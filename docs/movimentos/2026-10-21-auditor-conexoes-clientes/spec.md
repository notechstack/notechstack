---
movement_id: auditor-conexoes-clientes
intent: ./intent.md
status: proposed
updated: 2026-10-21
revision: 1 — Frente 3 (solutions), partindo do esquema provisório da Frente 1
---

# Spec: um auditor por cliente, com o marketing-hub no centro

Cada decisão traz primeiro a **recomendação**, depois a alternativa e o que
precisaria ser verdade para ela vencer. As decisões que são do Lucca estão marcadas
**[Lucca]** e reunidas em "Decisões pendentes", no fim.

## Contrato com o problema

O auditor precisa:

1. saber **quem** é o cliente;
2. guardar **a conexão** dele com Meta e Google;
3. ler **só as contas que ele escolheu**;
4. produzir e entregar **o relatório no ritmo do plano**;
5. **apagar tudo** quando ele sair.

Tudo isso sem afrouxar o hub da Nó (`NO_ADMIN`, `MARKETING_AGENT`) e sem que o
Lucca leia dados de cliente por padrão.

## Estado atual relevante (lido em origin/main 62483db3)

- **Hub:**
  - `marketing-hub` tem `verify_jwt=false` e autentica na própria função
    (`store.ts:43-55`).
  - `autorizar()` aceita só `NO_ADMIN` com aal2 e `MARKETING_AGENT`
    (`handler.ts:232-240`).
  - Todo acesso ao banco usa service role.
  - O cliente é fixo: `SLUG_NO = "no-tech-stack"` (`store.ts:17`).
  - As chaves de cache não têm cliente (`handler.ts:221, 311`).
  - O cache Google em memória guarda um token só (`google-auth.ts:23`).
- **Tenant:**
  - `public.clients` é a base multi-tenant e já tem FKs.
  - `memberships(user_id, client_id, role check = 'CLIENT')` dá acesso a
    `/p/*` por `can_read_project`, que exige projeto.
  - Os papéis ficam em `app_metadata.role`. O signup está desligado
    (`enable_signup = false`).
  - O login é por senha, com MFA para `NO_ADMIN`. Não existe `signInWithOtp`;
    links são gerados por `generateLink` no servidor.
- **Auditor:**
  - `auditor_assinaturas` identifica o assinante por nome, e-mail, WhatsApp e
    `pagarme_subscription_id`, sem usuário.
  - A tolerância de 3 dias após recusa ainda é **proposta não confirmada**
    (`20261016200100…sql:2-3`).
  - `auditor_lista_envio_relatorio` não é usada por nada.
  - O diagnóstico grátis é anônimo (IP com hash, 3 por pessoa, retenção de 90
    dias).
- **Planos** (`assinatura-auditor/core.ts:9-13` e retrospectiva t13): Mensal R$ 47
  ("1 relatório por mês"), Semanal R$ 97 ("toda segunda"), Agência R$ 197
  ("personalizado; até 5 clientes, 1 site + contas cada"). Todos são cobrados por
  mês no cartão.
- **E-mail:** Resend (`RESEND_API_KEY`), remetente `leads@notechstack.com.br`.
- **Agendamento:** `pg_cron` + `pg_net` + segredo no Vault (`marketing_invoke_publish_due`,
  `diag_limpar_diario`).
- **IA:** nenhuma função do backend usa LLM hoje. A Política de Privacidade já
  lista a Anthropic como operadora (chat).
- **Frente 1** (`claude/auditor-oauth-clientes`, código local):
  - OAuth com `state` HMAC, PKCE e cookie.
  - Meta via Facebook Login for Business, só `ads_read`.
  - Google com Ads, GA4 e GSC em leitura.
  - Listagem de contas escolhíveis (`ContaSelecionavel`).
  - Callbacks em `marketing-hub/cliente/{meta|google}/callback`.

### Fatos da Frente 2 que esta spec incorpora (`.tasks/auditor-conexoes-aprovacoes.md`)

- **Google, verificação de marca:** exige callbacks OAuth em domínio verificado.
  `*.supabase.co` só serve em modo Teste. As rotas `/cliente/*` precisam estar
  acessíveis por um domínio da nó (recomendação da Frente 2:
  `api.notechstack.com.br`, como domínio próprio do Supabase) antes da
  verificação. A spec não depende do host, só do caminho.
- **Google Ads:** o nível de acesso do developer token passou a ser do projeto
  Cloud `no-hub`, e o MCC deixou de ser necessário. `login_customer_id` continua
  útil só quando a conta do cliente é lida através de uma MCC dele.
- **Google, escopos:** os três são sensíveis, não restritos, então não há CASA. Em
  "Testando", o refresh token morre em 7 dias. Publicar "Em produção" resolve, e o
  limite de 100 usuários basta para o piloto.
- **Meta, permissões:** `ads_read` em Advanced exige App Review **e** Access
  Verification (Tech Provider). Sem isso, usuário sem papel no app recebe erro
  100.
- **Meta, exclusão:** o callback é **opcional** se houver uma URL de instruções. A
  Frente 2 propõe a âncora `/privacidade/#exclusao-meta`.

---

## 1. Identidade do cliente do auditor

### Recomendação: cliente vira usuário do app, entra por link mágico e conecta **antes** de pagar

**Quem é quem:**

