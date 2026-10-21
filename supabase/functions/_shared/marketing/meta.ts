// Adaptador Meta do hub: Ads (leitura e escrita), orgânico IG/FB e publicação.
// Reaproveita o cliente Graph de abril (`metaFetch`). Escritas rodam sem retry,
// porque repetir um POST de criação duplica o objeto na conta.

import { GRAPH_BASE, MetaApiError, extractMetaError, metaFetch } from "../meta.ts";
import { Registro, mensagemMeta, tentar } from "./estados.ts";
import {
  type MetaInsightRow,
  type MetricasPagas,
  type Periodo,
  addDias,
  inteiro,
  parseMetaInsight,
} from "./normalize.ts";

export { mensagemMeta };

export const META_PIXEL_ID = "1753619075655271";

export type MetaCtx = {
  token: string;
  adAccountId?: string | null;
  pageId?: string | null;
  igUserId?: string | null;
};

export class MetaEscritaError extends Error {
  readonly externalIds: Record<string, string>;
  constructor(message: string, externalIds: Record<string, string>) {
    super(message);
    this.externalIds = externalIds;
  }
}

function exigir<T>(valor: T | null | undefined, nome: string): T {
  if (valor === null || valor === undefined || valor === "") throw new Error(`Ativo Meta não configurado: ${nome}`);
  return valor;
}

function timeRange(p: Periodo): string {
  return JSON.stringify({ since: p.de, until: p.ate });
}

export async function paginar<T>(path: string, params: Record<string, string | undefined>, limitePaginas = 5): Promise<T[]> {
  const itens: T[] = [];
  let resp = await metaFetch<{ data?: T[]; paging?: { next?: string } }>(path, params);
  itens.push(...(resp.data ?? []));
  let paginas = 1;
  while (resp.paging?.next && paginas < limitePaginas) {
    resp = await metaFetch<{ data?: T[]; paging?: { next?: string } }>(resp.paging.next, {});
    itens.push(...(resp.data ?? []));
    paginas += 1;
  }
  return itens;
}

const CAMPOS_INSIGHT = "spend,impressions,reach,clicks,inline_link_clicks,actions";

// ------------------------------------------------------------------ Leitura

export type ContaMeta = {
  id: string;
  moeda: string | null;
  fuso: string | null;
  versao_api: string | null;
};

export type MetaResumo = {
  total: MetricasPagas;
  por_dia: ({ dia: string } & MetricasPagas)[];
  conta: ContaMeta;
};

// Moeda, fuso e versão vêm da Graph a cada leitura, nunca de constante do app.
// A versão é o cabeçalho `facebook-api-version`, que a Graph manda em toda
// resposta; `metaFetch` só devolve o corpo, por isso o fetch é direto aqui.
export async function metaConta(ctx: MetaCtx): Promise<ContaMeta> {
  const conta = exigir(ctx.adAccountId, "conta de anúncios");
  const url = new URL(`${GRAPH_BASE}/${conta}`);
  url.searchParams.set("fields", "id,currency,timezone_name");
  url.searchParams.set("access_token", ctx.token);
  const resp = await fetch(url.toString());
  const corpo = await resp.json().catch(() => ({})) as { id?: string; currency?: string; timezone_name?: string };
  if (!resp.ok) throw new MetaApiError(resp.status, corpo, extractMetaError(corpo) ?? `Meta API ${resp.status}`);
  return {
    id: corpo.id ?? conta,
    moeda: corpo.currency ?? null,
    fuso: corpo.timezone_name ?? null,
    versao_api: resp.headers.get("facebook-api-version"),
  };
}

