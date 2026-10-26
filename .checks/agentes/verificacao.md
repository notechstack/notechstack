# Verificação da frente D — resumo (rodada 2)

Relatório completo: `.checks/agentes-escritorio.verified.md` (Round 2, verificado em `c54fbd54`, faixa `9a12aecb..c54fbd54`, perfil `light` + passo 1 a pedido).

**Veredito: FAIL** · critérios 1–32 renegociados: 32/32 provados · 44/44 `PASS` nas três provas, rodadas uma de cada vez (EXIT 0) · R vigentes: 8 por asserção, 3 parciais, 3 só por inspeção, R3 em aberto · faults não rodaram (`light`)

## Lacunas, por gravidade

1. **Alta — 1440, Tela 2:** o modal da gaveta cobre a mesa aproximada. No fiscal, a mesa está em y=163 com o topo do modal em 165; no Auditor, em y=152 com o topo em 131. Foi dado como corrigido e não está, e nenhum check cobre isso. Ver `final2-tela2-1440.png`.
2. **Média-alta — R4, R9 e R10 sem asserção:** círculo ≥ 16 px, halo, contorno ≥ 2 px e âmbar piscando apontam para o `PASS C6`, que só afirma texto e cor. O código (`cena.js:47`, `:354-359`) e a imagem conferem. R5 (forma do crachá), R12 (lado a lado, sem cruzar, tubos com pulsos) e R16 (meshopt e WebP) também foram conferidos só à mão.
3. **Média — R3:** a mediana `[220,199,170] ±12` ficou sem prova, e a cena dá `[204,154,108]`. A R8 manda escurecer, mas não retira a mediana de forma expressa.
4. **Média-baixa:** o corpo do checklist (C1, C2, C6, C7, C16, C26a, C31) e o Unresolved 6 da task ainda trazem os valores antigos.
5. **Baixa:** arranjo da referência sem check (cartões, CTA, alça, botão largo); "mesmo ângulo" (R11) não é afirmado; no C16, inteiros pequenos passam trivialmente; as provas regravam 16 PNGs versionados; na Tela 2, o `h1` aparece acima da navbar.

## Fechado desde a rodada 1

- O C31 agora mede com a conversa completa (9 s / 7 s): a gaveta tem 503 px (≤ 62%) e a mesa fica acima dela.
- Em 1440, o fecho mostra a sala abaixo da navbar junto com o `h2`.
- O C6 roda no canvas da página e o C7 varre os nomes do GLB.

## Conferido sem achado

- R2: cena de borda a borda, sem caixa, com degradê de 64 px.
- Telas 1, 2 e 3 em 375 e 390.
- Nenhum polvo, mascote ou animal no GLB (nós e texturas), nos pôsteres ou nas texturas do Blender.
- `agentes/fiscal/` e `agentes/auditor/` intactos.
- As provas que mudaram mudaram por renegociação registrada (R1, R6, R10, R11, R13, R15) ou só por tempo, sem enfraquecimento.

## Atenção

A worktree recebeu a Rodada 6 (R17–R19) sem commit às 17:52–17:54, durante a verificação. Minhas provas e capturas terminaram antes (17:47 e 17:51) e valem para `c54fbd54`. A Rodada 6 não foi verificada.
