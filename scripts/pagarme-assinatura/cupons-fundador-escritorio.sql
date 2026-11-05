-- Cupons de fundador do plano Escritório (Lucca, 05/11/2026; .design/agente-fiscal-escritorio.md, "Cupom de fundador").
-- NÃO roda sozinho: Lucca aplica no SQL Editor do Supabase de produção, DEPOIS da migração
-- 20261105180000_agente_fiscal_escritorio.sql (ela cria fiscal_cupons.dias_de_teste e aceita os planos escritorio_*).
--
-- O que cada cupom faz no checkout (supabase/functions/assinatura-fiscal/core.ts):
--   - dias_de_teste = 30 → a assinatura nasce no plano `escritorio_N_teste30` do Pagar.me: o 1º mês é grátis;
--   - tipo 'valor' + valor + ciclos 12 → vai em `discounts` ({value, discount_type: "flat", cycles: 12}): a mensalidade
--     cai R$ 50 / 150 / 300 nas 12 primeiras cobranças, ou seja, R$ 247 / 647 / 1.197 por mês no 1º ano pago.
--
-- Sobre `ciclos` com o teste: o código não prova se o Pagar.me conta os 30 dias de teste como um ciclo do desconto.
-- O teste vem do plano (trial_period_days, sem start_at) e a assinatura só gera fatura depois dele, então o esperado é
-- que o 1º ciclo com desconto seja a 1ª cobrança após o teste, e 12 ciclos = os 12 primeiros meses pagos. Conferir
-- na primeira assinatura com FUNDADOR5 (no sandbox ou na da Sandra): a fatura do 2º mês pago tem de vir com R$ 247.
-- Se o Pagar.me contar o teste como ciclo, o 12º mês pago sai cheio; aí sobe para 13 (update abaixo, comentado). O
-- update só vale para as assinaturas novas: o desconto das já criadas está no Pagar.me e é ajustado lá.
--
-- max_usos 20 em cada faixa: o banco trava o 21º (CUPOM_ESGOTADO) e o mesmo escritório não usa duas vezes
-- (fiscal_cupom_usos, CUPOM_JA_USADO). Cada cupom vale só na própria faixa (CUPOM_PLANO nas outras).

begin;

insert into nofiscal.fiscal_cupons (codigo, descricao, tipo, valor, ciclos, planos, dias_de_teste, max_usos)
values
  ('FUNDADOR5', 'Fundador: 1º mês grátis e R$ 247/mês no 1º ano', 'valor', 5000, 12, array['escritorio_5'], 30, 20),
  ('FUNDADOR20', 'Fundador: 1º mês grátis e R$ 647/mês no 1º ano', 'valor', 15000, 12, array['escritorio_20'], 30, 20),
  ('FUNDADOR50', 'Fundador: 1º mês grátis e R$ 1.197/mês no 1º ano', 'valor', 30000, 12, array['escritorio_50'], 30, 20)
on conflict (codigo) do nothing;

-- Conferência: as três linhas, ativas, sem uso.
select codigo, tipo, valor, ciclos, planos, dias_de_teste, max_usos, usos, ativo
  from nofiscal.fiscal_cupons
 where codigo in ('FUNDADOR5', 'FUNDADOR20', 'FUNDADOR50')
 order by valor;

commit;

-- Só se a conferência do 2º mês mostrar que o teste contou como ciclo:
-- update nofiscal.fiscal_cupons set ciclos = 13 where codigo in ('FUNDADOR5', 'FUNDADOR20', 'FUNDADOR50');
