# /agentes/ como "Escritório nó"

Profile: `light` (nenhum `AGENTS.md` declara perfil). A tarefa tem interface com fonte vinculante,
então `ui` caberia; Lucca pode subir o perfil, e aí o Verifier roda o passo 1 de `verify.md`.

Sources:

- `.tasks/agentes-escritorio.md` (commit `b4a452dc`) - registro de decisão: 32 critérios, fora de escopo, Unresolved 1–7 com o valor provisório de cada um.
- `.tasks/agentes-escritorio-frentes.md` - quem escreve qual arquivo e o contrato `montarEscritorio` / `montarGaveta`.
- `.tasks/refs/agentes-escritorio-referencia.webp` - **vinculante para a interface**: Telas 1, 2 e 3. O mascote foi apagado da imagem em 26/10 a pedido de Lucca e não entra na cena.
- Conversa com Lucca em 26/10/2026 (este chat): "RETIRE AS REFERENCIAS À QUALQUER POLVO" → critérios 6, 7 e 9 reescritos na task; o mascote do design system não entra.
- `agentes/fiscal/fiscal.js` (linhas 248–311) - textos da conversa do fiscal.
- `supabase/functions/marketing-hub/auditor.ts` `textoCopia` (linhas 51–59) - formato da mensagem do auditor.
- `agentes/auditor/retrospectiva/index.html` - únicos números permitidos na mensagem do auditor (Unresolved 3).
- `lp-narrador/cenas-lp/lp-v8.html` (importmap `three@0.170.0`) e `lp-narrador/cenas-lp/historia/cenas3d.js` - padrão de carga, matéria e movimento reduzido.
- Skill `C:/Users/lucca/.claude/skills/no-design-system/SKILL.md` - tokens, fontes, "nó." plano, selo de demonstração.

## Out of scope

- Digitar na conversa, emitir ou diagnosticar dentro da gaveta - fica nas LPs.
- Personagens andando, sala "nó tech stack" interativa, porta abrindo - fase 2.
- Qualquer arquivo em `agentes/fiscal/` e `agentes/auditor/`.
- Novo `title`, `description` ou imagem `og:`.
- Medir toques e CTAs no dataLayer e configurar o GTM (Unresolved 4).
- Mascote, animal ou o polvo do design system em qualquer lugar da página.
- Push, PR, merge remoto e deploy sem confirmação expressa de Lucca.

## Landing

Toca só `agentes/index.html`, `agentes/agentes.css` e o novo `agentes/escritorio/`. Reusa o
importmap da home, `tokens.css`, `site.css`, `site-layout.css`, `card-nav.css` e os trechos
canônicos de `shared/sync-site-layout.mjs`. O `agentes/auditor/auditor.css` deixa de ser carregado
aqui e não muda.

| One-way door | Literal shape | Alternative rejected |
| --- | --- | --- |
| None - tudo é HTML/CSS/JS estático, reversível no próximo commit | three `0.170.0` pelo importmap do jsDelivr, como a home | portar o console React/Vite do Escritório nó: build próprio e nomes de *The Office* |
| Contrato da cena ganha `inspecionar()` (aditivo, decidido pelo orquestrador antes do código) | `inspecionar() -> { enquadramento: 'tela1'\|'fiscal'\|'auditor'\|'fecho', projetados: { [nome]: {x, y, visivel} }, etiquetas: [{ mesa, texto, cor }], logoBalcao: { geometria, castShadow, receiveShadow, contorno, mapa }, personagens: [{ agente, corpo, cabeca, cracha }], linhas: { cor, quantidade }, placaSala }` com `nome` em `mesa-fiscal`, `mesa-auditor`, `mesa-vaga`, `recepcao`, `personagem-fiscal`, `personagem-auditor`, `sala-tech-stack`; coordenadas em px CSS relativas ao canvas | provar 6, 7, 8 e 11 só por captura: uma captura não diz a ordem nem o tipo de geometria a um script |
| `focar` ganha um segundo argumento opcional (aditivo) | `focar(mesa, { alvoY = 0.2 } = {})`: o centro da mesa aproximada fica a `alvoY` × altura do canvas, a partir do topo; a página calcula `alvoY` para a mesa ficar acima da gaveta (C31) | câmera com ponto fixo: só serve para um tamanho de canvas e quebra o C31 em 390×844 e no desktop |
| Cores da gaveta sem hex | balões e fundo do WhatsApp via `color-mix()` sobre `--no-verde`, `--no-osso`, `--no-tinta` etc. | hex do WhatsApp (`#dcf8c6`): quebra o critério 5 |
| Playwright das provas | `require` de `../../app/node_modules/@playwright/test`, com fallback `C:/Users/lucca/projetos/notechstack/app/node_modules/@playwright/test` (worktrees não têm `node_modules`), igual a `.checks/seo/test-site-layout.cjs` | instalar dependência nova |

