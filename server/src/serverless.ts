/**
 * Adaptador para execução serverless (Netlify Functions v2 / Web Request).
 * Reaproveita integralmente o servidor Fastify (mesmas rotas, validações,
 * autenticação, CSRF e RLS) — apenas troca o transporte HTTP.
 */
import type { FastifyInstance } from 'fastify';
import { CONFIG_KEYS, ConfigError, loadConfig } from './config.js';
import { createDeps } from './deps.js';
import { buildApp } from './app.js';
import { runMaintenance } from './maintenance.js';
import type { Deps } from './lib/context.js';

let ready: Promise<{ app: FastifyInstance; deps: Deps }> | null = null;

function init() {
  ready ??= (async () => {
    const config = loadConfig();
    const deps = await createDeps(config);
    const app = await buildApp(deps);
    await app.ready();
    return { app, deps };
  })().catch((err) => {
    ready = null; // permite nova tentativa na próxima requisição
    throw err;
  });
  return ready;
}

const NO_BODY = new Set([204, 205, 304]);

/**
 * Converte a requisição Web em chamada ao Fastify. `clientIp` deve vir da
 * plataforma (ex.: context.ip no Netlify), não de cabeçalhos do cliente.
 */
export async function handleWebRequest(request: Request, clientIp: string): Promise<Response> {
  let app: FastifyInstance;
  try {
    ({ app } = await init());
  } catch (err) {
    console.error('Falha ao iniciar a API:', (err as Error).message);
    // Para configuração, informa só os NOMES das variáveis (públicos no repositório), nunca valores.
    const message =
      err instanceof ConfigError
        ? `Serviço indisponível: configuração ausente ou inválida no servidor (${err.fields.join(', ')}). ` +
          'Confira as variáveis de ambiente das funções e publique novamente.'
        : 'Serviço temporariamente indisponível.';
    // Diagnóstico: somente os NOMES das variáveis que a função recebeu (nunca valores).
    const recebidas = err instanceof ConfigError ? CONFIG_KEYS.filter((k) => process.env[k]?.trim()) : undefined;
    return Response.json(
      { error: { code: 'unavailable', message, ...(recebidas ? { variaveisRecebidas: recebidas } : {}) } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const res = await app.inject({
    method: request.method as 'GET',
    url: url.pathname + url.search,
    headers,
    remoteAddress: clientIp,
    ...(hasBody ? { payload: Buffer.from(await request.arrayBuffer()) } : {}),
  });
  const out = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined || key === 'content-length' || key === 'transfer-encoding' || key === 'connection') continue;
    if (Array.isArray(value)) for (const v of value) out.append(key, String(v));
    else out.set(key, String(value));
  }
  const body = NO_BODY.has(res.statusCode) || request.method === 'HEAD' ? null : new Uint8Array(res.rawPayload);
  return new Response(body, { status: res.statusCode, headers: out });
}

export async function handleMaintenance() {
  const { deps } = await init();
  return runMaintenance(deps);
}
