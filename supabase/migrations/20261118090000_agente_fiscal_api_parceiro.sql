-- nó.fiscal: API para parceiro (escritório com sistema próprio que revende a emissão como white label), 18/11/2026.
-- Caso real: escritório contábil com 30 a 40 CNPJs, 300 a 400 notas/mês, integrando por API REST.
--
-- 1. Chave do parceiro: a chave da conta-mãe passa a ser gerada e trocada pelo painel "Minha conta" (mostrada uma
--    vez só). O banco continua guardando só o sha256 (`api_key_hash`); o prefixo e a data servem para a tela.
--    Uma chave emite por qualquer empresa ativa da conta (`cnpj_prestador` no POST).
-- 2. Origem da nota: `fiscal_invoices.origem = 'api'` para a nota que nasceu na API (sem WhatsApp por nota).
-- 3. Webhook de retorno: fila durável (`fiscal_webhook_entregas`), com reenvio e espera, no lugar do callback com
--    reenvio em memória. O segredo continua no Supabase Vault (`set_webhook_secret`), agora gravável pelo painel.
-- 4. White label: `emails_da_no = false` na conta-mãe desliga os e-mails de nota que a nó manda (o parceiro entrega).
-- 5. Empresas por API: funções que reaproveitam as do painel (`fiscal_empresa_adicionar`, `fiscal_empresa_configurar`,
--    `onboarding_set_procuracao`) com o usuário da conta-mãe, sem sessão. Limite de empresas e procuração seguem
--    as mesmas regras. Upload de A1 continua só pelo painel.

-- ------------------------------------------------------------ Conta-mãe

alter table nofiscal.fiscal_tenants
  add column api_key_prefixo text check (api_key_prefixo ~ '^nfk_[A-Za-z0-9_-]{6}$'),
  add column api_key_gerada_em timestamptz,
  add column emails_da_no boolean not null default true;
comment on column nofiscal.fiscal_tenants.api_key_prefixo is
  'Início da chave da API gerada no painel (nfk_ + 6 caracteres), só para reconhecer qual está em uso.';
comment on column nofiscal.fiscal_tenants.emails_da_no is
  'false: a nó não manda e-mail de nota (emitida/cancelada) das empresas desta conta; o parceiro entrega.';

grant update (api_key_hash, api_key_prefixo, api_key_gerada_em, webhook_url, emails_da_no)
  on nofiscal.fiscal_tenants to nofiscal_service;

-- ------------------------------------------------------------ Origem da nota

alter table nofiscal.fiscal_invoices
  add column origem text check (origem in ('api'));
comment on column nofiscal.fiscal_invoices.origem is
  'api: nota pedida por POST /v1/nfse (o retorno vai pelo webhook, não por WhatsApp). Nulo: WhatsApp, painel ou planilha.';

-- ------------------------------------------------------------ Webhook

create table nofiscal.fiscal_webhook_entregas (
  id uuid primary key default gen_random_uuid(),
  dono_tenant_id uuid not null references nofiscal.fiscal_tenants (id) on delete cascade,
  recurso text not null check (recurso in ('nfse', 'nfe')),
  documento_id uuid not null,
  evento text not null check (evento ~ '^(nfse|nfe)\.[a-z_]{3,40}$'),
  -- Retrato da nota no momento do evento: o corpo enviado é sempre este, mesmo que a nota mude depois.
  dados jsonb not null,
  status text not null default 'pendente' check (status in ('pendente', 'entregue', 'desistiu')),
  tentativas smallint not null default 0 check (tentativas between 0 and 20),
  proxima_em timestamptz not null default now(),
  ultimo_http integer,
  ultimo_erro text,
  entregue_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (documento_id, evento)
);
create index fiscal_webhook_entregas_pendentes_idx on nofiscal.fiscal_webhook_entregas (proxima_em)
  where status = 'pendente';
create index fiscal_webhook_entregas_dono_idx on nofiscal.fiscal_webhook_entregas (dono_tenant_id, created_at desc);
comment on table nofiscal.fiscal_webhook_entregas is
  'Um evento de nota (emitida, recusada, cancelada…) para o webhook da conta-mãe, com reenvio e espera.';

alter table nofiscal.fiscal_webhook_entregas enable row level security;
revoke all on nofiscal.fiscal_webhook_entregas from public, anon, authenticated, service_role;
grant select, insert, update on nofiscal.fiscal_webhook_entregas to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_webhook_entregas
  for all to nofiscal_service using (true) with check (true);

-- O painel grava o segredo do webhook (gerado no servidor, mostrado uma vez). Antes, só o dono do schema gravava.
grant execute on function nofiscal.set_webhook_secret(uuid, text) to nofiscal_service;

