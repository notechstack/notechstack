// Medição da cobrança paga do nó.fiscal (03/11/2026): a primeira cobrança depois do teste grátis e cada renovação
// viram Purchase na Meta CAPI e purchase no GA4 (Measurement Protocol). Regras puras, sem Deno.* nem import por URL.
//
// Quem decide se mede é public.fiscal_reivindicar_cobranca (migração 20261103130000):
//   - assinatura que não é do fiscal (a conta do Pagar.me tem outros produtos) -> encontrada=false, nada sai;
//   - consentimento do checkout diferente de "granted" (inclusive assinatura anterior à migração) -> nada sai;
//   - cobrança já reivindicada (reentrega, ou invoice.paid + charge.paid do mesmo pagamento) -> nada sai;
//   - cobrança do primeiro ciclo de assinatura sem teste -> já medida no checkout, nada sai.
// event_id determinístico: nofiscal-purchase-<fatura> (ou <cobrança> sem fatura). Mesmo que o banco falhasse em
// segurar a repetição, a Meta descarta o segundo Purchase com o mesmo event_id e o GA4 o mesmo transaction_id.

import {
  type CobrancaPaga,
  corpoDaCobrancaGa4,
  corpoDaCobrancaMeta,
  enviarParaGa4,
  enviarParaMeta,
  GA4_ID_PADRAO,
} from "../assinatura-fiscal/medicao.ts";
import { centavosDoCiclo, lerPlano, planoDeEscritorio } from "../assinatura-fiscal/core.ts";
import type { PagamentoDoAviso } from "./core.ts";

export type Reivindicacao = {
  encontrada?: boolean;
  enviar?: boolean;
  motivo?: string;
  ordem?: number;
  tenant_id?: string;
  plano?: string;
  ciclo?: string;
  com_teste?: boolean;
  email?: string | null;
  telefone?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

export type DepsDaCobranca = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** public.fiscal_reivindicar_cobranca. */
  reivindicar: (args: { p_subscription_id: string; p_chave: string; p_tipo: string }) => Promise<Reivindicacao | null>;
  /** public.fiscal_registrar_resultado_cobranca (só auditoria; falha não importa). */
  registrarResultado?: (args: { p_chave: string; p_meta: string; p_ga4: string }) => Promise<void>;
  agora?: () => Date;
};

const GA4_ID = /^G-[A-Z0-9]{4,20}$/;

export async function medirCobranca(
  args: { subscriptionId: string; tipo: string; pagamento: PagamentoDoAviso },
  deps: DepsDaCobranca,
): Promise<Record<string, unknown>> {
  const { pagamento } = args;
  // Fatura de valor zero (não deveria existir com o teste do plano, mas não é compra) não chega a ser reivindicada.
  if (pagamento.centavos === 0) return { resultado: "valor_zero", chave: pagamento.chave };

  const r = await deps.reivindicar({ p_subscription_id: args.subscriptionId, p_chave: pagamento.chave, p_tipo: args.tipo });
  if (!r?.encontrada) return { resultado: "nao_fiscal" };
  if (!r.enviar) return { resultado: r.motivo || "nao_enviar", chave: pagamento.chave };

  // Escritório (05/11/2026): as faixas também viram compra, sempre no mensal.
  const plano = lerPlano(r.plano);
  const ciclo = r.ciclo === "anual" && !planoDeEscritorio(plano) ? "anual" : "mensal";
  if (!plano || !r.tenant_id) return { resultado: "contexto_invalido", chave: pagamento.chave };

  const cobranca: CobrancaPaga = {
    chave: pagamento.chave,
    valorCentavos: pagamento.centavos ?? centavosDoCiclo(plano, ciclo),
    plano,
    ciclo,
  };
  const tipoCompra = r.com_teste && r.ordem === 1 ? "primeira_apos_teste" : "renovacao";
  const agora = (deps.agora ?? (() => new Date()))();
  const teste = deps.env.META_TEST_EVENT_CODE || undefined;

  let meta = "sem_token";
  const token = deps.env.META_ACCESS_TOKEN || "";
  if (token) {
    try {
      const corpo = await corpoDaCobrancaMeta(
        cobranca,
        { email: r.email ?? null, telefone: r.telefone ?? null, tenantId: r.tenant_id },
        { fbp: r.fbp ?? null, fbc: r.fbc ?? null },
        agora,
        teste,
      );
      meta = await enviarParaMeta(deps.fetch, token, corpo);
    } catch {
      meta = "erro_montagem";
    }
  }

  let ga4 = "sem_secret";
  const secret = deps.env.GA4_API_SECRET || "";
  const idGa4 = (deps.env.GA4_MEASUREMENT_ID || "").trim() || GA4_ID_PADRAO;
  if (secret && GA4_ID.test(idGa4)) {
    try {
      ga4 = await enviarParaGa4(deps.fetch, idGa4, secret, await corpoDaCobrancaGa4(cobranca, r.tenant_id, tipoCompra, Boolean(teste)));
    } catch {
      ga4 = "erro_montagem";
    }
  } else if (secret) {
    ga4 = "measurement_id_invalido";
  }

  if (deps.registrarResultado) {
    try {
      await deps.registrarResultado({ p_chave: pagamento.chave, p_meta: meta, p_ga4: ga4 });
    } catch {
      // só auditoria
    }
  }
  // Log sem dado pessoal: ids do gateway, plano, valor e o resumo de cada envio.
  return {
    resultado: "enviado",
    chave: pagamento.chave,
    plano,
    ciclo,
    tipo_compra: tipoCompra,
    valor_centavos: cobranca.valorCentavos,
    meta,
    ga4,
  };
}
