-- Agente fiscal (lote A): checks C2, C3, C4, C9, C10, C11 e a parte de banco de C31 de
-- .checks/agente-fiscal-whatsapp.md, mais o estado da assinatura visível ao motor (Landing).
-- Tudo roda numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- No Postgres 15 criar um papel não dá ao criador o direito de assumi-lo.
-- Os grants vivem só nesta transação, que é desfeita no fim.
grant nofiscal_service to postgres;
grant nofiscal_onboarding to postgres;
grant usage on schema extensions to nofiscal_service, nofiscal_onboarding, service_role;

-- Contagem com o papel corrente, ou 'denied' quando o papel não tem privilégio.
create function public.agente_fiscal_test_count(p_sql text)
returns text
language plpgsql
as $$
declare
  v_count bigint;
begin
  execute p_sql into v_count;
  return v_count::text;
exception when insufficient_privilege then
  return 'denied';
end;
$$;
grant execute on function public.agente_fiscal_test_count(text)
  to anon, authenticated, service_role, nofiscal_service, nofiscal_onboarding;

-- Dono de A (u1), dono de B (u2) e um usuário sem empresa (u3).
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('f1500000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dono-a@example.test', '{"role":"CLIENT"}', '{}', now(), now()),
  ('f1500000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'dono-b@example.test', '{"role":"CLIENT"}', '{}', now(), now()),
  ('f1500000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'estranho@example.test', '{"role":"CLIENT"}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('f1600000-0000-4000-8000-000000000001', 'Empresa A', 'agente-fiscal-teste-a'),
  ('f1600000-0000-4000-8000-000000000002', 'Empresa B', 'agente-fiscal-teste-b');
insert into public.memberships (user_id, client_id, role) values
  ('f1500000-0000-4000-8000-000000000001', 'f1600000-0000-4000-8000-000000000001', 'CLIENT'),
  ('f1500000-0000-4000-8000-000000000002', 'f1600000-0000-4000-8000-000000000002', 'CLIENT');

-- A e B são tenants do self-service; C é um tenant por chave de API, sem conta da Nó.
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id
) values
  ('f1700000-0000-4000-8000-000000000001', '11444777000161', 'EMPRESA A TESTE', '3550308', repeat('1', 64), 'pro', 100,
   'f1600000-0000-4000-8000-000000000001'),
  ('f1700000-0000-4000-8000-000000000002', '22333444000181', 'EMPRESA B TESTE', '3550308', repeat('2', 64), 'inicial', 20,
   'f1600000-0000-4000-8000-000000000002'),
  ('f1700000-0000-4000-8000-000000000003', '33444555000172', 'EMPRESA C TESTE', '3550308', repeat('3', 64), 'custom', 300,
   null);

-- Colunas novas de fiscal_tenants.
select has_column('nofiscal', 'fiscal_tenants', 'client_id', 'fiscal_tenants.client_id existe');
select has_column('nofiscal', 'fiscal_tenants', 'contador_email', 'fiscal_tenants.contador_email existe');
select has_column('nofiscal', 'fiscal_tenants', 'cnae', 'fiscal_tenants.cnae existe');
select has_column('nofiscal', 'fiscal_tenants', 'codigo_servico_nacional', 'fiscal_tenants.codigo_servico_nacional existe');
select has_column('nofiscal', 'fiscal_tenants', 'trial_ends_at', 'fiscal_tenants.trial_ends_at existe');
select throws_ok(
  $$insert into nofiscal.fiscal_tenants (cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id)
    values ('44555666000190', 'DUPLICADO', '3550308', repeat('4', 64), 'pro', 100, 'f1600000-0000-4000-8000-000000000001')$$,
  '23505', null, 'client_id único: uma conta da Nó tem um único tenant');
select throws_ok(
  $$update nofiscal.fiscal_tenants set client_id = 'f1600000-0000-4000-8000-0000000000ff'
     where id = 'f1700000-0000-4000-8000-000000000003'$$,
  '23503', null, 'client_id referencia public.clients');
select throws_ok(
  $$update nofiscal.fiscal_tenants set contador_email = 'sem-arroba' where id = 'f1700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'contador_email precisa ser um e-mail');
select throws_ok(
  $$update nofiscal.fiscal_tenants set cnae = '62' where id = 'f1700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'cnae tem 7 dígitos');

-- ---------------------------------------------------------------------------------------
-- C2: configuração fiscal obrigatória
-- A tem certificado válido e assinatura paga; só a configuração fiscal varia.
select nofiscal.upsert_certificate(
  'f1700000-0000-4000-8000-000000000001', 'UEZYLUE=', 'senha-a', 'CN=EMPRESA A TESTE:11444777000161', now() + interval '200 days');
insert into nofiscal.fiscal_subscriptions (
  tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto
) values ('f1700000-0000-4000-8000-000000000001', 'pro', false, 'sub_teste_a', 'paga', now(), 'Li e aceito os Termos.');

select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000001'), 'FISCAL_CONFIG_MISSING',
  'configuração fiscal obrigatória: sem código de serviço e sem percentual, a emissão real não é liberada');
update nofiscal.fiscal_tenants set codigo_servico_nacional = '010701' where id = 'f1700000-0000-4000-8000-000000000001';
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000001'), 'FISCAL_CONFIG_MISSING',
  'configuração fiscal obrigatória: só o código de serviço não libera');
update nofiscal.fiscal_tenants set codigo_servico_nacional = null, p_tot_trib_sn = 6
 where id = 'f1700000-0000-4000-8000-000000000001';
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000001'), 'FISCAL_CONFIG_MISSING',
  'configuração fiscal obrigatória: só o percentual não libera');
