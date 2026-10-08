-- Link de checkout fixo criado no painel da AbacatePay: o botão "Assinar" da
-- página de vendas pode abrir esse link diretamente (sem a chave da API).
-- Com a chave configurada, quem paga por ele também tem a conta criada
-- automaticamente (dados do cliente consultados na API).
alter table platform_settings
  add column sale_checkout_url text check (sale_checkout_url is null or sale_checkout_url ~ '^https://app\.abacatepay\.com/pay/[A-Za-z0-9_-]{1,200}$');
alter table platform_settings add column sale_link_checked_at timestamptz;
update platform_settings set sale_checkout_url = 'https://app.abacatepay.com/pay/bill_Eq2EpR0tp63jEq02XDwUYNMH' where id = 1;

alter table signups add column source text not null default 'site' check (source in ('site', 'link'));
