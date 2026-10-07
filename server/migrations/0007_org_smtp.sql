-- E-mail próprio de cada organização: os lembretes saem da conta de e-mail
-- do cliente (Gmail, Outlook, iCloud, provedor próprio) em vez do remetente
-- da plataforma. Senha cifrada (AES-256-GCM) como os demais segredos;
-- org_channels continua sem permissões para o papel da aplicação.
alter table org_channels
  add column smtp_host         text check (smtp_host is null or (smtp_host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and char_length(smtp_host) <= 253)),
  add column smtp_port         integer check (smtp_port is null or smtp_port in (465, 587, 2525)),
  add column smtp_user         citext check (smtp_user is null or (smtp_user ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(smtp_user) <= 254)),
  add column smtp_password_enc text,
  add column smtp_from_name    text check (smtp_from_name is null or char_length(smtp_from_name) between 1 and 80),
  add constraint org_channels_smtp_complete check (
    (smtp_host is null and smtp_port is null and smtp_user is null and smtp_password_enc is null)
    or (smtp_host is not null and smtp_port is not null and smtp_user is not null and smtp_password_enc is not null)
  );