// Alcance não soma entre dias: o total vem de uma chamada sem quebra diária.
export async function metaResumo(ctx: MetaCtx, p: Periodo, reg = new Registro()): Promise<MetaResumo> {
  const conta = exigir(ctx.adAccountId, "conta de anúncios");
  const [total, diario, dadosConta] = await Promise.all([
    metaFetch<{ data?: MetaInsightRow[] }>(`/${conta}/insights`, {
      access_token: ctx.token, level: "account", time_range: timeRange(p), fields: CAMPOS_INSIGHT,
    }),
    paginar<MetaInsightRow>(`/${conta}/insights`, {
      access_token: ctx.token, level: "account", time_range: timeRange(p), time_increment: "1",
      fields: CAMPOS_INSIGHT, limit: "100",
    }),
    tentar(reg, ["conta"], () => metaConta(ctx)),
  ]);
  const vazio = parseMetaInsight({});
  const porDia = new Map(diario.map((r) => [r.date_start ?? "", parseMetaInsight(r)]));
  const dias: ({ dia: string } & MetricasPagas)[] = [];
  for (let d = p.de; d <= p.ate; d = addDias(d, 1)) dias.push({ dia: d, ...(porDia.get(d) ?? { ...vazio, alcance: 0, cliques_link: 0 }) });
  return {
    total: total.data?.[0] ? parseMetaInsight(total.data[0]) : { ...vazio, alcance: 0, cliques_link: 0 },
    por_dia: dias,
    conta: dadosConta ?? { id: conta, moeda: null, fuso: null, versao_api: null },
  };
}

export type CampanhaResumo = {
  plataforma: "meta" | "google";
  id: string;
  nome: string;
  status: string;
  status_efetivo: string | null;
  objetivo: string | null;
  orcamento_diario_centavos: number | null;
  orcamento_total_centavos: number | null;
  metricas: MetricasPagas;
};

type MetaCampanhaApi = {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  start_time?: string;
  stop_time?: string;
  created_time?: string;
};

export async function metaCampanhas(ctx: MetaCtx, p: Periodo): Promise<CampanhaResumo[]> {
  const conta = exigir(ctx.adAccountId, "conta de anúncios");
  const [campanhas, insights] = await Promise.all([
    paginar<MetaCampanhaApi>(`/${conta}/campaigns`, {
      access_token: ctx.token,
      fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time",
      limit: "100",
    }),
    paginar<MetaInsightRow>(`/${conta}/insights`, {
      access_token: ctx.token, level: "campaign", time_range: timeRange(p),
      fields: `campaign_id,${CAMPOS_INSIGHT}`, limit: "500",
    }),
  ]);
  const porCampanha = new Map(insights.map((r) => [r.campaign_id ?? "", parseMetaInsight(r)]));
  const vazio = parseMetaInsight({});
  return campanhas
    .filter((c) => c.status !== "DELETED" && c.status !== "ARCHIVED")
    .map((c) => ({
      plataforma: "meta" as const,
      id: c.id,
      nome: c.name,
      status: c.status,
      status_efetivo: c.effective_status ?? null,
      objetivo: c.objective ?? null,
      orcamento_diario_centavos: c.daily_budget ? inteiro(c.daily_budget) : null,
      orcamento_total_centavos: c.lifetime_budget ? inteiro(c.lifetime_budget) : null,
      metricas: porCampanha.get(c.id) ?? vazio,
    }));
}

