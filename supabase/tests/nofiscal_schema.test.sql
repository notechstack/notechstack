-- Nó Fiscal: checks C12, C14, C16, C18, C30, C35, C37, C38, C40, C44 de
-- .checks/nfse-automatica-prontia.md. Tudo roda numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- No Postgres 15 criar um papel não dá ao criador o direito de assumi-lo.
-- O grant vive só nesta transação, que é desfeita no fim.
grant nofiscal_service to postgres;
-- O pgTAP mora em extensions; o papel do motor precisa enxergá-lo só durante o teste.
grant usage on schema extensions to nofiscal_service;

-- Executa uma consulta com o papel corrente e devolve a contagem, ou 'denied'
-- quando o papel não tem privilégio. Assim um papel barrado por grant e um
-- papel barrado por RLS passam pela mesma asserção.
create function public.nofiscal_test_count(p_sql text)
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
grant execute on function public.nofiscal_test_count(text)
  to anon, authenticated, nofiscal_service, supabase_read_only_user;

insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit
) values
  ('a0000000-0000-4000-8000-00000000000a', '56210013000140', 'PRIMECARE TESTE', '3550308', repeat('a', 64), 'pro', 5000),
  ('b0000000-0000-4000-8000-00000000000b', '11222333000181', 'OUTRO TESTE', '3550308', repeat('b', 64), 'inicial', 300);

insert into nofiscal.fiscal_dps_series (tenant_id, serie, next_number)
values ('a0000000-0000-4000-8000-00000000000a', '1', 41);

select nofiscal.upsert_certificate(
  'a0000000-0000-4000-8000-00000000000a', 'UEZYLUE=', 'senha-tenant-a', 'CN=A', now() + interval '200 days');
select nofiscal.upsert_certificate(
  'b0000000-0000-4000-8000-00000000000b', 'UEZYLUI=', 'senha-tenant-b', 'CN=B', now() + interval '10 days');
select nofiscal.set_webhook_secret('a0000000-0000-4000-8000-00000000000a', 'whsec-tenant-a');

-- checks de domínio
select throws_ok(
  $$insert into nofiscal.fiscal_invoices (tenant_id, external_id, status, payload)
    values ('a0000000-0000-4000-8000-00000000000a', 'dominio-1', 'aprovada', '{}')$$,
  '23514', null, 'checks de domínio: status fora dos 8 valores é recusado');
select throws_ok(
  $$insert into nofiscal.fiscal_tenants (cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit)
    values ('123', 'X', '3550308', repeat('c', 64), 'pro', 1)$$,
  '23514', null, 'checks de domínio: CNPJ sem 14 dígitos é recusado');
select throws_ok(
  $$insert into nofiscal.fiscal_tenants (cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit)
    values ('99888777000166', 'X', '355', repeat('d', 64), 'pro', 1)$$,
  '23514', null, 'checks de domínio: código IBGE sem 7 dígitos é recusado');

-- C40
select is(
  (select ambiente from nofiscal.fiscal_tenants where id = 'a0000000-0000-4000-8000-00000000000a'),
  'producao_restrita', 'ambiente restrito por padrão');
select throws_ok(
  $$update nofiscal.fiscal_tenants set ambiente = 'homologacao' where id = 'a0000000-0000-4000-8000-00000000000a'$$,
  '23514', null, 'ambiente restrito por padrão: só producao_restrita e producao');

-- C12
insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload)
values ('a0000000-0000-4000-8000-00000000000a', 'pp-1', '{}');
select throws_ok(
  $$insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload)
    values ('a0000000-0000-4000-8000-00000000000a', 'pp-1', '{}')$$,
  '23505', null, 'external_id único por tenant: a segunda venda igual falha');
select lives_ok(
  $$insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload)
    values ('b0000000-0000-4000-8000-00000000000b', 'pp-1', '{}')$$,
  'external_id único por tenant: outro tenant pode usar o mesmo id');
select is(
  (select count(*)::int from nofiscal.fiscal_invoices
    where tenant_id = 'a0000000-0000-4000-8000-00000000000a' and external_id = 'pp-1'),
  1, 'external_id único por tenant: sobra uma única linha');

-- C14
select is(nofiscal.allocate_dps_number('a0000000-0000-4000-8000-00000000000a', '1'), 41::bigint,
  'numeração consecutiva: primeiro número é o next_number cadastrado');
