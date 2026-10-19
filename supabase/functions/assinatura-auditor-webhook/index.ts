import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log } from "../_shared/logger.ts";
import { envelopeSeguro, eventoEmDoPayload, mapearEvento } from "./core.ts";

const json = (status: number, body: unknown) => new Response(
  JSON.stringify(body),
  { status, headers: { "Content-Type": "application/json" } },
);

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function authorized(request: Request): Promise<boolean> {
  const user = Deno.env.get("PAGARME_ASSINATURA_WEBHOOK_USER") || "";
  const pass = Deno.env.get("PAGARME_ASSINATURA_WEBHOOK_PASS") || "";
  const supplied = request.headers.get("Authorization") || "";
  const expected = `Basic ${btoa(`${user}:${pass}`)}`;
  const matches = await constantTimeEqual(supplied, expected);
  return Boolean(user && pass && matches);
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(405, { ok: false, error_code: "METHOD_NOT_ALLOWED" });
  if (!(await authorized(request))) return json(401, { ok: false, error_code: "UNAUTHORIZED" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return json(500, { ok: false, error_code: "CONFIG_AUSENTE" });

  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const eventId = String(body?.id ?? "").trim();
    const tipo = String(body?.type ?? "").trim();
    const data = body?.data && typeof body.data === "object" ? body.data as Record<string, unknown> : {};
    if (!eventId || !tipo) return json(400, { ok: false, error_code: "EVENTO_INVALIDO" });

    const { subscriptionId, status } = mapearEvento(tipo, data);
    // created_at do aviso no Pagar.me: o banco usa para ignorar aviso fora de ordem (achado F-01).
    const eventoEm = eventoEmDoPayload(body);
    const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: result, error } = await sb.rpc("aplicar_evento_assinatura_auditor", {
      p_gateway_event_id: eventId,
      p_tipo: tipo,
      p_subscription_id: subscriptionId,
      p_status: status,
      p_payload: envelopeSeguro(eventId, tipo, data),
      p_evento_em: eventoEm,
    });
    if (error) {
      log("error", "assinatura_auditor_webhook_rpc_failed", { gateway_event_id: eventId, tipo });
      return json(500, { ok: false, error_code: "EVENTO_FALHOU" });
    }

    // Log sem dado pessoal: so ids do gateway, tipo e resultado.
    log("info", "assinatura_auditor_webhook_processed", {
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
    // 200 tambem para duplicado e tipo desconhecido: o Pagar.me nao precisa reenviar.
    return json(200, { ok: true, ...(result || {}) });
  } catch (error) {
    log("error", "assinatura_auditor_webhook_internal", { error: error instanceof Error ? error.name : "unknown" });
    return json(500, { ok: false, error_code: "INTERNAL" });
  }
});