export async function metaCampanhaDetalhe(ctx: MetaCtx, id: string, p: Periodo) {
  const [campanha, conjuntos, anuncios, insights] = await Promise.all([
    metaFetch<MetaCampanhaApi>(`/${id}`, {
      access_token: ctx.token,
      fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,created_time",
    }),
    paginar<Record<string, unknown>>(`/${id}/adsets`, {
      access_token: ctx.token,
      fields: "id,name,status,effective_status,daily_budget,lifetime_budget,start_time,end_time,optimization_goal,targeting",
      limit: "50",
    }),
    paginar<Record<string, unknown>>(`/${id}/ads`, {
      access_token: ctx.token,
      fields: "id,name,status,effective_status,adset_id,creative{id,title,body,thumbnail_url}",
      limit: "50",
    }),
    metaFetch<{ data?: MetaInsightRow[] }>(`/${id}/insights`, {
      access_token: ctx.token, time_range: timeRange(p), fields: CAMPOS_INSIGHT,
    }),
  ]);
  return {
    plataforma: "meta" as const,
    campanha: {
      id: campanha.id,
      nome: campanha.name,
      status: campanha.status,
      status_efetivo: campanha.effective_status ?? null,
      objetivo: campanha.objective ?? null,
      inicio: campanha.start_time ?? null,
      fim: campanha.stop_time ?? null,
    },
    metricas: insights.data?.[0] ? parseMetaInsight(insights.data[0]) : parseMetaInsight({}),
    conjuntos: conjuntos.map((c) => ({
      id: String(c.id),
      nome: String(c.name ?? ""),
      status: String(c.status ?? ""),
      status_efetivo: c.effective_status ? String(c.effective_status) : null,
      orcamento_diario_centavos: c.daily_budget ? inteiro(c.daily_budget) : null,
      orcamento_total_centavos: c.lifetime_budget ? inteiro(c.lifetime_budget) : null,
      inicio: c.start_time ? String(c.start_time) : null,
      fim: c.end_time ? String(c.end_time) : null,
      otimizacao: c.optimization_goal ? String(c.optimization_goal) : null,
    })),
    anuncios: anuncios.map((a) => {
      const criativo = (a.creative ?? {}) as { id?: string; title?: string; body?: string; thumbnail_url?: string };
      return {
        id: String(a.id),
        nome: String(a.name ?? ""),
        status: String(a.status ?? ""),
        status_efetivo: a.effective_status ? String(a.effective_status) : null,
        conjunto_id: a.adset_id ? String(a.adset_id) : null,
        titulo: criativo.title ?? null,
        texto: criativo.body ?? null,
        miniatura: criativo.thumbnail_url ?? null,
      };
    }),
  };
}

export async function metaSugerirLocais(ctx: MetaCtx, q: string) {
  const resp = await metaFetch<{ data?: { key: string; name: string; type: string; region?: string; country_code?: string }[] }>(
    "/search",
    {
      access_token: ctx.token, type: "adgeolocation", q, country_code: "BR",
      location_types: JSON.stringify(["city", "region"]), limit: "10",
    },
  );
  return (resp.data ?? []).map((l) => ({
    key: l.key,
    nome: l.region ? `${l.name} (${l.region})` : l.name,
    tipo: l.type === "region" ? "regiao" : "cidade",
  }));
}

// ------------------------------------------------------------------ Orgânico

type Valor = { value?: number; end_time?: string };
type Metrica = { name: string; values?: Valor[]; total_value?: { value?: number } };

function unix(data: string, fimDoDia = false): string {
  const d = new Date(`${data}T${fimDoDia ? "23:59:59" : "00:00:00"}-03:00`);
  return String(Math.floor(d.getTime() / 1000));
}

// A API de insights do IG aceita no máximo 30 dias por chamada.
function janelas(p: Periodo, tamanho = 30): { de: string; ate: string }[] {
  const lista: { de: string; ate: string }[] = [];
  for (let de = p.de; de <= p.ate; de = addDias(de, tamanho)) {
    const ate = addDias(de, tamanho - 1);
    lista.push({ de, ate: ate > p.ate ? p.ate : ate });
  }
  return lista;
}

export type PostOrganico = {
  id: string;
  rede: "instagram" | "facebook";
  data: string;
  tipo: string;
  texto: string;
  link: string | null;
  alcance: number | null;
  visualizacoes: number | null;
  interacoes: number | null;
  curtidas: number | null;
  comentarios: number | null;
  compartilhamentos: number | null;
};

const IG_METRICAS_CONTA = ["reach", "views", "accounts_engaged", "total_interactions"] as const;

// Chave de `estados` de cada métrica de conta do IG (nome do campo devolvido).
const IG_CAMPO: Record<(typeof IG_METRICAS_CONTA)[number], string> = {
  reach: "alcance", views: "visualizacoes", accounts_engaged: "contas_engajadas", total_interactions: "interacoes",
};
const IG_CAMPOS_POST = ["posts.alcance", "posts.visualizacoes", "posts.interacoes", "posts.compartilhamentos"];

