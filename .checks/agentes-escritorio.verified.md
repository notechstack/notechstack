# /agentes/ como "Escritório nó" — Verification

**Verdict**: FAIL
**Profile**: light (nenhum `AGENTS.md` declara outro). O passo 1 (fonte vinculante e composição) rodou a pedido do orquestrador. Faults e `Test policy` não rodaram: são de `standard`/`ui`, e o artefato não tem seção `Test policy`.
**Diff range**: `9a12aecb..c54fbd54` (branch `feat/agentes-escritorio`)
**Round**: 2 - scoped, mas com todas as provas rodadas de novo, em sequência, em HEAD · verified at `c54fbd54`. O que não foi medido de novo diz `carried from e15bbc46`.
**Verifier**: frente D, independente (author != verifier)

## Resumo

- As três provas rodaram em `c54fbd54`, **uma de cada vez**, e passaram com EXIT 0: test-pagina 21 rótulos, test-gaveta 12 e test-cena 11 (mais a linha de contrato e uma `INFO`). São **44 `PASS` e nenhum `FAIL`**.
- **Critérios 1–32, já com as renegociações: 32 de 32 provados.** O C31 da rodada 1 está fechado: a gaveta fica fixa em 503 px (≤ 62%), e a mesa aparece acima dela também com a conversa completa.
- **Itens R vigentes (15; a R7 foi substituída pela R11):**
  - provados por asserção: R1, R6, R8, R11, R13, R14, R15 e R16;
  - parcialmente: R5, R10 e R12;
  - só por inspeção minha, sem asserção: R2 (declarado no checklist como ponto do Verifier), R4 e R9;
  - R3: a mediana de cor ficou sem prova e fora da faixa (ver lacuna 3).
- **Por que FAIL:**
  1. Em 1440, a gaveta continua cobrindo a mesa aproximada. O briefing desta rodada dizia que isso estava corrigido.
  2. R4, R9 e R10 (círculo ≥ 16 px, halo pulsando, contorno ≥ 2 px, âmbar piscando) estão mapeados ao `PASS C6`, mas o C6 não afirma nenhum desses valores.
- Polvo, mascote e animal: nenhum (detalhes abaixo). `agentes/fiscal/` e `agentes/auditor/`: nenhuma mudança na faixa.
- **A worktree foi alterada por outra sessão durante a verificação.** Às 17:52–17:54 entraram, sem commit, `agentes/index.html`, `agentes/agentes.css`, `.checks/agentes/test-pagina.cjs` e `.tasks/agentes-escritorio.md` (Rodada 6, R17–R19), além de `brand/agentes/no-agentes-tinta-azul.webp`. Minhas provas terminaram às 17:47:50 e minhas capturas às 17:51:53, então tudo neste relatório vale para o conteúdo de `c54fbd54`. A Rodada 6 está fora desta faixa e não foi verificada.

## Binding sources

