-- =====================================================================
-- 0006 — Renovação automática de acesso mais restrita.
-- Antes: qualquer cobrança paga do cliente de cobrança renovava o acesso a
-- partir do vencimento (uma cobrança avulsa com vencimento em 2099 daria
-- acesso até 2099). Agora:
--   • só cobranças GERADAS pela assinatura do plano renovam;
--   • a renovação é limitada a um período (+1 mês de folga) a partir de hoje.
-- =====================================================================
create or replace function app.tg_platform_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o record;
  months int;
  target date;
begin
  if new.status <> 'paga' or old.status = 'paga' or new.subscription_id is null then return new; end if;
  for o in
    select org.id, org.plan_interval_months, org.access_until
      from organizations org
      join subscriptions s on s.id = new.subscription_id and s.customer_id = org.billing_customer_id
     where org.billing_customer_id = new.customer_id
  loop
    select coalesce((select interval_months from subscriptions where id = new.subscription_id), o.plan_interval_months, 1) into months;
    target := least(
      greatest(coalesce(o.access_until, new.due_date), (new.due_date + make_interval(months => months))::date),
      (app.org_today(o.id) + make_interval(months => months + 1))::date
    );
    update organizations
       set access_until = greatest(coalesce(access_until, target), target),
           is_active = case when suspended_reason = 'inadimplencia' then true else is_active end,
           suspended_reason = case when suspended_reason = 'inadimplencia' then null else suspended_reason end
     where id = o.id;
    insert into audit_events (actor_id, organization_id, action, entity_type, entity_id, details)
    values (app.uid(), o.id, 'platform.access_renewed', 'organization', o.id::text,
            jsonb_build_object('charge', new.id, 'months', months, 'until', target));
  end loop;
  return new;
end $$;

revoke all on function app.tg_platform_payment() from public;
