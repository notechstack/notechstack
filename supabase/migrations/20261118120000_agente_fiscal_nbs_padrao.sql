-- NBS padrão por empresa (nó.fiscal). Coluna opcional em fiscal_tenants, ao lado de codigo_servico_nacional.
-- Na emissão (app/api/_lib/dps-builder.ts) a ordem é: servico.nbs da nota (API) > NBS padrão da empresa >
-- Anexo VIII pelo código. A lista nacional (NBS 2.0, 918 códigos) é conferida na fiscal-conta; aqui, só o formato.
-- As quatro funções abaixo são as mesmas de antes (conferidas contra a produção em 18/11/2026), com o campo a mais.
-- RLS: fiscal_tenants já tem RLS; a coluna nova não muda quem lê ou grava a linha. Os grants das funções ficam.

alter table nofiscal.fiscal_tenants
  add column nbs_padrao text
  constraint fiscal_tenants_nbs_padrao_formato check (nbs_padrao ~ '^[0-9]{9}$');

comment on column nofiscal.fiscal_tenants.nbs_padrao is
  'NBS padrão da empresa (cNBS da DPS, 9 dígitos, lista NBS 2.0). Vale quando a nota não informa servico.nbs.';

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
  v_mexe_nbs boolean;
  v_nbs text;
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

  -- NBS padrão (opcional): chave ausente mantém; null ou '' apaga. A lista nacional (NBS 2.0) quem confere é a fiscal-conta.
  v_mexe_nbs := p_dados ? 'nbs_padrao';
  v_nbs := case when v_mexe_nbs then nullif(btrim(coalesce(p_dados ->> 'nbs_padrao', '')), '') end;
  if v_nbs is not null and v_nbs !~ '^[0-9]{9}$' then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'nbs_padrao');
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
         nbs_padrao = case when v_mexe_nbs then v_nbs else nbs_padrao end,
         contador_email = case when v_mexe_contador then v_contador else contador_email end,
         resumo_frequencia = case when v_mexe_resumo then v_freq else resumo_frequencia end,
         resumo_dia = case when v_mexe_resumo then v_dia::smallint else resumo_dia end,
         onboarding_etapa = case when onboarding_etapa = 'dados_fiscais' then 'clientes' else onboarding_etapa end,
         updated_at = now()
   where id = v_t.id;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.fiscal_empresa_configurar(p_user_id uuid, p_tenant_id uuid, p_dados jsonb)
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
  v_mexe_nbs boolean;
  v_nbs text;
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

  -- NBS padrão (opcional): chave ausente mantém; null ou '' apaga. A lista nacional (NBS 2.0) quem confere é a fiscal-conta.
  v_mexe_nbs := p_dados ? 'nbs_padrao';
  v_nbs := case when v_mexe_nbs then nullif(btrim(coalesce(p_dados ->> 'nbs_padrao', '')), '') end;
  if v_nbs is not null and v_nbs !~ '^[0-9]{9}$' then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'nbs_padrao');
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
         nbs_padrao = case when v_mexe_nbs then v_nbs else nbs_padrao end,
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

