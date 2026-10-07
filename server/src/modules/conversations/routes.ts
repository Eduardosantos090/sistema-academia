import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg } from '../../lib/context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { waMeLink, zText, zUuid } from '../../lib/normalize.js';
import { loadChannels, sendWhatsAppWithMedia, whatsappAutomatic } from '../channels/service.js';
import { mediaUrl } from '../../lib/media.js';
import { loadBotOrg, simulate } from '../bot/engine.js';
import { OutboundError } from '../../lib/http.js';

export function registerConversationRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/conversations', async (req) => {
    requireOrg(req);
    const q = parse(z.object({ status: z.enum(['todas', 'bot', 'humano', 'encerrada']).default('todas') }), req.query);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select cv.id, cv.phone, cv.status, cv.unread, cv.last_message_at as "lastMessageAt",
                cu.id as "customerId", cu.name as "customerName",
                (select body from chat_messages m where m.conversation_id = cv.id order by m.created_at desc limit 1) as "lastMessage"
           from conversations cv left join customers cu on cu.id = cv.customer_id
          where ($1 = 'todas' or cv.status::text = $1)
          order by (cv.unread > 0 and cv.status = 'humano') desc, cv.last_message_at desc
          limit 200`,
        [q.status],
      );
      return { items: rows };
    });
  });

  app.get('/api/conversations/:id', async (req) => {
    requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select cv.id, cv.phone, cv.status, cv.unread, cv.last_message_at as "lastMessageAt",
                cu.id as "customerId", cu.name as "customerName"
           from conversations cv left join customers cu on cu.id = cv.customer_id where cv.id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound('Conversa não encontrada.');
      const msgs = await db.query(
        `select m.id, m.direction, m.author, m.body, m.created_at as "createdAt", u.full_name as "userName",
                mf.token as "mediaToken", mf.name as "mediaName", mf.mime as "mediaMime"
           from chat_messages m left join users u on u.id = m.user_id left join media_files mf on mf.id = m.media_id
          where m.conversation_id = $1 order by m.created_at desc limit 200`,
        [id],
      );
      await db.query('update conversations set unread = 0 where id = $1 and unread > 0', [id]);
      const messages = msgs.rows.reverse().map(({ mediaToken, ...m }: { mediaToken: string | null; mediaName: string | null; [k: string]: unknown }) => ({
        ...m,
        mediaUrl: mediaToken ? mediaUrl(deps.config.appUrl, { token: mediaToken, name: m.mediaName! }) : null,
      }));
      return { ...rows[0], messages };
    });
  });

  app.patch('/api/conversations/:id', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(z.object({ status: z.enum(['bot', 'humano', 'encerrada']) }).strict(), req.body);
    await asUser(deps, req, async (db) => {
      const r = await db.query('update conversations set status = $2, unread = 0 where id = $1', [id, body.status]);
      if (!r.rowCount) throw notFound('Conversa não encontrada.');
      await audit(db, req, 'conversation.status', 'conversation', id, me.orgId, { status: body.status });
    });
    return { ok: true };
  });

  /** Resposta de um atendente. Com WhatsApp automático, é enviada; no modo manual, devolve o link. */
  app.post('/api/conversations/:id/reply', async (req) => {
    const me = requireOrg(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const body = parse(
      z
        .object({ text: z.string().max(4000).default(''), mediaId: zUuid.nullish() })
        .strict()
        .refine((b) => b.text.trim() || b.mediaId, { message: 'Escreva uma mensagem ou anexe um arquivo.', path: ['text'] }),
      req.body,
    );
    body.text = body.text.trim();
    await deps.limiters.sendNow.consume(`u:${me.id}`);
    const channels = await loadChannels(deps, me.orgId);
    const conv = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ phone: string; slug: string }>(
        `select cv.phone, o.slug from conversations cv join organizations o on o.id = cv.organization_id where cv.id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound('Conversa não encontrada.');
      let media: { token: string; name: string; mime: string } | null = null;
      if (body.mediaId) {
        const mf = await db.query<{ token: string; name: string; mime: string }>('select token, name, mime from media_files where id = $1', [body.mediaId]);
        if (!mf.rows[0]) throw notFound('Arquivo não encontrado.');
        media = mf.rows[0];
      }
      await db.query(
        `insert into chat_messages (organization_id, conversation_id, direction, author, body, user_id, media_id)
         values ($1, $2, 'out', 'atendente', $3, app.uid(), $4)`,
        [me.orgId, id, body.text || `[${media?.name ?? 'anexo'}]`, body.mediaId ?? null],
      );
      await db.query(`update conversations set status = 'humano', unread = 0, last_message_at = now() where id = $1`, [id]);
      return { ...rows[0], media };
    });
    const media = conv.media ? { url: mediaUrl(deps.config.appUrl, conv.media), mime: conv.media.mime, name: conv.media.name } : null;
    if (!whatsappAutomatic(channels)) {
      return { sent: false, waLink: waMeLink(conv.phone, [body.text, media ? `📎 ${media.url}` : ''].filter(Boolean).join('\n\n')) };
    }
    try {
      await sendWhatsAppWithMedia(deps, { slug: conv.slug }, channels, { to: conv.phone, body: body.text, media });
      return { sent: true, waLink: null };
    } catch (e) {
      throw new AppError(502, 'send_failed', e instanceof OutboundError ? e.message : 'Falha ao enviar pelo WhatsApp.');
    }
  });

  /** Simulador do assistente: mesma lógica do WhatsApp, sem gravar nem enviar nada. */
  app.post('/api/bot/simulate', async (req) => {
    const me = requireOrg(req);
    const body = parse(z.object({ customerId: zUuid.nullish(), text: z.string().max(1000) }).strict(), req.body);
    if (body.customerId) {
      const ok = await asUser(deps, req, (db) => db.query('select 1 from customers where id = $1', [body.customerId]));
      if (!ok.rowCount) throw notFound('Cliente não encontrado.');
    }
    const org = await loadBotOrg(deps.pools.owner, { id: me.orgId });
    if (!org) throw notFound();
    const d = await simulate(deps, org, body.customerId ?? null, body.text);
    const media = d.media ? { url: mediaUrl(deps.config.appUrl, d.media), mime: d.media.mime, name: d.media.name } : null;
    return { replies: d.replies, media, intent: d.intent, actions: d.actions };
  });
}
