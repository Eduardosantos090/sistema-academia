import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Deps } from '../../lib/context.js';
import { OutboundError } from '../../lib/http.js';

/**
 * Cliente mínimo da API v2 da AbacatePay (autenticação Bearer).
 * Referência: documentação oficial (AbacatePay/documentation, openapi.yaml).
 * As chaves da v1 e da v2 não são intercambiáveis.
 */
export const ABACATE_API = 'https://api.abacatepay.com/v2';

/** Situações que guardamos para cada PIX (o provedor tem outras, mapeadas abaixo). */
export type PixStatus = 'PENDING' | 'EXPIRED' | 'CANCELLED' | 'PAID' | 'REFUNDED';

/** Só PAID dá baixa; as demais situações do provedor são mapeadas de forma conservadora. */
export function mapPixStatus(s: unknown): PixStatus {
  switch (s) {
    case 'PAID':
      return 'PAID';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'CANCELLED':
    case 'FAILED':
      return 'CANCELLED';
    case 'REFUNDED':
    case 'UNDER_DISPUTE':
      return 'REFUNDED';
    default:
      return 'PENDING';
  }
}

export interface AbacatePix {
  id: string;
  amount: number;
  status: PixStatus;
  devMode: boolean;
  brCode: string;
  brCodeBase64: string | null;
  expiresAt: string;
}

/** Formato da chave da API (letras, números, _ e -). */
export const zAbacateKeyRe = /^[A-Za-z0-9_-]{10,300}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export async function abacateCall<T>(deps: Deps, apiKey: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
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
  if (res.status === 401 || res.status === 403) {
    throw new OutboundError('AbacatePay recusou a chave da API (confira se é uma chave da API v2 com as permissões necessárias).');
  }
  if (res.status < 200 || res.status >= 300 || json.error || !json.data) {
    const msg = typeof json.error === 'string' ? json.error : typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
    throw new OutboundError(`AbacatePay: ${msg.slice(0, 200)}`);
  }
  return json.data;
}

const q = (id: string) => {
  if (!ID_RE.test(id)) throw new OutboundError('Identificador inválido.');
  return encodeURIComponent(id);
};

// ------------------------------------------------------------------ PIX (checkout transparente)

export async function createPix(deps: Deps, apiKey: string, p: { amountCents: number; expiresInSeconds: number; description: string; externalId?: string }) {
  const d = await abacateCall<Record<string, unknown>>(deps, apiKey, 'POST', '/transparents/create', {
    method: 'PIX',
    data: {
      amount: p.amountCents,
      expiresIn: p.expiresInSeconds,
      description: p.description.slice(0, 500),
      ...(p.externalId ? { externalId: p.externalId } : {}),
    },
  });
  if (typeof d.id !== 'string' || !ID_RE.test(d.id) || typeof d.brCode !== 'string' || !d.brCode) {
    throw new OutboundError('AbacatePay: resposta inesperada.');
  }
  const img = typeof d.brCodeBase64 === 'string' ? d.brCodeBase64 : null;
  return {
    id: d.id,
    amount: Number(d.amount),
    status: mapPixStatus(d.status),
    devMode: !!d.devMode,
    brCode: d.brCode.slice(0, 1000),
    // Só imagem PNG/JPEG em base64 (o valor vai para um <img>).
    brCodeBase64: img && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(img) && img.length <= 200_000 ? img : null,
    expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : new Date(Date.now() + p.expiresInSeconds * 1000).toISOString(),
  } satisfies AbacatePix;
}

/** Situação atual do PIX consultada no provedor (fonte da verdade da confirmação). */
export async function checkPix(deps: Deps, apiKey: string, id: string): Promise<{ status: PixStatus }> {
  const d = await abacateCall<{ status?: unknown }>(deps, apiKey, 'GET', `/transparents/check?id=${q(id)}`);
  return { status: mapPixStatus(d.status) };
}

/** Somente em chaves de teste (devMode): simula o pagamento de um PIX. */
export async function simulatePixPayment(deps: Deps, apiKey: string, id: string) {
  await abacateCall(deps, apiKey, 'POST', `/transparents/simulate-payment?id=${q(id)}`, {});
}

/** Valida a chave consultando a loja. */
export async function getStore(deps: Deps, apiKey: string): Promise<{ name: string | null }> {
  const d = await abacateCall<{ name?: unknown }>(deps, apiKey, 'GET', '/stores/get');
  return { name: typeof d.name === 'string' ? d.name.slice(0, 120) : null };
}

// ------------------------------------------------------------------ assinaturas

export interface AbacateProduct {
  id: string;
  name: string;
  price: number;
  cycle: string | null;
  status: string;
  devMode: boolean;
}

