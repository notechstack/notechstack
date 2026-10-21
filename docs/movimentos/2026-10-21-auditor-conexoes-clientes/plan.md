---
movement_id: auditor-conexoes-clientes
intent: ./intent.md
spec: ./spec.md
spec_revision: 1.1 (aprovada em 21/10/2026, D1–D10 como recomendado)
status: approved
updated: 2026-10-21
---

# Plan: um auditor por cliente, com o marketing-hub no centro

## Resultado que será entregue

- **Entrada do cliente.** `app /auditor/entrar` recebe o e-mail e o aceite e
  dispara o link mágico pelo Resend. No primeiro acesso nascem a conta `gratis`,
  o negócio (`clients.origem='auditor'`) e o `memberships(role='AUDITOR')`.
- **Conexões.** Meta e Google por negócio, com a escolha de uma conta por tipo
  (`meta_ads`, `google_ads`, `ga4`, `gsc`). O OAuth é da **Frente 1**; esta frente
  entrega as telas, a escolha e as regras de acesso.
- **Retrospectiva real**, uma vez por negócio, no app, nas telas do protótipo.
- **Relatório recorrente.** Semanal às segundas e mensal no dia 1, com regras
  determinísticas, redação por IA validada, e-mail Resend e tela no app. Sai
  parcial quando falta fonte.
- **Isolamento.** Rotas `/cliente/*` na `marketing-hub`, RLS por membership,
  acesso de suporte concedido pelo cliente e tela `/no/auditor` só com metadados.
- **Ciclo de vida e LGPD.** Desconectar, cancelar e excluir conta; deauthorize da
  Meta; job de limpeza; textos de `/privacidade/` e `/termos/`.
- **Checkout logado.** A assinatura é ligada à conta, e o plano pago agenda os
  relatórios.

## Donos da mudança

| Mudança | Onde | Quem |
|---|---|---|
| OAuth, Vault, `marketing_cliente_conexoes`/`_ativos`/`_eventos`, listagem de contas, cache Google por credencial | `supabase/functions/_shared/marketing/`, `marketing-hub/cliente/*` (OAuth), migration A | **Frente 1** (`claude/auditor-oauth-clientes`) |
| Identidade, contas, negócios, snapshots, relatórios, suporte, exclusões, limpeza | migration B, `supabase/functions/auditor-acesso/`, `marketing-hub/cliente/*` (fora do OAuth), `_shared/auditor/` | Executor desta frente |
| Telas do cliente e tela de operação | `app/src/auditor/`, `app/src/App.tsx` (rotas novas só) | Executor desta frente |
| Checkout logado | `supabase/functions/assinatura-auditor/`, `agentes/auditor/assinatura.js` | Executor desta frente. É exceção à regra "não mexer em checkout": a spec aprovada pede. |
| Ponte site → app (`site=`) | `agentes/auditor/retrospectiva/diagnostico-real.js` | Executor desta frente |
| Privacidade e Termos | `privacidade/index.html`, `termos/index.html` | Executor, com textos da Frente 2 (seções 6 e 7 de `.tasks/auditor-conexoes-aprovacoes.md`) e prazos da spec, seção 5 |
| Consoles Meta/Google, verificações, App Review | painéis | **Lucca + Frente 2** |
| Merge e deploy de site/app (Vercel) | GitHub | **só o Lucca** |

## Corte

A spec tem 8 fatias observáveis:

1. a pessoa entra;
2. o negócio conecta e escolhe as contas;
3. a retrospectiva real aparece;
4. o relatório chega na data;
5. o token expirado produz um relatório parcial e um aviso;
6. o Lucca só vê com concessão;
7. a exclusão apaga;
8. o checkout logado liga o plano.

Pela regra da `tlc-plan`, o padrão é **uma tarefa**. Este movimento é grande pelo
critério que importa: tem duas migrations em produção compartilhada, um papel novo
de Auth e um contrato público com a Meta. Por isso as **costuras** abaixo são
mostradas e o Lucca escolhe onde cortar os PRs. A tarefa continua sendo uma só.

**Restrições de ordem (não negociáveis):**

