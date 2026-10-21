// Regras determinísticas do relatório do auditor (spec 2026-10-21, seção 4).
// Todo número do relatório nasce aqui; a IA só redige a partir de `achados`.
// Sem Deno nem rede: testado pelo Vitest do app.

import type { MetricasPagas } from "../marketing/normalize.ts";
import type { CampanhaResumo } from "../marketing/meta.ts";
import type { Checagem } from "../../diagnostico-auditor/diagnostico.ts";

export const VERSAO_REGRAS = "r1";

// Limiares da r1. Mudar qualquer um = nova versão de regras.
export const LIMIARES = {
  gastoSemConversaoCentavos: 5_000, // R$ 50 no período
  variacaoCpa: 0.2, // ±20%
  frequenciaAlta: 4,
  impressoesMinFrequencia: 1_000,
  divergenciaGastoGa4: 0.1, // 10%
  variacaoGasto: 0.3,
  variacaoSessoes: 0.2,
} as const;

export type FonteId = "meta_ads" | "google_ads" | "ga4" | "gsc" | "site";
export type EstadoFonte = "ok" | "expirado" | "revogado" | "erro" | "sem_conexao" | "nao_escolhido" | "nao_disponivel";

export type Pago = { total: MetricasPagas; campanhas: CampanhaResumo[] };
export type Ga4 = {
  sessoes: number;
  eventos_chave: number;
  google_ads_segundo_ga4?: { gasto_centavos: number; cliques: number; impressoes: number };
};
export type Gsc = {
  cliques: number;
  impressoes: number;
  paginas_que_cresceram?: { chave: string; cliques: number; cliques_antes: number }[];
};
export type Site = { url: string; checagens: Checagem[] };

export type Fonte<T> = { estado: EstadoFonte; atual?: T; anterior?: T };

export type EntradaRegras = {
  periodo: { de: string; ate: string };
  anterior: { de: string; ate: string };
  meta_ads?: Fonte<Pago>;
  google_ads?: Fonte<Pago>;
  ga4?: Fonte<Ga4>;
  gsc?: Fonte<Gsc>;
  site?: Fonte<Site>;
};

export type Severidade = "alta" | "media" | "baixa" | "info";

export type Achado = {
  id: string;
  tipo: string;
  severidade: Severidade;
  fonte: FonteId;
  titulo: string;
  // Valores já formatados em pt-BR: são os únicos números que a redação pode citar.
  numeros: Record<string, string>;
  evidencia: string;
  acao: string;
};

export type ResultadoRegras = {
  versao: string;
  periodo: { de: string; ate: string; rotulo: string };
  fontes: Record<FonteId, EstadoFonte>;
  achados: Achado[];
  destaques: Record<string, string>;
};

