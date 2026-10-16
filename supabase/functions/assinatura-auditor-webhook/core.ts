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
