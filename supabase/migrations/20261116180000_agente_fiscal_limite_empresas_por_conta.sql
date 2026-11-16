-- nó.fiscal: limite de empresas por conta, o "pacote por notas" do Escritório (Lucca, 16/11/2026).
-- Escritório com muitos clientes de poucas notas paga a faixa normal (escritorio_5/20/50, com cupom) e recebe
-- mais CNPJs do que a faixa permite. A franquia de notas (limite_do_plano) não muda: o pacote é a franquia da
-- faixa com os CNPJs liberados. Primeiro caso: faixa 20 com "sem limite de empresas, limite só de 2.000 notas".
--
-- Entra: nofiscal.fiscal_tenants.max_empresas_override (só na conta-mãe de escritório) e
-- nofiscal.max_empresas_da_conta(tenant) = coalesce(override, max_empresas_do_plano(plan)). Trocar plano,
-- estado do painel, adicionar e reativar empresa passam a usar o limite da conta.
-- Aplicar o pacote: public.fiscal_definir_limite_empresas(conta_mae, limite), EXECUTE só service_role
-- (Lucca pelo SQL do painel ou CLI). null tira o pacote e volta ao limite da faixa.
--
-- Decisão (troca de faixa): o override fica na conta até ser zerado (null), em qualquer troca de faixa, para
-- cima ou para baixo. O pacote é vendido por volume de notas, e a franquia de notas acompanha a faixa nova;
-- por isso descer de faixa reduz as notas, não os CNPJs. Se não quiser isso para um cliente, zere o override.

alter table nofiscal.fiscal_tenants
  add column max_empresas_override integer,
  add constraint fiscal_tenants_max_empresas_override_check
    check (max_empresas_override is null or max_empresas_override between 1 and 1000),
  -- Só a conta-mãe de escritório tem limite próprio; empresa de escritório segue a conta-mãe.
  add constraint fiscal_tenants_max_empresas_override_conta_mae
    check (max_empresas_override is null or escritorio_tenant_id is null);
comment on column nofiscal.fiscal_tenants.max_empresas_override is
  'Pacote por notas: empresas ativas que a conta-mãe do escritório pode ter, no lugar do limite da faixa. '
  'null = limite da faixa. Fica na troca de faixa até ser zerado. Definir só por public.fiscal_definir_limite_empresas.';

-- Limite de empresas ativas da conta (conta-mãe). Para qualquer outro tenant, o limite do plano dele.
create function nofiscal.max_empresas_da_conta(p_tenant_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(t.max_empresas_override, nofiscal.max_empresas_do_plano(t.plan))
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id;
$$;

-- ------------------------------------------------------------ Troca de plano

-- Corpo de 20261105180000; o limite da faixa pedida é o override da conta, se houver.
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
  v_limite integer;
begin
  if p_plano is null or p_plano not in ('inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50') then
    raise exception 'fiscal_trocar_plano: plano invalido' using errcode = '22023';
  end if;
  select t.id, t.plan, t.max_empresas_override into v_tenant
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
    v_limite := coalesce(v_tenant.max_empresas_override, nofiscal.max_empresas_do_plano(p_plano));
    select count(*) into v_ativas
      from nofiscal.fiscal_tenants t
     where (t.id = v_tenant.id or t.escritorio_tenant_id = v_tenant.id) and t.active;
    if v_ativas > v_limite then
      return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE',
                                'ativas', v_ativas, 'limite', v_limite);
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

-- Corpo de 20261111180000 (certificado efetivo e procuração); max_empresas = limite da conta e
-- max_empresas_override para o painel saber que a conta tem pacote.
create or replace function public.fiscal_escritorio_estado(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dono uuid;
  v_plan text;
  v_override integer;
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
  select t.plan, t.max_empresas_override into v_plan, v_override from nofiscal.fiscal_tenants t where t.id = v_dono;
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
        'modo_autenticacao', t.modo_autenticacao,
        'procuracao', case when p.tenant_id is null then null
                           else jsonb_build_object('status', p.status, 'valida_ate', p.valida_ate) end,
        'certificado', case when ce.tenant_id is null then null
                            else jsonb_build_object('subject', ce.subject, 'not_after', ce.not_after) end,
        'notas_mes', (select count(*) from nofiscal.fiscal_invoices i
                       where i.tenant_id = t.id and i.issued_at >= v_inicio and i.issued_at < v_fim),
        'situacao', case
          when not t.active then 'desativada'
          when t.modo_autenticacao = 'procuracao' and ce.tenant_id is null then 'procuracao_pendente'
          when ce.tenant_id is null then 'falta_certificado'
          when ce.not_after <= now() then 'certificado_vencido'
          when t.codigo_servico_nacional is null or (t.p_tot_trib_sn is null and t.regime <> 'mei') then 'falta_dados_fiscais'
          when ce.not_after <= now() + interval '30 days' then 'certificado_vencendo'
          else 'pronta'
        end) as e
        from nofiscal.fiscal_tenants t
        left join nofiscal.fiscal_certificados_de_emissao ce on ce.tenant_id = t.id
        left join nofiscal.fiscal_procuracoes p on p.tenant_id = t.id
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
    'max_empresas', nofiscal.max_empresas_da_conta(v_dono),
    'max_empresas_override', v_override,
    'empresas_ativas', v_ativas,
    'notas_limite', nofiscal.limite_do_plano(v_plan),
    'notas_mes', v_notas,
    'empresas', v_empresas);
end;
$$;

