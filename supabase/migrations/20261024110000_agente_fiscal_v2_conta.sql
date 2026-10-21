-- Agente fiscal v2, lote B: "Minha conta", configuração fiscal e ciclo da assinatura.
-- Formas literais no Landing de .checks/agente-fiscal-v2.md, linhas "(lote B)". Só cria objetos
-- próprios (funções, grants, segredo do cron e job); as colunas vêm da migração-base
-- 20261024090000_agente_fiscal_v2.sql. Edge functions → banco só por public.fiscal_*
-- (security definer, search_path = '', EXECUTE só service_role).

-- ---------------------------------------------------------------------------------------
-- Fim do ciclo derivado no banco (Landing, "Fim do período pago"): âncora = dia UTC de
-- trial_ends_at (com teste) ou de created_at (sem teste); fim = primeira âncora + n meses
-- depois de agora − 1 s. Usado quando o current_cycle.end_at do Pagar.me não está à mão.
create function nofiscal.fim_do_ciclo_derivado(p_subscription_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ancora timestamp;
  v_fim timestamptz;
  v_meses integer := 1;
begin
  select date_trunc('day',
           case when s.com_teste and t.trial_ends_at is not null then t.trial_ends_at else s.created_at end
           at time zone 'UTC')
    into v_ancora
    from nofiscal.fiscal_subscriptions s
    join nofiscal.fiscal_tenants t on t.id = s.tenant_id
   where s.id = p_subscription_id;
  if v_ancora is null then
    return null;
  end if;

  loop
    -- make_interval a partir da âncora (não somas sucessivas): dia 31 não escorrega para 28.
    v_fim := ((v_ancora + make_interval(months => v_meses)) at time zone 'UTC') - interval '1 second';
    exit when v_fim > now() or v_meses >= 1200;
    v_meses := v_meses + 1;
  end loop;
  return v_fim;
end;
$$;

-- Regra única do cancelamento agendado (site e WhatsApp). Ver Landing para a forma.
create function nofiscal.agendar_cancelamento_com_fim(p_tenant_id uuid, p_origem text, p_fim_ciclo timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_fim timestamptz;
  v_quando timestamptz;
begin
  if p_origem is null or p_origem not in ('site', 'whatsapp') then
    raise exception 'agendar_cancelamento: origem invalida' using errcode = '22023';
  end if;

  select s.id, s.status, s.com_teste, s.cancelamento_agendado_para, t.trial_ends_at
    into v
    from nofiscal.fiscal_subscriptions s
    join nofiscal.fiscal_tenants t on t.id = s.tenant_id
   where s.tenant_id = p_tenant_id
     and s.status <> 'cancelada'
   order by s.created_at desc
   limit 1
   for update of s;
  if not found then
    return jsonb_build_object('status', 'sem_assinatura');
  end if;

  -- O primeiro pedido vale: repetir não muda a data.
  if v.cancelamento_agendado_para is not null then
    return jsonb_build_object('status', 'agendado', 'cancelamento_agendado_para', v.cancelamento_agendado_para);
  end if;

  if (v.com_teste and v.status = 'pendente' and v.trial_ends_at > now()) or v.status = 'recusada' then
    -- No teste nada foi cobrado; com pagamento recusado não há período pago.
    v_quando := now();
  else
    v_fim := case when p_fim_ciclo > now() then p_fim_ciclo else nofiscal.fim_do_ciclo_derivado(v.id) end;
    v_quando := greatest(coalesce(v_fim - interval '1 hour', now()), now());
  end if;

  update nofiscal.fiscal_subscriptions
     set cancelamento_agendado_para = v_quando,
         cancelamento_pedido_em = now(),
         cancelamento_origem = p_origem,
         updated_at = now()
   where id = v.id;

  return jsonb_build_object('status', 'agendado', 'cancelamento_agendado_para', v_quando);
end;
$$;

-- Contrato B → C (Landing): o agente do WhatsApp agenda pelo nofiscal_service.
create function nofiscal.agendar_cancelamento(p_tenant_id uuid, p_origem text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select nofiscal.agendar_cancelamento_com_fim(p_tenant_id, p_origem, null);
$$;

-- ---------------------------------------------------------------------------------------
-- Estado da conta (contrato E → B). Campos internos (ids do Pagar.me, em_teste) saem daqui e
-- o core da edge function tira o que não vai para a página.
create function public.fiscal_conta_estado(p_user_id uuid)
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
  select t.id, t.cnpj, t.razao_social, t.codigo_municipio_ibge, t.cnae, t.plan, t.onboarding_etapa,
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

-- Configuração fiscal (critérios 16–18). A edge function valida antes (inclusive a lista
-- nacional); aqui a regra de plano e o formato se repetem, e tudo grava numa transação.
create function public.fiscal_configurar(p_user_id uuid, p_dados jsonb)
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
  select t.id, t.plan
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

  v_pct_txt := p_dados ->> 'p_tot_trib_sn';
  if v_pct_txt is null or v_pct_txt !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' or v_pct_txt::numeric > 100 then
    return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'p_tot_trib_sn');
  end if;
  v_pct := v_pct_txt::numeric;

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

-- Troca de plano (critério 40): chamada depois que o Pagar.me aceitou o item novo.
create function public.fiscal_trocar_plano(p_user_id uuid, p_plano text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_sub uuid;
begin
  if p_plano is null or p_plano not in ('inicial', 'pro') then
    raise exception 'fiscal_trocar_plano: plano invalido' using errcode = '22023';
  end if;
  select t.id into v_tenant
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id
     and a.email_verified_at is not null
   for update of t;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_SEM_EMPRESA');
  end if;
  select s.id into v_sub
    from nofiscal.fiscal_subscriptions s
   where s.tenant_id = v_tenant and s.status <> 'cancelada'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'SEM_ASSINATURA');
  end if;

  update nofiscal.fiscal_tenants
     set plan = p_plano,
         monthly_note_limit = case p_plano when 'pro' then 100 else 20 end,
         updated_at = now()
   where id = v_tenant;
  update nofiscal.fiscal_subscriptions set plano = p_plano, updated_at = now() where id = v_sub;
  return jsonb_build_object('ok', true);
end;
$$;

-- Cancelamento pedido no site (critérios 41 e 43); p_fim_ciclo = current_cycle.end_at, ou nulo.
create function public.fiscal_agendar_cancelamento(p_user_id uuid, p_fim_ciclo timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select t.id into v_tenant
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id
     and a.email_verified_at is not null;
  if not found then
    return jsonb_build_object('status', 'sem_empresa');
  end if;
  return nofiscal.agendar_cancelamento_com_fim(v_tenant, 'site', p_fim_ciclo);
end;
$$;

-- Apagar conta e dados (critério 45, Unresolved 9). O Pagar.me já foi cancelado pela edge function.
create function public.fiscal_apagar_conta(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_client uuid;
  v_secret uuid;
begin
  select t.id, t.client_id into v_tenant, v_client
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id
     and a.email_verified_at is not null
   for update of t;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_SEM_EMPRESA');
  end if;

  update nofiscal.fiscal_subscriptions
     set cancelamento_agendado_para = now(),
         cancelamento_pedido_em = now(),
         cancelamento_origem = 'site',
         updated_at = now()
   where tenant_id = v_tenant
     and status <> 'cancelada'
     and cancelamento_agendado_para is null;

  perform pg_advisory_xact_lock(hashtextextended('nofiscal_onboarding_certificate:' || v_tenant::text, 0));
  delete from nofiscal.fiscal_certificates c where c.tenant_id = v_tenant returning c.vault_secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets s where s.id = v_secret;
  end if;

  delete from nofiscal.fiscal_models where tenant_id = v_tenant;
  delete from nofiscal.fiscal_requests where tenant_id = v_tenant;
  delete from nofiscal.fiscal_phones where tenant_id = v_tenant;
  delete from nofiscal.fiscal_verification_codes where user_id = p_user_id;
  delete from nofiscal.fiscal_certificate_attempts where tenant_id = v_tenant;
  delete from public.memberships where user_id = p_user_id and client_id = v_client;
  delete from nofiscal.fiscal_accounts where user_id = p_user_id;

  update nofiscal.fiscal_tenants
     set active = false, contador_email = null, updated_at = now()
   where id = v_tenant;

  return jsonb_build_object('ok', true, 'tenant_id', v_tenant);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- assinatura-fiscal-ciclo (critério 42): segredo do cron, fila de vencidas e o job.

create function public.fiscal_ciclo_segredo_ok(p_segredo text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_segredo, '') <> ''
     and exists (
       select 1 from vault.decrypted_secrets
        where name = 'FISCAL_CICLO_CRON_SECRET'
          and decrypted_secret = p_segredo);
$$;

create function public.fiscal_cancelamentos_vencidos(p_limite integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id,
           'tenant_id', v.tenant_id,
           'pagarme_subscription_id', v.pagarme_subscription_id,
           'cancelamento_agendado_para', v.cancelamento_agendado_para) order by v.cancelamento_agendado_para), '[]'::jsonb)
    from (
      select s.id, s.tenant_id, s.pagarme_subscription_id, s.cancelamento_agendado_para
        from nofiscal.fiscal_subscriptions s
       where s.cancelamento_agendado_para is not null
         and s.cancelamento_agendado_para <= now()
         and s.status <> 'cancelada'
       order by s.cancelamento_agendado_para
       limit greatest(1, least(coalesce(p_limite, 50), 50))) v;
$$;

-- Sem URL ou sem segredo no Vault, o job não faz nada.
create function public.fiscal_invocar_ciclo()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'fiscal_ciclo_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'FISCAL_CICLO_CRON_SECRET';
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    return null;
  end if;

  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 60000
  );
end;
$$;

-- ---------------------------------------------------------------------------------------
-- EXECUTE: funções novas nascem com EXECUTE para PUBLIC; tira de todos e devolve a quem usa.
revoke all on function nofiscal.fim_do_ciclo_derivado(uuid) from public, anon, authenticated, service_role;
revoke all on function nofiscal.agendar_cancelamento_com_fim(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function nofiscal.agendar_cancelamento(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.fiscal_conta_estado(uuid) from public, anon, authenticated;
revoke all on function public.fiscal_configurar(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fiscal_trocar_plano(uuid, text) from public, anon, authenticated;
revoke all on function public.fiscal_agendar_cancelamento(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.fiscal_apagar_conta(uuid) from public, anon, authenticated;
revoke all on function public.fiscal_ciclo_segredo_ok(text) from public, anon, authenticated;
revoke all on function public.fiscal_cancelamentos_vencidos(integer) from public, anon, authenticated;
revoke all on function public.fiscal_invocar_ciclo() from public, anon, authenticated;

grant execute on function nofiscal.agendar_cancelamento(uuid, text) to nofiscal_service;
grant execute on function public.fiscal_conta_estado(uuid) to service_role;
grant execute on function public.fiscal_configurar(uuid, jsonb) to service_role;
grant execute on function public.fiscal_trocar_plano(uuid, text) to service_role;
grant execute on function public.fiscal_agendar_cancelamento(uuid, timestamptz) to service_role;
grant execute on function public.fiscal_apagar_conta(uuid) to service_role;
grant execute on function public.fiscal_ciclo_segredo_ok(text) to service_role;
grant execute on function public.fiscal_cancelamentos_vencidos(integer) to service_role;
grant execute on function public.fiscal_invocar_ciclo() to service_role;

-- Segredo do x-cron-secret: nasce aqui, nunca sai do banco (molde MARKETING_CRON_SECRET).
-- A URL (`fiscal_ciclo_url`) é gravada à mão por ambiente.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'FISCAL_CICLO_CRON_SECRET') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'FISCAL_CICLO_CRON_SECRET',
      'Header x-cron-secret do job assinatura-fiscal-ciclo'
    );
  end if;
end;
$$;

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'assinatura-fiscal-ciclo',
  '*/15 * * * *',
  $$select public.fiscal_invocar_ciclo()$$
);
