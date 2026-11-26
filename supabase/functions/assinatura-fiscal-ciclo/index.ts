import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log } from "../_shared/logger.ts";
import { processarCiclo, type Vencida } from "./core.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    log("error", "assinatura_fiscal_ciclo_config_ausente", { faltando: "supabase" });
    return json(500, { ok: false, error_code: "CONFIG_AUSENTE" });
  }
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const rpc = async (nome: string, args: Record<string, unknown>) => {
    const { data, error } = await sb.rpc(nome, args);
    if (error) throw new Error(`${nome}_falhou`);
    return data;
  };

  try {
    const resultado = await processarCiclo(
      { metodo: request.method, segredo: request.headers.get("x-cron-secret") },
      {
        env: {
          PAGARME_ASSINATURA_SECRET_KEY: Deno.env.get("PAGARME_ASSINATURA_SECRET_KEY"),
          PAGARME_SECRET_KEY: Deno.env.get("PAGARME_SECRET_KEY"),
          PAGARME_ASSINATURA_API_URL: Deno.env.get("PAGARME_ASSINATURA_API_URL"),
          PAGARME_ASSINATURA_AMBIENTE: Deno.env.get("PAGARME_ASSINATURA_AMBIENTE"),
        },
        fetch: (url, init) => fetch(url, init),
        segredoOk: async (segredo) => Boolean(await rpc("fiscal_ciclo_segredo_ok", { p_segredo: segredo })),
        vencidas: async (limite) => ((await rpc("fiscal_cancelamentos_vencidos", { p_limite: limite })) || []) as Vencida[],
        // Módulo Guias: a assinatura separada vai junto com a principal e o módulo desligado é cancelado no Pagar.me.
        guiasComPrincipal: async (tenantId) => { await rpc("fiscal_guias_cancelar_com_principal", { p_tenant_id: tenantId }); },
        guiasPendentes: async (limite) =>
          ((await rpc("fiscal_guias_cancelamentos_pendentes", { p_limite: limite })) || []) as { tenant_id: string; pagarme_subscription_id: string }[],
        guiasCancelamentoPedido: async (tenantId, sub) => {
          await rpc("fiscal_guias_cancelamento_pedido", { p_tenant_id: tenantId, p_subscription_id: sub });
        },
        log,
      },
    );
    return json(resultado.http, resultado.body);
  } catch (error) {
    log("error", "assinatura_fiscal_ciclo_internal", { error: error instanceof Error ? error.message : "unknown" });
    return json(500, { ok: false, error_code: "INTERNAL" });
  }
});
