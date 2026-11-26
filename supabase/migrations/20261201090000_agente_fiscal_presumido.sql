-- nó.fiscal: Lucro Presumido e Lucro Real (Lucca, 19/11/2026; publicar com a virada da NT 009 em 01/12/2026).
-- Fontes oficiais e decisões: side-session-notes/…/presumido-nt009-fontes.md e o method nofiscal-virada-nt009.
--
-- - `fiscal_tenants.regime` passa a aceitar `presumido` e `real` (DPS com opSimpNac 1). As bases públicas de CNPJ só
--   dizem "fora do Simples": quem cadastra declara Presumido ou Real, e o cadastro só aceita município da lista de
--   emissor nacional pleno (supabase/functions/_shared/fiscal/cnpj.ts, MUNICIPIOS_TODOS_OS_REGIMES; regra E0039).
-- - Não optante não informa `pTotTribSN` nem `indTotTrib` (E0713): guarda `pTotTrib` federal, estadual e municipal
--   (Lei 12.741/2012) em três colunas novas. O estadual é 0 para quem só presta serviço.
-- - As funções abaixo são as da produção em 19/11/2026 (pg_get_functiondef, md5 conferido com as migrations), com a
--   troca mínima: aceitar os regimes novos e conferir os percentuais certos de cada regime.
--   `fiscal_cadastro_criar` leva também a lista de planos de 20261123210000 (planos por volume: escritorio_1000 e
--   escritorio_10000), que alterou a função no lugar depois de 19/11; sem isso, esta migração desfaria aquela.
-- - Cidades do Presumido (Lucca, 19/11/2026): `fiscal_municipios_presumido` guarda o que já se sabe de cada cidade
--   (aceita/recusada) e de onde veio (norma, nota autorizada, recusa da Sefin). Cidade sem registro entra "a conferir":
--   a primeira nota de Presumido/Real autorizada lá marca `aceita`; recusa de convênio (E0037/E0038/E0039) marca
--   `recusada`, e o emission_block passa a barrar as empresas Presumido/Real dessa cidade (MUNICIPIO_SEM_PRESUMIDO).
--   Linha de origem `norma` (decreto lido por gente) não é trocada pelo automático.
-- - NF-e (nfe_emission_block) continua só Simples e MEI: CRT 3 não está no motor da NF-e.
-- Reversão: as colunas e os valores novos ficam inertes se o código voltar; para desfazer de fato, restaure as funções
-- da migração anterior de cada uma e volte o check de regime (só depois de desativar empresas presumido/real).

alter table nofiscal.fiscal_tenants drop constraint fiscal_tenants_regime_check;
alter table nofiscal.fiscal_tenants
  add constraint fiscal_tenants_regime_check check (regime in ('simples', 'mei', 'presumido', 'real'));

alter table nofiscal.fiscal_tenants
  add column p_tot_trib_fed numeric(5, 2) check (p_tot_trib_fed between 0 and 100),
  add column p_tot_trib_est numeric(5, 2) check (p_tot_trib_est between 0 and 100),
  add column p_tot_trib_mun numeric(5, 2) check (p_tot_trib_mun between 0 and 100),
  add constraint fiscal_tenants_p_tot_trib_regime_check
    check (regime in ('presumido', 'real') or (p_tot_trib_fed is null and p_tot_trib_est is null and p_tot_trib_mun is null));

comment on column nofiscal.fiscal_tenants.p_tot_trib_fed is
  'Presumido/Real: percentual aproximado dos tributos federais (DPS totTrib/pTotTrib/pTotTribFed, Lei 12.741/2012).';
comment on column nofiscal.fiscal_tenants.p_tot_trib_est is
  'Presumido/Real: percentual aproximado dos tributos estaduais (pTotTribEst); 0 para quem só presta serviço.';
comment on column nofiscal.fiscal_tenants.p_tot_trib_mun is
  'Presumido/Real: percentual aproximado dos tributos municipais (pTotTribMun).';

