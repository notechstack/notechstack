// Google Ads API (REST v25): leitura por GAQL e escrita por googleAds:mutate.
// Só campanhas de Pesquisa. Tudo nasce PAUSED (C3).

import { googleFetch } from "./google-auth.ts";
import {
  type GoogleAdsMetrics,
  type MetricasPagas,
  type Periodo,
  addDias,
  centavosDeMicros,
  microsDeCentavos,
  parseGoogleAdsMetrics,
  somarMetricas,
} from "./normalize.ts";
import type { CampanhaResumo } from "./meta.ts";

export const GOOGLE_ADS_API = "https://googleads.googleapis.com/v25";

export type AdsCtx = {
  token: string;
  developerToken: string;
  customerId: string;
  loginCustomerId?: string | null;
};

const SO_DIGITOS = /\D/g;
const ID_NUMERICO = /^\d{1,20}$/;

export function idCliente(valor: string): string {
  return valor.replace(SO_DIGITOS, "");
}

function cabecalhos(ctx: AdsCtx): Record<string, string> {
  const login = ctx.loginCustomerId ? idCliente(ctx.loginCustomerId) : "";
  // Sem developer token (o acesso passou a ser do projeto Cloud em 09/2026) o cabeçalho não vai.
  return {
    ...(ctx.developerToken ? { "developer-token": ctx.developerToken } : {}),
    ...(login ? { "login-customer-id": login } : {}),
  };
}

export async function adsSearch<T>(ctx: AdsCtx, query: string, limitePaginas = 5): Promise<T[]> {
  const url = `${GOOGLE_ADS_API}/customers/${idCliente(ctx.customerId)}/googleAds:search`;
  const linhas: T[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < limitePaginas; i++) {
    const resp = await googleFetch<{ results?: T[]; nextPageToken?: string }>(url, ctx.token, {
      body: { query, ...(pageToken ? { pageToken } : {}) },
      headers: cabecalhos(ctx),
    });
    linhas.push(...(resp.results ?? []));
    pageToken = resp.nextPageToken;
    if (!pageToken) break;
  }
  return linhas;
}

function entreDatas(p: Periodo): string {
  return `segments.date BETWEEN '${p.de}' AND '${p.ate}'`;
}

function exigirId(id: string): string {
  if (!ID_NUMERICO.test(id)) throw new Error("Id de campanha Google inválido.");
  return id;
}

// ------------------------------------------------------------------ Leitura

export async function adsResumo(ctx: AdsCtx, p: Periodo): Promise<{ total: MetricasPagas; por_dia: ({ dia: string } & MetricasPagas)[] }> {
  const linhas = await adsSearch<{ segments?: { date?: string }; metrics?: GoogleAdsMetrics }>(
    ctx,
    `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM customer WHERE ${entreDatas(p)}`,
  );
  const porData = new Map(linhas.map((l) => [l.segments?.date ?? "", parseGoogleAdsMetrics(l.metrics)]));
  const vazio = parseGoogleAdsMetrics(undefined);
  const por_dia: ({ dia: string } & MetricasPagas)[] = [];
  for (let d = p.de; d <= p.ate; d = addDias(d, 1)) por_dia.push({ dia: d, ...(porData.get(d) ?? vazio) });
  return { total: somarMetricas(por_dia), por_dia };
}

type LinhaCampanha = {
  campaign?: { id?: string; name?: string; status?: string; advertisingChannelType?: string; biddingStrategyType?: string };
  campaignBudget?: { amountMicros?: string };
  metrics?: GoogleAdsMetrics;
};

