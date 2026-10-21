-- Migration A do auditor por cliente (spec 2026-10-21-auditor-conexoes-clientes, seção 3, itens 1–5):
-- identidade (clients.origem, memberships AUDITOR) e conexões Meta/Google por cliente.
-- O token mora só no Supabase Vault; a tabela guarda o id do segredo, que nenhum papel
-- do navegador lê. Toda escrita passa por RPC executável só pela service role.
-- A migration B (Frente 3) acrescenta contas, relatórios, suporte e exclusões, e troca
-- `auditor_pode_ler` para incluir o acesso de suporte vigente.

-- ---------------------------------------------------------------- Identidade

alter table public.clients add column origem text not null default 'projeto'
  check (origem in ('projeto', 'auditor', 'interno'));
update public.clients set origem = 'interno' where slug = 'no-tech-stack';

alter table public.memberships drop constraint memberships_role_check,
  add constraint memberships_role_check check (role in ('CLIENT', 'AUDITOR'));

-- ------------------------------------------------------------------ Tabelas

create table public.marketing_cliente_conexoes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  provedor text not null check (provedor in ('meta', 'google')),
  estado text not null check (estado in ('conectado', 'expirado', 'revogado', 'erro', 'desconectado')),
  escopos text[] not null default '{}',
  usuario_externo text check (char_length(usuario_externo) <= 100), -- id na Meta (deauthorize e exclusão)
  expira_em timestamptz,                                            -- null = sem expiração
  vault_secret_id uuid,                                             -- null depois de apagar
  conectado_por uuid references auth.users(id) on delete set null,
  conectado_em timestamptz not null default now(),
  verificado_em timestamptz,                                        -- última chamada bem-sucedida
  ultimo_erro text check (ultimo_erro ~ '^[a-z0-9_]{1,60}$'),       -- só código, nunca token nem resposta crua
  encerrado_em timestamptz,
  constraint marketing_cliente_conexoes_token check (estado <> 'conectado' or vault_secret_id is not null)
);
-- Uma conexão viva por (cliente, provedor); as desconectadas ficam como histórico.
create unique index marketing_cliente_conexoes_viva on public.marketing_cliente_conexoes (client_id, provedor)
  where estado <> 'desconectado';
create index marketing_cliente_conexoes_usuario on public.marketing_cliente_conexoes (provedor, usuario_externo)
  where usuario_externo is not null;

create table public.marketing_cliente_ativos (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  conexao_id uuid not null references public.marketing_cliente_conexoes(id) on delete cascade,
  tipo text not null check (tipo in ('meta_ads', 'google_ads', 'ga4', 'gsc')),
  external_id text not null check (char_length(external_id) between 1 and 300),
  nome text check (char_length(nome) <= 300),
  login_customer_id text check (login_customer_id ~ '^\d{1,20}$'),
  moeda text check (char_length(moeda) <= 10),
  detalhe text check (char_length(detalhe) <= 300),
  selecionado_por uuid references auth.users(id) on delete set null,
  selecionado_em timestamptz not null default now(),
  unique (client_id, tipo),
  check (tipo = 'google_ads' or login_customer_id is null),
  check (tipo <> 'meta_ads' or external_id ~ '^act_\d{1,30}$')
);

-- Trilha: sem FK em client_id para sobreviver à exclusão do negócio. Nunca token, e-mail ou métrica.
create table public.marketing_cliente_eventos (
  id bigint generated always as identity primary key,
  client_id uuid,
  ator_user_id uuid,
  ator_papel text,
  acao text not null check (acao ~ '^[a-z_]{1,40}$'),
  detalhe jsonb not null default '{}'::jsonb,
  em timestamptz not null default now()
);
create index marketing_cliente_eventos_cliente on public.marketing_cliente_eventos (client_id, em desc);

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

