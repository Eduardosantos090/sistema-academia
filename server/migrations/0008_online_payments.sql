-- Recebimento automático por PIX (AbacatePay): cada cobrança ganha um link
-- público de pagamento; o QR Code PIX é gerado no provedor quando o cliente
-- abre o link, e o pagamento é confirmado pelo webhook ou por consulta
-- periódica ao provedor (nunca pelo conteúdo do webhook sozinho).

-- Chave da API e segredo do webhook: cifrados, só o servidor privilegiado lê.
alter table org_channels
  add column abacate_api_key_enc        text,
  add column abacate_webhook_secret_enc text;

-- Indicador público (sem segredo) de que a organização recebe por PIX online.
alter table organizations add column online_pay boolean not null default false;
grant select (online_pay) on organizations to venceu_app;

-- Identificador do link público de pagamento (64 hex, imprevisível).
alter table charges add column pay_token text not null default app.random_hex();
alter table charges add constraint charges_pay_token_key unique (pay_token);
alter table charges add constraint charges_pay_token_format check (pay_token ~ '^[0-9a-f]{64}$');

-- PIX gerados no provedor. Sem permissões para o papel da aplicação:
-- somente o servidor cria, consulta e confirma.
create table online_payments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  charge_id        uuid not null references charges (id) on delete cascade,
  provider         text not null default 'abacatepay' check (provider in ('abacatepay')),
  provider_id      text not null check (char_length(provider_id) between 1 and 200),
  amount_cents     integer not null check (amount_cents > 0),
  br_code          text not null check (char_length(br_code) <= 1000),
  br_code_image    text check (char_length(br_code_image) <= 200000),
  status           text not null default 'PENDING' check (status in ('PENDING', 'EXPIRED', 'CANCELLED', 'PAID', 'REFUNDED')),
  dev_mode         boolean not null default false,
  expires_at       timestamptz not null,
  checked_at       timestamptz,
  paid_at          timestamptz,
  created_at       timestamptz not null default now(),
  unique (provider, provider_id)
);
create index online_payments_charge on online_payments (charge_id, created_at desc);
create index online_payments_pending on online_payments (checked_at nulls first) where status = 'PENDING';
alter table online_payments enable row level security;
revoke all on online_payments from public;

-- O indicador online_pay só é alterado pelo servidor (ao salvar a chave).
create or replace function app.tg_org_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if app.uid() is null or app.is_platform() or current_user <> 'venceu_app' then return new; end if;
  if new.slug is distinct from old.slug or new.is_active is distinct from old.is_active
     or new.webhook_id is distinct from old.webhook_id or new.suspended_reason is distinct from old.suspended_reason
     or new.plan_name is distinct from old.plan_name or new.plan_amount_cents is distinct from old.plan_amount_cents
     or new.access_until is distinct from old.access_until or new.auto_suspend is distinct from old.auto_suspend
     or new.billing_customer_id is distinct from old.billing_customer_id or new.is_billing_org is distinct from old.is_billing_org
     or new.online_pay is distinct from old.online_pay then
    raise exception 'Somente a administração da plataforma altera estes dados.' using errcode = 'VC403';
  end if;
  return new;
end $$;

-- O link de pagamento de uma cobrança não é trocado pelo painel.
create or replace function app.tg_charge_token_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'venceu_app' and new.pay_token is distinct from old.pay_token then
    raise exception 'Operação não permitida.' using errcode = 'VC403';
  end if;
  return new;
end $$;
create trigger charges_token_guard before update on charges for each row execute function app.tg_charge_token_guard();
