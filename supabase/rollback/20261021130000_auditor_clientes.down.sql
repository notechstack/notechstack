-- Reversão de 20261021130000_auditor_clientes.sql (Frente 3). Rodar ANTES da reversão da migration A.
-- Apaga contas, relatórios, snapshots e concessões do auditor. Os negócios (clients origem 'auditor'),
-- vínculos e conexões são da migration A e ficam para a reversão dela.

do $$
declare j text;
begin
  foreach j in array array['auditor-relatorios-planejar', 'auditor-relatorios-processar', 'auditor_limpar_diario'] loop
    if exists (select 1 from cron.job where jobname = j and username = current_user) then
      perform cron.unschedule(j);
    end if;
  end loop;
end;
$$;

drop function if exists public.auditor_invoke_processar();
drop view if exists public.auditor_operacao;
drop function if exists public.auditor_limpar(timestamptz);
drop function if exists public.auditor_apagar_conta(uuid, text);
drop function if exists public.auditor_relatorio_falha(uuid, text, boolean);
drop function if exists public.auditor_claim_relatorios(integer);
drop function if exists public.auditor_retrospectiva_agendar(uuid, uuid, timestamptz);
drop function if exists public.auditor_planejar_relatorios(timestamptz);
drop function if exists public.auditor_conta_com_acesso(uuid, timestamptz);
drop function if exists public.auditor_suporte_revogar(uuid, uuid);
drop function if exists public.auditor_suporte_conceder(uuid, uuid, text, integer);
drop function if exists public.auditor_negocio_criar(uuid, text, text);
drop function if exists public.auditor_primeiro_acesso(uuid, text, text);

-- Volta auditor_pode_ler à versão da migration A (só membro AUDITOR), antes de apagar a tabela de suporte.
create or replace function public.auditor_pode_ler(p_client_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.client_id = p_client_id and m.role = 'AUDITOR'
  );
$$;

drop table if exists public.auditor_avisos;
drop table if exists public.auditor_exclusoes;
drop table if exists public.auditor_acessos_suporte;
drop table if exists public.auditor_relatorios;
drop table if exists public.marketing_cliente_snapshots;
drop table if exists public.auditor_clientes;
alter table public.auditor_assinaturas drop column if exists conta_id;
drop table if exists public.auditor_contas;
