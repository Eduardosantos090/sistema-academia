import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Deps, AuthUser } from '../../lib/context.js';
import { requireUser } from '../../lib/context.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zPassword } from '../../lib/normalize.js';
import * as auth from './service.js';

export function sessionCookieName(deps: Deps) {
  return deps.config.secureCookies ? '__Host-vc_session' : 'vc_session';
}

function setSessionCookie(deps: Deps, reply: FastifyReply, token: string) {
  reply.setCookie(sessionCookieName(deps), token, {
    httpOnly: true,
    secure: deps.config.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: deps.config.SESSION_ABSOLUTE_HOURS * 3600,
  });
}

export function publicUser(u: AuthUser) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    orgId: u.orgId,
    orgName: u.orgName,
    role: u.role,
    isPlatformAdmin: u.isPlatformAdmin,
  };
}

const zToken = z.string().min(20).max(200);

export function registerAuthRoutes(app: FastifyInstance, deps: Deps) {
  app.post('/api/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = parse(z.object({ email: zEmail, password: z.string().min(1).max(200) }).strict(), req.body);
    const { token, user } = await auth.login(deps, body.email, body.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    setSessionCookie(deps, reply, token);
    return { user: publicUser(user), csrfToken: user.csrfToken };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const user = requireUser(req);
    await auth.logout(deps, user, req.ip);
    reply.clearCookie(sessionCookieName(deps), { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const user = requireUser(req);
    return { user: publicUser(user), csrfToken: user.csrfToken };
  });

  app.post('/api/auth/password-reset/request', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ email: zEmail }).strict(), req.body);
    await auth.requestPasswordReset(deps, body.email, req.ip);
    if (deps.config.mailMode === 'manual') {
      return {
        ok: true,
        message: 'A redefinição de senha é feita pelo responsável da sua conta. Solicite o link a ele.',
      };
    }
    return { ok: true, message: 'Se o e-mail estiver cadastrado e ativo, você receberá as instruções em instantes.' };
  });

  app.post('/api/auth/password-reset/confirm', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: zToken, password: zPassword }).strict(), req.body);
    await auth.confirmPasswordReset(deps, body.token, body.password, req.ip);
    return { ok: true };
  });

  app.post('/api/auth/invite/inspect', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: zToken }).strict(), req.body);
    return auth.inspectInvite(deps, body.token, req.ip);
  });

  app.post('/api/auth/invite/accept', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: zToken, password: zPassword }).strict(), req.body);
    await auth.acceptInvite(deps, body.token, body.password, req.ip);
    return { ok: true };
  });

  app.post('/api/auth/password/change', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ currentPassword: z.string().min(1).max(200), newPassword: zPassword }).strict(),
      req.body,
    );
    await auth.changePassword(deps, user, body.currentPassword, body.newPassword, req.ip);
    return { ok: true };
  });
}
