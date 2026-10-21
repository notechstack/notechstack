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

-- A4: negócios do auditor saem antes (conexões e Vault vão junto pelos gatilhos da migration A).
delete from public.memberships where role = 'AUDITOR';
delete from public.clients where origem = 'auditor';

drop trigger if exists auditor_clientes_depois_de_apagar on public.auditor_clientes;
drop trigger if exists auditor_contas_antes_de_apagar on public.auditor_contas;
drop function if exists public.auditor_clientes_depois_de_apagar();
drop function if exists public.auditor_contas_antes_de_apagar();
drop trigger if exists auditor_assinatura_sincronizar on public.auditor_assinaturas;
drop function if exists public.auditor_assinatura_sincronizar();
drop function if exists public.auditor_assinatura_vincular(text, uuid, boolean);
drop function if exists public.auditor_copia_whatsapp_ler(uuid, uuid);
drop function if exists public.auditor_eu_copia_whatsapp(boolean, text);
drop function if exists public.auditor_checkout_preparar(uuid);
drop function if exists public.auditor_invoke_processar();
drop function if exists public.auditor_eu_frequencia(uuid, text);
drop function if exists public.auditor_eu_negocio_criar(text, text);
drop function if exists public.auditor_eu_retrospectiva(uuid);
drop function if exists public.auditor_eu_suporte(uuid, boolean, text);
drop function if exists public.auditor_eu_iniciar(text, text);
drop function if exists public.auditor_eu();
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
drop function if exists public.auditor_acesso_preparar(text, text, text);
drop function if exists public.auditor_assinatura_paga_vigente(uuid, timestamptz);
drop function if exists public.auditor_assinatura_ja_pagou(uuid);

-- Policies de memberships voltam ao R1; conexao_salvar volta à checagem por vínculo (migration A).
drop policy if exists memberships_insert_admin on public.memberships;
create policy memberships_insert_admin on public.memberships for insert to authenticated with check (public.is_no_admin());
drop policy if exists memberships_update_admin on public.memberships;
create policy memberships_update_admin on public.memberships for update to authenticated
  using (public.is_no_admin()) with check (public.is_no_admin());
drop policy if exists memberships_delete_admin on public.memberships;
create policy memberships_delete_admin on public.memberships for delete to authenticated using (public.is_no_admin());

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
drop table if exists public.auditor_aceites;
drop table if exists public.auditor_acesso_tentativas;
drop table if exists public.auditor_exclusoes;
drop table if exists public.auditor_acessos_suporte;
drop table if exists public.auditor_relatorios;
drop table if exists public.marketing_cliente_snapshots;
drop table if exists public.auditor_clientes;
alter table public.auditor_assinaturas drop column if exists conta_id;
drop table if exists public.auditor_contas;
-- conexao_salvar volta à versão da migration A.
create or replace function public.marketing_cliente_conexao_salvar(
  p_client_id uuid, p_provedor text, p_token text, p_escopos text[], p_expira_em timestamptz,
  p_usuario_externo text, p_user_id uuid
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  atual public.marketing_cliente_conexoes;
  nome_segredo text := 'marketing_cliente:' || p_client_id || ':' || p_provedor;
  segredo uuid;
begin
  if p_token is null or length(p_token) = 0 then raise exception 'token ausente'; end if;
  if p_provedor not in ('meta', 'google') then raise exception 'provedor inválido'; end if;
  -- Só o membro AUDITOR de um negócio do auditor conecta (o NO_ADMIN não conecta em nome do cliente).
  if not exists (
    select 1 from auth.users u
    join public.memberships m on m.user_id = u.id and m.client_id = p_client_id and m.role = 'AUDITOR'
    join public.clients c on c.id = p_client_id and c.origem = 'auditor'
    where u.id = p_user_id and (u.banned_until is null or u.banned_until <= now())
  ) then
    raise exception 'autor não autorizado para este cliente';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(nome_segredo));
  select * into atual from public.marketing_cliente_conexoes
  where client_id = p_client_id and provedor = p_provedor and estado <> 'desconectado';

  select id into segredo from vault.secrets where id = atual.vault_secret_id;
  if segredo is null then
    delete from vault.secrets where name = nome_segredo; -- sobra de encerramento interrompido
    segredo := vault.create_secret(p_token, nome_segredo, 'Token OAuth do cliente (marketing-hub)');
  else
    perform vault.update_secret(segredo, p_token);
  end if;

  if atual.id is null then
    insert into public.marketing_cliente_conexoes (client_id, provedor, estado, escopos, expira_em, usuario_externo, vault_secret_id, conectado_por)
    values (p_client_id, p_provedor, 'conectado', coalesce(p_escopos, '{}'), p_expira_em, p_usuario_externo, segredo, p_user_id);
  else
    -- Outra conta do provedor: as escolhas antigas não valem para o token novo.
    if atual.usuario_externo is distinct from p_usuario_externo then
      delete from public.marketing_cliente_ativos where conexao_id = atual.id;
    end if;
    update public.marketing_cliente_conexoes set
      estado = 'conectado', escopos = coalesce(p_escopos, '{}'), expira_em = p_expira_em, usuario_externo = p_usuario_externo,
      vault_secret_id = segredo, conectado_por = p_user_id, conectado_em = now(), ultimo_erro = null, encerrado_em = null
    where id = atual.id;
  end if;

  perform public.marketing_cliente_evento(p_client_id, p_user_id, 'AUDITOR',
    case when atual.id is null then 'conectou' else 'reconectou' end,
    jsonb_build_object('provedor', p_provedor, 'escopos', coalesce(p_escopos, '{}'), 'expira_em', p_expira_em));
end;
$$;
drop function if exists public.auditor_dono_do_negocio(uuid, uuid);
