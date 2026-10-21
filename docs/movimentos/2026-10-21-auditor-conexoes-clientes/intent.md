---
movement_id: auditor-conexoes-clientes
status: approved
owner: Lucca
created: 2026-10-21
updated: 2026-10-21
coordenacao: C:/Users/lucca/projetos/.tasks/auditor-conexoes.md
---

# Intent: o auditor lê Meta e Google de cada cliente, com o marketing-hub no centro

## Situação

- **Decisão já tomada pelo Lucca (21/10/2026):** o `marketing-hub` passa a ser o
  núcleo do "Conectar com Facebook/Google" do auditor. Este intent registra o
  compromisso e o problema; não reabre o *se*. O que fica para decidir é a *forma*
  (spec).
- **Tipo de problema:** construção. O auditor está à venda em código (checkout
  Pagar.me pronto, atrás de `AUDITOR_VENDA_ABERTA`), mas a parte que dá valor aos
  planos pagos (ler as contas do cliente e mandar o relatório no ritmo do plano)
  ainda não existe.
- **Em andamento e que esta frente toca:**
  - Frente 1 (`claude/auditor-oauth-clientes`) já escreve `oauth-cliente.ts` e
    `contas-cliente.ts` em `_shared/marketing/`, assumindo `client_id` e `user_id`
    no `state` OAuth.
  - Frente 2 levanta as exigências da Meta e do Google.
  - `dwight/auditor-assinatura-pagarme` e `dwight/agentes-auditor` (worktrees do
    Dwight) mexeram na assinatura e na LP.
- **O que está em jogo:** dados de contas de anúncio de terceiros sob LGPD e sob
  as políticas da Meta e do Google. Errar o isolamento expõe um cliente a outro;
  errar a política derruba o app na plataforma. É caro errar, então a spec decide
  isolamento e retenção antes do código.

## O problema

**O que foi prometido:** a LP (`agentes/auditor/index.html:144-155`) e a
retrospectiva (`agentes/auditor/retrospectiva/index.html`) prometem que o cliente
"autoriza uma vez" Meta e Google e recebe um relatório "toda segunda" (Semanal,
R$ 97) ou "1 por mês" (Mensal, R$ 47). O plano Agência (R$ 197) cobre "até 5
clientes, 1 site + contas cada".

**O que já existe e precisa servir:**

- Adaptadores Meta, Google Ads, GA4 e GSC que recebem a credencial por parâmetro
  (`supabase/functions/_shared/marketing/*`) e um formato normalizado de métricas
  (`normalize.ts`).
- Assinatura com estados vindos do webhook e regra de acesso com tolerância
  (`auditor_assinatura_com_acesso`). Ainda não há conta de usuário, só e-mail,
  WhatsApp e `pagarme_subscription_id`.
- Diagnóstico gratuito anônimo, só do HTML público.

**O que trava sem esta frente:**

1. A Frente 1 não tem onde gravar a conexão nem a quem ela pertence.
2. Ninguém sabe quem é o cliente logado nem o que ele pode ver. O hub só conhece o
   slug fixo `no-tech-stack`, e o cache, o registro e os segredos no Vault não têm
   cliente.
3. A view `auditor_lista_envio_relatorio` existe, mas nada a consome. Não há
   gerador, agenda nem entrega do relatório.
4. A retrospectiva só mostra dados de demonstração.
5. Privacidade e Termos não cobrem assinatura, Pagar.me, CPF, OAuth nem exclusão
   de dados exigida pela Meta.

**Por que agora e não depois:** a venda dos planos pagos depende disto. Abrir a
venda sem relatório é cobrar por algo que não é entregue. E a Frente 1 está
escrevendo o armazenamento de tokens agora: decidir o modelo de dados depois
significaria escrevê-lo duas vezes.

## Resultado desejado

- Cada cliente do auditor entra com o próprio e-mail, conecta as contas Meta e
  Google dele e escolhe quais contas o auditor lê.
- O cliente vê a retrospectiva com dados reais e recebe o relatório no ritmo do
  plano, por e-mail e numa tela.
- Os dados de um cliente nunca aparecem para outro.
- `NO_ADMIN` e `MARKETING_AGENT` continuam exatamente como estão.
- O Lucca não lê dados de cliente sem motivo registrado.
- Desconectar, cancelar ou pedir exclusão apaga tokens e dados nos prazos
  publicados.

## Funcionou se

- **Funcionou se:** em até 30 dias após a abertura da venda, todo assinante pago
  com pelo menos uma conexão ativa recebeu os relatórios do período no dia
  prometido. Pela regra do produto, o alvo é 100%.
- **Sinal cedo:** a primeira conexão real do Lucca, como usuário de teste, gera a
  retrospectiva com números que batem com o Ads Manager e o GA4. Sinal de problema:
  relatório em `falhou` ou `parcial` sem que a conexão tenha expirado.
- **Revisão:** o Lucca, depois dos 10 primeiros relatórios pagos enviados.

## Fora de escopo

- Escrita nas contas do cliente (criar ou pausar campanha, publicar post). O
  auditor só lê.
- IG/FB orgânico do cliente: a Frente 1 pede só `ads_read`.
- Migrar a operação da própria Nó (`/no/marketing`) para o novo modelo de conexões.
  Fica possível, mas não faz parte deste movimento.
- TikTok, LinkedIn, Shopify ou loja. A "Loja" da tela t02 da retrospectiva fica
  para depois.
- WhatsApp como canal de entrega (o checkout coleta o número, mas o envio por
  WhatsApp é outro movimento).
- Aprovações das plataformas: responsabilidade da Frente 2.

## Decisão do gate

**Aprovado** pelo Lucca em 21/10/2026, junto com a spec (D1–D10 como recomendado).