select is(nofiscal.allocate_dps_number('a0000000-0000-4000-8000-00000000000a', '1'), 42::bigint,
  'numeração consecutiva: segundo número é o seguinte');
select throws_ok(
  $$select nofiscal.allocate_dps_number('a0000000-0000-4000-8000-00000000000a', '9')$$,
  'P0002', 'NOFISCAL_SERIE_NOT_FOUND', 'série inexistente');

-- C16
insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, dps_serie, dps_numero)
values ('a0000000-0000-4000-8000-00000000000a', 'pp-2', '{}', '1', 41);
select throws_ok(
  $$insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, dps_serie, dps_numero)
    values ('a0000000-0000-4000-8000-00000000000a', 'pp-3', '{}', '1', 41)$$,
  '23505', null, 'número de DPS único');

-- C18 (parte banco)
select throws_ok(
  $$update nofiscal.fiscal_invoices set attempts = 6
    where tenant_id = 'a0000000-0000-4000-8000-00000000000a' and external_id = 'pp-1'$$,
  '23514', null, 'attempts limitado a 5');

-- C44
select nofiscal.upsert_certificate(
  'a0000000-0000-4000-8000-00000000000a', 'UEZYLUEy', 'senha-tenant-a-nova', 'CN=A2', now() + interval '365 days');
select is(
  (select count(*)::int from nofiscal.fiscal_certificates where tenant_id = 'a0000000-0000-4000-8000-00000000000a'),
  1, 'upsert_certificate troca o A1: um único certificado por tenant');
select is(
  (select subject from nofiscal.fiscal_certificates where tenant_id = 'a0000000-0000-4000-8000-00000000000a'),
  'CN=A2', 'upsert_certificate troca o A1: titular atualizado');

-- C30 e C37: o motor opera com nofiscal_service
set local role nofiscal_service;
select results_eq(
  $$select pfx_base64, password from nofiscal.read_certificate('a0000000-0000-4000-8000-00000000000a')$$,
  $$values ('UEZYLUEy'::text, 'senha-tenant-a-nova'::text)$$,
  'read_certificate devolve só o tenant pedido: certificado atual do tenant A');
select is(
  (select count(*)::int from nofiscal.read_certificate('a0000000-0000-4000-8000-00000000000a')),
  1, 'read_certificate devolve só o tenant pedido: uma linha');
select is(
  nofiscal.read_webhook_secret('a0000000-0000-4000-8000-00000000000a'), 'whsec-tenant-a',
  'segredo do callback só para nofiscal_service: o motor lê');
select lives_ok(
  $$insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload)
    values ('a0000000-0000-4000-8000-00000000000a', 'pp-servico', '{}')$$,
  'nofiscal_service opera o schema: grava nota');
select lives_ok(
  $$update nofiscal.fiscal_invoices set status = 'signing'
    where tenant_id = 'a0000000-0000-4000-8000-00000000000a' and external_id = 'pp-servico'$$,
  'nofiscal_service opera o schema: muda status');
select is(nofiscal.allocate_dps_number('a0000000-0000-4000-8000-00000000000a', '1'), 43::bigint,
  'nofiscal_service opera o schema: aloca número');
select is(public.nofiscal_test_count('select count(*) from nofiscal.fiscal_tenants'), '2',
  'nofiscal_service opera o schema: lê os tenants');

-- C38: nofiscal_service não sai do schema
select is(public.nofiscal_test_count('select count(*) from public.clients'), 'denied',
  'nofiscal_service não sai do schema: public.* negado');
select is(public.nofiscal_test_count('select count(*) from vault.decrypted_secrets'), 'denied',
  'nofiscal_service não sai do schema: vault.decrypted_secrets negado');
select throws_ok(
  $$select nofiscal.upsert_certificate('a0000000-0000-4000-8000-00000000000a', 'eA==', 'x', 'CN=X', now())$$,
  '42501', null, 'nofiscal_service não sai do schema: não troca certificado');
select throws_ok(
  $$update nofiscal.fiscal_tenants set active = false where id = 'a0000000-0000-4000-8000-00000000000a'$$,
  '42501', null, 'nofiscal_service não sai do schema: não altera tenant');
reset role;

-- C35: papéis de fora
set local role anon;
select ok(public.nofiscal_test_count('select count(*) from nofiscal.fiscal_invoices') in ('0', 'denied'),
  'papéis de fora não leem nofiscal: anon');
