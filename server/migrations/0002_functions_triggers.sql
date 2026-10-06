-- =====================================================================
-- Funções de autorização, gatilhos de integridade e dados padrão.
--
-- O servidor abre cada transação de usuário com:
--   select set_config('app.user_id', '<uuid do usuário autenticado>', true)
-- usando o papel "venceu_app" (sem BYPASSRLS). Perfil e organização são
-- derivados EXCLUSIVAMENTE do banco, a partir desse identificador — nunca
-- de dados enviados pelo navegador.
--
-- Códigos de erro próprios (SQLSTATE):
--   VC403 = operação não permitida
--   VC409 = conflito de estado
--   VC422 = dados inválidos / relacionamento incoerente
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'venceu_app') then
    raise exception 'O papel venceu_app precisa existir antes das migrações (ver docs/INSTALACAO.md).';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Identidade e escopo do usuário corrente
-- ---------------------------------------------------------------------
create or replace function app.uid() returns uuid
language sql stable set search_path = public, pg_temp as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- Organização do usuário corrente, somente se usuário e organização estiverem ativos.
create or replace function app.org_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select u.organization_id
    from users u
    join organizations o on o.id = u.organization_id
   where u.id = app.uid() and u.is_active and o.is_active
$$;

create or replace function app.org_role() returns org_role
language sql stable security definer set search_path = public, pg_temp as $$
  select u.role
    from users u
    join organizations o on o.id = u.organization_id
   where u.id = app.uid() and u.is_active and o.is_active
$$;

create or replace function app.is_owner() returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce(app.org_role() = 'owner', false)
$$;

create or replace function app.is_platform() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select u.is_platform_admin and u.is_active from users u where u.id = app.uid()), false)
$$;

-- Registro de auditoria dentro da mesma transação da operação.
create or replace function app.audit(
  p_action text, p_entity_type text, p_entity_id text,
  p_org uuid default null, p_details jsonb default '{}'::jsonb, p_ip inet default null
) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into audit_events (actor_id, organization_id, action, entity_type, entity_id, details, ip)
  values (app.uid(), p_org, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb), p_ip)
$$;

-- Data "de hoje" no fuso da organização.
create or replace function app.org_today(p_org uuid) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select (now() at time zone coalesce((select timezone from organizations where id = p_org), 'America/Sao_Paulo'))::date
$$;

-- Avança N meses preservando o dia de cobrança (31 → último dia do mês).
create or replace function app.add_months_keep_day(p_date date, p_months int, p_day int) returns date
language sql immutable set search_path = public, pg_temp as $$
  select least(
    (date_trunc('month', p_date) + make_interval(months => p_months))::date + (p_day - 1),
    (date_trunc('month', p_date) + make_interval(months => p_months + 1))::date - 1
  )
$$;

-- ---------------------------------------------------------------------
-- Gatilhos genéricos
-- ---------------------------------------------------------------------
create or replace function app.tg_touch() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.tg_append_only() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'Registro somente de inclusão.' using errcode = 'VC403';
end $$;

do $$
declare t text;
begin
  foreach t in array array['organizations','org_channels','users','customers','plans','subscriptions','charges',
                           'message_templates','reminder_rules','bot_answers','conversations'] loop
    execute format('create trigger %I before update on %I for each row execute function app.tg_touch()', t || '_touch', t);
  end loop;
end $$;

create trigger audit_events_append_only before update or delete on audit_events
  for each row execute function app.tg_append_only();

-- ---------------------------------------------------------------------
-- Organizações: dono da organização não altera endereço, situação nem webhook.
-- (Contexto sem usuário = servidor privilegiado: rotinas internas.)
-- ---------------------------------------------------------------------
create or replace function app.tg_org_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if app.uid() is null or app.is_platform() then return new; end if;
  if new.slug is distinct from old.slug or new.is_active is distinct from old.is_active
     or new.webhook_id is distinct from old.webhook_id then
    raise exception 'Somente a administração da plataforma altera estes dados.' using errcode = 'VC403';
  end if;
  return new;
end $$;
create trigger organizations_guard before update on organizations for each row execute function app.tg_org_guard();

