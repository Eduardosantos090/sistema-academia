-- Tempo de resposta do assistente: espera (com "digitando…" no WhatsApp por QR
-- Code) antes de cada resposta automática, para a conversa não parecer robô/spam.
alter table organizations
  add column bot_reply_delay_seconds smallint not null default 3 check (bot_reply_delay_seconds between 0 and 8);
grant select (bot_reply_delay_seconds) on organizations to venceu_app;
grant update (bot_reply_delay_seconds) on organizations to venceu_app;
