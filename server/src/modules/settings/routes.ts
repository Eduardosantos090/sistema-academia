import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, requireOrg, requireOwner } from '../../lib/context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { newToken } from '../../lib/crypto.js';
import { encryptSecret } from '../../lib/secrets.js';
import { OutboundError, validateOutboundUrl } from '../../lib/http.js';
import { cleanText, zOptionalDocument, zOptionalEmail, zOptionalPhone, zOptionalText, zText, zUuid } from '../../lib/normalize.js';
import { TEMPLATE_VARS, chargeValues, renderTemplate, unknownVariables } from '../../lib/template.js';
import { SEGMENTS } from '../platform/routes.js';
import { emailAvailable, loadChannels, sendWhatsApp, whatsappAutomatic } from '../channels/service.js';

const zTemplateBody = (max: number) =>
  zText(5, max).superRefine((v, ctx) => {
    const bad = unknownVariables(v);
    if (bad.length) ctx.addIssue({ code: 'custom', message: `Variável desconhecida: ${bad.map((b) => `{{${b}}}`).join(', ')}` });
  });

const TIMEZONES = [
  'America/Sao_Paulo', 'America/Manaus', 'America/Cuiaba', 'America/Belem', 'America/Fortaleza', 'America/Recife',
  'America/Bahia', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Rio_Branco', 'America/Noronha',
] as const;