| Source | Opened | Contradiction | Uncovered |
|---|---|---|---|
| `.tasks/refs/agentes-escritorio-referencia.webp` — Tela 1 | sim (rodada 1), comparada com `final2-tela1-{375,390,1440}.png` | nenhuma. Arranjo igual: rótulo, `h1`, subtítulo, cena logo abaixo e de borda a borda (R2), fiscal → nó.auditor → "criar uma automação" → recepção com "nó." | R2 só por inspeção (declarado). Medi: `.ag-escritorio` em x=0, largura = viewport (375/390), fundo transparente, borda 0, raio 0, sem sombra, `mask-image` de 64 px em cima e embaixo (`agentes.css:62-87`), topo da cena = base do subtítulo (299/302) |
| idem — Tela 2 | sim, `final2-tela2-{375,390,1440}.png` e `final2-tela2-auditor-*.png` | **1440: a gaveta cobre a mesa aproximada** (ver lacuna 1). Em 375 e 390 confere: cena no topo, logo abaixo da navbar (topo do canvas 83, navbar 75); pessoa e mesa acima da gaveta; gaveta com alça, selo, título, explicação, WhatsApp compacto e botão azul largo | alça e botão azul largo continuam sem check (*carried from e15bbc46*). Resto de rolagem: a última linha do `h1` aparece acima da navbar flutuante na Tela 2, em todas as larguras |
| idem — Tela 3 | sim, `final2-tela3-{375,390,1440}.png` | nenhuma diante das renegociações. A R11 troca o recuo da referência pelo arrasto até a sala, e o fecho mostra a sala com a placa, os três cabos e o `h2` | cartões lado a lado e botão com contorno continuam sem check, embora confiram (*carried*; a Rodada 6, sem commit, já mexe nessa seção) |
| `.tasks/agentes-escritorio.md`, Rodadas 3–5 | sim | **o corpo do checklist está desatualizado**: C1, C2, C6, C16, C26a, C31 e C7 ainda falam em "Auditor", "um problema seu aqui?", 75%, 750×1624 e Capsule/Sphere. Só a tabela "Rodadas 3–5" aponta as provas novas. O Unresolved 6 da task ainda diz "Escrito `Auditor`", embora a R1 o resolva | ver lacunas 2 a 4 |

## Checks (verified at `c54fbd54`)

Comandos, nesta ordem: `AGENTES_REAL=1 node .checks/agentes/test-pagina.cjs` (EXIT 0) → `node .checks/agentes/test-gaveta.mjs` (EXIT 0) → `node .checks/agentes/test-cena.mjs` (EXIT 0).

Asserções sem mudança desde a rodada 1 (C3, C4, C5, C9, C10, C13–C15, C17–C30, C32): o rótulo `PASS` apareceu de novo em HEAD. A evidência `file:line` é a da rodada 1, *carried from e15bbc46*, porque o diff dos testes não toca essas asserções. Abaixo, só o que mudou ou foi renegociado:

