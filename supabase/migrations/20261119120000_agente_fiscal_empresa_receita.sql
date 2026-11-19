-- nó.fiscal: atualizar os dados da Receita de uma empresa já cadastrada (caso de 19/11/2026: empresa
-- cliente de escritório mudou de razão social e o painel não deixava corrigir; recadastrar dava
-- CNPJ_JA_CADASTRADO). A edge function `fiscal-conta` (ação `empresa_atualizar_receita`) reconsulta o CNPJ
-- pela mesma consulta do cadastro e grava aqui só razão social, município, CNAE e regime. O CNPJ não muda.
-- Edge functions → banco só por public.fiscal_* (security definer, search_path = '', EXECUTE só service_role).

create function public.fiscal_empresa_atualizar_receita(
  p_user_id uuid,
  p_tenant_id uuid,
  p_cnpj text,
  p_razao_social text,
  p_codigo_municipio_ibge text,
  p_cnae text,
  p_regime text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_razao text := btrim(coalesce(p_razao_social, ''));
begin
  if p_tenant_id is null or p_cnpj is null or p_cnpj !~ '^[0-9]{14}$'
     or p_codigo_municipio_ibge is null or p_codigo_municipio_ibge !~ '^[0-9]{7}$'
     or (p_cnae is not null and p_cnae !~ '^[0-9]{7}$')
     or length(v_razao) not between 1 and 150
     or p_regime is null or p_regime not in ('simples', 'mei') then
    raise exception 'fiscal_empresa_atualizar_receita: parametro invalido' using errcode = '22023';
  end if;
  if not nofiscal.usuario_pode_tenant(p_user_id, p_tenant_id) then
    return jsonb_build_object('ok', false, 'erro', 'FORBIDDEN');
  end if;

  select t.id, t.cnpj, t.razao_social, t.codigo_municipio_ibge, t.cnae, t.regime into v_t
    from nofiscal.fiscal_tenants t where t.id = p_tenant_id for update;
  -- A consulta foi feita com o CNPJ desta empresa; outro CNPJ é corpo adulterado.
  if v_t.cnpj is distinct from p_cnpj then
    return jsonb_build_object('ok', false, 'erro', 'FORBIDDEN');
  end if;

  update nofiscal.fiscal_tenants
     set razao_social = v_razao,
         codigo_municipio_ibge = p_codigo_municipio_ibge,
         cnae = p_cnae,
         regime = p_regime,
         -- MEI não informa o percentual do Simples (E0710); quem vira Simples precisa preencher (falta_dados_fiscais).
         p_tot_trib_sn = case when p_regime = 'mei' then null else p_tot_trib_sn end,
         updated_at = now()
   where id = p_tenant_id;

  return jsonb_build_object(
    'ok', true,
    'antes', jsonb_build_object(
      'razao_social', v_t.razao_social,
      'codigo_municipio_ibge', v_t.codigo_municipio_ibge,
      'cnae', v_t.cnae,
      'regime', v_t.regime));
end;
$$;

revoke all on function public.fiscal_empresa_atualizar_receita(uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fiscal_empresa_atualizar_receita(uuid, uuid, text, text, text, text, text)
  to service_role;
