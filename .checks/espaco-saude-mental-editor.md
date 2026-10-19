# Espaço Saúde Mental — dashboard CLIENT e Editor com preview ao vivo

## O que é

Segundo projeto real no dashboard, criado para validar o **Editor** com a ponte de
preview ligada — o que a demonstração do Discordia (ver `f2-10-editor.md`) deixou
explicitamente em aberto: *"preview visual controlado deste case exige build de
preview opt-in própria"*.

- Projeto: `4fbc3859-a32f-4a71-b799-b005f32f65f8` — "Espaço Saúde Mental — site e agendamento"
- Versão atual: `eb2ab04c-059e-4d70-8707-f9e7dc15384b` — V1 publicada
- Build de preview: `https://app.notechstack.com.br/prototipos/espaco-saudemental/`

## Build de preview

`app/public/prototipos/espaco-saudemental/` é uma **cópia** gerada de
`espaco-saudemental/espaco-site` por `vite build -c vite.prototipo.config.ts`
(entry `prototipo.tsx`: LandingV2 em MemoryRouter, `base: './'`, JS e CSS inline).
Nada foi alterado no repositório da cliente. Só as mídias que a v2 usa foram
mantidas (`videos/hero-desktop.mp4`, `videos/hero-poster.jpg`, `quem/thais-*.jpg`).

Duas inclusões existem apenas nesta cópia:

- `no-editor-map.js` — a LP é React e não traz `data-editor`. O mapa carimba os
  atributos nos elementos certos depois que o React monta e recarimba via
  `MutationObserver` quando um trecho é remontado.
- `/no-editor-preview.js` — o runtime oficial, com `data-parent-origin`,
  `data-project-id`, `data-version-id` e `data-components` desta versão.

Para regerar a build depois de mudanças na LP, repita o `vite build` acima
apontando `--outDir` para esta pasta e reinjete os dois scripts: o `index.html`
é gerado e sobrescrito.

## Allowlist da V1 (`editor_version_configs`, `bridge_enabled = true`)

| id | tela | controles |
|---|---|---|
| `marca_topo` | Topo | texto, cor |
| `hero_titulo` | Abertura | texto, tamanho, cor |
| `hero_texto` | Abertura | texto, tamanho, cor |
| `hero_cta` | Abertura | texto, cor |
| `valores_titulo` | Honorários | texto, tamanho, cor |

Sem controle de `logo`: a LP não tem `<img>` de marca, e a única imagem da página
é o carrossel de fotos, que o React troca a cada 4,2 s e sobrescreveria o ajuste.

## Verificado

- [x] Os cinco componentes são carimbados e recebem os ajustes — conferido com um
      harness local que envia o `postMessage` no formato do Editor.
- [x] Controle fora da allowlist não passa: `hero_cta` e `marca_topo` ficaram sem
      `font-size` mesmo com `size` no payload.
- [x] Estado no banco: CONVERTIDO / V1_PUBLICADA / completo, acesso
      ATIVO_ATE_FIM_DO_PROJETO, seis módulos ativos, uma versão atual, 9 itens de
      cronograma, `exports = 0`.

## Pendente

- [ ] Login da conta CLIENT e passagem pelo Editor na sessão real — depende do
      titular; nenhuma senha foi digitada por agente.
- [ ] Envio de pacote (Storage + checklist + ingestão) nesta conta.
- [ ] Trocar `data-editor` carimbado por marcação na própria LP, se o Editor virar
      rotina para esta cliente.

## Ressalvas

- Valores e prazos em `commercial_terms` e no roadmap são **simulação**
  (`financial_status = 'SIMULACAO — sem cobrança'`). Nenhuma cobrança, proposta ou
  contrato existe. A mensalidade citada é a de referência do plano.
- Trocar o texto de `hero_titulo` substitui o conteúdo do `<h1>` inteiro, então o
  traço animado da palavra "contorno" some no preview. É o comportamento do
  runtime, não um defeito desta build.
- A conta CLIENT foi criada já confirmada, direto no banco, justamente para **não**
  disparar e-mail de convite para a cliente real.

