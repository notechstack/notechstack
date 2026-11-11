-- Procuração eletrônica da empresa cliente ao escritório (20261111180000 e 20261111220000): só empresa de escritório
-- dá procuração, o procurador é sempre o escritório (a nó não assina por ninguém), a declaração, o certificado que o
-- motor usa, os bloqueios e os privilégios. Tudo numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- E: escritório (conta-mãe com A1). C: empresa cliente do escritório. X: outro escritório. O: conta Pro avulsa.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'proc-e@example.test', '{}', '{}', now(), now()),
  ('a1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'proc-o@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('a2000000-0000-4000-8000-000000000001', 'PROC E', 'proc-teste-e'),
  ('a2000000-0000-4000-8000-000000000002', 'PROC O', 'proc-teste-o');
insert into public.memberships (user_id, client_id, role) values
  ('a1000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'CLIENT'),
  ('a1000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000002', 'CLIENT');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa, escritorio_tenant_id
) values
  ('a3000000-0000-4000-8000-000000000001', '81444777000161', 'ESCRITORIO E', '3550308', repeat('3', 64), 'escritorio_5', 500,
   'a2000000-0000-4000-8000-000000000001', '170201', 6, 'concluido', null),
  ('a3000000-0000-4000-8000-000000000002', '82444777000161', 'CLIENTE C', '3550308', repeat('4', 64), 'escritorio_5', 500,
   null, '010701', 6, 'certificado', 'a3000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000003', '83444777000161', 'ESCRITORIO X', '3550308', repeat('5', 64), 'escritorio_5', 500,
   null, '170201', 6, 'concluido', null),
  ('a3000000-0000-4000-8000-000000000004', '84444777000161', 'AVULSA O', '3550308', repeat('6', 64), 'pro', 100,
   'a2000000-0000-4000-8000-000000000002', '010701', 6, 'certificado', null);
insert into nofiscal.fiscal_subscriptions
  (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
values ('a3000000-0000-4000-8000-000000000001', 'escritorio_5', false, 'sub_proc_e', 'paga', now(), 'aceite');
select nofiscal.upsert_certificate('a3000000-0000-4000-8000-000000000001', 'cGZ4LWVzY3JpdG9yaW8=', 'senha-e',
  'CN=ESCRITORIO E:81444777000161', now() + interval '1 year');
select nofiscal.upsert_certificate('a3000000-0000-4000-8000-000000000003', 'cGZ4LXg=', 'senha-x',
  'CN=ESCRITORIO X:83444777000161', now() + interval '1 year');

-- ---------------------------------------------------------------------------------------
-- Objetos e privilégios.
select has_column('nofiscal', 'fiscal_tenants', 'modo_autenticacao', 'modo de autenticação por empresa');
select has_table('nofiscal', 'fiscal_procuracoes', 'tabela de procurações');
select has_view('nofiscal', 'fiscal_certificados_de_emissao', 'view do certificado de emissão');
select hasnt_table('nofiscal', 'fiscal_config', 'sem procurador da plataforma: fiscal_config não existe');
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
-- Quem pode dar procuração.
select is((select documento from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000002')), '81444777000161',
  'procurador da empresa cliente é o escritório dela');
select is((select motivo from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000002')), null, 'escritório pronto');
select is((select motivo from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000004')), 'PROCURACAO_SO_NO_ESCRITORIO',
  'conta Pro avulsa não dá procuração');
select is((select motivo from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000001')), 'PROCURACAO_SO_NO_ESCRITORIO',
  'a conta do próprio escritório não dá procuração');
select is(nofiscal.onboarding_set_procuracao('a1000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000004', null),
  'PROCURACAO_SO_NO_ESCRITORIO', 'declaração recusada fora do escritório');

-- ---------------------------------------------------------------------------------------
-- Declaração.
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'CERT_MISSING', 'antes: falta o A1');
select is(nofiscal.onboarding_set_procuracao('a1000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000002', null),
  'FORBIDDEN', 'outro usuário não declara');
select is(nofiscal.onboarding_procuracao_info('a1000000-0000-4000-8000-000000000002', 'a3000000-0000-4000-8000-000000000002') ->> 'erro',
  'FORBIDDEN', 'outro usuário não lê');
select is(nofiscal.onboarding_set_procuracao('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', '2000-01-01'),
  'VALIDADE_PASSADA', 'validade no passado');
select is(nofiscal.onboarding_set_procuracao('a1000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', '2099-01-01'),
  'OK', 'dono do escritório declara');
select is((select array[modo_autenticacao, onboarding_etapa] from nofiscal.fiscal_tenants where id = 'a3000000-0000-4000-8000-000000000002'),
  array['procuracao', 'dados_fiscais'], 'modo procuração e cadastro nos dados fiscais');
select is((select procurador_tenant_id from nofiscal.fiscal_procuracoes where tenant_id = 'a3000000-0000-4000-8000-000000000002'),
  'a3000000-0000-4000-8000-000000000001'::uuid, 'procurador gravado é o escritório');
select is((select subject from nofiscal.fiscal_certificados_de_emissao where tenant_id = 'a3000000-0000-4000-8000-000000000002'),
  'CN=ESCRITORIO E:81444777000161', 'a view entrega o A1 do escritório');
select is((select password from nofiscal.read_emission_certificate('a3000000-0000-4000-8000-000000000002')), 'senha-e',
  'read_emission_certificate abre o A1 do escritório');
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), null, 'emissão liberada');

-- ---------------------------------------------------------------------------------------
-- Só o escritório da empresa assina por ela, mesmo com dado errado gravado.
update nofiscal.fiscal_procuracoes set procurador_tenant_id = 'a3000000-0000-4000-8000-000000000003'
 where tenant_id = 'a3000000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURACAO_INVALIDA', 'outro procurador bloqueia');
select is((select count(*)::int from nofiscal.fiscal_certificados_de_emissao where tenant_id = 'a3000000-0000-4000-8000-000000000002'),
  0, 'e some da view');
update nofiscal.fiscal_procuracoes set procurador_tenant_id = 'a3000000-0000-4000-8000-000000000001'
 where tenant_id = 'a3000000-0000-4000-8000-000000000002';

-- Bloqueios.
update nofiscal.fiscal_procuracoes set ultimo_erro = 'E2245' where tenant_id = 'a3000000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURACAO_NAO_ENCONTRADA', 'E2245 segura a emissão');
update nofiscal.fiscal_procuracoes set ultimo_erro = null, status = 'invalida' where tenant_id = 'a3000000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURACAO_INVALIDA', 'inválida bloqueia');
update nofiscal.fiscal_procuracoes set status = 'confirmada', valida_ate = current_date - 1 where tenant_id = 'a3000000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURACAO_VENCIDA', 'vencida bloqueia');
update nofiscal.fiscal_procuracoes set valida_ate = null where tenant_id = 'a3000000-0000-4000-8000-000000000002';
update nofiscal.fiscal_certificates set not_after = now() - interval '1 day' where tenant_id = 'a3000000-0000-4000-8000-000000000001';
select is(nofiscal.emission_block('a3000000-0000-4000-8000-000000000002'), 'PROCURADOR_CERT_INVALIDO', 'A1 do escritório vencido bloqueia');
select is((select motivo from nofiscal.procurador_do_tenant('a3000000-0000-4000-8000-000000000002')), 'PROCURADOR_CERT_VENCIDO',
  'e o painel deixa de oferecer');
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

select * from finish();
rollback;
