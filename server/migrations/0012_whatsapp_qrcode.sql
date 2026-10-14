-- WhatsApp por QR Code (Evolution API): o servidor Evolution é configurado
-- uma vez pela plataforma; cada organização conecta o próprio número lendo um
-- QR Code. Chaves e segredos cifrados, somente servidor privilegiado.
alter type whatsapp_mode add value if not exists 'qrcode';

alter table platform_settings
  add column evolution_url     text check (evolution_url is null or (evolution_url ~ '^https://[^\s/?#]+(/[^\s?#]*)?$' and char_length(evolution_url) <= 300)),
  add column evolution_key_enc text;

alter table org_channels
  add column evo_instance           text unique check (evo_instance is null or evo_instance ~ '^[a-z0-9-]{3,64}$'),
  add column evo_token_enc          text,
  add column evo_webhook_secret_enc text,
  add column evo_status             text check (evo_status is null or evo_status in ('open', 'connecting', 'close')),
  add column evo_number             text check (evo_number is null or evo_number ~ '^\+[1-9][0-9]{7,14}$');
