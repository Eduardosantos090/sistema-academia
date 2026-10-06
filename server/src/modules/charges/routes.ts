import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg } from '../../lib/context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { Where } from '../../lib/sql.js';
import { likePattern, zCents, zDate, zHttpsUrl, zOptionalText, zPage, zText, zUuid } from '../../lib/normalize.js';
import { sendChargeMessage } from '../messages/service.js';
import { emailAvailable, loadChannels } from '../channels/service.js';

const CHARGE_COLS = `ch.id, ch.description, ch.amount_cents as "amountCents", to_char(ch.due_date, 'YYYY-MM-DD') as "dueDate",
  ch.status, ch.paid_at as "paidAt", ch.paid_amount_cents as "paidAmountCents", ch.payment_method as "paymentMethod",
  ch.payment_link as "paymentLink", ch.reported_paid_at as "reportedPaidAt", ch.notes, ch.subscription_id as "subscriptionId",
  ch.created_at as "createdAt",
  (ch.status = 'aberta' and ch.due_date < app.org_today(ch.organization_id)) as "overdue",
  (app.org_today(ch.organization_id) - ch.due_date) as "daysLate",
  cu.id as "customerId", cu.name as "customerName", cu.phone as "customerPhone", cu.email as "customerEmail"`;

const FILTERS = ['abertas', 'atrasadas', 'vencendo', 'hoje', 'a_conferir', 'pagas', 'canceladas', 'todas'] as const;

const zMethod = z.enum(['pix', 'dinheiro', 'cartao', 'boleto', 'transferencia', 'outro']);

