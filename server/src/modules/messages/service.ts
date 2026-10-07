import type { FastifyRequest } from 'fastify';
import type { Deps } from '../../lib/context.js';
import { asUser, audit, type AuthUser } from '../../lib/context.js';
import { AppError, notFound } from '../../lib/errors.js';
import { waMeLink } from '../../lib/normalize.js';
import { mediaUrl } from '../../lib/media.js';
import { chargeValues, renderTemplate, variablesInOrder } from '../../lib/template.js';
import { dispatchMessage } from '../automation/dispatch.js';
import { emailAvailable, loadChannels, whatsappAutomatic, type ChannelConfig } from '../channels/service.js';

type Kind = 'lembrete' | 'vencimento' | 'atraso' | 'pagamento_confirmado' | 'personalizada';

interface ChargeCtx {
  charge_id: string;
  description: string;
  amount_cents: number;
  due_date: string;
  payment_link: string | null;
  paid_amount_cents: number | null;
  status: string;
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp_opt_in: boolean;
  email_opt_in: boolean;
  org_name: string;
  pix_key: string | null;
  payment_instructions: string | null;
  contact_phone: string | null;
  today: string;
}

export interface SendResult {
  messageId: string;
  status: string;
  error: string | null;
  waLink: string | null;
}

/**
 * Envia (ou prepara para envio manual) uma mensagem sobre uma cobrança,
 * usando o modelo escolhido ou o mais adequado à situação da cobrança.
 * Respeita o consentimento do cliente em cada canal.
 */
export async function sendChargeMessage(
  deps: Deps,
  req: FastifyRequest,
  me: AuthUser & { orgId: string },
  chargeId: string,
  opts: {
    channel: 'whatsapp' | 'email';
    templateId?: string | null;
    kind: 'manual' | 'confirmacao';
    templateKind?: Kind;
    /** false = só coloca na fila (disparo em massa respeita o intervalo entre envios). */
    dispatch?: boolean;
    /** Não cria outra mensagem se já houver uma na fila para a mesma cobrança e canal. */
    skipIfQueued?: boolean;
    channelsCache?: ChannelConfig;
  },
): Promise<SendResult> {
  const channels = opts.channelsCache ?? (await loadChannels(deps, me.orgId));
  const waAuto = whatsappAutomatic(channels);
  const prepared = await asUser(deps, req, async (db) => {
    const { rows } = await db.query<ChargeCtx>(
      `select ch.id as charge_id, ch.description, ch.amount_cents, to_char(ch.due_date, 'YYYY-MM-DD') as due_date,
              ch.payment_link, ch.paid_amount_cents, ch.status,
              cu.id as customer_id, cu.name, cu.email, cu.phone, cu.whatsapp_opt_in, cu.email_opt_in,
              o.name as org_name, o.pix_key, o.payment_instructions, o.contact_phone,
              to_char(app.org_today(o.id), 'YYYY-MM-DD') as today
         from charges ch
         join customers cu on cu.id = ch.customer_id
         join organizations o on o.id = ch.organization_id
        where ch.id = $1`,
      [chargeId],
    );
    const c = rows[0];
    if (!c) throw notFound('Cobrança não encontrada.');
    if (c.status === 'cancelada') throw new AppError(409, 'conflict', 'Cobrança cancelada.');
    if (opts.skipIfQueued) {
      const q = await db.query<{ id: string }>(
        `select id from messages where charge_id = $1 and channel = $2 and status in ('pendente', 'manual') limit 1`,
        [chargeId, opts.channel],
      );
      if (q.rows[0]) return { id: q.rows[0].id, status: 'ja_na_fila', to: '', body: '', manualText: '' };
    }

    let to: string;
    if (opts.channel === 'whatsapp') {
      if (!c.phone) throw new AppError(422, 'invalid', 'O cliente não tem telefone cadastrado.');
      if (!c.whatsapp_opt_in) throw new AppError(409, 'conflict', 'O cliente pediu para não receber mensagens por WhatsApp.');
      to = c.phone;
    } else {
      if (!c.email) throw new AppError(422, 'invalid', 'O cliente não tem e-mail cadastrado.');
      if (!c.email_opt_in) throw new AppError(409, 'conflict', 'O cliente pediu para não receber e-mails.');
      if (!emailAvailable(deps, channels)) throw new AppError(409, 'conflict', 'O envio de e-mail não está disponível.');
      to = c.email;
    }

    const autoKind: Kind =
      opts.templateKind ?? (c.status === 'paga' ? 'pagamento_confirmado' : c.due_date < c.today ? 'atraso' : c.due_date === c.today ? 'vencimento' : 'lembrete');
    const t = (
      await db.query<{ body: string; subject: string | null; wa_template_name: string | null; wa_template_lang: string; media_id: string | null; media_token: string | null; media_name: string | null }>(
        `select t.body, t.subject, t.wa_template_name, t.wa_template_lang, t.media_id, mf.token as media_token, mf.name as media_name
           from message_templates t left join media_files mf on mf.id = t.media_id
          where ${opts.templateId ? 't.id = $1' : 't.kind = $1'} order by t.created_at limit 1`,
        [opts.templateId ?? autoKind],
      )
    ).rows[0];
    if (!t) throw notFound('Modelo de mensagem não encontrado.');

    const org = { name: c.org_name, pix_key: c.pix_key, payment_instructions: c.payment_instructions, contact_phone: c.contact_phone };
    const values = chargeValues(org, c, c, c.today);
    const body = renderTemplate(t.body, values).slice(0, 4096);
    const subject = t.subject ? renderTemplate(t.subject, values).slice(0, 150) : `Mensagem de ${c.org_name}`;
    const waTemplate =
      opts.channel === 'whatsapp' && t.wa_template_name && channels.mode === 'cloud_api'
        ? { name: t.wa_template_name, lang: t.wa_template_lang, params: variablesInOrder(t.body).map((v) => values[v] ?? '') }
        : null;
    const status = opts.channel === 'whatsapp' && !waAuto ? 'manual' : 'pendente';
    const { rows: m } = await db.query<{ id: string }>(
      `insert into messages (organization_id, customer_id, charge_id, channel, kind, to_address, subject, body, wa_template, status, created_by, media_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, app.uid(), $11) returning id`,
      [me.orgId, c.customer_id, c.charge_id, opts.channel, opts.kind, to, opts.channel === 'email' ? subject : null, body,
        waTemplate ? JSON.stringify(waTemplate) : null, status, t.media_id],
    );
    await audit(db, req, 'message.created', 'message', m[0]!.id, me.orgId, { channel: opts.channel, kind: opts.kind });
    const attachment = t.media_token ? `\n\n📎 ${mediaUrl(deps.config.appUrl, { token: t.media_token, name: t.media_name! })}` : '';
    return { id: m[0]!.id, status, to, body, manualText: body + attachment };
  });

  if (prepared.status === 'ja_na_fila') return { messageId: prepared.id, status: 'ja_na_fila', error: null, waLink: null };
  if (prepared.status === 'manual') {
    return { messageId: prepared.id, status: 'manual', error: null, waLink: waMeLink(prepared.to, prepared.manualText) };
  }
  if (opts.dispatch === false) return { messageId: prepared.id, status: 'pendente', error: null, waLink: null };
  const r = await dispatchMessage(deps, prepared.id);
  return { messageId: prepared.id, status: r?.status ?? 'pendente', error: r?.error ?? null, waLink: null };
}
