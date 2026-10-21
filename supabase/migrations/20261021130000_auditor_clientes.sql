-- Auditor por cliente (Frente 3): identidade, conta e plano, negócios, snapshots, relatórios,
-- acesso de suporte, exclusões, avisos, agenda e limpeza.
-- Spec: docs/movimentos/2026-10-21-auditor-conexoes-clientes/spec.md (aprovada em 21/10/2026, D1–D10).
-- Depende de 20261021120000_marketing_cliente_conexoes.sql (migration A, Frente 1), que já cria
-- clients.origem, memberships 'AUDITOR', conexões, ativos e a trilha marketing_cliente_eventos.
-- Esta migration redefine auditor_pode_ler() para incluir o acesso de suporte (D2).
-- Toda escrita é por service_role (Edge Functions) ou pelas RPCs abaixo; authenticated só lê,
-- e só o que auditor_pode_ler() libera.
-- Reversão: supabase/rollback/20261021130000_auditor_clientes.down.sql

-- ------------------------------------------------------------ 2 · Conta e negócio

create table public.auditor_contas (
  id uuid primary key default gen_random_uuid(),
  dono_user_id uuid not null unique references auth.users(id) on delete cascade,
  plano text not null default 'gratis' check (plano in ('gratis', 'mensal', 'semanal', 'agencia')),
  assinatura_id uuid unique references public.auditor_assinaturas(id) on delete set null,
  criada_em timestamptz not null default now(),
  encerrada_em timestamptz,
  excluir_apos timestamptz,
  -- Cópia do relatório pelo WhatsApp, enviada à mão pela equipe da nó (decisão do Lucca, 21/10).
  -- Opt-in opcional no checkout; o cliente desliga no painel. Só com ela a equipe lê o texto final do relatório.
  copia_whatsapp boolean not null default false,
  copia_whatsapp_numero text check (copia_whatsapp_numero ~ '^[0-9]{10,11}$'),
  copia_whatsapp_em timestamptz,
  check (not copia_whatsapp or (copia_whatsapp_numero is not null and copia_whatsapp_em is not null))
);

alter table public.auditor_assinaturas
  add column if not exists conta_id uuid references public.auditor_contas(id) on delete set null;

create table public.auditor_clientes (
  client_id uuid primary key references public.clients(id) on delete cascade,
  conta_id uuid not null references public.auditor_contas(id) on delete cascade,
  site_url text check (site_url is null or (char_length(site_url) <= 500 and site_url ~ '^https?://')),
  -- null = segue o plano (Mensal/Semanal); no Agência o dono escolhe por negócio (padrão semanal).
  frequencia text check (frequencia in ('semanal', 'mensal')),
  fuso text not null default 'America/Sao_Paulo',
  retrospectiva_gerada_em timestamptz,
  criado_em timestamptz not null default now()
);
create index auditor_clientes_conta on public.auditor_clientes (conta_id);

-- ------------------------------------------------------------ 3 · Snapshots e relatórios

create table public.marketing_cliente_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  tipo text not null check (tipo in ('meta_ads', 'google_ads', 'ga4', 'gsc', 'site')),
  external_id text not null check (char_length(external_id) between 1 and 500),
  periodo_de date not null,
  periodo_ate date not null check (periodo_ate >= periodo_de),
  dados jsonb not null,
  versao_formato smallint not null default 1,
  coletado_em timestamptz not null default now(),
  unique (client_id, tipo, external_id, periodo_de, periodo_ate)
);

create table public.auditor_relatorios (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  tipo text not null check (tipo in ('retrospectiva', 'semanal', 'mensal')),
  periodo_de date not null,
  periodo_ate date not null check (periodo_ate >= periodo_de),
  estado text not null default 'agendado'
    check (estado in ('agendado', 'coletando', 'gerando', 'pronto', 'enviado', 'parcial', 'falhou', 'pulado')),
  executar_em timestamptz not null default now(),
  iniciado_em timestamptz,               -- quando o processamento atual começou (relatório preso volta à fila)
  tentativas smallint not null default 0,
  fontes jsonb not null default '{}'::jsonb,
  achados jsonb,
  narrativa jsonb,
  modelo text,
  versao_regras text,
  uso jsonb,
  gerado_em timestamptz,
  enviado_em timestamptz,
  email_id text,
  erro text check (char_length(erro) <= 500),
  criado_em timestamptz not null default now(),
  unique (client_id, tipo, periodo_de)
);
create index auditor_relatorios_fila on public.auditor_relatorios (executar_em) where estado = 'agendado';

-- ------------------------------------------------------------ 4 · Suporte, trilha, exclusões, avisos

create table public.auditor_acessos_suporte (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  concedido_por uuid not null references auth.users(id) on delete cascade,
  motivo text check (char_length(motivo) <= 300),
  inicio timestamptz not null default now(),
  expira_em timestamptz not null,
  revogado_em timestamptz,
  check (expira_em > inicio),
  check (expira_em <= inicio + interval '72 hours')
);
create index auditor_acessos_suporte_cliente on public.auditor_acessos_suporte (client_id, expira_em desc);

create table public.auditor_exclusoes (
  id uuid primary key default gen_random_uuid(),
  origem text not null check (origem in ('meta_callback', 'cliente', 'cancelamento', 'inatividade', 'admin')),
  codigo_confirmacao text not null unique default encode(extensions.gen_random_bytes(12), 'hex'),
  provedor text check (provedor in ('meta', 'google')),
  usuario_externo text,
  client_id uuid,
  conta_id uuid,
  estado text not null default 'recebido' check (estado in ('recebido', 'concluido', 'sem_dados')),
  pedido_em timestamptz not null default now(),
  concluido_em timestamptz
);

-- Fila de e-mails de aviso, idempotente por (client_id, tipo, referencia).
create table public.auditor_avisos (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  tipo text not null check (tipo in ('expira_7d', 'expira_1d', 'gratis_tokens_apagados', 'sem_fonte_30d')),
  referencia text not null,
  criado_em timestamptz not null default now(),
  enviado_em timestamptz,
  unique (client_id, tipo, referencia)
);

-- Aceite dos Termos e da Política, registrado pelo próprio usuário logado (revisão B3). O primeiro acesso exige.
create table public.auditor_aceites (
  user_id uuid not null references auth.users(id) on delete cascade,
  versao text not null check (versao ~ '^[a-z0-9._-]{1,40}$'),
  aceito_em timestamptz not null default now(),
  primary key (user_id, versao)
);