## V2 — pedidos da Thaís (Base V1, enviado em 13/10/2026 16:09) · TASK-mvbfaammemy

Estado em 19/10/2026 (rodada 6, 10:05): **passo 1 feito**, aguardando a conferência do
Oscar (passo 2). Lucca tirou o pacote do banco em 16/10 (`base-v1/LEIA-ME.md`, linha
`editor_exports` `597eae29-bff4-4211-a140-1311f29d24ef`). Na rodada 6 o Dwight conferiu
direto no banco, só leitura: `md5(changes::text)` = `72ea5277b21207d0c0d99a1b6b18bcd0`
e 8 499 caracteres, iguais aos de `base-v1/changes.jsonb.txt`; é o último dos 7 envios
do projeto; o projeto só tem a V1 (atual, com configuração e `"*"`, ponte ligada).

Texto histórico das rodadas 1 a 3: o Base V1 estava só
em produção e o gate negava ao agente o conector Supabase (leitura de banco remoto
incluída, mesmo com a aprovação de Lucca). O bucket `editor-exports` é privado
(`public = false`, leitura só por usuário autenticado com acesso ao projeto,
migrations 20260915238000 e 20260916015006), então não há URL pública para baixar
sem a sessão de Lucca. Dois caminhos, ambos de Lucca, para
`.checks/espaco-saude-mental-v2/base-v1/` (fora do git pelo `.gitignore`, l.11: é
dado de cliente):

- **Mais rápido:** admin → projeto Espaço Saúde Mental → seção "Exports do Editor" →
  card "Base V1 · Enviado em 13/10/2026 16:09". O card lista cada componente
  (tela / rótulo e id) com o "Antes" e o "Depois" em JSON
  (`AdminDashboardPages.tsx`, `EditorExportsControl`). Copiar o card inteiro para
  `base-v1/admin.txt` basta para aplicar texto, tamanho, cor e foto.
- **Completo:** Storage, bucket `editor-exports`, pasta
  `4fbc3859-a32f-4a71-b799-b005f32f65f8/<sha256>/`: `editor.md`, `editor.cfg`,
  `editor.css` e `manifest.json`. O `editor.css` traz o seletor de cada id
  `auto:…`, que o harness usa.

Fotos trocadas pela Thaís vêm como URL pública do bucket `editor-assets` (no "Depois"
ou no `editor.cfg`) e são baixadas pela URL.

### Onde a alteração entra (confirmado)

**Direto na cópia** `app/public/prototipos/espaco-saudemental/`, não no repo
`espacosaudemental`:

- O site no ar está fora do escopo (reunião de 16/10, Q2 = A). Aplicar no repo da
  cliente e regerar a cópia pelo `vite.prototipo.config.ts` mudaria a fonte do site
  no ar.
- Texto entra no bundle inline do `index.html` por troca exata de string (cada troca
  conferida por contagem de ocorrências). Tamanho e cor entram num
  `<style id="no-base-v2">` com os mesmos seletores do `editor.css` do pacote
  (`[data-editor=…]`, ou o caminho no DOM no modo automático). O `no-editor-map.js`
  continua carimbando os mesmos elementos, então o Editor da V2 segue achando os
  componentes.
- Quando a mudança for levada ao site no ar (outra TASK, depois do aceite da Thaís),
  a cópia volta a ser regerada da fonte, e esta camada deixa de ser necessária.

### Ordem (confirmada pelo runtime)

O `no-editor-preview.js` descarta mensagens cujo `baseVersionId` difere do
`data-version-id` da cópia, e `project-publish-version` cria a versão já como atual
(não há rascunho). Logo a cópia publicada precisa do id da V2, que só existe depois da
publicação, e a V2 nasce sem configuração no Editor:

Rodada 3 (16/10): o Oscar confere os itens **antes** da publicação e, depois, só a
troca do id (achado F-04 da revisão da rodada 2: com uma passada só, depois de
publicar, uma reprovação deixaria o Editor da Thaís vazio durante toda a correção).
A instrução de Lucca continua valendo: Dwight termina → Oscar dá o ok → Michael faz
PR, merge e deploy.

