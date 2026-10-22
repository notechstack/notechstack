-- Agente fiscal: cupons de desconto no checkout (pedido de Lucca, 22/10/2026).
-- Um cupom dá desconto percentual (1–100) ou em valor fixo (centavos) na mensalidade. Percentual de 100
-- é cortesia: não passa pelo Pagar.me, não pede cartão e a assinatura nasce paga
-- (pagarme_subscription_id = 'cortesia_<uuid>'). Os demais vão no corpo da assinatura do Pagar.me
-- (discounts: percentage ou flat), pelos ciclos do cupom (nulo = sempre).
-- Cupons são criados por SQL (insert em nofiscal.fiscal_cupons); não há tela de administração.
-- Lições do Vault (cupons dos roteadores e da Prontia): o checkout revalida no servidor o mesmo cálculo
-- da prévia; restrição por plano tem prova própria (na Prontia a coluna errada a deixou morta); cortesia
-- sem limite de usos é proibida pelo próprio banco (o cupom 100% ilimitado da Prontia passou em planos).
-- Edge functions → banco só por public.fiscal_* (security definer, search_path = '', EXECUTE só service_role).

create table nofiscal.fiscal_cupons (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique check (codigo ~ '^[A-Z0-9_-]{3,40}$'),
  descricao text check (descricao is null or char_length(descricao) <= 200),
  tipo text not null check (tipo in ('percentual', 'valor')),
  -- Percentual: 1 a 100. Valor: centavos abatidos da mensalidade.
  valor integer not null check (valor >= 1),
  -- Ciclos de cobrança com desconto (não vale para cortesia); nulo = em todos.
  ciclos smallint check (ciclos is null or ciclos between 1 and 120),
  -- Nulo = vale para qualquer plano.
  planos text[] check (planos is null or planos <@ array['inicial', 'pro']::text[]),
  valido_ate timestamptz,
  max_usos integer check (max_usos is null or max_usos >= 1),
  usos integer not null default 0 check (usos >= 0),
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  constraint fiscal_cupons_percentual_check check (tipo <> 'percentual' or valor <= 100),
  constraint fiscal_cupons_cortesia_limitada_check check (not (tipo = 'percentual' and valor = 100) or max_usos is not null)
);

create table nofiscal.fiscal_cupom_usos (
  cupom_id uuid not null references nofiscal.fiscal_cupons(id) on delete restrict,
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete cascade,
  subscription_id uuid references nofiscal.fiscal_subscriptions(id) on delete set null,
  usado_em timestamptz not null default now(),
  primary key (cupom_id, tenant_id)
);

alter table nofiscal.fiscal_subscriptions
  add column origem text not null default 'pagarme' check (origem in ('pagarme', 'cortesia')),
  add column cupom_id uuid references nofiscal.fiscal_cupons(id) on delete restrict,
  add column desconto_tipo text check (desconto_tipo is null or desconto_tipo in ('percentual', 'valor')),
  add column desconto_valor integer check (desconto_valor is null or desconto_valor >= 1),
  add constraint fiscal_subscriptions_cortesia_id_check
    check ((origem = 'cortesia') = (pagarme_subscription_id like 'cortesia\_%'));

