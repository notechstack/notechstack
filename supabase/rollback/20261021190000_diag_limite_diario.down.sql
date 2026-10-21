-- Volta ao limite de 3 diagnósticos no total por dispositivo (sem janela).
update public.diag_config
   set limite_usuario = 3,
       janela_usuario_horas = null
 where id = 1;
