import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { safeEqual } from '../../lib/crypto.js';
import { hmacHex } from '../../lib/secrets.js';
import { normalizePhone } from '../../lib/normalize.js';
import { loadChannels, sendWhatsAppWithMedia, signWebhook } from '../channels/service.js';
import { mediaKind, mediaUrl } from '../../lib/media.js';
import { handleIncoming, loadBotOrg } from '../bot/engine.js';

/**
 * Webhooks de ENTRADA (mensagens recebidas pelo WhatsApp).
 *
 * O endereço contém um identificador aleatório por organização, e TODA
 * requisição precisa de assinatura HMAC válida (App Secret da Meta ou
 * segredo do webhook). Sem assinatura válida, nada é processado.
 * Respostas não revelam se a organização existe.
 */

const zHook = z.object({ hookId: z.string().regex(/^[0-9a-f]{64}$/) });
const MAX_SKEW_SECONDS = 300;

function deny(reply: FastifyReply) {
  return reply.code(403).send({ error: { code: 'forbidden', message: 'Assinatura inválida.' } });
}

async function findOrg(deps: Deps, req: FastifyRequest) {
  const p = zHook.safeParse(req.params);
  if (!p.success) return null;
  const org = await loadBotOrg(deps.pools.owner, { webhookId: p.data.hookId });
  return org?.is_active ? org : null;
}

interface CloudMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

export function registerWebhookRoutes(app: FastifyInstance, deps: Deps) {
  /** Verificação do webhook pela Meta (hub.challenge). */
  app.get('/api/webhooks/whatsapp/:hookId', { config: { public: true } }, async (req, reply) => {
    const org = await findOrg(deps, req);
    const q = req.query as Record<string, string | undefined>;
    if (!org) return deny(reply);
    const c = await loadChannels(deps, org.id);
    const token = q['hub.verify_token'];
    if (q['hub.mode'] !== 'subscribe' || !c.verifyToken || typeof token !== 'string' || !safeEqual(token, c.verifyToken)) {
      return deny(reply);
    }
    const challenge = String(q['hub.challenge'] ?? '');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(challenge)) return deny(reply);
    return reply.type('text/plain').send(challenge);
  });

  /** Mensagens recebidas pela WhatsApp Cloud API (Meta). */
  app.post('/api/webhooks/whatsapp/:hookId', { config: { public: true } }, async (req, reply) => {
    const org = await findOrg(deps, req);
    if (!org) return deny(reply);
    const c = await loadChannels(deps, org.id);
    const sig = req.headers['x-hub-signature-256'];
    if (!c.appSecret || typeof sig !== 'string' || !req.rawBody) return deny(reply);
    if (!safeEqual(sig, `sha256=${hmacHex(c.appSecret, req.rawBody)}`)) return deny(reply);
    await deps.limiters.webhookOrg.consume(`wa:${org.id}`);

    const body = req.body as { entry?: { changes?: { value?: { messages?: CloudMessage[] } }[] }[] };
    const incoming: CloudMessage[] = [];
    for (const e of body?.entry ?? []) for (const ch of e.changes ?? []) incoming.push(...(ch.value?.messages ?? []));
    for (const m of incoming.slice(0, 20)) {
      const phone = m.from ? normalizePhone(`+${m.from}`) : null;
      if (!phone) continue;
      const text =
        m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? `[${m.type ?? 'mensagem'} recebida]`;
      const r = await handleIncoming(deps, org, phone, String(text).slice(0, 4096), m.id ? String(m.id).slice(0, 200) : null);
      if (c.mode === 'cloud_api') {
        for (const [i, reply] of r.replies.entries()) {
          const media = i === 0 && r.media ? { url: mediaUrl(deps.config.appUrl, r.media), mime: r.media.mime, name: r.media.name } : null;
          await sendWhatsAppWithMedia(deps, org, c, { to: phone, body: reply, media }).catch((err) =>
            req.log.warn({ err: { message: (err as Error).message } }, 'falha ao responder pelo WhatsApp'),
          );
        }
      }
    }
    return { ok: true };
  });

  /**
   * Webhook genérico de entrada (Z-API, Evolution API, n8n, Make…):
   * POST { from, text, id } com cabeçalhos X-Venceu-Timestamp e
   * X-Venceu-Signature = sha256=HMAC(segredo, "<timestamp>.<corpo>").
   * As respostas do assistente voltam no corpo da resposta (replies).
   */
  app.post('/api/webhooks/inbound/:hookId', { config: { public: true } }, async (req, reply) => {
    const org = await findOrg(deps, req);
    if (!org) return deny(reply);
    const c = await loadChannels(deps, org.id);
    const ts = req.headers['x-venceu-timestamp'];
    const sig = req.headers['x-venceu-signature'];
    if (!c.webhookSecret || typeof ts !== 'string' || typeof sig !== 'string' || !req.rawBody) return deny(reply);
    if (!/^\d{9,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) return deny(reply);
    if (!safeEqual(sig, signWebhook(c.webhookSecret, ts, req.rawBody.toString('utf8')))) return deny(reply);
    await deps.limiters.webhookOrg.consume(`in:${org.id}`);

    const p = z
      .object({ from: z.string().max(40), text: z.string().max(4096), id: z.string().min(1).max(200) })
      .safeParse(req.body);
    // "id" é obrigatório: impede que uma requisição assinada capturada seja reenviada (deduplicação).
    if (!p.success) return reply.code(422).send({ error: { code: 'invalid', message: 'Envie { from, text, id } (id único da mensagem).' } });
    const phone = normalizePhone(p.data.from.startsWith('+') ? p.data.from : `+${p.data.from.replace(/\D/g, '')}`);
    if (!phone) return reply.code(422).send({ error: { code: 'invalid', message: 'Telefone inválido.' } });
    const r = await handleIncoming(deps, org, phone, p.data.text, p.data.id);
    const media = r.media
      ? { url: mediaUrl(deps.config.appUrl, r.media), mime: r.media.mime, name: r.media.name, kind: mediaKind(r.media.mime) }
      : null;
    return { replies: r.replies, media, intent: r.intent };
  });
}
