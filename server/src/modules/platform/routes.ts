import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requirePlatform } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zDate, zEmail, zOptionalEmail, zOptionalPhone, zOptionalText, zText, zUuid } from '../../lib/normalize.js';
import { withTx } from '../../lib/db.js';
import { zInterval } from '../plans/routes.js';
import { ACCESS_STATUS_SQL, adminResetLink, inviteUser } from '../users/routes.js';

export const SEGMENTS = [
  'academia', 'estudio', 'escola', 'curso', 'clinica', 'consultorio', 'salao', 'condominio',
  'associacao', 'igreja', 'coworking', 'servicos', 'software', 'outro',
] as const;

export function slugify(name: string) {
  const base = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : `org-${base || 'nova'}`;
}

async function uniqueSlug(deps: Deps, wanted: string) {
  let slug = wanted;
  for (let i = 2; i < 50; i++) {
    const { rowCount } = await deps.pools.owner.query('select 1 from organizations where slug = $1', [slug]);
    if (!rowCount) return slug;
    slug = `${wanted.slice(0, 44)}-${i}`;
  }
  throw conflict('Não foi possível gerar um endereço único para a organização.');
}

const zSlug = z.string().regex(/^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$/, 'Use letras minúsculas, números e hífen (3 a 50).');

const zNewOrg = z
  .object({
    name: zText(2, 120),
    slug: zSlug.optional(),
    segment: z.enum(SEGMENTS).default('outro'),
    contactEmail: zOptionalEmail,
    contactPhone: zOptionalPhone,
    ownerName: zText(2, 120),
    ownerEmail: zEmail,
  })
  .strict();

/** Cria organização + dados padrão + responsável (convite). Usa a RLS do administrador da plataforma. */
async function createOrganization(deps: Deps, req: FastifyRequest, body: z.output<typeof zNewOrg>, db: Db) {
  const exists = await deps.pools.owner.query('select 1 from users where email = $1', [body.ownerEmail]);
  if (exists.rowCount) throw conflict('O e-mail do responsável já está em uso por outro usuário.');
  const slug = await uniqueSlug(deps, body.slug ?? slugify(body.name));
  const { rows } = await db.query<{ id: string }>(
    `insert into organizations (name, slug, segment, contact_email, contact_phone)
     values ($1, $2, $3, $4, $5) returning id`,
    [body.name, slug, body.segment, body.contactEmail ?? body.ownerEmail, body.contactPhone],
  );
  const orgId = rows[0]!.id;
  await db.query('select app.seed_org_defaults($1)', [orgId]);
  const u = await db.query<{ id: string }>(
    `insert into users (email, full_name, organization_id, role) values ($1, $2, $3, 'owner') returning id`,
    [body.ownerEmail, body.ownerName, orgId],
  );
  await audit(db, req, 'platform.org_created', 'organization', orgId, orgId, { slug, segment: body.segment });
  return { orgId, ownerId: u.rows[0]!.id, slug };
}

/** Auditoria das ações da plataforma sobre uma organização (servidor privilegiado). */
async function auditOrg(db: Db, actorId: string, action: string, orgId: string | null, ip: string, details: Record<string, unknown> = {}) {
  await db.query(
    `insert into audit_events (actor_id, organization_id, action, entity_type, entity_id, details, ip)
     values ($1, $2, $3, 'organization', $4, $5, $6)`,
    [actorId, orgId, action, orgId, JSON.stringify(details), ip],
  );
}

