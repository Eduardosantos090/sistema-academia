-- Executar UMA vez por ambiente, como superusuário do PostgreSQL, ANTES das
-- migrações. Troque as senhas por valores fortes (gerenciador de segredos).
--
--   psql "<url de administrador>" -v owner_pw="'...'" -v app_pw="'...'" -f create-roles.sql

-- Proprietário do esquema: migrações, autenticação, automações e scripts.
create role venceu_owner login password :owner_pw;
-- Papel da aplicação: sujeito à RLS. Não pode ser superusuário nem ter BYPASSRLS.
create role venceu_app login password :app_pw nosuperuser nobypassrls nocreatedb nocreaterole noinherit;

-- create database venceu_prod owner venceu_owner;
-- revoke all on database venceu_prod from public;
-- grant connect on database venceu_prod to venceu_app;
