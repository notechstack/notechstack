-- Auditor por cliente (Frente 3): isolamento, primeiro acesso, agenda, fila, falhas, exclusão e limpeza.
-- Critérios do plan.md: C1–C4, C7 (idempotência sequencial), C9, C13, C16, C18.
-- C7 e C10 sob concorrência real ficam em auditor_clientes_concorrencia.mjs (duas conexões).
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- ------------------------------------------------------------ fixtures
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at) values
  ('a3000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'cliente-a@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now(), now()),
  ('a3000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'cliente-b@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now(), now()),
  ('a3000000-0000-4000-8000-0000000000ad', 'authenticated', 'authenticated', 'admin@example.test', '{"role":"NO_ADMIN"}', '{}', now(), now(), now()),
  ('a3000000-0000-4000-8000-0000000000d0', 'authenticated', 'authenticated', 'dot@example.test', '{"role":"MARKETING_AGENT"}', '{}', now(), now(), now()),
  ('a3000000-0000-4000-8000-0000000000c0', 'authenticated', 'authenticated', 'velho@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now(), now() - interval '13 months');

-- Assinatura antiga (sem conta) do cliente A, paga, plano semanal.
insert into public.auditor_assinaturas (id, plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto, created_at)
values ('a3100000-0000-4000-8000-000000000001', 'semanal', 'Cliente A', 'Cliente-A@example.test', '11999999999', 'sub_a', 'paga', now(), 'Aceito', now() - interval '20 days');
insert into public.auditor_assinatura_eventos (gateway_event_id, tipo, pagarme_subscription_id, status_aplicado, evento_em)
values ('hook_a1', 'invoice.paid', 'sub_a', 'paga', now() - interval '20 days');

-- ------------------------------------------------------------ C7: primeiro acesso (sequencial)
select is((select criada from public.auditor_primeiro_acesso('a3000000-0000-4000-8000-00000000000a', 'cliente-a@example.test', 'https://www.loja-a.com.br/')),
  true, 'C7 primeiro acesso cria a conta');
select is((select criada from public.auditor_primeiro_acesso('a3000000-0000-4000-8000-00000000000a', 'cliente-a@example.test', null)),
  false, 'C7 segundo acesso não cria de novo');
select is((select count(*)::int from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-00000000000a'), 1, 'C7 uma conta');
select is((select count(*)::int from public.memberships where user_id = 'a3000000-0000-4000-8000-00000000000a' and role = 'AUDITOR'), 1, 'C7 um vínculo AUDITOR');
select is((select c.origem from public.clients c join public.memberships m on m.client_id = c.id
           where m.user_id = 'a3000000-0000-4000-8000-00000000000a'), 'auditor', 'C7 negócio com origem auditor');
select is((select name from public.clients c join public.memberships m on m.client_id = c.id
           where m.user_id = 'a3000000-0000-4000-8000-00000000000a'), 'loja-a.com.br', 'nome do negócio vem do domínio');
select is((select plano from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-00000000000a'), 'semanal',
  'assinatura antiga paga é vinculada pelo e-mail (sem diferenciar maiúsculas)');
select is((select conta_id is not null from public.auditor_assinaturas where id = 'a3100000-0000-4000-8000-000000000001'), true,
  'assinatura antiga ganha conta_id');

select lives_ok($$select * from public.auditor_primeiro_acesso('a3000000-0000-4000-8000-00000000000b', 'cliente-b@example.test', 'https://loja-b.com.br')$$, 'cliente B entra');
select throws_ok($$select * from public.auditor_primeiro_acesso('a3000000-0000-4000-8000-0000000000ad', 'admin@example.test', null)$$,
  'P0001', 'conta do sistema não vira cliente do auditor', 'NO_ADMIN não vira cliente');
select throws_ok($$select * from public.auditor_primeiro_acesso('a3000000-0000-4000-8000-0000000000d0', 'dot@example.test', null)$$,
  'P0001', 'conta do sistema não vira cliente do auditor', 'MARKETING_AGENT não vira cliente');

create temp table ids on commit drop as
select (select m.client_id from public.memberships m where m.user_id = 'a3000000-0000-4000-8000-00000000000a') as x,
       (select m.client_id from public.memberships m where m.user_id = 'a3000000-0000-4000-8000-00000000000b') as y;
grant select on ids to authenticated;

-- Dados de X e Y: conexão (Vault), ativo, snapshot, relatório pronto.
select public.marketing_cliente_conexao_salvar(x, 'meta', 'TOKEN-FIXTURE-X', array['ads_read'], now() + interval '5 days', 'meta-user-x', 'a3000000-0000-4000-8000-00000000000a') from ids;
select public.marketing_cliente_conexao_salvar(y, 'meta', 'TOKEN-FIXTURE-Y', array['ads_read'], null, 'meta-user-y', 'a3000000-0000-4000-8000-00000000000b') from ids;
select public.marketing_cliente_ativos_salvar(x, 'meta', '[{"tipo":"meta_ads","external_id":"act_1","nome":"Conta X"}]', 'a3000000-0000-4000-8000-00000000000a') from ids;
select public.marketing_cliente_ativos_salvar(y, 'meta', '[{"tipo":"meta_ads","external_id":"act_2","nome":"Conta Y"}]', 'a3000000-0000-4000-8000-00000000000b') from ids;
insert into public.marketing_cliente_snapshots (client_id, tipo, external_id, periodo_de, periodo_ate, dados)
select x, 'meta_ads', 'act_1', current_date - 7, current_date - 1, '{"gasto_centavos":100}'::jsonb from ids
union all
select y, 'meta_ads', 'act_2', current_date - 7, current_date - 1, '{"gasto_centavos":200}'::jsonb from ids;
insert into public.auditor_relatorios (client_id, tipo, periodo_de, periodo_ate, estado, achados)
select x, 'semanal', current_date - 7, current_date - 1, 'pronto', '[]'::jsonb from ids
union all
select y, 'semanal', current_date - 7, current_date - 1, 'pronto', '[]'::jsonb from ids
union all
select x, 'mensal', current_date - 30, current_date - 1, 'gerando', '[]'::jsonb from ids;

-- ------------------------------------------------------------ C1: A não lê B
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-00000000000a","role":"authenticated","aal":"aal1","app_metadata":{"role":"AUDITOR_CLIENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_snapshots where client_id = (select y from ids)), 0, 'C1 snapshots de B: 0');
select is((select count(*)::int from public.auditor_relatorios where client_id = (select y from ids)), 0, 'C1 relatórios de B: 0');
select is((select count(*)::int from public.marketing_cliente_ativos where client_id = (select y from ids)), 0, 'C1 ativos de B: 0');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id = (select y from ids)), 0, 'C1 conexões de B: 0');
select is((select count(*)::int from public.auditor_clientes where client_id = (select y from ids)), 0, 'C1 negócio de B: 0');
select is((select count(*)::int from public.marketing_cliente_snapshots), 1, 'A lê o próprio snapshot');
select is((select count(*)::int from public.auditor_relatorios), 1, 'A lê só o relatório pronto (não o que está gerando)');
select is((select count(*)::int from public.auditor_contas), 1, 'A lê só a própria conta');
-- C4: vault_secret_id ilegível
select throws_ok($$select vault_secret_id from public.marketing_cliente_conexoes$$, '42501', null, 'C4 vault_secret_id ilegível');
select throws_ok($$select dono_user_id from public.auditor_contas$$, '42501', null, 'dono_user_id fora do grant');
select throws_ok($$insert into public.auditor_relatorios (client_id, tipo, periodo_de, periodo_ate) values ((select x from ids), 'mensal', current_date, current_date)$$,
  '42501', null, 'cliente não escreve relatório');
