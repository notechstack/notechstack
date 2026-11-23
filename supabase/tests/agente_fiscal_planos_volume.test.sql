-- Planos por volume e módulos (migração 20261123210000): faixas novas, empresas sem limite, tipos de nota e cupons.
-- As regras de fiscal_definir_tipos_nota em contas de verdade (conta-mãe, empresa cliente, Inicial/Pro) ficam em
-- tests/agente-fiscal-v2-conta/planos-volume.test.mjs, que cria as contas pelas funções do cadastro.
begin;
create extension if not exists pgtap with schema extensions;
select plan(26);

-- Faixas: os três códigos antigos e os dois novos.
select is(nofiscal.limite_do_plano('escritorio_5'), 500, 'faixa de 500 documentos');
select is(nofiscal.limite_do_plano('escritorio_1000'), 1000, 'faixa de 1.000 documentos');
select is(nofiscal.limite_do_plano('escritorio_20'), 2000, 'faixa de 2.000 documentos');
select is(nofiscal.limite_do_plano('escritorio_50'), 5000, 'faixa de 5.000 documentos');
select is(nofiscal.limite_do_plano('escritorio_10000'), 10000, 'faixa de 10.000 documentos');
select is(nofiscal.limite_do_plano('pro'), 100, 'Pro não muda');
select ok(nofiscal.plano_de_escritorio('escritorio_1000') and nofiscal.plano_de_escritorio('escritorio_10000'), 'faixas novas são Escritório');
select ok(nofiscal.plano_completo('escritorio_1000') and nofiscal.plano_completo('escritorio_10000'), 'faixas novas têm tudo do Pro');
select ok(not nofiscal.plano_de_escritorio('escritorio_500'), 'apelido do site não é código de plano');

-- Empresas: sem limite em toda faixa do Escritório; Inicial e Pro seguem com uma.
select is(nofiscal.max_empresas_do_plano('escritorio_5'), 100000, 'sem limite na faixa de 500');
select is(nofiscal.max_empresas_do_plano('escritorio_10000'), 100000, 'sem limite na faixa de 10.000');
select is(nofiscal.max_empresas_do_plano('pro'), 1, 'Pro: uma empresa');

-- Travas de plano aceitam as faixas novas.
select ok(pg_get_constraintdef(oid) like '%escritorio_1000%' and pg_get_constraintdef(oid) like '%escritorio_10000%', conname || ' aceita as faixas novas')
  from pg_constraint
 where conname in ('fiscal_tenants_plan_check', 'fiscal_subscriptions_plano_check', 'fiscal_cupons_planos_check')
 order by conname;

-- Tipos de nota: coluna, padrão e privilégios.
select is((select column_default from information_schema.columns where table_schema = 'nofiscal' and table_name = 'fiscal_tenants' and column_name = 'tipos_nota'),
  $$ARRAY['nfse'::text]$$, 'conta nova emite só NFS-e');
select ok(has_function_privilege('service_role', 'public.fiscal_definir_tipos_nota(uuid,text[])', 'execute'), 'service_role grava os tipos de nota');
select ok(not has_function_privilege('authenticated', 'public.fiscal_definir_tipos_nota(uuid,text[])', 'execute'), 'authenticated não grava');
select ok(not has_function_privilege('anon', 'public.fiscal_definir_tipos_nota(uuid,text[])', 'execute'), 'anon não grava');
select ok(has_function_privilege('nofiscal_service', 'nofiscal.tipos_nota_da_conta(uuid)', 'execute'), 'motor lê os tipos de nota');
select throws_ok($$ select public.fiscal_definir_tipos_nota('f9000000-0000-4000-8000-000000000001', array['cte']) $$, '22023', null, 'tipo de nota desconhecido é inválido');
select throws_ok($$ select public.fiscal_definir_tipos_nota('f9000000-0000-4000-8000-000000000001', array[]::text[]) $$, '22023', null, 'lista vazia é inválida');
select is(public.fiscal_definir_tipos_nota('f9000000-0000-4000-8000-000000000001', array['nfse']) ->> 'erro', 'CONTA_NAO_ENCONTRADA', 'tenant inexistente');

-- Cupons do modelo novo.
select is((select valor || ':' || ciclos || ':' || dias_de_teste || ':' || planos[1] from nofiscal.fiscal_cupons where codigo = 'FUNDADOR1000'),
  '10000:12:30:escritorio_1000', 'FUNDADOR1000: R$ 100 por 12 cobranças, 30 dias, só na faixa de 1.000');
select is((select valor || ':' || ciclos || ':' || dias_de_teste || ':' || planos[1] from nofiscal.fiscal_cupons where codigo = 'FUNDADOR10000'),
  '50000:12:30:escritorio_10000', 'FUNDADOR10000: R$ 500 por 12 cobranças, 30 dias, só na faixa de 10.000');
select is((select valor || ':' || coalesce(ciclos::text, 'sem prazo') || ':' || planos[1] from nofiscal.fiscal_cupons where codigo = 'MODULOSJUNTOS'),
  '9700:sem prazo:guias', 'MODULOSJUNTOS: R$ 97 no Guias, sem prazo');

select * from finish();
rollback;