-- ---------------------------------------------------------------------
-- Usuários: sem escalada de privilégio e sem auto-bloqueio.
-- ---------------------------------------------------------------------
create or replace function app.tg_users_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if app.uid() is null or app.is_platform() then return new; end if;
  if tg_op = 'INSERT' then
    if new.is_platform_admin or new.organization_id is distinct from app.org_id() then
      raise exception 'Operação não permitida.' using errcode = 'VC403';
    end if;
    return new;
  end if;
  if new.is_platform_admin is distinct from old.is_platform_admin
     or new.organization_id is distinct from old.organization_id
     or new.email is distinct from old.email then
    raise exception 'Operação não permitida.' using errcode = 'VC403';
  end if;
  if old.id = app.uid() and (new.role is distinct from old.role or not new.is_active) then
    raise exception 'Você não pode alterar o próprio perfil nem desativar o próprio acesso.' using errcode = 'VC409';
  end if;
  return new;
end $$;
create trigger users_guard before insert or update on users for each row execute function app.tg_users_guard();

-- A organização precisa manter ao menos um responsável (owner) ativo.
create or replace function app.tg_users_keep_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.role = 'owner' and old.is_active and (new.role <> 'owner' or not new.is_active) then
    if not exists (select 1 from users u where u.organization_id = old.organization_id
                    and u.role = 'owner' and u.is_active and u.id <> old.id) then
      raise exception 'A organização precisa de ao menos um responsável ativo.' using errcode = 'VC409';
    end if;
  end if;
  return new;
end $$;
create trigger users_keep_owner after update on users for each row execute function app.tg_users_keep_owner();

-- ---------------------------------------------------------------------
-- Coerência entre organizações: todo vínculo aponta para a MESMA organização.
-- ---------------------------------------------------------------------
create or replace function app.tg_same_org() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  rec jsonb := to_jsonb(new);
  org uuid := new.organization_id;
begin
  if rec ? 'customer_id' and rec->>'customer_id' is not null
     and not exists (select 1 from customers where id = (rec->>'customer_id')::uuid and organization_id = org) then
    raise exception 'Cliente não pertence a esta organização.' using errcode = 'VC422';
  end if;
  if rec ? 'plan_id' and rec->>'plan_id' is not null
     and not exists (select 1 from plans where id = (rec->>'plan_id')::uuid and organization_id = org) then
    raise exception 'Plano não pertence a esta organização.' using errcode = 'VC422';
  end if;
  if rec ? 'subscription_id' and rec->>'subscription_id' is not null
     and not exists (select 1 from subscriptions where id = (rec->>'subscription_id')::uuid and organization_id = org) then
    raise exception 'Assinatura não pertence a esta organização.' using errcode = 'VC422';
  end if;
  if rec ? 'template_id' and rec->>'template_id' is not null
     and not exists (select 1 from message_templates where id = (rec->>'template_id')::uuid and organization_id = org) then
    raise exception 'Modelo não pertence a esta organização.' using errcode = 'VC422';
  end if;
  if rec ? 'charge_id' and rec->>'charge_id' is not null
     and not exists (select 1 from charges where id = (rec->>'charge_id')::uuid and organization_id = org) then
    raise exception 'Cobrança não pertence a esta organização.' using errcode = 'VC422';
  end if;
  if rec ? 'conversation_id' and rec->>'conversation_id' is not null
     and not exists (select 1 from conversations where id = (rec->>'conversation_id')::uuid and organization_id = org) then
    raise exception 'Conversa não pertence a esta organização.' using errcode = 'VC422';
  end if;
  if tg_op = 'UPDATE' and new.organization_id is distinct from old.organization_id then
    raise exception 'Não é possível mudar a organização do registro.' using errcode = 'VC403';
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['customers','plans','subscriptions','charges','message_templates','reminder_rules',
                           'bot_answers','conversations','chat_messages','messages'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function app.tg_same_org()',
                   t || '_same_org', t);
  end loop;
end $$;