| Conceito | Onde fica | Observação |
|---|---|---|
| **Negócio auditado** (1 site + contas) | `public.clients`, com nova coluna `origem` = `'auditor'` | É o `client_id` que a Frente 1 já usa. A Nó vira `origem='interno'`; os demais clientes, `'projeto'`. |
| **Conta do auditor** (quem paga e qual plano) | `auditor_contas` (nova) | 1 por usuário dono. O plano Agência agrupa até 5 negócios. |
| **Pessoa** | `auth.users`, com `app_metadata.role = 'AUDITOR_CLIENT'` | Usuário novo que já tem outro papel mantém o papel; o acesso vem da linha em `memberships`, não do papel. |
| **Vínculo pessoa ↔ negócio** | `memberships(user_id, client_id, role='AUDITOR')` | Esquema da Frente 1. O `check` passa a aceitar `'AUDITOR'`. `can_read_project` não muda, porque negócio do auditor não tem projeto. |

**Login:**

- Só por link mágico, sem senha.
- A função `auditor-acesso` (pública) recebe o e-mail e o aceite dos Termos.
- Limites: por IP com hash (padrão `diag_*`) e por e-mail.
- Ela cria o usuário, se não existir, com `role='AUDITOR_CLIENT'`.
- Gera o link com `auth.admin.generateLink({type:'magiclink'})` e envia **pelo
  Resend**, no mesmo padrão de `skill-01-ativar-dashboard` (links gerados no
  servidor). O signup continua desligado.
- A conta (`auditor_contas`), o negócio (`clients` + `auditor_clientes`) e o
  `memberships` só nascem **no primeiro acesso autenticado**. E-mail digitado
  errado não deixa lixo.
- Um e-mail que já pertence a `NO_ADMIN` ou `MARKETING_AGENT` recebe recusa. As
  contas do sistema não se misturam com a de cliente; o Lucca testa com outro
  e-mail.

**Funil (grátis → conectado → pago):**

```
1. Diagnóstico grátis (como hoje: anônimo, só HTML)          site /agentes/auditor/
2. "Conectar com Facebook/Google"                            app /auditor/entrar?site=<url>&utm…
   → e-mail + aceite → link mágico → 1º acesso cria conta 'gratis' + negócio
3. Conectar Meta e/ou Google (Frente 1) → escolher contas    app /auditor/:clientId/conexoes
4. Retrospectiva real, UMA vez por negócio (últimos 28 dias) app /auditor/:clientId/retrospectiva
5. Tela de planos (t13) → checkout logado                    o assinatura-auditor recebe o JWT
6. Webhook 'paga' → conta.plano = plano → relatórios na agenda
```

- O checkout passa a **exigir sessão**. `assinatura-auditor` lê o usuário do JWT e
  grava `auditor_assinaturas.conta_id`. Continua sem receber dados de cartão.
- **Assinatura antiga sem conta, se houver em produção:** no primeiro login com o
  mesmo e-mail, a assinatura sem `conta_id` é vinculada uma única vez e o evento é
  registrado. Contar quantas existem é passo 0 do plano (SELECT só leitura).
- **Conta grátis que nunca paga:** 30 dias depois da conexão sem assinatura, os
  tokens são revogados e apagados e o cliente recebe e-mail avisando. A conta e a
  retrospectiva ficam até o prazo da seção 5.

**Alternativa (não recomendada): assinante sem login, identificado por e-mail, com
link assinado em cada e-mail.**
- Só venceria se ninguém precisasse voltar à tela para reconectar, escolher contas
  ou excluir dados. Mas reconectar quando o token expira é rotina: o Meta expira em
  60 dias quando não é token de usuário do sistema. E a Meta e o Google exigem um
  caminho de revogação e exclusão. Link assinado sem sessão vira um login improvisado.

**Alternativa (não recomendada): pagar antes de conectar.**
- Vence se o custo de cada retrospectiva grátis (chamadas de API + IA) for alto ou
  se houver abuso. Contraria a ordem do protótipo (t01 → t02 conectar → … → t13
  planos), que usa a retrospectiva real como prova antes do preço. **[Lucca, D1]**

## 2. Multi-cliente sem afrouxar o hub

### Recomendação: namespace `/cliente/*` dentro da `marketing-hub`, com autorizador próprio e RLS como segunda trava

**Roteamento:**
- `handler.ts` encaminha tudo que começa com `/cliente/` para
  `cliente/handler.ts` **antes** de chamar `autorizar()`.
- O ramo antigo fica byte a byte igual. Os testes do admin (`marketingHub`, pgTAP
  `hub_marketing`) são a prova.

**Autorizador `clienteAutorizado(user, clientId)`:**

| Regra | Efeito |
|---|---|
| Tem `memberships(user_id, client_id, role='AUDITOR')` e o negócio tem `origem='auditor'` | Acesso pleno às rotas do cliente. |
| `NO_ADMIN` com aal2 e **acesso de suporte vigente** concedido pelo cliente (`auditor_acessos_suporte`) | Só leitura, só durante a janela. Cada leitura é registrada. **Não pode iniciar OAuth em nome do cliente.** |
| `NO_ADMIN` sem concessão | 403 nas rotas com dados. Vê só os **metadados operacionais** pela tela de operação (seção "O Lucca vê o quê"). |
| `MARKETING_AGENT` | 403 em todo `/cliente/*`. |
| Qualquer outro | 403. |

