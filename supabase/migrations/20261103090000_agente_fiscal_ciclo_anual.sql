-- Agente fiscal: ciclo anual da assinatura (Lucca, 03/11/2026). O anual cobra 12 mensalidades com 20% de
-- desconto de uma vez (planos anuais no Pagar.me, interval = year); a franquia de notas continua mensal.
-- 1. nofiscal.fiscal_subscriptions.ciclo ('mensal' | 'anual'), padrão 'mensal' para as linhas existentes.
-- 2. fiscal_registrar_assinatura ganha p_ciclo com padrão 'mensal': a edge function antiga, que não manda o
--    parâmetro, continua funcionando (PostgREST resolve pelos nomes).
-- 3. fim_do_ciclo_derivado anda de 12 em 12 meses no anual (cancelamento agendado e "Minha conta").
-- 4. fiscal_conta_estado devolve o ciclo da assinatura (troca de plano no anual usa o preço anual).
-- Corpos copiados das migrações 20261022090000, 20261024110000 e 20261026090000; só as linhas do ciclo mudam.

alter table nofiscal.fiscal_subscriptions
  add column ciclo text not null default 'mensal' check (ciclo in ('mensal', 'anual'));

-- ------------------------------------------------------------ Registro da assinatura com o ciclo

drop function public.fiscal_registrar_assinatura(uuid, text, boolean, timestamptz, text, text, text, text);

create function public.fiscal_registrar_assinatura(
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
  if p_plano is null or p_plano not in ('inicial', 'pro') then
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
         monthly_note_limit = case p_plano when 'pro' then 100 else 20 end,
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

-- ------------------------------------------------------------ Fim do período pago no anual

create or replace function nofiscal.fim_do_ciclo_derivado(p_subscription_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ancora timestamp;
  v_fim timestamptz;
  v_passo integer := 1;
  v_meses integer;
begin
  select date_trunc('day',
           case when s.com_teste and t.trial_ends_at is not null then t.trial_ends_at else s.created_at end
           at time zone 'UTC'),
         case when s.ciclo = 'anual' then 12 else 1 end
    into v_ancora, v_passo
    from nofiscal.fiscal_subscriptions s
    join nofiscal.fiscal_tenants t on t.id = s.tenant_id
   where s.id = p_subscription_id;
  if v_ancora is null then
    return null;
  end if;

  v_meses := v_passo;
  loop
    -- make_interval a partir da âncora (não somas sucessivas): dia 31 não escorrega para 28.
    v_fim := ((v_ancora + make_interval(months => v_meses)) at time zone 'UTC') - interval '1 second';
    exit when v_fim > now() or v_meses >= 1200;
    v_meses := v_meses + v_passo;
  end loop;
  return v_fim;
end;
$$;

-- ------------------------------------------------------------ Ciclo no estado da conta

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
      'contador_email', v_t.contador_email,
      'resumo', case when v_t.resumo_frequencia is null then null
                     else jsonb_build_object('frequencia', v_t.resumo_frequencia, 'dia', v_t.resumo_dia) end));
end;
$$;

revoke all on function public.fiscal_registrar_assinatura(uuid, text, boolean, timestamptz, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fiscal_registrar_assinatura(uuid, text, boolean, timestamptz, text, text, text, text, text)
  to service_role;
