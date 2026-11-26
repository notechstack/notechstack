-- Cobrança do módulo Guias (20261119190000_agente_fiscal_guias_cobranca.sql): cupom FUNDADORGUIAS só no produto guias,
-- funções da ação "ligar Guias" só para service_role, registro com cupom, bloqueio por cobrança recusada e cascata
-- da principal cancelada. Tudo numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant nofiscal_service to postgres;
grant usage on schema extensions to nofiscal_service, service_role, authenticated;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('fd000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'cob-a@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values ('fe000000-0000-4000-8000-000000000001', 'COB A', 'cob-teste-a');
insert into public.memberships (user_id, client_id, role) values
  ('fd000000-0000-4000-8000-000000000001', 'fe000000-0000-4000-8000-000000000001', 'CLIENT');
insert into nofiscal.fiscal_tenants (id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa)
values ('ff000000-0000-4000-8000-000000000001', '95444777000161', 'Contabilidade Cob', '3507605', repeat('5', 64), 'escritorio_5', 500,
        'fe000000-0000-4000-8000-000000000001', '170201', 6, 'concluido');
insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values
  ('fd000000-0000-4000-8000-000000000001', 'cob-a@example.test', '+5511900000401', now(), 'fe000000-0000-4000-8000-000000000001');
insert into nofiscal.fiscal_subscriptions (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
values ('ff000000-0000-4000-8000-000000000001', 'escritorio_5', true, 'sub_cob_principal', 'pendente', now(), 'aceite');

select is((select planos from nofiscal.fiscal_cupons where codigo = 'FUNDADORGUIAS'), array['guias'], 'FUNDADORGUIAS só vale no produto guias');
select is((select (valor, ciclos, tipo)::text from nofiscal.fiscal_cupons where codigo = 'FUNDADORGUIAS'), '(5000,12,valor)', 'R$ 50 por 12 ciclos');
select is(public.fiscal_validar_cupom('ff000000-0000-4000-8000-000000000001', 'FUNDADORGUIAS', 'escritorio_5') ->> 'motivo', 'CUPOM_PLANO',
  'FUNDADORGUIAS não vale na assinatura do Escritório');
select is((public.fiscal_validar_cupom('ff000000-0000-4000-8000-000000000001', 'FUNDADORGUIAS', 'guias') ->> 'ok')::boolean, true,
  'vale para guias');

set local role authenticated;
select throws_ok($$ select public.fiscal_guias_reservar('ff000000-0000-4000-8000-000000000001', 500) $$, '42501', null, 'authenticated não reserva');
select throws_ok($$ select public.fiscal_guias_registrar('ff000000-0000-4000-8000-000000000001', 'sub_x', 500, null, null) $$, '42501', null, 'nem registra');
reset role;
set local role nofiscal_service;
select throws_ok($$ select public.fiscal_guias_desligar('ff000000-0000-4000-8000-000000000001') $$, '42501', null, 'o motor não desliga a cobrança');
reset role;

set local role service_role;
select is(public.fiscal_guias_reservar('ff000000-0000-4000-8000-000000000001', 500) ->> 'reservado', 'true', 'reserva');
select is(public.fiscal_guias_reservar('ff000000-0000-4000-8000-000000000001', 500) ->> 'erro', 'CRIACAO_EM_ANDAMENTO', 'segunda reserva espera');
select is(public.fiscal_guias_registrar('ff000000-0000-4000-8000-000000000001', 'sub_cob_guias', 500, 'FUNDADORGUIAS',
  '2026-12-16T18:42:00Z') ->> 'ok', 'true', 'registra com o cupom e liga');
select is(public.fiscal_guias_reservar('ff000000-0000-4000-8000-000000000001', 500) ->> 'pagarme_subscription_id', 'sub_cob_guias',
  'depois de registrada, reservar devolve a que existe');
reset role;

select is(nofiscal.guias_ligado('ff000000-0000-4000-8000-000000000001'), true, 'módulo ligado');
select is((nofiscal.guias_cobranca('ff000000-0000-4000-8000-000000000001') ->> 'valor_atual_centavos')::int, 14700, 'R$ 147 com o cupom');

set local role service_role;
select is(public.fiscal_aplicar_evento_assinatura('ev_cob_1', 'invoice.payment_failed', 'sub_cob_guias', 'recusada', '{}', now()) ->> 'produto',
  'guias', 'o aviso da Guias é reconhecido pelo id');
reset role;
select is(nofiscal.guias_bloqueio('ff000000-0000-4000-8000-000000000001'), 'PAGAMENTO_RECUSADO', 'cobrança recusada bloqueia o módulo');
select throws_ok($$ select nofiscal.guias_disparar('fd000000-0000-4000-8000-000000000001', array[gen_random_uuid()], null) $$,
  'P0001', 'GUIAS_BLOQUEADO', 'bloqueado, não dispara');
select is((select status from nofiscal.fiscal_subscriptions where pagarme_subscription_id = 'sub_cob_principal'), 'pendente', 'a principal não muda');

set local role service_role;
select is(public.fiscal_aplicar_evento_assinatura('ev_cob_2', 'subscription.canceled', 'sub_cob_principal', 'cancelada', '{}', now()) ->> 'encontrada',
  'true', 'principal cancelada');
reset role;
select is((select (status, cancelar_no_gateway)::text from nofiscal.fiscal_addons where tenant_id = 'ff000000-0000-4000-8000-000000000001'),
  '(desligado,t)', 'a principal cancelada desliga o módulo e marca a Guias para cancelar no Pagar.me');
set local role service_role;
select is((select count(*)::int from public.fiscal_guias_cancelamentos_pendentes(10) where pagarme_subscription_id = 'sub_cob_guias'), 1,
  'a Guias está na fila do ciclo');
reset role;

select * from finish();
rollback;