**Rotas** (os nomes do OAuth são da Frente 1; os demais são sugestão):

| Rota | Quem | O quê |
|---|---|---|
| `GET /cliente/eu` | membro | conta, plano, negócios, limite do plano |
| `POST /cliente/negocios` | dono, plano Agência | cria negócio (até 5) |
| `GET /cliente/:clientId/conexoes` | membro | estado das conexões e ativos escolhidos (sem token) |
| `POST /cliente/:clientId/:provedor/ir` → `GET /cliente/{meta,google}/callback` | membro | OAuth (Frente 1) |
| `GET /cliente/:clientId/:provedor/contas` | membro | contas escolhíveis (Frente 1, `contas-cliente.ts`) |
| `PUT /cliente/:clientId/ativos` | membro | grava a escolha (1 por tipo) |
| `DELETE /cliente/:clientId/:provedor` | membro | desconecta: revoga no provedor, apaga do Vault e marca `desconectado` |
| `GET /cliente/:clientId/relatorios[/:id]` | membro ou suporte | lista e mostra relatórios |
| `POST /cliente/:clientId/suporte` / `DELETE …/suporte` | dono | concede ou revoga acesso de suporte (padrão 72 h) |
| `POST /cliente/excluir-conta` | dono | pedido de exclusão (seção 5) |
| `POST /cliente/meta/desautorizar` | Meta (`signed_request`) | deauthorize: marca `revogado` e apaga o token |
| `POST /cliente/meta/exclusao` | Meta (`signed_request`) | callback de exclusão de dados (seção 5; logo após o lançamento) |
| `POST /internal/auditor/planejar` e `/internal/auditor/processar` | cron (`x-cron-secret`) | relatórios (seção 4) |

**Isolamento, em três camadas:**
1. **Servidor:** o `clientId` da URL só vale depois de `clienteAutorizado`. Toda
   consulta filtra por esse `client_id`. A função nunca usa o `client_id` vindo do
   corpo da requisição.
2. **Banco:** as rotas de leitura do cliente consultam com um cliente Supabase
   montado com o **JWT do usuário**, não com a service role. Assim a RLS (seção 3)
   também barra um bug de filtro. A service role fica restrita ao Vault, às
   escritas e ao cron.
3. **Cache e memória:**
   - as chaves de `marketing_cache` das rotas novas sempre começam com
     `cli:<client_id>:`;
   - o cache de access token Google em memória (`google-auth.ts:23`) passa a ser
     indexado pelo refresh token (hash) ou desligado para clientes;
   - hoje ele guarda um token só, então dois clientes no mesmo worker trocariam
     de token. **Isso é bloqueio para a Frente 1.**

**O que não muda:** `autorizar()`, as rotas e a interface de `/no/marketing`, o
`SLUG_NO`, as env vars da Nó, o `ad_accounts` e o `marketing_actions`. A Nó continua
lendo com o token de usuário do sistema dela.

**Alternativa: função separada `auditor-hub` importando `_shared/marketing`.**
- Isola o deploy: uma mudança do auditor não reimplanta a função que a Nó usa.
- Vence se o auditor passar a ter deploys bem mais frequentes que o hub, ou se um
  incidente no `/cliente/*` puder derrubar o planner.
- Hoje a Frente 1 já cadastra os callbacks em `marketing-hub/cliente/*`, e mudar
  isso agora custa uma volta no console. Para o Lucca, a mudança é de uma linha
  (pasta da função), e ela continua sendo opção barata depois.
- **Exceção:** o processamento de relatórios roda em `marketing-hub`
  `/internal/auditor/processar`, mas com um limite pequeno de relatórios por
  chamada (seção 4).

### O Lucca vê o quê (definição de "motivo")

| Dado | O Lucca vê? | Como |
|---|---|---|
| Metadados operacionais: negócio, plano, estado de cada conexão, `expira_em`, estado e erro de cada relatório, contagens | **Sim, sempre** | Tela `/no/auditor` (NO_ADMIN, aal2), lida por service role com uma view que **não** tem métricas, achados nem texto. |
| Métricas, achados, texto do relatório, nomes de campanha, ids de contas | **Só com acesso de suporte** | O cliente concede na tela dele (botão "Permitir que a equipe nó veja meus relatórios por 72 h"). Cada leitura entra em `marketing_cliente_eventos`. |
| Token | **Nunca** | Fica só no Vault; nenhuma tela ou view lê. |

- **Motivo** = um pedido do cliente: suporte, contestação ou erro que ele relatou.
  A concessão do cliente é a evidência.
- **Exceção legal:** ordem judicial ou investigação de segurança ou abuso. Fica
  registrada à mão em `marketing_cliente_eventos`, com `acao='acesso_excepcional'`
  e a justificativa.
- **Limite honesto:** como dono do projeto Supabase, o Lucca tem acesso técnico a
  tudo pelo SQL. A regra acima é de **procedimento e registro**, não uma barreira
  técnica contra ele. Isso precisa constar na política, e é a mesma situação de
  qualquer operador de SaaS. **[Lucca, D2]**

## 3. Modelo de dados

Parte do esquema provisório da Frente 1. As mudanças em relação a ele vêm marcadas
**Δ**. Nada aqui reaproveita `ad_accounts`: ela tem `access_token` em texto aberto e
o check só aceita plataformas Meta, e continua sendo da Nó.

