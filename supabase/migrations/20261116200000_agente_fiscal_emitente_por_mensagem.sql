-- Agente fiscal, conta Escritório: emitente no pedido por mensagem (.design/agente-fiscal-emitente-por-mensagem.md,
-- Lucca, 16/11/2026). O telefone é da conta-mãe; com mais de uma empresa ativa, o pedido por mensagem escolhe a
-- empresa que emite ("nota pela Oficina Trilho pra Clínica Saúde, 450") e, sem ela, o agente pergunta
-- "Por qual empresa sai a nota?". Essa espera é a etapa nova `escolher_prestador`; escolhida a empresa, o pedido segue
-- com `tenant_id` = a empresa que emite. Só acrescenta um valor ao check; nenhum dado muda.

alter table nofiscal.fiscal_requests drop constraint if exists fiscal_requests_etapa_check;
alter table nofiscal.fiscal_requests
  add constraint fiscal_requests_etapa_check
    check (etapa in ('dados_tomador', 'confirmar', 'escolher_nota', 'salvar_modelo', 'substituir_modelo', 'escolher_prestador'));

comment on column nofiscal.fiscal_requests.tenant_id is
  'A empresa que emite a nota do pedido: a do telefone ou, na conta Escritório, a escolhida no pedido (empresa com escritorio_tenant_id = conta do telefone).';
