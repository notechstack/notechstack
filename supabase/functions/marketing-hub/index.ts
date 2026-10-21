// Edge Function do hub de marketing. verify_jwt = false no config.toml porque a
// função valida a sessão ela mesma (papel + aal) e a rota do cron não usa JWT.
// Secrets por nome (nunca por valor): ver supabase/README.md.

import { log } from "../_shared/logger.ts";
import { criarHandler } from "./handler.ts";
import { autenticador, clienteAdmin, criarClienteStore, criarStore } from "./store.ts";
import { criarRotasAuditor } from "./auditor.ts";
import { criarAuditorStore } from "./auditor-store.ts";
import { criarGeradorAnthropic } from "../_shared/auditor/anthropic.ts";
import { enviarResend } from "../_shared/auditor/email.ts";
import { executarDiagnostico } from "../diagnostico-auditor/diagnostico.ts";
import { normalizarUrl } from "../diagnostico-auditor/core.ts";
import { lerConfig as lerConfigAssinatura } from "../assinatura-auditor/core.ts";

const env = (nome: string): string | null => Deno.env.get(nome)?.trim() || null;

const admin = clienteAdmin();

const APP_URL = (env("APP_URL") ?? "https://app.notechstack.com.br").replace(/\/$/, "");
const HUB_URL = (env("MARKETING_HUB_PUBLIC_URL") ?? "https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/marketing-hub").replace(/\/$/, "");

// Auditor (Frente 3): completa o ClienteStore da Frente 1 sem mexer nele.
//   suporteVigente — concessão do cliente (migration B);
//   membroAuditor  — posse do negócio, não o vínculo em memberships (revisão A1);
//   leitor         — no modo suporte do NO_ADMIN, a leitura vai pela service role: a RLS só libera o dono, e a
//                    rota já conferiu a concessão e gravou suporte_leu (revisão B6).
const auditorStore = criarAuditorStore(admin);
const clienteBase = criarClienteStore(admin);
function papelDoJwt(jwt: string): string | null {
  try {
    const corpo = jwt.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") ?? "";
    return (JSON.parse(atob(corpo.padEnd(Math.ceil(corpo.length / 4) * 4, "="))) as { app_metadata?: { role?: string } }).app_metadata?.role ?? null;
  } catch {
    return null;
  }
}
const clienteStore = {
  ...clienteBase,
  suporteVigente: auditorStore.suporteVigente,
  membroAuditor: auditorStore.donoDoNegocio,
  leitor: (jwt: string) => (papelDoJwt(jwt) === "NO_ADMIN" ? auditorStore.leitorServico() : clienteBase.leitor(jwt)),
};
const autenticar = autenticador(admin);
const configAssinatura = lerConfigAssinatura({
  PAGARME_ASSINATURA_SECRET_KEY: Deno.env.get("PAGARME_ASSINATURA_SECRET_KEY"),
  PAGARME_SECRET_KEY: Deno.env.get("PAGARME_SECRET_KEY"),
  PAGARME_ASSINATURA_API_URL: Deno.env.get("PAGARME_ASSINATURA_API_URL"),
  PAGARME_ASSINATURA_AMBIENTE: Deno.env.get("PAGARME_ASSINATURA_AMBIENTE"),
});

const rotasAuditor = criarRotasAuditor({
  store: auditorStore,
  clienteStore,
  autenticar,
  google: { clientId: env("GOOGLE_OAUTH_CLIENT_ID"), clientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET"), developerToken: env("GOOGLE_ADS_DEVELOPER_TOKEN") },
  site: async (url) => {
    const r = await executarDiagnostico(url, { fetch: (u, i) => fetch(u, i), validarUrl: normalizarUrl });
    return r ? { url: r.url_final ?? url, checagens: r.checagens } : null;
  },
  gerar: criarGeradorAnthropic(env("ANTHROPIC_API_KEY") ?? undefined),
  enviar: async (para, email, chave) => {
    const apiKey = env("RESEND_API_KEY");
    if (!apiKey) throw new Error("resend_transitorio");
    return await enviarResend({ apiKey, para, email, chave });
  },
  cancelarAssinatura: async (subscriptionId) => {
    if (!configAssinatura.secretKey) return false;
    try {
      const res = await fetch(`${configAssinatura.apiUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${configAssinatura.secretKey}:`)}` },
        body: JSON.stringify({ cancel_pending_invoices: true }),
      });
      await res.body?.cancel();
      if (res.ok) return true;
      if (res.status !== 404 && res.status !== 422) return false;
      // M3: 404/422 só vale como "já cancelada" se o GET confirmar o status canceled.
      const conf = await fetch(`${configAssinatura.apiUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        headers: { Authorization: `Basic ${btoa(`${configAssinatura.secretKey}:`)}` },
      });
      const sub = await conf.json().catch(() => ({})) as { status?: string };
      return conf.ok && sub.status === "canceled";
    } catch {
      return false;
    }
  },
  appUrl: APP_URL,
  agora: () => new Date(),
  log,
});

const handler = criarHandler({
  store: criarStore(admin),
  clienteStore,
  autenticar,
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
      // Nomes próprios: META_APP_SECRET é do app legado de abril (oauth-callback, refresh-tokens).
      meta: { appId: env("AUDITOR_META_APP_ID"), appSecret: env("AUDITOR_META_APP_SECRET"), configId: env("AUDITOR_META_LOGIN_CONFIG_ID") },
    },
  },
  agora: () => new Date(),
  esperar: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  uuid: () => crypto.randomUUID(),
  log,
  auditor: rotasAuditor,
});

Deno.serve(handler);