-- Pedidos de link mágico (auditor-acesso): só hashes, guardados 1 dia, para o limite por hora (U5).
create table public.auditor_acesso_tentativas (
  id bigint generated always as identity primary key,
  chave_email text not null check (chave_email ~ '^[0-9a-f]{64}$'),
  chave_ip text not null check (chave_ip ~ '^[0-9a-f]{64}$'),
  em timestamptz not null default now()
);
create index auditor_acesso_tentativas_email on public.auditor_acesso_tentativas (chave_email, em);
create index auditor_acesso_tentativas_ip on public.auditor_acesso_tentativas (chave_ip, em);

-- ------------------------------------------------------------ 5 · Quem lê o quê (D2)

-- Dono do negócio: a posse vem de auditor_clientes → auditor_contas, que só a service role e as RPCs escrevem.
-- (Revisão A1: memberships não serve de prova; o NO_ADMIN tem INSERT nela pelas policies do R1.)
create or replace function public.auditor_dono_do_negocio(p_user_id uuid, p_client_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_user_id is not null and exists (
    select 1 from public.auditor_clientes ac
    join public.auditor_contas c on c.id = ac.conta_id
    join public.clients cl on cl.id = ac.client_id and cl.origem = 'auditor'
    where ac.client_id = p_client_id and c.dono_user_id = p_user_id
  );
$$;
revoke all on function public.auditor_dono_do_negocio(uuid, uuid) from public, anon, authenticated;
grant execute on function public.auditor_dono_do_negocio(uuid, uuid) to service_role;

-- Pela RLS, só o dono lê o próprio negócio. A leitura de suporte do NO_ADMIN (D2) passa só pela marketing-hub,
-- que confere a concessão vigente e registra cada leitura (revisão B6); pelo banco direto, o NO_ADMIN não lê.
create or replace function public.auditor_pode_ler(p_client_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select public.auditor_dono_do_negocio((select auth.uid()), p_client_id);
$$;
revoke all on function public.auditor_pode_ler(uuid) from public, anon;
grant execute on function public.auditor_pode_ler(uuid) to authenticated, service_role;

-- A1: o NO_ADMIN continua administrando os vínculos CLIENT (R1), mas não cria nem altera vínculos AUDITOR.
drop policy if exists memberships_insert_admin on public.memberships;
create policy memberships_insert_admin on public.memberships for insert to authenticated
  with check (public.is_no_admin() and role = 'CLIENT');
drop policy if exists memberships_update_admin on public.memberships;
create policy memberships_update_admin on public.memberships for update to authenticated
  using (public.is_no_admin() and role = 'CLIENT')
  with check (public.is_no_admin() and role = 'CLIENT');
drop policy if exists memberships_delete_admin on public.memberships;
create policy memberships_delete_admin on public.memberships for delete to authenticated
  using (public.is_no_admin() and role = 'CLIENT');

-- A1: conectar Meta/Google exige a posse do negócio (redefine a função da migration A; só muda a checagem).
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
  -- Só o dono do negócio conecta (o NO_ADMIN não conecta em nome do cliente).
  if not exists (
    select 1 from auth.users u
    where u.id = p_user_id and (u.banned_until is null or u.banned_until <= now())
      and public.auditor_dono_do_negocio(u.id, p_client_id)
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

alter table public.auditor_contas enable row level security;
alter table public.auditor_clientes enable row level security;
alter table public.marketing_cliente_snapshots enable row level security;
alter table public.auditor_relatorios enable row level security;
alter table public.auditor_acessos_suporte enable row level security;
alter table public.auditor_exclusoes enable row level security;
alter table public.auditor_avisos enable row level security;
alter table public.auditor_aceites enable row level security;

revoke all on public.auditor_contas, public.auditor_clientes, public.marketing_cliente_snapshots,
  public.auditor_relatorios, public.auditor_acessos_suporte,
  public.auditor_exclusoes, public.auditor_avisos, public.auditor_aceites
  from public, anon, authenticated;

grant select (id, plano, criada_em, encerrada_em, excluir_apos, copia_whatsapp, copia_whatsapp_numero, copia_whatsapp_em) on public.auditor_contas to authenticated;
create policy auditor_contas_dono on public.auditor_contas
  for select to authenticated using (dono_user_id = (select auth.uid()));

grant select on public.auditor_clientes to authenticated;
create policy auditor_clientes_leitor on public.auditor_clientes
  for select to authenticated using ((select public.auditor_pode_ler(client_id)));

grant select on public.marketing_cliente_snapshots to authenticated;
create policy marketing_cliente_snapshots_leitor on public.marketing_cliente_snapshots
  for select to authenticated using ((select public.auditor_pode_ler(client_id)));

grant select (id, client_id, tipo, periodo_de, periodo_ate, estado, fontes, achados, narrativa, gerado_em, enviado_em)
  on public.auditor_relatorios to authenticated;
create policy auditor_relatorios_leitor on public.auditor_relatorios
  for select to authenticated
  using (estado in ('pronto', 'enviado', 'parcial') and (select public.auditor_pode_ler(client_id)));

grant select (id, client_id, motivo, inicio, expira_em, revogado_em) on public.auditor_acessos_suporte to authenticated;
create policy auditor_acessos_suporte_leitor on public.auditor_acessos_suporte
  for select to authenticated using ((select public.auditor_pode_ler(client_id)));

grant select, insert, delete on public.auditor_acesso_tentativas to service_role;
grant select, insert, update, delete on public.auditor_contas, public.auditor_clientes,
  public.marketing_cliente_snapshots, public.auditor_relatorios, public.auditor_acessos_suporte,
  public.auditor_exclusoes, public.auditor_avisos, public.auditor_aceites to service_role;

alter table public.auditor_acesso_tentativas enable row level security;
revoke all on public.auditor_acesso_tentativas from public, anon, authenticated;

-- Limite do link mágico (3 por e-mail e 20 por IP, por hora; e 300 no total por hora) + quem é o usuário desse e-mail.
-- Uma ida ao banco; evita varrer o Auth inteiro. Registra a tentativa só quando permitida.
create or replace function public.auditor_acesso_preparar(p_email text, p_chave_email text, p_chave_ip text)
returns table (permitido boolean, user_id uuid, papel text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('auditor_acesso:' || p_chave_email));
  delete from public.auditor_acesso_tentativas where em < now() - interval '1 day';
  if (select count(*) from public.auditor_acesso_tentativas where chave_email = p_chave_email and em > now() - interval '1 hour') >= 3
     or (select count(*) from public.auditor_acesso_tentativas where chave_ip = p_chave_ip and em > now() - interval '1 hour') >= 20
     or (select count(*) from public.auditor_acesso_tentativas where em > now() - interval '1 hour') >= 300 then
    return query select false, null::uuid, null::text;
    return;
  end if;
  insert into public.auditor_acesso_tentativas (chave_email, chave_ip) values (p_chave_email, p_chave_ip);
  return query
    select true, u.id, u.raw_app_meta_data ->> 'role'
      from (select 1) x
      left join auth.users u on lower(u.email) = v_email;
end;
$$;

-- ------------------------------------------------------------ 5b · Pagamento (A4)

-- Já houve algum pagamento confirmado desta assinatura (evento 'paga' do webhook ou status atual 'paga').
create or replace function public.auditor_assinatura_ja_pagou(p_assinatura_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select a.status = 'paga' or exists (
      select 1 from public.auditor_assinatura_eventos e
      where e.pagarme_subscription_id = a.pagarme_subscription_id and e.status_aplicado = 'paga')
    from public.auditor_assinaturas a where a.id = p_assinatura_id), false);
$$;

-- Acesso pago vigente pela política D8 (paga, ou recusada dentro da tolerância depois de já ter pago).
create or replace function public.auditor_assinatura_paga_vigente(p_assinatura_id uuid, p_agora timestamptz default now())
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select public.auditor_assinatura_com_acesso(a.status, r.recusada_desde, p.ultima_paga is not null, p_agora)
      from public.auditor_assinaturas a
      left join lateral (
        select max(coalesce(e.evento_em, e.recebido_em)) as ultima_paga
          from public.auditor_assinatura_eventos e
         where e.pagarme_subscription_id = a.pagarme_subscription_id and e.status_aplicado = 'paga'
      ) p on true
      left join lateral (
        select min(coalesce(e.evento_em, e.recebido_em)) as recusada_desde
          from public.auditor_assinatura_eventos e
         where e.pagarme_subscription_id = a.pagarme_subscription_id and e.status_aplicado = 'recusada'
           and coalesce(e.evento_em, e.recebido_em) > coalesce(p.ultima_paga, '-infinity'::timestamptz)
      ) r on true
     where a.id = p_assinatura_id
  ), false);
