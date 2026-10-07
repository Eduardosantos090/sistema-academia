import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg, requireOwner } from '../../lib/context.js';
import { AppError, fromPgError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { Where } from '../../lib/sql.js';
import {
  likePattern,
  zOptionalDocument,
  zOptionalEmail,
  zOptionalPhone,
  zOptionalText,
  zPage,
  zText,
  zUuid,
  zCents,
  zDate,
} from '../../lib/normalize.js';
import { zInterval } from '../plans/routes.js';
import { formatPhoneBr } from '../../lib/template.js';
import { csvDate, csvMoney, toCsv } from '../../lib/csv.js';
import { createSubscription, zNewSubscriptionFields } from '../subscriptions/routes.js';

const zCustomerFields = {
  name: zText(2, 120),
  email: zOptionalEmail,
  phone: zOptionalPhone,
  document: zOptionalDocument,
  notes: zOptionalText(2000),
  whatsappOptIn: z.boolean().default(true),
  emailOptIn: z.boolean().default(true),
};

/** Situação financeira do cliente calculada no banco (em dia, vencendo, em atraso). */
export const CUSTOMER_FINANCE_SQL = `
  (select count(*)::int from charges ch where ch.customer_id = c.id and ch.status = 'aberta') as "openCount",
  (select count(*)::int from charges ch where ch.customer_id = c.id and ch.status = 'aberta'
     and ch.due_date < app.org_today(c.organization_id)) as "overdueCount",
  (select coalesce(sum(ch.amount_cents), 0)::bigint from charges ch where ch.customer_id = c.id and ch.status = 'aberta'
     and ch.due_date < app.org_today(c.organization_id)) as "overdueCents",
  (select to_char(min(ch.due_date), 'YYYY-MM-DD') from charges ch where ch.customer_id = c.id and ch.status = 'aberta') as "nextDueDate"`;

const IMPORT_LABELS: Record<string, string> = {
  name: 'Nome', phone: 'WhatsApp', email: 'E-mail', document: 'CPF/CNPJ', notes: 'Observações', planName: 'Plano',
  amountCents: 'Valor', intervalMonths: 'Periodicidade', firstDueDate: 'Vencimento',
};

const zCustomerFilters = {
  q: z.string().max(100).optional(),
  status: z.enum(['todos', 'em_dia', 'atrasados', 'inativos']).default('todos'),
};

function customerWhere(q: { q?: string; status: string }) {
  const w = new Where();
  if (q.q) {
    const digits = q.q.replace(/\D/g, '');
    const text = w.param(likePattern(q.q));
    if (digits.length >= 4) {
      const num = w.param(`%${digits}%`);
      w.raw(`(c.name ilike ${text} or c.email::text ilike ${text} or c.phone like ${num} or c.document like ${num})`);
    } else {
      w.raw(`(c.name ilike ${text} or c.email::text ilike ${text})`);
    }
  }
  if (q.status === 'inativos') w.raw('not c.is_active');
  else w.raw('c.is_active');
  const overdue = `exists (select 1 from charges ch where ch.customer_id = c.id and ch.status = 'aberta'
                    and ch.due_date < app.org_today(c.organization_id))`;
  if (q.status === 'atrasados') w.raw(overdue);
  if (q.status === 'em_dia') w.raw(`not ${overdue}`);
  return w;
}

const PLAN_NAME_SQL = `(select s.description from subscriptions s where s.customer_id = c.id and s.status = 'ativa'
  order by s.created_at desc limit 1) as "planName"`;

const CUSTOMER_COLS = `c.id, c.name, c.email, c.phone, c.document, c.notes, c.whatsapp_opt_in as "whatsappOptIn",
  c.email_opt_in as "emailOptIn", c.is_active as "isActive", c.created_at as "createdAt"`;

export function registerCustomerRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/customers', async (req) => {
    requireOrg(req);
    const q = parse(zPage.extend(zCustomerFilters), req.query);
    return asUser(deps, req, async (db) => {
      const w = customerWhere(q);
      const total = await db.query<{ n: number }>(`select count(*)::int as n from customers c ${w.clause}`, w.params);
      const lim = w.param(q.pageSize);
      const off = w.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select ${CUSTOMER_COLS}, ${CUSTOMER_FINANCE_SQL}, ${PLAN_NAME_SQL}
           from customers c ${w.clause}
          order by c.name limit ${lim} offset ${off}`,
        w.params,
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
    });
  });

  /** Planilha (CSV) dos clientes do filtro atual. */
  app.get('/api/customers/export', async (req, reply) => {
    const me = requireOrg(req);
    const q = parse(z.object(zCustomerFilters), req.query);
    const rows = await asUser(deps, req, async (db) => {
      const w = customerWhere(q);
      const r = await db.query<{
        name: string; phone: string | null; email: string | null; document: string | null; planName: string | null;
        isActive: boolean; overdueCount: number; overdueCents: number; nextDueDate: string | null;
        whatsappOptIn: boolean; emailOptIn: boolean; createdAt: Date;
      }>(`select ${CUSTOMER_COLS}, ${CUSTOMER_FINANCE_SQL}, ${PLAN_NAME_SQL} from customers c ${w.clause} order by c.name limit 20000`, w.params);
      await audit(db, req, 'customer.exported', 'customer', null, me.orgId, { status: q.status, rows: r.rowCount });
      return r.rows;
    });
    const csv = toCsv(
      ['Nome', 'WhatsApp', 'E-mail', 'CPF/CNPJ', 'Plano', 'Situação', 'Em atraso (R$)', 'Próximo vencimento', 'Recebe WhatsApp', 'Recebe e-mail', 'Cliente desde'],
      rows.map((c) => [
        c.name, formatPhoneBr(c.phone), c.email, c.document, c.planName,
        !c.isActive ? 'Inativo' : c.overdueCount ? 'Em atraso' : 'Em dia',
        csvMoney(c.overdueCents), csvDate(c.nextDueDate), c.whatsappOptIn ? 'Sim' : 'Não', c.emailOptIn ? 'Sim' : 'Não', csvDate(c.createdAt.toISOString()),
      ]),
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="clientes-${q.status}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return csv;
  });

  app.post('/api/customers', async (req, reply) => {
    const me = requireOrg(req);
    const body = parse(
      z
        .object({
          ...zCustomerFields,
          subscription: z.object(zNewSubscriptionFields).strict().nullish(),
        })
        .strict(),
      req.body,
    );
    const id = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into customers (organization_id, name, email, phone, document, notes, whatsapp_opt_in, email_opt_in)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [me.orgId, body.name, body.email, body.phone, body.document, body.notes, body.whatsappOptIn, body.emailOptIn],
      );
      const cid = rows[0]!.id;
      await audit(db, req, 'customer.created', 'customer', cid, me.orgId);
      if (body.subscription) await createSubscription(db, req, me.orgId, cid, body.subscription);
      return cid;
    });
    reply.code(201);
    return { id };
  });

  app.get('/api/customers/:id', async (req) => {
    requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(`select ${CUSTOMER_COLS}, ${CUSTOMER_FINANCE_SQL} from customers c where c.id = $1`, [id]);
      if (!rows[0]) throw notFound('Cliente não encontrado.');
      const subs = await db.query(
        `select s.id, s.description, s.amount_cents as "amountCents", s.interval_months as "intervalMonths",
                to_char(s.next_due_date, 'YYYY-MM-DD') as "nextDueDate", s.billing_day as "billingDay", s.status,
                s.plan_id as "planId", s.created_at as "createdAt"
           from subscriptions s where s.customer_id = $1 order by (s.status = 'cancelada'), s.created_at desc`,
        [id],
      );
      const charges = await db.query(
        `select ch.id, ch.description, ch.amount_cents as "amountCents", to_char(ch.due_date, 'YYYY-MM-DD') as "dueDate",
                ch.status, ch.paid_at as "paidAt", ch.paid_amount_cents as "paidAmountCents", ch.payment_method as "paymentMethod",
                ch.reported_paid_at as "reportedPaidAt", ch.payment_link as "paymentLink",
                (ch.status = 'aberta' and ch.due_date < app.org_today(ch.organization_id)) as "overdue"
           from charges ch where ch.customer_id = $1 order by ch.due_date desc limit 60`,
        [id],
      );
      const messages = await db.query(
        `select m.id, m.channel, m.kind, m.status, m.subject, m.body, m.error, m.created_at as "createdAt", m.sent_at as "sentAt"
           from messages m where m.customer_id = $1 order by m.created_at desc limit 30`,
        [id],
      );
      const conv = await db.query(
        `select id, status, unread from conversations where customer_id = $1 order by last_message_at desc limit 1`,
        [id],
      );
      return { ...rows[0], subscriptions: subs.rows, charges: charges.rows, messages: messages.rows, conversation: conv.rows[0] ?? null };
    });
  });

  app.patch('/api/customers/:id', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          name: zCustomerFields.name.optional(),
          email: zCustomerFields.email.optional(),
          phone: zCustomerFields.phone.optional(),
          document: zCustomerFields.document.optional(),
          notes: zCustomerFields.notes.optional(),
          whatsappOptIn: z.boolean().optional(),
          emailOptIn: z.boolean().optional(),
          isActive: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const map: Record<string, string> = {
      name: 'name', email: 'email', phone: 'phone', document: 'document', notes: 'notes',
      whatsappOptIn: 'whatsapp_opt_in', emailOptIn: 'email_opt_in', isActive: 'is_active',
    };
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [k, col] of Object.entries(map)) {
      if (k in body) {
        params.push((body as Record<string, unknown>)[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) return { ok: true };
    await asUser(deps, req, async (db) => {
      const r = await db.query(`update customers set ${sets.join(', ')} where id = $1`, params);
      if (!r.rowCount) throw notFound('Cliente não encontrado.');
      if (body.isActive === false) {
        // Cliente desativado: assinaturas pausadas e envios pendentes cancelados.
        await db.query(`update subscriptions set status = 'pausada' where customer_id = $1 and status = 'ativa'`, [id]);
        await db.query(
          `update messages set status = 'cancelada', error = 'Cliente desativado.' where customer_id = $1 and status in ('pendente', 'manual')`,
          [id],
        );
      }
      await audit(db, req, 'customer.updated', 'customer', id, me.orgId, { fields: Object.keys(body) });
    });
    return { ok: true };
  });

  /** Exclusão definitiva dos dados do cliente (pedido do titular — LGPD). Somente o responsável. */
  app.delete('/api/customers/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const related = await asUser(deps, req, async (db) => {
      const conv = await db.query<{ id: string }>('select id from conversations where customer_id = $1', [id]);
      const msgs = await db.query<{ id: string }>('select id from messages where customer_id = $1', [id]);
      const r = await db.query('delete from customers where id = $1', [id]);
      if (!r.rowCount) throw notFound('Cliente não encontrado.');
      await audit(db, req, 'customer.deleted', 'customer', id, me.orgId);
      return { conv: conv.rows.map((x) => x.id), msgs: msgs.rows.map((x) => x.id) };
    });
    // Conversas e mensagens com dados de contato do titular: removidas pelo servidor
    // (a equipe não tem permissão de exclusão nessas tabelas).
    await deps.pools.owner.query('delete from conversations where organization_id = $1 and id = any($2::uuid[])', [me.orgId, related.conv]);
    await deps.pools.owner.query('delete from messages where organization_id = $1 and id = any($2::uuid[])', [me.orgId, related.msgs]);
    return { ok: true };
  });

  /**
   * Importação em lote (planilha CSV já interpretada no navegador). Cada linha
   * é validada e gravada em um ponto de salvamento próprio: linhas com erro
   * são informadas sem impedir as demais. Duplicados (mesmo telefone ou
   * e-mail já cadastrado) são ignorados.
   */
  app.post('/api/customers/import', { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const me = requireOrg(req);
    const body = parse(
      z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(500) }).strict(),
      req.body,
    );
    await deps.limiters.sendNow.consume(`import:${me.id}`);
    const zRow = z
      .object({
        ...zCustomerFields,
        planName: zOptionalText(80),
        amountCents: zCents.nullish(),
        intervalMonths: zInterval.nullish(),
        firstDueDate: zDate.nullish(),
      })
      .strip();
    const result = { created: 0, subscriptions: 0, duplicates: 0, errors: [] as { line: number; message: string }[] };
    await asUser(deps, req, async (db) => {
      const plans = (await db.query<{ id: string; name: string }>('select id, lower(btrim(name)) as name from plans where is_active')).rows;
      for (const [i, raw] of body.rows.entries()) {
        const line = i + 2; // linha 1 = cabeçalho da planilha
        const r = zRow.safeParse(raw);
        if (!r.success) {
          const issue = r.error.issues[0]!;
          const col = IMPORT_LABELS[String(issue.path[0])] ?? 'Linha';
          result.errors.push({ line, message: `${col}: ${issue.message}` });
          continue;
        }
        const row = r.data;
        const dup = await db.query(
          `select 1 from customers where ($1::text is not null and phone = $1) or ($2::citext is not null and email = $2) limit 1`,
          [row.phone, row.email],
        );
        if (dup.rowCount) {
          result.duplicates++;
          continue;
        }
        await db.query('savepoint linha');
        try {
          const { rows } = await db.query<{ id: string }>(
            `insert into customers (organization_id, name, email, phone, document, notes, whatsapp_opt_in, email_opt_in)
             values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
            [me.orgId, row.name, row.email, row.phone, row.document, row.notes, row.whatsappOptIn, row.emailOptIn],
          );
          if (row.firstDueDate && (row.planName || row.amountCents)) {
            const plan = row.planName ? plans.find((p) => p.name === row.planName!.trim().toLowerCase()) : undefined;
            await createSubscription(db, req, me.orgId, rows[0]!.id, {
              planId: plan?.id ?? null,
              description: plan ? null : row.planName ?? 'Mensalidade',
              amountCents: row.amountCents ?? null,
              intervalMonths: plan ? null : row.intervalMonths ?? 1,
              firstDueDate: row.firstDueDate,
            });
          }
          await db.query('release savepoint linha');
          result.created++;
          if (row.firstDueDate && (row.planName || row.amountCents)) result.subscriptions++;
        } catch (e) {
          await db.query('rollback to savepoint linha');
          const known = e instanceof AppError ? e : fromPgError(e);
          const msg = known?.message ?? 'não foi possível gravar';
          result.errors.push({ line, message: msg });
        }
      }
      await audit(db, req, 'customer.imported', 'customer', null, me.orgId, {
        created: result.created, subscriptions: result.subscriptions, duplicates: result.duplicates, errors: result.errors.length,
      });
    });
    return result;
  });
}
