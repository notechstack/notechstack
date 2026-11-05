// Medição da compra do nó.fiscal (Lucca, 22/10/2026: eventos de compra da LP até a assinatura).
// A resposta do checkout leva o evento (nome, event_id, valor) que o navegador repete no fbq e no dataLayer; com o
// consentimento "granted", o mesmo evento sai também daqui para a Meta CAPI, e a Meta deduplica pelo event_id.
// Sem consentimento, nada sai para a Meta (nem fbp/fbc, nem IP, nem hash de e-mail).
// Política da Meta (mesma de supabase/functions/meta-capi): custom_data do checkout só com value, currency e order_id;
// a cobrança paga pelo webhook (fim do arquivo) leva também os ids do plano do nó.fiscal, nunca categoria de saúde.

export const PIXEL_ID = "1753619075655271"; // portfólio 990413650211777, o mesmo do site
export const GRAPH = "https://graph.facebook.com/v21.0";

export type EventoDaCompra = {
  /** Purchase quando há cobrança; StartTrial quando a assinatura entra no teste grátis (nada cobrado agora). */
  evento: "Purchase" | "StartTrial";
  event_id: string;
  transaction_id: string;
  valor: number;
  moeda: "BRL";
};

export type MedicaoDoNavegador = {
  consent: "granted" | "denied";
  fbp: string | null;
  fbc: string | null;
  page_url: string | null;
};

export type ClienteHttp = { ip: string | null; ua: string | null };

export function eventoDaCompra(assinaturaId: string, comTeste: boolean, valorCentavos: number): EventoDaCompra {
  const evento = comTeste ? "StartTrial" : "Purchase";
  return {
    evento,
    event_id: `nofiscal-${comTeste ? "trial" : "purchase"}-${assinaturaId}`,
    transaction_id: assinaturaId,
    valor: Math.round(valorCentavos) / 100,
    moeda: "BRL",
  };
}

const FBP = /^fb\.\d\.\d{10,13}\.\d{1,20}$/;
const FBC = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_-]{8,500}$/;

/** `medicao` do corpo do checkout. Qualquer coisa fora do formato vira "denied" sem identificadores. */
export function lerMedicao(valor: unknown): MedicaoDoNavegador {
  const m = valor && typeof valor === "object" && !Array.isArray(valor) ? valor as Record<string, unknown> : {};
  if (m.consent !== "granted") return { consent: "denied", fbp: null, fbc: null, page_url: null };
  const texto = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const fbp = texto(m.fbp);
  const fbc = texto(m.fbc);
  let pagina: string | null = null;
  try {
    const u = new URL(texto(m.page_url));
    if (u.protocol === "https:" && /(^|\.)notechstack\.com\.br$/.test(u.hostname)) pagina = `${u.origin}${u.pathname}`;
  } catch {
    pagina = null;
  }
  return { consent: "granted", fbp: FBP.test(fbp) ? fbp : null, fbc: FBC.test(fbc) ? fbc : null, page_url: pagina };
}