select throws_ok($$select 1 from public.marketing_cliente_eventos$$, '42501', null, 'trilha fechada para authenticated');
select throws_ok($$select 1 from public.auditor_operacao$$, '42501', null, 'view de operação fechada para authenticated');
reset role;

-- ------------------------------------------------------------ C2: NO_ADMIN só com concessão
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-0000000000ad","role":"authenticated","aal":"aal2","app_metadata":{"role":"NO_ADMIN"}}', true);
select is((select count(*)::int from public.marketing_cliente_snapshots), 0, 'C2 NO_ADMIN sem concessão: 0 snapshots');
select is((select count(*)::int from public.auditor_relatorios), 0, 'C2 NO_ADMIN sem concessão: 0 relatórios');
select is((select count(*)::int from public.marketing_cliente_conexoes), 0, 'C2 NO_ADMIN sem concessão: 0 conexões (regra da Frente 1 endurecida)');
reset role;

select throws_ok($$select public.auditor_suporte_conceder('a3000000-0000-4000-8000-00000000000b', (select x from ids), 'x', 72)$$,
  'P0001', 'so_o_dono_concede', 'só o dono concede');
select throws_ok($$select public.auditor_suporte_conceder('a3000000-0000-4000-8000-00000000000a', (select x from ids), 'x', 73)$$,
  'P0001', 'janela_invalida', 'janela máxima de 72 h');
