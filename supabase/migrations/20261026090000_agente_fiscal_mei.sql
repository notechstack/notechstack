-- nó.fiscal para MEI (Lucca, 22/10/2026). O cadastro passa a gravar o regime da Receita (BrasilAPI):
-- mei ou simples (ME/EPP). Quem não é do Simples é barrado na edge function, antes do banco.
-- O MEI emite pelo Emissor Nacional em qualquer município (Anexo I v1.01: E0037/E0038/E0039
-- exceptuam o MEI) e não informa o percentual do Simples na DPS (E0710), então p_tot_trib_sn
-- deixa de ser obrigatório para ele.

alter table nofiscal.fiscal_tenants drop constraint fiscal_tenants_regime_check,
  add constraint fiscal_tenants_regime_check check (regime in ('simples', 'mei'));

-- ------------------------------------------------------------ Cadastro com regime

-- p_regime entra por último e com padrão: a fiscal-cadastro publicada antes desta migração
-- continua chamando a função pelos parâmetros nomeados e cria empresa do Simples.
drop function public.fiscal_cadastro_criar(uuid, text, text, text, text, text, text, text, text, text);

create function public.fiscal_cadastro_criar(
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
     or p_plano not in ('inicial', 'pro') or p_codigo_municipio_ibge !~ '^[0-9]{7}$'
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
     case p_plano when 'pro' then 100 else 20 end, p_ambiente, v_client_id, 'pagamento')
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

revoke all on function public.fiscal_cadastro_criar(uuid, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fiscal_cadastro_criar(uuid, text, text, text, text, text, text, text, text, text, text) to service_role;

-- ------------------------------------------------------------ Emissão sem percentual para MEI

create or replace function nofiscal.emission_block(p_tenant_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tenant record;
  v_not_after timestamptz;
  v_status text;
begin
  select t.active, t.codigo_servico_nacional, t.p_tot_trib_sn, t.regime, t.trial_ends_at
    into v_tenant
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id;
  if not found then
    return 'TENANT_NOT_FOUND';
  end if;
  if not v_tenant.active then
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
   where s.tenant_id = p_tenant_id
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
  if v_status = 'pendente' and v_tenant.trial_ends_at > now() then
    return null;
  end if;
  return 'PAYMENT_NOT_APPROVED';
end;
$$;

-- ------------------------------------------------------------ Conta: regime no estado e na configuração

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
         t.trial_ends_at, t.codigo_servico_nacional, t.p_tot_trib_sn, t.contador_email,
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

  select s.id, s.plano, s.status, s.com_teste, s.pagarme_subscription_id, s.cancelamento_agendado_para,
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
      'contador_email', v_t.contador_email,
      'resumo', case when v_t.resumo_frequencia is null then null
                     else jsonb_build_object('frequencia', v_t.resumo_frequencia, 'dia', v_t.resumo_dia) end));
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
  if v_t.plan <> 'pro' then
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
