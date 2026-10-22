-- Agente fiscal v2, lote B (.checks/agente-fiscal-v2.md): C41 ("agendado ainda emite"), C44b
-- ("agendar pelo WhatsApp", contrato com o lote C) e os objetos da migração
-- 20261024110000_agente_fiscal_v2_conta.sql (privilégios, job e segredo do ciclo).
-- Tudo roda numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

-- No Postgres 15 criar um papel não dá ao criador o direito de assumi-lo.
grant nofiscal_service to postgres;
grant usage on schema extensions to nofiscal_service, service_role;

-- Dono de A (fora do teste), de B (no teste) e de C (sem assinatura); D emite com cancelamento agendado.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('b2500000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'v2b-a@example.test', '{}', '{}', now(), now()),
  ('b2500000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'v2b-b@example.test', '{}', '{}', now(), now()),
  ('b2500000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'v2b-c@example.test', '{}', '{}', now(), now()),
  ('b2500000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'v2b-d@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('b2600000-0000-4000-8000-000000000001', 'V2B A', 'v2b-teste-a'),
  ('b2600000-0000-4000-8000-000000000002', 'V2B B', 'v2b-teste-b'),
  ('b2600000-0000-4000-8000-000000000003', 'V2B C', 'v2b-teste-c'),
  ('b2600000-0000-4000-8000-000000000004', 'V2B D', 'v2b-teste-d');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, trial_ends_at, onboarding_etapa
) values
  ('b2700000-0000-4000-8000-000000000001', '81444777000161', 'V2B A', '3550308', repeat('a', 64), 'inicial', 20,
   'b2600000-0000-4000-8000-000000000001', '010701', 6, null, 'concluido'),
  ('b2700000-0000-4000-8000-000000000002', '82444777000161', 'V2B B', '3550308', repeat('b', 64), 'pro', 100,
   'b2600000-0000-4000-8000-000000000002', '010701', 6, now() + interval '3 days', 'concluido'),
  ('b2700000-0000-4000-8000-000000000003', '83444777000161', 'V2B C', '3550308', repeat('c', 64), 'inicial', 20,
   'b2600000-0000-4000-8000-000000000003', null, null, null, 'pagamento'),
  ('b2700000-0000-4000-8000-000000000004', '84444777000161', 'V2B D', '3550308', repeat('d', 64), 'inicial', 20,
   'b2600000-0000-4000-8000-000000000004', '010701', 6, null, 'concluido');
insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values
  ('b2500000-0000-4000-8000-000000000001', 'v2b-a@example.test', '+5511900000001', now(), 'b2600000-0000-4000-8000-000000000001'),
  ('b2500000-0000-4000-8000-000000000002', 'v2b-b@example.test', '+5511900000002', now(), 'b2600000-0000-4000-8000-000000000002'),
  ('b2500000-0000-4000-8000-000000000003', 'v2b-c@example.test', '+5511900000003', now(), 'b2600000-0000-4000-8000-000000000003'),
  ('b2500000-0000-4000-8000-000000000004', 'v2b-d@example.test', '+5511900000004', now(), 'b2600000-0000-4000-8000-000000000004');

-- A: paga, sem teste, criada há 10 dias (âncora do ciclo = dia UTC da criação).
-- B: no teste. D: paga com cancelamento agendado para daqui a 10 dias, certificado válido.
insert into nofiscal.fiscal_subscriptions
  (id, tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto, created_at,
   cancelamento_agendado_para, cancelamento_pedido_em, cancelamento_origem)
values
  ('b2800000-0000-4000-8000-000000000001', 'b2700000-0000-4000-8000-000000000001', 'inicial', false,
   'sub_v2b_a', 'paga', now(), 'aceite', (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC') - interval '10 days',
   null, null, null),
  ('b2800000-0000-4000-8000-000000000002', 'b2700000-0000-4000-8000-000000000002', 'pro', true,
   'sub_v2b_b', 'pendente', now(), 'aceite', now(), null, null, null),
  ('b2800000-0000-4000-8000-000000000004', 'b2700000-0000-4000-8000-000000000004', 'inicial', false,
   'sub_v2b_d', 'paga', now(), 'aceite', now(), now() + interval '10 days', now(), 'site');
select nofiscal.upsert_certificate('b2700000-0000-4000-8000-000000000004', 'TESTPFXv2b', 'senha', 'CN=V2B D:84444777000161',
  now() + interval '1 year');
select nofiscal.upsert_certificate('b2700000-0000-4000-8000-000000000001', 'TESTPFXv2a', 'senha', 'CN=V2B A:81444777000161',
  now() + interval '1 year');

-- ---------------------------------------------------------------------------------------
-- Objetos e privilégios.
select has_function('nofiscal', 'agendar_cancelamento', array['uuid', 'text'], 'nofiscal.agendar_cancelamento existe');
select is((select prosecdef from pg_proc where oid = 'nofiscal.agendar_cancelamento(uuid,text)'::regprocedure), true,
  'agendar pelo WhatsApp: security definer');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'nofiscal.agendar_cancelamento(uuid,text)'::regprocedure),
  'agendar pelo WhatsApp: search_path vazio');
select ok(has_function_privilege('nofiscal_service', 'nofiscal.agendar_cancelamento(uuid,text)', 'execute'),
  'agendar pelo WhatsApp: nofiscal_service executa');
select ok(not has_function_privilege('service_role', 'nofiscal.agendar_cancelamento(uuid,text)', 'execute'),
  'agendar pelo WhatsApp: service_role não executa');
select ok(not has_function_privilege('authenticated', 'nofiscal.agendar_cancelamento(uuid,text)', 'execute'),
  'agendar pelo WhatsApp: authenticated não executa');
select ok(not has_function_privilege('anon', 'nofiscal.agendar_cancelamento(uuid,text)', 'execute'),
  'agendar pelo WhatsApp: anon não executa');
select ok(not has_function_privilege('nofiscal_service', 'nofiscal.agendar_cancelamento_com_fim(uuid,text,timestamptz)', 'execute'),
  'a regra interna não é executável pelo motor');
select ok(not has_function_privilege('service_role', 'nofiscal.agendar_cancelamento_com_fim(uuid,text,timestamptz)', 'execute'),
  'a regra interna não é executável pelas edge functions');

select ok(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute')
          and not has_function_privilege('authenticated', f, 'execute')
          and (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = f::regprocedure),
          f || ': security definer, search_path vazio, EXECUTE só service_role')
  from unnest(array[
    'public.fiscal_conta_estado(uuid)',
    'public.fiscal_configurar(uuid,jsonb)',
    'public.fiscal_trocar_plano(uuid,text)',
    'public.fiscal_agendar_cancelamento(uuid,timestamptz)',
    'public.fiscal_apagar_conta(uuid)',
    'public.fiscal_ciclo_segredo_ok(text)',
    'public.fiscal_cancelamentos_vencidos(integer)',
    'public.fiscal_invocar_ciclo()'
  ]) f;

-- ---------------------------------------------------------------------------------------
-- C44b · agendar pelo WhatsApp (como o motor: papel nofiscal_service).
set local role nofiscal_service;

select is(
  nofiscal.agendar_cancelamento('b2700000-0000-4000-8000-000000000001', 'whatsapp'),
  jsonb_build_object(
    'status', 'agendado',
    'cancelamento_agendado_para',
    ((date_trunc('day', now() at time zone 'UTC') - interval '10 days' + interval '1 month') at time zone 'UTC')
      - interval '1 second' - interval '1 hour'),
  'agendar pelo WhatsApp: fora do teste agenda o fim do período pago (fim do ciclo − 1 h)');

select is(
  nofiscal.agendar_cancelamento('b2700000-0000-4000-8000-000000000001', 'whatsapp'),
  jsonb_build_object(
    'status', 'agendado',
    'cancelamento_agendado_para',
    ((date_trunc('day', now() at time zone 'UTC') - interval '10 days' + interval '1 month') at time zone 'UTC')
      - interval '1 second' - interval '1 hour'),
  'agendar pelo WhatsApp: repetir devolve a mesma data');

select is(
  nofiscal.agendar_cancelamento('b2700000-0000-4000-8000-000000000002', 'whatsapp'),
  jsonb_build_object('status', 'agendado', 'cancelamento_agendado_para', now()),
  'agendar pelo WhatsApp: no teste agenda now()');

select is(
  nofiscal.agendar_cancelamento('b2700000-0000-4000-8000-000000000003', 'whatsapp'),
  '{"status": "sem_assinatura"}'::jsonb,
  'agendar pelo WhatsApp: sem assinatura → sem_assinatura');

select throws_ok(
  $$select nofiscal.agendar_cancelamento('b2700000-0000-4000-8000-000000000001', 'email')$$,
  '22023', null,
  'agendar pelo WhatsApp: origem fora de site/whatsapp é recusada');

-- O motor não executa a regra interna nem as funções das edge functions.
select throws_ok(
  $$select nofiscal.agendar_cancelamento_com_fim('b2700000-0000-4000-8000-000000000001', 'whatsapp', null)$$,
  '42501', null, 'agendar pelo WhatsApp: nofiscal_service não chama a regra interna');

-- C41 · agendado ainda emite (emission_block é do motor).
select is(nofiscal.emission_block('b2700000-0000-4000-8000-000000000004'), null,
  'agendado ainda emite: assinatura paga com cancelamento agendado no futuro libera a emissão');
select is(nofiscal.emission_block('b2700000-0000-4000-8000-000000000001'), null,
  'agendado ainda emite: depois de agendar pelo WhatsApp a emissão segue liberada');

reset role;

select is(
  (select row(cancelamento_origem, cancelamento_pedido_em = now(), status)::text
     from nofiscal.fiscal_subscriptions where id = 'b2800000-0000-4000-8000-000000000001'),
  row('whatsapp', true, 'paga')::text,
  'agendar pelo WhatsApp: grava origem e pedido, e o status continua paga');

-- Service role (edge functions) não chama o contrato do motor.
set local role service_role;
select throws_ok(
  $$select nofiscal.agendar_cancelamento('b2700000-0000-4000-8000-000000000001', 'whatsapp')$$,
  '42501', null, 'agendar pelo WhatsApp: service_role é recusado');
reset role;

-- Depois do aviso subscription.canceled, a emissão para.
select public.fiscal_aplicar_evento_assinatura('hook_v2b_d', 'subscription.canceled', 'sub_v2b_d', 'cancelada', '{}'::jsonb, now());
select is(nofiscal.emission_block('b2700000-0000-4000-8000-000000000004'), 'SUBSCRIPTION_CANCELLED',
  'agendado ainda emite: até o aviso de cancelamento, que bloqueia');

-- ---------------------------------------------------------------------------------------
-- Ciclo: fila, segredo e job.
select ok(
  (select public.fiscal_cancelamentos_vencidos(50) @> jsonb_build_array(jsonb_build_object('pagarme_subscription_id', 'sub_v2b_b'))),
  'ciclo: o cancelamento do teste (agendado now()) entra na fila');
select ok(
  not (select public.fiscal_cancelamentos_vencidos(50) @> jsonb_build_array(jsonb_build_object('pagarme_subscription_id', 'sub_v2b_a'))),
  'ciclo: o agendado para o fim do período não entra antes da data');

select is(public.fiscal_ciclo_segredo_ok('errado'), false, 'ciclo: segredo errado não passa');
select is(public.fiscal_ciclo_segredo_ok(''), false, 'ciclo: segredo vazio não passa');
select is(public.fiscal_ciclo_segredo_ok(null), false, 'ciclo: sem segredo não passa');
select is(
  public.fiscal_ciclo_segredo_ok((select decrypted_secret from vault.decrypted_secrets where name = 'FISCAL_CICLO_CRON_SECRET')),
  true, 'ciclo: o segredo do Vault passa');

select is((select schedule from cron.job where jobname = 'assinatura-fiscal-ciclo'), '*/15 * * * *',
  'job assinatura-fiscal-ciclo a cada 15 minutos');
select is((select command from cron.job where jobname = 'assinatura-fiscal-ciclo'), 'select public.fiscal_invocar_ciclo()',
  'job chama public.fiscal_invocar_ciclo()');

delete from vault.secrets where name = 'fiscal_ciclo_url';
select is(public.fiscal_invocar_ciclo(), null, 'job sem fiscal_ciclo_url no Vault não faz nada');
select vault.create_secret('http://127.0.0.1:9/functions/v1/assinatura-fiscal-ciclo', 'fiscal_ciclo_url', 'teste');
delete from vault.secrets where name = 'FISCAL_CICLO_CRON_SECRET';
select is(public.fiscal_invocar_ciclo(), null, 'job sem FISCAL_CICLO_CRON_SECRET no Vault não faz nada');

select * from finish();
rollback;