1. Dwight aplica o Base V1 na cópia (ainda com o id da V1), preenche o checklist e
   confere no harness local (`.checks/espaco-saude-mental-v2/harness/`,
   `versionIdEsperado` = id da V1).
2. Oscar confere item por item no harness, ainda com o id da V1. Sem PR e sem
   publicação: a TASK volta ao Dwight só com a troca do id pendente.
3. Lucca, no admin, num bloco só, publica a V2 e informa o id:
   `V1_PUBLICADA` → `EM_REVISAO_CLIENTE` (manual) → botão "Ingerir no Kanban" no card
   do Base V1 (`ingest_editor_export` exige `EM_REVISAO_CLIENTE`, cria os itens do
   Kanban e já leva a `ALTERACOES_RECEBIDAS`, migration 20261002141941) →
   `V2_EM_DESENVOLVIMENTO` (manual) → publicar a V2 com a mesma referência de build da
   V1, `https://app.notechstack.com.br/prototipos/espaco-saudemental/` (o Editor monta
   o iframe por `config.buildReference`, e ela não muda depois de publicar).
   Publicar não manda e-mail à cliente (`project-publish-version` só registra log).
4. Dwight troca o `data-version-id` da cópia e o placeholder do SQL pelo id da V2 e
   roda o harness com `versionIdEsperado` = id da V2 e o item negativo de versão com o
   id da V1 como `baseVersionId` (a cópia da V2 tem que descartar mensagem da V1).
5. Oscar confere só a troca do id e dá o ok; Michael faz PR, merge e deploy.
6. Lucca roda `.checks/espaco-saude-mental-v2/editor_version_configs-v2.sql`
   inteiro, uma vez (`bridge_enabled = true`). Desde a rodada 3 (achado F-05, Gabe
   fez, Dwight revisou) ele só aceita a versão com macro `V2`, label `V2` e status
   `publicada`, publicada depois da V1, e aborta sem gravar nada se a V2 já tiver
   linha (insert simples, sem sobrescrever). Provado em PGlite (Postgres 18 em
   memória) com as tabelas e a `editor_allowed_controls` das próprias migrations:
   13 cenários, 0 falhas. Opcional: "Associar checklist" do Base V1 à V2 no mesmo
   card, o que libera o checklist no histórico da cliente.
7. Conferência (C4): a V2 aparece no dashboard e o Editor abre com os componentes.

Entre 3 e 6 o Editor da Thaís fica vazio (`get_client_editor_config` só devolve a
versão atual que tem linha em `editor_version_configs`) e o link do protótipo da V2
ainda mostra a página antiga. Nesse intervalo ficam só a troca do id, a conferência
curta do Oscar e o deploy: fazer 3 → 6 no mesmo período, de preferência fora do
horário da clínica. O SQL fica para depois do deploy de propósito: antes dele o
Editor abriria com componentes, mas o preview não responderia (a cópia no ar, com o
id da V1, descarta as mensagens da V2) e a Thaís poderia mandar um pacote sem ver o
efeito. Vazio é mais seguro que mudo.

### Allowlist e C3

