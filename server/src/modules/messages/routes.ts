import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg } from '../../lib/context.js';
import { AppError } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { Where } from '../../lib/sql.js';
import { waMeLink, zPage, zUuid } from '../../lib/normalize.js';
import { dispatchMessage } from '../automation/dispatch.js';
import { loadChannels, whatsappAutomatic } from '../channels/service.js';

export function registerMessageRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/messages', async (req) => {
    requireOrg(req);
    const q = parse(
      zPage.extend({
        status: z.enum(['pendente', 'manual', 'enviada', 'falhou', 'cancelada']).optional(),
        channel: z.enum(['whatsapp', 'email']).optional(),
      }),
      req.query,
    );
    return asUser(deps, req, async (db) => {
      const w = new Where();
      if (q.status) w.add('m.status = ?', q.status);
      if (q.channel) w.add('m.channel = ?', q.channel);
      const total = await db.query<{ n: number }>(`select count(*)::int as n from messages m ${w.clause}`, w.params);
      const lim = w.param(q.pageSize);
      const off = w.param((q.page - 1) * q.pageSize);
      const { rows } = await db.query<{ status: string; channel: string; toAddress: string; body: string }>(
        `select m.id, m.channel, m.kind, m.status, m.to_address as "toAddress", m.subject, m.body, m.error, m.attempts,
                m.created_at as "createdAt", m.sent_at as "sentAt", m.charge_id as "chargeId",
                cu.id as "customerId", cu.name as "customerName"
           from messages m left join customers cu on cu.id = m.customer_id
           ${w.clause} order by m.created_at desc limit ${lim} offset ${off}`,
        w.params,
      );
      const items = rows.map((m) => ({
        ...m,
        waLink: m.channel === 'whatsapp' && m.status === 'manual' ? waMeLink(m.toAddress, m.body) : null,
      }));
      const counts = await db.query(
        `select count(*) filter (where status = 'manual')::int as manual,
                count(*) filter (where status = 'pendente')::int as pendente,
                count(*) filter (where status = 'falhou' and created_at > now() - interval '7 days')::int as falhou,
                count(*) filter (where status = 'enviada' and sent_at > now() - interval '30 days')::int as enviadas30d
           from messages`,
      );
      return { items, total: total.rows[0]!.n, page: q.page, pageSize: q.pageSize, counts: counts.rows[0] };
    });
  });

  /** Envio manual de WhatsApp concluído pela equipe (clicou no link e enviou). */
  app.post('/api/messages/:id/mark-sent', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query(`update messages set status = 'enviada', sent_at = now() where id = $1 and status = 'manual'`, [id]);
      if (!r.rowCount) throw new AppError(409, 'conflict', 'Mensagem não está aguardando envio manual.');
      await audit(db, req, 'message.marked_sent', 'message', id, me.orgId);
    });
    return { ok: true };
  });

  app.post('/api/messages/:id/cancel', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query(
        `update messages set status = 'cancelada', error = 'Cancelada pela equipe.' where id = $1 and status in ('manual', 'pendente', 'falhou')`,
        [id],
      );
      if (!r.rowCount) throw new AppError(409, 'conflict', 'Esta mensagem não pode ser cancelada.');
      await audit(db, req, 'message.cancelled', 'message', id, me.orgId);
    });
    return { ok: true };
  });

  /** Nova tentativa de uma mensagem que falhou (ex.: depois de corrigir a integração). */
  app.post('/api/messages/:id/retry', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await deps.limiters.sendNow.consume(`u:${me.id}`);
    const channels = await loadChannels(deps, me.orgId);
    const msg = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ channel: string; to_address: string; body: string }>(
        `select channel, to_address, body from messages where id = $1 and status = 'falhou'`,
        [id],
      );
      const m = rows[0];
      if (!m) throw new AppError(409, 'conflict', 'Somente mensagens com falha podem ser reenviadas.');
      const manual = m.channel === 'whatsapp' && !whatsappAutomatic(channels);
      await db.query(`update messages set status = $2, error = null where id = $1`, [id, manual ? 'manual' : 'pendente']);
      await audit(db, req, 'message.retry', 'message', id, me.orgId);
      return { ...m, manual };
    });
    // Tentativas zeradas pelo servidor (coluna não editável pela equipe).
    await deps.pools.owner.query('update messages set attempts = 0 where id = $1 and organization_id = $2', [id, me.orgId]);
    if (msg.manual) return { status: 'manual', waLink: waMeLink(msg.to_address, msg.body), error: null };
    const r = await dispatchMessage(deps, id);
    return { status: r?.status ?? 'pendente', error: r?.error ?? null, waLink: null };
  });
}
