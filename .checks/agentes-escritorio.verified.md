# /agentes/ como "Escritório nó" — Verification

**Verdict**: FAIL
**Profile**: light (nenhum `AGENTS.md` declara outro). O passo 1 (fonte vinculante e composição) rodou a pedido do orquestrador. Faults e `Test policy` não rodaram: são de `standard`/`ui`, e o artefato não tem seção `Test policy`.
**Diff range**: `9a12aecb..bd2b2073`; escopo de re-verificação = `c54fbd54..bd2b2073` + tudo o que não foi PASS na rodada 2
**Round**: 3 - scoped, com as três provas rodadas inteiras, uma de cada vez, em `bd2b2073` · verified at `bd2b2073`. O que não foi medido de novo diz *carried from c54fbd54*.
**Verifier**: frente D, independente (author != verifier)

## Resumo

- Provas em `bd2b2073`, nesta ordem, todas com EXIT 0:
  - `AGENTES_REAL=1 node .checks/agentes/test-pagina.cjs` → **23 PASS** (entram C31-desktop e C33-medicao);
  - `node .checks/agentes/test-gaveta.mjs` → **12 PASS**;
  - `node .checks/agentes/test-cena.mjs` → **11 PASS**.

  São **46 PASS e nenhum FAIL**.
- A árvore estava commitada; durante a verificação só mudaram PNGs de captura, e HEAD continuou em `bd2b2073`.
- Lacunas da rodada 2: fechadas as de R4 (círculo), R9, R10, R3 e 1440 (mesa à esquerda do painel). **A R23 falha em 1024×768**, uma largura que ela mesma cobre ("a partir de 1024 px"): a mesa fica atrás do painel e a câmera se afasta ×1,80. O `C31-desktop` só mede 1440.
- R17–R19: textos exatos e card na estrutura do `.agency-partner`. R20–R22: mesmo `event_id` no dataLayer, no `fbq` e no corpo da CAPI; a CAPI não sai fora da produção; o JSON do GTM é coerente e não colide com os outros containers. Ausência de dado pessoal e de `content_*` na Meta: conferida no código, **sem asserção**.
- Nenhuma asserção foi enfraquecida (ver seção própria).

## Binding sources

| Source | Opened | Contradiction | Uncovered |
|---|---|---|---|
| referência — Tela 1, com R17 | sim; `final3-tela1-{375,390,900,1024,1440}.png` e páginas inteiras | nenhuma. Arranjo: logo nó.agentes → `h1` → subtítulo → cena fundida (R2) com as três etiquetas e a recepção | — |
| referência — Tela 2, com R6 e R23 | sim; `final3-tela2-*.png` e `final3-tela2-auditor-*.png` | **1024×768**: painel em x=460–1000, a 24 px da direita, como pede a regra; mesa do fiscal em (517,169) e do Auditor em (515,141), **atrás do painel**. A altura do quadro da câmera vai de 6,72 a **12,07 (×1,80)**: a câmera se afasta, e a cena aparece pequena acima do painel. **1440×900**: mesa e pessoa à esquerda do painel (R23 ok), mas a câmera **quase não aproxima** (altura 6,72 → 6,58, ×0,98, contra ×0,80 em 375). O "aproxima essa mesa" do critério 12 não acontece no desktop. O C12-pagina só lê o rótulo `enquadramento === 'fiscal'` | o C31-desktop só cobre 1440, sem nada entre 1024 e 1439. Nenhum check afirma o zoom do foco na página. 375, 390 e 900 (folha de baixo) conferem |
| referência — Tela 3, com R11 e R18 | sim; `final3-tela3-*.png` | nenhuma: a câmera é arrastada até a sala, e vêm o `h2` "Entenda mais sobre nossas soluções" e os dois cartões lado a lado | cartões lado a lado continuam sem check (*carried*) |
| `/agencia/` `.agency-partner` (R19) | sim: `agencia/index.html:244` e `agencia/agencia.css:74,77,78` | nenhuma de estrutura. `section > palco > [img logo branco, div(h2+p), a.pílula(texto + círculo →)]`. CSS espelhado com tokens: no desktop, grade `180px 1fr auto`, `gap` 50, `min-height` 360, `padding 60px clamp(38px,6vw,92px)`, raio 30 e ruído a .17; no celular, coluna, `48px 28px`, raio 22 e imagem de 100 px. Pílula: `7px 7px 7px 24px`, círculo de 38 px âmbar. Sem hex (`grep -c` = 0) | a faixa de 769–1100 px de `/agencia/` (`130px 1fr`, pílula sob o texto) não foi copiada. Em 1024, as 3 colunas cabem (`inteira-1024.png`) |
| `.tasks/agentes-escritorio.md`, Rodadas 6–8 | sim | nenhuma entre a task e o código | **o checklist não foi atualizado nesta faixa**: não há linha para R17–R23, `C31-desktop` nem `C33-medicao`, e o corpo dos C1, C2, C6, C7, C16, C26a e C31 segue com valores antigos. No `Unresolved`, os itens 4, 6 e 7 viraram "resolvido", mas a coluna "Until answered" ainda traz o texto antigo ("Escrito não…", "Escrito `Auditor`…", "centralizada…") |