-- Membro AUDITOR do negócio. A migration B acrescenta: ou NO_ADMIN aal2 com acesso de suporte vigente.
create or replace function public.auditor_pode_ler(p_client_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.client_id = p_client_id and m.role = 'AUDITOR'
  );
$$;
revoke all on function public.auditor_pode_ler(uuid) from public, anon;
grant execute on function public.auditor_pode_ler(uuid) to authenticated, service_role;

-- Só leitura e só colunas sem segredo. Eventos e nonces: nenhum grant ao navegador.
grant select (id, client_id, provedor, estado, escopos, expira_em, conectado_em, verificado_em, ultimo_erro, encerrado_em)
  on public.marketing_cliente_conexoes to authenticated;
grant select (id, client_id, conexao_id, tipo, external_id, nome, login_customer_id, moeda, detalhe, selecionado_em)
  on public.marketing_cliente_ativos to authenticated;

create policy marketing_cliente_conexoes_ler on public.marketing_cliente_conexoes
  for select to authenticated using (public.auditor_pode_ler(client_id));
create policy marketing_cliente_ativos_ler on public.marketing_cliente_ativos
  for select to authenticated using (public.auditor_pode_ler(client_id));

-- -------------------------------------------------------------------- RPCs

create or replace function public.marketing_cliente_evento(p_client_id uuid, p_ator uuid, p_papel text, p_acao text, p_detalhe jsonb)
returns void language sql security definer set search_path = ''
as $$
  insert into public.marketing_cliente_eventos (client_id, ator_user_id, ator_papel, acao, detalhe)
  values (p_client_id, p_ator, p_papel, p_acao, coalesce(p_detalhe, '{}'::jsonb));
$$;

-- Tipos de ativo de cada provedor.
create or replace function public.marketing_cliente_tipos(p_provedor text)
returns text[] language sql immutable set search_path = ''
as $$
  select case p_provedor when 'meta' then array['meta_ads'] when 'google' then array['google_ads', 'ga4', 'gsc'] else array[]::text[] end;
$$;

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

create or replace function public.marketing_cliente_token_ler(p_client_id uuid, p_provedor text)
returns table (token text, escopos text[]) language sql stable security definer set search_path = ''
as $$
  select s.decrypted_secret, c.escopos
  from public.marketing_cliente_conexoes c
  join vault.decrypted_secrets s on s.id = c.vault_secret_id
  where c.client_id = p_client_id and c.provedor = p_provedor and c.estado = 'conectado';
$$;

-- Leitura que deu certo (verificado_em) ou token recusado pelo provedor (expirado/erro, só código).
create or replace function public.marketing_cliente_conexao_marcar(p_client_id uuid, p_provedor text, p_estado text, p_codigo text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_estado = 'verificado' then
    update public.marketing_cliente_conexoes set verificado_em = now()
    where client_id = p_client_id and provedor = p_provedor and estado = 'conectado';
    return;
  end if;
  if p_estado not in ('expirado', 'erro') then raise exception 'estado inválido'; end if;
  update public.marketing_cliente_conexoes set estado = p_estado, ultimo_erro = p_codigo
  where client_id = p_client_id and provedor = p_provedor and estado = 'conectado';
  if found then
    perform public.marketing_cliente_evento(p_client_id, null, 'SISTEMA', case p_estado when 'expirado' then 'expirou' else 'erro' end,
      jsonb_build_object('provedor', p_provedor, 'codigo', p_codigo));
  end if;
end;
$$;

-- Encerra a conexão viva: apaga o segredo do Vault e as contas escolhidas.
--   desconectado = o próprio cliente desconectou; revogado = o provedor avisou (deauthorize).
create or replace function public.marketing_cliente_conexao_encerrar(
  p_client_id uuid, p_provedor text, p_estado text, p_user_id uuid, p_papel text
)
returns boolean language plpgsql security definer set search_path = ''
as $$
declare atual public.marketing_cliente_conexoes;
begin
  if p_estado not in ('desconectado', 'revogado') then raise exception 'estado inválido'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('marketing_cliente:' || p_client_id || ':' || p_provedor));
  select * into atual from public.marketing_cliente_conexoes
  where client_id = p_client_id and provedor = p_provedor and estado <> 'desconectado';
  delete from vault.secrets where id = atual.vault_secret_id or name = 'marketing_cliente:' || p_client_id || ':' || p_provedor;
  if atual.id is null or (atual.estado = 'revogado' and p_estado = 'revogado') then return false; end if;
  delete from public.marketing_cliente_ativos where conexao_id = atual.id;
  update public.marketing_cliente_conexoes
  set estado = p_estado, vault_secret_id = null, escopos = '{}', encerrado_em = now()
  where id = atual.id;
  perform public.marketing_cliente_evento(p_client_id, p_user_id, p_papel,
    case p_estado when 'desconectado' then 'desconectou' else 'revogou' end, jsonb_build_object('provedor', p_provedor));
  return true;
