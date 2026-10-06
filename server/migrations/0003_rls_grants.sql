-- =====================================================================
-- Row Level Security e privilégios.
-- Regra geral: negar por padrão. O papel venceu_app recebe o mínimo
-- necessário, por tabela e por coluna, e toda linha passa pelas políticas.
-- Cada organização enxerga somente os próprios dados — inclusive a
-- administração da plataforma, que NÃO lê clientes/cobranças das
-- organizações (apenas cadastro e totais agregados pelo servidor).
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array['organizations','org_channels','users','user_credentials','sessions','invites',
                           'password_resets','rate_limit_counters','customers','plans','subscriptions','charges',
                           'message_templates','reminder_rules','bot_answers','conversations','chat_messages',
                           'messages','access_requests','audit_events'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public', t);
  end loop;
end $$;

-- org_channels, user_credentials, sessions, invites, password_resets e
-- rate_limit_counters: sem políticas e sem privilégios para venceu_app =>
-- acessíveis somente pelo servidor privilegiado.

grant usage on schema app to venceu_app;
revoke all on all functions in schema app from public;
grant execute on all functions in schema app to venceu_app;

-- ---------------------------------------------------------------------
-- Organizações
-- ---------------------------------------------------------------------
create policy organizations_read on organizations for select to venceu_app
  using (id = app.org_id() or app.is_platform());
create policy organizations_insert on organizations for insert to venceu_app with check (app.is_platform());
create policy organizations_update on organizations for update to venceu_app
  using ((id = app.org_id() and app.is_owner()) or app.is_platform())
  with check ((id = app.org_id() and app.is_owner()) or app.is_platform());

grant select (id, name, slug, segment, contact_email, contact_phone, document, pix_key, payment_instructions,
              timezone, send_hour, notify_on_payment, bot_enabled, bot_greeting, webhook_id, is_active,
              created_at, updated_at)
  on organizations to venceu_app;
grant insert (name, slug, segment, contact_email, contact_phone, document, timezone) on organizations to venceu_app;
grant update (name, segment, contact_email, contact_phone, document, pix_key, payment_instructions, timezone,
              send_hour, notify_on_payment, bot_enabled, bot_greeting, is_active)
  on organizations to venceu_app;

-- ---------------------------------------------------------------------
-- Usuários: o próprio registro; equipe da mesma organização; plataforma vê todos.
-- Somente o responsável (owner) gerencia a equipe da organização.
-- ---------------------------------------------------------------------
create policy users_read on users for select to venceu_app
  using (id = app.uid() or (organization_id = app.org_id()) or app.is_platform());
create policy users_insert on users for insert to venceu_app
  with check ((app.is_owner() and organization_id = app.org_id()) or app.is_platform());
create policy users_update on users for update to venceu_app
  using ((app.is_owner() and organization_id = app.org_id()) or app.is_platform())
  with check ((app.is_owner() and organization_id = app.org_id()) or app.is_platform());

grant select (id, email, full_name, organization_id, role, is_platform_admin, is_active, created_at, updated_at, last_login_at)
  on users to venceu_app;
grant insert (email, full_name, organization_id, role) on users to venceu_app;
grant update (full_name, role, is_active) on users to venceu_app;

-- ---------------------------------------------------------------------
-- Dados operacionais da organização (toda a equipe)
-- ---------------------------------------------------------------------
create policy customers_read on customers for select to venceu_app using (organization_id = app.org_id());
create policy customers_insert on customers for insert to venceu_app with check (organization_id = app.org_id());
create policy customers_update on customers for update to venceu_app
  using (organization_id = app.org_id()) with check (organization_id = app.org_id());
-- Exclusão definitiva (LGPD): somente o responsável.
create policy customers_delete on customers for delete to venceu_app using (organization_id = app.org_id() and app.is_owner());
grant select, insert, update, delete on customers to venceu_app;

create policy subscriptions_rw on subscriptions for all to venceu_app
  using (organization_id = app.org_id()) with check (organization_id = app.org_id());
grant select, insert, update on subscriptions to venceu_app;

create policy charges_rw on charges for all to venceu_app
  using (organization_id = app.org_id()) with check (organization_id = app.org_id());
grant select, insert, update on charges to venceu_app;

create policy conversations_rw on conversations for all to venceu_app
  using (organization_id = app.org_id()) with check (organization_id = app.org_id());
grant select on conversations to venceu_app;
grant update (status, unread, customer_id, last_message_at) on conversations to venceu_app;

-- Equipe só grava mensagens de atendente em nome de si mesma.
create policy chat_messages_read on chat_messages for select to venceu_app using (organization_id = app.org_id());
create policy chat_messages_insert on chat_messages for insert to venceu_app
  with check (organization_id = app.org_id() and author = 'atendente' and direction = 'out' and user_id = app.uid());
grant select on chat_messages to venceu_app;
grant insert (organization_id, conversation_id, direction, author, body, user_id) on chat_messages to venceu_app;

create policy messages_read on messages for select to venceu_app using (organization_id = app.org_id());
create policy messages_insert on messages for insert to venceu_app
  with check (organization_id = app.org_id() and created_by = app.uid() and kind in ('manual', 'atendimento', 'confirmacao'));
create policy messages_update on messages for update to venceu_app
  using (organization_id = app.org_id()) with check (organization_id = app.org_id());
grant select on messages to venceu_app;
grant insert (organization_id, customer_id, charge_id, channel, kind, to_address, subject, body, wa_template, status, created_by)
  on messages to venceu_app;
grant update (status, error, sent_at) on messages to venceu_app;

-- ---------------------------------------------------------------------
-- Configuração (equipe lê; somente o responsável altera)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['plans', 'message_templates', 'reminder_rules', 'bot_answers'] loop
    execute format('create policy %I on %I for select to venceu_app using (organization_id = app.org_id())', t || '_read', t);
    execute format('create policy %I on %I for insert to venceu_app with check (organization_id = app.org_id() and app.is_owner())', t || '_insert', t);
    execute format('create policy %I on %I for update to venceu_app using (organization_id = app.org_id() and app.is_owner()) with check (organization_id = app.org_id() and app.is_owner())', t || '_update', t);
    execute format('create policy %I on %I for delete to venceu_app using (organization_id = app.org_id() and app.is_owner())', t || '_delete', t);
    execute format('grant select, insert, update, delete on %I to venceu_app', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Plataforma
-- ---------------------------------------------------------------------
create policy access_requests_platform on access_requests for all to venceu_app
  using (app.is_platform()) with check (app.is_platform());
grant select on access_requests to venceu_app;
grant update (status, organization_id, decided_by, decided_at) on access_requests to venceu_app;

create policy audit_read on audit_events for select to venceu_app
  using (app.is_platform() or (app.is_owner() and organization_id = app.org_id()));
grant select on audit_events to venceu_app;

-- ---------------------------------------------------------------------
-- Supabase: a API automática (PostgREST) expõe "public" aos papéis anon e
-- authenticated. Este sistema NÃO usa essa API; removemos qualquer
-- privilégio deles (defesa adicional à RLS). Sem esses papéis, nada é feito.
-- ---------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke all on all functions in schema app from %I', r);
      execute format('revoke all on schema app from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;
