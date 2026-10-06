-- =====================================================================
-- Venceu — esquema inicial
-- Multiempresa: cada organização (academia, escola, clínica, estúdio,
-- prestador de serviços…) só enxerga os próprios dados.
-- Políticas de acesso (RLS), funções e permissões ficam em 0002/0003.
-- =====================================================================

create extension if not exists citext;

create schema if not exists app;

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
create type org_role as enum ('owner', 'staff');
create type subscription_status as enum ('ativa', 'pausada', 'cancelada');
create type charge_status as enum ('aberta', 'paga', 'cancelada');
create type template_kind as enum ('lembrete', 'vencimento', 'atraso', 'pagamento_confirmado', 'personalizada');
create type message_channel as enum ('whatsapp', 'email');
create type message_status as enum ('pendente', 'manual', 'enviada', 'falhou', 'cancelada');
create type conversation_status as enum ('bot', 'humano', 'encerrada');
create type whatsapp_mode as enum ('manual', 'cloud_api', 'webhook');

-- Gera identificador aleatório (hex, 64 caracteres) sem depender de pgcrypto.
create or replace function app.random_hex() returns text
language sql volatile set search_path = public, pg_temp as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

-- ---------------------------------------------------------------------
-- Organizações (clientes da plataforma)
-- ---------------------------------------------------------------------
create table organizations (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (char_length(btrim(name)) between 2 and 120),
  slug                  text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$'),
  segment               text not null default 'outro' check (char_length(segment) <= 40),
  contact_email         citext check (contact_email is null or contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  contact_phone         text check (contact_phone is null or contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  document              text check (document is null or document ~ '^[0-9]{11}$|^[0-9]{14}$'),
  pix_key               text check (char_length(pix_key) <= 140),
  payment_instructions  text check (char_length(payment_instructions) <= 1000),
  timezone              text not null default 'America/Sao_Paulo' check (char_length(timezone) <= 64),
  send_hour             smallint not null default 9 check (send_hour between 6 and 20),
  notify_on_payment     boolean not null default true,
  bot_enabled           boolean not null default true,
  bot_greeting          text check (char_length(bot_greeting) <= 500),
  webhook_id            text not null unique default app.random_hex(),
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Canais de envio e segredos de integração: SOMENTE o servidor privilegiado
-- acessa (sem permissões para o papel da aplicação). Segredos cifrados
-- (AES-256-GCM) com a chave SECRETS_KEY, que nunca fica no banco.
create table org_channels (
  organization_id     uuid primary key references organizations (id) on delete cascade,
  whatsapp_mode       whatsapp_mode not null default 'manual',
  wa_phone_number_id  text check (wa_phone_number_id is null or wa_phone_number_id ~ '^[0-9]{5,30}$'),
  wa_access_token_enc text,
  wa_app_secret_enc   text,
  wa_verify_token_enc text,
  webhook_url         text check (webhook_url is null or (webhook_url ~ '^https://' and char_length(webhook_url) <= 500)),
  webhook_secret_enc  text,
  email_enabled       boolean not null default true,
  email_reply_to      citext check (email_reply_to is null or email_reply_to ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Usuários (sem credenciais — ver user_credentials)
-- ---------------------------------------------------------------------
create table users (
  id                 uuid primary key default gen_random_uuid(),
  email              citext not null unique
                     check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name          text not null check (char_length(btrim(full_name)) between 2 and 120),
  organization_id    uuid references organizations (id) on delete restrict,
  role               org_role,
  is_platform_admin  boolean not null default false,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_login_at      timestamptz,
  constraint users_role_matches_org check ((organization_id is null) = (role is null)),
  constraint users_has_scope check (is_platform_admin or organization_id is not null)
);
create index users_org_idx on users (organization_id);

create table user_credentials (
  user_id              uuid primary key references users (id) on delete cascade,
  password_hash        text not null,
  password_changed_at  timestamptz not null default now(),
  failed_attempts      integer not null default 0,
  locked_until         timestamptz
);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  token_hash    bytea not null unique,
  csrf_token    text not null,
  user_id       uuid not null references users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  user_agent    text,
  ip            inet
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expires_idx on sessions (expires_at);

create table invites (
  id          uuid primary key default gen_random_uuid(),
  token_hash  bytea not null unique,
  user_id     uuid not null references users (id) on delete cascade,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz
);
create index invites_user_idx on invites (user_id);

create table password_resets (
  id          uuid primary key default gen_random_uuid(),
  token_hash  bytea not null unique,
  user_id     uuid not null references users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index password_resets_user_idx on password_resets (user_id);

create table rate_limit_counters (
  key_hash      text not null,
  window_start  timestamptz not null,
  hits          integer not null,
  expires_at    timestamptz not null,
  primary key (key_hash, window_start)
);
create index rate_limit_counters_expires_idx on rate_limit_counters (expires_at);

-- ---------------------------------------------------------------------
-- Clientes da organização (alunos, pacientes, assinantes…)
-- ---------------------------------------------------------------------
create table customers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 2 and 120),
  email            citext check (email is null or (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone            text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  document         text check (document is null or document ~ '^[0-9]{11}$|^[0-9]{14}$'),
  notes            text check (char_length(notes) <= 2000),
  whatsapp_opt_in  boolean not null default true,
  email_opt_in     boolean not null default true,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index customers_org_idx on customers (organization_id, is_active, name);
create index customers_phone_idx on customers (organization_id, phone);

-- ---------------------------------------------------------------------
-- Planos, assinaturas e cobranças (vencimentos)
-- ---------------------------------------------------------------------
create table plans (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  name             text not null check (char_length(btrim(name)) between 2 and 80),
  description      text check (char_length(description) <= 500),
  amount_cents     integer not null check (amount_cents between 1 and 100000000),
  interval_months  smallint not null check (interval_months in (1, 2, 3, 6, 12)),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index plans_name_uq on plans (organization_id, lower(btrim(name)));

create table subscriptions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  customer_id      uuid not null references customers (id) on delete cascade,
  plan_id          uuid references plans (id) on delete set null,
  description      text not null check (char_length(btrim(description)) between 2 and 120),
  amount_cents     integer not null check (amount_cents between 1 and 100000000),
  interval_months  smallint not null check (interval_months in (1, 2, 3, 6, 12)),
  -- Próximo vencimento ainda NÃO gerado como cobrança.
  next_due_date    date not null,
  billing_day      smallint not null check (billing_day between 1 and 31),
  status           subscription_status not null default 'ativa',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  cancelled_at     timestamptz
);
create index subscriptions_customer_idx on subscriptions (customer_id);
create index subscriptions_due_idx on subscriptions (status, next_due_date);

create table charges (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations (id) on delete cascade,
  customer_id        uuid not null references customers (id) on delete cascade,
  subscription_id    uuid references subscriptions (id) on delete set null,
  description        text not null check (char_length(btrim(description)) between 2 and 160),
  amount_cents       integer not null check (amount_cents between 1 and 100000000),
  due_date           date not null,
  status             charge_status not null default 'aberta',
  paid_at            timestamptz,
  paid_amount_cents  integer check (paid_amount_cents is null or paid_amount_cents between 0 and 100000000),
  payment_method     text check (payment_method in ('pix', 'dinheiro', 'cartao', 'boleto', 'transferencia', 'outro')),
  payment_link       text check (payment_link is null or (payment_link ~ '^https://' and char_length(payment_link) <= 500)),
  -- Cliente informou pelo assistente que já pagou (aguarda conferência humana).
  reported_paid_at   timestamptz,
  notes              text check (char_length(notes) <= 1000),
  created_by         uuid references users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint charges_paid_consistency check ((status = 'paga') = (paid_at is not null))
);
create index charges_org_due_idx on charges (organization_id, status, due_date);
create index charges_customer_idx on charges (customer_id, due_date desc);
-- Uma única cobrança ativa por vencimento de assinatura (geração idempotente).
create unique index charges_subscription_due_uq on charges (subscription_id, due_date)
  where subscription_id is not null and status <> 'cancelada';

-- ---------------------------------------------------------------------
-- Automação: modelos de mensagem e regras de lembrete
-- ---------------------------------------------------------------------
create table message_templates (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations (id) on delete cascade,
  kind              template_kind not null,
  name              text not null check (char_length(btrim(name)) between 2 and 80),
  subject           text check (char_length(subject) <= 150),
  body              text not null check (char_length(btrim(body)) between 5 and 1500),
  -- WhatsApp Cloud API: mensagens iniciadas pela empresa exigem modelo aprovado pela Meta.
  wa_template_name  text check (wa_template_name is null or wa_template_name ~ '^[a-z0-9_]{1,512}$'),
  wa_template_lang  text not null default 'pt_BR' check (wa_template_lang ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index message_templates_org_idx on message_templates (organization_id);

create table reminder_rules (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  -- negativo = dias antes do vencimento; 0 = no dia; positivo = dias de atraso
  offset_days      smallint not null check (offset_days between -30 and 60),
  template_id      uuid not null references message_templates (id) on delete restrict,
  send_whatsapp    boolean not null default true,
  send_email       boolean not null default true,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint reminder_rules_channel check (send_whatsapp or send_email)
);
create unique index reminder_rules_offset_uq on reminder_rules (organization_id, offset_days);

-- ---------------------------------------------------------------------
-- Assistente virtual (chatbot) e atendimento
-- ---------------------------------------------------------------------
create table bot_answers (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  title            text not null check (char_length(btrim(title)) between 2 and 80),
  keywords         text[] not null check (cardinality(keywords) between 1 and 20),
  answer           text not null check (char_length(btrim(answer)) between 2 and 1500),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index bot_answers_org_idx on bot_answers (organization_id);

create table conversations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  phone            text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  customer_id      uuid references customers (id) on delete set null,
  status           conversation_status not null default 'bot',
  unread           integer not null default 0 check (unread >= 0),
  last_message_at  timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, phone)
);
create index conversations_org_idx on conversations (organization_id, last_message_at desc);

create table chat_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  conversation_id  uuid not null references conversations (id) on delete cascade,
  direction        text not null check (direction in ('in', 'out')),
  author           text not null check (author in ('cliente', 'bot', 'atendente', 'sistema')),
  body             text not null check (char_length(body) between 1 and 4096),
  user_id          uuid references users (id) on delete set null,
  provider_id      text check (char_length(provider_id) <= 200),
  created_at       timestamptz not null default now()
);
create index chat_messages_conv_idx on chat_messages (conversation_id, created_at);
-- Reentregas do provedor (webhook repetido) não duplicam mensagens.
create unique index chat_messages_provider_uq on chat_messages (organization_id, provider_id) where provider_id is not null;

-- ---------------------------------------------------------------------
-- Caixa de saída (lembretes, confirmações, respostas)
-- ---------------------------------------------------------------------
create table messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  customer_id      uuid references customers (id) on delete set null,
  charge_id        uuid references charges (id) on delete set null,
  rule_id          uuid references reminder_rules (id) on delete set null,
  channel          message_channel not null,
  kind             text not null check (kind in ('lembrete', 'confirmacao', 'manual', 'atendimento')),
  to_address       text not null check (char_length(to_address) <= 254),
  subject          text check (char_length(subject) <= 150),
  body             text not null check (char_length(body) between 1 and 4096),
  wa_template      jsonb,
  status           message_status not null default 'pendente',
  error            text check (char_length(error) <= 300),
  attempts         smallint not null default 0,
  -- Reserva temporária durante o envio (execuções simultâneas não duplicam envios).
  lease_until      timestamptz,
  dedupe_key       text unique,
  provider_id      text check (char_length(provider_id) <= 200),
  created_by       uuid references users (id) on delete set null,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index messages_org_idx on messages (organization_id, created_at desc);
create index messages_pending_idx on messages (status, created_at) where status = 'pendente';
create index messages_charge_idx on messages (charge_id);

-- ---------------------------------------------------------------------
-- Pedidos de acesso pelo site (novas organizações)
-- ---------------------------------------------------------------------
create table access_requests (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(btrim(name)) between 2 and 120),
  business_name  text not null check (char_length(btrim(business_name)) between 2 and 120),
  segment        text not null check (char_length(segment) <= 40),
  email          citext not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone          text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  message        text check (char_length(message) <= 1000),
  status         text not null default 'novo' check (status in ('novo', 'aprovado', 'recusado')),
  organization_id uuid references organizations (id) on delete set null,
  decided_by     uuid references users (id) on delete set null,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index access_requests_status_idx on access_requests (status, created_at desc);

-- ---------------------------------------------------------------------
-- Auditoria (somente inclusão)
-- ---------------------------------------------------------------------
create table audit_events (
  id               bigint generated always as identity primary key,
  actor_id         uuid references users (id) on delete set null,
  organization_id  uuid references organizations (id) on delete set null,
  action           text not null check (char_length(action) <= 80),
  entity_type      text check (char_length(entity_type) <= 40),
  entity_id        text check (char_length(entity_id) <= 80),
  details          jsonb not null default '{}'::jsonb,
  ip               inet,
  created_at       timestamptz not null default now()
);
create index audit_events_org_idx on audit_events (organization_id, created_at desc);
create index audit_events_created_idx on audit_events (created_at desc);
