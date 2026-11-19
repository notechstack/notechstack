-- nó.fiscal: módulo Guias (disparo de guias de impostos, honorários e parcelamentos), MVP de 19/11/2026.
-- Design: .design/agente-fiscal-disparo-guias.md § 3; task: .tasks/agente-fiscal-disparo-guias.md.
--
-- O escritório (conta-mãe de plano escritorio_*) sobe os PDFs das guias, o motor lê de quem é cada uma (CNPJ/CPF,
-- tipo, competência, valor, vencimento, linha digitável), o escritório confere e dispara, e o cliente recebe pelo
-- WhatsApp (modelo de utilidade com o PDF) e por e-mail, com lembrete e registro de entregue, lida, baixada e "paguei".
--
-- Entra (schema nofiscal, só o papel nofiscal_service, RLS ligada):
--   fiscal_addons   módulo vendido à parte por conta-mãe (produto 'guias', faixa, limite de guias/mês).
--   guia_contatos   clientes que recebem guia (≠ empresas emitentes: sem A1 nem dados fiscais), com aceite e "SAIR".
--   guia_lotes      um upload de PDFs.
--   guias           uma guia (um PDF), com a leitura, a conferência e o andamento.
--   guia_envios     cada mensagem (WhatsApp ou e-mail) de envio, lembrete ou 2ª via, com a marca da Meta.
--   guia_regras     lembretes, hora, e-mail de alerta e assinatura (nome do escritório) por conta.
--
-- Posse: o painel roda cada pedido numa transação com set_config('nofiscal.guias_usuario', <user id>, true); as
-- políticas só deixam ver e mexer nas linhas das contas que nofiscal.usuario_pode_tenant libera a esse usuário. Sem
-- o ajuste (worker e webhook, que não têm usuário), o papel vê tudo, como nas outras tabelas do nofiscal.
-- Ligar o módulo: public.fiscal_definir_modulo_guias(conta_mae, ligado, limite_mes), EXECUTE só service_role.
-- Bucket privado fiscal-guias (PDFs), criado aqui quando o Storage existe; upload por URL assinada, nunca pela Vercel.

-- ------------------------------------------------------------ Tabelas

create table nofiscal.fiscal_addons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete cascade,
  produto text not null check (produto in ('guias')),
  faixa text not null default 'piloto' check (faixa in ('piloto', 'guias_500', 'guias_1500', 'guias_4000', 'sob_medida')),
  limite_mes integer not null check (limite_mes between 1 and 100000),
  pagarme_subscription_id text,
  status text not null default 'ativo' check (status in ('ativo', 'desligado')),
  fundador_ate date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, produto)
);
comment on table nofiscal.fiscal_addons is
  'Módulos vendidos à parte por conta-mãe de escritório. Ligar/desligar só por public.fiscal_definir_modulo_guias.';

create table nofiscal.guia_contatos (
  id uuid primary key default gen_random_uuid(),
  escritorio_tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete cascade,
  documento text not null check (documento ~ '^(\d{11}|\d{14})$'),
  nome text not null check (length(nome) between 1 and 200),
  whatsapps text[] not null default '{}' check (array_length(whatsapps, 1) is null or array_length(whatsapps, 1) <= 5),
  emails text[] not null default '{}' check (array_length(emails, 1) is null or array_length(emails, 1) <= 5),
  -- Vínculo opcional com a empresa que também emite pela nó.
  tenant_id uuid references nofiscal.fiscal_tenants(id) on delete set null,
  aceite_em timestamptz,
  aceite_origem text check (aceite_origem is null or length(aceite_origem) between 1 and 200),
  sair_whatsapp_em timestamptz,
  sair_email_em timestamptz,
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (escritorio_tenant_id, documento)
);
create index guia_contatos_whatsapps_idx on nofiscal.guia_contatos using gin (whatsapps);

