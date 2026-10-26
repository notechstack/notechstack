# Verificação da frente D — resumo

Relatório completo: `.checks/agentes-escritorio.verified.md` (round 1, verificado em `e15bbc46`, faixa `9a12aecb..e15bbc46`, perfil `light` + passo 1 a pedido).

**Veredito: FAIL** · 31 de 32 critérios provados · 38/38 rótulos `PASS` nas três provas (EXIT 0) · faults não rodaram (perfil `light`)

## Lacunas, por gravidade

1. **Alta — C31 falso em HEAD.** De ~3 a 6 s em diante, a gaveta cresce até 609 px (75%), com o topo em y=203, e cobre a mesa aproximada (y=246) em 375×812. Em 390×844 também, e no Auditor desde 3 s. A prova (`test-pagina.cjs:657-664`) mede só aos 1,4 s. Causa provável: o `alvoY` é calculado só na abertura (`pagina.js:181-183`). A Tela 2 deixa de ter a mesa em cima, como na referência. Ver `final-tela2-375.png` e `final-tela2-390.png`.
2. **Média — arranjo da referência sem check.** Tela 3: cartões lado a lado, botão com contorno. Tela 2: alça, botão azul largo. Tela 1: cena abaixo do texto, na largura toda (o C6 é provado só na bancada). Hoje tudo confere, mas nenhuma prova trava.
3. **Média-baixa — 1440.** Na Tela 2, o modal cobre a mesa aproximada. Na Tela 3, a sala fica sob a navbar quando o `h2` está visível. Na Tela 1, a placa da sala sai cortada na borda do canvas.
4. **Baixa.** C6 e C7 (mascote) são provados abaixo do nível da página, mas valem nas medições e capturas. No C16, inteiros pequenos passam trivialmente. O C13 não afirma o fundo da conversa.
5. **Baixa.** As provas regravam 12 PNGs versionados, e a árvore fica com `M`.

## Conferido sem achado

- Polvo, mascote e animal: nenhum, no código, na cena, nos pôsteres e nos assets carregados.
- `agentes/fiscal/` e `agentes/auditor/`: nenhum arquivo mudou na faixa.
- Telas 1 e 3 em 375 e 390: a composição confere com a referência.
- O C25 passa por `carregando` antes de `estatica` quando o import falha, como o diagrama de States autoriza.

## Capturas

`final-tela1-375.png`, `final-tela1-390.png`, `final-tela1-1440.png`, `final-tela2-375.png`, `final-tela2-390.png`, `final-tela2-1440.png`, `final-tela3-375.png`, `final-tela3-390.png`, `final-tela3-1440.png`
