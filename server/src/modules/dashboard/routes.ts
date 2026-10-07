import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../lib/context.js';
import { asUser, requireOrg } from '../../lib/context.js';

export function registerDashboardRoutes(app: FastifyInstance, deps: Deps) {
  /** Contadores leves para os avisos do menu. */
  app.get('/api/counters', async (req) => {
    requireOrg(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `select (select count(*)::int from conversations where status = 'humano' and unread > 0) as "waitingConversations",
                (select count(*)::int from messages where status = 'manual') as "manualQueue",
                (select count(*)::int from charges where status = 'aberta' and reported_paid_at is not null) as "toConfirm",
                o.plan_name as "planName", to_char(o.access_until, 'YYYY-MM-DD') as "accessUntil",
                (o.access_until - app.org_today(o.id)) as "accessDaysLeft", o.grace_days as "graceDays", o.auto_suspend as "autoSuspend"
           from organizations o where o.id = $1`,
        [requireOrg(req).orgId],
      );
      return rows[0];
    });
  });

  app.get('/api/dashboard', async (req) => {
    const me = requireOrg(req);
    return asUser(deps, req, async (db) => {
      const { rows } = await db.query(
        `with t as (select app.org_today($1) as today)
         select to_char(t.today, 'YYYY-MM-DD') as "today",
           (select coalesce(sum(amount_cents), 0)::bigint from charges, t where status = 'aberta'
              and date_trunc('month', due_date) = date_trunc('month', t.today)) as "receivableMonthCents",
           (select coalesce(sum(paid_amount_cents), 0)::bigint from charges ch, t where status = 'paga'
              and date_trunc('month', (paid_at at time zone o.timezone)) = date_trunc('month', t.today)) as "receivedMonthCents",
           (select count(*)::int from charges ch, t where status = 'paga'
              and date_trunc('month', (paid_at at time zone o.timezone)) = date_trunc('month', t.today)) as "receivedMonthCount",
           (select coalesce(sum(amount_cents), 0)::bigint from charges, t where status = 'aberta' and due_date < t.today) as "overdueCents",
           (select count(*)::int from charges, t where status = 'aberta' and due_date < t.today) as "overdueCount",
           (select count(distinct customer_id)::int from charges, t where status = 'aberta' and due_date < t.today) as "overdueCustomers",
           (select count(*)::int from charges, t where status = 'aberta' and due_date between t.today and t.today + 7) as "dueSoonCount",
           (select coalesce(sum(amount_cents), 0)::bigint from charges, t where status = 'aberta' and due_date between t.today and t.today + 7) as "dueSoonCents",
           (select count(*)::int from charges, t where status = 'aberta' and due_date = t.today) as "dueTodayCount",
           (select count(*)::int from charges where status = 'aberta' and reported_paid_at is not null) as "toConfirmCount",
           (select count(*)::int from customers where is_active) as "activeCustomers",
           (select count(*)::int from subscriptions where status = 'ativa') as "activeSubscriptions",
           (select count(*)::int from conversations where status = 'humano' and unread > 0) as "waitingConversations",
           (select count(*)::int from messages where status = 'manual') as "manualQueue",
           (select count(*)::int from messages where status = 'falhou' and created_at > now() - interval '7 days') as "failedMessages",
           (select count(*)::int from messages where status = 'enviada' and sent_at > now() - interval '30 days') as "sent30d",
           (select case when count(*) = 0 then null else round(100.0 * count(*) filter (where status = 'paga') / count(*))::int end
              from charges, t where status <> 'cancelada' and due_date between t.today - 30 and t.today - 1) as "onTimeRate"
         from t, organizations o where o.id = $1`,
        [me.orgId],
      );
      const series = await db.query(
        `with t as (select app.org_today($1) as today, (select timezone from organizations where id = $1) as tz),
              months as (select generate_series(date_trunc('month', t.today) - interval '5 months', date_trunc('month', t.today), interval '1 month')::date as m from t)
         select to_char(m, 'YYYY-MM') as month,
           (select coalesce(sum(paid_amount_cents), 0)::bigint from charges, t where status = 'paga'
              and date_trunc('month', paid_at at time zone t.tz) = m) as "receivedCents",
           (select coalesce(sum(amount_cents), 0)::bigint from charges where status <> 'cancelada'
              and date_trunc('month', due_date) = m) as "billedCents",
           (select coalesce(sum(amount_cents), 0)::bigint from charges, t where status = 'aberta' and due_date < t.today
              and date_trunc('month', due_date) = m) as "overdueCents"
         from months order by m`,
        [me.orgId],
      );
      const cols = `ch.id, ch.description, ch.amount_cents as "amountCents", to_char(ch.due_date, 'YYYY-MM-DD') as "dueDate",
        ch.reported_paid_at as "reportedPaidAt", cu.id as "customerId", cu.name as "customerName", cu.phone as "customerPhone",
        (app.org_today(ch.organization_id) - ch.due_date) as "daysLate"`;
      const upcoming = await db.query(
        `select ${cols} from charges ch join customers cu on cu.id = ch.customer_id
          where ch.status = 'aberta' and ch.due_date between app.org_today(ch.organization_id) and app.org_today(ch.organization_id) + 7
          order by ch.due_date, cu.name limit 8`,
      );
      const overdue = await db.query(
        `select ${cols} from charges ch join customers cu on cu.id = ch.customer_id
          where ch.status = 'aberta' and ch.due_date < app.org_today(ch.organization_id)
          order by ch.due_date limit 8`,
      );
      // Quem vence hoje, amanhã, em 2 e em 3 dias (com situação do lembrete).
      const dueSoon = await db.query(
        `select ch.id, ch.description, ch.amount_cents as "amountCents", to_char(ch.due_date, 'YYYY-MM-DD') as "dueDate",
                (ch.due_date - app.org_today(ch.organization_id)) as "inDays",
                cu.id as "customerId", cu.name as "customerName", cu.phone as "customerPhone",
                exists (select 1 from messages m where m.charge_id = ch.id and m.status = 'enviada') as "reminded"
           from charges ch join customers cu on cu.id = ch.customer_id
          where ch.status = 'aberta' and ch.due_date between app.org_today(ch.organization_id) and app.org_today(ch.organization_id) + 3
          order by ch.due_date, cu.name limit 400`,
      );
      const toConfirm = await db.query(
        `select ${cols} from charges ch join customers cu on cu.id = ch.customer_id
          where ch.status = 'aberta' and ch.reported_paid_at is not null order by ch.reported_paid_at desc limit 6`,
      );
      return { ...rows[0], series: series.rows, upcoming: upcoming.rows, overdue: overdue.rows, toConfirm: toConfirm.rows, dueSoon: dueSoon.rows };
    });
  });
}