create table nofiscal.guia_lotes (
  id uuid primary key default gen_random_uuid(),
  escritorio_tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete cascade,
  criado_por uuid,
  total_arquivos integer not null check (total_arquivos between 1 and 500),
  lidos integer not null default 0,
  com_problema integer not null default 0,
  status text not null default 'enviando' check (status in ('enviando', 'lendo', 'conferir', 'disparado', 'cancelado')),
  criado_em timestamptz not null default now()
);
create index guia_lotes_conta_idx on nofiscal.guia_lotes (escritorio_tenant_id, criado_em desc);

create table nofiscal.guias (
  id uuid primary key default gen_random_uuid(),
  escritorio_tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete cascade,
  contato_id uuid references nofiscal.guia_contatos(id) on delete set null,
  lote_id uuid not null references nofiscal.guia_lotes(id) on delete cascade,
  tipo text check (tipo in ('das', 'das_mei', 'darf', 'dctfweb', 'fgts', 'iss', 'parcelamento', 'honorario', 'outro')),
  -- CNPJ/CPF lido do PDF (ou corrigido na conferência): é por ele que a guia casa com o contato.
  documento text check (documento is null or documento ~ '^(\d{11}|\d{14})$'),
  competencia date check (competencia is null or extract(day from competencia) = 1),
  valor_centavos bigint check (valor_centavos is null or valor_centavos between 1 and 99999999999),
  vencimento date,
  linha_digitavel text check (linha_digitavel is null or linha_digitavel ~ '^\d{47,48}$'),
  pix_copia_cola text check (pix_copia_cola is null or length(pix_copia_cola) <= 512),
  pdf_path text not null check (length(pdf_path) between 1 and 300),
  pdf_nome text not null default 'guia.pdf' check (length(pdf_nome) between 1 and 200),
  -- {campos: {...}, origem: {campo: 'regra'|'ia'|'manual'}, faltando: [...], valor_divergente: bool, ...}
  leitura jsonb not null default '{}'::jsonb,
  leitura_iniciada_em timestamptz,
  status text not null default 'enviando' check (status in (
    'enviando', 'lendo', 'conferir', 'agendada', 'falhou', 'enviada', 'entregue', 'lida', 'baixada',
    'paga_informada', 'paga', 'vencida', 'cancelada')),
  agendada_para timestamptz,
  enviada_em timestamptz,
  baixada_em timestamptz,
  pago_em timestamptz,
  pago_origem text check (pago_origem is null or pago_origem in ('whatsapp', 'comprovante', 'escritorio', 'link')),
  lembretes_enviados integer not null default 0 check (lembretes_enviados between 0 and 2),
  -- sha256 hex do token do link /g/<token> (o token nunca é guardado).
  link_token_hash text unique,
  link_expira_em timestamptz,
  ultima_resposta text check (ultima_resposta is null or length(ultima_resposta) <= 1000),
  ultima_resposta_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lote_id, pdf_path)
);
create index guias_conta_idx on nofiscal.guias (escritorio_tenant_id, created_at desc);
create index guias_status_idx on nofiscal.guias (status, agendada_para);
create index guias_contato_idx on nofiscal.guias (contato_id);

create table nofiscal.guia_envios (
  id uuid primary key default gen_random_uuid(),
  guia_id uuid not null references nofiscal.guias(id) on delete cascade,
  escritorio_tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete cascade,
  canal text not null check (canal in ('whatsapp', 'email')),
  destino text not null check (length(destino) between 3 and 254),
  motivo text not null check (motivo in ('envio', 'lembrete', 'segunda_via')),
  modelo text,
  -- Chave de idempotência: a mesma (guia, canal, destino, motivo, dia) nunca sai duas vezes.
  chave text not null unique check (length(chave) between 1 and 300),
  id_externo text,
  status text not null default 'pendente' check (status in ('pendente', 'enviada', 'entregue', 'lida', 'falhou')),
  enviado_em timestamptz,
  entregue_em timestamptz,
  lido_em timestamptz,
  erro text check (erro is null or length(erro) <= 500),
  created_at timestamptz not null default now()
);
create index guia_envios_guia_idx on nofiscal.guia_envios (guia_id);
create index guia_envios_externo_idx on nofiscal.guia_envios (id_externo) where id_externo is not null;
create index guia_envios_teto_idx on nofiscal.guia_envios (canal, enviado_em);

