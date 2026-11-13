// Regras puras do checkout da assinatura do Agente Fiscal (sem Deno.*, sem import por URL).
// Formas literais no Landing de .checks/agente-fiscal-whatsapp.md (lote C): "Checkout da assinatura",
// "Planos em pares", "trial_ends_at", "Teste reivindicado antes do Pagar.me", "Recusa na criação" e
// "Texto do aceite". Molde: assinatura-auditor/core.ts.
// Dado de cartão nunca passa por aqui: o navegador tokeniza direto no Pagar.me e manda só o card_token.
// O banco é alcançado só pelas quatro funções public.fiscal_* do lote A (deps).
// Escritório (Lucca, 05/11/2026; .design/agente-fiscal-escritorio.md): faixas escritorio_5/20/50, só mensal, com
// três planos por faixa no Pagar.me. Escolha: cupom com dias_de_teste = 30 → `_teste30`; senão o teste de 7 dias
// liberado por fiscal_trial_claims → o base; senão `_sem_teste`. O desconto do cupom vai em discounts, como sempre.

import { hashesDoTeste, normalizarTelefone } from "./teste-gratis.ts";
import { type ClienteHttp, corpoDaCompraMeta, eventoDaCompra, lerMedicao, type MedicaoDoNavegador } from "./medicao.ts";

export type CodigoPlano = "inicial" | "pro";
/** Faixas do plano Escritório (Lucca, 05/11/2026; .design/agente-fiscal-escritorio.md, "Faixas do Escritório").
    A empresa do próprio escritório é a conta-mãe: um tenant comum com uma destas faixas. Só mensal na v1. */
export type PlanoEscritorio = "escritorio_5" | "escritorio_20" | "escritorio_50";
/** Todo plano que uma assinatura pode ter (o mesmo check de fiscal_subscriptions.plano). */
export type PlanoAssinatura = CodigoPlano | PlanoEscritorio;
/** Ciclo de cobrança (Lucca, 03/11/2026): anual = 12 mensalidades com 20% off, cobradas de uma vez. */
export type Ciclo = "mensal" | "anual";
/** Teste do plano do Escritório no Pagar.me: 7 dias (o base), nenhum, ou 30 dias (cupom de fundador). */
export type TesteDoEscritorio = "teste" | "sem_teste" | "teste30";
export type CodigoPlanoPagarme =
  | CodigoPlano
  | "inicial_sem_teste"
  | "pro_sem_teste"
  | "inicial_anual"
  | "pro_anual"
  | "inicial_anual_sem_teste"
  | "pro_anual_sem_teste"
  | PlanoEscritorio
  | `${PlanoEscritorio}_sem_teste`
  | `${PlanoEscritorio}_teste30`
  | `${PlanoEscritorio}_anual`
  | `${PlanoEscritorio}_anual_sem_teste`;
export type Ambiente = "sandbox" | "producao";
type Nivel = "info" | "warn" | "error";

const DIAS_DE_TESTE = 7;
/** Teste do cupom de fundador do Escritório (fiscal_cupons.dias_de_teste só aceita 30). */
export const DIAS_DE_TESTE_DO_CUPOM = 30;
const DIA_MS = 24 * 3600 * 1000;

/** Empresas e notas por mês de cada faixa: o mesmo de nofiscal.limite_do_plano e max_empresas_do_plano. */
export const FAIXAS_ESCRITORIO: Record<PlanoEscritorio, { centavos: number; empresas: number; notas: number }> = {
  escritorio_5: { centavos: 29700, empresas: 5, notas: 500 },
  escritorio_20: { centavos: 79700, empresas: 20, notas: 2000 },
  escritorio_50: { centavos: 149700, empresas: 50, notas: 5000 },
};
const ESCRITORIO_ENV: Record<PlanoEscritorio, string> = {
  escritorio_5: "PAGARME_PLANO_FISCAL_ESCRITORIO_5",
  escritorio_20: "PAGARME_PLANO_FISCAL_ESCRITORIO_20",
  escritorio_50: "PAGARME_PLANO_FISCAL_ESCRITORIO_50",
};

export function planoDeEscritorio(plano: unknown): plano is PlanoEscritorio {
  return plano === "escritorio_5" || plano === "escritorio_20" || plano === "escritorio_50";
}

/** Plano do corpo do pedido, ou null quando não é um dos cinco. */
export function lerPlano(valor: unknown): PlanoAssinatura | null {
  return valor === "inicial" || valor === "pro" || planoDeEscritorio(valor) ? valor : null;
}

/** Código do plano do Escritório no Pagar.me: o base tem 7 dias de teste, como Inicial e Pro. */
export function codigoPagarmeEscritorio(plano: PlanoEscritorio, teste: TesteDoEscritorio): CodigoPlanoPagarme {
  return `${plano}${teste === "teste" ? "" : `_${teste}`}` as CodigoPlanoPagarme;
}

type PlanoPagarme = { nome: string; centavos: number; comTeste: boolean; diasDeTeste?: number; ciclo: Ciclo; env: string };

/** Os 15 planos do Escritório: cinco por faixa (mensal com teste de 7 dias, sem teste e com teste de 30 dias; anual
    com e sem o teste de 7 dias). */
