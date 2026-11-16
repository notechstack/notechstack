-- Agente fiscal: retenção de ISS e de INSS na nota (Lucca, 16/11/2026; .design/agente-fiscal-retencoes.md).
-- O escritório marca, ao adicionar a empresa cliente, se ela tem ISS retido (com a alíquota) e INSS retido (com o
-- percentual). É o padrão das notas dessa empresa; cada pedido (WhatsApp, planilha, painel) pode mudar. O motor não
-- calcula regra tributária: o contador informa, e o código só barra o que a Sefin recusa (Anexo I v1.01):
-- - MEI não tem retenção (E0583, E0676);
-- - alíquota do ISS retido entre 2% e 5% (LC 123 art. 21 §4º; E0595), obrigatória com ISS retido (E0621/E0628);
-- - INSS retido como percentual do valor da nota, maior que 0 e menor que 100 (o vRetCP sai < vServ, E0699).
-- As notas guardam a retenção já resolvida no payload (jsonb); nenhuma nota antiga muda.

alter table nofiscal.fiscal_tenants
  add column retem_iss boolean not null default false,
  add column aliquota_iss numeric(3, 2) check (aliquota_iss between 2 and 5),
  add column retem_inss boolean not null default false,
  add column inss_percentual numeric(5, 2) check (inss_percentual > 0 and inss_percentual < 100),
  add constraint fiscal_tenants_retem_iss_check check (not retem_iss or aliquota_iss is not null),
  add constraint fiscal_tenants_retem_inss_check check (not retem_inss or inss_percentual is not null),
  add constraint fiscal_tenants_retencao_mei_check check (regime <> 'mei' or (not retem_iss and not retem_inss));

comment on column nofiscal.fiscal_tenants.retem_iss is
  'Padrão das notas da empresa: ISS retido pelo tomador (tpRetISSQN 2), com aliquota_iss em pAliq. Só tomador CNPJ.';
comment on column nofiscal.fiscal_tenants.retem_inss is
  'Padrão das notas da empresa: INSS retido (vRetCP = valor × inss_percentual / 100).';

-- O painel (POST /api/v1/fiscal/emissao, conexão nofiscal_service) grava a retenção da empresa do dono.
-- O select já vem do grant da tabela inteira (20261020180000_nofiscal_core).
grant update (retem_iss, aliquota_iss, retem_inss, inss_percentual) on nofiscal.fiscal_tenants to nofiscal_service;
