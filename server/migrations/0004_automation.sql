-- =====================================================================
-- Automação: geração das cobranças recorrentes das assinaturas.
--
-- Cada assinatura ativa guarda o próximo vencimento ainda não gerado
-- (next_due_date). A função cria as cobranças que vencem dentro do
-- horizonte (padrão: 30 dias) e avança o próximo vencimento. É idempotente
-- (índice único por assinatura + vencimento) e segura para execução
-- concorrente (FOR UPDATE SKIP LOCKED).
--
-- Chamada pela equipe (RLS: somente a própria organização) ao criar uma
-- assinatura, e pelo servidor privilegiado na rotina periódica.
-- =====================================================================

create or replace function app.generate_charges(p_subscription uuid default null, p_horizon_days int default 30)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s record;
  due date;
  created integer := 0;
  guard integer;
  inserted integer;
begin
  if p_horizon_days not between 0 and 120 then
    raise exception 'Horizonte inválido.' using errcode = 'VC422';
  end if;
  for s in
    select sub.*
      from subscriptions sub
      join customers cu on cu.id = sub.customer_id and cu.is_active
      join organizations o on o.id = sub.organization_id and o.is_active
     where sub.status = 'ativa'
       and (p_subscription is null or sub.id = p_subscription)
       -- Usuário comum: somente assinaturas da própria organização.
       and (app.uid() is null or sub.organization_id = app.org_id())
       and sub.next_due_date <= app.org_today(sub.organization_id) + p_horizon_days
     for update of sub skip locked
  loop
    due := s.next_due_date;
    guard := 0;
    while due <= app.org_today(s.organization_id) + p_horizon_days and guard < 24 loop
      insert into charges (organization_id, customer_id, subscription_id, description, amount_cents, due_date)
      values (s.organization_id, s.customer_id, s.id, s.description, s.amount_cents, due)
      on conflict (subscription_id, due_date) where subscription_id is not null and status <> 'cancelada' do nothing;
      get diagnostics inserted = row_count;
      created := created + inserted;
      due := app.add_months_keep_day(due, s.interval_months, s.billing_day);
      guard := guard + 1;
    end loop;
    update subscriptions set next_due_date = due where id = s.id;
  end loop;
  return created;
end $$;

revoke all on function app.generate_charges(uuid, int) from public;
grant execute on function app.generate_charges(uuid, int) to venceu_app;
