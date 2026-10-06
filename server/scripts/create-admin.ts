/**
 * Provisionamento seguro do primeiro administrador da PLATAFORMA Venceu.
 *
 *   npm run admin:create -- --email pessoa@empresa.com.br --name "Nome Completo"
 *
 * Não existe senha fixa: o script cria o usuário e um convite de uso único
 * (72 h). O link é exibido somente neste terminal (e enviado por e-mail se
 * SMTP estiver configurado). A pessoa define a própria senha ao aceitar.
 * Se já houver administrador ativo, exige --additional.
 */
import { parseArgs } from 'node:util';
import pg from 'pg';
import { sslFromEnv } from '../src/lib/db.js';
import { loadDotEnv } from '../src/lib/dotenv.js';
import { newToken, sha256 } from '../src/lib/crypto.js';
import { normalizeEmail } from '../src/lib/normalize.js';

loadDotEnv();
const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    additional: { type: 'boolean', default: false },
  },
});

const email = normalizeEmail(values.email ?? '');
const name = (values.name ?? '').trim();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || name.length < 2) {
  console.error('Uso: npm run admin:create -- --email <email> --name "<nome>" [--additional]');
  process.exit(1);
}
const url = process.env.DATABASE_OWNER_URL;
const appUrl = process.env.APP_URL;
if (!url || !appUrl) {
  console.error('Defina DATABASE_OWNER_URL e APP_URL.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: sslFromEnv() });
await client.connect();
try {
  await client.query('begin');
  const admins = await client.query('select count(*)::int as n from users where is_platform_admin and is_active');
  if (admins.rows[0].n > 0 && !values.additional) {
    throw new Error('Já existe administrador da plataforma ativo. Execute com --additional para criar outro.');
  }
  const exists = await client.query('select 1 from users where email = $1', [email]);
  if (exists.rowCount) throw new Error('Já existe usuário com este e-mail.');
  const { rows } = await client.query<{ id: string }>(
    'insert into users (email, full_name, is_platform_admin) values ($1, $2, true) returning id',
    [email, name],
  );
  const id = rows[0]!.id;
  const token = newToken();
  await client.query(
    "insert into invites (token_hash, user_id, expires_at) values ($1, $2, now() + interval '72 hours')",
    [sha256(token), id],
  );
  await client.query(
    "insert into audit_events (actor_id, action, entity_type, entity_id, details) values (null, 'admin.provisioned_cli', 'user', $1, '{}')",
    [id],
  );
  await client.query('commit');
  console.log('\nAdministrador criado. Envie o link abaixo por canal seguro à pessoa (uso único, 72 h):\n');
  console.log(`${appUrl.replace(/\/$/, '')}/convite#token=${token}\n`);
} catch (e) {
  await client.query('rollback');
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