create or replace function public.fiscal_conta_estado(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_s record;
  v_c record;
  v_em_teste boolean;
  v_assinatura jsonb := null;
  v_certificado jsonb := null;
begin
  select t.id, t.cnpj, t.razao_social, t.codigo_municipio_ibge, t.cnae, t.regime, t.plan, t.onboarding_etapa,
         t.trial_ends_at, t.codigo_servico_nacional, t.p_tot_trib_sn, t.nbs_padrao, t.contador_email,
         t.resumo_frequencia, t.resumo_dia, a.email, a.phone_e164,
         u.raw_user_meta_data ->> 'responsavel' as responsavel
    into v_t
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
    left join auth.users u on u.id = a.user_id
   where a.user_id = p_user_id
     and a.email_verified_at is not null;
  if not found then
    return null;
  end if;

  select s.id, s.plano, s.ciclo, s.status, s.com_teste, s.pagarme_subscription_id, s.cancelamento_agendado_para,
         s.cancelamento_origem
    into v_s
    from nofiscal.fiscal_subscriptions s
   where s.tenant_id = v_t.id
   order by (s.status <> 'cancelada') desc, s.created_at desc
   limit 1;
  if found then
    v_em_teste := v_s.com_teste and v_s.status = 'pendente' and v_t.trial_ends_at > now();
    v_assinatura := jsonb_build_object(
      'id', v_s.id,
      'status', v_s.status,
      'com_teste', v_s.com_teste,
      'em_teste', v_em_teste,
      'trial_ends_at', v_t.trial_ends_at,
      'cancelamento_agendado_para', v_s.cancelamento_agendado_para,
      'cancelamento_origem', v_s.cancelamento_origem,
      'pagarme_subscription_id', v_s.pagarme_subscription_id,
      'ciclo', v_s.ciclo,
      'periodo_fim', case
        when v_s.cancelamento_agendado_para is not null then v_s.cancelamento_agendado_para
        when v_s.status = 'cancelada' or v_s.status = 'recusada' then null
        when v_em_teste then v_t.trial_ends_at
        else nofiscal.fim_do_ciclo_derivado(v_s.id) - interval '1 hour'
      end);
  end if;

  select c.subject, c.not_after into v_c from nofiscal.fiscal_certificates c where c.tenant_id = v_t.id;
  if found then
    v_certificado := jsonb_build_object('subject', v_c.subject, 'not_after', v_c.not_after);
  end if;

  return jsonb_build_object(
    'tenant_id', v_t.id,
    'onboarding_etapa', v_t.onboarding_etapa,
    'plano', v_t.plan,
    'empresa', jsonb_build_object(
      'cnpj', v_t.cnpj,
      'razao_social', v_t.razao_social,
      'codigo_municipio_ibge', v_t.codigo_municipio_ibge,
      'municipio', null,
      'uf', null,
      'cnae', v_t.cnae,
      'regime', v_t.regime,
      'responsavel', v_t.responsavel,
      'email', v_t.email,
      'telefone', v_t.phone_e164),
    'assinatura', v_assinatura,
    'certificado', v_certificado,
    'fiscal', jsonb_build_object(
      'codigo_servico_nacional', v_t.codigo_servico_nacional,
      'p_tot_trib_sn', v_t.p_tot_trib_sn,
      'nbs_padrao', v_t.nbs_padrao,
      'contador_email', v_t.contador_email,
      'resumo', case when v_t.resumo_frequencia is null then null
                     else jsonb_build_object('frequencia', v_t.resumo_frequencia, 'dia', v_t.resumo_dia) end));
end;
$$;

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
        'nbs_padrao', t.nbs_padrao,
        'modo_autenticacao', t.modo_autenticacao,
        'procuracao', case when p.tenant_id is null then null
                           else jsonb_build_object('status', p.status, 'valida_ate', p.valida_ate) end,
        'certificado', case when ce.tenant_id is null then null
                            else jsonb_build_object('subject', ce.subject, 'not_after', ce.not_after) end,
        'notas_mes', (select count(*) from nofiscal.fiscal_invoices i
                       where i.tenant_id = t.id and i.issued_at >= v_inicio and i.issued_at < v_fim)
                   + (select count(*) from nofiscal.fiscal_nfe n
                       where n.tenant_id = t.id and n.authorized_at >= v_inicio and n.authorized_at < v_fim),
        'nfe', jsonb_build_object(
          'inscricao_estadual', t.inscricao_estadual,
          'endereco', t.endereco,
          'serie', (select s.serie from nofiscal.fiscal_nfe_series s where s.tenant_id = t.id and s.ativa),
          'proximo_numero', (select s.next_number from nofiscal.fiscal_nfe_series s where s.tenant_id = t.id and s.ativa),
          'bloqueio', nofiscal.nfe_emission_block(t.id)),
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
  v_notas := v_notas + (select count(*) from nofiscal.fiscal_nfe n
     where n.tenant_id in (select nofiscal.empresas_do_dono(v_dono))
       and n.authorized_at >= v_inicio and n.authorized_at < v_fim);

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
