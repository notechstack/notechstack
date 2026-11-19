-- nó.fiscal: cobrança do módulo Guias como assinatura separada no Pagar.me, "nó.fiscal Guias" (Lucca, 19/11/2026).
-- O painel do Pagar.me não deixa incluir item na assinatura principal do Escritório; por isso a segunda assinatura,
-- no mesmo cliente e cartão, começando na próxima cobrança da principal. Quem liga é a nó (edge function
-- assinatura-fiscal-guias, só service role); o escritório não liga sozinho.
--
-- Entra:
--   fiscal_addons: estado da cobrança no Pagar.me (pagarme_status), próxima cobrança, cupom e ciclos pagos, e a
--     marca cancelar_no_gateway (o ciclo assinatura-fiscal-ciclo cancela no Pagar.me o que ficou marcado).
--   cupom FUNDADORGUIAS (R$ 50 por 12 ciclos, só no produto 'guias'), pelo mesmo mecanismo de fiscal_cupons.
--   public.fiscal_guias_* (contexto, reservar, soltar, registrar, desligar, cancelamento_pedido, pendentes):
--     EXECUTE só service_role.
--   public.fiscal_aplicar_evento_assinatura: o aviso que não é da principal procura a assinatura Guias (pelo id, ou
--     pela metadata produto=guias + tenant enquanto o id ainda não foi gravado); principal cancelada cancela a Guias
--     e desliga o módulo.
--   Bloqueio: cobrança da Guias recusada bloqueia o módulo (nofiscal.guias_bloqueio): não dispara nem lembra, como a
--     principal recusada bloqueia a emissão. Paga de novo, desbloqueia.

alter table nofiscal.fiscal_cupons drop constraint fiscal_cupons_planos_check,
  add constraint fiscal_cupons_planos_check
    check (planos is null or planos <@ array['inicial', 'pro', 'escritorio_5', 'escritorio_20', 'escritorio_50', 'guias']::text[]);

insert into nofiscal.fiscal_cupons (codigo, descricao, tipo, valor, ciclos, planos, max_usos)
values ('FUNDADORGUIAS', 'Fundador Guias: R$ 147/mês no 1º ano', 'valor', 5000, 12, array['guias'], 20)
on conflict (codigo) do nothing;

alter table nofiscal.fiscal_addons
  add column pagarme_status text check (pagarme_status is null or pagarme_status in
    ('criando', 'pendente', 'paga', 'recusada', 'cancelamento_pedido', 'cancelada')),
  add column criando_em timestamptz,
  add column proxima_cobranca timestamptz,
  add column cupom_id uuid references nofiscal.fiscal_cupons(id) on delete restrict,
  add column desconto_valor integer check (desconto_valor is null or desconto_valor >= 1),
  add column desconto_ciclos smallint check (desconto_ciclos is null or desconto_ciclos between 1 and 120),
  add column ciclos_pagos integer not null default 0,
  add column ultimo_evento_gateway_em timestamptz,
  add column cancelar_no_gateway boolean not null default false,
  -- Sobe a cada assinatura nova depois de uma cancelada: entra na Idempotency-Key do POST /subscriptions.
  add column geracao integer not null default 0;
create unique index fiscal_addons_pagarme_sub_idx on nofiscal.fiscal_addons (pagarme_subscription_id)
  where pagarme_subscription_id is not null;

-- Preço do plano "nó.fiscal Guias" (PAGARME_PLANO_FISCAL_GUIAS_ID), em centavos.
create function nofiscal.guias_preco_centavos()
returns integer language sql immutable set search_path = '' as $$ select 19700 $$;