## Checks novos ou alterados (verified at `bd2b2073`)

| Check / R | Claim | Proof run | Evidence | Result |
|---|---|---|---|---|
| C1 + R17/R18/R19 | ordem: logo `alt="nó.agentes"` → `h1` → subtítulo → mesas → `h2` "Entenda mais…" → cartões → `h2` "Quer criar um agente de IA seu?" → subtítulo → "Vamos conversar" → `/contato/`; sem "Conte sua ideia" no `main` | `PASS C1` | `test-pagina.cjs`: lista `ordem` com os trechos literais e `main.indexOf(trecho, i)`; `assert.equal(h1, 'Encontre soluções já mapeadas que transformamos em agentes.')`; logo `naturalWidth > 0`; `getAttribute('href') === '/contato/'`; `count() === 0` para "Conte sua ideia" | PASS. Texto do HTML confere com a task, inclusive "a colocar" sem crase |
| C28 / C30 | o CTA passa de `.ag-cta` para `.ag-pilula-cta` | `PASS C28`, `PASS C30` | troca de seletor que segue a R18/R19; as asserções (`isVisible`, ≥ 44×44) são as mesmas | PASS |
| C6 + R4/R9/R10 | círculo ≥ 16 px, contorno ≥ 2 px na cor do agente, âmbar piscando | `PASS C6` (círculo 16 px, contorno 2,3 px, opacidade 0,949 → 0,39 → 0,371) | `test-cena.mjs`: `et[id].circuloPx >= 16`, `et[id].contornoPx >= 2`, `corContorno === TOKEN.*`, `max−min(opacidade) > 0.1`. Valores lidos dos pixels da textura real (`cena.js` `medirChip`/`corBorda`) e da opacidade do material | **PASS: lacuna 2 da rodada 2 fechada** para círculo, contorno e piscar. O **halo pulsando** da R4 segue sem asserção (no código: `cena.js` `sin(t·2,6)`) |
| R3 | substituída pela R8 (aprovação de Lucca registrada na task) | — | task, Rodada 8 | **fechada** (lacuna 3 da rodada 2) |
| **C31-desktop** (R23) | a partir de 1024 px: painel à direita (24 px) e mesa aproximada visível à esquerda | `PASS C31-desktop` (1440: mesa em (731,265) e (728,217), painel x≥876) | `test-pagina.cjs`: `y > fundoNav && y < 900` e `x < painel.left - 8`, para mesa e pessoa, **só em 1440×900**. `test-gaveta.mjs`: `\|r.right − (1440−24)\| <= 1` | **PASS em 1440 e FAIL em 1024 na minha medição**: mesa em x=517 com o painel começando em 460 (fiscal), x=515 contra 460 (Auditor). Câmera ×1,80, se afastando. Ver `final3-tela2-1024.png` e `final3-tela2-auditor-1024.png` |
| **C33-medicao** (R20/R21) | mesmo `event_id` no dataLayer, no `fbq` e no corpo da CAPI; a CAPI não sai fora da produção; eventos de gaveta, CTA e versão estática | `PASS C33-medicao` | `assert.equal(fbqVc[3].eventID, vc.event_id)`; `assert.equal(capi[0].event_id, vc.event_id)`; `chamadasCapi === 0` em 127.0.0.1; `deepEqual([agente,origem,versao], ['fiscal','botao','animada'])`; `cta === 'simular_emissao'`; `motivo === ['movimento-reduzido']`; CTAs `lp_auditor`, `vamos_conversar`, `criar_automacao` | PASS. `medicao.capi` é o **mesmo objeto** serializado no `fetch` (`pagina.js:100-111`), então afirma o corpo real. Limites: (a) só o caminho negativo é provado, e o envio em produção não é exercitado; (b) **"sem dado pessoal e sem `content_*`" não é afirmado**. No código, o corpo é `{event_name, event_id, event_source_url, fbp, fbc}` e o `fbq` recebe `{}`, sem `content_*` e sem e-mail ou telefone. A `meta-capi` só aceita `PageView`/`ViewContent` e só faz hash de `em`/`ph` se vierem no corpo. Ressalva: `event_source_url = location.href` leva a query string inteira |
| R22 (GTM) | JSON importável, IDs sem colisão, gatilhos e variáveis existem, GA4 `G-1YEB89RVER` | sem prova automática | medição minha: `exportFormatVersion 2`, `publicId GTM-NK87FH8W`. 4 tags `gaawe` (1021–1024), todas com `measurementIdOverride G-1YEB89RVER`; 4 gatilhos `CUSTOM_EVENT` (1011–1014), um por tag e todos existentes; 6 variáveis `v` (1001–1006). Referências `{{dl.*}}` e `{{_event}}` definidas (built-in `Event` declarada). **Nenhuma colisão** de ID ou nome com `gtm-nofiscal-funil.json` (920–946) nem com `gtm-compra-diagnostico.json` (901–904). Nenhuma tag da Meta, e nenhum ViewContent nos três containers | PASS estrutural. A importação real no GTM é ação externa e não foi feita |
| demais (C2–C5, C9–C27, C29, C32, R6, R8, R11–R16, C12-foco) | sem mudança | `PASS` em HEAD | *carried from c54fbd54* (diff dos testes não toca essas asserções) | PASS |

