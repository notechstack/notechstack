// Edge Function do hub de marketing. verify_jwt = false no config.toml porque a
// função valida a sessão ela mesma (papel + aal) e a rota do cron não usa JWT.
// Secrets por nome (nunca por valor): ver supabase/README.md.

import { log } from "../_shared/logger.ts";
import { criarHandler } from "./handler.ts";
import { autenticador, clienteAdmin, criarClienteStore, criarStore } from "./store.ts";

const env = (nome: string): string | null => Deno.env.get(nome)?.trim() || null;

const admin = clienteAdmin();

const APP_URL = (env("APP_URL") ?? "https://app.notechstack.com.br").replace(/\/$/, "");
const HUB_URL = (env("MARKETING_HUB_PUBLIC_URL") ?? "https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/marketing-hub").replace(/\/$/, "");

const handler = criarHandler({
  store: criarStore(admin),
  clienteStore: criarClienteStore(admin),
  autenticar: autenticador(admin),
  config: {
    metaToken: env("META_SYSTEM_USER_TOKEN"),
    google: {
      clientId: env("GOOGLE_OAUTH_CLIENT_ID"),
      clientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
      refreshToken: env("GOOGLE_OAUTH_REFRESH_TOKEN"),
      developerToken: env("GOOGLE_ADS_DEVELOPER_TOKEN"),
      customerId: env("GOOGLE_ADS_CUSTOMER_ID"),
      loginCustomerId: env("GOOGLE_ADS_LOGIN_CUSTOMER_ID"),
      ga4PropertyId: env("GA4_PROPERTY_ID"),
      gscSiteUrl: env("GSC_SITE_URL"),
    },
    googleCriacaoLiberada: env("GOOGLE_ADS_CREATE_ENABLED") === "true",
    appUrl: APP_URL,
    clientes: {
      stateSecret: env("MARKETING_OAUTH_STATE_SECRET"),
      hubUrl: HUB_URL,
      // A volta do OAuth cai na tela de conexões do negócio no app (spec, seção 6).
      voltaUrl: env("AUDITOR_VOLTA_URL") ?? `${APP_URL}/auditor/{client_id}/conexoes`,
      meta: { appId: env("META_APP_ID"), appSecret: env("META_APP_SECRET"), configId: env("META_LOGIN_CONFIG_ID") },
    },
  },
  agora: () => new Date(),
  esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  uuid: () => crypto.randomUUID(),
  log,
});

Deno.serve(handler);