function planosDoEscritorio(): Record<string, PlanoPagarme> {
  const planos: Record<string, PlanoPagarme> = {};
  for (const faixa of Object.keys(FAIXAS_ESCRITORIO) as PlanoEscritorio[]) {
    const nome = `Agente Fiscal Escritório ${FAIXAS_ESCRITORIO[faixa].empresas}`;
    const base = { nome, centavos: FAIXAS_ESCRITORIO[faixa].centavos, ciclo: "mensal" as Ciclo };
    planos[faixa] = { ...base, comTeste: true, env: `${ESCRITORIO_ENV[faixa]}_ID` };
    planos[`${faixa}_sem_teste`] = { ...base, comTeste: false, env: `${ESCRITORIO_ENV[faixa]}_SEM_TESTE_ID` };
    planos[`${faixa}_teste30`] = {
      ...base,
      comTeste: true,
      diasDeTeste: DIAS_DE_TESTE_DO_CUPOM,
      env: `${ESCRITORIO_ENV[faixa]}_TESTE30_ID`,
    };
    // Anual do Escritório (Lucca, 13/11/2026): 12 mensalidades com o desconto da faixa (25%, 30% e 45%; no Inicial e
    // no Pro são 20%), com e sem o teste de 7 dias. Por ora só a definição e os planos no Pagar.me: o checkout ainda
    // recusa o anual do Escritório (ESCRITORIO_SO_MENSAL) até a etapa de pagamento do cadastro oferecer o ciclo.
    const anual = { nome, centavos: centavosAnuaisDoEscritorio(faixa), ciclo: "anual" as Ciclo };
    planos[`${faixa}_anual`] = { ...anual, comTeste: true, env: `${ESCRITORIO_ENV[faixa]}_ANUAL_ID` };
    planos[`${faixa}_anual_sem_teste`] = { ...anual, comTeste: false, env: `${ESCRITORIO_ENV[faixa]}_ANUAL_SEM_TESTE_ID` };
  }
  return planos;
}

export const DESCONTO_ANUAL_PERCENTUAL = 20;
/** Desconto do anual em cada faixa do Escritório (Lucca, 13/11/2026): mais agressivo que os 20% de Inicial e Pro. */
export const DESCONTO_ANUAL_ESCRITORIO: Record<PlanoEscritorio, number> = { escritorio_5: 25, escritorio_20: 30, escritorio_50: 45 };

/** Preço do ano no anual do Escritório: 12 mensalidades da faixa com o desconto dela, em centavos. */
export function centavosAnuaisDoEscritorio(faixa: PlanoEscritorio): number {
  return Math.round(FAIXAS_ESCRITORIO[faixa].centavos * 12 * (100 - DESCONTO_ANUAL_ESCRITORIO[faixa]) / 100);
}

/** Preço do ano no anual: 12 mensalidades com o desconto, em centavos. */
export function centavosAnuais(mensal: number): number {
  return Math.round(mensal * 12 * (100 - DESCONTO_ANUAL_PERCENTUAL) / 100);
}

export const PLANOS_PAGARME: Record<CodigoPlanoPagarme, PlanoPagarme> = {
  inicial: { nome: "Agente Fiscal Inicial", centavos: 4900, comTeste: true, ciclo: "mensal", env: "PAGARME_PLANO_FISCAL_INICIAL_ID" },
  pro: { nome: "Agente Fiscal Pro", centavos: 12900, comTeste: true, ciclo: "mensal", env: "PAGARME_PLANO_FISCAL_PRO_ID" },
  inicial_sem_teste: {
    nome: "Agente Fiscal Inicial",
    centavos: 4900,
    comTeste: false,
    ciclo: "mensal",
    env: "PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID",
  },
  pro_sem_teste: {
    nome: "Agente Fiscal Pro",
    centavos: 12900,
    comTeste: false,
    ciclo: "mensal",
    env: "PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID",
  },
  inicial_anual: {
    nome: "Agente Fiscal Inicial",
    centavos: centavosAnuais(4900),
    comTeste: true,
    ciclo: "anual",
    env: "PAGARME_PLANO_FISCAL_INICIAL_ANUAL_ID",
  },
  pro_anual: {
    nome: "Agente Fiscal Pro",
    centavos: centavosAnuais(12900),
    comTeste: true,
    ciclo: "anual",
    env: "PAGARME_PLANO_FISCAL_PRO_ANUAL_ID",
  },
  inicial_anual_sem_teste: {
    nome: "Agente Fiscal Inicial",
    centavos: centavosAnuais(4900),
    comTeste: false,
    ciclo: "anual",
    env: "PAGARME_PLANO_FISCAL_INICIAL_ANUAL_SEM_TESTE_ID",
  },
  pro_anual_sem_teste: {
    nome: "Agente Fiscal Pro",
    centavos: centavosAnuais(12900),
    comTeste: false,
    ciclo: "anual",
    env: "PAGARME_PLANO_FISCAL_PRO_ANUAL_SEM_TESTE_ID",
  },
  ...planosDoEscritorio(),
} as Record<CodigoPlanoPagarme, PlanoPagarme>;

