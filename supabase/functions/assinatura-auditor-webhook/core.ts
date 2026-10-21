// Regras puras do webhook de assinatura do Auditor (sem Deno.*, sem import por URL).
// Contrato: CONTRATO.md, secao "Status a partir do webhook".

export type StatusAssinatura = "paga" | "recusada" | "cancelada";

const PAGA = new Set(["invoice.paid", "charge.paid"]);
const RECUSADA = new Set([
  "invoice.payment_failed",
  "charge.payment_failed",
  "subscription.payment_failed",
]);
const CANCELADA = new Set(["subscription.canceled"]);

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
//        -> data.invoice.subscription_id -> data.id quando o tipo comeca com "subscription."
export function idDaAssinatura(tipo: string, data: Record<string, unknown>): string | null {
  const invoice = obj(data.invoice);
  return texto(obj(data.subscription).id)
    ?? texto(data.subscription_id)
    ?? texto(obj(invoice.subscription).id)
    ?? texto(invoice.subscription_id)
    ?? (tipo.startsWith("subscription.") ? texto(data.id) : null);
}

export function mapearEvento(
  tipo: string,
  data: Record<string, unknown>,
): { subscriptionId: string | null; status: StatusAssinatura | null } {
  const t = String(tipo || "").trim();
  return { subscriptionId: idDaAssinatura(t, obj(data)), status: statusDoTipo(t) };
}

// created_at do topo do payload do webhook (hora do aviso no Pagar.me): vai para p_evento_em e decide a
// ordem dos avisos no banco. String ISO valida -> ISO normalizada em UTC; qualquer outra coisa -> null
// (o banco usa a hora do recebimento). Sem fuso no texto, vale UTC.
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

// Payload gravado no banco: so id, tipo, ids e status. Nada de cartao, e-mail, documento ou telefone.
export function envelopeSeguro(
  eventId: string,
  tipo: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
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

// ── Só eventos do auditor (21/10) ──
// A conta do Pagar.me manda os avisos para TODOS os webhooks cadastrados: cobranças do Roteador e de testes
// também chegam aqui (a Frente 1 achou 11 delas, de 19 a 21/10, sem id de assinatura). O webhook do auditor
// só grava eventos de assinaturas do auditor; o resto volta 200, sem gravar nada e sem dado pessoal no log.
// Sinais, em ordem: metadata.origem = "auditor" (o checkout grava) → plan_id de um plano do auditor
// → (no index.ts) id de assinatura já registrado em auditor_assinaturas.

const ORIGEM_AUDITOR = "auditor";

// Nomes dos secrets com os plan_id do auditor (iguais aos de assinatura-auditor/core.ts, PLANOS; o teste confere).
export const PLANOS_AUDITOR = ["PAGARME_PLANO_MENSAL_ID", "PAGARME_PLANO_SEMANAL_ID", "PAGARME_PLANO_AGENCIA_ID"];

function lugares(data: Record<string, unknown>): Record<string, unknown>[] {
  const invoice = obj(data.invoice);
  return [data, obj(data.subscription), invoice, obj(invoice.subscription), obj(obj(data.charge).invoice)];
}

export function temMetadataDoAuditor(data: Record<string, unknown>): boolean {
  return lugares(obj(data)).some((o) => texto(obj(o.metadata).origem) === ORIGEM_AUDITOR);
}

export function planosDoEvento(data: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const o of lugares(obj(data))) {
    for (const v of [obj(o.plan).id, o.plan_id]) {
      const t = texto(v);
      if (t) ids.add(t);
    }
  }
  return [...ids];
}

export type Triagem =
  | { decisao: "auditor"; sinal: "metadata" | "plano" }
  | { decisao: "consultar"; subscriptionId: string }
  | { decisao: "ignorar" };

// Sem metadata nem plano do auditor: só segue se houver id de assinatura para conferir no banco.
export function triarEvento(tipo: string, data: Record<string, unknown>, planosAuditor: string[]): Triagem {
  const d = obj(data);
  if (temMetadataDoAuditor(d)) return { decisao: "auditor", sinal: "metadata" };
  const nossos = new Set(planosAuditor.filter(Boolean));
  if (planosDoEvento(d).some((p) => nossos.has(p))) return { decisao: "auditor", sinal: "plano" };
  const { subscriptionId } = mapearEvento(tipo, d);
  return subscriptionId ? { decisao: "consultar", subscriptionId } : { decisao: "ignorar" };
}
