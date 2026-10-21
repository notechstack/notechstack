-- Agendamento do auditor (Frente 3): liga os 3 jobs do pg_cron.
-- Separada da 20261021130000 por decisão do orquestrador (21/10): só se aplica em produção quando
-- existir um cliente real conectado. Sem relatório vencido nem aviso pendente, o `processar` não faz
-- chamada HTTP (auditor_invoke_processar devolve null); `planejar` sem assinantes devolve 0.
-- Reversão: supabase/rollback/20261021140000_auditor_agendamento.down.sql

do $$
declare j text;
begin
  foreach j in array array['auditor-relatorios-planejar', 'auditor-relatorios-processar', 'auditor_limpar_diario'] loop
    if exists (select 1 from cron.job where jobname = j and username = current_user) then
      perform cron.unschedule(j);
    end if;
  end loop;
  -- 06:00 BRT: agenda os relatórios do dia (semanal na segunda, mensal no dia 1).
  perform cron.schedule('auditor-relatorios-planejar', '0 9 * * *', 'select public.auditor_planejar_relatorios()');
  -- A cada 10 min: até 3 relatórios + avisos (só chama a marketing-hub se houver trabalho).
  perform cron.schedule('auditor-relatorios-processar', '*/10 * * * *', 'select public.auditor_invoke_processar()');
  -- 03:30 BRT: retenção (D3).
  perform cron.schedule('auditor_limpar_diario', '30 6 * * *', 'select public.auditor_limpar()');
end;
$$;