$$;

-- ------------------------------------------------------------ 6 · Primeiro acesso e negócios

-- Cria (uma vez) conta 'gratis' + negócio + vínculo AUDITOR. Idempotente e seguro sob concorrência.
-- Vincula, uma única vez, a assinatura mais recente sem conta com o mesmo e-mail.
create or replace function public.auditor_primeiro_acesso(p_user_id uuid, p_email text, p_site_url text default null)
returns table (conta_id uuid, client_id uuid, criada boolean)
language plpgsql security definer set search_path = ''
as $$
declare
  v_conta public.auditor_contas;
  v_client uuid;
  v_assinatura public.auditor_assinaturas;
  v_site text := nullif(trim(p_site_url), '');
begin
  if v_site is not null and (v_site !~ '^https?://' or char_length(v_site) > 500) then v_site := null; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('auditor_conta:' || p_user_id));

  select * into v_conta from public.auditor_contas where dono_user_id = p_user_id;
  if v_conta.id is not null then
    -- B7: quem volta reabre a conta encerrada (por inatividade ou cancelamento) como grátis, salvo acesso pago vigente.
    if v_conta.encerrada_em is not null then
      update public.auditor_contas
         set encerrada_em = null, excluir_apos = null,
             plano = case when public.auditor_assinatura_paga_vigente(assinatura_id) then plano else 'gratis' end
       where id = v_conta.id;
      perform public.marketing_cliente_evento(
        (select ac.client_id from public.auditor_clientes ac where ac.conta_id = v_conta.id order by ac.criado_em limit 1),
        p_user_id, 'AUDITOR', 'conta_reaberta', '{}'::jsonb);
    end if;
    select ac.client_id into v_client from public.auditor_clientes ac
      where ac.conta_id = v_conta.id order by ac.criado_em limit 1;
    return query select v_conta.id, v_client, false;
    return;
  end if;
  -- B3: a conta só nasce com o aceite dos Termos registrado pelo próprio usuário.
  if not exists (select 1 from public.auditor_aceites a where a.user_id = p_user_id) then
    raise exception 'aceite_pendente';
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'usuário inexistente';
  end if;
  if exists (select 1 from auth.users u where u.id = p_user_id
             and u.raw_app_meta_data ->> 'role' in ('NO_ADMIN', 'MARKETING_AGENT')) then
    raise exception 'conta_sistema'; -- conta do sistema (NO_ADMIN/MARKETING_AGENT) não vira cliente do auditor
  end if;

  insert into public.auditor_contas (dono_user_id) values (p_user_id) returning * into v_conta;

  insert into public.clients (name, slug, email, origem)
  values (coalesce(substring(v_site from '^https?://(?:www\.)?([^/:?#]+)'), 'Meu negócio'),
          'auditor-' || replace(gen_random_uuid()::text, '-', ''), lower(p_email), 'auditor')
  returning id into v_client;
  insert into public.auditor_clientes (client_id, conta_id, site_url) values (v_client, v_conta.id, v_site);
  insert into public.memberships (user_id, client_id, role) values (p_user_id, v_client, 'AUDITOR');

  perform public.marketing_cliente_evento(v_client, p_user_id, 'AUDITOR', 'conta_criada', '{}'::jsonb);

  select * into v_assinatura from public.auditor_assinaturas a
   where a.conta_id is null and lower(a.email) = lower(p_email) and a.status <> 'cancelada'
   order by a.created_at desc limit 1
   for update;
  if v_assinatura.id is not null then
    update public.auditor_assinaturas set conta_id = v_conta.id where id = v_assinatura.id;
    update public.auditor_contas
       set assinatura_id = v_assinatura.id,
           plano = case when public.auditor_assinatura_ja_pagou(v_assinatura.id) and v_assinatura.status in ('paga', 'recusada')
                        then v_assinatura.plano else 'gratis' end
     where id = v_conta.id;
    perform public.marketing_cliente_evento(v_client, p_user_id, 'SISTEMA', 'assinatura_vinculada',
      jsonb_build_object('plano', v_assinatura.plano));
  end if;

  return query select v_conta.id, v_client, true;
end;
$$;

-- Plano Agência: até 5 negócios por conta.
create or replace function public.auditor_negocio_criar(p_user_id uuid, p_site_url text, p_nome text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_conta public.auditor_contas;
  v_client uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('auditor_conta:' || p_user_id));
  select * into v_conta from public.auditor_contas where dono_user_id = p_user_id;
  if v_conta.id is null then raise exception 'conta_inexistente'; end if;
  if v_conta.plano <> 'agencia' or not public.auditor_conta_com_acesso(v_conta.id) then raise exception 'plano_sem_multiplos_negocios'; end if;
  if (select count(*) from public.auditor_clientes where conta_id = v_conta.id) >= 5 then
    raise exception 'limite_de_negocios';
  end if;
  if p_site_url is null or p_site_url !~ '^https?://' or char_length(p_site_url) > 500 then
    raise exception 'site_invalido';
  end if;
  insert into public.clients (name, slug, origem)
  values (coalesce(nullif(left(trim(p_nome), 120), ''), substring(p_site_url from '^https?://(?:www\.)?([^/:?#]+)')),
          'auditor-' || replace(gen_random_uuid()::text, '-', ''), 'auditor')
  returning id into v_client;
  insert into public.auditor_clientes (client_id, conta_id, site_url, frequencia)
  values (v_client, v_conta.id, p_site_url, 'semanal');
  insert into public.memberships (user_id, client_id, role) values (p_user_id, v_client, 'AUDITOR');
  perform public.marketing_cliente_evento(v_client, p_user_id, 'AUDITOR', 'negocio_criado', '{}'::jsonb);
  return v_client;
