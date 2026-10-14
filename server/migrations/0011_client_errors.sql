-- Erros de tela registrados pelo navegador (diagnóstico de "tela preta").
-- Somente o servidor privilegiado lê; guardados por 30 dias.
create table client_errors (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  user_id     uuid references users (id) on delete set null,
  path        text check (char_length(path) <= 300),
  message     text not null check (char_length(message) <= 500),
  stack       text check (char_length(stack) <= 4000),
  user_agent  text check (char_length(user_agent) <= 300),
  release     text check (char_length(release) <= 60)
);
create index client_errors_created on client_errors (created_at desc);
alter table client_errors enable row level security;
revoke all on client_errors from public;