export async function getProduct(deps: Deps, apiKey: string, id: string): Promise<AbacateProduct> {
  const d = await abacateCall<Record<string, unknown>>(deps, apiKey, 'GET', `/products/get?id=${q(id)}`);
  return {
    id: String(d.id ?? id),
    name: typeof d.name === 'string' ? d.name.slice(0, 120) : 'Assinatura',
    price: Number(d.price),
    cycle: typeof d.cycle === 'string' ? d.cycle : null,
    status: typeof d.status === 'string' ? d.status : 'ACTIVE',
    devMode: !!d.devMode,
  };
}

export async function createCustomer(deps: Deps, apiKey: string, c: { email: string; name: string; cellphone?: string | null; taxId?: string | null }) {
  const d = await abacateCall<{ id?: unknown }>(deps, apiKey, 'POST', '/customers/create', {
    email: c.email,
    name: c.name,
    ...(c.cellphone ? { cellphone: c.cellphone } : {}),
    ...(c.taxId ? { taxId: c.taxId } : {}),
  });
  if (typeof d.id !== 'string' || !ID_RE.test(d.id)) throw new OutboundError('AbacatePay: resposta inesperada.');
  return { id: d.id };
}

export async function createSubscriptionCheckout(
  deps: Deps,
  apiKey: string,
  p: { productId: string; customerId: string; externalId: string; completionUrl: string; returnUrl: string; methods: string[] },
) {
  const d = await abacateCall<{ id?: unknown; url?: unknown }>(deps, apiKey, 'POST', '/subscriptions/create', {
    items: [{ id: p.productId, quantity: 1 }],
    customerId: p.customerId,
    externalId: p.externalId,
    completionUrl: p.completionUrl,
    returnUrl: p.returnUrl,
    methods: p.methods,
  });
  if (typeof d.id !== 'string' || !ID_RE.test(d.id) || typeof d.url !== 'string' || !/^https:\/\/[^\s]+$/.test(d.url)) {
    throw new OutboundError('AbacatePay: resposta inesperada.');
  }
  return { id: d.id, url: d.url };
}

export async function getCustomer(deps: Deps, apiKey: string, id: string) {
  const d = await abacateCall<Record<string, unknown>>(deps, apiKey, 'GET', `/customers/get?id=${q(id)}`);
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return { id, email: str(d.email, 254), name: str(d.name, 120), cellphone: str(d.cellphone, 40), taxId: str(d.taxId, 20) };
}

/** Assinaturas ativas geradas por um checkout (ex.: link fixo criado no painel), mais recentes primeiro. */
export async function listSubscriptionsByCheckout(deps: Deps, apiKey: string, checkoutId: string) {
  const d = await abacateCall<unknown>(deps, apiKey, 'GET', `/subscriptions/list?checkoutId=${q(checkoutId)}&status=ACTIVE&limit=100`);
  if (!Array.isArray(d)) throw new OutboundError('AbacatePay: resposta inesperada.');
  return d.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map(toSubscription);
}

function toSubscription(d: Record<string, unknown>): AbacateSubscription {
  if (typeof d.id !== 'string' || !ID_RE.test(d.id)) throw new OutboundError('AbacatePay: resposta inesperada.');
  return {
    id: d.id,
    checkoutId: typeof d.checkoutId === 'string' ? d.checkoutId : null,
    customerId: typeof d.customerId === 'string' && ID_RE.test(d.customerId) ? d.customerId : null,
    status: String(d.status ?? ''),
    amount: Number(d.amount),
    method: typeof d.method === 'string' ? d.method : null,
    devMode: !!d.devMode,
  };
}

export interface AbacateSubscription {
  id: string;
  checkoutId: string | null;
  customerId: string | null;
  status: string;
  amount: number;
  method: string | null;
  devMode: boolean;
}

/** Assinatura consultada no provedor por id (subs_...) ou pelo nosso externalId. */
export async function getSubscription(deps: Deps, apiKey: string, by: { id?: string; externalId?: string }): Promise<AbacateSubscription> {
  const qs = by.id ? `id=${q(by.id)}` : `externalId=${q(by.externalId!)}`;
  return toSubscription(await abacateCall<Record<string, unknown>>(deps, apiKey, 'GET', `/subscriptions/get?${qs}`));
}

// ------------------------------------------------------------------ webhooks

/**
 * Chave pública da AbacatePay para a assinatura HMAC dos webhooks (documentação
 * oficial, "Verificação e Segurança"). Garante a integridade do corpo; a
 * autenticidade vem do segredo na URL (webhookSecret).
 */
const ABACATE_WEBHOOK_PUBLIC_KEY =
  't9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9';

export function abacateSignature(rawBody: Buffer) {
  return createHmac('sha256', ABACATE_WEBHOOK_PUBLIC_KEY).update(rawBody).digest('base64');
}

/** Assinatura ausente é tolerada (o segredo já autentica); presente e inválida, recusa. */
export function signatureOk(rawBody: Buffer | undefined, header: unknown) {
  if (header === undefined) return true;
  if (typeof header !== 'string' || !rawBody) return false;
  const a = Buffer.from(abacateSignature(rawBody));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