export function registerPlatformRoutes(app: FastifyInstance, deps: Deps) {
  /** Visão geral: somente totais agregados (sem dados pessoais dos clientes das organizações). */
  app.get('/api/platform/overview', async (req) => {
    requirePlatform(req);
    const { rows } = await deps.pools.owner.query(
      `select (select count(*)::int from organizations where is_active) as "activeOrgs",
              (select count(*)::int from organizations) as "totalOrgs",
              (select count(*)::int from customers where is_active) as "customers",
              (select count(*)::int from messages where status = 'enviada' and sent_at > now() - interval '30 days') as "messages30d",
              (select count(*)::int from access_requests where status = 'novo') as "pendingRequests"`,
    );
    return rows[0];
  });

  app.get('/api/platform/orgs', async (req) => {
    requirePlatform(req);
    const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
    const { rows } = await deps.pools.owner.query(
      `select o.id, o.name, o.slug, o.segment, o.contact_email as "contactEmail", o.contact_phone as "contactPhone",
              o.is_active as "isActive", o.created_at as "createdAt",
              (select count(*)::int from customers c where c.organization_id = o.id and c.is_active) as "customers",
              (select count(*)::int from users u where u.organization_id = o.id and u.is_active) as "users",
              (select count(*)::int from messages m where m.organization_id = o.id and m.status = 'enviada'
                 and m.sent_at > now() - interval '30 days') as "messages30d",
              (select max(u.last_login_at) from users u where u.organization_id = o.id) as "lastLoginAt",
              ch.whatsapp_mode as "whatsappMode",
              o.plan_name as "planName", o.plan_amount_cents as "planAmountCents", o.plan_interval_months as "planIntervalMonths",
              to_char(o.access_until, 'YYYY-MM-DD') as "accessUntil", o.auto_suspend as "autoSuspend", o.grace_days as "graceDays",
              o.suspended_reason as "suspendedReason", (o.billing_customer_id is not null) as "autoBilling", o.is_billing_org as "isBillingOrg",
              (o.access_until - app.org_today(o.id)) as "accessDaysLeft"
         from organizations o left join org_channels ch on ch.organization_id = o.id
        where ($1::text is null or o.name ilike '%' || $1 || '%' or o.slug ilike '%' || $1 || '%')
        order by o.is_active desc, o.name`,
      [q.q ? q.q.replace(/[\\%_]/g, (c) => `\\${c}`) : null],
    );
    return { items: rows };
  });

  app.post('/api/platform/orgs', async (req, reply) => {
    const me = requirePlatform(req);
    const body = parse(zNewOrg, req.body);
    await deps.limiters.invite.consume(`u:${me.id}`);
    const created = await asUser(deps, req, (db) => createOrganization(deps, req, body, db));
    reply.code(201);
    return { id: created.orgId, slug: created.slug, ...(await inviteUser(deps, created.ownerId, me.id)) };
  });

  app.get('/api/platform/orgs/:id', async (req) => {
    requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const { rows } = await deps.pools.owner.query(
      `select id, name, slug, segment, contact_email as "contactEmail", contact_phone as "contactPhone",
              o.is_active as "isActive", o.created_at as "createdAt",
              o.plan_name as "planName", o.plan_amount_cents as "planAmountCents", o.plan_interval_months as "planIntervalMonths",
              to_char(o.access_until, 'YYYY-MM-DD') as "accessUntil", o.auto_suspend as "autoSuspend", o.grace_days as "graceDays",
              o.suspended_reason as "suspendedReason", (o.billing_customer_id is not null) as "autoBilling", o.is_billing_org as "isBillingOrg",
              (o.access_until - app.org_today(o.id)) as "accessDaysLeft"
         from organizations o where o.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound();
    const users = await deps.pools.owner.query(
      `select u.id, u.email, u.full_name as "fullName", u.role, u.is_active as "isActive",
              u.last_login_at as "lastLoginAt", ${ACCESS_STATUS_SQL} as "accessStatus"
         from users u where u.organization_id = $1 order by u.role, u.full_name`,
      [id],
    );
    return { ...rows[0], users: users.rows, mailMode: deps.config.mailMode };
  });

  app.patch('/api/platform/orgs/:id', async (req) => {
    requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ name: zText(2, 120).optional(), segment: z.enum(SEGMENTS).optional(), isActive: z.boolean().optional() }).strict(),
      req.body,
    );
    await asUser(deps, req, async (db) => {
      const r = await db.query(
        `update organizations set name = coalesce($2, name), segment = coalesce($3, segment), is_active = coalesce($4, is_active),
                suspended_reason = case when $4 is null then suspended_reason when $4 then null else 'manual' end
          where id = $1`,
        [id, body.name ?? null, body.segment ?? null, body.isActive ?? null],
      );
      if (!r.rowCount) throw notFound();
      await audit(db, req, body.isActive === false ? 'platform.org_suspended' : 'platform.org_updated', 'organization', id, id, body);
    });
    if (body.isActive === false) {
      await deps.pools.owner.query(
        'delete from sessions where user_id in (select id from users where organization_id = $1)',
        [id],
      );
    }
    return { ok: true };
  });

  /** Adiciona responsável/equipe a uma organização (ex.: troca de responsável). */
  app.post('/api/platform/orgs/:id/users', async (req, reply) => {
    const me = requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ email: zEmail, fullName: zText(2, 120), role: z.enum(['owner', 'staff']).default('owner') }).strict(),
      req.body,
    );
    await deps.limiters.invite.consume(`u:${me.id}`);
    const userId = await asUser(deps, req, async (db) => {
      const org = await db.query('select 1 from organizations where id = $1', [id]);
      if (!org.rowCount) throw notFound();
      const exists = await deps.pools.owner.query('select 1 from users where email = $1', [body.email]);
      if (exists.rowCount) throw conflict('Este e-mail já está em uso por outro usuário.');
      const { rows } = await db.query<{ id: string }>(
        'insert into users (email, full_name, organization_id, role) values ($1, $2, $3, $4) returning id',
        [body.email, body.fullName, id, body.role],
      );
      await audit(db, req, 'platform.user_created', 'user', rows[0]!.id, id, { role: body.role });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id: userId, ...(await inviteUser(deps, userId, me.id)) };
  });

  app.post('/api/platform/users/:id/invite', async (req) => {
    const me = requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await deps.limiters.invite.consume(`u:${me.id}`);
    return inviteUser(deps, id, me.id);
  });

  app.post('/api/platform/users/:id/reset-link', async (req) => {
    requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return adminResetLink(deps, id);
  });

  app.patch('/api/platform/users/:id', async (req) => {
    requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ isActive: z.boolean() }).strict(), req.body);
    await asUser(deps, req, async (db) => {
      const r = await db.query<{ organization_id: string | null }>(
        'update users set is_active = $2 where id = $1 and id <> app.uid() returning organization_id',
        [id, body.isActive],
      );
      if (!r.rows[0]) throw notFound();
      await audit(db, req, 'platform.user_updated', 'user', id, r.rows[0].organization_id, body);
    });
    if (!body.isActive) await deps.pools.owner.query('delete from sessions where user_id = $1', [id]);
    return { ok: true };
  });

  // ------------------------------------------------------------- pedidos de acesso

  app.get('/api/platform/requests', async (req) => {
    requirePlatform(req);
    const q = parse(z.object({ status: z.enum(['novo', 'aprovado', 'recusado']).default('novo') }), req.query);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select id, name, business_name as "businessName", segment, email, phone, message, status,
                created_at as "createdAt", decided_at as "decidedAt", organization_id as "organizationId"
           from access_requests where status = $1 order by created_at desc limit 200`,
        [q.status],
      );
      return { items: rows };
    });
  });

  app.post('/api/platform/requests/:id/approve', async (req) => {
    const me = requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ slug: zSlug.optional() }).strict(), req.body ?? {});
    const created = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ name: string; business_name: string; segment: string; email: string; phone: string | null }>(
        `select name, business_name, segment, email, phone from access_requests where id = $1 and status = 'novo' for update`,
        [id],
      );
      const r = rows[0];
      if (!r) throw notFound('Pedido não encontrado ou já decidido.');
      const segment = (SEGMENTS as readonly string[]).includes(r.segment) ? (r.segment as (typeof SEGMENTS)[number]) : 'outro';
      const c = await createOrganization(
        deps,
        req,
        { name: r.business_name, slug: body.slug, segment, contactEmail: r.email, contactPhone: r.phone, ownerName: r.name, ownerEmail: r.email },
        db,
      );
      await db.query(
        `update access_requests set status = 'aprovado', organization_id = $2, decided_by = app.uid(), decided_at = now() where id = $1`,
        [id, c.orgId],
      );
      return c;
    });
    return { id: created.orgId, slug: created.slug, ...(await inviteUser(deps, created.ownerId, me.id)) };
  });

  app.post('/api/platform/requests/:id/reject', async (req) => {
    requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query(
        `update access_requests set status = 'recusado', decided_by = app.uid(), decided_at = now() where id = $1 and status = 'novo'`,
        [id],
      );
      if (!r.rowCount) throw notFound('Pedido não encontrado ou já decidido.');
      await audit(db, req, 'platform.request_rejected', 'access_request', id);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------- plano e acesso

  const zDateOrNull = z.union([zDate, z.null()]);

  /** Plano da organização e liberação manual do acesso. */
  app.put('/api/platform/orgs/:id/plan', async (req) => {
    const me = requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(
      z
        .object({
          planName: zOptionalText(80),
          amountCents: z.coerce.number().int().min(0).max(100_000_000).nullable(),
          intervalMonths: zInterval,
          accessUntil: zDateOrNull,
          autoSuspend: z.boolean(),
          graceDays: z.coerce.number().int().min(0).max(60),
        })
        .strict(),
      req.body,
    );
    await withTx(deps.pools.owner, async (db) => {
      const r = await db.query(
        `update organizations set plan_name = $2, plan_amount_cents = $3, plan_interval_months = $4, access_until = $5,
                auto_suspend = $6, grace_days = $7,
                is_active = case when suspended_reason = 'inadimplencia' and ($5::date is null or $5::date >= app.org_today(id)) then true else is_active end,
                suspended_reason = case when suspended_reason = 'inadimplencia' and ($5::date is null or $5::date >= app.org_today(id)) then null else suspended_reason end
          where id = $1`,
        [id, b.planName, b.amountCents, b.intervalMonths, b.accessUntil, b.autoSuspend, b.graceDays],
      );
      if (!r.rowCount) throw notFound();
      await auditOrg(db, me.id, 'platform.plan_updated', id, req.ip, { accessUntil: b.accessUntil, autoSuspend: b.autoSuspend });
    });
    return { ok: true };
  });

  /** "Ativar plano": libera o acesso por N meses a partir de hoje (ou do fim do período atual) e reativa. */
  app.post('/api/platform/orgs/:id/extend', async (req) => {
    const me = requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ months: z.coerce.number().int().min(1).max(24) }).strict(), req.body);
    const accessUntil = await withTx(deps.pools.owner, async (db) => {
      const { rows } = await db.query<{ access_until: string }>(
        `update organizations
            set access_until = (greatest(coalesce(access_until, app.org_today(id)), app.org_today(id)) + make_interval(months => $2))::date,
                is_active = true, suspended_reason = null
          where id = $1 returning to_char(access_until, 'YYYY-MM-DD') as access_until`,
        [id, b.months],
      );
      if (!rows[0]) throw notFound();
      await auditOrg(db, me.id, 'platform.access_extended', id, req.ip, { months: b.months });
      return rows[0].access_until;
    });
    return { ok: true, accessUntil };
  });

  /** Organização usada pela plataforma para cobrar os próprios clientes (ex.: a empresa do Eduardo). */
  app.put('/api/platform/billing-org', async (req) => {
    const me = requirePlatform(req);
    const b = parse(z.object({ orgId: zUuid.nullable() }).strict(), req.body);
    await withTx(deps.pools.owner, async (db) => {
      await db.query('update organizations set is_billing_org = false where is_billing_org');
      if (b.orgId) {
        const r = await db.query('update organizations set is_billing_org = true where id = $1', [b.orgId]);
        if (!r.rowCount) throw notFound();
      }
      await auditOrg(db, me.id, 'platform.billing_org', b.orgId, req.ip);
    });
    return { ok: true };
  });

  app.get('/api/platform/billing-org', async (req) => {
    requirePlatform(req);
    const { rows } = await deps.pools.owner.query('select id, name from organizations where is_billing_org');
    return { org: rows[0] ?? null };
  });

  /**
   * Cobrança automática do plano: cria (na organização de cobrança da
   * plataforma) o cliente e a assinatura correspondentes. Os lembretes saem
   * sozinhos e, quando o pagamento é registrado, o acesso é renovado
   * automaticamente. Com suspensão automática, o acesso é bloqueado após o
   * vencimento + tolerância.
   */
  app.post('/api/platform/orgs/:id/auto-billing', async (req) => {
    const me = requirePlatform(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(z.object({ enable: z.boolean(), firstDueDate: zDate.optional() }).strict(), req.body);
    await withTx(deps.pools.owner, async (db) => {
      const { rows } = await db.query<{
        name: string; contact_email: string | null; contact_phone: string | null; document: string | null;
        plan_name: string | null; plan_amount_cents: number | null; plan_interval_months: number;
        billing_customer_id: string | null; is_billing_org: boolean; access_until: string | null;
      }>('select *, to_char(access_until, \'YYYY-MM-DD\') as access_until from organizations where id = $1 for update', [id]);
      const o = rows[0];
      if (!o) throw notFound();
      const billing = (await db.query<{ id: string }>('select id from organizations where is_billing_org')).rows[0];
      if (!b.enable) {
        if (o.billing_customer_id) {
          await db.query(
            `update charges set status = 'cancelada' where customer_id = $1 and status = 'aberta' and due_date >= app.org_today(organization_id)`,
            [o.billing_customer_id],
          );
          await db.query(`update subscriptions set status = 'cancelada', cancelled_at = now() where customer_id = $1 and status <> 'cancelada'`, [
            o.billing_customer_id,
          ]);
        }
        await db.query('update organizations set billing_customer_id = null where id = $1', [id]);
        await auditOrg(db, me.id, 'platform.auto_billing_off', id, req.ip);
        return;
      }
      if (!billing) throw new AppError(409, 'conflict', 'Defina antes a organização de cobrança da plataforma (em Organizações).');
      if (billing.id === id) throw new AppError(409, 'conflict', 'A organização de cobrança não pode cobrar a si mesma.');
      if (!o.plan_amount_cents) throw new AppError(422, 'invalid', 'Defina o valor do plano antes de ativar a cobrança automática.');
      if (o.billing_customer_id) throw new AppError(409, 'conflict', 'A cobrança automática já está ativa.');
      const first = b.firstDueDate ?? o.access_until;
      if (!first) throw new AppError(422, 'invalid', 'Informe a data do primeiro vencimento.');
      const cust = await db.query<{ id: string }>(
        `insert into customers (organization_id, name, email, phone, document, notes)
         values ($1, $2, $3, $4, $5, 'Cliente da plataforma Venceu (cobrança automática do plano).') returning id`,
        [billing.id, o.name.slice(0, 120), o.contact_email, o.contact_phone, o.document],
      );
      const sub = await db.query<{ id: string }>(
        `insert into subscriptions (organization_id, customer_id, description, amount_cents, interval_months, next_due_date, billing_day)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [billing.id, cust.rows[0]!.id, `Plano ${o.plan_name ?? 'Venceu'}`.slice(0, 120), o.plan_amount_cents, o.plan_interval_months, first, Number(first.slice(8, 10))],
      );
      await db.query('select app.generate_charges($1, 30)', [sub.rows[0]!.id]);
      await db.query('update organizations set billing_customer_id = $2, auto_suspend = true where id = $1', [id, cust.rows[0]!.id]);
      await auditOrg(db, me.id, 'platform.auto_billing_on', id, req.ip, { firstDueDate: first });
    });
    return { ok: true };
  });
}
