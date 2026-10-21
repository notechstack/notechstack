---
movement_id: auditor-conexoes-clientes
plan: ./plan.md
updated: 2026-10-21
---

# Execução: Frente 3 (auditor por cliente)

Branch `claude/auditor-clientes-frente3`. Nada aplicado em produção até agora.

## Rodada 1 (21/10/2026)

### Feito

| Passo do plano | O que entrou | Onde |
|---|---|---|
| 1 · Migration B | Contas e plano; negócios; snapshots; relatórios; acesso de suporte; exclusões; avisos; limite do link mágico; `auditor_pode_ler` com suporte (D2); agenda, fila, falhas, exclusão e limpeza; view `auditor_operacao`; jobs `pg_cron`. | `supabase/migrations/20261021130000_auditor_clientes.sql`, `supabase/rollback/…down.sql` |
| 2 · Entrada | Função `auditor-acesso` (link mágico pelo Resend), RPCs `auditor_eu_*` e tela `/auditor/entrar`. O `LoginPage` leva `AUDITOR_CLIENT` para `/auditor`. | `supabase/functions/auditor-acesso/`, `app/src/auditor/` |
| 3 · Suporte | Concessão e revogação de 72 h pelo dono, na tela de negócios. | RPC `auditor_eu_suporte`, `AuditorPages.tsx` |
| 4 · Regras e redação | Regras `r1`, redação com saída estruturada validada, texto de modelo, e-mails do relatório e dos avisos. | `supabase/functions/_shared/auditor/` |
| 5 · Telas | Negócios, conexões (contrato `/cliente/*` da Frente 1), relatórios e relatório com estados por fonte. | `app/src/auditor/AuditorPages.tsx` |
| 7 · Exclusão (banco) | `auditor_apagar_conta` apaga negócio, conexões e segredo do Vault, ativos, snapshots, relatórios, conta e usuário. Também anonimiza a assinatura. | migration B |

### Desvios do plano (decididos na execução, todos reversíveis)

1. **Agenda direto em SQL.** O job `auditor-relatorios-planejar` chama `auditor_planejar_relatorios()` sem passar por HTTP, porque o planejamento não precisa de API externa. Só o processamento (`auditor_invoke_processar`) chama a `marketing-hub`.
2. **Retentativas.** Ficam em +10 e +30 min, e a 3ª falha vira `falhou`. É o que o critério C13 pede; o texto do passo 4, "+10, +30, +90", estava em desacordo com o C13.
3. **View `auditor_lista_envio_relatorio` mantida.** Ela não tem leitor, mas o rollback da 200100 a referencia. Apagá-la não traz ganho.
4. **Trilha única.** Os eventos do auditor vão para `marketing_cliente_eventos` (migration A, Frente 1), por `marketing_cliente_evento()`. Não foi criada uma tabela separada.
5. **App fala direto com o banco.** As leituras do app usam a RLS com o JWT do cliente, e as escritas simples usam as RPCs `auditor_eu_*`, presas a `auth.uid()`. Isso tira da `marketing-hub` tudo que não precisa de rede. Ficam lá só o OAuth (Frente 1), o processamento dos relatórios e a exclusão de conta, que precisa revogar no provedor e cancelar no Pagar.me.
6. **Leitura de suporte registrada só pela função.** Um `NO_ADMIN` com concessão vigente também lê pela RLS sem gerar `suporte_leu`, porque o Postgres não registra `SELECT`. O registro é garantido quando a leitura passa pelas rotas da `marketing-hub`, que a Frente 1 já faz (`registrarSuporte`). É risco residual: a concessão do cliente continua obrigatória.

### Provas

- **pgTAP `auditor_clientes.test.sql`: 106 verificações.** Cobrem C1–C4, C7 sequencial, C9, C13, C16, C18, o limite do link (U5) e as RPCs `auditor_eu_*`.
- **`auditor_clientes_concorrencia.mjs`: C7 e C10** com duas sessões reais, 7 verificações.
- **Stack local isolado.** `project_id` `auditor-spec-local`, portas 555xx, fora do repo, com a migration A da Frente 1 copiada só para leitura.
  - Os 13 arquivos pgTAP do repo continuam passando. `agency_console.sql` já falhava antes por não ter plano.
  - O rollback desfaz tudo: sobram só as tabelas de assinatura que já existiam, e nenhum job. A migration reaplica depois.
