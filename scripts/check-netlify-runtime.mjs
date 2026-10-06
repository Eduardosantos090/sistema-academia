// Simula o ambiente das Netlify Functions: código da função transpilado com as
// dependências carregadas de node_modules (como o empacotador do Netlify faz) e
// Node sem suporte a require() de módulos ES (runtimes mais antigos).
// Sobe a API e faz requisições que não precisam de banco.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const out = path.join(root, '.netlify-runtime-check');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync('npx', ['esbuild', 'netlify/functions/api.mts', '--bundle', '--packages=external', '--platform=node',
  '--format=esm', `--outfile=${out}/api.mjs`, '--log-level=warning'], { stdio: 'inherit' });
symlinkSync(path.join(root, 'node_modules'), path.join(out, 'node_modules'));
writeFileSync(`${out}/run.mjs`, `
Object.assign(process.env, {
  APP_ENV: 'staging', APP_URL: 'https://exemplo.netlify.app', MAIL_MODE: 'manual',
  DATABASE_URL: 'postgres://x:y@127.0.0.1:1/x', DATABASE_OWNER_URL: 'postgres://x:y@127.0.0.1:1/x',
  SECRETS_KEY: Buffer.alloc(32, 1).toString('base64'), RATE_LIMIT_STORE: 'postgres', LOG_LEVEL: 'silent',
});
const { default: handler } = await import('./api.mjs');
const call = async (path, init = {}) => handler(new Request('https://exemplo.netlify.app' + path, init), { ip: '203.0.113.1' });
const checks = [
  // Sem banco neste teste: a API sobe e informa só a categoria da falha.
  ['GET /api/health (sem banco)', await call('/api/health'), 503],
  ['GET /api/auth/me sem sessão', await call('/api/auth/me'), 401],
  ['POST login inválido (validação)', await call('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://exemplo.netlify.app' }, body: '{"email":"x"}' }), 422],
];
let ok = true;
for (const [name, res, expected] of checks) {
  const pass = res.status === expected;
  ok &&= pass;
  console.log((pass ? 'ok   ' : 'FALHA') + ' ' + name + ' -> ' + res.status);
}
process.exit(ok ? 0 : 1);
`);
try {
  execFileSync(process.execPath, ['--no-experimental-require-module', `${out}/run.mjs`], { stdio: 'inherit' });
} finally {
  rmSync(out, { recursive: true, force: true });
}