create table nofiscal.guia_regras (
  escritorio_tenant_id uuid primary key references nofiscal.fiscal_tenants(id) on delete cascade,
  lembrete_dias integer[] not null default '{-1,0}' check (lembrete_dias <@ array[-3, -2, -1, 0]),
  hora_envio smallint not null default 9 check (hora_envio between 6 and 20),
  email_alerta text check (email_alerta is null or email_alerta ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  assinatura text not null check (length(assinatura) between 1 and 80),
  -- Número do escritório para o "Falar com o escritório" (wa.me), em E.164.
  whatsapp_escritorio text check (whatsapp_escritorio is null or whatsapp_escritorio ~ '^\+\d{10,15}$'),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------ Funções de apoio

-- O painel liga o filtro de posse com set_config('nofiscal.guias_usuario', <user id>, true). Sem ele (worker,
-- webhook), vale tudo, como nas outras tabelas do nofiscal.
create function nofiscal.guias_acesso(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when coalesce(current_setting('nofiscal.guias_usuario', true), '') = '' then true
    else nofiscal.usuario_pode_tenant(current_setting('nofiscal.guias_usuario', true)::uuid, p_tenant_id)
  end;
$$;

create function nofiscal.guias_ligado(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from nofiscal.fiscal_addons a
                  where a.tenant_id = p_tenant_id and a.produto = 'guias' and a.status = 'ativo');
$$;

-- Conta-mãe de escritório do usuário com o módulo ligado; null se não houver.
create function nofiscal.guias_conta_do_usuario(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
    from nofiscal.fiscal_tenants t
   where t.id = nofiscal.escritorio_do_usuario(p_user_id)
     and t.escritorio_tenant_id is null
     and nofiscal.usuario_pode_tenant(p_user_id, t.id)
     and nofiscal.guias_ligado(t.id);
$$;

-- Ordem do andamento: marca nova (entregue, lida, baixada…) só sobe, nunca desce.
create function nofiscal.guia_status_ordem(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'enviando' then 0 when 'lendo' then 1 when 'conferir' then 2 when 'agendada' then 3 when 'falhou' then 4
    when 'enviada' then 5 when 'entregue' then 6 when 'lida' then 7 when 'baixada' then 8
    when 'paga_informada' then 9 when 'paga' then 10 when 'vencida' then 11 when 'cancelada' then 12
    else -1 end;
$$;

-- Cor da conferência. vermelho: sem contato ativo com canal (WhatsApp ou e-mail sem "SAIR"). amarelo: faltou campo
-- ou o valor do texto não bate com o do código de barras. verde: casou o CNPJ e leu tudo.
create function nofiscal.guia_cor(p_guia_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when c.id is null or not c.ativo
      or ((cardinality(c.whatsapps) = 0 or c.sair_whatsapp_em is not null)
          and (cardinality(c.emails) = 0 or c.sair_email_em is not null)) then 'vermelho'
    when g.tipo is null or g.documento is null or g.valor_centavos is null or g.vencimento is null
      or (g.linha_digitavel is null and g.pix_copia_cola is null)
      or (g.competencia is null and g.tipo not in ('honorario', 'outro'))
      or coalesce((g.leitura ->> 'valor_divergente')::boolean, false) then 'amarelo'
    else 'verde'
  end
  from nofiscal.guias g
  left join nofiscal.guia_contatos c on c.id = g.contato_id
  where g.id = p_guia_id;
$$;

-- Guias enviadas no mês (Brasília) da conta: as que saíram (status ≥ enviada, menos as canceladas antes de sair).
create function nofiscal.guias_uso_mes(p_tenant_id uuid, p_ref timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mes as (
    select (date_trunc('month', p_ref at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo' as ini,
           (date_trunc('month', p_ref at time zone 'America/Sao_Paulo') + interval '1 month') at time zone 'America/Sao_Paulo' as fim
  )
  select jsonb_build_object(
    'enviadas', (select count(*) from nofiscal.guias g, mes
                  where g.escritorio_tenant_id = p_tenant_id and g.enviada_em >= mes.ini and g.enviada_em < mes.fim),
    'limite', (select a.limite_mes from nofiscal.fiscal_addons a where a.tenant_id = p_tenant_id and a.produto = 'guias'));
$$;

-- ------------------------------------------------------------ Funções do módulo (recusam conta sem o módulo)

-- Cria ou edita um contato (p_dados: id?, documento, nome, whatsapps[], emails[], aceite_em?, aceite_origem?,
-- ativo?). Casa as guias da conta ainda sem contato que têm o mesmo documento.
create function nofiscal.guias_contato_salvar(p_user_id uuid, p_dados jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conta uuid;
  v_id uuid;
  v_doc text;
begin
  v_conta := nofiscal.guias_conta_do_usuario(p_user_id);
  if v_conta is null then
    raise exception 'GUIAS_DESLIGADO' using errcode = 'P0001';
  end if;
  v_doc := regexp_replace(coalesce(p_dados ->> 'documento', ''), '\D', '', 'g');
  if (p_dados ->> 'id') is not null then
    update nofiscal.guia_contatos c
       set nome = coalesce(p_dados ->> 'nome', c.nome),
           documento = case when v_doc = '' then c.documento else v_doc end,
           whatsapps = case when p_dados ? 'whatsapps'
                            then coalesce((select array_agg(x) from jsonb_array_elements_text(p_dados -> 'whatsapps') x), '{}')
                            else c.whatsapps end,
           emails = case when p_dados ? 'emails'
                         then coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p_dados -> 'emails') x), '{}')
                         else c.emails end,
           aceite_em = case when p_dados ? 'aceite_em' then (p_dados ->> 'aceite_em')::timestamptz else c.aceite_em end,
           aceite_origem = case when p_dados ? 'aceite_origem' then p_dados ->> 'aceite_origem' else c.aceite_origem end,
           ativo = coalesce((p_dados ->> 'ativo')::boolean, c.ativo),
           updated_at = now()
     where c.id = (p_dados ->> 'id')::uuid and c.escritorio_tenant_id = v_conta
    returning c.id into v_id;
    if v_id is null then
      raise exception 'CONTATO_NAO_ENCONTRADO' using errcode = 'P0001';
    end if;
  else
    insert into nofiscal.guia_contatos (escritorio_tenant_id, documento, nome, whatsapps, emails, aceite_em, aceite_origem)
    values (v_conta, v_doc, p_dados ->> 'nome',
            coalesce((select array_agg(x) from jsonb_array_elements_text(p_dados -> 'whatsapps') x), '{}'),
            coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(p_dados -> 'emails') x), '{}'),
            (p_dados ->> 'aceite_em')::timestamptz, p_dados ->> 'aceite_origem')
    on conflict (escritorio_tenant_id, documento) do update
      set nome = excluded.nome, whatsapps = excluded.whatsapps, emails = excluded.emails,
          aceite_em = coalesce(excluded.aceite_em, nofiscal.guia_contatos.aceite_em),
          aceite_origem = coalesce(excluded.aceite_origem, nofiscal.guia_contatos.aceite_origem),
          ativo = true, updated_at = now()
    returning id into v_id;
  end if;
  update nofiscal.guias g
     set contato_id = v_id, updated_at = now()
   where g.escritorio_tenant_id = v_conta and g.contato_id is null
     and g.documento = (select c.documento from nofiscal.guia_contatos c where c.id = v_id)
     and g.status in ('lendo', 'conferir');
  return v_id;
end;
$$;

create function nofiscal.guias_lote_criar(p_user_id uuid, p_total integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conta uuid;
  v_id uuid;
begin
  v_conta := nofiscal.guias_conta_do_usuario(p_user_id);
  if v_conta is null then
    raise exception 'GUIAS_DESLIGADO' using errcode = 'P0001';
  end if;
  insert into nofiscal.guia_lotes (escritorio_tenant_id, criado_por, total_arquivos)
  values (v_conta, p_user_id, p_total)
  returning id into v_id;
  return v_id;
end;
$$;

-- Dispara (agora ou na data/hora): só guias da conta, em conferência (ou que falharam) e verdes. Nada sai sem isto.
create function nofiscal.guias_disparar(p_user_id uuid, p_guias uuid[], p_quando timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conta uuid;
  v_agendadas integer;
begin
  v_conta := nofiscal.guias_conta_do_usuario(p_user_id);
  if v_conta is null then
    raise exception 'GUIAS_DESLIGADO' using errcode = 'P0001';
  end if;
  if p_guias is null or cardinality(p_guias) = 0 or cardinality(p_guias) > 500 then
    raise exception 'guias_disparar: lista invalida' using errcode = '22023';
  end if;
  update nofiscal.guias g
     set status = 'agendada', agendada_para = greatest(coalesce(p_quando, now()), now()), updated_at = now()
   where g.id = any (p_guias) and g.escritorio_tenant_id = v_conta
     and g.status in ('conferir', 'falhou')
     and nofiscal.guia_cor(g.id) = 'verde';
  get diagnostics v_agendadas = row_count;
  update nofiscal.guia_lotes l set status = 'disparado'
   where l.escritorio_tenant_id = v_conta
     and l.id in (select g.lote_id from nofiscal.guias g where g.id = any (p_guias) and g.escritorio_tenant_id = v_conta)
     and not exists (select 1 from nofiscal.guias g where g.lote_id = l.id and g.status in ('enviando', 'lendo', 'conferir'));
  return jsonb_build_object('agendadas', v_agendadas, 'recusadas', cardinality(p_guias) - v_agendadas);
end;
$$;

-- ------------------------------------------------------------ Ligar o módulo (só a nó)

-- Liga (p_ligado true) ou desliga o módulo Guias numa conta-mãe de escritório. p_limite_mes: guias/mês da faixa
-- (500, 1.500, 4.000 ou sob medida); null mantém o atual (500 na primeira vez). Cria as regras padrão.
-- Achar a conta-mãe pelo CNPJ ou pelo e-mail do escritório:
--   select t.id, t.cnpj, t.razao_social, t.plan from nofiscal.fiscal_tenants t
--     left join nofiscal.fiscal_accounts a on a.client_id = t.client_id
--    where t.escritorio_tenant_id is null and (t.cnpj = '<14 dígitos>' or lower(a.email) = lower('<email>'));
create function public.fiscal_definir_modulo_guias(p_tenant_id uuid, p_ligado boolean, p_limite_mes integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_limite integer;
begin
  if p_tenant_id is null or p_ligado is null or (p_limite_mes is not null and p_limite_mes not between 1 and 100000) then
    raise exception 'fiscal_definir_modulo_guias: parametro invalido' using errcode = '22023';
  end if;
  select t.id, t.plan, t.escritorio_tenant_id, t.razao_social into v_t
    from nofiscal.fiscal_tenants t where t.id = p_tenant_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_NAO_ENCONTRADA');
  end if;
  if v_t.escritorio_tenant_id is not null or not nofiscal.plano_de_escritorio(v_t.plan) then
    return jsonb_build_object('ok', false, 'erro', 'NAO_E_CONTA_MAE_DE_ESCRITORIO');
  end if;
  select coalesce(p_limite_mes, a.limite_mes, 500) into v_limite
    from (select 1) x left join nofiscal.fiscal_addons a on a.tenant_id = v_t.id and a.produto = 'guias';
  insert into nofiscal.fiscal_addons (tenant_id, produto, faixa, limite_mes, status)
  values (v_t.id, 'guias',
          case v_limite when 500 then 'guias_500' when 1500 then 'guias_1500' when 4000 then 'guias_4000' else 'sob_medida' end,
          v_limite, case when p_ligado then 'ativo' else 'desligado' end)
  on conflict (tenant_id, produto) do update
    set limite_mes = excluded.limite_mes, faixa = excluded.faixa, status = excluded.status, updated_at = now();
  insert into nofiscal.guia_regras (escritorio_tenant_id, assinatura)
  values (v_t.id, left(v_t.razao_social, 80))
  on conflict (escritorio_tenant_id) do nothing;
  return jsonb_build_object('ok', true, 'tenant_id', v_t.id, 'ligado', p_ligado, 'limite_mes', v_limite);
end;
$$;

-- ------------------------------------------------------------ Bucket privado dos PDFs

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('fiscal-guias', 'fiscal-guias', false, 10485760, array['application/pdf'])
    on conflict (id) do nothing;
  end if;
end;
$$;

-- ------------------------------------------------------------ Acesso

alter table nofiscal.fiscal_addons enable row level security;
alter table nofiscal.guia_contatos enable row level security;
alter table nofiscal.guia_lotes enable row level security;
alter table nofiscal.guias enable row level security;
alter table nofiscal.guia_envios enable row level security;
alter table nofiscal.guia_regras enable row level security;

revoke all on nofiscal.fiscal_addons, nofiscal.guia_contatos, nofiscal.guia_lotes, nofiscal.guias,
  nofiscal.guia_envios, nofiscal.guia_regras from public, anon, authenticated, service_role;
grant select on nofiscal.fiscal_addons to nofiscal_service;
grant select, insert, update, delete on nofiscal.guia_contatos, nofiscal.guia_lotes, nofiscal.guias,
  nofiscal.guia_envios, nofiscal.guia_regras to nofiscal_service;

create policy nofiscal_service_posse on nofiscal.fiscal_addons
  for select to nofiscal_service using (nofiscal.guias_acesso(tenant_id));
create policy nofiscal_service_posse on nofiscal.guia_contatos
  for all to nofiscal_service using (nofiscal.guias_acesso(escritorio_tenant_id)) with check (nofiscal.guias_acesso(escritorio_tenant_id));
create policy nofiscal_service_posse on nofiscal.guia_lotes
  for all to nofiscal_service using (nofiscal.guias_acesso(escritorio_tenant_id)) with check (nofiscal.guias_acesso(escritorio_tenant_id));
create policy nofiscal_service_posse on nofiscal.guias
  for all to nofiscal_service using (nofiscal.guias_acesso(escritorio_tenant_id)) with check (nofiscal.guias_acesso(escritorio_tenant_id));
create policy nofiscal_service_posse on nofiscal.guia_envios
  for all to nofiscal_service using (nofiscal.guias_acesso(escritorio_tenant_id)) with check (nofiscal.guias_acesso(escritorio_tenant_id));
create policy nofiscal_service_posse on nofiscal.guia_regras
  for all to nofiscal_service using (nofiscal.guias_acesso(escritorio_tenant_id)) with check (nofiscal.guias_acesso(escritorio_tenant_id));

revoke all on function nofiscal.guias_acesso(uuid), nofiscal.guias_ligado(uuid), nofiscal.guias_conta_do_usuario(uuid),
  nofiscal.guia_status_ordem(text), nofiscal.guia_cor(uuid), nofiscal.guias_uso_mes(uuid, timestamptz),
  nofiscal.guias_contato_salvar(uuid, jsonb), nofiscal.guias_lote_criar(uuid, integer),
  nofiscal.guias_disparar(uuid, uuid[], timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function nofiscal.guias_acesso(uuid), nofiscal.guias_ligado(uuid), nofiscal.guias_conta_do_usuario(uuid),
  nofiscal.guia_status_ordem(text), nofiscal.guia_cor(uuid), nofiscal.guias_uso_mes(uuid, timestamptz),
  nofiscal.guias_contato_salvar(uuid, jsonb), nofiscal.guias_lote_criar(uuid, integer),
  nofiscal.guias_disparar(uuid, uuid[], timestamptz)
  to nofiscal_service;

revoke all on function public.fiscal_definir_modulo_guias(uuid, boolean, integer) from public, anon, authenticated;
grant execute on function public.fiscal_definir_modulo_guias(uuid, boolean, integer) to service_role;