| Check / R | Claim vigente | Proof run | Evidence | Result |
|---|---|---|---|---|
| C1 + R1 + R10 | mesas `nó.fiscal`, `nó.auditor`, "criar uma automação", na ordem | `PASS C1` | `test-pagina.cjs` (lista de ordem com `'nó.auditor'` e `'criar uma automação'`; `assert.equal(innerText, texto)` por mesa) | PASS |
| C2 + R1 | cartão diz `nó.auditor` | `PASS C2` | `assert(... .includes('nó.auditor'))` | PASS |
| C6 + R1/R10 | ordem e visibilidade, textos e cor da etiqueta, `tela1` | `PASS C6` | `test-cena.mjs`: `et.auditor.texto === 'nó.auditor'`, `et.vaga.texto === 'criar uma automação'`, `cor === TOKEN.*`. A bancada passou a ter o canvas da página (`caixa.height === 520`), o que **fecha a lacuna de nível da rodada 1** | PASS |
| R4 / R9 / R10 (efeitos) | círculo ≥ 16 px, halo pulsando, contornos verde/azul ≥ 2 px, contorno âmbar piscando | mapeados ao `PASS C6` | **nenhuma asserção**: o C6 só lê `texto` e a cor do pixel do círculo (`cena.js:456`). No código: `circ = 16`, `borda = 2.5` (`cena.js:47`), halo em `sin(t·2,6)` (`cena.js:354-356`), contorno da vaga piscando (`cena.js:359`); visível em `final2-tela1-*.png` | **NÃO PROVADO** (o comportamento confere na inspeção) |
| C7 + R13 + R5 | `pessoa-fiscal`/`pessoa-auditor`, faixa do crachá = token, sem nomes, Office ou mascote (no GLB também) | `PASS C7 (R13)` | `x.no === 'pessoa-' + x.agente`; `per.fiscal.cracha === TOKEN.verde` (lido do material `cracha-faixa-<agente>`, `cena.js:441-447`); varredura de nomes de nós, malhas, materiais e animações do GLB | PASS. R5 (cartão, cordão, "nó.", legível): só a cor é afirmada. Por inspeção em dpr 3 (`zoom-tela2-*.png`), confere: cordão, faixa colorida e "nó." legível, embora pequeno |
| C8 + R14 | logo plano do SVG oficial | `PASS C8` | inalterado (`geometria`, sombras, `contorno`, `mapa`) | PASS. "Posicionado em `marca-logo-balcao`" não é afirmado |
| R8 | luminância ≤ 165 e desvio ≥ 62 na Tela 1 | `PASS R8` (144,4 / 68,2) | `assert(lum[0] <= 165)`, `assert(lum[1] >= 62)` sobre `cena-tela1.png` | PASS. Minha medição na página (375, faixa interna da cena): média 144,1 e desvio 68,7 |
| R3 (mediana) | mediana RGB a ±12 de `[220,199,170]` | sem prova | medi `[204,154,108]`: G −45, B −62 | **fora da faixa**. A R8 manda escurecer, e a luminância da R3 foi substituída. A mediana de cor não foi retirada de forma expressa (ver lacuna 3) |
| C11 + R11 | só arrasta até a sala: altura do quadro varia ≤ 3%; sala visível; 3 cabos `#3d63db` acesos; placa | `PASS C11 (R11)` (0,0%) | `variacao <= .03`; `sala.visivel`; `linhas.quantidade === 3`; `cabos.every(cor === '#3d63db')`; `cabosAcesos >= 1` (progresso do shader, 1,01 = aceso até a sala) | PASS. "Mesmo ângulo" não é afirmado |
| R12 | cabos acima do piso, lado a lado, sem cruzar, tubo com pulsos | `PASS R12` | `c.yMin > i3.pisoY` para os 3 (folga de 0,006 m) | parcial: só "acima do piso" é afirmado. Por inspeção (`zoom-cabos.png`), confere: três tubos com volume, lado a lado, em curvas suaves, sem se cruzar, com pulsos claros até a caixa azul da sala |
| C12-foco | no foco, pessoa e mesa na faixa acima da gaveta; chip no tamanho da Tela 1; os outros chips somem | `PASS C12-foco` | faixa `[0, 218.4]`; `y` da pessoa e da mesa dentro dela; `\|razão − 1\| <= .1`; `et4[o].visivel === false` | PASS |
| C12 / C16 / C16-pagina + R1 | título "nó.auditor — seu relatório semanal no WhatsApp" | `PASS C12`, `PASS C16`, `PASS C16-pagina` | `assert.equal(info.titulo, 'nó.auditor — …')` | PASS |
| R6 fiscal / auditor | explicação ≤ 2 frases e ≤ 180 caracteres, copiada da LP; gaveta ≤ 62%; janela ≤ 300 px; CTA à vista | `PASS R6 fiscal` (96 c.), `PASS R6 auditor` (121 c.) | `texto.length <= 180`; `frases <= 2`; `lps[agente].includes(texto)`; `dlg.height <= 0.62*812`; `wa.height <= 300.5`; ordem selo → título → explicação → janela → CTA | PASS. Cabeçalho verde e fundo com rabiscos: por inspeção, conferem |
| **C31** (R6) | 375×812: gaveta ≤ 62% e mesa acima dela, **também com a conversa completa** | `PASS C31 [real]` | `test-pagina.cjs`: `g.height <= 0.62*812+0.5` e `yMesa < g.top`, aos 1,4 s e 9 s (fiscal) e aos 7 s (auditor). Saída: gaveta 503 px, mesa y=247, gaveta y=309 nas três medições | **PASS: lacuna 1 da rodada 1 fechada.** Minha medição em 375/390 aos 9 s (fiscal) e 7 s (auditor) dá topo 309/321 e mesa 247/256 |
| C26a / C26-posteres + R15 | pôsteres 750×1040 | `PASS C26a`, `PASS C26-posteres (R15)` | `deepEqual([w,h],[750,1040])`; `tamanhoWebp === '750x1040'` | PASS |
| R16 | um GLB ≤ 3 MB, com meshopt e WebP | `PASS R16` (1,98 MB) | `tamGlb <= 3*1024*1024`; `deepEqual(globs, ['escritorio.glb'])` | PASS em tamanho e unicidade. Meshopt e WebP não são afirmados; conferi `extensionsUsed`: `EXT_meshopt_compression` e `EXT_texture_webp`, as duas em `extensionsRequired`, e as 5 imagens em `image/webp` |
| C12-pagina, C19, C22 | inalterados na substância | `PASS` | mudança no teste = esperar o botão parar de mover antes do clique (C12-pagina e C19) e atrasar o `cena.js` em 1,8 s para conseguir ler a tela de carregamento (C22). O C23 continua exigindo cena montada e quadros subindo | PASS, sem enfraquecimento |

