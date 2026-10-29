-- Central de conversas do nó.fiscal (Lucca, 29/10/2026): as mensagens trocadas no número do robô
-- passam a ser guardadas por 90 dias, para a equipe ver ao vivo em /no/fiscal/conversas, assumir
-- uma conversa (o robô fica quieto naquele número) e responder pelo próprio número do robô.
-- Só a API (papel `nofiscal_service`) lê e grava; a tela chega aqui pela rota de API, que exige
-- NO_ADMIN com segundo fator. "Apagar conta" apaga as mensagens junto com os telefones.
-- Só acrescenta.

-- ------------------------------------------------------------ Mensagens

create table nofiscal.fiscal_messages (
  id uuid primary key default gen_random_uuid(),
  -- Número com o nono dígito (agrupa a conversa e acha a conta).
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- O endereço exatamente como a Meta mandou ou como saiu (às vezes sem o 9): a resposta da equipe vai para ele.
  endereco text check (endereco ~ '^\+?[0-9]{8,15}$'),
  tenant_id uuid references nofiscal.fiscal_tenants(id) on delete cascade,
  direcao text not null check (direcao in ('entrada', 'saida')),
  autor text not null check (autor in ('cliente', 'robo', 'equipe')),
  -- `messages[].type` da Meta (`text`, `document`, `image`…) ou `template`.
  tipo text not null check (length(tipo) between 1 and 40),
  texto text check (length(texto) <= 8000),
  -- Só o nome do arquivo; o arquivo nunca é guardado.
  arquivo text check (length(arquivo) <= 300),
  wamid text unique check (length(wamid) <= 200),
  -- Só na saída: o envio e as marcas que a Meta devolve no webhook (`statuses[]`).
  status text check (status in ('enviada', 'entregue', 'lida', 'falhou')),
  erro text check (length(erro) <= 500),
  -- Quem da equipe respondeu (auth.users), só com autor = equipe.
  user_id uuid,
  -- Falha de envio já avisada por e-mail.
  avisado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fiscal_messages_autor check ((direcao = 'entrada') = (autor = 'cliente')),
  constraint fiscal_messages_status check (direcao = 'saida' or status is null)
);

comment on table nofiscal.fiscal_messages is 'Mensagens do número do robô do nó.fiscal, guardadas por 90 dias (central de conversas).';

create index fiscal_messages_phone_idx on nofiscal.fiscal_messages (phone_e164, created_at desc);
create index fiscal_messages_created_idx on nofiscal.fiscal_messages (created_at);
create index fiscal_messages_tenant_idx on nofiscal.fiscal_messages (tenant_id);
create index fiscal_messages_falhas_idx on nofiscal.fiscal_messages (updated_at)
  where status = 'falhou' and avisado_em is null;

-- Ordem das marcas de envio: uma marca atrasada da Meta nunca volta a mensagem para trás.
create function nofiscal.fiscal_status_ordem(p_status text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_status when 'enviada' then 1 when 'entregue' then 2 when 'lida' then 3 when 'falhou' then 4 else 0 end
$$;

-- ------------------------------------------------------------ Conversa assumida pela equipe

-- Enquanto `assumida_ate` não passou, o robô não responde a esse número (as entregas de nota
-- continuam). Cada resposta da equipe empurra o prazo; "Devolver ao robô" zera.
create table nofiscal.fiscal_conversations (
  phone_e164 text primary key check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  assumida_ate timestamptz,
  assumida_por uuid,
  updated_at timestamptz not null default now()
);

comment on table nofiscal.fiscal_conversations is 'Conversa assumida pela equipe na central: o robô fica quieto até assumida_ate.';

-- ------------------------------------------------------------ Eventos e alertas

-- Linhas de sistema da conversa. Os tipos de alerta vão por e-mail para FISCAL_ALERTA_EMAIL
-- no worker; `avisado_em` marca o que já foi.
create table nofiscal.fiscal_conversation_events (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  tenant_id uuid references nofiscal.fiscal_tenants(id) on delete cascade,
  tipo text not null check (tipo in (
    'pediu_atendente', 'ia_falhou', 'ia_nao_entendeu', 'sefin_recusou', 'equipe_assumiu', 'equipe_devolveu'
  )),
  detalhe text check (length(detalhe) <= 500),
  user_id uuid,
  avisado_em timestamptz,
  created_at timestamptz not null default now()
);

create index fiscal_conversation_events_phone_idx on nofiscal.fiscal_conversation_events (phone_e164, created_at desc);
create index fiscal_conversation_events_created_idx on nofiscal.fiscal_conversation_events (created_at);
create index fiscal_conversation_events_pendentes_idx on nofiscal.fiscal_conversation_events (created_at)
  where avisado_em is null;

-- ------------------------------------------------------------ Apagar conta

-- `fiscal_apagar_conta` apaga os telefones da empresa; a conversa de cada um vai junto.
create function nofiscal.fiscal_phones_apagar_conversa()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from nofiscal.fiscal_messages where phone_e164 = old.phone_e164;
  delete from nofiscal.fiscal_conversation_events where phone_e164 = old.phone_e164;
  delete from nofiscal.fiscal_conversations where phone_e164 = old.phone_e164;
  return old;
end
$$;

create trigger fiscal_phones_apagar_conversa
  after delete on nofiscal.fiscal_phones
  for each row execute function nofiscal.fiscal_phones_apagar_conversa();

revoke all on function nofiscal.fiscal_phones_apagar_conversa() from public, anon, authenticated;

-- ------------------------------------------------------------ Acesso

alter table nofiscal.fiscal_messages enable row level security;
alter table nofiscal.fiscal_conversations enable row level security;
alter table nofiscal.fiscal_conversation_events enable row level security;

revoke all on nofiscal.fiscal_messages, nofiscal.fiscal_conversations, nofiscal.fiscal_conversation_events
  from public, anon, authenticated, service_role;
revoke all on function nofiscal.fiscal_status_ordem(text) from public, anon, authenticated;

grant select, insert, update, delete on nofiscal.fiscal_messages, nofiscal.fiscal_conversations,
  nofiscal.fiscal_conversation_events to nofiscal_service;
grant execute on function nofiscal.fiscal_status_ordem(text) to nofiscal_service;

create policy nofiscal_service_all on nofiscal.fiscal_messages
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_conversations
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_conversation_events
  for all to nofiscal_service using (true) with check (true);