- Nada além disso é difícil de reverter.

## Checks

Formato das provas: cada script imprime uma linha `PASS C<n> …` por check e sai com código ≠ 0 no
primeiro `assert` que falha. "Prova" abaixo = o script e o rótulo que precisa aparecer.

### S1 - Página sem a cena (frente A) · 6 arquivos · 30 KB · ~8k

**C1** - HTML servido, antes de qualquer JS, tem na ordem: `NÓ AGENTES`, `h1` "Cada agente resolve um problema da sua empresa.", subtítulo "Por assinatura. Toque numa mesa para ver o agente trabalhando.", botões `[data-mesa=fiscal]` "nó.fiscal", `[data-mesa=auditor]` "Auditor", `[data-mesa=vaga]` "um problema seu aqui?", `h2` "Quando forem vários, a gente une tudo num sistema só.", dois cartões, link "Conte sua ideia" → `/contato/`
Proof: `node .checks/agentes/test-pagina.cjs` → `PASS C1` (lê o HTML bruto com `javaScriptEnabled:false` e compara índices)

**C2** - Cartão fiscal: "Emite a NFS-e pelo WhatsApp, para MEI e Simples." → `/agentes/fiscal/`; cartão Auditor: "Confere se o rastreamento dos seus anúncios conta certo." → `/agentes/auditor/`; o texto "Revisa e organiza" não aparece
Proof: `test-pagina.cjs` → `PASS C2`

**C3** - `title`, `meta description`, `canonical`, `og:*`, `twitter:*`, `telemetria.js?v=3` antes do GTM, snippet `GTM-NK87FH8W` com `noMarketingHostAllowed`, `<noscript>` do GTM e `/agentes/` em `sitemap.xml` iguais a `9e83de87`
Proof: `test-pagina.cjs` → `PASS C3` (compara com `git show 9e83de87:agentes/index.html` e `9e83de87:sitemap.xml`)

**C4** - `node shared/sync-site-layout.mjs --check` não aponta `agentes/index.html`
Proof: `test-pagina.cjs` → `PASS C4` (roda o `--check` e o sync numa cópia, diff vazio)

**C5** - Página não referencia `/agentes/auditor/auditor.css`; carrega `tokens.css`, `site.css`, `site-layout.css`, `card-nav.css`; `agentes/agentes.css` e `agentes/escritorio/gaveta.css` não têm `#[0-9a-fA-F]{3,8}`
Proof: `test-pagina.cjs` → `PASS C5`

### S2 - Escritório 3D (frente B) · 4 arquivos · 40 KB · ~10k

**C6** - Em 375×812, `inspecionar().projetados`: `mesa-fiscal.y < mesa-auditor.y < mesa-vaga.y < recepcao.y`, todos visíveis; etiquetas: fiscal `--no-verde`, Auditor `--no-azul`, "um problema seu aqui?" `--no-ambar`; `enquadramento === 'tela1'`
Proof: `node .checks/agentes/test-cena.mjs` → `PASS C6`, mais a captura `.checks/agentes/cena-tela1.png`

**C7** - Dois personagens, cada um `corpo: 'CapsuleGeometry'`, `cabeca: 'SphereGeometry'`; crachá verde no fiscal e azul no auditor; `cena*.js` não contém nomes de pessoa nem `Michael|Dwight|Jim|Pam|Dunder|Scranton|Office`; nenhum objeto de mascote/animal na cena
Proof: `test-cena.mjs` → `PASS C7`

**C8** - `logoBalcao`: `PlaneGeometry`, `castShadow:false`, `receiveShadow:false`, sem contorno, mapa de `/brand/logo/svg/no-tinta-ponto-azul.svg`
Proof: `test-cena.mjs` → `PASS C8`

**C9** - Regiões de `personagem-fiscal` e `personagem-auditor` diferem entre dois quadros a 1 s; de novo após 60 s
Proof: `test-cena.mjs` → `PASS C9` (diff de pixels por região, com 60 s reais)

**C10** - Com o canvas fora da tela e com `visibilitychange` para `hidden`, `quadros()` não sobe em 1 s; ao voltar, sobe
Proof: `test-cena.mjs` → `PASS C10`

**C11** - `fecho(1)`: `enquadramento === 'fecho'`, `sala-tech-stack` visível, `linhas.cor === '#3d63db'`, `linhas.quantidade === 3`, `placaSala === 'nó tech stack'`; `fecho(0)` volta a `tela1`. Na página integrada, rolar até o `h2` leva a `fecho`, e rolar de volta, a `tela1`
Proof: `test-cena.mjs` → `PASS C11`; `test-pagina.cjs` → `PASS C11-pagina`; captura `cena-tela3.png`