| # | Antes | Depois | Por quê |
|---|---|---|---|
| O1 | Migration A (Frente 1) | Migration B | B referencia `marketing_cliente_ativos` (FK dos snapshots) e amplia `memberships`, que A já usa. |
| O2 | Cache Google indexado por credencial (Frente 1) | Qualquer coleta de relatório | Sem isso, dois negócios no mesmo worker trocam de token (spec, Riscos). |
| O3 | Política e Termos **publicados** (merge do Lucca) | Submissões Meta/Google **e** `AUDITOR_VENDA_ABERTA=sim` | Exigência das plataformas (Frente 2) e R9. |
| O4 | Checkout logado no ar | Abrir a venda | Sem ele, assinatura nova nasce sem conta, e a conta não ganha plano. |

**Costuras temáticas (preferência de revisão, negociável):**
- PR-1: migration B + pgTAP;
- PR-2: `auditor-acesso` + entrada no app;
- PR-3: `/cliente/*` (não OAuth) + regras + relatório + cron;
- PR-4: retrospectiva e telas;
- PR-5: exclusão, limpeza e deauthorize;
- PR-6: checkout logado;
- PR-7: Política e Termos.

Na prática do repo, as migrations seguem junto do comportamento que as usa (ex.:
`20261016200000_auditor_assinaturas.sql` veio com a função). PR-1 só fica separado
porque a Frente 1 aplica a migration A em paralelo.

## Blast radius e risco principal

- **Produção compartilhada** (`sdeowbqmwkwseyktyemn`): funil de leads, checkout
  Pagar.me, `/p/*`, console de agências, hub da Nó e CAPI.
  - A migration B mexe em duas tabelas existentes: `clients`, com coluna nova com
    default, e `memberships`, com o check ampliado. As duas mudanças só **ampliam**.
    Nenhuma linha muda de significado, exceto a Nó, que passa a `origem='interno'`.
  - Todos os leitores de `clients` precisam continuar iguais. Isso está em
    "Regressões vizinhas".
- **Etapa mais arriscada: o dispatch `/cliente/*` dentro da `marketing-hub`.** Um
  erro abre rota de admin para o cliente ou derruba o planner da Nó.
  - Mitigação: o prefixo é testado antes de `autorizar()`, e os testes atuais
    (`marketingHub.test.ts`, `hub_marketing.test.sql`, `hub_marketing_edge.mjs`)
    passam **sem alteração**.
  - O deploy da função só acontece depois disso, por regra da coordenação.
- **Segunda mais arriscada: o checkout.** Mexe em cobrança real.
  - Mitigação: sandbox (`sk_test_`) antes da produção.
  - O caminho sem JWT passa a recusar com 401 antes de qualquer chamada ao
    Pagar.me.

## Ordem de execução

### Passo 0 — Fatos de produção (só leitura) e pré-requisitos

| # | O quê | Quem | Registro |
|---|---|---|---|
| 0.1 | `select count(*) from auditor_assinaturas` e quantas têm `estado='paga'` | Executor (SQL só leitura) | `execution.md`. Se for > 0, o vínculo por e-mail (passo 6) é obrigatório. Se for 0, vira só salvaguarda. |
| 0.2 | Listar os leitores de `public.clients` e `memberships` (grep no repo + `pg_depend` em views e funções) | Executor | Lista em `execution.md`, usada em "Regressões vizinhas". |
| 0.3 | Confirmar que o domínio do Resend permite `relatorios@notechstack.com.br` | Lucca (painel Resend) | Sim ou não. Se for não, o remetente fica `leads@` até ajustar. |
| 0.4 | Criar o secret `ANTHROPIC_API_KEY` em Supabase → Edge Functions → Secrets | Lucca (cola direto no painel) | Só o nome. Sem ele, os relatórios saem com o texto de modelo, e isso não bloqueia nada. |
| 0.5 | Migration A aplicada pela Frente 1, com o esquema validado na coordenação | Frente 1 | Data e hora na seção da Frente 1. |

### Passo 1 — Migration B (`supabase migration new auditor_clientes`)

DDL da spec, seção 3, **menos** o que é da migration A:
- `clients.origem`, com `update` da linha `no-tech-stack` para `'interno'`;
- `memberships` com o check ampliado para `'AUDITOR'`;
- tabelas `auditor_contas`, `auditor_clientes`, `marketing_cliente_snapshots`,
  `auditor_relatorios`, `auditor_acessos_suporte` e `auditor_exclusoes`;
- coluna `auditor_assinaturas.conta_id`;
- helper `auditor_pode_ler(uuid)`, policies e grants;
- view `auditor_operacao`, para a `/no/auditor`, **sem** `achados`, `narrativa`,
  `dados` nem nomes de campanha;
