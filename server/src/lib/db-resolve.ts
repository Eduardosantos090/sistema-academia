import pg from 'pg';

/**
 * Resolução automática da conexão com o banco no Supabase.
 *
 * Se o endereço configurado estiver malformado (ex.: marcador ">>>...<<<" não
 * substituído) ou apontar para um host inalcançável (ex.: db.<ref>.supabase.co,
 * só IPv6), tenta os endereços do pooler do Supabase para a região do projeto,
 * reaproveitando usuário e senha já configurados. Nunca registra credenciais.
 */

export interface ParsedDbUrl {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
}

/** Leitura tolerante (funciona mesmo com host inválido, onde new URL() falha). */
export function parseDbUrl(url: string): ParsedDbUrl | null {
  const m = url.trim().match(/^postgres(?:ql)?:\/\/([^:/?#]+):([^@]*)@([^/]*?)(?::(\d+))?\/([^?#]*)/);
  if (!m) return null;
  return {
    user: decodeURIComponent(m[1]!),
    password: decodeURIComponent(m[2]!),
    host: m[3]!,
    port: m[4] ?? '5432',
    database: m[5] || 'postgres',
  };
}

function build(p: ParsedDbUrl) {
  return `postgres://${encodeURIComponent(p.user)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${p.database}`;
}

export function projectRef(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null;
  const m = supabaseUrl.match(/^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/);
  return m ? m[1]! : null;
}

/** Endereço configurado primeiro; depois os poolers do Supabase (transaction, 6543). */
export function candidateUrls(configured: string, supabaseUrl?: string, region?: string): string[] {
  const out: string[] = [];
  const parsed = parseDbUrl(configured);
  const validHost = parsed && /^[a-z0-9.-]+$/i.test(parsed.host);
  if (validHost) out.push(configured.trim());
  const ref = projectRef(supabaseUrl);
  if (parsed && ref && region) {
    const base = parsed.user.split('.')[0]!;
    for (const cluster of ['aws-0', 'aws-1']) {
      const url = build({
        user: `${base}.${ref}`,
        password: parsed.password,
        host: `${cluster}-${region}.pooler.supabase.com`,
        port: '6543',
        database: 'postgres',
      });
      if (!out.includes(url)) out.push(url);
    }
  }
  return out;
}

type Ssl = pg.ClientConfig['ssl'];
export type Probe = (url: string, ssl: Ssl) => Promise<void>;

const defaultProbe: Probe = async (url, ssl) => {
  const c = new pg.Client({ connectionString: url, ssl, connectionTimeoutMillis: 5000 });
  try {
    await c.connect();
    await c.query('select 1');
  } finally {
    await c.end().catch(() => undefined);
  }
};

const isCertError = (e: { code?: string; message?: string }) =>
  /certificate|self-signed|self signed/i.test(e.message ?? '') || (e.code ?? '').startsWith('ERR_OSSL');

export interface Resolved {
  url: string;
  ssl: Ssl;
  /** true quando o endereço configurado não funcionou e foi usado o pooler automático. */
  auto: boolean;
  /** true quando a conexão é criptografada sem verificação do certificado (falta DATABASE_SSL_CA). */
  tlsUnverified: boolean;
}

/**
 * Escolhe o primeiro endereço que conecta. Senha recusada interrompe a busca
 * (tentar outros hosts não resolveria). Se o erro for só de verificação do
 * certificado e nenhum CA válido foi informado, usa TLS sem verificação e
 * sinaliza isso (visível em /api/health).
 */
export async function resolveDbUrl(
  configured: string,
  ssl: Ssl,
  opts: { supabaseUrl?: string; region?: string; caProvided: boolean; probe?: Probe },
): Promise<Resolved> {
  const probe = opts.probe ?? defaultProbe;
  const candidates = candidateUrls(configured, opts.supabaseUrl, opts.region);
  if (!candidates.length) throw new Error('Nenhum endereço de banco válido configurado.');
  const tryOne = async (url: string, i: number): Promise<Resolved> => {
    const attempts: { ssl: Ssl; unverified: boolean }[] = [{ ssl, unverified: false }];
    if (ssl && !opts.caProvided) attempts.push({ ssl: { rejectUnauthorized: false }, unverified: true });
    let lastErr: unknown;
    for (const a of attempts) {
      try {
        await probe(url, a.ssl);
        return { url, ssl: a.ssl, auto: i > 0 || url !== configured.trim(), tlsUnverified: a.unverified };
      } catch (err) {
        lastErr = err;
        // só vale tentar sem verificação quando o erro é do certificado
        if (!isCertError(err as { code?: string; message?: string })) break;
      }
    }
    throw lastErr;
  };
  // Testa todos ao mesmo tempo (um host que não responde não atrasa os outros) e
  // escolhe o primeiro que funcionou na ordem de preferência.
  const results = await Promise.allSettled(candidates.map(tryOne));
  for (const r of results) if (r.status === 'fulfilled') return r.value;
  const errors = results.map((r) => (r as PromiseRejectedResult).reason as { code?: string });
  // Senha recusada é o motivo mais útil a relatar (outro host não resolveria).
  throw errors.find((e) => e?.code === '28P01') ?? errors[0];
}