### S3 - Gaveta e WhatsApp (frente C) · 5 arquivos · 45 KB · ~11k

**C12** - Abrir `fiscal`: selo `DEMONSTRAÇÃO`, título "nó.fiscal — sua NFS-e pelo WhatsApp", mockup presente; na página, `cena.inspecionar().enquadramento === 'fiscal'` (por canvas e por botão)
Proof: `node .checks/agentes/test-gaveta.mjs` → `PASS C12`; `test-pagina.cjs` → `PASS C12-pagina`

**C13** - Mockup fiscal: cabeçalho avatar + `nó.fiscal`; balões da pessoa à direita com hora e `✓✓`, do agente à esquerda; 5 mensagens na ordem e com os textos do critério 13, cada uma depois de um "digitando…"
Proof: `test-gaveta.mjs` → `PASS C13`

**C14** - 4 s depois da mensagem 5, a conversa volta à mensagem 1 (tolerância ±300 ms)
Proof: `test-gaveta.mjs` → `PASS C14`

**C15** - Botão "Simular uma emissão" → `/agentes/fiscal/#simulador`
Proof: `test-gaveta.mjs` → `PASS C15`

**C16** - Abrir `auditor`: selo, título "Auditor — seu relatório semanal no WhatsApp", cabeçalho `nó.` + "equipe nó", uma mensagem depois de "digitando…", com linha em negrito `Relatório semanal · <negócio> (<dd/mm> a <dd/mm>)`, resumo, `Prioridades` em `<n>. <título>: <o que fazer>`, `Relatório completo:` com link; todo número da mensagem aparece em `agentes/auditor/retrospectiva/index.html`
Proof: `test-gaveta.mjs` → `PASS C16`; `test-pagina.cjs` → `PASS C16-pagina` (câmera em `auditor`)

**C17** - Nota "Cópia opcional do relatório, enviada pela equipe da nó. O relatório chega no e-mail e no painel." abaixo do mockup
Proof: `test-gaveta.mjs` → `PASS C17`

**C18** - Botão "Diagnosticar grátis" → `/agentes/auditor/`
Proof: `test-gaveta.mjs` → `PASS C18`

**C21** - Trocar de mesa com gaveta aberta e tocar duas vezes em < 300 ms: uma gaveta, a da última; nenhuma mensagem da conversa anterior aparece nos 15 s seguintes
Proof: `test-gaveta.mjs` → `PASS C21`

**C26b** - `estatico:true`: conversa inteira de uma vez, sem "digitando…" e sem animação
Proof: `test-gaveta.mjs` → `PASS C26b`

### S4 - Carregamento, versão estática e integração (frente A) · 8 arquivos · 35 KB · ~9k

**C19** - Tocar `[data-mesa=vaga]` (e a mesa vaga no canvas) navega para `/contato/` sem abrir gaveta
Proof: `test-pagina.cjs` → `PASS C19`

**C20** - Gaveta fecha por ×, `Esc` e toque fora; câmera volta a `tela1`; foco volta ao botão de origem; com a gaveta aberta, `Tab` não sai dela
Proof: `test-pagina.cjs` → `PASS C20` (os três modos); `test-gaveta.mjs` → `PASS C20-gaveta`

**C22** - Com JS + WebGL e sem movimento reduzido: tela de carregamento cobre a viewport com o "nó." do SVG, quatro pontos animando azul → vermelho → âmbar → verde, "Montando o escritório…" e progresso 0–100%
Proof: `test-pagina.cjs` → `PASS C22`

**C23** - Ela some só depois de `document.fonts` ter Sora e JetBrains Mono, three importado, `montarEscritorio` resolvido e `gaveta.js` carregado; ao sumir, `quadros()` > 0 e subindo
Proof: `test-pagina.cjs` → `PASS C23`

**C24** - Com o three atrasado (rota segurada), aos 4 s surge "Ver sem animações"; tocando, versão estática na hora, e o canvas não aparece mesmo quando a carga termina
Proof: `test-pagina.cjs` → `PASS C24`

**C25** - Import do three abortado → estática sem tela de carregamento visível nem botão; sem WebGL (contexto negado) → idem
Proof: `test-pagina.cjs` → `PASS C25`

**C26a** - Estática: `#escritorio-poster` com `poster-escritorio.webp`, fecho com `poster-fecho.webp` (ambos 750×1624), mesas tocáveis pelos botões
Proof: `test-pagina.cjs` → `PASS C26a`; `test-cena.mjs` → `PASS C26-posteres` (dimensões)

**C27** - `reducedMotion:'reduce'` → estática direto, sem tela de carregamento
Proof: `test-pagina.cjs` → `PASS C27`

**C28** - `javaScriptEnabled:false` → sem tela de carregamento e conteúdo do C1 visível (`isVisible`)
Proof: `test-pagina.cjs` → `PASS C28`

