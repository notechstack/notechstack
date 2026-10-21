-- Migration A do auditor (20261021120000): identidade, Vault, RLS, RPCs só para a
-- service role, nonce de uso único, desconexão, deauthorize e limpeza do Vault.
-- Provas exigidas pela spec: A não lê B; NO_ADMIN sem concessão não lê;
-- MARKETING_AGENT não lê nada; vault_secret_id ilegível para authenticated.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('c1aaaaaa-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'cli-a@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now()),
  ('c1bbbbbb-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'cli-b@example.test', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now()),
  ('c1cccccc-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'projeto@example.test', '{"role":"CLIENT"}', '{}', now(), now()),
  ('c1dddddd-0000-4000-8000-00000000000d', 'authenticated', 'authenticated', 'admin@example.test', '{"role":"NO_ADMIN"}', '{}', now(), now()),
  ('c1eeeeee-0000-4000-8000-00000000000e', 'authenticated', 'authenticated', 'dot@example.test', '{"role":"MARKETING_AGENT"}', '{}', now(), now());

-- I1: identidade.
select is((select origem from public.clients where slug = 'no-tech-stack'), 'interno', 'I1 a Nó é origem interno');
insert into public.clients (id, name, slug, origem) values
  ('c1000000-0000-4000-8000-00000000000a', 'Negócio A', 'auditor-cli-a', 'auditor'),
  ('c1000000-0000-4000-8000-00000000000b', 'Negócio B', 'auditor-cli-b', 'auditor'),
  ('c1000000-0000-4000-8000-00000000000c', 'Projeto C', 'auditor-cli-c', 'projeto');
select is((select origem from public.clients where slug = 'auditor-cli-c'), 'projeto', 'I1 default projeto');
select throws_ok($$insert into public.clients (name, slug, origem) values ('x', 'auditor-x', 'outro')$$, '23514', null, 'I1 origem fora da lista');

insert into public.memberships (user_id, client_id, role) values
  ('c1aaaaaa-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 'AUDITOR'),
  ('c1bbbbbb-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-00000000000b', 'AUDITOR'),
  ('c1cccccc-0000-4000-8000-00000000000c', 'c1000000-0000-4000-8000-00000000000c', 'CLIENT');
-- Posse dos negócios (migration B, revisão A1): é a conta do auditor, não o vínculo, que dá acesso.
insert into public.auditor_contas (id, dono_user_id) values
  ('c1c00000-0000-4000-8000-00000000000a', 'c1aaaaaa-0000-4000-8000-00000000000a'),
  ('c1c00000-0000-4000-8000-00000000000b', 'c1bbbbbb-0000-4000-8000-00000000000b');
insert into public.auditor_clientes (client_id, conta_id) values
  ('c1000000-0000-4000-8000-00000000000a', 'c1c00000-0000-4000-8000-00000000000a'),
  ('c1000000-0000-4000-8000-00000000000b', 'c1c00000-0000-4000-8000-00000000000b');
select throws_ok($$insert into public.memberships (user_id, client_id, role) values ('c1dddddd-0000-4000-8000-00000000000d', 'c1000000-0000-4000-8000-00000000000a', 'DONO')$$,
  '23514', null, 'I1 papel de membership só CLIENT ou AUDITOR');

-- V1: escritas pela service role (a Edge Function).
set local role service_role;
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000a', 'meta', 'fixture-token-meta-A',
  array['ads_read'], now() + interval '60 days', 'fb-user-a', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'V1 salva conexão Meta do negócio A');
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000a', 'google', 'fixture-refresh-google-A',
  array['https://www.googleapis.com/auth/analytics.readonly'], null, null, 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'V1 salva conexão Google do negócio A');
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000b', 'meta', 'fixture-token-meta-B',
  array['ads_read'], null, 'fb-user-b', 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'V1 salva conexão Meta do negócio B');
select lives_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000a', 'meta',
  '[{"tipo":"meta_ads","external_id":"act_111","nome":"Loja A","moeda":"BRL"}]', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'V1 grava seleção do negócio A');
select lives_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000b', 'meta',
  '[{"tipo":"meta_ads","external_id":"act_222","nome":"Loja B"}]', 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'V1 grava seleção do negócio B');

