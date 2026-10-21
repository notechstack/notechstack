-- Auditor por cliente (Frente 3): isolamento, primeiro acesso, agenda, fila, falhas, exclusão e limpeza.
-- Critérios do plan.md: C1–C4, C7 (idempotência sequencial), C9, C13, C16, C18.
-- C7 e C10 sob concorrência real ficam em auditor_clientes_concorrencia.mjs (duas conexões).
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

create function pg_temp.aceite_fixture() returns trigger language plpgsql as $f$
begin
  insert into public.auditor_aceites (user_id, versao) values (new.id, 'termos-teste') on conflict do nothing;
  return new;
end;
$f$;
create trigger aceite_fixture after insert on auth.users for each row execute function pg_temp.aceite_fixture();

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
  'P0001', 'conta_sistema', 'NO_ADMIN não vira cliente');
select throws_ok($$select * from public.auditor_primeiro_acesso('a3000000-0000-4000-8000-0000000000d0', 'dot@example.test', null)$$,
  'P0001', 'conta_sistema', 'MARKETING_AGENT não vira cliente');

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
select is((select count(*)::int from public.marketing_cliente_snapshots where client_id = (select x from ids)), 0, 'B6 com concessão: pela RLS o NO_ADMIN não lê (suporte só pela marketing-hub, que registra)');
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
select is((select estado from public.auditor_exclusoes where origem = 'cliente' and conta_id = (select id from conta_a)), 'concluido', 'C16 exclusão concluída');
select results_eq($$select nome, email like 'excluido+%', whatsapp, conta_id from public.auditor_assinaturas where id = 'a3100000-0000-4000-8000-000000000001'$$,
  $$values ('[excluído]'::text, true, '0000000000'::text, null::uuid)$$, 'C16 assinatura anonimizada e guardada');
select is((select count(*)::int from public.clients where id = (select y from ids)), 1, 'C16 negócio de B intocado');
select is((select origem from public.clients where slug = 'no-tech-stack'), 'interno', 'a Nó é interno');

-- ------------------------------------------------------------ U5: limite do link mágico
select results_eq($$select permitido, user_id, papel from public.auditor_acesso_preparar('Cliente-B@Example.test', repeat('e', 64), repeat('1', 64))$$,
  $$values (true, 'a3000000-0000-4000-8000-00000000000b'::uuid, 'AUDITOR_CLIENT'::text)$$, 'acesso: acha o usuário pelo e-mail sem diferenciar maiúsculas');
select results_eq($$select permitido, user_id from public.auditor_acesso_preparar('novo@example.test', repeat('f', 64), repeat('1', 64))$$,
  $$values (true, null::uuid)$$, 'acesso: e-mail novo é permitido e sem usuário');
select public.auditor_acesso_preparar('cliente-b@example.test', repeat('e', 64), repeat('2', 64));
select public.auditor_acesso_preparar('cliente-b@example.test', repeat('e', 64), repeat('3', 64));
select is((select permitido from public.auditor_acesso_preparar('cliente-b@example.test', repeat('e', 64), repeat('4', 64))), false, 'U5 4º link do mesmo e-mail na hora: recusado');
select is((select count(*)::int from public.auditor_acesso_tentativas where chave_email = repeat('e', 64)), 3, 'U5 recusa não registra tentativa');
insert into public.auditor_acesso_tentativas (chave_email, chave_ip) select md5(g::text) || md5(g::text), repeat('9', 64) from generate_series(1, 20) g;
select is((select permitido from public.auditor_acesso_preparar('outro@example.test', repeat('a', 64), repeat('9', 64))), false, 'U5 21º pedido do mesmo IP na hora: recusado');
update public.auditor_acesso_tentativas set em = now() - interval '2 hours' where chave_email = repeat('e', 64);
select is((select permitido from public.auditor_acesso_preparar('cliente-b@example.test', repeat('e', 64), repeat('5', 64))), true, 'U5 depois de uma hora, libera');

