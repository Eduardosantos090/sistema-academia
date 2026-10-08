import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOwner } from '../../lib/context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { newToken, safeEqual } from '../../lib/crypto.js';
import { encryptSecret } from '../../lib/secrets.js';
import { OutboundError } from '../../lib/http.js';
import { getStore, signatureOk, simulatePixPayment, zAbacateKeyRe } from './abacatepay.js';
import { loadAbacate, payPage, pendingByProviderIds, refreshPix } from './service.js';

const zToken = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });
const zHook = z.object({ hookId: z.string().regex(/^[0-9a-f]{64}$/) });

function deny(reply: FastifyReply) {
  return reply.code(403).send({ error: { code: 'forbidden', message: 'Não autorizado.' } });
}

/** Identificadores citados no corpo do webhook (valores de "id"), com limites de profundidade e quantidade. */
export function collectIds(body: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || out.size >= 20 || !body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k === 'id' && typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v)) out.add(v);
    else if (v && typeof v === 'object') collectIds(v, out, depth + 1);
    if (out.size >= 20) break;
  }
  return out;
}

async function latestPending(deps: Deps, token: string) {
  const { rows } = await deps.pools.owner.query<{
    id: string; organization_id: string; charge_id: string; provider_id: string; amount_cents: number; dev_mode: boolean;
  }>(
    `select p.id, p.organization_id, p.charge_id, p.provider_id, p.amount_cents, p.dev_mode
       from online_payments p join charges c on c.id = p.charge_id
      where c.pay_token = $1 and c.status = 'aberta' and p.status = 'PENDING'
      order by p.created_at desc limit 1`,
    [token],
  );
  return rows[0] ?? null;
}

