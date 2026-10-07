import type { Deps } from '../../lib/context.js';
import { OutboundError } from '../../lib/http.js';

/**
 * Cliente mínimo da API da AbacatePay (v1, autenticação Bearer).
 * Referência: SDK oficial AbacatePay/abacatepay-nodejs-sdk.
 */
export const ABACATE_API = 'https://api.abacatepay.com/v1';

export type PixStatus = 'PENDING' | 'EXPIRED' | 'CANCELLED' | 'PAID' | 'REFUNDED';
const STATUSES: PixStatus[] = ['PENDING', 'EXPIRED', 'CANCELLED', 'PAID', 'REFUNDED'];

export interface AbacatePix {
  id: string;
  amount: number;
  status: PixStatus;
  devMode: boolean;
  brCode: string;
  brCodeBase64: string | null;
  expiresAt: string;
}

/** Formato da chave (ex.: abc_dev_... em testes, abc_prod_... em produção). */
export const zAbacateKeyRe = /^[A-Za-z0-9_-]{10,300}$/;

async function call<T>(deps: Deps, apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await deps.fetch(`${ABACATE_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: { data?: T; error?: unknown; message?: unknown } = {};
  try {
    json = JSON.parse(res.body);
  } catch {
    /* resposta não-JSON */
  }
  if (res.status === 401 || res.status === 403) throw new OutboundError('AbacatePay recusou a chave da API. Confira a chave em Configurações.');
  if (res.status < 200 || res.status >= 300 || json.error || !json.data) {
    const msg = typeof json.error === 'string' ? json.error : typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
    throw new OutboundError(`AbacatePay: ${msg.slice(0, 200)}`);
  }
  return json.data;
}

function toPix(d: Partial<AbacatePix> & { id?: unknown }): AbacatePix {
  if (typeof d.id !== 'string' || !d.id || typeof d.brCode !== 'string' || !STATUSES.includes(d.status as PixStatus)) {
    throw new OutboundError('AbacatePay: resposta inesperada.');
  }
  return {
    id: d.id,
    amount: Number(d.amount),
    status: d.status as PixStatus,
    devMode: !!d.devMode,
    brCode: d.brCode,
    brCodeBase64: typeof d.brCodeBase64 === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(d.brCodeBase64) ? d.brCodeBase64 : null,
    expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : new Date(Date.now() + 3600_000).toISOString(),
  };
}

export async function createPix(deps: Deps, apiKey: string, p: { amountCents: number; expiresInSeconds: number; description: string }) {
  const d = await call<Partial<AbacatePix>>(deps, apiKey, 'POST', '/pixQrCode/create', {
    amount: p.amountCents,
    expiresIn: p.expiresInSeconds,
    // A AbacatePay limita a descrição a 37 caracteres.
    description: p.description.slice(0, 37),
  });
  return toPix(d);
}

/** Situação atual do PIX consultada no provedor (fonte da verdade da confirmação). */
export async function checkPix(deps: Deps, apiKey: string, id: string): Promise<{ status: PixStatus }> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new OutboundError('Identificador de PIX inválido.');
  const d = await call<{ status?: string }>(deps, apiKey, 'GET', `/pixQrCode/check?id=${encodeURIComponent(id)}`);
  if (!STATUSES.includes(d.status as PixStatus)) throw new OutboundError('AbacatePay: resposta inesperada.');
  return { status: d.status as PixStatus };
}

/** Valida a chave consultando a loja. */
export async function getStore(deps: Deps, apiKey: string): Promise<{ name: string | null }> {
  const d = await call<{ name?: unknown }>(deps, apiKey, 'GET', '/store/get');
  return { name: typeof d.name === 'string' ? d.name.slice(0, 120) : null };
}

/** Somente em chaves de teste: simula o pagamento de um PIX. */
export async function simulatePixPayment(deps: Deps, apiKey: string, id: string) {
  await call(deps, apiKey, 'POST', `/pixQrCode/simulate-payment?id=${encodeURIComponent(id)}`, { metadata: {} });
}