A V1 tem também o modo automático desde 02/10 (`"*": text, size, color, logo` no
`data-components` da cópia, PR #52 e #54), então a Thaís pode ter mexido em qualquer
texto ou foto (ids `auto:…`; foto como `auto:src/<arquivo>`). O C3 da TASK lista só
`marca_topo`, `hero_titulo`, `hero_texto`, `hero_cta` e `valores_titulo`.

**Decidido por Lucca em 16/10 (opção A):** ids `auto:…` entram nesta TASK, aplicados
na cópia como os demais, e a configuração da V2 mantém o `"*"` da V1 (o SQL já grava
o mesmo `data-components`). A TASK só para e volta a Lucca para rever o porte se o
pacote trouxer:

- mudança estrutural: seção ou bloco novo, removido ou reordenado, troca de layout,
  componente que não existe na LP;
- controle que a V1 não libera para aquele id (por exemplo `size` em `hero_cta` ou
  `marca_topo`, `logo` em algo que não é imagem).

### Harness de conferência (C1)

`.checks/espaco-saude-mental-v2/harness/` (Andy fez, Dwight revisou):

- `serve.mjs` serve `app/public` em `/` e o harness em `/__harness/`, só em
  127.0.0.1 (no `localhost` o runtime aceita o próprio origin). Node puro.
- `index.html` abre a cópia num iframe, lê projeto, versão e allowlist do próprio
  script da cópia (segue a V1 hoje e a V2 depois da troca do id) e, para cada item,
  confere (a) **estático**: a cópia já mostra o valor, sem mensagem; (b) **editor**:
  o `postMessage` do Editor ainda acha e edita o componente e, com `changes: {}`,
  volta ao original. Item `"negativo": true` prova que controle fora da allowlist
  não passa. Texto que só difere no espaçamento (quebra de linha que vira `<br>`)
  passa com aviso. Resultado no `document.title`: `HARNESS OK x/x` ou
  `HARNESS FALHA x/x: n=…`.
- Checklist: `{"versionIdEsperado": "<uuid>", "itens": [...]}` (rodada 3, achado F-02
  do Oscar). Com `versionIdEsperado` diferente do `data-version-id` da cópia, nenhum
  item roda e o título é `HARNESS FALHA 0/x: versionId <medido> ≠ <esperado>`. A forma
  array antiga continua aceita, sem conferência de id.
- Item: `{"n", "id", "selector"?, "field": "text|size|color|logo|x|y", "expected",
  "negativo"?, "baseVersionId"?}`. Para id `auto:…`, o `selector` vem do `editor.css`
  do pacote. `baseVersionId` faz a sonda daquele item sair com outro id; com
  `"negativo": true`, prova que o runtime descarta mensagem de outra versão
  (`no-editor-preview.js`, `message.baseVersionId !== versionId`). No passo 4 da
  ordem, esse item usa o id da V1 e o `versionIdEsperado` passa a ser o da V2.

```
node .checks/espaco-saude-mental-v2/harness/serve.mjs 5317
msedge --headless=new --disable-gpu --no-first-run --no-default-browser-check --window-size=1366,900 --user-data-dir=<pasta temporária nova> --dump-dom --virtual-time-budget=20000 "http://127.0.0.1:5317/__harness/index.html?checklist=checklist.exemplo.json"
```

`--no-first-run --no-default-browser-check` são obrigatórias nesta máquina: sem elas,
com perfil novo, o Edge sai em ~10 ms (código 21) e não devolve DOM. A janela de
1366×900 é a do item 4 (tamanho do título depende da largura).

Na V1 atual (16/10, rodada 3): `checklist.exemplo.json` (13 itens dos cinco ids, 1
negativo de allowlist e 1 negativo de versão) → `HARNESS OK 15/15`, rodado pelo Andy e
de novo pelo Dwight. Controles do Andy: `versionIdEsperado` errado →
`HARNESS FALHA 0/15: versionId eb2ab04c-… ≠ 22222222-…`; item 15 com o id certo →
`HARNESS FALHA 14/15: n=15` (a sonda aplicou, então o negativo tem dente). Rodada 2:
controle com um valor errado de propósito → `HARNESS FALHA 13/14: n=9`.

### Checklist do Base V1 (rodada 6, 19/10)

Aplicado direto na cópia por `base-v1/aplicar.mjs` (fora do git, como o pacote): 22 trocas
de texto no bundle, cada uma exigindo exatamente 1 ocorrência antes de trocar, e o
`<style id="no-base-v2">` antes do `</head>` com os seletores do `editor.css` do pacote
(x/y, cor e `white-space: pre-line` onde a Thaís digitou quebra de linha, como o runtime
mostrava com `<br>`). `data-version-id` continua o da V1 até o passo 4; os dois scripts
do Editor continuam injetados, sem mudança. Conferência: `harness/checklist.v2.json`
(Andy fez, Dwight revisou), 1 item por campo alterado + 2 negativos →
**`HARNESS OK 30/30`** (Edge headless 1366×900).

| # | componente | campo | antes → depois (resumo) | aplicado | Oscar |
|---|---|---|---|---|---|
| 1-2 | `hero_texto` | x, y | 0,0 → 13,2 px | ok | |
| 3 | `hero_texto` | text | novo texto "orientada pela psicanálise…" + 2 quebras no fim | ok | |
| 4 | `marca_topo` | text | "Espaço / saúde mental" → "Thaís de Santis / Psicoterapia e psicanálise" | ok | |
| 5 | `marca_topo` | color | #232b31 → #141414 (marca inteira) | ok | |
| 6 | abertura, botão 2 | text | "Conhecer a clínica" → "Sobre mim" | ok | |
| 7 | clínica, texto | text | troca o travessão por vírgula, "com a formação" | ok | |
| 8 | clínica, psicanálise | text | travessão → vírgula | ok | |
| 9 | experiências, fecho | text | esvaziado | ok | |
| 10 | como funciona, passo 1 | text | descrição → "Consulte os horários disponíveis…" | ok | |
| 11 | como funciona, suporte | text | → "Se preferir esclarecer alguma dúvida…" | ok | |
| 12 | seção 5, texto | text | "começam a mudar" → "começam a ter outro sentido" | ok | |
| 13 | quem atende, texto | text | corta o trecho depois de "ética" | ok | |
| 14 | honorários, item 1 | text | "Sessão de 1 hora" → "Sessão de 50 minutos" | ok | |
| 15-16 | honorários, item 2 | text | título e texto esvaziados | ok | |
| 17 | honorários, item 1 | text | "para adultos" → "para adolescentes e adultos" | ok | |
| 18 | conteúdos, texto | text | sem diferença no pacote (antes = depois) | nada a aplicar | |
| 19 | dúvidas, título | text | esvaziado | ok | |
| 20 | rodapé, ajuda | text | → "Precisa de ajuda? Entre em contato." | ok | |
| 21 | rodapé, marca | text | → "Thaís de Santis / Psicologia e Psicanálise" | ok | |
| 22-23 | quem atende, CRP | x, y | 0,0 → 3,8 px | ok | |
| 24 | quem atende, CRP | text | tira "Responsável Técnica" (fica "· " no fim) | ok | |
| 25 | rodapé, copyright | text | "Espaço Saúde Mental" → "Thaís de Santis" | ok | |
| 26-28 | experiências, cartões 1, 2 e 4 | text | travessões removidos | ok | |
| 29-30 | negativos | size / versão | `hero_cta` sem `size`; mensagem de outra versão descartada | barrados | |

Como foi aplicado, para a conferência:

- **Marca (4, 5, 21):** o mesmo componente `ag` desenha topo e rodapé. A linha 2 usa o
  `light` do rodapé para ter textos diferentes, como a Thaís pediu. As duas linhas ficam
  nos dois `<span>` da marca (serif e versalete), não em texto corrido: o runtime achata
  os filhos ao trocar texto, como no traço de "contorno" (Ressalvas). A cor vai no botão
  e nos dois `<span>`, como no preview dela.
- **Passo 1 (10):** a Thaís manteve "Escolha um horário" e trocou só a descrição; troquei
  só a descrição, e o título segue com o estilo dele.
- **Esvaziados (9, 15, 16, 19):** texto vazio, elemento mantido, como ela viu no preview.
  Tirar o bloco de verdade seria mudança estrutural e fica para quando levar ao site no
  ar. O item 2 dos honorários fica como um marcador sem texto.
- **Para confirmar com a Thaís no aceite da V2** (aplicado como enviado): "precisa
  **para**, por dentro" (26, era "parar —"); "· " sobrando no fim do CRP (24); os dois
  deslocamentos pequenos (1-2 e 22-23) parecem arrasto sem querer; a janela de
  agendamento, fora do pacote, ainda diz "Precisa de ajuda? Fale com o Espaço." e a
  duração da sessão vem de outro dado do agendamento.
- **Limite conhecido:** x/y entram por folha de estilo (como o `editor.css`), então o
  Editor da V2 lê 0 como posição inicial desses dois elementos; se a Thaís arrastar de
  novo, eles partem de 0, não de 13 e 3.
