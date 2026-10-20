# Conexão Equestre no painel da nó

Estado em 20/10/2026: **cadastro gravado em produção; conta do cliente e publicação do frontend pendentes.**

Cliente de agência da Maisis Publicidade (`f4b64fc8-112b-416f-8612-2e02bcf2ee65`).
Supabase de produção (`sdeowbqmwkwseyktyemn`), transação `conexao-equestre-production.sql` aplicada em 20/10/2026:

| Registro | UUID |
|---|---|
| Cliente `conexao-equestre` | `245c8606-479c-4df2-b863-ccef94b7614a` |
| Projeto "Novo site Conexão Equestre" | `6a84f861-ec07-4193-9bc8-3c07bf3326c3` |
| Vínculo `agency_projects` | Maisis |

8 tarefas (3 concluídas), roadmap com `prototype_url`, memberships = 0.
Rota do cliente após o acesso: `/p/6a84f861-ec07-4193-9bc8-3c07bf3326c3/como-funciona`.

**Conta do cliente (pendente).** E-mail informado pelo Lucca: hipicaconexaoequestre@gmail.com.
O cadastro público está desabilitado no projeto (`signup_disabled`) e o Auth Admin API exige a
service_role, que não é lida pelo agente. Executar `app/scripts/create-client-user.mjs` com as
variáveis no ambiente (cria o usuário confirmado com papel CLIENT e a membership) e depois:

```sql
update public.projects set access_status='ATIVO_ATE_FIM_DO_PROJETO', access_released_at=coalesce(access_released_at, now())
where id='6a84f861-ec07-4193-9bc8-3c07bf3326c3';
```

Senha nunca gravada em arquivo, log ou vault.

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
2. Criar a conta do cliente (acima) e liberar `access_status`.
3. Conferir com sessão Maisis (carteira → detalhe → Protótipo) e com login do cliente.
4. Revisar os diferenciais dos pacotes: Lucca quer acentuar o gap de UX/UI entre Básico e
   Plataforma (animações de tela, componentes interativos, scroll). Atualizar
   `PROPOSTA-PACOTES.md`, `conexao-equestre.json` e o `scope_options` no banco.
5. Prévia local: `/__preview/cliente-agencia/prototipo?projeto=conexao-equestre` com
   `VITE_AGENCY_LOCAL_PREVIEW=true` (DEV), renderiza o snapshot sem banco.
