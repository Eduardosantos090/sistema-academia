import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOwner, requirePlatform } from '../../lib/context.js';
import { AppError } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { newToken, safeEqual } from '../../lib/crypto.js';
import { encryptSecret } from '../../lib/secrets.js';
import { OutboundError, validateOutboundUrl } from '../../lib/http.js';
import { normalizePhone } from '../../lib/normalize.js';
import { mediaUrl } from '../../lib/media.js';
import { handleIncoming, loadBotOrg } from '../bot/engine.js';
import { loadChannels, sendWhatsAppWithMedia } from './service.js';
import {
  checkServer,
  connectInstance,
  createInstance,
  deleteInstance,
  instanceNameFor,
  instanceState,
  loadEvolutionServer,
  logoutInstance,
  type EvoState,
} from './evolution.js';

const zHook = z.object({ hookId: z.string().regex(/^[0-9a-f]{64}$/) });

function deny(reply: FastifyReply) {
  return reply.code(403).send({ error: { code: 'forbidden', message: 'Não autorizado.' } });
}

const providerError = (e: unknown) =>
  new AppError(502, 'provider', e instanceof OutboundError ? e.message : 'Não foi possível falar com o servidor de WhatsApp.');

/** Texto de uma mensagem recebida pela Evolution (texto, legenda ou resposta de botão/lista). */
function messageText(m: Record<string, unknown> | undefined): string | null {
  if (!m) return null;
  const pick = (o: unknown, k: string) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined);
  const candidates = [
    m.conversation,
    pick(m.extendedTextMessage, 'text'),
    pick(m.imageMessage, 'caption'),
    pick(m.videoMessage, 'caption'),
    pick(m.documentMessage, 'caption'),
    pick(m.buttonsResponseMessage, 'selectedDisplayText'),
    pick(m.templateButtonReplyMessage, 'selectedDisplayText'),
    pick(pick(m.listResponseMessage, 'singleSelectReply'), 'selectedRowId'),
  ];
  const t = candidates.find((x) => typeof x === 'string' && x.trim());
  if (typeof t === 'string') return t.slice(0, 4096);
  if (m.audioMessage) return '[áudio recebido]';
  if (m.imageMessage) return '[imagem recebida]';
  if (m.documentMessage) return '[documento recebido]';
  if (m.videoMessage) return '[vídeo recebido]';
  return null;
}

