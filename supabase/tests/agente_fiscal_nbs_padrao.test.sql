-- NBS padrão por empresa (20261118120000_agente_fiscal_nbs_padrao.sql): a coluna aceita só 9 dígitos, o
-- configurar da conta e o da empresa do escritório gravam, mantêm (chave ausente) e apagam (null ou ''), e os
-- dois estados devolvem o campo. Tudo roda numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('ab500000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'nbs-e@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('ab600000-0000-4000-8000-000000000001', 'NBS E', 'nbs-teste-e');
insert into public.memberships (user_id, client_id, role) values
  ('ab500000-0000-4000-8000-000000000001', 'ab600000-0000-4000-8000-000000000001', 'CLIENT');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa
) values
  ('ab700000-0000-4000-8000-000000000001', '81444777000161', 'NBS E', '3507605', repeat('1', 64), 'escritorio_5', 500,
   'ab600000-0000-4000-8000-000000000001', '170201', 6, 'concluido');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, escritorio_tenant_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa
) values
  ('ab700000-0000-4000-8000-000000000002', '82444777000161', 'NBS Cliente', '3550308', repeat('2', 64), 'escritorio_5', 500,
   'ab700000-0000-4000-8000-000000000001', '010701', 6, 'concluido');
insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values
  ('ab500000-0000-4000-8000-000000000001', 'nbs-e@example.test', '+5511900000301', now(), 'ab600000-0000-4000-8000-000000000001');
insert into nofiscal.fiscal_subscriptions
  (id, tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
values
  ('ab800000-0000-4000-8000-000000000001', 'ab700000-0000-4000-8000-000000000001', 'escritorio_5', false,
   'sub_nbs_e', 'paga', now(), 'aceite');

-- Coluna.
select has_column('nofiscal', 'fiscal_tenants', 'nbs_padrao', 'fiscal_tenants.nbs_padrao existe');
select throws_ok(
  $$update nofiscal.fiscal_tenants set nbs_padrao = '1.1502.10.00' where id = 'ab700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'coluna só aceita 9 dígitos');

-- Conta (Meus dados).
select is(public.fiscal_configurar('ab500000-0000-4000-8000-000000000001',
  '{"codigo_servico_nacional":"170201","p_tot_trib_sn":"6","nbs_padrao":"115021000"}') ->> 'ok', 'true', 'configurar grava a NBS');
select is((select nbs_padrao from nofiscal.fiscal_tenants where id = 'ab700000-0000-4000-8000-000000000001'),
  '115021000', 'NBS gravada');
select is(public.fiscal_conta_estado('ab500000-0000-4000-8000-000000000001') -> 'fiscal' ->> 'nbs_padrao',
  '115021000', 'estado da conta devolve a NBS');
select is(public.fiscal_configurar('ab500000-0000-4000-8000-000000000001',
  '{"codigo_servico_nacional":"170201","p_tot_trib_sn":"6"}') ->> 'ok', 'true', 'configurar sem a chave');
select is((select nbs_padrao from nofiscal.fiscal_tenants where id = 'ab700000-0000-4000-8000-000000000001'),
  '115021000', 'chave ausente mantém a NBS');
select is(public.fiscal_configurar('ab500000-0000-4000-8000-000000000001',
  '{"codigo_servico_nacional":"170201","p_tot_trib_sn":"6","nbs_padrao":"12345"}') ->> 'campo', 'nbs_padrao',
  'NBS fora do formato é recusada');
select is(public.fiscal_configurar('ab500000-0000-4000-8000-000000000001',
  '{"codigo_servico_nacional":"170201","p_tot_trib_sn":"6","nbs_padrao":""}') ->> 'ok', 'true', 'NBS vazia apaga');
select ok((select nbs_padrao from nofiscal.fiscal_tenants where id = 'ab700000-0000-4000-8000-000000000001') is null,
  'NBS apagada');

-- Empresa do escritório (Minhas empresas).
select is(public.fiscal_empresa_configurar('ab500000-0000-4000-8000-000000000001', 'ab700000-0000-4000-8000-000000000002',
  '{"codigo_servico_nacional":"010701","p_tot_trib_sn":"6","nbs_padrao":"115021000"}') ->> 'ok', 'true',
  'empresa_configurar grava a NBS');
select is((select e ->> 'nbs_padrao'
             from jsonb_array_elements(public.fiscal_escritorio_estado('ab500000-0000-4000-8000-000000000001') -> 'empresas') e
            where e ->> 'tenant_id' = 'ab700000-0000-4000-8000-000000000002'),
  '115021000', 'estado do escritório devolve a NBS da empresa');
select is(public.fiscal_empresa_configurar('ab500000-0000-4000-8000-000000000001', 'ab700000-0000-4000-8000-000000000002',
  '{"codigo_servico_nacional":"010701","p_tot_trib_sn":"6","nbs_padrao":null}') ->> 'ok', 'true', 'NBS null apaga');
select ok((select nbs_padrao from nofiscal.fiscal_tenants where id = 'ab700000-0000-4000-8000-000000000002') is null,
  'NBS da empresa apagada');

select * from finish();
rollback;
