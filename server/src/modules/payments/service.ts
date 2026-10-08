import type { Deps } from '../../lib/context.js';
import { OutboundError } from '../../lib/http.js';
import { decryptSecret } from '../../lib/secrets.js';
import { chargeValues, renderTemplate } from '../../lib/template.js';
import { emailAvailable, loadChannels, whatsappAutomatic } from '../channels/service.js';
import { checkPix, createPix, type PixStatus } from './abacatepay.js';

/** Validade de cada QR Code gerado (o link continua valendo: um novo PIX é gerado ao expirar). */
export const PIX_TTL_SECONDS = 3 * 24 * 3600;

export function payLink(appUrl: string, token: string) {
  return `${appUrl}/pagar/${token}`;
}

/**
 * Link de pagamento efetivo da cobrança: o informado manualmente ou, se a
 * organização recebe por PIX online, a página de pagamento do Venceu.
 */
export function effectivePaymentLink(deps: Deps, row: { payment_link: string | null; pay_token?: string | null; online_pay?: boolean | null }) {
  if (row.payment_link) return row.payment_link;
  return row.online_pay && row.pay_token ? payLink(deps.config.appUrl, row.pay_token) : null;
}

export interface AbacateConfig {
  apiKey: string;
  webhookSecret: string | null;
}

export async function loadAbacate(deps: Deps, orgId: string): Promise<AbacateConfig | null> {
  const { rows } = await deps.pools.owner.query<{ k: string | null; s: string | null }>(
    'select abacate_api_key_enc as k, abacate_webhook_secret_enc as s from org_channels where organization_id = $1',
    [orgId],
  );
  const apiKey = decryptSecret(deps.config.secretsKey, rows[0]?.k);
  return apiKey ? { apiKey, webhookSecret: decryptSecret(deps.config.secretsKey, rows[0]?.s) } : null;
}

export interface PayPage {
  orgName: string;
  description: string;
  amountCents: number;
  dueDate: string;
  status: 'aberta' | 'paga' | 'cancelada';
  paidAt: string | null;
  pix: { brCode: string; image: string | null; expiresAt: string; devMode: boolean } | null;
  /** Motivo de não haver PIX (organização sem recebimento online ou falha no provedor). */
  unavailable: string | null;
}

interface PayRow {
  charge_id: string;
  organization_id: string;
  org_name: string;
  online_pay: boolean;
  description: string;
  amount_cents: number;
  due_date: string;
  status: 'aberta' | 'paga' | 'cancelada';
  paid_at: string | null;
  org_active: boolean;
}

async function findCharge(deps: Deps, token: string) {
  const { rows } = await deps.pools.owner.query<PayRow>(
    `select c.id as charge_id, c.organization_id, o.name as org_name, o.online_pay, c.description, c.amount_cents,
            to_char(c.due_date, 'YYYY-MM-DD') as due_date, c.status, c.paid_at, o.is_active as org_active
       from charges c join organizations o on o.id = c.organization_id
      where c.pay_token = $1`,
    [token],
  );
  return rows[0] ?? null;
}

/**
 * Dados da página pública de pagamento. Reaproveita o PIX ainda válido da
 * cobrança ou gera um novo no provedor (um por vez por cobrança).
 */