/** Código do plano no Pagar.me para o par plano × ciclo × teste (Inicial e Pro; o Escritório usa codigoPagarmeEscritorio). */
export function codigoPagarme(plano: CodigoPlano, ciclo: Ciclo, comTeste: boolean): CodigoPlanoPagarme {
  return `${plano}${ciclo === "anual" ? "_anual" : ""}${comTeste ? "" : "_sem_teste"}` as CodigoPlanoPagarme;
}

/** O que a assinatura cobra por ciclo, em centavos (sem cupom). O Escritório é só mensal: o ciclo não muda o preço
    (quem pede o anual é recusado antes, em ESCRITORIO_SO_MENSAL). */
export function centavosDoCiclo(plano: PlanoAssinatura, ciclo: Ciclo): number {
  if (planoDeEscritorio(plano)) return PLANOS_PAGARME[plano].centavos;
  return PLANOS_PAGARME[codigoPagarme(plano, ciclo, true)].centavos;
}

// Corpo de POST /plans (docs.pagar.me, "Criar plano"; molde scripts/pagarme-assinatura/planos.mjs).
// trial_period_days: "Dias de teste. A assinatura será iniciada após o término deste período." Os planos sem
// teste não mandam o campo (equivale a 0), como os de Inicial e Pro que já estão em produção.
export function corpoDoPlano(codigo: CodigoPlanoPagarme): Record<string, unknown> {
  const p = PLANOS_PAGARME[codigo];
  const nome = p.ciclo === "anual" ? `${p.nome} anual` : p.nome;
  const dias = p.diasDeTeste ?? DIAS_DE_TESTE;
  return {
    name: !p.comTeste ? `${nome} (sem teste)` : dias !== DIAS_DE_TESTE ? `${nome} (teste de ${dias} dias)` : nome,
    description: `Assinatura ${nome} · nó tech stack`,
    interval: p.ciclo === "anual" ? "year" : "month",
    interval_count: 1,
    billing_type: "prepaid",
    payment_methods: ["credit_card"],
    installments: [1],
    currency: "BRL",
    statement_descriptor: "NOFISCAL",
    items: [{ name: nome, quantity: 1, pricing_scheme: { scheme_type: "unit", price: p.centavos } }],
    ...(p.comTeste ? { trial_period_days: dias } : {}),
    metadata: { origem: "agente-fiscal", codigo },
  };
}

// Texto e Termos aprovados por Lucca em 22/10/2026 (fecha a RFC 1 / Unresolved 8). Voltar a true
// faz o checkout em produção responder TERMOS_PROVISORIOS de novo.
// O banco grava ESTA constante, nunca a string do cliente.
export const TEXTO_ACEITE_PROVISORIO = false;
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
    planIds: Object.fromEntries(
      (Object.keys(PLANOS_PAGARME) as CodigoPlanoPagarme[]).map((c) => [c, env[PLANOS_PAGARME[c].env] || ""]),
    ) as Record<CodigoPlanoPagarme, string>,
  };
}

/** GET assinatura-fiscal (critério 10 da v2): sem sessão, sempre 200. */
export function responderConfiguracao(env: Record<string, string | undefined>): Resultado {
  return { http: 200, body: configuracaoPublica(env) };
}

/** Corpo de GET assinatura-fiscal: o que a etapa de pagamento precisa. */
export function configuracaoPublica(env: Record<string, string | undefined>): Record<string, unknown> {
  const config = lerConfig(env);
  // O anual só abre com os quatro planos anuais cadastrados; sem eles a página oferece só o mensal.
  const anualDisponivel = (["inicial", "pro"] as CodigoPlano[]).every((p) =>
    Boolean(config.planIds[codigoPagarme(p, "anual", true)] && config.planIds[codigoPagarme(p, "anual", false)])
  );
  // O Escritório só abre com os 9 planos dele cadastrados (sem eles o checkout responde PLANO_INDISPONIVEL).
  const escritorioDisponivel = (Object.keys(FAIXAS_ESCRITORIO) as PlanoEscritorio[]).every((faixa) =>
    escritorioConfigurado(config, faixa)
  );
  const faixa = (p: PlanoEscritorio) => ({
    valor_centavos: FAIXAS_ESCRITORIO[p].centavos,
    empresas: FAIXAS_ESCRITORIO[p].empresas,
    notas: FAIXAS_ESCRITORIO[p].notas,
  });
  return {
    ok: true,
    venda_aberta: config.vendaAberta,
    anual_disponivel: anualDisponivel,
    escritorio_disponivel: escritorioDisponivel,
    public_key: env.PAGARME_ASSINATURA_PUBLIC_KEY || "",
    aceite_texto: TEXTO_ACEITE_FISCAL,
    planos: {
      inicial: { valor_centavos: PLANOS_PAGARME.inicial.centavos, anual_centavos: centavosDoCiclo("inicial", "anual") },
      pro: { valor_centavos: PLANOS_PAGARME.pro.centavos, anual_centavos: centavosDoCiclo("pro", "anual") },
      // Escritório: só mensal (sem anual_centavos).
      escritorio_5: faixa("escritorio_5"),
      escritorio_20: faixa("escritorio_20"),
      escritorio_50: faixa("escritorio_50"),
    },
  };
}