- RPCs `auditor_planejar_relatorios()` e `auditor_claim_relatorios(p_limit)`, esta
  com `for update skip locked`;
- `auditor_invoke(p_rota)`, no padrão de `marketing_invoke_publish_due`;
- `auditor_limpar()`;
- jobs `pg_cron`:

| Job | Agenda (UTC) | Equivale a (BRT) |
|---|---|---|
| `auditor-relatorios-planejar` | `0 9 * * *` | 06:00 |
| `auditor-relatorios-processar` | `*/10 * * * *` | a cada 10 min |
| `auditor_limpar_diario` | `30 6 * * *` | 03:30 |

- remoção da view sem uso `auditor_lista_envio_relatorio`. A substituição já foi
  aprovada na spec, seção 4.

Testes: `supabase/tests/auditor_clientes.test.sql` (pgTAP), com os critérios C1–C4.

### Passo 2 — Entrada do cliente

1. **Função `auditor-acesso`** (pública, `verify_jwt=false`):
   - `POST {email, aceite_versao, site?, utm?}` → sempre `202
     {ok:true}`, exista ou não a conta, para não revelar contas.
   - Cria o usuário com `app_metadata.role='AUDITOR_CLIENT'` quando ele não existe.
   - Recusa em silêncio (mesmo 202, sem envio) os e-mails de `NO_ADMIN` e
     `MARKETING_AGENT`, e registra o motivo.
   - Chama `generateLink({type:'magiclink', redirectTo: APP_URL/auditor/entrar})` e
     envia pelo Resend.
   - Limites por e-mail e por IP com hash (`DIAG_IP_SALT`); veja U5.
2. **`marketing-hub`:** `GET /cliente/eu`. No primeiro acesso, cria
   `auditor_contas` + `clients` + `auditor_clientes` + `memberships` numa RPC
   transacional. Também faz o vínculo da assinatura antiga por e-mail (0.1).
3. **App:**
   - `/auditor/entrar`: formulário, mais o tratamento do retorno do link.
   - `/auditor`: lista de negócios e plano.
   - `/auditor/:clientId/conexoes`: chama as rotas OAuth da Frente 1.
   - A rota usa `ProtectedRoute`; quem decide o acesso é o servidor.
   - `/acesso` e `LoginPage` ficam **intocados**. O `LoginPage` só ganha o redirect
     `AUDITOR_CLIENT → /auditor`.
4. **Site:** `diagnostico-real.js` passa `site=<url>` adiante. Mais nada muda no site.

### Passo 3 — Isolamento e suporte

1. Dispatch `/cliente/` em `handler.ts`, antes de `autorizar()`, para
   `cliente/handler.ts` com `clienteAutorizado()` (spec, seção 2).
2. As leituras do cliente usam um cliente Supabase montado com o JWT do usuário.
   As chaves de cache começam com `cli:<client_id>:`.
3. `POST`/`DELETE /cliente/:clientId/suporte` (só o dono): concessão de 72 h.
4. Tela `/no/auditor` (NO_ADMIN, aal2), lendo **só** a view `auditor_operacao`.
5. Escolha de ativos: `PUT /cliente/:clientId/ativos`.

### Passo 4 — Coleta, regras e relatório

1. `_shared/auditor/coleta.ts`: para cada ativo, chama o adaptador existente com a
   credencial do Vault e grava `marketing_cliente_snapshots` (período e período
   anterior).
2. `_shared/auditor/regras.ts`, com `versao_regras = 'r1'`:
   - os achados da spec, seção 4, cada um com teste de unidade;
   - os limiares (CPA +20%, frequência > 4) ficam como constantes no arquivo.
3. `_shared/auditor/redacao.ts`:
   - SDK `npm:@anthropic-ai/sdk`, `model: 'claude-opus-5-5'`;
   - `output_config: {effort:'low', format:{type:'json_schema', …}}`;
   - `fallbacks:'default'`, com o beta `server-side-fallback-2026-07-01`;
   - valida a resposta (`achado_id` existente; nenhum número fora de `achados`);
   - se a validação falhar, usa o texto de modelo;
   - grava `modelo`, `uso` (tokens) e `versao_regras`.
