-- Procuração eletrônica (20261111180000_agente_fiscal_procuracao.sql): quem é o procurador, a declaração, o
-- certificado que o motor usa, os bloqueios novos e os privilégios. Tudo numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- P: procurador da plataforma (tenant com A1). C: cliente que vai dar procuração. O: outro usuário.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'proc-c@example.test', '{}', '{}', now(), now()),
  ('a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'proc-o@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'PROC C', 'proc-teste-c'),
  ('a2000000-0000-4000-8000-000000000002', 'PROC O', 'proc-teste-o');
insert into public.memberships (user_id, client_id, role) values
  ('a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'CLIENT'),
  ('a1000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000002', 'CLIENT');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa
) values
  ('a3000000-0000-4000-8000-000000000001', '81444777000161', 'PROCURADOR P', '3550308', repeat('3', 64), 'pro', 100,
   null, '010701', 6, 'concluido'),
  ('a3000000-0000-4000-8000-000000000002', '82444777000161', 'CLIENTE C', '3550308', repeat('4', 64), 'pro', 100,
   'a2000000-0000-4000-8000-000000000001', '010701', 6, 'certificado');
insert into nofiscal.fiscal_subscriptions
  (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
values ('a3000000-0000-4000-8000-000000000002', 'pro', false, 'sub_proc_c', 'paga', now(), 'aceite');
select nofiscal.upsert_certificate('a3000000-0000-4000-8000-000000000001', 'cGZ4LXByb2N1cmFkb3I=', 'senha-p',
  'CN=PROCURADOR P:81444777000161', now() + interval '1 year');
update nofiscal.fiscal_config set valor = '81444777000161' where chave = 'procurador_plataforma_cnpj';

-- ---------------------------------------------------------------------------------------
-- Objetos e privilégios.
select has_column('nofiscal', 'fiscal_tenants', 'modo_autenticacao', 'modo de autenticação por empresa');
select has_table('nofiscal', 'fiscal_procuracoes', 'tabela de procurações');
select has_view('nofiscal', 'fiscal_certificados_de_emissao', 'view do certificado de emissão');
select is((select modo_autenticacao from nofiscal.fiscal_tenants where id = 'a3000000-0000-4000-8000-000000000002'),
  'certificado_proprio', 'empresa nasce no modo certificado próprio');
select ok(has_function_privilege('nofiscal_onboarding', 'nofiscal.onboarding_set_procuracao(uuid,uuid,date)', 'execute'),
  'cadastro declara a procuração');
select ok(has_function_privilege('nofiscal_onboarding', 'nofiscal.onboarding_procuracao_info(uuid,uuid)', 'execute'),
  'cadastro lê a procuração');
select ok(not has_function_privilege('nofiscal_onboarding', 'nofiscal.read_emission_certificate(uuid)', 'execute'),
  'cadastro não lê certificado');
select ok(has_function_privilege('nofiscal_service', 'nofiscal.read_emission_certificate(uuid)', 'execute'), 'motor lê o certificado de emissão');
select ok(has_table_privilege('nofiscal_service', 'nofiscal.fiscal_certificados_de_emissao', 'select'), 'motor lê a view');
select ok(has_table_privilege('nofiscal_service', 'nofiscal.fiscal_procuracoes', 'update'), 'motor confirma a procuração');
select ok(not has_table_privilege('service_role', 'nofiscal.fiscal_procuracoes', 'select'), 'edge function não lê procurações');
select ok(not has_function_privilege('anon', 'nofiscal.onboarding_set_procuracao(uuid,uuid,date)', 'execute'), 'anon não declara');
select ok(not has_function_privilege('authenticated', 'nofiscal.procurador_do_tenant(uuid)', 'execute'), 'authenticated não consulta procurador');

-- ---------------------------------------------------------------------------------------
-- Procurador e declaração.
select is((select documento from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000002')), '81444777000161',
  'procurador da plataforma pelo CNPJ da configuração');
select is((select motivo from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000002')), null, 'procurador pronto');
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'CERT_MISSING', 'antes: falta o A1');
select is(nofiscal.onboarding_set_procuracao('a1000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000002', null),
  'FORBIDDEN', 'outro usuário não declara');
select is(nofiscal.onboarding_procuracao_info('a1000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000002') ->> 'erro',
  'FORBIDDEN', 'outro usuário não lê');
select is(nofiscal.onboarding_set_procuracao('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', '2000-01-01'),
  'VALIDADE_PASSADA', 'validade no passado');
select is(nofiscal.onboarding_set_procuracao('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', '2099-01-01'),
  'OK', 'dono declara');
select is((select array[modo_autenticacao, onboarding_etapa] from nofiscal.fiscal_tenants where id = 'a3000000-0000-4000-8000-000000000002'),
  array['procuracao', 'dados_fiscais'], 'modo procuração e cadastro nos dados fiscais');
select is((select status from nofiscal.fiscal_procuracoes where tenant_id = 'a3000000-0000-4000-8000-000000000002'), 'declarada', 'declarada');
select is((select modo from nofiscal.fiscal_certificados_de_emissao where tenant_id = 'a3000000-0000-4000-8000-000000000002'),
  'procuracao', 'a view entrega o A1 do procurador');
select is((select subject from nofiscal.fiscal_certificados_de_emissao where tenant_id = 'a3000000-0000-4000-8000-000000000002'),
  'CN=PROCURADOR P:81444777000161', 'é o certificado do procurador');
select is((select password from nofiscal.read_emission_certificate('a3000000-0000-4000-8000-000000000002')), 'senha-p',
  'read_emission_certificate abre o A1 do procurador');
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), null, 'emissão liberada');

-- ---------------------------------------------------------------------------------------
-- Bloqueios.
update nofiscal.fiscal_procuracoes set ultimo_erro = 'E2245' where tenant_id = 'a3000000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURACAO_NAO_ENCONTRADA', 'E2245 segura a emissão');
update nofiscal.fiscal_procuracoes set ultimo_erro = null, status = 'invalida' where tenant_id = 'a3000000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURACAO_INVALIDA', 'inválida bloqueia');
select is((select count(*)::int from nofiscal.fiscal_certificados_de_emissao where tenant_id = 'a3000000-0000-4000-8000-000000000002'),
  0, 'inválida some da view');