-- Cobrança recusada: o módulo fica bloqueado (sobe e confere, não dispara nem lembra).
create function nofiscal.guias_bloqueio(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when a.pagarme_status = 'recusada' then 'PAGAMENTO_RECUSADO' end
    from nofiscal.fiscal_addons a where a.tenant_id = p_tenant_id and a.produto = 'guias';
$$;

-- O que o painel mostra em Meus dados: valor (com o cupom enquanto durar), próxima cobrança e situação.
create function nofiscal.guias_cobranca(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when a.pagarme_subscription_id is null then null else jsonb_build_object(
    'valor_centavos', nofiscal.guias_preco_centavos(),
    'valor_atual_centavos', case when a.desconto_valor is not null and (a.desconto_ciclos is null or a.ciclos_pagos < a.desconto_ciclos)
                                 then greatest(0, nofiscal.guias_preco_centavos() - a.desconto_valor) else nofiscal.guias_preco_centavos() end,
    'desconto_ciclos_restantes', case when a.desconto_valor is null then 0
                                      else greatest(0, coalesce(a.desconto_ciclos, 999) - a.ciclos_pagos) end,
    'proxima_cobranca', case when a.pagarme_status in ('cancelada', 'cancelamento_pedido') then null else a.proxima_cobranca end,
    'status', a.pagarme_status) end
    from nofiscal.fiscal_addons a where a.tenant_id = p_tenant_id and a.produto = 'guias';
$$;

-- Disparo (corpo de 20261119180000) recusa o módulo bloqueado.
create or replace function nofiscal.guias_disparar(p_user_id uuid, p_guias uuid[], p_quando timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conta uuid;
  v_agendadas integer;
begin
  v_conta := nofiscal.guias_conta_do_usuario(p_user_id);
  if v_conta is null then
    raise exception 'GUIAS_DESLIGADO' using errcode = 'P0001';
  end if;
  if nofiscal.guias_bloqueio(v_conta) is not null then
    raise exception 'GUIAS_BLOQUEADO' using errcode = 'P0001';
  end if;
  if p_guias is null or cardinality(p_guias) = 0 or cardinality(p_guias) > 500 then
    raise exception 'guias_disparar: lista invalida' using errcode = '22023';
  end if;
  update nofiscal.guias g
     set status = 'agendada', agendada_para = greatest(coalesce(p_quando, now()), now()), updated_at = now()
   where g.id = any (p_guias) and g.escritorio_tenant_id = v_conta
     and g.status in ('conferir', 'falhou')
     and nofiscal.guia_cor(g.id) = 'verde';
  get diagnostics v_agendadas = row_count;
  update nofiscal.guia_lotes l set status = 'disparado'
   where l.escritorio_tenant_id = v_conta
     and l.id in (select g.lote_id from nofiscal.guias g where g.id = any (p_guias) and g.escritorio_tenant_id = v_conta)
     and not exists (select 1 from nofiscal.guias g where g.lote_id = l.id and g.status in ('enviando', 'lendo', 'conferir'));
  return jsonb_build_object('agendadas', v_agendadas, 'recusadas', cardinality(p_guias) - v_agendadas);
end;
$$;

-- Desligar pela função da nó (corpo de 20261119180000) também marca a assinatura Guias para cancelar no Pagar.me.
create or replace function public.fiscal_definir_modulo_guias(p_tenant_id uuid, p_ligado boolean, p_limite_mes integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_limite integer;
begin
  if p_tenant_id is null or p_ligado is null or (p_limite_mes is not null and p_limite_mes not between 1 and 100000) then
    raise exception 'fiscal_definir_modulo_guias: parametro invalido' using errcode = '22023';
  end if;
  select t.id, t.plan, t.escritorio_tenant_id, t.razao_social into v_t
    from nofiscal.fiscal_tenants t where t.id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_NAO_ENCONTRADA');
  end if;
  if v_t.escritorio_tenant_id is not null or not nofiscal.plano_de_escritorio(v_t.plan) then
    return jsonb_build_object('ok', false, 'erro', 'NAO_E_CONTA_MAE_DE_ESCRITORIO');
  end if;
  select coalesce(p_limite_mes, a.limite_mes, 500) into v_limite
    from (select 1) x left join nofiscal.fiscal_addons a on a.tenant_id = v_t.id and a.produto = 'guias';
  insert into nofiscal.fiscal_addons (tenant_id, produto, faixa, limite_mes, status)
  values (v_t.id, 'guias',
          case v_limite when 500 then 'guias_500' when 1500 then 'guias_1500' when 4000 then 'guias_4000' else 'sob_medida' end,
          v_limite, case when p_ligado then 'ativo' else 'desligado' end)
  on conflict (tenant_id, produto) do update
    set limite_mes = excluded.limite_mes, faixa = excluded.faixa, status = excluded.status,
        -- Desligar marca a Guias para cancelar no Pagar.me; durante a criação (ainda sem id) também: o registro
        -- encontra a marca, não liga e a assinatura nova é cancelada.
        cancelar_no_gateway = case
          when not p_ligado and (nofiscal.fiscal_addons.pagarme_subscription_id is not null
                                 or nofiscal.fiscal_addons.pagarme_status = 'criando')
               and coalesce(nofiscal.fiscal_addons.pagarme_status, '') not in ('cancelada', 'cancelamento_pedido') then true
          else nofiscal.fiscal_addons.cancelar_no_gateway end,
        updated_at = now();
  insert into nofiscal.guia_regras (escritorio_tenant_id, assinatura)
  values (v_t.id, left(v_t.razao_social, 80))
  on conflict (escritorio_tenant_id) do nothing;
  return jsonb_build_object('ok', true, 'tenant_id', v_t.id, 'ligado', p_ligado, 'limite_mes', v_limite);
end;
$$;

-- ------------------------------------------------------------ Funções da ação "ligar Guias" (service role)

-- Conta-mãe, assinatura principal e o estado da cobrança Guias.
create function public.fiscal_guias_contexto(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_s record;
  v_a record;
begin
  select t.id, t.plan, t.escritorio_tenant_id, t.razao_social into v_t from nofiscal.fiscal_tenants t where t.id = p_tenant_id;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_NAO_ENCONTRADA');
  end if;
  if v_t.escritorio_tenant_id is not null or not nofiscal.plano_de_escritorio(v_t.plan) then
    return jsonb_build_object('ok', false, 'erro', 'NAO_E_CONTA_MAE_DE_ESCRITORIO');
  end if;
  select s.pagarme_subscription_id, s.status, s.origem into v_s
    from nofiscal.fiscal_subscriptions s
   where s.tenant_id = v_t.id
   order by (s.status <> 'cancelada') desc, s.created_at desc limit 1;
  select a.status, a.limite_mes, a.pagarme_subscription_id, a.pagarme_status into v_a
    from nofiscal.fiscal_addons a where a.tenant_id = v_t.id and a.produto = 'guias';
  return jsonb_build_object(
    'ok', true, 'tenant_id', v_t.id, 'razao_social', v_t.razao_social, 'plano', v_t.plan,
    'principal', case when v_s.pagarme_subscription_id is null then null else jsonb_build_object(
      'pagarme_subscription_id', v_s.pagarme_subscription_id, 'status', v_s.status, 'origem', v_s.origem) end,
    'guias', case when v_a.status is null then null else jsonb_build_object(
      'status', v_a.status, 'limite_mes', v_a.limite_mes, 'pagarme_subscription_id', v_a.pagarme_subscription_id,
      'pagarme_status', v_a.pagarme_status) end);
end;
$$;

-- Reserva a criação (duas chamadas ao mesmo tempo: só uma cria). Devolve a assinatura que já existe, se houver.
create function public.fiscal_guias_reservar(p_tenant_id uuid, p_limite_mes integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a record;
begin
  if p_tenant_id is null or p_limite_mes is null or p_limite_mes not between 1 and 100000 then
    raise exception 'fiscal_guias_reservar: parametro invalido' using errcode = '22023';
  end if;
  insert into nofiscal.fiscal_addons (tenant_id, produto, limite_mes, status)
  values (p_tenant_id, 'guias', p_limite_mes, 'desligado')
  on conflict (tenant_id, produto) do nothing;
  select a.* into v_a from nofiscal.fiscal_addons a where a.tenant_id = p_tenant_id and a.produto = 'guias' for update;
  -- Desligada com o cancelamento ainda não aceito pelo Pagar.me: espera o ciclo cancelar a antiga antes de criar outra.
  if v_a.cancelar_no_gateway then
    return jsonb_build_object('ok', false, 'erro', 'CANCELAMENTO_PENDENTE');
  end if;
  if v_a.pagarme_subscription_id is not null and coalesce(v_a.pagarme_status, '') not in ('cancelada', 'cancelamento_pedido') then
    return jsonb_build_object('ok', true, 'reservado', false, 'pagarme_subscription_id', v_a.pagarme_subscription_id,
                              'pagarme_status', v_a.pagarme_status);
  end if;
  if v_a.pagarme_status = 'criando' and v_a.criando_em > now() - interval '10 minutes' then
    return jsonb_build_object('ok', false, 'erro', 'CRIACAO_EM_ANDAMENTO');
  end if;
  update nofiscal.fiscal_addons
     set pagarme_status = 'criando', criando_em = now(), pagarme_subscription_id = null, cancelar_no_gateway = false,
         geracao = geracao + case when v_a.pagarme_status in ('cancelada', 'cancelamento_pedido') then 1 else 0 end,
         cupom_id = null, desconto_valor = null, desconto_ciclos = null, ciclos_pagos = 0, ultimo_evento_gateway_em = null,
         updated_at = now()
   where id = v_a.id;
  return jsonb_build_object('ok', true, 'reservado', true,
                            'geracao', (select a.geracao from nofiscal.fiscal_addons a where a.id = v_a.id));
end;
$$;

-- Recusa depois da reserva (sem cartão, principal cancelada, Pagar.me fora): nada fica ligado.
create function public.fiscal_guias_soltar(p_tenant_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update nofiscal.fiscal_addons set pagarme_status = null, criando_em = null, updated_at = now()
   where tenant_id = p_tenant_id and produto = 'guias' and pagarme_status = 'criando';
$$;

-- A assinatura nasceu no Pagar.me: grava o id, o início e o cupom (uso registrado), e liga o módulo.
create function public.fiscal_guias_registrar(p_tenant_id uuid, p_subscription_id text, p_limite_mes integer,
                                              p_cupom text, p_inicio timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cupom jsonb;
  v_ligar jsonb;
  v_a record;
begin
  if p_tenant_id is null or p_subscription_id is null or btrim(p_subscription_id) = '' then
    raise exception 'fiscal_guias_registrar: parametro invalido' using errcode = '22023';
  end if;
  select a.* into v_a from nofiscal.fiscal_addons a where a.tenant_id = p_tenant_id and a.produto = 'guias' for update;
  -- Desligada (ou principal cancelada) durante a criação: grava o id para o ciclo cancelar e não liga.
  if v_a.cancelar_no_gateway then
    update nofiscal.fiscal_addons
       set pagarme_subscription_id = p_subscription_id, pagarme_status = 'pendente', criando_em = null, updated_at = now()
     where id = v_a.id;
    return jsonb_build_object('ok', false, 'erro', 'DESLIGADO_DURANTE_A_CRIACAO', 'cancelar', p_subscription_id);
  end if;
  update nofiscal.fiscal_addons
     set pagarme_status = case when pagarme_subscription_id is distinct from p_subscription_id
                                    or pagarme_status = 'criando' or pagarme_status is null then 'pendente' else pagarme_status end,
         pagarme_subscription_id = p_subscription_id,
         criando_em = null, proxima_cobranca = p_inicio, cancelar_no_gateway = false, updated_at = now()
   where id = v_a.id;
  if p_cupom is not null and btrim(p_cupom) <> '' then
    v_cupom := nofiscal.cupom_avaliar(p_tenant_id, p_cupom, 'guias');
    if (v_cupom ->> 'ok')::boolean then
      update nofiscal.fiscal_addons
         set cupom_id = (v_cupom ->> 'cupom_id')::uuid, desconto_valor = (v_cupom ->> 'valor')::integer,
             desconto_ciclos = (v_cupom ->> 'ciclos')::smallint
       where tenant_id = p_tenant_id and produto = 'guias';
      insert into nofiscal.fiscal_cupom_usos (cupom_id, tenant_id, subscription_id)
      values ((v_cupom ->> 'cupom_id')::uuid, p_tenant_id, null);
      update nofiscal.fiscal_cupons set usos = usos + 1 where id = (v_cupom ->> 'cupom_id')::uuid;
    end if;
  end if;
  v_ligar := public.fiscal_definir_modulo_guias(p_tenant_id, true, p_limite_mes);
  return jsonb_build_object('ok', (v_ligar ->> 'ok')::boolean, 'modulo', v_ligar, 'cupom', v_cupom - 'cupom_id');
end;
$$;

-- Desliga o módulo e devolve a assinatura a cancelar no Pagar.me (a marca fica até o cancelamento ser pedido).
create function public.fiscal_guias_desligar(p_tenant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v jsonb;
  v_sub text;
begin
  v := public.fiscal_definir_modulo_guias(p_tenant_id, false, null);
  if not (v ->> 'ok')::boolean then
    return v;
  end if;
  select a.pagarme_subscription_id into v_sub from nofiscal.fiscal_addons a
   where a.tenant_id = p_tenant_id and a.produto = 'guias' and a.cancelar_no_gateway;
  return jsonb_build_object('ok', true, 'cancelar', v_sub);
end;
$$;

-- O Pagar.me aceitou o cancelamento (o aviso subscription.canceled confirma depois).
create function public.fiscal_guias_cancelamento_pedido(p_tenant_id uuid, p_subscription_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update nofiscal.fiscal_addons
     set cancelar_no_gateway = false,
         pagarme_status = case when pagarme_status = 'cancelada' then pagarme_status else 'cancelamento_pedido' end,
         updated_at = now()
   where tenant_id = p_tenant_id and produto = 'guias' and pagarme_subscription_id = p_subscription_id;
$$;

-- Fila do ciclo: assinaturas Guias marcadas para cancelar no Pagar.me.
create function public.fiscal_guias_cancelamentos_pendentes(p_limite integer)
returns table (tenant_id uuid, pagarme_subscription_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.tenant_id, a.pagarme_subscription_id from nofiscal.fiscal_addons a
   where a.produto = 'guias' and a.cancelar_no_gateway and a.pagarme_subscription_id is not null
   order by a.updated_at limit greatest(1, least(coalesce(p_limite, 50), 200));
$$;

-- ------------------------------------------------------------ Avisos do Pagar.me

-- Corpo de 20261022090000 com dois acréscimos: (1) aviso que não é de assinatura principal procura a Guias;
-- (2) principal cancelada → Guias marcada para cancelar no Pagar.me e módulo desligado.
create or replace function public.fiscal_aplicar_evento_assinatura(
  p_gateway_event_id text,
  p_tipo text,
  p_subscription_id text,
  p_status text,
  p_payload jsonb,
  p_evento_em timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_novos int;
  v_evento_em timestamptz := coalesce(p_evento_em, now());
  v_atual record;
  v_addon record;
begin
  if p_gateway_event_id is null or p_tipo is null then
    raise exception 'fiscal_aplicar_evento_assinatura: parametro obrigatorio ausente' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('paga', 'recusada', 'cancelada') then
    raise exception 'fiscal_aplicar_evento_assinatura: status invalido' using errcode = '22023';
  end if;
  if p_subscription_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('fiscal_assinatura:' || p_subscription_id, 0));
  end if;

  insert into nofiscal.fiscal_subscription_events
    (gateway_event_id, tipo, pagarme_subscription_id, status_aplicado, payload, evento_em)
  values (p_gateway_event_id, p_tipo, p_subscription_id, p_status, p_payload, p_evento_em)
  on conflict do nothing;
  get diagnostics v_novos = row_count;

  if v_novos = 0 then
    return jsonb_build_object('applied', false, 'duplicado', true);
  end if;
  if p_status is null then
    return jsonb_build_object('applied', false, 'duplicado', false, 'status', null);
  end if;

  select s.id, s.tenant_id, s.status, s.ultimo_evento_gateway_em
    into v_atual
    from nofiscal.fiscal_subscriptions s
   where s.pagarme_subscription_id = p_subscription_id
   for update;

  if not found then
    -- Assinatura Guias: pelo id; enquanto o id não foi gravado (aviso antes do registro), pela metadata.
    select a.* into v_addon from nofiscal.fiscal_addons a
     where a.produto = 'guias' and a.pagarme_subscription_id = p_subscription_id
     for update;
    if not found and p_payload ->> 'produto' = 'guias' and (p_payload ->> 'tenant_id') ~ '^[0-9a-f-]{36}$' then
      -- Só a assinatura da geração atual: aviso atrasado de uma Guias anterior (cancelada) não pega a reserva nova.
      select a.* into v_addon from nofiscal.fiscal_addons a
       where a.produto = 'guias' and a.tenant_id = (p_payload ->> 'tenant_id')::uuid
         and (a.pagarme_subscription_id is null or a.pagarme_status = 'criando')
         and (p_payload ->> 'geracao') ~ '^\d+$' and (p_payload ->> 'geracao')::int = a.geracao
       for update;
      if found then
        update nofiscal.fiscal_addons set pagarme_subscription_id = p_subscription_id where id = v_addon.id;
      end if;
    end if;
    if v_addon.id is null then
      return jsonb_build_object('applied', true, 'duplicado', false, 'status', p_status, 'encontrada', false);
    end if;
    if v_addon.pagarme_status = 'cancelada' then
      return jsonb_build_object('applied', false, 'duplicado', false, 'ignorado', 'cancelada_final', 'produto', 'guias');
    end if;
    if p_status <> 'cancelada' and v_addon.ultimo_evento_gateway_em is not null and v_evento_em < v_addon.ultimo_evento_gateway_em then
      return jsonb_build_object('applied', false, 'duplicado', false, 'ignorado', 'fora_de_ordem', 'produto', 'guias');
    end if;
    update nofiscal.fiscal_addons
       set pagarme_status = p_status,
           status = case when p_status = 'cancelada' then 'desligado' else status end,
           cancelar_no_gateway = case when p_status = 'cancelada' then false else cancelar_no_gateway end,
           ciclos_pagos = ciclos_pagos + case when p_status = 'paga' and p_tipo like 'invoice.%' then 1 else 0 end,
           proxima_cobranca = case when p_status = 'paga' and p_tipo like 'invoice.%' and proxima_cobranca is not null
                                        and proxima_cobranca <= v_evento_em + interval '5 days'
                                   then proxima_cobranca + interval '1 month' else proxima_cobranca end,
           ultimo_evento_gateway_em = greatest(ultimo_evento_gateway_em, v_evento_em),
           updated_at = now()
     where id = v_addon.id;
    return jsonb_build_object('applied', true, 'duplicado', false, 'status', p_status, 'encontrada', true, 'produto', 'guias');
  end if;
  if v_atual.status = 'cancelada' then
    return jsonb_build_object('applied', false, 'duplicado', false, 'ignorado', 'cancelada_final');
  end if;
  if p_status <> 'cancelada'
     and v_atual.ultimo_evento_gateway_em is not null
     and v_evento_em < v_atual.ultimo_evento_gateway_em then
    return jsonb_build_object('applied', false, 'duplicado', false, 'ignorado', 'fora_de_ordem');
  end if;

  update nofiscal.fiscal_subscriptions
     set status = p_status,
         ultimo_evento_tipo = p_tipo,
         ultimo_evento_em = now(),
         ultimo_evento_gateway_em = greatest(ultimo_evento_gateway_em, v_evento_em),
         updated_at = now()
   where id = v_atual.id;

  -- Principal cancelada: a Guias vai junto (o ciclo cancela no Pagar.me) e o módulo desliga.
  if p_status = 'cancelada' then
    update nofiscal.fiscal_addons
       set status = 'desligado',
           cancelar_no_gateway = (pagarme_subscription_id is not null or pagarme_status = 'criando')
                                 and coalesce(pagarme_status, '') not in ('cancelada', 'cancelamento_pedido'),
           updated_at = now()
     where tenant_id = v_atual.tenant_id and produto = 'guias';
  end if;

  return jsonb_build_object('applied', true, 'duplicado', false, 'status', p_status, 'encontrada', true);
end;
$$;

-- Ciclo: a principal cancelada pelo ciclo (cancelamento agendado vencido) leva a Guias junto, já nesta rodada.
create function public.fiscal_guias_cancelar_com_principal(p_tenant_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update nofiscal.fiscal_addons
     set status = 'desligado',
         cancelar_no_gateway = (pagarme_subscription_id is not null or pagarme_status = 'criando')
                               and coalesce(pagarme_status, '') not in ('cancelada', 'cancelamento_pedido'),
         updated_at = now()
   where tenant_id = p_tenant_id and produto = 'guias';
$$;

-- ------------------------------------------------------------ Acesso

revoke all on function nofiscal.guias_preco_centavos(), nofiscal.guias_bloqueio(uuid), nofiscal.guias_cobranca(uuid)
  from public, anon, authenticated, service_role;
grant execute on function nofiscal.guias_preco_centavos(), nofiscal.guias_bloqueio(uuid), nofiscal.guias_cobranca(uuid)
  to nofiscal_service;

revoke all on function public.fiscal_guias_contexto(uuid), public.fiscal_guias_reservar(uuid, integer),
  public.fiscal_guias_soltar(uuid), public.fiscal_guias_registrar(uuid, text, integer, text, timestamptz),
  public.fiscal_guias_desligar(uuid), public.fiscal_guias_cancelamento_pedido(uuid, text),
  public.fiscal_guias_cancelamentos_pendentes(integer), public.fiscal_guias_cancelar_com_principal(uuid)
  from public, anon, authenticated;
grant execute on function public.fiscal_guias_contexto(uuid), public.fiscal_guias_reservar(uuid, integer),
  public.fiscal_guias_soltar(uuid), public.fiscal_guias_registrar(uuid, text, integer, text, timestamptz),
  public.fiscal_guias_desligar(uuid), public.fiscal_guias_cancelamento_pedido(uuid, text),
  public.fiscal_guias_cancelamentos_pendentes(integer), public.fiscal_guias_cancelar_com_principal(uuid)
  to service_role;
