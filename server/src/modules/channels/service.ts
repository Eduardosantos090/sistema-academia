import type pg from 'pg';
import type { Deps } from '../../lib/context.js';
import type { Db } from '../../lib/db.js';
import { decryptSecret, hmacHex } from '../../lib/secrets.js';
import { OutboundError } from '../../lib/http.js';
import { mediaKind } from '../../lib/media.js';
import type { Mailer, OrgSmtp } from '../../lib/mailer.js';
import { evoSend, loadEvolutionServer, type EvoState, type EvolutionServer } from './evolution.js';

export type WhatsAppMode = 'manual' | 'cloud_api' | 'webhook' | 'qrcode';

export interface ChannelConfig {
  mode: WhatsAppMode;
  phoneNumberId: string | null;
  accessToken: string | null;
  appSecret: string | null;
  verifyToken: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  emailEnabled: boolean;
  emailReplyTo: string | null;
  /** WhatsApp por QR Code (Evolution API): instância da organização no servidor da plataforma. */
  evo: { server: EvolutionServer | null; name: string; token: string; status: EvoState; number: string | null } | null;
  evoWebhookSecret: string | null;
  /** Conta de e-mail própria (null = remetente da plataforma). */
  smtp: Omit<OrgSmtp, 'fromName'> & { fromName: string | null } | null;
}

export const GRAPH_API = 'https://graph.facebook.com/v21.0';

interface ChannelRow {
  whatsapp_mode: WhatsAppMode;
  wa_phone_number_id: string | null;
  wa_access_token_enc: string | null;
  wa_app_secret_enc: string | null;
  wa_verify_token_enc: string | null;
  webhook_url: string | null;
  webhook_secret_enc: string | null;
  email_enabled: boolean;
  email_reply_to: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_user: string | null;
  smtp_password_enc: string | null;
  smtp_from_name: string | null;
  evo_instance: string | null;
  evo_token_enc: string | null;
  evo_webhook_secret_enc: string | null;
  evo_status: EvoState | null;
  evo_number: string | null;
}

/** Lê (e decifra) a configuração de canais. Somente pelo servidor privilegiado. */
export async function loadChannels(deps: Deps, orgId: string, db: Db | pg.Pool = deps.pools.owner): Promise<ChannelConfig> {
  const { rows } = await db.query<ChannelRow>('select * from org_channels where organization_id = $1', [orgId]);
  const r = rows[0];
  const key = deps.config.secretsKey;
  return {
    mode: r?.whatsapp_mode ?? 'manual',
    phoneNumberId: r?.wa_phone_number_id ?? null,
    accessToken: decryptSecret(key, r?.wa_access_token_enc),
    appSecret: decryptSecret(key, r?.wa_app_secret_enc),
    verifyToken: decryptSecret(key, r?.wa_verify_token_enc),
    webhookUrl: r?.webhook_url ?? null,
    webhookSecret: decryptSecret(key, r?.webhook_secret_enc),
    emailEnabled: r?.email_enabled ?? true,
    emailReplyTo: r?.email_reply_to ?? null,
    smtp: smtpFromRow(key, r),
    evo: await evoFromRow(deps, key, r),
    evoWebhookSecret: decryptSecret(key, r?.evo_webhook_secret_enc),
  };
}

async function evoFromRow(deps: Deps, key: Buffer, r: ChannelRow | undefined): Promise<ChannelConfig['evo']> {
  const token = decryptSecret(key, r?.evo_token_enc);
  if (!r?.evo_instance || !token) return null;
  return { server: await loadEvolutionServer(deps), name: r.evo_instance, token, status: r.evo_status ?? 'close', number: r.evo_number };
}

function smtpFromRow(key: Buffer, r: ChannelRow | undefined): ChannelConfig['smtp'] {
  if (!r?.smtp_host || !r.smtp_port || !r.smtp_user) return null;
  const password = decryptSecret(key, r.smtp_password_enc);
  if (!password) return null;
  return { host: r.smtp_host, port: r.smtp_port, user: r.smtp_user, password, fromName: r.smtp_from_name };
}

/** Remetente dos e-mails da organização: a conta própria, se configurada; senão o da plataforma. */
export function orgMailer(deps: Deps, c: ChannelConfig, orgName: string): Mailer {
  return c.smtp ? deps.orgMailer({ ...c.smtp, fromName: c.smtp.fromName || orgName }) : deps.mailer;
}

/** WhatsApp com envio automático configurado (senão, envio manual pelo painel). */
export function whatsappAutomatic(c: ChannelConfig): boolean {
  if (c.mode === 'cloud_api') return !!c.phoneNumberId && !!c.accessToken;
  if (c.mode === 'webhook') return !!c.webhookUrl && !!c.webhookSecret;
  if (c.mode === 'qrcode') return !!c.evo?.server && c.evo.status === 'open';
  return false;
}

export function emailAvailable(deps: Deps, c: ChannelConfig): boolean {
  return c.emailEnabled && (!!c.smtp || deps.config.mailMode !== 'manual');
}

export interface WaTemplate {
  name: string;
  lang: string;
  params: string[];
}