```sql
-- Tenant: negócio auditado = clients
alter table public.clients add column origem text not null default 'projeto'
  check (origem in ('projeto','auditor','interno'));          -- Δ; a Nó vira 'interno'
alter table public.memberships drop constraint memberships_role_check,
  add constraint memberships_role_check check (role in ('CLIENT','AUDITOR'));  -- Δ

-- Conta do auditor (quem paga) — Δ nova
create table public.auditor_contas (
  id uuid primary key default gen_random_uuid(),
  dono_user_id uuid not null unique references auth.users(id),
  plano text not null default 'gratis' check (plano in ('gratis','mensal','semanal','agencia')),
  assinatura_id uuid unique references public.auditor_assinaturas(id),
  criada_em timestamptz not null default now(),
  encerrada_em timestamptz,               -- cancelamento efetivo ou pedido de exclusão
  excluir_apos timestamptz                -- quando a limpeza apaga tudo (seção 5)
);
alter table public.auditor_assinaturas add column conta_id uuid references public.auditor_contas(id); -- Δ

-- Negócio do auditor (extensão de clients) — Δ nova
create table public.auditor_clientes (
  client_id uuid primary key references public.clients(id) on delete cascade,
  conta_id uuid not null references public.auditor_contas(id) on delete cascade,
  site_url text not null,
  frequencia text not null default 'mensal' check (frequencia in ('semanal','mensal')),
  fuso text not null default 'America/Sao_Paulo',
  retrospectiva_gerada_em timestamptz,    -- a grátis só sai uma vez
  criado_em timestamptz not null default now()
);

-- Conexão (Frente 1) — 1 viva por (client_id, provedor)
create table public.marketing_cliente_conexoes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  provedor text not null check (provedor in ('meta','google')),
  estado text not null check (estado in ('conectado','expirado','revogado','erro','desconectado')), -- Δ +desconectado
  escopos text[] not null default '{}',
  usuario_externo text,                   -- id do usuário na Meta (necessário para o callback de exclusão)
  expira_em timestamptz,                  -- null = sem expiração
  vault_secret_id uuid,                   -- SEM grant de coluna para authenticated; null após apagar
  conectado_por uuid references auth.users(id),
  conectado_em timestamptz not null default now(),
  verificado_em timestamptz,              -- última chamada bem-sucedida
  ultimo_erro text,                       -- código/motivo, nunca token nem resposta crua
  encerrado_em timestamptz
);
create unique index on public.marketing_cliente_conexoes(client_id, provedor) where estado <> 'desconectado';
-- Segredo no Vault: nome 'marketing_cliente:<client_id>:<provedor>' (Frente 1).
-- Meta: token longo ou de usuário do sistema; Google: refresh token. Gravação/leitura/apagamento só por RPCs security definer executáveis por service_role.

-- Contas escolhidas (Frente 1) — 1 por tipo por negócio
create table public.marketing_cliente_ativos (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  conexao_id uuid not null references public.marketing_cliente_conexoes(id) on delete cascade,
  tipo text not null check (tipo in ('meta_ads','google_ads','ga4','gsc')),
  external_id text not null,
  nome text,
  login_customer_id text,                 -- Google Ads via MCC do cliente
  moeda text, detalhe text,
  selecionado_por uuid references auth.users(id),
  selecionado_em timestamptz not null default now(),
  unique (client_id, tipo)                -- [Lucca, D6]
);

-- Snapshots normalizados (formato de normalize.ts) — Δ nova
create table public.marketing_cliente_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  ativo_id uuid not null references public.marketing_cliente_ativos(id) on delete cascade,
  periodo_de date not null, periodo_ate date not null,
  dados jsonb not null,                   -- MetricasPagas | Ga4Resumo | GscResumo + top campanhas/horários
  versao_formato smallint not null,
  coletado_em timestamptz not null default now(),
  unique (ativo_id, periodo_de, periodo_ate)
);

-- Relatórios — Δ nova
create table public.auditor_relatorios (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  tipo text not null check (tipo in ('retrospectiva','semanal','mensal')),
  periodo_de date not null, periodo_ate date not null,
  estado text not null default 'agendado'
    check (estado in ('agendado','coletando','gerando','pronto','enviado','parcial','falhou','pulado')),
  executar_em timestamptz not null,
  tentativas smallint not null default 0,
  fontes jsonb not null default '{}',     -- {"meta_ads":"ok","ga4":"expirado","site":"ok",...}
  achados jsonb,                          -- saída das regras determinísticas (fonte de todo número)
  narrativa jsonb,                        -- saída estruturada da IA (sem números próprios)
  modelo text, versao_regras text, uso jsonb,
  gerado_em timestamptz, enviado_em timestamptz, email_id text, erro text,
  unique (client_id, tipo, periodo_de)
);

-- Trilha (Frente 1, ampliada) — conectou, escolheu, expirou, revogou, desconectou,
-- suporte_concedido, suporte_leu, relatorio_enviado, exclusao_*, acesso_excepcional
create table public.marketing_cliente_eventos (
  id bigint generated always as identity primary key,
  client_id uuid,                         -- sem FK: precisa sobreviver à exclusão do negócio
  ator_user_id uuid, ator_papel text,
  acao text not null, detalhe jsonb not null default '{}',   -- nunca token, e-mail ou métrica
  em timestamptz not null default now()
);

-- Acesso de suporte — Δ nova
create table public.auditor_acessos_suporte (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  concedido_por uuid not null references auth.users(id),
  motivo text, inicio timestamptz not null default now(),
  expira_em timestamptz not null, revogado_em timestamptz
);

-- Pedidos de exclusão (Meta callback e outros) — Δ nova
create table public.auditor_exclusoes (
  id uuid primary key default gen_random_uuid(),
  origem text not null check (origem in ('meta_callback','cliente','cancelamento','inatividade','admin')),
  codigo_confirmacao text not null unique,  -- devolvido à Meta
  provedor text, usuario_externo text, client_id uuid, conta_id uuid,  -- sem FK: sobrevivem à exclusão
  estado text not null default 'recebido' check (estado in ('recebido','concluido','sem_dados')),
  pedido_em timestamptz not null default now(), concluido_em timestamptz
);
```

