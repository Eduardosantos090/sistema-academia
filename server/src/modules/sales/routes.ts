import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { requirePlatform } from '../../lib/context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { newToken, safeEqual } from '../../lib/crypto.js';
import { encryptSecret } from '../../lib/secrets.js';
import { OutboundError } from '../../lib/http.js';
import { zEmail, zOptionalDocument, zOptionalPhone, zPassword, zText } from '../../lib/normalize.js';
import { SEGMENTS } from '../platform/routes.js';
import { getProduct, getStore, signatureOk, zAbacateKeyRe } from '../payments/abacatepay.js';
import { checkSignup, handleSubscriptionEvent, loadSaleConfig, saleAvailable, saleMode, startSignup } from './service.js';

const CYCLE_MONTHS: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUALLY: 6, ANNUALLY: 12, YEARLY: 12 };
const zToken = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) });

function deny(reply: FastifyReply) {
  return reply.code(403).send({ error: { code: 'forbidden', message: 'Não autorizado.' } });
}

export function registerSalesRoutes(app: FastifyInstance, deps: Deps) {
  // ------------------------------------------------------------ público

  /** Plano à venda (página de vendas). */
  app.get('/api/public/plan', { config: { public: true } }, async (_req, reply) => {
    const c = await loadSaleConfig(deps);
    reply.header('cache-control', 'public, max-age=60');
    const mode = saleMode(c);
    return {
      available: mode !== 'none',
      mode,
      checkoutUrl: mode === 'link' ? c.checkoutUrl : null,
      planName: c.planName,
      priceCents: c.priceCents,
      intervalMonths: c.intervalMonths,
      methods: c.methods,
    };
  });

  /** Cadastro + checkout de assinatura: devolve a URL de pagamento da AbacatePay. */
  app.post('/api/public/signup', { config: { public: true } }, async (req) => {
    const body = parse(
      z
        .object({
          ownerName: zText(2, 120),
          businessName: zText(2, 120),
          segment: z.enum(SEGMENTS).default('outro'),
          email: zEmail,
          phone: zOptionalPhone.pipe(z.string({ message: 'Informe o WhatsApp.' })),
          document: zOptionalDocument,
          password: zPassword,
          consent: z.literal(true, { message: 'É preciso aceitar os termos para continuar.' }),
          website: z.string().max(200).optional(),
        })
        .strict(),
      req.body,
    );
    await deps.limiters.accessRequestIp.consume(`signup:${req.ip}`);
    if (body.website) throw new AppError(400, 'bad_request', 'Não foi possível concluir.');
    return startSignup(deps, { ...body, document: body.document ?? null });
  });

  /** Situação do cadastro (página de conclusão; token entregue só a quem iniciou). */
  app.get('/api/public/signup/:token', { config: { public: true } }, async (req, reply) => {
    const { token } = parse(zToken, req.params);
    await deps.limiters.payIp.consume(`ip:${req.ip}`);
    const { rows } = await deps.pools.owner.query(
      `select status, email, business_name as "businessName", checkout_url as "checkoutUrl", error from signups where token = $1`,
      [token],
    );
    if (!rows[0]) throw notFound('Cadastro não encontrado.');
    reply.header('cache-control', 'no-store');
    return rows[0];
  });

  /** "Já paguei": confere na hora na AbacatePay. */
  app.post('/api/public/signup/:token/check', { config: { public: true } }, async (req) => {
    const { token } = parse(zToken, req.params);
    await deps.limiters.payIp.consume(`ip:${req.ip}`);
    const { rows } = await deps.pools.owner.query<{ id: string; checkout_id: string | null; status: string }>(
      'select id, checkout_id, status from signups where token = $1',
      [token],
    );
    const s = rows[0];
    if (!s) throw notFound('Cadastro não encontrado.');
    if (s.status === 'pendente') {
      const cfg = await loadSaleConfig(deps);
      if (cfg.apiKey) await checkSignup(deps, cfg.apiKey, s);
    }
    const r = await deps.pools.owner.query<{ status: string }>('select status from signups where id = $1', [s.id]);
    return { status: r.rows[0]!.status };
  });

  /** Webhook da AbacatePay para as assinaturas do Venceu (segredo na URL + assinatura HMAC). */
  app.post('/api/webhooks/abacatepay-venceu', { config: { public: true } }, async (req, reply) => {
    const cfg = await loadSaleConfig(deps);
    const raw = (req.query as Record<string, unknown>).webhookSecret;
    const given = (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === 'string').slice(0, 3);
    if (!cfg.apiKey || !cfg.webhookSecret || !given.some((v) => safeEqual(v, cfg.webhookSecret!))) return deny(reply);
    if (!signatureOk(req.rawBody, req.headers['x-webhook-signature'])) return deny(reply);
    await deps.limiters.webhookOrg.consume('abacate:platform');
    try {
      return await handleSubscriptionEvent(deps, cfg.apiKey, req.body);
    } catch (e) {
      // Falha temporária ao consultar a AbacatePay: 503 faz o provedor reenviar.
      req.log.warn({ err: e instanceof OutboundError ? e.message : 'erro' }, 'abacatepay: evento de assinatura não processado');
      return reply.code(503).send({ error: { code: 'retry', message: 'Tente novamente.' } });
    }
  });

  // ------------------------------------------------------------ plataforma

  app.get('/api/platform/sales', async (req) => {
    requirePlatform(req);
    const c = await loadSaleConfig(deps);
    const { rows } = await deps.pools.owner.query(
      `select s.id, s.business_name as "businessName", s.owner_name as "ownerName", s.email, s.phone, s.status, s.error,
              s.created_at as "createdAt", s.activated_at as "activatedAt", s.organization_id as "organizationId"
         from signups s order by s.created_at desc limit 50`,
    );
    return {
      enabled: c.enabled,
      available: saleAvailable(c),
      mode: saleMode(c),
      checkoutUrl: c.checkoutUrl,
      keyHint: c.apiKey ? `${c.apiKey.slice(0, 8)}…${c.apiKey.slice(-4)}` : null,
      productId: c.productId,
      planName: c.planName,
      priceCents: c.priceCents,
      intervalMonths: c.intervalMonths,
      methods: c.methods,
      webhookUrl: `${deps.config.appUrl}/api/webhooks/abacatepay-venceu`,
      webhookSecret: c.webhookSecret,
      signups: rows,
    };
  });

  app.put('/api/platform/sales', async (req) => {
    const me = requirePlatform(req);
    const body = parse(
      z
        .object({
          enabled: z.boolean(),
          apiKey: z.string().trim().regex(zAbacateKeyRe, 'Chave da API inválida.').optional(),
          productId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/, 'ID do produto inválido.'),
          planName: zText(2, 80),
          methods: z.array(z.enum(['CARD', 'PIX'])).min(1, 'Escolha ao menos uma forma de pagamento.').max(2),
          checkoutUrl: z
            .string()
            .trim()
            .regex(/^https:\/\/app\.abacatepay\.com\/pay\/[A-Za-z0-9_-]{1,200}$/, 'Use um link no formato https://app.abacatepay.com/pay/bill_…')
            .nullable()
            .optional(),
          regenerateWebhookSecret: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    await deps.limiters.sendNow.consume(`u:${me.id}`);
    const current = await loadSaleConfig(deps);
    const apiKey = body.apiKey || current.apiKey;
    if (body.enabled && !apiKey) throw new AppError(422, 'invalid', 'Informe a chave da API da AbacatePay (ou use só o link de checkout, com a venda pela API desligada).');
    let priceCents = current.priceCents;
    let intervalMonths = current.intervalMonths;
    let productName: string | null = null;
    if (apiKey && (body.enabled || body.apiKey)) {
      try {
        if (body.apiKey) await getStore(deps, body.apiKey);
        const p = await getProduct(deps, apiKey, body.productId);
        if (!p.cycle || !(p.cycle in CYCLE_MONTHS)) {
          throw new AppError(422, 'invalid', 'O produto precisa ser uma assinatura mensal, trimestral, semestral ou anual na AbacatePay.');
        }
        if (!Number.isFinite(p.price) || p.price < 100) throw new AppError(422, 'invalid', 'Preço do produto inválido na AbacatePay.');
        priceCents = Math.round(p.price);
        intervalMonths = CYCLE_MONTHS[p.cycle]!;
        productName = p.name;
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError(422, 'invalid', e instanceof OutboundError ? e.message : 'Não foi possível validar na AbacatePay.');
      }
    }
    const key = deps.config.secretsKey;
    const secret = !current.webhookSecret || body.regenerateWebhookSecret ? newToken() : current.webhookSecret;
    await deps.pools.owner.query(
      `update platform_settings set abacate_api_key_enc = $1, abacate_webhook_secret_enc = $2, sale_enabled = $3, sale_product_id = $4,
              sale_plan_name = $5, sale_price_cents = $6, sale_interval_months = $7, sale_methods = $8,
              sale_checkout_url = case when $9::boolean then $10 else sale_checkout_url end, updated_at = now()
        where id = 1`,
      [apiKey ? encryptSecret(key, apiKey) : null, encryptSecret(key, secret), body.enabled && !!apiKey, body.productId, body.planName,
        priceCents, intervalMonths, body.methods, body.checkoutUrl !== undefined, body.checkoutUrl ?? null],
    );
    await deps.pools.owner.query(
      `insert into audit_events (actor_id, action, entity_type, details, ip) values ($1, 'platform.sales_settings', 'platform', $2, $3)`,
      [me.id, JSON.stringify({ enabled: body.enabled, productId: body.productId, priceCents, methods: body.methods }), req.ip],
    );
    return { ok: true, productName, priceCents, intervalMonths };
  });
}
