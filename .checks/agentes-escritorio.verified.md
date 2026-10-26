# /agentes/ como "Escritório nó" — Verification

**Verdict**: FAIL
**Profile**: light (nenhum `AGENTS.md` declara outro). Por pedido do orquestrador, o passo 1 (fonte vinculante) rodou mesmo assim. O passo 4 (faults) e a linha `Test policy` não rodaram: são de `standard`/`ui`, e o artefato não tem seção `Test policy`.
**Diff range**: `9a12aecb..e15bbc46` (branch `feat/agentes-escritorio`)
**Round**: 1 - full · verified at `e15bbc46`
**Verifier**: frente D, sub-agente independente (author != verifier); não construiu nada da feature

## Resumo

- As três provas rodaram em HEAD e saíram verdes: **38 rótulos `PASS`**, `EXIT 0` em todas.
- **31 de 32 critérios provados.** O **C31 é falso em HEAD**, embora a prova esteja verde. Ela mede a gaveta 1,4 s depois de abrir, quando a conversa ainda é curta (402 px). De ~3 a 6 s em diante, a gaveta cresce até 609 px (75%) e cobre a mesa aproximada, tanto no fiscal quanto no auditor, em 375×812 e em 390×844. A Tela 2 deixa de ser a composição da referência: "mesa aproximada em cima, gaveta embaixo".
- Polvo, mascote e animal: nenhum, nem no código, nem na cena, nem nos pôsteres (detalhes abaixo).
- `agentes/fiscal/` e `agentes/auditor/`: nenhum arquivo mudou na faixa (`git diff --name-only 9a12aecb..e15bbc46 -- agentes/fiscal agentes/auditor` → vazio).

## Binding sources

| Source | Opened | Contradiction | Uncovered |
|---|---|---|---|
| `.tasks/refs/agentes-escritorio-referencia.webp` — Tela 1 | sim, a imagem foi aberta e comparada com `final-tela1-{375,390,1440}.png` | nenhuma. A navbar canônica com Home/Agentes/Contato difere do desenho (hambúrguer à direita, sem links), mas o critério 30 decide "como em `/contato/`" | **arranjo**: nenhum check afirma que a cena fica abaixo do subtítulo, na largura toda no celular, nem que a recepção aparece no primeiro viewport. O C6 é provado na bancada 375×812, não no canvas da página (375×520). Renderizado e não desenhado: a sala envidraçada aparece na borda direita do canvas na Tela 1. Em 1440, a placa sai cortada ("nó. t") e um nó azul fica solto (`final-tela1-1440.png`) |
| idem — Tela 2 | sim, comparada com `final-tela2-{375,390,1440}.png` | nenhuma nos checks. **O C31 descreve a Tela 2 e falha no código** (ver Checks) | alça da gaveta (`.gv-alca` renderizada, sem check); botão azul **largo** (o C15 só afirma texto, href e ≥ 44 px, nem cor nem largura; medido: 343/375 px, `rgb(47,86,229)`). Renderizado e não desenhado: o ×, que o critério 20 decide, então ok |
| idem — Tela 3 | sim, comparada com `final-tela3-{375,390,1440}.png` | nenhuma | **arranjo**: os dois cartões **lado a lado** não têm check (o C1 conta 2 cartões e a ordem; medido: mesmo `y`, x=20/193 em 375). O botão "Conte sua ideia" **com contorno** não tem check (medido: fundo transparente, borda 1px `rgb(61,99,219)`). Também sem check: o ponto colorido e a seta (›) dos cartões |
| idem — desktop (não desenhado; Unresolved 7) | — | — | Em 1440, o C32 só mede largura e centro. Na Tela 2, o modal de 540 px cobre a mesa aproximada inteira. Na Tela 3, a sala "nó tech stack" fica sob a navbar sempre que o `h2` está visível: o fecho só entra depois de `scrollY` ≈ 500, e aí a marca da sala está em y=113 com a navbar terminando em 87. A metade de baixo do canvas fica só com piso (`tela3-1440` nas capturas da verificação) |
| `.tasks/agentes-escritorio.md` (registro de decisão) | sim | nenhuma entre o checklist e a task. O texto do Auditor e a gaveta em passos da imagem são substituídos pela task de forma expressa | — |

## Checks