4. `POST /internal/auditor/planejar` e `/internal/auditor/processar`
   (`x-cron-secret`). Processar segue esta ordem:
   1. pega até 3 relatórios;
   2. em cada um: `coletando` → `gerando` → `pronto` → e-mail → `enviado`;
   3. em erro transitório, refaz em +10, +30 e +90 min;
   4. depois disso, marca `falhou` e manda alerta para `contato@`;
   5. erro de autenticação do provedor muda a conexão para `expirado` ou
      `revogado` e deixa o relatório `parcial`.
5. Lembrete de expiração Meta (7 dias e 1 dia antes): sai no mesmo `planejar`.
6. E-mail Resend com o resumo, as 3 prioridades e o link para
   `/auditor/:clientId/relatorios/:id`.

### Passo 5 — Retrospectiva e telas de relatório (app)

- Portar `retrospectiva/shared/` (Motion, StatusMark, `nota.js`) para
  `app/src/auditor/retrospectiva/`.
- Telas t01/t06, t02, t04, t07, t-horario, t08, t-caminho e t13, alimentadas por
  `achados`, `narrativa` e `fontes`.
- O **design é o protótipo existente** (`agentes/auditor/retrospectiva/index.html`).
  Não há tela nova a desenhar.
- A retrospectiva grátis é gerada na hora, pelo mesmo pipeline do passo 4, com
  `tipo='retrospectiva'`, cobrindo os últimos 28 dias até ontem.
- O diagnóstico do site reaproveita `diag_cache` (24 h). Se não houver cache, a
  função roda o diagnóstico sem tocar em `diag_reservar`, porque não é anônimo.

### Passo 6 — Checkout logado

- `assinatura-auditor` exige JWT. Sem JWT, responde 401 `{ok:false,
  motivo:'login_necessario'}` **antes** de chamar o Pagar.me.
- Grava `conta_id`. Sobre o e-mail enviado ao Pagar.me:
  - continua sendo o digitado no formulário (a pessoa pode cobrar em outro
    e-mail);
  - o vínculo é pela conta, não pelo e-mail.
- O webhook `paga` atualiza `auditor_contas.plano`. `cancelada` grava
  `encerrada_em`, e `excluir_apos` passa a ser `encerrada_em + 90 dias`.
- **Decisão deste plano: o checkout passa a acontecer no app**
  (`/auditor/planos`).
  - A sessão do cliente só existe em `app.notechstack.com.br`, e o site não pode
    ler essa sessão.
  - O app reaproveita a tokenização de cartão do `assinatura.js` (chave pública
    Pagar.me, cartão nunca no servidor).
  - O site mantém a tela de planos como vitrine, com link para o app.

### Passo 7 — Exclusão, desconexão e limpeza

1. `DELETE /cliente/:clientId/:provedor` (Frente 1 revoga e apaga do Vault; esta
   frente registra o evento e atualiza a tela).
2. `POST /cliente/excluir-conta`:
   - registra `auditor_exclusoes`;
   - cancela a assinatura no Pagar.me;
   - revoga as conexões;
   - apaga negócio, conta e usuário na mesma execução;
   - marca `concluido`.
3. `POST /cliente/meta/desautorizar`:
   - valida o `signed_request` com `META_APP_SECRET` (HMAC-SHA256);
   - marca `revogado` as conexões de `usuario_externo`;
   - apaga o Vault.
4. `auditor_limpar()` aplica a tabela de retenção da spec, seção 5.
   - Anonimiza `nome`, `email` e `whatsapp` em `auditor_assinaturas` quando a conta
     é apagada.
5. O callback de exclusão Meta (`/cliente/meta/exclusao`) fica para **logo após o
   lançamento** (spec). Não entra neste plano como critério.

### Passo 8 — Política e Termos

- Textos da Frente 2 (seções 6 e 7 de `.tasks/auditor-conexoes-aprovacoes.md`),
  com:
  - os prazos da spec, seção 5;
  - a correção da linha 77 de `/privacidade/`;
  - a âncora `#exclusao-meta`;
  - a Anthropic como operadora da redação;
  - o encarregado nomeado (D9);
  - o direito de arrependimento.
- Data "atualizada em" nas duas páginas.
- **PR separado, porque o merge publica o site** (O3).

### Passo 9 — Produção (o que o aceite de 21/10 libera)

1. Testes verdes: vitest do app, pgTAP (`hub_marketing` + `auditor_clientes`) e
   `hub_marketing_edge.mjs`.
