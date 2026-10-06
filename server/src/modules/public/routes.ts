import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { zEmail, zOptionalPhone, zOptionalText, zText } from '../../lib/normalize.js';
import { verifySigned } from '../../lib/secrets.js';
import { SEGMENTS } from '../platform/routes.js';

export function registerPublicRoutes(app: FastifyInstance, deps: Deps) {
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