select throws_ok($$select nofiscal.read_webhook_secret('a0000000-0000-4000-8000-00000000000a')$$,
  '42501', null, 'segredo do callback só para nofiscal_service: anon negado');
reset role;

set local role authenticated;
select ok(public.nofiscal_test_count('select count(*) from nofiscal.fiscal_invoices') in ('0', 'denied'),
  'papéis de fora não leem nofiscal: authenticated');
select throws_ok($$select * from nofiscal.read_certificate('a0000000-0000-4000-8000-00000000000a')$$,
  '42501', null, 'papéis de fora não leem nofiscal: authenticated não chama read_certificate');
reset role;

-- supabase_read_only_user é reservado (nem o postgres o assume), então a
-- verificação usa as funções de privilégio do Postgres. Ele tem pg_read_all_data
-- e BYPASSRLS, então lê as tabelas de nofiscal: aceito por Lucca em 20/10/2026
-- (C35 renegociado). O que continua proibido é obter o A1.
select ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'vault' and p.proname like '%decrypt%'
       and has_function_privilege('supabase_read_only_user', p.oid, 'EXECUTE')),
  'papel de leitura não lê o A1: sem EXECUTE na descriptografia do Supabase Vault');
select ok(not has_function_privilege('supabase_read_only_user', 'nofiscal.read_certificate(uuid)', 'EXECUTE'),
  'papel de leitura não lê o A1: sem EXECUTE em read_certificate');

-- C35 sobre o conjunto inteiro (verificação, rodada 1): todas as tabelas de
-- nofiscal, as duas funções de leitura e a descriptografia do Vault, para anon
-- e authenticated.
-- Agente fiscal (lote A, Landing de .checks/agente-fiscal-whatsapp.md): 5 tabelas do motor
-- mais 9 do agente. A contagem continua exata: tabela nova exige rever esta prova.
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'nofiscal' and c.relkind in ('r', 'p', 'v', 'm')),
  14, 'papéis de fora não leem nofiscal: o schema tem as 14 tabelas avaliadas abaixo');
select ok(not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join (values ('anon'), ('authenticated')) r(role)
     where n.nspname = 'nofiscal' and c.relkind in ('r', 'p', 'v', 'm')
       and has_table_privilege(r.role, c.oid, 'SELECT')),
  'papéis de fora não leem nofiscal: anon e authenticated sem SELECT em nenhuma tabela');
select ok(not exists (
    select 1 from (values ('anon'), ('authenticated')) r(role)
     cross join (values ('nofiscal.read_certificate(uuid)'), ('nofiscal.read_webhook_secret(uuid)')) f(fn)
     where has_function_privilege(r.role, f.fn, 'EXECUTE')),
  'papéis de fora não leem nofiscal: anon e authenticated sem EXECUTE em read_certificate e read_webhook_secret');
select ok(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     cross join (values ('anon'), ('authenticated')) r(role)
     where n.nspname = 'vault' and p.proname like '%decrypt%'
       and has_function_privilege(r.role, p.oid, 'EXECUTE')),
  'papéis de fora não leem nofiscal: anon e authenticated sem EXECUTE na descriptografia do Supabase Vault');

select ok((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'vault' and p.proname like '%decrypt%') > 0,
  'papéis de fora não leem nofiscal: existe função de descriptografia no Vault para as asserções acima avaliarem');

-- C38 sobre o conjunto inteiro: nenhuma relação de public é legível pelo motor.
select ok(not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and has_table_privilege('nofiscal_service', c.oid, 'SELECT')),
  'nofiscal_service não sai do schema: sem SELECT em nenhuma relação de public');

-- Lote 2b: percentual aproximado dos tributos do Simples, por tenant.
select has_column('nofiscal', 'fiscal_tenants', 'p_tot_trib_sn', 'p_tot_trib_sn existe em fiscal_tenants');
select col_is_null('nofiscal', 'fiscal_tenants', 'p_tot_trib_sn', 'p_tot_trib_sn nasce nulo');
select throws_ok($$update nofiscal.fiscal_tenants set p_tot_trib_sn = 100.01 where id = 'a0000000-0000-4000-8000-00000000000a'$$,
  '23514', null, 'p_tot_trib_sn acima de 100 é recusado');

select * from finish();
rollback;
