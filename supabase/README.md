# Supabase da nó — hub de marketing e histórico da Fase 1

Projeto Supabase: `sdeowbqmwkwseyktyemn` (sa-east-1). Produção compartilhada com o
funil de leads, o checkout, os dashboards de clientes e o console de agências.

## Hub de marketing (movimento `hub-marketing-agentes`, 30/09/2026)

Planner `/no/marketing` no app → Edge Function `marketing-hub` → Meta / Google.
Documentos: `docs/movimentos/2026-09-30-hub-marketing-agentes/` (intent, spec, plan, execution).

- **Quem entra**: `NO_ADMIN` só com sessão `aal2` (TOTP obrigatório) e a conta do dot
  (`MARKETING_AGENT`), que só enxerga o planner. A função decide por papel em toda rota.
- **Leitura ao vivo** com cache em `marketing_cache` (15 min para dias abertos, 60 min
  para períodos fechados). `?fresco=1` ignora o cache.
- **Escrita**: toda ação grava `marketing_actions` antes de chamar a API, idempotente por
  `request_id`. Campanhas nascem `PAUSED`.
- **Posts**: fila em `scheduled_posts`; o `pg_cron` (`marketing-publish-due`, a cada 5 min)
  chama `marketing-hub/internal/publish-due` com o segredo `MARKETING_CRON_SECRET` do Vault.
- **Mídia**: bucket privado `marketing-media`, só por URL assinada da função.

### Secrets da `marketing-hub` (nomes; valores só no painel do Supabase)

