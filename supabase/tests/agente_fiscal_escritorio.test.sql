-- Conta Escritório (20261105180000_agente_fiscal_escritorio.sql): a empresa do escritório herda a assinatura
-- da conta-mãe, a posse passa por usuario_pode_tenant, o limite de empresas vale no adicionar e na troca de
-- faixa, e o relatório só mostra notas da conta. Tudo roda numa transação desfeita no fim.
begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

grant nofiscal_service to postgres;
grant usage on schema extensions to nofiscal_service, service_role;

-- E: escritório (conta-mãe, escritorio_5, paga). O: outro usuário com conta Pro, sem relação com E.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('e5000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'esc-e@example.test', '{}', '{}', now(), now()),
  ('e5000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'esc-o@example.test', '{}', '{}', now(), now());
insert into public.clients (id, name, slug) values
  ('e6000000-0000-4000-8000-000000000001', 'ESC E', 'esc-teste-e'),
  ('e6000000-0000-4000-8000-000000000002', 'ESC O', 'esc-teste-o');
insert into public.memberships (user_id, client_id, role) values
  ('e5000000-0000-4000-8000-000000000001', 'e6000000-0000-4000-8000-000000000001', 'CLIENT'),
  ('e5000000-0000-4000-8000-000000000002', 'e6000000-0000-4000-8000-000000000002', 'CLIENT');
insert into nofiscal.fiscal_tenants (
  id, cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id,
  codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa
) values
  ('e7000000-0000-4000-8000-000000000001', '91444777000161', 'ESC E', '3507605', repeat('1', 64), 'escritorio_5', 500,
   'e6000000-0000-4000-8000-000000000001', '170201', 6, 'concluido'),
  ('e7000000-0000-4000-8000-000000000002', '92444777000161', 'ESC O', '3550308', repeat('2', 64), 'pro', 100,
   'e6000000-0000-4000-8000-000000000002', '010701', 6, 'concluido');
insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values
  ('e5000000-0000-4000-8000-000000000001', 'esc-e@example.test', '+5511900000101', now(), 'e6000000-0000-4000-8000-000000000001'),
  ('e5000000-0000-4000-8000-000000000002', 'esc-o@example.test', '+5511900000102', now(), 'e6000000-0000-4000-8000-000000000002');
insert into nofiscal.fiscal_subscriptions
  (id, tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto)
values
  ('e8000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', 'escritorio_5', false,
   'sub_esc_e', 'paga', now(), 'aceite'),
  ('e8000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000002', 'pro', false,
   'sub_esc_o', 'paga', now(), 'aceite');

-- ---------------------------------------------------------------------------------------
-- Objetos e privilégios.
select has_table('nofiscal', 'fiscal_lotes', 'fiscal_lotes existe');
select has_table('nofiscal', 'fiscal_lote_itens', 'fiscal_lote_itens existe');
select has_table('nofiscal', 'fiscal_invoice_entregas', 'fiscal_invoice_entregas existe');
select ok(has_table_privilege('nofiscal_service', 'nofiscal.fiscal_lotes', 'insert'), 'motor grava lote');
select ok(not has_table_privilege('service_role', 'nofiscal.fiscal_lotes', 'select'), 'edge function não lê lote direto');
select ok(not has_table_privilege('authenticated', 'nofiscal.fiscal_invoice_entregas', 'select'), 'authenticated não lê entregas');
select ok(has_function_privilege('service_role', 'public.fiscal_relatorio(uuid,date,uuid)', 'execute'), 'relatório pelo service_role');
select ok(not has_function_privilege('authenticated', 'public.fiscal_relatorio(uuid,date,uuid)', 'execute'), 'relatório fechado ao authenticated');
select ok(not has_function_privilege('anon', 'public.fiscal_empresa_adicionar(uuid,text,text,text,text,text,text,text)', 'execute'),
  'adicionar empresa fechado ao anon');
select ok(has_function_privilege('nofiscal_service', 'nofiscal.usuario_pode_tenant(uuid,uuid)', 'execute'), 'motor confere posse (PDF)');
select is(nofiscal.limite_do_plano('escritorio_20'), 2000, 'franquia da faixa 20');
select is(nofiscal.max_empresas_do_plano('escritorio_50'), 50, 'empresas da faixa 50');

-- ---------------------------------------------------------------------------------------
-- Adicionar empresa: só conta de escritório, dentro do limite, CNPJ novo.
select is(public.fiscal_empresa_adicionar('e5000000-0000-4000-8000-000000000002', '93444777000161', 'Cliente X',
  '3550308', null, 'simples', repeat('3', 64), 'producao') ->> 'erro', 'PLANO_SEM_EMPRESAS', 'conta Pro não adiciona empresa');

select is(public.fiscal_empresa_adicionar('e5000000-0000-4000-8000-000000000001', '93444777000161', 'Cliente X',
  '3550308', null, 'simples', repeat('3', 64), 'producao') ->> 'ok', 'true', 'escritório adiciona empresa');
select is((select escritorio_tenant_id from nofiscal.fiscal_tenants where cnpj = '93444777000161'),
  'e7000000-0000-4000-8000-000000000001'::uuid, 'empresa nova aponta para a conta-mãe');
select ok((select client_id from nofiscal.fiscal_tenants where cnpj = '93444777000161') is null, 'empresa nova sem login próprio');
select is((select plan from nofiscal.fiscal_tenants where cnpj = '93444777000161'), 'escritorio_5', 'empresa nova no plano da conta');
select is((select next_number from nofiscal.fiscal_dps_series s join nofiscal.fiscal_tenants t on t.id = s.tenant_id
            where t.cnpj = '93444777000161'), 1::bigint, 'série 1 criada');
select is(public.fiscal_empresa_adicionar('e5000000-0000-4000-8000-000000000001', '92444777000161', 'Outro',
  '3550308', null, 'simples', repeat('4', 64), 'producao') ->> 'erro', 'CNPJ_JA_CADASTRADO', 'CNPJ de outra conta é recusado');

-- Limite: conta-mãe + 4 = 5 ativas na faixa 5; a sexta é recusada.
select public.fiscal_empresa_adicionar('e5000000-0000-4000-8000-000000000001', c, 'Cliente ' || c, '3550308', null,
  'simples', repeat(n, 64), 'producao')
  from (values ('94444777000161', '5'), ('95444777000161', '6'), ('96444777000161', '7')) v(c, n);
select is((select count(*) from nofiscal.fiscal_tenants where escritorio_tenant_id = 'e7000000-0000-4000-8000-000000000001'),
  4::bigint, 'quatro empresas do escritório');
select is(public.fiscal_empresa_adicionar('e5000000-0000-4000-8000-000000000001', '97444777000161', 'Sexta',
  '3550308', null, 'simples', repeat('8', 64), 'producao') ->> 'erro', 'EMPRESAS_ACIMA_DO_LIMITE', 'sexta empresa passa do limite');

-- ---------------------------------------------------------------------------------------
-- Posse.
select ok(nofiscal.usuario_pode_tenant('e5000000-0000-4000-8000-000000000001',
  (select id from nofiscal.fiscal_tenants where cnpj = '93444777000161')), 'dono do escritório mexe na empresa dele');
select ok(not nofiscal.usuario_pode_tenant('e5000000-0000-4000-8000-000000000002',
  (select id from nofiscal.fiscal_tenants where cnpj = '93444777000161')), 'outro usuário não mexe');
select ok(nofiscal.usuario_pode_tenant('e5000000-0000-4000-8000-000000000002', 'e7000000-0000-4000-8000-000000000002'),
  'conta comum continua dona da própria empresa');
select is(nofiscal.onboarding_set_certificate('e5000000-0000-4000-8000-000000000002',
  (select id from nofiscal.fiscal_tenants where cnpj = '93444777000161'), 'PFX', 'x', 'CN=X:93444777000161',
  now() + interval '1 year'), 'FORBIDDEN', 'A1 de empresa alheia é recusado');
select is(nofiscal.onboarding_set_certificate('e5000000-0000-4000-8000-000000000001',
  (select id from nofiscal.fiscal_tenants where cnpj = '93444777000161'), 'PFX', 'x', 'CN=X:93444777000161',
  now() + interval '1 year'), 'OK', 'A1 da empresa do escritório é aceito');
select is((select onboarding_etapa from nofiscal.fiscal_tenants where cnpj = '93444777000161'), 'dados_fiscais',
  'A1 leva a empresa aos dados fiscais');

-- ---------------------------------------------------------------------------------------
-- Emissão: a empresa do escritório herda a assinatura da conta-mãe.
select is(nofiscal.emission_block((select id from nofiscal.fiscal_tenants where cnpj = '93444777000161')),
  'FISCAL_CONFIG_MISSING', 'sem dados fiscais ainda não emite');
select is(public.fiscal_empresa_configurar('e5000000-0000-4000-8000-000000000002',
  (select id from nofiscal.fiscal_tenants where cnpj = '93444777000161'), '{"codigo_servico_nacional":"170201","p_tot_trib_sn":"6"}')
  ->> 'erro', 'FORBIDDEN', 'outro usuário não configura');
select is(public.fiscal_empresa_configurar('e5000000-0000-4000-8000-000000000001',
  (select id from nofiscal.fiscal_tenants where cnpj = '93444777000161'), '{"codigo_servico_nacional":"170201","p_tot_trib_sn":"6"}')
  ->> 'ok', 'true', 'dono configura');
select is((select onboarding_etapa from nofiscal.fiscal_tenants where cnpj = '93444777000161'), 'concluido',
  'empresa do escritório conclui no dado fiscal');
select is(nofiscal.emission_block((select id from nofiscal.fiscal_tenants where cnpj = '93444777000161')), null::text,
  'com A1, dados e assinatura paga da conta-mãe, emite');

update nofiscal.fiscal_subscriptions set status = 'recusada' where id = 'e8000000-0000-4000-8000-000000000001';
select is(nofiscal.emission_block((select id from nofiscal.fiscal_tenants where cnpj = '93444777000161')),
  'PAYMENT_NOT_APPROVED', 'assinatura recusada da conta-mãe bloqueia a empresa');
update nofiscal.fiscal_subscriptions set status = 'paga' where id = 'e8000000-0000-4000-8000-000000000001';

select is(public.fiscal_empresa_ativar('e5000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000001', false)
  ->> 'erro', 'EMPRESA_PRINCIPAL', 'conta-mãe não se desativa');
select is(public.fiscal_empresa_ativar('e5000000-0000-4000-8000-000000000001',
  (select id from nofiscal.fiscal_tenants where cnpj = '93444777000161'), false) ->> 'ok', 'true', 'desativa empresa');
select is(nofiscal.emission_block((select id from nofiscal.fiscal_tenants where cnpj = '93444777000161')),
  'TENANT_INACTIVE', 'empresa desativada não emite');

-- ---------------------------------------------------------------------------------------
-- Troca de faixa.
select is(public.fiscal_trocar_plano('e5000000-0000-4000-8000-000000000001', 'pro') ->> 'erro', 'PLANO_DE_OUTRA_FAMILIA',
  'escritório não vira Pro pelo site');
select is(public.fiscal_trocar_plano('e5000000-0000-4000-8000-000000000001', 'escritorio_20') ->> 'ok', 'true', 'sobe para a faixa 20');
select is((select count(*) from nofiscal.fiscal_tenants
            where (id = 'e7000000-0000-4000-8000-000000000001' or escritorio_tenant_id = 'e7000000-0000-4000-8000-000000000001')
              and plan = 'escritorio_20' and monthly_note_limit = 2000), 5::bigint, 'faixa e franquia mudam em todas as empresas');

-- ---------------------------------------------------------------------------------------
-- Estado e relatório.
insert into nofiscal.fiscal_invoices (tenant_id, external_id, status, payload, issued_at)
values
  ((select id from nofiscal.fiscal_tenants where cnpj = '94444777000161'), 'lote:teste-1', 'issued',
   '{"tomador":{"cnpj":"11222333000181","nome":"Tomador Um","email":"um@example.test"},"servico":{"codigo_servico_nacional":"170201","descricao":"Honorários"},"valor":"350.00"}',
   now()),
  ('e7000000-0000-4000-8000-000000000002', 'avulsa-o', 'issued',
   '{"tomador":{"cpf":"11144477735","nome":"Alheio"},"servico":{"codigo_servico_nacional":"010701","descricao":"X"},"valor":"10.00"}',
   now());
insert into nofiscal.fiscal_invoice_entregas (invoice_id, canal, papel, destino, status)
select id, 'email', 'tomador', 'um@example.test', 'enviado' from nofiscal.fiscal_invoices where external_id = 'lote:teste-1';

select is(jsonb_array_length(public.fiscal_escritorio_estado('e5000000-0000-4000-8000-000000000001') -> 'empresas'), 5,
  'estado lista as cinco empresas');
select is((public.fiscal_escritorio_estado('e5000000-0000-4000-8000-000000000001') ->> 'notas_mes')::int, 1, 'uso do mês somado');
select ok(public.fiscal_escritorio_estado('e5000000-0000-4000-8000-000000000002') is null, 'conta Pro não tem estado de escritório');
select is(jsonb_array_length(public.fiscal_relatorio('e5000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Sao_Paulo')::date) -> 'notas'), 1, 'relatório traz só as notas da conta');
select is(public.fiscal_relatorio('e5000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Sao_Paulo')::date) -> 'notas' -> 0 -> 'entregas' -> 0 ->> 'destino', 'um@example.test',
  'relatório mostra para onde a nota foi');