**RLS e grants:**
- Todas as tabelas novas: RLS ligada; tudo revogado de `anon`.
- Helper `public.auditor_pode_ler(p_client_id uuid)` (security definer,
  `search_path=''`): verdadeiro se existe `memberships(auth.uid(), p_client_id,
  'AUDITOR')`, **ou** se `is_no_admin()` com aal2 e acesso de suporte vigente.
- `authenticated` recebe **só SELECT**, com policy `using (auditor_pode_ler(client_id))`, em:
  - `marketing_cliente_conexoes`: grant de colunas **sem** `vault_secret_id` e `usuario_externo`;
  - `marketing_cliente_ativos`;
  - `marketing_cliente_snapshots`;
  - `auditor_relatorios`: só `estado in ('pronto','enviado','parcial')`;
  - `auditor_clientes`;
  - `auditor_acessos_suporte`, para o cliente ver quem acessou.
- `auditor_contas`: SELECT da própria linha (`dono_user_id = auth.uid()`).
- Sem grant nenhum para `authenticated`: `marketing_cliente_eventos`,
  `auditor_exclusoes` e `auditor_assinaturas`. Toda escrita é por service role ou
  RPC.
- Testes pgTAP obrigatórios:
  - o usuário A não lê nada do negócio B;
  - `NO_ADMIN` sem concessão não lê métricas;
  - `MARKETING_AGENT` não lê nada;
  - `vault_secret_id` é ilegível para `authenticated`.

**Por que snapshots, se o hub da Nó lê ao vivo (spec de 30/09, opção D adiada):**
- o relatório precisa comparar com o período anterior;
- o relatório precisa reproduzir os números enviados por e-mail depois que o token
  expirar;
- o processamento agendado não pode depender das APIs no momento em que o cliente
  abre a tela.

Guardar o normalizado por período, e não o diário bruto por campanha, mantém isso
pequeno.

## 4. Relatório recorrente

**Agenda (recomendação, [Lucca, D4]):**

| Plano | Frequência | Período coberto | Chega |
|---|---|---|---|
| Semanal | toda segunda | segunda a domingo anteriores, no fuso do negócio | segunda até 09h (BRT) |
| Mensal | dia 1 | mês anterior | dia 1 até 09h |
| Agência | o dono escolhe semanal ou mensal **por negócio** (padrão: semanal) | idem | idem |
| Grátis | só a retrospectiva única | últimos 28 dias até ontem | na hora, após escolher as contas |

**Mecânica:** o padrão do hub (`pg_cron` → `pg_net` → rota interna com
`x-cron-secret` do Vault).
- **`auditor-relatorios-planejar`:** diário, às 06:00 BRT (`0 9 * * *` UTC).
  1. Lê os negócios com acesso (`auditor_assinatura_com_acesso`).
  2. Insere as linhas devidas em `auditor_relatorios`, com `on conflict do nothing`:
     a chave única torna a operação idempotente.
  3. Substitui a view `auditor_lista_envio_relatorio`, hoje sem uso.
- **`auditor-relatorios-processar`:** a cada 10 min.
  1. Pega até 3 relatórios `agendado` com `executar_em <= now()`, usando `for
     update skip locked` (padrão `marketing_claim_due_posts`).
  2. Para cada um: coleta → regras → IA → e-mail.
  3. Em erro transitório, faz até 3 tentativas com espera crescente. Esgotadas as
     tentativas, marca `falhou` e manda alerta para `contato@notechstack.com.br`
     (padrão `diag_alertas`).

**Geração, em duas camadas:**
1. **Regras determinísticas** (`_shared/auditor/regras.ts`, versionadas em
   `versao_regras`). Lêem os snapshots do período e do período anterior, mais o
   diagnóstico do site, e produzem `achados[]`: `{id, tipo, severidade, fonte,
   numeros:{…}, evidencia}`.
   - Exemplos: CPA subiu mais de 20%; gasto com zero conversão; campanha com
     frequência acima de 4; divergência entre conversões do Google Ads e eventos
     do GA4; nenhuma conversão por servidor; horário de pico.
   - **Todo número do relatório nasce aqui.**
