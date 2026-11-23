-- Planos por volume e módulos (Lucca, 23/11/2026).
--
-- O Escritório passa a vender documentos por mês, sem limite de empresas, e o cliente escolhe o que emite:
--   - faixas: escritorio_5 (500 documentos), escritorio_1000, escritorio_20 (2.000), escritorio_50 (5.000) e
--     escritorio_10000. Os três códigos antigos continuam os mesmos, para não mexer nas assinaturas, nos cupons e nos
--     planos do Pagar.me que já existem; só as duas faixas novas ganham código pelo volume;
--   - empresas ilimitadas em todas as faixas (nofiscal.max_empresas_do_plano devolve 100000; o pacote por conta,
--     max_empresas_override, continua valendo quando existe);
--   - tipos de nota por conta-mãe (fiscal_tenants.tipos_nota): NFS-e e/ou NF-e. O primeiro tipo vem no preço do plano;
--     o segundo é cobrado no próprio plano do Pagar.me (assinatura-fiscal/core.ts). A NF-e pelo painel só abre com
--     'nfe' na lista (app/api/_lib/nfe/painel-nfe.ts);
--   - cupons de fundador das duas faixas novas (20% OFF) e o desconto de quem leva NF-e e Guias juntos.
--
-- As funções que conferem o plano por lista são corrigidas no lugar (pg_get_functiondef + replace), em vez de serem
-- reescritas aqui: a definição em vigor é a da última migração que tocou cada uma, e copiar o corpo inteiro arriscaria
-- desfazer uma correção posterior. Cada troca confere que a lista antiga estava lá; se não estava, a migração para.

-- 1. Travas de plano -------------------------------------------------------------------------------------------------
alter table nofiscal.fiscal_tenants drop constraint fiscal_tenants_plan_check,
  add constraint fiscal_tenants_plan_check
    check (plan in ('inicial', 'pro', 'custom', 'escritorio_5', 'escritorio_20', 'escritorio_50', 'escritorio_1000', 'escritorio_10000'));

alter table nofiscal.fiscal_subscriptions drop constraint fiscal_subscriptions_plano_check,
  add constraint fiscal_subscriptions_plano_check
    check (plano in ('inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50', 'escritorio_1000', 'escritorio_10000'));

alter table nofiscal.fiscal_cupons drop constraint fiscal_cupons_planos_check,
  add constraint fiscal_cupons_planos_check
    check (planos is null or planos <@ array['inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50',
                                             'escritorio_1000', 'escritorio_10000', 'guias']::text[]);

-- 2. Funções com a lista de planos -----------------------------------------------------------------------------------
do $$
declare
  r record;
  v_nova text;
  v_trocas integer := 0;
begin
  -- Listas "(..., 'escritorio_50')": plano_completo, plano_de_escritorio e as quatro funções public.fiscal_*.
  for r in
    select p.oid, n.nspname || '.' || p.proname as nome, pg_get_functiondef(p.oid) as def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'nofiscal' and p.proname in ('plano_completo', 'plano_de_escritorio'))
        or (n.nspname = 'public' and p.proname in ('fiscal_cadastro_criar', 'fiscal_registrar_assinatura',
                                                   'fiscal_registrar_cortesia', 'fiscal_trocar_plano'))
  loop
    v_nova := replace(r.def, $a$'escritorio_50')$a$, $a$'escritorio_50', 'escritorio_1000', 'escritorio_10000')$a$);
    if v_nova = r.def then
      raise exception 'planos_volume: não achei a lista de planos em %', r.nome;
    end if;
    execute v_nova;
    v_trocas := v_trocas + 1;
  end loop;
  if v_trocas <> 6 then
    raise exception 'planos_volume: esperava corrigir 6 funções, corrigi %', v_trocas;
  end if;

  -- Franquia de documentos por mês: as duas faixas novas.
  select pg_get_functiondef(p.oid) into v_nova
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'nofiscal' and p.proname = 'limite_do_plano';
  if position($a$when 'escritorio_50' then 5000$a$ in v_nova) = 0 then
    raise exception 'planos_volume: não achei a faixa de 5.000 em nofiscal.limite_do_plano';
  end if;
  execute replace(v_nova, $a$when 'escritorio_50' then 5000$a$,
    $a$when 'escritorio_50' then 5000 when 'escritorio_1000' then 1000 when 'escritorio_10000' then 10000$a$);

  -- Empresas: sem limite em todas as faixas do Escritório.
  select pg_get_functiondef(p.oid) into v_nova
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'nofiscal' and p.proname = 'max_empresas_do_plano';
  if position($a$when 'escritorio_5' then 5$a$ in v_nova) = 0 or position($a$when 'escritorio_20' then 20$a$ in v_nova) = 0
     or position($a$when 'escritorio_50' then 50$a$ in v_nova) = 0 then
    raise exception 'planos_volume: não achei as três faixas em nofiscal.max_empresas_do_plano';
  end if;
  v_nova := replace(v_nova, $a$when 'escritorio_50' then 50$a$,
    $a$when 'escritorio_50' then 100000 when 'escritorio_1000' then 100000 when 'escritorio_10000' then 100000$a$);
  v_nova := replace(v_nova, $a$when 'escritorio_20' then 20$a$, $a$when 'escritorio_20' then 100000$a$);
  v_nova := replace(v_nova, $a$when 'escritorio_5' then 5$a$, $a$when 'escritorio_5' then 100000$a$);
  execute v_nova;
