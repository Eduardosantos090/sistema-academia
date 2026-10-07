import type { Deps } from '../../lib/context.js';
import { OutboundError } from '../../lib/http.js';
import { mediaUrl } from '../../lib/media.js';
import { signValue } from '../../lib/secrets.js';
import {
  emailAvailable,
  loadChannels,
  orgMailer,
  sendWhatsAppWithMedia,
  whatsappAutomatic,
  type ChannelConfig,
  type WaTemplate,
} from '../channels/service.js';

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
  media_token: string | null;
  media_name: string | null;
  media_mime: string | null;
}

export function unsubscribeLink(deps: Deps, customerId: string) {
  const sig = signValue(deps.config.secretsKey, 'unsubscribe', customerId);
  return `${deps.config.appUrl}/descadastrar#t=${customerId}.${sig}`;
}

/** Erros exibidos no painel: somente mensagens seguras (sem tokens, hosts internos ou pilhas). */
function safeError(e: unknown) {
  if (e instanceof OutboundError) return e.message.slice(0, 300);
  const err = e as { code?: string; responseCode?: number };
  if (err.code === 'EAUTH') return 'O servidor de e-mail recusou o usuário ou a senha. Confira em Configurações → E-mail.';
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(err.code ?? '')) return 'Não foi possível conectar ao servidor de e-mail. Confira o endereço e a porta.';
  const code = err.responseCode;
  if (code) return `Servidor de e-mail recusou o envio (código ${code}).`;
  return 'Falha no envio. Tente novamente mais tarde.';
}

/**
 * Envia uma mensagem já reservada. Atualiza o status para "enviada" ou
 * registra a falha (nova tentativa automática até MAX_ATTEMPTS).
 */
