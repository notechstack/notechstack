// Regras puras do checkout da assinatura do Agente Fiscal (sem Deno.*, sem import por URL).
// Formas literais no Landing de .checks/agente-fiscal-whatsapp.md (lote C): "Checkout da assinatura",
// "Planos em pares", "trial_ends_at", "Teste reivindicado antes do Pagar.me", "Recusa na criação" e
// "Texto do aceite". Molde: assinatura-auditor/core.ts.
// Dado de cartão nunca passa por aqui: o navegador tokeniza direto no Pagar.me e manda só o card_token.
// O banco é alcançado só pelas quatro funções public.fiscal_* do lote A (deps).

import { hashesDoTeste, normalizarTelefone } from "./teste-gratis.ts";

export type CodigoPlano = "inicial" | "pro";
export type CodigoPlanoPagarme = CodigoPlano | "inicial_sem_teste" | "pro_sem_teste";
export type Ambiente = "sandbox" | "producao";
type Nivel = "info" | "warn" | "error";

const DIAS_DE_TESTE = 7;
const DIA_MS = 24 * 3600 * 1000;

export const PLANOS_PAGARME: Record<CodigoPlanoPagarme, {
  nome: string;
  centavos: number;
  comTeste: boolean;
  env: string;
}> = {
  inicial: { nome: "Agente Fiscal Inicial", centavos: 4900, comTeste: true, env: "PAGARME_PLANO_FISCAL_INICIAL_ID" },
  pro: { nome: "Agente Fiscal Pro", centavos: 12900, comTeste: true, env: "PAGARME_PLANO_FISCAL_PRO_ID" },
  inicial_sem_teste: {
    nome: "Agente Fiscal Inicial",
    centavos: 4900,
    comTeste: false,
    env: "PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID",
  },
  pro_sem_teste: {
    nome: "Agente Fiscal Pro",
    centavos: 12900,
    comTeste: false,
    env: "PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID",
  },
};

// Corpo de POST /plans (docs.pagar.me, "Criar plano"; molde scripts/pagarme-assinatura/planos.mjs).
// trial_period_days: "Dias de teste. A assinatura será iniciada após o término deste período."
export function corpoDoPlano(codigo: CodigoPlanoPagarme): Record<string, unknown> {
  const p = PLANOS_PAGARME[codigo];
  return {
    name: p.comTeste ? p.nome : `${p.nome} (sem teste)`,
    description: `Assinatura ${p.nome} · nó tech stack`,
    interval: "month",
    interval_count: 1,
    billing_type: "prepaid",
    payment_methods: ["credit_card"],
    installments: [1],
    currency: "BRL",
    statement_descriptor: "NOFISCAL",
    items: [{ name: p.nome, quantity: 1, pricing_scheme: { scheme_type: "unit", price: p.centavos } }],
    ...(p.comTeste ? { trial_period_days: DIAS_DE_TESTE } : {}),
    metadata: { origem: "agente-fiscal", codigo },
  };
}

// PROVISÓRIO: o texto final dos Termos depende da RFC 1 (Unresolved 8 da tarefa, bloqueia o go-live).
// Enquanto TEXTO_ACEITE_PROVISORIO for true, o checkout em produção responde TERMOS_PROVISORIOS.
// O banco grava ESTA constante, nunca a string do cliente.
export const TEXTO_ACEITE_PROVISORIO = true;
export const TEXTO_ACEITE_FISCAL =
  "Li e aceito os Termos de Uso e a Política de Privacidade do Agente Fiscal da nó, inclusive a guarda do " +
  "meu certificado digital A1 para emitir as notas que eu confirmar no WhatsApp.";

export const MSG_TESTE_JA_USADO = "Este CNPJ, e-mail ou telefone já usou o teste grátis";

const API_PADRAO = "https://api.pagar.me/core/v5";
const CAMPOS_CARTAO = ["card", "card_number", "number", "cvv", "holder_name", "exp_month", "exp_year"];
const UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

function normalizarTexto(texto: string): string {
  return texto.normalize("NFC").replace(/\s+/g, " ").trim();
}

export type Config = {
  ambiente: Ambiente;
  apiUrl: string;
  vendaAberta: boolean;
  secretKey: string;
  sal: string;
  planIds: Record<CodigoPlanoPagarme, string>;
};

