-- Agente fiscal: NF-e avulsa pelo WhatsApp (Lucca, 23/11/2026). A conversa da NF-e usa o mesmo `fiscal_requests` da
-- NFS-e, com `kind` = 'emitir_nfe' e a etapa única 'nfe' (o passo da conversa fica em `conversa -> 'nfe'`); a nota
-- criada pela conversa tem `origem` = 'whatsapp' em `fiscal_nfe`. Só acrescenta valores aos checks; nenhum dado muda.

alter table nofiscal.fiscal_requests drop constraint if exists fiscal_requests_kind_check;
alter table nofiscal.fiscal_requests
  add constraint fiscal_requests_kind_check check (kind in ('emitir', 'cancelar', 'emitir_nfe'));

alter table nofiscal.fiscal_requests drop constraint if exists fiscal_requests_etapa_check;
alter table nofiscal.fiscal_requests
  add constraint fiscal_requests_etapa_check
    check (etapa in ('dados_tomador', 'confirmar', 'escolher_nota', 'salvar_modelo', 'substituir_modelo', 'escolher_prestador', 'nfe'));

alter table nofiscal.fiscal_nfe drop constraint if exists fiscal_nfe_origem_check;
alter table nofiscal.fiscal_nfe
  add constraint fiscal_nfe_origem_check check (origem in ('painel', 'planilha', 'api', 'whatsapp'));