export function registerSettingsRoutes(app: FastifyInstance, deps: Deps) {
  // ---------------------------------------------------------------- organização

  app.get('/api/settings', async (req) => {
    const me = requireOrg(req);
    const org = await asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select id, name, slug, segment, contact_email as "contactEmail", contact_phone as "contactPhone", document,
                pix_key as "pixKey", payment_instructions as "paymentInstructions", timezone, send_hour as "sendHour",
                notify_on_payment as "notifyOnPayment", bot_enabled as "botEnabled", bot_greeting as "botGreeting",
                webhook_id as "webhookId"
           from organizations where id = $1`,
        [me.orgId],
      );
      return rows[0];
    });
    if (!org) throw notFound();
    const c = await loadChannels(deps, me.orgId);
    const isOwner = me.role === 'owner';
    return {
      organization: { ...org, webhookId: undefined },
      channels: {
        whatsappMode: c.mode,
        whatsappAutomatic: whatsappAutomatic(c),
        phoneNumberId: c.phoneNumberId,
        hasAccessToken: !!c.accessToken,
        hasAppSecret: !!c.appSecret,
        webhookUrl: c.webhookUrl,
        hasWebhookSecret: !!c.webhookSecret,
        emailEnabled: c.emailEnabled,
        emailAvailable: emailAvailable(deps, c),
        emailReplyTo: c.emailReplyTo,
        platformMailMode: deps.config.mailMode,
        // Endereços e token de verificação: somente para o responsável (configuração das integrações).
        ...(isOwner
          ? {
              verifyToken: c.verifyToken,
              cloudWebhookUrl: `${deps.config.appUrl}/api/webhooks/whatsapp/${org.webhookId}`,
              inboundWebhookUrl: `${deps.config.appUrl}/api/webhooks/inbound/${org.webhookId}`,
            }
          : {}),
      },
      templateVars: TEMPLATE_VARS,
    };
  });

  app.patch('/api/settings/organization', async (req) => {
    const me = requireOwner(req);
    const body = parse(
      z
        .object({
          name: zText(2, 120).optional(),
          segment: z.enum(SEGMENTS).optional(),
          contactEmail: zOptionalEmail.optional(),
          contactPhone: zOptionalPhone.optional(),
          document: zOptionalDocument.optional(),
          pixKey: zOptionalText(140).optional(),
          paymentInstructions: zOptionalText(1000).optional(),
          timezone: z.enum(TIMEZONES).optional(),
          sendHour: z.coerce.number().int().min(6).max(20).optional(),
          notifyOnPayment: z.boolean().optional(),
          botEnabled: z.boolean().optional(),
          botGreeting: z
            .string()
            .nullish()
            .transform((v) => (v == null ? null : cleanText(v) || null))
            .pipe(z.string().max(500).nullable())
            .optional(),
        })
        .strict(),
      req.body,
    );
    const map: Record<string, string> = {
      name: 'name', segment: 'segment', contactEmail: 'contact_email', contactPhone: 'contact_phone', document: 'document',
      pixKey: 'pix_key', paymentInstructions: 'payment_instructions', timezone: 'timezone', sendHour: 'send_hour',
      notifyOnPayment: 'notify_on_payment', botEnabled: 'bot_enabled', botGreeting: 'bot_greeting',
    };
    const sets: string[] = [];
    const params: unknown[] = [me.orgId];
    for (const [k, col] of Object.entries(map)) {
      if (k in body) {
        params.push((body as Record<string, unknown>)[k]);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) return { ok: true };
    await asUser(deps, req, async (db) => {
      await db.query(`update organizations set ${sets.join(', ')} where id = $1`, params);
      await audit(db, req, 'settings.organization', 'organization', me.orgId, me.orgId, { fields: Object.keys(body) });
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- canais

  /**
   * Integração do WhatsApp. Tokens e segredos são cifrados no banco e NUNCA
   * devolvidos ao navegador (somente "configurado: sim/não"). Campos vazios
   * mantêm o valor atual.
   */
  app.put('/api/settings/whatsapp', async (req) => {
    const me = requireOwner(req);
    const secret = z.string().trim().max(1000).optional();
    const body = parse(
      z
        .object({
          mode: z.enum(['manual', 'cloud_api', 'webhook']),
          phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, 'ID do número inválido.').nullish(),
          accessToken: secret,
          appSecret: secret,
          webhookUrl: z.string().trim().max(500).nullish(),
          regenerateWebhookSecret: z.boolean().default(false),
        })
        .strict(),
      req.body,
    );
    const key = deps.config.secretsKey;
    const current = await loadChannels(deps, me.orgId);
    let webhookUrl = current.webhookUrl;
    if (body.webhookUrl !== undefined) {
      if (body.webhookUrl) {
        try {
          webhookUrl = validateOutboundUrl(body.webhookUrl).toString();
        } catch (e) {
          throw new AppError(422, 'invalid', e instanceof OutboundError ? e.message : 'URL inválida.');
        }
      } else webhookUrl = null;
    }
    const accessToken = body.accessToken || current.accessToken;
    const appSecret = body.appSecret || current.appSecret;
    const phoneNumberId = body.phoneNumberId === undefined ? current.phoneNumberId : body.phoneNumberId || null;
    if (body.mode === 'cloud_api' && (!phoneNumberId || !accessToken || !appSecret)) {
      throw new AppError(422, 'invalid', 'Para a API oficial informe o ID do número, o token de acesso e o App Secret.');
    }
    if (body.mode === 'webhook' && !webhookUrl) throw new AppError(422, 'invalid', 'Informe a URL do webhook de envio.');
    const verifyToken = current.verifyToken ?? newToken();
    let webhookSecret = current.webhookSecret;
    let revealedSecret: string | null = null;
    if (body.mode === 'webhook' && (!webhookSecret || body.regenerateWebhookSecret)) {
      webhookSecret = newToken();
      revealedSecret = webhookSecret;
    }
    await deps.pools.owner.query(
      `insert into org_channels (organization_id, whatsapp_mode, wa_phone_number_id, wa_access_token_enc, wa_app_secret_enc,
                                 wa_verify_token_enc, webhook_url, webhook_secret_enc)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (organization_id) do update set whatsapp_mode = $2, wa_phone_number_id = $3, wa_access_token_enc = $4,
         wa_app_secret_enc = $5, wa_verify_token_enc = $6, webhook_url = $7, webhook_secret_enc = $8`,
      [
        me.orgId,
        body.mode,
        phoneNumberId,
        accessToken ? encryptSecret(key, accessToken) : null,
        appSecret ? encryptSecret(key, appSecret) : null,
        encryptSecret(key, verifyToken),
        webhookUrl,
        webhookSecret ? encryptSecret(key, webhookSecret) : null,
      ],
    );
    await asUser(deps, req, (db) => audit(db, req, 'settings.whatsapp', 'organization', me.orgId, me.orgId, { mode: body.mode }));
    // O segredo do webhook é exibido UMA única vez, no momento em que é gerado.
    return { ok: true, webhookSecret: revealedSecret };
  });

  app.put('/api/settings/email', async (req) => {
    const me = requireOwner(req);
    const body = parse(z.object({ enabled: z.boolean(), replyTo: zOptionalEmail }).strict(), req.body);
    await deps.pools.owner.query(
      `insert into org_channels (organization_id, email_enabled, email_reply_to) values ($1, $2, $3)
       on conflict (organization_id) do update set email_enabled = $2, email_reply_to = $3`,
      [me.orgId, body.enabled, body.replyTo],
    );
    await asUser(deps, req, (db) => audit(db, req, 'settings.email', 'organization', me.orgId, me.orgId, { enabled: body.enabled }));
    return { ok: true };
  });

  /** Teste de envio para um número informado pelo responsável. */
  app.post('/api/settings/whatsapp/test', async (req) => {
    const me = requireOwner(req);
    const body = parse(z.object({ to: zOptionalPhone.pipe(z.string({ message: 'Informe o número.' })) }).strict(), req.body);
    await deps.limiters.sendNow.consume(`u:${me.id}`);
    const c = await loadChannels(deps, me.orgId);
    if (!whatsappAutomatic(c)) throw new AppError(409, 'conflict', 'Configure o envio automático antes de testar.');
    const { rows } = await deps.pools.owner.query<{ slug: string; name: string }>('select slug, name from organizations where id = $1', [me.orgId]);
    try {
      await sendWhatsApp(deps, rows[0]!, c, { to: body.to, body: `✅ Teste do Venceu: integração do WhatsApp da ${rows[0]!.name} funcionando.` });
    } catch (e) {
      throw new AppError(502, 'send_failed', e instanceof OutboundError ? e.message : 'Falha ao enviar.');
    }
    return { ok: true };
  });

  // ---------------------------------------------------------------- modelos

  app.get('/api/templates', async (req) => {
    requireOrg(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select t.id, t.kind, t.name, t.subject, t.body, t.wa_template_name as "waTemplateName", t.wa_template_lang as "waTemplateLang",
                (select count(*)::int from reminder_rules r where r.template_id = t.id) as "rules", t.updated_at as "updatedAt"
           from message_templates t order by t.kind, t.name`,
      );
      return { items: rows, vars: TEMPLATE_VARS };
    });
  });

  const zTemplate = z
    .object({
      kind: z.enum(['lembrete', 'vencimento', 'atraso', 'pagamento_confirmado', 'personalizada']),
      name: zText(2, 80),
      subject: zOptionalText(150).pipe(
        z.string().nullable().refine((v) => !v || !unknownVariables(v).length, 'Variável desconhecida no assunto.'),
      ),
      body: zTemplateBody(1500),
      waTemplateName: z
        .string()
        .trim()
        .nullish()
        .transform((v) => v || null)
        .pipe(z.string().regex(/^[a-z0-9_]{1,512}$/, 'Use letras minúsculas, números e _.').nullable()),
      waTemplateLang: z.string().regex(/^[a-z]{2}(_[A-Z]{2})?$/).default('pt_BR'),
    })
    .strict();

  app.post('/api/templates', async (req, reply) => {
    const me = requireOwner(req);
    const b = parse(zTemplate, req.body);
    const id = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into message_templates (organization_id, kind, name, subject, body, wa_template_name, wa_template_lang)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [me.orgId, b.kind, b.name, b.subject, b.body, b.waTemplateName, b.waTemplateLang],
      );
      await audit(db, req, 'template.created', 'template', rows[0]!.id, me.orgId);
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.put('/api/templates/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(zTemplate, req.body);
    await asUser(deps, req, async (db) => {
      const r = await db.query(
        `update message_templates set kind = $2, name = $3, subject = $4, body = $5, wa_template_name = $6, wa_template_lang = $7
          where id = $1`,
        [id, b.kind, b.name, b.subject, b.body, b.waTemplateName, b.waTemplateLang],
      );
      if (!r.rowCount) throw notFound('Modelo não encontrado.');
      await audit(db, req, 'template.updated', 'template', id, me.orgId);
    });
    return { ok: true };
  });

  app.delete('/api/templates/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const used = await db.query('select 1 from reminder_rules where template_id = $1', [id]);
      if (used.rowCount) throw new AppError(409, 'conflict', 'Este modelo é usado por uma regra de lembrete. Troque o modelo da regra antes.');
      const r = await db.query('delete from message_templates where id = $1', [id]);
      if (!r.rowCount) throw notFound('Modelo não encontrado.');
      await audit(db, req, 'template.deleted', 'template', id, me.orgId);
    });
    return { ok: true };
  });

  /** Pré-visualização com dados de exemplo. */
  app.post('/api/templates/preview', async (req) => {
    const me = requireOrg(req);
    const b = parse(z.object({ body: z.string().max(1500), subject: z.string().max(150).nullish() }).strict(), req.body);
    const org = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ name: string; pix_key: string | null; payment_instructions: string | null; contact_phone: string | null; today: string }>(
        `select name, pix_key, payment_instructions, contact_phone, to_char(app.org_today(id), 'YYYY-MM-DD') as today
           from organizations where id = $1`,
        [me.orgId],
      );
      return rows[0]!;
    });
    const due = new Date(Date.parse(org.today) + 3 * 86_400_000).toISOString().slice(0, 10);
    const values = chargeValues(org, { name: 'Maria Oliveira' }, {
      description: 'Mensalidade Plano Mensal', amount_cents: 12990, due_date: due, payment_link: null, paid_amount_cents: 12990,
    }, org.today);
    return {
      body: renderTemplate(b.body, values),
      subject: b.subject ? renderTemplate(b.subject, values) : null,
      unknown: unknownVariables(`${b.body} ${b.subject ?? ''}`),
    };
  });

  // ---------------------------------------------------------------- regras de lembrete

  app.get('/api/rules', async (req) => {
    requireOrg(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select r.id, r.offset_days as "offsetDays", r.template_id as "templateId", t.name as "templateName",
                r.send_whatsapp as "sendWhatsapp", r.send_email as "sendEmail", r.is_active as "isActive"
           from reminder_rules r join message_templates t on t.id = r.template_id
          order by r.offset_days`,
      );
      return { items: rows };
    });
  });

  const zRule = z
    .object({
      offsetDays: z.coerce.number().int().min(-30).max(60),
      templateId: zUuid,
      sendWhatsapp: z.boolean(),
      sendEmail: z.boolean(),
      isActive: z.boolean().default(true),
    })
    .strict()
    .refine((r) => r.sendWhatsapp || r.sendEmail, { message: 'Escolha ao menos um canal.', path: ['sendWhatsapp'] });

  app.post('/api/rules', async (req, reply) => {
    const me = requireOwner(req);
    const b = parse(zRule, req.body);
    const id = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into reminder_rules (organization_id, offset_days, template_id, send_whatsapp, send_email, is_active)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [me.orgId, b.offsetDays, b.templateId, b.sendWhatsapp, b.sendEmail, b.isActive],
      );
      await audit(db, req, 'rule.created', 'rule', rows[0]!.id, me.orgId, { offsetDays: b.offsetDays });
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.put('/api/rules/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(zRule, req.body);
    await asUser(deps, req, async (db) => {
      const r = await db.query(
        `update reminder_rules set offset_days = $2, template_id = $3, send_whatsapp = $4, send_email = $5, is_active = $6 where id = $1`,
        [id, b.offsetDays, b.templateId, b.sendWhatsapp, b.sendEmail, b.isActive],
      );
      if (!r.rowCount) throw notFound('Regra não encontrada.');
      await audit(db, req, 'rule.updated', 'rule', id, me.orgId, { offsetDays: b.offsetDays, isActive: b.isActive });
    });
    return { ok: true };
  });

  app.delete('/api/rules/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query('delete from reminder_rules where id = $1', [id]);
      if (!r.rowCount) throw notFound('Regra não encontrada.');
      await audit(db, req, 'rule.deleted', 'rule', id, me.orgId);
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- respostas do assistente

  app.get('/api/bot-answers', async (req) => {
    requireOrg(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select id, title, keywords, answer, is_active as "isActive" from bot_answers order by is_active desc, title`,
      );
      return { items: rows };
    });
  });

  const zAnswer = z
    .object({
      title: zText(2, 80),
      keywords: z
        .array(zText(2, 40))
        .min(1, 'Informe ao menos uma palavra-chave.')
        .max(20)
        .transform((ks) => [...new Set(ks.map((k) => k.toLowerCase()))]),
      answer: zText(2, 1500),
      isActive: z.boolean().default(true),
    })
    .strict();

  app.post('/api/bot-answers', async (req, reply) => {
    const me = requireOwner(req);
    const b = parse(zAnswer, req.body);
    const id = await asUser(deps, req, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `insert into bot_answers (organization_id, title, keywords, answer, is_active) values ($1, $2, $3, $4, $5) returning id`,
        [me.orgId, b.title, b.keywords, b.answer, b.isActive],
      );
      await audit(db, req, 'bot_answer.created', 'bot_answer', rows[0]!.id, me.orgId);
      return rows[0]!.id;
    });
    reply.code(201);
    return { id };
  });

  app.put('/api/bot-answers/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    const b = parse(zAnswer, req.body);
    await asUser(deps, req, async (db) => {
      const r = await db.query(`update bot_answers set title = $2, keywords = $3, answer = $4, is_active = $5 where id = $1`, [
        id, b.title, b.keywords, b.answer, b.isActive,
      ]);
      if (!r.rowCount) throw notFound('Resposta não encontrada.');
      await audit(db, req, 'bot_answer.updated', 'bot_answer', id, me.orgId);
    });
    return { ok: true };
  });

  app.delete('/api/bot-answers/:id', async (req) => {
    const me = requireOwner(req);
    const { id } = parse(z.object({ id: zUuid }), req.params);
    await asUser(deps, req, async (db) => {
      const r = await db.query('delete from bot_answers where id = $1', [id]);
      if (!r.rowCount) throw notFound('Resposta não encontrada.');
      await audit(db, req, 'bot_answer.deleted', 'bot_answer', id, me.orgId);
    });
    return { ok: true };
  });
}
