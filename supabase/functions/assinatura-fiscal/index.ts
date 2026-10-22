import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsFiscal } from "../_shared/fiscal/cors.ts";
import { log } from "../_shared/logger.ts";
import {
  type Contexto,
  type CupomBanco,
  type Deps,
  processarCheckout,
  processarValidarCupom,
  responderConfiguracao,
} from "./core.ts";
import { enviarParaMeta } from "./medicao.ts";

// Só nomes (variaveis-ambiente.txt); os valores ficam com Lucca.
const NOMES_ENV = [
  "PAGARME_ASSINATURA_SECRET_KEY",
  "PAGARME_ASSINATURA_PUBLIC_KEY",
  "PAGARME_SECRET_KEY",
  "PAGARME_ASSINATURA_API_URL",
  "PAGARME_ASSINATURA_AMBIENTE",
  "PAGARME_PLANO_FISCAL_INICIAL_ID",
  "PAGARME_PLANO_FISCAL_PRO_ID",
  "PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID",
  "PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID",
  "FISCAL_VENDA_ABERTA",
  "FISCAL_TRIAL_SALT",
  // Só em teste: manda a compra para a aba "Testar eventos" do Events Manager.
  "META_TEST_EVENT_CODE",
];

function lerEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const nome of NOMES_ENV) env[nome] = Deno.env.get(nome);
  return env;
}

Deno.serve(async (request) => {
  const cors = corsFiscal(request.headers.get("origin"), (k) => Deno.env.get(k));
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const headers: Record<string, string> = { ...cors, "Content-Type": "application/json" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  // Configuração pública da etapa de pagamento (sem sessão).
  if (request.method === "GET") {
    const r = responderConfiguracao(lerEnv());
    return json(r.http, r.body);
  }
  if (request.method !== "POST") {
    return json(405, { ok: false, error_code: "METHOD_NOT_ALLOWED", mensagem: "Método não permitido." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  // Checado antes de chamar o Pagar.me: sem banco não se cria assinatura que depois teria de ser desfeita.
  if (!supabaseUrl || !serviceKey) {
    log("error", "assinatura_fiscal_config_ausente", { faltando: "supabase" });
    return json(500, {
      ok: false,
      error_code: "CONFIG_AUSENTE",
      mensagem: "O pagamento está fora do ar agora. Nada foi cobrado; tente mais tarde.",
    });
  }
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const rpc = async (nome: string, args: Record<string, unknown>) => {
    const { data, error } = await sb.rpc(nome, args);
    if (error) throw new Error(`${nome}_falhou`);
    return data;
  };

  try {
    const body = await request.json().catch(() => null);
    const metaToken = Deno.env.get("META_ACCESS_TOKEN") || "";
    const deps: Deps = {
      env: lerEnv(),
      fetch: (url, init) => fetch(url, init),
      sessao: async () => {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (!token) return null;
        const { data, error } = await sb.auth.getUser(token);
        return error || !data?.user?.id ? null : data.user.id;
      },
      contexto: async (userId) => (await rpc("fiscal_assinatura_contexto", { p_user_id: userId })) as Contexto | null,
      reivindicarTeste: async (tenantId, hashes) =>
        Boolean(await rpc("fiscal_reivindicar_teste", { p_tenant_id: tenantId, p_hashes: hashes })),
      registrar: async (l) => {
        const data = await rpc("fiscal_registrar_assinatura", {
          p_tenant_id: l.tenant_id,
          p_plano: l.plano,
          p_com_teste: l.com_teste,
          p_trial_ends_at: l.trial_ends_at,
          p_customer_id: l.customer_id,
          p_subscription_id: l.subscription_id,
          p_status: l.status,
          p_aceite_texto: l.aceite_texto,
        }) as { id?: string; status?: string; reconciliada?: boolean } | null;
        if (!data?.id) throw new Error("fiscal_registrar_assinatura_sem_id");
        log("info", "assinatura_fiscal_registrada", {
          plano: l.plano,
          com_teste: l.com_teste,
          subscription_id: l.subscription_id,
          status: data.status,
          reconciliada: Boolean(data.reconciliada),
        });
        return { id: String(data.id), status: String(data.status) };
      },
      marcarPago: async (tenantId) => {
        await rpc("fiscal_marcar_pago", { p_tenant_id: tenantId });
      },
      validarCupom: async (tenantId, codigo, plano) =>
        (await rpc("fiscal_validar_cupom", { p_tenant_id: tenantId, p_codigo: codigo, p_plano: plano })) as CupomBanco,
      registrarCortesia: async (tenantId, plano, codigo, aceite) =>
        (await rpc("fiscal_registrar_cortesia", {
          p_tenant_id: tenantId,
          p_plano: plano,
          p_codigo: codigo,
          p_aceite_texto: aceite,
        })) as CupomBanco,
      usarCupom: async (tenantId, codigo, plano, subscriptionId) =>
        (await rpc("fiscal_usar_cupom", {
          p_tenant_id: tenantId,
          p_codigo: codigo,
          p_plano: plano,
          p_subscription_id: subscriptionId,
        })) as CupomBanco,
      log,
      // Meta CAPI da compra: o mesmo segredo de meta-capi e pagarme-webhook-no. Sem ele, nada sai.
      enviarMeta: metaToken ? (corpo) => enviarParaMeta((url, init) => fetch(url, init), metaToken, corpo) : undefined,
      cliente: {
        ip: (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null,
        ua: request.headers.get("user-agent"),
      },
    };
    // A prévia do cupom (etapa de pagamento) usa a mesma rota, com acao.
    const acao = body && typeof body === "object" ? (body as Record<string, unknown>).acao : undefined;
    const resultado = acao === "validar_cupom" ? await processarValidarCupom(body, deps) : await processarCheckout(body, deps);
    return json(resultado.http, resultado.body);
  } catch (error) {
    log("error", "assinatura_fiscal_internal", { error: error instanceof Error ? error.message : "unknown" });
    return json(500, {
      ok: false,
      error_code: "INTERNAL",
      mensagem: "Algo deu errado do nosso lado. Tente de novo em alguns minutos.",
    });
  }
});