select lives_ok($$select public.auditor_suporte_conceder('a3000000-0000-4000-8000-00000000000a', (select x from ids), 'erro no relatório', 72)$$, 'dono concede 72 h');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-0000000000ad","role":"authenticated","aal":"aal2","app_metadata":{"role":"NO_ADMIN"}}', true);
select is((select count(*)::int from public.marketing_cliente_snapshots where client_id = (select x from ids)), 1, 'C2 com concessão: lê X');
select is((select count(*)::int from public.marketing_cliente_snapshots where client_id = (select y from ids)), 0, 'C2 com concessão de X: não lê Y');
select set_config('request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-0000000000ad","role":"authenticated","aal":"aal1","app_metadata":{"role":"NO_ADMIN"}}', true);
select is((select count(*)::int from public.marketing_cliente_snapshots), 0, 'C2 com concessão mas aal1: 0');
reset role;

update public.auditor_acessos_suporte set inicio = now() - interval '73 hours', expira_em = now() - interval '1 hour';
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-0000000000ad","role":"authenticated","aal":"aal2","app_metadata":{"role":"NO_ADMIN"}}', true);
select is((select count(*)::int from public.marketing_cliente_snapshots), 0, 'C2 concessão expirada: 0');
reset role;

-- ------------------------------------------------------------ C3: MARKETING_AGENT não lê nada
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"a3000000-0000-4000-8000-0000000000d0","role":"authenticated","aal":"aal1","app_metadata":{"role":"MARKETING_AGENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_snapshots), 0, 'C3 dot: 0 snapshots');
select is((select count(*)::int from public.auditor_relatorios), 0, 'C3 dot: 0 relatórios');
select is((select count(*)::int from public.marketing_cliente_conexoes), 0, 'C3 dot: 0 conexões');
select is((select count(*)::int from public.marketing_cliente_ativos), 0, 'C3 dot: 0 ativos');
select is((select count(*)::int from public.auditor_clientes), 0, 'C3 dot: 0 negócios');
reset role;

-- ------------------------------------------------------------ C9: agenda idempotente
delete from public.auditor_relatorios;
-- 19/10/2026 é segunda. A (semanal, paga) recebe 1; B (grátis) nenhum.
select is(public.auditor_planejar_relatorios(timestamptz '2026-10-19 09:00:00+00'), 1, 'C9 segunda: 1 relatório');
select is(public.auditor_planejar_relatorios(timestamptz '2026-10-19 09:30:00+00'), 0, 'C9 de novo no mesmo dia: 0');
select results_eq($$select tipo, periodo_de, periodo_ate from public.auditor_relatorios$$,
  $$values ('semanal'::text, date '2026-10-12', date '2026-10-18')$$, 'C9 período seg–dom anterior');
select is(public.auditor_planejar_relatorios(timestamptz '2026-10-20 09:00:00+00'), 0, 'C9 terça: 0');
-- Fuso: 19/10 01:00 UTC ainda é domingo 18/10 em São Paulo.
delete from public.auditor_relatorios;
select is(public.auditor_planejar_relatorios(timestamptz '2026-10-19 01:00:00+00'), 0, 'C9 respeita o fuso do negócio');
-- Mensal no dia 1.
update public.auditor_contas set plano = 'mensal' where dono_user_id = 'a3000000-0000-4000-8000-00000000000a';
select is(public.auditor_planejar_relatorios(timestamptz '2026-11-01 09:00:00+00'), 1, 'C9 mensal no dia 1');
select results_eq($$select tipo, periodo_de, periodo_ate from public.auditor_relatorios where tipo = 'mensal'$$,
  $$values ('mensal'::text, date '2026-10-01', date '2026-10-31')$$, 'C9 mensal cobre o mês anterior');
-- Lembrete de expiração Meta (X expira em 5 dias).
select is((select count(*)::int from public.auditor_avisos where tipo = 'expira_7d' and client_id = (select x from ids)), 1, 'aviso de expiração em 7 dias');
select public.auditor_planejar_relatorios(now());
select is((select count(*)::int from public.auditor_avisos where tipo = 'expira_7d'), 1, 'aviso não se repete');
-- Sem acesso (assinatura cancelada): nada.
update public.auditor_assinaturas set status = 'cancelada' where id = 'a3100000-0000-4000-8000-000000000001';
delete from public.auditor_relatorios;
select is(public.auditor_planejar_relatorios(timestamptz '2026-12-01 09:00:00+00'), 0, 'C9 sem acesso: 0');
update public.auditor_assinaturas set status = 'paga' where id = 'a3100000-0000-4000-8000-000000000001';

-- Retrospectiva grátis: uma vez.
select isnt(public.auditor_retrospectiva_agendar('a3000000-0000-4000-8000-00000000000b', (select y from ids)), null, 'retrospectiva grátis agendada');
select is(public.auditor_retrospectiva_agendar('a3000000-0000-4000-8000-00000000000b', (select y from ids)), null, 'retrospectiva grátis só uma vez');
select throws_ok($$select public.auditor_retrospectiva_agendar('a3000000-0000-4000-8000-00000000000a', (select y from ids))$$,
  'P0001', 'sem_acesso', 'retrospectiva só do próprio negócio');

-- ------------------------------------------------------------ C13: falhas
delete from public.auditor_relatorios;
insert into public.auditor_relatorios (id, client_id, tipo, periodo_de, periodo_ate, executar_em)
select 'a3200000-0000-4000-8000-000000000001', x, 'semanal', date '2026-10-12', date '2026-10-18', now() - interval '1 minute' from ids;
select is((select count(*)::int from public.auditor_claim_relatorios(3)), 1, 'claim pega o vencido');
select is((select count(*)::int from public.auditor_claim_relatorios(3)), 0, 'claim não pega de novo');
select is(public.auditor_relatorio_falha('a3200000-0000-4000-8000-000000000001', 'timeout', true), 'agendado', 'C13 1ª falha volta à fila');
update public.auditor_relatorios set executar_em = now() - interval '1 second' where id = 'a3200000-0000-4000-8000-000000000001';
select public.auditor_claim_relatorios(3);
select is(public.auditor_relatorio_falha('a3200000-0000-4000-8000-000000000001', 'timeout', true), 'agendado', 'C13 2ª falha volta à fila');
update public.auditor_relatorios set executar_em = now() - interval '1 second' where id = 'a3200000-0000-4000-8000-000000000001';
select public.auditor_claim_relatorios(3);
select is(public.auditor_relatorio_falha('a3200000-0000-4000-8000-000000000001', 'timeout', true), 'falhou', 'C13 3ª falha: falhou');
select is((select tentativas::int from public.auditor_relatorios where id = 'a3200000-0000-4000-8000-000000000001'), 3, 'C13 tentativas = 3');
select is((select count(*)::int from public.marketing_cliente_eventos where acao = 'relatorio_falhou'), 1, 'C13 falha registrada');

-- ------------------------------------------------------------ C18: limpeza
insert into public.marketing_cliente_snapshots (client_id, tipo, external_id, periodo_de, periodo_ate, dados)
select x, 'ga4', '123', (now() - interval '13 months' - interval '8 days')::date, (now() - interval '13 months' - interval '1 day')::date, '{}'::jsonb from ids
union all
select x, 'ga4', '123', (now() - interval '13 months' + interval '1 day')::date, (now() - interval '13 months' + interval '1 day')::date, '{}'::jsonb from ids;
-- B é grátis e conectou há 31 dias.
update public.marketing_cliente_conexoes set conectado_em = now() - interval '31 days' where client_id = (select y from ids);
-- Conta antiga sem login há 13 meses.
select public.auditor_primeiro_acesso('a3000000-0000-4000-8000-0000000000c0', 'velho@example.test', null);
update public.auditor_contas set criada_em = now() - interval '14 months' where dono_user_id = 'a3000000-0000-4000-8000-0000000000c0';

select lives_ok($$select public.auditor_limpar()$$, 'C18 limpar roda');
select is((select count(*)::int from public.marketing_cliente_snapshots where tipo = 'ga4'), 1, 'C18 snapshot de 13 meses + 1 dia apagado, o outro fica');
select is((select vault_secret_id from public.marketing_cliente_conexoes where client_id = (select y from ids)), null, 'C18 token da conta grátis apagado após 30 dias');
select is((select count(*)::int from vault.secrets where name = 'marketing_cliente:' || (select y from ids) || ':meta'), 0, 'C18 segredo fora do Vault');
select isnt((select vault_secret_id from public.marketing_cliente_conexoes where client_id = (select x from ids)), null, 'C18 token do assinante fica');
select isnt((select encerrada_em from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000c0'), null, 'C18 conta grátis inativa há 12 meses é encerrada');
update public.auditor_contas set excluir_apos = now() - interval '1 minute' where dono_user_id = 'a3000000-0000-4000-8000-0000000000c0';
select public.auditor_limpar();
select is((select count(*)::int from auth.users where id = 'a3000000-0000-4000-8000-0000000000c0'), 0, 'C18 conta vencida apagada com o usuário');

-- ------------------------------------------------------------ C16: exclusão a pedido
create temp table conta_a on commit drop as select id from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-00000000000a';
select is((public.auditor_apagar_conta((select id from conta_a), 'cliente') ->> 'usuario_apagado')::boolean, true, 'C16 exclusão apaga o usuário');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id = (select x from ids)), 0, 'C16 conexões apagadas');
select is((select count(*)::int from vault.secrets where name = 'marketing_cliente:' || (select x from ids) || ':meta'), 0, 'C16 segredo fora do Vault');
select is((select count(*)::int from public.marketing_cliente_ativos where client_id = (select x from ids)), 0, 'C16 ativos apagados');
select is((select count(*)::int from public.marketing_cliente_snapshots where client_id = (select x from ids)), 0, 'C16 snapshots apagados');
select is((select count(*)::int from public.auditor_relatorios where client_id = (select x from ids)), 0, 'C16 relatórios apagados');
select is((select count(*)::int from public.auditor_clientes where client_id = (select x from ids)), 0, 'C16 negócio apagado');
select is((select count(*)::int from public.clients where id = (select x from ids)), 0, 'C16 clients apagado');
select is((select count(*)::int from auth.users where id = 'a3000000-0000-4000-8000-00000000000a'), 0, 'C16 usuário Auth apagado');
select is((select estado from public.auditor_exclusoes where origem = 'cliente'), 'concluido', 'C16 exclusão concluída');
select results_eq($$select nome, email like 'excluido+%', whatsapp, conta_id from public.auditor_assinaturas where id = 'a3100000-0000-4000-8000-000000000001'$$,
  $$values ('[excluído]'::text, true, '0000000000'::text, null::uuid)$$, 'C16 assinatura anonimizada e guardada');
select is((select count(*)::int from public.clients where id = (select y from ids)), 1, 'C16 negócio de B intocado');
select is((select origem from public.clients where slug = 'no-tech-stack'), 'interno', 'a Nó é interno');

select * from finish();
rollback;
