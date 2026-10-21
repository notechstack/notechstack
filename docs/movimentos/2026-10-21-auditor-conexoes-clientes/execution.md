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
