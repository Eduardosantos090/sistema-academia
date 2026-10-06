-- =====================================================================
-- Preparação do banco no SUPABASE (executar UMA vez no SQL Editor do
-- projeto, ANTES das migrações). Troque as duas senhas por valores fortes
-- e guarde-as somente nas variáveis de ambiente do Netlify.
-- Antes: em Database → Extensions, habilite "citext" (esquema "extensions").
-- =====================================================================
create role venceu_owner login password 'TROQUE_SENHA_OWNER_FORTE';
create role venceu_app login password 'TROQUE_SENHA_APP_FORTE' nosuperuser nobypassrls nocreatedb nocreaterole noinherit;

grant create on database postgres to venceu_owner;
grant usage, create on schema public to venceu_owner;
grant usage on schema public to venceu_app;
grant usage on schema extensions to venceu_owner, venceu_app;
alter role venceu_owner set search_path = public, extensions;
alter role venceu_app set search_path = public, extensions;