/** Assinatura dos webhooks do Venceu: HMAC-SHA256 de "<timestamp>.<corpo>". */
export function signWebhook(secret: string, timestamp: string, body: string) {
  return `sha256=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

export async function sendWhatsApp(
  deps: Deps,
  org: { slug: string },
  c: ChannelConfig,
  msg: { to: string; body: string; template?: WaTemplate | null; messageId?: string; media?: OutMedia | null; typingMs?: number },
): Promise<{ providerId: string | null }> {
  const digits = msg.to.replace(/\D/g, '');
  // Espera antes de responder (assistente). No QR Code a Evolution mostra "digitando…" nesse tempo.
  const typingMs = Math.min(Math.max(msg.typingMs ?? 0, 0), 8000);
  if (typingMs && c.mode !== 'qrcode') await new Promise((r) => setTimeout(r, typingMs));
  if (c.mode === 'cloud_api') {
    if (!c.phoneNumberId || !c.accessToken) throw new OutboundError('WhatsApp Cloud API não configurada.');
    const kind = msg.media ? mediaKind(msg.media.mime) : null;
    const payload = msg.media && kind
      ? {
          messaging_product: 'whatsapp',
          to: digits,
          type: kind,
          [kind]: {
            link: msg.media.url,
            ...(kind !== 'audio' && msg.body ? { caption: msg.body.slice(0, 1024) } : {}),
            ...(kind === 'document' ? { filename: msg.media.name } : {}),
          },
        }
      : msg.template
      ? {
          messaging_product: 'whatsapp',
          to: digits,
          type: 'template',
          template: {
            name: msg.template.name,
            language: { code: msg.template.lang },
            ...(msg.template.params.length
              ? { components: [{ type: 'body', parameters: msg.template.params.map((text) => ({ type: 'text', text: text || '-' })) }] }
              : {}),
          },
        }
      : { messaging_product: 'whatsapp', to: digits, type: 'text', text: { body: msg.body, preview_url: false } };
    const res = await deps.fetch(`${GRAPH_API}/${c.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data: { messages?: { id?: string }[]; error?: { message?: string; code?: number } } = {};
    try {
      data = JSON.parse(res.body);
    } catch {
      /* resposta não-JSON */
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = data.error?.message ? `: ${data.error.message.slice(0, 160)}` : '';
      throw new OutboundError(`WhatsApp recusou o envio (HTTP ${res.status}${data.error?.code ? `, código ${data.error.code}` : ''})${detail}`);
    }
    return { providerId: data.messages?.[0]?.id ?? null };
  }
  if (c.mode === 'webhook') {
    if (!c.webhookUrl || !c.webhookSecret) throw new OutboundError('Webhook de envio não configurado.');
    const ts = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({
      event: 'message.send',
      organization: org.slug,
      messageId: msg.messageId ?? null,
      to: msg.to,
      text: msg.body,
      template: msg.template ?? null,
      media: msg.media ? { url: msg.media.url, mime: msg.media.mime, name: msg.media.name, kind: mediaKind(msg.media.mime) } : null,
    });
    const res = await deps.fetch(c.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-venceu-timestamp': ts,
        'x-venceu-signature': signWebhook(c.webhookSecret, ts, body),
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) throw new OutboundError(`Webhook respondeu HTTP ${res.status}.`);
    let providerId: string | null = null;
    try {
      const d = JSON.parse(res.body) as { id?: unknown };
      if (typeof d.id === 'string') providerId = d.id.slice(0, 200);
    } catch {
      /* corpo opcional */
    }
    return { providerId };
  }
  if (c.mode === 'qrcode') {
    if (!c.evo?.server) throw new OutboundError('WhatsApp por QR Code não configurado.');
    if (c.evo.status !== 'open') throw new OutboundError('WhatsApp desconectado: leia o QR Code de novo em Configurações → WhatsApp.');
    const kind = msg.media ? mediaKind(msg.media.mime) : null;
    const providerId = await evoSend(deps, c.evo.server, c.evo, {
      number: digits,
      text: msg.body,
      media: msg.media && kind ? { ...msg.media, kind } : null,
      typingMs,
    });
    return { providerId };
  }
  throw new OutboundError('Envio automático de WhatsApp não configurado (modo manual).');
}

export interface OutMedia {
  url: string;
  mime: string;
  name: string;
}

/**
 * Texto + anexo. Na API oficial: imagem/PDF levam o texto como legenda (até
 * 1024 caracteres); áudio vai em mensagem separada, depois do texto. No
 * webhook, tudo segue numa única chamada (o provedor decide como entregar).
 */
export async function sendWhatsAppWithMedia(
  deps: Deps,
  org: { slug: string },
  c: ChannelConfig,
  msg: { to: string; body: string; template?: WaTemplate | null; messageId?: string; media?: OutMedia | null; typingMs?: number },
) {
  if (!msg.media || (c.mode !== 'cloud_api' && c.mode !== 'qrcode')) return sendWhatsApp(deps, org, c, msg);
  const kind = mediaKind(msg.media.mime);
  if (!msg.template && kind !== 'audio' && msg.body.length <= 1024) return sendWhatsApp(deps, org, c, msg);
  const first = msg.body || msg.template ? await sendWhatsApp(deps, org, c, { ...msg, media: null }) : null;
  const second = await sendWhatsApp(deps, org, c, { to: msg.to, body: '', media: msg.media, typingMs: first ? 1000 : msg.typingMs });
  return { providerId: first?.providerId ?? second.providerId };
}

/**
 * Tempo de "digitando…" antes de cada resposta do assistente: a primeira espera o
 * tempo configurado; as seguintes, até 1,5 s. Total limitado a 8 s (limite da função).
 */
export function replyTypingPlan(delaySeconds: number, count: number): number[] {
  const base = Math.min(Math.max(delaySeconds, 0), 8) * 1000;
  let left = 8000;
  return Array.from({ length: count }, (_, i) => {
    const t = Math.min(i === 0 ? base : Math.min(base, 1500), left);
    left -= t;
    return t;
  });
}
