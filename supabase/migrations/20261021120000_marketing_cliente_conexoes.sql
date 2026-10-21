-- Conexões Meta/Google por cliente do auditor ("Conectar com Facebook/Google").
-- Modelo PROVISÓRIO da Frente 1 até a spec da Frente 3 (ver .tasks/auditor-conexoes.md).
-- O token mora só no Supabase Vault; a tabela guarda o id do segredo, que nenhum papel
-- do navegador lê. Toda escrita passa pela service role da Edge Function marketing-hub.

create table public.marketing_cliente_conexoes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  provedor text not null check (provedor in ('meta', 'google')),
  estado text not null check (estado in ('conectado', 'expirado', 'revogado', 'erro')),
  escopos text[] not null default '{}',
  expira_em timestamptz,
  usuario_externo text check (char_length(usuario_externo) <= 100),
  vault_secret_id uuid,
  conectado_por uuid references auth.users(id) on delete set null,
  conectado_em timestamptz,
  revogado_em timestamptz,
  ultimo_erro text check (char_length(ultimo_erro) <= 500),
  atualizado_em timestamptz not null default now(),
  unique (client_id, provedor),
  constraint marketing_cliente_conexoes_token check (estado <> 'conectado' or vault_secret_id is not null)
);

-- Uma conta escolhida por tipo; os adaptadores do hub leem uma conta por vez.
create table public.marketing_cliente_ativos (
  client_id uuid not null references public.clients(id) on delete cascade,
  tipo text not null check (tipo in ('meta_ads', 'google_ads', 'ga4', 'gsc')),
  external_id text not null check (char_length(external_id) between 1 and 300),
  nome text check (char_length(nome) <= 300),
  login_customer_id text check (login_customer_id ~ '^\d{1,20}$'),
  selecionado_por uuid references auth.users(id) on delete set null,
  selecionado_em timestamptz not null default now(),
  primary key (client_id, tipo),
  check (tipo = 'google_ads' or login_customer_id is null),
  check (tipo <> 'meta_ads' or external_id ~ '^act_\d{1,30}$')
);

-- Trilha para LGPD: quem conectou, escolheu, revogou; nunca o token.
create table public.marketing_cliente_eventos (
  id bigint generated always as identity primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  provedor text not null check (provedor in ('meta', 'google')),
  evento text not null check (evento in ('conectou', 'reconectou', 'selecionou', 'revogou', 'expirou', 'erro')),
  ator uuid references auth.users(id) on delete set null,
  detalhe jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now()
);
create index marketing_cliente_eventos_cliente on public.marketing_cliente_eventos (client_id, criado_em desc);

-- Nonce de uso único do state OAuth (10 min).
create table public.marketing_oauth_nonces (
  nonce text primary key check (nonce ~ '^[a-f0-9]{64}$'),
  expira_em timestamptz not null
);

-- ------------------------------------------------------------------ Acesso

alter table public.marketing_cliente_conexoes enable row level security;
alter table public.marketing_cliente_ativos enable row level security;
alter table public.marketing_cliente_eventos enable row level security;
alter table public.marketing_oauth_nonces enable row level security;

revoke all on public.marketing_cliente_conexoes, public.marketing_cliente_ativos,
  public.marketing_cliente_eventos, public.marketing_oauth_nonces from public, anon, authenticated;

-- Membro do cliente (memberships, padrão R1) ou NO_ADMIN.
create or replace function public.marketing_cliente_membro(p_client_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select public.is_no_admin() or exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.client_id = p_client_id
  );
$$;
revoke all on function public.marketing_cliente_membro(uuid) from public, anon;
grant execute on function public.marketing_cliente_membro(uuid) to authenticated, service_role;

-- Só leitura, só colunas sem segredo (vault_secret_id e usuario_externo ficam de fora).
grant select (id, client_id, provedor, estado, escopos, expira_em, conectado_em, revogado_em, ultimo_erro, atualizado_em)
  on public.marketing_cliente_conexoes to authenticated;
grant select (client_id, tipo, external_id, nome, selecionado_em) on public.marketing_cliente_ativos to authenticated;
grant select (id, client_id, provedor, evento, criado_em) on public.marketing_cliente_eventos to authenticated;

create policy marketing_cliente_conexoes_membro on public.marketing_cliente_conexoes
  for select to authenticated using ((select public.marketing_cliente_membro(client_id)));