update nofiscal.fiscal_tenants set codigo_servico_nacional = '010701' where id = 'f1700000-0000-4000-8000-000000000001';
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000001'), null,
  'configuração fiscal obrigatória: com os dois, a emissão real é liberada');
select throws_ok(
  $$update nofiscal.fiscal_tenants set p_tot_trib_sn = 100.01 where id = 'f1700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'configuração fiscal obrigatória: percentual acima de 100 é recusado');
select throws_ok(
  $$update nofiscal.fiscal_tenants set p_tot_trib_sn = -0.01 where id = 'f1700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'configuração fiscal obrigatória: percentual abaixo de 0 é recusado');
select lives_ok(
  $$update nofiscal.fiscal_tenants set p_tot_trib_sn = 0 where id = 'f1700000-0000-4000-8000-000000000002'$$,
  'configuração fiscal obrigatória: 0 é aceito');
select lives_ok(
  $$update nofiscal.fiscal_tenants set p_tot_trib_sn = 100 where id = 'f1700000-0000-4000-8000-000000000002'$$,
  'configuração fiscal obrigatória: 100 é aceito');
select throws_ok(
  $$update nofiscal.fiscal_tenants set codigo_servico_nacional = '1234' where id = 'f1700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'configuração fiscal obrigatória: código de serviço nacional tem 6 dígitos');

set local role nofiscal_service;
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000001'), null,
  'configuração fiscal obrigatória: o motor (nofiscal_service) lê o estado');
reset role;

-- ---------------------------------------------------------------------------------------
-- Estado da assinatura visível ao motor (Landing, lote A). B: configurado, com A1, sem assinatura.
update nofiscal.fiscal_tenants set codigo_servico_nacional = '010701', p_tot_trib_sn = 6
 where id = 'f1700000-0000-4000-8000-000000000002';
select nofiscal.upsert_certificate(
  'f1700000-0000-4000-8000-000000000002', 'UEZYLUI=', 'senha-b', 'CN=EMPRESA B TESTE:22333444000181', now() + interval '200 days');
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000002'), 'NO_SUBSCRIPTION',
  'estado da assinatura: sem assinatura, a emissão real não é liberada');
select is(nofiscal.emission_block('f1700000-0000-4000-8000-0000000000ff'), 'TENANT_NOT_FOUND',
  'estado da assinatura: tenant inexistente');

-- As edge functions (service_role) só escrevem pelas funções de public.
set local role service_role;
select is(public.agente_fiscal_test_count('select count(*) from nofiscal.fiscal_subscriptions'), 'denied',
  'estado da assinatura: service_role não lê nofiscal direto');
select is(
  public.fiscal_assinatura_contexto('f1500000-0000-4000-8000-000000000002'), null,
  'estado da assinatura: contexto só para o dono com conta ativa');
reset role;

insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, phone_verified_at, client_id)
values ('f1500000-0000-4000-8000-000000000002', 'dono-b@example.test', '+5511900000002', now(), now(),
        'f1600000-0000-4000-8000-000000000002');

set local role service_role;
select is(
  public.fiscal_assinatura_contexto('f1500000-0000-4000-8000-000000000002') ->> 'tenant_id',
  'f1700000-0000-4000-8000-000000000002', 'estado da assinatura: contexto devolve o tenant do dono');
select is(
  public.fiscal_assinatura_contexto('f1500000-0000-4000-8000-000000000002') ->> 'cnpj',
  '22333444000181', 'estado da assinatura: contexto traz o CNPJ');
