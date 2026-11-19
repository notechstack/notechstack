// Regras puras da assinatura "nó.fiscal Guias" (sem Deno.*, sem import por URL). Molde: assinatura-fiscal/core.ts.
// O módulo Guias é cobrado numa segunda assinatura no Pagar.me, no mesmo cliente e cartão da principal do Escritório,
// começando na próxima cobrança dela (o painel do Pagar.me não deixa incluir item na principal). Só a nó liga: a rota
// exige a service role (index.ts confere com autorizadoServico).
//
// POST {acao: 'ligar', tenant_id, limite_mes?, cupom?}: lê a principal no Pagar.me (GET /subscriptions/{id}), pega o
//   cliente e o cartão salvos, cria a Guias (POST /subscriptions com customer_id, card_id, start_at = próxima cobrança
//   da principal, discounts do cupom e metadata {produto: 'guias', tenant_id}), grava o id em fiscal_addons e liga o
//   módulo. Principal que não está active/future, ou sem cartão: recusa sem ligar nada. Chamar de novo não cria outra
//   (reserva no banco + Idempotency-Key no Pagar.me).
// POST {acao: 'desligar', tenant_id}: desliga o módulo e cancela a Guias no Pagar.me (DELETE /subscriptions/{id}); se
//   o Pagar.me falhar, a marca cancelar_no_gateway fica e o assinatura-fiscal-ciclo cancela na próxima rodada.
import { descontoPagarme, lerCodigoCupom, lerConfig, valorComDesconto, type CupomBanco, type CupomValido } from "../assinatura-fiscal/core.ts";

type Nivel = "info" | "warn" | "error";

export const PLANO_GUIAS = {
  nome: "nó.fiscal Guias",
  centavos: 19700,
  env: "PAGARME_PLANO_FISCAL_GUIAS_ID",
  fatura: "NOFISCALGUIAS",
} as const;

export const LIMITE_PADRAO = 500;

/** Corpo de POST /plans do plano "nó.fiscal Guias": mensal, R$ 197,00, sem teste, fatura NOFISCALGUIAS. */
export function corpoDoPlanoGuias(): Record<string, unknown> {
  return {
    name: PLANO_GUIAS.nome,
    description: `Assinatura ${PLANO_GUIAS.nome} · nó tech stack`,
    interval: "month",
    interval_count: 1,
    billing_type: "prepaid",
    payment_methods: ["credit_card"],
    installments: [1],
    currency: "BRL",
    statement_descriptor: PLANO_GUIAS.fatura,
    items: [{ name: PLANO_GUIAS.nome, quantity: 1, pricing_scheme: { scheme_type: "unit", price: PLANO_GUIAS.centavos } }],
    metadata: { origem: "agente-fiscal", codigo: "guias", produto: "guias" },
  };
}

export type ContextoGuias = {
  ok: boolean;
  erro?: string;
  tenant_id?: string;
  razao_social?: string;
  principal: { pagarme_subscription_id: string; status: string; origem: string } | null;
  guias: { status: string; limite_mes: number; pagarme_subscription_id: string | null; pagarme_status: string | null } | null;
};

export type DepsGuias = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  contexto: (tenantId: string) => Promise<ContextoGuias>;
  reservar: (tenantId: string, limite: number) => Promise<{ ok: boolean; erro?: string; reservado?: boolean; geracao?: number; pagarme_subscription_id?: string }>;
  soltar: (tenantId: string) => Promise<void>;
  registrar: (a: { tenantId: string; subscriptionId: string; limite: number; cupom: string | null; inicio: string | null }) => Promise<Record<string, unknown>>;
  ligarModulo: (tenantId: string, limite: number) => Promise<Record<string, unknown>>;
  desligar: (tenantId: string) => Promise<{ ok: boolean; erro?: string; cancelar?: string | null }>;
  cancelamentoPedido: (tenantId: string, subscriptionId: string) => Promise<void>;
  validarCupom: (tenantId: string, codigo: string) => Promise<CupomBanco>;
  agora?: () => Date;
  log?: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void;
};

