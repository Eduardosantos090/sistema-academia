import pg from 'pg';
import type { Config } from '../config.js';
import { SUPABASE_ROOT_CA } from './supabase-ca.js';

// numeric -> number, bigint -> number (contagens e somas)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export type Db = pg.PoolClient;

export interface Pools {
  /** Papel venceu_app: sujeito a RLS. */
  app: pg.Pool;
  /** Papel proprietário: somente autenticação e tarefas administrativas do servidor. */
  owner: pg.Pool;
}

/**
 * TLS com verificação do certificado. Para o Supabase, informe o CA (PEM) em
 * DATABASE_SSL_CA — aceita quebras de linha reais ou "\n".
 */
export function sslOptions(enabled: boolean, ca?: string) {
  if (!enabled) return undefined;
  const pem = validCa(ca);
  return { rejectUnauthorized: true, ...(pem ? { ca: pem } : {}) };
}

/** Certificado PEM utilizável, ou undefined (vazio, marcador não substituído, colado incompleto). */
export function validCa(ca?: string) {
  const pem = ca?.replace(/\\n/g, '\n').trim();
  return pem && pem.includes('-----BEGIN CERTIFICATE-----') && pem.includes('-----END CERTIFICATE-----') ? pem : undefined;
}

/** Mesma configuração TLS para scripts de linha de comando (lê o ambiente). */
export function sslFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return sslOptions(env.DATABASE_SSL === 'true' || env.DATABASE_SSL === '1', env.DATABASE_SSL_CA);
}

export interface DbInfo {
  /** Endereço descoberto automaticamente (o configurado não funcionou). */
  auto: boolean;
  /** Conexão criptografada sem verificação de certificado (falta DATABASE_SSL_CA válido). */
  tlsUnverified: boolean;
}

export function createPools(
  config: Config,
  resolved?: { app?: { url: string; ssl: pg.ClientConfig['ssl'] }; owner?: { url: string; ssl: pg.ClientConfig['ssl'] } },
): Pools {
  const ssl = sslOptions(config.DATABASE_SSL, config.DATABASE_SSL_CA);
  return {
    app: new pg.Pool({
      connectionString: resolved?.app?.url ?? config.DATABASE_URL,
      ssl: resolved?.app?.ssl ?? ssl,
      max: config.DB_POOL_MAX,
      connectionTimeoutMillis: 8000,
    }),
    owner: new pg.Pool({
      connectionString: resolved?.owner?.url ?? config.DATABASE_OWNER_URL,
      ssl: resolved?.owner?.ssl ?? ssl,
      max: Math.min(5, config.DB_POOL_MAX),
      connectionTimeoutMillis: 8000,
    }),
  };
}

/**
 * Cria os pools resolvendo automaticamente o endereço do Supabase quando o
 * configurado não funciona. Se nada funcionar, usa o configurado (o motivo
 * aparece em /api/health).
 */
export async function createPoolsResolved(config: Config): Promise<{ pools: Pools; info: DbInfo }> {
  // Sem CA informado, no Supabase usa o certificado raiz público embutido. Se ele
  // não validar, a resolução ainda cai para TLS sem verificação (sinalizado em /api/health).
  const supabase = !!config.SUPABASE_URL || /supabase\.(com|co)[:/]/.test(config.DATABASE_URL);
  const ssl = sslOptions(config.DATABASE_SSL, validCa(config.DATABASE_SSL_CA) ?? (supabase ? SUPABASE_ROOT_CA : undefined));
  const opts = {
    supabaseUrl: config.SUPABASE_URL,
    region: config.SUPABASE_REGION,
    caProvided: !!validCa(config.DATABASE_SSL_CA),
  };
  const { resolveDbUrl } = await import('./db-resolve.js');
  const safe = async (url: string) => resolveDbUrl(url, ssl, opts).catch(() => null);
  const [app, owner] = await Promise.all([safe(config.DATABASE_URL), safe(config.DATABASE_OWNER_URL)]);
  return {
    pools: createPools(config, { app: app ?? undefined, owner: owner ?? undefined }),
    info: { auto: !!(app?.auto || owner?.auto), tlsUnverified: !!(app?.tlsUnverified || owner?.tlsUnverified) },
  };
}

/**
 * Executa `fn` em uma transação com o usuário autenticado definido para a RLS.
 * O identificador vem da sessão validada no servidor — nunca do navegador.
 */
export async function withUser<T>(pool: pg.Pool, userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function withTx<T>(pool: pg.Pool, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
