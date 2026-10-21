// Processamento dos relatórios do auditor (spec 2026-10-21, seção 4; plan, passo 4).
// Por relatório: coleta (atual + anterior) → snapshots → regras → redação → e-mail.
// Orquestração pura: rede, banco e IA entram por `ProcessarDeps` (testável no Vitest do app).

import type { CampanhaResumo } from "../marketing/meta.ts";
import type { MetricasPagas } from "../marketing/normalize.ts";
import { emailAviso, emailRelatorio, type Email, type TipoAviso } from "./email.ts";
import { redigir, type GeradorIa } from "./redacao.ts";
import { avaliar, estadoFinal, VERSAO_REGRAS, type EntradaRegras, type EstadoFonte, type Fonte, type FonteId, type Ga4, type Gsc, type Pago, type Site } from "./regras.ts";

export type RelatorioFila = { id: string; client_id: string; tipo: "retrospectiva" | "semanal" | "mensal"; periodo_de: string; periodo_ate: string; tentativas: number };
export type NegocioEnvio = { client_id: string; nome: string; site_url: string | null; dono_email: string | null };
export type AtivoColeta = { tipo: "meta_ads" | "google_ads" | "ga4" | "gsc"; external_id: string; login_customer_id: string | null };
export type ConexaoEstado = { provedor: "meta" | "google"; estado: string };
export type Aviso = { id: string; client_id: string; tipo: TipoAviso; referencia: string };
export type PeriodoColeta = { de: string; ate: string; dias: number };

// Erro de uma fonte: `expirado` = a plataforma recusou o token (a conexão já foi marcada); `erro` = falha passageira.
export class ErroFonte extends Error {
  constructor(readonly estado: "expirado" | "erro") {
    super(estado);
  }
}

export type Ga4Coleta = Ga4 & { por_canal?: { canal: string; sessoes: number; eventos_chave: number }[] };
export type PagoColeta = { total: MetricasPagas; campanhas: CampanhaResumo[] };

export type Coletores = {
  meta_ads(clientId: string, a: AtivoColeta, p: PeriodoColeta, comCampanhas: boolean): Promise<PagoColeta>;
  google_ads(clientId: string, a: AtivoColeta, p: PeriodoColeta, comCampanhas: boolean): Promise<PagoColeta>;
  ga4(clientId: string, a: AtivoColeta, p: PeriodoColeta): Promise<Ga4Coleta>;
  gsc(clientId: string, a: AtivoColeta, p: PeriodoColeta): Promise<Gsc>;
};

export type ProcessarStore = {
  claim(limite: number): Promise<RelatorioFila[]>;
  negocio(clientId: string): Promise<NegocioEnvio | null>;
  ativos(clientId: string): Promise<AtivoColeta[]>;
  conexoes(clientId: string): Promise<ConexaoEstado[]>;
  snapshot(l: { client_id: string; tipo: FonteId; external_id: string; periodo_de: string; periodo_ate: string; dados: unknown }): Promise<void>;
  atualizar(id: string, patch: Record<string, unknown>): Promise<void>;
  falha(id: string, erro: string, transitorio: boolean): Promise<string>;
  avisosPendentes(limite: number): Promise<Aviso[]>;
  avisoEnviado(id: string): Promise<void>;
  evento(clientId: string, acao: string, detalhe: Record<string, unknown>): Promise<void>;
};

export type ProcessarDeps = {
  store: ProcessarStore;
  coletar: Coletores;
  site: (url: string) => Promise<Site | null>;
  gerar: GeradorIa | null;
  enviar: (para: string, email: Email) => Promise<string>;
  appUrl: string;
  log: (nivel: "info" | "warn" | "error", evento: string, dados?: Record<string, unknown>) => void;
};

export const LIMITE_RELATORIOS = 3;
export const LIMITE_AVISOS = 20;
const MAX_TENTATIVAS = 3;

function addDias(data: string, dias: number): string {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function periodos(de: string, ate: string): { atual: PeriodoColeta; anterior: PeriodoColeta } {
  const dias = Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000) + 1;
  return { atual: { de, ate, dias }, anterior: { de: addDias(de, -dias), ate: addDias(de, -1), dias } };
}

// Snapshot enxuto: o normalizado do período, sem diário bruto; campanhas só as 10 de maior gasto.
function enxugarPago(d: PagoColeta) {
  return { total: d.total, campanhas: [...d.campanhas].sort((a, b) => b.metricas.gasto_centavos - a.metricas.gasto_centavos).slice(0, 10) };
}