2. **IA só para redação.** O modelo recebe os `achados` (sem e-mail, nome ou outros
   dados pessoais) e devolve JSON estruturado:
   `{resumo, prioridades:[{achado_id, titulo, o_que_fazer}], tom}`.
   - Um validador rejeita a saída se ela citar um `achado_id` inexistente ou trouxer
     um número que não está nos achados.
   - Se o validador rejeitar, ou a IA falhar, o relatório sai com **texto de
     modelo determinístico**. A IA nunca bloqueia a entrega.
   - **Modelo:** Claude Opus 5.5 (`claude-opus-5-5`), effort `low`, saída
     estruturada via `output_config.format`, SDK `@anthropic-ai/sdk` na Edge
     Function, com `fallbacks: "default"` para recusas.
   - **Troca de modelo:** Claude Sonnet 5.5 (`claude-sonnet-5-5`) custa metade por
     token (US$ 2/10 contra US$ 4/20 por milhão) e é a troca natural se o custo
     pesar. A escolha é do Lucca: **[Lucca, D5]**.
   - **Batch API:** sai pela metade do preço, mas responde em até 24 h. Só vale
     quando o volume de segunda justificar; não entra na v1.
   - O custo por relatório é medido no plano com `count_tokens` sobre um achado real
     e gravado em `uso`. Não há estimativa aqui para não inventar número.

**Entrega:**
- **E-mail pelo Resend**, remetente `relatorios@notechstack.com.br`. O domínio é o
  mesmo já usado no Resend; o Lucca confirma o endereço.
  - Conteúdo: resumo e as 3 prioridades em texto, mais o botão "Ver relatório
    completo", que abre o app (link mágico, se não houver sessão).
  - O e-mail não carrega métricas sensíveis além do resumo.
  - `email_id` é gravado.
- **Tela:** `app /auditor/:clientId/relatorios/:id`, usando os componentes da
  retrospectiva (seção 6).

**Token expirado ou revogado:**

| Situação | O que acontece |
|---|---|
| Meta com `expira_em` a menos de 7 dias | E-mail "reconecte em 1 clique". Repete 1 dia antes. |
| Erro de autenticação na coleta (Meta `190`, Google `invalid_grant`) | Conexão vai para `expirado` (ou `revogado`, se o provedor indicar), e o Vault é apagado em caso de revogação. O relatório sai **`parcial`** com as fontes que restam, mais o diagnóstico do site, que sempre roda, e um bloco "Reconecte o Facebook para ver anúncios". |
| Nenhuma fonte conectada no período | O relatório sai `parcial`, só com o site, e um CTA de reconexão. |
| 30 dias seguidos sem nenhuma conexão viva (assinante) | E-mail oferecendo ajuda ou cancelamento. A cobrança **não** é pausada automaticamente. **[Lucca, D7]** |
| Assinatura sem acesso (`auditor_assinatura_com_acesso` = falso) | O planejador não agenda. As conexões ficam até a limpeza da seção 5. |

## 5. LGPD e plataformas

**Papéis e bases legais (recomendação; revisão jurídica recomendada antes de
publicar):**

| Dado | Papel da nó | Base legal (LGPD art. 7º) |
|---|---|---|
| E-mail, nome e WhatsApp do assinante; registro de acesso | controladora | V: execução de contrato (inclui o plano grátis aceito nos Termos) |
| Dados das contas de anúncio e analytics do cliente (métricas, nomes de campanha, consultas do GSC) | controladora para prestar o serviço contratado. Majoritariamente dado de empresa, mas o GSC pode trazer termos com nomes de pessoas. | V: execução de contrato |
| CPF/CNPJ, endereço e cartão | não guarda: vão direto ao Pagar.me (operador) | V |
| Assinatura e eventos de cobrança | controladora | II: obrigação legal/fiscal, e VI: exercício de direitos |
| Logs de segurança e trilha | controladora | IX: legítimo interesse, minimizado |

**Retenção (recomendação, [Lucca, D3]):**

| Dado | Enquanto ativo | Depois |
|---|---|---|
| Token (Vault) | até desconectar, expirar ou revogar | **apagado na hora** ao desconectar, na revogação ou no pedido de exclusão; em até 30 dias após cancelar a assinatura; 30 dias após conectar sem assinar |
| Ativos escolhidos | enquanto houver conexão | com a conexão |
| Snapshots e relatórios | 13 meses corridos | 90 dias após o encerramento da conta, depois apagados |
| Conta, negócio e usuário | enquanto houver assinatura ou conta grátis com uso | 90 dias após o encerramento; conta grátis sem login há 12 meses é encerrada |
| `auditor_assinaturas` e eventos | — | 5 anos após o fim, sem dados de contato (anonimiza `nome`, `email` e `whatsapp`); confirmar o prazo com o contador |
| `marketing_cliente_eventos` | — | 12 meses; detalhes sem dado pessoal |
| `auditor_exclusoes` | — | 5 anos (prova de atendimento) |

A limpeza ganha o job `auditor_limpar_diario` no padrão de `diag_limpar()`.

**Revogação e exclusão, pelos 4 caminhos:**
1. **O cliente desconecta no app:** revoga no provedor (`revogarNoProvedor`, Frente
   1), apaga do Vault, `estado='desconectado'`. Os snapshots ficam até a regra
   acima.
2. **O cliente pede exclusão da conta:** registra em `auditor_exclusoes`, revoga
   tudo, apaga tokens, ativos, snapshots, relatórios, negócio, conta e usuário em
   até 15 dias (o prazo já publicado em `/privacidade/`) e cancela a assinatura no
   Pagar.me.
