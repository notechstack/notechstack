// Regras puras do webhook da assinatura do Agente Fiscal (sem Deno.*, sem import por URL).
// Landing de .checks/agente-fiscal-whatsapp.md, "Webhook da assinatura fiscal" (lote C). Molde:
// assinatura-auditor-webhook/core.ts. A ordem dos avisos, a idempotência e o "cancelada é final"
// vivem em public.fiscal_aplicar_evento_assinatura (lote A); aqui só se traduz o aviso.

export type StatusAssinatura = "paga" | "recusada" | "cancelada";
type Nivel = "info" | "warn" | "error";

// Só eventos da lista oficial (docs.pagar.me, "Eventos de webhook").
const PAGA = new Set(["invoice.paid", "charge.paid"]);
const RECUSADA = new Set(["invoice.payment_failed", "charge.payment_failed"]);
const CANCELADA = new Set(["subscription.canceled"]);

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function texto(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const limpo = String(value).trim();
  return limpo ? limpo : null;
}

export function statusDoTipo(tipo: string): StatusAssinatura | null {
  if (PAGA.has(tipo)) return "paga";
  if (RECUSADA.has(tipo)) return "recusada";
  if (CANCELADA.has(tipo)) return "cancelada";
  return null;
}

// Ordem: data.subscription.id -> data.subscription_id -> data.invoice.subscription.id
//        -> data.invoice.subscription_id -> data.id quando o tipo começa com "subscription."
export function idDaAssinatura(tipo: string, data: Record<string, unknown>): string | null {
  const invoice = obj(data.invoice);
  return texto(obj(data.subscription).id) ??
    texto(data.subscription_id) ??
    texto(obj(invoice.subscription).id) ??
    texto(invoice.subscription_id) ??
    (tipo.startsWith("subscription.") ? texto(data.id) : null);
}

export function mapearEvento(tipo: string, data: Record<string, unknown>) {
  const t = String(tipo || "").trim();
  return { subscriptionId: idDaAssinatura(t, obj(data)), status: statusDoTipo(t) };
}

// created_at do topo do aviso: decide a ordem no banco. ISO válida -> ISO em UTC (sem fuso, UTC);
// qualquer outra coisa -> null (o banco usa a hora do recebimento).
const ISO_DATA_HORA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/i;