Provas rodadas em `e15bbc46`:
`AGENTES_REAL=1 node .checks/agentes/test-pagina.cjs` → `# modo: real` … `# tudo verde (real)`, EXIT 0 ·
`node .checks/agentes/test-gaveta.mjs` → EXIT 0 ·
`node .checks/agentes/test-cena.mjs` (sem `--posteres`) → EXIT 0.

| Check | Claim | Proof run | Evidence | Result |
|---|---|---|---|---|
| C1 | ordem do conteúdo sem JS | `PASS C1` | `test-pagina.cjs:244-260`: `main.indexOf(trecho, i)` sobre a lista literal (rótulo → h1 → sub → 3 `data-mesa` → h2 → 2 cartões → `href="/contato/">Conte sua ideia<`); `:263` `assert.equal(h1, 'Cada agente resolve…')`; `:265` texto de cada mesa | PASS. Obs.: as mesas são `<a data-mesa>` e não `<button>`; o seletor do check é `[data-mesa]` |
| C2 | textos dos cartões, sem "Revisa e organiza" | `PASS C2` | `:280` `includes('Emite a NFS-e pelo WhatsApp, para MEI e Simples.')`; `:282` `includes('Confere se o rastreamento…')`; `:284` `!servido.includes('Revisa e organiza')` | PASS |
| C3 | head/GTM/sitemap iguais a `9e83de87` | `PASS C3` | `:306` `assert.deepEqual(n[k], a[k])` para title, description, canonical, og, twitter, telemetria, gtm e noscript, contra `git show 9e83de87`; `:308` telemetria antes do GTM; `:312` linha do sitemap igual | PASS |
| C4 | sync não altera a página | `PASS C4` | `:319` `--check` não cita `agentes/index.html`; `:329` `Buffer.equals` depois do sync numa cópia | PASS |
| C5 | sem `auditor.css`, 4 CSS, sem hex | `PASS C5` | `:336` `!includes('/agentes/auditor/auditor.css')`; `:338` regex de cada `<link>`; `:342`/`:345` `!hex.test(...)` em `agentes.css` e no `gaveta.css` real | PASS. A cena tem hex de material 3D, fora do alcance do critério 5; as cores de marca vêm dos tokens (`cena.js:24-31`) |
| C6 | ordem e visibilidade das mesas, cor das etiquetas, `tela1` | `PASS C6` | `test-cena.mjs:104` `p[k].visivel`; `:105-107` `y` fiscal < auditor < vaga < recepção; `:109-111` `et.*.cor === TOKEN.*` e textos; `:112` `'tela1'` | PASS, com **lacuna de nível**: provado na bancada (canvas 375×812), não na página (375×520). Medi na página: 443 < 552 < 661 < 770 em 375 e 452 < 566 < 679 < 792 em 390, todos `visivel:true` |
| C7 | 2 personagens cápsula+esfera, crachás, sem nomes/Office/mascote | `PASS C7` | `:125` `length === 2`; `:128` `'CapsuleGeometry'`/`'SphereGeometry'`; `:129` crachá = token; `:134-136` regex sem Office/mascote/`nome:` nos `cena*.js` | PASS. "Sem mascote" é provado só por regex no código-fonte; confirmei nas capturas e nos dois pôsteres que não há animal |
| C8 | logo plano, sem sombra/contorno, mapa do SVG | `PASS C8` | `:142-143` `'PlaneGeometry'`, `castShadow:false`, `receiveShadow:false`, `contorno:false`, `mapa === '/brand/logo/svg/no-tinta-ponto-azul.svg'`. Os valores vêm do grafo (`cena.js:637-641`), não são fixos | PASS |
| C9 | personagens mudam a 1 s e após 60 s | `PASS C9` (2219/2714 px e 2475/2090 px) | `:158` `assert(n > 40)` por região; `:164` `ESPERA(60000)` reais | PASS |
| C10 | `quadros()` parado fora da tela e com a aba oculta; retoma | `PASS C10` | `:173` `q2 === q1`; `:177` `q3 > q2`; `:186` `q5 === q4`; `:194` `q6 > q5` | PASS |
| C11 | fecho: sala visível, 3 linhas `#3d63db`, placa; volta a `tela1` | `PASS C11` | `:202` `'fecho'`; `:203` `sala.visivel`; `:204` `linhas.cor === '#3d63db'`; `:205` `quantidade === 3`; `:206` `'nó tech stack'`; `:219` `'tela1'` | PASS |
| C11-pagina | rolar até o h2 → fecho; voltar → tela1 | `PASS C11-pagina [real]` | `test-pagina.cjs:553` `=== 'fecho'`; `:562` `=== 'tela1'` | PASS |
| C12 | selo, título, mockup | `PASS C12` | `test-gaveta.mjs:133` `'DEMONSTRAÇÃO'`; `:135` `'nó.fiscal — sua NFS-e pelo WhatsApp'`; `:137` `.gv-wa-cab` + `.gv-wa-conversa` | PASS |
| C12-pagina | câmera `fiscal` por botão e por canvas | `PASS C12-pagina [real]` | `test-pagina.cjs:575` e `:585` `=== 'fiscal'`; `:576` título | PASS |
| C13 | cabeçalho, lados, hora/✓✓, 5 mensagens após "digitando…" | `PASS C13` | `test-gaveta.mjs:154` `'nó.fiscal'`; `:163-165` `seq[pos-1].tipo === 'digitando'`; `:168-180` textos 1–5, passos na ordem (`:176`) e um a um (`:177`); `:188-192` pessoa à direita, verde, `^\d\d:\d\d$`, `'✓✓'`; `:194-195` agente à esquerda, branco | PASS. "Fundo de conversa" (critério 13) não é afirmado; está visível nas capturas |
| C14 | recomeço 4 s após a msg 5 (±300 ms) | `PASS C14` | `:210` `Math.abs(dt - 4000) <= 300`; `:213` primeira depois do recomeço é "nota pra Studio Lima" | PASS |
| C15 | "Simular uma emissão" → `/agentes/fiscal/#simulador` | `PASS C15` | `:221` `texto === 'Simular uma emissão'`, `href === '/agentes/fiscal/#simulador'` | PASS |
| C16 | gaveta do Auditor no formato `textoCopia`, números da retrospectiva | `PASS C16` | `:240` título; `:241` `'nó.'`/`'equipe nó'`; `:244` uma mensagem; `:247` digitando antes; `:250` regex da linha em negrito; `:260` `^n\. [^:]+: .+$`; `:261` `Relatório completo: https?://`; `:268` `faltam` vazio | PASS. Precisão: inteiros pequenos (1, 2, 3, 4) passam trivialmente no teste contra a retrospectiva |
| C16-pagina | câmera `auditor` | `PASS C16-pagina [real]` | `test-pagina.cjs:592` `=== 'auditor'`; `:593` título | PASS |
| C17 | nota abaixo do mockup | `PASS C17` | `test-gaveta.mjs:276` texto exato; `:277` `topo >= fimMockup - 1` | PASS |
| C18 | "Diagnosticar grátis" → `/agentes/auditor/` | `PASS C18` | `:286` texto e `href` | PASS |
| C19 | mesa vaga (botão e canvas) → `/contato/` sem gaveta | `PASS C19 [real]` | `test-pagina.cjs:639`/`:645` navegação contada; `:640`/`:646` `gavetaAberta === false` | PASS |
| C20 | ×, Esc, fora; câmera, foco, Tab | `PASS C20 [real]` | `:600` três modos; `:611` foco dentro após Tab/Shift+Tab; `:621` `activeElement === [data-mesa=fiscal]`; `:622` `'tela1'` | PASS |
| C20-gaveta | idem na bancada, × ≥ 44 | `PASS C20-gaveta` | `test-gaveta.mjs:296` `x.w >= 44 && x.h >= 44`; `:292` foco volta; `:313-314` Tab preso | PASS |
| C21 | troca e toque duplo: uma gaveta, nada vaza em 15 s | `PASS C21` | `:325-326` uma gaveta, a do Auditor; `:332` `vazou` vazio após `esperar(15000)`; `:340-341` toque duplo → uma, a do fiscal; `:345` msg 1 uma vez | PASS |
| C22 | tela de carregamento: cobre, logo, 4 pontos na ordem, texto, 0→100% | `PASS C22` (0% → … → 100%) | `test-pagina.cjs:486` cobre a viewport; `:488` logo `/brand/logo/svg/no-*.svg`; `:504` `deepEqual(cores, tokens azul,vermelho,âmbar,verde)`; `:507` delays crescentes; `:509` texto; `:514-515` `'0%'`…`'100%'` | PASS |
| C23 | só some com fontes, three, cena, gaveta e quadros subindo | `PASS C23 [real]` | `:523` Sora e Mono; `:524-526` `responseEnd <= em`; `:527` cena; `:529` `quadros > 0`; `:533` `q2 > q1` | PASS |
| C24 | botão aos 4 s; estática na hora; canvas nunca aparece | `PASS C24` | `:444` invisível aos 3,5 s; `:447` `3900 <= decorrido <= 6000`; `:452` `< 500` ms; `:458` canvas invisível após liberar o three; `:461` `cena === false` | PASS |
| C25 | falha no import / sem WebGL → estática sem tela nem botão | `PASS C25` | `:422-426` após o abort: tela e botão invisíveis, pôster visível, console `falha`; `:431` `carregandoVisto === false` sem WebGL | PASS. Com o import abortado, a página passa por `carregando` antes de `estatica` (medido), o que o diagrama de States da task autoriza ("Carregando --> Estatica: falha no import") |
| C26a | pôsteres 750×1624, mesas pelos botões | `PASS C26a` | `:392`/`:399` `deepEqual([w,h],[750,1624])`; `:391`/`:398` `src`; `:405` gaveta abre pelo botão na estática | PASS |
| C26b | estática: conversa inteira, sem digitando | `PASS C26b` | `test-gaveta.mjs:357` 5 mensagens na hora, 0 digitando; `:358` 4 passos; `:362` HTML igual após 3 s; `:367` auditor | PASS |
| C26-posteres | WebP 750×1624 | `PASS C26-posteres` | `test-cena.mjs:250`/`:254` `tamanhoWebp === '750x1624'` | PASS |
| C27 | reduce → estática sem tela | `PASS C27` | `test-pagina.cjs:377` `carregandoVisto === false`; `:378` motivo | PASS |
| C28 | sem JS: sem tela, conteúdo visível | `PASS C28` | `:352` tela invisível; `:356` cada seletor do C1 `isVisible` | PASS |
| C29 | quatro motivos no console | `PASS C29` | `:468` `motivosVistos.has(m)` para os 4; regex `:35` | PASS |
| C30 | 375/390: sem rolagem lateral, nav/rodapé, alvos ≥ 44 | `PASS C30` | `:676` `sw === cw`; `:681` dentro da largura; `:688` mesas, cartões e CTA ≥ 44; `:694` × ≥ 44 | PASS |
| **C31** | 375×812, gaveta aberta: altura ≤ 0,75×812 **e mesa aproximada acima do topo da gaveta** | `PASS C31 [real]` (gaveta 402px; mesa y=247, gaveta y=410) | `test-pagina.cjs:659` `g.height <= 0.75*812+0.5`; `:664` `yMesa < g.top`, **medido uma vez, aos 1,4 s** (`:657` `waitForTimeout(1400)`) | **FAIL**: medição minha em HEAD, fiscal em 375×812 (click e tap): t=3 s topo 410 / mesa 246 ✓; **t=6, 9 e 12 s: topo 203 / mesa 246 ✗**. Em 390×844: topo 211 / mesa 263 ✗. Auditor em 375: ✗ desde t=3 s (topo 203 / mesa 221). Causa provável: `alvoY` calculado uma vez só, na abertura (`pagina.js:181-183`), enquanto a gaveta cresce com a conversa até `--gv-altura-max: 75vh` (`gaveta.css:7`, `:39`). Captura: `final-tela2-375.png`, `final-tela2-390.png` |
| C32 | 1440: sem rolagem lateral, nav/rodapé como `/contato/`, canvas ≤ 720 centralizado | `PASS C32` (720×780, centro 720.0/720) | `:731` `sw === cw`; `:736-740` nav e rodapé contra `/contato/`; `:743` `c.width <= 720`; `:744` `\|centro - meio\| <= 1` | PASS |

