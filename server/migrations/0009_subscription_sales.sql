-- Venda online da assinatura do Venceu (AbacatePay): a pessoa se cadastra na
-- página de vendas, paga no checkout de assinatura da AbacatePay e a conta é
-- criada automaticamente. Renovações estendem o acesso; cancelamento deixa o
-- acesso terminar no fim do período pago.

-- Configuração da venda (linha única), somente servidor privilegiado.
create table platform_settings (
  id                         smallint primary key default 1 check (id = 1),
  abacate_api_key_enc        text,
  abacate_webhook_secret_enc text,
  sale_enabled               boolean not null default false,
  sale_product_id            text check (sale_product_id is null or sale_product_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  sale_plan_name             text not null default 'Venceu Mensal' check (char_length(sale_plan_name) between 2 and 80),
  sale_price_cents           integer not null default 5000 check (sale_price_cents between 100 and 100000000),
  sale_interval_months       smallint not null default 1 check (sale_interval_months in (1, 3, 6, 12)),
  sale_methods               text[] not null default array['CARD'] check (sale_methods <@ array['CARD', 'PIX'] and cardinality(sale_methods) >= 1),
  updated_at                 timestamptz not null default now()
);
insert into platform_settings (id, sale_product_id) values (1, 'prod_XkFSP4HpB41XDPPXyMtKj5am');
alter table platform_settings enable row level security;
revoke all on platform_settings from public;

-- Cadastros iniciados na página de vendas (antes e depois do pagamento).
create table signups (
  id                   uuid primary key default gen_random_uuid(),
  token                text not null unique default app.random_hex() check (token ~ '^[0-9a-f]{64}$'),
  owner_name           text not null check (char_length(owner_name) between 2 and 120),
  business_name        text not null check (char_length(business_name) between 2 and 120),
  segment              text not null default 'outro' check (char_length(segment) <= 40),
  email                citext not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone                text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  document             text check (document is null or document ~ '^[0-9]{11}$|^[0-9]{14}$'),
  -- Senha escolhida no cadastro (hash scrypt); apagada quando a conta é criada.
  password_hash        text,
  status               text not null default 'pendente' check (status in ('pendente', 'ativo', 'cancelado', 'expirado')),
  abacate_customer_id  text,
  checkout_id          text unique,
  checkout_url         text,
  subscription_id      text unique,
  organization_id      uuid references organizations (id) on delete set null,
  error                text check (char_length(error) <= 300),
  checked_at           timestamptz,
  activated_at         timestamptz,
  created_at           timestamptz not null default now()
);
create index signups_pending on signups (checked_at nulls first) where status = 'pendente';
create index signups_email on signups (email, created_at desc);
alter table signups enable row level security;
revoke all on signups from public;

-- Assinatura da organização no provedor (somente servidor).
alter table organizations
  add column abacate_subscription_id text unique,
  add column subscription_status     text check (subscription_status in ('ativa', 'cancelada'));
grant select (subscription_status) on organizations to venceu_app;

-- Eventos de webhook já processados (o provedor reenvia em caso de falha).
create table webhook_events (
  provider     text not null,
  event_id     text not null check (char_length(event_id) between 1 and 200),
  received_at  timestamptz not null default now(),
  primary key (provider, event_id)
);
alter table webhook_events enable row level security;
revoke all on webhook_events from public;

create or replace function app.tg_org_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if app.uid() is null or app.is_platform() or current_user <> 'venceu_app' then return new; end if;
  if new.slug is distinct from old.slug or new.is_active is distinct from old.is_active
     or new.webhook_id is distinct from old.webhook_id or new.suspended_reason is distinct from old.suspended_reason
     or new.plan_name is distinct from old.plan_name or new.plan_amount_cents is distinct from old.plan_amount_cents
     or new.access_until is distinct from old.access_until or new.auto_suspend is distinct from old.auto_suspend
     or new.billing_customer_id is distinct from old.billing_customer_id or new.is_billing_org is distinct from old.is_billing_org
     or new.online_pay is distinct from old.online_pay
     or new.abacate_subscription_id is distinct from old.abacate_subscription_id
     or new.subscription_status is distinct from old.subscription_status then
    raise exception 'Somente a administração da plataforma altera estes dados.' using errcode = 'VC403';
  end if;
  return new;
end $$;
