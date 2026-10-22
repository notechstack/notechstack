-- Agente fiscal v2, lote D (Landing de .checks/agente-fiscal-v2.md, "Cota de PDFs"): quantos PDFs
-- de notas cada tenant já mandou para a IA ler na base de clientes (critério 23: o 31º responde
-- 429 sem chamar a IA). Só a contagem: o PDF nunca é gravado (critério 22).

create table nofiscal.fiscal_importacao_pdfs (
  tenant_id uuid primary key references nofiscal.fiscal_tenants(id) on delete cascade,
  enviados smallint not null check (enviados between 0 and 30),
  atualizado_em timestamptz not null default now()
);

comment on table nofiscal.fiscal_importacao_pdfs is 'PDFs de notas enviados pelo tenant para leitura por IA no onboarding (no máximo 30).';

alter table nofiscal.fiscal_importacao_pdfs enable row level security;
revoke all on nofiscal.fiscal_importacao_pdfs from public, anon, authenticated, service_role;
grant select, insert, update on nofiscal.fiscal_importacao_pdfs to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_importacao_pdfs
  for all to nofiscal_service using (true) with check (true);
