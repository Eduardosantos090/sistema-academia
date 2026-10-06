import type { Deps } from '../../lib/context.js';
import { OutboundError } from '../../lib/http.js';
import { signValue } from '../../lib/secrets.js';
import { emailAvailable, loadChannels, sendWhatsApp, whatsappAutomatic, type ChannelConfig, type WaTemplate } from '../channels/service.js';

const MAX_ATTEMPTS = 3;

interface MessageRow {
  id: string;
  organization_id: string;
  customer_id: string | null;
  channel: 'whatsapp' | 'email';
  to_address: string;
  subject: string | null;
  body: string;
  wa_template: WaTemplate | null;
  attempts: number;
  org_slug: string;
  org_name: string;
  org_email: string | null;
}

export function unsubscribeLink(deps: Deps, customerId: string) {
  const sig = signValue(deps.config.secretsKey, 'unsubscribe', customerId);
  return `${deps.config.appUrl}/descadastrar#t=${customerId}.${sig}`;
}

/** Erros exibidos no painel: somente mensagens seguras (sem tokens, hosts internos ou pilhas). */
function safeError(e: unknown) {
  if (e instanceof OutboundError) return e.message.slice(0, 300);
  const code = (e as { code?: string; responseCode?: number }).responseCode;
  if (code) return `Servidor de e-mail recusou o envio (código ${code}).`;
  return 'Falha no envio. Tente novamente mais tarde.';
}

/**
 * Envia uma mensagem da caixa de saída já reservada (status "pendente").
 * Atualiza o status para "enviada" ou registra a falha (com nova tentativa
 * automática até MAX_ATTEMPTS).
 */
async function sendOne(deps: Deps, m: MessageRow, channels: ChannelConfig) {
  try {
    let providerId: string | null = null;
    if (m.channel === 'whatsapp') {
      if (!whatsappAutomatic(channels)) throw new OutboundError('WhatsApp automático não configurado.');
      ({ providerId } = await sendWhatsApp(deps, { slug: m.org_slug }, channels, {
        to: m.to_address,
        body: m.body,
        template: channels.mode === 'cloud_api' ? m.wa_template : null,
        messageId: m.id,
      }));
    } else {
      if (!emailAvailable(deps, channels)) throw new OutboundError('Envio de e-mail desativado.');
      const unsub = m.customer_id ? unsubscribeLink(deps, m.customer_id) : null;
      await deps.mailer.send({
        to: m.to_address,
        subject: m.subject || `Mensagem de ${m.org_name}`,
        text: m.body + (unsub ? `\n\n—\nNão quer mais receber estes avisos por e-mail? ${unsub}` : ''),
        replyTo: channels.emailReplyTo ?? m.org_email ?? undefined,
        ...(unsub ? { unsubscribeUrl: unsub } : {}),
      });
    }
    await deps.pools.owner.query(
      `update messages set status = 'enviada', sent_at = now(), error = null, provider_id = $2, lease_until = null where id = $1`,
      [m.id, providerId],
    );
    return true;
  } catch (e) {
    const attempts = m.attempts + 1;
    await deps.pools.owner.query(
      `update messages set status = case when $3::int >= $4::int then 'falhou'::message_status else 'pendente'::message_status end,
              attempts = $3::smallint, error = $2, lease_until = null where id = $1`,
      [m.id, safeError(e), attempts, MAX_ATTEMPTS],
    );
    return false;
  }
}

const SELECT_MSG = `
  select m.id, m.organization_id, m.customer_id, m.channel, m.to_address, m.subject, m.body, m.wa_template, m.attempts,
         o.slug as org_slug, o.name as org_name, o.contact_email as org_email
    from messages m join organizations o on o.id = m.organization_id`;

/** Envia imediatamente uma mensagem específica (ex.: "enviar agora", confirmação de pagamento). */
export async function dispatchMessage(deps: Deps, messageId: string) {
  const { rows } = await deps.pools.owner.query<MessageRow>(
    `${SELECT_MSG} where m.id = $1 and m.status = 'pendente' and o.is_active
       and (m.lease_until is null or m.lease_until < now())`,
    [messageId],
  );
  const m = rows[0];
  if (!m) return null;
  const lease = await deps.pools.owner.query(
    `update messages set lease_until = now() + interval '2 minutes'
      where id = $1 and status = 'pendente' and (lease_until is null or lease_until < now())`,
    [messageId],
  );
  if (!lease.rowCount) return null;
  const channels = await loadChannels(deps, m.organization_id);
  const ok = await sendOne(deps, m, channels);
  const { rows: after } = await deps.pools.owner.query<{ status: string; error: string | null }>(
    'select status, error from messages where id = $1',
    [messageId],
  );
  return { ok, status: after[0]?.status ?? 'pendente', error: after[0]?.error ?? null };
}

/**
 * Processa a fila de mensagens pendentes. Cada lote é reservado com
 * SKIP LOCKED (várias execuções simultâneas não enviam em duplicidade).
 */
export async function dispatchPending(deps: Deps, opts: { deadline: number; batch?: number }) {
  let sent = 0;
  let failed = 0;
  const channelCache = new Map<string, ChannelConfig>();
  while (Date.now() < opts.deadline) {
    const client = await deps.pools.owner.connect();
    let batch: MessageRow[] = [];
    try {
      await client.query('begin');
      const { rows } = await client.query<MessageRow>(
        `${SELECT_MSG}
          where m.status = 'pendente' and o.is_active and m.attempts < ${MAX_ATTEMPTS}
            and m.created_at > now() - interval '3 days'
            and (m.lease_until is null or m.lease_until < now())
          order by m.created_at
          limit $1
          for update of m skip locked`,
        [opts.batch ?? 25],
      );
      batch = rows;
      // Reserva o lote: outra execução simultânea não pega as mesmas mensagens.
      if (batch.length) {
        await client.query(`update messages set lease_until = now() + interval '2 minutes' where id = any($1::uuid[])`, [
          batch.map((m) => m.id),
        ]);
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    if (!batch.length) break;
    for (const m of batch) {
      if (Date.now() >= opts.deadline) break;
      let ch = channelCache.get(m.organization_id);
      if (!ch) {
        ch = await loadChannels(deps, m.organization_id);
        channelCache.set(m.organization_id, ch);
      }
      if (await sendOne(deps, m, ch)) sent++;
      else failed++;
    }
    if (batch.length < (opts.batch ?? 25)) break;
  }
  // Pendências antigas demais (ex.: integração desligada por dias) não são mais enviadas.
  await deps.pools.owner.query(
    `update messages set status = 'falhou', error = coalesce(error, 'Expirada sem envio.')
      where status = 'pendente' and created_at <= now() - interval '3 days'`,
  );
  return { sent, failed };
}