/** Os três planos da faixa (7 dias, sem teste e 30 dias) têm id no ambiente. */
function escritorioConfigurado(config: Config, faixa: PlanoEscritorio): boolean {
  return (["teste", "sem_teste", "teste30"] as TesteDoEscritorio[]).every((t) =>
    Boolean(config.planIds[codigoPagarmeEscritorio(faixa, t)])
  );
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
  plano: PlanoAssinatura;
  ciclo: Ciclo;
  /** Opcional desde 22/10/2026: o cadastro não pede mais o CPF (Lucca); quando vem, entra no bloqueio de reteste. */
  cpf?: string;
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
  plano: PlanoAssinatura;
  ciclo: Ciclo;
  com_teste: boolean;
  trial_ends_at: string | null;
  customer_id: string | null;
  subscription_id: string;
  status: "pendente";
  aceite_texto: string;
};

/** O que public.fiscal_validar_cupom / fiscal_registrar_cortesia / fiscal_usar_cupom devolvem. */
export type CupomBanco = {
  ok: boolean;
  motivo?: string;
  codigo?: string;
  descricao?: string | null;
  tipo?: "percentual" | "valor";
  valor?: number;
  cortesia?: boolean;
  ciclos?: number | null;
  /** Migração 20261105180000: 30 no cupom de fundador do Escritório; nulo nos demais. */
  dias_de_teste?: number | null;
  id?: string;
  status?: string;
};

export type Deps = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Usuário da sessão Supabase, ou null. */
  sessao: () => Promise<string | null>;
  contexto: (userId: string) => Promise<Contexto | null>;
  reivindicarTeste: (tenantId: string, hashes: Record<string, string>) => Promise<boolean>;
  registrar: (linha: LinhaAssinatura) => Promise<{ id: string; status: string }>;
  /** Fluxo v2: grava pago_em e passa onboarding_etapa a 'certificado' depois do registro. */
  marcarPago?: (tenantId: string) => Promise<void>;
  /** Cupons (migração 20261025090000). */
  validarCupom?: (tenantId: string, codigo: string, plano: PlanoAssinatura) => Promise<CupomBanco>;
  registrarCortesia?: (tenantId: string, plano: PlanoAssinatura, codigo: string, aceite: string) => Promise<CupomBanco>;
  usarCupom?: (tenantId: string, codigo: string, plano: PlanoAssinatura, subscriptionId: string) => Promise<CupomBanco>;
  agora?: () => Date;
  log?: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void;
  /** Meta CAPI da compra (medicao.ts); ausente sem META_ACCESS_TOKEN. Devolve o resumo para o log. */
  enviarMeta?: (corpo: Record<string, unknown>) => Promise<string>;
  /** IP e user agent de quem assinou, só para a CAPI com consentimento. */
  cliente?: ClienteHttp;
  /** public.fiscal_registrar_medicao: guarda o consentimento (e fbp/fbc só com "granted") na assinatura, para o
      webhook medir a cobrança depois do teste e as renovações. Ausente: nada é gravado e o webhook não mede. */
  registrarMedicao?: (assinaturaId: string, medicao: MedicaoDoNavegador) => Promise<void>;
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

const MSG_ESCOLHA_PLANO = "Escolha um dos planos: Inicial, Pro ou Escritório.";
export const MSG_ESCRITORIO_SO_MENSAL = "O plano Escritório é só mensal. Escolha a cobrança mensal.";

/** Escritório com ciclo anual: recusado antes de qualquer cupom ou chamada (Decisions "Faixas do Escritório"). */
function recusaAnualDoEscritorio(b: Record<string, unknown>): Resultado | null {
  return planoDeEscritorio(b.plano) && lerCiclo(b.ciclo) === "anual"
    ? erro(400, "ESCRITORIO_SO_MENSAL", MSG_ESCRITORIO_SO_MENSAL)
    : null;
}

