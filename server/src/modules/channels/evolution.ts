import type { Deps } from '../../lib/context.js';
import { OutboundError } from '../../lib/http.js';
import { decryptSecret } from '../../lib/secrets.js';

/**
 * Cliente mínimo da Evolution API v2 (WhatsApp por QR Code).
 * Referência: código-fonte oficial EvolutionAPI/evolution-api (rotas
 * /instance/*, /message/*; autenticação pelo cabeçalho "apikey": chave
 * global para criar instâncias, token da instância para o resto).
 */

export interface EvolutionServer {
  url: string;
  globalKey: string;
}

export async function loadEvolutionServer(deps: Deps): Promise<EvolutionServer | null> {
  const { rows } = await deps.pools.owner.query<{ evolution_url: string | null; evolution_key_enc: string | null }>(
    'select evolution_url, evolution_key_enc from platform_settings where id = 1',
  );
  const r = rows[0];
  const key = decryptSecret(deps.config.secretsKey, r?.evolution_key_enc);
  return r?.evolution_url && key ? { url: r.evolution_url.replace(/\/+$/, ''), globalKey: key } : null;
}

const NAME_RE = /^[a-z0-9-]{3,64}$/;

async function call<T>(deps: Deps, base: string, apikey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await deps.fetch(`${base}${path}`, {
    method,
    headers: { apikey, 'content-type': 'application/json', accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* corpo não-JSON */
  }
  if (res.status === 401 || res.status === 403) throw new OutboundError('Servidor de WhatsApp recusou a chave.');
  if (res.status < 200 || res.status >= 300) {
    const j = json as { response?: { message?: unknown }; message?: unknown } | null;
    const m = j?.response?.message ?? j?.message;
    const msg = Array.isArray(m) ? String(m[0]) : typeof m === 'string' ? m : `HTTP ${res.status}`;
    throw new OutboundError(`WhatsApp: ${msg.slice(0, 200)}`);
  }
  return json as T;
}

/** Remoção (logout/exclusão da instância): 404 é tratado como já removido. */
async function callDelete(deps: Deps, base: string, apikey: string, path: string) {
  const res = await deps.fetch(`${base}${path}`, { method: 'DELETE', headers: { apikey, accept: 'application/json' } });
  if (res.status === 404) return;
  if (res.status < 200 || res.status >= 300) throw new OutboundError(`WhatsApp: HTTP ${res.status}`);
}

export type EvoState = 'open' | 'connecting' | 'close';
const asState = (s: unknown): EvoState => (s === 'open' || s === 'connecting' ? s : 'close');
const asQr = (q: unknown) => (typeof q === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(q) && q.length < 200_000 ? q : null);

/** Valida o servidor e a chave global (lista instâncias). */
export async function checkServer(deps: Deps, s: EvolutionServer) {
  await call(deps, s.url, s.globalKey, 'GET', '/instance/fetchInstances');
}

/** Cria a instância da organização já com o webhook de entrada configurado. */
export async function createInstance(
  deps: Deps,
  s: EvolutionServer,
  p: { name: string; webhookUrl: string; webhookSecret: string },
): Promise<{ token: string; qr: string | null; state: EvoState }> {
  if (!NAME_RE.test(p.name)) throw new OutboundError('Nome de instância inválido.');
  const d = await call<{ hash?: unknown; instance?: { status?: unknown }; qrcode?: { base64?: unknown } }>(deps, s.url, s.globalKey, 'POST', '/instance/create', {
    instanceName: p.name,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    groupsIgnore: true,
    alwaysOnline: false,
    readMessages: false,
    webhook: {
      enabled: true,
      url: p.webhookUrl,
      byEvents: false,
      base64: false,
      headers: { 'x-venceu-token': p.webhookSecret },
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
    },
  });
  const token = typeof d?.hash === 'string' ? d.hash : (d?.hash as { apikey?: unknown } | undefined)?.apikey;
  if (typeof token !== 'string' || token.length < 8) throw new OutboundError('WhatsApp: resposta inesperada ao criar a conexão.');
  return { token, qr: asQr(d?.qrcode?.base64), state: asState(d?.instance?.status) };
}

/** QR Code atual para conectar (ou estado "open" se já conectado). */
export async function connectInstance(deps: Deps, s: EvolutionServer, name: string, token: string): Promise<{ qr: string | null; state: EvoState }> {
  const d = await call<{ base64?: unknown; instance?: { state?: unknown } }>(deps, s.url, token, 'GET', `/instance/connect/${encodeURIComponent(name)}`);
  if (d?.instance?.state) return { qr: null, state: asState(d.instance.state) };
  const qr = asQr(d?.base64);
  return { qr, state: qr ? 'connecting' : 'close' };
}

export async function instanceState(deps: Deps, s: EvolutionServer, name: string, token: string): Promise<EvoState> {
  const d = await call<{ instance?: { state?: unknown } }>(deps, s.url, token, 'GET', `/instance/connectionState/${encodeURIComponent(name)}`);
  return asState(d?.instance?.state);
}

export async function logoutInstance(deps: Deps, s: EvolutionServer, name: string, token: string) {
  await callDelete(deps, s.url, token, `/instance/logout/${encodeURIComponent(name)}`).catch(() => undefined);
}

export async function deleteInstance(deps: Deps, s: EvolutionServer, name: string) {
  await callDelete(deps, s.url, s.globalKey, `/instance/delete/${encodeURIComponent(name)}`).catch(() => undefined);
}

type MediaKind = 'image' | 'audio' | 'video' | 'document';

/** Envia texto, mídia (com legenda) ou áudio de voz. Devolve o id da mensagem no WhatsApp. */
export async function evoSend(
  deps: Deps,
  s: EvolutionServer,
  inst: { name: string; token: string },
  msg: { number: string; text: string; media?: { url: string; mime: string; name: string; kind: MediaKind } | null },
): Promise<string | null> {
  const path = (p: string) => `/message/${p}/${encodeURIComponent(inst.name)}`;
  let d: { key?: { id?: unknown } };
  if (!msg.media) {
    d = await call(deps, s.url, inst.token, 'POST', path('sendText'), { number: msg.number, text: msg.text });
  } else if (msg.media.kind === 'audio') {
    d = await call(deps, s.url, inst.token, 'POST', path('sendWhatsAppAudio'), { number: msg.number, audio: msg.media.url });
  } else {
    d = await call(deps, s.url, inst.token, 'POST', path('sendMedia'), {
      number: msg.number,
      mediatype: msg.media.kind,
      mimetype: msg.media.mime,
      media: msg.media.url,
      fileName: msg.media.name,
      ...(msg.text ? { caption: msg.text.slice(0, 1024) } : {}),
    });
  }
  return typeof d?.key?.id === 'string' ? d.key.id.slice(0, 200) : null;
}

/** Nome da instância derivado da organização (estável e sem dados pessoais). */
export const instanceNameFor = (slug: string, orgId: string) => `venceu-${slug.slice(0, 40)}-${orgId.slice(0, 8)}`.replace(/-+/g, '-');