-- Cobrança: estado coerente e histórico de pagamento preservado.
create or replace function app.tg_charges_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' then
    if old.status = 'cancelada' and new.status <> 'cancelada' then
      raise exception 'Cobrança cancelada não pode ser reaberta. Crie uma nova cobrança.' using errcode = 'VC409';
    end if;
    if old.status = 'paga' and new.status = 'paga' and (new.amount_cents <> old.amount_cents or new.due_date <> old.due_date) then
      raise exception 'Cobrança paga não pode ter valor ou vencimento alterados. Estorne o pagamento antes.' using errcode = 'VC409';
    end if;
    if new.customer_id <> old.customer_id then
      raise exception 'Não é possível trocar o cliente da cobrança.' using errcode = 'VC409';
    end if;
  end if;
  if new.status <> 'paga' then
    new.paid_at := null;
    new.paid_amount_cents := null;
    new.payment_method := null;
  end if;
  return new;
end $$;
create trigger charges_guard before insert or update on charges for each row execute function app.tg_charges_guard();

-- Mensagens do chat: imutáveis depois de gravadas.
create trigger chat_messages_append_only before update on chat_messages
  for each row execute function app.tg_append_only();

-- ---------------------------------------------------------------------
-- Dados padrão de uma nova organização: modelos, regras e assistente.
-- ---------------------------------------------------------------------
create or replace function app.seed_org_defaults(p_org uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t_lembrete uuid;
  t_venc uuid;
  t_atraso uuid;
begin
  if app.uid() is not null and not app.is_platform() then
    raise exception 'Operação não permitida.' using errcode = 'VC403';
  end if;
  if exists (select 1 from message_templates where organization_id = p_org) then
    return;
  end if;

  insert into org_channels (organization_id) values (p_org) on conflict do nothing;

  insert into message_templates (organization_id, kind, name, subject, body) values
    (p_org, 'lembrete', 'Lembrete antes do vencimento', 'Lembrete: {{descricao}} vence em {{vencimento}}',
     E'Olá, {{primeiro_nome}}! 👋\nPassando para lembrar que {{descricao}} no valor de {{valor}} vence em {{vencimento}}.\n\n{{instrucoes_pagamento}}\n\nQualquer dúvida, é só responder esta mensagem.\n— {{empresa}}')
    returning id into t_lembrete;
  insert into message_templates (organization_id, kind, name, subject, body) values
    (p_org, 'vencimento', 'Aviso no dia do vencimento', 'Hoje vence: {{descricao}}',
     E'Oi, {{primeiro_nome}}! Hoje ({{vencimento}}) é o vencimento de {{descricao}} — {{valor}}.\n\n{{instrucoes_pagamento}}\n\nSe você já pagou, pode desconsiderar. Obrigado!\n— {{empresa}}')
    returning id into t_venc;
  insert into message_templates (organization_id, kind, name, subject, body) values
    (p_org, 'atraso', 'Aviso de atraso', 'Pagamento pendente: {{descricao}}',
     E'Olá, {{primeiro_nome}}. {{descricao}} ({{valor}}), com vencimento em {{vencimento}}, está em aberto há {{dias_atraso}} dia(s).\n\n{{instrucoes_pagamento}}\n\nSe já realizou o pagamento, responda 3 que nossa equipe confere.\n— {{empresa}}')
    returning id into t_atraso;
  insert into message_templates (organization_id, kind, name, subject, body) values
    (p_org, 'pagamento_confirmado', 'Confirmação de pagamento', 'Pagamento confirmado: {{descricao}}',
     E'Pagamento confirmado! ✅\nRecebemos {{valor_pago}} referente a {{descricao}}. Obrigado, {{primeiro_nome}}!\n— {{empresa}}');

  insert into reminder_rules (organization_id, offset_days, template_id, send_whatsapp, send_email) values
    (p_org, -3, t_lembrete, true, true),
    (p_org, 0, t_venc, true, false),
    (p_org, 3, t_atraso, true, true),
    (p_org, 10, t_atraso, true, true);

  insert into bot_answers (organization_id, title, keywords, answer, is_active) values
    (p_org, 'Horário de atendimento', array['horario', 'funcionamento', 'abre', 'fecha'],
     'Nosso horário de atendimento é de segunda a sexta, das 8h às 18h. (Edite esta resposta em Automação → Assistente.)', false);
end $$;
