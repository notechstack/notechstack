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
const UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);
const MSG_ENDERECO = "Confira o endereço de cobrança do cartão.";

// Texto exato da caixa de aceite (obrigatoria) da tela de planos no fim da retrospectiva: Termos + relatorio no
// WhatsApp, decisao de Lucca em 16/10. O banco grava ESTA constante, nunca a string do cliente. Mudar o texto da
// caixa exige mudar esta constante junto (front.test.mjs e checkout-core.test.mjs conferem).
export const TEXTO_ACEITE_ASSINATURA =
  "Li e aceito os Termos de Uso e a Política de Privacidade. Sei que o relatório do Auditor chega no WhatsApp " +
  "que informei acima, enviado pelo número da nó (+55 11 93928-9413).";

function normalizarTexto(texto: string): string {
  return texto.normalize("NFC").replace(/\s+/g, " ").trim();
}

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
  // WhatsApp com DDD, so digitos: obrigatorio, e para onde vai o relatorio.
  telefone: string;
  card_token: string;
  aceite_texto: string;
  // Endereco de cobranca do cartao: so vai ao Pagar.me (o token do cartao nao leva endereco na v5).
  // Nao vai para o banco nem para log.
  endereco: Endereco;
};

export type Endereco = {
  cep: string; // 8 digitos
  rua: string;
  numero: string;
  complemento: string; // "" quando nao informado
  bairro: string;
  cidade: string;
  uf: string; // sigla maiuscula
};

export type LinhaAssinatura = {
  plano: CodigoPlano;
  nome: string;
  email: string;
  whatsapp: string;
  customer_id: string | null;
  subscription_id: string;
  status: "pendente" | "recusada";
  aceite_texto: string;
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
  const ambiente: Ambiente = env.PAGARME_ASSINATURA_AMBIENTE === "producao" ? "producao" : "sandbox";
  return {
    ambiente,
    apiUrl: (env.PAGARME_ASSINATURA_API_URL || API_PADRAO).replace(/\/+$/, ""),
    vendaAberta: env.AUDITOR_VENDA_ABERTA === "sim",
    medicaoLiberada: env.AUDITOR_MEDICAO_CHECKOUT === "sim",
    publicKey: env.PAGARME_ASSINATURA_PUBLIC_KEY || "",
    // Producao (Lucca, 19/10): sem a chave propria, usa a PAGARME_SECRET_KEY da conta da no.
    // Em sandbox nunca cai nela, entao a guarda sk_test_ continua valendo.
    secretKey: env.PAGARME_ASSINATURA_SECRET_KEY
      || (ambiente === "producao" ? env.PAGARME_SECRET_KEY || "" : ""),
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

// Campos do endereco de cobranca como o front manda: {cep, rua, numero, complemento?, bairro, cidade, uf}.
// Retorna null se ausente ou invalido (quem chama devolve 400 sem chamar o Pagar.me).
export function lerEndereco(valor: unknown): Endereco | null {
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return null;
  const e = valor as Record<string, unknown>;
  const texto = (v: unknown, min: number, max: number): string | null => {
    if (typeof v !== "string") return null;
    const t = normalizarTexto(v);
    return t.length >= min && t.length <= max ? t : null;
  };

  // Aceita a mascara "01001-000"; o que sobra tem de ser exatamente 8 digitos.
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

  const telefone = typeof b.telefone === "string" ? b.telefone.replace(/\D/g, "") : "";
  if (!telefone) return invalido("Informe o WhatsApp com DDD: é nele que chega o relatório do Auditor.");
  if (telefone.length < 10 || telefone.length > 11) {
    return invalido("Confira o WhatsApp: use o DDD e o número (10 ou 11 números).");
  }

  const endereco = lerEndereco(b.endereco);
  if (!endereco) return invalido(MSG_ENDERECO);

  const cardToken = typeof b.card_token === "string" ? b.card_token : "";
  if (!cardToken.startsWith("token_")) {
    return invalido("Não conseguimos ler o cartão. Confira os dados do cartão e tente de novo.");
  }

  // Aceite unico e obrigatorio: Termos + relatorio no WhatsApp informado. Sem ele, nao ha assinatura.
  if (b.termos_aceite !== true) {
    return invalido("Para assinar, aceite os Termos e o envio do relatório no seu WhatsApp.");
  }
  const recebido = typeof b.aceite_texto === "string" ? normalizarTexto(b.aceite_texto) : "";
  if (recebido !== TEXTO_ACEITE_ASSINATURA) {
    return invalido("Não conseguimos registrar o seu aceite. Recarregue a página e tente de novo.");
  }

  return {
    ok: true,
    pedido: {
      plano: plano as CodigoPlano,
      nome,
      email,
      documento,
      telefone,
      card_token: cardToken,
      aceite_texto: TEXTO_ACEITE_ASSINATURA,
      endereco,
    },
  };
}

// Formato de endereco da API v5 do Pagar.me (billing_address do cartao e address do customer).
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

// Corpo do POST /subscriptions. So o token do cartao; nada de numero, cvv ou validade.
// O "card" daqui leva SO o billing_address (o token da v5 nao carrega endereco); o "card" vindo do navegador
// continua recusado em validarPedido.
export function corpoAssinatura(pedido: Pedido, planId: string) {
  const customer: Record<string, unknown> = {
    name: pedido.nome,
    email: pedido.email,
    document: pedido.documento,
    type: pedido.documento.length === 14 ? "company" : "individual",
    phones: {
      mobile_phone: {
        country_code: "55",
        area_code: pedido.telefone.slice(0, 2),
        number: pedido.telefone.slice(2),
      },
    },
    address: enderecoPagarme(pedido.endereco),
  };
  return {
    plan_id: planId,
    payment_method: "credit_card",
    card_token: pedido.card_token,
    card: { billing_address: enderecoPagarme(pedido.endereco) },
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
    whatsapp: pedido.telefone,
    customer_id: typeof customerId === "string" ? customerId : null,
    subscription_id: subId,
    status: statusInicial(sub),
    aceite_texto: pedido.aceite_texto,
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