end;
$$;

-- ------------------------------------------------------------ 7 · Suporte (concessão do cliente)

create or replace function public.auditor_suporte_conceder(p_user_id uuid, p_client_id uuid, p_motivo text default null, p_horas int default 72)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if p_horas < 1 or p_horas > 72 then raise exception 'janela_invalida'; end if;
  if not exists (
    select 1 from public.auditor_clientes ac join public.auditor_contas c on c.id = ac.conta_id
    where ac.client_id = p_client_id and c.dono_user_id = p_user_id
  ) then raise exception 'so_o_dono_concede'; end if;
  update public.auditor_acessos_suporte set revogado_em = now()
   where client_id = p_client_id and revogado_em is null and expira_em > now();
  insert into public.auditor_acessos_suporte (client_id, concedido_por, motivo, expira_em)
  values (p_client_id, p_user_id, left(p_motivo, 300), now() + make_interval(hours => p_horas))
  returning id into v_id;
  perform public.marketing_cliente_evento(p_client_id, p_user_id, 'AUDITOR', 'suporte_concedido', jsonb_build_object('horas', p_horas));
  return v_id;
end;
$$;

create or replace function public.auditor_suporte_revogar(p_user_id uuid, p_client_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.auditor_clientes ac join public.auditor_contas c on c.id = ac.conta_id
    where ac.client_id = p_client_id and c.dono_user_id = p_user_id
  ) then raise exception 'so_o_dono_revoga'; end if;
  update public.auditor_acessos_suporte set revogado_em = now()
   where client_id = p_client_id and revogado_em is null and expira_em > now();
  perform public.marketing_cliente_evento(p_client_id, p_user_id, 'AUDITOR', 'suporte_revogado', '{}'::jsonb);
end;
$$;

-- ------------------------------------------------------------ 8 · Acesso pago e agenda

-- Mesma política de auditor_lista_envio_relatorio (tolerância de 3 dias, D8), por conta.
create or replace function public.auditor_conta_com_acesso(p_conta_id uuid, p_agora timestamptz default now())
returns boolean language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select public.auditor_assinatura_paga_vigente(c.assinatura_id, p_agora)
      from public.auditor_contas c
     where c.id = p_conta_id and c.plano <> 'gratis' and c.encerrada_em is null and c.assinatura_id is not null
  ), false);
$$;

-- D4: Semanal toda segunda (semana anterior, seg–dom); Mensal no dia 1 (mês anterior);
-- Agência por negócio (padrão semanal). Data no fuso do negócio. Idempotente pela chave única.
create or replace function public.auditor_planejar_relatorios(p_agora timestamptz default now())
returns integer language plpgsql security definer set search_path = ''
as $$
declare
  n integer := 0;
  v integer;
  r record;
  v_hoje date;
  v_freq text;
begin
  for r in
    select ac.client_id, ac.fuso, ac.frequencia, c.plano
      from public.auditor_clientes ac
      join public.auditor_contas c on c.id = ac.conta_id
     where public.auditor_conta_com_acesso(c.id, p_agora)
  loop
    v_hoje := (p_agora at time zone r.fuso)::date;
    v_freq := case r.plano when 'semanal' then 'semanal' when 'mensal' then 'mensal'
                           else coalesce(r.frequencia, 'semanal') end;
    if v_freq = 'semanal' and extract(isodow from v_hoje) = 1 then
      insert into public.auditor_relatorios (client_id, tipo, periodo_de, periodo_ate, executar_em)
      values (r.client_id, 'semanal', v_hoje - 7, v_hoje - 1, p_agora)
      on conflict (client_id, tipo, periodo_de) do nothing;
      get diagnostics v = row_count; n := n + v;
    elsif v_freq = 'mensal' and extract(day from v_hoje) = 1 then
      insert into public.auditor_relatorios (client_id, tipo, periodo_de, periodo_ate, executar_em)
      values (r.client_id, 'mensal', (v_hoje - interval '1 month')::date, v_hoje - 1, p_agora)
      on conflict (client_id, tipo, periodo_de) do nothing;
      get diagnostics v = row_count; n := n + v;
    end if;
  end loop;

  -- Lembretes de expiração Meta (7 dias e 1 dia antes), uma vez por expiração.
  insert into public.auditor_avisos (client_id, tipo, referencia)
  select c.client_id, case when c.expira_em - p_agora <= interval '1 day' then 'expira_1d' else 'expira_7d' end,
         c.provedor || ':' || c.expira_em::text
    from public.marketing_cliente_conexoes c
    join public.clients cl on cl.id = c.client_id and cl.origem = 'auditor'
   where c.estado = 'conectado' and c.expira_em is not null
     and c.expira_em > p_agora and c.expira_em - p_agora <= interval '7 days'
  on conflict (client_id, tipo, referencia) do nothing;

  return n;
end;
$$;

-- Retrospectiva grátis: uma vez por negócio, últimos 28 dias até ontem (D1).
create or replace function public.auditor_retrospectiva_agendar(p_user_id uuid, p_client_id uuid, p_agora timestamptz default now())
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_hoje date;
begin
  if not public.auditor_dono_do_negocio(p_user_id, p_client_id) then raise exception 'sem_acesso'; end if;
  update public.auditor_clientes set retrospectiva_gerada_em = p_agora
   where client_id = p_client_id and retrospectiva_gerada_em is null
   returning (p_agora at time zone fuso)::date into v_hoje;
  if v_hoje is null then return null; end if;
  insert into public.auditor_relatorios (client_id, tipo, periodo_de, periodo_ate, executar_em)
  values (p_client_id, 'retrospectiva', v_hoje - 28, v_hoje - 1, p_agora)
  returning id into v_id;
  return v_id;
end;
$$;