-- Corpo de 20261105180000; limite da conta no lugar do limite da faixa.
create or replace function public.fiscal_empresa_adicionar(
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
  v_limite integer;
  v_id uuid;
begin
  if p_cnpj is null or p_cnpj !~ '^[0-9]{14}$' or p_codigo_municipio_ibge !~ '^[0-9]{7}$'
     or (p_cnae is not null and p_cnae !~ '^[0-9]{7}$')
     or length(btrim(coalesce(p_razao_social, ''))) not between 1 and 150
     or p_regime is null or p_regime not in ('simples', 'mei')
     or p_api_key_hash !~ '^[0-9a-f]{64}$' or p_ambiente not in ('producao_restrita', 'producao') then
    raise exception 'fiscal_empresa_adicionar: parametro invalido' using errcode = '22023';
  end if;

  select t.id, t.plan, nofiscal.max_empresas_da_conta(t.id) as limite
    into v_dono
    from nofiscal.fiscal_tenants t
   where t.id = nofiscal.escritorio_do_usuario(p_user_id)
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'PLANO_SEM_EMPRESAS');
  end if;
  v_limite := v_dono.limite;
  perform pg_advisory_xact_lock(hashtextextended('fiscal_cadastro_cnpj:' || p_cnpj, 0));

  select count(*) into v_ativas from nofiscal.fiscal_tenants t
   where (t.id = v_dono.id or t.escritorio_tenant_id = v_dono.id) and t.active;

  select t.id, t.escritorio_tenant_id, t.active into v_existente
    from nofiscal.fiscal_tenants t where t.cnpj = p_cnpj;
  if found then
    -- Empresa desativada deste escritório: volta, se couber no limite da conta.
    if v_existente.escritorio_tenant_id = v_dono.id and not v_existente.active then
      if v_ativas >= v_limite then
        return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE', 'limite', v_limite);
      end if;
      update nofiscal.fiscal_tenants set active = true, updated_at = now() where id = v_existente.id;
      return jsonb_build_object('ok', true, 'tenant_id', v_existente.id, 'reativada', true);
    end if;
    return jsonb_build_object('ok', false, 'erro', 'CNPJ_JA_CADASTRADO');
  end if;

  if v_ativas >= v_limite then
    return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE', 'limite', v_limite);
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

-- Corpo de 20261105180000; limite da conta no lugar do limite da faixa.
create or replace function public.fiscal_empresa_ativar(p_user_id uuid, p_tenant_id uuid, p_ativa boolean)
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
  select t.id, t.plan, nofiscal.max_empresas_da_conta(t.id) as limite
    into v_dono
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
    if v_ativas >= v_dono.limite then
      return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE', 'limite', v_dono.limite);
    end if;
  end if;
  update nofiscal.fiscal_tenants set active = p_ativa, updated_at = now() where id = p_tenant_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ------------------------------------------------------------ Aplicar o pacote (só a nó)

-- Define (p_limite > 0) ou tira (p_limite null) o limite de empresas da conta-mãe de um escritório.
-- Recusa: conta que não é conta-mãe de escritório, limite fora de 1..1000, limite abaixo das empresas ativas.
-- Achar a conta-mãe pelo CNPJ ou pelo e-mail do escritório:
--   select t.id, t.cnpj, t.razao_social, t.plan, t.max_empresas_override
--     from nofiscal.fiscal_tenants t
--     left join nofiscal.fiscal_accounts a on a.client_id = t.client_id
--    where t.escritorio_tenant_id is null
--      and (t.cnpj = '<14 dígitos>' or lower(a.email) = lower('<email>'));
create function public.fiscal_definir_limite_empresas(p_tenant_id uuid, p_limite integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_ativas integer;
  v_limite integer;
begin
  if p_tenant_id is null or (p_limite is not null and p_limite not between 1 and 1000) then
    raise exception 'fiscal_definir_limite_empresas: parametro invalido' using errcode = '22023';
  end if;
  select t.id, t.plan, t.escritorio_tenant_id, t.max_empresas_override into v_t
    from nofiscal.fiscal_tenants t where t.id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_NAO_ENCONTRADA');
  end if;
  if v_t.escritorio_tenant_id is not null or not nofiscal.plano_de_escritorio(v_t.plan) then
    return jsonb_build_object('ok', false, 'erro', 'NAO_E_CONTA_MAE_DE_ESCRITORIO');
  end if;
  v_limite := coalesce(p_limite, nofiscal.max_empresas_do_plano(v_t.plan));
  select count(*) into v_ativas from nofiscal.fiscal_tenants t
   where (t.id = v_t.id or t.escritorio_tenant_id = v_t.id) and t.active;
  if v_ativas > v_limite then
    return jsonb_build_object('ok', false, 'erro', 'EMPRESAS_ACIMA_DO_LIMITE', 'ativas', v_ativas, 'limite', v_limite);
  end if;
  update nofiscal.fiscal_tenants
     set max_empresas_override = p_limite, updated_at = now()
   where id = v_t.id;
  return jsonb_build_object('ok', true, 'tenant_id', v_t.id, 'plano', v_t.plan,
                            'limite_anterior', coalesce(v_t.max_empresas_override, nofiscal.max_empresas_do_plano(v_t.plan)),
                            'limite', v_limite, 'override', p_limite, 'ativas', v_ativas);
end;
$$;

-- ------------------------------------------------------------ Acesso

revoke all on function nofiscal.max_empresas_da_conta(uuid) from public, anon, authenticated, service_role;
grant execute on function nofiscal.max_empresas_da_conta(uuid) to nofiscal_service;

revoke all on function public.fiscal_definir_limite_empresas(uuid, integer) from public, anon, authenticated;
grant execute on function public.fiscal_definir_limite_empresas(uuid, integer) to service_role;
