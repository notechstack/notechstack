-- Conexões por cliente do auditor (20261021120000): Vault, RLS "cliente A não lê cliente B",
-- RPCs só para a service role, nonce de uso único, revogação e limpeza do Vault.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('c1aaaaaa-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'cli-a@example.test', '{"role":"CLIENT"}', '{}', now(), now()),
  ('c1bbbbbb-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'cli-b@example.test', '{"role":"CLIENT"}', '{}', now(), now()),
  ('c1cccccc-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'fora@example.test', '{}', '{}', now(), now()),
  ('c1dddddd-0000-4000-8000-00000000000d', 'authenticated', 'authenticated', 'admin@example.test', '{"role":"NO_ADMIN"}', '{}', now(), now());

insert into public.clients (id, name, slug) values
  ('c1000000-0000-4000-8000-00000000000a', 'Cliente A', 'auditor-cli-a'),
  ('c1000000-0000-4000-8000-00000000000b', 'Cliente B', 'auditor-cli-b'),
  ('c1000000-0000-4000-8000-00000000000c', 'Cliente C (sem membros)', 'auditor-cli-c');

insert into public.memberships (user_id, client_id, role) values
  ('c1aaaaaa-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-00000000000a', 'CLIENT'),
  ('c1bbbbbb-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-00000000000b', 'CLIENT');

-- Escritas pela service role (a Edge Function).
set local role service_role;
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000a', 'meta', 'fixture-token-meta-A',
  array['ads_read'], now() + interval '60 days', 'fb-user-a', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'V1 service_role salva conexão Meta do cliente A');
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000a', 'google', 'fixture-refresh-google-A',
  array['https://www.googleapis.com/auth/analytics.readonly'], null, null, 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'V1 service_role salva conexão Google do cliente A');
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000b', 'meta', 'fixture-token-meta-B',
  array['ads_read'], null, 'fb-user-b', 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'V1 service_role salva conexão Meta do cliente B');
select lives_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000a', 'meta',
  '[{"tipo":"meta_ads","external_id":"act_111","nome":"Loja A"}]', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'V1 service_role grava seleção do cliente A');
select lives_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000b', 'meta',
  '[{"tipo":"meta_ads","external_id":"act_222","nome":"Loja B"}]', 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'V1 service_role grava seleção do cliente B');

select throws_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000a', 'meta', 'x',
  array['ads_read'], null, null, 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'P0001', 'autor não autorizado para este cliente',
  'V2 membro de B não conecta o cliente A');
select throws_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000b', 'google',
  '[{"tipo":"ga4","external_id":"1"}]', 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'P0001', 'conexão ausente', 'V2 seleção exige conexão ativa');
select throws_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000a', 'meta',
  '[{"tipo":"meta_ads","external_id":"123"}]', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, '23514', null, 'V2 meta_ads exige act_*');
