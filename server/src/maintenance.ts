import type { Deps } from './lib/context.js';
import { queueReminders } from './modules/automation/reminders.js';
import { dispatchPending } from './modules/automation/dispatch.js';

/**
 * Rotina periódica (a cada 15 minutos): gera as cobranças recorrentes das
 * assinaturas, enfileira os lembretes do dia, envia a fila e faz a limpeza
 * de sessões, tokens e contadores vencidos.
 */
export async function runMaintenance(deps: Deps, budgetMs = 20_000) {
  const deadline = Date.now() + budgetMs;
  await deps.pools.owner.query(
    `delete from sessions where expires_at < now();
     delete from password_resets where expires_at < now() - interval '7 days';
     delete from invites where expires_at < now() - interval '30 days' and used_at is null;
     delete from rate_limit_counters where expires_at < now() - interval '1 hour';
     update messages set status = 'cancelada', error = 'Envio manual não realizado em 7 dias.'
      where status = 'manual' and created_at < now() - interval '7 days';`,
  );
  const { rows } = await deps.pools.owner.query<{ n: number }>('select app.generate_charges(null, 30) as n');
  const queued = await queueReminders(deps);
  const sent = await dispatchPending(deps, { deadline });
  return { chargesCreated: rows[0]!.n, queued, ...sent };
}