export async function instagramOrganico(ctx: MetaCtx, p: Periodo, reg = new Registro()) {
  const ig = exigir(ctx.igUserId, "conta do Instagram");
  const perfil = await metaFetch<{ followers_count?: number; media_count?: number; username?: string }>(`/${ig}`, {
    access_token: ctx.token, fields: "followers_count,media_count,username",
  });

  const totais: Record<string, number | null> = Object.fromEntries(IG_METRICAS_CONTA.map((m) => [m, 0]));
  const partes = janelas(p);
  for (const j of partes) {
    const resp = await tentar(reg, Object.values(IG_CAMPO), () => metaFetch<{ data?: Metrica[] }>(`/${ig}/insights`, {
      access_token: ctx.token, metric: IG_METRICAS_CONTA.join(","), metric_type: "total_value", period: "day",
      since: unix(j.de), until: unix(j.ate, true),
    }), `janela ${j.de}..${j.ate}`);
    for (const m of IG_METRICAS_CONTA) {
      const valor = resp?.data?.find((d) => d.name === m)?.total_value?.value;
      totais[m] = valor === undefined || totais[m] === null ? null : (totais[m] ?? 0) + valor;
    }
  }

  const midias = await tentar(reg, ["posts"], () => paginar<{
    id: string; caption?: string; media_type?: string; media_product_type?: string; timestamp?: string;
    permalink?: string; like_count?: number; comments_count?: number;
  }>(`/${ig}/media`, {
    access_token: ctx.token,
    fields: "id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count",
    since: unix(p.de), until: unix(p.ate, true), limit: "50",
  }, 2)) ?? [];
  const noPeriodo = midias.filter((m) => {
    const dia = m.timestamp ? new Date(new Date(m.timestamp).getTime() - 3 * 3600_000).toISOString().slice(0, 10) : "";
    return dia >= p.de && dia <= p.ate;
  }).slice(0, 25);

  const posts: PostOrganico[] = await Promise.all(noPeriodo.map(async (m) => {
    const ins = await tentar(reg, IG_CAMPOS_POST, () => metaFetch<{ data?: Metrica[] }>(`/${m.id}/insights`, {
      access_token: ctx.token, metric: "reach,views,total_interactions,shares",
    }));
    const val = (nome: string) => {
      const v = ins?.data?.find((d) => d.name === nome)?.values?.[0]?.value;
      return v === undefined ? null : inteiro(v);
    };
    return {
      id: m.id,
      rede: "instagram" as const,
      data: m.timestamp ?? "",
      tipo: m.media_product_type === "REELS" ? "reel" : (m.media_type ?? "").toLowerCase(),
      texto: (m.caption ?? "").slice(0, 280),
      link: m.permalink ?? null,
      alcance: val("reach"),
      visualizacoes: val("views"),
      interacoes: val("total_interactions"),
      curtidas: m.like_count ?? null,
      comentarios: m.comments_count ?? null,
      compartilhamentos: val("shares"),
    };
  }));

  return {
    usuario: perfil.username ?? null,
    seguidores: perfil.followers_count ?? null,
    alcance: totais.reach,
    visualizacoes: totais.views,
    contas_engajadas: totais.accounts_engaged,
    interacoes: totais.total_interactions,
    aproximado: partes.length > 1,
    posts,
  };
}

export async function tokenDaPagina(ctx: MetaCtx): Promise<string> {
  const pagina = exigir(ctx.pageId, "Página do Facebook");
  const resp = await metaFetch<{ access_token?: string }>(`/${pagina}`, { access_token: ctx.token, fields: "access_token" });
  if (!resp.access_token) throw new Error("O usuário do sistema não tem acesso de publicação à Página.");
  return resp.access_token;
}

type PostFacebookApi = {
  id: string; message?: string; created_time?: string; permalink_url?: string;
  shares?: { count?: number }; reactions?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
};