export function lerConfig(env: Record<string, string | undefined>): Config {
  const ambiente: Ambiente = env.PAGARME_ASSINATURA_AMBIENTE === "producao" ? "producao" : "sandbox";
  return {
    ambiente,
    apiUrl: (env.PAGARME_ASSINATURA_API_URL || API_PADRAO).replace(/\/+$/, ""),
    vendaAberta: env.FISCAL_VENDA_ABERTA === "sim",
    // Como no auditor: em produção, sem chave própria, usa a da conta da nó; em sandbox nunca.
    secretKey: env.PAGARME_ASSINATURA_SECRET_KEY || (ambiente === "producao" ? env.PAGARME_SECRET_KEY || "" : ""),
    sal: env.FISCAL_TRIAL_SALT || "",
    planIds: {
      inicial: env[PLANOS_PAGARME.inicial.env] || "",
      pro: env[PLANOS_PAGARME.pro.env] || "",
      inicial_sem_teste: env[PLANOS_PAGARME.inicial_sem_teste.env] || "",
      pro_sem_teste: env[PLANOS_PAGARME.pro_sem_teste.env] || "",
    },
  };
}

export type Endereco = {
  cep: string;
  rua: string;
  numero: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
};

export type Pedido = {
  plano: CodigoPlano;
  cpf: string;
  card_token: string;
  endereco: Endereco;
  aceite_texto: string;
};

/** O que public.fiscal_assinatura_contexto devolve. */
export type Contexto = {
  tenant_id: string;
  cnpj: string;
  razao_social: string;
  email: string;
  phone_e164: string;
  trial_ends_at: string | null;
  assinatura: { status: string } | null;
};

/** Argumentos de public.fiscal_registrar_assinatura. */
export type LinhaAssinatura = {
  tenant_id: string;
  plano: CodigoPlano;
  com_teste: boolean;
  trial_ends_at: string | null;
  customer_id: string | null;
  subscription_id: string;
  status: "pendente";
  aceite_texto: string;
};

export type Deps = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Usuário da sessão Supabase, ou null. */
  sessao: () => Promise<string | null>;
  contexto: (userId: string) => Promise<Contexto | null>;
  reivindicarTeste: (tenantId: string, hashes: Record<string, string>) => Promise<boolean>;
  registrar: (linha: LinhaAssinatura) => Promise<{ id: string; status: string }>;
  agora?: () => Date;
  log?: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void;
};

export type Resultado = { http: number; body: Record<string, unknown> };

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function tem(o: Record<string, unknown>, campo: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, campo);
}

function erro(http: number, error_code: string, mensagem: string): Resultado {
  return { http, body: { ok: false, error_code, mensagem } };
}

function invalido(mensagem: string) {
  return { ok: false as const, mensagem };
}

export function lerEndereco(valor: unknown): Endereco | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  const e = valor as Record<string, unknown>;
  const texto = (v: unknown, min: number, max: number): string | null => {
    if (typeof v !== "string") return null;
    const t = normalizarTexto(v);
    return t.length >= min && t.length <= max ? t : null;
  };
  const cep = typeof e.cep === "string" ? e.cep.replace(/[\s.-]/g, "") : "";
  if (!/^\d{8}$/.test(cep)) return null;
  const rua = texto(e.rua, 2, 120);
  const numero = texto(e.numero, 1, 20);
  const bairro = texto(e.bairro, 2, 80);
  const cidade = texto(e.cidade, 2, 80);
  if (rua === null || numero === null || bairro === null || cidade === null) return null;
  const complemento = e.complemento === undefined || e.complemento === null ? "" : texto(e.complemento, 0, 60);
  if (complemento === null) return null;
  const uf = typeof e.uf === "string" ? e.uf.trim().toUpperCase() : "";
  if (!UFS.has(uf)) return null;
  return { cep, rua, numero, complemento, bairro, cidade, uf };
}

export function validarPedido(body: unknown): { ok: true; pedido: Pedido } | { ok: false; mensagem: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalido("Não recebemos os dados da assinatura. Recarregue a página e tente de novo.");
  }
  const b = body as Record<string, unknown>;
  if (CAMPOS_CARTAO.some((campo) => tem(b, campo))) {
    return invalido("Por segurança, os dados do cartão não passam por aqui. Recarregue a página e tente de novo.");
  }
  const plano = typeof b.plano === "string" ? b.plano : "";
  if (plano !== "inicial" && plano !== "pro") return invalido("Escolha um dos planos: Inicial ou Pro.");

  const cpf = typeof b.cpf === "string" ? b.cpf.replace(/\D/g, "") : "";
  if (cpf.length !== 11) return invalido("Informe o seu CPF (11 números).");

  const endereco = lerEndereco(b.endereco);
  if (!endereco) return invalido("Confira o endereço de cobrança do cartão.");

  const cardToken = typeof b.card_token === "string" ? b.card_token : "";
  if (!cardToken.startsWith("token_")) {
    return invalido("Não conseguimos ler o cartão. Confira os dados do cartão e tente de novo.");
  }

  // Aceite obrigatório (critério 36): sem ele não há assinatura.
  if (b.termos_aceite !== true) return invalido("Para assinar, aceite os Termos de Uso.");
  const recebido = typeof b.aceite_texto === "string" ? normalizarTexto(b.aceite_texto) : "";
  if (recebido !== TEXTO_ACEITE_FISCAL) {
    return invalido("Não conseguimos registrar o seu aceite. Recarregue a página e tente de novo.");
  }

  return { ok: true, pedido: { plano, cpf, card_token: cardToken, endereco, aceite_texto: TEXTO_ACEITE_FISCAL } };
}

