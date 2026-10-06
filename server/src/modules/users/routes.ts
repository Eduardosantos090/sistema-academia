import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg, requireOwner, requireUser } from '../../lib/context.js';
import { withTx } from '../../lib/db.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zText, zUuid } from '../../lib/normalize.js';
import {
  ADMIN_RESET_TTL_MINUTES,
  INVITE_TTL_HOURS,
  createInvite,
  createResetToken,
  inviteLink,
  resetLink,
  sendInviteEmail,
} from '../auth/service.js';

/** Situação de acesso: convite pendente, ativo ou desativado (calculado pelo servidor privilegiado). */
export const ACCESS_STATUS_SQL = `case
  when not u.is_active then 'desativado'
  when exists (select 1 from user_credentials cr where cr.user_id = u.id) then 'ativo'
  when exists (select 1 from invites i where i.user_id = u.id and i.used_at is null and i.revoked_at is null and i.expires_at > now()) then 'convite_pendente'
  else 'convite_expirado' end`;

/**
 * Com SMTP, o convite vai por e-mail. No modo manual, o link é devolvido
 * SOMENTE a quem o gerou (nunca registrado em log ou auditoria).
 */
export async function deliverInvite(deps: Deps, email: string, name: string, token: string) {
  if (deps.config.mailMode === 'manual') return { inviteLink: inviteLink(deps, token), validHours: INVITE_TTL_HOURS };
  await sendInviteEmail(deps, email, name, token);
  return { inviteSent: true };
}

export async function inviteUser(deps: Deps, userId: string, createdBy: string) {
  const { rows } = await deps.pools.owner.query<{ email: string; full_name: string; has_password: boolean }>(
    `select u.email, u.full_name, exists (select 1 from user_credentials cr where cr.user_id = u.id) as has_password
       from users u where u.id = $1 and u.is_active`,
    [userId],
  );
  const u = rows[0];
  if (!u) throw notFound();
  if (u.has_password) throw conflict('Este usuário já definiu a senha. Use "Gerar link de redefinição".');
  const token = await withTx(deps.pools.owner, (db) => createInvite(deps, db, userId, createdBy));
  return deliverInvite(deps, u.email, u.full_name, token);
}

export async function adminResetLink(deps: Deps, userId: string) {
  if (deps.config.mailMode !== 'manual') {
    throw badRequest('Com e-mail configurado, a pessoa usa "Esqueci minha senha" na tela de acesso.');
  }
  const token = await withTx(deps.pools.owner, async (db) => {
    const ok = await db.query('select 1 from user_credentials where user_id = $1', [userId]);
    if (!ok.rowCount) throw conflict('Este usuário ainda não aceitou o convite. Reenvie o convite.');
    return createResetToken(db, userId, ADMIN_RESET_TTL_MINUTES);
  });
  return { resetLink: resetLink(deps, token), validHours: ADMIN_RESET_TTL_MINUTES / 60 };
}

const roles = ['owner', 'staff'] as const;

export function registerUserRoutes(app: FastifyInstance, deps: Deps) {
  /** Equipe da organização. */
  app.get('/api/team', async (req) => {
    const me = requireOrg(req);
    const { rows } = await deps.pools.owner.query(
      `select u.id, u.email, u.full_name as "fullName", u.role, u.is_active as "isActive",
              u.created_at as "createdAt", u.last_login_at as "lastLoginAt", ${ACCESS_STATUS_SQL} as "accessStatus"
         from users u where u.organization_id = $1
        order by u.is_active desc, u.full_name`,
      [me.orgId],
    );
    return { items: rows, mailMode: deps.config.mailMode };
  });

  app.post('/api/team', async (req, reply) => {
    const me = requireOwner(req);
    const body = parse(z.object({ email: zEmail, fullName: zText(2, 120), role: z.enum(roles) }).strict(), req.body);
    await deps.limiters.invite.consume(`u:${me.id}`);
    const id = await asUser(deps, req, async (db) => {
      const exists = await deps.pools.owner.query('select 1 from users where email = $1', [body.email]);
      if (exists.rowCount) throw conflict('Este e-mail já está em uso por outro usuário.');
      const { rows } = await db.query<{ id: string }>(
        'insert into users (email, full_name, organization_id, role) values ($1, $2, $3, $4) returning id',
        [body.email, body.fullName, me.orgId, body.role],
      );
      await audit(db, req, 'team.user_created', 'user', rows[0]!.id, me.orgId, { role: body.role });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id, ...(await inviteUser(deps, id, me.id)) };
  });

  app.patch('/api/team/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z.object({ fullName: zText(2, 120).optional(), role: z.enum(roles).optional(), isActive: z.boolean().optional() }).strict(),
      req.body,
    );
    await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `update users set full_name = coalesce($2, full_name), role = coalesce($3, role), is_active = coalesce($4, is_active)
          where id = $1 and organization_id = $5 returning id`,
        [id, body.fullName ?? null, body.role ?? null, body.isActive ?? null, me.orgId],
      );
      if (!rows[0]) throw notFound();
      await audit(db, req, 'team.user_updated', 'user', id, me.orgId, {
        role: body.role,
        isActive: body.isActive,
      });
    });
    // Sessões ficam em tabela exclusiva do servidor: encerradas pelo papel privilegiado.
    if (body.isActive === false || body.role) await deps.pools.owner.query('delete from sessions where user_id = $1', [id]);
    return { ok: true };
  });

  app.post('/api/team/:id/invite', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await deps.limiters.invite.consume(`u:${me.id}`);
    const ok = await deps.pools.owner.query('select 1 from users where id = $1 and organization_id = $2', [id, me.orgId]);
    if (!ok.rowCount) throw notFound();
    return inviteUser(deps, id, me.id);
  });

  app.post('/api/team/:id/reset-link', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const ok = await deps.pools.owner.query('select 1 from users where id = $1 and organization_id = $2 and is_active', [id, me.orgId]);
    if (!ok.rowCount) throw notFound();
    return adminResetLink(deps, id);
  });

  /** Dados do próprio usuário. */
  app.patch('/api/me', async (req) => {
    const me = requireUser(req);
    const body = parse(z.object({ fullName: zText(2, 120) }).strict(), req.body);
    await deps.pools.owner.query('update users set full_name = $2 where id = $1', [me.id, body.fullName]);
    return { ok: true };
  });
}