create policy marketing_cliente_ativos_membro on public.marketing_cliente_ativos
  for select to authenticated using ((select public.marketing_cliente_membro(client_id)));
create policy marketing_cliente_eventos_membro on public.marketing_cliente_eventos
  for select to authenticated using ((select public.marketing_cliente_membro(client_id)));

-- ---------------------------------------------------------- Vault (RPCs)

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
  -- Quem iniciou pode ter perdido o acesso enquanto estava no provedor.
  if not exists (
    select 1 from auth.users u where u.id = p_user_id and (u.banned_until is null or u.banned_until <= now())
      and (u.raw_app_meta_data->>'role' = 'NO_ADMIN'
        or exists (select 1 from public.memberships m where m.user_id = u.id and m.client_id = p_client_id))
  ) then
    raise exception 'autor não autorizado para este cliente';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(nome_segredo));
  select * into atual from public.marketing_cliente_conexoes where client_id = p_client_id and provedor = p_provedor;

  select id into segredo from vault.secrets where id = atual.vault_secret_id;
  if segredo is null then
    delete from vault.secrets where name = nome_segredo; -- sobra de revogação interrompida
    segredo := vault.create_secret(p_token, nome_segredo, 'Token OAuth do cliente (marketing-hub)');
  else
    perform vault.update_secret(segredo, p_token);
  end if;

  -- Outra conta do provedor: as escolhas antigas não valem para o token novo.
  if atual.id is not null and atual.usuario_externo is distinct from p_usuario_externo then
    delete from public.marketing_cliente_ativos
    where client_id = p_client_id
      and tipo = any (case p_provedor when 'meta' then array['meta_ads'] else array['google_ads', 'ga4', 'gsc'] end);
  end if;

  insert into public.marketing_cliente_conexoes as c
    (client_id, provedor, estado, escopos, expira_em, usuario_externo, vault_secret_id, conectado_por, conectado_em, revogado_em, ultimo_erro, atualizado_em)
  values (p_client_id, p_provedor, 'conectado', coalesce(p_escopos, '{}'), p_expira_em, p_usuario_externo, segredo, p_user_id, now(), null, null, now())
  on conflict (client_id, provedor) do update set
    estado = 'conectado', escopos = excluded.escopos, expira_em = excluded.expira_em,
    usuario_externo = excluded.usuario_externo, vault_secret_id = excluded.vault_secret_id,
    conectado_por = excluded.conectado_por, conectado_em = now(), revogado_em = null, ultimo_erro = null, atualizado_em = now();

  insert into public.marketing_cliente_eventos (client_id, provedor, evento, ator, detalhe)
  values (p_client_id, p_provedor, case when atual.id is null then 'conectou' else 'reconectou' end, p_user_id,
    jsonb_build_object('escopos', coalesce(p_escopos, '{}'), 'expira_em', p_expira_em));
end;
$$;

create or replace function public.marketing_cliente_token_ler(p_client_id uuid, p_provedor text)
returns table (token text, escopos text[]) language sql stable security definer set search_path = ''
as $$
  select s.decrypted_secret, c.escopos
  from public.marketing_cliente_conexoes c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.client_id = p_client_id and c.provedor = p_provedor and c.estado = 'conectado';
$$;