update nofiscal.fiscal_procuracoes set status = 'confirmada', valida_ate = current_date - 1 where tenant_id = 'a3000000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURACAO_VENCIDA', 'vencida bloqueia');
update nofiscal.fiscal_procuracoes set valida_ate = null where tenant_id = 'a3000000-0000-4000-8000-000000000002';
update nofiscal.fiscal_certificates set not_after = now() - interval '1 day' where tenant_id = 'a3000000-0000-4000-8000-000000000001';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURADOR_CERT_INVALIDO', 'A1 do procurador vencido bloqueia');
select is((select motivo from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000002')), 'PROCURADOR_CERT_VENCIDO',
  'e o cadastro deixa de oferecer');
update nofiscal.fiscal_certificates set not_after = now() + interval '1 year' where tenant_id = 'a3000000-0000-4000-8000-000000000001';
delete from nofiscal.fiscal_procuracoes where tenant_id = 'a3000000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURACAO_MISSING', 'modo procuração sem procuração');

-- O A1 próprio volta o modo.
select is(nofiscal.onboarding_set_certificate('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002',
  'cGZ4LWNsaWVudGU=', 'senha-c', 'CN=CLIENTE C:82444777000161', now() + interval '1 year'), 'OK', 'A1 próprio aceito');
select is((select modo_autenticacao from nofiscal.fiscal_tenants where id = 'a3000000-0000-4000-8000-000000000002'),
  'certificado_proprio', 'volta ao modo certificado próprio');
select is((select password from nofiscal.read_emission_certificate('a3000000-0000-4000-8000-000000000002')), 'senha-c',
  'motor volta a usar o A1 da empresa');

-- Sem configuração, o cadastro não oferece a procuração.
delete from nofiscal.fiscal_config where chave = 'procurador_plataforma_cnpj';
select is((select motivo from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000002')), 'PROCURADOR_NAO_CONFIGURADO',
  'sem procurador configurado');

select * from finish();
rollback;