Rótulos que apareceram: test-pagina 21 (C1–C5, C11-pagina, C12-pagina, C16-pagina, C19, C20, C22–C25, C26a, C27–C32), test-gaveta 10 (C12–C18, C20-gaveta, C21, C26b), test-cena 7 (C6–C11, C26-posteres). Total: 38, nenhum `FAIL`.

## Mascote, polvo, animal

- Código entregue: `rg -i "polvo|octo|mascote|mascot|animal|gato|cachorro|cat|dog|pássaro|bird|peixe|fish|tentácul"` em `agentes/index.html`, `agentes/agentes.css` e `agentes/escritorio/**` → nenhuma ocorrência.
- Assets que a página carrega: só `/brand/logo/`, `/brand/lockup/`, `/brand/favicon/`, `/brand/fonts/`, `/brand/tokens/` e os dois pôsteres. Nada de `/brand/mascote/`.
- Visual: `final-tela{1,2,3}-*.png`, `poster-escritorio.webp` e `poster-fecho.webp` mostram dois personagens, mesas, cadeiras, monitores, plantas, sofá, balcão e sala de servidor. Nenhum animal.
- Task: `b4a452dc` retirou o polvo dos critérios 6, 7 e 9 e das Sources. Restam menções só como proibição (task, checklist e regex do `test-cena.mjs:135`).