export function enderecoPagarme(e: Endereco): Record<string, string> {
  return {
    line_1: `${e.numero}, ${e.rua}, ${e.bairro}`,
    ...(e.complemento ? { line_2: e.complemento } : {}),
    zip_code: e.cep,
    city: e.cidade,
    state: e.uf,
    country: "BR",
  };
}

function telefonePagarme(e164: string): Record<string, unknown> | null {
  const t = normalizarTelefone(e164);
  if (!t || !t.startsWith("+55")) return null;
  const nacional = t.slice(3);
  return { mobile_phone: { country_code: "55", area_code: nacional.slice(0, 2), number: nacional.slice(2) } };
}

// Corpo de POST /subscriptions (docs.pagar.me, "Criar assinatura de plano"). Sem start_at: o teste vem
// do plano. O cliente é a empresa do contexto, nunca dados do corpo do pedido.
export function corpoAssinatura(pedido: Pedido, contexto: Contexto, planId: string, comTeste: boolean) {
  const phones = telefonePagarme(contexto.phone_e164);
  return {
    plan_id: planId,
    payment_method: "credit_card",
    card_token: pedido.card_token,
    card: { billing_address: enderecoPagarme(pedido.endereco) },
    customer: {
      name: contexto.razao_social,
      email: contexto.email,
      document: contexto.cnpj,
      type: "company",
      ...(phones ? { phones } : {}),
      address: enderecoPagarme(pedido.endereco),
    },
    metadata: { origem: "agente-fiscal", tenant_id: contexto.tenant_id, plano: pedido.plano, com_teste: comTeste },
  };
}

const MSG_PAGARME =
  "Não conseguimos concluir a assinatura com o sistema de pagamento agora. Tente de novo em alguns minutos.";

