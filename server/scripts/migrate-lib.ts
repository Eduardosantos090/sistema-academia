import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslFromEnv } from '../src/lib/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Funciona tanto em server/scripts (tsx) quanto em server/dist/scripts (build).
const dir = [path.resolve(here, '..', 'migrations'), path.resolve(here, '..', '..', 'migrations')].find(existsSync)!;

/** Aplica migrações versionadas em ordem, cada uma em transação, com checksum. */
export async function migrate(connectionString: string, log: (m: string) => void = console.log) {
  const client = new pg.Client({ connectionString, ssl: sslFromEnv() });
  await client.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    await client.query('revoke all on schema_migrations from public');
    await client.query('alter table schema_migrations enable row level security');
    const applied = new Map(
      (await client.query<{ name: string; checksum: string }>('select name, checksum from schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const sql = readFileSync(path.join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      const prev = applied.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`Migração ${f} foi alterada após aplicada. Crie uma nova migração.`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [f, sum]);
        await client.query('commit');
        log(`aplicada: ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Falha na migração ${f}: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}