3. **A pessoa remove o app pela Meta.**
   - **No lançamento**, vale a URL de instruções `/privacidade/#exclusao-meta`
     (proposta da Frente 2), que aponta para o caminho 2.
   - Mais o **deauthorize callback**, que só marca a conexão como `revogado` e
     apaga o token do Vault.
   - **Recomendado logo depois, sem bloquear o lançamento:** o callback de
     exclusão `POST /cliente/meta/exclusao`.
     - Valida o `signed_request` com o `META_APP_SECRET`.
     - Busca as conexões por `usuario_externo`.
     - Apaga tokens e os dados obtidos por essa conexão.
     - Responde `{url, confirmation_code}`, e a URL mostra o estado em
       `auditor_exclusoes`.
   - O esquema já guarda `usuario_externo` e `auditor_exclusoes`, então o callback
     não exige migration nova.
4. **O Google revoga** (usuário em myaccount): aparece como `invalid_grant` na
   próxima coleta e cai na tabela da seção 4.

**Exigências das plataformas** (já confirmadas pela Frente 2 com fontes oficiais,
salvo a dúvida aberta no fim):
- Meta:
  - URL de Política de Privacidade;
  - URL de exclusão de dados ou callback;
  - verificação da empresa;
  - App Review de `ads_read`, se o acesso avançado for exigido para usuários fora
    dos papéis do app.
- Google:
  - verificação OAuth dos escopos sensíveis (`analytics.readonly`,
    `webmasters.readonly` e `adwords`);
  - branding e domínio verificado;
  - **política de dados do usuário das APIs Google, inclusive "Limited Use"**:
    - sem leitura humana, salvo com consentimento, por segurança ou por exigência
      legal, o que **casa com a seção 2**;
    - sem uso para publicidade;
    - envio a um modelo de IA só para prestar o recurso pedido pelo usuário, sem
      treinar modelos gerais;
  - acesso **Explorer** do projeto `no-hub` para começar, e **Basic** depois da
    verificação da marca.
- Meta: Access Verification (Tech Provider), além do App Review.
- **Dúvida aberta para a Frente 2:** se mandar achados derivados de dados do Google
  para a Anthropic exige divulgação específica na tela de consentimento ou na
  política. A recomendação é divulgar de qualquer forma.

**O que entra em `/privacidade/`** (nova subseção em "7. Auditor", hoje linhas
229-286):
- Conexão com Meta e Google:
  - o que lemos, pelos escopos;
  - para quê: relatório do próprio cliente;
  - o que **não** fazemos: não escrevemos nas contas, não vendemos nem usamos para
    anúncios, não treinamos IA.
- Declaração de conformidade com a política de dados do usuário das APIs Google
  (Limited Use), com o texto exigido.
- Assinatura:
  - o Pagar.me como operador (cartão, CPF/CNPJ e endereço ficam lá);
  - **corrigir a linha 77** ("Não pedimos CPF, dados de pagamento"), que hoje é
    falsa para assinantes;
  - o WhatsApp é coletado e o uso dele precisa ser declarado.
- A Anthropic como operadora também para a redação dos relatórios (só achados
  agregados, sem dado de contato).
- A tabela de retenção acima.
- Os 4 caminhos de exclusão e a página de status `/privacidade/exclusao/`.
- Quem da equipe vê o quê (seção 2), em linguagem simples, incluindo o acesso
  técnico do operador.
- O encarregado e o contato LGPD: hoje é só `notechstack@gmail.com`, sem
  encarregado nomeado. **[Lucca, D9]**

**O que entra em `/termos/`** (hoje não cita o auditor):
- Descrição do serviço e dos planos: preço, frequência e limite de 5 negócios no
  Agência.
- Cobrança mensal no cartão, renovação, recusa e tolerância **[Lucca, D8]**, e
  cancelamento a qualquer momento com efeito no fim do ciclo pago.
- Direito de arrependimento de 7 dias (CDC, art. 49) para a contratação online.
- O relatório é informativo, não garante resultado e depende das conexões.
- Responsabilidade do cliente: só conectar contas que ele tem autorização para
  compartilhar.
- O plano grátis: 1 retrospectiva por negócio, e o que acontece com os dados sem
  assinatura.
- O aceite registrado: o texto de `TEXTO_ACEITE_ASSINATURA` e o novo aceite no
  primeiro acesso.

## 6. Retrospectiva com dados reais

### Recomendação: a retrospectiva real mora no app; a do site continua como demonstração e diagnóstico grátis

- **Por que no app:** a sessão Supabase do cliente vive em `app.notechstack.com.br`.
  O site estático em `notechstack.com.br` não tem sessão nem deve ter. O
  `diagnostico-real.js` já manda os botões "Conectar…" para
  `https://app.notechstack.com.br/?origem=auditor` (linhas 16 e 119-125); falta só
  levar `site=<url>` junto.
- **O que vira código no app (`app/src/auditor/`):**
  - entrar e confirmar o e-mail;
  - escolher contas (t02, alimentada por `/cliente/:id/:provedor/contas`);
  - "lendo as fontes" (t04, com o estado real de `fontes`);
  - nota e checagens do site (t01/t06);
  - Meta Ads (t07), horários (t-horario), Google (t08) e caminho (t-caminho),
    alimentados por `achados` + `narrativa` + snapshots;
  - planos (t13), com checkout logado.
- O visual e o movimento de `retrospectiva/shared/` (Motion, StatusMark, `nota.js`)
  são portados como componentes. A identidade v2 vale.
