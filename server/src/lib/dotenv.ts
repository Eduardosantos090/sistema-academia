/** Carrega .env (se existir) para scripts de linha de comando. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnv(file = path.resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '');
  }
}