-- Fila: até p_limit relatórios vencidos, sem repetição entre chamadas simultâneas.
-- B5: relatório parado em coletando/gerando há mais de 20 min (função caiu no meio) volta a valer como vencido;
-- na 3ª tentativa vira 'falhou'.
create or replace function public.auditor_claim_relatorios(p_limit integer default 1)
returns setof public.auditor_relatorios
language plpgsql security definer set search_path = ''
as $$
declare r record;
begin
  for r in
    select id, client_id, tentativas from public.auditor_relatorios
     where estado in ('coletando', 'gerando') and iniciado_em < now() - interval '20 minutes' and tentativas >= 3
     for update skip locked
  loop
    update public.auditor_relatorios set estado = 'falhou', erro = 'parado_no_processamento' where id = r.id;
    perform public.marketing_cliente_evento(r.client_id, null, 'SISTEMA', 'relatorio_falhou',
      jsonb_build_object('relatorio_id', r.id, 'tentativas', r.tentativas, 'motivo', 'parado'));
  end loop;
  return query
  update public.auditor_relatorios a
     set estado = 'coletando', tentativas = a.tentativas + 1, iniciado_em = now()
   where a.id in (
     select id from public.auditor_relatorios
      where (estado = 'agendado' and executar_em <= now())
         or (estado in ('coletando', 'gerando') and iniciado_em < now() - interval '20 minutes')
      order by executar_em
      limit greatest(1, least(p_limit, 10))
      for update skip locked
   )
  returning a.*;
end;
$$;

-- Erro na geração: transitório volta para a fila (+10 min, +30 min); na 3ª falha vira 'falhou'.
create or replace function public.auditor_relatorio_falha(p_id uuid, p_erro text, p_transitorio boolean)
returns text language plpgsql security definer set search_path = ''
as $$
declare v_rel public.auditor_relatorios;
begin
  select * into v_rel from public.auditor_relatorios where id = p_id for update;
  if v_rel.id is null then raise exception 'relatorio_inexistente'; end if;
  if p_transitorio and v_rel.tentativas < 3 then
    update public.auditor_relatorios
       set estado = 'agendado', erro = left(p_erro, 500),
           executar_em = now() + case v_rel.tentativas when 1 then interval '10 minutes' else interval '30 minutes' end
     where id = p_id;
    return 'agendado';
  end if;
  update public.auditor_relatorios set estado = 'falhou', erro = left(p_erro, 500) where id = p_id;
  perform public.marketing_cliente_evento(v_rel.client_id, null, 'SISTEMA', 'relatorio_falhou',
    jsonb_build_object('relatorio_id', p_id, 'tentativas', v_rel.tentativas));
  return 'falhou';
end;
$$;

-- ------------------------------------------------------------ 9 · Exclusão e limpeza