create or replace function public.marketing_cliente_conexao_marcar(p_client_id uuid, p_provedor text, p_estado text, p_erro text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_estado not in ('expirado', 'erro') then raise exception 'estado inválido'; end if;
  update public.marketing_cliente_conexoes
  set estado = p_estado, ultimo_erro = left(p_erro, 500), atualizado_em = now()
  where client_id = p_client_id and provedor = p_provedor and estado = 'conectado';
  if found then
    insert into public.marketing_cliente_eventos (client_id, provedor, evento, detalhe)
    values (p_client_id, p_provedor, case p_estado when 'expirado' then 'expirou' else 'erro' end, jsonb_build_object('erro', left(p_erro, 500)));
  end if;
end;
$$;

-- Apaga o segredo do Vault e as contas escolhidas; a linha fica como trilha (estado revogado).
create or replace function public.marketing_cliente_conexao_revogar(p_client_id uuid, p_provedor text, p_user_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare atual public.marketing_cliente_conexoes;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('marketing_cliente:' || p_client_id || ':' || p_provedor));
  select * into atual from public.marketing_cliente_conexoes where client_id = p_client_id and provedor = p_provedor;
  delete from vault.secrets where id = atual.vault_secret_id or name = 'marketing_cliente:' || p_client_id || ':' || p_provedor;
  delete from public.marketing_cliente_ativos
  where client_id = p_client_id
    and tipo = any (case p_provedor when 'meta' then array['meta_ads'] else array['google_ads', 'ga4', 'gsc'] end);
  if atual.id is null or atual.estado = 'revogado' then return; end if;
  update public.marketing_cliente_conexoes
  set estado = 'revogado', vault_secret_id = null, escopos = '{}', revogado_em = now(), atualizado_em = now()
  where id = atual.id;
  insert into public.marketing_cliente_eventos (client_id, provedor, evento, ator)
  values (p_client_id, p_provedor, 'revogou', p_user_id);
end;
$$;

create or replace function public.marketing_cliente_ativos_salvar(p_client_id uuid, p_provedor text, p_ativos jsonb, p_user_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare a jsonb;
begin
  if not exists (select 1 from public.marketing_cliente_conexoes
    where client_id = p_client_id and provedor = p_provedor and estado = 'conectado') then
    raise exception 'conexão ausente';
  end if;
  for a in select * from jsonb_array_elements(p_ativos) loop
    if (a->>'tipo') <> all (case p_provedor when 'meta' then array['meta_ads'] else array['google_ads', 'ga4', 'gsc'] end) then
      raise exception 'tipo fora do provedor';
    end if;
    insert into public.marketing_cliente_ativos (client_id, tipo, external_id, nome, login_customer_id, selecionado_por, selecionado_em)
    values (p_client_id, a->>'tipo', a->>'external_id', a->>'nome', a->>'login_customer_id', p_user_id, now())
    on conflict (client_id, tipo) do update set
      external_id = excluded.external_id, nome = excluded.nome, login_customer_id = excluded.login_customer_id,
      selecionado_por = excluded.selecionado_por, selecionado_em = now();
  end loop;
  insert into public.marketing_cliente_eventos (client_id, provedor, evento, ator, detalhe)
  values (p_client_id, p_provedor, 'selecionou', p_user_id,
    jsonb_build_object('tipos', (select jsonb_agg(x->>'tipo') from jsonb_array_elements(p_ativos) x)));
end;
$$;

create or replace function public.marketing_oauth_nonce_registrar(p_nonce text, p_expira_em timestamptz)
returns void language sql security definer set search_path = ''
as $$
  delete from public.marketing_oauth_nonces where expira_em < now();
  insert into public.marketing_oauth_nonces (nonce, expira_em) values (p_nonce, least(p_expira_em, now() + interval '15 minutes'));
$$;

create or replace function public.marketing_oauth_nonce_consumir(p_nonce text)
returns boolean language sql security definer set search_path = ''
as $$
  with usado as (
    delete from public.marketing_oauth_nonces where nonce = p_nonce returning expira_em
  )
  select coalesce((select expira_em > now() from usado), false);
$$;

-- Cliente apagado (LGPD): o segredo sai do Vault junto com a linha.
create or replace function public.marketing_cliente_conexoes_apagar_segredo()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.vault_secret_id is not null then delete from vault.secrets where id = old.vault_secret_id; end if;
  return old;
end;
$$;
create trigger marketing_cliente_conexoes_apagar_segredo
  after delete on public.marketing_cliente_conexoes
  for each row execute function public.marketing_cliente_conexoes_apagar_segredo();

do $$
declare f text;
begin
  foreach f in array array[
    'public.marketing_cliente_conexao_salvar(uuid, text, text, text[], timestamptz, text, uuid)',
    'public.marketing_cliente_token_ler(uuid, text)',
    'public.marketing_cliente_conexao_marcar(uuid, text, text, text)',
    'public.marketing_cliente_conexao_revogar(uuid, text, uuid)',
    'public.marketing_cliente_ativos_salvar(uuid, text, jsonb, uuid)',
    'public.marketing_oauth_nonce_registrar(text, timestamptz)',
    'public.marketing_oauth_nonce_consumir(text)',
    'public.marketing_cliente_conexoes_apagar_segredo()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if f not like '%apagar_segredo%' then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end;
$$;