**C29** - Console registra `[agentes] versão estática: <motivo>` com `pediu`, `falha`, `sem-webgl`, `movimento-reduzido` nos quatro cenários
Proof: `test-pagina.cjs` → `PASS C29`

### S5 - Celular primeiro, desktop sem quebra (frente A) · 3 arquivos · 15 KB · ~4k

**C30** - Em 375×812 e 390×844: `scrollWidth === clientWidth`; `.no-card-nav` e `.no-site-footer` presentes e dentro da largura, como em `/contato/`; cada `[data-mesa]`, CTA e o × da gaveta ≥ 44×44
Proof: `test-pagina.cjs` → `PASS C30`

**C31** - Em 375×812 com a gaveta aberta: altura ≤ 0,75 × 812 e `projetados['mesa-fiscal'].y` acima do topo da gaveta
Proof: `test-pagina.cjs` → `PASS C31`

**C32** - Em 1440×900: sem rolagem horizontal, navbar e rodapé como em `/contato/`, canvas ≤ 720 px de largura e centralizado (±1 px)
Proof: `test-pagina.cjs` → `PASS C32`

## Swept

- validation: n/a - sem entrada da pessoa.
- failure modes: C24, C25.
- idempotency and retry: C14, C21.
- authorization: n/a - página pública.
- concurrency and ordering: C21.
- data lifecycle: n/a - nada é gravado; "Ver sem animações" não persiste (Unresolved 5).
- dependency failure: C25 (jsDelivr).
- state transitions: C22–C27.
- observability: C29; medir toques é Unresolved 4, fora.

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| motivos da versão estática (4) | `pediu` C24/C29 · `falha` C25/C29 · `sem-webgl` C25/C29 · `movimento-reduzido` C27/C29 | - |
| modos de fechar a gaveta (3) | × C20 · `Esc` C20 · toque fora C20 | - |
| mesas (3) | fiscal C12 · auditor C16 · vaga C19 | - |
| viewports (3) | 375×812 C30/C31 · 390×844 C30 · 1440×900 C32 | - |
| mensagens do fiscal (5) | 1–5 C13 | - |
| enquadramentos (4) | `tela1` C6 · `fiscal` C12 · `auditor` C16 · `fecho` C11 | - |

## Handoff

As três frentes rodam em paralelo, cada uma na sua worktree, e não em sequência: S1+S4+S5 = ~21k
(frente A), S2 = ~10k (frente B), S3 = ~11k (frente C), todas bem abaixo de 150k. A fronteira é a
superfície (página, cena, gaveta), como em `.tasks/agentes-escritorio-frentes.md`. O orquestrador
(Claude 01, este chat) faz o merge local de B e C em `feat/agentes-escritorio`, integra e despacha
o Verifier (frente D) sobre `9a12aecb..HEAD`.

- Settled mid-build: o polvo/mascote saiu da task e da imagem (commit `b4a452dc`); a conta Claude 02 não é usada (erro de autenticação); frentes de design (B e C) rodam em Fable 5.1, esforço alto.
- Boundary: merge local de `feat/agentes-escritorio-cena` (`b15867e1`) e `feat/agentes-escritorio-whatsapp` (`fe9f1031`) em `feat/agentes-escritorio`, sem conflito. As três provas ficam verdes com os módulos reais (`AGENTES_REAL=1` na da página).
- Decidido na integração (aditivo; nada quebra o contrato):
  - Etiquetas: na animada valem os chips da cena (critério 6). Os botões HTML viram áreas de toque transparentes de 132×96 sobre cada mesa, que seguem `projetados['mesa-*']` em px inteiros e mostram a pílula só no foco do teclado. Alternativa rejeitada: pílulas HTML sobre o canvas, que duplicavam as etiquetas e cobriam as cabeças.
  - Pôsteres sem chips (`cena.mostrarEtiquetas(false)` antes da captura em `test-cena.mjs`). Na estática e sem JS, o quadro tem a proporção do pôster (750×1624) e as pílulas HTML ficam onde a cena desenha os chips, medidos por `projetados['etiqueta-*']`. Alternativa rejeitada: chips gravados no pôster com as pílulas por cima, que dava duplicata com corte variável.
  - Tela 1 na página: o canvas da hero é 375:520, e a altura de mundo passa a ser `clamp(largura da Tela 1 / aspecto, 9.6, 13.4)`. Em 375×812 continua 13.4 (C6 e pôsteres iguais).
  - `gaveta.css`: `.gv-painel[hidden], .gv-fundo[hidden] { display: none }`. O `display:flex` vencia o `[hidden]`, e a gaveta fechada ficava fora da tela, mas com os botões alcançáveis pelo Tab (achado pelo C26a real).
- Abandonado: nada.
