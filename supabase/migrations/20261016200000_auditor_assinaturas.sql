-- TASK-mvbcb35pbn0: assinatura do Auditor no Pagar.me (sandbox).
-- Tudo em public, RLS ligada e sem policy: so service_role (edge functions) le e escreve.
-- Reversao: supabase/rollback/20261016200000_auditor_assinaturas.down.sql

create table if not exists public.auditor_assinaturas (
  id uuid primary key default gen_random_uuid(),
  plano text not null check (plano in ('mensal','semanal','agencia')),
  nome text not null,
  email text not null,
  pagarme_customer_id text,
  pagarme_subscription_id text unique,
  status text not null default 'pendente' check (status in ('pendente','paga','recusada','cancelada')),
  relatorio_aceite boolean not null,
  -- preenchido pelo servidor com now() quando aceite = true; null quando false
  relatorio_aceite_em timestamptz,
  relatorio_aceite_texto text, -- texto exato da caixa que a pessoa viu
  ultimo_evento_tipo text,
  ultimo_evento_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auditor_assinaturas_aceite_coerente
    check (relatorio_aceite = (relatorio_aceite_em is not null))
);

create table if not exists public.auditor_assinatura_eventos (
  gateway_event_id text primary key, -- id do webhook (hook_...) = idempotencia
  tipo text not null,
  pagarme_subscription_id text,
  status_aplicado text,
  payload jsonb,                     -- envelope seguro: sem cartao, e-mail, documento ou telefone
  recebido_em timestamptz not null default now()
);
create index if not exists auditor_assinatura_eventos_sub_idx
  on public.auditor_assinatura_eventos (pagarme_subscription_id, recebido_em);

-- Lista de envio do relatorio: so quem aceitou e esta com a assinatura paga.
create or replace view public.auditor_lista_envio_relatorio
with (security_invoker = true) as
select a.id, a.plano, a.nome, a.email, a.pagarme_subscription_id,
       a.relatorio_aceite_em, a.ultimo_evento_em
  from public.auditor_assinaturas a
 where a.relatorio_aceite = true
   and a.status = 'paga';

alter table public.auditor_assinaturas        enable row level security;
alter table public.auditor_assinatura_eventos enable row level security;

revoke all on table public.auditor_assinaturas, public.auditor_assinatura_eventos,
                    public.auditor_lista_envio_relatorio
  from anon, authenticated;
grant select, insert, update, delete on table public.auditor_assinaturas,
                                             public.auditor_assinatura_eventos
  to service_role;
grant select on table public.auditor_lista_envio_relatorio to service_role;

-- Aplica um evento do webhook. Evento repetido (mesmo gateway_event_id) nao mexe em nada.
create or replace function public.aplicar_evento_assinatura_auditor(
  p_gateway_event_id text,
  p_tipo text,
  p_subscription_id text,
  p_status text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_novos int;
  v_atualizadas int;
begin
  if p_gateway_event_id is null or p_tipo is null then
    raise exception 'aplicar_evento_assinatura_auditor: parametro obrigatorio ausente';
  end if;
  if p_status is not null and p_status not in ('paga','recusada','cancelada') then
    raise exception 'aplicar_evento_assinatura_auditor: status invalido';
  end if;
  -- Mesma trava do registrar_assinatura_auditor: evento e registro da mesma assinatura nunca correm juntos,
  -- entao o webhook que chega durante o registro ou acha a linha ou e achado pela reconciliacao.
  if p_subscription_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('auditor_assinatura:' || p_subscription_id, 0));
  end if;

  insert into public.auditor_assinatura_eventos
    (gateway_event_id, tipo, pagarme_subscription_id, status_aplicado, payload)
  values (p_gateway_event_id, p_tipo, p_subscription_id, p_status, p_payload)
  on conflict do nothing;
  get diagnostics v_novos = row_count;

  if v_novos = 0 then
    return jsonb_build_object('applied', false, 'duplicado', true);
  end if;

  if p_status is null then
    return jsonb_build_object('applied', false, 'duplicado', false, 'status', null);
  end if;

  update public.auditor_assinaturas
     set status = p_status,
         ultimo_evento_tipo = p_tipo,
         ultimo_evento_em = now(),
         updated_at = now()
   where pagarme_subscription_id = p_subscription_id;
  get diagnostics v_atualizadas = row_count;

  return jsonb_build_object(
    'applied', true,
    'duplicado', false,
    'status', p_status,
    'encontrada', v_atualizadas > 0);
end;
$$;

revoke all on function public.aplicar_evento_assinatura_auditor(text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.aplicar_evento_assinatura_auditor(text, text, text, text, jsonb)
  to service_role;

-- Registra a assinatura criada pelo checkout (status inicial pendente ou recusada; "paga" so vem do webhook).
-- Reconcilia a corrida: se o webhook chegou antes da linha existir, aplica o evento mais recente com status.
create or replace function public.registrar_assinatura_auditor(
  p_plano text,
  p_nome text,
  p_email text,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_relatorio_aceite boolean,
  p_relatorio_aceite_texto text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_status text;
  v_evento record;
  v_reconciliada boolean := false;
begin
  if p_subscription_id is null then
    raise exception 'registrar_assinatura_auditor: subscription_id obrigatorio';
  end if;
  if p_status is null or p_status not in ('pendente','recusada') then
    raise exception 'registrar_assinatura_auditor: status invalido';
  end if;
  -- Trava por assinatura (a mesma do aplicar_evento_assinatura_auditor): sem ela, um webhook que grava o evento
  -- entre o insert e a leitura abaixo nao acha a linha, e a leitura nao ve o evento ainda nao confirmado.
  perform pg_advisory_xact_lock(hashtextextended('auditor_assinatura:' || p_subscription_id, 0));

  insert into public.auditor_assinaturas
    (plano, nome, email, pagarme_customer_id, pagarme_subscription_id, status,
     relatorio_aceite, relatorio_aceite_em, relatorio_aceite_texto)
  values
    (p_plano, p_nome, p_email, p_customer_id, p_subscription_id, p_status,
     p_relatorio_aceite,
     case when p_relatorio_aceite then now() end,
     case when p_relatorio_aceite then p_relatorio_aceite_texto end)
  returning id, status into v_id, v_status;

  select e.tipo, e.status_aplicado, e.recebido_em
    into v_evento
    from public.auditor_assinatura_eventos e
   where e.pagarme_subscription_id = p_subscription_id
     and e.status_aplicado is not null
   order by e.recebido_em desc
   limit 1;

  if found then
    update public.auditor_assinaturas
       set status = v_evento.status_aplicado,
           ultimo_evento_tipo = v_evento.tipo,
           ultimo_evento_em = v_evento.recebido_em,
           updated_at = now()
     where id = v_id
    returning status into v_status;
    v_reconciliada := true;
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status, 'reconciliada', v_reconciliada);
end;
$$;

revoke all on function public.registrar_assinatura_auditor(text, text, text, text, text, text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.registrar_assinatura_auditor(text, text, text, text, text, text, boolean, text)
  to service_role;
