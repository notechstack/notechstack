import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handlePreflight } from "../_shared/cors.ts";
import { log } from "../_shared/logger.ts";
import { lerConfig, processarCheckout, respostaGet } from "./core.ts";

// Variaveis do CONTRATO.md (so nomes; valores ficam com Lucca).
const NOMES_ENV = [
  "PAGARME_ASSINATURA_SECRET_KEY",
  "PAGARME_SECRET_KEY",
  "PAGARME_ASSINATURA_PUBLIC_KEY",
  "PAGARME_ASSINATURA_API_URL",
  "PAGARME_ASSINATURA_AMBIENTE",
  "PAGARME_PLANO_MENSAL_ID",
  "PAGARME_PLANO_SEMANAL_ID",
  "PAGARME_PLANO_AGENCIA_ID",
  "AUDITOR_VENDA_ABERTA",
  "AUDITOR_MEDICAO_CHECKOUT",
];

// Excecao so local: em sandbox, a pagina servida em localhost/127.0.0.1 pode chamar a funcao.
const ORIGEM_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function lerEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const nome of NOMES_ENV) env[nome] = Deno.env.get(nome);
  return env;
}

function origemLocal(origin: string | null, ambiente: string): string | null {
  return ambiente === "sandbox" && origin && ORIGEM_LOCAL.test(origin) ? origin : null;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  const env = lerEnv();
  const config = lerConfig(env);
  const local = origemLocal(origin, config.ambiente);

  const preflight = handlePreflight(request);
  if (preflight) {
    // Sem isso o preflight do POST em localhost falharia e a excecao local nao serviria.
    if (local) preflight.headers.set("Access-Control-Allow-Origin", local);
    return preflight;
  }

  const headers: Record<string, string> = { ...corsHeaders(origin), "Content-Type": "application/json" };
  if (local) headers["Access-Control-Allow-Origin"] = local;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

  if (request.method === "GET") return json(200, respostaGet(config));
  if (request.method !== "POST") {
    return json(405, { ok: false, error_code: "METHOD_NOT_ALLOWED", mensagem: "Método não permitido." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  // Checado antes de chamar o Pagar.me: sem banco nao se cria assinatura que depois teria de ser desfeita.
  if (config.vendaAberta && (!supabaseUrl || !serviceKey)) {
    log("error", "assinatura_auditor_config_ausente", { faltando: "supabase" });
    return json(500, {
      ok: false,
      error_code: "CONFIG_AUSENTE",
      mensagem: "O pagamento está fora do ar agora. Nada foi cobrado; tente mais tarde.",
    });
  }

  try {
    const body = await request.json().catch(() => null);
    const resultado = await processarCheckout(body, {
      env,
      fetch: (url, init) => fetch(url, init),
      registrar: async (row) => {
        const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
        const { data, error } = await sb.rpc("registrar_assinatura_auditor", {
          p_plano: row.plano,
          p_nome: row.nome,
          p_email: row.email,
          p_whatsapp: row.whatsapp,
          p_customer_id: row.customer_id,
          p_subscription_id: row.subscription_id,
          p_status: row.status,
          p_aceite_texto: row.aceite_texto,
        });
        if (error || !data?.id) throw new Error("registrar_assinatura_auditor_falhou");
        // Log sem dado pessoal: so plano, ids do gateway e resultado.
        log("info", "assinatura_auditor_registrada", {
          plano: row.plano,
          subscription_id: row.subscription_id,
          status: data.status,
          reconciliada: Boolean(data.reconciliada),
        });
        return { id: String(data.id), status: String(data.status) };
      },
      log,
    });
    return json(resultado.http, resultado.body);
  } catch (error) {
    log("error", "assinatura_auditor_internal", { error: error instanceof Error ? error.name : "unknown" });
    return json(500, {
      ok: false,
      error_code: "INTERNAL",
      mensagem: "Algo deu errado do nosso lado. Tente de novo em alguns minutos.",
    });
  }
});