export async function payPage(deps: Deps, token: string): Promise<PayPage | null> {
  const c = await findCharge(deps, token);
  if (!c || !c.org_active) return null;
  const base: PayPage = {
    orgName: c.org_name,
    description: c.description,
    amountCents: c.amount_cents,
    dueDate: c.due_date,
    status: c.status,
    paidAt: c.paid_at,
    pix: null,
    unavailable: null,
  };
  if (c.status !== 'aberta') return base;
  if (!c.online_pay) return { ...base, unavailable: 'Esta empresa não recebe pagamento online. Fale com ela para pagar.' };
  const cfg = await loadAbacate(deps, c.organization_id);
  if (!cfg) return { ...base, unavailable: 'Pagamento online indisponível no momento. Fale com a empresa.' };

  const client = await deps.pools.owner.connect();
  try {
    await client.query('begin');
    // Uma geração por vez por cobrança (duas aberturas simultâneas não criam dois PIX).
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 7))', [c.charge_id]);
    const { rows: ex } = await client.query<{ br_code: string; br_code_image: string | null; expires_at: Date; dev_mode: boolean }>(
      `select br_code, br_code_image, expires_at, dev_mode from online_payments
        where charge_id = $1 and status = 'PENDING' and amount_cents = $2 and expires_at > now() + interval '10 minutes'
        order by created_at desc limit 1`,
      [c.charge_id, c.amount_cents],
    );
    let pix = ex[0] ? { brCode: ex[0].br_code, image: ex[0].br_code_image, expiresAt: ex[0].expires_at.toISOString(), devMode: ex[0].dev_mode } : null;
    if (!pix) {
      const created = await createPix(deps, cfg.apiKey, {
        amountCents: c.amount_cents,
        expiresInSeconds: PIX_TTL_SECONDS,
        description: `${c.description} – ${c.org_name}`,
      });
      if (created.amount !== c.amount_cents) throw new OutboundError('AbacatePay: valor do PIX diferente da cobrança.');
      const expires = new Date(created.expiresAt);
      const expiresAt = Number.isNaN(expires.getTime()) ? new Date(Date.now() + PIX_TTL_SECONDS * 1000) : expires;
      await client.query(
        `insert into online_payments (organization_id, charge_id, provider_id, amount_cents, br_code, br_code_image, status, dev_mode, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [c.organization_id, c.charge_id, created.id, created.amount, created.brCode, created.brCodeBase64, created.status, created.devMode, expiresAt],
      );
      pix = { brCode: created.brCode, image: created.brCodeBase64, expiresAt: expiresAt.toISOString(), devMode: created.devMode };
    }
    await client.query('commit');
    return { ...base, pix };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    if (e instanceof OutboundError) return { ...base, unavailable: 'Não foi possível gerar o PIX agora. Tente novamente em alguns minutos.' };
    throw e;
  } finally {
    client.release();
  }
}

interface PendingPix {
  id: string;
  organization_id: string;
  charge_id: string;
  provider_id: string;
  amount_cents: number;
}

/**
 * Consulta o PIX no provedor e, se pago, dá baixa na cobrança. A confirmação
 * vem SEMPRE da consulta à API com a chave da organização, nunca do
 * conteúdo de um webhook.
 */
export async function refreshPix(deps: Deps, p: PendingPix, apiKey: string): Promise<PixStatus> {
  const { status } = await checkPix(deps, apiKey, p.provider_id);
  await deps.pools.owner.query(
    `update online_payments set status = $2, checked_at = now(), paid_at = case when $2 = 'PAID' then coalesce(paid_at, now()) else paid_at end
      where id = $1`,
    [p.id, status],
  );
  if (status === 'PAID') await markPaidOnline(deps, p.charge_id, p.amount_cents, p.provider_id);
  return status;
}

/** Dá baixa na cobrança paga pelo PIX online e avisa o cliente (se a empresa usa confirmação). */
export async function markPaidOnline(deps: Deps, chargeId: string, amountCents: number, providerId: string) {
  const client = await deps.pools.owner.connect();
  let paid: { organization_id: string; notify: boolean } | undefined;
  try {
    await client.query('begin');
    const { rows } = await client.query<{ organization_id: string; notify: boolean }>(
      `update charges ch set status = 'paga', paid_at = now(), paid_amount_cents = $2, payment_method = 'pix', reported_paid_at = null
         from organizations o
        where ch.id = $1 and o.id = ch.organization_id and ch.status = 'aberta'
        returning ch.organization_id, o.notify_on_payment as notify`,
      [chargeId, amountCents],
    );
    paid = rows[0];
    if (paid) {
      await client.query(
        `update messages set status = 'cancelada', error = 'Cobrança paga.'
          where charge_id = $1 and kind = 'lembrete' and status in ('pendente', 'manual')`,
        [chargeId],
      );
      await client.query(
        `insert into audit_events (organization_id, action, entity_type, entity_id, details)
         values ($1, 'charge.paid_online', 'charge', $2, $3)`,
        [paid.organization_id, chargeId, JSON.stringify({ provider: 'abacatepay', providerId, amountCents })],
      );
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  if (paid?.notify) await queuePaidConfirmation(deps, paid.organization_id, chargeId).catch(() => undefined);
  return !!paid;
}

/** Coloca na fila a mensagem "pagamento confirmado" (WhatsApp; senão e-mail). */
async function queuePaidConfirmation(deps: Deps, orgId: string, chargeId: string) {
  const { rows } = await deps.pools.owner.query(
    `select c.description, c.amount_cents, to_char(c.due_date, 'YYYY-MM-DD') as due_date, c.payment_link, c.paid_amount_cents,
            cu.id as customer_id, cu.name, cu.email, cu.phone, cu.whatsapp_opt_in, cu.email_opt_in,
            o.name as org_name, o.pix_key, o.payment_instructions, o.contact_phone,
            to_char(app.org_today(o.id), 'YYYY-MM-DD') as today,
            t.body, t.subject
       from charges c
       join customers cu on cu.id = c.customer_id
       join organizations o on o.id = c.organization_id
       join lateral (select body, subject from message_templates where organization_id = o.id and kind = 'pagamento_confirmado'
                      order by created_at limit 1) t on true
      where c.id = $1`,
    [chargeId],
  );
  const r = rows[0];
  if (!r) return;
  const channels = await loadChannels(deps, orgId);
  const target =
    r.phone && r.whatsapp_opt_in
      ? { channel: 'whatsapp' as const, to: r.phone as string, status: whatsappAutomatic(channels) ? 'pendente' : 'manual' }
      : r.email && r.email_opt_in && emailAvailable(deps, channels)
      ? { channel: 'email' as const, to: r.email as string, status: 'pendente' }
      : null;
  if (!target) return;
  const values = chargeValues({ name: r.org_name, pix_key: r.pix_key, payment_instructions: r.payment_instructions, contact_phone: r.contact_phone }, r, r, r.today);
  await deps.pools.owner.query(
    `insert into messages (organization_id, customer_id, charge_id, channel, kind, to_address, subject, body, status, dedupe_key)
     values ($1, $2, $3, $4, 'confirmacao', $5, $6, $7, $8, $9)
     on conflict (dedupe_key) do nothing`,
    [
      orgId, r.customer_id, chargeId, target.channel, target.to,
      target.channel === 'email' ? (r.subject ? renderTemplate(r.subject, values).slice(0, 150) : `Pagamento confirmado – ${r.org_name}`) : null,
      renderTemplate(r.body, values).slice(0, 4096), target.status, `paid-online:${chargeId}`,
    ],
  );
}

/** Confere PIX pendentes (rede de segurança caso um webhook não chegue). */
export async function pollOnlinePayments(deps: Deps, limit = 20) {
  const { rows } = await deps.pools.owner.query<PendingPix>(
    `select p.id, p.organization_id, p.charge_id, p.provider_id, p.amount_cents
       from online_payments p join charges c on c.id = p.charge_id
      where p.status = 'PENDING' and c.status = 'aberta' and p.expires_at > now() - interval '1 hour'
        and (p.checked_at is null or p.checked_at < now() - interval '2 minutes')
      order by p.checked_at nulls first
      limit $1`,
    [limit],
  );
  const keys = new Map<string, string | null>();
  let paid = 0;
  for (const p of rows) {
    if (!keys.has(p.organization_id)) keys.set(p.organization_id, (await loadAbacate(deps, p.organization_id))?.apiKey ?? null);
    const key = keys.get(p.organization_id);
    try {
      if (!key) throw new Error('sem chave');
      if ((await refreshPix(deps, p, key)) === 'PAID') paid++;
    } catch {
      await deps.pools.owner.query('update online_payments set checked_at = now() where id = $1', [p.id]);
    }
  }
  return { checked: rows.length, paid };
}

/** PIX desta organização citados no webhook (os demais são ignorados). */
export async function pendingByProviderIds(deps: Deps, orgId: string, ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await deps.pools.owner.query<PendingPix>(
    `select id, organization_id, charge_id, provider_id, amount_cents from online_payments
      where organization_id = $1 and provider = 'abacatepay' and provider_id = any($2::text[]) and status in ('PENDING', 'EXPIRED')`,
    [orgId, ids],
  );
  return rows;
}