select is(public.fiscal_relatorio('e5000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Sao_Paulo')::date) -> 'notas' -> 0 ->> 'codigo_tributacao', '170201', 'código de tributação');
select is(public.fiscal_relatorio('e5000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Sao_Paulo')::date, 'e7000000-0000-4000-8000-000000000002') ->> 'erro', 'FORBIDDEN',
  'relatório de empresa alheia é recusado');
select is((public.fiscal_relatorio('e5000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Sao_Paulo')::date) -> 'totais' ->> 'valor_emitido')::numeric, 350.00, 'valor emitido do mês');

-- Lote: mesma planilha não abre dois lotes vivos.
insert into nofiscal.fiscal_lotes (escritorio_tenant_id, arquivo_sha256, expires_at)
values ('e7000000-0000-4000-8000-000000000001', repeat('a', 64), now() + interval '24 hours');
select throws_ok($$insert into nofiscal.fiscal_lotes (escritorio_tenant_id, arquivo_sha256, expires_at)
  values ('e7000000-0000-4000-8000-000000000001', repeat('a', 64), now() + interval '24 hours')$$,
  '23505', null, 'mesma planilha com lote vivo é recusada');

-- Cupom com teste de 30 dias.
insert into nofiscal.fiscal_cupons (codigo, tipo, valor, ciclos, planos, dias_de_teste, max_usos)
values ('FUNDADORTESTE', 'valor', 5000, 12, array['escritorio_5'], 30, 5);
select is(public.fiscal_validar_cupom('e7000000-0000-4000-8000-000000000001', 'FUNDADORTESTE', 'escritorio_5') ->> 'dias_de_teste',
  '30', 'cupom devolve os dias de teste');
select is(public.fiscal_validar_cupom('e7000000-0000-4000-8000-000000000001', 'FUNDADORTESTE', 'escritorio_20') ->> 'motivo',
  'CUPOM_PLANO', 'cupom da faixa 5 não vale na 20');

select * from finish();
rollback;