- **Diagnóstico do site no app:** com `site=<url>`, o servidor reaproveita o
  `diag_cache` de 24 h, se houver. Senão, roda o diagnóstico como parte da
  retrospectiva, sem consumir o limite anônimo de 3 por IP: o usuário logado tem o
  próprio limite, que é o do plano.
- **O site:**
  - `retrospectiva/index.html` mantém as telas de demonstração, com o selo
    "DEMONSTRAÇÃO";
  - o modo `diagnostico-real.js` fica como está, só que passando `site` para o app;
  - nada de dados de cliente no site.
- **Telas que dependem de dado que a Frente 1 não pede:** a "Loja" (t02) e a
  conversão por servidor (`eventos_servidor`) aparecem como "não disponível"
  enquanto não houver escopo. Não se inventa número.

---

## Requisitos (resumo verificável)

| # | Requisito |
|---|---|
| R1 | O cliente entra por link mágico; só conta nova com `AUDITOR_CLIENT`; `NO_ADMIN`/`MARKETING_AGENT` não viram cliente. |
| R2 | Conexões, ativos, snapshots e relatórios têm `client_id` e RLS por `memberships`; o usuário A nunca lê o B (pgTAP). |
| R3 | O token só existe no Vault; nenhuma tela, view, log ou resposta o contém. |
| R4 | Os caminhos `NO_ADMIN`/`MARKETING_AGENT` existentes ficam idênticos (os testes atuais passam sem alteração). |
| R5 | O Lucca vê métricas de cliente só com concessão vigente, e cada leitura fica registrada. |
| R6 | Relatório no dia prometido, para todo negócio com acesso; parcial quando falta fonte; nunca bloqueado pela IA. |
| R7 | Todo número do relatório vem de `achados`; a IA não introduz números. |
| R8 | Desconectar, revogar, cancelar e excluir apagam o que a seção 5 diz, no prazo dito; o callback Meta responde com o código. |
| R9 | `/privacidade/` e `/termos/` publicados com o conteúdo da seção 5 **antes** de abrir a venda ou de pedir as aprovações. |

## Riscos

| Risco | Mitigação |
|---|---|
| Cache de token Google em memória compartilhado entre clientes (`google-auth.ts:23`) | Bloqueio para a Frente 1: indexar por credencial ou desligar para `/cliente/*`. Teste com dois clientes no mesmo worker. |
| Bug no roteador expõe rota de admin a cliente | Dispatch por prefixo antes de `autorizar()`; testes do admin intocados; rotas `/cliente/*` sem nenhum import do store da Nó. |
| Relatórios de segunda estouram o tempo da função | Limite de 3 por chamada, cron a cada 10 min e a janela das 06h às 09h (18 rodadas, ~54 relatórios). Acima disso, aumentar a frequência ou separar a função (sinal: relatórios de segunda saindo depois das 09h). |
| Meta Ads com atribuição atrasada (números de dias recentes mudam) | O rodapé do relatório avisa; a comparação usa o mesmo corte nos dois períodos. |
| Aprovação Meta/Google atrasa | Até lá, só usuários de teste (o Lucca). A venda paga não abre sem a aprovação; a Frente 2 é dona disso. |
| Assinaturas antigas sem conta | Passo 0: contar em produção, só leitura; vincular por e-mail no primeiro login. |

## Fora desta spec (para o plan)

Ordem de blocos sugerida, para o `plan.md` depois do gate:

0. Contagens só leitura em produção.
1. Migration do modelo e pgTAP de isolamento.
2. Correção do cache Google (com a Frente 1).
3. `auditor-acesso` + entrada no app.
4. `/cliente/*` (com a Frente 1).
5. Regras + snapshots.
6. Relatório (IA, e-mail, cron).
7. Retrospectiva no app.
8. Exclusão e callback Meta.
9. Privacidade e Termos.
10. Checkout logado.

## Decisões pendentes (Lucca)

| # | Pergunta | Recomendação |
|---|---|---|
| D1 | Conectar antes de pagar (1 retrospectiva grátis por negócio)? | **Sim.** |
| D2 | Acesso do Lucca a métricas só com concessão do cliente (72 h), metadados sempre? | **Sim.** |
| D3 | Retenção: tokens apagados na hora / 30 d; relatórios 13 meses; 90 d após encerrar; assinaturas 5 anos | **Sim**, prazo fiscal a confirmar com o contador. |
| D4 | Semanal na segunda até 09h; mensal no dia 1; Agência escolhe por negócio | **Sim.** |
| D5 | Modelo da redação | **Opus 5.5 (effort low)**; Sonnet 5.5 se custo pesar. |
| D6 | 1 conta por tipo (Meta Ads, Google Ads, GA4, GSC) por negócio | **Sim na v1.** |
| D7 | Cobrança continua quando o cliente fica desconectado (relatório parcial + aviso aos 30 dias) | **Sim.** |
| D8 | Confirmar a tolerância de 3 dias após recusa (proposta do Dwight) | **Sim.** |
| D9 | Encarregado LGPD e e-mail de contato | Nomear o Lucca; usar um endereço do domínio. |
| D10 | Remetente dos relatórios | `relatorios@notechstack.com.br`. |

## Decisão do gate

Pendente. Nenhuma implementação começa antes da aprovação do Lucca.