const FB_CAMPOS_POST = "id,message,created_time,permalink_url,shares";
// Evidência real 01/10/2026 22:19 UTC: completa, sem_comentarios e
// sem_reacoes recusadas; somente sem_engajamento retorna os posts.
// Decisão T1-Unresolved 4: remover ambos os campos, sem pedir permissão nova.
// Rever esta restrição apenas após autorização e prova de acesso da Página.
async function postsDaPagina(pagina: string, tokenPagina: string, p: Periodo, reg: Registro) {
  const brutos = await tentar(reg, ["posts"], () => paginar<PostFacebookApi>(`/${pagina}/posts`, {
    access_token: tokenPagina, fields: FB_CAMPOS_POST,
    since: unix(p.de), until: unix(p.ate, true), limit: "50",
  }, 2), "sem_engajamento");
  if (!brutos) return null;
  reg.falhas.push({
    chaves: ["posts.curtidas", "posts.comentarios", "posts.interacoes"],
    estado: "sem_permissao",
    mensagem: "Campos reactions e comments omitidos após recusa de permissão verificada na Página em 01/10/2026.",
    variante: "sem_engajamento",
  });
  return { brutos, sem: new Set<string>(["curtidas", "comentarios"]) };
}

export async function facebookOrganico(ctx: MetaCtx, p: Periodo, reg = new Registro()) {
  const pagina = exigir(ctx.pageId, "Página do Facebook");
  const tokenPagina = await tokenDaPagina(ctx);
  const perfil = await metaFetch<{ followers_count?: number; name?: string }>(`/${pagina}`, {
    access_token: tokenPagina, fields: "followers_count,name",
  });

  // page_impressions saiu em 15/11/2025; page_media_view é o substituto.
  const insights = await tentar(reg, ["visualizacoes", "interacoes"], () => metaFetch<{ data?: Metrica[] }>(`/${pagina}/insights`, {
    access_token: tokenPagina, metric: "page_media_view,page_post_engagements", period: "day",
    since: p.de, until: addDias(p.ate, 1),
  }));
  const soma = (nome: string) => {
    const serie = insights?.data?.find((d) => d.name === nome)?.values;
    return serie ? serie.reduce((a, v) => a + (v.value ?? 0), 0) : null;
  };

  const lidos = await postsDaPagina(pagina, tokenPagina, p, reg);
  const sem = lidos?.sem ?? new Set<string>();
  const posts: PostOrganico[] = (lidos?.brutos ?? []).slice(0, 25).map((b) => {
    const curtidas = sem.has("curtidas") ? null : b.reactions?.summary?.total_count ?? null;
    const comentarios = sem.has("comentarios") ? null : b.comments?.summary?.total_count ?? null;
    const compartilhamentos = b.shares?.count ?? 0;
    return {
      id: b.id,
      rede: "facebook" as const,
      data: b.created_time ?? "",
      tipo: "post",
      texto: (b.message ?? "").slice(0, 280),
      link: b.permalink_url ?? null,
      alcance: null,
      visualizacoes: null,
      // Sem curtidas ou comentários a soma sairia menor que a real: fica sem valor.
      interacoes: curtidas === null || comentarios === null ? null : curtidas + comentarios + compartilhamentos,
      curtidas,
      comentarios,
      compartilhamentos,
    };
  });

  return {
    pagina: perfil.name ?? null,
    seguidores: perfil.followers_count ?? null,
    visualizacoes: soma("page_media_view"),
    interacoes: soma("page_post_engagements"),
    posts,
  };
}

// -------------------------------------------------------------------- Escrita

export const META_OBJETIVOS = ["OUTCOME_TRAFFIC", "OUTCOME_LEADS", "OUTCOME_AWARENESS"] as const;
export const META_CTAS = ["LEARN_MORE", "CONTACT_US", "SIGN_UP", "GET_QUOTE"] as const;

export type NovaCampanhaMeta = {
  nome: string;
  objetivo: (typeof META_OBJETIVOS)[number];
  orcamento: { tipo: "diario" | "total"; centavos: number };
  inicio: string;
  fim: string | null;
  publico: {
    paises: string[];
    cidades: { key: string; nome: string; raio_km: number }[];
    regioes: { key: string; nome: string }[];
    idade_min: number;
    idade_max: number;
    genero: "todos" | "masculino" | "feminino";
  };
  criativo: {
    tipo: "imagem" | "video";
    midia: string;
    texto: string;
    titulo: string;
    link: string;
    cta: (typeof META_CTAS)[number];
  };
};

export type MidiaMeta =
  | { tipo: "imagem"; bytesBase64: string }
  | { tipo: "video"; url: string };

