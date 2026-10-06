import { loadDotEnv } from './lib/dotenv.js';
import { loadConfig } from './config.js';

loadDotEnv();
import { createDeps } from './deps.js';
import { buildApp } from './app.js';
import { runMaintenance } from './maintenance.js';

const config = loadConfig();
const deps = await createDeps(config);
const app = await buildApp(deps);

// Automação periódica: cobranças recorrentes, lembretes, envio da fila e limpeza.
const tick = () => void runMaintenance(deps).catch((e) => app.log.error({ err: { message: (e as Error).message } }, 'automação falhou'));
const cleanup = setInterval(tick, 15 * 60 * 1000);
setTimeout(tick, 10_000).unref();
cleanup.unref();

const shutdown = async () => {
  await app.close();
  await deps.pools.app.end();
  await deps.pools.owner.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