2. Medir `leads`, `lead_sessoes` e `lead_eventos` e rodar os advisors (antes e
   depois).
3. Aplicar a migration B.
4. Deploy de `auditor-acesso` e `marketing-hub`.
5. Avisar na seção Frente 3, com data e hora.
6. App e site só vão ao ar com **merge do Lucca**.
7. A venda (`AUDITOR_VENDA_ABERTA`) só abre por decisão do Lucca, depois de O3 e
   O4.

## Critérios (observáveis, um teste ou uma execução decide)

| # | Critério | Prova |
|---|---|---|
| C1 | Usuário A (membro do negócio X) faz `select` em `marketing_cliente_snapshots`, `auditor_relatorios`, `marketing_cliente_ativos` e `marketing_cliente_conexoes` do negócio Y → 0 linhas. | pgTAP |
| C2 | `NO_ADMIN` sem concessão vigente → 0 linhas em snapshots e relatórios. Com concessão vigente → linhas visíveis. Com concessão `expira_em < now()` → 0 linhas. | pgTAP |
| C3 | `MARKETING_AGENT` → 0 linhas em todas as tabelas acima. `GET /cliente/eu` com o token dele → 403. | pgTAP + teste da função |
| C4 | `select vault_secret_id from marketing_cliente_conexoes` como `authenticated` → erro de permissão (42501). | pgTAP |
| C5 | Todos os testes atuais de `marketingHub.test.ts`, `hub_marketing.test.sql` e `hub_marketing_edge.mjs` passam sem nenhuma linha alterada nesses arquivos. | CI local |
| C6 | `POST auditor-acesso` com e-mail novo → 202, usuário criado com `role=AUDITOR_CLIENT` e 1 e-mail no Resend. Com e-mail de `NO_ADMIN` → 202, nenhum envio e nenhum usuário alterado. | teste da função (Resend e Auth simulados) |
| C7 | O primeiro `GET /cliente/eu` de um usuário novo cria exatamente 1 conta `gratis`, 1 `clients` com `origem='auditor'`, 1 `auditor_clientes` e 1 `memberships` `AUDITOR`. Duas chamadas simultâneas continuam criando 1 de cada. | teste da RPC (2 transações concorrentes) |
| C8 | `PUT /cliente/X/ativos` com 2 contas do mesmo tipo → 409 `{ok:false, motivo:'um_por_tipo'}`. | teste da função |
| C9 | Com uma assinatura `semanal` com acesso, `auditor_planejar_relatorios()` rodando numa segunda (no fuso do negócio) cria 1 relatório `semanal` com o período de segunda a domingo anteriores. Rodar de novo no mesmo dia não cria o segundo. Plano `mensal` no dia 1 → 1 relatório do mês anterior. `gratis` → nenhum. | pgTAP com data fixada |
| C10 | `auditor_claim_relatorios(3)` chamado por 2 sessões ao mesmo tempo, com 4 pendentes → 3 + 1, sem repetição. | pgTAP (2 conexões) |
| C11 | Na coleta, o adaptador Meta devolve erro `190` → a conexão fica `expirado`, o relatório termina `parcial` com `fontes.meta_ads='expirado'`, e o e-mail contém o link de reconexão. | teste da função (adaptador simulado) |
| C12 | IA devolve um número ausente de `achados` → o relatório usa o texto de modelo, `narrativa.origem='modelo'`, e mesmo assim é enviado. Sem `ANTHROPIC_API_KEY` → mesmo resultado. | teste de `redacao.ts` |
| C13 | Erro transitório 3 vezes seguidas → estado `falhou`, `tentativas=3`, 1 alerta para `contato@notechstack.com.br`. | teste da função |
| C14 | O dono concede suporte → `NO_ADMIN` lê o relatório via `GET /cliente/X/relatorios/:id`, e aparece 1 evento `suporte_leu`. Sem concessão → 403. | teste da função |
| C15 | `/no/auditor` mostra negócio, plano, estado das conexões e estado dos relatórios. A resposta não contém as chaves `achados`, `narrativa` nem `dados`. | teste da função + vitest |
| C16 | `POST /cliente/excluir-conta` → depois da execução, não existe nenhuma linha com aquele `client_id` em conexões, ativos, snapshots, relatórios, `auditor_clientes` e `clients`, e o usuário Auth não existe. `auditor_exclusoes` fica `concluido`. A assinatura no Pagar.me recebe `DELETE`. | teste ponta a ponta local |
| C17 | `signed_request` válido em `/cliente/meta/desautorizar` → conexão `revogado` e `vault_secret_id` nulo. Assinatura inválida → 400, sem mudança. | teste da função |
| C18 | `auditor_limpar()` com data fixada: snapshot de 13 meses + 1 dia é apagado e o de 13 meses − 1 dia fica. Conta com `excluir_apos < now()` é apagada. Conta grátis com conexão de mais de 30 dias e sem assinatura → token apagado. | pgTAP |
| C19 | `assinatura-auditor` sem JWT → 401 `login_necessario`, e o Pagar.me não é chamado. Com JWT (sandbox) → a assinatura fica com `conta_id`. O webhook `paga` → `auditor_contas.plano='semanal'`. | teste da função + sandbox |
| C20 | Tela `/auditor/:clientId/retrospectiva` sem nenhuma conexão → mostra só o site, com os botões "Conectar com o Facebook" e "Conectar com o Google". Fonte `expirado` → bloco "Reconecte…". Fonte não disponível (Loja, eventos de servidor) → "não disponível", sem número. | vitest |
| C21 | `/privacidade/` não contém mais "Não pedimos CPF, dados de pagamento" e contém o id `exclusao-meta`. `/termos/` contém a seção do auditor. | teste de conteúdo (grep no build) |