select is(
  public.fiscal_registrar_assinatura(
    'f1700000-0000-4000-8000-000000000002', 'inicial', true, now() + interval '7 days',
    'cus_b', 'sub_teste_b', 'pendente', 'Li e aceito os Termos.') ->> 'status',
  'pendente', 'estado da assinatura: registro com teste fica pendente');
reset role;

select is(
  (select trial_ends_at from nofiscal.fiscal_tenants where id = 'f1700000-0000-4000-8000-000000000002'),
  now() + interval '7 days', 'estado da assinatura: o registro grava trial_ends_at');
select results_eq(
  $$select plan, monthly_note_limit from nofiscal.fiscal_tenants where id = 'f1700000-0000-4000-8000-000000000002'$$,
  $$values ('inicial'::text, 20)$$, 'estado da assinatura: o registro grava o plano e o limite');
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000002'), null,
  'estado da assinatura: pendente dentro do teste libera');

update nofiscal.fiscal_tenants set trial_ends_at = now() - interval '1 minute'
 where id = 'f1700000-0000-4000-8000-000000000002';
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000002'), 'PAYMENT_NOT_APPROVED',
  'estado da assinatura: pendente depois do teste bloqueia');

set local role service_role;
select is(
  public.fiscal_aplicar_evento_assinatura('hook_b_1', 'charge.paid', 'sub_teste_b', 'paga', '{}', now()) ->> 'applied',
  'true', 'estado da assinatura: cobrança aprovada é aplicada');
reset role;
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000002'), null,
  'estado da assinatura: paga libera depois do teste');

set local role service_role;
select is(
  public.fiscal_aplicar_evento_assinatura('hook_b_1', 'charge.paid', 'sub_teste_b', 'paga', '{}', now()) ->> 'duplicado',
  'true', 'estado da assinatura: aviso repetido não muda nada');
select is(
  public.fiscal_aplicar_evento_assinatura('hook_b_0', 'charge.payment_failed', 'sub_teste_b', 'recusada', '{}',
    now() - interval '1 hour') ->> 'ignorado',
  'fora_de_ordem', 'estado da assinatura: aviso mais antigo não muda o status');
select is(
  public.fiscal_aplicar_evento_assinatura('hook_b_2', 'charge.payment_failed', 'sub_teste_b', 'recusada', '{}',
    now() + interval '1 hour') ->> 'status',
  'recusada', 'estado da assinatura: cobrança recusada é aplicada');
reset role;
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000002'), 'PAYMENT_NOT_APPROVED',
  'estado da assinatura: recusada bloqueia');

set local role service_role;
select is(
  public.fiscal_aplicar_evento_assinatura('hook_b_3', 'subscription.canceled', 'sub_teste_b', 'cancelada', '{}',
    now() + interval '2 hours') ->> 'status',
  'cancelada', 'estado da assinatura: cancelamento é aplicado');
select is(
  public.fiscal_aplicar_evento_assinatura('hook_b_4', 'charge.paid', 'sub_teste_b', 'paga', '{}',
    now() + interval '3 hours') ->> 'ignorado',
  'cancelada_final', 'estado da assinatura: cancelada é final');
reset role;
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000002'), 'SUBSCRIPTION_CANCELLED',
  'estado da assinatura: cancelada bloqueia');

select throws_ok(
  $$insert into nofiscal.fiscal_subscriptions (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
    values ('f1700000-0000-4000-8000-000000000001', 'pro', false, 'sub_teste_a2', 'pendente', now(), 'Aceito.')$$,
  '23505', null, 'estado da assinatura: uma única assinatura não cancelada por tenant');
select throws_ok(
  $$insert into nofiscal.fiscal_subscriptions (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
    values ('f1700000-0000-4000-8000-000000000003', 'pro', false, 'sub_teste_c', 'pendente', now(), '')$$,
  '23514', null, 'estado da assinatura: aceite com texto obrigatório');

select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000003'), 'FISCAL_CONFIG_MISSING',
  'estado da assinatura: a ordem dos motivos começa pela configuração');
update nofiscal.fiscal_tenants set active = false where id = 'f1700000-0000-4000-8000-000000000003';
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000003'), 'TENANT_INACTIVE',
  'estado da assinatura: tenant inativo vem antes de tudo');

