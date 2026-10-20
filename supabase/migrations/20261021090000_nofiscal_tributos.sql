-- Nó Fiscal, lote 2b: percentual aproximado dos tributos do Simples (`totTrib/pTotTribSN` da DPS).
-- O valor vem da contadora (Unresolved 5) e é gravado por Lucca, como dono. Enquanto a
-- coluna estiver nula, o motor deixa as notas do tenant em `queued` com
-- `last_error_code = 'TRIBUTOS_NOT_CONFIGURED'` (Landing do checklist, lote 2b).
alter table nofiscal.fiscal_tenants
  add column p_tot_trib_sn numeric(5,2) check (p_tot_trib_sn between 0 and 100);

comment on column nofiscal.fiscal_tenants.p_tot_trib_sn is
  'Percentual aproximado dos tributos do Simples Nacional (DPS totTrib/pTotTribSN), informado pela contadora.';
