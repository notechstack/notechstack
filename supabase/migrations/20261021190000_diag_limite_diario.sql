-- Diagnóstico grátis do Auditor: limite "invisível" de 3 por dispositivo a cada 24 horas (Lucca, 21/10/2026).
-- Antes: 3 no total por dispositivo (janela_usuario_horas null). O teto diário geral (teto_diario) não muda.
-- O site não mostra mais a cota: no 4º pedido do dia, a LP leva à tela final com o "Refazer" travado.
update public.diag_config
   set limite_usuario = 3,
       janela_usuario_horas = 24
 where id = 1;