type Resultado<T> = { estado: EstadoFonte; atual?: T; anterior?: T };

async function coletarFonte<T>(ler: () => Promise<{ atual: T; anterior?: T }>): Promise<Resultado<T>> {
  try {
    const r = await ler();
    return { estado: "ok", ...r };
  } catch (e) {
    return { estado: e instanceof ErroFonte ? e.estado : "erro" };
  }
}

export async function processarRelatorio(r: RelatorioFila, deps: ProcessarDeps): Promise<"enviado" | "parcial" | "pronto" | "agendado" | "falhou"> {
  const { store } = deps;
  const negocio = await store.negocio(r.client_id);
  if (!negocio) {
    await store.atualizar(r.id, { estado: "pulado", erro: "negocio_inexistente" });
    return "falhou";
  }
  const { atual, anterior } = periodos(r.periodo_de, r.periodo_ate);
  const [ativos, conexoes] = await Promise.all([store.ativos(r.client_id), store.conexoes(r.client_id)]);
  const ativo = (t: AtivoColeta["tipo"]) => ativos.find((a) => a.tipo === t) ?? null;
  const conexao = (p: "meta" | "google") => conexoes.find((c) => c.provedor === p && c.estado !== "desconectado") ?? null;
  // Sem conta escolhida: diz se falta conectar ou só escolher (e se a conexão caiu).
  const semAtivo = (p: "meta" | "google"): EstadoFonte => {
    const c = conexao(p);
    if (!c) return "sem_conexao";
    if (c.estado === "expirado" || c.estado === "revogado") return c.estado as EstadoFonte;
    return "nao_escolhido";
  };

  await store.atualizar(r.id, { estado: "coletando" });
  const meta = ativo("meta_ads");
  const ads = ativo("google_ads");
  const ga4 = ativo("ga4");
  const gsc = ativo("gsc");
  const [rMeta, rAds, rGa4, rGsc, rSite] = await Promise.all([
    meta ? coletarFonte(async () => ({ atual: await deps.coletar.meta_ads(r.client_id, meta, atual, true), anterior: await deps.coletar.meta_ads(r.client_id, meta, anterior, false) })) : Promise.resolve({ estado: semAtivo("meta") } as Resultado<PagoColeta>),
    ads ? coletarFonte(async () => ({ atual: await deps.coletar.google_ads(r.client_id, ads, atual, true), anterior: await deps.coletar.google_ads(r.client_id, ads, anterior, false) })) : Promise.resolve({ estado: semAtivo("google") } as Resultado<PagoColeta>),
    ga4 ? coletarFonte(async () => ({ atual: await deps.coletar.ga4(r.client_id, ga4, atual), anterior: await deps.coletar.ga4(r.client_id, ga4, anterior) })) : Promise.resolve({ estado: semAtivo("google") } as Resultado<Ga4Coleta>),
    gsc ? coletarFonte(async () => ({ atual: await deps.coletar.gsc(r.client_id, gsc, atual) })) : Promise.resolve({ estado: semAtivo("google") } as Resultado<Gsc>),
    negocio.site_url
      ? deps.site(negocio.site_url).then((s): Resultado<Site> => (s ? { estado: "ok", atual: s } : { estado: "erro" }), (): Resultado<Site> => ({ estado: "erro" }))
      : Promise.resolve({ estado: "nao_disponivel" } as Resultado<Site>),
  ]);

  // Falha passageira numa fonte escolhida: tenta de novo mais tarde; na última tentativa segue parcial.
  const passageira = [rMeta, rAds, rGa4, rGsc].some((x) => x.estado === "erro");
  if (passageira && r.tentativas < MAX_TENTATIVAS) {
    return (await store.falha(r.id, "fonte_indisponivel", true)) as "agendado" | "falhou";
  }

  // Snapshots (atual e anterior): reproduzem os números depois que o token expirar.
  const gravar = async (tipo: FonteId, externalId: string | undefined, res: Resultado<unknown>, enxugar: (d: never) => unknown = (d) => d) => {
    if (res.estado !== "ok" || !externalId) return;
    if (res.atual !== undefined) await store.snapshot({ client_id: r.client_id, tipo, external_id: externalId, periodo_de: atual.de, periodo_ate: atual.ate, dados: enxugar(res.atual as never) });
    if (res.anterior !== undefined) await store.snapshot({ client_id: r.client_id, tipo, external_id: externalId, periodo_de: anterior.de, periodo_ate: anterior.ate, dados: enxugar(res.anterior as never) });
  };
  await gravar("meta_ads", meta?.external_id, rMeta, enxugarPago as (d: never) => unknown);
  await gravar("google_ads", ads?.external_id, rAds, enxugarPago as (d: never) => unknown);
  await gravar("ga4", ga4?.external_id, rGa4);
  await gravar("gsc", gsc?.external_id, rGsc);
  await gravar("site", negocio.site_url ?? undefined, rSite);

  const entrada: EntradaRegras = {
    periodo: { de: atual.de, ate: atual.ate },
    anterior: { de: anterior.de, ate: anterior.ate },
    meta_ads: rMeta as Fonte<Pago>,
    google_ads: rAds as Fonte<Pago>,
    ga4: rGa4 as Fonte<Ga4>,
    gsc: rGsc as Fonte<Gsc>,
    site: rSite as Fonte<Site>,
  };
  await store.atualizar(r.id, { estado: "gerando" });
  const resultado = avaliar(entrada);
  const { narrativa, uso } = await redigir(resultado, deps.gerar);
  const final = estadoFinal(resultado);
  await store.atualizar(r.id, {
    estado: final, fontes: resultado.fontes, achados: resultado.achados, narrativa,
    modelo: uso?.modelo ?? null, versao_regras: VERSAO_REGRAS, uso, gerado_em: new Date().toISOString(), erro: null,
  });

  if (!negocio.dono_email) return final;
  const email = emailRelatorio({
    tipo: r.tipo, negocio: negocio.nome, resultado, narrativa,
    urlRelatorio: `${deps.appUrl}/auditor/${r.client_id}/relatorios/${r.id}`,
    urlConexoes: `${deps.appUrl}/auditor/${r.client_id}/conexoes`,
  });
  try {
    const emailId = await deps.enviar(negocio.dono_email, email);
    await store.atualizar(r.id, { estado: final === "pronto" ? "enviado" : "parcial", enviado_em: new Date().toISOString(), email_id: emailId });
    await store.evento(r.client_id, "relatorio_enviado", { relatorio_id: r.id, tipo: r.tipo, estado: final });
    return final === "pronto" ? "enviado" : "parcial";
  } catch (e) {
    const transitorio = !(e instanceof Error && e.message === "resend_recusou");
    deps.log("warn", "auditor_relatorio_email_falhou", { relatorio_id: r.id, transitorio });
    return (await store.falha(r.id, "email_falhou", transitorio)) as "agendado" | "falhou";
  }
}

