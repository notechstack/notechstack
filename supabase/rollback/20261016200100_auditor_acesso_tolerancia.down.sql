-- Reverte supabase/migrations/20261016200100_auditor_acesso_tolerancia.sql (TASK-mvbcb35pbn0).
-- Volta a lista de envio para "aceitou e esta paga" e apaga a funcao de acesso.
-- Ordem: rodar esta ANTES de 20261016200000_auditor_assinaturas.down.sql. Fica fora de migrations de proposito.
begin;
create or replace view public.auditor_lista_envio_relatorio
with (security_invoker = true) as
select a.id, a.plano, a.nome, a.email, a.pagarme_subscription_id,
       a.relatorio_aceite_em, a.ultimo_evento_em
  from public.auditor_assinaturas a
 where a.relatorio_aceite = true
   and a.status = 'paga';
drop function if exists public.auditor_assinatura_com_acesso(text, timestamptz, boolean, timestamptz, interval);
commit;