async function sha256(valor: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(valor)));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Corpo de POST /{pixel}/events. E-mail e telefone vão só em hash, normalizados como a Meta pede. */
export async function corpoDaCompraMeta(
  e: EventoDaCompra,
  pessoa: { email: string; telefone: string; tenantId: string },
  medicao: MedicaoDoNavegador,
  cliente: ClienteHttp,
  agora: Date,
  testEventCode?: string,
): Promise<Record<string, unknown>> {
  const userData: Record<string, unknown> = {};
  const email = pessoa.email.trim().toLowerCase();
  if (email) userData.em = [await sha256(email)];
  const fone = pessoa.telefone.replace(/\D/g, "");
  if (fone.length >= 12) userData.ph = [await sha256(fone)];
  userData.external_id = [await sha256(pessoa.tenantId)];
  if (medicao.fbp) userData.fbp = medicao.fbp;
  if (medicao.fbc) userData.fbc = medicao.fbc;
  if (cliente.ip) userData.client_ip_address = cliente.ip;
  if (cliente.ua) userData.client_user_agent = cliente.ua;
  return {
    data: [{
      event_name: e.evento,
      event_time: Math.floor(agora.getTime() / 1000),
      event_id: e.event_id,
      event_source_url: medicao.page_url ?? "https://www.notechstack.com.br/agentes/fiscal/comecar/",
      action_source: "website",
      user_data: userData,
      custom_data: { value: e.valor, currency: e.moeda, order_id: e.transaction_id },
    }],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
}

/** Envia e devolve um resumo para o log (`ok_<recebidos>`, `erro_<http>`, `erro_rede`); nunca lança. */
export async function enviarParaMeta(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  token: string,
  corpo: Record<string, unknown>,
): Promise<string> {
  try {
    const res = await fetcher(`${GRAPH}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const body = await res.json().catch(() => ({})) as { events_received?: number };
    return res.ok ? `ok_${body.events_received ?? 0}` : `erro_${res.status}`;
  } catch {
    return "erro_rede";
  }
}

// ------------------------------------------------------------ Cobrança paga pelo webhook (03/11/2026)
// A cobrança que vem depois do teste grátis, e cada renovação, não passam pelo navegador: saem do
// assinatura-fiscal-webhook, só com o consentimento gravado no checkout (fiscal_registrar_medicao).
//
// action_source "system_generated": é o valor que a Meta define para "conversão que aconteceu automaticamente,
// por exemplo a renovação de uma assinatura no débito automático". Nenhuma das duas cobranças tem visita ao site
// por trás (o cartão é cobrado pelo Pagar.me no fim do teste e a cada ciclo), então "website" exigiria uma
// event_source_url e um navegador que não existem. O vínculo com a pessoa vem do e-mail, do telefone e do
// external_id (o mesmo hash de tenant do StartTrial do checkout) e, quando a pessoa permitiu, do fbp/fbc gravados.
// custom_data: a política da Meta de meta-capi vale aqui (nada de saúde); o nó.fiscal leva só ids do próprio plano.

export const ACTION_SOURCE_COBRANCA = "system_generated";

export type CobrancaPaga = {
  /** Id da fatura (in_...) ou, sem fatura, da cobrança (ch_...). Base do event_id e do transaction_id. */
  chave: string;
  valorCentavos: number;
  /** Os planos de fiscal_subscriptions.plano (core.ts, PlanoAssinatura; repetido aqui porque core.ts importa este arquivo). */
  plano: "inicial" | "pro" | "escritorio_5" | "escritorio_20" | "escritorio_50";
  /** O Escritório é só mensal. */
  ciclo: "mensal" | "anual";
};

const NOME_PLANO: Record<CobrancaPaga["plano"], string> = {
  inicial: "Inicial",
  pro: "Pro",
  escritorio_5: "Escritório 5",
  escritorio_20: "Escritório 20",
  escritorio_50: "Escritório 50",
};

export function eventIdDaCobranca(chave: string): string {
  return `nofiscal-purchase-${chave}`;
}

export function idDoProduto(plano: CobrancaPaga["plano"], ciclo: CobrancaPaga["ciclo"]): string {
  return `nofiscal-${plano}-${ciclo}`;
}

/** Corpo de POST /{pixel}/events da cobrança paga. Mesma normalização de corpoDaCompraMeta. */
export async function corpoDaCobrancaMeta(
  c: CobrancaPaga,
  pessoa: { email: string | null; telefone: string | null; tenantId: string },
  navegador: { fbp: string | null; fbc: string | null },
  agora: Date,
  testEventCode?: string,
): Promise<Record<string, unknown>> {
  const userData: Record<string, unknown> = {};
  const email = (pessoa.email || "").trim().toLowerCase();
  if (email) userData.em = [await sha256(email)];
  const fone = (pessoa.telefone || "").replace(/\D/g, "");
  if (fone.length >= 12) userData.ph = [await sha256(fone)];
  userData.external_id = [await sha256(pessoa.tenantId)];
  if (navegador.fbp && FBP.test(navegador.fbp)) userData.fbp = navegador.fbp;
  if (navegador.fbc && FBC.test(navegador.fbc)) userData.fbc = navegador.fbc;
  return {
    data: [{
      event_name: "Purchase",
      event_time: Math.floor(agora.getTime() / 1000),
      event_id: eventIdDaCobranca(c.chave),
      action_source: ACTION_SOURCE_COBRANCA,
      user_data: userData,
      custom_data: {
        value: Math.round(c.valorCentavos) / 100,
        currency: "BRL",
        order_id: c.chave,
        content_ids: [idDoProduto(c.plano, c.ciclo)],
        content_type: "product",
        content_name: `nó.fiscal ${NOME_PLANO[c.plano]}`,
      },
    }],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
}

// GA4 Measurement Protocol: o mesmo caminho de diagnostico-auditor/envios.ts (secret GA4_API_SECRET; sem ele, não
// envia). A propriedade é a do site; GA4_MEASUREMENT_ID só troca o destino (por exemplo, numa propriedade de teste).
export const GA4_ID_PADRAO = "G-1YEB89RVER";
export const GA4_MP = "https://www.google-analytics.com/mp/collect";

/** client_id estável por empresa ("número.número", o formato do cookie _ga): as renovações caem no mesmo usuário. */
export async function clientIdGa4(tenantId: string): Promise<string> {
  const h = await sha256(`nofiscal-ga4:${tenantId}`);
  return `${parseInt(h.slice(0, 8), 16) % 2147483647}.${parseInt(h.slice(8, 16), 16) % 2147483647}`;
}

/** Corpo do /mp/collect: evento purchase; o GA4 deduplica pelo transaction_id. */
export async function corpoDaCobrancaGa4(
  c: CobrancaPaga,
  tenantId: string,
  tipoCompra: "primeira_apos_teste" | "renovacao",
  debug = false,
): Promise<Record<string, unknown>> {
  const valor = Math.round(c.valorCentavos) / 100;
  return {
    client_id: await clientIdGa4(tenantId),
    consent: { ad_user_data: "GRANTED", ad_personalization: "GRANTED" },
    events: [{
      name: "purchase",
      params: {
        transaction_id: c.chave,
        value: valor,
        currency: "BRL",
        plano: c.plano,
        ciclo: c.ciclo,
        tipo_compra: tipoCompra,
        origem: "webhook",
        items: [{
          item_id: idDoProduto(c.plano, c.ciclo),
          item_name: `nó.fiscal ${NOME_PLANO[c.plano]}`,
          item_category: "nofiscal",
          price: valor,
          quantity: 1,
        }],
        ...(debug ? { debug_mode: 1 } : {}),
      },
    }],
  };
}

/** Envia ao GA4 e devolve `ok_<http>`, `erro_<http>` ou `erro_rede`; nunca lança nem loga a URL (tem o secret). */
export async function enviarParaGa4(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  measurementId: string,
  apiSecret: string,
  corpo: Record<string, unknown>,
): Promise<string> {
  try {
    const url = `${GA4_MP}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;
    const res = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
    return res.ok ? `ok_${res.status}` : `erro_${res.status}`;
  } catch {
    return "erro_rede";
  }
}
