import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('127.0.0.1'),
  /** URL pública da aplicação (links de convite, recuperação de senha e webhooks). */
  APP_URL: z.string().url(),
  /** Conexão com o papel "venceu_app" (sem BYPASSRLS). Usada em todas as operações de usuário. */
  DATABASE_URL: z.string().min(1),
  /** Conexão com o papel proprietário. Autenticação, automações, webhooks, migrações e scripts. */
  DATABASE_OWNER_URL: z.string().min(1),
  DATABASE_SSL: bool.default(false),
  /** Conexões por instância. Em funções serverless use 1–2 com o pooler do Supabase. */
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(15),
  /** Certificado da autoridade do banco (PEM). No Supabase: Database → SSL Configuration. */
  DATABASE_SSL_CA: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  /** Região do projeto Supabase (ex.: sa-east-1), usada para descobrir o pooler automaticamente. */
  SUPABASE_REGION: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/).optional(),
  /**
   * Chave mestra (32 bytes em base64) que cifra tokens de integração (WhatsApp,
   * webhooks) e assina links de descadastro. Gere com:
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  SECRETS_KEY: z.string().optional(),
  /** smtp = envia e-mails; manual = o administrador copia o link e envia por canal seguro. */
  MAIL_MODE: z.enum(['smtp', 'manual']).optional(),
  /** limites de tentativas: memory (uma instância) ou postgres (serverless / várias instâncias). */
  RATE_LIMIT_STORE: z.enum(['memory', 'postgres']).default('memory'),
  /** Origens adicionais permitidas (CORS). Vazio = somente a mesma origem. */
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: bool.default(false),
  SMTP_URL: z.string().optional(),
  /** Alternativa ao SMTP_URL: usuário e senha de aplicativo (ex.: Gmail). */
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_HOST: z.string().default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  MAIL_FROM: z.string().optional(),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().positive().default(12),
  SESSION_IDLE_MINUTES: z.coerce.number().positive().default(120),
  /** Diretório do build do frontend servido pelo backend em homologação/produção. */
  WEB_DIST_DIR: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema> & {
  isProd: boolean;
  secureCookies: boolean;
  corsOrigins: string[];
  mailMode: 'smtp' | 'manual' | 'dev';
  mailFrom: string;
  secretsKey: Buffer;
  appUrl: string;
};

/** Erro de configuração: lista apenas NOMES de variáveis (nunca valores). */
export class ConfigError extends Error {
  constructor(
    readonly fields: string[],
    message: string,
  ) {
    super(message);
  }
}

// Chave fixa SOMENTE para desenvolvimento e testes (nunca aceita em homologação/produção).
const DEV_SECRETS_KEY = Buffer.alloc(32, 7);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Variáveis definidas mas vazias (ex.: "MAIL_MODE=" no .env) contam como não definidas.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new ConfigError(fields, `Configuração inválida ou ausente: ${fields.join(', ')}`);
  }
  const c = parsed.data;
  const isProd = c.APP_ENV === 'production' || c.APP_ENV === 'staging';
  const smtpConfigured = !!c.SMTP_URL || (!!c.SMTP_USER && !!c.SMTP_PASSWORD);
  const mailMode = smtpConfigured ? 'smtp' : c.MAIL_MODE ?? (isProd ? undefined : 'dev');
  if (!mailMode) {
    throw new ConfigError(['MAIL_MODE'], 'Em homologação/produção defina SMTP_USER e SMTP_PASSWORD (ou SMTP_URL) ou MAIL_MODE=manual.');
  }
  if (mailMode === 'smtp' && !smtpConfigured) {
    throw new ConfigError(['SMTP_USER', 'SMTP_PASSWORD'], 'MAIL_MODE=smtp exige SMTP_USER e SMTP_PASSWORD (ou SMTP_URL).');
  }
  const mailFrom = c.MAIL_FROM ?? (c.SMTP_USER ? `Venceu <${c.SMTP_USER.trim()}>` : 'Venceu <nao-responda@localhost>');
  if (isProd && !c.APP_URL.startsWith('https://')) throw new ConfigError(['APP_URL'], 'APP_URL deve usar https em homologação/produção.');

  let secretsKey = DEV_SECRETS_KEY;
  if (c.SECRETS_KEY) {
    const k = Buffer.from(c.SECRETS_KEY.trim(), 'base64');
    if (k.length !== 32) throw new ConfigError(['SECRETS_KEY'], 'SECRETS_KEY deve ter 32 bytes em base64.');
    secretsKey = k;
  } else if (isProd) {
    throw new ConfigError(['SECRETS_KEY'], 'Defina SECRETS_KEY (32 bytes em base64) em homologação/produção.');
  }

  return {
    ...c,
    isProd,
    secureCookies: c.APP_URL.startsWith('https://'),
    corsOrigins: c.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    mailMode,
    mailFrom,
    secretsKey,
    appUrl: c.APP_URL.replace(/\/$/, ''),
  };
}
