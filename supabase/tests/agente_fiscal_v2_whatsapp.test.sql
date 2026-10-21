-- Agente fiscal v2, lote C: check C47 de .checks/agente-fiscal-v2.md (job `nofiscal-worker`) e
-- as portas de banco do lote C no Landing (grants do contrato B → C, estado da conversa, modelo
-- das boas-vindas, lista de abandono). Tudo roda numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant nofiscal_service to postgres;
grant usage on schema extensions to nofiscal_service;

-- ---------------------------------------------------------------------------------------
-- C47: o job existe, roda a cada minuto e chama a função do Vault.
select is(
  (select schedule from cron.job where jobname = 'nofiscal-worker'),
  '* * * * *', 'nofiscal-worker: job a cada minuto');
select is(
  (select command from cron.job where jobname = 'nofiscal-worker'),
  'select nofiscal.invocar_worker()', 'nofiscal-worker: o job chama nofiscal.invocar_worker()');
select is((select count(*)::int from cron.job where jobname = 'nofiscal-worker'), 1,
  'nofiscal-worker: um job só');

-- Sem URL e sem segredo (apagados só nesta transação), nada é chamado.
delete from vault.secrets where name in ('nofiscal_worker_url', 'NOFISCAL_CRON_SECRET');
select is(nofiscal.invocar_worker(), null, 'nofiscal-worker: sem URL nem segredo devolve null');
select is((select count(*)::int from net.http_request_queue where url like '%/api/internal/nfse-worker'), 0,
  'nofiscal-worker: sem URL nem segredo não enfileira chamada');

select vault.create_secret('https://app.example.test', 'nofiscal_worker_url', 'teste');
select is(nofiscal.invocar_worker(), null, 'nofiscal-worker: só com a URL devolve null');

delete from vault.secrets where name = 'nofiscal_worker_url';
select vault.create_secret('segredo-de-teste', 'NOFISCAL_CRON_SECRET', 'teste');
select is(nofiscal.invocar_worker(), null, 'nofiscal-worker: só com o segredo devolve null');

select vault.create_secret('https://app.example.test/', 'nofiscal_worker_url', 'teste');
select isnt(nofiscal.invocar_worker(), null, 'nofiscal-worker: com os dois chama o worker');
select results_eq(
  $$select url, method::text, headers->>'Authorization' from net.http_request_queue
     where url = 'https://app.example.test/api/internal/nfse-worker'$$,
  $$values ('https://app.example.test/api/internal/nfse-worker'::text, 'POST'::text, 'Bearer segredo-de-teste'::text)$$,
  'nofiscal-worker: POST na rota do worker com Authorization: Bearer');

select ok(not exists (
    select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('nofiscal_service'), ('nofiscal_onboarding')) r(role)
     where has_function_privilege(r.role, 'nofiscal.invocar_worker()', 'EXECUTE')),
  'nofiscal-worker: nenhum papel da API ou do motor executa a função');

-- ---------------------------------------------------------------------------------------
-- Contrato B → C e estado da conversa: o que o nofiscal_service pode gravar no tenant.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('f2500000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'dono-c1@example.test', '{}',
   '{"responsavel":"Maria Teste"}', now(), now()),
  ('f2500000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'dono-c2@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('f2600000-0000-4000-8000-000000000001', 'Empresa C1', 'agente-fiscal-v2-c1'),
  ('f2600000-0000-4000-8000-000000000002', 'Empresa C2', 'agente-fiscal-v2-c2');
insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values
  ('f2500000-0000-4000-8000-000000000001', 'dono-c1@example.test', '+5511911110001', now(), 'f2600000-0000-4000-8000-000000000001'),
  ('f2500000-0000-4000-8000-000000000002', 'dono-c2@example.test', '+5511911110002', now(), 'f2600000-0000-4000-8000-000000000002');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  onboarding_etapa, pago_em, trial_ends_at
) values
  ('f2700000-0000-4000-8000-000000000001', '11444777000161', 'EMPRESA C1 TESTE', '3550308', repeat('1', 64), 'pro', 100,
   'f2600000-0000-4000-8000-000000000001', 'certificado', now() - interval '2 hours', now() + interval '5 days'),
  ('f2700000-0000-4000-8000-000000000002', '22333444000181', 'EMPRESA C2 TESTE', '3550308', repeat('2', 64), 'inicial', 20,
   'f2600000-0000-4000-8000-000000000002', 'concluido', now() - interval '2 hours', null);

