# Conexão Equestre no painel da nó

Estado em 20/10/2026: **cadastro, conta do cliente e acesso ativos em produção; publicação do frontend pendente.**

Cliente de agência da Maisis Publicidade (`f4b64fc8-112b-416f-8612-2e02bcf2ee65`).
Supabase de produção (`sdeowbqmwkwseyktyemn`), transação `conexao-equestre-production.sql` aplicada em 20/10/2026:

| Registro | UUID |
|---|---|
| Cliente `conexao-equestre` | `245c8606-479c-4df2-b863-ccef94b7614a` |
| Projeto "Novo site Conexão Equestre" | `6a84f861-ec07-4193-9bc8-3c07bf3326c3` |
| Vínculo `agency_projects` | Maisis |

14 tarefas em 4 fases (Proposta · Reforma de identidade · Produção do site · Publicação),
3 concluídas; roadmap com `prototype_url` e fluxograma com logos oficiais (nó no centro, WhatsApp,
Google Maps, YouTube, Hostinger, Meta, Supabase). Rota do cliente:
`/p/6a84f861-ec07-4193-9bc8-3c07bf3326c3/como-funciona`.

**Conta do cliente (ativa).** hipicaconexaoequestre@gmail.com · usuário `2b79833d-9ef3-4bc7-b5b4-3435c836bcb9`,
e-mail confirmado, `app_metadata.role=CLIENT`, membership CLIENT com o cliente, projeto com
`access_status=ATIVO_ATE_FIM_DO_PROJETO` desde 20/10/2026. Criado pelo Lucca com
`app/scripts/create-client-user.mjs` (Auth Admin API; cadastro público está desabilitado, `signup_disabled`).
Login real validado pela API de autenticação e no app local: a sessão vê só este projeto, com a
marca Maisis no topo. Senha nunca gravada em arquivo, log ou vault; a service_role passou pelo chat
e deve ser rotacionada.

**Ajustes do painel em 20/10/2026 (compartilhados com os demais clientes):** aba Protótipo sem
toggle Desktop/Celular e sem balão do mascote, com "mockup infinito" (a moldura cresce até a
altura do protótipo de mesma origem; tela cheia mantém rolagem interna); fluxograma aceita
`brand=no` no hub (logo da nó sem inversão); grade de fases das Etapas com `auto-fit`.
Segunda rodada: seletor Desktop/Celular restaurado, ambos infinitos (celular com visor);
cards de pacote aceitam `badge`, `price`, `price_note`, `tagline`, `cta_label` e `cta_href`
(somente `https://` ou `mailto:`). Os botões "Quero o …" abrem e-mail para
contato@maisispublicidade.com.br com o pacote no assunto; trocar pelo WhatsApp da Maisis
quando o Lucca informar. LP: menu com `white-space:nowrap`, CTA curto abaixo de 1240 px e
menu hambúrguer abaixo de 1024 px, para não quebrar dentro do quadro.

## Arquivos

- `PROPOSTA-PACOTES.md` — diagnóstico do site atual e os três pacotes (R$ 2 mil · 5 mil · 10 mil).
- `conexao-equestre.json` — snapshot do cadastro: cliente, projeto, roadmap (stack, apresentação,
  três `scope_options` sem nenhum selecionado, `prototype_url`) e 8 tarefas reais da fase de proposta.
- `build-sql.mjs` → `conexao-equestre-production.sql` — transação idempotente no padrão da Gazeta:
  resolve agência por slug, cria cliente/projeto só se ausentes, vincula em `agency_projects`,
  grava kanban e roadmap. Não cria usuário Auth, membership nem versão publicada.
- `screenshot.mjs` — captura do protótipo em desktop e celular (`checks/`).
- Protótipo: `app/public/prototipos/conexao-equestre/lp-basica-v1/` (index.html + 36 imagens do
  site atual, 4,3 MB). Servido pelo rewrite existente de `/prototipos/` em `app/vercel.json`.

## Decisões de cadastro

- `lead_status=JANELA_DE_DECISAO` e `project_status=EM_REVISAO_CLIENTE`: proposta apresentada,
  pacote ainda não escolhido. Nenhum pacote marcado como `selected`.
- Módulos: como_funciona, protótipo e etapas ativos; editor, versões e marca bloqueados.
- `hide_project_navigation=true` (projeto único), como na Gazeta.
- Valores dos pacotes aparecem nos rótulos das opções por decisão do Lucca; remover de
  `scope_options[].label` antes de gravar se a política comercial com a Maisis mudar.
- Sem e-mail do cliente: acesso CLIENT não liberado. Para liberar depois, seguir a seção
  "Acesso do cliente" da skill `no-criar-cliente`.

## Pendências

1. Publicar o frontend com a pasta do protótipo (branch `feat/conexao-equestre-onboarding`);
   até lá a aba Protótipo retorna 404 em produção.
2. Conferir com sessão Maisis no navegador (carteira → detalhe → Protótipo); a RPC já lista o projeto.
4. Revisar os diferenciais dos pacotes: Lucca quer acentuar o gap de UX/UI entre Básico e
   Plataforma (animações de tela, componentes interativos, scroll). Atualizar
   `PROPOSTA-PACOTES.md`, `conexao-equestre.json` e o `scope_options` no banco.
5. Prévia local: `/__preview/cliente-agencia/prototipo?projeto=conexao-equestre` com
   `VITE_AGENCY_LOCAL_PREVIEW=true` (DEV), renderiza o snapshot sem banco.