end $$;

-- 3. Tipos de nota por conta ----------------------------------------------------------------------------------------
alter table nofiscal.fiscal_tenants
  add column tipos_nota text[] not null default array['nfse']::text[]
    constraint fiscal_tenants_tipos_nota_check
      check (cardinality(tipos_nota) between 1 and 2 and tipos_nota <@ array['nfse', 'nfe']::text[]);

comment on column nofiscal.fiscal_tenants.tipos_nota is
  'O que a conta emite: nfse e/ou nfe. Vale a da conta-mãe; nas empresas clientes do escritório o campo não é lido.';

-- Quem já era Escritório antes do modelo novo continua com a NF-e (liberada aos fundadores em 17/11/2026).
update nofiscal.fiscal_tenants
   set tipos_nota = array['nfse', 'nfe']::text[]
 where escritorio_tenant_id is null and nofiscal.plano_de_escritorio(plan);

-- Leitura para o app (o painel de NF-e decide por aqui).
create function nofiscal.tipos_nota_da_conta(p_tenant_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select t.tipos_nota from nofiscal.fiscal_tenants t where t.id = p_tenant_id;
$$;

revoke all on function nofiscal.tipos_nota_da_conta(uuid) from public;
grant execute on function nofiscal.tipos_nota_da_conta(uuid) to nofiscal_service;

-- Gravação: só a service role (assinatura-fiscal, depois de registrar a assinatura) e a equipe da nó.
--   select public.fiscal_definir_tipos_nota('<uuid da conta-mãe>', array['nfse','nfe']);
create function public.fiscal_definir_tipos_nota(p_tenant_id uuid, p_tipos text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_tipos text[];
begin
  if p_tenant_id is null or p_tipos is null or cardinality(p_tipos) not between 1 and 2
     or not (p_tipos <@ array['nfse', 'nfe']::text[]) then
    raise exception 'fiscal_definir_tipos_nota: parametro invalido' using errcode = '22023';
  end if;
  -- Sem repetição e em ordem fixa (nfse antes de nfe).
  select array_agg(x order by x desc) into v_tipos from (select distinct unnest(p_tipos) as x) s;
  select t.id, t.plan, t.escritorio_tenant_id into v_t
    from nofiscal.fiscal_tenants t where t.id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_NAO_ENCONTRADA');
  end if;
  if v_t.escritorio_tenant_id is not null then
    return jsonb_build_object('ok', false, 'erro', 'NAO_E_CONTA_MAE');
  end if;
  -- A NF-e é do Escritório: Inicial e Pro só emitem NFS-e.
  if not nofiscal.plano_de_escritorio(v_t.plan) and v_tipos <> array['nfse']::text[] then
    return jsonb_build_object('ok', false, 'erro', 'SO_ESCRITORIO');
  end if;
  update nofiscal.fiscal_tenants set tipos_nota = v_tipos, updated_at = now() where id = p_tenant_id;
  return jsonb_build_object('ok', true, 'tipos_nota', to_jsonb(v_tipos));
end;
$$;

revoke all on function public.fiscal_definir_tipos_nota(uuid, text[]) from public, anon, authenticated;
grant execute on function public.fiscal_definir_tipos_nota(uuid, text[]) to service_role;

-- 4. Cupons ---------------------------------------------------------------------------------------------------------
-- Fundador das faixas novas, no molde de FUNDADOR5/20/50 (scripts/pagarme-assinatura/cupons-fundador-escritorio.sql):
-- 1º mês grátis e 20% OFF nas 12 primeiras cobranças (R$ 397 e R$ 1.997 por mês), 20 vagas por faixa.
-- MODULOSJUNTOS: quem assina com NF-e e Guias paga R$ 297 pelos dois, em vez de R$ 394. O desconto de R$ 97 entra na
-- assinatura do Guias, sem prazo. Só o checkout o aplica (assinatura-fiscal chama assinatura-fiscal-guias).
insert into nofiscal.fiscal_cupons (codigo, descricao, tipo, valor, ciclos, planos, dias_de_teste, max_usos)
values
  ('FUNDADOR1000', 'Fundador: 1º mês grátis e R$ 397/mês no 1º ano', 'valor', 10000, 12, array['escritorio_1000'], 30, 20),
  ('FUNDADOR10000', 'Fundador: 1º mês grátis e R$ 1.997/mês no 1º ano', 'valor', 50000, 12, array['escritorio_10000'], 30, 20),
  ('MODULOSJUNTOS', 'NF-e e Guias juntos: R$ 100/mês no Guias', 'valor', 9700, null, array['guias'], null, null)
on conflict (codigo) do nothing;