-- Papéis de fora não chamam as funções da assinatura nem o estado.
select ok(not exists (
    select 1 from (values ('anon'), ('authenticated'), ('nofiscal_service'), ('nofiscal_onboarding')) r(role)
     cross join (values
       ('public.fiscal_assinatura_contexto(uuid)'),
       ('public.fiscal_reivindicar_teste(uuid, jsonb)'),
       ('public.fiscal_registrar_assinatura(uuid, text, boolean, timestamptz, text, text, text, text)'),
       ('public.fiscal_aplicar_evento_assinatura(text, text, text, text, jsonb, timestamptz)')) f(fn)
     where has_function_privilege(r.role, f.fn, 'EXECUTE')),
  'estado da assinatura: só service_role executa as funções de public');
select ok(not exists (
    select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(role)
     where has_function_privilege(r.role, 'nofiscal.emission_block(uuid)', 'EXECUTE')),
  'estado da assinatura: só o motor executa emission_block');

-- ---------------------------------------------------------------------------------------
-- C3: número só emite verificado e não revogado
insert into nofiscal.fiscal_phones (id, tenant_id, phone_e164, role)
values ('f1800000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001', '+5511987654321', 'authorized');

set local role nofiscal_service;
select is((select count(*)::int from nofiscal.emitting_phone('+5511987654321')), 0,
  'número só emite verificado e não revogado: sem verified_at não emite');
update nofiscal.fiscal_phones set verified_at = now() where id = 'f1800000-0000-4000-8000-000000000001';
select results_eq(
  $$select phone_id, tenant_id from nofiscal.emitting_phone('+5511987654321')$$,
  $$values ('f1800000-0000-4000-8000-000000000001'::uuid, 'f1700000-0000-4000-8000-000000000001'::uuid)$$,
  'número só emite verificado e não revogado: verificado emite pelo tenant dele');
update nofiscal.fiscal_phones set revoked_at = now() where id = 'f1800000-0000-4000-8000-000000000001';
select is((select count(*)::int from nofiscal.emitting_phone('+5511987654321')), 0,
  'número só emite verificado e não revogado: revogado para na hora');
reset role;

select throws_ok(
  $$insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role)
    values ('f1700000-0000-4000-8000-000000000001', '11987654321', 'authorized')$$,
  '23514', null, 'número só emite verificado e não revogado: telefone em E.164');
insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role, verified_at)
values ('f1700000-0000-4000-8000-000000000001', '+5511900000001', 'owner', now());
select throws_ok(
  $$update nofiscal.fiscal_phones set revoked_at = now() where phone_e164 = '+5511900000001'$$,
  '23514', null, 'número só emite verificado e não revogado: o número do dono não é revogável');

-- ---------------------------------------------------------------------------------------
-- C4: número em um único tenant
select throws_ok(
  $$insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role)
    values ('f1700000-0000-4000-8000-000000000002', '+5511987654321', 'authorized')$$,
  '23505', null, 'número em um único tenant: o mesmo número em outro tenant é recusado');
select throws_ok(
  $$insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role)
    values ('f1700000-0000-4000-8000-000000000001', '+5511987654321', 'authorized')$$,
  '23505', null, 'número em um único tenant: nem repetido no mesmo tenant');
select is(
  (select count(*)::int from nofiscal.fiscal_phones where phone_e164 = '+5511987654321'),
  1, 'número em um único tenant: sobra uma linha');

-- ---------------------------------------------------------------------------------------
-- C9: papel do cadastro só grava o próprio tenant
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'nofiscal' and has_function_privilege('nofiscal_onboarding', p.oid, 'EXECUTE')),
  2, 'papel do cadastro só grava o próprio tenant: executa exatamente duas funções de nofiscal');
select ok(has_function_privilege('nofiscal_onboarding',
    'nofiscal.onboarding_set_certificate(uuid, uuid, text, text, text, timestamptz)', 'EXECUTE')
  and has_function_privilege('nofiscal_onboarding', 'nofiscal.onboarding_delete_certificate(uuid, uuid)', 'EXECUTE'),
  'papel do cadastro só grava o próprio tenant: as duas são as de cadastro');
select ok(not exists (
    select 1 from (values ('nofiscal_service'), ('anon'), ('authenticated'), ('service_role')) r(role)
     cross join (values
       ('nofiscal.onboarding_set_certificate(uuid, uuid, text, text, text, timestamptz)'),
       ('nofiscal.onboarding_delete_certificate(uuid, uuid)')) f(fn)
     where has_function_privilege(r.role, f.fn, 'EXECUTE')),
  'papel do cadastro só grava o próprio tenant: nofiscal_service e papéis de fora não executam as duas');
select ok(not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
     where n.nspname in ('nofiscal', 'public', 'vault') and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and has_table_privilege('nofiscal_onboarding', c.oid, p.priv)),
  'papel do cadastro só grava o próprio tenant: nenhuma tabela de nofiscal, public ou vault');
select ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'vault' and p.proname like '%decrypt%'
       and has_function_privilege('nofiscal_onboarding', p.oid, 'EXECUTE')),
  'papel do cadastro só grava o próprio tenant: sem descriptografia do Supabase Vault');
select ok(
  (select not rolcanlogin and not rolinherit from pg_roles where rolname = 'nofiscal_onboarding'),
  'papel do cadastro só grava o próprio tenant: nologin noinherit');

set local role nofiscal_onboarding;
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000003', 'f1700000-0000-4000-8000-000000000001',
    'UEZYLUVTVFJBTkhP', 'x', 'CN=EMPRESA A TESTE:11444777000161', now() + interval '1 year'),
  'FORBIDDEN', 'papel do cadastro só grava o próprio tenant: usuário sem memberships é recusado');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000002', 'f1700000-0000-4000-8000-000000000001',
    'UEZYLUI=', 'x', 'CN=EMPRESA A TESTE:11444777000161', now() + interval '1 year'),
  'FORBIDDEN', 'papel do cadastro só grava o próprio tenant: dono de outro tenant é recusado');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000003',
    'UEZYLUM=', 'x', 'CN=EMPRESA C TESTE:33444555000172', now() + interval '1 year'),
  'FORBIDDEN', 'papel do cadastro só grava o próprio tenant: tenant sem client_id é recusado');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-0000000000ff',
    'UEZYLUM=', 'x', 'CN=X:11444777000161', now() + interval '1 year'),
  'FORBIDDEN', 'papel do cadastro só grava o próprio tenant: tenant inexistente é recusado');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001',
    'UEZYLU5PVk8=', 'senha-nova', 'CN=EMPRESA A TESTE:11444777000161', now() + interval '1 year'),
  'OK', 'papel do cadastro só grava o próprio tenant: o dono grava o A1 do próprio tenant');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001',
    'UEZYLU9VVFJP', 'x', 'CN=OUTRA EMPRESA:99888777000166', now() + interval '1 year'),
  'CERT_CNPJ_DIFERENTE', 'papel do cadastro só grava o próprio tenant: CNPJ de outro titular é recusado');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001',
    'UEZYLVZFTkM=', 'x', 'CN=EMPRESA A TESTE:11444777000161', now() - interval '1 day'),
  'CERT_VENCIDO', 'papel do cadastro só grava o próprio tenant: certificado vencido é recusado');
select is(public.agente_fiscal_test_count('select count(*) from nofiscal.fiscal_certificates'), 'denied',
  'papel do cadastro só grava o próprio tenant: não lê fiscal_certificates');
select is(public.agente_fiscal_test_count('select count(*) from public.memberships'), 'denied',
  'papel do cadastro só grava o próprio tenant: não lê memberships');
select throws_ok($$select * from nofiscal.read_certificate('f1700000-0000-4000-8000-000000000001')$$,
  '42501', null, 'papel do cadastro só grava o próprio tenant: não lê o A1');
select throws_ok(
  $$select nofiscal.upsert_certificate('f1700000-0000-4000-8000-000000000002', 'eA==', 'x', 'CN=X', now() + interval '1 year')$$,
  '42501', null, 'papel do cadastro só grava o próprio tenant: não chama upsert_certificate direto');
reset role;

select results_eq(
  $$select pfx_base64, password from nofiscal.read_certificate('f1700000-0000-4000-8000-000000000001')$$,
  $$values ('UEZYLU5PVk8='::text, 'senha-nova'::text)$$,
  'papel do cadastro só grava o próprio tenant: o A1 gravado é o do dono');
select results_eq(
  $$select pfx_base64 from nofiscal.read_certificate('f1700000-0000-4000-8000-000000000002')$$,
  $$values ('UEZYLUI='::text)$$,
  'papel do cadastro só grava o próprio tenant: o A1 do outro tenant não mudou');
select is(
  (select count(*)::int from nofiscal.fiscal_certificates where tenant_id = 'f1700000-0000-4000-8000-000000000003'),
  0, 'papel do cadastro só grava o próprio tenant: recusado não grava');

-- Limite: 5 tentativas por hora por tenant (Unresolved 17). A já usou 3 (OK, CNPJ, vencido).
set local role nofiscal_onboarding;
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001',
    null, null, null, null),
  'INVALID', 'limite de tentativas no banco: a 4ª conta mesmo sem certificado');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001',
    null, null, null, null),
  'INVALID', 'limite de tentativas no banco: a 5ª ainda passa');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001',
    'UEZYLUE=', 'x', 'CN=EMPRESA A TESTE:11444777000161', now() + interval '1 year'),
  'RATE_LIMITED', 'limite de tentativas no banco: a 6ª na mesma hora é recusada');
