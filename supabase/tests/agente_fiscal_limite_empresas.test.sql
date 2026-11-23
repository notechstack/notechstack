-- Pacote por notas (20261116180000_agente_fiscal_limite_empresas_por_conta.sql): limite de empresas por conta.
-- Sem override nada muda; com override = 200 a 21ª empresa de uma conta escritorio_20 entra e a 201ª é barrada;
-- o override fica na troca de faixa e a franquia de notas segue a faixa. Tudo numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant nofiscal_service to postgres;
grant usage on schema extensions to nofiscal_service, service_role;

-- A: escritório na faixa 20 (o primeiro caso, FUNDADOR20). B: escritório na faixa 5, sem pacote. P: conta Pro.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('f5000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'lim-a@example.test', '{}', '{}', now(), now()),
  ('f5000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'lim-b@example.test', '{}', '{}', now(), now()),
  ('f5000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'lim-p@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('f6000000-0000-4000-8000-000000000001', 'LIM A', 'lim-teste-a'),
  ('f6000000-0000-4000-8000-000000000002', 'LIM B', 'lim-teste-b'),
  ('f6000000-0000-4000-8000-000000000003', 'LIM P', 'lim-teste-p');
insert into public.memberships (user_id, client_id, role) values
  ('f5000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000001', 'CLIENT'),
  ('f5000000-0000-4000-8000-000000000002', 'f6000000-0000-4000-8000-000000000002', 'CLIENT'),
  ('f5000000-0000-4000-8000-000000000003', 'f6000000-0000-4000-8000-000000000003', 'CLIENT');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa
) values
  ('f7000000-0000-4000-8000-000000000001', '81444777000161', 'LIM A', '3507605', repeat('a', 64), 'escritorio_20', 2000,
   'f6000000-0000-4000-8000-000000000001', '170201', 6, 'concluido'),
  ('f7000000-0000-4000-8000-000000000002', '82444777000161', 'LIM B', '3507605', repeat('b', 64), 'escritorio_5', 500,
   'f6000000-0000-4000-8000-000000000002', '170201', 6, 'concluido'),
  ('f7000000-0000-4000-8000-000000000003', '83444777000161', 'LIM P', '3550308', repeat('c', 64), 'pro', 100,
   'f6000000-0000-4000-8000-000000000003', '010701', 6, 'concluido');
insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values
  ('f5000000-0000-4000-8000-000000000001', 'lim-a@example.test', '+5511900000201', now(), 'f6000000-0000-4000-8000-000000000001'),
  ('f5000000-0000-4000-8000-000000000002', 'lim-b@example.test', '+5511900000202', now(), 'f6000000-0000-4000-8000-000000000002'),
  ('f5000000-0000-4000-8000-000000000003', 'lim-p@example.test', '+5511900000203', now(), 'f6000000-0000-4000-8000-000000000003');
insert into nofiscal.fiscal_subscriptions
  (id, tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
values
  ('f8000000-0000-4000-8000-000000000001', 'f7000000-0000-4000-8000-000000000001', 'escritorio_20', true,
   'sub_lim_a', 'paga', now(), 'aceite'),
  ('f8000000-0000-4000-8000-000000000002', 'f7000000-0000-4000-8000-000000000002', 'escritorio_5', false,
   'sub_lim_b', 'paga', now(), 'aceite'),
  ('f8000000-0000-4000-8000-000000000003', 'f7000000-0000-4000-8000-000000000003', 'pro', false,
   'sub_lim_p', 'paga', now(), 'aceite');

-- Adiciona a empresa n (1..999) do escritório A pelo mesmo caminho do painel. CNPJ e chave únicos por n.
create function pg_temp.add_a(n integer) returns jsonb language sql as $$
  select public.fiscal_empresa_adicionar('f5000000-0000-4000-8000-000000000001',
    '70' || lpad(n::text, 12, '0'), 'Cliente ' || n, '3550308', null, 'simples',
    encode(sha256(convert_to('lim-a-' || n, 'UTF8')), 'hex'), 'producao');
$$;
create function pg_temp.ativas_a() returns bigint language sql as $$
  select count(*) from nofiscal.fiscal_tenants t
   where (t.id = 'f7000000-0000-4000-8000-000000000001' or t.escritorio_tenant_id = 'f7000000-0000-4000-8000-000000000001')
     and t.active;
$$;

-- ---------------------------------------------------------------------------------------
-- Objetos e privilégios.
select has_column('nofiscal', 'fiscal_tenants', 'max_empresas_override', 'coluna do pacote existe');
select ok(has_function_privilege('service_role', 'public.fiscal_definir_limite_empresas(uuid,integer)', 'execute'),
  'service_role aplica o pacote');
select ok(not has_function_privilege('authenticated', 'public.fiscal_definir_limite_empresas(uuid,integer)', 'execute'),
  'authenticated não aplica o pacote');
select ok(not has_function_privilege('anon', 'public.fiscal_definir_limite_empresas(uuid,integer)', 'execute'),
  'anon não aplica o pacote');
select ok(has_function_privilege('nofiscal_service', 'nofiscal.max_empresas_da_conta(uuid)', 'execute'),
  'motor lê o limite da conta');
select ok(not has_function_privilege('service_role', 'nofiscal.max_empresas_da_conta(uuid)', 'execute'),
  'edge function não chama o limite direto');

-- ---------------------------------------------------------------------------------------
-- Sem override, a faixa não limita empresas (planos por volume, 23/11/2026): 100000 é o "sem limite".
select is(nofiscal.max_empresas_da_conta('f7000000-0000-4000-8000-000000000001'), 100000, 'faixa 20 sem pacote: sem limite de empresas');
select is(nofiscal.max_empresas_da_conta('f7000000-0000-4000-8000-000000000002'), 100000, 'faixa 5 sem pacote: sem limite de empresas');
select is(nofiscal.max_empresas_da_conta('f7000000-0000-4000-8000-000000000003'), 1, 'conta Pro: 1 empresa');
select is((public.fiscal_escritorio_estado('f5000000-0000-4000-8000-000000000001') ->> 'max_empresas')::int, 100000,
  'painel mostra o sem limite sem pacote');
select ok((public.fiscal_escritorio_estado('f5000000-0000-4000-8000-000000000001') -> 'max_empresas_override') = 'null'::jsonb,
  'painel sem override');

-- Conta-mãe + 19 = 20 ativas; sem pacote a 21ª entra (antes a faixa 20 barrava).
select pg_temp.add_a(n) from generate_series(1, 19) n;
select is(pg_temp.ativas_a(), 20::bigint, 'vinte ativas na faixa 20');
select is(pg_temp.add_a(20) ->> 'ok', 'true', 'sem pacote, a 21ª entra');
select is(pg_temp.ativas_a(), 21::bigint, 'vinte e uma ativas na faixa 20');

-- ---------------------------------------------------------------------------------------
-- Aplicar o pacote: recusas.
select throws_ok($$ select public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-000000000001', 0) $$,
  '22023', null, 'limite zero é inválido');
select throws_ok($$ select public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-000000000001', 1001) $$,
  '22023', null, 'limite acima de 1000 é inválido');
select is(public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-000000000003', 200) ->> 'erro',
  'NAO_E_CONTA_MAE_DE_ESCRITORIO', 'conta Pro não recebe pacote');
select is(public.fiscal_definir_limite_empresas(
  (select id from nofiscal.fiscal_tenants where cnpj = '70000000000001'), 200) ->> 'erro',
  'NAO_E_CONTA_MAE_DE_ESCRITORIO', 'empresa do escritório não recebe pacote');
select is(public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-0000000000ff', 200) ->> 'erro',
  'CONTA_NAO_ENCONTRADA', 'tenant inexistente');
select is(public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-000000000001', 10) ->> 'erro',
  'EMPRESAS_ACIMA_DO_LIMITE', 'limite abaixo das ativas é recusado');
select throws_ok($$ update nofiscal.fiscal_tenants set max_empresas_override = 200 where cnpj = '70000000000001' $$,
  '23514', null, 'override só na conta-mãe (constraint)');

-- Aplicar o pacote: 200 empresas na faixa 20.
select is(public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-000000000001', 200) ->> 'ok', 'true',
  'pacote de 200 aplicado');
select is(nofiscal.max_empresas_da_conta('f7000000-0000-4000-8000-000000000001'), 200, 'limite da conta vira 200');
select is((public.fiscal_escritorio_estado('f5000000-0000-4000-8000-000000000001') ->> 'max_empresas')::int, 200,
  'painel mostra 200');
select is((public.fiscal_escritorio_estado('f5000000-0000-4000-8000-000000000001') ->> 'max_empresas_override')::int, 200,
  'painel sabe do pacote');
select is((public.fiscal_escritorio_estado('f5000000-0000-4000-8000-000000000001') ->> 'notas_limite')::int, 2000,
  'franquia de notas continua a da faixa 20');
select is(nofiscal.max_empresas_da_conta('f7000000-0000-4000-8000-000000000002'), 100000, 'outra conta não muda');

select is(pg_temp.add_a(200) ->> 'ok', 'true', 'com pacote, mais uma entra');
select is((select monthly_note_limit from nofiscal.fiscal_tenants where cnpj = '70000000000020'), 2000,
  'empresa nova com a franquia da faixa');
select pg_temp.add_a(n) from generate_series(21, 198) n;
select is(pg_temp.ativas_a(), 200::bigint, 'duzentas ativas');
select is(pg_temp.add_a(199) ->> 'erro', 'EMPRESAS_ACIMA_DO_LIMITE', 'a 201ª é barrada');
select is((pg_temp.add_a(199) ->> 'limite')::int, 200, 'limite informado é o do pacote');

-- Reativar respeita o pacote.
select is(public.fiscal_empresa_ativar('f5000000-0000-4000-8000-000000000001',
  (select id from nofiscal.fiscal_tenants where cnpj = '70000000000001'), false) ->> 'ok', 'true', 'desativa uma');
select is(pg_temp.add_a(199) ->> 'ok', 'true', 'vaga liberada vira a 200ª');
select is(public.fiscal_empresa_ativar('f5000000-0000-4000-8000-000000000001',
  (select id from nofiscal.fiscal_tenants where cnpj = '70000000000001'), true) ->> 'erro', 'EMPRESAS_ACIMA_DO_LIMITE',
  'reativar a 201ª é barrado');

-- Diminuir o pacote para menos que as 200 ativas: recusado. (Tirar o pacote é sempre aceito: a faixa não limita.)
select is(public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-000000000001', 150) ->> 'erro',
  'EMPRESAS_ACIMA_DO_LIMITE', 'não diminui o pacote para menos que as ativas');

-- ---------------------------------------------------------------------------------------
-- Troca de faixa: o override fica até ser zerado; a franquia de notas segue a faixa.
select is(public.fiscal_trocar_plano('f5000000-0000-4000-8000-000000000001', 'escritorio_50') ->> 'ok', 'true',
  'sobe para a faixa 50 com 200 ativas');
select is((select max_empresas_override from nofiscal.fiscal_tenants where id = 'f7000000-0000-4000-8000-000000000001'),
  200, 'pacote fica na subida');
select is((public.fiscal_escritorio_estado('f5000000-0000-4000-8000-000000000001') ->> 'max_empresas')::int, 200,
  'limite continua 200 na faixa 50');
select is((public.fiscal_escritorio_estado('f5000000-0000-4000-8000-000000000001') ->> 'notas_limite')::int, 5000,
  'franquia vira a da faixa 50');
select is(public.fiscal_trocar_plano('f5000000-0000-4000-8000-000000000001', 'escritorio_5') ->> 'ok', 'true',
  'desce para a faixa 5 com 200 ativas');
select is((select max_empresas_override from nofiscal.fiscal_tenants where id = 'f7000000-0000-4000-8000-000000000001'),
  200, 'pacote fica na descida');
select is((select monthly_note_limit from nofiscal.fiscal_tenants where cnpj = '70000000000100'), 500,
  'franquia das empresas vira a da faixa 5');

-- Sem pacote, a faixa é só o volume de documentos: a conta B (1 ativa + 5 = 6) desce para a faixa de 500.
select is(public.fiscal_trocar_plano('f5000000-0000-4000-8000-000000000002', 'escritorio_20') ->> 'ok', 'true',
  'B sobe para a faixa 20');
select public.fiscal_empresa_adicionar('f5000000-0000-4000-8000-000000000002', '71' || lpad(n::text, 12, '0'),
  'B ' || n, '3550308', null, 'simples', encode(sha256(convert_to('lim-b-' || n, 'UTF8')), 'hex'), 'producao')
  from generate_series(1, 5) n;
select is(public.fiscal_trocar_plano('f5000000-0000-4000-8000-000000000002', 'escritorio_5') ->> 'ok',
  'true', 'B sem pacote desce com 6 ativas');

-- Zerar o pacote quando as ativas cabem na faixa.
select is(public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-000000000002', 10) ->> 'ok', 'true',
  'B recebe pacote de 10');
select is(public.fiscal_trocar_plano('f5000000-0000-4000-8000-000000000002', 'escritorio_1000') ->> 'ok', 'true',
  'com pacote, B vai para a faixa nova de 1.000 documentos');
select is(public.fiscal_trocar_plano('f5000000-0000-4000-8000-000000000002', 'escritorio_20') ->> 'ok', 'true',
  'B volta para a faixa 20');
select is(public.fiscal_definir_limite_empresas('f7000000-0000-4000-8000-000000000002', null) ->> 'ok', 'true',
  'pacote de B zerado');
select is(nofiscal.max_empresas_da_conta('f7000000-0000-4000-8000-000000000002'), 100000, 'B volta a não ter limite de empresas');

select * from finish();
rollback;
