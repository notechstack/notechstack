import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log } from "../_shared/logger.ts";
import { processarAviso } from "./core.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  const env = {
    PAGARME_FISCAL_WEBHOOK_USER: Deno.env.get("PAGARME_FISCAL_WEBHOOK_USER"),
    PAGARME_FISCAL_WEBHOOK_PASS: Deno.env.get("PAGARME_FISCAL_WEBHOOK_PASS"),
  };
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  try {
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const resultado = await processarAviso(
      { metodo: request.method, authorization: request.headers.get("Authorization"), body },
      {
        env,
        aplicarEvento: async (args) => {
          if (!supabaseUrl || !serviceKey) throw new Error("config_ausente");
          const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
          const { data, error } = await sb.rpc("fiscal_aplicar_evento_assinatura", args);
          if (error) throw new Error("fiscal_aplicar_evento_assinatura_falhou");
          return data as Record<string, unknown> | null;
        },
        log,
      },
    );
    return json(resultado.http, resultado.body);
  } catch (error) {
    log("error", "assinatura_fiscal_webhook_internal", { error: error instanceof Error ? error.name : "unknown" });
    return json(500, { ok: false, error_code: "INTERNAL" });
  }
});
