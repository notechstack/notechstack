// Regras puras do checkout de assinatura do Auditor (sem Deno.*, sem import por URL).
// Contrato: CONTRATO.md, secao "Funcao assinatura-auditor (checkout)".
// Dado de cartao nunca passa por aqui: o navegador tokeniza direto no Pagar.me e manda so o card_token.

export type CodigoPlano = "mensal" | "semanal" | "agencia";
export type Ambiente = "sandbox" | "producao";
type Nivel = "info" | "warn" | "error";

export const PLANOS = {
  mensal: { centavos: 4700, env: "PAGARME_PLANO_MENSAL_ID" },
  semanal: { centavos: 9700, env: "PAGARME_PLANO_SEMANAL_ID" },
  agencia: { centavos: 19700, env: "PAGARME_PLANO_AGENCIA_ID" },
} as const;

const CODIGOS = Object.keys(PLANOS) as CodigoPlano[];
const API_PADRAO = "https://api.pagar.me/core/v5";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAMPOS_CARTAO = ["card", "card_number", "number", "cvv", "holder_name", "exp_month", "exp_year"];

export type Config = {
  ambiente: Ambiente;
  apiUrl: string;
  vendaAberta: boolean;
  // Medicao do checkout segurada ate a TASK da D4 (decisao de Lucca, 16/10): so "sim" libera.
  medicaoLiberada: boolean;
  publicKey: string;
  secretKey: string;
  planIds: Record<CodigoPlano, string>;
};

export type Pedido = {
  plano: CodigoPlano;
  nome: string;
  email: string;
  documento: string;
  telefone: string | null;
  card_token: string;
  relatorio_aceite: boolean;
  relatorio_aceite_texto: string | null;
};

export type LinhaAssinatura = {
  plano: CodigoPlano;
  nome: string;
  email: string;
  customer_id: string | null;
  subscription_id: string;
  status: "pendente" | "recusada";
  relatorio_aceite: boolean;
  relatorio_aceite_texto: string | null;
};

export type Deps = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  registrar: (row: LinhaAssinatura) => Promise<{ id: string; status: string }>;
  log?: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void;
};

export type Resultado = { http: number; body: Record<string, unknown> };

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function tem(o: Record<string, unknown>, campo: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, campo);
}

export function lerConfig(env: Record<string, string | undefined>): Config {
  return {
    ambiente: env.PAGARME_ASSINATURA_AMBIENTE === "producao" ? "producao" : "sandbox",
    apiUrl: (env.PAGARME_ASSINATURA_API_URL || API_PADRAO).replace(/\/+$/, ""),
    vendaAberta: env.AUDITOR_VENDA_ABERTA === "sim",
    medicaoLiberada: env.AUDITOR_MEDICAO_CHECKOUT === "sim",
    publicKey: env.PAGARME_ASSINATURA_PUBLIC_KEY || "",
    secretKey: env.PAGARME_ASSINATURA_SECRET_KEY || "",
    planIds: {
      mensal: env[PLANOS.mensal.env] || "",
      semanal: env[PLANOS.semanal.env] || "",
      agencia: env[PLANOS.agencia.env] || "",
    },
  };
}

// O que o navegador pode ver. Nunca a secret.
export function respostaGet(config: Config) {
  return {
    ambiente: config.ambiente,
    venda_aberta: config.vendaAberta,
    medicao_liberada: config.medicaoLiberada,
    public_key: config.publicKey || "",
    planos: CODIGOS.map((codigo) => ({ codigo, disponivel: Boolean(config.planIds[codigo]) })),
  };
}

function invalido(mensagem: string) {
  return { ok: false as const, error_code: "DADOS_INVALIDOS" as const, mensagem };
}

