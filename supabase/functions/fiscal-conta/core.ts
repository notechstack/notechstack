// Regras puras de "Minha conta" do Agente Fiscal (sem Deno.*, sem import por URL).
// Formas literais no Landing de .checks/agente-fiscal-v2.md: "`fiscal-conta`: forma", "`configurar`:
// validação e etapa", "Fim do período pago e cancelamento agendado", "Troca de cartão", "Troca de
// plano" e "Apagar conta" (lote B), e o "Contrato E → B" (lote E). Dado de cartão nunca passa por
// aqui: só o card_token. O banco é alcançado só pelas funções public.fiscal_* (deps).

import {
  type Ciclo,
  type CodigoPlano,
  centavosDoCiclo,
  enderecoPagarme,
  FAIXAS_ESCRITORIO,
  lerConfig,
  lerEndereco,
  lerPlano,
  type PlanoAssinatura,
  planoDeEscritorio,
  PLANOS_PAGARME,
} from "../assinatura-fiscal/core.ts";
import {
  cnpjValido,
  type Consulta,
  consultarCnpj,
  type ListaMunicipios,
  municipioAtendido,
  type Regime,
  soDigitos,
} from "../_shared/fiscal/cnpj.ts";

type Nivel = "info" | "warn" | "error";

export const ACOES = [
  "estado",
  "configurar",
  "trocar_cartao",
  "trocar_plano",
  "cancelar",
  "apagar_conta",
  // Conta Escritório (.design/agente-fiscal-escritorio.md, "Painel do escritório").
  "empresa_adicionar",
  "empresa_configurar",
  "empresa_ativar",
  "relatorio",
] as const;
export type Acao = typeof ACOES[number];

// Faixas do Escritório (Decisions "Faixas do Escritório"): empresas, notas e preço vêm de assinatura-fiscal
// (FAIXAS_ESCRITORIO, PLANOS_PAGARME), para o item da assinatura ter o mesmo nome e preço do checkout. Só mensal.

export { planoDeEscritorio };
export type PlanoDaConta = PlanoAssinatura;

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mesmos textos de fiscal-cadastro (core.ts), para a empresa adicionada pelo escritório.
export const MSG_CNPJ_INVALIDO = "CNPJ inválido. Confira os 14 números.";
export const MSG_NAO_ENCONTRADO = "Não encontramos este CNPJ na Receita Federal.";
export const MSG_INDISPONIVEL = "Não conseguimos confirmar o CNPJ na Receita Federal agora. Tente de novo em alguns minutos.";
export const MSG_FORA_DO_PADRAO =
  "Seu município ainda não emite pelo padrão nacional. Para empresas do Simples, só atendemos cidades que já usam o Emissor Nacional";
export const MSG_FORA_DO_SIMPLES =
  "O nó.fiscal atende MEI e empresas do Simples Nacional. Na Receita Federal, este CNPJ não está no Simples";

export const MSG_CNPJ_JA_CADASTRADO = "Este CNPJ já está cadastrado no nó.fiscal.";
export const MSG_OUTRA_FAMILIA =
  "A troca entre os planos Inicial/Pro e Escritório é feita com a nó. Fale com a gente pelo WhatsApp.";

export function msgLimiteEmpresas(limite: unknown): string {
  return `Seu plano permite até ${Number(limite) || 1} empresas.`;
}

const CAMPOS_CARTAO = ["card", "card_number", "number", "cvv", "holder_name", "exp_month", "exp_year"];

export const MSG_CARTAO_RECUSADO = "Cartão recusado. Tente outro cartão.";
const MSG_PAGARME = "Não conseguimos falar com o sistema de pagamento agora. Tente de novo em alguns minutos.";

/** O que public.fiscal_conta_estado devolve (com os campos internos). */
export type EstadoBanco = {
  tenant_id: string;
  onboarding_etapa: string;
  plano: string;
  empresa: Record<string, unknown>;
  assinatura: {
    id: string;
    status: string;
    com_teste: boolean;
    em_teste: boolean;
    trial_ends_at: string | null;
    cancelamento_agendado_para: string | null;
    cancelamento_origem: string | null;
    pagarme_subscription_id: string;
    periodo_fim: string | null;
    /** Desde a migração 20261103090000; ausente é mensal. */
    ciclo?: string | null;
  } | null;
  certificado: { subject: string; not_after: string } | null;
  fiscal: Record<string, unknown>;
};

type RespostaBanco = { ok: boolean; erro?: string; campo?: string; limite?: number; ativas?: number };

/** O que public.fiscal_escritorio_estado devolve (null fora do plano Escritório). */
export type EscritorioBanco = {
  escritorio_tenant_id: string;
  plano: string;
  max_empresas: number;
  empresas_ativas: number;
  notas_limite: number;
  notas_mes: number;
  empresas: Array<Record<string, unknown> & { tenant_id: string; regime?: string; principal?: boolean }>;
};

