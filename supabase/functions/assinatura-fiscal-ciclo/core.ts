// Regras puras do ciclo da assinatura fiscal (sem Deno.*, sem import por URL). Landing de
// .checks/agente-fiscal-v2.md, "`assinatura-fiscal-ciclo` e o job" (lote B): chamado pelo pg_cron a
// cada 15 minutos com x-cron-secret; cancela no Pagar.me as assinaturas com cancelamento agendado
// vencido. O status `cancelada` continua vindo só do aviso subscription.canceled.

import { lerConfig } from "../assinatura-fiscal/core.ts";

type Nivel = "info" | "warn" | "error";

export type Vencida = {
  id: string;
  tenant_id: string;
  pagarme_subscription_id: string;
  cancelamento_agendado_para: string;
};

export type DepsDoCiclo = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Compara o x-cron-secret com o Vault (public.fiscal_ciclo_segredo_ok). */
  segredoOk: (segredo: string) => Promise<boolean>;
  /** public.fiscal_cancelamentos_vencidos. */
  vencidas: (limite: number) => Promise<Vencida[]>;
  log?: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void;
};

export type Resultado = { http: number; body: Record<string, unknown> };

export const LIMITE_POR_RODADA = 50;

export async function processarCiclo(
  req: { metodo: string; segredo: string | null },
  deps: DepsDoCiclo,
): Promise<Resultado> {
  const log = deps.log ?? (() => {});
  if (req.metodo !== "POST") return { http: 405, body: { ok: false, error_code: "METHOD_NOT_ALLOWED" } };
  const segredo = (req.segredo || "").trim();
  if (!segredo || !(await deps.segredoOk(segredo))) {
    return { http: 401, body: { ok: false, error_code: "UNAUTHORIZED" } };
  }

  const config = lerConfig(deps.env);
  if (!config.secretKey || (config.ambiente === "sandbox" && !config.secretKey.startsWith("sk_test_"))) {
    log("error", "assinatura_fiscal_ciclo_config_ausente", { secret: Boolean(config.secretKey) });
    return { http: 500, body: { ok: false, error_code: "CONFIG_AUSENTE" } };
  }
  const headers = { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${config.secretKey}:`)}` };

  const fila = await deps.vencidas(LIMITE_POR_RODADA);
  let canceladas = 0;
  let falhas = 0;
  for (const v of fila) {
    try {
      const res = await deps.fetch(`${config.apiUrl}/subscriptions/${encodeURIComponent(v.pagarme_subscription_id)}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ cancel_pending_invoices: true }),
      });
      if (res.ok) {
        canceladas += 1;
        log("info", "assinatura_fiscal_ciclo_cancelou", {
          tenant_id: v.tenant_id,
          subscription_id: v.pagarme_subscription_id,
          agendado_para: v.cancelamento_agendado_para,
        });
      } else {
        falhas += 1;
        log("error", "assinatura_fiscal_ciclo_falhou", {
          tenant_id: v.tenant_id,
          subscription_id: v.pagarme_subscription_id,
          http_status: res.status,
        });
      }
    } catch {
      falhas += 1;
      log("error", "assinatura_fiscal_ciclo_falhou", {
        tenant_id: v.tenant_id,
        subscription_id: v.pagarme_subscription_id,
        rede: true,
      });
    }
  }
  return { http: 200, body: { ok: true, processadas: fila.length, canceladas, falhas } };
}
