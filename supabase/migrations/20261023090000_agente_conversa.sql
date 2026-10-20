-- Agente fiscal (lote B): estado da conversa no pedido e marcas de "uma vez só" (mensagem
-- repetida da Meta e avisos). Formas literais no Landing de .checks/agente-fiscal-whatsapp.md
-- ("Estado da conversa" e "Mensagem repetida e avisos únicos"). Só acrescenta.

-- Etapa da conversa e o que o código decidiu nela. `parsed` continua só com a saída da IA.
alter table nofiscal.fiscal_requests
  add column etapa text
    check (etapa in ('dados_tomador', 'confirmar', 'escolher_nota', 'salvar_modelo', 'substituir_modelo')),
  add column conversa jsonb not null default '{}'::jsonb;

comment on column nofiscal.fiscal_requests.etapa is 'O que o agente espera do número neste pedido; nulo = nada.';
comment on column nofiscal.fiscal_requests.conversa is 'Estado gravado pelo código da conversa (tomador, serviço, valor, modelo, candidatas); nunca pela IA.';

create index fiscal_requests_phone_etapa_idx on nofiscal.fiscal_requests (phone_id, created_at desc)
  where etapa is not null;

-- Quem insere a chave primeiro faz a ação; a repetição encontra a chave e não faz nada.
create table nofiscal.fiscal_agent_once (
  chave text primary key check (length(chave) between 1 and 200),
  tenant_id uuid references nofiscal.fiscal_tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index fiscal_agent_once_tenant_idx on nofiscal.fiscal_agent_once (tenant_id);

alter table nofiscal.fiscal_agent_once enable row level security;
revoke all on nofiscal.fiscal_agent_once from public, anon, authenticated, service_role;
grant select, insert, delete on nofiscal.fiscal_agent_once to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_agent_once
  for all to nofiscal_service using (true) with check (true);
