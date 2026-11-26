-- Módulo Guias (20261119180000_agente_fiscal_guias.sql): um escritório não lê guias/contatos de outro; conta sem o
-- módulo é recusada pelas funções do módulo; a função de ligar não roda com papel comum; cor da conferência e
-- disparo só de guia verde. Tudo numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant nofiscal_service to postgres;
grant usage on schema extensions to nofiscal_service, service_role, authenticated;

-- A e B: escritórios com o módulo. C: escritório sem o módulo. P: conta Pro.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('f9000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'gui-a@example.test', '{}', '{}', now(), now()),
  ('f9000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'gui-b@example.test', '{}', '{}', now(), now()),
  ('f9000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'gui-c@example.test', '{}', '{}', now(), now()),
  ('f9000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'gui-p@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('fa000000-0000-4000-8000-000000000001', 'GUI A', 'gui-teste-a'),
  ('fa000000-0000-4000-8000-000000000002', 'GUI B', 'gui-teste-b'),
  ('fa000000-0000-4000-8000-000000000003', 'GUI C', 'gui-teste-c'),
  ('fa000000-0000-4000-8000-000000000004', 'GUI P', 'gui-teste-p');
insert into public.memberships (user_id, client_id, role) values
  ('f9000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', 'CLIENT'),
  ('f9000000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000002', 'CLIENT'),
  ('f9000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000003', 'CLIENT'),
  ('f9000000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000004', 'CLIENT');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa
) values
  ('fb000000-0000-4000-8000-000000000001', '91444777000161', 'Contabilidade A', '3507605', repeat('1', 64), 'escritorio_5', 500,
   'fa000000-0000-4000-8000-000000000001', '170201', 6, 'concluido'),
  ('fb000000-0000-4000-8000-000000000002', '92444777000161', 'Contabilidade B', '3507605', repeat('2', 64), 'escritorio_20', 2000,
   'fa000000-0000-4000-8000-000000000002', '170201', 6, 'concluido'),
  ('fb000000-0000-4000-8000-000000000003', '93444777000161', 'Contabilidade C', '3507605', repeat('3', 64), 'escritorio_5', 500,
   'fa000000-0000-4000-8000-000000000003', '170201', 6, 'concluido'),
  ('fb000000-0000-4000-8000-000000000004', '94444777000161', 'Conta Pro P', '3550308', repeat('4', 64), 'pro', 100,
   'fa000000-0000-4000-8000-000000000004', '010701', 6, 'concluido');
insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values
  ('f9000000-0000-4000-8000-000000000001', 'gui-a@example.test', '+5511900000301', now(), 'fa000000-0000-4000-8000-000000000001'),
  ('f9000000-0000-4000-8000-000000000002', 'gui-b@example.test', '+5511900000302', now(), 'fa000000-0000-4000-8000-000000000002'),
  ('f9000000-0000-4000-8000-000000000003', 'gui-c@example.test', '+5511900000303', now(), 'fa000000-0000-4000-8000-000000000003'),
  ('f9000000-0000-4000-8000-000000000004', 'gui-p@example.test', '+5511900000304', now(), 'fa000000-0000-4000-8000-000000000004');

-- ------------------------------------------------------------ Ligar o módulo

select is((public.fiscal_definir_modulo_guias('fb000000-0000-4000-8000-000000000001', true, 500) ->> 'ok')::boolean, true,
  'a nó liga o módulo na conta-mãe do escritório A');
select is((public.fiscal_definir_modulo_guias('fb000000-0000-4000-8000-000000000002', true, null) ->> 'limite_mes')::int, 500,
  'sem limite informado, a primeira vez fica com 500 guias/mês');
select is(public.fiscal_definir_modulo_guias('fb000000-0000-4000-8000-000000000004', true, 500) ->> 'erro',
  'NAO_E_CONTA_MAE_DE_ESCRITORIO', 'conta Pro não recebe o módulo');
select is((select assinatura from nofiscal.guia_regras where escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000001'),
  'Contabilidade A', 'as regras padrão nascem com o nome do escritório na assinatura');
select is((select faixa from nofiscal.fiscal_addons where tenant_id = 'fb000000-0000-4000-8000-000000000001'),
  'guias_500', 'limite 500 = faixa Guias 500');

set local role authenticated;
select throws_ok($$ select public.fiscal_definir_modulo_guias('fb000000-0000-4000-8000-000000000003', true, 500) $$,
  '42501', null, 'papel authenticated não liga o módulo');
reset role;
set local role nofiscal_service;
select throws_ok($$ select public.fiscal_definir_modulo_guias('fb000000-0000-4000-8000-000000000003', true, 500) $$,
  '42501', null, 'nem o papel do motor (nofiscal_service)');
reset role;
set local role anon;
select throws_ok($$ select public.fiscal_definir_modulo_guias('fb000000-0000-4000-8000-000000000003', true, 500) $$,
  '42501', null, 'nem anon');
reset role;
select is(nofiscal.guias_ligado('fb000000-0000-4000-8000-000000000003'), false, 'C continua sem o módulo');

-- ------------------------------------------------------------ Funções do módulo, como o motor

set local role nofiscal_service;

select is(nofiscal.guias_conta_do_usuario('f9000000-0000-4000-8000-000000000001'), 'fb000000-0000-4000-8000-000000000001'::uuid,
  'conta do usuário A com o módulo');
select is(nofiscal.guias_conta_do_usuario('f9000000-0000-4000-8000-000000000003'), null::uuid, 'C sem o módulo: nenhuma conta');

select throws_ok($$ select nofiscal.guias_contato_salvar('f9000000-0000-4000-8000-000000000003',
  '{"documento":"11222333000181","nome":"X","whatsapps":["+5511987650000"]}') $$,
  'P0001', 'GUIAS_DESLIGADO', 'conta sem o módulo não cadastra contato');
select throws_ok($$ select nofiscal.guias_lote_criar('f9000000-0000-4000-8000-000000000003', 3) $$,
  'P0001', 'GUIAS_DESLIGADO', 'conta sem o módulo não cria lote');
select throws_ok($$ select nofiscal.guias_disparar('f9000000-0000-4000-8000-000000000003',
  array['fc000000-0000-4000-8000-000000000001'::uuid], null) $$,
  'P0001', 'GUIAS_DESLIGADO', 'conta sem o módulo não dispara');
select throws_ok($$ select nofiscal.guias_lote_criar('f9000000-0000-4000-8000-000000000004', 3) $$,
  'P0001', 'GUIAS_DESLIGADO', 'conta Pro não usa o módulo');

-- Contatos de A e de B, o mesmo cliente nos dois escritórios.
select lives_ok($$ select nofiscal.guias_contato_salvar('f9000000-0000-4000-8000-000000000001',
  '{"documento":"11.222.333/0001-81","nome":"Cliente Um","whatsapps":["+5511987650001"],"emails":["Um@Cliente.test"],
    "aceite_em":"2026-11-19T10:00:00-03:00","aceite_origem":"declarado pelo escritório"}') $$, 'A cadastra um contato');
select lives_ok($$ select nofiscal.guias_contato_salvar('f9000000-0000-4000-8000-000000000002',
  '{"documento":"11222333000181","nome":"Cliente Um em B","whatsapps":["+5511987650002"]}') $$, 'B cadastra o mesmo CNPJ');
select lives_ok($$ select nofiscal.guias_contato_salvar('f9000000-0000-4000-8000-000000000002',
  '{"documento":"45723174000110","nome":"Cliente Dois em B","emails":["dois@cliente.test"]}') $$, 'B cadastra outro');

-- Lotes e guias de A e de B (o motor grava as guias; aqui direto).
select ok(nofiscal.guias_lote_criar('f9000000-0000-4000-8000-000000000001', 3) is not null, 'A cria lote');
insert into nofiscal.guias (id, escritorio_tenant_id, lote_id, contato_id, tipo, documento, competencia, valor_centavos,
                            vencimento, linha_digitavel, pdf_path, status)
select 'fc000000-0000-4000-8000-000000000001', 'fb000000-0000-4000-8000-000000000001', l.id,
       (select id from nofiscal.guia_contatos where escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000001'),
       'das', '11222333000181', '2026-11-01', 12345, '2026-12-20', repeat('8', 48), 'a/1.pdf', 'conferir'
  from nofiscal.guia_lotes l where l.escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000001';
insert into nofiscal.guias (id, escritorio_tenant_id, lote_id, contato_id, tipo, documento, competencia, valor_centavos,
                            vencimento, linha_digitavel, pdf_path, status)
select 'fc000000-0000-4000-8000-000000000002', 'fb000000-0000-4000-8000-000000000001', l.id, null,
       'das', '99888777000166', '2026-11-01', 999, '2026-12-20', repeat('8', 48), 'a/2.pdf', 'conferir'
  from nofiscal.guia_lotes l where l.escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000001';
insert into nofiscal.guias (id, escritorio_tenant_id, lote_id, contato_id, tipo, documento, competencia, valor_centavos,
                            vencimento, linha_digitavel, pdf_path, status)
select 'fc000000-0000-4000-8000-000000000003', 'fb000000-0000-4000-8000-000000000001', l.id,
       (select id from nofiscal.guia_contatos where escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000001'),
       'das', '11222333000181', '2026-11-01', null, '2026-12-20', repeat('8', 48), 'a/3.pdf', 'conferir'
  from nofiscal.guia_lotes l where l.escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000001';
select ok(nofiscal.guias_lote_criar('f9000000-0000-4000-8000-000000000002', 1) is not null, 'B cria lote');
insert into nofiscal.guias (id, escritorio_tenant_id, lote_id, contato_id, tipo, documento, competencia, valor_centavos,
                            vencimento, linha_digitavel, pdf_path, status)
select 'fc000000-0000-4000-8000-000000000004', 'fb000000-0000-4000-8000-000000000002', l.id,
       (select id from nofiscal.guia_contatos where escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000002'
         and documento = '11222333000181'),
       'das', '11222333000181', '2026-11-01', 5000, '2026-12-20', repeat('8', 48), 'b/1.pdf', 'conferir'
  from nofiscal.guia_lotes l where l.escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000002';

-- Cor da conferência.
select is(nofiscal.guia_cor('fc000000-0000-4000-8000-000000000001'), 'verde', 'casou o CNPJ e leu tudo: verde');
select is(nofiscal.guia_cor('fc000000-0000-4000-8000-000000000002'), 'vermelho', 'CNPJ sem contato: vermelha');
select is(nofiscal.guia_cor('fc000000-0000-4000-8000-000000000003'), 'amarelo', 'faltou o valor: amarela');
update nofiscal.guias set leitura = '{"valor_divergente": true}' where id = 'fc000000-0000-4000-8000-000000000001';
select is(nofiscal.guia_cor('fc000000-0000-4000-8000-000000000001'), 'amarelo', 'valor divergente do código de barras: amarela');
update nofiscal.guias set leitura = '{}' where id = 'fc000000-0000-4000-8000-000000000001';

-- Criar o contato na conferência casa a guia vermelha.
select lives_ok($$ select nofiscal.guias_contato_salvar('f9000000-0000-4000-8000-000000000001',
  '{"documento":"99888777000166","nome":"Cliente Novo","emails":["novo@cliente.test"]}') $$, 'A cria o contato da guia vermelha');
select is(nofiscal.guia_cor('fc000000-0000-4000-8000-000000000002'), 'verde', 'a guia casou e ficou verde');

-- ------------------------------------------------------------ Posse: um escritório não lê o do outro

select set_config('nofiscal.guias_usuario', 'f9000000-0000-4000-8000-000000000001', true);
select is((select count(*)::int from nofiscal.guia_contatos), 2, 'A vê só os seus 2 contatos');
select is((select count(*)::int from nofiscal.guia_contatos where escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000002'), 0,
  'A não lê nenhum contato de B, nem filtrando por B');
select is((select count(*)::int from nofiscal.guias), 3, 'A vê só as suas 3 guias');
select is((select count(*)::int from nofiscal.guias where id = 'fc000000-0000-4000-8000-000000000004'), 0, 'A não lê a guia de B');
select is((select count(*)::int from nofiscal.guia_lotes), 1, 'A vê só o seu lote');
select is((select count(*)::int from nofiscal.fiscal_addons), 1, 'A vê só o seu módulo');
update nofiscal.guias set valor_centavos = 1 where id = 'fc000000-0000-4000-8000-000000000004';
select throws_ok($$ insert into nofiscal.guia_contatos (escritorio_tenant_id, documento, nome)
  values ('fb000000-0000-4000-8000-000000000002', '45723174000110', 'intruso') $$,
  '42501', null, 'A não grava contato na conta de B');

-- Disparo: guia de B pedida por A é ignorada; a amarela de A também.
select is(nofiscal.guias_disparar('f9000000-0000-4000-8000-000000000001',
  array['fc000000-0000-4000-8000-000000000004', 'fc000000-0000-4000-8000-000000000003',
        'fc000000-0000-4000-8000-000000000001']::uuid[], null),
  '{"agendadas": 1, "recusadas": 2}'::jsonb, 'A dispara só a própria guia verde');

select set_config('nofiscal.guias_usuario', 'f9000000-0000-4000-8000-000000000002', true);
select is((select count(*)::int from nofiscal.guia_contatos), 2, 'B vê só os seus 2 contatos');
select is((select valor_centavos from nofiscal.guias where id = 'fc000000-0000-4000-8000-000000000004'), 5000::bigint,
  'o update de A não tocou na guia de B');
select is((select count(*)::int from nofiscal.guias where escritorio_tenant_id = 'fb000000-0000-4000-8000-000000000001'), 0,
  'B não lê as guias de A');

-- Sem usuário (worker e webhook): o motor vê tudo.
select set_config('nofiscal.guias_usuario', '', true);
select is((select count(*)::int from nofiscal.guias where id::text like 'fc000000%'), 4, 'o worker vê as guias de todos');
select is((select status from nofiscal.guias where id = 'fc000000-0000-4000-8000-000000000001'), 'agendada', 'a verde ficou agendada');
select is((select status from nofiscal.guias where id = 'fc000000-0000-4000-8000-000000000004'), 'conferir', 'a de B não');

reset role;

-- Desligar o módulo recusa as funções em seguida.
select is((public.fiscal_definir_modulo_guias('fb000000-0000-4000-8000-000000000001', false, null) ->> 'ok')::boolean, true,
  'a nó desliga o módulo de A');
set local role nofiscal_service;
select throws_ok($$ select nofiscal.guias_lote_criar('f9000000-0000-4000-8000-000000000001', 1) $$,
  'P0001', 'GUIAS_DESLIGADO', 'desligado, A não cria lote');
reset role;

select * from finish();
rollback;
