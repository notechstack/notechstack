-- Reverte supabase/migrations/20261016200000_auditor_assinaturas.sql (TASK-mvbcb35pbn0).
-- Fica fora de migrations de proposito: o db push nao aplica. Apaga assinaturas e eventos do Auditor.
-- Roda numa transacao so: se qualquer drop falhar, nada e desfeito pela metade.
begin;
drop function if exists public.registrar_assinatura_auditor(text, text, text, text, text, text, text, text);
drop function if exists public.aplicar_evento_assinatura_auditor(text, text, text, text, jsonb, timestamptz);
drop view if exists public.auditor_lista_envio_relatorio;
drop table if exists public.auditor_assinatura_eventos;
drop table if exists public.auditor_assinaturas;
commit;