## Superfícies (walk)

| Superfície | Item | Onde fica |
|---|---|---|
| Tela `/auditor/entrar` | vazio, carregando, erro e não autorizado | C6 (sempre 202, mesma mensagem "Se o e-mail puder entrar, o link chega em instantes"). Erro de rede: existente, padrão de mensagem do app. |
| Tela `/auditor` e conexões | vazio (sem conexão), carregando, erro, sem permissão; confirmação destrutiva | vazio: C20. Sem permissão: C3/C1 (403). Desconectar e excluir conta pedem confirmação em tela, no padrão do arquivamento (`AdminDashboardPages.tsx:1203`) — existente. |
| Tela da retrospectiva e do relatório | estados por fonte | C20. Ordem das telas: a do protótipo. |
| Tela `/no/auditor` | densidade e ordem | C15. Ordem: relatórios `falhou` primeiro, depois `parcial`. U6 com padrão. |
| API `/cliente/*` | forma de erro | existente: `{ok:false, motivo, mensagem}` do hub (`handler.ts:209`). Quem chama: C1–C3, C14. Versionamento: n/a, consumido só pelo app do mesmo repo. Limite de taxa: n/a nas leituras (cache), U5 no `auditor-acesso`. |
| Webhook Meta (desautorizar) | forma, quem chama | C17. Resposta 200 vazia. |
| Cron (`planejar`, `processar`, `limpar`) | saída, falha no meio | C9, C10, C13. A falha no meio fica no `estado` de cada relatório. O job em si registra em `cron.job_run_details` (existente). |
| E-mail do relatório | estrutura, tom, próximo passo | estrutura: resumo + 3 prioridades + botão. Tom: o da `narrativa.tom`, PT-BR. Próximo passo: "Ver relatório completo". C11 cobre o caso de reconexão. |
| Textos de Política e Termos | estrutura e o que o leitor faz | C21. Os textos são da Frente 2; a revisão jurídica é U4. |

## Varredura (as nove)

| Dimensão | Onde caiu |
|---|---|
| Validação | C8 (um por tipo); C17 (`signed_request`); `auditor-acesso` valida e-mail e `aceite_versao` (o 400 é existente: padrão `core.ts` do diagnóstico). |
| Modos de falha | C11 (token), C12 (IA), C13 (transitório). |
| Idempotência e retry | C9 (planejar repetido), C13 (retry com limite). Envio de e-mail duplicado: o estado `enviado` + `email_id` impede reenvio, e o processar só pega `agendado`. |
| Autorização | C1–C4, C14, C15, C19. |
| Concorrência e ordem | C7 (primeiro acesso simultâneo), C10 (claim simultâneo). Webhook Pagar.me fora de ordem: existente (`created_at`, `assinatura-auditor-webhook/core.ts:57-65`). |
| Ciclo de vida dos dados | C16, C18; anonimização da assinatura no passo 7. |
| Falha de dependência externa | C11 (Meta/Google), C12 (Anthropic). Resend fora: o relatório fica `pronto` sem `enviado` e volta no próximo `processar` (mesmo mecanismo de C13). |
| Transições de estado | C9 → C11/C13: `agendado → coletando → gerando → pronto → enviado`, ou `parcial`, `falhou`, `pulado`. Conexão: C11, C17. |
| Observabilidade | Alvo de serviço, não critério: "relatório semanal enviado até 09h BRT de segunda". Medido por `select count(*) filter (where enviado_em > …)` na `/no/auditor`, com alerta de `falhou` (C13). Custo de IA: `auditor_relatorios.uso`. |