export function registerChargeRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/charges', async (req) => {
    requireOrg(req);
    const q = parse(
      zPage.extend({
        filter: z.enum(FILTERS).default('abertas'),
        q: z.string().max(100).optional(),
        customerId: zUuid.optional(),
        from: zDate.optional(),
        to: zDate.optional(),
      }),
      req.query,
    );
    return asUser(deps, req, async (db) => {
      const w = new Where();
      const today = 'app.org_today(ch.organization_id)';
      switch (q.filter) {
        case 'abertas': w.raw(`ch.status = 'aberta'`); break;
        case 'atrasadas': w.raw(`ch.status = 'aberta' and ch.due_date < ${today}`); break;
        case 'hoje': w.raw(`ch.status = 'aberta' and ch.due_date = ${today}`); break;
        case 'vencendo': w.raw(`ch.status = 'aberta' and ch.due_date between ${today} and ${today} + 7`); break;
        case 'a_conferir': w.raw(`ch.status = 'aberta' and ch.reported_paid_at is not null`); break;
        case 'pagas': w.raw(`ch.status = 'paga'`); break;
        case 'canceladas': w.raw(`ch.status = 'cancelada'`); break;
        default: break;
      }
      if (q.q) w.add('(cu.name ilike ? or ch.description ilike ?)', likePattern(q.q));
      if (q.customerId) w.add('ch.customer_id = ?', q.customerId);
      if (q.from) w.add('ch.due_date >= ?::date', q.from);
      if (q.to) w.add('ch.due_date <= ?::date', q.to);
      const from = 'from charges ch join customers cu on cu.id = ch.customer_id';
      const totals = await db.query<{ n: number; cents: number }>(
        `select count(*)::int as n, coalesce(sum(ch.amount_cents), 0)::bigint as cents ${from} ${w.clause}`,
        w.params,
      );
      const lim = w.param(q.pageSize);
      const off = w.param((q.page - 1) * q.pageSize);
      const order = q.filter === 'pagas' ? 'ch.paid_at desc' : q.filter === 'canceladas' || q.filter === 'todas' ? 'ch.due_date desc' : 'ch.due_date, cu.name';
      const { rows } = await db.query(`select ${CHARGE_COLS} ${from} ${w.clause} order by ${order} limit ${lim} offset ${off}`, w.params);
      return { items: rows, total: totals.rows[0]!.n, totalCents: totals.rows[0]!.cents, page: q.page, pageSize: q.pageSize };
    });
  });

  app.post('/api/charges', async (req, reply) => {
    const me = requireOrg(req);
    const body = parse(
      z
        .object({
          customerId: zUuid,
          description: zText(2, 160),
          amountCents: zCents,
          dueDate: zDate,
          paymentLink: zHttpsUrl,
          notes: zOptionalText(1000),
        })
        .strict(),
      req.body,
    );
    const id = await asUser(deps, req, async (db) => {
      const c = await db.query('select 1 from customers where id = $1 and is_active', [body.customerId]);
      if (!c.rowCount) throw notFound('Cliente não encontrado ou inativo.');
      const { rows } = await db.query<{ id: string }>(
        `insert into charges (organization_id, customer_id, description, amount_cents, due_date, payment_link, notes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, app.uid()) returning id`,
        [me.orgId, body.customerId, body.description, body.amountCents, body.dueDate, body.paymentLink, body.notes],
      );
      await audit(db, req, 'charge.created', 'charge', rows[0]!.id, me.orgId, { amountCents: body.amountCents });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.get('/api/charges/:id', async (req) => {
    requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(`select ${CHARGE_COLS} from charges ch join customers cu on cu.id = ch.customer_id where ch.id = $1`, [id]);
      if (!rows[0]) throw notFound('Cobrança não encontrada.');
      const msgs = await db.query(
        `select id, channel, kind, status, body, error, created_at as "createdAt", sent_at as "sentAt"
           from messages where charge_id = $1 order by created_at desc limit 50`,
        [id],
      );
      return { ...rows[0], messages: msgs.rows };
    });
  });

  app.patch('/api/charges/:id', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          description: zText(2, 160).optional(),
          amountCents: zCents.optional(),
          dueDate: zDate.optional(),
          paymentLink: zHttpsUrl.optional(),
          notes: zOptionalText(1000).optional(),
        })
        .strict(),
      req.body,
    );
    await asUser(deps, req, async (db) => {
      const r = await db.query(
        `update charges set description = coalesce($2, description), amount_cents = coalesce($3, amount_cents),
                due_date = coalesce($4::date, due_date),
                payment_link = case when $7 then $5 else payment_link end,
                notes = case when $8 then $6 else notes end
          where id = $1 and status <> 'cancelada'`,
        [id, body.description ?? null, body.amountCents ?? null, body.dueDate ?? null, body.paymentLink ?? null,
          body.notes ?? null, 'paymentLink' in body, 'notes' in body],
      );
      if (!r.rowCount) throw notFound('Cobrança não encontrada ou cancelada.');
      await audit(db, req, 'charge.updated', 'charge', id, me.orgId, { fields: Object.keys(body) });
    });
    return { ok: true };
  });

  /** Registra o pagamento (baixa manual) e, se configurado, confirma ao cliente. */
  app.post('/api/charges/:id/pay', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          paidOn: zDate.optional(),
          amountCents: z.coerce.number().int().min(0).max(100_000_000).optional(),
          method: zMethod.default('pix'),
          notify: z.boolean().default(true),
        })
        .strict(),
      req.body ?? {},
    );
    const info = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ notify: boolean; phone: string | null; email: string | null; wa: boolean; em: boolean }>(
        `update charges ch set status = 'paga',
                paid_at = case when $2::date is null then now() else ($2::date + time '12:00') at time zone o.timezone end,
                paid_amount_cents = coalesce($3, ch.amount_cents), payment_method = $4, reported_paid_at = null
           from organizations o, customers cu
          where ch.id = $1 and o.id = ch.organization_id and cu.id = ch.customer_id and ch.status = 'aberta'
          returning o.notify_on_payment as notify, cu.phone, cu.email, cu.whatsapp_opt_in as wa, cu.email_opt_in as em`,
        [id, body.paidOn ?? null, body.amountCents ?? null, body.method],
      );
      if (!rows[0]) throw new AppError(409, 'conflict', 'Cobrança não encontrada ou não está em aberto.');
      // Lembretes ainda não enviados desta cobrança perdem o sentido.
      await db.query(
        `update messages set status = 'cancelada', error = 'Cobrança paga.' where charge_id = $1 and kind = 'lembrete' and status in ('pendente', 'manual')`,
        [id],
      );
      await audit(db, req, 'charge.paid', 'charge', id, me.orgId, { method: body.method });
      return rows[0];
    });
    let confirmation = null;
    if (body.notify && info.notify) {
      const channels = await loadChannels(deps, me.orgId);
      const channel = info.phone && info.wa ? 'whatsapp' : info.email && info.em && emailAvailable(deps, channels) ? 'email' : null;
      if (channel) {
        confirmation = await sendChargeMessage(deps, req, me, id, { channel, kind: 'confirmacao', templateKind: 'pagamento_confirmado' }).catch(
          () => null,
        );
      }
    }
    return { ok: true, confirmation };
  });

  /** Estorno da baixa (pagamento registrado por engano). */
  app.post('/api/charges/:id/unpay', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query(`update charges set status = 'aberta' where id = $1 and status = 'paga'`, [id]);
      if (!r.rowCount) throw new AppError(409, 'conflict', 'Cobrança não encontrada ou não está paga.');
      await audit(db, req, 'charge.unpaid', 'charge', id, me.orgId);
    });
    return { ok: true };
  });

  app.post('/api/charges/:id/cancel', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query(`update charges set status = 'cancelada' where id = $1 and status = 'aberta'`, [id]);
      if (!r.rowCount) throw new AppError(409, 'conflict', 'Somente cobranças em aberto podem ser canceladas.');
      await db.query(
        `update messages set status = 'cancelada', error = 'Cobrança cancelada.' where charge_id = $1 and status in ('pendente', 'manual')`,
        [id],
      );
      await audit(db, req, 'charge.cancelled', 'charge', id, me.orgId);
    });
    return { ok: true };
  });

  /** O cliente disse que pagou, mas o pagamento não foi encontrado: volta a ser cobrado normalmente. */
  app.post('/api/charges/:id/dismiss-report', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query(`update charges set reported_paid_at = null where id = $1 and status = 'aberta'`, [id]);
      if (!r.rowCount) throw notFound('Cobrança não encontrada.');
      await audit(db, req, 'charge.report_dismissed', 'charge', id, me.orgId);
    });
    return { ok: true };
  });

  /** Enviar lembrete agora (WhatsApp automático, WhatsApp manual com link ou e-mail). */
  app.post('/api/charges/:id/send', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ channel: z.enum(['whatsapp', 'email']), templateId: zUuid.nullish() }).strict(),
      req.body,
    );
    await deps.limiters.sendNow.consume(`u:${me.id}`);
    return sendChargeMessage(deps, req, me, id, { channel: body.channel, templateId: body.templateId, kind: 'manual' });
  });
}
