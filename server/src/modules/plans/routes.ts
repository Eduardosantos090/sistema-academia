import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg, requireOwner } from '../../lib/context.js';
import { notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zCents, zOptionalText, zText, zUuid } from '../../lib/normalize.js';

export const zInterval = z.coerce.number().int().refine((v) => [1, 2, 3, 6, 12].includes(v), 'Periodicidade inválida.');

export function registerPlanRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/plans', async (req) => {
    requireOrg(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select p.id, p.name, p.description, p.amount_cents as "amountCents", p.interval_months as "intervalMonths",
                p.is_active as "isActive",
                (select count(*)::int from subscriptions s where s.plan_id = p.id and s.status = 'ativa') as "activeSubscriptions"
           from plans p order by p.is_active desc, p.name`,
      );
      return { items: rows };
    });
  });

  app.post('/api/plans', async (req, reply) => {
    const me = requireOwner(req);
    const body = parse(
      z.object({ name: zText(2, 80), description: zOptionalText(500), amountCents: zCents, intervalMonths: zInterval }).strict(),
      req.body,
    );
    const id = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into plans (organization_id, name, description, amount_cents, interval_months) values ($1, $2, $3, $4, $5) returning id`,
        [me.orgId, body.name, body.description, body.amountCents, body.intervalMonths],
      );
      await audit(db, req, 'plan.created', 'plan', rows[0]!.id, me.orgId);
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.patch('/api/plans/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({
          name: zText(2, 80).optional(),
          description: zOptionalText(500).optional(),
          amountCents: zCents.optional(),
          intervalMonths: zInterval.optional(),
          isActive: z.boolean().optional(),
          /** Aplica o novo valor às assinaturas ativas deste plano (próximas cobranças). */
          applyToSubscriptions: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    await asUser(deps, req, async (db) => {
      const r = await db.query(
        `update plans set name = coalesce($2, name), description = case when $7 then $3 else description end,
                amount_cents = coalesce($4, amount_cents), interval_months = coalesce($5, interval_months),
                is_active = coalesce($6, is_active)
          where id = $1`,
        [id, body.name ?? null, body.description ?? null, body.amountCents ?? null, body.intervalMonths ?? null, body.isActive ?? null, 'description' in body],
      );
      if (!r.rowCount) throw notFound('Plano não encontrado.');
      if (body.applyToSubscriptions && body.amountCents) {
        await db.query(`update subscriptions set amount_cents = $2 where plan_id = $1 and status <> 'cancelada'`, [id, body.amountCents]);
      }
      await audit(db, req, 'plan.updated', 'plan', id, me.orgId, { fields: Object.keys(body) });
    });
    return { ok: true };
  });
}
