-- Sandbox da API do parceiro (20261119100000_agente_fiscal_api_sandbox.sql): as três tabelas do sandbox ficam só
-- com o nofiscal_service (nem anon, nem authenticated, nem service_role leem); a chave entra só como hash, pela
-- função do service_role, e só em conta-mãe; o segredo do webhook sandbox vai ao Vault. Transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into nofiscal.fiscal_tenants (id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit)
values ('ac700000-0000-4000-8000-000000000001', '83444777000161', 'Sandbox Mãe', '3550308', repeat('3', 64), 'escritorio_5', 500);
insert into nofiscal.fiscal_tenants (id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, escritorio_tenant_id)
values ('ac700000-0000-4000-8000-000000000002', '84444777000161', 'Sandbox Cliente', '3550308', repeat('4', 64), 'escritorio_5', 500,
        'ac700000-0000-4000-8000-000000000001');

-- Tabelas e privilégios.
select has_table('nofiscal', t, t || ' existe')
  from unnest(array['fiscal_sandbox_contas', 'fiscal_sandbox_invoices', 'fiscal_sandbox_webhook_entregas']) t;
select ok(not has_table_privilege(r, 'nofiscal.' || t, 'select'), r || ' não lê ' || t)
  from unnest(array['anon', 'authenticated', 'service_role']) r,
       unnest(array['fiscal_sandbox_contas', 'fiscal_sandbox_invoices', 'fiscal_sandbox_webhook_entregas']) t;
select ok(has_table_privilege('nofiscal_service', 'nofiscal.' || t, 'select'), 'nofiscal_service lê ' || t)
  from unnest(array['fiscal_sandbox_contas', 'fiscal_sandbox_invoices', 'fiscal_sandbox_webhook_entregas']) t;
select ok(not has_column_privilege('nofiscal_service', 'nofiscal.fiscal_sandbox_contas', 'api_key_hash', 'update'),
  'nofiscal_service não troca a chave sandbox');
select ok(not has_table_privilege('nofiscal_service', 'nofiscal.fiscal_sandbox_contas', 'insert'),
  'nofiscal_service não cria conta sandbox');

-- Funções.
select ok(has_function_privilege('service_role', 'public.fiscal_definir_chave_sandbox(uuid, text, text)', 'execute'),
  'service_role define a chave sandbox');
select ok(not has_function_privilege(r, 'public.fiscal_definir_chave_sandbox(uuid, text, text)', 'execute'), r || ' não define a chave sandbox')
  from unnest(array['anon', 'authenticated', 'nofiscal_service']) r;
select ok(has_function_privilege('nofiscal_service', f, 'execute'), 'nofiscal_service executa ' || f)
  from unnest(array['nofiscal.set_sandbox_webhook_secret(uuid, text)', 'nofiscal.read_sandbox_webhook_secret(uuid)']) f;
select ok(not has_function_privilege(r, f, 'execute'), r || ' não executa ' || f)
  from unnest(array['anon', 'authenticated', 'service_role']) r,
       unnest(array['nofiscal.set_sandbox_webhook_secret(uuid, text)', 'nofiscal.read_sandbox_webhook_secret(uuid)']) f;

-- Chave: só conta-mãe; hash e prefixo juntos e no formato.
select is(public.fiscal_definir_chave_sandbox('ac700000-0000-4000-8000-000000000002', repeat('a', 64), 'nfk_test_AAAAAA') ->> 'erro',
  'CONTA_NAO_ENCONTRADA', 'empresa de escritório não tem chave sandbox própria');
select throws_ok($$select public.fiscal_definir_chave_sandbox('ac700000-0000-4000-8000-000000000001', repeat('a', 64), null)$$,
  '22023', null, 'hash sem prefixo é recusado');
select throws_ok($$select public.fiscal_definir_chave_sandbox('ac700000-0000-4000-8000-000000000001', repeat('a', 64), 'nfk_AAAAAA')$$,
  '23514', null, 'prefixo de chave de produção é recusado');
select is(public.fiscal_definir_chave_sandbox('ac700000-0000-4000-8000-000000000001', repeat('a', 64), 'nfk_test_AAAAAA') ->> 'ok',
  'true', 'conta-mãe recebe a chave sandbox');
select is(public.fiscal_definir_chave_sandbox('ac700000-0000-4000-8000-000000000001', repeat('b', 64), 'nfk_test_BBBBBB') ->> 'ok',
  'true', 'trocar a chave');
select is((select api_key_hash from nofiscal.fiscal_sandbox_contas where dono_tenant_id = 'ac700000-0000-4000-8000-000000000001'),
  repeat('b', 64), 'a troca substitui o hash');
select is((select count(*)::int from nofiscal.fiscal_tenants where api_key_hash = repeat('b', 64)), 0,
  'a chave sandbox nunca vai para fiscal_tenants.api_key_hash');

-- Segredo do webhook sandbox no Vault, separado do de produção.
select lives_ok($$select nofiscal.set_sandbox_webhook_secret('ac700000-0000-4000-8000-000000000001', 'whsec_test_um')$$, 'grava o segredo');
select is(nofiscal.read_sandbox_webhook_secret('ac700000-0000-4000-8000-000000000001'), 'whsec_test_um', 'lê o segredo');
select lives_ok($$select nofiscal.set_sandbox_webhook_secret('ac700000-0000-4000-8000-000000000001', 'whsec_test_dois')$$, 'troca o segredo');
select is(nofiscal.read_sandbox_webhook_secret('ac700000-0000-4000-8000-000000000001'), 'whsec_test_dois', 'lê o segredo novo');
select ok(nofiscal.read_webhook_secret('ac700000-0000-4000-8000-000000000001') is null, 'o webhook de produção não ganhou segredo');
select throws_ok($$select nofiscal.set_sandbox_webhook_secret('ac700000-0000-4000-8000-000000000002', 'x')$$,
  'P0002', null, 'sem conta sandbox, sem segredo');

-- Revogar: o hash sai; a linha fica (as notas sandbox continuam).
select is(public.fiscal_definir_chave_sandbox('ac700000-0000-4000-8000-000000000001', null, null) ->> 'ok', 'true', 'revoga');
select ok((select api_key_hash is null from nofiscal.fiscal_sandbox_contas where dono_tenant_id = 'ac700000-0000-4000-8000-000000000001'),
  'chave revogada');

-- Nota sandbox: status e roteiro só dos valores conhecidos; external_id e número únicos por empresa.
insert into nofiscal.fiscal_sandbox_invoices (dono_tenant_id, tenant_id, external_id, payload, dps_numero)
values ('ac700000-0000-4000-8000-000000000001', 'ac700000-0000-4000-8000-000000000002', 'v-1', '{}', 1);
select throws_ok($$insert into nofiscal.fiscal_sandbox_invoices (dono_tenant_id, tenant_id, external_id, payload, dps_numero)
  values ('ac700000-0000-4000-8000-000000000001', 'ac700000-0000-4000-8000-000000000002', 'v-1', '{}', 2)$$,
  '23505', null, 'external_id único por empresa');
select throws_ok($$insert into nofiscal.fiscal_sandbox_invoices (dono_tenant_id, tenant_id, external_id, payload, dps_numero)
  values ('ac700000-0000-4000-8000-000000000001', 'ac700000-0000-4000-8000-000000000002', 'v-2', '{}', 1)$$,
  '23505', null, 'número da DPS sandbox único por empresa');
select throws_ok($$update nofiscal.fiscal_sandbox_invoices set status = 'signing' where external_id = 'v-1'$$,
  '23514', null, 'status fora da lista é recusado');

select * from finish();
rollback;