export type Resultado = { http: number; body: Record<string, unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function texto(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function erro(http: number, error_code: string, mensagem: string, extra: Record<string, unknown> = {}): Resultado {
  return { http, body: { ok: false, error_code, mensagem, ...extra } };
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/** `Authorization: Bearer <service role>` em tempo constante. Sem chave configurada, nega. */
export async function autorizadoServico(authorization: string | null, chave: string | undefined): Promise<boolean> {
  if (!chave) return false;
  const [x, y] = await Promise.all([digest(authorization || ""), digest(`Bearer ${chave}`)]);
  let diferenca = 0;
  for (let i = 0; i < x.length; i += 1) diferenca |= x[i] ^ y[i];
  return diferenca === 0;
}

/** O que a principal do Pagar.me precisa ter para a Guias nascer nela. */
export type Principal = { status: string; customerId: string | null; cardId: string | null; proximaCobranca: string | null };

export function lerPrincipal(json: unknown): Principal {
  const s = obj(json);
  const card = obj(s.card);
  const cardAtivo = texto(card.id) && (!texto(card.status) || card.status === "active");
  return {
    status: texto(s.status) ?? "",
    customerId: texto(obj(s.customer).id) ?? texto(s.customer_id),
    cardId: cardAtivo ? texto(card.id) : null,
    // Assinatura em teste ("future"): a primeira cobrança é o fim do teste (start_at); senão next_billing_at.
    proximaCobranca: texto(s.next_billing_at) ?? (s.status === "future" ? texto(s.start_at) : null),
  };
}

/** Corpo de POST /subscriptions da Guias. `inicio` no futuro vira start_at; no passado, começa já. */
export function corpoAssinaturaGuias(a: {
  planId: string;
  tenantId: string;
  limite: number;
  principal: Principal;
  cupom: CupomValido | null;
  agora: Date;
}): Record<string, unknown> {
  const inicio = a.principal.proximaCobranca && Date.parse(a.principal.proximaCobranca) > a.agora.getTime()
    ? new Date(Date.parse(a.principal.proximaCobranca)).toISOString()
    : null;
  return {
    plan_id: a.planId,
    customer_id: a.principal.customerId,
    card_id: a.principal.cardId,
    payment_method: "credit_card",
    ...(inicio ? { start_at: inicio } : {}),
    ...(a.cupom ? { discounts: [descontoPagarme(a.cupom)] } : {}),
    metadata: {
      origem: "agente-fiscal",
      produto: "guias",
      tenant_id: a.tenantId,
      limite_mes: a.limite,
      ...(a.cupom ? { cupom: a.cupom.codigo } : {}),
    },
  };
}

export async function processarGuias(req: { metodo: string; autorizado: boolean; body: unknown }, deps: DepsGuias): Promise<Resultado> {
  const log = deps.log ?? (() => {});
  if (req.metodo !== "POST") return erro(405, "METHOD_NOT_ALLOWED", "use POST");
  if (!req.autorizado) return erro(401, "UNAUTHORIZED", "só a equipe da nó (service role)");
  const b = obj(req.body);
  const tenantId = texto(b.tenant_id);
  if (!tenantId || !UUID.test(tenantId)) return erro(422, "DADOS_INVALIDOS", "tenant_id (conta-mãe do escritório) inválido");
  if (b.acao === "desligar") return desligar(tenantId, deps, log);
  if (b.acao !== "ligar") return erro(422, "ACAO_DESCONHECIDA", "acao: ligar ou desligar");

  const limite = b.limite_mes === undefined || b.limite_mes === null ? LIMITE_PADRAO : Number(b.limite_mes);
  if (!Number.isInteger(limite) || limite < 1 || limite > 100000) return erro(422, "DADOS_INVALIDOS", "limite_mes entre 1 e 100000");
  const codigo = lerCodigoCupom(b.cupom);
  if (codigo === false) return erro(422, "CUPOM_INVALIDO", "cupom fora do formato");

  const config = lerConfig(deps.env);
  const planId = deps.env[PLANO_GUIAS.env] || "";
  if (!config.secretKey || !planId || (config.ambiente === "sandbox" && !config.secretKey.startsWith("sk_test_"))) {
    log("error", "assinatura_guias_config_ausente", { secret: Boolean(config.secretKey), plano: Boolean(planId) });
    return erro(500, "CONFIG_AUSENTE", `falta a chave do Pagar.me ou ${PLANO_GUIAS.env}`);
  }
  const headers = { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${config.secretKey}:`)}` };

  const ctx = await deps.contexto(tenantId);
  if (!ctx.ok) return erro(422, ctx.erro || "CONTA_INVALIDA", "a conta não é conta-mãe de Escritório");
  const principalBanco = ctx.principal;
  if (!principalBanco || principalBanco.origem !== "pagarme" || principalBanco.status === "cancelada") {
    return erro(409, "SEM_ASSINATURA_PRINCIPAL", "a conta não tem assinatura principal ativa no Pagar.me");
  }

  // Cupom antes de qualquer reserva ou chamada ao Pagar.me.
  let cupom: CupomValido | null = null;
  if (codigo) {
    const r = await deps.validarCupom(tenantId, codigo);
    if (!r || !r.ok || (r.tipo !== "percentual" && r.tipo !== "valor") || typeof r.valor !== "number" || r.cortesia) {
      return erro(422, r?.motivo || "CUPOM_INVALIDO", "cupom não vale para o módulo Guias");
    }
    cupom = { codigo: r.codigo || codigo, descricao: r.descricao ?? null, tipo: r.tipo, valor: r.valor, cortesia: false, ciclos: typeof r.ciclos === "number" ? r.ciclos : null, diasDeTeste: null };
    if (valorComDesconto(PLANO_GUIAS.centavos, cupom) < 100) return erro(422, "CUPOM_PLANO", "o cupom zeraria a mensalidade");
  }

  const reserva = await deps.reservar(tenantId, limite);
  if (!reserva.ok) return erro(409, reserva.erro || "CRIACAO_EM_ANDAMENTO", "outra chamada está criando a assinatura Guias agora");
  if (!reserva.reservado) {
    // Já existe: só garante o módulo ligado (idempotente), sem nova assinatura.
    await deps.ligarModulo(tenantId, limite);
    log("info", "assinatura_guias_ja_existia", { tenant_id: tenantId, subscription_id: reserva.pagarme_subscription_id });
    return { http: 200, body: { ok: true, ja_existia: true, pagarme_subscription_id: reserva.pagarme_subscription_id } };
  }

  let principal: Principal;
  try {
    const res = await deps.fetch(`${config.apiUrl}/subscriptions/${encodeURIComponent(principalBanco.pagarme_subscription_id)}`, { method: "GET", headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    principal = lerPrincipal(await res.json());
  } catch {
    await deps.soltar(tenantId);
    return erro(502, "PAGARME_INDISPONIVEL", "não consegui ler a assinatura principal no Pagar.me");
  }
  if (principal.status !== "active" && principal.status !== "future") {
    await deps.soltar(tenantId);
    return erro(409, "PRINCIPAL_INATIVA", `a assinatura principal está "${principal.status || "?"}" no Pagar.me`);
  }
  if (!principal.cardId || !principal.customerId) {
    await deps.soltar(tenantId);
    return erro(409, "SEM_CARTAO", "a assinatura principal não tem cartão ativo salvo");
  }

  const agora = (deps.agora ?? (() => new Date()))();
  const corpo = corpoAssinaturaGuias({ planId, tenantId, limite, principal, cupom, agora });
  let subscriptionId: string;
  try {
    const res = await deps.fetch(`${config.apiUrl}/subscriptions`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": `nofiscal-guias-${tenantId}-${reserva.geracao ?? 0}` },
      body: JSON.stringify(corpo),
    });
    const json = obj(await res.json().catch(() => null));
    const id = texto(json.id);
    if (!res.ok || !id) throw new Error(`HTTP ${res.status}`);
    subscriptionId = id;
  } catch {
    await deps.soltar(tenantId);
    log("error", "assinatura_guias_criar_falhou", { tenant_id: tenantId });
    return erro(502, "PAGARME_FALHOU", "o Pagar.me não criou a assinatura Guias");
  }

  const inicio = typeof corpo.start_at === "string" ? corpo.start_at : null;
  const registro = await deps.registrar({ tenantId, subscriptionId, limite, cupom: cupom?.codigo ?? null, inicio });
  log("info", "assinatura_guias_criada", { tenant_id: tenantId, subscription_id: subscriptionId, inicio, cupom: cupom?.codigo ?? null });
  return {
    http: 201,
    body: {
      ok: true,
      pagarme_subscription_id: subscriptionId,
      inicio,
      valor_centavos: PLANO_GUIAS.centavos,
      valor_com_desconto_centavos: cupom ? valorComDesconto(PLANO_GUIAS.centavos, cupom) : PLANO_GUIAS.centavos,
      desconto_ciclos: cupom?.ciclos ?? null,
      registro,
    },
  };
}

async function desligar(tenantId: string, deps: DepsGuias, log: NonNullable<DepsGuias["log"]>): Promise<Resultado> {
  const d = await deps.desligar(tenantId);
  if (!d.ok) return erro(422, d.erro || "CONTA_INVALIDA", "a conta não é conta-mãe de Escritório");
  if (!d.cancelar) return { http: 200, body: { ok: true, desligado: true, cancelamento: "nada_a_cancelar" } };
  const cancelado = await cancelarNoPagarme(deps, d.cancelar);
  if (cancelado) await deps.cancelamentoPedido(tenantId, d.cancelar);
  log(cancelado ? "info" : "warn", "assinatura_guias_desligada", { tenant_id: tenantId, subscription_id: d.cancelar, cancelado });
  return { http: 200, body: { ok: true, desligado: true, cancelamento: cancelado ? "pedido" : "fica_para_o_ciclo" } };
}

/** DELETE /subscriptions/{id}. 404 conta como cancelada (não há o que cancelar). */
export async function cancelarNoPagarme(deps: Pick<DepsGuias, "env" | "fetch">, subscriptionId: string): Promise<boolean> {
  const config = lerConfig(deps.env);
  if (!config.secretKey) return false;
  try {
    const res = await deps.fetch(`${config.apiUrl}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${config.secretKey}:`)}` },
      body: JSON.stringify({ cancel_pending_invoices: true }),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