export function validarPedido(body: unknown):
  | { ok: true; pedido: Pedido }
  | { ok: false; error_code: "DADOS_INVALIDOS"; mensagem: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return invalido("Não recebemos os dados da assinatura. Recarregue a página e tente de novo.");
  }
  const b = body as Record<string, unknown>;

  if (CAMPOS_CARTAO.some((campo) => tem(b, campo))) {
    return invalido("Por segurança, os dados do cartão não passam por aqui. Recarregue a página e tente de novo.");
  }

  const plano = typeof b.plano === "string" ? b.plano : "";
  if (!tem(PLANOS, plano)) return invalido("Escolha um dos planos: Mensal, Semanal ou Agência.");

  const nome = typeof b.nome === "string" ? b.nome.trim() : "";
  if (nome.length < 2 || nome.length > 120) return invalido("Informe seu nome (de 2 a 120 letras).");

  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !EMAIL.test(email)) return invalido("Confira o e-mail: ele parece incompleto.");

  const documento = typeof b.documento === "string" ? b.documento.replace(/\D/g, "") : "";
  if (documento.length !== 11 && documento.length !== 14) {
    return invalido("Informe o CPF (11 números) ou o CNPJ (14 números).");
  }

  let telefone: string | null = null;
  if (b.telefone !== undefined && b.telefone !== null && b.telefone !== "") {
    telefone = typeof b.telefone === "string" ? b.telefone.replace(/\D/g, "") : "";
    if (telefone.length < 10 || telefone.length > 11) {
      return invalido("Confira o telefone: use o DDD e o número (10 ou 11 números).");
    }
  }

  const cardToken = typeof b.card_token === "string" ? b.card_token : "";
  if (!cardToken.startsWith("token_")) {
    return invalido("Não conseguimos ler o cartão. Confira os dados do cartão e tente de novo.");
  }

  if (typeof b.relatorio_aceite !== "boolean") {
    return invalido("Diga se quer ou não receber o relatório marcando ou desmarcando a caixa.");
  }
  const aceite = b.relatorio_aceite;

  let aceiteTexto: string | null = null;
  if (aceite) {
    if (!telefone) return invalido("Para receber o relatório, informe um telefone com DDD.");
    aceiteTexto = typeof b.relatorio_aceite_texto === "string" ? b.relatorio_aceite_texto.trim() : "";
    if (aceiteTexto.length < 1 || aceiteTexto.length > 500) {
      return invalido("Não conseguimos registrar o seu aceite do relatório. Recarregue a página e tente de novo.");
    }
  }

  if (b.termos_aceite !== true) return invalido("Para assinar, é preciso aceitar os termos.");

  return {
    ok: true,
    pedido: {
      plano: plano as CodigoPlano,
      nome,
      email,
      documento,
      telefone,
      card_token: cardToken,
      relatorio_aceite: aceite,
      relatorio_aceite_texto: aceiteTexto,
    },
  };
}

// Corpo do POST /subscriptions. So o token do cartao; nada de numero, cvv ou validade.
export function corpoAssinatura(pedido: Pedido, planId: string) {
  const customer: Record<string, unknown> = {
    name: pedido.nome,
    email: pedido.email,
    document: pedido.documento,
    type: pedido.documento.length === 14 ? "company" : "individual",
  };
  if (pedido.telefone) {
    customer.phones = {
      mobile_phone: {
        country_code: "55",
        area_code: pedido.telefone.slice(0, 2),
        number: pedido.telefone.slice(2),
      },
    };
  }
  return {
    plan_id: planId,
    payment_method: "credit_card",
    card_token: pedido.card_token,
    customer,
    metadata: { origem: "auditor", plano: pedido.plano },
  };
}

// "paga" so vem do webhook.
export function statusInicial(sub: unknown): "pendente" | "recusada" {
  const status = obj(sub).status;
  return status === "failed" || status === "canceled" ? "recusada" : "pendente";
}

function erro(http: number, error_code: string, mensagem: string): Resultado {
  return { http, body: { ok: false, error_code, mensagem } };
}

const MSG_PAGARME =
  "Não conseguimos concluir a assinatura com o sistema de pagamento agora. Tente de novo em alguns minutos.";

