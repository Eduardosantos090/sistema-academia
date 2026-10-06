import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, requireUser } from '../../lib/context.js';
import { forbidden } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zPage } from '../../lib/normalize.js';

export function registerAuditRoutes(app: FastifyInstance, deps: Deps) {
  /** Plataforma: todos os eventos. Responsável: eventos da própria organização (RLS). */
  app.get('/api/audit', async (req) => {
    const me = requireUser(req);
    if (!me.isPlatformAdmin && me.role !== 'owner') throw forbidden();
    const q = parse(zPage.extend({ action: z.string().max(80).optional() }), req.query);
    return asUser(deps, req, async (db) => {
      const params: unknown[] = [];
      let where = '';
      if (q.action) {
        params.push(`${q.action.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        where = `where a.action like $1`;
      }
      params.push(q.pageSize, (q.page - 1) * q.pageSize);
      const { rows } = await db.query(
        `select a.id, a.action, a.entity_type as "entityType", a.entity_id as "entityId", a.details, a.ip::text as ip,
                a.created_at as "createdAt", u.full_name as "actorName", o.name as "organizationName"
           from audit_events a left join users u on u.id = a.actor_id left join organizations o on o.id = a.organization_id
           ${where} order by a.id desc limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      return { items: rows, page: q.page, pageSize: q.pageSize };
    });
  });
}