-- Recusas por falta de vínculo não contam: um estranho não trava o dono de B.
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000003', 'f1700000-0000-4000-8000-000000000002',
    null, null, null, null),
  'FORBIDDEN', 'limite de tentativas no banco: estranho recusado');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000003', 'f1700000-0000-4000-8000-000000000002',
    null, null, null, null), 'FORBIDDEN', 'limite de tentativas no banco: estranho recusado de novo');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000003', 'f1700000-0000-4000-8000-000000000002',
    null, null, null, null), 'FORBIDDEN', 'limite de tentativas no banco: estranho recusado pela 3ª vez');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000003', 'f1700000-0000-4000-8000-000000000002',
    null, null, null, null), 'FORBIDDEN', 'limite de tentativas no banco: estranho recusado pela 4ª vez');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000003', 'f1700000-0000-4000-8000-000000000002',
    null, null, null, null), 'FORBIDDEN', 'limite de tentativas no banco: estranho recusado pela 5ª vez');
select is(
  nofiscal.onboarding_set_certificate('f1500000-0000-4000-8000-000000000002', 'f1700000-0000-4000-8000-000000000002',
    null, null, null, null),
  'INVALID', 'limite de tentativas no banco: o dono de B não foi travado pelo estranho');
reset role;

-- ---------------------------------------------------------------------------------------
-- C10: apagar remove o segredo
create temp table agente_fiscal_segredo on commit drop as
  select vault_secret_id from nofiscal.fiscal_certificates where tenant_id = 'f1700000-0000-4000-8000-000000000001';
grant select on agente_fiscal_segredo to nofiscal_onboarding;

set local role nofiscal_onboarding;
select is(
  nofiscal.onboarding_delete_certificate('f1500000-0000-4000-8000-000000000002', 'f1700000-0000-4000-8000-000000000001'),
  'FORBIDDEN', 'apagar remove o segredo: dono de outro tenant não apaga');
reset role;
select is(
  (select count(*)::int from nofiscal.fiscal_certificates where tenant_id = 'f1700000-0000-4000-8000-000000000001'),
  1, 'apagar remove o segredo: recusado não apaga');

set local role nofiscal_onboarding;
select is(
  nofiscal.onboarding_delete_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001'),
  'OK', 'apagar remove o segredo: o dono apaga');
-- Apagar de novo não falha (DELETE idempotente) e não conta no limite.
select is(
  nofiscal.onboarding_delete_certificate('f1500000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001'),
  'OK', 'apagar remove o segredo: apagar de novo responde OK');
reset role;

select is(
  (select count(*)::int from vault.secrets where id = (select vault_secret_id from agente_fiscal_segredo)),
  0, 'apagar remove o segredo: o segredo saiu do Supabase Vault');
select is(
  (select count(*)::int from nofiscal.fiscal_certificates where tenant_id = 'f1700000-0000-4000-8000-000000000001'),
  0, 'apagar remove o segredo: fiscal_certificates não tem a linha do tenant');
select is(nofiscal.emission_block('f1700000-0000-4000-8000-000000000001'), 'CERT_MISSING',
  'apagar remove o segredo: a emissão real pausa');
select results_eq(
  $$select pfx_base64 from nofiscal.read_certificate('f1700000-0000-4000-8000-000000000002')$$,
  $$values ('UEZYLUI='::text)$$,
  'apagar remove o segredo: o A1 do outro tenant continua');

-- ---------------------------------------------------------------------------------------
-- C11: teste só por hash
select columns_are('nofiscal', 'fiscal_trial_claims', array['kind', 'hash', 'created_at'],
  'teste só por hash: só tipo, hash e data');
select throws_ok(
  $$insert into nofiscal.fiscal_trial_claims (kind, hash) values ('cpf', '12345678909')$$,
  '23514', null, 'teste só por hash: valor em claro é recusado');
select throws_ok(
  $$insert into nofiscal.fiscal_trial_claims (kind, hash) values ('email', 'fulano@example.test')$$,
  '23514', null, 'teste só por hash: e-mail em claro é recusado');
select throws_ok(
  $$insert into nofiscal.fiscal_trial_claims (kind, hash) values ('rg', encode(sha256('x'::bytea), 'hex'))$$,
  '23514', null, 'teste só por hash: só cpf, cnpj, email e phone');
select lives_ok(
  $$insert into nofiscal.fiscal_trial_claims (kind, hash) values ('email', encode(sha256('sal+fulano@example.test'::bytea), 'hex'))$$,
  'teste só por hash: sha256 em hex é aceito');
