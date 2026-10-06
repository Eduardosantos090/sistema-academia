import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Pools, Db, DbInfo } from './db.js';
import { withUser } from './db.js';
import type { Mailer } from './mailer.js';
import type { Limiters } from './rate-limit.js';
import type { HttpFetch } from './http.js';
import { forbidden, unauthorized } from './errors.js';

export type OrgRole = 'owner' | 'staff';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  orgId: string | null;
  orgName: string | null;
  role: OrgRole | null;
  isPlatformAdmin: boolean;
  sessionId: string;
  csrfToken: string;
}

export interface Deps {
  config: Config;
  pools: Pools;
  mailer: Mailer;
  dbInfo?: DbInfo;
  limiters: Limiters;
  /** Cliente HTTP de saída (WhatsApp/webhooks). Substituível nos testes. */
  fetch: HttpFetch;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    rawBody?: Buffer;
  }
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.authUser) throw unauthorized();
  return req.authUser;
}

/** Usuário vinculado a uma organização (equipe ou responsável). */
export function requireOrg(req: FastifyRequest): AuthUser & { orgId: string; role: OrgRole } {
  const u = requireUser(req);
  if (!u.orgId || !u.role) throw forbidden('Esta área é exclusiva das organizações.');
  return u as AuthUser & { orgId: string; role: OrgRole };
}

export function requireOwner(req: FastifyRequest) {
  const u = requireOrg(req);
  if (u.role !== 'owner') throw forbidden('Somente o responsável pela organização pode fazer esta operação.');
  return u;
}

export function requirePlatform(req: FastifyRequest) {
  const u = requireUser(req);
  if (!u.isPlatformAdmin) throw forbidden();
  return u;
}

/** Transação com RLS aplicada ao usuário autenticado desta requisição. */
export function asUser<T>(deps: Deps, req: FastifyRequest, fn: (db: Db, user: AuthUser) => Promise<T>): Promise<T> {
  const user = requireUser(req);
  return withUser(deps.pools.app, user.id, (db) => fn(db, user));
}

export async function audit(
  db: Db,
  req: FastifyRequest,
  action: string,
  entityType: string | null,
  entityId: string | null,
  orgId: string | null = null,
  details: Record<string, unknown> = {},
) {
  await db.query('select app.audit($1, $2, $3, $4, $5, $6)', [
    action,
    entityType,
    entityId,
    orgId,
    JSON.stringify(details),
    req.ip ?? null,
  ]);
}