-- Apaga tudo de uma conta do auditor. Revogação no provedor e cancelamento no Pagar.me
-- acontecem antes, na Edge Function (precisam de rede). Anonimiza a assinatura (guardada 5 anos).
-- O usuário Auth sai junto quando é só cliente do auditor (papel AUDITOR_CLIENT e nenhum outro vínculo).
create or replace function public.auditor_apagar_conta(p_conta_id uuid, p_origem text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_conta public.auditor_contas;
  v_clients uuid[];
  v_exclusao uuid;
  v_usuario int;
begin
  if p_origem not in ('cliente', 'cancelamento', 'inatividade', 'admin') then raise exception 'origem_invalida'; end if;
  select * into v_conta from public.auditor_contas where id = p_conta_id for update;
  if v_conta.id is null then raise exception 'conta_inexistente'; end if;

  select coalesce(array_agg(ac.client_id), '{}') into v_clients
    from public.auditor_clientes ac join public.clients cl on cl.id = ac.client_id and cl.origem = 'auditor'
   where ac.conta_id = v_conta.id;

  insert into public.auditor_exclusoes (origem, conta_id, estado)
  values (p_origem, v_conta.id, 'recebido') returning id into v_exclusao;

  -- B8: também as assinaturas antigas sem conta com o mesmo e-mail do dono (checkout anterior ao login).
  update public.auditor_assinaturas
     set nome = '[excluído]', email = 'excluido+' || id || '@invalid.notechstack', whatsapp = '0000000000', conta_id = null
   where conta_id = v_conta.id
      or (conta_id is null and lower(email) = (select lower(u.email) from auth.users u where u.id = v_conta.dono_user_id));

  delete from public.memberships where client_id = any (v_clients);
  -- Conexões: o trigger da Frente 1 apaga o segredo do Vault junto com a linha.
  delete from public.clients where id = any (v_clients) and origem = 'auditor';
  delete from public.auditor_contas where id = v_conta.id;
  delete from auth.users u
   where u.id = v_conta.dono_user_id and u.raw_app_meta_data ->> 'role' = 'AUDITOR_CLIENT'
     and not exists (select 1 from public.memberships m where m.user_id = u.id);
  get diagnostics v_usuario = row_count;

  update public.auditor_exclusoes set estado = 'concluido', concluido_em = now() where id = v_exclusao;
  perform public.marketing_cliente_evento(c, case when p_origem = 'cliente' then v_conta.dono_user_id end,
          case when p_origem = 'cliente' then 'AUDITOR' else 'SISTEMA' end, 'exclusao_concluida',
          jsonb_build_object('origem', p_origem, 'exclusao_id', v_exclusao))
    from unnest(v_clients) c;

  return jsonb_build_object('exclusao_id', v_exclusao, 'codigo', (select codigo_confirmacao from public.auditor_exclusoes where id = v_exclusao),
                            'usuario_apagado', v_usuario = 1, 'negocios', coalesce(array_length(v_clients, 1), 0));
end;
$$;

-- Retenção (spec, seção 5; D3). Devolve as contagens.
create or replace function public.auditor_limpar(p_agora timestamptz default now())
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_snap int; v_rel int; v_ev int; v_exc int; v_ass int; v_tok int := 0; v_enc int; v_apag int := 0;
  v_falhas int := 0; v_orf int := 0; v_evass int;
  r record;
begin
  delete from public.marketing_cliente_snapshots where periodo_ate < (p_agora - interval '13 months')::date;
  get diagnostics v_snap = row_count;
  delete from public.auditor_relatorios where periodo_ate < (p_agora - interval '13 months')::date;
  get diagnostics v_rel = row_count;

  -- Tokens (D3, revisão A4): conta SEM acesso pago vigente (grátis, checkout abandonado, cobrança recusada sem
  -- pagamento, cancelada) e conexão feita — ou conta encerrada — há mais de 30 dias.
  for r in
    select c.client_id, c.provedor
      from public.marketing_cliente_conexoes c
      join public.auditor_clientes ac on ac.client_id = c.client_id
      join public.auditor_contas ct on ct.id = ac.conta_id
     where c.vault_secret_id is not null and c.estado <> 'desconectado'
       and not public.auditor_conta_com_acesso(ct.id, p_agora)
       and coalesce(ct.encerrada_em, c.conectado_em) < p_agora - interval '30 days'
  loop
    begin
      perform public.marketing_cliente_conexao_encerrar(r.client_id, r.provedor, 'desconectado', null, 'SISTEMA');
      insert into public.auditor_avisos (client_id, tipo, referencia)
      values (r.client_id, 'gratis_tokens_apagados', r.provedor || ':' || p_agora::date)
      on conflict do nothing;
      perform public.marketing_cliente_evento(r.client_id, null, 'SISTEMA', 'token_apagado_retencao', jsonb_build_object('provedor', r.provedor));
      v_tok := v_tok + 1;
    exception when others then
      v_falhas := v_falhas + 1;
      raise warning 'auditor_limpar: token % não apagado (%)', r.client_id, sqlstate;
    end;
  end loop;

  -- Negócios órfãos (usuário apagado por fora antes do gatilho existir): apaga com conexões e Vault.
  delete from public.memberships m using public.clients cl
   where cl.id = m.client_id and cl.origem = 'auditor'
     and not exists (select 1 from public.auditor_clientes ac where ac.client_id = cl.id);
  delete from public.clients cl
   where cl.origem = 'auditor' and not exists (select 1 from public.auditor_clientes ac where ac.client_id = cl.id);
  get diagnostics v_orf = row_count;

  -- Conta grátis sem login há 12 meses: encerra (apaga em 90 dias).
  update public.auditor_contas c
     set encerrada_em = p_agora, excluir_apos = p_agora + interval '90 days'
    from auth.users u
   where u.id = c.dono_user_id and c.encerrada_em is null and c.plano = 'gratis'
     and coalesce(u.last_sign_in_at, c.criada_em) < p_agora - interval '12 months';
  get diagnostics v_enc = row_count;

  for r in
    select c.id, (a.status = 'cancelada') as cancelada
      from public.auditor_contas c left join public.auditor_assinaturas a on a.id = c.assinatura_id
     where c.excluir_apos is not null and c.excluir_apos < p_agora
  loop
    -- B9: uma conta com erro não derruba o job; fica para a próxima rodada.
    begin
      perform public.auditor_apagar_conta(r.id, case when r.cancelada then 'cancelamento' else 'inatividade' end);
      v_apag := v_apag + 1;
    exception when others then
      v_falhas := v_falhas + 1;
      raise warning 'auditor_limpar: conta % não apagada (%)', r.id, sqlstate;
    end;
  end loop;

  delete from public.marketing_cliente_eventos where em < p_agora - interval '12 months';
  get diagnostics v_ev = row_count;
  delete from public.auditor_exclusoes where pedido_em < p_agora - interval '5 years';
  get diagnostics v_exc = row_count;
  delete from public.auditor_assinaturas
   where conta_id is null and status = 'cancelada' and updated_at < p_agora - interval '5 years';
  get diagnostics v_ass = row_count;
  -- Eventos do webhook: 5 anos, como as assinaturas (prazo fiscal, D3).
  delete from public.auditor_assinatura_eventos where recebido_em < p_agora - interval '5 years';
  get diagnostics v_evass = row_count;

  return jsonb_build_object('snapshots', v_snap, 'relatorios', v_rel, 'tokens', v_tok, 'contas_encerradas', v_enc,
    'contas_apagadas', v_apag, 'eventos', v_ev, 'exclusoes', v_exc, 'assinaturas', v_ass,
    'eventos_assinatura', v_evass, 'negocios_orfaos', v_orf, 'falhas', v_falhas);
end;
$$;


-- A4: usuário apagado por fora (painel do Auth) → auditor_contas some em cascata. Antes disso, anonimiza as
-- assinaturas; depois que o negócio some de auditor_clientes, apaga vínculos e o clients do auditor (conexões e
-- Vault vão junto pelos gatilhos da migration A).
create or replace function public.auditor_contas_antes_de_apagar()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update public.auditor_assinaturas
     set nome = '[excluído]', email = 'excluido+' || id || '@invalid.notechstack', whatsapp = '0000000000', conta_id = null
   where conta_id = old.id;
  return old;
end;
$$;
drop trigger if exists auditor_contas_antes_de_apagar on public.auditor_contas;
create trigger auditor_contas_antes_de_apagar before delete on public.auditor_contas
  for each row execute function public.auditor_contas_antes_de_apagar();

create or replace function public.auditor_clientes_depois_de_apagar()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.memberships where client_id = old.client_id;
  delete from public.clients where id = old.client_id and origem = 'auditor';
  return old;
end;
$$;
drop trigger if exists auditor_clientes_depois_de_apagar on public.auditor_clientes;
create trigger auditor_clientes_depois_de_apagar after delete on public.auditor_clientes
  for each row execute function public.auditor_clientes_depois_de_apagar();

revoke all on function public.auditor_contas_antes_de_apagar() from public, anon, authenticated;
revoke all on function public.auditor_clientes_depois_de_apagar() from public, anon, authenticated;

-- ------------------------------------------------------------ 9b · RPCs do próprio cliente (app, com o JWT dele)
-- Agem só sobre auth.uid(); executáveis por authenticated. Erros com código curto para o app.

create or replace function public.auditor_eu()
returns jsonb language sql stable security definer set search_path = ''
as $$
  select case when c.id is null then null else jsonb_build_object(
    'conta_id', c.id, 'plano', c.plano, 'encerrada_em', c.encerrada_em, 'excluir_apos', c.excluir_apos,
    'copia_whatsapp', c.copia_whatsapp, 'copia_whatsapp_numero', c.copia_whatsapp_numero,
    'limite_negocios', case c.plano when 'agencia' then 5 else 1 end,
    'negocios', coalesce((
      select jsonb_agg(jsonb_build_object(
        'client_id', ac.client_id, 'nome', cl.name, 'site_url', ac.site_url,
        'frequencia', case c.plano when 'semanal' then 'semanal' when 'mensal' then 'mensal'
                                   when 'agencia' then coalesce(ac.frequencia, 'semanal') else null end,
        'retrospectiva_gerada_em', ac.retrospectiva_gerada_em,
        'suporte_ate', (select max(s.expira_em) from public.auditor_acessos_suporte s
                         where s.client_id = ac.client_id and s.revogado_em is null and s.expira_em > now()))
        order by ac.criado_em)
      from public.auditor_clientes ac join public.clients cl on cl.id = ac.client_id
      where ac.conta_id = c.id), '[]'::jsonb)) end
  from (select 1) x
  left join public.auditor_contas c on c.dono_user_id = (select auth.uid());
$$;

-- Liga (com o número) ou desliga a cópia por WhatsApp. Desligar apaga o número.
create or replace function public.auditor_eu_copia_whatsapp(p_ativo boolean, p_numero text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_numero text := nullif(regexp_replace(coalesce(p_numero, ''), '[^0-9]', '', 'g'), '');
begin
  if (select auth.uid()) is null then raise exception 'sem_sessao'; end if;
  if p_ativo and (v_numero is null or v_numero !~ '^[0-9]{10,11}$') then raise exception 'numero_invalido'; end if;
  update public.auditor_contas
     set copia_whatsapp = p_ativo,
         copia_whatsapp_numero = case when p_ativo then v_numero else null end,
         copia_whatsapp_em = case when p_ativo then now() else null end
   where dono_user_id = (select auth.uid());
  if not found then raise exception 'conta_inexistente'; end if;
  perform public.marketing_cliente_evento(
    (select ac.client_id from public.auditor_clientes ac join public.auditor_contas c on c.id = ac.conta_id
      where c.dono_user_id = (select auth.uid()) order by ac.criado_em limit 1),
    (select auth.uid()), 'AUDITOR', case when p_ativo then 'copia_whatsapp_ligada' else 'copia_whatsapp_desligada' end, '{}'::jsonb);
end;
$$;

-- Inicia (ou reabre) a conta. Com p_aceite_versao, registra antes o aceite dos Termos do próprio usuário (B3);
-- sem aceite registrado, o primeiro acesso devolve 'aceite_pendente' e o app mostra a caixa.
create or replace function public.auditor_eu_iniciar(p_site_url text default null, p_aceite_versao text default null)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v_email text;
begin
  if (select auth.uid()) is null then raise exception 'sem_sessao'; end if;
  if p_aceite_versao is not null then
    if p_aceite_versao !~ '^[a-z0-9._-]{1,40}$' then raise exception 'aceite_invalido'; end if;
    insert into public.auditor_aceites (user_id, versao) values ((select auth.uid()), p_aceite_versao)
    on conflict do nothing;
  end if;
  select email into v_email from auth.users where id = (select auth.uid());
  perform public.auditor_primeiro_acesso((select auth.uid()), v_email, p_site_url);
  return public.auditor_eu();
end;
$$;

create or replace function public.auditor_eu_suporte(p_client_id uuid, p_conceder boolean, p_motivo text default null)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'sem_sessao'; end if;
  if p_conceder then perform public.auditor_suporte_conceder((select auth.uid()), p_client_id, p_motivo, 72);
  else perform public.auditor_suporte_revogar((select auth.uid()), p_client_id); end if;
end;
$$;

create or replace function public.auditor_eu_retrospectiva(p_client_id uuid)
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'sem_sessao'; end if;
  return public.auditor_retrospectiva_agendar((select auth.uid()), p_client_id);
end;
$$;

create or replace function public.auditor_eu_negocio_criar(p_site_url text, p_nome text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null then raise exception 'sem_sessao'; end if;
  return public.auditor_negocio_criar((select auth.uid()), p_site_url, p_nome);
end;
$$;

create or replace function public.auditor_eu_frequencia(p_client_id uuid, p_frequencia text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_frequencia not in ('semanal', 'mensal') then raise exception 'frequencia_invalida'; end if;
  update public.auditor_clientes ac set frequencia = p_frequencia
    from public.auditor_contas c
   where ac.client_id = p_client_id and c.id = ac.conta_id
     and c.dono_user_id = (select auth.uid()) and c.plano = 'agencia';
  if not found then raise exception 'so_no_plano_agencia'; end if;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.auditor_eu()', 'public.auditor_eu_iniciar(text, text)', 'public.auditor_eu_copia_whatsapp(boolean, text)', 'public.auditor_eu_suporte(uuid, boolean, text)',
    'public.auditor_eu_retrospectiva(uuid)', 'public.auditor_eu_negocio_criar(text, text)', 'public.auditor_eu_frequencia(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end;
$$;


-- ------------------------------------------------------------ 9c · Checkout logado (plan, passo 6)

-- Antes de cobrar: quem é o dono e se já tem assinatura com acesso (evita assinar duas vezes).
create or replace function public.auditor_checkout_preparar(p_user_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'conta_id', c.id,
    'email', (select u.email from auth.users u where u.id = p_user_id),
    'ja_assinante', coalesce(public.auditor_conta_com_acesso(c.id), false),
    -- A2: checkout iniciado há menos de 30 min ainda pendente: não abre outro (evita cobrança duplicada).
    'pendente_recente', exists (select 1 from public.auditor_assinaturas a
                                 where a.conta_id = c.id and a.status = 'pendente' and a.created_at > now() - interval '30 minutes'))
  from public.auditor_contas c where c.dono_user_id = p_user_id;
$$;

-- Depois do registro no Pagar.me: liga a assinatura à conta. Se o webhook 'paga' já chegou, o plano vale na hora.
-- Devolve {anterior}: id no Pagar.me da assinatura que esta substitui (não cancelada), para a função cancelar (A2).
create or replace function public.auditor_assinatura_vincular(p_subscription_id text, p_user_id uuid, p_copia_whatsapp boolean default false)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_conta public.auditor_contas;
  v_ass public.auditor_assinaturas;
  v_anterior text;
begin
  select * into v_conta from public.auditor_contas where dono_user_id = p_user_id for update;
  if v_conta.id is null then raise exception 'conta_inexistente'; end if;
  select * into v_ass from public.auditor_assinaturas where pagarme_subscription_id = p_subscription_id for update;
  if v_ass.id is null then raise exception 'assinatura_inexistente'; end if;
  if v_ass.conta_id is not null and v_ass.conta_id <> v_conta.id then raise exception 'assinatura_de_outra_conta'; end if;
  update public.auditor_contas set assinatura_id = null where assinatura_id = v_ass.id and id <> v_conta.id;
  select a.pagarme_subscription_id into v_anterior from public.auditor_assinaturas a
   where a.id = v_conta.assinatura_id and a.id <> v_ass.id and a.status <> 'cancelada';
  update public.auditor_assinaturas set conta_id = v_conta.id where id = v_ass.id;
  update public.auditor_contas
     set assinatura_id = v_ass.id,
         plano = case when v_ass.status in ('paga', 'recusada') and public.auditor_assinatura_ja_pagou(v_ass.id) then v_ass.plano else plano end,
         encerrada_em = case when v_ass.status = 'paga' then null else encerrada_em end,
         excluir_apos = case when v_ass.status = 'paga' then null else excluir_apos end,
         copia_whatsapp = case when p_copia_whatsapp then true else copia_whatsapp end,
         copia_whatsapp_numero = case when p_copia_whatsapp then v_ass.whatsapp else copia_whatsapp_numero end,
         copia_whatsapp_em = case when p_copia_whatsapp then now() else copia_whatsapp_em end
   where id = v_conta.id;
  perform public.marketing_cliente_evento(
    (select ac.client_id from public.auditor_clientes ac where ac.conta_id = v_conta.id order by ac.criado_em limit 1),
    p_user_id, 'AUDITOR', 'assinatura_vinculada', jsonb_build_object('plano', v_ass.plano, 'substitui_outra', v_anterior is not null));
  return jsonb_build_object('anterior', v_anterior);
end;
$$;

-- Webhook mudou o status da assinatura: o plano da conta acompanha.
--   paga      -> plano da assinatura, conta reaberta
--   cancelada -> conta encerrada; tokens em 30 dias, dados em 90 (D3)
create or replace function public.auditor_assinatura_sincronizar()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.conta_id is null or new.status is not distinct from old.status then return new; end if;
  if new.status = 'paga' then
    update public.auditor_contas set plano = new.plano, encerrada_em = null, excluir_apos = null
     where id = new.conta_id and assinatura_id = new.id;
  elsif new.status = 'cancelada' then
    update public.auditor_contas set encerrada_em = coalesce(encerrada_em, now()), excluir_apos = coalesce(excluir_apos, now() + interval '90 days')
     where id = new.conta_id and assinatura_id = new.id;
  end if;
  return new;
end;
$$;
drop trigger if exists auditor_assinatura_sincronizar on public.auditor_assinaturas;
create trigger auditor_assinatura_sincronizar
  after update of status on public.auditor_assinaturas
  for each row execute function public.auditor_assinatura_sincronizar();

do $$
declare f text;
begin
  foreach f in array array[
    'public.auditor_checkout_preparar(uuid)', 'public.auditor_assinatura_vincular(text, uuid, boolean)', 'public.auditor_assinatura_sincronizar()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if f not like '%sincronizar%' then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end;
$$;

-- Texto final de um relatório para a equipe mandar pelo WhatsApp. Só com o opt-in da conta, só relatório
-- pronto/enviado/parcial, só resumo + prioridades (o mesmo do e-mail), nunca snapshots nem achados.
-- Cada leitura vira 'copia_whatsapp_leu' na trilha. Chamada pela marketing-hub (NO_ADMIN aal2).
create or replace function public.auditor_copia_whatsapp_ler(p_relatorio_id uuid, p_ator uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare v jsonb;
begin
  select jsonb_build_object(
      'relatorio_id', r.id, 'client_id', r.client_id, 'negocio', cl.name, 'tipo', r.tipo,
      'periodo_de', r.periodo_de, 'periodo_ate', r.periodo_ate, 'numero', c.copia_whatsapp_numero,
      'resumo', r.narrativa ->> 'resumo', 'prioridades', coalesce(r.narrativa -> 'prioridades', '[]'::jsonb))
    into v
    from public.auditor_relatorios r
    join public.auditor_clientes ac on ac.client_id = r.client_id
    join public.auditor_contas c on c.id = ac.conta_id
    join public.clients cl on cl.id = r.client_id
   where r.id = p_relatorio_id and c.copia_whatsapp and r.estado in ('pronto', 'enviado', 'parcial') and r.narrativa is not null;
  if v is null then return null; end if;
  perform public.marketing_cliente_evento((v ->> 'client_id')::uuid, p_ator, 'NO_ADMIN', 'copia_whatsapp_leu',
    jsonb_build_object('relatorio_id', p_relatorio_id));
  return v;
end;
$$;
revoke all on function public.auditor_copia_whatsapp_ler(uuid, uuid) from public, anon, authenticated;
grant execute on function public.auditor_copia_whatsapp_ler(uuid, uuid) to service_role;

-- ------------------------------------------------------------ 10 · Operação (NO_ADMIN, sem métricas)

create or replace view public.auditor_operacao
with (security_invoker = true) as
select ac.client_id, cl.name as negocio, ac.site_url, ct.plano, ct.criada_em as conta_criada_em,
       ct.encerrada_em, ct.copia_whatsapp,
       (select coalesce(jsonb_object_agg(c.provedor, jsonb_build_object('estado', c.estado, 'expira_em', c.expira_em)), '{}'::jsonb)
          from public.marketing_cliente_conexoes c where c.client_id = ac.client_id) as conexoes,
       (select jsonb_build_object('id', r.id, 'estado', r.estado, 'tipo', r.tipo, 'periodo_ate', r.periodo_ate, 'erro', r.erro)
          from public.auditor_relatorios r where r.client_id = ac.client_id
          order by r.criado_em desc limit 1) as ultimo_relatorio,
       (select count(*) from public.auditor_relatorios r where r.client_id = ac.client_id and r.estado = 'falhou') as relatorios_falhos
  from public.auditor_clientes ac
  join public.auditor_contas ct on ct.id = ac.conta_id
  join public.clients cl on cl.id = ac.client_id;
revoke all on public.auditor_operacao from public, anon, authenticated;
grant select on public.auditor_operacao to service_role;

-- ------------------------------------------------------------ 11 · Permissões das RPCs e jobs

do $$
declare f text;
begin
  foreach f in array array[
    'public.auditor_acesso_preparar(text, text, text)',
    'public.auditor_assinatura_ja_pagou(uuid)',
    'public.auditor_assinatura_paga_vigente(uuid, timestamptz)',
    'public.auditor_primeiro_acesso(uuid, text, text)',
    'public.auditor_negocio_criar(uuid, text, text)',
    'public.auditor_suporte_conceder(uuid, uuid, text, integer)',
    'public.auditor_suporte_revogar(uuid, uuid)',
    'public.auditor_conta_com_acesso(uuid, timestamptz)',
    'public.auditor_planejar_relatorios(timestamptz)',
    'public.auditor_retrospectiva_agendar(uuid, uuid, timestamptz)',
    'public.auditor_claim_relatorios(integer)',
    'public.auditor_relatorio_falha(uuid, text, boolean)',
    'public.auditor_apagar_conta(uuid, text)',
    'public.auditor_limpar(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- Processamento: chama marketing-hub /internal/auditor/processar (mesma URL e segredo do Vault
-- usados por marketing_invoke_publish_due). Sem URL ou segredo, não faz nada.
create or replace function public.auditor_invoke_processar()
returns bigint language plpgsql security definer set search_path = ''
as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'marketing_hub_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'MARKETING_CRON_SECRET';
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then return null; end if;
  if not exists (select 1 from public.auditor_relatorios where estado = 'agendado' and executar_em <= now())
     and not exists (select 1 from public.auditor_avisos where enviado_em is null) then
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/internal/auditor/processar',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 150000
  );
end;
$$;
revoke all on function public.auditor_invoke_processar() from public, anon, authenticated;

-- Os jobs do pg_cron ficam na 20261021140000_auditor_agendamento.sql, aplicada só quando houver
-- cliente real conectado (decisão do orquestrador, 21/10).
