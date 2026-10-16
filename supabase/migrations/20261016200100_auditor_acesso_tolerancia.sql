-- TASK-mvbcb35pbn0: politica de acesso ao plano do Auditor.
-- PROPOSTA do Dwight (questao 10), a confirmar por Lucca na TASK das chaves:
--   paga      -> tem acesso
--   recusada  -> mantem o acesso por 3 dias contados da PRIMEIRA recusa depois do ultimo pagamento,
--                so para quem ja pagou alguma vez (renovacao com cartao recusado; o Pagar.me tenta de novo).
--                Cada nova tentativa recusada nao estende o prazo.
--   pendente, cancelada -> sem acesso
-- Trocar a tolerancia = mudar o default de p_tolerancia abaixo (um lugar so).
-- Depende de 20261016200000_auditor_assinaturas.sql.
-- Reversao: supabase/rollback/20261016200100_auditor_acesso_tolerancia.down.sql (rodar ANTES do rollback da 200000).

create or replace function public.auditor_assinatura_com_acesso(
  p_status text,
  p_recusada_desde timestamptz,
  p_ja_pagou boolean,
  p_agora timestamptz default now(),
  p_tolerancia interval default interval '3 days'
) returns boolean
language sql
stable
set search_path = public
as $$
  select case p_status
    when 'paga' then true
    when 'recusada' then coalesce(p_ja_pagou, false)
                         and p_recusada_desde is not null
                         and p_agora < p_recusada_desde + p_tolerancia
    else false
  end;
$$;

revoke all on function public.auditor_assinatura_com_acesso(text, timestamptz, boolean, timestamptz, interval)
  from public, anon, authenticated;
grant execute on function public.auditor_assinatura_com_acesso(text, timestamptz, boolean, timestamptz, interval)
  to service_role;

-- Lista de envio do relatorio: quem aceitou e tem acesso pela politica acima.
-- Mesmas colunas, na mesma ordem, da view da 200000 (create or replace exige isso).
create or replace view public.auditor_lista_envio_relatorio
with (security_invoker = true) as
select a.id, a.plano, a.nome, a.email, a.pagarme_subscription_id,
       a.relatorio_aceite_em, a.ultimo_evento_em
  from public.auditor_assinaturas a
  left join lateral (
    select max(e.recebido_em) as ultima_paga
      from public.auditor_assinatura_eventos e
     where e.pagarme_subscription_id = a.pagarme_subscription_id
       and e.status_aplicado = 'paga'
  ) p on true
  left join lateral (
    select min(e.recebido_em) as recusada_desde
      from public.auditor_assinatura_eventos e
     where e.pagarme_subscription_id = a.pagarme_subscription_id
       and e.status_aplicado = 'recusada'
       and e.recebido_em > coalesce(p.ultima_paga, '-infinity'::timestamptz)
  ) r on true
 where a.relatorio_aceite = true
   and public.auditor_assinatura_com_acesso(a.status, r.recusada_desde, p.ultima_paga is not null);