export function eventoEmDoPayload(body: unknown): string | null {
  const bruto = obj(body).created_at;
  if (typeof bruto !== "string") return null;
  const limpo = bruto.trim();
  if (!ISO_DATA_HORA.test(limpo)) return null;
  const comFuso = /(Z|[+-]\d{2}:\d{2})$/i.test(limpo) ? limpo : `${limpo}Z`;
  const ms = Date.parse(comFuso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// Payload gravado: só ids, tipo e status. Nada de cartão, e-mail, documento ou telefone.
export function envelopeSeguro(eventId: string, tipo: string, data: Record<string, unknown>): Record<string, unknown> {
  const d = obj(data);
  const invoice = obj(d.invoice);
  const charge = obj(d.charge);
  const { subscriptionId, status } = mapearEvento(tipo, d);
  return {
    id: eventId,
    type: tipo,
    data: {
      id: texto(d.id),
      status: texto(d.status),
      subscription_id: subscriptionId,
      invoice_id: texto(invoice.id) ?? (tipo.startsWith("invoice.") ? texto(d.id) : null),
      invoice_status: texto(invoice.status) ?? (tipo.startsWith("invoice.") ? texto(d.status) : null),
      charge_id: texto(charge.id) ?? (tipo.startsWith("charge.") ? texto(d.id) : null),
      charge_status: texto(charge.status) ?? (tipo.startsWith("charge.") ? texto(d.status) : null),
      customer_id: texto(obj(d.customer).id) ?? texto(d.customer_id),
    },
    status_aplicado: status,
  };
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function iguaisEmTempoConstante(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diferenca = 0;
  for (let i = 0; i < x.length; i += 1) diferenca |= x[i] ^ y[i];
  return diferenca === 0;
}

export async function autorizado(authorization: string | null, env: Record<string, string | undefined>): Promise<boolean> {
  const user = env.PAGARME_FISCAL_WEBHOOK_USER || "";
  const pass = env.PAGARME_FISCAL_WEBHOOK_PASS || "";
  const confere = await iguaisEmTempoConstante(authorization || "", `Basic ${btoa(`${user}:${pass}`)}`);
  return Boolean(user && pass && confere);
}

// Cobrança paga do aviso (Purchase da cobrança depois do teste e das renovações; compra.ts). O Pagar.me manda
// invoice.paid e charge.paid para o mesmo pagamento: a chave é a fatura nos dois (charge.paid traz data.invoice);
// charge.paid sem fatura não é medido. Valor em centavos: o pago da cobrança, senão o da fatura;
// null quando o aviso não traz (compra.ts usa o preço do plano).
export type PagamentoDoAviso = { chave: string; centavos: number | null };

function centavos(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function pagamentoDoAviso(tipo: string, data: Record<string, unknown>): PagamentoDoAviso | null {
  const t = String(tipo || "").trim();
  if (statusDoTipo(t) !== "paga") return null;
  const d = obj(data);
  if (t.startsWith("invoice.")) {
    const charge = obj(d.charge);
    const chave = texto(d.id) ?? texto(charge.id);
    return chave ? { chave, centavos: centavos(charge.paid_amount) ?? centavos(d.amount) ?? centavos(charge.amount) } : null;
  }
  // charge.paid só mede quando traz a fatura: sem ela a chave seria ch_… e o invoice.paid do mesmo pagamento
  // (chave in_…) viraria um segundo Purchase. Cobrança de assinatura sempre tem fatura; o invoice.paid cobre.
  const chave = texto(obj(d.invoice).id) ?? texto(d.invoice_id);
  return chave ? { chave, centavos: centavos(d.paid_amount) ?? centavos(d.amount) } : null;
}

/** Argumentos de public.fiscal_aplicar_evento_assinatura. */
export type ArgsDoEvento = {
  p_gateway_event_id: string;
  p_tipo: string;
  p_subscription_id: string | null;
  p_status: StatusAssinatura | null;
  p_payload: Record<string, unknown>;
  p_evento_em: string | null;
};

export type DepsDoAviso = {
  env: Record<string, string | undefined>;
  aplicarEvento: (args: ArgsDoEvento) => Promise<Record<string, unknown> | null>;
  log?: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void;
  /** Medição da cobrança paga (compra.ts). Devolve o resumo para o log; nunca muda a resposta ao Pagar.me. */
  medirCobranca?: (args: { subscriptionId: string; tipo: string; pagamento: PagamentoDoAviso }) => Promise<Record<string, unknown>>;
};

export type Resultado = { http: number; body: Record<string, unknown> };

export async function processarAviso(
  req: { metodo: string; authorization: string | null; body: unknown },
  deps: DepsDoAviso,
): Promise<Resultado> {
  const log = deps.log ?? (() => {});
  if (req.metodo !== "POST") return { http: 405, body: { ok: false, error_code: "METHOD_NOT_ALLOWED" } };
  if (!(await autorizado(req.authorization, deps.env))) return { http: 401, body: { ok: false, error_code: "UNAUTHORIZED" } };

  const body = obj(req.body);
  const eventId = String(body.id ?? "").trim();
  const tipo = String(body.type ?? "").trim();
  const data = obj(body.data);
  if (!eventId || !tipo) return { http: 400, body: { ok: false, error_code: "EVENTO_INVALIDO" } };

  const { subscriptionId, status } = mapearEvento(tipo, data);
  const eventoEm = eventoEmDoPayload(body);
  let result: Record<string, unknown> | null;
  try {
    result = await deps.aplicarEvento({
      p_gateway_event_id: eventId,
      p_tipo: tipo,
      p_subscription_id: subscriptionId,
      p_status: status,
      p_payload: envelopeSeguro(eventId, tipo, data),
      p_evento_em: eventoEm,
    });
  } catch {
    log("error", "assinatura_fiscal_webhook_rpc_failed", { gateway_event_id: eventId, tipo });
    return { http: 500, body: { ok: false, error_code: "EVENTO_FALHOU" } };
  }

  // Log sem dado pessoal: só ids do gateway, tipo e resultado.
  log("info", "assinatura_fiscal_webhook_processed", {
    gateway_event_id: eventId,
    tipo,
    subscription_id: subscriptionId,
    status,
    evento_em: eventoEm,
    applied: Boolean(result?.applied),
    duplicado: Boolean(result?.duplicado),
    encontrada: result?.encontrada ?? null,
    ignorado: result?.ignorado ?? null,
  });
  // Cobrança paga: Purchase (e purchase no GA4) com o consentimento gravado no checkout. Aviso repetido não mede de
  // novo (duplicado aqui, e a chave da cobrança no banco segura invoice.paid + charge.paid do mesmo pagamento).
  // "fora_de_ordem" e "cancelada_final" só dizem respeito ao status: a cobrança foi paga do mesmo jeito.
  const pagamento = pagamentoDoAviso(tipo, data);
  if (pagamento && subscriptionId && deps.medirCobranca && !result?.duplicado) {
    try {
      const medida = await deps.medirCobranca({ subscriptionId, tipo, pagamento });
      log("info", "assinatura_fiscal_webhook_cobranca", { gateway_event_id: eventId, subscription_id: subscriptionId, ...medida });
    } catch {
      log("error", "assinatura_fiscal_webhook_cobranca", { gateway_event_id: eventId, subscription_id: subscriptionId, resultado: "erro" });
    }
  }
  // 200 também para repetido e tipo desconhecido: o Pagar.me não precisa reenviar.
  return { http: 200, body: { ok: true, ...(result || {}) } };
}