async function sendOne(deps: Deps, m: MessageRow, channels: ChannelConfig) {
  const media = m.media_token
    ? { url: mediaUrl(deps.config.appUrl, { token: m.media_token, name: m.media_name! }), mime: m.media_mime!, name: m.media_name! }
    : null;
  try {
    let providerId: string | null = null;
    if (m.channel === 'whatsapp') {
      if (!whatsappAutomatic(channels)) throw new OutboundError('WhatsApp automático não configurado.');
      ({ providerId } = await sendWhatsAppWithMedia(deps, { slug: m.org_slug }, channels, {
        to: m.to_address,
        body: m.body,
        template: channels.mode === 'cloud_api' ? m.wa_template : null,
        messageId: m.id,
        media,
      }));
    } else {
      if (!emailAvailable(deps, channels)) throw new OutboundError('Envio de e-mail desativado.');
      const unsub = m.customer_id ? unsubscribeLink(deps, m.customer_id) : null;
      await orgMailer(deps, channels, m.org_name).send({
        to: m.to_address,
        subject: m.subject || `Mensagem de ${m.org_name}`,
        text:
          m.body +
          (media ? `\n\nAnexo: ${media.url}` : '') +
          (unsub ? `\n\n—\nNão quer mais receber estes avisos por e-mail? ${unsub}` : ''),
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
         o.slug as org_slug, o.name as org_name, o.contact_email as org_email,
         mf.token as media_token, mf.name as media_name, mf.mime as media_mime
    from messages m
    join organizations o on o.id = m.organization_id
    left join media_files mf on mf.id = m.media_id`;

/**
 * Reserva o "horário de envio" da organização: respeita o intervalo mínimo
 * entre disparos configurado pelo cliente. Atômico (duas execuções
 * simultâneas não enviam juntas).
 */
async function claimSlot(deps: Deps, orgId: string) {
  const r = await deps.pools.owner.query(
    `update organizations set last_dispatch_at = now()
      where id = $1 and (send_delay_seconds = 0 or last_dispatch_at is null
                         or last_dispatch_at <= now() - make_interval(secs => send_delay_seconds))`,
    [orgId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Reserva até `limit` mensagens pendentes de uma organização (SKIP LOCKED + reserva temporária). */
async function lease(deps: Deps, orgId: string, limit: number) {
  const client = await deps.pools.owner.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query<MessageRow>(
      `${SELECT_MSG}
        where m.organization_id = $1 and m.status = 'pendente' and o.is_active and m.attempts < ${MAX_ATTEMPTS}
          and m.created_at > now() - interval '3 days'
          and (m.lease_until is null or m.lease_until < now())
        order by m.created_at
        limit $2
        for update of m skip locked`,
      [orgId, limit],
    );
    if (rows.length) {
      await client.query(`update messages set lease_until = now() + interval '2 minutes' where id = any($1::uuid[])`, [
        rows.map((m) => m.id),
      ]);
    }
    await client.query('commit');
    return rows;
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Envia imediatamente uma mensagem específica ("enviar agora", confirmação).
 * Se a organização tem intervalo entre disparos e o último envio foi há
 * pouco, a mensagem fica na fila e sai na próxima janela (status "pendente").
 */
export async function dispatchMessage(deps: Deps, messageId: string) {
  const { rows } = await deps.pools.owner.query<MessageRow>(
    `${SELECT_MSG} where m.id = $1 and m.status = 'pendente' and o.is_active
       and (m.lease_until is null or m.lease_until < now())`,
    [messageId],
  );
  const m = rows[0];
  if (!m) return null;
  if (m.channel === 'whatsapp' && !(await claimSlot(deps, m.organization_id))) {
    return { ok: false, status: 'pendente', error: null, queued: true };
  }
  const leased = await deps.pools.owner.query(
    `update messages set lease_until = now() + interval '2 minutes'
      where id = $1 and status = 'pendente' and (lease_until is null or lease_until < now())`,
    [messageId],
  );
  if (!leased.rowCount) return null;
  const channels = await loadChannels(deps, m.organization_id);
  const ok = await sendOne(deps, m, channels);
  const { rows: after } = await deps.pools.owner.query<{ status: string; error: string | null }>(
    'select status, error from messages where id = $1',
    [messageId],
  );
  return { ok, status: after[0]?.status ?? 'pendente', error: after[0]?.error ?? null, queued: false };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OrgQueue {
  id: string;
  delay: number;
  nextAt: number;
  channels?: ChannelConfig;
  done: boolean;
}

/**
 * Processa a fila de mensagens pendentes respeitando o intervalo entre
 * disparos de cada organização (WhatsApp). Organizações sem intervalo
 * enviam em lote; com intervalo, uma mensagem por vez. O que não couber no
 * tempo desta execução sai na próxima (a rotina roda a cada minuto).
 */
export async function dispatchPending(deps: Deps, opts: { deadline: number; batch?: number; orgId?: string }) {
  let sent = 0;
  let failed = 0;
  // orgId: envio disparado por uma organização processa SOMENTE a fila dela.
  const { rows: orgs } = await deps.pools.owner.query<{ id: string; delay: number; last: Date | null }>(
    `select o.id, o.send_delay_seconds as delay, o.last_dispatch_at as last
       from organizations o
      where o.is_active and ($1::uuid is null or o.id = $1) and exists (
        select 1 from messages m where m.organization_id = o.id and m.status = 'pendente'
           and m.attempts < ${MAX_ATTEMPTS} and m.created_at > now() - interval '3 days')`,
    [opts.orgId ?? null],
  );
  const queues: OrgQueue[] = orgs.map((o) => ({
    id: o.id,
    delay: o.delay,
    nextAt: o.delay && o.last ? o.last.getTime() + o.delay * 1000 : 0,
    done: false,
  }));

  while (Date.now() < opts.deadline) {
    const active = queues.filter((q) => !q.done);
    if (!active.length) break;
    const now = Date.now();
    const ready = active.filter((q) => q.nextAt <= now);
    if (!ready.length) {
      const soonest = Math.min(...active.map((q) => q.nextAt));
      if (soonest - now > opts.deadline - now - 2000) break; // fica para a próxima execução
      await sleep(Math.max(50, soonest - now));
      continue;
    }
    for (const q of ready) {
      if (Date.now() >= opts.deadline) break;
      q.channels ??= await loadChannels(deps, q.id);
      if (q.delay > 0) {
        if (!(await claimSlot(deps, q.id))) {
          q.nextAt = Date.now() + 1000;
          continue;
        }
        const [m] = await lease(deps, q.id, 1);
        if (!m) {
          q.done = true;
          continue;
        }
        // E-mail não sofre bloqueio por rajada, mas segue a mesma fila para manter a ordem.
        if (await sendOne(deps, m, q.channels)) sent++;
        else failed++;
        q.nextAt = Date.now() + q.delay * 1000;
      } else {
        const batch = await lease(deps, q.id, opts.batch ?? 25);
        if (!batch.length) {
          q.done = true;
          continue;
        }
        for (const m of batch) {
          if (Date.now() >= opts.deadline) break;
          if (await sendOne(deps, m, q.channels)) sent++;
          else failed++;
        }
        await deps.pools.owner.query('update organizations set last_dispatch_at = now() where id = $1', [q.id]);
      }
    }
  }
  if (opts.orgId) return { sent, failed };
  // Pendências antigas demais (ex.: integração desligada por dias) não são mais enviadas.
  await deps.pools.owner.query(
    `update messages set status = 'falhou', error = coalesce(error, 'Expirada sem envio.')
      where status = 'pendente' and created_at <= now() - interval '3 days'`,
  );
  return { sent, failed };
}