## Regressões vizinhas a verificar

- Os leitores de `clients` e `memberships` levantados no passo 0.2 (console de
  agências, `/p/*`, `can_read_project`, views `thais_*`).
- Planner `/no/marketing`: visão geral, campanhas e conexões, com a conta do Lucca
  e a do dot (C5 + uso manual de 5 min).
- `diagnostico-auditor` e o limite anônimo: inalterados, porque o passo 5 não chama
  `diag_reservar`.
- Os processos do Pagar.me fora do auditor (`pagarme-webhook-no`, `roadmap-checkout`):
  intocados.

## Rollback

- **Migration B:** só acrescenta, exceto o `drop view auditor_lista_envio_relatorio`,
  que não tem leitor. O rollback é uma migration que remove os jobs `pg_cron`
  novos. As tabelas ficam, vazias de efeito.
- **`marketing-hub`:** redeploy da versão anterior (o Supabase guarda as versões).
- **`assinatura-auditor`:** redeploy da versão anterior. Com a venda fechada, o
  risco é nulo.
- **App e site:** reversão pela Vercel, feita pelo Lucca.

## Condições de parada

- Algum teste de C5 falha → parar. Não ajustar o teste do admin.
- Os leitores de `clients` (0.2) incluem algo que filtra por `status` ou lista todos
  os clientes para o cliente final → parar e perguntar antes da migration B.
- A Frente 1 muda o esquema validado → parar e reconciliar na coordenação.
- Qualquer passo exigir ler token, `.env` ou `_sensivel` → parar.

## Pendências (Unresolved)

| # | Pergunta | Tipo | Até ser respondida |
|---|---|---|---|
| U1 | Meta: Verificação da Empresa, Access Verification e App Review `ads_read` | **bloqueia go-live** | Só usuários com papel no app (o Lucca) conectam a Meta. A Frente 2 e o Lucca são os donos. |
| U2 | Google: host de callback em domínio verificado (`api.notechstack.com.br`?) e verificação de marca e escopos | **bloqueia go-live** | Até 100 usuários, com aviso de app não verificado, depois de "Em produção". A Frente 2 e o Lucca são os donos. |
| U3 | Merge do site (Política e Termos) e do app | **bloqueia go-live** | Nada vai ao ar na Vercel. Só o Lucca faz. |
| U4 | Revisão jurídica dos textos de Política e Termos | aberta | Publicar o texto da Frente 2 + spec. Revisar depois, sem bloquear. |
| U5 | Limites do `auditor-acesso` | aberta | 3 links por e-mail por hora e 20 por IP por hora. |
| U6 | Ordem e filtros da `/no/auditor` | aberta | `falhou` → `parcial` → o resto, por data. |
| U7 | Prazo fiscal de 5 anos para `auditor_assinaturas` | aberta | 5 anos (D3). O Lucca confirma com o contador. |
| U8 | Divulgação do envio de achados Google à Anthropic sob o Uso Limitado | aberta | Divulgar na Política (passo 8). A Frente 2 confirma. |

## Alternativas rejeitadas (no plano)

- **Checkout continuar no site, com a sessão passada por URL.** Rejeitada: o token
  de sessão iria na URL. Fica no app (passo 6).
- **Batch API da Anthropic para os relatórios de segunda.** Fica para quando o
  volume justificar (spec, seção 4).
- **Função separada `auditor-hub`.** Rejeitada na spec. Fica como saída barata se
  os relatórios de segunda passarem das 09h (spec, Riscos).

## Decisão do gate

**Aprovado** em 21/10/2026 pelo orquestrador das três frentes, a quem o Lucca delegou a coordenação,
"como está", incluindo o checkout no app (`/auditor/planos`). O orquestrador leva essa decisão nova ao
Lucca no resumo; se ele mudar, ajusta-se depois. Execução registrada em `execution.md`.
