# Venexia no painel da nó

Estado em 06/11/2026: **cadastro, conta do cliente e acesso ativos em produção; publicação do protótipo
pendente (merge desta branch).**

Cliente de agência da Maisis Publicidade (`f4b64fc8-112b-416f-8612-2e02bcf2ee65`), trazido pelo Thomas.
Venexia é uma empresa de venda direta de bem-estar e beleza (venexia.com.br).
Supabase de produção (`sdeowbqmwkwseyktyemn`):

| Registro | UUID |
|---|---|
| Cliente `venexia` | `aa1ed608-962e-414c-877b-5b1d0502d6b7` |
| Projeto "Novo site Venexia" | `9c53893e-3dd1-491e-91b5-17dacd45804e` |
| Vínculo `agency_projects` | Maisis |
| Conta venexia@maisis.com.br | `73d0e50a-aad3-40f1-a65d-f8c9c095ca95` (papel CLIENT, membership CLIENT) |

Rota do cliente: `/p/9c53893e-3dd1-491e-91b5-17dacd45804e/como-funciona`.
15 tarefas em 4 fases (Proposta · Conteúdo e identidade · Produção do site · Publicação), 3 concluídas.

## O que foi aplicado

1. `venexia-production.sql` (06/11/2026): cliente, projeto (`JANELA_DE_DECISAO` / `EM_REVISAO_CLIENTE`,
   acesso `ATIVO_ATE_FIM_DO_PROJETO`), vínculo Maisis, kanban e roadmap.
2. `venexia-account-link.sql` (06/11/2026): a conta, criada pelo Lucca no painel do Supabase, recebeu
   `app_metadata.role=CLIENT` e a membership. **Decisão:** feito por SQL em vez de
   `app/scripts/create-client-user.mjs`, porque nenhum checkout tem as dependências instaladas e a
   service_role não passa pelo agente. Efeito no banco igual ao do script (que chama
   `updateUserById(app_metadata)` e insere a membership), com checagens extras. A skill
   `no-criar-cliente` pede Auth Admin API; vale registrar essa rota alternativa nela.
3. Validação sem senha (`venexia-verify.sql`, sessões simuladas por JWT, RLS real): o cliente vê só
   este projeto, 1 roadmap e 15 tarefas; Protótipo liberado, Editor bloqueado, marca Maisis no topo;
   a Conexão Equestre fica invisível. O console da Maisis lista Venexia, Conexão e Gazeta.
   Login real no navegador continua com o Lucca.

## Conta e senha

A senha passou pelo chat. Para trocar: sair e entrar de novo (a sessão antiga não tem o papel CLIENT),
depois abrir `/acesso?projectId=9c53893e-3dd1-491e-91b5-17dacd45804e` e definir uma senha nova.
Alternativa: redefinir no painel do Supabase e entregar fora do chat.

## Arquivos

- `make-json.mjs` → `venexia.json` — snapshot do cadastro (os links de WhatsApp são montados aqui).
- `build-sql.mjs` → `venexia-production.sql` — padrão da Conexão Equestre; rodar de novo não regride
  status, módulos, acesso nem tarefas concluídas, mas regrava o roadmap inteiro.
- `venexia-account-link.sql` — papel CLIENT + membership (aplicado).
- `venexia-verify.sql` — validação por sessões simuladas, sempre com rollback.
- Protótipo: `app/public/prototipos/venexia/lp-institucional-v1/` (1,1 MB). Fonte de trabalho fora
  do repo: `C:/Users/lucca/projetos/venexia/prototipo/`.

## Decisões de conteúdo

- Pacotes com preço nos cards (decisão do Lucca): Site institucional R$ 1.500 · E-commerce R$ 5.000 ·
  Catálogo conceitual R$ 8.000 a 10.000. Botões abrem o WhatsApp do Thomas (+55 11 99715-1833) com
  mensagem pronta citando o pacote. Nenhum pacote `selected`.
- Prazo e suporte não informados: os três cards terminam em "combinados com a Maisis".
- Não está definido se o Pacote 3 inclui a loja do Pacote 2; o fluxograma não promete isso.
- Protótipo de desktop vale a partir de 641 px: no painel, o modo Desktop num notebook 1366 tem ~710 px.
- Fora do protótipo, de propósito: a jornada de 6 passos (texto provisório na apresentação), logos de
  marcas do Best Off (exigem autorização) e a regra de conquista da Venexia Experience (a apresentação
  traz duas versões). Fotos recortadas do PDF; o site final precisa das originais. Formulário sem envio.

## Pendências

1. Merge desta branch para publicar o protótipo. Até lá a aba Protótipo mostra 404 em produção.
2. Login real no navegador com a conta da Venexia e troca da senha.
3. Painel (código, afeta todos os clientes de agência) — corrigido em 06/11/2026, aguardando merge:
   a aba Etapas e o botão "Falar com a equipe" passam a ler `presentation.contact_href` e
   `contact_label` do roadmap (só `https://` ou `mailto:`; padrão WhatsApp da nó), e a moldura do
   protótipo volta a encolher (mede o `<body>`, zera ao trocar de dispositivo). **Passo de dados
   pendente, a pedir ao Lucca depois do merge:** gravar `contact_href` com o WhatsApp do Thomas
   (+55 11 99715-1833) nos roadmaps da Venexia, da Conexão Equestre e da Gazeta; até lá os dois
   botões continuam no WhatsApp da nó.
4. Definir prazo e suporte por pacote e se o Pacote 3 inclui a loja.