## Escopo

- `git diff --name-only 9a12aecb..e15bbc46 -- agentes/fiscal agentes/auditor` → vazio.
- A faixa toca `agentes/index.html`, `agentes/agentes.css`, `agentes/escritorio/*`, `.checks/**` e `.tasks/agentes-escritorio.md` + a imagem de referência. Isso confere com o `Landing`.

## Test policy rows

Não há seção `## Test policy` no artefato, e o perfil é `light`. Não se aplica.

## Faults injected

Não rodou: o passo 4 é de `standard`/`ui`. O C31 mostra o risco que ele cobriria: uma asserção que passa com uma implementação errada em estado estável.

## Gate

- `AGENTES_REAL=1 node .checks/agentes/test-pagina.cjs` → 21 PASS, 0 FAIL, EXIT 0
- `node .checks/agentes/test-gaveta.mjs` → 10 PASS, 0 FAIL, EXIT 0
- `node .checks/agentes/test-cena.mjs` → 7 PASS (+ contrato), 0 FAIL, EXIT 0

## Lacunas, por gravidade

1. **Alta — C31 falso em HEAD; a Tela 2 diverge da referência.** Com a conversa já carregada (≥ 3–6 s), a gaveta ocupa 75% da altura e cobre a mesa aproximada, no fiscal e no auditor, em 375 e 390. A prova só olha aos 1,4 s. Corrigir o código e fazer a prova medir também em estado estável (por exemplo, após a mensagem 5). Precisão do checklist: o C31 deve dizer "durante todo o tempo em que a gaveta está aberta".
2. **Média — arranjo sem check (passo 1).** Tela 3: cartões lado a lado, botão com contorno, ponto e seta nos cartões. Tela 2: alça e botão azul largo. Tela 1: cena abaixo do texto, na largura toda, com a recepção no primeiro viewport (o C6 é provado só na bancada). Hoje tudo isso confere (medido), mas nada impede uma regressão.
3. **Média-baixa — desktop 1440, fora da referência e sem check além do C32.** Na Tela 2, o modal cobre a mesa aproximada inteira. Na Tela 3, a sala fica sob a navbar sempre que o `h2` está visível. Na Tela 1, a placa da sala sai cortada ("nó. t") na borda do canvas e um nó azul fica solto.
4. **Baixa — nível e precisão.** O C6 é provado só na bancada (vale na página, conforme medido). O "sem mascote" do C7 é provado só por regex de fonte (vale nas capturas). No C16, inteiros pequenos passam trivialmente. O C13 não afirma o "fundo de conversa".
5. **Baixa — higiene das provas.** Cada execução regrava 12 PNGs versionados em `.checks/agentes/` (`git status` mostra `M`). A verificação deixou esses arquivos modificados e não os restaurou. Novos e não versionados: os 9 `final-tela*-*.png`.

## Artefatos da verificação

- Capturas: `.checks/agentes/final-tela{1,2,3}-{375,390,1440}.png`
- Scripts e medições (fora do repositório): `%TEMP%/verif-agentes/` (`captura.cjs`, `c31-tempo.cjs`, `c31-auditor.cjs`, `c6-pagina.cjs`, `tela3-1440*.cjs`, `c25.cjs`, `medidas.json`)