/** Argumentos de public.fiscal_empresa_adicionar (os dados do CNPJ vêm sempre da Receita). */
export type ArgsEmpresa = {
  cnpj: string;
  razao_social: string;
  codigo_municipio_ibge: string;
  cnae: string | null;
  regime: Regime;
  api_key_hash: string;
  ambiente: "producao_restrita" | "producao";
};

export type Deps = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Usuário da sessão Supabase, ou null. */
  sessao: () => Promise<string | null>;
  estado: (userId: string) => Promise<EstadoBanco | null>;
  configurar: (userId: string, dados: Record<string, unknown>) => Promise<RespostaBanco>;
  trocarPlano: (userId: string, plano: PlanoDaConta) => Promise<RespostaBanco>;
  /** public.fiscal_escritorio_estado. Ausente: a conta é tratada como Inicial/Pro. */
  escritorio?: (userId: string) => Promise<EscritorioBanco | null>;
  empresaAdicionar?: (userId: string, args: ArgsEmpresa) => Promise<RespostaBanco & { tenant_id?: string; reativada?: boolean }>;
  empresaConfigurar?: (userId: string, tenantId: string, dados: Record<string, unknown>) => Promise<RespostaBanco>;
  empresaAtivar?: (userId: string, tenantId: string, ativa: boolean) => Promise<RespostaBanco>;
  /** public.fiscal_relatorio; `mes` no formato AAAA-MM-01. */
  relatorio?: (userId: string, mes: string, tenantId: string | null) => Promise<Record<string, unknown>>;
  /** Lista de municípios do padrão nacional (a mesma de fiscal-cadastro). */
  municipios?: () => Promise<ListaMunicipios>;
  /** 32 bytes aleatórios; o sha256 deles vira api_key_hash e eles são descartados (como em fiscal-cadastro). */
  bytesAleatorios?: () => Uint8Array<ArrayBuffer>;
  agendarCancelamento: (
    userId: string,
    fimCiclo: string | null,
  ) => Promise<{ status: string; cancelamento_agendado_para?: string }>;
  apagarConta: (userId: string) => Promise<RespostaBanco>;
  /** Códigos da lista nacional (`codigos-servico.json`), ou null quando a lista não está à mão. */
  codigosServico?: () => Promise<Set<string> | null>;
  agora?: () => Date;
  log?: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void;
};

export type Resultado = { http: number; body: Record<string, unknown> };

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function erro(http: number, error_code: string, mensagem: string, extra: Record<string, unknown> = {}): Resultado {
  return { http, body: { ok: false, error_code, mensagem, ...extra } };
}

function invalido(campo: string, mensagem: string): Resultado {
  return erro(422, "DADOS_FISCAIS_INVALIDOS", mensagem, { campo });
}

/** Assinatura de cortesia (cupom de 100%, migração 20261025090000): não existe no Pagar.me. */
export function ehCortesia(subscriptionId: string | null | undefined): boolean {
  return typeof subscriptionId === "string" && subscriptionId.startsWith("cortesia_");
}

/** Ciclo da assinatura no estado do banco: só "anual" muda alguma coisa. */
export function cicloDaAssinatura(a: { ciclo?: string | null } | null | undefined): Ciclo {
  return a && a.ciclo === "anual" ? "anual" : "mensal";
}

/** Estado para a página (contrato E → B): sem ids do Pagar.me nem campos internos. */
export function estadoPublico(e: EstadoBanco): Record<string, unknown> {
  const a = e.assinatura;
  const cortesia = Boolean(a && ehCortesia(a.pagarme_subscription_id));
  return {
    ok: true,
    tenant_id: e.tenant_id,
    onboarding_etapa: e.onboarding_etapa,
    plano: e.plano,
    empresa: e.empresa,
    assinatura: a
      ? {
        status: a.status,
        com_teste: a.com_teste,
        trial_ends_at: a.trial_ends_at,
        periodo_fim: cortesia ? null : a.periodo_fim,
        cortesia,
        ciclo: cicloDaAssinatura(a),
        cancelamento_agendado_para: a.cancelamento_agendado_para,
      }
      : null,
    certificado: e.certificado ? { subject: e.certificado.subject, not_after: e.certificado.not_after } : null,
    fiscal: e.fiscal,
  };
}

// ---------------------------------------------------------------------------------------------
// Validação do configurar (critérios 16–18).

const RE_PERCENTUAL = /^\d{1,3}([.,]\d{1,2})?$/;
const RE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function lerPercentual(valor: unknown): string | null {
  let texto: string;
  if (typeof valor === "number") {
    if (!Number.isFinite(valor)) return null;
    texto = String(valor);
  } else if (typeof valor === "string") {
    texto = valor.trim();
  } else {
    return null;
  }
  if (!RE_PERCENTUAL.test(texto)) return null;
  const normalizado = texto.replace(",", ".");
  const n = Number(normalizado);
  if (!(n >= 0 && n <= 100)) return null;
  return normalizado;
}

type Configuracao = { dados: Record<string, unknown>; temResumo: boolean; temContador: boolean };