select throws_ok($$select public.marketing_cliente_ativos_salvar('c1000000-0000-4000-8000-00000000000a', 'meta',
  '[{"tipo":"ga4","external_id":"1"}]', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'P0001', 'tipo fora do provedor', 'V2 tipo precisa ser do provedor');
reset role;

-- V3: token só no Vault, cifrado; a tabela não tem coluna de token.
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:%'), 3, 'V3 três segredos no Vault');
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:%' and secret like 'fixture-%'), 0, 'V3 Vault guarda cifrado, não em texto');
select is((select count(*)::int from information_schema.columns where table_schema = 'public'
  and table_name in ('marketing_cliente_conexoes', 'marketing_cliente_ativos', 'marketing_cliente_eventos')
  and column_name ~ '(token|secret)' and column_name <> 'vault_secret_id'), 0, 'V3 nenhuma coluna de token nas tabelas');
set local role service_role;
select is((select token from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000a', 'meta')), 'fixture-token-meta-A', 'V3 service_role lê o token de A pela RPC');
select is((select token from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000b', 'meta')), 'fixture-token-meta-B', 'V3 e o de B separado');
reset role;

-- V4: cliente A não lê cliente B (e vice-versa).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1aaaaaa-0000-4000-8000-00000000000a","role":"authenticated","app_metadata":{"role":"CLIENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 2, 'V4 A vê as duas conexões dele');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id <> 'c1000000-0000-4000-8000-00000000000a'), 0, 'V4 A não vê conexão de B');
select is((select count(*)::int from public.marketing_cliente_ativos), 1, 'V4 A vê só a própria seleção');
select is((select external_id from public.marketing_cliente_ativos), 'act_111', 'V4 seleção de A é act_111');
select is((select count(*)::int from public.marketing_cliente_eventos where client_id <> 'c1000000-0000-4000-8000-00000000000a'), 0, 'V4 A não vê eventos de B');
select throws_ok($$select vault_secret_id from public.marketing_cliente_conexoes$$, '42501', null, 'V4 A não lê vault_secret_id');
select throws_ok($$select usuario_externo from public.marketing_cliente_conexoes$$, '42501', null, 'V4 A não lê usuario_externo');
select throws_ok($$select login_customer_id from public.marketing_cliente_ativos$$, '42501', null, 'V4 A não lê login_customer_id');
select throws_ok($$select * from vault.decrypted_secrets$$, '42501', null, 'V4 A não lê o Vault');
select throws_ok($$update public.marketing_cliente_conexoes set estado = 'erro'$$, '42501', null, 'V4 A não altera conexão');
select throws_ok($$delete from public.marketing_cliente_ativos$$, '42501', null, 'V4 A não apaga seleção');
select throws_ok($$insert into public.marketing_cliente_ativos (client_id, tipo, external_id) values ('c1000000-0000-4000-8000-00000000000b', 'ga4', '1')$$, '42501', null, 'V4 A não grava seleção em B');
select throws_ok($$select * from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000a', 'meta')$$, '42501', null, 'V4 A não chama a RPC de token nem do próprio cliente');
select throws_ok($$select public.marketing_cliente_conexao_revogar('c1000000-0000-4000-8000-00000000000b', 'meta', null)$$, '42501', null, 'V4 A não revoga B');
select throws_ok($$select public.marketing_oauth_nonce_consumir('aa')$$, '42501', null, 'V4 A não mexe em nonce');
select throws_ok($$select 1 from public.marketing_oauth_nonces$$, '42501', null, 'V4 A não lê nonces');

select set_config('request.jwt.claims', '{"sub":"c1bbbbbb-0000-4000-8000-00000000000b","role":"authenticated","app_metadata":{"role":"CLIENT"}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 1, 'V4 B vê só a própria conexão');
select is((select client_id from public.marketing_cliente_conexoes), 'c1000000-0000-4000-8000-00000000000b'::uuid, 'V4 B não vê A');
select is((select count(*)::int from public.marketing_cliente_ativos where client_id = 'c1000000-0000-4000-8000-00000000000a'), 0, 'V4 B não vê seleção de A');

select set_config('request.jwt.claims', '{"sub":"c1cccccc-0000-4000-8000-00000000000c","role":"authenticated","app_metadata":{}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 0, 'V4 sem membership não vê nada');

select set_config('request.jwt.claims', '{"sub":"c1dddddd-0000-4000-8000-00000000000d","role":"authenticated","app_metadata":{"role":"NO_ADMIN"}}', true);
select is((select count(*)::int from public.marketing_cliente_conexoes), 3, 'V4 NO_ADMIN vê todas (suporte)');
select throws_ok($$select vault_secret_id from public.marketing_cliente_conexoes$$, '42501', null, 'V4 nem o NO_ADMIN lê o id do segredo pelo navegador');
reset role;

set local role anon;
select throws_ok($$select 1 from public.marketing_cliente_conexoes$$, '42501', null, 'V4 anon não lê conexões');
select throws_ok($$select public.marketing_cliente_membro('c1000000-0000-4000-8000-00000000000a')$$, '42501', null, 'V4 anon não chama marketing_cliente_membro');
reset role;

select is((select count(*)::int from information_schema.routine_privileges
  where routine_schema = 'public' and routine_name ~ '^marketing_(cliente|oauth)_' and routine_name <> 'marketing_cliente_membro'
    and grantee in ('anon', 'authenticated', 'PUBLIC')), 0, 'V4 nenhuma RPC de token/nonce executável por anon/authenticated');

-- V5: nonce de uso único e com validade.
set local role service_role;
select lives_ok($$select public.marketing_oauth_nonce_registrar(repeat('a', 64), now() + interval '10 minutes')$$, 'V5 registra nonce');
select is(public.marketing_oauth_nonce_consumir(repeat('a', 64)), true, 'V5 primeiro uso vale');
select is(public.marketing_oauth_nonce_consumir(repeat('a', 64)), false, 'V5 segundo uso não vale');
select lives_ok($$select public.marketing_oauth_nonce_registrar(repeat('b', 64), now() - interval '1 second')$$, 'V5 registra nonce vencido');
select is(public.marketing_oauth_nonce_consumir(repeat('b', 64)), false, 'V5 nonce vencido não vale');
select throws_ok($$select public.marketing_oauth_nonce_registrar('curto', now())$$, '23514', null, 'V5 nonce fora do formato');
reset role;

-- V6: reconectar com outra conta da Meta limpa a seleção antiga.
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000b', 'meta', 'fixture-token-meta-B2',
  array['ads_read'], null, 'fb-user-outro', 'c1bbbbbb-0000-4000-8000-00000000000b')$$, 'V6 reconexão de B');
select is((select count(*)::int from public.marketing_cliente_ativos where client_id = 'c1000000-0000-4000-8000-00000000000b'), 0, 'V6 seleção de B zerada');
select is((select token from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000b', 'meta')), 'fixture-token-meta-B2', 'V6 Vault atualizado no mesmo segredo');
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:c1000000-0000-4000-8000-00000000000b:%'), 1, 'V6 sem segredo duplicado');

-- V7: expirado deixa de entregar token.
select lives_ok($$select public.marketing_cliente_conexao_marcar('c1000000-0000-4000-8000-00000000000a', 'google', 'expirado', 'Google: invalid_grant')$$, 'V7 marca expirado');
select is((select count(*)::int from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000a', 'google')), 0, 'V7 token expirado não é entregue');

-- V8: revogar apaga do Vault e a seleção; a linha fica como trilha.
select lives_ok($$select public.marketing_cliente_conexao_revogar('c1000000-0000-4000-8000-00000000000a', 'meta', 'c1aaaaaa-0000-4000-8000-00000000000a')$$, 'V8 revoga Meta de A');
select is((select count(*)::int from vault.secrets where name = 'marketing_cliente:c1000000-0000-4000-8000-00000000000a:meta'), 0, 'V8 segredo saiu do Vault');
select is((select estado from public.marketing_cliente_conexoes where client_id = 'c1000000-0000-4000-8000-00000000000a' and provedor = 'meta'), 'revogado', 'V8 estado revogado');
select is((select count(*)::int from public.marketing_cliente_ativos where client_id = 'c1000000-0000-4000-8000-00000000000a' and tipo = 'meta_ads'), 0, 'V8 seleção Meta de A apagada');
select is((select count(*)::int from public.marketing_cliente_token_ler('c1000000-0000-4000-8000-00000000000a', 'meta')), 0, 'V8 sem token depois de revogar');
select lives_ok($$select public.marketing_cliente_conexao_revogar('c1000000-0000-4000-8000-00000000000a', 'meta', null)$$, 'V8 revogar de novo é idempotente');
select is((select count(*)::int from public.marketing_cliente_eventos where client_id = 'c1000000-0000-4000-8000-00000000000a' and evento = 'revogou'), 1, 'V8 um evento de revogação');

-- V9: cliente apagado (LGPD) leva o segredo do Vault junto.
select lives_ok($$select public.marketing_cliente_conexao_salvar('c1000000-0000-4000-8000-00000000000c', 'google', 'fixture-refresh-C',
  array['https://www.googleapis.com/auth/webmasters.readonly'], null, null, 'c1dddddd-0000-4000-8000-00000000000d')$$, 'V9 NO_ADMIN conecta por um cliente');
delete from public.clients where id = 'c1000000-0000-4000-8000-00000000000c';
select is((select count(*)::int from vault.secrets where name like 'marketing_cliente:c1000000-0000-4000-8000-00000000000c:%'), 0, 'V9 segredo apagado com o cliente');
select is((select count(*)::int from public.marketing_cliente_conexoes where client_id = 'c1000000-0000-4000-8000-00000000000c'), 0, 'V9 conexão apagada com o cliente');

select * from finish();
rollback;