alter table nofiscal.fiscal_cupons enable row level security;
alter table nofiscal.fiscal_cupom_usos enable row level security;
revoke all on nofiscal.fiscal_cupons, nofiscal.fiscal_cupom_usos from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- Avaliação única do cupom (validar, cortesia e uso no Pagar.me). Trava a linha do cupom, para
-- dois checkouts simultâneos não passarem do max_usos.
create function nofiscal.cupom_avaliar(p_tenant_id uuid, p_codigo text, p_plano text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codigo text := upper(btrim(coalesce(p_codigo, '')));
  v record;
begin
  select c.* into v from nofiscal.fiscal_cupons c where c.codigo = v_codigo for update;
  if not found or not v.ativo then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_INVALIDO');
  end if;
  if v.valido_ate is not null and v.valido_ate <= now() then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_VENCIDO');
  end if;
  if v.max_usos is not null and v.usos >= v.max_usos then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_ESGOTADO');
  end if;
  if v.planos is not null and not (p_plano = any (v.planos)) then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_PLANO');
  end if;
  if exists (select 1 from nofiscal.fiscal_cupom_usos u where u.cupom_id = v.id and u.tenant_id = p_tenant_id) then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_JA_USADO');
  end if;
  return jsonb_build_object(
    'ok', true,
    'cupom_id', v.id,
    'codigo', v.codigo,
    'descricao', v.descricao,
    'tipo', v.tipo,
    'valor', v.valor,
    'cortesia', v.tipo = 'percentual' and v.valor = 100,
    'ciclos', case when v.tipo = 'percentual' and v.valor = 100 then null else v.ciclos end);
end;
$$;

-- Etapa de pagamento: "Aplicar cupom". Não consome o cupom.
create function public.fiscal_validar_cupom(p_tenant_id uuid, p_codigo text, p_plano text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select nofiscal.cupom_avaliar(p_tenant_id, p_codigo, p_plano) - 'cupom_id';
$$;

-- Cortesia (percentual de 100): assinatura paga sem Pagar.me, plano e limite no tenant, uso registrado.
create function public.fiscal_registrar_cortesia(p_tenant_id uuid, p_plano text, p_codigo text, p_aceite_texto text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cupom jsonb;
  v_id uuid;
begin
  if p_tenant_id is null or p_plano is null or p_plano not in ('inicial', 'pro') then
    raise exception 'fiscal_registrar_cortesia: parametro invalido' using errcode = '22023';
  end if;
  if p_aceite_texto is null or btrim(p_aceite_texto) = '' then
    raise exception 'fiscal_registrar_cortesia: aceite obrigatorio' using errcode = '22023';
  end if;

  v_cupom := nofiscal.cupom_avaliar(p_tenant_id, p_codigo, p_plano);
  if not (v_cupom ->> 'ok')::boolean then
    return v_cupom;
  end if;
  if not (v_cupom ->> 'cortesia')::boolean then
    return jsonb_build_object('ok', false, 'motivo', 'CUPOM_NAO_CORTESIA');
  end if;
  if exists (select 1 from nofiscal.fiscal_subscriptions s where s.tenant_id = p_tenant_id and s.status <> 'cancelada') then
    return jsonb_build_object('ok', false, 'motivo', 'ASSINATURA_EXISTENTE');
  end if;

  insert into nofiscal.fiscal_subscriptions
    (tenant_id, plano, com_teste, pagarme_subscription_id, status, aceite_em, aceite_texto,
     origem, cupom_id, desconto_tipo, desconto_valor)
  values
    (p_tenant_id, p_plano, false, 'cortesia_' || gen_random_uuid(), 'paga', now(), p_aceite_texto,
     'cortesia', (v_cupom ->> 'cupom_id')::uuid, 'percentual', 100)
  returning id into v_id;

  update nofiscal.fiscal_tenants
     set plan = p_plano,
         monthly_note_limit = case p_plano when 'pro' then 100 else 20 end,
         updated_at = now()
   where id = p_tenant_id;

  insert into nofiscal.fiscal_cupom_usos (cupom_id, tenant_id, subscription_id)
  values ((v_cupom ->> 'cupom_id')::uuid, p_tenant_id, v_id);
  update nofiscal.fiscal_cupons set usos = usos + 1 where id = (v_cupom ->> 'cupom_id')::uuid;

  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'paga');
end;
$$;

-- Cupom com cobrança (percentual abaixo de 100 ou valor fixo), depois de a assinatura com desconto existir no Pagar.me e no banco.
-- O desconto já foi dado no Pagar.me: se o cupom esgotou no meio, só devolve o motivo (para o log).
create function public.fiscal_usar_cupom(p_tenant_id uuid, p_codigo text, p_plano text, p_subscription_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cupom jsonb;
  v_sub uuid;
begin
  v_cupom := nofiscal.cupom_avaliar(p_tenant_id, p_codigo, p_plano);
  if not (v_cupom ->> 'ok')::boolean then
    return v_cupom;
  end if;
  update nofiscal.fiscal_subscriptions
     set cupom_id = (v_cupom ->> 'cupom_id')::uuid,
         desconto_tipo = v_cupom ->> 'tipo',
         desconto_valor = (v_cupom ->> 'valor')::integer,
         updated_at = now()
   where tenant_id = p_tenant_id and pagarme_subscription_id = p_subscription_id
  returning id into v_sub;
  if v_sub is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_ASSINATURA');
  end if;
  insert into nofiscal.fiscal_cupom_usos (cupom_id, tenant_id, subscription_id)
  values ((v_cupom ->> 'cupom_id')::uuid, p_tenant_id, v_sub);
  update nofiscal.fiscal_cupons set usos = usos + 1 where id = (v_cupom ->> 'cupom_id')::uuid;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Cancelamento de cortesia: não há período pago nem Pagar.me, então cancela na hora (site e WhatsApp).
-- Mesmo corpo de 20261024110000_agente_fiscal_v2_conta.sql, com o ramo da cortesia no começo.
create or replace function nofiscal.agendar_cancelamento_com_fim(p_tenant_id uuid, p_origem text, p_fim_ciclo timestamptz)
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

  select s.id, s.status, s.com_teste, s.cancelamento_agendado_para, s.origem, t.trial_ends_at
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

  if v.origem = 'cortesia' then
    update nofiscal.fiscal_subscriptions
       set status = 'cancelada',
           cancelamento_agendado_para = now(),
           cancelamento_pedido_em = now(),
           cancelamento_origem = p_origem,
           updated_at = now()
     where id = v.id
    returning cancelamento_agendado_para into v_quando;
    return jsonb_build_object('status', 'agendado', 'cancelamento_agendado_para', v_quando, 'cancelada_agora', true);
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

revoke all on function nofiscal.cupom_avaliar(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function public.fiscal_validar_cupom(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fiscal_registrar_cortesia(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.fiscal_usar_cupom(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fiscal_validar_cupom(uuid, text, text) to service_role;
grant execute on function public.fiscal_registrar_cortesia(uuid, text, text, text) to service_role;
grant execute on function public.fiscal_usar_cupom(uuid, text, text, text) to service_role;
