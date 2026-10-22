// Medição da compra do nó.fiscal (Lucca, 22/10/2026: eventos de compra da LP até a assinatura).
// A resposta do checkout leva o evento (nome, event_id, valor) que o navegador repete no fbq e no dataLayer; com o
// consentimento "granted", o mesmo evento sai também daqui para a Meta CAPI, e a Meta deduplica pelo event_id.
// Sem consentimento, nada sai para a Meta (nem fbp/fbc, nem IP, nem hash de e-mail).
// Política da Meta (mesma de supabase/functions/meta-capi): custom_data só com value, currency e order_id.

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