export async function validarConfiguracao(
  body: Record<string, unknown>,
  plano: string,
  codigos: Set<string> | null,
  regime: unknown = "simples",
): Promise<{ ok: true; config: Configuracao } | { ok: false; resultado: Resultado }> {
  const codigo = typeof body.codigo_servico_nacional === "string" ? body.codigo_servico_nacional.trim() : "";
  if (!/^\d{6}$/.test(codigo) || (codigos && !codigos.has(codigo))) {
    return {
      ok: false,
      resultado: invalido("codigo_servico_nacional", "Escolha um código de serviço da lista nacional (6 números)."),
    };
  }
  // MEI não informa o percentual do Simples na DPS (E0710): o campo não existe para ele.
  const mei = regime === "mei";
  const percentual = mei ? null : lerPercentual(body.p_tot_trib_sn);
  if (!mei && percentual === null) {
    return {
      ok: false,
      resultado: invalido("p_tot_trib_sn", "Informe o percentual de tributos do Simples entre 0 e 100, com até 2 casas."),
    };
  }

  const dados: Record<string, unknown> = { codigo_servico_nacional: codigo };
  if (!mei) dados.p_tot_trib_sn = percentual;
  const temContador = Object.hasOwn(body, "contador_email");
  const temResumo = Object.hasOwn(body, "resumo");
  const contador = temContador && body.contador_email !== null
    ? (typeof body.contador_email === "string" ? body.contador_email.trim() : undefined)
    : null;
  const resumo = temResumo ? body.resumo : undefined;

  // Plano antes do formato: no Inicial, contador e resumo não existem.
  if (plano !== "pro") {
    if (temResumo && resumo !== null) {
      return { ok: false, resultado: erro(403, "PLANO_SEM_RESUMO", "O resumo das notas é do plano Pro.") };
    }
    if (temContador && contador !== null && contador !== "") {
      return { ok: false, resultado: erro(403, "PLANO_SEM_CONTADOR", "O e-mail do contador é do plano Pro.") };
    }
  }

  if (temContador) {
    if (contador === undefined || (contador !== null && contador !== "" && (contador.length > 254 || !RE_EMAIL.test(contador)))) {
      return { ok: false, resultado: invalido("contador_email", "Confira o e-mail do contador.") };
    }
    dados.contador_email = contador === "" ? null : contador;
  }

  if (temResumo) {
    if (resumo === null) {
      dados.resumo = null;
    } else {
      const r = obj(resumo);
      const freq = r.frequencia;
      const dia = r.dia;
      const diaOk = typeof dia === "number" && Number.isInteger(dia) &&
        ((freq === "mensal" && dia >= 1 && dia <= 28) || (freq === "semanal" && dia >= 1 && dia <= 7));
      if (!diaOk) {
        return {
          ok: false,
          resultado: invalido("resumo", "Escolha Mensal com dia de 1 a 28 ou Semanal com o dia da semana."),
        };
      }
      dados.resumo = { frequencia: freq, dia };
    }
  }
  return { ok: true, config: { dados, temResumo, temContador } };
}

// ---------------------------------------------------------------------------------------------
// Pagar.me

type Gateway = {
  chamar: (metodo: string, caminho: string, corpo?: unknown) => Promise<{ ok: boolean; status: number; json: unknown }>;
};

function gateway(deps: Deps, apiUrl: string, secretKey: string): Gateway {
  const headers = { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${secretKey}:`)}` };
  return {
    async chamar(metodo, caminho, corpo) {
      const res = await deps.fetch(`${apiUrl}${caminho}`, {
        method: metodo,
        headers,
        ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
      });
      const json = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, json };
    },
  };
}

function caminhoAssinatura(id: string): string {
  return `/subscriptions/${encodeURIComponent(id)}`;
}