const OTIMIZACAO: Record<NovaCampanhaMeta["objetivo"], { goal: string; destino: string | null }> = {
  OUTCOME_TRAFFIC: { goal: "LINK_CLICKS", destino: "WEBSITE" },
  OUTCOME_LEADS: { goal: "OFFSITE_CONVERSIONS", destino: "WEBSITE" },
  OUTCOME_AWARENESS: { goal: "REACH", destino: null },
};

export function metaTargeting(publico: NovaCampanhaMeta["publico"]) {
  const geo: Record<string, unknown> = {};
  if (publico.paises.length) geo.countries = publico.paises;
  if (publico.cidades.length) {
    geo.cities = publico.cidades.map((c) => ({ key: c.key, radius: c.raio_km, distance_unit: "kilometer" }));
  }
  if (publico.regioes.length) geo.regions = publico.regioes.map((r) => ({ key: r.key }));
  return {
    geo_locations: geo,
    age_min: publico.idade_min,
    age_max: publico.idade_max,
    ...(publico.genero === "todos" ? {} : { genders: [publico.genero === "masculino" ? 1 : 2] }),
    // Público exato, sem expansão automática: o que o Lucca revisou é o que roda.
    targeting_automation: { advantage_audience: 0 },
  };
}

export type Espera = (ms: number) => Promise<void>;

async function esperarVideoPronto(ctx: MetaCtx, videoId: string, esperar: Espera, tentativas = 12): Promise<void> {
  for (let i = 0; i < tentativas; i++) {
    const v = await metaFetch<{ status?: { video_status?: string } }>(`/${videoId}`, { access_token: ctx.token, fields: "status" });
    const status = v.status?.video_status;
    if (status === "ready") return;
    if (status === "error") throw new Error("A Meta recusou o processamento do vídeo.");
    await esperar(5000);
  }
  throw new Error("O vídeo ainda está em processamento na Meta. Tente de novo em alguns minutos.");
}

