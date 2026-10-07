import path from 'node:path';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import { z } from 'zod';
import type { Deps } from './lib/context.js';
import { AppError, forbidden, fromPgError, unauthorized } from './lib/errors.js';
import { ValidationError } from './lib/validate.js';
import { safeEqual } from './lib/crypto.js';
import { resolveSession } from './modules/auth/service.js';
import { registerAuthRoutes, sessionCookieName } from './modules/auth/routes.js';
import { registerUserRoutes } from './modules/users/routes.js';
import { registerPlatformRoutes } from './modules/platform/routes.js';
import { registerCustomerRoutes } from './modules/customers/routes.js';
import { registerPlanRoutes } from './modules/plans/routes.js';
import { registerSubscriptionRoutes } from './modules/subscriptions/routes.js';
import { registerChargeRoutes } from './modules/charges/routes.js';
import { registerMessageRoutes } from './modules/messages/routes.js';
import { registerConversationRoutes } from './modules/conversations/routes.js';
import { registerSettingsRoutes } from './modules/settings/routes.js';
import { registerDashboardRoutes } from './modules/dashboard/routes.js';
import { registerPublicRoutes } from './modules/public/routes.js';
import { registerWebhookRoutes } from './modules/webhooks/routes.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import { registerMediaRoutes } from './modules/media/routes.js';
import { registerReminderRoutes } from './modules/reminders/routes.js';