/** current_cycle.end_at da assinatura, se for uma data futura. */
export function fimDoCiclo(sub: unknown, agora: Date): string | null {
  const fim = obj(obj(sub).current_cycle).end_at;
  if (typeof fim !== "string") return null;
  const ms = Date.parse(fim);
  return Number.isNaN(ms) || ms <= agora.getTime() ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------------------------

export async function processarConta(metodo: string, body: unknown, deps: Deps): Promise<Resultado> {
  const log = deps.log ?? (() => {});
  const agora = deps.agora ?? (() => new Date());
  if (metodo !== "POST") return erro(405, "METHOD_NOT_ALLOWED", "Método não permitido.");

  const userId = await deps.sessao();
  if (!userId) return erro(401, "SEM_SESSAO", "Entre na sua conta para continuar.");

  const b = obj(body);
  const acao = typeof b.acao === "string" ? b.acao : "";
  if (!(ACOES as readonly string[]).includes(acao)) return erro(400, "ACAO_INVALIDA", "Ação desconhecida.");

  if (acao === "apagar_conta" && b.confirmacao !== "APAGAR") {
    return erro(422, "CONFIRMACAO_INVALIDA", "Para apagar a conta, digite APAGAR.");
  }

  const estado = await deps.estado(userId);
  if (!estado) return erro(403, "CONTA_SEM_EMPRESA", "Esta conta ainda não tem empresa. Comece o cadastro.");

  if (acao === "estado") return await publicar(userId, estado, deps);
  if (acao === "empresa_adicionar") return await adicionarEmpresa(userId, estado, b, deps, log);
  if (acao === "empresa_configurar") return await configurarEmpresa(userId, estado, b, deps, log);
  if (acao === "empresa_ativar") return await ativarEmpresa(userId, estado, b, deps, log);
  if (acao === "relatorio") return await relatorio(userId, b, deps, agora);

  if (acao === "configurar") {
    let codigos: Set<string> | null = null;
    try {
      codigos = deps.codigosServico ? await deps.codigosServico() : null;
    } catch {
      codigos = null;
    }
    if (!codigos) log("warn", "fiscal_conta_lista_codigos_indisponivel", {});
    const v = await validarConfiguracao(b, estado.plano, codigos, estado.empresa.regime);
    if (!v.ok) return v.resultado;
    const r = await deps.configurar(userId, v.config.dados);
    if (!r.ok) return resultadoDoBanco(r);
    log("info", "fiscal_conta_configurada", { tenant_id: estado.tenant_id, resumo: v.config.temResumo, contador: v.config.temContador });
    return await estadoAtual(userId, deps);
  }

  // Cortesia: nada no Pagar.me. O banco cancela na hora (nofiscal.agendar_cancelamento_com_fim).
  const ativa = estado.assinatura && estado.assinatura.status !== "cancelada" ? estado.assinatura : null;
  if (ativa && ehCortesia(ativa.pagarme_subscription_id)) {
    if (acao === "apagar_conta") {
      const r = await deps.apagarConta(userId);
      if (!r.ok) return resultadoDoBanco(r);
      log("info", "fiscal_conta_apagada", { tenant_id: estado.tenant_id, cortesia: true });
      return { http: 200, body: { ok: true } };
    }
    if (acao === "trocar_cartao") {
      return erro(409, "CORTESIA_SEM_CARTAO", "Sua assinatura é cortesia: não há cartão cadastrado.");
    }
    if (acao === "trocar_plano") {
      const troca = await conferirTroca(userId, estado, b.plano, deps);
      if (!troca.ok) return troca.resultado;
      const plano = troca.plano;
      if (plano === estado.plano) return await publicar(userId, estado, deps);
      const banco = await deps.trocarPlano(userId, plano);
      if (!banco.ok) return resultadoDoBanco(banco);
      log("info", "fiscal_conta_plano_trocado", { tenant_id: estado.tenant_id, plano, cortesia: true });
      return await estadoAtual(userId, deps);
    }
    const cancelada = await deps.agendarCancelamento(userId, null);
    if (cancelada.status !== "agendado") return erro(409, "SEM_ASSINATURA", "Esta empresa não tem assinatura ativa.");
    log("info", "fiscal_conta_cortesia_cancelada", { tenant_id: estado.tenant_id });
    return {
      http: 200,
      body: { ok: true, cancelada_agora: true, cancelamento_agendado_para: cancelada.cancelamento_agendado_para },
    };
  }

  // Daqui para baixo, o Pagar.me.
  const config = lerConfig(deps.env);
  if (!config.secretKey) {
    log("error", "fiscal_conta_config_ausente", {});
    return erro(500, "CONFIG_AUSENTE", "O sistema de pagamento está fora do ar agora. Tente mais tarde.");
  }
  if (config.ambiente === "sandbox" && !config.secretKey.startsWith("sk_test_")) {
    log("error", "fiscal_conta_chave_nao_sandbox", {});
    return erro(500, "CHAVE_NAO_SANDBOX", "O sistema de pagamento está em manutenção. Tente mais tarde.");
  }
  const pagarme = gateway(deps, config.apiUrl, config.secretKey);
  const sub = estado.assinatura && estado.assinatura.status !== "cancelada" ? estado.assinatura : null;

  const chamar = async (evento: string, metodoHttp: string, caminho: string, corpo?: unknown) => {
    try {
      const r = await pagarme.chamar(metodoHttp, caminho, corpo);
      if (!r.ok) log("error", evento, { tenant_id: estado.tenant_id, http_status: r.status });
      return r;
    } catch {
      log("error", evento, { tenant_id: estado.tenant_id, rede: true });
      return null;
    }
  };

  if (acao === "apagar_conta") {
    if (sub) {
      const r = await chamar("fiscal_conta_apagar_pagarme_falhou", "DELETE", caminhoAssinatura(sub.pagarme_subscription_id), {
        cancel_pending_invoices: true,
      });
      if (!r || !r.ok) {
        return erro(502, "PAGARME_FALHOU", "Não conseguimos cancelar a assinatura agora, então nada foi apagado. Tente de novo em alguns minutos.");
      }
    }
    const r = await deps.apagarConta(userId);
    if (!r.ok) return resultadoDoBanco(r);
    log("info", "fiscal_conta_apagada", { tenant_id: estado.tenant_id, assinatura_cancelada: Boolean(sub) });
    return { http: 200, body: { ok: true } };
  }

  if (!sub) return erro(409, "SEM_ASSINATURA", "Esta empresa não tem assinatura ativa.");

  if (acao === "trocar_cartao") {
    if (CAMPOS_CARTAO.some((campo) => Object.hasOwn(b, campo))) {
      return erro(400, "DADOS_INVALIDOS", "Por segurança, os dados do cartão não passam por aqui. Recarregue a página e tente de novo.");
    }
    const cardToken = typeof b.card_token === "string" ? b.card_token : "";
    if (!cardToken.startsWith("token_")) {
      return erro(400, "DADOS_INVALIDOS", "Não conseguimos ler o cartão. Confira os dados do cartão e tente de novo.");
    }
    let card: Record<string, unknown> | undefined;
    if (b.endereco !== undefined && b.endereco !== null) {
      const endereco = lerEndereco(b.endereco);
      if (!endereco) return erro(400, "DADOS_INVALIDOS", "Confira o endereço de cobrança do cartão.");
      card = { billing_address: enderecoPagarme(endereco) };
    }
    const r = await chamar("fiscal_conta_cartao_pagarme_falhou", "PATCH", `${caminhoAssinatura(sub.pagarme_subscription_id)}/payment-method`, {
      payment_method: "credit_card",
      card_token: cardToken,
      ...(card ? { card } : {}),
    });
    if (!r || r.status >= 500) return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    if (!r.ok) return erro(402, "CARTAO_RECUSADO", MSG_CARTAO_RECUSADO);
    log("info", "fiscal_conta_cartao_trocado", { tenant_id: estado.tenant_id });
    return { http: 200, body: { ok: true } };
  }

  if (acao === "trocar_plano") {
    const troca = await conferirTroca(userId, estado, b.plano, deps);
    if (!troca.ok) return troca.resultado;
    const plano = troca.plano;
    if (plano === estado.plano) return await publicar(userId, estado, deps);
    if (sub.cancelamento_agendado_para) {
      return erro(409, "CANCELAMENTO_AGENDADO", "A assinatura já tem cancelamento agendado. O plano não pode mudar.");
    }
    // No anual o PUT do item só mudaria o preço da renovação, e a franquia mudaria na hora (ano pago
    // de Inicial com franquia Pro, ou Pro pago sem crédito). Até existir troca com proporcional: com a equipe.
    if (cicloDaAssinatura(sub) === "anual") {
      return erro(409, "TROCA_ANUAL_INDISPONIVEL", "No plano anual, a troca de plano é feita com a nó. Fale com a gente pelo WhatsApp.");
    }
    const itens = await chamar("fiscal_conta_plano_itens_falhou", "GET", `${caminhoAssinatura(sub.pagarme_subscription_id)}/items`);
    if (!itens || !itens.ok) return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    const lista = Array.isArray(obj(itens.json).data) ? obj(itens.json).data as unknown[] : [];
    const item = lista.map(obj).find((i) => i.status === "active" && typeof i.id === "string");
    if (!item) {
      log("error", "fiscal_conta_plano_sem_item", { tenant_id: estado.tenant_id });
      return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    }
    const ciclo = cicloDaAssinatura(sub);
    // Escritório: só mensal (o anual já saiu acima); nome e preço do plano no Pagar.me (assinatura-fiscal).
    const nome = PLANOS_PAGARME[plano].nome;
    const preco = centavosDoCiclo(plano, ciclo);
    const r = await chamar(
      "fiscal_conta_plano_pagarme_falhou",
      "PUT",
      `${caminhoAssinatura(sub.pagarme_subscription_id)}/items/${encodeURIComponent(String(item.id))}`,
      {
        name: nome,
        description: `Assinatura ${nome} · nó tech stack`,
        quantity: 1,
        pricing_scheme: { scheme_type: "unit", price: preco },
      },
    );
    if (!r || !r.ok) return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    const banco = await deps.trocarPlano(userId, plano);
    if (!banco.ok) return resultadoDoBanco(banco);
    log("info", "fiscal_conta_plano_trocado", { tenant_id: estado.tenant_id, plano, ciclo });
    return await estadoAtual(userId, deps);
  }

  // cancelar
  if (sub.cancelamento_agendado_para) {
    return {
      http: 200,
      body: { ok: true, cancelada_agora: false, cancelamento_agendado_para: sub.cancelamento_agendado_para },
    };
  }
  if (sub.em_teste) {
    const agendado = await deps.agendarCancelamento(userId, null);
    if (agendado.status !== "agendado") return erro(409, "SEM_ASSINATURA", "Esta empresa não tem assinatura ativa.");
    const r = await chamar("fiscal_conta_cancelar_pagarme_falhou", "DELETE", caminhoAssinatura(sub.pagarme_subscription_id), {
      cancel_pending_invoices: true,
    });
    if (!r || !r.ok) {
      return erro(
        502,
        "PAGARME_FALHOU",
        "Não conseguimos cancelar no sistema de pagamento agora. O cancelamento ficou pedido e sai nos próximos minutos; nada será cobrado.",
      );
    }
    log("info", "fiscal_conta_cancelada_no_teste", { tenant_id: estado.tenant_id });
    return {
      http: 200,
      body: { ok: true, cancelada_agora: true, cancelamento_agendado_para: agendado.cancelamento_agendado_para },
    };
  }

  // Fora do teste: o fim do ciclo vem do Pagar.me; sem ele, o banco deriva.
  let fimCiclo: string | null = null;
  const lido = await chamar("fiscal_conta_ciclo_pagarme_falhou", "GET", caminhoAssinatura(sub.pagarme_subscription_id));
  if (lido && lido.ok) fimCiclo = fimDoCiclo(lido.json, agora());
  const agendado = await deps.agendarCancelamento(userId, fimCiclo);
  if (agendado.status !== "agendado") return erro(409, "SEM_ASSINATURA", "Esta empresa não tem assinatura ativa.");
  log("info", "fiscal_conta_cancelamento_agendado", {
    tenant_id: estado.tenant_id,
    fonte: fimCiclo ? "pagarme" : "banco",
    cancelamento_agendado_para: agendado.cancelamento_agendado_para,
  });
  return {
    http: 200,
    body: { ok: true, cancelada_agora: false, cancelamento_agendado_para: agendado.cancelamento_agendado_para },
  };
}

async function estadoAtual(userId: string, deps: Deps): Promise<Resultado> {
  const e = await deps.estado(userId);
  if (!e) return erro(403, "CONTA_SEM_EMPRESA", "Esta conta ainda não tem empresa. Comece o cadastro.");
  return await publicar(userId, e, deps);
}

/** Estado da página; no plano Escritório, com `escritorio` (empresas, situações, limites e uso do mês). */
async function publicar(userId: string, e: EstadoBanco, deps: Deps): Promise<Resultado> {
  const body = estadoPublico(e);
  // Só o Escritório consulta a função: conta Inicial/Pro não depende dela.
  if (planoDeEscritorio(e.plano) && deps.escritorio) {
    const escritorio = await deps.escritorio(userId);
    if (escritorio) body.escritorio = escritorio;
  }
  return { http: 200, body };
}

// ---------------------------------------------------------------------------------------------
// Conta Escritório: empresas e relatório.

const MSG_SEM_EMPRESAS = "Cadastrar várias empresas é do plano Escritório.";

function limiteNaTroca(ativas: number, limite: number): Resultado {
  return erro(
    409,
    "EMPRESAS_ACIMA_DO_LIMITE",
    `Você tem ${ativas} empresas ativas, e esta faixa permite até ${limite}. Desative empresas antes de trocar.`,
    { ativas, limite },
  );
}

/** Plano pedido em trocar_plano: Inicial ↔ Pro ou entre as faixas do Escritório, nunca entre as famílias. */
async function conferirTroca(
  userId: string,
  estado: EstadoBanco,
  plano: unknown,
  deps: Deps,
): Promise<{ ok: true; plano: PlanoDaConta } | { ok: false; resultado: Resultado }> {
  const escritorio = planoDeEscritorio(estado.plano);
  const pedido = lerPlano(plano);
  if (!pedido) {
    return {
      ok: false,
      resultado: erro(
        400,
        "DADOS_INVALIDOS",
        escritorio ? "Escolha uma das faixas: até 5, 20 ou 50 empresas." : "Escolha um dos planos: Inicial ou Pro.",
      ),
    };
  }
  if (planoDeEscritorio(pedido) !== escritorio) {
    return { ok: false, resultado: erro(409, "PLANO_DE_OUTRA_FAMILIA", MSG_OUTRA_FAMILIA) };
  }
  // Antes do Pagar.me: uma faixa menor que as empresas ativas não chega a mudar o preço.
  if (planoDeEscritorio(pedido) && pedido !== estado.plano && deps.escritorio) {
    const esc = await deps.escritorio(userId);
    const ativas = Number(esc?.empresas_ativas ?? 0);
    const limite = FAIXAS_ESCRITORIO[pedido].empresas;
    if (ativas > limite) return { ok: false, resultado: limiteNaTroca(ativas, limite) };
  }
  return { ok: true, plano: pedido };
}

// Nenhuma empresa entra sem a Receita confirmar o CNPJ (mesma regra e mesmos textos de fiscal-cadastro).
function respostaConsulta(c: Consulta): Resultado | null {
  if (c.ok) return null;
  if (c.motivo === "nao_encontrado") return erro(404, "CNPJ_NAO_ENCONTRADO", MSG_NAO_ENCONTRADO, { campo: "cnpj" });
  if (c.motivo === "inativo") {
    const situacao = c.situacao.toLowerCase();
    return erro(
      422,
      "CNPJ_INATIVO",
      `Este CNPJ está com situação ${situacao} na Receita Federal. Só empresas ativas podem emitir notas.`,
      { campo: "cnpj" },
    );
  }
  if (c.motivo === "fora_do_simples") return erro(422, "CNPJ_FORA_DO_SIMPLES", MSG_FORA_DO_SIMPLES, { campo: "cnpj" });
  return erro(503, "CONSULTA_INDISPONIVEL", MSG_INDISPONIVEL);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

function tenantDoCorpo(b: Record<string, unknown>): string | null {
  return typeof b.tenant_id === "string" && RE_UUID.test(b.tenant_id) ? b.tenant_id.toLowerCase() : null;
}

async function adicionarEmpresa(
  userId: string,
  estado: EstadoBanco,
  b: Record<string, unknown>,
  deps: Deps,
  log: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void,
): Promise<Resultado> {
  if (!deps.empresaAdicionar || !planoDeEscritorio(estado.plano)) return erro(403, "PLANO_SEM_EMPRESAS", MSG_SEM_EMPRESAS);
  const cnpj = soDigitos(b.cnpj);
  if (!cnpjValido(cnpj)) return erro(422, "CNPJ_INVALIDO", MSG_CNPJ_INVALIDO, { campo: "cnpj" });

  // O que dá para responder sem a Receita: empresa já na lista e limite da faixa.
  const esc = deps.escritorio ? await deps.escritorio(userId) : null;
  if (esc) {
    const existente = esc.empresas.find((e) => e.cnpj === cnpj);
    if (existente && existente.ativa !== false) {
      return erro(409, "CNPJ_JA_CADASTRADO", "Esta empresa já está em Minhas empresas.", { campo: "cnpj" });
    }
    if (Number(esc.empresas_ativas) >= Number(esc.max_empresas)) {
      return erro(409, "EMPRESAS_ACIMA_DO_LIMITE", msgLimiteEmpresas(esc.max_empresas), { limite: Number(esc.max_empresas) });
    }
  }

  // Razão social, município, CNAE e regime vêm sempre da consulta, nunca do corpo.
  const c = await consultarCnpj(cnpj, { apiUrl: deps.env.CNPJ_API_URL, fetch: deps.fetch });
  const recusa = respostaConsulta(c);
  if (recusa || !c.ok) {
    if (!c.ok) log("info", "fiscal_conta_empresa_consulta", { motivo: c.motivo });
    return recusa!;
  }
  if (!municipioAtendido(c.dados, deps.municipios ? await deps.municipios() : null)) {
    return erro(422, "MUNICIPIO_FORA_DO_PADRAO", MSG_FORA_DO_PADRAO, { campo: "cnpj" });
  }

  // Chave de API como no cadastro: 32 bytes aleatórios, só o sha256 fica.
  const bytes = deps.bytesAleatorios ? deps.bytesAleatorios() : crypto.getRandomValues(new Uint8Array(32));
  const ambiente = deps.env.FISCAL_AMBIENTE_PADRAO === "producao" ? "producao" : "producao_restrita";
  let res: RespostaBanco & { tenant_id?: string; reativada?: boolean };
  try {
    res = await deps.empresaAdicionar(userId, {
      cnpj,
      razao_social: c.dados.razao_social,
      codigo_municipio_ibge: c.dados.codigo_municipio_ibge,
      cnae: c.dados.cnae,
      regime: c.dados.regime,
      api_key_hash: await sha256Hex(bytes),
      ambiente,
    });
  } finally {
    bytes.fill(0);
  }
  if (!res.ok) return resultadoDoBanco(res);
  log("info", "fiscal_conta_empresa_adicionada", {
    escritorio_tenant_id: estado.tenant_id,
    tenant_id: res.tenant_id,
    reativada: Boolean(res.reativada),
    regime: c.dados.regime,
  });
  const atual = await estadoAtual(userId, deps);
  if (atual.http !== 200) return atual;
  return { http: 200, body: { ...atual.body, adicionada: { tenant_id: res.tenant_id, reativada: Boolean(res.reativada) } } };
}

async function configurarEmpresa(
  userId: string,
  estado: EstadoBanco,
  b: Record<string, unknown>,
  deps: Deps,
  log: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void,
): Promise<Resultado> {
  if (!deps.empresaConfigurar) return erro(403, "PLANO_SEM_EMPRESAS", MSG_SEM_EMPRESAS);
  const tenantId = tenantDoCorpo(b);
  if (!tenantId) return erro(400, "DADOS_INVALIDOS", "Escolha a empresa.");

  // O regime decide se o percentual do Simples existe (MEI não informa, E0710).
  let regime: unknown;
  if (tenantId === String(estado.tenant_id).toLowerCase()) {
    regime = estado.empresa.regime;
  } else {
    const esc = deps.escritorio ? await deps.escritorio(userId) : null;
    const empresa = esc?.empresas.find((e) => String(e.tenant_id).toLowerCase() === tenantId);
    if (!empresa) return erro(403, "FORBIDDEN", "Esta empresa não é da sua conta.");
    regime = empresa.regime;
  }

  let codigos: Set<string> | null = null;
  try {
    codigos = deps.codigosServico ? await deps.codigosServico() : null;
  } catch {
    codigos = null;
  }
  if (!codigos) log("warn", "fiscal_conta_lista_codigos_indisponivel", {});
  // Só código e percentual: contador e resumo continuam sendo da conta (`configurar`).
  const v = await validarConfiguracao(
    { codigo_servico_nacional: b.codigo_servico_nacional, p_tot_trib_sn: b.p_tot_trib_sn },
    "pro",
    codigos,
    regime,
  );
  if (!v.ok) return v.resultado;
  const r = await deps.empresaConfigurar(userId, tenantId, v.config.dados);
  if (!r.ok) return resultadoDoBanco(r);
  log("info", "fiscal_conta_empresa_configurada", { tenant_id: tenantId });
  return await estadoAtual(userId, deps);
}

async function ativarEmpresa(
  userId: string,
  estado: EstadoBanco,
  b: Record<string, unknown>,
  deps: Deps,
  log: (nivel: Nivel, evento: string, dados?: Record<string, unknown>) => void,
): Promise<Resultado> {
  if (!deps.empresaAtivar || !planoDeEscritorio(estado.plano)) return erro(403, "PLANO_SEM_EMPRESAS", MSG_SEM_EMPRESAS);
  const tenantId = tenantDoCorpo(b);
  if (!tenantId) return erro(400, "DADOS_INVALIDOS", "Escolha a empresa.");
  if (typeof b.ativa !== "boolean") return erro(400, "DADOS_INVALIDOS", "Diga se a empresa fica ativa ou desativada.");
  const r = await deps.empresaAtivar(userId, tenantId, b.ativa);
  if (!r.ok) return resultadoDoBanco(r);
  log("info", "fiscal_conta_empresa_ativa", { tenant_id: tenantId, ativa: b.ativa });
  return await estadoAtual(userId, deps);
}

const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

/** AAAA-MM do mês corrente no fuso de Brasília. */
export function mesAtual(agora: Date): string {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit" }).formatToParts(agora)) {
    p[x.type] = x.value;
  }
  return `${p.year}-${p.month}`;
}

async function relatorio(
  userId: string,
  b: Record<string, unknown>,
  deps: Deps,
  agora: () => Date,
): Promise<Resultado> {
  if (!deps.relatorio) return erro(400, "ACAO_INVALIDA", "Ação desconhecida.");
  const mes = b.mes === undefined || b.mes === null || b.mes === "" ? mesAtual(agora()) : b.mes;
  if (typeof mes !== "string" || !RE_MES.test(mes)) return erro(400, "DADOS_INVALIDOS", "Escolha o mês do relatório (AAAA-MM).");
  let tenantId: string | null = null;
  if (b.tenant_id !== undefined && b.tenant_id !== null && b.tenant_id !== "") {
    tenantId = tenantDoCorpo(b);
    if (!tenantId) return erro(400, "DADOS_INVALIDOS", "Escolha a empresa.");
  }
  const r = obj(await deps.relatorio(userId, `${mes}-01`, tenantId));
  if (r.ok !== true) return resultadoDoBanco(r as RespostaBanco);
  return {
    http: 200,
    body: {
      ok: true,
      mes: typeof r.mes === "string" ? r.mes : mes,
      tenant_id: tenantId,
      totais: obj(r.totais),
      notas: Array.isArray(r.notas) ? r.notas : [],
    },
  };
}

function resultadoDoBanco(r: RespostaBanco): Resultado {
  switch (r.erro) {
    case "EMPRESAS_ACIMA_DO_LIMITE":
      return typeof r.ativas === "number"
        ? limiteNaTroca(r.ativas, Number(r.limite))
        : erro(409, "EMPRESAS_ACIMA_DO_LIMITE", msgLimiteEmpresas(r.limite), { limite: Number(r.limite) });
    case "PLANO_DE_OUTRA_FAMILIA":
      return erro(409, "PLANO_DE_OUTRA_FAMILIA", MSG_OUTRA_FAMILIA);
    case "PLANO_SEM_EMPRESAS":
      return erro(403, "PLANO_SEM_EMPRESAS", MSG_SEM_EMPRESAS);
    case "CNPJ_JA_CADASTRADO":
      return erro(409, "CNPJ_JA_CADASTRADO", MSG_CNPJ_JA_CADASTRADO, { campo: "cnpj" });
    case "EMPRESA_PRINCIPAL":
      return erro(409, "EMPRESA_PRINCIPAL", "A empresa do próprio escritório não pode ser desativada.");
    case "FORBIDDEN":
      return erro(403, "FORBIDDEN", "Esta empresa não é da sua conta.");
    case "PLANO_SEM_RESUMO":
      return erro(403, "PLANO_SEM_RESUMO", "O resumo das notas é do plano Pro.");
    case "PLANO_SEM_CONTADOR":
      return erro(403, "PLANO_SEM_CONTADOR", "O e-mail do contador é do plano Pro.");
    case "DADOS_FISCAIS_INVALIDOS":
      return invalido(r.campo || "codigo_servico_nacional", "Confira os dados fiscais.");
    case "SEM_ASSINATURA":
      return erro(409, "SEM_ASSINATURA", "Esta empresa não tem assinatura ativa.");
    default:
      return erro(403, "CONTA_SEM_EMPRESA", "Esta conta ainda não tem empresa. Comece o cadastro.");
  }
}