/** Ciclo do pedido: ausente é mensal (páginas antigas); qualquer outro valor é inválido. */
export function lerCiclo(valor: unknown): Ciclo | null {
  if (valor === undefined || valor === null || valor === "" || valor === "mensal") return "mensal";
  return valor === "anual" ? "anual" : null;
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
  const plano = lerPlano(b.plano);
  if (!plano) return invalido(MSG_ESCOLHA_PLANO);
  const ciclo = lerCiclo(b.ciclo);
  if (!ciclo) return invalido("Escolha a cobrança: mensal ou anual.");
  if (ciclo === "anual" && planoDeEscritorio(plano)) return invalido(MSG_ESCRITORIO_SO_MENSAL);

  const cpf = typeof b.cpf === "string" ? b.cpf.replace(/\D/g, "") : "";
  if (cpf !== "" && cpf.length !== 11) return invalido("Confira o CPF (11 números).");

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

  return {
    ok: true,
    pedido: { plano, ciclo, ...(cpf ? { cpf } : {}), card_token: cardToken, endereco, aceite_texto: TEXTO_ACEITE_FISCAL },
  };
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
export function corpoAssinatura(
  pedido: Pedido,
  contexto: Contexto,
  planId: string,
  comTeste: boolean,
  cupom: CupomValido | null = null,
  diasDeTeste: number = DIAS_DE_TESTE,
) {
  const phones = telefonePagarme(contexto.phone_e164);
  return {
    plan_id: planId,
    ...(cupom ? { discounts: [descontoPagarme(cupom)] } : {}),
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
    metadata: {
      origem: "agente-fiscal",
      tenant_id: contexto.tenant_id,
      plano: pedido.plano,
      ciclo: pedido.ciclo,
      com_teste: comTeste,
      // Só o teste de 30 dias do cupom de fundador; o de 7 dias segue sem o campo, como antes.
      ...(comTeste && diasDeTeste !== DIAS_DE_TESTE ? { dias_de_teste: diasDeTeste } : {}),
      ...(cupom ? { cupom: cupom.codigo } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Cupons. A prévia (validar_cupom) e o checkout usam o mesmo cálculo; o checkout revalida no banco.

export type CupomValido = {
  codigo: string;
  descricao: string | null;
  tipo: "percentual" | "valor";
  valor: number;
  cortesia: boolean;
  ciclos: number | null;
  /** 30 no cupom de fundador do Escritório: o checkout usa o plano `_teste30` (o primeiro mês grátis). */
  diasDeTeste: number | null;
};

const MSG_CUPOM: Record<string, string> = {
  CUPOM_INVALIDO: "Cupom não encontrado. Confira o código.",
  CUPOM_VENCIDO: "Este cupom venceu.",
  CUPOM_ESGOTADO: "Este cupom já atingiu o limite de usos.",
  CUPOM_PLANO: "Este cupom não vale para o plano escolhido.",
  CUPOM_JA_USADO: "Sua empresa já usou este cupom.",
  CUPOM_NAO_CORTESIA: "Este cupom não dispensa o pagamento. Informe o cartão.",
  CUPOM_ANUAL: "O plano anual já tem 20% de desconto e não aceita cupom. Para usar o cupom, escolha o mensal.",
};

/** Código normalizado, null quando não veio, false quando veio fora do formato. */
export function lerCodigoCupom(valor: unknown): string | null | false {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor !== "string") return false;
  const codigo = valor.trim().toUpperCase();
  if (codigo === "") return null;
  return /^[A-Z0-9_-]{3,40}$/.test(codigo) ? codigo : false;
}

/** Mensalidade com o desconto, em centavos (o que a página mostra e o Pagar.me cobra). */
export function valorComDesconto(centavos: number, cupom: CupomValido): number {
  if (cupom.tipo === "percentual") return Math.max(0, Math.round(centavos * (100 - cupom.valor) / 100));
  return Math.max(0, centavos - cupom.valor);
}

/** Item de discounts da assinatura (docs.pagar.me, "Criar assinatura de plano").
    `cycles` com o teste do plano: o código não tem como provar se o Pagar.me conta o período de teste como um
    ciclo. O que se sabe daqui: o teste vem do plano (trial_period_days, sem start_at) e a assinatura só gera
    cobrança depois dele, então o esperado é que o 1º ciclo com desconto seja a 1ª cobrança após o teste. Os cupons
    de fundador do Escritório usam 12 ciclos nessa premissa (scripts/pagarme-assinatura/cupons-fundador-escritorio.sql);
    conferir na primeira assinatura de sandbox com cupom e teste (a fatura do 2º mês deve vir com o desconto). */
export function descontoPagarme(cupom: CupomValido): Record<string, unknown> {
  return {
    value: cupom.valor,
    discount_type: cupom.tipo === "percentual" ? "percentage" : "flat",
    ...(cupom.ciclos ? { cycles: cupom.ciclos } : {}),
  };
}

function erroCupom(motivo: string): Resultado {
  const codigo = motivo in MSG_CUPOM ? motivo : "CUPOM_INVALIDO";
  return erro(422, codigo, MSG_CUPOM[codigo]);
}

/** Lê o cupom no banco e confere contra o preço do plano. Valor fixo que zera a mensalidade não vale: cortesia é só 100%. */
async function avaliarCupom(
  deps: Deps,
  tenantId: string,
  codigo: string,
  plano: PlanoAssinatura,
): Promise<{ ok: true; cupom: CupomValido } | { ok: false; resultado: Resultado }> {
  if (!deps.validarCupom) return { ok: false, resultado: erroCupom("CUPOM_INVALIDO") };
  const r = await deps.validarCupom(tenantId, codigo, plano);
  if (!r || !r.ok || (r.tipo !== "percentual" && r.tipo !== "valor") || typeof r.valor !== "number") {
    return { ok: false, resultado: erroCupom(r?.motivo || "CUPOM_INVALIDO") };
  }
  const cupom: CupomValido = {
    codigo: r.codigo || codigo,
    descricao: r.descricao ?? null,
    tipo: r.tipo,
    valor: r.valor,
    cortesia: Boolean(r.cortesia),
    ciclos: typeof r.ciclos === "number" ? r.ciclos : null,
    // O teste de 30 dias só existe nos planos do Escritório; em Inicial e Pro o campo é ignorado.
    diasDeTeste: planoDeEscritorio(plano) && r.dias_de_teste === DIAS_DE_TESTE_DO_CUPOM ? DIAS_DE_TESTE_DO_CUPOM : null,
  };
  if (!cupom.cortesia && valorComDesconto(PLANOS_PAGARME[plano].centavos, cupom) < 100) {
    return { ok: false, resultado: erroCupom("CUPOM_PLANO") };
  }
  return { ok: true, cupom };
}

function cupomPublico(cupom: CupomValido, plano: PlanoAssinatura): Record<string, unknown> {
  const centavos = PLANOS_PAGARME[plano].centavos;
  return {
    codigo: cupom.codigo,
    descricao: cupom.descricao,
    tipo: cupom.tipo,
    valor: cupom.valor,
    cortesia: cupom.cortesia,
    ciclos: cupom.ciclos,
    valor_centavos: centavos,
    valor_centavos_com_desconto: cupom.cortesia ? 0 : valorComDesconto(centavos, cupom),
    // Só quando vale: a página mostra "1º mês grátis, depois R$ 247/mês no 1º ano" (FUNDADOR5).
    ...(cupom.diasDeTeste ? { dias_de_teste: cupom.diasDeTeste } : {}),
  };
}

/** POST assinatura-fiscal {acao:"validar_cupom", codigo, plano}: prévia da etapa de pagamento. Não consome o cupom. */
export async function processarValidarCupom(body: unknown, deps: Deps): Promise<Resultado> {
  const b = obj(body);
  const userId = await deps.sessao();
  if (!userId) return erro(401, "SEM_SESSAO", "Entre na sua conta para usar um cupom.");
  const plano = lerPlano(b.plano);
  if (!plano) return erro(400, "DADOS_INVALIDOS", MSG_ESCOLHA_PLANO);
  const soMensal = recusaAnualDoEscritorio(b);
  if (soMensal) return soMensal;
  const codigo = lerCodigoCupom(b.codigo);
  if (!codigo) return erroCupom("CUPOM_INVALIDO");
  // O anual já vem com desconto: cupom (cortesia inclusive) só no mensal.
  if (lerCiclo(b.ciclo) !== "mensal") return erroCupom("CUPOM_ANUAL");
  const contexto = await deps.contexto(userId);
  if (!contexto) return erro(403, "CONTA_SEM_EMPRESA", "Conclua o cadastro da empresa antes de usar um cupom.");
  const a = await avaliarCupom(deps, contexto.tenant_id, codigo, plano);
  if (!a.ok) return a.resultado;
  return { http: 200, body: { ok: true, cupom: cupomPublico(a.cupom, plano) } };
}

/** Pedido de cortesia: só plano e aceite; cartão e endereço não entram. */
function validarPedidoCortesia(b: Record<string, unknown>): { ok: true; plano: PlanoAssinatura } | { ok: false; mensagem: string } {
  if (CAMPOS_CARTAO.some((campo) => tem(b, campo))) {
    return invalido("Por segurança, os dados do cartão não passam por aqui. Recarregue a página e tente de novo.");
  }
  const plano = lerPlano(b.plano);
  if (!plano) return invalido(MSG_ESCOLHA_PLANO);
  if (b.termos_aceite !== true) return invalido("Para assinar, aceite os Termos de Uso.");
  const recebido = typeof b.aceite_texto === "string" ? normalizarTexto(b.aceite_texto) : "";
  if (recebido !== TEXTO_ACEITE_FISCAL) {
    return invalido("Não conseguimos registrar o seu aceite. Recarregue a página e tente de novo.");
  }
  return { ok: true, plano };
}

const MSG_PAGARME =
  "Não conseguimos concluir a assinatura com o sistema de pagamento agora. Tente de novo em alguns minutos.";

export async function processarCheckout(body: unknown, deps: Deps): Promise<Resultado> {
  const log = deps.log ?? (() => {});
  const agora = deps.agora ?? (() => new Date());
  const config = lerConfig(deps.env);
  const b = obj(body);
  const soMensal = recusaAnualDoEscritorio(b);
  if (soMensal) return soMensal;

  // Cupom: lido e revalidado aqui (a prévia da página não vale como prova). A cortesia termina neste
  // bloco: não é venda (vale com a venda fechada) e não passa pelo Pagar.me.
  const codigoCupom = lerCodigoCupom(b.cupom);
  if (codigoCupom === false) return erroCupom("CUPOM_INVALIDO");
  if (codigoCupom && lerCiclo(b.ciclo) !== "mensal") return erroCupom("CUPOM_ANUAL");
  let cupom: CupomValido | null = null;
  let sessaoLida: string | null | undefined;
  const sessao = async () => (sessaoLida === undefined ? (sessaoLida = await deps.sessao()) : sessaoLida);
  if (codigoCupom) {
    if (config.ambiente === "producao" && TEXTO_ACEITE_PROVISORIO) {
      log("error", "assinatura_fiscal_termos_provisorios", {});
      return erro(500, "TERMOS_PROVISORIOS", "A assinatura ainda não está aberta. Nada foi cobrado; volte em breve.");
    }
    const userId = await sessao();
    if (!userId) return erro(401, "SEM_SESSAO", "Entre na sua conta para assinar.");
    const plano = lerPlano(b.plano);
    if (!plano) return erro(400, "DADOS_INVALIDOS", MSG_ESCOLHA_PLANO);
    const contexto = await deps.contexto(userId);
    if (!contexto) return erro(403, "CONTA_SEM_EMPRESA", "Conclua o cadastro da conta e da empresa antes de assinar.");
    if (contexto.assinatura && contexto.assinatura.status !== "cancelada") {
      return erro(409, "ASSINATURA_EXISTENTE", "Esta empresa já tem uma assinatura.");
    }
    const a = await avaliarCupom(deps, contexto.tenant_id, codigoCupom, plano);
    if (!a.ok) return a.resultado;
    cupom = a.cupom;
    if (cupom.cortesia) return await processarCortesia(b, contexto, cupom, deps, log);
  }

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

  const userId = await sessao();
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

  // Escritório: três planos por faixa no Pagar.me. Sem os três ids da faixa, nada é reivindicado nem cobrado
  // (e Inicial/Pro seguem funcionando sem eles).
  const escritorio = planoDeEscritorio(pedido.plano) ? pedido.plano : null;
  let planoComTeste: string;
  let planoSemTeste: string;
  let planoTeste30 = "";
  if (escritorio) {
    if (!escritorioConfigurado(config, escritorio)) {
      log("warn", "assinatura_fiscal_escritorio_indisponivel", { plano: escritorio });
      return erro(
        409,
        "PLANO_INDISPONIVEL",
        "O plano Escritório ainda não está disponível para assinatura. Nada foi cobrado; fale com a nó pelo WhatsApp.",
      );
    }
    planoComTeste = config.planIds[codigoPagarmeEscritorio(escritorio, "teste")];
    planoSemTeste = config.planIds[codigoPagarmeEscritorio(escritorio, "sem_teste")];
    planoTeste30 = config.planIds[codigoPagarmeEscritorio(escritorio, "teste30")];
  } else {
    const plano = pedido.plano as CodigoPlano;
    planoComTeste = config.planIds[codigoPagarme(plano, pedido.ciclo, true)];
    planoSemTeste = config.planIds[codigoPagarme(plano, pedido.ciclo, false)];
    if (!planoComTeste || !planoSemTeste) {
      log("warn", "assinatura_fiscal_plano_indisponivel", { plano: pedido.plano, ciclo: pedido.ciclo });
      return erro(409, "PLANO_INDISPONIVEL", "Este plano não está disponível agora. Tente mais tarde.");
    }
  }

  // O par é escolhido por fiscal_trial_claims (Decided "Teste com cartão"). Só hash sai daqui.
  const hashes = await hashesDoTeste(
    { cpf: pedido.cpf, cnpj: contexto.cnpj, email: contexto.email, phone: contexto.phone_e164 },
    config.sal,
  ) as Record<string, string>;
  // Cupom de fundador do Escritório (dias_de_teste = 30): o plano `_teste30` dá o primeiro mês grátis, mesmo para
  // quem já usou o teste de 7 dias. A reivindicação ainda roda, para CNPJ, e-mail e telefone ficarem marcados como
  // "já teve teste" (um cadastro novo com eles não ganha outro teste de 7 dias).
  const testeDoCupom = Boolean(escritorio && cupom?.diasDeTeste === DIAS_DE_TESTE_DO_CUPOM);
  const reivindicou = await deps.reivindicarTeste(contexto.tenant_id, hashes);
  const comTeste = testeDoCupom || reivindicou;
  const diasDeTeste = testeDoCupom ? DIAS_DE_TESTE_DO_CUPOM : DIAS_DE_TESTE;
  // Anual sem teste cobra o ano inteiro na hora: só com a confirmação explícita da página. Quando a
  // reivindicação falha nada é gravado em fiscal_trial_claims, então repetir com a confirmação é seguro.
  if (!comTeste && pedido.ciclo === "anual" && b.confirmar_sem_teste !== true) {
    log("info", "assinatura_fiscal_anual_sem_teste_confirmar", { plano: pedido.plano });
    return {
      http: 409,
      body: {
        ok: false,
        error_code: "CONFIRMAR_SEM_TESTE",
        mensagem: `${MSG_TESTE_JA_USADO}. No anual, o ano inteiro é cobrado agora.`,
        valor_centavos: centavosDoCiclo(pedido.plano, "anual"),
      },
    };
  }
  const planId = testeDoCupom ? planoTeste30 : comTeste ? planoComTeste : planoSemTeste;

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
      body: JSON.stringify(corpoAssinatura(pedido, contexto, planId, comTeste, cupom, diasDeTeste)),
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
  const trialEndsAt = comTeste ? new Date(agora().getTime() + diasDeTeste * DIA_MS).toISOString() : null;
  const linha: LinhaAssinatura = {
    tenant_id: contexto.tenant_id,
    plano: pedido.plano,
    ciclo: pedido.ciclo,
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

  if (cupom && deps.usarCupom) {
    // O desconto já está no Pagar.me; uma falha aqui só fica no log (o uso deixa de contar).
    try {
      const uso = await deps.usarCupom(contexto.tenant_id, cupom.codigo, pedido.plano, subId);
      if (!uso?.ok) log("warn", "assinatura_fiscal_cupom_nao_registrado", { subscription_id: subId, motivo: uso?.motivo });
    } catch {
      log("error", "assinatura_fiscal_cupom_nao_registrado", { subscription_id: subId });
    }
  }

  const status = registro?.status || linha.status;
  log("info", "assinatura_fiscal_checkout", {
    plano: pedido.plano,
    ciclo: pedido.ciclo,
    com_teste: comTeste,
    dias_de_teste: comTeste ? diasDeTeste : 0,
    subscription_id: subId,
    status,
  });
  // A reconciliação pode trazer um aviso que chegou antes do registro.
  if (status === "recusada") {
    return erro(402, "PAGAMENTO_RECUSADO", "O pagamento não foi aprovado pelo cartão. Atualize o cartão para continuar.");
  }
  if (status === "cancelada") {
    return erro(409, "ASSINATURA_CANCELADA", "Esta assinatura foi cancelada no sistema de pagamento. Tente assinar de novo.");
  }
  // A assinatura já existe: uma falha aqui não muda a resposta (repetir o checkout daria 409).
  if (deps.marcarPago) {
    try {
      await deps.marcarPago(contexto.tenant_id);
    } catch {
      log("error", "assinatura_fiscal_marca_pago_falhou", { subscription_id: subId });
    }
  }
  // Medição (medicao.ts): o navegador repete este evento com o mesmo event_id; com consentimento, a CAPI também.
  const centavos = centavosDoCiclo(pedido.plano, pedido.ciclo);
  const compra = eventoDaCompra(registro.id, comTeste, cupom ? valorComDesconto(centavos, cupom) : centavos);
  const medicao = lerMedicao(b.medicao);
  // A assinatura já existe: uma falha aqui só fica no log (o webhook deixa de medir as cobranças dela).
  if (deps.registrarMedicao) {
    try {
      await deps.registrarMedicao(registro.id, medicao);
    } catch {
      log("error", "assinatura_fiscal_medicao_nao_gravada", { subscription_id: subId });
    }
  }
  if (medicao.consent === "granted" && deps.enviarMeta) {
    try {
      const corpo = await corpoDaCompraMeta(
        compra,
        { email: contexto.email, telefone: contexto.phone_e164, tenantId: contexto.tenant_id },
        medicao,
        deps.cliente ?? { ip: null, ua: null },
        agora(),
        deps.env.META_TEST_EVENT_CODE || undefined,
      );
      log("info", "assinatura_fiscal_capi", { evento: compra.evento, resultado: await deps.enviarMeta(corpo) });
    } catch {
      log("error", "assinatura_fiscal_capi", { evento: compra.evento, resultado: "erro_montagem" });
    }
  }
  return {
    http: 200,
    body: {
      ok: true,
      status,
      assinatura_id: registro.id,
      ciclo: pedido.ciclo,
      com_teste: comTeste,
      // Teste de 30 dias do cupom de fundador; o de 7 dias segue sem o campo.
      ...(testeDoCupom ? { dias_de_teste: diasDeTeste } : {}),
      medicao: compra,
      trial_ends_at: trialEndsAt,
      ...(comTeste ? {} : { aviso: MSG_TESTE_JA_USADO }),
      ...(cupom ? { cupom: cupomPublico(cupom, pedido.plano) } : {}),
    },
  };
}

/** Cortesia (cupom de 100%): sem Pagar.me, sem cartão e sem reivindicar o teste grátis. */
async function processarCortesia(
  b: Record<string, unknown>,
  contexto: Contexto,
  cupom: CupomValido,
  deps: Deps,
  log: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void,
): Promise<Resultado> {
  const v = validarPedidoCortesia(b);
  if (!v.ok) return erro(400, "DADOS_INVALIDOS", v.mensagem);
  if (!deps.registrarCortesia) return erroCupom("CUPOM_INVALIDO");
  const r = await deps.registrarCortesia(contexto.tenant_id, v.plano, cupom.codigo, TEXTO_ACEITE_FISCAL);
  if (!r || !r.ok) {
    if (r?.motivo === "ASSINATURA_EXISTENTE") return erro(409, "ASSINATURA_EXISTENTE", "Esta empresa já tem uma assinatura.");
    return erroCupom(r?.motivo || "CUPOM_INVALIDO");
  }
  log("info", "assinatura_fiscal_cortesia", { plano: v.plano, cupom: cupom.codigo });
  if (deps.marcarPago) {
    try {
      await deps.marcarPago(contexto.tenant_id);
    } catch {
      log("error", "assinatura_fiscal_marca_pago_falhou", { cortesia: true });
    }
  }
  return {
    http: 200,
    body: {
      ok: true,
      status: "paga",
      assinatura_id: r.id,
      cortesia: true,
      com_teste: false,
      trial_ends_at: null,
      cupom: cupomPublico(cupom, v.plano),
    },
  };
}