export async function processarCheckout(body: unknown, deps: Deps): Promise<Resultado> {
  const log = deps.log ?? (() => {});
  const config = lerConfig(deps.env);

  if (!config.vendaAberta) {
    return erro(403, "VENDA_FECHADA", "A assinatura ainda não está aberta. Volte em breve.");
  }
  if (!config.secretKey) {
    log("error", "assinatura_auditor_config_ausente", {});
    return erro(500, "CONFIG_AUSENTE", "O pagamento está fora do ar agora. Nada foi cobrado; tente mais tarde.");
  }
  // Garante zero cobranca real: em sandbox so aceita chave de teste, e nem chega a chamar o Pagar.me.
  if (config.ambiente === "sandbox" && !config.secretKey.startsWith("sk_test_")) {
    log("error", "assinatura_auditor_chave_nao_sandbox", {});
    return erro(500, "CHAVE_NAO_SANDBOX", "O pagamento está em manutenção. Nada foi cobrado; tente mais tarde.");
  }

  const validacao = validarPedido(body);
  if (!validacao.ok) return erro(400, validacao.error_code, validacao.mensagem);
  const pedido = validacao.pedido;

  const planId = config.planIds[pedido.plano];
  if (!planId) {
    log("warn", "assinatura_auditor_plano_indisponivel", { plano: pedido.plano });
    return erro(409, "PLANO_INDISPONIVEL", "Este plano não está disponível agora. Escolha outro ou tente mais tarde.");
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Basic ${btoa(`${config.secretKey}:`)}`,
  };

  let sub: Record<string, unknown>;
  try {
    const res = await deps.fetch(`${config.apiUrl}/subscriptions`, {
      method: "POST",
      headers,
      body: JSON.stringify(corpoAssinatura(pedido, planId)),
    });
    if (!res.ok) {
      // So o status HTTP; o corpo da resposta pode ter dado pessoal.
      log("error", "assinatura_auditor_pagarme_http", { plano: pedido.plano, http_status: res.status });
      return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    }
    sub = obj(await res.json());
  } catch {
    log("error", "assinatura_auditor_pagarme_rede", { plano: pedido.plano });
    return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
  }

  const subId = typeof sub.id === "string" ? sub.id : "";
  if (!subId.startsWith("sub_")) {
    log("error", "assinatura_auditor_pagarme_sem_id", { plano: pedido.plano });
    return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
  }
  const customerId = obj(sub.customer).id;

  const row: LinhaAssinatura = {
    plano: pedido.plano,
    nome: pedido.nome,
    email: pedido.email,
    customer_id: typeof customerId === "string" ? customerId : null,
    subscription_id: subId,
    status: statusInicial(sub),
    relatorio_aceite: pedido.relatorio_aceite,
    relatorio_aceite_texto: pedido.relatorio_aceite_texto,
  };

  let registro: { id: string; status: string };
  try {
    registro = await deps.registrar(row);
  } catch {
    log("error", "assinatura_auditor_registro_falhou", { plano: pedido.plano, subscription_id: subId });
    // Compensa: sem linha no banco a assinatura nao pode ficar viva no Pagar.me (sem novas cobrancas).
    // Cancelar nao estorna a primeira cobranca, se ela ja foi aprovada: por isso a mensagem nao promete "nada cobrado".
    try {
      const res = await deps.fetch(`${config.apiUrl}/subscriptions/${encodeURIComponent(subId)}`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ cancel_pending_invoices: true }),
      });
      log(res.ok ? "info" : "error", "assinatura_auditor_compensacao", {
        subscription_id: subId,
        http_status: res.status,
      });
    } catch {
      log("error", "assinatura_auditor_compensacao_rede", { subscription_id: subId });
    }
    return erro(
      500,
      "REGISTRO_FALHOU",
      "Não conseguimos registrar a sua assinatura e pedimos o cancelamento dela no sistema de pagamento, " +
        "para não haver novas cobranças. Se aparecer alguma cobrança no cartão, fale com a nó pelo WhatsApp.",
    );
  }

  const status = registro?.status || row.status;
  log("info", "assinatura_auditor_checkout", { plano: pedido.plano, subscription_id: subId, status });
  if (status === "recusada") {
    return erro(
      402,
      "PAGAMENTO_RECUSADO",
      "O pagamento não foi aprovado pelo cartão e nada foi cobrado. Confira os dados ou use outro cartão.",
    );
  }
  // A reconciliacao pode trazer um cancelamento que chegou antes do registro: nao e assinatura ativa.
  if (status !== "pendente" && status !== "paga") {
    return erro(409, "ASSINATURA_CANCELADA", "Esta assinatura foi cancelada no sistema de pagamento. Tente assinar de novo.");
  }
  return { http: 200, body: { ok: true, status, assinatura_id: registro.id } };
}