end;
$$;

-- Deauthorize da Meta: o usuário removeu o app; encerra todas as conexões vivas dele.
create or replace function public.marketing_meta_desautorizar(p_usuario_externo text)
returns integer language plpgsql security definer set search_path = ''
as $$
declare c record; n integer := 0;
begin
  for c in select client_id from public.marketing_cliente_conexoes
    where provedor = 'meta' and usuario_externo = p_usuario_externo and estado <> 'desconectado' loop
    if public.marketing_cliente_conexao_encerrar(c.client_id, 'meta', 'revogado', null, 'META') then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- Grava as escolhas (1 por tipo). Os tipos precisam ser do provedor da conexão.
create or replace function public.marketing_cliente_ativos_salvar(p_client_id uuid, p_provedor text, p_ativos jsonb, p_user_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare a jsonb; conexao uuid;
begin
  select id into conexao from public.marketing_cliente_conexoes
  where client_id = p_client_id and provedor = p_provedor and estado = 'conectado';
  if conexao is null then raise exception 'conexão ausente'; end if;
  for a in select * from jsonb_array_elements(p_ativos) loop
    if not ((a->>'tipo') = any (public.marketing_cliente_tipos(p_provedor))) then
      raise exception 'tipo fora do provedor';
    end if;
    insert into public.marketing_cliente_ativos (client_id, conexao_id, tipo, external_id, nome, login_customer_id, moeda, detalhe, selecionado_por)
    values (p_client_id, conexao, a->>'tipo', a->>'external_id', a->>'nome', a->>'login_customer_id', a->>'moeda', a->>'detalhe', p_user_id)
    on conflict (client_id, tipo) do update set
      conexao_id = excluded.conexao_id, external_id = excluded.external_id, nome = excluded.nome,
      login_customer_id = excluded.login_customer_id, moeda = excluded.moeda, detalhe = excluded.detalhe,
      selecionado_por = excluded.selecionado_por, selecionado_em = now();
  end loop;
  perform public.marketing_cliente_evento(p_client_id, p_user_id, 'AUDITOR', 'selecionou',
    jsonb_build_object('provedor', p_provedor, 'tipos', (select jsonb_agg(x->>'tipo') from jsonb_array_elements(p_ativos) x)));
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

-- Negócio apagado (LGPD): o segredo sai do Vault junto com a linha.
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
    'public.marketing_cliente_evento(uuid, uuid, text, text, jsonb)',
    'public.marketing_cliente_tipos(text)',
    'public.marketing_cliente_conexao_salvar(uuid, text, text, text[], timestamptz, text, uuid)',
    'public.marketing_cliente_token_ler(uuid, text)',
    'public.marketing_cliente_conexao_marcar(uuid, text, text, text)',
    'public.marketing_cliente_conexao_encerrar(uuid, text, text, uuid, text)',
    'public.marketing_meta_desautorizar(text)',
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
