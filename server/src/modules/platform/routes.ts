import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requirePlatform } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zOptionalEmail, zOptionalPhone, zText, zUuid } from '../../lib/normalize.js';
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
              ch.whatsapp_mode as "whatsappMode"
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
              is_active as "isActive", created_at as "createdAt"
         from organizations where id = $1`,
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
        `update organizations set name = coalesce($2, name), segment = coalesce($3, segment), is_active = coalesce($4, is_active)
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
}
