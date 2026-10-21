-- Reversão de 20261021140000_auditor_agendamento.sql: desliga os 3 jobs do auditor.
do $$
declare j text;
begin
  foreach j in array array['auditor-relatorios-planejar', 'auditor-relatorios-processar', 'auditor_limpar_diario'] loop
    if exists (select 1 from cron.job where jobname = j and username = current_user) then
      perform cron.unschedule(j);
    end if;
  end loop;
end;
$$;
