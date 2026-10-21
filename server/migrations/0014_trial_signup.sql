-- Cadastro direto no site ("Criar conta"): a pessoa entra na hora com um
-- período de teste; para continuar, assina dentro do sistema (AbacatePay).
alter table platform_settings
  add column sale_trial_days smallint not null default 7 check (sale_trial_days between 0 and 30);