set local role nofiscal_service;
select lives_ok(
  $$update nofiscal.fiscal_tenants
       set resumo_frequencia = 'semanal', resumo_dia = 1, onboarding_etapa = 'boas_vindas_conferir',
           agente_conversa = '{"boas_vindas":{"passo":"nome"}}', updated_at = now()
     where id = 'f2700000-0000-4000-8000-000000000001'$$,
  'contrato B → C: nofiscal_service grava resumo, etapa e estado da conversa');
select is(
  (select agente_conversa->'boas_vindas'->>'passo' from nofiscal.fiscal_tenants where id = 'f2700000-0000-4000-8000-000000000001'),
  'nome', 'contrato B → C: nofiscal_service lê o estado da conversa');
select throws_ok(
  $$update nofiscal.fiscal_tenants set pago_em = now() where id = 'f2700000-0000-4000-8000-000000000001'$$,
  '42501', null, 'contrato B → C: nofiscal_service não muda pago_em');
select throws_ok(
  $$update nofiscal.fiscal_tenants set plan = 'pro' where id = 'f2700000-0000-4000-8000-000000000002'$$,
  '42501', null, 'contrato B → C: nofiscal_service não muda o plano');
select throws_ok(
  $$update nofiscal.fiscal_tenants set agente_conversa = '[]' where id = 'f2700000-0000-4000-8000-000000000001'$$,
  '23514', null, 'estado da conversa é um objeto');

-- Modelo do cliente frequente salvo nas boas-vindas: origem própria, sem nota de origem.
select lives_ok(
  $$insert into nofiscal.fiscal_models (tenant_id, nome, tomador_documento, tomador_nome, codigo_servico_nacional, descricao, origem)
    values ('f2700000-0000-4000-8000-000000000001', 'Prontia', '52998224725', 'Prontia', '010701', 'Prestação de serviços', 'boas_vindas')$$,
  'modelo das boas-vindas: origem boas_vindas sem nota');
select throws_ok(
  $$insert into nofiscal.fiscal_models (tenant_id, nome, tomador_documento, tomador_nome, codigo_servico_nacional, descricao, origem)
    values ('f2700000-0000-4000-8000-000000000001', 'Outro', '52998224725', 'Outro', '010701', 'x', 'whatsapp')$$,
  '23514', null, 'modelo das boas-vindas: outra origem continua recusada');

-- Lista de abandono: pagou há mais de 1 h e não concluiu; responsável do lote A ou e-mail.
select results_eq(
  $$select tenant_id, razao_social, responsavel, telefone, plano, etapa
      from nofiscal.lista_de_abandono(now() - interval '1 hour')
     where tenant_id in ('f2700000-0000-4000-8000-000000000001', 'f2700000-0000-4000-8000-000000000002')$$,
  $$values ('f2700000-0000-4000-8000-000000000001'::uuid, 'EMPRESA C1 TESTE'::text, 'Maria Teste'::text,
            '+5511911110001'::text, 'pro'::text, 'boas_vindas_conferir'::text)$$,
  'lista de abandono: só quem não concluiu, com o responsável');
reset role;

update nofiscal.fiscal_tenants set onboarding_etapa = 'clientes', pago_em = now() - interval '30 minutes'
 where id = 'f2700000-0000-4000-8000-000000000002';
update auth.users set raw_user_meta_data = '{}' where id = 'f2500000-0000-4000-8000-000000000001';
set local role nofiscal_service;
select results_eq(
  $$select tenant_id, responsavel from nofiscal.lista_de_abandono(now() - interval '1 hour')
     where tenant_id in ('f2700000-0000-4000-8000-000000000001', 'f2700000-0000-4000-8000-000000000002')$$,
  $$values ('f2700000-0000-4000-8000-000000000001'::uuid, 'dono-c1@example.test'::text)$$,
  'lista de abandono: pago há menos de 1 h fica de fora; sem responsável, vale o e-mail');
select throws_ok($$select count(*) from auth.users$$, '42501', null,
  'lista de abandono: o nofiscal_service continua sem ler auth.users');
reset role;

select ok(not exists (
    select 1 from (values ('anon'), ('authenticated'), ('service_role'), ('nofiscal_onboarding')) r(role)
     where has_function_privilege(r.role, 'nofiscal.lista_de_abandono(timestamptz)', 'EXECUTE')),
  'lista de abandono: só o nofiscal_service executa');

select * from finish();
rollback;
