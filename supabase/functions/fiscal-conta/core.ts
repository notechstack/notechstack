// Regras puras de "Minha conta" do Agente Fiscal (sem Deno.*, sem import por URL).
// Formas literais no Landing de .checks/agente-fiscal-v2.md: "`fiscal-conta`: forma", "`configurar`:
// validação e etapa", "Fim do período pago e cancelamento agendado", "Troca de cartão", "Troca de
// plano" e "Apagar conta" (lote B), e o "Contrato E → B" (lote E). Dado de cartão nunca passa por
// aqui: só o card_token. O banco é alcançado só pelas funções public.fiscal_* (deps).

import { type CodigoPlano, lerConfig, lerEndereco, enderecoPagarme, PLANOS_PAGARME } from "../assinatura-fiscal/core.ts";

type Nivel = "info" | "warn" | "error";

export const ACOES = ["estado", "configurar", "trocar_cartao", "trocar_plano", "cancelar", "apagar_conta"] as const;
export type Acao = typeof ACOES[number];

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
  } | null;
  certificado: { subject: string; not_after: string } | null;
  fiscal: Record<string, unknown>;
};

type RespostaBanco = { ok: boolean; erro?: string; campo?: string };

export type Deps = {
  env: Record<string, string | undefined>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Usuário da sessão Supabase, ou null. */
  sessao: () => Promise<string | null>;
  estado: (userId: string) => Promise<EstadoBanco | null>;
  configurar: (userId: string, dados: Record<string, unknown>) => Promise<RespostaBanco>;
  trocarPlano: (userId: string, plano: CodigoPlano) => Promise<RespostaBanco>;
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
): Promise<{ ok: true; config: Configuracao } | { ok: false; resultado: Resultado }> {
  const codigo = typeof body.codigo_servico_nacional === "string" ? body.codigo_servico_nacional.trim() : "";
  if (!/^\d{6}$/.test(codigo) || (codigos && !codigos.has(codigo))) {
    return {
      ok: false,
      resultado: invalido("codigo_servico_nacional", "Escolha um código de serviço da lista nacional (6 números)."),
    };
  }
  const percentual = lerPercentual(body.p_tot_trib_sn);
  if (percentual === null) {
    return {
      ok: false,
      resultado: invalido("p_tot_trib_sn", "Informe o percentual de tributos do Simples entre 0 e 100, com até 2 casas."),
    };
  }

  const dados: Record<string, unknown> = { codigo_servico_nacional: codigo, p_tot_trib_sn: percentual };
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

  if (acao === "estado") return { http: 200, body: estadoPublico(estado) };

  if (acao === "configurar") {
    let codigos: Set<string> | null = null;
    try {
      codigos = deps.codigosServico ? await deps.codigosServico() : null;
    } catch {
      codigos = null;
    }
    if (!codigos) log("warn", "fiscal_conta_lista_codigos_indisponivel", {});
    const v = await validarConfiguracao(b, estado.plano, codigos);
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
      const plano = b.plano;
      if (plano !== "inicial" && plano !== "pro") return erro(400, "DADOS_INVALIDOS", "Escolha um dos planos: Inicial ou Pro.");
      if (plano === estado.plano) return { http: 200, body: estadoPublico(estado) };
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
    const plano = b.plano;
    if (plano !== "inicial" && plano !== "pro") return erro(400, "DADOS_INVALIDOS", "Escolha um dos planos: Inicial ou Pro.");
    if (plano === estado.plano) return { http: 200, body: estadoPublico(estado) };
    if (sub.cancelamento_agendado_para) {
      return erro(409, "CANCELAMENTO_AGENDADO", "A assinatura já tem cancelamento agendado. O plano não pode mudar.");
    }
    const itens = await chamar("fiscal_conta_plano_itens_falhou", "GET", `${caminhoAssinatura(sub.pagarme_subscription_id)}/items`);
    if (!itens || !itens.ok) return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    const lista = Array.isArray(obj(itens.json).data) ? obj(itens.json).data as unknown[] : [];
    const item = lista.map(obj).find((i) => i.status === "active" && typeof i.id === "string");
    if (!item) {
      log("error", "fiscal_conta_plano_sem_item", { tenant_id: estado.tenant_id });
      return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    }
    const p = PLANOS_PAGARME[plano];
    const r = await chamar(
      "fiscal_conta_plano_pagarme_falhou",
      "PUT",
      `${caminhoAssinatura(sub.pagarme_subscription_id)}/items/${encodeURIComponent(String(item.id))}`,
      {
        name: p.nome,
        description: `Assinatura ${p.nome} · nó tech stack`,
        quantity: 1,
        pricing_scheme: { scheme_type: "unit", price: p.centavos },
      },
    );
    if (!r || !r.ok) return erro(502, "PAGARME_FALHOU", MSG_PAGARME);
    const banco = await deps.trocarPlano(userId, plano);
    if (!banco.ok) return resultadoDoBanco(banco);
    log("info", "fiscal_conta_plano_trocado", { tenant_id: estado.tenant_id, plano });
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
  return { http: 200, body: estadoPublico(e) };
}

function resultadoDoBanco(r: RespostaBanco): Resultado {
  switch (r.erro) {
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
