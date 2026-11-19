-- Lucro Presumido e Real (20261201090000_agente_fiscal_presumido.sql): o regime entra pelo cadastro e pela empresa do
-- escritório, os percentuais de pTotTrib substituem o do Simples, o bloqueio da emissão e a situação do painel usam a
-- mesma regra, e o Simples e o MEI continuam como antes. Tudo roda numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('ac500000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'presumido-e@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('ac600000-0000-4000-8000-000000000001', 'Presumido E', 'presumido-teste-e');
insert into public.memberships (user_id, client_id, role) values
  ('ac500000-0000-4000-8000-000000000001', 'ac600000-0000-4000-8000-000000000001', 'CLIENT');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa
) values
  ('ac700000-0000-4000-8000-000000000001', '81444777000162', 'Escritório Presumido', '3205309', repeat('1', 64), 'escritorio_5', 500,
   'ac600000-0000-4000-8000-000000000001', '170201', 6, 'concluido');
insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values
  ('ac500000-0000-4000-8000-000000000001', 'presumido-e@example.test', '+5511900000401', now(), 'ac600000-0000-4000-8000-000000000001');
insert into nofiscal.fiscal_subscriptions
  (id, tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
values
  ('ac800000-0000-4000-8000-000000000001', 'ac700000-0000-4000-8000-000000000001', 'escritorio_5', false,
   'sub_presumido_e', 'paga', now(), 'aceite');

-- Esquema.
select has_column('nofiscal', 'fiscal_tenants', 'p_tot_trib_fed', 'p_tot_trib_fed existe');
select has_column('nofiscal', 'fiscal_tenants', 'p_tot_trib_est', 'p_tot_trib_est existe');
select has_column('nofiscal', 'fiscal_tenants', 'p_tot_trib_mun', 'p_tot_trib_mun existe');
select throws_ok(
  $$update nofiscal.fiscal_tenants set regime = 'arbitrado' where id = 'ac700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'regime fora da lista é recusado');
select throws_ok(
  $$update nofiscal.fiscal_tenants set p_tot_trib_fed = 10 where id = 'ac700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'Simples não guarda pTotTrib');

-- Empresa Presumido entra pelo escritório (Rio de Janeiro).
select is(public.fiscal_empresa_adicionar('ac500000-0000-4000-8000-000000000001', '83444777000161', 'Cliente Presumido Ltda',
  '3304557', null, 'presumido', repeat('3', 64), 'producao_restrita') ->> 'ok', 'true', 'empresa_adicionar aceita presumido');
select is(public.fiscal_empresa_adicionar('ac500000-0000-4000-8000-000000000001', '84444777000161', 'Cliente Real SA',
  '4314902', null, 'real', repeat('4', 64), 'producao_restrita') ->> 'ok', 'true', 'empresa_adicionar aceita real');
select throws_ok(
  $$select public.fiscal_empresa_adicionar('ac500000-0000-4000-8000-000000000001', '85444777000161', 'X', '3304557', null,
    'arbitrado', repeat('5', 64), 'producao_restrita')$$,
  '22023', null, 'regime desconhecido continua barrado');

create temp table ids as
  select cnpj, id from nofiscal.fiscal_tenants where cnpj in ('83444777000161', '84444777000161');

select is(nofiscal.emission_block((select id from ids where cnpj = '83444777000161')), 'FISCAL_CONFIG_MISSING',
  'Presumido sem percentuais não emite');

-- Configurar com o percentual do Simples não serve.
select is(public.fiscal_empresa_configurar('ac500000-0000-4000-8000-000000000001', (select id from ids where cnpj = '83444777000161'),
  '{"codigo_servico_nacional":"170101","p_tot_trib_sn":"6"}') ->> 'campo', 'p_tot_trib', 'Presumido pede pTotTrib, não pTotTribSN');
select is(public.fiscal_empresa_configurar('ac500000-0000-4000-8000-000000000001', (select id from ids where cnpj = '83444777000161'),
  '{"codigo_servico_nacional":"170101","p_tot_trib":{"fed":"13.45","mun":"101"}}') ->> 'campo', 'p_tot_trib', 'percentual acima de 100 é recusado');
select is(public.fiscal_empresa_configurar('ac500000-0000-4000-8000-000000000001', (select id from ids where cnpj = '83444777000161'),
  '{"codigo_servico_nacional":"170101","p_tot_trib":{"fed":"13.45","mun":"5"}}') ->> 'ok', 'true', 'grava fed e mun; est vira 0');
select is((select array[p_tot_trib_fed, p_tot_trib_est, p_tot_trib_mun]::text from nofiscal.fiscal_tenants
            where cnpj = '83444777000161'), '{13.45,0.00,5.00}', 'três percentuais gravados');
select ok((select p_tot_trib_sn is null from nofiscal.fiscal_tenants where cnpj = '83444777000161'), 'sem percentual do Simples');
select isnt(nofiscal.emission_block((select id from ids where cnpj = '83444777000161')), 'FISCAL_CONFIG_MISSING',
  'configurado, o bloqueio passa da configuração fiscal');

select is((select e -> 'p_tot_trib' ->> 'fed'
             from jsonb_array_elements(public.fiscal_escritorio_estado('ac500000-0000-4000-8000-000000000001') -> 'empresas') e
            where e ->> 'cnpj' = '83444777000161'), '13.45', 'estado do escritório devolve pTotTrib');
select is((select e ->> 'situacao'
             from jsonb_array_elements(public.fiscal_escritorio_estado('ac500000-0000-4000-8000-000000000001') -> 'empresas') e
            where e ->> 'cnpj' = '84444777000161'), 'falta_certificado', 'Real sem certificado: a situação segue a ordem de antes');

-- Simples e MEI como antes.
select is(public.fiscal_configurar('ac500000-0000-4000-8000-000000000001',
  '{"codigo_servico_nacional":"170201","p_tot_trib_sn":"6"}') ->> 'ok', 'true', 'Simples continua com pTotTribSN');
select ok(nofiscal.dados_fiscais_completos('mei', '170201', null, null, null), 'MEI só precisa do código');
select ok(not nofiscal.dados_fiscais_completos('simples', '170201', null, null, null), 'Simples sem percentual: incompleto');
select ok(not nofiscal.dados_fiscais_completos('presumido', '170201', 6, null, null), 'Presumido com percentual do Simples: incompleto');
select ok(nofiscal.dados_fiscais_completos('real', '170201', null, 10, 5), 'Real com fed e mun: completo');
select is(nofiscal.ler_tributos_aproximados('{"fed":13.45,"est":"","mun":"5"}'), '{"fed": 13.45, "est": 0, "mun": 5}'::jsonb,
  'número ou texto; est vazio é 0');

-- Cidades do Presumido: ponto de partida e aprendizado com a Sefin.
select is(public.fiscal_municipio_presumido('3304557'), 'aceita', 'Rio aceita (norma)');
select is(public.fiscal_municipio_presumido('3550308'), 'recusada', 'São Paulo recusada (norma)');
select ok(public.fiscal_municipio_presumido('4106902') is null, 'Curitiba a conferir');
select is(nofiscal.registrar_municipio_presumido('3550308', 'recusada', 'recusa_sefin', 'E0039'), 'recusada', 'recusa não troca a norma');
select is((select origem from nofiscal.fiscal_municipios_presumido where codigo_ibge = '3550308'), 'norma', 'origem continua norma');
select is(nofiscal.registrar_municipio_presumido('4106902', 'recusada', 'recusa_sefin', 'E0039: teste'), 'recusada', 'cidade a conferir vira recusada');
select is(nofiscal.registrar_municipio_presumido('4106902', 'aceita', 'nota_autorizada', 'nota'), 'aceita', 'nota autorizada depois vale mais');
select throws_ok($$select nofiscal.registrar_municipio_presumido('4106902', 'aceita', 'norma', 'x')$$, '22023', null,
  'o automático não grava origem norma');

-- Empresa Presumido numa cidade recusada: bloqueio e situação no painel.
update nofiscal.fiscal_tenants set codigo_municipio_ibge = '5300108' where cnpj = '83444777000161';
select is(nofiscal.emission_block((select id from ids where cnpj = '83444777000161')), 'MUNICIPIO_SEM_PRESUMIDO',
  'Presumido em cidade recusada não emite');
update nofiscal.fiscal_tenants set codigo_municipio_ibge = '3304557' where cnpj = '83444777000161';

select * from finish();
rollback;