## As provas que mudaram nas rodadas 3–5: renegociação ou enfraquecimento?

Diff `e15bbc46..c54fbd54` dos três testes:
- **Valores trocados, todos registrados na task:**
  - `Auditor` → `nó.auditor` (R1);
  - "um problema seu aqui?" → "criar uma automação" (R10);
  - 75% → 62% (R6);
  - 750×1624 → 750×1040 (R15);
  - Capsule/Sphere → `pessoa-<agente>` (R13);
  - o C11 passa de "recuo" a "variação ≤ 3%" (R11, que substitui R7 e o critério 11).
- **Asserções novas:** R6 ×2, R8, R12, R16, C12-foco, a varredura de nomes no GLB e a medição do C31 em estado estável (9 s e 7 s), com as duas mesas.
- **Mudanças só de tempo:** a espera pelo botão parado (C12-pagina, C19) e o atraso do `cena.js` (C22) não tiram nenhuma asserção.
- **Nada removido sem registro.** A única perda é a do C7 (cápsula e esfera), que a R13 retira de forma expressa.

## Lacunas da rodada 1: estado

| Lacuna (rodada 1) | Estado em `c54fbd54` |
|---|---|
| 1. C31 falso com a conversa completa | **fechada**: prova aos 9 s e 7 s, e minha medição confere |
| 2. arranjo sem check (cartões lado a lado, contorno do CTA, alça, botão largo, cena abaixo do texto) | **aberta**: o comportamento confere, mas não há asserção. A R2 está declarada como ponto do Verifier e conferi por inspeção |
| 3a. 1440: sala sob a navbar no fecho | **fechada**: há rolagens (`scrollY` 300–600) com fecho ativo, sala abaixo da navbar (y=183 com o `h2` a 62%) e `h2` na tela; ver `final2-tela3-1440.png` |
| 3b. 1440: gaveta cobre a mesa aproximada | **ABERTA**: fiscal aos 9 s com modal 540 px em x=450–990, topo 165; mesa em (724, 163), na borda do modal. Auditor aos 7 s com topo 131 e mesa em y=152, sob o modal. Acima do modal só aparecem a etiqueta e uma faixa da cena (`final2-tela2-1440.png`, `final2-tela2-auditor-1440.png`) |
| 3c. 1440: placa da sala cortada na Tela 1 | resolvida pela cena nova: a sala aparece na borda direita com fusão lateral, sem placa cortada |
| 4. C6 e mascote abaixo do nível da página | **fechada**: o C6 roda no canvas 375×520 e o C7 varre os nomes do GLB. Seguem abertos o C16 (inteiros pequenos passam trivialmente) e o fundo da conversa no C13 (confere na inspeção) |
| 5. provas regravam PNGs versionados | **aberta**: 16 PNGs ficaram com `M` depois das minhas execuções |

## Mascote, polvo, animal

