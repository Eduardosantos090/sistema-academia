import type { Deps } from '../../lib/context.js';
import { chargeValues, renderTemplate, variablesInOrder, type OrgPaymentInfo } from '../../lib/template.js';
import { emailAvailable, loadChannels, whatsappAutomatic } from '../channels/service.js';

interface OrgClock extends OrgPaymentInfo {
  id: string;
  send_hour: number;
  local_hour: number;
  today: string;
}

interface DueRow {
  rule_id: string;
  offset_days: number;
  send_whatsapp: boolean;
  send_email: boolean;
  body: string;
  subject: string | null;
  wa_template_name: string | null;
  wa_template_lang: string;
  charge_id: string;
  description: string;
  amount_cents: number;
  due_date: string;
  payment_link: string | null;
  customer_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp_opt_in: boolean;
  email_opt_in: boolean;
}

/** Último horário local para envios automáticos (não incomodar à noite). */
const QUIET_FROM_HOUR = 21;

/**
 * Coloca na caixa de saída os lembretes do dia (regras de N dias antes, no
 * dia e depois do vencimento), respeitando o horário de envio da
 * organização e o consentimento de cada cliente por canal. Idempotente: a
 * chave de deduplicação impede o mesmo lembrete duas vezes.
 */
export async function queueReminders(deps: Deps, onlyOrg?: string) {
  const { rows: orgs } = await deps.pools.owner.query<OrgClock>(
    `select o.id, o.name, o.pix_key, o.payment_instructions, o.contact_phone, o.send_hour,
            extract(hour from now() at time zone o.timezone)::int as local_hour,
            to_char((now() at time zone o.timezone)::date, 'YYYY-MM-DD') as today
       from organizations o
      where o.is_active and ($1::uuid is null or o.id = $1)`,
    [onlyOrg ?? null],
  );
  let queued = 0;
  for (const org of orgs) {
    if (org.local_hour < org.send_hour || org.local_hour >= QUIET_FROM_HOUR) continue;
    const channels = await loadChannels(deps, org.id);
    const waAuto = whatsappAutomatic(channels);
    const emailOk = emailAvailable(deps, channels);
    const { rows } = await deps.pools.owner.query<DueRow>(
      `select r.id as rule_id, r.offset_days, r.send_whatsapp, r.send_email,
              t.body, t.subject, t.wa_template_name, t.wa_template_lang,
              c.id as charge_id, c.description, c.amount_cents, to_char(c.due_date, 'YYYY-MM-DD') as due_date, c.payment_link,
              cu.id as customer_id, cu.name, cu.email, cu.phone, cu.whatsapp_opt_in, cu.email_opt_in
         from reminder_rules r
         join message_templates t on t.id = r.template_id
         join charges c on c.organization_id = r.organization_id and c.status = 'aberta'
         join customers cu on cu.id = c.customer_id and cu.is_active
        where r.organization_id = $1 and r.is_active
          and c.due_date + r.offset_days = $2::date
          -- Depois do vencimento, não cobra quem avisou que já pagou (aguardando conferência).
          and (r.offset_days <= 0 or c.reported_paid_at is null)
        order by c.due_date, cu.name`,
      [org.id, org.today],
    );
    for (const r of rows) {
      const values = chargeValues(org, r, r, org.today);
      const body = renderTemplate(r.body, values);
      const subject = r.subject ? renderTemplate(r.subject, values).slice(0, 150) : null;
      const targets: { channel: 'whatsapp' | 'email'; to: string; status: 'pendente' | 'manual' }[] = [];
      if (r.send_whatsapp && r.phone && r.whatsapp_opt_in) {
        targets.push({ channel: 'whatsapp', to: r.phone, status: waAuto ? 'pendente' : 'manual' });
      }
      if (r.send_email && r.email && r.email_opt_in && emailOk) {
        targets.push({ channel: 'email', to: r.email, status: 'pendente' });
      }
      const waTemplate =
        r.wa_template_name && channels.mode === 'cloud_api'
          ? { name: r.wa_template_name, lang: r.wa_template_lang, params: variablesInOrder(r.body).map((v) => values[v] ?? '') }
          : null;
      for (const t of targets) {
        const res = await deps.pools.owner.query(
          `insert into messages (organization_id, customer_id, charge_id, rule_id, channel, kind, to_address, subject, body,
                                 wa_template, status, dedupe_key)
           values ($1, $2, $3, $4, $5, 'lembrete', $6, $7, $8, $9, $10, $11)
           on conflict (dedupe_key) do nothing`,
          [
            org.id,
            r.customer_id,
            r.charge_id,
            r.rule_id,
            t.channel,
            t.to,
            t.channel === 'email' ? subject : null,
            body.slice(0, 4096),
            t.channel === 'whatsapp' && waTemplate ? JSON.stringify(waTemplate) : null,
            t.status,
            `rule:${r.rule_id}:${r.charge_id}:${r.due_date}:${t.channel}`,
          ],
        );
        queued += res.rowCount ?? 0;
      }
    }
  }
  return queued;
}
