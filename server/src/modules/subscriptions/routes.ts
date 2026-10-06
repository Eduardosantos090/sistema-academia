import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { likePattern, zCents, zDate, zPage, zText, zUuid } from '../../lib/normalize.js';
import { zInterval } from '../plans/routes.js';

export const zNewSubscriptionFields = {
  planId: zUuid.nullish(),
  description: zText(2, 120).nullish(),
  amountCents: zCents.nullish(),
  intervalMonths: zInterval.nullish(),
  firstDueDate: zDate,
};

type NewSub = z.output<z.ZodObject<typeof zNewSubscriptionFields>>;

/** Cria a assinatura e gera as cobranças dos próximos 30 dias. */
export async function createSubscription(db: Db, req: FastifyRequest, orgId: string, customerId: string, f: NewSub) {
  let description = f.description ?? null;
  let amount = f.amountCents ?? null;
  let interval = f.intervalMonths ?? null;
  if (f.planId) {
    const { rows } = await db.query<{ name: string; amount_cents: number; interval_months: number }>(
      'select name, amount_cents, interval_months from plans where id = $1 and is_active',
      [f.planId],
    );
    const p = rows[0];
    if (!p) throw notFound('Plano não encontrado ou inativo.');
    description ??= p.name;
    amount ??= p.amount_cents;
    interval ??= p.interval_months;
  }
  if (!description || !amount || !interval) {
    throw new AppError(422, 'invalid', 'Escolha um plano ou informe descrição, valor e periodicidade.');
  }
  const billingDay = Number(f.firstDueDate.slice(8, 10));
  const { rows } = await db.query<{ id: string }>(
    `insert into subscriptions (organization_id, customer_id, plan_id, description, amount_cents, interval_months, next_due_date, billing_day)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [orgId, customerId, f.planId ?? null, description, amount, interval, f.firstDueDate, billingDay],
  );
  const id = rows[0]!.id;
  await db.query('select app.generate_charges($1, 30)', [id]);
  await audit(db, req, 'subscription.created', 'subscription', id, orgId, { amount, interval });
  return id;
}

export function registerSubscriptionRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/subscriptions', async (req) => {
    requireOrg(req);
    const q = parse(
      zPage.extend({ status: z.enum(['ativa', 'pausada', 'cancelada']).optional(), q: z.string().max(100).optional() }),
      req.query,
    );
    return asUser(deps, req, async (db) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.status) {
        params.push(q.status);
        where.push(`s.status = $${params.length}`);
      }
      if (q.q) {
        params.push(likePattern(q.q));
        where.push(`(cu.name ilike $${params.length} or s.description ilike $${params.length})`);
      }
      const clause = where.length ? `where ${where.join(' and ')}` : '';
      const total = await db.query<{ n: number }>(
        `select count(*)::int as n from subscriptions s join customers cu on cu.id = s.customer_id ${clause}`,
        params,
      );
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select s.id, s.description, s.amount_cents as "amountCents", s.interval_months as "intervalMonths",
                to_char(s.next_due_date, 'YYYY-MM-DD') as "nextDueDate", s.status, s.created_at as "createdAt",
                cu.id as "customerId", cu.name as "customerName"
           from subscriptions s join customers cu on cu.id = s.customer_id ${clause}
          order by (s.status = 'cancelada'), cu.name
          limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      return { items: rows, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize };
    });
  });

  app.post('/api/subscriptions', async (req, reply) => {
    const me = requireOrg(req);
    const body = parse(z.object({ customerId: zUuid, ...zNewSubscriptionFields }).strict(), req.body);
    const id = await asUser(deps, req, async (db) => {
      const c = await db.query('select 1 from customers where id = $1 and is_active', [body.customerId]);
      if (!c.rowCount) throw notFound('Cliente não encontrado ou inativo.');
      return createSubscription(db, req, me.orgId, body.customerId, body);
    });
    reply.code(201);
    return { id };
  });

  app.patch('/api/subscriptions/:id', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          status: z.enum(['ativa', 'pausada', 'cancelada']).optional(),
          description: zText(2, 120).optional(),
          amountCents: zCents.optional(),
          /** Também atualiza as cobranças em aberto ainda não vencidas. */
          applyToOpen: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ status: string; organization_id: string }>(
        'select status, organization_id from subscriptions where id = $1 for update',
        [id],
      );
      const s = rows[0];
      if (!s) throw notFound('Assinatura não encontrada.');
      if (s.status === 'cancelada' && body.status && body.status !== 'cancelada') {
        throw new AppError(409, 'conflict', 'Assinatura cancelada não pode ser reativada. Crie uma nova assinatura.');
      }
      await db.query(
        `update subscriptions set description = coalesce($2, description), amount_cents = coalesce($3, amount_cents),
                status = coalesce($4, status),
                cancelled_at = case when $4 = 'cancelada' then now() else cancelled_at end
          where id = $1`,
        [id, body.description ?? null, body.amountCents ?? null, body.status ?? null],
      );
      if (body.status === 'cancelada') {
        // Cancela as cobranças futuras ainda em aberto (as vencidas continuam para cobrança).
        await db.query(
          `update charges set status = 'cancelada', notes = coalesce(notes || ' ', '') || '(assinatura cancelada)'
            where subscription_id = $1 and status = 'aberta' and due_date >= app.org_today(organization_id)`,
          [id],
        );
      }
      if (body.status === 'ativa' && s.status === 'pausada') {
        // Retomada: o próximo vencimento não fica no passado.
        await db.query(
          `update subscriptions set next_due_date = (
              select min(d)::date from generate_series(next_due_date, app.org_today(organization_id) + interval '400 days',
                     make_interval(months => interval_months)) d
               where d >= app.org_today(organization_id))
            where id = $1 and next_due_date < app.org_today(organization_id)`,
          [id],
        );
        await db.query('select app.generate_charges($1, 30)', [id]);
      }
      if (body.applyToOpen && (body.amountCents || body.description)) {
        await db.query(
          `update charges set amount_cents = coalesce($2, amount_cents), description = coalesce($3, description)
            where subscription_id = $1 and status = 'aberta' and due_date >= app.org_today(organization_id)`,
          [id, body.amountCents ?? null, body.description ?? null],
        );
      }
      await audit(db, req, 'subscription.updated', 'subscription', id, me.orgId, {
        status: body.status,
        amountCents: body.amountCents,
      });
    });
    return { ok: true };
  });
}
