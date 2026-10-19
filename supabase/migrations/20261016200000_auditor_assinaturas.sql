-- TASK-mvbcb35pbn0: assinatura do Auditor no Pagar.me (sandbox).
-- Tudo em public, RLS ligada e sem policy: so service_role (edge functions) le e escreve.
-- Aceite (Lucca, 16/10): receber o relatorio no WhatsApp faz parte do aceite obrigatorio dos Termos,
-- antes do pagamento. Todo assinante tem aceite (sempre true), data, texto do aceite e um WhatsApp.
-- Ordem dos avisos (achado F-01 do Oscar): cada evento guarda o created_at do Pagar.me (evento_em) e a
-- assinatura guarda o do ultimo evento aplicado (ultimo_evento_gateway_em). Aviso mais antigo nao muda
-- status; 'cancelada' e final.
-- Reversao: supabase/rollback/20261016200000_auditor_assinaturas.down.sql

create table if not exists public.auditor_assinaturas (
  id uuid primary key default gen_random_uuid(),
  plano text not null check (plano in ('mensal','semanal','agencia')),
  nome text not null,
  email text not null,
  -- DDD + numero, so digitos (10 ou 11)
  whatsapp text not null
    constraint auditor_assinaturas_whatsapp_formato check (whatsapp ~ '^[0-9]{10,11}$'),
  pagarme_customer_id text,
  pagarme_subscription_id text unique,
  status text not null default 'pendente' check (status in ('pendente','paga','recusada','cancelada')),
  -- aceite obrigatorio dos Termos (inclui receber o relatorio no WhatsApp): nunca false
  relatorio_aceite boolean not null default true
    constraint auditor_assinaturas_aceite_obrigatorio check (relatorio_aceite),
  relatorio_aceite_em timestamptz not null, -- preenchido pelo servidor com now()
  relatorio_aceite_texto text not null      -- texto exato da caixa que a pessoa viu
    constraint auditor_assinaturas_aceite_texto_tamanho
      check (char_length(relatorio_aceite_texto) between 1 and 500),
  ultimo_evento_tipo text,
  ultimo_evento_em timestamptz,         -- quando aplicamos o ultimo evento (nosso relogio)
  ultimo_evento_gateway_em timestamptz, -- created_at (Pagar.me) do ultimo evento aplicado: ordem dos avisos
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.auditor_assinatura_eventos (
  gateway_event_id text primary key, -- id do webhook (hook_...) = idempotencia
  tipo text not null,
  pagarme_subscription_id text,
  status_aplicado text,              -- status que o tipo traduz (gravado mesmo quando o aviso foi ignorado)
  payload jsonb,                     -- envelope seguro: sem cartao, e-mail, documento ou telefone
  evento_em timestamptz,             -- created_at do aviso no Pagar.me; nulo se o payload nao trouxe
  recebido_em timestamptz not null default now()
);
create index if not exists auditor_assinatura_eventos_sub_idx
  on public.auditor_assinatura_eventos (pagarme_subscription_id, recebido_em);

-- Lista de envio do relatorio (base): quem aceitou e esta com a assinatura paga.
-- A 20261016200100 redefine com a politica de acesso; as colunas sao as mesmas, na mesma ordem.
create or replace view public.auditor_lista_envio_relatorio
with (security_invoker = true) as
select a.id, a.plano, a.nome, a.email, a.whatsapp, a.pagarme_subscription_id,
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

-- Assinaturas antigas destas funcoes (rascunhos desta TASK), caso algum banco local tenha rodado.
drop function if exists public.aplicar_evento_assinatura_auditor(text, text, text, text, jsonb);
drop function if exists public.registrar_assinatura_auditor(text, text, text, text, text, text, boolean, text);

-- Aplica um evento do webhook. Evento repetido (mesmo gateway_event_id) nao mexe em nada.
-- Ordem: p_evento_em e o created_at do aviso no Pagar.me (nulo -> now()).
--   assinatura cancelada nunca muda de status            -> {"applied":false,"duplicado":false,"ignorado":"cancelada_final"}
--   aviso mais antigo que ultimo_evento_gateway_em       -> {"applied":false,"duplicado":false,"ignorado":"fora_de_ordem"}
--   (o cancelamento vale mesmo atrasado: na ordem real ele veio antes e nada depois dele conta)
-- O evento fica gravado em todos os casos, menos no duplicado.
create or replace function public.aplicar_evento_assinatura_auditor(
  p_gateway_event_id text,
  p_tipo text,
  p_subscription_id text,
  p_status text,
  p_payload jsonb,
  p_evento_em timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_novos int;
  v_evento_em timestamptz := coalesce(p_evento_em, now());
  v_atual record;
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

  select a.id, a.status, a.ultimo_evento_gateway_em
    into v_atual
    from public.auditor_assinaturas a
   where a.pagarme_subscription_id = p_subscription_id
   for update;

  if not found then
    -- Linha ainda nao existe: o registrar_assinatura_auditor reconcilia depois.
    return jsonb_build_object('applied', true, 'duplicado', false, 'status', p_status, 'encontrada', false);
  end if;

  if v_atual.status = 'cancelada' then
    return jsonb_build_object('applied', false, 'duplicado', false, 'ignorado', 'cancelada_final');
  end if;

  if p_status <> 'cancelada'
     and v_atual.ultimo_evento_gateway_em is not null
     and v_evento_em < v_atual.ultimo_evento_gateway_em then
    return jsonb_build_object('applied', false, 'duplicado', false, 'ignorado', 'fora_de_ordem');
  end if;

  update public.auditor_assinaturas
     set status = p_status,
         ultimo_evento_tipo = p_tipo,
         ultimo_evento_em = now(),
         ultimo_evento_gateway_em = greatest(ultimo_evento_gateway_em, v_evento_em),
         updated_at = now()
   where id = v_atual.id;

  return jsonb_build_object('applied', true, 'duplicado', false, 'status', p_status, 'encontrada', true);
end;
$$;

revoke all on function public.aplicar_evento_assinatura_auditor(text, text, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.aplicar_evento_assinatura_auditor(text, text, text, text, jsonb, timestamptz)
  to service_role;

-- Registra a assinatura criada pelo checkout (status inicial pendente ou recusada; "paga" so vem do webhook).
-- Aceite obrigatorio: grava relatorio_aceite = true, data = now() e o texto exato; sem texto, erro.
-- Reconcilia a corrida: se o webhook chegou antes da linha existir, aplica o evento com status de created_at
-- (evento_em; sem ele, recebido_em) mais recente. Cancelamento e final: se houver um, ele vence.
create or replace function public.registrar_assinatura_auditor(
  p_plano text,
  p_nome text,
  p_email text,
  p_whatsapp text,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_aceite_texto text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_status text;
  v_evento record;
  v_gateway_em timestamptz;
  v_reconciliada boolean := false;
begin
  if p_subscription_id is null then
    raise exception 'registrar_assinatura_auditor: subscription_id obrigatorio';
  end if;
  if p_status is null or p_status not in ('pendente','recusada') then
    raise exception 'registrar_assinatura_auditor: status invalido';
  end if;
  if p_aceite_texto is null or btrim(p_aceite_texto) = '' then
    raise exception 'registrar_assinatura_auditor: aceite obrigatorio (texto do aceite ausente)';
  end if;
  -- Trava por assinatura (a mesma do aplicar_evento_assinatura_auditor): sem ela, um webhook que grava o evento
  -- entre o insert e a leitura abaixo nao acha a linha, e a leitura nao ve o evento ainda nao confirmado.
  perform pg_advisory_xact_lock(hashtextextended('auditor_assinatura:' || p_subscription_id, 0));

  insert into public.auditor_assinaturas
    (plano, nome, email, whatsapp, pagarme_customer_id, pagarme_subscription_id, status,
     relatorio_aceite, relatorio_aceite_em, relatorio_aceite_texto)
  values
    (p_plano, p_nome, p_email, p_whatsapp, p_customer_id, p_subscription_id, p_status,
     true, now(), p_aceite_texto)
  returning id, status into v_id, v_status;

  select e.tipo, e.status_aplicado, e.recebido_em
    into v_evento
    from public.auditor_assinatura_eventos e
   where e.pagarme_subscription_id = p_subscription_id
     and e.status_aplicado is not null
   order by (e.status_aplicado = 'cancelada') desc,
            coalesce(e.evento_em, e.recebido_em) desc,
            e.recebido_em desc
   limit 1;

  if found then
    select max(coalesce(e.evento_em, e.recebido_em))
      into v_gateway_em
      from public.auditor_assinatura_eventos e
     where e.pagarme_subscription_id = p_subscription_id
       and e.status_aplicado is not null;

    update public.auditor_assinaturas
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

revoke all on function public.registrar_assinatura_auditor(text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.registrar_assinatura_auditor(text, text, text, text, text, text, text, text)
  to service_role;