export async function metaCriarCampanha(
  ctx: MetaCtx,
  input: NovaCampanhaMeta,
  midia: MidiaMeta,
  esperar: Espera,
): Promise<{ result: Record<string, unknown>; external_ids: Record<string, string> }> {
  const conta = exigir(ctx.adAccountId, "conta de anúncios");
  const pagina = exigir(ctx.pageId, "Página do Facebook");
  const ids: Record<string, string> = {};
  const post = <T>(path: string, body: Record<string, unknown>) =>
    metaFetch<T>(path, { access_token: ctx.token }, { method: "POST", body, maxRetries: 0 });

  try {
    const campanha = await post<{ id: string }>(`/${conta}/campaigns`, {
      name: input.nome,
      objective: input.objetivo,
      status: "PAUSED",
      buying_type: "AUCTION",
      special_ad_categories: [],
      is_adset_budget_sharing_enabled: false,
    });
    ids.campaign_id = campanha.id;

    const otim = OTIMIZACAO[input.objetivo];
    const conjunto = await post<{ id: string }>(`/${conta}/adsets`, {
      name: `${input.nome} · conjunto`,
      campaign_id: campanha.id,
      // Dentro de uma campanha pausada: ativar a campanha é o único passo que libera gasto.
      status: "ACTIVE",
      billing_event: "IMPRESSIONS",
      optimization_goal: otim.goal,
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      ...(otim.destino ? { destination_type: otim.destino } : {}),
      ...(input.objetivo === "OUTCOME_LEADS" ? { promoted_object: { pixel_id: META_PIXEL_ID, custom_event_type: "LEAD" } } : {}),
      ...(input.orcamento.tipo === "diario"
        ? { daily_budget: input.orcamento.centavos }
        : { lifetime_budget: input.orcamento.centavos }),
      start_time: input.inicio,
      ...(input.fim ? { end_time: input.fim } : {}),
      targeting: metaTargeting(input.publico),
    });
    ids.adset_id = conjunto.id;

    const cta = { type: input.criativo.cta, value: { link: input.criativo.link } };
    let storySpec: Record<string, unknown>;
    if (midia.tipo === "imagem") {
      const upload = await post<{ images?: Record<string, { hash?: string }> }>(`/${conta}/adimages`, { bytes: midia.bytesBase64 });
      const hash = Object.values(upload.images ?? {})[0]?.hash;
      if (!hash) throw new Error("A Meta não devolveu o hash da imagem.");
      ids.image_hash = hash;
      storySpec = {
        link_data: {
          message: input.criativo.texto,
          name: input.criativo.titulo,
          link: input.criativo.link,
          image_hash: hash,
          call_to_action: cta,
        },
      };
    } else {
      const video = await post<{ id: string }>(`/${conta}/advideos`, { file_url: midia.url, name: input.nome });
      ids.video_id = video.id;
      await esperarVideoPronto(ctx, video.id, esperar);
      const miniaturas = await metaFetch<{ data?: { uri?: string; is_preferred?: boolean }[] }>(`/${video.id}/thumbnails`, {
        access_token: ctx.token, fields: "uri,is_preferred",
      });
      const capa = miniaturas.data?.find((t) => t.is_preferred)?.uri ?? miniaturas.data?.[0]?.uri;
      if (!capa) throw new Error("A Meta não gerou a capa do vídeo.");
      storySpec = {
        video_data: {
          video_id: video.id,
          image_url: capa,
          message: input.criativo.texto,
          title: input.criativo.titulo,
          call_to_action: cta,
        },
      };
    }

    const criativo = await post<{ id: string }>(`/${conta}/adcreatives`, {
      name: `${input.nome} · criativo`,
      object_story_spec: {
        page_id: pagina,
        ...(ctx.igUserId ? { instagram_user_id: ctx.igUserId } : {}),
        ...storySpec,
      },
    });
    ids.creative_id = criativo.id;

    const anuncio = await post<{ id: string }>(`/${conta}/ads`, {
      name: `${input.nome} · anúncio`,
      adset_id: conjunto.id,
      creative: { creative_id: criativo.id },
      status: "ACTIVE",
    });
    ids.ad_id = anuncio.id;

    return {
      result: {
        status_campanha: "PAUSED",
        link: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${conta.replace(/^act_/, "")}&selected_campaign_ids=${campanha.id}`,
      },
      external_ids: ids,
    };
  } catch (e) {
    throw new MetaEscritaError(mensagemMeta(e), ids);
  }
}

export type NivelMeta = "campaign" | "adset" | "ad";

export type EdicaoMeta = {
  nome?: string;
  orcamento_diario_centavos?: number;
  orcamento_total_centavos?: number;
  inicio?: string;
  fim?: string | null;
};

export function corpoEdicaoMeta(nivel: NivelMeta, e: EdicaoMeta): Record<string, unknown> {
  const corpo: Record<string, unknown> = {};
  if (e.nome !== undefined) corpo.name = e.nome;
  if (nivel === "adset") {
    if (e.orcamento_diario_centavos !== undefined) corpo.daily_budget = e.orcamento_diario_centavos;
    if (e.orcamento_total_centavos !== undefined) corpo.lifetime_budget = e.orcamento_total_centavos;
    if (e.inicio !== undefined) corpo.start_time = e.inicio;
    if (e.fim !== undefined) corpo.end_time = e.fim ?? "";
  }
  if (nivel === "campaign" && e.fim !== undefined) corpo.stop_time = e.fim ?? "";
  return corpo;
}

export async function metaAtualizar(ctx: MetaCtx, nivel: NivelMeta, id: string, e: EdicaoMeta) {
  const corpo = corpoEdicaoMeta(nivel, e);
  if (!Object.keys(corpo).length) throw new Error("Nada para alterar.");
  try {
    await metaFetch(`/${id}`, { access_token: ctx.token }, { method: "POST", body: corpo, maxRetries: 0 });
  } catch (err) {
    throw new MetaEscritaError(mensagemMeta(err), {});
  }
  return { result: { alterado: Object.keys(corpo) }, external_ids: { [`${nivel}_id`]: id } };
}

export async function metaAlterarStatus(ctx: MetaCtx, nivel: NivelMeta, id: string, status: "ACTIVE" | "PAUSED") {
  try {
    await metaFetch(`/${id}`, { access_token: ctx.token }, { method: "POST", body: { status }, maxRetries: 0 });
  } catch (err) {
    throw new MetaEscritaError(mensagemMeta(err), {});
  }
  return { result: { status }, external_ids: { [`${nivel}_id`]: id } };
}

// ----------------------------------------------------------------- Publicação

export type PostParaPublicar = {
  rede: "instagram" | "facebook";
  tipo: "feed_image" | "feed_video" | "reel" | "carousel" | "fb_post";
  legenda: string;
  urls: string[];
  containerId: string | null;
};

export type ResultadoPublicacao =
  | { status: "publicado"; externalPostId: string; containerId: string | null }
  | { status: "processando"; containerId: string };

const VIDEO = /\.(mp4|mov)(\?|$)/i;

async function statusContainer(ctx: MetaCtx, id: string): Promise<string> {
  const r = await metaFetch<{ status_code?: string }>(`/${id}`, { access_token: ctx.token, fields: "status_code" });
  return r.status_code ?? "IN_PROGRESS";
}

async function criarContainerIg(ctx: MetaCtx, ig: string, post: PostParaPublicar): Promise<string> {
  const criar = (body: Record<string, unknown>) =>
    metaFetch<{ id: string }>(`/${ig}/media`, { access_token: ctx.token }, { method: "POST", body, maxRetries: 0 });

  if (post.tipo === "carousel") {
    const filhos: string[] = [];
    for (const url of post.urls) {
      const filho = await criar(VIDEO.test(url)
        ? { media_type: "VIDEO", video_url: url, is_carousel_item: true }
        : { image_url: url, is_carousel_item: true });
      filhos.push(filho.id);
    }
    return (await criar({ media_type: "CAROUSEL", children: filhos.join(","), caption: post.legenda })).id;
  }
  if (post.tipo === "reel" || post.tipo === "feed_video") {
    return (await criar({ media_type: "REELS", video_url: post.urls[0], caption: post.legenda, share_to_feed: true })).id;
  }
  return (await criar({ image_url: post.urls[0], caption: post.legenda })).id;
}

export async function publicarInstagram(
  ctx: MetaCtx,
  post: PostParaPublicar,
  esperar: Espera,
  checagens = 6,
): Promise<ResultadoPublicacao> {
  const ig = exigir(ctx.igUserId, "conta do Instagram");
  const containerId = post.containerId ?? await criarContainerIg(ctx, ig, post);
  for (let i = 0; i < checagens; i++) {
    const status = await statusContainer(ctx, containerId);
    if (status === "FINISHED") {
      const publicado = await metaFetch<{ id: string }>(`/${ig}/media_publish`, { access_token: ctx.token }, {
        method: "POST", body: { creation_id: containerId }, maxRetries: 0,
      });
      return { status: "publicado", externalPostId: publicado.id, containerId };
    }
    if (status === "ERROR" || status === "EXPIRED") throw new Error(`O Instagram recusou a mídia (${status}).`);
    if (i < checagens - 1) await esperar(5000);
  }
  return { status: "processando", containerId };
}

export async function publicarFacebook(ctx: MetaCtx, post: PostParaPublicar): Promise<ResultadoPublicacao> {
  const pagina = exigir(ctx.pageId, "Página do Facebook");
  const tokenPagina = await tokenDaPagina(ctx);
  const enviar = (path: string, body: Record<string, unknown>) =>
    metaFetch<{ id: string; post_id?: string }>(path, { access_token: tokenPagina }, { method: "POST", body, maxRetries: 0 });

  const url = post.urls[0];
  let resp: { id: string; post_id?: string };
  if (!url) resp = await enviar(`/${pagina}/feed`, { message: post.legenda });
  else if (VIDEO.test(url)) resp = await enviar(`/${pagina}/videos`, { file_url: url, description: post.legenda });
  else resp = await enviar(`/${pagina}/photos`, { url, message: post.legenda, published: true });
  return { status: "publicado", externalPostId: resp.post_id ?? resp.id, containerId: null };
}
