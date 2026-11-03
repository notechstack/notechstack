-- Medição da cobrança do nó.fiscal (03/11/2026): a cobrança paga depois do teste grátis, e cada renovação, vira
-- Purchase na Meta CAPI (e purchase no GA4, quando houver secret) pelo webhook assinatura-fiscal-webhook.
--
-- 1. O consentimento de medição do checkout passa a ficar na assinatura. Até aqui ele só valia na hora do checkout
--    (medicao.consent do corpo, assinatura-fiscal/medicao.ts) e se perdia. Sem 'granted' gravado aqui, o webhook
--    não manda nada: assinaturas anteriores a esta migração ficam com null e nunca geram Purchase pelo servidor.
--    fbp/fbc só são gravados com 'granted' (a função abaixo zera os dois quando não é).
-- 2. nofiscal.fiscal_purchase_events: uma linha por cobrança paga (chave = id da fatura, ou da cobrança sem fatura).
--    O Pagar.me manda invoice.paid e charge.paid para o mesmo pagamento, e reentrega avisos; a chave primária faz
--    a cobrança ser medida uma vez só, qualquer que seja a ordem ou a repetição dos avisos.
-- 3. A primeira cobrança de uma assinatura SEM teste já foi medida no checkout (Purchase com event_id
--    nofiscal-purchase-<id da assinatura>, no navegador e na CAPI). O webhook registra como 'contada_no_checkout'
--    toda cobrança paga de assinatura sem teste nos primeiros 15 dias dela (a cobrança do primeiro ciclo e as
--    retentativas dela; a renovação mais próxima vem com ~30 dias) e não manda de novo. Janela por data, e não
--    "primeira linha", porque o aviso dessa cobrança costuma chegar antes de o checkout gravar a assinatura e o
--    consentimento: nesse caso ele nem é reivindicado, e a primeira renovação seria tomada pela do checkout.
-- Nada aqui é aplicado automaticamente: aplicar pela CLI, como as demais migrações do fiscal.

alter table nofiscal.fiscal_subscriptions
  add column medicao_consent text check (medicao_consent in ('granted', 'denied')),
  add column medicao_fbp text check (medicao_fbp is null or char_length(medicao_fbp) <= 120),
  add column medicao_fbc text check (medicao_fbc is null or char_length(medicao_fbc) <= 600),
  add column medicao_em timestamptz;

create table nofiscal.fiscal_purchase_events (
  chave text primary key check (char_length(chave) between 1 and 120),
  subscription_id uuid not null references nofiscal.fiscal_subscriptions(id) on delete cascade,
  pagarme_subscription_id text not null,
  tipo text not null,
  -- 1 = primeira cobrança paga que o webhook viu nesta assinatura.
  ordem integer not null check (ordem >= 1),
  decisao text not null check (decisao in ('enviar', 'contada_no_checkout')),
  resultado_meta text check (resultado_meta is null or char_length(resultado_meta) <= 60),
  resultado_ga4 text check (resultado_ga4 is null or char_length(resultado_ga4) <= 60),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz
);
create index fiscal_purchase_events_sub_idx on nofiscal.fiscal_purchase_events (subscription_id, criado_em);
alter table nofiscal.fiscal_purchase_events enable row level security;
revoke all on nofiscal.fiscal_purchase_events from public, anon, authenticated, service_role;

-- ------------------------------------------------------------ Consentimento gravado no checkout