- **Vitest.**
  - `auditorRelatorio.test.ts`: 17 (regras, C11, C12, e-mails, Resend).
  - `auditorAcesso.test.ts`: 8 (C6, U5, CORS).
  - `auditorTelas.test.tsx`: 7 (entrada, C20, exclusão).
  - Suíte do app: 399 de 401. As 2 falhas são de `pipelineExamples.test.ts`, que lê `../gazeta_bragantina/…` e `home-no-prototipo/`, arquivos que não estão neste worktree. Isso não tem relação com o auditor.
- **`tsc -p tsconfig.app.json` e `eslint`** limpos nos arquivos tocados.

### Falta

- Rebase sobre a branch da Frente 1 depois do push dela. Na sequência:
  - `POST /internal/auditor/processar`: coleta → regras → redação → e-mail; avisos;
  - `POST /cliente/excluir-conta`: revoga no provedor e cancela no Pagar.me;
  - tela `/no/auditor`.
  Esses três ficam na `marketing-hub`, que é da Frente 1 nesta rodada.
- Passo 5: telas da retrospectiva (t01…t13) portadas do protótipo.
- Passo 6: checkout no app (`/auditor/planos`) e `assinatura-auditor` com JWT.
- Passo 8: Política e Termos. Os textos são do PR #64, da Frente 2; os prazos são os da spec, seção 5.
- Passo 9: produção. A migration B só entra depois da migration A aplicada e verificada, com contagens de `leads`, `lead_sessoes` e `lead_eventos` antes e depois, e os advisors.
- Passo 0, só leitura em produção: contagem de `auditor_assinaturas` e leitores de `clients`/`memberships`. A busca no repo já foi feita: as policies de `clients` dependem de um claim `client_id` que os usuários do auditor não têm, e por isso o app usa `auditor_eu()`.

## Rodada 2 (21/10/2026, 10:30–11:00)

