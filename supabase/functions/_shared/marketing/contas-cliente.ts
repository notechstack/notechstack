// Contas que o cliente pode escolher depois de conectar: act_* da Meta,
// customers do Google Ads, propriedades GA4 e sites do Search Console.
// Só leitura, com o token do próprio cliente; reaproveita os clientes HTTP do hub.

import { paginar } from "./meta.ts";
import { GOOGLE_ADS_API, adsSearch, idCliente } from "./google-ads.ts";
import { googleFetch } from "./google-auth.ts";

export type TipoAtivo = "meta_ads" | "google_ads" | "ga4" | "gsc";
export const TIPOS_ATIVO: readonly TipoAtivo[] = ["meta_ads", "google_ads", "ga4", "gsc"];

export type ContaSelecionavel = {
  tipo: TipoAtivo;
  external_id: string;
  nome: string | null;
  // Google Ads acessado via MCC do cliente: o id da MCC vai no cabeçalho login-customer-id.
  login_customer_id: string | null;
  moeda: string | null;
  detalhe: string | null;
};

const ESCOPO = {
  ads: "https://www.googleapis.com/auth/adwords",
  ga4: "https://www.googleapis.com/auth/analytics.readonly",
  gsc: "https://www.googleapis.com/auth/webmasters.readonly",
};

// Limites para uma conta com muitos ativos não estourar o tempo da função.
const MAX_CUSTOMERS = 20;

// ---------------------------------------------------------------------- Meta

type ContaMetaApi = { id: string; name?: string; currency?: string; account_status?: number };

export async function metaContasAnuncio(token: string): Promise<ContaSelecionavel[]> {
  const contas = await paginar<ContaMetaApi>("/me/adaccounts", {
    access_token: token, fields: "id,name,currency,account_status", limit: "100",
  });
  return contas
    .filter((c) => /^act_\d{1,30}$/.test(c.id))
    .map((c) => ({
      tipo: "meta_ads" as const,
      external_id: c.id,
      nome: c.name ?? null,
      login_customer_id: null,
      moeda: c.currency ?? null,
      // account_status 1 = ativa; os demais (desativada, em análise…) aparecem marcados.
      detalhe: c.account_status === 1 ? null : "inativa",
    }));
}

// -------------------------------------------------------------------- Google

type CustomerApi = { customer?: { id?: string; descriptiveName?: string; manager?: boolean; currencyCode?: string } };
type CustomerClientApi = { customerClient?: { id?: string; descriptiveName?: string; manager?: boolean; currencyCode?: string } };

export async function googleAdsContas(token: string, developerToken: string | null): Promise<ContaSelecionavel[]> {
  const lista = await googleFetch<{ resourceNames?: string[] }>(`${GOOGLE_ADS_API}/customers:listAccessibleCustomers`, token, {
    headers: developerToken ? { "developer-token": developerToken } : {},
  });
  const ids = (lista.resourceNames ?? []).map((r) => idCliente(r.split("/").at(-1) ?? "")).filter(Boolean).slice(0, MAX_CUSTOMERS);
  const saida = new Map<string, ContaSelecionavel>();
  for (const id of ids) {
    const ctx = { token, developerToken: developerToken ?? "", customerId: id, loginCustomerId: null };
    let c: CustomerApi["customer"];
    try {
      c = (await adsSearch<CustomerApi>(ctx, "SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code FROM customer LIMIT 1", 1))[0]?.customer;
    } catch {
      continue; // conta cancelada ou sem acesso direto: não é escolhível
    }
    if (!c) continue;
    if (!c.manager) {
      saida.set(id, { tipo: "google_ads", external_id: id, nome: c.descriptiveName ?? null, login_customer_id: null, moeda: c.currencyCode ?? null, detalhe: null });
      continue;
    }
    // MCC do cliente: as contas filhas diretas viram opções, lidas através da MCC.
    try {
      const filhas = await adsSearch<CustomerClientApi>({ ...ctx, loginCustomerId: id },
        "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.currency_code FROM customer_client WHERE customer_client.level = 1 AND customer_client.status = 'ENABLED'", 2);
      for (const f of filhas) {
        const fid = idCliente(String(f.customerClient?.id ?? ""));
        if (!fid || f.customerClient?.manager || saida.has(fid)) continue;
        saida.set(fid, {
          tipo: "google_ads", external_id: fid, nome: f.customerClient?.descriptiveName ?? null, login_customer_id: id,
          moeda: f.customerClient?.currencyCode ?? null, detalhe: `via MCC ${c.descriptiveName ?? id}`,
        });
      }
    } catch {
      // MCC sem leitura das filhas: segue com as contas diretas.
    }
  }
  return [...saida.values()];
}

type ResumoContasGa4 = {
  accountSummaries?: { displayName?: string; propertySummaries?: { property?: string; displayName?: string }[] }[];
  nextPageToken?: string;
};

export async function ga4Propriedades(token: string): Promise<ContaSelecionavel[]> {
  const saida: ContaSelecionavel[] = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await googleFetch<ResumoContasGa4>(url.toString(), token);
    for (const conta of r.accountSummaries ?? []) {
      for (const p of conta.propertySummaries ?? []) {
        const id = (p.property ?? "").replace(/^properties\//, "");
        if (/^\d{1,20}$/.test(id)) saida.push({ tipo: "ga4", external_id: id, nome: p.displayName ?? null, login_customer_id: null, moeda: null, detalhe: conta.displayName ?? null });
      }
    }
    pageToken = r.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return saida;
}

export async function gscSites(token: string): Promise<ContaSelecionavel[]> {
  const r = await googleFetch<{ siteEntry?: { siteUrl?: string; permissionLevel?: string }[] }>(
    "https://www.googleapis.com/webmasters/v3/sites", token,
  );
  return (r.siteEntry ?? [])
    .filter((s) => s.siteUrl && s.permissionLevel && s.permissionLevel !== "siteUnverifiedUser")
    .map((s) => ({ tipo: "gsc" as const, external_id: s.siteUrl as string, nome: s.siteUrl as string, login_customer_id: null, moeda: null, detalhe: s.permissionLevel ?? null }));
}

export type ListagemGoogle = {
  google_ads: ContaSelecionavel[] | null; // null = escopo não concedido
  ga4: ContaSelecionavel[] | null;
  gsc: ContaSelecionavel[] | null;
  falhas: { tipo: TipoAtivo; mensagem: string }[];
};

// Cada produto falha sozinho: o cliente sem Ads ainda escolhe GA4 e Search Console.
export async function googleContas(token: string, escopos: string[], developerToken: string | null): Promise<ListagemGoogle> {
  const falhas: ListagemGoogle["falhas"] = [];
  const tentar = async (tipo: TipoAtivo, ativo: boolean, f: () => Promise<ContaSelecionavel[]>) => {
    if (!ativo) return null;
    try {
      return await f();
    } catch (e) {
      falhas.push({ tipo, mensagem: e instanceof Error ? e.message.slice(0, 300) : "falha" });
      return null;
    }
  };
  const [google_ads, ga4, gsc] = await Promise.all([
    tentar("google_ads", escopos.includes(ESCOPO.ads), () => googleAdsContas(token, developerToken)),
    tentar("ga4", escopos.includes(ESCOPO.ga4), () => ga4Propriedades(token)),
    tentar("gsc", escopos.includes(ESCOPO.gsc), () => gscSites(token)),
  ]);
  return { google_ads, ga4, gsc, falhas };
}