create function public.fiscal_registrar_medicao(
  p_subscription_id uuid,
  p_consent text,
  p_fbp text,
  p_fbc text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_granted boolean := p_consent = 'granted';
begin
  if p_subscription_id is null or p_consent is null or p_consent not in ('granted', 'denied') then
    raise exception 'fiscal_registrar_medicao: parametro invalido' using errcode = '22023';
  end if;
  update nofiscal.fiscal_subscriptions
     set medicao_consent = p_consent,
         medicao_fbp = case when v_granted then nullif(left(btrim(coalesce(p_fbp, '')), 120), '') end,
         medicao_fbc = case when v_granted then nullif(left(btrim(coalesce(p_fbc, '')), 600), '') end,
         medicao_em = now(),
         updated_at = now()
   where id = p_subscription_id;
  return found;
end;
$$;

-- ------------------------------------------------------------ Reivindicação da cobrança paga (webhook)

-- Devolve o que o webhook precisa para medir a cobrança, e grava a reivindicação (idempotente pela chave).
-- encontrada=false: a assinatura não é do fiscal (a conta do Pagar.me tem outros produtos) -> nada sai.
-- enviar=false com motivo: sem_consentimento | duplicado | contada_no_checkout.
create function public.fiscal_reivindicar_cobranca(
  p_subscription_id text,
  p_chave text,
  p_tipo text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s record;
  v_anteriores integer;
  v_decisao text;
  v_novos integer;
begin
  if p_subscription_id is null or btrim(p_subscription_id) = '' or p_chave is null or btrim(p_chave) = ''
     or p_tipo is null then
    raise exception 'fiscal_reivindicar_cobranca: parametro obrigatorio ausente' using errcode = '22023';
  end if;

  select s.id, s.tenant_id, s.plano, s.ciclo, s.com_teste, s.medicao_consent, s.medicao_fbp, s.medicao_fbc,
         s.created_at, a.email, a.phone_e164
    into v_s
    from nofiscal.fiscal_subscriptions s
    join nofiscal.fiscal_tenants t on t.id = s.tenant_id
    left join nofiscal.fiscal_accounts a on a.client_id = t.client_id
   where s.pagarme_subscription_id = p_subscription_id;
  if not found then
    return jsonb_build_object('encontrada', false, 'enviar', false);
  end if;
  if v_s.medicao_consent is distinct from 'granted' then
    return jsonb_build_object('encontrada', true, 'enviar', false, 'motivo', 'sem_consentimento');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fiscal_cobranca:' || p_subscription_id, 0));
  select count(*) into v_anteriores from nofiscal.fiscal_purchase_events e where e.subscription_id = v_s.id;
  v_decisao := case when not v_s.com_teste and now() < v_s.created_at + interval '15 days'
                    then 'contada_no_checkout' else 'enviar' end;

  insert into nofiscal.fiscal_purchase_events (chave, subscription_id, pagarme_subscription_id, tipo, ordem, decisao)
  values (p_chave, v_s.id, p_subscription_id, p_tipo, v_anteriores + 1, v_decisao)
  on conflict (chave) do nothing;
  get diagnostics v_novos = row_count;
  if v_novos = 0 then
    return jsonb_build_object('encontrada', true, 'enviar', false, 'motivo', 'duplicado');
  end if;
  if v_decisao <> 'enviar' then
    return jsonb_build_object('encontrada', true, 'enviar', false, 'motivo', v_decisao);
  end if;

  return jsonb_build_object(
    'encontrada', true,
    'enviar', true,
    'ordem', v_anteriores + 1,
    'tenant_id', v_s.tenant_id,
    'plano', v_s.plano,
    'ciclo', v_s.ciclo,
    'com_teste', v_s.com_teste,
    'email', v_s.email,
    'telefone', v_s.phone_e164,
    'fbp', v_s.medicao_fbp,
    'fbc', v_s.medicao_fbc);
end;
$$;

-- Resultado do envio (resumo curto: ok_1, erro_400, erro_rede, sem_token, sem_secret...), só para auditoria.
create function public.fiscal_registrar_resultado_cobranca(p_chave text, p_meta text, p_ga4 text)
returns void
language sql
security definer
set search_path = ''
as $$
  update nofiscal.fiscal_purchase_events
     set resultado_meta = left(p_meta, 60),
         resultado_ga4 = left(p_ga4, 60),
         atualizado_em = now()
   where chave = p_chave;
$$;

revoke all on function public.fiscal_registrar_medicao(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.fiscal_reivindicar_cobranca(text, text, text) from public, anon, authenticated;
revoke all on function public.fiscal_registrar_resultado_cobranca(text, text, text) from public, anon, authenticated;
grant execute on function public.fiscal_registrar_medicao(uuid, text, text, text) to service_role;
grant execute on function public.fiscal_reivindicar_cobranca(text, text, text) to service_role;
grant execute on function public.fiscal_registrar_resultado_cobranca(text, text, text) to service_role;