### Feito
- **Rebase:** base = `origin/main` (#63, #64, #65) + merge de `origin/claude/auditor-oauth-clientes` (`51ef393a`, `cbe8468a`), com os SHAs preservados.
- **`marketing-hub`:**
  - `auditor.ts` + `auditor-store.ts`, com três rotas:
    - `POST /internal/auditor/processar` (`x-cron-secret`);
    - `POST /cliente/excluir-conta` (cancela no Pagar.me **antes** de apagar; revoga nas plataformas);
    - `GET /auditor/operacao` (NO_ADMIN aal2, sem métricas).
  - `handler.ts`: campo opcional `auditor` em `Deps` e 2 linhas de despacho antes de `/cliente/*`.
  - `index.ts`: liga as rotas e completa o `ClienteStore` com `suporteVigente`.
- **`_shared/auditor/processar.ts`:** coleta atual + anterior com o token do negócio, snapshots, regras, redação, e-mail, retentativas e avisos.
- **Checkout logado:**
  - no banco: `auditor_checkout_preparar`, `auditor_assinatura_vincular` e o gatilho `auditor_assinatura_sincronizar` (paga → plano; cancelada → conta encerrada);
  - `assinatura-auditor/index.ts`: exige sessão (401 antes do Pagar.me), recusa sem conta ou já assinante (409) e vincula dentro do `registrar` (se falhar, o core compensa cancelando);
  - app: `/auditor/planos`, com o cartão tokenizado no navegador.
- **App:**
  - escolher contas (t02);
  - mensagens da volta do OAuth;
  - retrospectiva com snapshots (nota, site, Meta, Google, "onde o clique se perde");
  - `/no/auditor`.
- **Agendamento:** separado em `20261021140000_auditor_agendamento.sql`, que **não** se aplica agora.

### Provas
- **pgTAP:** 622 no total, incluindo o `hub_marketing_clientes` da Frente 1, já com a B aplicada por cima. Só `agency_console.sql` falha, e já falhava antes.
- **`auditor_edge.mjs`:** 26 verificações no runtime Deno real.
  - `processar` vazio responde 200;
  - RLS: a rota `/cliente/*` da Frente 1 nega 403 a outro cliente;
  - relatório gerado com texto de modelo;
  - `auditor-acesso` e `assinatura-auditor` C19;
  - exclusão de conta.
- **Vitest do auditor:** 54 testes. Os arquivos de teste do hub não mudaram, e os 232 testes deles passam.
- **Suíte do app, em sequência (`--no-file-parallelism`):** só o `pipelineExamples` falha (arquivos fora do repo).
  - Em paralelo, testes antigos (planner, `App`) às vezes estouram o tempo por carga da máquina. Isolados, passam.
- **`tsc -p tsconfig.app.json` e `eslint`:** limpos. **`vite build`:** fecha.

### Achado: venda aberta em produção
`GET assinatura-auditor` responde `ambiente: producao`, `venda_aberta: true`. Ver a seção Frente 3 da coordenação (10:58). O deploy da nova `assinatura-auditor` fica segurado até o Lucca decidir.

## Produção — passo a passo (para quem tem acesso ao projeto `sdeowbqmwkwseyktyemn`)

Ordem obrigatória. A migration A já está aplicada (Frente 1, 10:27, versão `20261021132726`).

**1 · Pré-checagem, só leitura.** Parar se algo divergir.
```sql
-- objetos que a B usa precisam existir
select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in
  ('auditor_assinatura_com_acesso','auditor_pode_ler','marketing_cliente_evento','marketing_cliente_conexao_encerrar',
   'marketing_cron_secret_ok','is_no_admin') order by 1;                       -- 6 linhas
select column_name from information_schema.columns where table_schema='public' and table_name='auditor_assinaturas'
  and column_name in ('id','plano','nome','email','whatsapp','pagarme_subscription_id','status','created_at','updated_at'); -- 9
select column_name from information_schema.columns where table_schema='public' and table_name='auditor_assinatura_eventos'
  and column_name in ('pagarme_subscription_id','status_aplicado','evento_em','recebido_em');   -- 4
select to_regclass('public.auditor_contas') is null as b_ainda_nao_aplicada;                    -- true
select status, count(*) from public.auditor_assinaturas group by 1;                             -- registrar no log
select (select count(*) from public.leads) leads, (select count(*) from public.lead_sessoes) lead_sessoes,
       (select count(*) from public.lead_eventos) lead_eventos;
```
Rodar também os advisors de segurança e de performance e anotar.

**2 · Aplicar a migration B.** Use o conteúdo de `supabase/migrations/20261021130000_auditor_clientes.sql` da branch `claude/auditor-clientes-frente3`, com o nome `auditor_clientes`. **Não** aplicar a `20261021140000_auditor_agendamento.sql`.

**3 · Pós-checagem.**
```sql
select (select count(*) from public.leads), (select count(*) from public.lead_sessoes), (select count(*) from public.lead_eventos); -- iguais ao passo 1
select count(*) from cron.job where jobname like 'auditor%';                       -- 0 (sem agendamento)
select count(*) from public.auditor_contas;                                        -- 0
select public.auditor_planejar_relatorios();                                       -- 0, sem erro
select public.auditor_invoke_processar();                                          -- null (sem trabalho, sem HTTP)
select public.auditor_assinatura_com_acesso('paga', null, true);                   -- true (D8 intacta)
```
Diferenças esperadas nos advisors:
- RLS sem policy em `auditor_eventos`? Não existe: a trilha é a `marketing_cliente_eventos`.
- Novas tabelas com RLS e policy só de leitura.
- `auditor_acesso_tentativas`, `auditor_exclusoes` e `auditor_avisos` ficam sem policy (só service_role).
- Funções `security definer` para authenticated: `auditor_eu`, `auditor_eu_iniciar`, `auditor_eu_suporte`, `auditor_eu_retrospectiva`, `auditor_eu_negocio_criar` e `auditor_eu_frequencia` (6 a mais).
- Índices sem uso nas tabelas novas.

**4 · Deploy das funções**, a partir da branch `claude/auditor-clientes-frente3`:
- `auditor-acesso`, com `verify_jwt=false`. Precisa de `RESEND_API_KEY` e `DIAG_IP_SALT`, que já existem; e de `APP_URL`.
- `marketing-hub`, com `verify_jwt=false`. Inclui tudo da v12 da Frente 1 mais as rotas do auditor. Antes, rodar `marketingHub.test.ts`, `marketingClientes.test.ts`, `marketingAdapters.test.ts` e o pgTAP `hub_marketing`.
- **`assinatura-auditor`: publicar.** A venda foi fechada pelo Lucca (`venda_aberta:false`, conferido às 11:37). Com ela fechada, a exigência de login não quebra nada no site, e o botão do site passa a levar ao app.

**5 · Provas pós-deploy** (sem login, todas sem efeito colateral):
- `POST marketing-hub/internal/auditor/processar` sem segredo → 401;
- o mesmo com o segredo do Vault → 200 `{"relatorios":{},"avisos":0}`;
- `GET marketing-hub/auditor/operacao` sem login → 401;
- `/overview`, `/connections`, `/config` e `/internal/publish-due` com as mesmas respostas da prova das 10:25/10:41;
- `POST auditor-acesso` com `{"email":"x"}` → 400.
- `GET marketing-hub/auditor/copia/<uuid>` sem login → 401;
- `POST assinatura-auditor` sem login → 401 `login_necessario`;
- `GET assinatura-auditor` → `venda_aberta:false`.

**Rollback:**
- `supabase/rollback/20261021130000_auditor_clientes.down.sql`, que devolve `auditor_pode_ler` à versão da A;
- redeploy da `marketing-hub` v12.


## Rodada 3 (21/10/2026, 11:00–11:40) — decisões do Lucca via orquestrador

### Feito
- **Rebase** sobre a `origin/main` com o #67 (`f6a104f9`). O diff da `marketing-hub` contra a main tem só as adições da Frente 3.
- **Fora o WhatsApp como canal do relatório.** Agora é e-mail + painel em todos os lugares:
  - `TEXTO_ACEITE_ASSINATURA` (servidor), `checkout.ts` (app) e o script de sandbox: "Sei que o relatório do Auditor chega no meu e-mail e no meu painel do auditor.";
  - planos da retrospectiva do site, `auditor.js`, `assinatura.js` (mensagens) e app: "celular" no lugar de "WhatsApp";
  - continuam os links de **contato** por WhatsApp (rodapé e a mensagem de compensação do checkout): são canal de suporte, não promessa de entrega.
- **Checkout do site:** o botão "Assinar" do site leva a `https://app.notechstack.com.br/auditor/planos?plano=…`, onde o formulário daquele plano já abre. O diálogo antigo do site fica sem uso.
- **Cópia opcional pelo WhatsApp** (proposta do orquestrador, implementada; cabe no modelo):
  - `auditor_contas.copia_whatsapp`, `copia_whatsapp_numero` e `copia_whatsapp_em` (consentimento);
  - opt-in **desmarcado** no checkout. O número vem do celular informado, por `auditor_assinatura_vincular(…, p_copia_whatsapp)`;
  - o cliente liga e desliga em "Conta" (`auditor_eu_copia_whatsapp`). Desligar apaga o número;
  - a equipe abre em `/no/auditor` → "Cópia para WhatsApp" (`GET /auditor/copia/:relatorioId`, NO_ADMIN aal2, por `auditor_copia_whatsapp_ler`):
    - **só com opt-in**, e devolve 404 igual a inexistente;
    - só relatório pronto, enviado ou parcial;
    - só **resumo + prioridades** (o texto do e-mail), nunca snapshots nem achados;
    - **cada leitura** gera `copia_whatsapp_leu` na trilha;
    - o texto vem pronto para colar, com o link para o relatório completo.
  - Como passa por RPC de service role, e não pela RLS, o registro é garantido.
- **Política** (`/privacidade/#copia-whatsapp`) e **Termos** (seção 6): a entrega é por e-mail e painel, e a cópia opcional entra como exceção explícita à regra "ninguém da equipe lê". Base legal: consentimento (art. 7º, I), revogável em "Conta".

### Provas
- **pgTAP:** 634 (126 em `auditor_clientes.test.sql`, 12 delas da cópia). Só `agency_console.sql` falha, como antes. Rollback e reaplicação OK.
- **Integração Deno:** 28, incluindo a rota da cópia (401 sem login, 403 para cliente).
- **Concorrência:** 7.
- **Vitest do auditor:** 58. **Suíte do app em sequência:** 483 de 485 (as 2 do `pipelineExamples`).
- **Testes do site** (`tests/assinatura-auditor`): 106 de 110, o mesmo de antes. As 4 falhas são de ambiente: `front` e `consistencia` leem arquivos fora do repo, e `acesso` e `sql` dependem do `@electric-sql/pglite`, que não está instalado. O `front.test.mjs` foi atualizado para o texto novo, mas não roda aqui.
- **`tsc`, `eslint` e `vite build`:** limpos.