-- Configuração fiscal que a DPS de cada regime exige (mesma regra no bloqueio da emissão e na situação do painel).
create function nofiscal.dados_fiscais_completos(
  p_regime text, p_codigo text, p_pct_sn numeric, p_pct_fed numeric, p_pct_mun numeric
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_codigo is not null and case
    when p_regime = 'mei' then true
    when p_regime in ('presumido', 'real') then p_pct_fed is not null and p_pct_mun is not null
    else p_pct_sn is not null
  end;
$$;

-- `{fed, est, mun}` do pedido (texto ou número, 0–100 com até 2 casas; `est` ausente = 0). Inválido: null.
create function nofiscal.ler_tributos_aproximados(p jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_fed text;
  v_est text;
  v_mun text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return null;
  end if;
  v_fed := p ->> 'fed';
  v_est := coalesce(nullif(p ->> 'est', ''), '0');
  v_mun := p ->> 'mun';
  if v_fed is null or v_mun is null
     or v_fed !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' or v_est !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' or v_mun !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$'
     or v_fed::numeric > 100 or v_est::numeric > 100 or v_mun::numeric > 100 then
    return null;
  end if;
  return jsonb_build_object('fed', v_fed::numeric, 'est', v_est::numeric, 'mun', v_mun::numeric);
end;
$$;

create table nofiscal.fiscal_municipios_presumido (
  codigo_ibge text primary key check (codigo_ibge ~ '^[0-9]{7}$'),
  situacao text not null check (situacao in ('aceita', 'recusada')),
  origem text not null check (origem in ('norma', 'nota_autorizada', 'recusa_sefin')),
  detalhe text check (length(detalhe) <= 500),
  atualizado_em timestamptz not null default now()
);
alter table nofiscal.fiscal_municipios_presumido enable row level security;
revoke all on nofiscal.fiscal_municipios_presumido from public, anon, authenticated;
grant select on nofiscal.fiscal_municipios_presumido to nofiscal_service;

comment on table nofiscal.fiscal_municipios_presumido is
  'Presumido/Real no Emissor Nacional por cidade: aceita ou recusada, por norma, nota autorizada ou recusa da Sefin (E0039).';

-- Ponto de partida: as normas lidas em 19/11/2026. São Paulo e DF mantêm emissor próprio para quem não é do Simples.
insert into nofiscal.fiscal_municipios_presumido (codigo_ibge, situacao, origem, detalhe) values
  ('3304557', 'aceita', 'norma', 'Rio de Janeiro: só emissor nacional desde 01/01/2026'),
  ('4314902', 'aceita', 'norma', 'Porto Alegre: obrigatório para todos desde 01/11/2025'),
  ('3205309', 'aceita', 'norma', 'Vitória: Decreto 25.903/2025, todos desde 01/01/2026'),
  ('3550308', 'recusada', 'norma', 'São Paulo: emissor próprio; só o Simples migrou (01/11/2026)'),
  ('5300108', 'recusada', 'norma', 'Distrito Federal: ISSnet próprio; só o Simples migrou');

-- Situação conhecida da cidade (null = a conferir). Para as edge functions do cadastro e para a API.
create function public.fiscal_municipio_presumido(p_ibge text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.situacao from nofiscal.fiscal_municipios_presumido m where m.codigo_ibge = p_ibge;
$$;

-- O worker aprende com a Sefin. `aceita` por nota autorizada vale sempre (a cidade passou a aceitar); `recusada` por
-- recusa não troca o que veio de norma. Devolve a situação gravada.
create function nofiscal.registrar_municipio_presumido(p_ibge text, p_situacao text, p_origem text, p_detalhe text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_atual record;
begin
  if p_ibge !~ '^[0-9]{7}$' or p_situacao not in ('aceita', 'recusada') or p_origem not in ('nota_autorizada', 'recusa_sefin') then
    raise exception 'registrar_municipio_presumido: parametro invalido' using errcode = '22023';
  end if;
  select situacao, origem into v_atual from nofiscal.fiscal_municipios_presumido where codigo_ibge = p_ibge for update;
  if found and (v_atual.situacao = p_situacao or (v_atual.origem = 'norma' and p_situacao = 'recusada')) then
    return v_atual.situacao;
  end if;
  insert into nofiscal.fiscal_municipios_presumido (codigo_ibge, situacao, origem, detalhe, atualizado_em)
  values (p_ibge, p_situacao, p_origem, left(p_detalhe, 500), now())
  on conflict (codigo_ibge) do update
    set situacao = excluded.situacao, origem = excluded.origem, detalhe = excluded.detalhe, atualizado_em = now();
  return p_situacao;
end;
$$;

revoke all on function public.fiscal_municipio_presumido(text) from public, anon, authenticated;
grant execute on function public.fiscal_municipio_presumido(text) to service_role, nofiscal_service;
revoke all on function nofiscal.registrar_municipio_presumido(text, text, text, text) from public, anon, authenticated;
grant execute on function nofiscal.registrar_municipio_presumido(text, text, text, text) to nofiscal_service;

revoke all on function nofiscal.dados_fiscais_completos(text, text, numeric, numeric, numeric) from public, anon, authenticated;
revoke all on function nofiscal.ler_tributos_aproximados(jsonb) from public, anon, authenticated;
grant execute on function nofiscal.dados_fiscais_completos(text, text, numeric, numeric, numeric) to nofiscal_service, service_role;
grant execute on function nofiscal.ler_tributos_aproximados(jsonb) to nofiscal_service, service_role;

CREATE OR REPLACE FUNCTION public.fiscal_cadastro_criar(p_user_id uuid, p_cnpj text, p_razao_social text, p_codigo_municipio_ibge text, p_cnae text, p_telefone text, p_plano text, p_responsavel text, p_api_key_hash text, p_ambiente text, p_regime text DEFAULT 'simples'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_email text;
  v_tenant record;
  v_client_id uuid;
  v_tenant_id uuid;
begin
  if p_user_id is null or p_cnpj !~ '^[0-9]{14}$' or p_telefone !~ '^\+[1-9][0-9]{7,14}$'
     or p_plano not in ('inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50', 'escritorio_1000', 'escritorio_10000') or p_codigo_municipio_ibge !~ '^[0-9]{7}$'
     or (p_cnae is not null and p_cnae !~ '^[0-9]{7}$')
     or length(btrim(coalesce(p_razao_social, ''))) not between 1 and 150
     or length(btrim(coalesce(p_responsavel, ''))) not between 2 and 120
     or p_api_key_hash !~ '^[0-9a-f]{64}$' or p_ambiente not in ('producao_restrita', 'producao')
     or p_regime is null or p_regime not in ('simples', 'mei', 'presumido', 'real') then
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
$function$;

CREATE OR REPLACE FUNCTION public.fiscal_empresa_adicionar(p_user_id uuid, p_cnpj text, p_razao_social text, p_codigo_municipio_ibge text, p_cnae text, p_regime text, p_api_key_hash text, p_ambiente text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
     or p_regime is null or p_regime not in ('simples', 'mei', 'presumido', 'real')
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
$function$;

CREATE OR REPLACE FUNCTION nofiscal.emission_block(p_tenant_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_tenant record;
  v_dono record;
  v_not_after timestamptz;
  v_status text;
  v_proc record;
begin
  select t.active, t.codigo_servico_nacional, t.p_tot_trib_sn, t.p_tot_trib_fed, t.p_tot_trib_mun, t.regime, t.codigo_municipio_ibge, t.escritorio_tenant_id, t.modo_autenticacao
    into v_tenant
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id;
  if not found then
    return 'TENANT_NOT_FOUND';
  end if;
  if not v_tenant.active then
    return 'TENANT_INACTIVE';
  end if;

  select t.id, t.active, t.trial_ends_at into v_dono
    from nofiscal.fiscal_tenants t
   where t.id = coalesce(v_tenant.escritorio_tenant_id, p_tenant_id);
  if not v_dono.active then
    return 'TENANT_INACTIVE';
  end if;

  if not nofiscal.dados_fiscais_completos(v_tenant.regime, v_tenant.codigo_servico_nacional, v_tenant.p_tot_trib_sn,
                                          v_tenant.p_tot_trib_fed, v_tenant.p_tot_trib_mun) then
    return 'FISCAL_CONFIG_MISSING';
  end if;

  -- Presumido/Real numa cidade que a Sefin recusou (ou que a norma diz não usar o Emissor Nacional para todos).
  if v_tenant.regime in ('presumido', 'real') and exists (
       select 1 from nofiscal.fiscal_municipios_presumido m
        where m.codigo_ibge = v_tenant.codigo_municipio_ibge and m.situacao = 'recusada') then
    return 'MUNICIPIO_SEM_PRESUMIDO';
  end if;

  if v_tenant.modo_autenticacao = 'procuracao' then
    select p.status, p.valida_ate, p.procurador_tenant_id, p.ultimo_erro into v_proc
      from nofiscal.fiscal_procuracoes p where p.tenant_id = p_tenant_id;
    if not found then
      return 'PROCURACAO_MISSING';
    end if;
    if v_tenant.escritorio_tenant_id is null or v_proc.procurador_tenant_id <> v_tenant.escritorio_tenant_id
       or v_proc.status not in ('declarada', 'confirmada') then
      return 'PROCURACAO_INVALIDA';
    end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.fiscal_configurar(p_user_id uuid, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t record;
  v_codigo text;
  v_pct_txt text;
  v_pct numeric;
  v_tot jsonb;
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
  v_tot := null;
  if v_t.regime = 'mei' then
    v_pct := null;
  elsif v_t.regime in ('presumido', 'real') then
    -- Não optante: sem percentual do Simples; totTrib/pTotTrib federal, estadual (padrão 0) e municipal (E0713).
    v_pct := null;
    v_tot := nofiscal.ler_tributos_aproximados(p_dados -> 'p_tot_trib');
    if v_tot is null then
      return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'p_tot_trib');
    end if;
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
         p_tot_trib_fed = (v_tot ->> 'fed')::numeric,
         p_tot_trib_est = (v_tot ->> 'est')::numeric,
         p_tot_trib_mun = (v_tot ->> 'mun')::numeric,
         nbs_padrao = case when v_mexe_nbs then v_nbs else nbs_padrao end,
         contador_email = case when v_mexe_contador then v_contador else contador_email end,
         resumo_frequencia = case when v_mexe_resumo then v_freq else resumo_frequencia end,
         resumo_dia = case when v_mexe_resumo then v_dia::smallint else resumo_dia end,
         onboarding_etapa = case when onboarding_etapa = 'dados_fiscais' then 'clientes' else onboarding_etapa end,
         updated_at = now()
   where id = v_t.id;

  return jsonb_build_object('ok', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.fiscal_empresa_configurar(p_user_id uuid, p_tenant_id uuid, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t record;
  v_codigo text;
  v_pct_txt text;
  v_pct numeric;
  v_tot jsonb;
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
  v_tot := null;
  if v_t.regime = 'mei' then
    v_pct := null;
  elsif v_t.regime in ('presumido', 'real') then
    -- Não optante: sem percentual do Simples; totTrib/pTotTrib federal, estadual (padrão 0) e municipal (E0713).
    v_pct := null;
    v_tot := nofiscal.ler_tributos_aproximados(p_dados -> 'p_tot_trib');
    if v_tot is null then
      return jsonb_build_object('ok', false, 'erro', 'DADOS_FISCAIS_INVALIDOS', 'campo', 'p_tot_trib');
    end if;
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
         p_tot_trib_fed = (v_tot ->> 'fed')::numeric,
         p_tot_trib_est = (v_tot ->> 'est')::numeric,
         p_tot_trib_mun = (v_tot ->> 'mun')::numeric,
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
$function$;

CREATE OR REPLACE FUNCTION public.fiscal_conta_estado(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_t record;
  v_s record;
  v_c record;
  v_em_teste boolean;
  v_assinatura jsonb := null;
  v_certificado jsonb := null;
begin
  select t.id, t.cnpj, t.razao_social, t.codigo_municipio_ibge, t.cnae, t.regime, t.plan, t.onboarding_etapa,
         t.trial_ends_at, t.codigo_servico_nacional, t.p_tot_trib_sn, t.p_tot_trib_fed, t.p_tot_trib_est, t.p_tot_trib_mun, t.nbs_padrao, t.contador_email,
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
      'p_tot_trib', case when v_t.p_tot_trib_fed is null then null
                         else jsonb_build_object('fed', v_t.p_tot_trib_fed, 'est', v_t.p_tot_trib_est, 'mun', v_t.p_tot_trib_mun) end,
      'nbs_padrao', v_t.nbs_padrao,
      'contador_email', v_t.contador_email,
      'resumo', case when v_t.resumo_frequencia is null then null
                     else jsonb_build_object('frequencia', v_t.resumo_frequencia, 'dia', v_t.resumo_dia) end));
end;
$function$;

CREATE OR REPLACE FUNCTION public.fiscal_escritorio_estado(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        'p_tot_trib', case when t.p_tot_trib_fed is null then null
                           else jsonb_build_object('fed', t.p_tot_trib_fed, 'est', t.p_tot_trib_est, 'mun', t.p_tot_trib_mun) end,
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
          when not nofiscal.dados_fiscais_completos(t.regime, t.codigo_servico_nacional, t.p_tot_trib_sn, t.p_tot_trib_fed, t.p_tot_trib_mun) then 'falta_dados_fiscais'
          when t.regime in ('presumido', 'real') and exists (
                 select 1 from nofiscal.fiscal_municipios_presumido m
                  where m.codigo_ibge = t.codigo_municipio_ibge and m.situacao = 'recusada') then 'municipio_sem_presumido'
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
$function$;

-- Corpo de 20261119120000 (PR #124), aceitando Presumido/Real e limpando os percentuais do regime que saiu.
create or replace function public.fiscal_empresa_atualizar_receita(
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
     or p_regime is null or p_regime not in ('simples', 'mei', 'presumido', 'real') then
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
         p_tot_trib_sn = case when p_regime = 'simples' then p_tot_trib_sn end,
         -- Presumido/Real guardam pTotTrib; quem sai desses regimes perde os três percentuais (check da tabela).
         p_tot_trib_fed = case when p_regime in ('presumido', 'real') then p_tot_trib_fed end,
         p_tot_trib_est = case when p_regime in ('presumido', 'real') then p_tot_trib_est end,
         p_tot_trib_mun = case when p_regime in ('presumido', 'real') then p_tot_trib_mun end,
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
