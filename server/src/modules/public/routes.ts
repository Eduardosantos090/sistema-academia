import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zOptionalPhone, zOptionalText, zText } from '../../lib/normalize.js';
import { verifySigned } from '../../lib/secrets.js';
import { SEGMENTS } from '../platform/routes.js';

export function registerPublicRoutes(app: FastifyInstance, deps: Deps) {
  /** Erro de tela no navegador (sem dados de formulário; só mensagem, pilha e página). */
  app.post('/api/client-errors', { config: { public: true } }, async (req, reply) => {
    const body = parse(
      z
        .object({
          message: z.string().max(2000),
          stack: z.string().max(20000).optional(),
          path: z.string().max(2000).optional(),
          release: z.string().max(200).optional(),
        })
        .strict(),
      req.body,
    );
    await deps.limiters.clientErrorIp.consume(`ip:${req.ip}`);
    const clean = (v: string | undefined, max: number) => (v ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, max) : null);
    await deps.pools.owner.query(
      `insert into client_errors (user_id, path, message, stack, user_agent, release) values ($1, $2, $3, $4, $5, $6)`,
      [
        req.authUser?.id ?? null,
        clean(body.path?.split(/[?#]/)[0], 300),
        clean(body.message, 500) ?? 'erro',
        clean(body.stack, 4000),
        clean(String(req.headers['user-agent'] ?? ''), 300),
        clean(body.release, 60),
      ],
    );
    return reply.code(204).send();
  });

  /** Pedido de acesso pelo site ("Quero usar o Venceu"). */
  app.post('/api/public/access-request', { config: { public: true } }, async (req) => {
    const body = parse(
      z
        .object({
          name: zText(2, 120),
          businessName: zText(2, 120),
          segment: z.enum(SEGMENTS).default('outro'),
          email: zEmail,
          phone: zOptionalPhone,
          message: zOptionalText(1000),
          consent: z.literal(true, { message: 'É preciso concordar com o uso dos dados para contato.' }),
          // Campo invisível: preenchido apenas por robôs.
          website: z.string().max(200).optional(),
        })
        .strict(),
      req.body,
    );
    await deps.limiters.accessRequestIp.consume(`ip:${req.ip}`);
    if (!body.website) {
      const dup = await deps.pools.owner.query(
        `select 1 from access_requests where email = $1 and status = 'novo' and created_at > now() - interval '7 days'`,
        [body.email],
      );
      if (!dup.rowCount) {
        await deps.pools.owner.query(
          `insert into access_requests (name, business_name, segment, email, phone, message) values ($1, $2, $3, $4, $5, $6)`,
          [body.name, body.businessName, body.segment, body.email, body.phone, body.message],
        );
      }
    }
    // Mesma resposta sempre (não revela duplicidade nem detecção de robô).
    return { ok: true };
  });

  /** Descadastro de e-mails de lembrete (link assinado presente em cada e-mail). */
  app.post('/api/public/unsubscribe', { config: { public: true } }, async (req) => {
    const body = parse(z.object({ token: z.string().min(40).max(120) }).strict(), req.body);
    await deps.limiters.publicIp.consume(`unsub:${req.ip}`);
    const m = body.token.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32})$/);
    if (!m || !verifySigned(deps.config.secretsKey, 'unsubscribe', m[1]!, m[2]!)) {
      throw badRequest('Link de descadastro inválido.');
    }
    const { rows } = await deps.pools.owner.query<{ name: string }>(
      `update customers c set email_opt_in = false from organizations o
        where c.id = $1 and o.id = c.organization_id returning o.name`,
      [m[1]],
    );
    await deps.pools.owner.query(
      `update messages set status = 'cancelada', error = 'Cliente descadastrou o e-mail.'
        where customer_id = $1 and channel = 'email' and status = 'pendente'`,
      [m[1]],
    );
    return { ok: true, organization: rows[0]?.name ?? null };
  });
}