export async function processarCheckout(body: unknown, deps: Deps): Promise<Resultado> {
  const log = deps.log ?? (() => {});
  const agora = deps.agora ?? (() => new Date());
  const config = lerConfig(deps.env);

  if (!config.vendaAberta) return erro(403, "VENDA_FECHADA", "A assinatura ainda não está aberta. Volte em breve.");
  if (!config.secretKey || !config.sal) {
    log("error", "assinatura_fiscal_config_ausente", { secret: Boolean(config.secretKey), sal: Boolean(config.sal) });
    return erro(500, "CONFIG_AUSENTE", "O pagamento está fora do ar agora. Nada foi cobrado; tente mais tarde.");
  }
  if (config.ambiente === "sandbox" && !config.secretKey.startsWith("sk_test_")) {
    log("error", "assinatura_fiscal_chave_nao_sandbox", {});
    return erro(500, "CHAVE_NAO_SANDBOX", "O pagamento está em manutenção. Nada foi cobrado; tente mais tarde.");
  }
  if (config.ambiente === "producao" && TEXTO_ACEITE_PROVISORIO) {
    log("error", "assinatura_fiscal_termos_provisorios", {});
    return erro(500, "TERMOS_PROVISORIOS", "A assinatura ainda não está aberta. Nada foi cobrado; volte em breve.");
  }

  const userId = await deps.sessao();
  if (!userId) return erro(401, "SEM_SESSAO", "Entre na sua conta para assinar.");

  const validacao = validarPedido(body);
  if (!validacao.ok) return erro(400, "DADOS_INVALIDOS", validacao.mensagem);
  const pedido = validacao.pedido;

  const contexto = await deps.contexto(userId);
  if (!contexto) {
    return erro(403, "CONTA_SEM_EMPRESA", "Conclua o cadastro da conta e da empresa antes de assinar.");
  }
  if (contexto.assinatura && contexto.assinatura.status !== "cancelada") {
    return erro(409, "ASSINATURA_EXISTENTE", "Esta empresa já tem uma assinatura.");
  }

  const planoComTeste = config.planIds[pedido.plano];
  const planoSemTeste = config.planIds[`${pedido.plano}_sem_teste` as CodigoPlanoPagarme];
  if (!planoComTeste || !planoSemTeste) {
    log("warn", "assinatura_fiscal_plano_indisponivel", { plano: pedido.plano });
    return erro(409, "PLANO_INDISPONIVEL", "Este plano não está disponível agora. Tente mais tarde.");
  }

  // O par é escolhido por fiscal_trial_claims (Decided "Teste com cartão"). Só hash sai daqui.
  const hashes = await hashesDoTeste(
    { cpf: pedido.cpf, cnpj: contexto.cnpj, email: contexto.email, phone: contexto.phone_e164 },
    config.sal,
  ) as Record<string, string>;
  const comTeste = await deps.reivindicarTeste(contexto.tenant_id, hashes);
  const planId = comTeste ? planoComTeste : planoSemTeste;

  const headers = { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${config.secretKey}:`)}` };
  const cancelar = async (subId: string, motivo: string) => {
    try {
      const res = await deps.fetch(`${config.apiUrl}/subscriptions/${encodeURIComponent(subId)}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ cancel_pending_invoices: true }),
      });
      log(res.ok ? "info" : "error", "assinatura_fiscal_compensacao", { subscription_id: subId, motivo, http_status: res.status });
    } catch {
      log("error", "assinatura_fiscal_compensacao_rede", { subscription_id: subId, motivo });
    }
  };

  let sub: Record<string, unknown>;
  try {
    const res = await deps.fetch(`${config.apiUrl}/subscriptions`, {
      method: "POST",
      headers,
      body: JSON.stringify(corpoAssinatura(pedido, contexto, planId, comTeste)),
    });
    if (!res.ok) {
      // Só o status HTTP; o corpo da resposta pode ter dado pessoal.
      log("error", "assinatura_fiscal_pagarme_http", { plano: pedido.plano, com_teste: comTeste, http_status: res.status });
      return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    }
    sub = obj(await res.json());
  } catch {
    log("error", "assinatura_fiscal_pagarme_rede", { plano: pedido.plano, com_teste: comTeste });
    return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
  }

  const subId = typeof sub.id === "string" ? sub.id : "";
  if (!subId.startsWith("sub_")) {
    log("error", "assinatura_fiscal_pagarme_sem_id", { plano: pedido.plano });
    return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
  }

  // Recusa na criação: não registra (deixaria a empresa presa no índice de assinatura atual) e cancela.
  if (sub.status === "failed" || sub.status === "canceled") {
    await cancelar(subId, "recusada_na_criacao");
    log("info", "assinatura_fiscal_recusada", { plano: pedido.plano, subscription_id: subId });
    return erro(402, "PAGAMENTO_RECUSADO", "O pagamento não foi aprovado pelo cartão. Confira os dados ou use outro cartão.");
  }

  const customerId = obj(sub.customer).id;
  const trialEndsAt = comTeste ? new Date(agora().getTime() + DIAS_DE_TESTE * DIA_MS).toISOString() : null;
  const linha: LinhaAssinatura = {
    tenant_id: contexto.tenant_id,
    plano: pedido.plano,
    com_teste: comTeste,
    trial_ends_at: trialEndsAt,
    customer_id: typeof customerId === "string" ? customerId : null,
    subscription_id: subId,
    // "paga" só vem do aviso.
    status: "pendente",
    aceite_texto: pedido.aceite_texto,
  };

  let registro: { id: string; status: string };
  try {
    registro = await deps.registrar(linha);
  } catch {
    log("error", "assinatura_fiscal_registro_falhou", { plano: pedido.plano, subscription_id: subId });
    await cancelar(subId, "registro_falhou");
    return erro(
      500,
      "REGISTRO_FALHOU",
      "Não conseguimos registrar a sua assinatura e pedimos o cancelamento dela no sistema de pagamento, " +
        "para não haver cobranças. Se aparecer alguma cobrança no cartão, fale com a nó pelo WhatsApp.",
    );
  }

  const status = registro?.status || linha.status;
  log("info", "assinatura_fiscal_checkout", { plano: pedido.plano, com_teste: comTeste, subscription_id: subId, status });
  // A reconciliação pode trazer um aviso que chegou antes do registro.
  if (status === "recusada") {
    return erro(402, "PAGAMENTO_RECUSADO", "O pagamento não foi aprovado pelo cartão. Atualize o cartão para continuar.");
  }
  if (status === "cancelada") {
    return erro(409, "ASSINATURA_CANCELADA", "Esta assinatura foi cancelada no sistema de pagamento. Tente assinar de novo.");
  }
  return {
    http: 200,
    body: {
      ok: true,
      status,
      assinatura_id: registro.id,
      com_teste: comTeste,
      trial_ends_at: trialEndsAt,
      ...(comTeste ? {} : { aviso: MSG_TESTE_JA_USADO }),
    },
  };
}