| Nome | O que é |
| --- | --- |
| `META_SYSTEM_USER_TOKEN` | token do usuário do sistema "nó-hub" (Business Manager da nó) |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | cliente OAuth do projeto Google Cloud "no-hub" |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | refresh token com os escopos Ads, Analytics (leitura) e Search Console (leitura) |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | developer token da conta de administrador (MCC) |
| `GOOGLE_ADS_CUSTOMER_ID` / `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | conta de anúncios da nó / MCC (não são segredo) |
| `GA4_PROPERTY_ID` / `GSC_SITE_URL` | propriedade GA4 numérica / site do Search Console (não são segredo) |
| `GOOGLE_ADS_CREATE_ENABLED` | `true` só depois da prova V6 (Explorer Access cria campanha) |
| `APP_URL` | já existente; base do link de convite do dot |

No Vault do banco: `MARKETING_CRON_SECRET` (criado pela migration, nunca sai do banco) e
`marketing_hub_url` (URL da função, criada no deploy).

Os ids da Meta (conta de anúncios `act_…`, Página, Instagram) ficam em `ad_accounts`
(cliente `no-tech-stack`), com `access_token` nulo.

### Conexões dos clientes do auditor (`/cliente/*`, 21/10/2026)

"Conectar com Facebook/Google" por negócio, para o auditor da nó.agentes. A spec é
`docs/movimentos/2026-10-21-auditor-conexoes-clientes/`. O código fica em `marketing-hub/clientes.ts`,
`_shared/marketing/oauth-cliente.ts` e `contas-cliente.ts`. A migration A é `20261021120000_marketing_cliente_conexoes.sql`.

- **Quem acessa:**
  - O membro `AUDITOR` de um negócio com `clients.origem='auditor'` tem acesso total.
  - O `NO_ADMIN` com aal2 e acesso de suporte vigente só lê, e cada leitura é registrada. A concessão chega na migration B.
  - O `NO_ADMIN` não conecta em nome do cliente.
  - O dot recebe 403.
- **O `clientId` vem da URL**, nunca do corpo.
- **Fluxo:**
  - `POST /cliente/:clientId/{meta|google}/conectar` devolve a URL de `/ir`.
  - `GET /cliente/{p}/ir` grava o cookie HttpOnly e manda ao provedor.
  - `GET /cliente/{p}/callback` faz 303 para `APP_URL/auditor/:clientId/conexoes`.
  - O state é assinado (HMAC), expira em 10 min e tem nonce de uso único. O PKCE é S256.
- **Tokens:** o token da Meta (longo ou de usuário do sistema) e o refresh token do Google ficam **só no Vault**
  (`marketing_cliente:<client_id>:<provedor>`). Nenhum papel do navegador lê o segredo nem o id dele.
  O cache de access token Google é um por credencial.
- **Depois de conectar:**
  - `GET /cliente/:clientId/{p}/contas` lista as contas.
  - `POST /cliente/:clientId/ativos` grava a escolha. Só aceita o que o token do cliente lista.
  - `GET /cliente/:clientId/conexoes` e `GET /cliente/:clientId/overview` leem com o **JWT do usuário**; a RLS é a segunda trava.
  - `DELETE /cliente/:clientId/{p}` desconecta: revoga no provedor, apaga do Vault e marca `desconectado`.
- **Meta:** `POST /cliente/meta/desautorizar` recebe o deauthorize por `signed_request` e marca `revogado`.

| Nome (secret da função) | O que é |
| --- | --- |
| `MARKETING_OAUTH_STATE_SECRET` | chave HMAC do state e do PKCE (32+ caracteres aleatórios) |
| `META_APP_ID` / `META_APP_SECRET` | app da Meta usado no login dos clientes |
| `META_LOGIN_CONFIG_ID` | configuração do Facebook Login for Business (`ads_read`); sem ela, pede `scope=ads_read` |
| `MARKETING_HUB_PUBLIC_URL` | opcional; base pública da função para o `redirect_uri` (domínio verificado, para a verificação Google) |
| `AUDITOR_VOLTA_URL` | opcional; destino da volta, com `{client_id}` (padrão `APP_URL/auditor/{client_id}/conexoes`) |

O Google reaproveita `GOOGLE_OAUTH_CLIENT_ID` e `GOOGLE_OAUTH_CLIENT_SECRET`. Se `GOOGLE_ADS_DEVELOPER_TOKEN`
existir, ele vai no cabeçalho; se não existir, o cabeçalho é omitido. Os redirect URIs a cadastrar são
`<base>/cliente/meta/callback` e `<base>/cliente/google/callback`. A listagem de propriedades GA4 usa
a Analytics Admin API, que precisa estar ativada no projeto Cloud.

### Provas locais

```bash
supabase db reset --local
supabase test db
supabase functions serve marketing-hub
node supabase/tests/hub_marketing_edge.mjs
# conexões dos clientes: variáveis de fixture no cabeçalho do script
node supabase/tests/hub_marketing_clientes_edge.mjs
```

Nota: desde `20261001214638_marketing_lead_classificacao.sql`, um banco local vazio não passa do
backfill (a migration exige os 10 leads de produção). Para subir a stack, insira 10 leads de fixture
no período, numa cópia local que não seja commitada.

## Histórico — Fase 1 de abril (arquivada)

O backend Meta de abril (OAuth por cliente, sync diário, refresh de tokens) nunca chegou
a ter conta conectada. As quatro funções foram arquivadas em
`supabase/functions-archive/meta-2026-04/` e saíram do `config.toml`. As tabelas ficaram:
`ad_accounts` virou o cadastro de ativos do hub e `scheduled_posts` virou a fila de posts.
Desde a migration `20260930215739`, `anon` e `authenticated` não têm privilégio nenhum
nessas tabelas.

O texto original da Fase 1 segue abaixo como referência.

---

### Texto original: nó hub — backend core de integração Meta (Fase 1)

Backend centralizado que alimenta todos os hubs da nó com dados de **Meta Ads**
e **Instagram/FB orgânico**. Multi-tenant via Row Level Security — cada cliente
só enxerga a própria linha pelo claim `client_id` no JWT.

Projeto Supabase: `sdeowbqmwkwseyktyemn` (sa-east-1).
Meta App ID: `1590026522084626` (Facebook Login).

## Estrutura

```
supabase/
├── config.toml                        # config do projeto (verify_jwt por função)
├── migrations/
│   └── 20260423195849_meta_integration_core.sql
└── functions/
    ├── _shared/                       # helpers (meta client, cors, logger, supabase)
    ├── oauth-callback/                # recebe redirect da Meta, salva tokens
    ├── sync-meta-ads/                 # cron diário — insights de campanhas
    ├── sync-meta-organic/             # cron diário — insights IG + FB Page
    └── refresh-tokens/                # cron diário — estende long-lived tokens
```

## Tabelas

| Tabela | Pra quê |
| --- | --- |
| `clients` | 1 linha por cliente da nó (gera o slug do hub) |
| `ad_accounts` | Contas Meta conectadas via OAuth (Ads, Page, IG Business) |
| `ad_metrics_daily` | Snapshot diário por campanha |
| `social_metrics_daily` | Snapshot diário por perfil orgânico |
| `scheduled_posts` | Fila de publicação programada |
| `sync_logs` | Auditoria de execução dos jobs |
| `ad_accounts_public` (view) | ad_accounts SEM o access_token, pro frontend |

## Deploy inicial

Pré-requisito: Supabase CLI instalado e você logado (`supabase login`).

```bash
cd supabase-backend-repo-root/   # onde está a pasta supabase/
supabase link --project-ref sdeowbqmwkwseyktyemn
```

### 1. Subir o schema

```bash
supabase db push
```

### 2. Adicionar o App Secret no Vault

**Faça isso ANTES de deployar qualquer função** — elas falham sem o secret.

```bash
supabase secrets set META_APP_SECRET=<valor-do-app-secret-da-Meta>
```

Confere com:

```bash
supabase secrets list
```

### 3. Deploy das Edge Functions

```bash
supabase functions deploy oauth-callback    --no-verify-jwt
supabase functions deploy sync-meta-ads
supabase functions deploy sync-meta-organic
supabase functions deploy refresh-tokens
```

> A flag `--no-verify-jwt` no `oauth-callback` é redundante com o `config.toml`,
> mas deixamos explícito pra quem lê o comando.

## Seed de teste (Thais Santinhas)

```sql
insert into public.clients (name, slug, email)
values ('Thais Santinhas', 'thais', 'thais@example.com')
returning id;
```

Guarda o `id` devolvido — vamos usar no `state` da URL OAuth.

## Testar o fluxo OAuth manualmente

1. Garanta que a Thais está **adicionada como Tester** no app Meta
   (`developers.facebook.com` → App da nó → Roles → Test Users).
2. Monte a URL OAuth (substitua `{CLIENT_ID_UUID}` pelo id da Thais):

   ```
   https://www.facebook.com/v21.0/dialog/oauth?client_id=1590026522084626&redirect_uri=https%3A%2F%2Fsdeowbqmwkwseyktyemn.supabase.co%2Ffunctions%2Fv1%2Foauth-callback&state={CLIENT_ID_UUID}&scope=ads_read%2Cads_management%2Cbusiness_management%2Cpages_show_list%2Cpages_read_engagement%2Cinstagram_basic%2Cinstagram_manage_insights%2Cinstagram_content_publish%2Cinstagram_manage_comments%2Cpublic_profile%2Cemail&response_type=code
   ```

   Versão legível dos parâmetros:

   | Parâmetro | Valor |
   | --- | --- |
   | `client_id` | `1590026522084626` |
   | `redirect_uri` | `https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/oauth-callback` |
   | `state` | `{CLIENT_ID_UUID}` |
   | `scope` | `ads_read,ads_management,business_management,pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_insights,instagram_content_publish,instagram_manage_comments,public_profile,email` |
   | `response_type` | `code` |

3. Abra no browser logado com a conta Meta da Thais, aceite as permissões.
4. Confere o resultado:

   ```sql
   select id, platform, external_id, external_name, status, token_expires_at
   from public.ad_accounts
   where client_id = '{CLIENT_ID_UUID}';

   select * from public.sync_logs
   where job_name = 'oauth-callback'
   order by created_at desc
   limit 5;
   ```

   Esperado: 1 linha `meta_ads` (conta Ads), 1 linha `meta_page` e 1 linha
   `meta_instagram` (se a Page estiver vinculada a um IG Business).

## Testar sync manual (via curl)

Use a **service role key** do projeto (pega em Project Settings → API).
Nunca expõe essa key no frontend.

```bash
export SERVICE_ROLE_KEY="eyJ..."
export FN_URL="https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1"

# Sync de Ads — todas as contas ativas
curl -X POST "$FN_URL/sync-meta-ads" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{}'

# Sync de Ads — só uma conta
curl -X POST "$FN_URL/sync-meta-ads" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -d '{"account_id":"<uuid-da-ad_accounts>"}'

# Sync orgânico
curl -X POST "$FN_URL/sync-meta-organic" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "content-type: application/json" -d '{}'

# Refresh de tokens
curl -X POST "$FN_URL/refresh-tokens" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY"
```

Cada chamada devolve um JSON tipo:

```json
{
  "results": [
    { "account_id": "...", "status": "success", "records": 21 }
  ]
}
```

Validação:

```sql
-- Amostra dos dados sincronizados
select date, campaign_name, spend, conversions, roas
from public.ad_metrics_daily
where client_id = '{CLIENT_ID_UUID}'
order by date desc, spend desc
limit 20;

select date, followers_count, followers_gained, engagement_rate
from public.social_metrics_daily
where client_id = '{CLIENT_ID_UUID}'
order by date desc;

select * from public.sync_logs
order by created_at desc
limit 20;
```

## Logs

Os logs das functions são JSON estruturado (`console.log(JSON.stringify(...))`)
e aparecem em **Project → Edge Functions → [nome da função] → Logs**. Dá pra
filtrar por `event` (ex: `event=sync_ads_failed`) ou `account_id`.

## Próximos passos (fora desta fase)

- Fase 2: módulo de dashboard no hub da Thais consumindo `ad_metrics_daily` +
  `social_metrics_daily` via view `ad_accounts_public`.
- Vercel Cron pra disparar `sync-meta-ads`, `sync-meta-organic` diariamente e
  `refresh-tokens` semanalmente (prompt separado).
- App Review da Meta (Lucca faz depois de validar MVP com 1-2 clientes reais).
- Encryption-at-rest adicional pro `access_token` via `pgsodium` ou Supabase
  Vault (hoje já fica criptografado em disco pelo Supabase, mas podemos
  endurecer).