export async function adsCampanhas(ctx: AdsCtx, p: Periodo): Promise<CampanhaResumo[]> {
  // Campanha sem veiculação no período não aparece numa consulta com métricas:
  // por isso a lista e as métricas vêm separadas.
  const [lista, metricas] = await Promise.all([
    adsSearch<LinhaCampanha>(ctx,
      "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros FROM campaign WHERE campaign.status != 'REMOVED'"),
    adsSearch<LinhaCampanha>(ctx,
      `SELECT campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE ${entreDatas(p)} AND campaign.status != 'REMOVED'`),
  ]);
  const porId = new Map(metricas.map((m) => [m.campaign?.id ?? "", parseGoogleAdsMetrics(m.metrics)]));
  return lista.map((l) => ({
    plataforma: "google" as const,
    id: l.campaign?.id ?? "",
    nome: l.campaign?.name ?? "",
    status: l.campaign?.status ?? "",
    status_efetivo: null,
    objetivo: l.campaign?.advertisingChannelType ?? null,
    orcamento_diario_centavos: l.campaignBudget?.amountMicros ? centavosDeMicros(l.campaignBudget.amountMicros) : null,
    orcamento_total_centavos: null,
    metricas: porId.get(l.campaign?.id ?? "") ?? parseGoogleAdsMetrics(undefined),
  }));
}