-- V2: quem não pode conectar.
select throws_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000a', 'meta', 'x',
  array['ads_read'], null, null, 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'P0001', 'autor não autorizado para este cliente', 'V2 membro de B não conecta A');
select throws_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000a', 'meta', 'x',
  array['ads_read'], null, null, 'c1dddddd-0000-4000-8000-00000000000d')$$, 'P0001', 'autor não autorizado para este cliente', 'V2 NO_ADMIN não conecta em nome do cliente');
select throws_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000c', 'meta', 'x',
  array['ads_read'], null, null, 'c1cccccc-0000-4000-8000-00000000000c')$$, 'P0001', 'autor não autorizado para este cliente', 'V2 membro CLIENT de projeto não conecta');
select throws_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000b', 'google',
  '[{"tipo":"ga4","external_id":"1"}]', 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'P0001', 'conexão ausente', 'V2 seleção exige conexão ativa');
select throws_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000a', 'meta',
  '[{"tipo":"meta_ads","external_id":"123"}]', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, '23514', null, 'V2 meta_ads exige act_*');
select throws_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000a', 'meta',
  '[{"tipo":"ga4","external_id":"1"}]', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'P0001', 'tipo fora do provedor', 'V2 tipo precisa ser do provedor');
select throws_ok($$select public.marketing_cliente_conexao_marcar('c1000000-0000-4000-8000-00000000000a', 'meta', 'expirado', 'Token EAAB… recusado')$$,
  '23514', null, 'V2 ultimo_erro só aceita código, nunca texto cru');
reset role;

-- V3: token só no Vault, cifrado; nenhuma coluna de token nas tabelas.
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:%'), 3, 'V3 três segredos no Vault');
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:%' and secret like 'fixture-%'), 0, 'V3 Vault guarda cifrado');
select is((select count(*)::int from information_schema.columns where table_schema = 'public'
  and table_name in ('marketing_cliente_conexoes', 'marketing_cliente_ativos', 'marketing_cliente_eventos')
  and column_name ~ '(token|secret)' and column_name <> 'vault_secret_id'), 0, 'V3 nenhuma coluna de token');
