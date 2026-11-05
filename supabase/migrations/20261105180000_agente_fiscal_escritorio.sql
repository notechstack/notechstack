-- nó.fiscal: conta Escritório (Lucca, 05/11/2026; .design/agente-fiscal-escritorio.md, versão 2).
-- A empresa do próprio escritório é a conta-mãe: guarda login, assinatura, telefones e franquia, como
-- uma conta comum. As demais empresas do escritório apontam para ela por `escritorio_tenant_id` e
-- herdam a assinatura (emission_block). Faixas: escritorio_5 / _20 / _50 (empresas e notas por mês).
-- Também: lote por planilha (fiscal_lotes, fiscal_lote_itens), registro de entregas por nota
-- (fiscal_invoice_entregas), cupom com teste de 30 dias (fiscal_cupons.dias_de_teste) e o painel
-- (fiscal_escritorio_estado, fiscal_empresa_*, fiscal_relatorio). Edge functions → banco só por
-- public.fiscal_* (security definer, search_path = '', EXECUTE só service_role).

-- ------------------------------------------------------------ Planos

create function nofiscal.limite_do_plano(p_plano text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_plano
    when 'inicial' then 20
    when 'pro' then 100
    when 'escritorio_5' then 500
    when 'escritorio_20' then 2000
    when 'escritorio_50' then 5000
  end;
$$;

create function nofiscal.max_empresas_do_plano(p_plano text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_plano
    when 'escritorio_5' then 5
    when 'escritorio_20' then 20
    when 'escritorio_50' then 50
    else 1
  end;
$$;

create function nofiscal.plano_de_escritorio(p_plano text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_plano in ('escritorio_5', 'escritorio_20', 'escritorio_50'), false);
$$;

-- Plano com contador, resumo e cópia ao tomador (o que hoje é só do Pro).
create function nofiscal.plano_completo(p_plano text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_plano in ('pro', 'escritorio_5', 'escritorio_20', 'escritorio_50'), false);
$$;

alter table nofiscal.fiscal_tenants drop constraint fiscal_tenants_plan_check,
  add constraint fiscal_tenants_plan_check
    check (plan in ('inicial', 'pro', 'custom', 'escritorio_5', 'escritorio_20', 'escritorio_50'));

alter table nofiscal.fiscal_subscriptions drop constraint fiscal_subscriptions_plano_check,
  add constraint fiscal_subscriptions_plano_check
    check (plano in ('inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50'));

alter table nofiscal.fiscal_cupons drop constraint fiscal_cupons_planos_check,
  add constraint fiscal_cupons_planos_check
    check (planos is null or planos <@ array['inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50']::text[]),
  -- Teste grátis dado pelo cupom (plano "_teste30" no Pagar.me). Só 30 na v1.
  add column dias_de_teste smallint check (dias_de_teste is null or dias_de_teste = 30);

-- ------------------------------------------------------------ Empresas do escritório

alter table nofiscal.fiscal_tenants
  add column escritorio_tenant_id uuid references nofiscal.fiscal_tenants(id) on delete restrict,
  add constraint fiscal_tenants_dono_unico check (escritorio_tenant_id is null or client_id is null),
  add constraint fiscal_tenants_escritorio_nao_proprio check (escritorio_tenant_id is null or escritorio_tenant_id <> id);
create index fiscal_tenants_escritorio_idx on nofiscal.fiscal_tenants (escritorio_tenant_id)
  where escritorio_tenant_id is not null;
comment on column nofiscal.fiscal_tenants.escritorio_tenant_id is
  'Empresa cadastrada por um escritório: aponta para o tenant do escritório (conta-mãe), que tem login, assinatura e telefones.';

-- Tenant dono da assinatura, dos telefones e da franquia.
create function nofiscal.dono_do_tenant(p_tenant_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(t.escritorio_tenant_id, t.id) from nofiscal.fiscal_tenants t where t.id = p_tenant_id;
$$;

-- O usuário pode mexer nesta empresa? Dono direto (membership no client) ou dono do escritório dela.
create function nofiscal.usuario_pode_tenant(p_user_id uuid, p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1
      from nofiscal.fiscal_tenants t
      left join nofiscal.fiscal_tenants e on e.id = t.escritorio_tenant_id
      join public.memberships m on m.client_id = coalesce(e.client_id, t.client_id)
     where t.id = p_tenant_id
       and m.user_id = p_user_id);
$$;

-- Empresas que respondem à conta-mãe (ela própria e as do escritório).
create function nofiscal.empresas_do_dono(p_dono_tenant_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from nofiscal.fiscal_tenants t
   where t.id = p_dono_tenant_id or t.escritorio_tenant_id = p_dono_tenant_id;
$$;

-- ------------------------------------------------------------ Lote por planilha

create table nofiscal.fiscal_lotes (
  id uuid primary key default gen_random_uuid(),
  escritorio_tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  phone_id uuid references nofiscal.fiscal_phones(id) on delete set null,
  origem text not null default 'planilha' check (origem in ('planilha')),
  arquivo_nome text check (arquivo_nome is null or char_length(arquivo_nome) <= 200),
  arquivo_sha256 text check (arquivo_sha256 is null or arquivo_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'aguardando_confirmacao'
    check (status in ('aguardando_confirmacao', 'emitindo', 'concluido', 'expirado', 'descartado')),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  concluido_em timestamptz,
  aviso_parcial_em timestamptz,
  -- Só depois que algum canal (WhatsApp ou e-mail) confirmar o retorno; até lá o worker tenta de novo.
  retorno_enviado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Mesma planilha não abre dois lotes esperando confirmação. Reenviar o mesmo arquivo no mês seguinte vale:
-- a nota em dobro é barrada por linha (JA_EMITIDA_NO_MES), na leitura e de novo no "confirmar".
create unique index fiscal_lotes_arquivo_idx on nofiscal.fiscal_lotes (escritorio_tenant_id, arquivo_sha256)
  where arquivo_sha256 is not null and status = 'aguardando_confirmacao';
create index fiscal_lotes_abertos_idx on nofiscal.fiscal_lotes (status, expires_at)
  where status in ('aguardando_confirmacao', 'emitindo');
create index fiscal_lotes_retorno_pendente_idx on nofiscal.fiscal_lotes (concluido_em)
  where status = 'concluido' and retorno_enviado_em is null;

create table nofiscal.fiscal_lote_itens (
  id uuid primary key default gen_random_uuid(),
  lote_id uuid not null references nofiscal.fiscal_lotes(id) on delete cascade,
  linha integer not null check (linha > 0),
  tenant_id uuid references nofiscal.fiscal_tenants(id) on delete restrict,
  payload jsonb not null,
  problema text check (problema is null or char_length(problema) <= 200),
  invoice_id uuid unique references nofiscal.fiscal_invoices(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (lote_id, linha)
);
create index fiscal_lote_itens_lote_idx on nofiscal.fiscal_lote_itens (lote_id);

-- ------------------------------------------------------------ Para onde cada nota foi

create table nofiscal.fiscal_invoice_entregas (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references nofiscal.fiscal_invoices(id) on delete restrict,
  canal text not null check (canal in ('whatsapp', 'email')),
  papel text not null check (papel in ('dono', 'tomador', 'contador', 'escritorio')),
  destino text not null check (char_length(destino) between 3 and 254),
  status text not null check (status in ('enviado', 'falhou')),
  created_at timestamptz not null default now()
);
create index fiscal_invoice_entregas_invoice_idx on nofiscal.fiscal_invoice_entregas (invoice_id);

alter table nofiscal.fiscal_lotes enable row level security;
alter table nofiscal.fiscal_lote_itens enable row level security;
alter table nofiscal.fiscal_invoice_entregas enable row level security;
revoke all on nofiscal.fiscal_lotes, nofiscal.fiscal_lote_itens, nofiscal.fiscal_invoice_entregas
  from public, anon, authenticated, service_role;
grant select, insert, update on nofiscal.fiscal_lotes, nofiscal.fiscal_lote_itens to nofiscal_service;
grant select, insert on nofiscal.fiscal_invoice_entregas to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_lotes
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_lote_itens
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_invoice_entregas
  for all to nofiscal_service using (true) with check (true);

-- ------------------------------------------------------------ Emissão: empresa do escritório herda a assinatura

create or replace function nofiscal.emission_block(p_tenant_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tenant record;
  v_dono record;
  v_not_after timestamptz;
  v_status text;
begin
  select t.active, t.codigo_servico_nacional, t.p_tot_trib_sn, t.regime, t.escritorio_tenant_id
    into v_tenant
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id;
  if not found then
    return 'TENANT_NOT_FOUND';
  end if;
  if not v_tenant.active then
    return 'TENANT_INACTIVE';
  end if;

  -- Assinatura e teste vêm da conta-mãe (ela própria, fora de escritório).
  select t.id, t.active, t.trial_ends_at into v_dono
    from nofiscal.fiscal_tenants t
   where t.id = coalesce(v_tenant.escritorio_tenant_id, p_tenant_id);
  if not v_dono.active then
    return 'TENANT_INACTIVE';
  end if;

  if v_tenant.codigo_servico_nacional is null
     or (v_tenant.p_tot_trib_sn is null and v_tenant.regime <> 'mei') then
    return 'FISCAL_CONFIG_MISSING';
  end if;

  select c.not_after into v_not_after from nofiscal.fiscal_certificates c where c.tenant_id = p_tenant_id;
  if not found then
    return 'CERT_MISSING';
  end if;
  if v_not_after <= now() then
    return 'CERT_EXPIRED';
  end if;

  select s.status into v_status
    from nofiscal.fiscal_subscriptions s
   where s.tenant_id = v_dono.id
   order by (s.status <> 'cancelada') desc, s.created_at desc
   limit 1;
  if not found then
    return 'NO_SUBSCRIPTION';
  end if;
  if v_status = 'paga' then
    return null;
  end if;
  if v_status = 'cancelada' then
    return 'SUBSCRIPTION_CANCELLED';
  end if;
  if v_status = 'pendente' and v_dono.trial_ends_at > now() then
    return null;
  end if;
  return 'PAYMENT_NOT_APPROVED';
end;
$$;

-- ------------------------------------------------------------ Troca de plano (com as faixas do Escritório)

create or replace function public.fiscal_trocar_plano(p_user_id uuid, p_plano text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant record;
  v_sub uuid;
  v_ativas integer;
begin
  if p_plano is null or p_plano not in ('inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50') then
    raise exception 'fiscal_trocar_plano: plano invalido' using errcode = '22023';
  end if;
  select t.id, t.plan into v_tenant
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id
     and a.email_verified_at is not null
   for update of t;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_SEM_EMPRESA');
  end if;
  -- Inicial/Pro e Escritório não se misturam pelo site.
  if nofiscal.plano_de_escritorio(v_tenant.plan) <> nofiscal.plano_de_escritorio(p_plano) then
    return jsonb_build_object('ok', false, 'erro', 'PLANO_DE_OUTRA_FAMILIA');
  end if;
  if nofiscal.plano_de_escritorio(p_plano) then
    select count(*) into v_ativas
      from nofiscal.fiscal_tenants t
     where (t.id = v_tenant.id or t.escritorio_tenant_id = v_tenant.id) and t.active;
    if v_ativas > nofiscal.max_empresas_do_plano(p_plano) then
      return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE',
                                'ativas', v_ativas, 'limite', nofiscal.max_empresas_do_plano(p_plano));
    end if;
  end if;
  select s.id into v_sub
    from nofiscal.fiscal_subscriptions s
   where s.tenant_id = v_tenant.id and s.status <> 'cancelada'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'SEM_ASSINATURA');
  end if;

  update nofiscal.fiscal_tenants
     set plan = p_plano,
         monthly_note_limit = nofiscal.limite_do_plano(p_plano),
         updated_at = now()
   where id = v_tenant.id or escritorio_tenant_id = v_tenant.id;
  update nofiscal.fiscal_subscriptions set plano = p_plano, updated_at = now() where id = v_sub;
  return jsonb_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------------ Painel do escritório

-- Conta-mãe do usuário (login), só se o plano for de escritório.
create function nofiscal.escritorio_do_usuario(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id
     and a.email_verified_at is not null
     and nofiscal.plano_de_escritorio(t.plan);
$$;

create function public.fiscal_escritorio_estado(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dono uuid;
  v_plan text;
  v_inicio timestamptz;
  v_fim timestamptz;
  v_empresas jsonb;
  v_ativas integer;
  v_notas integer;
begin
  v_dono := nofiscal.escritorio_do_usuario(p_user_id);
  if v_dono is null then
    return null;
  end if;
  select t.plan into v_plan from nofiscal.fiscal_tenants t where t.id = v_dono;
  v_inicio := (date_trunc('month', now() at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo';
  v_fim := ((date_trunc('month', now() at time zone 'America/Sao_Paulo')) + interval '1 month') at time zone 'America/Sao_Paulo';

  select coalesce(jsonb_agg(e order by (e ->> 'principal')::boolean desc, e ->> 'razao_social'), '[]'::jsonb)
    into v_empresas
    from (
      select jsonb_build_object(
        'tenant_id', t.id,
        'cnpj', t.cnpj,
        'razao_social', t.razao_social,
        'codigo_municipio_ibge', t.codigo_municipio_ibge,
        'regime', t.regime,
        'cnae', t.cnae,
        'principal', t.id = v_dono,
        'ativa', t.active,
        'codigo_servico_nacional', t.codigo_servico_nacional,
        'p_tot_trib_sn', t.p_tot_trib_sn,
        'certificado', case when c.tenant_id is null then null
                            else jsonb_build_object('subject', c.subject, 'not_after', c.not_after) end,
        'notas_mes', (select count(*) from nofiscal.fiscal_invoices i
                       where i.tenant_id = t.id and i.issued_at >= v_inicio and i.issued_at < v_fim),
        'situacao', case
          when not t.active then 'desativada'
          when c.tenant_id is null then 'falta_certificado'
          when c.not_after <= now() then 'certificado_vencido'
          when t.codigo_servico_nacional is null or (t.p_tot_trib_sn is null and t.regime <> 'mei') then 'falta_dados_fiscais'
          when c.not_after <= now() + interval '30 days' then 'certificado_vencendo'
          else 'pronta'
        end) as e
        from nofiscal.fiscal_tenants t
        left join nofiscal.fiscal_certificates c on c.tenant_id = t.id
       where t.id = v_dono or t.escritorio_tenant_id = v_dono
    ) x;

  select count(*) into v_ativas from nofiscal.fiscal_tenants t
   where (t.id = v_dono or t.escritorio_tenant_id = v_dono) and t.active;
  select count(*) into v_notas from nofiscal.fiscal_invoices i
   where i.tenant_id in (select nofiscal.empresas_do_dono(v_dono))
     and i.issued_at >= v_inicio and i.issued_at < v_fim;

  return jsonb_build_object(
    'escritorio_tenant_id', v_dono,
    'plano', v_plan,
    'max_empresas', nofiscal.max_empresas_do_plano(v_plan),
    'empresas_ativas', v_ativas,
    'notas_limite', nofiscal.limite_do_plano(v_plan),
    'notas_mes', v_notas,
    'empresas', v_empresas);
end;
$$;

create function public.fiscal_empresa_adicionar(
  p_user_id uuid,
  p_cnpj text,
  p_razao_social text,
  p_codigo_municipio_ibge text,
  p_cnae text,
  p_regime text,
  p_api_key_hash text,
  p_ambiente text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dono record;
  v_existente record;
  v_ativas integer;
  v_id uuid;
begin
  if p_cnpj is null or p_cnpj !~ '^[0-9]{14}$' or p_codigo_municipio_ibge !~ '^[0-9]{7}$'
     or (p_cnae is not null and p_cnae !~ '^[0-9]{7}$')
     or length(btrim(coalesce(p_razao_social, ''))) not between 1 and 150
     or p_regime is null or p_regime not in ('simples', 'mei')
     or p_api_key_hash !~ '^[0-9a-f]{64}$' or p_ambiente not in ('producao_restrita', 'producao') then
    raise exception 'fiscal_empresa_adicionar: parametro invalido' using errcode = '22023';
  end if;

  select t.id, t.plan into v_dono
    from nofiscal.fiscal_tenants t
   where t.id = nofiscal.escritorio_do_usuario(p_user_id)
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'PLANO_SEM_EMPRESAS');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fiscal_cadastro_cnpj:' || p_cnpj, 0));

  select count(*) into v_ativas from nofiscal.fiscal_tenants t
   where (t.id = v_dono.id or t.escritorio_tenant_id = v_dono.id) and t.active;

  select t.id, t.escritorio_tenant_id, t.active into v_existente
    from nofiscal.fiscal_tenants t where t.cnpj = p_cnpj;
  if found then
    -- Empresa desativada deste escritório: volta, se couber no plano.
    if v_existente.escritorio_tenant_id = v_dono.id and not v_existente.active then
      if v_ativas >= nofiscal.max_empresas_do_plano(v_dono.plan) then
        return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE',
                                  'limite', nofiscal.max_empresas_do_plano(v_dono.plan));
      end if;
      update nofiscal.fiscal_tenants set active = true, updated_at = now() where id = v_existente.id;
      return jsonb_build_object('ok', true, 'tenant_id', v_existente.id, 'reativada', true);
    end if;
    return jsonb_build_object('ok', false, 'erro', 'CNPJ_JA_CADASTRADO');
  end if;

  if v_ativas >= nofiscal.max_empresas_do_plano(v_dono.plan) then
    return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE',
                              'limite', nofiscal.max_empresas_do_plano(v_dono.plan));
  end if;

  insert into nofiscal.fiscal_tenants
    (cnpj, razao_social, codigo_municipio_ibge, cnae, regime, api_key_hash, plan, monthly_note_limit,
     ambiente, client_id, escritorio_tenant_id, onboarding_etapa)
  values
    (p_cnpj, btrim(p_razao_social), p_codigo_municipio_ibge, p_cnae, p_regime, p_api_key_hash, v_dono.plan,
     nofiscal.limite_do_plano(v_dono.plan), p_ambiente, null, v_dono.id, 'certificado')
  returning id into v_id;
  insert into nofiscal.fiscal_dps_series (tenant_id, serie, next_number) values (v_id, '1', 1);

  return jsonb_build_object('ok', true, 'tenant_id', v_id, 'reativada', false);
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'erro', 'CNPJ_JA_CADASTRADO');
end;
$$;

-- Código de serviço e percentual do Simples de uma empresa (da conta-mãe ou do escritório).
create function public.fiscal_empresa_configurar(p_user_id uuid, p_tenant_id uuid, p_dados jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_codigo text;
  v_pct_txt text;
  v_pct numeric;
begin
  if not nofiscal.usuario_pode_tenant(p_user_id, p_tenant_id) then
    return jsonb_build_object('ok', false, 'erro', 'FORBIDDEN');
  end if;
  select t.id, t.regime, t.escritorio_tenant_id, t.onboarding_etapa into v_t
    from nofiscal.fiscal_tenants t where t.id = p_tenant_id for update;
  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'codigo_servico_nacional');
  end if;
  v_codigo := p_dados ->> 'codigo_servico_nacional';
  if v_codigo is null or v_codigo !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'codigo_servico_nacional');
  end if;
  if v_t.regime = 'mei' then
    v_pct := null;
  else
    v_pct_txt := p_dados ->> 'p_tot_trib_sn';
    if v_pct_txt is null or v_pct_txt !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' or v_pct_txt::numeric > 100 then
      return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'p_tot_trib_sn');
    end if;
    v_pct := v_pct_txt::numeric;
  end if;

  update nofiscal.fiscal_tenants
     set codigo_servico_nacional = v_codigo,
         p_tot_trib_sn = v_pct,
         onboarding_etapa = case
           -- Empresa do escritório: não passa por clientes nem ativação (o WhatsApp é o da conta-mãe).
           when escritorio_tenant_id is not null then 'concluido'
           when onboarding_etapa = 'dados_fiscais' then 'clientes'
           else onboarding_etapa end,
         updated_at = now()
   where id = p_tenant_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Desativar ou reativar uma empresa do escritório. A conta-mãe não se desativa por aqui.
create function public.fiscal_empresa_ativar(p_user_id uuid, p_tenant_id uuid, p_ativa boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dono record;
  v_t record;
  v_ativas integer;
begin
  if p_ativa is null then
    raise exception 'fiscal_empresa_ativar: parametro invalido' using errcode = '22023';
  end if;
  select t.id, t.plan into v_dono
    from nofiscal.fiscal_tenants t
   where t.id = nofiscal.escritorio_do_usuario(p_user_id)
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'PLANO_SEM_EMPRESAS');
  end if;
  if p_tenant_id = v_dono.id then
    return jsonb_build_object('ok', false, 'erro', 'EMPRESA_PRINCIPAL');
  end if;
  select t.id, t.active into v_t
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id and t.escritorio_tenant_id = v_dono.id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'FORBIDDEN');
  end if;
  if p_ativa and not v_t.active then
    select count(*) into v_ativas from nofiscal.fiscal_tenants t
     where (t.id = v_dono.id or t.escritorio_tenant_id = v_dono.id) and t.active;
    if v_ativas >= nofiscal.max_empresas_do_plano(v_dono.plan) then
      return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE',
                                'limite', nofiscal.max_empresas_do_plano(v_dono.plan));
    end if;
  end if;
  update nofiscal.fiscal_tenants set active = p_ativa, updated_at = now() where id = p_tenant_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Notas do mês (fuso de Brasília, por created_at) de todas as empresas da conta ou de uma só.
create function public.fiscal_relatorio(p_user_id uuid, p_mes date, p_tenant_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dono uuid;
  v_inicio timestamptz;
  v_fim timestamptz;
  v_notas jsonb;
  v_totais jsonb;
begin
  if p_mes is null then
    raise exception 'fiscal_relatorio: parametro invalido' using errcode = '22023';
  end if;
  select coalesce(t.escritorio_tenant_id, t.id) into v_dono
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id and a.email_verified_at is not null;
  if v_dono is null then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_SEM_EMPRESA');
  end if;
  if p_tenant_id is not null and not nofiscal.usuario_pode_tenant(p_user_id, p_tenant_id) then
    return jsonb_build_object('ok', false, 'erro', 'FORBIDDEN');
  end if;
  v_inicio := date_trunc('month', p_mes::timestamp) at time zone 'America/Sao_Paulo';
  v_fim := (date_trunc('month', p_mes::timestamp) + interval '1 month') at time zone 'America/Sao_Paulo';

  select coalesce(jsonb_agg(n order by n ->> 'criada_em' desc), '[]'::jsonb) into v_notas
    from (
      select jsonb_build_object(
        'invoice_id', i.id,
        'criada_em', i.created_at,
        'emitida_em', i.issued_at,
        'situacao', i.status,
        'numero', i.dps_numero,
        'chave_acesso', i.chave_acesso,
        'empresa', jsonb_build_object('tenant_id', t.id, 'cnpj', t.cnpj, 'razao_social', t.razao_social),
        'tomador', jsonb_build_object(
          'nome', i.payload -> 'tomador' ->> 'nome',
          'documento', coalesce(i.payload -> 'tomador' ->> 'cnpj', i.payload -> 'tomador' ->> 'cpf'),
          'email', i.payload -> 'tomador' ->> 'email'),
        'descricao', i.payload -> 'servico' ->> 'descricao',
        'codigo_tributacao', coalesce(i.payload -> 'servico' ->> 'codigo_servico_nacional', t.codigo_servico_nacional),
        'valor', i.payload ->> 'valor',
        'motivo', case when i.status = 'rejected' then i.last_error end,
        'tem_pdf', i.status in ('issued', 'cancelled') and i.xml_nfse is not null,
        'entregas', coalesce((
          select jsonb_agg(jsonb_build_object('canal', e.canal, 'papel', e.papel, 'destino', e.destino,
                                              'status', e.status, 'em', e.created_at) order by e.created_at)
            from nofiscal.fiscal_invoice_entregas e where e.invoice_id = i.id), '[]'::jsonb)) as n
        from nofiscal.fiscal_invoices i
        join nofiscal.fiscal_tenants t on t.id = i.tenant_id
       where i.tenant_id in (select nofiscal.empresas_do_dono(v_dono))
         and (p_tenant_id is null or i.tenant_id = p_tenant_id)
         and i.created_at >= v_inicio and i.created_at < v_fim
       order by i.created_at desc
       limit 1000
    ) x;

  select jsonb_build_object(
           'emitidas', count(*) filter (where i.status = 'issued'),
           'valor_emitido', coalesce(sum((i.payload ->> 'valor')::numeric) filter (where i.status = 'issued'), 0),
           'recusadas', count(*) filter (where i.status = 'rejected'),
           'na_fila', count(*) filter (where i.status in ('queued', 'signing', 'sent')),
           'canceladas', count(*) filter (where i.status = 'cancelled'))
    into v_totais
    from nofiscal.fiscal_invoices i
   where i.tenant_id in (select nofiscal.empresas_do_dono(v_dono))
     and (p_tenant_id is null or i.tenant_id = p_tenant_id)
     and i.created_at >= v_inicio and i.created_at < v_fim
     and (i.payload ->> 'valor') ~ '^[0-9]+(\.[0-9]{1,2})?$';

  return jsonb_build_object('ok', true, 'mes', to_char(p_mes, 'YYYY-MM'), 'totais', v_totais, 'notas', v_notas);
end;
$$;

-- ------------------------------------------------------------ Funções existentes com os planos novos

create or replace function public.fiscal_cadastro_criar(
  p_user_id uuid,
  p_cnpj text,
  p_razao_social text,
  p_codigo_municipio_ibge text,
  p_cnae text,
  p_telefone text,
  p_plano text,
  p_responsavel text,
  p_api_key_hash text,
  p_ambiente text,
  p_regime text default 'simples'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_tenant record;
  v_client_id uuid;
  v_tenant_id uuid;
begin
  if p_user_id is null or p_cnpj !~ '^[0-9]{14}$' or p_telefone !~ '^\+[1-9][0-9]{7,14}$'
     or p_plano not in ('inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50') or p_codigo_municipio_ibge !~ '^[0-9]{7}$'
     or (p_cnae is not null and p_cnae !~ '^[0-9]{7}$')
     or length(btrim(coalesce(p_razao_social, ''))) not between 1 and 150
     or length(btrim(coalesce(p_responsavel, ''))) not between 2 and 120
     or p_api_key_hash !~ '^[0-9a-f]{64}$' or p_ambiente not in ('producao_restrita', 'producao')
     or p_regime is null or p_regime not in ('simples', 'mei') then
    raise exception 'fiscal_cadastro_criar: parametro invalido' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fiscal_cadastro_cnpj:' || p_cnpj, 0));
  perform pg_advisory_xact_lock(hashtextextended('fiscal_cadastro_tel:' || p_telefone, 0));
  perform pg_advisory_xact_lock(hashtextextended('fiscal_cadastro_user:' || p_user_id::text, 0));

  select lower(u.email) into v_email
    from auth.users u
   where u.id = p_user_id and u.email_confirmed_at is not null and u.email is not null;
  if v_email is null then
    return jsonb_build_object('status', 'sem_email_confirmado');
  end if;

  -- Já é dono de uma empresa: a mesma (retentativa) ou outra.
  select t.id, t.cnpj, t.onboarding_etapa into v_tenant
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id;
  if found then
    if v_tenant.cnpj = p_cnpj then
      return jsonb_build_object('status', 'existente', 'tenant_id', v_tenant.id, 'etapa', v_tenant.onboarding_etapa);
    end if;
    return jsonb_build_object('status', 'conta_ja_tem_empresa');
  end if;

  if exists (select 1 from nofiscal.fiscal_tenants t where t.cnpj = p_cnpj) then
    return jsonb_build_object('status', 'cnpj_ja_cadastrado');
  end if;
  if exists (select 1 from nofiscal.fiscal_phones f where f.phone_e164 = p_telefone) then
    return jsonb_build_object('status', 'telefone_de_outra_empresa');
  end if;

  insert into public.clients (name, slug, email, origem)
  values (btrim(p_razao_social), 'fiscal-' || replace(gen_random_uuid()::text, '-', ''), v_email, 'fiscal')
  returning id into v_client_id;

  insert into public.memberships (user_id, client_id, role) values (p_user_id, v_client_id, 'CLIENT');

  update auth.users
     set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                              || jsonb_build_object('responsavel', btrim(p_responsavel)),
         updated_at = now()
   where id = p_user_id;

  -- Conta que sobrou de um cadastro anterior sem empresa (v1) é reaproveitada.
  insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, phone_verified_at, client_id)
  values (p_user_id, v_email, p_telefone, now(), null, v_client_id)
  on conflict (user_id) do update
     set email = excluded.email, phone_e164 = excluded.phone_e164, email_verified_at = now(),
         phone_verified_at = null, client_id = excluded.client_id, updated_at = now();

  insert into nofiscal.fiscal_tenants
    (cnpj, razao_social, codigo_municipio_ibge, cnae, regime, api_key_hash, plan, monthly_note_limit,
     ambiente, client_id, onboarding_etapa)
  values
    (p_cnpj, btrim(p_razao_social), p_codigo_municipio_ibge, p_cnae, p_regime, p_api_key_hash, p_plano,
     nofiscal.limite_do_plano(p_plano), p_ambiente, v_client_id, 'pagamento')
  returning id into v_tenant_id;

  -- Unresolved 3 da tarefa: sem resposta da pesquisa, série "1" e próximo número 1.
  insert into nofiscal.fiscal_dps_series (tenant_id, serie, next_number) values (v_tenant_id, '1', 1);

  insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role, verified_at)
  values (v_tenant_id, p_telefone, 'owner', null);

  return jsonb_build_object('status', 'criado', 'tenant_id', v_tenant_id, 'etapa', 'pagamento');
exception
  -- Corrida que escapou das travas (outro caminho gravando o mesmo CNPJ ou número).
  when unique_violation then
    if exists (select 1 from nofiscal.fiscal_tenants t where t.cnpj = p_cnpj) then
      return jsonb_build_object('status', 'cnpj_ja_cadastrado');
    end if;
    return jsonb_build_object('status', 'telefone_de_outra_empresa');
end;
$$;


create or replace function public.fiscal_registrar_assinatura(
  p_tenant_id uuid,
  p_plano text,
  p_com_teste boolean,
  p_trial_ends_at timestamptz,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_aceite_texto text,
  p_ciclo text default 'mensal'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_status text;
  v_evento record;
  v_gateway_em timestamptz;
  v_reconciliada boolean := false;
begin
  if p_subscription_id is null or p_tenant_id is null or p_com_teste is null then
    raise exception 'fiscal_registrar_assinatura: parametro obrigatorio ausente' using errcode = '22023';
  end if;
  if p_plano is null or p_plano not in ('inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50') then
    raise exception 'fiscal_registrar_assinatura: plano invalido' using errcode = '22023';
  end if;
  if p_ciclo is null or p_ciclo not in ('mensal', 'anual') then
    raise exception 'fiscal_registrar_assinatura: ciclo invalido' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('pendente', 'recusada') then
    raise exception 'fiscal_registrar_assinatura: status invalido' using errcode = '22023';
  end if;
  if p_aceite_texto is null or btrim(p_aceite_texto) = '' then
    raise exception 'fiscal_registrar_assinatura: aceite obrigatorio' using errcode = '22023';
  end if;
  if p_com_teste and p_trial_ends_at is null then
    raise exception 'fiscal_registrar_assinatura: fim do teste obrigatorio' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fiscal_assinatura:' || p_subscription_id, 0));

  insert into nofiscal.fiscal_subscriptions
    (tenant_id, plano, ciclo, com_teste, pagarme_customer_id, pagarme_subscription_id, status, aceite_em, aceite_texto)
  values
    (p_tenant_id, p_plano, p_ciclo, p_com_teste, p_customer_id, p_subscription_id, p_status, now(), p_aceite_texto)
  returning id, status into v_id, v_status;

  update nofiscal.fiscal_tenants
     set plan = p_plano,
         monthly_note_limit = nofiscal.limite_do_plano(p_plano),
         trial_ends_at = case when p_com_teste then p_trial_ends_at else trial_ends_at end,
         updated_at = now()
   where id = p_tenant_id;

  select e.tipo, e.status_aplicado, e.recebido_em
    into v_evento
    from nofiscal.fiscal_subscription_events e
   where e.pagarme_subscription_id = p_subscription_id
     and e.status_aplicado is not null
   order by (e.status_aplicado = 'cancelada') desc,
            coalesce(e.evento_em, e.recebido_em) desc,
            e.recebido_em desc
   limit 1;

  if found then
    select max(coalesce(e.evento_em, e.recebido_em))
      into v_gateway_em
      from nofiscal.fiscal_subscription_events e
     where e.pagarme_subscription_id = p_subscription_id
       and e.status_aplicado is not null;

    update nofiscal.fiscal_subscriptions
       set status = v_evento.status_aplicado,
           ultimo_evento_tipo = v_evento.tipo,
           ultimo_evento_em = v_evento.recebido_em,
           ultimo_evento_gateway_em = v_gateway_em,
           updated_at = now()
     where id = v_id
    returning status into v_status;
    v_reconciliada := true;
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status, 'reconciliada', v_reconciliada);
end;
$$;


create or replace function public.fiscal_registrar_cortesia(p_tenant_id uuid, p_plano text, p_codigo text, p_aceite_texto text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cupom jsonb;
  v_id uuid;
begin
  if p_tenant_id is null or p_plano is null or p_plano not in ('inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50') then
    raise exception 'fiscal_registrar_cortesia: parametro invalido' using errcode = '22023';
  end if;
  if p_aceite_texto is null or btrim(p_aceite_texto) = '' then
    raise exception 'fiscal_registrar_cortesia: aceite obrigatorio' using errcode = '22023';
  end if;

  v_cupom := nofiscal.cupom_avaliar(p_tenant_id, p_codigo, p_plano);
  if not (v_cupom ->> 'ok')::boolean then
    return v_cupom;
  end if;
  if not (v_cupom ->> 'cortesia')::boolean then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_NAO_CORTESIA');
  end if;
  if exists (select 1 from nofiscal.fiscal_subscriptions s where s.tenant_id = p_tenant_id and s.status <> 'cancelada') then
    return jsonb_build_object('ok', false, 'motivo', 'ASSINATURA_EXISTENTE');
  end if;

  insert into nofiscal.fiscal_subscriptions
    (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto,
     origem, cupom_id, desconto_tipo, desconto_valor)
  values
    (p_tenant_id, p_plano, false, 'cortesia_' || gen_random_uuid(), 'paga', now(), p_aceite_texto,
     'cortesia', (v_cupom ->> 'cupom_id')::uuid, 'percentual', 100)
  returning id into v_id;

  update nofiscal.fiscal_tenants
     set plan = p_plano,
         monthly_note_limit = nofiscal.limite_do_plano(p_plano),
         updated_at = now()
   where id = p_tenant_id;

  insert into nofiscal.fiscal_cupom_usos (cupom_id, tenant_id, subscription_id)
  values ((v_cupom ->> 'cupom_id')::uuid, p_tenant_id, v_id);
  update nofiscal.fiscal_cupons set usos = usos + 1 where id = (v_cupom ->> 'cupom_id')::uuid;

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'paga');
end;
$$;


create or replace function public.fiscal_configurar(p_user_id uuid, p_dados jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_codigo text;
  v_pct_txt text;
  v_pct numeric;
  v_mexe_contador boolean;
  v_contador text;
  v_mexe_resumo boolean;
  v_freq text;
  v_dia integer;
  v_dia_txt text;
begin
  select t.id, t.plan, t.regime
    into v_t
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id
     and a.email_verified_at is not null
   for update of t;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_SEM_EMPRESA');
  end if;
  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'codigo_servico_nacional');
  end if;

  v_codigo := p_dados ->> 'codigo_servico_nacional';
  if v_codigo is null or v_codigo !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'codigo_servico_nacional');
  end if;

  -- MEI não informa o percentual do Simples na DPS (E0710): fica nulo e o pedido não precisa trazê-lo.
  if v_t.regime = 'mei' then
    v_pct := null;
  else
    v_pct_txt := p_dados ->> 'p_tot_trib_sn';
    if v_pct_txt is null or v_pct_txt !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' or v_pct_txt::numeric > 100 then
      return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'p_tot_trib_sn');
    end if;
    v_pct := v_pct_txt::numeric;
  end if;

  v_mexe_contador := p_dados ? 'contador_email';
  v_contador := case when v_mexe_contador then nullif(btrim(coalesce(p_dados ->> 'contador_email', '')), '') end;
  -- Chave ausente mantém; null apaga.
  v_mexe_resumo := p_dados ? 'resumo';

  -- Plano antes do formato: no Inicial, contador e resumo não existem.
  if not nofiscal.plano_completo(v_t.plan) then
    if v_mexe_resumo and jsonb_typeof(p_dados -> 'resumo') <> 'null' then
      return jsonb_build_object('ok', false, 'erro', 'PLANO_SEM_RESUMO');
    end if;
    if v_contador is not null then
      return jsonb_build_object('ok', false, 'erro', 'PLANO_SEM_CONTADOR');
    end if;
  end if;

  if v_contador is not null
     and (length(v_contador) > 254 or v_contador !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'contador_email');
  end if;

  if v_mexe_resumo and jsonb_typeof(p_dados -> 'resumo') <> 'null' then
    if jsonb_typeof(p_dados -> 'resumo') <> 'object' then
      return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'resumo');
    end if;
    v_freq := p_dados -> 'resumo' ->> 'frequencia';
    v_dia_txt := p_dados -> 'resumo' ->> 'dia';
    if v_dia_txt is null or v_dia_txt !~ '^[0-9]{1,2}$' then
      return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'resumo');
    end if;
    v_dia := v_dia_txt::integer;
    if not ((v_freq = 'mensal' and v_dia between 1 and 28) or (v_freq = 'semanal' and v_dia between 1 and 7)) then
      return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'resumo');
    end if;
  end if;

  update nofiscal.fiscal_tenants
     set codigo_servico_nacional = v_codigo,
         p_tot_trib_sn = v_pct,
         contador_email = case when v_mexe_contador then v_contador else contador_email end,
         resumo_frequencia = case when v_mexe_resumo then v_freq else resumo_frequencia end,
         resumo_dia = case when v_mexe_resumo then v_dia::smallint else resumo_dia end,
         onboarding_etapa = case when onboarding_etapa = 'dados_fiscais' then 'clientes' else onboarding_etapa end,
         updated_at = now()
   where id = v_t.id;

  return jsonb_build_object('ok', true);