-- ------------------------------------------------------------ Empresas por API

-- Usuário da conta-mãe (o login com e-mail confirmado), para reaproveitar as funções do painel sem sessão.
create function nofiscal.usuario_do_dono(p_dono_tenant_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.user_id
    from nofiscal.fiscal_tenants t
    join nofiscal.fiscal_accounts a on a.client_id = t.client_id
   where t.id = p_dono_tenant_id
     and a.email_verified_at is not null
   order by a.created_at
   limit 1;
$$;

-- Adiciona a empresa cliente (dados da Receita conferidos pela API antes) e, com `p_dados`, grava código de serviço
-- e percentual do Simples. O ambiente é o da conta-mãe. Resultado: o mesmo jsonb de fiscal_empresa_adicionar, mais
-- `configuracao` (o de fiscal_empresa_configurar) quando houve dados.
create function nofiscal.api_empresa_adicionar(
  p_dono_tenant_id uuid,
  p_cnpj text,
  p_razao_social text,
  p_codigo_municipio_ibge text,
  p_cnae text,
  p_regime text,
  p_api_key_hash text,
  p_dados jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_ambiente text;
  v_res jsonb;
  v_conf jsonb;
begin
  v_user := nofiscal.usuario_do_dono(p_dono_tenant_id);
  if v_user is null or nofiscal.escritorio_do_usuario(v_user) is distinct from p_dono_tenant_id then
    return jsonb_build_object('ok', false, 'erro', 'PLANO_SEM_EMPRESAS');
  end if;
  select t.ambiente into v_ambiente from nofiscal.fiscal_tenants t where t.id = p_dono_tenant_id;
  v_res := public.fiscal_empresa_adicionar(
    v_user, p_cnpj, p_razao_social, p_codigo_municipio_ibge, p_cnae, p_regime, p_api_key_hash, v_ambiente);
  if not coalesce((v_res ->> 'ok')::boolean, false) or p_dados is null then
    return v_res;
  end if;
  v_conf := public.fiscal_empresa_configurar(v_user, (v_res ->> 'tenant_id')::uuid, p_dados);
  return v_res || jsonb_build_object('configuracao', v_conf);
end;
$$;

-- Código de serviço e percentual do Simples de uma empresa da conta (o mesmo "Dados fiscais" do painel).
create function nofiscal.api_empresa_configurar(p_dono_tenant_id uuid, p_tenant_id uuid, p_dados jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if not exists (select 1 from nofiscal.fiscal_tenants t
                  where t.id = p_tenant_id and (t.id = p_dono_tenant_id or t.escritorio_tenant_id = p_dono_tenant_id)) then
    return jsonb_build_object('ok', false, 'erro', 'FORBIDDEN');
  end if;
  v_user := nofiscal.usuario_do_dono(p_dono_tenant_id);
  if v_user is null then
    return jsonb_build_object('ok', false, 'erro', 'FORBIDDEN');
  end if;
  return public.fiscal_empresa_configurar(v_user, p_tenant_id, p_dados);
end;
$$;

-- "Já fiz a procuração" pela API: só para empresa do escritório (o procurador é sempre o escritório; a nó nunca
-- assina nota de cliente). Mesmo resultado de onboarding_set_procuracao: OK | FORBIDDEN | RATE_LIMITED | ...
create function nofiscal.api_empresa_procuracao(p_dono_tenant_id uuid, p_tenant_id uuid, p_valida_ate date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if not exists (select 1 from nofiscal.fiscal_tenants t
                  where t.id = p_tenant_id and t.escritorio_tenant_id = p_dono_tenant_id) then
    return 'FORBIDDEN';
  end if;
  v_user := nofiscal.usuario_do_dono(p_dono_tenant_id);
  if v_user is null then
    return 'FORBIDDEN';
  end if;
  return nofiscal.onboarding_set_procuracao(v_user, p_tenant_id, p_valida_ate);
end;
$$;

revoke all on function nofiscal.usuario_do_dono(uuid),
  nofiscal.api_empresa_adicionar(uuid, text, text, text, text, text, text, jsonb),
  nofiscal.api_empresa_configurar(uuid, uuid, jsonb),
  nofiscal.api_empresa_procuracao(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function nofiscal.api_empresa_adicionar(uuid, text, text, text, text, text, text, jsonb),
  nofiscal.api_empresa_configurar(uuid, uuid, jsonb),
  nofiscal.api_empresa_procuracao(uuid, uuid, date)
  to nofiscal_service;

-- Regime confirmado à mão (20261117180000), também para o cadastro de empresa pela API.
grant execute on function public.fiscal_regime_confirmado(text) to nofiscal_service;