set local role service_role;
select is((select token from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000a', 'meta')), 'fixture-token-meta-A', 'V3 service_role lê o token de A pela RPC');
select is((select token from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000b', 'meta')), 'fixture-token-meta-B', 'V3 e o de B separado');
reset role;

-- V4: A não lê B (e vice-versa).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1aaaaaa-0000-4000-8000-00000000000a","role":"authenticated","app_metadata":{"role":"AUDITOR_CLIENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 2, 'V4 A vê as duas conexões dele');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id <> 'c1000000-0000-4000-8000-00000000000a'), 0, 'V4 A não vê conexão de B');
select is((select external_id from public.marketing_cliente_ativos), 'act_111', 'V4 A vê só a própria seleção');
select is((select moeda from public.marketing_cliente_ativos), 'BRL', 'V4 com moeda');
select throws_ok($$select vault_secret_id from public.marketing_cliente_conexoes$$, '42501', null, 'V4 vault_secret_id ilegível');
select throws_ok($$select usuario_externo from public.marketing_cliente_conexoes$$, '42501', null, 'V4 usuario_externo ilegível');
select throws_ok($$select id from public.marketing_cliente_eventos$$, '42501', null, 'V4 eventos sem grant ao navegador');
select throws_ok($$select * from vault.decrypted_secrets$$, '42501', null, 'V4 A não lê o Vault');
select throws_ok($$update public.marketing_cliente_conexoes set estado = 'erro'$$, '42501', null, 'V4 A não altera conexão');
select throws_ok($$delete from public.marketing_cliente_ativos$$, '42501', null, 'V4 A não apaga seleção');
select throws_ok($$insert into public.marketing_cliente_ativos (client_id, conexao_id, tipo, external_id) values ('c1000000-0000-4000-8000-00000000000b', gen_random_uuid(), 'ga4', '1')$$, '42501', null, 'V4 A não grava em B');
select throws_ok($$select * from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000a', 'meta')$$, '42501', null, 'V4 A não chama a RPC de token nem do próprio negócio');
select throws_ok($$select public.marketing_cliente_conexao_encerrar('c1000000-0000-4000-8000-00000000000b', 'meta', 'desconectado', null, 'x')$$, '42501', null, 'V4 A não desconecta B');
select throws_ok($$select public.marketing_oauth_nonce_consumir('aa')$$, '42501', null, 'V4 A não mexe em nonce');
select throws_ok($$select 1 from public.marketing_oauth_nonces$$, '42501', null, 'V4 A não lê nonces');

select set_config('request.jwt.claims', '{"sub":"c1bbbbbb-0000-4000-8000-00000000000b","role":"authenticated","app_metadata":{"role":"AUDITOR_CLIENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 1, 'V4 B vê só a própria conexão');
select is((select client_id from public.marketing_cliente_conexoes), 'c1000000-0000-4000-8000-00000000000b'::uuid, 'V4 B não vê A');
select is((select count(*)::int from public.marketing_cliente_ativos where client_id = 'c1000000-0000-4000-8000-00000000000a'), 0, 'V4 B não vê seleção de A');

-- V5: NO_ADMIN sem concessão, MARKETING_AGENT e CLIENT de projeto não leem nada.
select set_config('request.jwt.claims', '{"sub":"c1dddddd-0000-4000-8000-00000000000d","role":"authenticated","aal":"aal2","app_metadata":{"role":"NO_ADMIN"}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 0, 'V5 NO_ADMIN sem concessão não lê conexões');
select is((select count(*)::int from public.marketing_cliente_ativos), 0, 'V5 NO_ADMIN sem concessão não lê ativos');
select throws_ok($$select vault_secret_id from public.marketing_cliente_conexoes$$, '42501', null, 'V5 nem o NO_ADMIN lê o id do segredo pelo navegador');
select set_config('request.jwt.claims', '{"sub":"c1eeeeee-0000-4000-8000-00000000000e","role":"authenticated","app_metadata":{"role":"MARKETING_AGENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 0, 'V5 MARKETING_AGENT não lê conexões');
select is((select count(*)::int from public.marketing_cliente_ativos), 0, 'V5 MARKETING_AGENT não lê ativos');
select set_config('request.jwt.claims', '{"sub":"c1cccccc-0000-4000-8000-00000000000c","role":"authenticated","app_metadata":{"role":"CLIENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 0, 'V5 CLIENT de projeto não lê conexões do auditor');
reset role;

set local role anon;
select throws_ok($$select 1 from public.marketing_cliente_conexoes$$, '42501', null, 'V5 anon não lê conexões');
select throws_ok($$select public.auditor_pode_ler('c1000000-0000-4000-8000-00000000000a')$$, '42501', null, 'V5 anon não chama auditor_pode_ler');
reset role;

select is((select count(*)::int from information_schema.routine_privileges
  where routine_schema = 'public' and routine_name ~ '^marketing_(cliente|oauth|meta)_'
    and grantee in ('anon', 'authenticated', 'PUBLIC')), 0, 'V5 nenhuma RPC executável por anon/authenticated');

-- V6: nonce de uso único e com validade.
set local role service_role;
select lives_ok($$select public.marketing_oauth_nonce_registrar(repeat('a', 64), now() + interval '10 minutes')$$, 'V6 registra nonce');
select is(public.marketing_oauth_nonce_consumir(repeat('a', 64)), true, 'V6 primeiro uso vale');
select is(public.marketing_oauth_nonce_consumir(repeat('a', 64)), false, 'V6 segundo uso não vale');
select lives_ok($$select public.marketing_oauth_nonce_registrar(repeat('b', 64), now() - interval '1 second')$$, 'V6 registra nonce vencido');
select is(public.marketing_oauth_nonce_consumir(repeat('b', 64)), false, 'V6 nonce vencido não vale');
select throws_ok($$select public.marketing_oauth_nonce_registrar('curto', now())$$, '23514', null, 'V6 nonce fora do formato');
reset role;

-- V7: reconectar com outra conta da Meta limpa a seleção antiga, no mesmo segredo.
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000b', 'meta', 'fixture-token-meta-B2',
  array['ads_read'], null, 'fb-user-outro', 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'V7 reconexão de B');
select is((select count(*)::int from public.marketing_cliente_ativos where client_id = 'c1000000-0000-4000-8000-00000000000b'), 0, 'V7 seleção de B zerada');
select is((select token from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000b', 'meta')), 'fixture-token-meta-B2', 'V7 Vault atualizado');
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:c1000000-0000-4000-8000-00000000000b:%'), 1, 'V7 sem segredo duplicado');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id = 'c1000000-0000-4000-8000-00000000000b'), 1, 'V7 continua uma conexão viva');

-- V8: expirado (só código) deixa de entregar token; verificado marca a data.
select lives_ok($$select public.marketing_cliente_conexao_marcar('c1000000-0000-4000-8000-00000000000a', 'meta', 'verificado', null)$$, 'V8 marca verificado');
select isnt((select verificado_em from public.marketing_cliente_conexoes where client_id = 'c1000000-0000-4000-8000-00000000000a' and provedor = 'meta'), null, 'V8 verificado_em preenchido');
select lives_ok($$select public.marketing_cliente_conexao_marcar('c1000000-0000-4000-8000-00000000000a', 'google', 'expirado', 'google_invalid_grant')$$, 'V8 marca expirado');
select is((select count(*)::int from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000a', 'google')), 0, 'V8 token expirado não é entregue');

-- V9: desconectar apaga Vault e seleção; a linha fica como histórico e libera nova conexão.
select is(public.marketing_cliente_conexao_encerrar('c1000000-0000-4000-8000-00000000000a', 'meta', 'desconectado', 'c1aaaaaa-0000-4000-8000-00000000000a', 'AUDITOR'), true, 'V9 desconecta Meta de A');
select is((select count(*)::int from vault.secrets where name = 'marketing_cliente:c1000000-0000-4000-8000-00000000000a:meta'), 0, 'V9 segredo saiu do Vault');
select is((select count(*)::int from public.marketing_cliente_ativos where client_id = 'c1000000-0000-4000-8000-00000000000a' and tipo = 'meta_ads'), 0, 'V9 seleção Meta de A apagada');
select is(public.marketing_cliente_conexao_encerrar('c1000000-0000-4000-8000-00000000000a', 'meta', 'desconectado', null, 'AUDITOR'), false, 'V9 desconectar de novo é idempotente');
select is((select count(*)::int from public.marketing_cliente_eventos where client_id = 'c1000000-0000-4000-8000-00000000000a' and acao = 'desconectou'), 1, 'V9 um evento de desconexão');
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000a', 'meta', 'fixture-token-meta-A2',
  array['ads_read'], null, 'fb-user-a', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'V9 reconecta depois de desconectar');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id = 'c1000000-0000-4000-8000-00000000000a' and provedor = 'meta'), 2,
  'V9 histórico desconectado + nova conexão viva');

-- V10: deauthorize da Meta encerra como revogado todas as conexões do usuário externo.
select is(public.marketing_meta_desautorizar('fb-user-a'), 1, 'V10 deauthorize encerra a conexão viva de A');
select is((select estado from public.marketing_cliente_conexoes where client_id = 'c1000000-0000-4000-8000-00000000000a' and provedor = 'meta' and estado <> 'desconectado'), 'revogado', 'V10 estado revogado');
select is((select count(*)::int from vault.secrets where name = 'marketing_cliente:c1000000-0000-4000-8000-00000000000a:meta'), 0, 'V10 segredo apagado');
select is(public.marketing_meta_desautorizar('fb-user-a'), 0, 'V10 deauthorize repetido não faz nada');
select is(public.marketing_meta_desautorizar('desconhecido'), 0, 'V10 usuário desconhecido não faz nada');

-- V11: negócio apagado (LGPD) leva o segredo do Vault; a trilha sobrevive.
delete from public.memberships where client_id = 'c1000000-0000-4000-8000-00000000000b';
delete from public.clients where id = 'c1000000-0000-4000-8000-00000000000b';
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:c1000000-0000-4000-8000-00000000000b:%'), 0, 'V11 segredo apagado com o negócio');
select cmp_ok((select count(*)::int from public.marketing_cliente_eventos where client_id = 'c1000000-0000-4000-8000-00000000000b'), '>', 0, 'V11 trilha sobrevive à exclusão');

select * from finish();
rollback;