z.config(z.locales.pt());

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            // Nunca registrar cookies, cabeçalhos de autenticação, corpos ou query strings.
            serializers: {
              req: (req) => ({ method: req.method, url: req.url.split('?')[0], id: req.id }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
          },
  });

  // JSON com o corpo bruto preservado: os webhooks validam a assinatura HMAC sobre os bytes recebidos.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer;
    req.rawBody = buf;
    if (!buf.length) return done(null, undefined);
    try {
      done(null, JSON.parse(buf.toString('utf8')));
    } catch {
      done(new AppError(400, 'bad_request', 'JSON inválido.'), undefined);
    }
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.secureCookies ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.secureCookies ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
  });

  // CORS: por padrão, somente mesma origem. Origens extras só por configuração explícita.
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || req.url.startsWith('/api/webhooks/')) return;
    const self = new URL(config.APP_URL).origin;
    // Mesmo site que atende a requisição (ex.: domínio próprio e endereço .netlify.app do mesmo site).
    const host = req.headers.host;
    const sameHost = !!host && origin === `${config.secureCookies ? 'https' : new URL(config.APP_URL).protocol.slice(0, -1)}://${host}`;
    const allowed = origin === self || sameHost || config.corsOrigins.includes(origin);
    if (!allowed) {
      if (req.url.startsWith('/api/')) throw forbidden('Origem não permitida.');
      return;
    }
    if (origin !== self && !sameHost) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
        reply.header('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
        return reply.code(204).send();
      }
    }
  });

  // Autenticação e CSRF para toda a API (rotas públicas e webhooks declaram config.public).
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    const isPublic = req.routeOptions.config?.public === true;
    if (isPublic && req.url.startsWith('/api/webhooks/')) return;
    const token = req.cookies[sessionCookieName(deps)];
    if (token) {
      const user = await resolveSession(deps, token);
      if (user) req.authUser = user;
    }
    if (isPublic) return;
    if (!req.authUser) throw unauthorized();
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, req.authUser.csrfToken)) {
        throw forbidden('Falha de verificação de segurança (CSRF). Recarregue a página.');
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    let e: AppError | null = err instanceof AppError ? err : fromPgError(err);
    const fe = err as { statusCode?: number; code?: string };
    if (!e && fe.statusCode === 413) e = new AppError(413, 'too_large', 'Conteúdo acima do limite permitido.');
    if (!e && fe.statusCode === 415) e = new AppError(415, 'unsupported', 'Tipo de conteúdo não suportado.');
    if (!e && fe.statusCode === 400) e = new AppError(400, 'bad_request', 'Requisição inválida.');
    if (!e && fe.statusCode === 406) e = new AppError(406, 'bad_request', 'Requisição inválida.');
    if (!e) {
      req.log.error({ err: { message: (err as Error).message, code: fe.code } }, 'erro não tratado');
      e = new AppError(500, 'internal', 'Erro interno. Tente novamente em instantes.');
    }
    const payload: Record<string, unknown> = { code: e.code, message: e.message };
    if (e instanceof ValidationError) payload.fields = e.fields;
    reply.header('Cache-Control', 'no-store');
    return reply.code(e.status).send({ error: payload });
  });

  registerAuthRoutes(app, deps);
  registerUserRoutes(app, deps);
  registerPlatformRoutes(app, deps);
  registerCustomerRoutes(app, deps);
  registerPlanRoutes(app, deps);
  registerSubscriptionRoutes(app, deps);
  registerChargeRoutes(app, deps);
  registerMessageRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerDashboardRoutes(app, deps);
  registerPublicRoutes(app, deps);
  registerWebhookRoutes(app, deps);
  registerAuditRoutes(app, deps);
  registerMediaRoutes(app, deps);
  registerReminderRoutes(app, deps);

  /** Saúde da API e do banco. Em falha, informa só a CATEGORIA (sem hosts ou credenciais). */
  app.get('/api/health', { config: { public: true } }, async (_req, reply) => {
    try {
      await deps.pools.owner.query('select 1');
      const aviso: string[] = [];
      if (deps.dbInfo?.tlsUnverified) aviso.push('conexão criptografada, mas sem verificação do certificado: configure DATABASE_SSL_CA');
      if (deps.dbInfo?.auto) aviso.push('endereço do banco descoberto automaticamente (o configurado não funcionou)');
      const email = config.mailMode === 'smtp' ? 'SMTP configurado' : config.mailMode === 'manual' ? 'manual (sem envio)' : 'desenvolvimento';
      return { ok: true, banco: 'ok', email, ...(aviso.length ? { aviso } : {}) };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      const msg = (e.message ?? '').toLowerCase();
      const code = e.code ?? '';
      let banco = 'falha de conexão com o banco';
      if (code === '28P01' || msg.includes('password authentication')) banco = 'senha do banco recusada';
      else if (msg.includes('tenant or user not found')) banco = 'usuário ou host do pooler do Supabase incorreto';
      else if (code === 'ERR_INVALID_URL' || msg.includes('invalid url')) banco = 'endereço do banco malformado (confira DATABASE_URL e DATABASE_OWNER_URL)';
      else if (msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls') || code.startsWith('ERR_OSSL'))
        banco = 'falha no certificado TLS (confira DATABASE_SSL_CA)';
      else if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) banco = 'host do banco não encontrado';
      else if (['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].includes(code))
        banco = 'sem rota até o banco: use o host do pooler (aws-...pooler.supabase.com)';
      else if (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET'].includes(code) || msg.includes('timeout'))
        banco = 'banco inacessível ou tempo esgotado (host ou porta)';
      app.log.error({ code: e.code }, 'health: falha no banco');
      reply.code(503);
      return { ok: false, banco, codigo: /^[A-Z0-9_]{2,40}$/.test(code) ? code : undefined };
    }
  });

  // Frontend compilado (homologação/produção em servidor próprio ou Docker).
  const webDir = config.WEB_DIST_DIR ? path.resolve(config.WEB_DIST_DIR) : null;
  if (webDir && existsSync(webDir)) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: true,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.header('Cache-Control', 'no-cache');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || (req.method !== 'GET' && req.method !== 'HEAD')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Recurso não encontrado.' } });
      }
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.code(404).send({ error: { code: 'not_found', message: 'Recurso não encontrado.' } }),
    );
  }

  return app;
}