export async function enviarAvisos(deps: ProcessarDeps): Promise<number> {
  const avisos = await deps.store.avisosPendentes(LIMITE_AVISOS);
  let n = 0;
  for (const a of avisos) {
    const negocio = await deps.store.negocio(a.client_id);
    if (!negocio?.dono_email) { await deps.store.avisoEnviado(a.id); continue; }
    const provedor = a.referencia.startsWith("google:") ? "google" : a.referencia.startsWith("meta:") ? "meta" : null;
    try {
      await deps.enviar(negocio.dono_email, emailAviso({ tipo: a.tipo, negocio: negocio.nome, provedor, urlConexoes: `${deps.appUrl}/auditor/${a.client_id}/conexoes` }));
      await deps.store.avisoEnviado(a.id);
      n++;
    } catch {
      deps.log("warn", "auditor_aviso_falhou", { aviso_id: a.id });
    }
  }
  return n;
}

// Uma chamada do cron: até 3 relatórios e 20 avisos. Erro inesperado num relatório não derruba os outros.
export async function processarFila(deps: ProcessarDeps): Promise<{ relatorios: Record<string, number>; avisos: number }> {
  const fila = await deps.store.claim(LIMITE_RELATORIOS);
  const contagem: Record<string, number> = {};
  for (const r of fila) {
    let estado: string;
    try {
      estado = await processarRelatorio(r, deps);
    } catch (e) {
      deps.log("error", "auditor_relatorio_erro", { relatorio_id: r.id, erro: e instanceof Error ? e.name : "erro" });
      estado = await deps.store.falha(r.id, "erro_interno", true).catch(() => "falhou");
    }
    contagem[estado] = (contagem[estado] ?? 0) + 1;
  }
  const avisos = await enviarAvisos(deps);
  return { relatorios: contagem, avisos };
}