-- ------------------------------------------------------------ RPCs do próprio cliente (auditor_eu_*)
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at) values
  ('a3000000-0000-4000-8000-0000000000e1', 'authenticated', 'authenticated', 'eu@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now(), now());
set local role anon;
select throws_ok($$select public.auditor_eu()$$, '42501', null, 'anon não chama auditor_eu');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal1","app_metadata":{"role":"AUDITOR_CLIENT"}}', true);
select is(public.auditor_eu(), null, 'sem conta: auditor_eu é nulo');
select is((public.auditor_eu_iniciar('https://eu.example.com.br/') -> 'negocios' -> 0 ->> 'nome'), 'eu.example.com.br', 'auditor_eu_iniciar cria e devolve o negócio');
select is(jsonb_array_length(public.auditor_eu_iniciar(null) -> 'negocios'), 1, 'iniciar de novo é idempotente');
select is((public.auditor_eu() ->> 'plano'), 'gratis', 'plano grátis');
select throws_ok($$select public.auditor_eu_negocio_criar('https://outro.example', null)$$, 'P0001', 'plano_sem_multiplos_negocios', 'grátis não cria segundo negócio');
select throws_ok($$select public.auditor_eu_frequencia((public.auditor_eu() -> 'negocios' -> 0 ->> 'client_id')::uuid, 'mensal')$$, 'P0001', 'so_no_plano_agencia', 'frequência só no Agência');
select lives_ok($$select public.auditor_eu_suporte((public.auditor_eu() -> 'negocios' -> 0 ->> 'client_id')::uuid, true, 'ajuda')$$, 'dono concede suporte pelo app');
select isnt((public.auditor_eu() -> 'negocios' -> 0 ->> 'suporte_ate'), null, 'auditor_eu mostra até quando vale o suporte');
select lives_ok($$select public.auditor_eu_suporte((public.auditor_eu() -> 'negocios' -> 0 ->> 'client_id')::uuid, false)$$, 'dono revoga');
select is((public.auditor_eu() -> 'negocios' -> 0 ->> 'suporte_ate'), null, 'revogado some');
select isnt(public.auditor_eu_retrospectiva((public.auditor_eu() -> 'negocios' -> 0 ->> 'client_id')::uuid), null, 'retrospectiva grátis pelo app');
select throws_ok($$select public.auditor_eu_suporte((select y from ids), true, null)$$, 'P0001', 'so_o_dono_concede', 'não concede suporte de negócio alheio');
reset role;
insert into public.auditor_assinaturas (plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto)
values ('agencia', 'Eu', 'eu@example.test', '11911112222', 'sub_e1', 'paga', now(), 'Aceito');
select public.auditor_assinatura_vincular('sub_e1', 'a3000000-0000-4000-8000-0000000000e1', false);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-0000000000e1","role":"authenticated","aal":"aal1","app_metadata":{"role":"AUDITOR_CLIENT"}}', true);
select lives_ok($$select public.auditor_eu_negocio_criar('https://n2.example', 'Cliente 2')$$, 'Agência cria segundo negócio');
select lives_ok($$select public.auditor_eu_negocio_criar('https://n3.example', null)$$, 'Agência: 3');
select lives_ok($$select public.auditor_eu_negocio_criar('https://n4.example', null)$$, 'Agência: 4');
select lives_ok($$select public.auditor_eu_negocio_criar('https://n5.example', null)$$, 'Agência: 5');
select throws_ok($$select public.auditor_eu_negocio_criar('https://n6.example', null)$$, 'P0001', 'limite_de_negocios', 'Agência: até 5 negócios');
select lives_ok($$select public.auditor_eu_frequencia((public.auditor_eu() -> 'negocios' -> 1 ->> 'client_id')::uuid, 'mensal')$$, 'Agência escolhe a frequência por negócio');
select is((public.auditor_eu() -> 'negocios' -> 1 ->> 'frequencia'), 'mensal', 'frequência gravada');
select is((public.auditor_eu() -> 'negocios' -> 2 ->> 'frequencia'), 'semanal', 'padrão do Agência é semanal');
reset role;

-- ------------------------------------------------------------ C19: checkout logado e sincronia do plano
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at) values
  ('a3000000-0000-4000-8000-0000000000f1', 'authenticated', 'authenticated', 'paga@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now(), now());
select public.auditor_primeiro_acesso('a3000000-0000-4000-8000-0000000000f1', 'paga@example.test', 'https://paga.example');
select is((public.auditor_checkout_preparar('a3000000-0000-4000-8000-0000000000f1') ->> 'ja_assinante')::boolean, false, 'C19 antes de pagar: não é assinante');
insert into public.auditor_assinaturas (plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto)
values ('semanal', 'Paga', 'outro-email@example.test', '11988887777', 'sub_f1', 'pendente', now(), 'Aceito');
select lives_ok($$select public.auditor_assinatura_vincular('sub_f1', 'a3000000-0000-4000-8000-0000000000f1')$$, 'C19 vincula pela conta, não pelo e-mail');
select is((select plano from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000f1'), 'gratis', 'C19 pendente: plano ainda grátis');
update public.auditor_assinaturas set status = 'paga' where pagarme_subscription_id = 'sub_f1';
insert into public.auditor_assinatura_eventos (gateway_event_id, tipo, pagarme_subscription_id, status_aplicado, evento_em) values ('hook_f1', 'invoice.paid', 'sub_f1', 'paga', now());
select is((select plano from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000f1'), 'semanal', 'C19 webhook paga: plano semanal');
select is((public.auditor_checkout_preparar('a3000000-0000-4000-8000-0000000000f1') ->> 'ja_assinante')::boolean, true, 'C19 agora é assinante (não assina duas vezes)');
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('a3000000-0000-4000-8000-0000000000f2', 'authenticated', 'authenticated', 'intruso@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now());
select public.auditor_primeiro_acesso('a3000000-0000-4000-8000-0000000000f2', 'intruso@example.test', null);
select throws_ok($$select public.auditor_assinatura_vincular('sub_f1', 'a3000000-0000-4000-8000-0000000000f2')$$, 'P0001', 'assinatura_de_outra_conta', 'C19 assinatura de outra conta não é sequestrada');
update public.auditor_assinaturas set status = 'cancelada' where pagarme_subscription_id = 'sub_f1';
select isnt((select excluir_apos from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000f1'), null, 'C19 cancelada: conta encerrada com data de exclusão');
select is(public.auditor_conta_com_acesso((select id from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000f1')), false, 'C19 cancelada: sem acesso');

-- ------------------------------------------------------------ Cópia por WhatsApp (opt-in, decisão 21/10)
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at) values
  ('a3000000-0000-4000-8000-0000000000c1', 'authenticated', 'authenticated', 'copia@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now(), now());
select public.auditor_primeiro_acesso('a3000000-0000-4000-8000-0000000000c1', 'copia@example.test', 'https://copia.example');
create temp table cop on commit drop as select m.client_id as x from public.memberships m where m.user_id = 'a3000000-0000-4000-8000-0000000000c1';
insert into public.auditor_assinaturas (plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto)
values ('mensal', 'Copia', 'copia@example.test', '11977776666', 'sub_c1', 'pendente', now(), 'Aceito');
insert into public.auditor_relatorios (id, client_id, tipo, periodo_de, periodo_ate, estado, narrativa, achados)
select 'a3200000-0000-4000-8000-0000000000c1', x, 'mensal', date '2026-09-01', date '2026-09-30', 'enviado',
  '{"origem":"modelo","resumo":"Resumo de setembro.","prioridades":[{"achado_id":"a","titulo":"T","o_que_fazer":"F"}]}'::jsonb,
  '[{"id":"a","numeros":{"gasto":"R$ 1,00"}}]'::jsonb from cop;
select is(public.auditor_copia_whatsapp_ler('a3200000-0000-4000-8000-0000000000c1', 'a3000000-0000-4000-8000-0000000000ad'), null, 'cópia: sem opt-in a equipe não lê');
select lives_ok($$select public.auditor_assinatura_vincular('sub_c1', 'a3000000-0000-4000-8000-0000000000c1', true)$$, 'cópia: opt-in no checkout');
select results_eq($$select copia_whatsapp, copia_whatsapp_numero from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000c1'$$,
  $$values (true, '11977776666'::text)$$, 'cópia: número do checkout gravado');
select is((public.auditor_copia_whatsapp_ler('a3200000-0000-4000-8000-0000000000c1', 'a3000000-0000-4000-8000-0000000000ad') ->> 'resumo'), 'Resumo de setembro.', 'cópia: com opt-in a equipe lê o resumo');
select is((public.auditor_copia_whatsapp_ler('a3200000-0000-4000-8000-0000000000c1', 'a3000000-0000-4000-8000-0000000000ad') ? 'achados'), false, 'cópia: nunca leva achados nem números brutos');
select is((select count(*)::int from public.marketing_cliente_eventos where acao = 'copia_whatsapp_leu' and client_id = (select x from cop)), 2, 'cópia: cada leitura registrada');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000000-0000-4000-8000-0000000000c1","role":"authenticated","aal":"aal1","app_metadata":{"role":"AUDITOR_CLIENT"}}', true);
select is((public.auditor_eu() ->> 'copia_whatsapp')::boolean, true, 'cliente vê a cópia ligada');
select throws_ok($$select public.auditor_eu_copia_whatsapp(true, '123')$$, 'P0001', 'numero_invalido', 'cópia: número inválido recusado');
select lives_ok($$select public.auditor_eu_copia_whatsapp(false)$$, 'cliente desliga a cópia');
select throws_ok($$select public.auditor_copia_whatsapp_ler('a3200000-0000-4000-8000-0000000000c1', 'a3000000-0000-4000-8000-0000000000ad')$$, '42501', null, 'cliente não chama a leitura da equipe');
reset role;
select results_eq($$select copia_whatsapp, copia_whatsapp_numero from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000c1'$$,
  $$values (false, null::text)$$, 'cópia desligada apaga o número');
select is(public.auditor_copia_whatsapp_ler('a3200000-0000-4000-8000-0000000000c1', 'a3000000-0000-4000-8000-0000000000ad'), null, 'cópia desligada: equipe não lê mais');

-- ------------------------------------------------------------ 11 cobranças de fora do auditor (Roteador/testes, 19–21/10)
-- Gravadas pela versão antiga do webhook: pagas, sem id de assinatura nem de fatura. Ficam no banco (não apagar),
-- mas não podem criar conta, assinatura, acesso nem relatório.
create temp table antes on commit drop as
select (select count(*) from public.auditor_contas) contas, (select count(*) from public.auditor_assinaturas) assinaturas,
       (select count(*) from public.auditor_relatorios) relatorios, (select count(*) from public.auditor_lista_envio_relatorio) lista;
select public.aplicar_evento_assinatura_auditor('hook_fora_' || g, 'charge.paid', null, 'paga',
  jsonb_build_object('id', 'hook_fora_' || g, 'type', 'charge.paid', 'data', jsonb_build_object('id', 'ch_fora_' || g, 'subscription_id', null, 'invoice_id', null)),
  now() - make_interval(hours => g))
from generate_series(1, 11) g;
select is((select count(*)::int from public.auditor_assinatura_eventos where gateway_event_id like 'hook_fora_%'), 11, '11 cobranças de fora gravadas (como em produção)');
select is((select count(*) from public.auditor_assinaturas), (select assinaturas from antes), 'cobranças de fora não criam assinatura');
select is((select count(*) from public.auditor_contas), (select contas from antes), 'cobranças de fora não criam conta');
select is((select count(*) from public.auditor_lista_envio_relatorio), (select lista from antes), 'cobranças de fora não dão acesso (lista de envio igual)');
select is(public.auditor_planejar_relatorios(timestamptz '2026-11-02 09:00:00+00') >= 0, true, 'planejar roda com elas no banco');
select is((select count(*) from public.auditor_relatorios r where not exists (select 1 from public.auditor_clientes ac where ac.client_id = r.client_id)), 0::bigint,
  'nenhum relatório sem negócio');
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('a3000000-0000-4000-8000-0000000000e9', 'authenticated', 'authenticated', 'fora@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now());
select public.auditor_primeiro_acesso('a3000000-0000-4000-8000-0000000000e9', 'fora@example.test', null);
select results_eq($$select plano, assinatura_id from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000e9'$$,
  $$values ('gratis'::text, null::uuid)$$, 'conta nova não herda nada das cobranças de fora');
select is(public.auditor_conta_com_acesso((select id from public.auditor_contas where dono_user_id = 'a3000000-0000-4000-8000-0000000000e9')), false,
  'sem acesso pago');

-- ================================================================ Revisão do PR #66 (21/10)
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, last_sign_in_at) values
  ('a5000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dona-r@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now(), now()),
  ('a5000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'intrusa-r@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now(), now()),
  ('a5000000-0000-4000-8000-0000000000ad', 'authenticated', 'authenticated', 'admin-r@example.test', '{"role":"NO_ADMIN"}', '{}', now(), now(), now());
select public.auditor_primeiro_acesso('a5000000-0000-4000-8000-000000000001', 'dona-r@example.test', 'https://dona-r.example');
create temp table rv on commit drop as
select (select m.client_id from public.memberships m where m.user_id = 'a5000000-0000-4000-8000-000000000001') as negocio,
       (select id from public.auditor_contas where dono_user_id = 'a5000000-0000-4000-8000-000000000001') as conta;
grant select on rv to authenticated;
select public.marketing_cliente_conexao_salvar((select negocio from rv), 'meta', 'TOKEN-R', array['ads_read'], null, 'meta-r', 'a5000000-0000-4000-8000-000000000001');
insert into public.marketing_cliente_snapshots (client_id, tipo, external_id, periodo_de, periodo_ate, dados)
select negocio, 'meta_ads', 'act_9', current_date - 7, current_date - 1, '{}'::jsonb from rv;

-- A1: NO_ADMIN (até com aal1) não cria vínculo AUDITOR; vínculo AUDITOR não dá acesso sem a posse da conta.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-0000000000ad","role":"authenticated","aal":"aal1","app_metadata":{"role":"NO_ADMIN"}}', true);
select throws_ok($$insert into public.memberships (user_id, client_id, role) values ('a5000000-0000-4000-8000-0000000000ad', (select negocio from rv), 'AUDITOR')$$,
  '42501', null, 'A1 NO_ADMIN insere vínculo AUDITOR → negado');
update public.memberships set user_id = 'a5000000-0000-4000-8000-0000000000ad' where user_id = 'a5000000-0000-4000-8000-000000000001';
reset role;
select is((select count(*)::int from public.memberships where user_id = 'a5000000-0000-4000-8000-000000000001' and role = 'AUDITOR'), 1, 'A1 NO_ADMIN não altera vínculo AUDITOR (a policy esconde a linha)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-0000000000ad","role":"authenticated","aal":"aal1","app_metadata":{"role":"NO_ADMIN"}}', true);
select is((select count(*)::int from public.memberships where role = 'AUDITOR' and user_id = 'a5000000-0000-4000-8000-0000000000ad'), 0, 'A1 nenhum vínculo criado');
reset role;
-- mesmo que um vínculo AUDITOR exista (gravado por fora), sem a posse não há leitura, conexão nem retrospectiva
insert into public.memberships (user_id, client_id, role) select 'a5000000-0000-4000-8000-000000000002', negocio, 'AUDITOR' from rv;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1","app_metadata":{"role":"AUDITOR_CLIENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_snapshots where client_id = (select negocio from rv)), 0, 'A1 vínculo sem posse: 0 snapshots');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id = (select negocio from rv)), 0, 'A1 vínculo sem posse: 0 conexões');
reset role;
select throws_ok($$select public.marketing_cliente_conexao_salvar((select negocio from rv), 'google', 'T', null, null, null, 'a5000000-0000-4000-8000-000000000002')$$,
  'P0001', 'autor não autorizado para este cliente', 'A1 vínculo sem posse não conecta');
select throws_ok($$select public.auditor_retrospectiva_agendar('a5000000-0000-4000-8000-000000000002', (select negocio from rv))$$,
  'P0001', 'sem_acesso', 'A1 vínculo sem posse não agenda retrospectiva');
delete from public.memberships where user_id = 'a5000000-0000-4000-8000-000000000002';

-- A4: checkout abandonado (pendente) e recusa sem pagamento não guardam tokens para sempre nem dão plano.
insert into public.auditor_assinaturas (plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto)
values ('agencia', 'Dona', 'dona-r@example.test', '11966665555', 'sub_r_recusada', 'recusada', now(), 'Aceito');
select public.auditor_assinatura_vincular('sub_r_recusada', 'a5000000-0000-4000-8000-000000000001', false);
select is((select plano from public.auditor_contas where id = (select conta from rv)), 'gratis', 'A4 recusada sem nenhum pagamento: plano não é promovido');
update public.auditor_contas set plano = 'agencia' where id = (select conta from rv);
select throws_ok($$select public.auditor_negocio_criar('a5000000-0000-4000-8000-000000000001', 'https://outro-r.example', null)$$,
  'P0001', 'plano_sem_multiplos_negocios', 'A4/I4 cartão recusado não libera os 5 negócios do Agência');
update public.marketing_cliente_conexoes set conectado_em = now() - interval '31 days' where client_id = (select negocio from rv);
select public.auditor_limpar();
select is((select vault_secret_id from public.marketing_cliente_conexoes where client_id = (select negocio from rv) and provedor = 'meta'), null,
  'A4 conta sem acesso (recusada sem pagamento) e conexão de 31 dias: token apagado');

-- B7: conta encerrada volta a valer quando a pessoa entra de novo.
update public.auditor_contas set encerrada_em = now() - interval '1 day', excluir_apos = now() + interval '89 days' where id = (select conta from rv);
select public.auditor_primeiro_acesso('a5000000-0000-4000-8000-000000000001', 'dona-r@example.test', null);
select results_eq($$select encerrada_em, excluir_apos, plano from public.auditor_contas where id = (select conta from rv)$$,
  $$values (null::timestamptz, null::timestamptz, 'gratis'::text)$$, 'B7 conta reaberta como grátis');

-- B3: sem aceite registrado, o primeiro acesso não cria conta; com aceite pelo próprio usuário, cria.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('a5000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'semaceite@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now());
delete from public.auditor_aceites where user_id = 'a5000000-0000-4000-8000-000000000003';
select throws_ok($$select public.auditor_primeiro_acesso('a5000000-0000-4000-8000-000000000003', 'semaceite@example.test', null)$$,
  'P0001', 'aceite_pendente', 'B3 sem aceite: nenhuma conta');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a5000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","app_metadata":{"role":"AUDITOR_CLIENT"}}', true);
select throws_ok($$select public.auditor_eu_iniciar(null)$$, 'P0001', 'aceite_pendente', 'B3 app sem aceite recebe aceite_pendente');
select is((public.auditor_eu_iniciar(null, 'termos-2026-10-21') ->> 'plano'), 'gratis', 'B3 com o aceite do próprio usuário: conta criada');
reset role;
select is((select versao from public.auditor_aceites where user_id = 'a5000000-0000-4000-8000-000000000003'), 'termos-2026-10-21', 'B3 aceite registrado com a versão');

-- B4: teto global de 300 links por hora.
insert into public.auditor_acesso_tentativas (chave_email, chave_ip) select md5('g' || g) || md5('h' || g), md5('i' || g) || md5('j' || g) from generate_series(1, 300) g;
select is((select permitido from public.auditor_acesso_preparar('nova-r@example.test', repeat('b', 64), repeat('c', 64))), false, 'B4 teto global de 300 por hora');
delete from public.auditor_acesso_tentativas;

-- B5: relatório preso em coletando volta à fila; na 3ª tentativa, falhou.
insert into public.auditor_relatorios (id, client_id, tipo, periodo_de, periodo_ate, estado, iniciado_em, tentativas)
select 'a5200000-0000-4000-8000-000000000001'::uuid, negocio, 'semanal', date '2026-01-05', date '2026-01-11', 'coletando', now() - interval '21 minutes', 1 from rv
union all
select 'a5200000-0000-4000-8000-000000000002', negocio, 'semanal', date '2026-01-12', date '2026-01-18', 'gerando', now() - interval '21 minutes', 3 from rv
union all
select 'a5200000-0000-4000-8000-000000000003', negocio, 'semanal', date '2026-01-19', date '2026-01-25', 'coletando', now() - interval '5 minutes', 1 from rv;
create temp table pegos on commit drop as select id from public.auditor_claim_relatorios(10);
select is((select count(*)::int from pegos where id = 'a5200000-0000-4000-8000-000000000001'), 1, 'B5 o preso há mais de 20 min volta à fila');
select is((select count(*)::int from pegos where id in ('a5200000-0000-4000-8000-000000000002', 'a5200000-0000-4000-8000-000000000003')), 0, 'B5 o de 5 min e o da 3ª tentativa não voltam');
select is((select tentativas::int from public.auditor_relatorios where id = 'a5200000-0000-4000-8000-000000000001'), 2, 'B5 conta a nova tentativa');
select is((select estado from public.auditor_relatorios where id = 'a5200000-0000-4000-8000-000000000002'), 'falhou', 'B5 preso na 3ª tentativa: falhou');
select is((select estado from public.auditor_relatorios where id = 'a5200000-0000-4000-8000-000000000003'), 'coletando', 'B5 em andamento há 5 min fica');

-- C: concessão de suporte acima de 72 h é recusada pela própria tabela.
select throws_ok($$insert into public.auditor_acessos_suporte (client_id, concedido_por, expira_em) select negocio, 'a5000000-0000-4000-8000-000000000001', now() + interval '73 hours' from rv$$,
  '23514', null, 'C concessão de 73 h barrada pela tabela');

-- B8: a exclusão anonimiza também a assinatura antiga sem conta, do mesmo e-mail.
insert into public.auditor_assinaturas (id, plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto)
values ('a5300000-0000-4000-8000-000000000001', 'mensal', 'Dona Antiga', 'DONA-R@example.test', '11955554444', 'sub_r_antiga', 'cancelada', now(), 'Aceito');
create temp table cont_r on commit drop as select conta from rv;
select public.auditor_apagar_conta((select conta from cont_r), 'cliente');
select is((select nome from public.auditor_assinaturas where id = 'a5300000-0000-4000-8000-000000000001'), '[excluído]', 'B8 assinatura antiga do mesmo e-mail anonimizada');

-- A4: usuário apagado por fora (painel do Auth) não deixa negócio, conexão nem segredo órfãos.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('a5000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'apagada@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now());
select public.auditor_primeiro_acesso('a5000000-0000-4000-8000-000000000004', 'apagada@example.test', 'https://apagada.example');
create temp table ap on commit drop as select m.client_id as negocio from public.memberships m where m.user_id = 'a5000000-0000-4000-8000-000000000004';
select public.marketing_cliente_conexao_salvar((select negocio from ap), 'meta', 'TOKEN-AP', array['ads_read'], null, 'meta-ap', 'a5000000-0000-4000-8000-000000000004');
insert into public.auditor_assinaturas (plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto, conta_id)
select 'mensal', 'Apagada', 'apagada@example.test', '11944443333', 'sub_ap', 'cancelada', now(), 'Aceito', id from public.auditor_contas where dono_user_id = 'a5000000-0000-4000-8000-000000000004';
delete from auth.users where id = 'a5000000-0000-4000-8000-000000000004';
select is((select count(*)::int from public.clients where id = (select negocio from ap)), 0, 'A4 usuário apagado por fora: negócio some');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id = (select negocio from ap)), 0, 'A4 conexões somem');
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:' || (select negocio from ap) || ':%'), 0, 'A4 segredo sai do Vault');
select is((select nome from public.auditor_assinaturas where pagarme_subscription_id = 'sub_ap'), '[excluído]', 'A4 assinatura anonimizada');

-- B9: uma conta que falha na exclusão não derruba a limpeza das outras.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('a5000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'falha@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now()),
  ('a5000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'segue@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now());
select public.auditor_primeiro_acesso('a5000000-0000-4000-8000-000000000005', 'falha@example.test', null);
select public.auditor_primeiro_acesso('a5000000-0000-4000-8000-000000000006', 'segue@example.test', null);
update public.auditor_contas set excluir_apos = now() - interval '1 minute'
 where dono_user_id in ('a5000000-0000-4000-8000-000000000005', 'a5000000-0000-4000-8000-000000000006');
create function pg_temp.falha_de_proposito() returns trigger language plpgsql as $f$
begin
  if old.email = 'falha@example.test' then raise exception 'falha de teste'; end if;
  return old;
end;
$f$;
create trigger falha_de_proposito before delete on public.clients for each row execute function pg_temp.falha_de_proposito();
select is((public.auditor_limpar() ->> 'falhas')::int >= 1, true, 'B9 a conta com erro é contada como falha');
select is((select count(*)::int from public.auditor_contas where dono_user_id = 'a5000000-0000-4000-8000-000000000006'), 0, 'B9 a outra conta foi apagada mesmo assim');
select is((select count(*)::int from public.auditor_contas where dono_user_id = 'a5000000-0000-4000-8000-000000000005'), 1, 'B9 a conta com erro fica para a próxima');
drop trigger falha_de_proposito on public.clients;

select * from finish();
rollback;
