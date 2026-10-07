-- =====================================================================
-- 0005 — Anexos (imagem, áudio, PDF), intervalo entre disparos e
-- planos/acesso das organizações (administração da plataforma).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Arquivos de mídia (respostas do assistente, modelos e atendimento).
-- Guardados no próprio banco (até 4 MB). Servidos publicamente SOMENTE
-- por um endereço com identificador aleatório (o WhatsApp precisa baixar
-- o arquivo pelo link). Tipo detectado pelo conteúdo, não pelo nome.
-- ---------------------------------------------------------------------
create table media_files (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id) on delete cascade,
  token            text not null unique default app.random_hex(),
  name             text not null check (char_length(btrim(name)) between 1 and 120),
  mime             text not null check (mime in ('image/jpeg', 'image/png', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'application/pdf')),
  size_bytes       integer not null check (size_bytes between 1 and 4194304),
  data             bytea not null,
  created_by       uuid references users (id) on delete set null,
  created_at       timestamptz not null default now()
);
create index media_files_org_idx on media_files (organization_id, created_at desc);

alter table bot_answers add column media_id uuid references media_files (id) on delete set null;
alter table message_templates add column media_id uuid references media_files (id) on delete set null;
alter table messages add column media_id uuid references media_files (id) on delete set null;
alter table chat_messages add column media_id uuid references media_files (id) on delete set null;

-- Anexo precisa ser da mesma organização do registro.
create or replace function app.tg_media_same_org() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.media_id is not null
     and not exists (select 1 from media_files where id = new.media_id and organization_id = new.organization_id) then
    raise exception 'Arquivo não pertence a esta organização.' using errcode = 'VC422';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['bot_answers', 'message_templates', 'messages', 'chat_messages'] loop
    execute format('create trigger %I before insert or update of media_id on %I for each row execute function app.tg_media_same_org()',
                   t || '_media_same_org', t);
  end loop;
end $$;

alter table media_files enable row level security;
revoke all on media_files from public;
create policy media_read on media_files for select to venceu_app using (organization_id = app.org_id());
create policy media_insert on media_files for insert to venceu_app
  with check (organization_id = app.org_id() and created_by = app.uid());
create policy media_delete on media_files for delete to venceu_app using (organization_id = app.org_id() and app.is_owner());
grant select (id, organization_id, token, name, mime, size_bytes, created_at) on media_files to venceu_app;
grant insert (organization_id, name, mime, size_bytes, data, created_by) on media_files to venceu_app;
grant delete on media_files to venceu_app;

grant insert (media_id) on chat_messages to venceu_app;
grant insert (media_id) on messages to venceu_app;

-- ---------------------------------------------------------------------
-- Intervalo entre disparos (evita bloqueio por envio em rajada).
-- ---------------------------------------------------------------------
alter table organizations
  add column send_delay_seconds integer not null default 0 check (send_delay_seconds between 0 and 3600),
  add column last_dispatch_at timestamptz;

grant select (send_delay_seconds) on organizations to venceu_app;
grant update (send_delay_seconds) on organizations to venceu_app;

-- ---------------------------------------------------------------------
-- Plano e acesso das organizações (somente a administração da plataforma).
--  • access_until: acesso liberado até esta data (nulo = sem vencimento).
--  • auto_suspend: suspende sozinho após access_until + grace_days.
--  • billing_customer_id: cliente correspondente na organização de cobrança
--    da plataforma; ao registrar o pagamento dele, o acesso é renovado
--    automaticamente.
-- ---------------------------------------------------------------------
alter table organizations
  add column plan_name            text check (char_length(plan_name) <= 80),
  add column plan_amount_cents    integer check (plan_amount_cents is null or plan_amount_cents between 0 and 100000000),
  add column plan_interval_months smallint not null default 1 check (plan_interval_months in (1, 2, 3, 6, 12)),
  add column access_until         date,
  add column auto_suspend         boolean not null default false,
  add column grace_days           smallint not null default 3 check (grace_days between 0 and 60),
  add column suspended_reason     text check (suspended_reason in ('manual', 'inadimplencia')),
  add column billing_customer_id  uuid references customers (id) on delete set null,
  add column is_billing_org       boolean not null default false;
create unique index organizations_billing_org_uq on organizations (is_billing_org) where is_billing_org;

grant select (plan_name, access_until, auto_suspend, grace_days, suspended_reason) on organizations to venceu_app;
-- Motivo da suspensão: a plataforma registra ao suspender/reativar (gatilho impede os demais).
grant update (suspended_reason) on organizations to venceu_app;

-- Dados de plano/acesso só mudam pela plataforma ou por rotinas do servidor
-- (funções privilegiadas executam como o proprietário).
create or replace function app.tg_org_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if app.uid() is null or app.is_platform() or current_user <> 'venceu_app' then return new; end if;
  if new.slug is distinct from old.slug or new.is_active is distinct from old.is_active
     or new.webhook_id is distinct from old.webhook_id or new.suspended_reason is distinct from old.suspended_reason
     or new.plan_name is distinct from old.plan_name or new.plan_amount_cents is distinct from old.plan_amount_cents
     or new.access_until is distinct from old.access_until or new.auto_suspend is distinct from old.auto_suspend
     or new.billing_customer_id is distinct from old.billing_customer_id or new.is_billing_org is distinct from old.is_billing_org then
    raise exception 'Somente a administração da plataforma altera estes dados.' using errcode = 'VC403';
  end if;
  return new;
end $$;

-- Pagamento registrado na organização de cobrança renova o acesso da
-- organização cliente correspondente (e reativa se estava suspensa por atraso).
create or replace function app.tg_platform_payment() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o record;
  months int;
begin
  if new.status <> 'paga' or old.status = 'paga' then return new; end if;
  for o in select id, plan_interval_months, access_until from organizations where billing_customer_id = new.customer_id loop
    select coalesce((select interval_months from subscriptions where id = new.subscription_id), o.plan_interval_months, 1) into months;
    update organizations
       set access_until = greatest(coalesce(o.access_until, new.due_date), (new.due_date + make_interval(months => months))::date),
           is_active = case when suspended_reason = 'inadimplencia' then true else is_active end,
           suspended_reason = case when suspended_reason = 'inadimplencia' then null else suspended_reason end
     where id = o.id;
    insert into audit_events (actor_id, organization_id, action, entity_type, entity_id, details)
    values (app.uid(), o.id, 'platform.access_renewed', 'organization', o.id::text,
            jsonb_build_object('charge', new.id, 'months', months));
  end loop;
  return new;
end $$;
create trigger charges_platform_payment after update of status on charges
  for each row execute function app.tg_platform_payment();

revoke all on all functions in schema app from public;
grant execute on all functions in schema app to venceu_app;