// ------------------------------------------------------------- formatação

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const inteiro = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const umaCasa = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export const fmt = {
  reais: (centavos: number) => brl.format(centavos / 100).replace(/[\u00a0\u202f]/g, " "),
  inteiro: (n: number) => inteiro.format(n),
  pct: (fracao: number) => `${inteiro.format(Math.round(Math.abs(fracao) * 100))}%`,
  decimal: (n: number) => umaCasa.format(n),
  data: (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`,
};

function variacao(atual: number, anterior: number): number | null {
  if (!anterior) return null;
  return (atual - anterior) / anterior;
}

function cpa(m: MetricasPagas): number | null {
  return m.conversoes > 0 ? m.gasto_centavos / m.conversoes : null;
}

const ORDEM: Record<Severidade, number> = { alta: 0, media: 1, baixa: 2, info: 3 };
const NOME_FONTE: Record<FonteId, string> = {
  meta_ads: "Meta Ads", google_ads: "Google Ads", ga4: "Google Analytics", gsc: "Search Console", site: "site",
};

// --------------------------------------------------------------- regras

function regrasPagas(fonte: "meta_ads" | "google_ads", f: Fonte<Pago> | undefined, saida: Achado[]) {
  if (!f?.atual || f.estado !== "ok") return;
  const nome = NOME_FONTE[fonte];
  const { total, campanhas } = f.atual;

  for (const c of campanhas) {
    const m = c.metricas;
    if (m.gasto_centavos >= LIMIARES.gastoSemConversaoCentavos && m.conversoes === 0) {
      saida.push({
        id: `${fonte}:gasto_sem_conversao:${c.id}`,
        tipo: "gasto_sem_conversao", severidade: "alta", fonte,
        titulo: `Campanha "${c.nome}" gastou sem gerar conversão`,
        numeros: { gasto: fmt.reais(m.gasto_centavos), cliques: fmt.inteiro(m.cliques) },
        evidencia: `${nome}: ${fmt.reais(m.gasto_centavos)} gastos e ${fmt.inteiro(m.cliques)} cliques, nenhuma conversão registrada.`,
        acao: "Confira se a conversão está sendo medida nessa campanha; se estiver, revise público e anúncio antes de manter o orçamento.",
      });
    }
    if (fonte === "meta_ads" && m.alcance && m.impressoes >= LIMIARES.impressoesMinFrequencia) {
      const freq = m.impressoes / m.alcance;
      if (freq > LIMIARES.frequenciaAlta) {
        saida.push({
          id: `${fonte}:frequencia_alta:${c.id}`,
          tipo: "frequencia_alta", severidade: "media", fonte,
          titulo: `Campanha "${c.nome}" está mostrando o mesmo anúncio muitas vezes para as mesmas pessoas`,
          numeros: { frequencia: fmt.decimal(freq), alcance: fmt.inteiro(m.alcance) },
          evidencia: `Frequência de ${fmt.decimal(freq)} vezes por pessoa para ${fmt.inteiro(m.alcance)} pessoas alcançadas.`,
          acao: "Renove o criativo ou amplie o público para reduzir o cansaço do anúncio.",
        });
      }
    }
  }

  const anterior = f.anterior?.total;
  if (!anterior) return;
  const cpaAtual = cpa(total);
  const cpaAntes = cpa(anterior);
  if (cpaAtual !== null && cpaAntes !== null) {
    const v = variacao(cpaAtual, cpaAntes)!;
    if (Math.abs(v) >= LIMIARES.variacaoCpa) {
      const subiu = v > 0;
      saida.push({
        id: `${fonte}:cpa_${subiu ? "subiu" : "caiu"}`,
        tipo: subiu ? "cpa_subiu" : "cpa_caiu", severidade: subiu ? "media" : "info", fonte,
        titulo: `Custo por conversão no ${nome} ${subiu ? "subiu" : "caiu"}`,
        numeros: { cpa_atual: fmt.reais(cpaAtual), cpa_anterior: fmt.reais(cpaAntes), variacao: fmt.pct(v) },
        evidencia: `De ${fmt.reais(cpaAntes)} para ${fmt.reais(cpaAtual)} por conversão (${subiu ? "+" : "-"}${fmt.pct(v)}).`,
        acao: subiu
          ? "Veja quais campanhas puxaram o custo para cima e redistribua o orçamento para as que convertem mais barato."
          : "Mantenha o que mudou neste período e acompanhe se a queda se sustenta.",
      });
    }
  }
  const vg = variacao(total.gasto_centavos, anterior.gasto_centavos);
  if (vg !== null && Math.abs(vg) >= LIMIARES.variacaoGasto) {
    saida.push({
      id: `${fonte}:gasto_variou`,
      tipo: "gasto_variou", severidade: "info", fonte,
      titulo: `Investimento no ${nome} ${vg > 0 ? "aumentou" : "diminuiu"}`,
      numeros: { gasto_atual: fmt.reais(total.gasto_centavos), gasto_anterior: fmt.reais(anterior.gasto_centavos), variacao: fmt.pct(vg) },
      evidencia: `De ${fmt.reais(anterior.gasto_centavos)} para ${fmt.reais(total.gasto_centavos)} (${vg > 0 ? "+" : "-"}${fmt.pct(vg)}).`,
      acao: "Confirme se a mudança de investimento foi intencional.",
    });
  }
}

function regraDivergenciaGa4(entrada: EntradaRegras, saida: Achado[]) {
  const ads = entrada.google_ads;
  const ga4 = entrada.ga4;
  if (ads?.estado !== "ok" || ga4?.estado !== "ok" || !ads.atual || !ga4.atual?.google_ads_segundo_ga4) return;
  const gastoAds = ads.atual.total.gasto_centavos;
  const gastoGa4 = ga4.atual.google_ads_segundo_ga4.gasto_centavos;
  if (gastoAds <= 0) return;
  const diferenca = Math.abs(gastoAds - gastoGa4) / gastoAds;
  if (diferenca <= LIMIARES.divergenciaGastoGa4) return;
  saida.push({
    id: "ga4:divergencia_google_ads",
    tipo: "divergencia_google_ads_ga4", severidade: "media", fonte: "ga4",
    titulo: "O Google Analytics não enxerga todo o investimento do Google Ads",
    numeros: { gasto_google_ads: fmt.reais(gastoAds), gasto_no_ga4: fmt.reais(gastoGa4), diferenca: fmt.pct(diferenca) },
    evidencia: `Google Ads informa ${fmt.reais(gastoAds)}; o Analytics registra ${fmt.reais(gastoGa4)} (${fmt.pct(diferenca)} de diferença).`,
    acao: "Confira o vínculo entre Google Ads e Google Analytics e a importação de custos.",
  });
}

function regrasGa4(f: Fonte<Ga4> | undefined, saida: Achado[]) {
  if (f?.estado !== "ok" || !f.atual || !f.anterior) return;
  const v = variacao(f.atual.sessoes, f.anterior.sessoes);
  if (v === null || Math.abs(v) < LIMIARES.variacaoSessoes) return;
  saida.push({
    id: `ga4:sessoes_${v > 0 ? "subiram" : "cairam"}`,
    tipo: v > 0 ? "sessoes_subiram" : "sessoes_cairam", severidade: v > 0 ? "info" : "media", fonte: "ga4",
    titulo: `Visitas ao site ${v > 0 ? "aumentaram" : "caíram"}`,
    numeros: { sessoes: fmt.inteiro(f.atual.sessoes), sessoes_anterior: fmt.inteiro(f.anterior.sessoes), variacao: fmt.pct(v) },
    evidencia: `${fmt.inteiro(f.atual.sessoes)} sessões contra ${fmt.inteiro(f.anterior.sessoes)} no período anterior (${v > 0 ? "+" : "-"}${fmt.pct(v)}).`,
    acao: v > 0 ? "Veja no Analytics de qual canal veio o aumento." : "Veja no Analytics qual canal perdeu visitas.",
  });
}

function regrasGsc(f: Fonte<Gsc> | undefined, saida: Achado[]) {
  if (f?.estado !== "ok" || !f.atual) return;
  const top = f.atual.paginas_que_cresceram?.[0];
  if (!top || top.cliques <= top.cliques_antes) return;
  saida.push({
    id: "gsc:pagina_cresceu",
    tipo: "pagina_cresceu", severidade: "info", fonte: "gsc",
    titulo: "Uma página ganhou cliques no Google",
    numeros: { cliques: fmt.inteiro(top.cliques), cliques_antes: fmt.inteiro(top.cliques_antes) },
    evidencia: `${top.chave}: ${fmt.inteiro(top.cliques_antes)} → ${fmt.inteiro(top.cliques)} cliques orgânicos.`,
    acao: "Reforce essa página: atualize o conteúdo e use-a como destino de anúncios relacionados.",
  });
}

function regrasSite(f: Fonte<Site> | undefined, saida: Achado[]) {
  if (f?.estado !== "ok" || !f.atual) return;
  for (const c of f.atual.checagens) {
    if (c.status !== "problema" && c.status !== "atencao") continue;
    const essencial = ["https", "gtm", "ga4", "meta_pixel"].includes(c.id);
    saida.push({
      id: `site:${c.id}`,
      tipo: "site_checagem", severidade: c.status === "problema" ? (essencial ? "alta" : "media") : "baixa", fonte: "site",
      titulo: c.titulo, numeros: {}, evidencia: c.evidencia, acao: c.recomendacao,
    });
  }
}

function regrasFontes(fontes: Record<FonteId, EstadoFonte>, saida: Achado[]) {
  for (const [id, estado] of Object.entries(fontes) as [FonteId, EstadoFonte][]) {
    if (estado !== "expirado" && estado !== "revogado") continue;
    const provedor = id === "meta_ads" ? "Facebook" : "Google";
    saida.push({
      id: `fonte:${id}:${estado}`,
      tipo: "fonte_desconectada", severidade: "alta", fonte: id,
      titulo: `Reconecte o ${provedor} para ver ${NOME_FONTE[id]}`,
      numeros: {},
      evidencia: estado === "expirado" ? "O acesso expirou." : "O acesso foi removido na plataforma.",
      acao: `Clique em "Conectar com o ${provedor}" no seu painel.`,
    });
  }
}

// ---------------------------------------------------------------- motor

export function avaliar(entrada: EntradaRegras): ResultadoRegras {
  const fontes: Record<FonteId, EstadoFonte> = {
    meta_ads: entrada.meta_ads?.estado ?? "sem_conexao",
    google_ads: entrada.google_ads?.estado ?? "sem_conexao",
    ga4: entrada.ga4?.estado ?? "sem_conexao",
    gsc: entrada.gsc?.estado ?? "sem_conexao",
    site: entrada.site?.estado ?? "nao_disponivel",
  };
  const achados: Achado[] = [];
  regrasFontes(fontes, achados);
  regrasPagas("meta_ads", entrada.meta_ads, achados);
  regrasPagas("google_ads", entrada.google_ads, achados);
  regraDivergenciaGa4(entrada, achados);
  regrasGa4(entrada.ga4, achados);
  regrasGsc(entrada.gsc, achados);
  regrasSite(entrada.site, achados);
  achados.sort((a, b) => ORDEM[a.severidade] - ORDEM[b.severidade] || a.id.localeCompare(b.id));

  const destaques: Record<string, string> = {};
  if (entrada.meta_ads?.estado === "ok" && entrada.meta_ads.atual) {
    destaques.gasto_meta = fmt.reais(entrada.meta_ads.atual.total.gasto_centavos);
    destaques.conversoes_meta = fmt.inteiro(entrada.meta_ads.atual.total.conversoes);
  }
  if (entrada.google_ads?.estado === "ok" && entrada.google_ads.atual) {
    destaques.gasto_google = fmt.reais(entrada.google_ads.atual.total.gasto_centavos);
    destaques.conversoes_google = fmt.inteiro(entrada.google_ads.atual.total.conversoes);
  }
  if (entrada.ga4?.estado === "ok" && entrada.ga4.atual) destaques.sessoes = fmt.inteiro(entrada.ga4.atual.sessoes);
  if (entrada.gsc?.estado === "ok" && entrada.gsc.atual) destaques.cliques_organicos = fmt.inteiro(entrada.gsc.atual.cliques);

  return {
    versao: VERSAO_REGRAS,
    periodo: { ...entrada.periodo, rotulo: `${fmt.data(entrada.periodo.de)} a ${fmt.data(entrada.periodo.ate)}` },
    fontes,
    achados,
    destaques,
  };
}

// Estado do relatório a partir das fontes: 'parcial' se alguma fonte escolhida falhou ou se nada pago/analytics está conectado.
export function estadoFinal(r: ResultadoRegras): "pronto" | "parcial" {
  const contas: FonteId[] = ["meta_ads", "google_ads", "ga4", "gsc"];
  const falhou = contas.some((f) => ["expirado", "revogado", "erro"].includes(r.fontes[f]));
  const algumaOk = contas.some((f) => r.fontes[f] === "ok");
  return falhou || !algumaOk ? "parcial" : "pronto";
}
