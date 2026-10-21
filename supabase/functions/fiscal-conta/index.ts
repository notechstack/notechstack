import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { log } from "../_shared/logger.ts";
import { corsFiscal } from "./cors.ts";
import { type EstadoBanco, processarConta } from "./core.ts";

// Só nomes; os valores ficam com Lucca. Os do Pagar.me são os mesmos do checkout.
const NOMES_ENV = [
  "PAGARME_ASSINATURA_SECRET_KEY",
  "PAGARME_SECRET_KEY",
  "PAGARME_ASSINATURA_API_URL",
  "PAGARME_ASSINATURA_AMBIENTE",
];

const SITE_PADRAO = "https://www.notechstack.com.br";
const LISTA_TTL_MS = 6 * 3600 * 1000;
let listaCache: { codigos: Set<string>; em: number } | null = null;

// Lista nacional publicada pelo site (lote P). Fora do ar ou sem itens: null (só o formato vale).
async function codigosServico(): Promise<Set<string> | null> {
  if (listaCache && Date.now() - listaCache.em < LISTA_TTL_MS) return listaCache.codigos;
  const base = (Deno.env.get("FISCAL_SITE_URL") || SITE_PADRAO).replace(/\/+$/, "");
  const res = await fetch(`${base}/agentes/fiscal/dados/codigos-servico.json`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null) as { itens?: Array<{ codigo?: unknown }> } | null;
  const codigos = new Set(
    (Array.isArray(json?.itens) ? json!.itens : [])
      .map((i) => (typeof i?.codigo === "string" ? i.codigo : ""))
      .filter((c) => /^\d{6}$/.test(c)),
  );
  if (codigos.size === 0) return null;
  listaCache = { codigos, em: Date.now() };
  return codigos;
}

Deno.serve(async (request) => {
  const cors = corsFiscal(request.headers.get("origin"), Deno.env.get("FISCAL_SITE_URL"));
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    log("error", "fiscal_conta_config_ausente", { faltando: "supabase" });
    return json(500, { ok: false, error_code: "CONFIG_AUSENTE", mensagem: "A conta está fora do ar agora. Tente mais tarde." });
  }
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const rpc = async (nome: string, args: Record<string, unknown>) => {
    const { data, error } = await sb.rpc(nome, args);
    if (error) throw new Error(`${nome}_falhou`);
    return data;
  };

  try {
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    const env: Record<string, string | undefined> = {};
    for (const nome of NOMES_ENV) env[nome] = Deno.env.get(nome);
    const resultado = await processarConta(request.method, body, {
      env,
      fetch: (url, init) => fetch(url, init),
      sessao: async () => {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
        if (!token) return null;
        const { data, error } = await sb.auth.getUser(token);
        return error || !data?.user?.id ? null : data.user.id;
      },
      estado: async (userId) => (await rpc("fiscal_conta_estado", { p_user_id: userId })) as EstadoBanco | null,
      configurar: async (userId, dados) => await rpc("fiscal_configurar", { p_user_id: userId, p_dados: dados }),
      trocarPlano: async (userId, plano) => await rpc("fiscal_trocar_plano", { p_user_id: userId, p_plano: plano }),
      agendarCancelamento: async (userId, fimCiclo) =>
        await rpc("fiscal_agendar_cancelamento", { p_user_id: userId, p_fim_ciclo: fimCiclo }),
      apagarConta: async (userId) => await rpc("fiscal_apagar_conta", { p_user_id: userId }),
      codigosServico: () => codigosServico().catch(() => null),
      log,
    });
    return json(resultado.http, resultado.body);
  } catch (error) {
    log("error", "fiscal_conta_internal", { error: error instanceof Error ? error.message : "unknown" });
    return json(500, { ok: false, error_code: "INTERNAL", mensagem: "Algo deu errado do nosso lado. Tente de novo em alguns minutos." });
  }
});
