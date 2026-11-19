// POST assinatura-fiscal-guias: liga (cria a assinatura "nó.fiscal Guias" no Pagar.me) ou desliga o módulo Guias de
// uma conta-mãe de Escritório. Só a equipe da nó: `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`. Secrets: os da
// assinatura-fiscal (PAGARME_ASSINATURA_SECRET_KEY / PAGARME_SECRET_KEY, PAGARME_ASSINATURA_API_URL,
// PAGARME_ASSINATURA_AMBIENTE) e PAGARME_PLANO_FISCAL_GUIAS_ID. Regras em core.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log } from "../_shared/logger.ts";
import type { CupomBanco } from "../assinatura-fiscal/core.ts";
import { autorizadoServico, processarGuias, type ContextoGuias } from "./core.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return json(500, { ok: false, error_code: "CONFIG_AUSENTE" });
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const rpc = async (nome: string, args: Record<string, unknown>) => {
    const { data, error } = await sb.rpc(nome, args);
    if (error) throw new Error(`${nome}_falhou`);
    return data;
  };
  try {
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const resultado = await processarGuias(
      { metodo: request.method, autorizado: await autorizadoServico(request.headers.get("Authorization"), serviceKey), body },
      {
        env: {
          PAGARME_ASSINATURA_SECRET_KEY: Deno.env.get("PAGARME_ASSINATURA_SECRET_KEY"),
          PAGARME_SECRET_KEY: Deno.env.get("PAGARME_SECRET_KEY"),
          PAGARME_ASSINATURA_API_URL: Deno.env.get("PAGARME_ASSINATURA_API_URL"),
          PAGARME_ASSINATURA_AMBIENTE: Deno.env.get("PAGARME_ASSINATURA_AMBIENTE"),
          PAGARME_PLANO_FISCAL_GUIAS_ID: Deno.env.get("PAGARME_PLANO_FISCAL_GUIAS_ID"),
        },
        fetch: (url, init) => fetch(url, init),
        contexto: async (t) => (await rpc("fiscal_guias_contexto", { p_tenant_id: t })) as ContextoGuias,
        reservar: async (t, l) => await rpc("fiscal_guias_reservar", { p_tenant_id: t, p_limite_mes: l }),
        soltar: async (t) => { await rpc("fiscal_guias_soltar", { p_tenant_id: t }); },
        registrar: async (a) =>
          await rpc("fiscal_guias_registrar", {
            p_tenant_id: a.tenantId, p_subscription_id: a.subscriptionId, p_limite_mes: a.limite, p_cupom: a.cupom, p_inicio: a.inicio,
          }),
        ligarModulo: async (t, l) => await rpc("fiscal_definir_modulo_guias", { p_tenant_id: t, p_ligado: true, p_limite_mes: l }),
        desligar: async (t) => await rpc("fiscal_guias_desligar", { p_tenant_id: t }),
        cancelamentoPedido: async (t, s) => { await rpc("fiscal_guias_cancelamento_pedido", { p_tenant_id: t, p_subscription_id: s }); },
        validarCupom: async (t, c) => (await rpc("fiscal_validar_cupom", { p_tenant_id: t, p_codigo: c, p_plano: "guias" })) as CupomBanco,
        log,
      },
    );
    return json(resultado.http, resultado.body);
  } catch (error) {
    log("error", "assinatura_guias_internal", { error: error instanceof Error ? error.message : "unknown" });
    return json(500, { ok: false, error_code: "INTERNAL" });
  }
});