export async function adsCampanhaDetalhe(ctx: AdsCtx, idBruto: string, p: Periodo) {
  const id = exigirId(idBruto);
  const [campanha, metricas, grupos, palavras, anuncios, criterios] = await Promise.all([
    adsSearch<LinhaCampanha>(ctx,
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${id}`),
    adsSearch<LinhaCampanha>(ctx,
      `SELECT campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign WHERE campaign.id = ${id} AND ${entreDatas(p)}`),
    adsSearch<{ adGroup?: { id?: string; name?: string; status?: string; cpcBidMicros?: string } }>(ctx,
      `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros FROM ad_group WHERE campaign.id = ${id} AND ad_group.status != 'REMOVED'`),
    adsSearch<{ adGroup?: { id?: string }; adGroupCriterion?: { criterionId?: string; status?: string; keyword?: { text?: string; matchType?: string } } }>(ctx,
      `SELECT ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM keyword_view WHERE campaign.id = ${id} AND ad_group_criterion.status != 'REMOVED'`),
    adsSearch<{ adGroup?: { id?: string }; adGroupAd?: { status?: string; ad?: { id?: string; finalUrls?: string[]; responsiveSearchAd?: { headlines?: { text?: string }[]; descriptions?: { text?: string }[] } } } }>(ctx,
      `SELECT ad_group.id, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE campaign.id = ${id} AND ad_group_ad.status != 'REMOVED'`),
    adsSearch<{ campaignCriterion?: { type?: string; location?: { geoTargetConstant?: string }; language?: { languageConstant?: string } } }>(ctx,
      `SELECT campaign_criterion.type, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant FROM campaign_criterion WHERE campaign.id = ${id}`),
  ]);
  const c = campanha[0];
  if (!c) throw new Error("Campanha Google não encontrada.");
  return {
    plataforma: "google" as const,
    campanha: {
      id,
      nome: c.campaign?.name ?? "",
      status: c.campaign?.status ?? "",
      tipo: c.campaign?.advertisingChannelType ?? null,
      lances: c.campaign?.biddingStrategyType ?? null,
      orcamento_diario_centavos: c.campaignBudget?.amountMicros ? centavosDeMicros(c.campaignBudget.amountMicros) : null,
    },
    metricas: metricas[0] ? parseGoogleAdsMetrics(metricas[0].metrics) : parseGoogleAdsMetrics(undefined),
    locais: criterios.flatMap((cr) => cr.campaignCriterion?.location?.geoTargetConstant ? [cr.campaignCriterion.location.geoTargetConstant] : []),
    idiomas: criterios.flatMap((cr) => cr.campaignCriterion?.language?.languageConstant ? [cr.campaignCriterion.language.languageConstant] : []),
    grupos: grupos.map((g) => ({
      id: g.adGroup?.id ?? "",
      nome: g.adGroup?.name ?? "",
      status: g.adGroup?.status ?? "",
      cpc_centavos: g.adGroup?.cpcBidMicros ? centavosDeMicros(g.adGroup.cpcBidMicros) : null,
    })),
    palavras_chave: palavras.map((k) => ({
      grupo_id: k.adGroup?.id ?? "",
      texto: k.adGroupCriterion?.keyword?.text ?? "",
      correspondencia: k.adGroupCriterion?.keyword?.matchType ?? "",
      status: k.adGroupCriterion?.status ?? "",
    })),
    anuncios: anuncios.map((a) => ({
      grupo_id: a.adGroup?.id ?? "",
      id: a.adGroupAd?.ad?.id ?? "",
      status: a.adGroupAd?.status ?? "",
      url_final: a.adGroupAd?.ad?.finalUrls?.[0] ?? null,
      titulos: (a.adGroupAd?.ad?.responsiveSearchAd?.headlines ?? []).map((h) => h.text ?? ""),
      descricoes: (a.adGroupAd?.ad?.responsiveSearchAd?.descriptions ?? []).map((d) => d.text ?? ""),
    })),
  };
}

export async function adsSugerirLocais(ctx: AdsCtx, q: string) {
  const resp = await googleFetch<{
    geoTargetConstantSuggestions?: { geoTargetConstant?: { id?: string; name?: string; canonicalName?: string; targetType?: string } }[];
  }>(`${GOOGLE_ADS_API}/geoTargetConstants:suggest`, ctx.token, {
    body: { locale: "pt-BR", countryCode: "BR", locationNames: { names: [q] } },
    headers: cabecalhos(ctx),
  });
  return (resp.geoTargetConstantSuggestions ?? []).flatMap((s) => {
    const g = s.geoTargetConstant;
    return g?.id ? [{ id: g.id, nome: g.canonicalName ?? g.name ?? g.id, tipo: g.targetType ?? "" }] : [];
  }).slice(0, 10);
}

// -------------------------------------------------------------------- Escrita

export const ESTRATEGIAS_GOOGLE = ["MAXIMIZE_CLICKS", "MAXIMIZE_CONVERSIONS", "MANUAL_CPC"] as const;
export const CORRESPONDENCIAS = ["EXACT", "PHRASE", "BROAD"] as const;

export type NovaCampanhaGoogle = {
  nome: string;
  orcamento_diario_centavos: number;
  lances: { estrategia: (typeof ESTRATEGIAS_GOOGLE)[number]; cpc_max_centavos: number | null };
  locais: string[];
  idiomas: string[];
  grupo: { nome: string };
  palavras_chave: { texto: string; correspondencia: (typeof CORRESPONDENCIAS)[number] }[];
  anuncio: { titulos: string[]; descricoes: string[]; url_final: string; caminho1: string; caminho2: string };
};

function lanceDaCampanha(l: NovaCampanhaGoogle["lances"]): Record<string, unknown> {
  if (l.estrategia === "MAXIMIZE_CONVERSIONS") return { maximizeConversions: {} };
  if (l.estrategia === "MANUAL_CPC") return { manualCpc: {} };
  return { targetSpend: l.cpc_max_centavos ? { cpcBidCeilingMicros: microsDeCentavos(l.cpc_max_centavos) } : {} };
}

// Uma requisição atômica com ids temporários (-1, -2, -3): ou nasce tudo, ou nada.
export function operacoesCampanhaPesquisa(customerId: string, input: NovaCampanhaGoogle, sufixo: string) {
  const c = `customers/${idCliente(customerId)}`;
  const orcamento = `${c}/campaignBudgets/-1`;
  const campanha = `${c}/campaigns/-2`;
  const grupo = `${c}/adGroups/-3`;
  return [
    {
      campaignBudgetOperation: {
        create: {
          resourceName: orcamento,
          name: `${input.nome} · orçamento ${sufixo}`,
          amountMicros: microsDeCentavos(input.orcamento_diario_centavos),
          deliveryMethod: "STANDARD",
          explicitlyShared: false,
        },
      },
    },
    {
      campaignOperation: {
        create: {
          resourceName: campanha,
          name: input.nome,
          status: "PAUSED",
          advertisingChannelType: "SEARCH",
          campaignBudget: orcamento,
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: false,
            targetContentNetwork: false,
            targetPartnerSearchNetwork: false,
          },
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
          ...lanceDaCampanha(input.lances),
        },
      },
    },
    ...input.locais.map((id) => ({
      campaignCriterionOperation: { create: { campaign: campanha, location: { geoTargetConstant: `geoTargetConstants/${id}` } } },
    })),
    ...input.idiomas.map((id) => ({
      campaignCriterionOperation: { create: { campaign: campanha, language: { languageConstant: `languageConstants/${id}` } } },
    })),
    {
      adGroupOperation: {
        create: {
          resourceName: grupo,
          campaign: campanha,
          name: input.grupo.nome,
          status: "ENABLED",
          type: "SEARCH_STANDARD",
          ...(input.lances.estrategia === "MANUAL_CPC" && input.lances.cpc_max_centavos
            ? { cpcBidMicros: microsDeCentavos(input.lances.cpc_max_centavos) }
            : {}),
        },
      },
    },
    ...input.palavras_chave.map((k) => ({
      adGroupCriterionOperation: {
        create: { adGroup: grupo, status: "ENABLED", keyword: { text: k.texto, matchType: k.correspondencia } },
      },
    })),
    {
      adGroupAdOperation: {
        create: {
          adGroup: grupo,
          status: "ENABLED",
          ad: {
            finalUrls: [input.anuncio.url_final],
            responsiveSearchAd: {
              headlines: input.anuncio.titulos.map((text) => ({ text })),
              descriptions: input.anuncio.descricoes.map((text) => ({ text })),
              ...(input.anuncio.caminho1 ? { path1: input.anuncio.caminho1 } : {}),
              ...(input.anuncio.caminho2 ? { path2: input.anuncio.caminho2 } : {}),
            },
          },
        },
      },
    },
  ];
}

type RespostaMutate = { mutateOperationResponses?: Record<string, { resourceName?: string }>[] };

async function mutate(ctx: AdsCtx, operacoes: unknown[], validateOnly = false): Promise<RespostaMutate> {
  return await googleFetch<RespostaMutate>(
    `${GOOGLE_ADS_API}/customers/${idCliente(ctx.customerId)}/googleAds:mutate`,
    ctx.token,
    { body: { mutateOperations: operacoes, ...(validateOnly ? { validateOnly: true } : {}) }, headers: cabecalhos(ctx) },
  );
}

function ultimoSegmento(resourceName: string | undefined): string {
  return resourceName?.split("/").pop()?.split("~").pop() ?? "";
}

export async function adsCriarCampanhaPesquisa(ctx: AdsCtx, input: NovaCampanhaGoogle, sufixo: string) {
  const resp = await mutate(ctx, operacoesCampanhaPesquisa(ctx.customerId, input, sufixo));
  const nomes = (resp.mutateOperationResponses ?? []).map((r) => Object.values(r)[0]?.resourceName);
  const campanha = nomes.find((n) => n?.includes("/campaigns/"));
  const orcamento = nomes.find((n) => n?.includes("/campaignBudgets/"));
  const grupo = nomes.find((n) => n?.includes("/adGroups/"));
  const campaignId = ultimoSegmento(campanha);
  return {
    result: {
      status_campanha: "PAUSED",
      link: `https://ads.google.com/aw/campaigns?campaignId=${campaignId}&__e=${idCliente(ctx.customerId)}`,
    },
    external_ids: {
      campaign_id: campaignId,
      budget_id: ultimoSegmento(orcamento),
      ad_group_id: ultimoSegmento(grupo),
    },
  };
}

export async function adsAtualizarOrcamento(ctx: AdsCtx, idBruto: string, centavos: number) {
  const id = exigirId(idBruto);
  const linha = await adsSearch<{ campaign?: { campaignBudget?: string } }>(ctx,
    `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${id}`);
  const orcamento = linha[0]?.campaign?.campaignBudget;
  if (!orcamento) throw new Error("Orçamento da campanha Google não encontrado.");
  await mutate(ctx, [{
    campaignBudgetOperation: { update: { resourceName: orcamento, amountMicros: microsDeCentavos(centavos) }, updateMask: "amount_micros" },
  }]);
  return { result: { orcamento_diario_centavos: centavos }, external_ids: { campaign_id: id, budget_id: ultimoSegmento(orcamento) } };
}

export async function adsAlterarStatus(ctx: AdsCtx, idBruto: string, status: "ENABLED" | "PAUSED") {
  const id = exigirId(idBruto);
  await mutate(ctx, [{
    campaignOperation: { update: { resourceName: `customers/${idCliente(ctx.customerId)}/campaigns/${id}`, status }, updateMask: "status" },
  }]);
  return { result: { status }, external_ids: { campaign_id: id } };
}