export function registerPaymentRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------ página pública

  /** Dados da cobrança e PIX (copia e cola + QR Code) para o cliente pagar. */
  app.get('/api/pay/:token', { config: { public: true } }, async (req, reply) => {
    const { token } = parse(zToken, req.params);
    await deps.limiters.payIp.consume(`ip:${req.ip}`);
    const page = await payPage(deps, token);
    if (!page) throw notFound('Cobrança não encontrada.');
    reply.header('cache-control', 'no-store');
    reply.header('x-robots-tag', 'noindex');
    return page;
  });

  /** "Já paguei": confere na hora no provedor. */
  app.post('/api/pay/:token/check', { config: { public: true } }, async (req) => {
    const { token } = parse(zToken, req.params);
    await deps.limiters.payIp.consume(`ip:${req.ip}`);
    const p = await latestPending(deps, token);
    if (!p) {
      const { rows } = await deps.pools.owner.query<{ status: string }>('select status from charges where pay_token = $1', [token]);
      if (!rows[0]) throw notFound('Cobrança não encontrada.');
      return { status: rows[0].status };
    }
    const cfg = await loadAbacate(deps, p.organization_id);
    if (!cfg) throw new AppError(409, 'conflict', 'Pagamento online indisponível.');
    try {
      const st = await refreshPix(deps, p, cfg.apiKey);
      return { status: st === 'PAID' ? 'paga' : 'aberta' };
    } catch (e) {
      throw new AppError(502, 'provider', e instanceof OutboundError ? 'Não foi possível conferir agora. Tente em instantes.' : 'Falha ao conferir.');
    }
  });

  /** Somente com chave de TESTE da AbacatePay: simula o pagamento para validar o fluxo. */
  app.post('/api/pay/:token/simulate', { config: { public: true } }, async (req) => {
    const { token } = parse(zToken, req.params);
    await deps.limiters.payIp.consume(`ip:${req.ip}`);
    const p = await latestPending(deps, token);
    if (!p || !p.dev_mode) throw new AppError(409, 'conflict', 'Simulação disponível apenas em modo de teste.');
    const cfg = await loadAbacate(deps, p.organization_id);
    if (!cfg) throw new AppError(409, 'conflict', 'Pagamento online indisponível.');
    try {
      await simulatePixPayment(deps, cfg.apiKey, p.provider_id);
      const st = await refreshPix(deps, p, cfg.apiKey);
      return { status: st === 'PAID' ? 'paga' : 'aberta' };
    } catch (e) {
      throw new AppError(502, 'provider', e instanceof OutboundError ? e.message : 'Falha ao simular.');
    }
  });

  // ------------------------------------------------------------ webhook

  /**
   * Aviso de pagamento da AbacatePay. Autenticado pelo segredo (parâmetro
   * webhookSecret) da organização; a baixa só acontece depois de consultar o
   * PIX na API com a chave da organização.
   */
  app.post('/api/webhooks/abacatepay/:hookId', { config: { public: true } }, async (req, reply) => {
    const p = zHook.safeParse(req.params);
    if (!p.success) return deny(reply);
    const { rows } = await deps.pools.owner.query<{ id: string }>('select id from organizations where webhook_id = $1 and is_active', [p.data.hookId]);
    const org = rows[0];
    if (!org) return deny(reply);
    const cfg = await loadAbacate(deps, org.id);
    // A AbacatePay envia o segredo no parâmetro webhookSecret (pode vir repetido se a URL já o continha).
    const raw = (req.query as Record<string, unknown>).webhookSecret;
    const given = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string').slice(0, 3);
    if (!cfg?.webhookSecret || !given.some((v) => safeEqual(v, cfg.webhookSecret!))) return deny(reply);
    if (!signatureOk(req.rawBody, req.headers['x-webhook-signature'])) return deny(reply);
    await deps.limiters.webhookOrg.consume(`abacate:${org.id}`);
    const pending = await pendingByProviderIds(deps, org.id, [...collectIds(req.body)]);
    let paid = 0;
    for (const pix of pending) {
      try {
        if ((await refreshPix(deps, pix, cfg.apiKey)) === 'PAID') paid++;
      } catch (e) {
        req.log.warn({ err: e instanceof OutboundError ? e.message : 'erro' }, 'abacatepay: falha ao conferir PIX');
      }
    }
    return { ok: true, processed: pending.length, paid };
  });

  // ------------------------------------------------------------ configuração

  app.get('/api/settings/payments', async (req) => {
    const me = requireOwner(req);
    const cfg = await loadAbacate(deps, me.orgId);
    const { rows } = await deps.pools.owner.query<{ webhook_id: string; online_pay: boolean }>(
      'select webhook_id, online_pay from organizations where id = $1',
      [me.orgId],
    );
    const o = rows[0]!;
    return {
      provider: 'abacatepay',
      enabled: o.online_pay && !!cfg,
      keyHint: cfg ? `${cfg.apiKey.slice(0, 8)}…${cfg.apiKey.slice(-4)}` : null,
      testMode: cfg ? /^abc_dev_/.test(cfg.apiKey) : false,
      // Endereço a cadastrar no painel da AbacatePay (contém o segredo: só para o responsável).
      webhookUrl: cfg?.webhookSecret ? `${deps.config.appUrl}/api/webhooks/abacatepay/${o.webhook_id}?webhookSecret=${cfg.webhookSecret}` : null,
      webhookBase: `${deps.config.appUrl}/api/webhooks/abacatepay/${o.webhook_id}`,
      webhookSecret: cfg?.webhookSecret ?? null,
    };
  });

  app.put('/api/settings/payments', async (req) => {
    const me = requireOwner(req);
    const body = parse(
      z
        .object({
          enabled: z.boolean(),
          apiKey: z.string().trim().regex(zAbacateKeyRe, 'Chave da API inválida.').optional(),
          regenerateWebhookSecret: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    const key = deps.config.secretsKey;
    const current = await loadAbacate(deps, me.orgId);
    const apiKey = body.apiKey || current?.apiKey || null;
    if (body.enabled && !apiKey) throw new AppError(422, 'invalid', 'Informe a chave da API da AbacatePay.');
    let storeName: string | null = null;
    if (body.enabled && body.apiKey) {
      await deps.limiters.sendNow.consume(`u:${me.id}`);
      try {
        storeName = (await getStore(deps, body.apiKey)).name;
      } catch (e) {
        throw new AppError(422, 'invalid', e instanceof OutboundError ? e.message : 'Não foi possível validar a chave.');
      }
    }
    const webhookSecret = !current?.webhookSecret || body.regenerateWebhookSecret ? newToken() : current.webhookSecret;
    await deps.pools.owner.query(
      `insert into org_channels (organization_id, abacate_api_key_enc, abacate_webhook_secret_enc) values ($1, $2, $3)
       on conflict (organization_id) do update set abacate_api_key_enc = $2, abacate_webhook_secret_enc = $3`,
      [me.orgId, apiKey ? encryptSecret(key, apiKey) : null, encryptSecret(key, webhookSecret)],
    );
    await deps.pools.owner.query('update organizations set online_pay = $2 where id = $1', [me.orgId, body.enabled && !!apiKey]);
    await asUser(deps, req, (db) => audit(db, req, 'settings.payments', 'organization', me.orgId, me.orgId, { enabled: body.enabled, provider: 'abacatepay' }));
    return { ok: true, storeName };
  });
}
