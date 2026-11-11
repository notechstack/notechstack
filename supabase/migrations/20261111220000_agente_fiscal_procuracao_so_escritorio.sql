-- nó.fiscal: procuração só do cliente para o ESCRITÓRIO (Lucca, 11/11/2026, correção de 20261111180000).
-- A nó não assina nem transmite nota de ninguém. A procuração eletrônica existe só no plano Escritório: a empresa
-- cliente (escritorio_tenant_id preenchido) dá procuração ao escritório, e o motor assina e conecta com o A1 do
-- escritório. A conta do próprio escritório e as contas Inicial e Pro emitem só com o A1 próprio.
-- Sai: o procurador da plataforma (fiscal_config.procurador_plataforma_cnpj e a tabela fiscal_config).
-- Entra: a regra no banco, não só no cadastro. A view do certificado de emissão e o emission_block só aceitam
-- procuração cujo procurador é o escritório da empresa.

drop table nofiscal.fiscal_config;

-- Procurador = sempre o escritório da empresa. Fora de escritório: PROCURACAO_SO_NO_ESCRITORIO.
create or replace function nofiscal.procurador_do_tenant(p_tenant_id uuid)
returns table (procurador_tenant_id uuid, documento text, nome text, tipo text, cert_not_after timestamptz, motivo text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_p record;
begin
  select t.id, t.escritorio_tenant_id into v_t from nofiscal.fiscal_tenants t where t.id = p_tenant_id;
  if not found then
    return;
  end if;
  if v_t.escritorio_tenant_id is null then
    return query select null::uuid, null::text, null::text, 'escritorio'::text, null::timestamptz, 'PROCURACAO_SO_NO_ESCRITORIO'::text;
    return;
  end if;

  select m.id, m.cnpj, m.razao_social, m.modo_autenticacao, c.not_after
    into v_p
    from nofiscal.fiscal_tenants m
    left join nofiscal.fiscal_certificates c on c.tenant_id = m.id
   where m.id = v_t.escritorio_tenant_id;
  return query select v_p.id, v_p.cnpj, v_p.razao_social, 'escritorio'::text, v_p.not_after,
    case
      when v_p.not_after is null or v_p.modo_autenticacao <> 'certificado_proprio' then 'ESCRITORIO_SEM_CERTIFICADO'
      when v_p.not_after <= now() then 'PROCURADOR_CERT_VENCIDO'
    end;
end;
$$;

-- Procuração só vale com o escritório da empresa como procurador (mesmas colunas de 20261111180000).
create or replace view nofiscal.fiscal_certificados_de_emissao
with (security_invoker = true) as
  select t.id as tenant_id, 'certificado_proprio'::text as modo, c.vault_secret_id, c.subject, c.not_after,
         null::uuid as procurador_tenant_id
    from nofiscal.fiscal_tenants t
    join nofiscal.fiscal_certificates c on c.tenant_id = t.id
   where t.modo_autenticacao = 'certificado_proprio'
  union all
  select t.id, 'procuracao'::text, c.vault_secret_id, c.subject, c.not_after, p.procurador_tenant_id
    from nofiscal.fiscal_tenants t
    join nofiscal.fiscal_procuracoes p on p.tenant_id = t.id
    join nofiscal.fiscal_certificates c on c.tenant_id = p.procurador_tenant_id
   where t.modo_autenticacao = 'procuracao'
     and t.escritorio_tenant_id is not null
     and p.procurador_tenant_id = t.escritorio_tenant_id
     and p.status in ('declarada', 'confirmada')
     and (p.valida_ate is null or p.valida_ate >= (now() at time zone 'America/Sao_Paulo')::date);

-- Corpo de 20261111180000 + procurador que não é o escritório da empresa: PROCURACAO_INVALIDA.
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
  v_proc record;
begin
  select t.active, t.codigo_servico_nacional, t.p_tot_trib_sn, t.regime, t.escritorio_tenant_id, t.modo_autenticacao
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

  if v_tenant.modo_autenticacao = 'procuracao' then
    select p.status, p.valida_ate, p.procurador_tenant_id, p.ultimo_erro into v_proc
      from nofiscal.fiscal_procuracoes p where p.tenant_id = p_tenant_id;
    if not found then
      return 'PROCURACAO_MISSING';
    end if;
    -- Só o escritório da empresa assina por ela.
    if v_tenant.escritorio_tenant_id is null or v_proc.procurador_tenant_id <> v_tenant.escritorio_tenant_id
       or v_proc.status not in ('declarada', 'confirmada') then
      return 'PROCURACAO_INVALIDA';
    end if;
    -- A última conferência no ADN respondeu E2245: a Sefin recusaria com E0718.
    if v_proc.status = 'declarada' and v_proc.ultimo_erro = 'E2245' then
      return 'PROCURACAO_NAO_ENCONTRADA';
    end if;
    if v_proc.valida_ate is not null and v_proc.valida_ate < (now() at time zone 'America/Sao_Paulo')::date then
      return 'PROCURACAO_VENCIDA';
    end if;
    select c.not_after into v_not_after from nofiscal.fiscal_certificates c where c.tenant_id = v_proc.procurador_tenant_id;
    if not found or v_not_after <= now() then
      return 'PROCURADOR_CERT_INVALIDO';
    end if;
  else
    select c.not_after into v_not_after from nofiscal.fiscal_certificates c where c.tenant_id = p_tenant_id;
    if not found then
      return 'CERT_MISSING';
    end if;
    if v_not_after <= now() then
      return 'CERT_EXPIRED';
    end if;
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
