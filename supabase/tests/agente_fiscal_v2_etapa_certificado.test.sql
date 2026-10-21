-- Agente fiscal v2: o A1 gravado leva `certificado` a `dados_fiscais` (migração
-- 20261024140000_agente_fiscal_v2_etapa_certificado.sql; Landing do lote E). Tudo numa transação desfeita.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(7);

grant nofiscal_onboarding to postgres;
grant usage on schema extensions to nofiscal_onboarding;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('e1400000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'etapa-a1@example.test', '{"role":"FISCAL_CLIENT"}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('e1410000-0000-4000-8000-000000000001', 'Etapa A1 1', 'agente-fiscal-etapa-a1-1'),
  ('e1410000-0000-4000-8000-000000000002', 'Etapa A1 2', 'agente-fiscal-etapa-a1-2'),
  ('e1410000-0000-4000-8000-000000000003', 'Etapa A1 3', 'agente-fiscal-etapa-a1-3');
insert into public.memberships (user_id, client_id, role) values
  ('e1400000-0000-4000-8000-000000000001', 'e1410000-0000-4000-8000-000000000001', 'CLIENT'),
  ('e1400000-0000-4000-8000-000000000001', 'e1410000-0000-4000-8000-000000000002', 'CLIENT'),
  ('e1400000-0000-4000-8000-000000000001', 'e1410000-0000-4000-8000-000000000003', 'CLIENT');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id, onboarding_etapa
) values
  ('e1420000-0000-4000-8000-000000000001', '00000014000105', 'ETAPA A1 UM', '3550308', repeat('e', 64), 'pro', 100,
   'e1410000-0000-4000-8000-000000000001', 'certificado'),
  ('e1420000-0000-4000-8000-000000000002', '00000014000296', 'ETAPA A1 DOIS', '3550308', repeat('f', 64), 'pro', 100,
   'e1410000-0000-4000-8000-000000000002', 'clientes'),
  ('e1420000-0000-4000-8000-000000000003', '00000014000377', 'ETAPA A1 TRES', '3550308', repeat('d', 64), 'inicial', 20,
   'e1410000-0000-4000-8000-000000000003', 'certificado');

set local role nofiscal_onboarding;
select is(
  nofiscal.onboarding_set_certificate('e1400000-0000-4000-8000-000000000001', 'e1420000-0000-4000-8000-000000000001',
    'UEZYLUVUQVBB', 'x', 'CN=ETAPA A1 UM:00000014000105', now() + interval '1 year'),
  'OK', 'A1 gravado no tenant em certificado');
select is(
  nofiscal.onboarding_set_certificate('e1400000-0000-4000-8000-000000000001', 'e1420000-0000-4000-8000-000000000002',
    'UEZYLURPSVM=', 'x', 'CN=ETAPA A1 DOIS:00000014000296', now() + interval '1 year'),
  'OK', 'A1 renovado com o onboarding mais adiante');
select is(
  nofiscal.onboarding_set_certificate('e1400000-0000-4000-8000-000000000001', 'e1420000-0000-4000-8000-000000000003',
    'UEZYLVRSRVM=', 'x', 'CN=OUTRA EMPRESA:99888777000166', now() + interval '1 year'),
  'CERT_CNPJ_DIFERENTE', 'A1 de outro CNPJ é recusado');
reset role;

select is((select onboarding_etapa from nofiscal.fiscal_tenants where id = 'e1420000-0000-4000-8000-000000000001'),
  'dados_fiscais', 'certificado → dados_fiscais quando o A1 é gravado');
select is((select onboarding_etapa from nofiscal.fiscal_tenants where id = 'e1420000-0000-4000-8000-000000000002'),
  'clientes', 'a etapa nunca volta: renovar o A1 em clientes não muda nada');
select is((select onboarding_etapa from nofiscal.fiscal_tenants where id = 'e1420000-0000-4000-8000-000000000003'),
  'certificado', 'A1 recusado não avança a etapa');
select ok(has_function_privilege('nofiscal_onboarding',
    'nofiscal.onboarding_set_certificate(uuid, uuid, text, text, text, timestamptz)', 'EXECUTE')
  and not has_function_privilege('nofiscal_service',
    'nofiscal.onboarding_set_certificate(uuid, uuid, text, text, text, timestamptz)', 'EXECUTE'),
  'grants da v1 mantidos: só o papel do cadastro executa');

select * from finish();
rollback;
