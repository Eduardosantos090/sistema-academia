import type { Deps } from './lib/context.js';
import { queueReminders } from './modules/automation/reminders.js';
import { dispatchPending } from './modules/automation/dispatch.js';
import { pollOnlinePayments } from './modules/payments/service.js';

/**
 * Rotina periódica (a cada minuto): gera as cobranças recorrentes das
 * assinaturas, enfileira os lembretes do dia, envia a fila e faz a limpeza
 * de sessões, tokens e contadores vencidos.
 */
export async function runMaintenance(deps: Deps, budgetMs = 20_000) {
  const deadline = Date.now() + budgetMs;
  // Limpeza, geração de cobranças e enfileiramento são idempotentes; o envio respeita o intervalo de cada organização.
  await deps.pools.owner.query(
    `delete from sessions where expires_at < now();
     delete from password_resets where expires_at < now() - interval '7 days';
     delete from invites where expires_at < now() - interval '30 days' and used_at is null;
     delete from rate_limit_counters where expires_at < now() - interval '1 hour';
     update messages set status = 'cancelada', error = 'Envio manual não realizado em 7 dias.'
      where status = 'manual' and created_at < now() - interval '7 days';`,
  );
  // Plano vencido + tolerância, com suspensão automática: bloqueia o acesso da organização.
  const suspended = await deps.pools.owner.query<{ id: string }>(
    `update organizations set is_active = false, suspended_reason = 'inadimplencia'
      where is_active and auto_suspend and not is_billing_org and access_until is not null
        and access_until + grace_days < app.org_today(id)
      returning id`,
  );
  for (const o of suspended.rows) {
    await deps.pools.owner.query('delete from sessions where user_id in (select id from users where organization_id = $1)', [o.id]);
    await deps.pools.owner.query(
      `insert into audit_events (organization_id, action, entity_type, entity_id) values ($1, 'platform.auto_suspended', 'organization', $2)`,
      [o.id, o.id],
    );
  }
  const { rows } = await deps.pools.owner.query<{ n: number }>('select app.generate_charges(null, 30) as n');
  const queued = await queueReminders(deps);
  // PIX online: confere pagamentos pendentes (caso algum aviso do provedor não tenha chegado).
  const pix = await pollOnlinePayments(deps).catch(() => ({ checked: 0, paid: 0 }));
  const sent = await dispatchPending(deps, { deadline });
  return { chargesCreated: rows[0]!.n, queued, pixPaid: pix.paid, ...sent };
}