export function registerQrCodeRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------ organização

  /** Gera (ou reaproveita) a conexão e devolve o QR Code para ler no celular. */
  app.post('/api/settings/whatsapp/qrcode/connect', async (req) => {
    const me = requireOwner(req);
    await deps.limiters.sendNow.consume(`qr:${me.id}`);
    const server = await loadEvolutionServer(deps);
    if (!server) throw new AppError(409, 'conflict', 'A conexão por QR Code ainda não foi habilitada pela administração do Venceu.');
    const c = await loadChannels(deps, me.orgId);
    const key = deps.config.secretsKey;
    try {
      if (!c.evo) {
        const { rows } = await deps.pools.owner.query<{ slug: string; webhook_id: string }>('select slug, webhook_id from organizations where id = $1', [me.orgId]);
        const org = rows[0]!;
        const name = instanceNameFor(org.slug, me.orgId);
        const secret = newToken();
        // Se sobrou uma instância com o mesmo nome (tentativa anterior), recomeça do zero.
        await deleteInstance(deps, server, name);
        const created = await createInstance(deps, server, {
          name,
          webhookUrl: `${deps.config.appUrl}/api/webhooks/evolution/${org.webhook_id}`,
          webhookSecret: secret,
        });
        await deps.pools.owner.query(
          `insert into org_channels (organization_id, evo_instance, evo_token_enc, evo_webhook_secret_enc, evo_status)
           values ($1, $2, $3, $4, $5)
           on conflict (organization_id) do update set evo_instance = $2, evo_token_enc = $3, evo_webhook_secret_enc = $4, evo_status = $5`,
          [me.orgId, name, encryptSecret(key, created.token), encryptSecret(key, secret), created.state],
        );
        await asUser(deps, req, (db) => audit(db, req, 'settings.whatsapp_qrcode', 'organization', me.orgId, me.orgId, { action: 'create' }));
        if (created.qr || created.state === 'open') return { state: created.state, qr: created.qr };
        const again = await connectInstance(deps, server, name, created.token);
        return again;
      }
      const r = await connectInstance(deps, server, c.evo.name, c.evo.token);
      await setState(deps, me.orgId, r.state);
      return r;
    } catch (e) {
      throw providerError(e);
    }
  });

  /** Situação da conexão (a tela consulta a cada poucos segundos enquanto mostra o QR Code). */
  app.get('/api/settings/whatsapp/qrcode/status', async (req) => {
    const me = requireOwner(req);
    const c = await loadChannels(deps, me.orgId);
    if (!c.evo?.server) return { state: 'close' as EvoState, number: null, active: false };
    try {
      const state = await instanceState(deps, c.evo.server, c.evo.name, c.evo.token);
      await setState(deps, me.orgId, state);
      return { state, number: c.evo.number, active: state === 'open' };
    } catch (e) {
      throw providerError(e);
    }
  });

  /** Desconecta o número (o celular deixa de estar ligado ao Venceu). */
  app.post('/api/settings/whatsapp/qrcode/disconnect', async (req) => {
    const me = requireOwner(req);
    const c = await loadChannels(deps, me.orgId);
    if (c.evo?.server) {
      await logoutInstance(deps, c.evo.server, c.evo.name, c.evo.token);
      await deleteInstance(deps, c.evo.server, c.evo.name);
    }
    await deps.pools.owner.query(
      `update org_channels set evo_instance = null, evo_token_enc = null, evo_webhook_secret_enc = null, evo_status = null, evo_number = null,
              whatsapp_mode = case when whatsapp_mode = 'qrcode' then 'manual'::whatsapp_mode else whatsapp_mode end
        where organization_id = $1`,
      [me.orgId],
    );
    await asUser(deps, req, (db) => audit(db, req, 'settings.whatsapp_qrcode', 'organization', me.orgId, me.orgId, { action: 'disconnect' }));
    return { ok: true };
  });

  // ------------------------------------------------------------ webhook de entrada

  /** Eventos da Evolution: mensagens recebidas (vão para o assistente) e mudança de conexão. */
  app.post('/api/webhooks/evolution/:hookId', { config: { public: true } }, async (req, reply) => {
    const p = zHook.safeParse(req.params);
    if (!p.success) return deny(reply);
    const org = await loadBotOrg(deps.pools.owner, { webhookId: p.data.hookId });
    if (!org?.is_active) return deny(reply);
    const c = await loadChannels(deps, org.id);
    const token = req.headers['x-venceu-token'];
    if (!c.evo || !c.evoWebhookSecret || typeof token !== 'string' || !safeEqual(token, c.evoWebhookSecret)) return deny(reply);
    await deps.limiters.webhookOrg.consume(`evo:${org.id}`);

    const body = req.body as { event?: unknown; instance?: unknown; data?: Record<string, unknown> } | undefined;
    if (body?.instance !== undefined && body.instance !== c.evo.name) return { ok: true, ignored: true };
    const event = String(body?.event ?? '').toLowerCase();

    if (event === 'connection.update') {
      const state = body?.data?.state;
      const wuid = typeof body?.data?.wuid === 'string' ? body.data.wuid : null;
      const number = wuid ? normalizePhone(`+${wuid.split('@')[0]!.replace(/\D/g, '')}`) : null;
      if (state === 'open' || state === 'connecting' || state === 'close') await setState(deps, org.id, state, number);
      return { ok: true };
    }

    if (event === 'messages.upsert') {
      const list = Array.isArray(body?.data) ? (body!.data as unknown[]) : [body?.data];
      for (const raw of list.slice(0, 20)) {
        const m = raw as { key?: { remoteJid?: unknown; remoteJidAlt?: unknown; fromMe?: unknown; id?: unknown }; message?: Record<string, unknown> } | undefined;
        if (!m?.key || m.key.fromMe === true) continue;
        const jid = [m.key.remoteJid, m.key.remoteJidAlt].find((j) => typeof j === 'string' && j.endsWith('@s.whatsapp.net')) as string | undefined;
        if (!jid) continue; // grupos, status e contatos sem número
        const phone = normalizePhone(`+${jid.split('@')[0]!.replace(/\D/g, '')}`);
        const text = messageText(m.message);
        if (!phone || !text) continue;
        const r = await handleIncoming(deps, org, phone, text, typeof m.key.id === 'string' ? m.key.id.slice(0, 200) : null);
        if (c.mode === 'qrcode') {
          for (const [i, replyText] of r.replies.entries()) {
            const media = i === 0 && r.media ? { url: mediaUrl(deps.config.appUrl, r.media), mime: r.media.mime, name: r.media.name } : null;
            await sendWhatsAppWithMedia(deps, org, c, { to: phone, body: replyText, media }).catch((err) =>
              req.log.warn({ err: { message: (err as Error).message } }, 'falha ao responder pelo WhatsApp (QR Code)'),
            );
          }
        }
      }
      return { ok: true };
    }
    return { ok: true, ignored: true };
  });

  // ------------------------------------------------------------ plataforma

  app.get('/api/platform/whatsapp-server', async (req) => {
    requirePlatform(req);
    const s = await loadEvolutionServer(deps);
    const { rows } = await deps.pools.owner.query<{ n: number; open: number }>(
      `select count(*)::int as n, count(*) filter (where evo_status = 'open')::int as open from org_channels where evo_instance is not null`,
    );
    return { url: s?.url ?? null, configured: !!s, keyHint: s ? `…${s.globalKey.slice(-4)}` : null, instances: rows[0]!.n, connected: rows[0]!.open };
  });

  app.put('/api/platform/whatsapp-server', async (req) => {
    const me = requirePlatform(req);
    const body = parse(
      z
        .object({
          url: z.string().trim().max(300).nullable(),
          apiKey: z.string().trim().min(8, 'Chave inválida.').max(300).optional(),
        })
        .strict(),
      req.body,
    );
    await deps.limiters.sendNow.consume(`u:${me.id}`);
    const current = await loadEvolutionServer(deps);
    if (!body.url) {
      await deps.pools.owner.query('update platform_settings set evolution_url = null, evolution_key_enc = null where id = 1');
      return { ok: true };
    }
    let url: string;
    try {
      url = validateOutboundUrl(body.url).toString().replace(/\/+$/, '');
    } catch (e) {
      throw new AppError(422, 'invalid', e instanceof OutboundError ? e.message : 'Endereço inválido.');
    }
    if (!/^https:\/\//.test(url)) throw new AppError(422, 'invalid', 'Use um endereço https://.');
    const key = body.apiKey || current?.globalKey;
    if (!key) throw new AppError(422, 'invalid', 'Informe a chave global (AUTHENTICATION_API_KEY) do servidor.');
    try {
      await checkServer(deps, { url, globalKey: key });
    } catch (e) {
      throw new AppError(422, 'invalid', e instanceof OutboundError ? e.message : 'Não foi possível conectar ao servidor.');
    }
    await deps.pools.owner.query('update platform_settings set evolution_url = $1, evolution_key_enc = $2 where id = 1', [
      url,
      encryptSecret(deps.config.secretsKey, key),
    ]);
    await deps.pools.owner.query(
      `insert into audit_events (actor_id, action, entity_type, details, ip) values ($1, 'platform.whatsapp_server', 'platform', $2, $3)`,
      [me.id, JSON.stringify({ url }), req.ip],
    );
    return { ok: true };
  });
}

/** Grava o estado da conexão; conectado, passa a organização para o modo QR Code. */
async function setState(deps: Deps, orgId: string, state: EvoState, number?: string | null) {
  await deps.pools.owner.query(
    `update org_channels set evo_status = $2, evo_number = coalesce($3, evo_number),
            whatsapp_mode = case when $2 = 'open' then 'qrcode'::whatsapp_mode else whatsapp_mode end
      where organization_id = $1 and evo_instance is not null`,
    [orgId, state, number ?? null],
  );
}
