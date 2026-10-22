-- Agente fiscal v2: o A1 gravado leva o onboarding de `certificado` para `dados_fiscais` (diagrama de estados da
-- tarefa agente-fiscal-v2, critério 15; achado do C54 na integração, Landing do lote E). Corpo da v1
-- (20261022090000_agente_fiscal.sql) inalterado; só o `OK` ganha o avanço da etapa, que nunca volta: renovar o A1
-- com o onboarding mais adiante não muda nada. `create or replace` mantém os grants da v1.

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
     and t.client_id is not null
     and exists (
       select 1 from public.memberships m
        where m.client_id = t.client_id and m.user_id = p_user_id);
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