## Asserções enfraquecidas?

Diff `c54fbd54..bd2b2073` dos três testes:
- **test-pagina:**
  - os textos do C1 seguem a R17–R19;
  - `.ag-cta` → `.ag-pilula-cta` no C28 e no C30, porque o CTA mudou;
  - entram `C31-desktop` e `C33-medicao`, e nada foi removido.
- **test-gaveta:** "centralizada" → "direita a 24 px", seguindo a R23.
- **test-cena:** só acrescenta (R4, R9 e R10).

**Nenhum enfraquecimento.** A única troca de valor está registrada na task.

## Lacunas da rodada 2: estado

| Lacuna (rodada 2) | Estado em `bd2b2073` |
|---|---|
| 1. 1440: gaveta sobre a mesa | **fechada em 1440**; **aberta em 1024**, dentro do alcance da R23 |
| 2. R4/R9/R10 sem asserção | **fechada** para círculo, contorno e piscar; o halo segue sem asserção (baixa) |
| 3. R3 mediana | **fechada** (substituída pela R8, aprovada) |
| 4. checklist e Unresolved desatualizados | **aberta e maior**: o checklist não ganhou R17–R23, C31-desktop nem C33, e no Unresolved só o status mudou |
| 5. baixas | seguem: sem check de arranjo (cartões, alça, botão largo), ângulo da R11, inteiros pequenos no C16, provas regravando PNGs versionados (18 com `M`) e `h1` acima da navbar na Tela 2 |

## Polvo, mascote, animal · escopo

- Nada mudou na cena, no GLB nem nas texturas nesta faixa (*carried from c54fbd54*: limpo). O logo nó.agentes e o card não têm figura de animal (capturas).
- `agentes/fiscal/` e `agentes/auditor/`: `git diff --name-only 9a12aecb..bd2b2073 -- agentes/fiscal agentes/auditor` → vazio. `shared/` também ficou intocado.

## Faults injected

Não rodou (perfil `light`).

## Gate

- `AGENTES_REAL=1 node .checks/agentes/test-pagina.cjs` → 23 PASS, EXIT 0
- `node .checks/agentes/test-gaveta.mjs` → 12 PASS, EXIT 0
- `node .checks/agentes/test-cena.mjs` → 11 PASS, EXIT 0

## Lacunas, por gravidade

1. **Alta: R23 falha em 1024×768.** O painel cobre a mesa aproximada, no fiscal e no Auditor, e a câmera se afasta ×1,80. O `C31-desktop` precisa medir de 1024 a 1439 (pelo menos em 1024×768), e não só em 1440.
2. **Média-alta: no desktop (1440) a câmera não aproxima a mesa** (×0,98). O critério 12 pede "a câmera aproxima essa mesa, como na Tela 2", e nenhuma prova da página afirma o zoom do foco.
3. **Média: C33 sem asserção de "sem dado pessoal e sem `content_*`"**, e sem exercitar o envio em produção (só o caminho negativo). O código confere. `event_source_url` leva a query string inteira, então vale considerar `location.origin + location.pathname`.
4. **Média-baixa: o checklist não cobre as Rodadas 6–8** (R17–R23, C31-desktop, C33), e o corpo dos C1–C31 segue com valores antigos. No `Unresolved`, os itens 4, 6 e 7 mudaram de status, mas o texto ficou antigo.
5. **Baixa:**
   - halo da R4 sem asserção;
   - faixa de 769–1100 px do `.agency-partner` não copiada (visualmente ok em 1024);
   - a origem do logo (`brand/agentes/Logotipo nó.agentes em fundo marfim-2.png`) não está no repositório;
   - `h1` acima da navbar na Tela 2;
   - cartões e alça sem check de arranjo;
   - provas regravam PNGs versionados.

## Artefatos

- Capturas: `.checks/agentes/final3-tela{1,2,3}-{375,390,900,1024,1440}.png` e `final3-tela2-auditor-{375,390,900,1024,1440}.png`
- Fora do repositório (`%TEMP%/verif-agentes/r3/`): `captura3.cjs`, `zoom3.cjs`, `medidas3.json` e `inteira-*.png`