- Nomes do GLB (133 nós, 33 malhas, 35 materiais, 2 animações `laco-*`, 5 imagens): nenhum suspeito. Varri polvo, octo, mascote, tentáculo, animal, bicho, gato, cachorro, pet, pássaro, peixe, lula, criatura e nomes de *The Office*. Os nós são pessoas, móveis, plantas, marcadores e câmeras.
- Texturas embutidas no GLB (extraídas e vistas): `assado-a/b` são atlas de luz assada, com sombras de móveis e plantas; também estão `cracha-fiscal/auditor` e `placa`.
- `.tasks/blender/texturas/*.png` (14) e os dois pôsteres, vistos numa folha de contato: etiquetas, crachás, logo, placa, livros, rack, teclado, telas e cenas. Nenhum animal.
- Busca de texto em `agentes/index.html`, `agentes.css`, `escritorio/*.{js,css,svg}` e nos scripts do Blender: nenhuma ocorrência.

## Escopo

`git diff --name-only 9a12aecb..c54fbd54 -- agentes/fiscal agentes/auditor` → vazio.

## Faults injected

Não rodou (perfil `light`).

## Gate

- `AGENTES_REAL=1 node .checks/agentes/test-pagina.cjs` → 21 PASS, EXIT 0 (17:42–17:44)
- `node .checks/agentes/test-gaveta.mjs` → 12 PASS, EXIT 0 (até 17:45)
- `node .checks/agentes/test-cena.mjs` → 11 PASS, EXIT 0 (até 17:47:50)

## Lacunas, por gravidade

1. **Alta: Tela 2 em 1440 com a gaveta sobre a mesa aproximada.** Não é a composição da coluna do celular (Unresolved 7) e foi dada como corrigida no briefing desta rodada. Nenhum check cobre a Tela 2 no desktop (o C31 só mede 375).
2. **Média-alta: R4, R9 e R10 sem asserção.** Círculo ≥ 16 px, halo pulsando, contorno ≥ 2 px e âmbar piscando estão mapeados ao `PASS C6`, que só afirma texto e cor. O código e a imagem conferem, mas pelo protocolo uma linha sem `file:line` que afirme o valor conta como não provada. O mesmo vale, em menor grau, para a forma do crachá (R5) e para "lado a lado, sem cruzar, tubo com pulsos" (R12), e para meshopt/WebP (R16), que conferi à mão.
3. **Média: falta precisão na R3.** A mediana `[220,199,170] ±12` não tem prova, e a cena dá `[204,154,108]`. Como a R8 manda escurecer, a mediana parece substituída, mas a task não diz isso. Retirar a mediana de forma expressa ou prová-la.
4. **Média-baixa: checklist e task desatualizados.** O corpo dos C1, C2, C6, C7, C16, C26a e C31 ainda traz os valores antigos, e só a tabela final aponta as novas provas. O Unresolved 6 da task ainda diz "Escrito `Auditor`".
5. **Baixa:**
   - arranjo da referência ainda sem check (cartões lado a lado, contorno do CTA, alça, botão largo);
   - "mesmo ângulo" (R11) e "posicionado em `marca-logo-balcao`" (R14) não são afirmados;
   - no C16, inteiros pequenos passam trivialmente;
   - as provas regravam 16 PNGs versionados;
   - na Tela 2, a última linha do `h1` aparece acima da navbar flutuante.
6. **Processo:** a worktree recebeu a Rodada 6 sem commit enquanto eu verificava. Para a rodada 3 desta verificação, congele a árvore (commit) antes de despachar.

## Artefatos

- Capturas: `.checks/agentes/final2-tela{1,2,3}-{375,390,1440}.png` e `final2-tela2-auditor-{375,390,1440}.png`
- Fora do repositório (`%TEMP%/verif-agentes/r2/`): `captura2.cjs`, `zoom.cjs`, `medidas2.json`, `zoom-tela2-{fiscal,auditor}.png`, `zoom-cabos.png`, `folha-texturas.png`, `glb/*.png` (texturas extraídas) e `tela3-melhor-*.png`