select throws_ok(
  $$insert into nofiscal.fiscal_trial_claims (kind, hash) values ('email', encode(sha256('sal+fulano@example.test'::bytea), 'hex'))$$,
  '23505', null, 'teste só por hash: unique (kind, hash)');
select lives_ok(
  $$insert into nofiscal.fiscal_trial_claims (kind, hash) values ('phone', encode(sha256('sal+fulano@example.test'::bytea), 'hex'))$$,
  'teste só por hash: o mesmo hash em outro tipo é outra reivindicação');

set local role service_role;
select is(
  public.fiscal_reivindicar_teste('f1700000-0000-4000-8000-000000000002', jsonb_build_object(
    'cnpj', encode(sha256('sal+22333444000181'::bytea), 'hex'),
    'email', encode(sha256('sal+dono-b@example.test'::bytea), 'hex'),
    'phone', encode(sha256('sal++5511900000002'::bytea), 'hex'))),
  true, 'teste só por hash: primeira reivindicação dá direito ao teste');
select is(
  public.fiscal_reivindicar_teste('f1700000-0000-4000-8000-000000000002', jsonb_build_object(
    'cnpj', encode(sha256('sal+55666777000188'::bytea), 'hex'),
    'email', encode(sha256('sal+outro@example.test'::bytea), 'hex'),
    'phone', encode(sha256('sal++5511900000002'::bytea), 'hex'))),
  false, 'teste só por hash: um valor repetido tira o teste');
reset role;
select is((select count(*)::int from nofiscal.fiscal_trial_claims), 5,
  'teste só por hash: a reivindicação recusada não grava nada');

set local role nofiscal_service;
select is(public.agente_fiscal_test_count('select count(*) from nofiscal.fiscal_trial_claims'), 'denied',
  'teste só por hash: o motor não lê as reivindicações');
reset role;

-- ---------------------------------------------------------------------------------------
-- C31 (banco): modelo único sem diferenciar maiúsculas
insert into nofiscal.fiscal_invoices (id, tenant_id, external_id, payload)
values ('f1900000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001', 'pedido-modelo', '{}');
insert into nofiscal.fiscal_models (
  tenant_id, nome, tomador_documento, tomador_nome, codigo_servico_nacional, descricao, created_from_invoice_id
) values ('f1700000-0000-4000-8000-000000000001', 'Prontia', '12345678000195', 'Prontia Saúde', '010701',
          'Consultoria', 'f1900000-0000-4000-8000-000000000001');
select throws_ok(
  $$insert into nofiscal.fiscal_models (tenant_id, nome, tomador_documento, tomador_nome, codigo_servico_nacional, descricao, created_from_invoice_id)
    values ('f1700000-0000-4000-8000-000000000001', 'PRONTIA', '12345678000195', 'Prontia Saúde', '010701', 'Outra', 'f1900000-0000-4000-8000-000000000001')$$,
  '23505', null, 'modelo único sem diferenciar maiúsculas: PRONTIA repete Prontia no mesmo tenant');
select lives_ok(
  $$insert into nofiscal.fiscal_models (tenant_id, nome, tomador_documento, tomador_nome, codigo_servico_nacional, descricao, created_from_invoice_id)
    values ('f1700000-0000-4000-8000-000000000002', 'prontia', '12345678000195', 'Prontia Saúde', '010701', 'Outra', 'f1900000-0000-4000-8000-000000000001')$$,
  'modelo único sem diferenciar maiúsculas: outro tenant pode usar o nome');
select throws_ok(
  $$insert into nofiscal.fiscal_models (tenant_id, nome, tomador_documento, tomador_nome, codigo_servico_nacional, descricao, created_from_invoice_id)
    values ('f1700000-0000-4000-8000-000000000001', 'Outro', '123', 'X', '010701', 'Y', 'f1900000-0000-4000-8000-000000000001')$$,
  '23514', null, 'modelo único sem diferenciar maiúsculas: documento do tomador com 11 ou 14 dígitos');

-- ---------------------------------------------------------------------------------------
-- Pedidos (lote B usa): estados e expiração em 24h.
insert into nofiscal.fiscal_requests (id, tenant_id, phone_id, kind)
values ('f1a00000-0000-4000-8000-000000000001', 'f1700000-0000-4000-8000-000000000001',
        'f1800000-0000-4000-8000-000000000001', 'emitir');