end;
$$;


create or replace function nofiscal.cupom_avaliar(p_tenant_id uuid, p_codigo text, p_plano text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codigo text := upper(btrim(coalesce(p_codigo, '')));
  v record;
begin
  select c.* into v from nofiscal.fiscal_cupons c where c.codigo = v_codigo for update;
  if not found or not v.ativo then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_INVALIDO');
  end if;
  if v.valido_ate is not null and v.valido_ate <= now() then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_VENCIDO');
  end if;
  if v.max_usos is not null and v.usos >= v.max_usos then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_ESGOTADO');
  end if;
  if v.planos is not null and not (p_plano = any (v.planos)) then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_PLANO');
  end if;
  if exists (select 1 from nofiscal.fiscal_cupom_usos u where u.cupom_id = v.id and u.tenant_id = p_tenant_id) then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_JA_USADO');
  end if;
  return jsonb_build_object(
    'ok', true,
    'cupom_id', v.id,
    'codigo', v.codigo,
    'descricao', v.descricao,
    'tipo', v.tipo,
    'valor', v.valor,
    'cortesia', v.tipo = 'percentual' and v.valor = 100,
    'ciclos', case when v.tipo = 'percentual' and v.valor = 100 then null else v.ciclos end,
    'dias_de_teste', v.dias_de_teste);
end;
$$;


create or replace function nofiscal.onboarding_set_certificate(
  p_user_id uuid, p_tenant_id uuid, p_pfx_base64 text, p_senha text, p_subject text, p_not_after timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cnpj text;
  v_attempts integer;
begin
  select t.cnpj into v_cnpj
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id
     and nofiscal.usuario_pode_tenant(p_user_id, t.id);
  if not found then
    return 'FORBIDDEN';
  end if;

  -- Uma tentativa por vez por tenant: duas simultâneas não passam juntas do limite.
  perform pg_advisory_xact_lock(hashtextextended('nofiscal_onboarding_certificate:' || p_tenant_id::text, 0));
  select count(*) into v_attempts
    from nofiscal.fiscal_certificate_attempts a
   where a.tenant_id = p_tenant_id
     and a.attempted_at > now() - interval '1 hour';
  if v_attempts >= 5 then
    return 'RATE_LIMITED';
  end if;
  insert into nofiscal.fiscal_certificate_attempts (tenant_id, user_id) values (p_tenant_id, p_user_id);

  if coalesce(p_pfx_base64, '') = '' or p_senha is null or coalesce(p_subject, '') = '' or p_not_after is null then
    return 'INVALID';
  end if;
  if p_not_after <= now() then
    return 'CERT_VENCIDO';
  end if;
  -- e-CNPJ ICP-Brasil: o CN é "NOME:CNPJ". O CNPJ do tenant tem de aparecer inteiro.
  if p_subject !~ ('(^|[^0-9])' || v_cnpj || '([^0-9]|$)') then
    return 'CERT_CNPJ_DIFERENTE';
  end if;

  perform nofiscal.upsert_certificate(p_tenant_id, p_pfx_base64, p_senha, p_subject, p_not_after);
  -- v2: com o A1 gravado, o onboarding passa aos dados fiscais (só a partir de `certificado`).
  update nofiscal.fiscal_tenants
     set onboarding_etapa = 'dados_fiscais', updated_at = now()
   where id = p_tenant_id
     and onboarding_etapa = 'certificado';
  return 'OK';
end;
$$;


create or replace function nofiscal.onboarding_delete_certificate(p_user_id uuid, p_tenant_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if not nofiscal.usuario_pode_tenant(p_user_id, p_tenant_id) then
    return 'FORBIDDEN';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('nofiscal_onboarding_certificate:' || p_tenant_id::text, 0));
  delete from nofiscal.fiscal_certificates c
   where c.tenant_id = p_tenant_id
  returning c.vault_secret_id into v_secret_id;
  if v_secret_id is not null then
    delete from vault.secrets s where s.id = v_secret_id;
  end if;
  return 'OK';
end;
$$;


-- ------------------------------------------------------------ Acesso

revoke all on function nofiscal.limite_do_plano(text), nofiscal.max_empresas_do_plano(text),
  nofiscal.plano_de_escritorio(text), nofiscal.plano_completo(text), nofiscal.dono_do_tenant(uuid),
  nofiscal.usuario_pode_tenant(uuid, uuid), nofiscal.empresas_do_dono(uuid), nofiscal.escritorio_do_usuario(uuid)
  from public, anon, authenticated, service_role;
grant execute on function nofiscal.limite_do_plano(text), nofiscal.max_empresas_do_plano(text),
  nofiscal.plano_de_escritorio(text), nofiscal.plano_completo(text), nofiscal.dono_do_tenant(uuid),
  nofiscal.usuario_pode_tenant(uuid, uuid), nofiscal.empresas_do_dono(uuid)
  to nofiscal_service;

revoke all on function public.fiscal_escritorio_estado(uuid),
  public.fiscal_empresa_adicionar(uuid, text, text, text, text, text, text, text),
  public.fiscal_empresa_configurar(uuid, uuid, jsonb),
  public.fiscal_empresa_ativar(uuid, uuid, boolean),
  public.fiscal_relatorio(uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function public.fiscal_escritorio_estado(uuid),
  public.fiscal_empresa_adicionar(uuid, text, text, text, text, text, text, text),
  public.fiscal_empresa_configurar(uuid, uuid, jsonb),
  public.fiscal_empresa_ativar(uuid, uuid, boolean),
  public.fiscal_relatorio(uuid, date, uuid)
  to service_role;
