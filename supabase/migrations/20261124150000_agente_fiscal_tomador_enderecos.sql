-- Agente fiscal: endereço do tomador em toda NFS-e (Robson, Contabilidade Bragantina, 24/11/2026). O endereço de um CNPJ
-- vem da Receita (BrasilAPI, espelho e CNPJ.ws) e fica guardado aqui, por CNPJ, para não consultar a cada nota: é dado
-- público, igual para todas as contas. Vale 30 dias (app/api/_lib/endereco-tomador.ts); vencido, consulta de novo e,
-- se a consulta falhar, ainda serve. Sem esta tabela o app só deixa de guardar (consulta sempre). Nenhum dado muda.

create table nofiscal.fiscal_tomador_enderecos (
  cnpj text primary key check (cnpj ~ '^[0-9]{14}$'),
  -- `EnderecoNacional` (retencao.ts): cMun, cep, logradouro, numero, complemento, bairro.
  endereco jsonb not null check (jsonb_typeof(endereco) = 'object'),
  consultado_em timestamptz not null default now()
);

alter table nofiscal.fiscal_tomador_enderecos enable row level security;
revoke all on nofiscal.fiscal_tomador_enderecos from public, anon, authenticated, service_role;
grant select, insert, update on nofiscal.fiscal_tomador_enderecos to nofiscal_service;
-- Dado público, sem dono: o papel do app lê e grava qualquer linha.
create policy nofiscal_service_all on nofiscal.fiscal_tomador_enderecos
  for all to nofiscal_service using (true) with check (true);