select results_eq(
  $$select status, expires_at - created_at, message_count, ai_input_tokens, ai_output_tokens
      from nofiscal.fiscal_requests where id = 'f1a00000-0000-4000-8000-000000000001'$$,
  $$values ('awaiting_confirmation'::text, interval '24 hours', 0, 0, 0)$$,
  'pedido nasce aguardando confirmação e expira em 24h');
select throws_ok(
  $$update nofiscal.fiscal_requests set status = 'emitido' where id = 'f1a00000-0000-4000-8000-000000000001'$$,
  '23514', null, 'pedido só tem os 4 estados');

-- ---------------------------------------------------------------------------------------
-- Grants do motor nas tabelas novas (Landing, lote A) e o que continua negado.
set local role nofiscal_service;
select lives_ok(
  $$update nofiscal.fiscal_tenants set contador_email = 'contador@example.test' where id = 'f1700000-0000-4000-8000-000000000001'$$,
  'nofiscal_service grava o e-mail do contador');
select throws_ok(
  $$update nofiscal.fiscal_tenants set codigo_servico_nacional = '999999' where id = 'f1700000-0000-4000-8000-000000000001'$$,
  '42501', null, 'nofiscal_service não muda a configuração fiscal');
select throws_ok(
  $$update nofiscal.fiscal_tenants set trial_ends_at = now() + interval '1 year' where id = 'f1700000-0000-4000-8000-000000000001'$$,
  '42501', null, 'nofiscal_service não estende o teste');
select throws_ok(
  $$update nofiscal.fiscal_subscriptions set status = 'paga'$$,
  '42501', null, 'nofiscal_service não muda a assinatura');
select is(public.agente_fiscal_test_count('select count(*) from nofiscal.fiscal_certificate_attempts'), 'denied',
  'nofiscal_service não lê as tentativas do certificado');
select is(public.agente_fiscal_test_count('select count(*) from nofiscal.fiscal_phones'), '2',
  'nofiscal_service lê os números');
reset role;

-- Lote B: marcas de "uma vez só" (mensagem repetida e avisos) e estado da conversa.
set local role nofiscal_service;
select lives_ok(
  $$insert into nofiscal.fiscal_agent_once (chave, tenant_id) values ('wa:wamid.teste-1', null)$$,
  'nofiscal_service marca uma mensagem');
select throws_ok(
  $$insert into nofiscal.fiscal_agent_once (chave) values ('wa:wamid.teste-1')$$,
  '23505', null, 'a mesma marca não entra duas vezes');
select lives_ok($$delete from nofiscal.fiscal_agent_once where chave = 'wa:wamid.teste-1'$$,
  'nofiscal_service desfaz a marca de uma mensagem que falhou');
select throws_ok(
  $$update nofiscal.fiscal_requests set etapa = 'emitir' where id = 'f1a00000-0000-4000-8000-000000000001'$$,
  '23514', null, 'pedido só tem as etapas da conversa');
select lives_ok(
  $$update nofiscal.fiscal_requests set etapa = 'confirmar', conversa = '{"valor": "10.00"}'
     where id = 'f1a00000-0000-4000-8000-000000000001'$$,
  'nofiscal_service grava a etapa e o estado da conversa');
reset role;
select throws_ok(
  $$insert into nofiscal.fiscal_agent_once (chave) values ('')$$,
  '23514', null, 'marca sem chave é recusada');

-- v2, lote D: cota de PDFs lidos pela IA (no máximo 30 por tenant).
set local role nofiscal_service;
select lives_ok(
  $$insert into nofiscal.fiscal_importacao_pdfs (tenant_id, enviados) values ('f1700000-0000-4000-8000-000000000001', 30)$$,
  'nofiscal_service registra os PDFs enviados');
select throws_ok(
  $$update nofiscal.fiscal_importacao_pdfs set enviados = 31 where tenant_id = 'f1700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'a cota de PDFs não passa de 30');
reset role;

-- Sentinela: anon e authenticated sem acesso a nenhuma tabela nova.
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'nofiscal' and c.relkind in ('r', 'p', 'v', 'm')),
  18, 'nofiscal tem as 5 tabelas do motor e as 13 do agente (cota de PDFs da v2, lote D; cupons e usos de cupom, 20261025090000)');
select ok(not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
     where n.nspname = 'nofiscal' and c.relkind in ('r', 'p', 'v', 'm')
       and has_table_privilege(r.role, c.oid, 'SELECT')),
  'anon, authenticated e service_role sem SELECT em nenhuma tabela de nofiscal');
select ok(not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'nofiscal' and c.relkind = 'r' and not c.relrowsecurity),
  'RLS ligada em todas as tabelas de nofiscal');

select * from finish();
rollback;
