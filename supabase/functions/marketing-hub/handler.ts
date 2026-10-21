// marketing-hub: a única porta do planner /no/marketing, para o Lucca e para o dot.
// Toda regra de permissão mora aqui, por papel da conta (spec rev. 3.1):
//   NO_ADMIN        → tudo, mas só com sessão aal2 (MFA, C2)
//   MARKETING_AGENT → tudo do marketing (C1 = a), nada de "dot" nem de outras áreas
// O Deno.serve e o Supabase ficam em index.ts/store.ts; aqui é lógica testável.

import { corsHeaders } from "../_shared/cors.ts";
import { type ClienteStore, type ClientesConfig, criarRotasCliente } from "./clientes.ts";
import { MetaApiError } from "../_shared/meta.ts";
import { adsAlterarStatus, adsAtualizarOrcamento, adsCampanhaDetalhe, adsCampanhas, adsCriarCampanhaPesquisa, adsResumo, adsSugerirLocais, type AdsCtx } from "../_shared/marketing/google-ads.ts";
import { type EscritaOk, diagnosticarConexoes } from "../_shared/marketing/conexoes.ts";
import { type EstadoMetrica, Registro, type Valores, calcularEstados, semPermissao, semSegredo } from "../_shared/marketing/estados.ts";
import { GOOGLE_CALLBACK, googleConsentimento, googleState, googleTrocarCodigo } from "../_shared/marketing/google-oauth.ts";
import { GoogleApiError, googleAccessToken, limparCacheGoogle } from "../_shared/marketing/google-auth.ts";
import { ga4Resumo } from "../_shared/marketing/ga4.ts";
import { gscResumo } from "../_shared/marketing/gsc.ts";
import { COLUNAS_ORIGEM_LEAD, type LeadOrigem, type LeadAdmin, type ClasseLead, leadsResumo } from "../_shared/marketing/leads.ts";
import {
  type MetaCtx,
  MetaEscritaError,
  type PostParaPublicar,
  facebookOrganico,
  instagramOrganico,
  mensagemMeta,
  metaAlterarStatus,
  metaAtualizar,
  metaCampanhaDetalhe,
  metaCampanhas,
  metaCriarCampanha,
  metaResumo,
  metaSugerirLocais,
  publicarFacebook,
  publicarInstagram,
} from "../_shared/marketing/meta.ts";
import { type MetricasPagas, type Periodo, addDias, hojeSaoPaulo, parsePeriodo, ttlSegundos, limitesUtc } from "../_shared/marketing/normalize.ts";
import {
  caminhoMidia,
  requestId as validarRequestId,
  validarCampanhaGoogle,
  validarCampanhaMeta,
  validarEdicaoMeta,
  validarEmail,
  validarPost,
  validarUpload,
  validarUuid,
} from "../_shared/marketing/validacao.ts";

export { COLUNAS_ORIGEM_LEAD };

// ----------------------------------------------------------------- Contratos

export type Chamador = { userId: string; role: string | null; aal: string | null; banido: boolean };

export type Ativo = { id: string; externalId: string };
export type Ativos = {
  clientId: string | null;
  metaAds: Ativo | null;
  metaPage: Ativo | null;
  metaInstagram: Ativo | null;
};

export type AcaoRow = {
  id: string;
  request_id: string;
  actor_user_id: string | null;
  actor_role: string;
  kind: string;
  target: string | null;
  payload: unknown;
  status: "executando" | "ok" | "erro";
  result: unknown;
  external_ids: unknown;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type PostRow = {
  id: string;
  account_id: string;
  scheduled_at: string;
  published_at: string | null;
  media_type: PostParaPublicar["tipo"];
  caption: string | null;
  media_urls: string[] | null;
  status: "draft" | "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  external_post_id: string | null;
  error_message: string | null;
  created_by: string | null;
  created_by_role: string | null;
  publish_attempts: number;
  meta_container_id: string | null;
};

export type AgenteRow = { id: string; email: string | null; banido: boolean; criado_em: string | null; ultimo_login: string | null };

export class ConflitoError extends Error {}

export interface MarketingStore {
  googleStateConsumir?(state: string): Promise<{ user_id: string } | null>;
  googleRefreshLer?(): Promise<string | null>;
  googleConexaoSalvar?(userId: string, refreshToken: string, requestId: string): Promise<void>;
  cacheLer(chave: string): Promise<unknown | null>;
  cacheGravar(chave: string, valor: unknown, ttlSegundos: number): Promise<void>;
  cacheLimpar(prefixo: string): Promise<void>;
  acaoIniciar(linha: {
    request_id: string; actor_user_id: string | null; actor_role: string; kind: string; target: string | null; payload: unknown;
  }): Promise<{ id: string } | { existente: AcaoRow }>;
  acaoFinalizar(id: string, fim: { status: "ok" | "erro"; result?: unknown; external_ids?: unknown; error?: string | null }): Promise<void>;
  acoesListar(limite: number): Promise<AcaoRow[]>;
  // Escritas `ok` desde a data, para provar publicação/escrita em /connections.
  escritasOk(desdeUtc: string): Promise<EscritaOk[]>;
  ativos(): Promise<Ativos>;
  postsListar(deUtc: string, ateUtc: string): Promise<PostRow[]>;
  postInserir(linha: Omit<PostRow, "id" | "published_at" | "external_post_id" | "error_message" | "publish_attempts" | "meta_container_id"> & { client_id: string }): Promise<PostRow>;
  postBuscar(id: string): Promise<PostRow | null>;
  postAtualizar(id: string, patch: Partial<PostRow>): Promise<void>;
  postsReservarVencidos(limite: number): Promise<PostRow[]>;
  leadsOrigem(inicioUtc: string, fimExclusivoUtc: string): Promise<LeadOrigem[]>;
  leadsListar(inicioUtc: string, fimExclusivoUtc: string): Promise<LeadAdmin[]>;
  leadExiste(id: string): Promise<boolean>;
  leadClassificar(linha: { lead_id: string; classe: ClasseLead; motivo: string | null; classificado_por: string; papel: string }): Promise<void>;
  cronSecretOk(segredo: string): Promise<boolean>;
  urlUpload(caminho: string): Promise<{ signedUrl: string; token: string; path: string }>;
  urlLeitura(caminho: string, segundos: number): Promise<string>;
  baixarMidia(caminho: string): Promise<Uint8Array>;
  agentesListar(): Promise<AgenteRow[]>;
  agentePapel(userId: string): Promise<string | null>;
  agenteConvidar(email: string, redirectTo: string): Promise<{ userId: string; link: string }>;
  agenteBanir(userId: string, banir: boolean): Promise<void>;
}

export type GoogleConfig = {
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  developerToken: string | null;
  customerId: string | null;
  loginCustomerId: string | null;
  ga4PropertyId: string | null;
  gscSiteUrl: string | null;
};

export type HubConfig = {
  metaToken: string | null;
  google: GoogleConfig;
  googleCriacaoLiberada: boolean;
  appUrl: string;
  // Conexões dos clientes do auditor (/cliente/*). Ausente = rotas respondem 503.
  clientes?: ClientesConfig;
};

export type Deps = {
  store: MarketingStore;
  clienteStore?: ClienteStore;
  autenticar: (token: string) => Promise<Chamador | null>;
  config: HubConfig;
  agora: () => Date;
  esperar: (ms: number) => Promise<void>;
  uuid: () => string;
  log: (nivel: "info" | "warn" | "error", evento: string, dados?: Record<string, unknown>) => void;
  // Rotas do auditor (Frente 3, marketing-hub/auditor.ts): null = não é rota dele.
  auditor?: (req: Request, partes: string[], json: (req: Request, status: number, corpo: unknown) => Response,
    erro: (req: Request, status: number, code: string, mensagem: string, extra?: Record<string, unknown>) => Response) => Promise<Response | null>;
};

// ------------------------------------------------------------------- Helpers

const METODOS = "GET, POST, PATCH, DELETE, OPTIONS";

function cors(req: Request): Record<string, string> {
  return { ...corsHeaders(req.headers.get("origin")), "Access-Control-Allow-Methods": METODOS };
}

function json(req: Request, status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { ...cors(req), "Content-Type": "application/json" } });
}

function erro(req: Request, status: number, error_code: string, mensagem: string, extra: Record<string, unknown> = {}): Response {
  return json(req, status, { error_code, mensagem, ...extra });
}

class HttpErro extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function bearer(req: Request): string {
  const v = req.headers.get("authorization") ?? "";
  return v.startsWith("Bearer ") ? v.slice(7) : "";
}

function rota(req: Request): string[] {
  const caminho = new URL(req.url).pathname;
  const i = caminho.indexOf("/marketing-hub");
  const resto = i >= 0 ? caminho.slice(i + "/marketing-hub".length) : caminho;
  return resto.split("/").filter(Boolean).map(decodeURIComponent);
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function mensagemDe(e: unknown): string {
  const mensagem = e instanceof MetaEscritaError ? e.message
    : e instanceof GoogleApiError ? `Google: ${e.message}`
    : e instanceof MetaApiError ? mensagemMeta(e)
    : e instanceof Error ? e.message : String(e);
  return semSegredo(mensagem);
}

// `estados` (T2 Decided 1–2): só as métricas que não estão `disponivel`.
export type Bloco<T> =
  | { ok: true; dados: T; cache: boolean; estados: Record<string, EstadoMetrica> }
  | { ok: false; motivo: "nao_configurado" | "falha" | "sem_permissao"; mensagem: string };

export type Leitura<T> = {
  ler: (reg: Registro) => Promise<T | null>;
  metricas?: (dados: T) => { periodo?: Valores; fixas?: Valores };
  atrasado: boolean;
};

// v3 acrescenta classificação dos leads; caches anteriores são refeitos.
const VERSAO_CACHE = 3;
const CHAVE_CONEXOES = "conexoes";
const TTL_CONEXOES = 15 * 60;
const JANELA_ESCRITA_MS = 30 * 86_400_000;

const pagas = (d: { total: MetricasPagas }) => ({ periodo: { ...d.total } });

// ------------------------------------------------------------------- Handler

export function criarHandler(deps: Deps) {
  const { store, config } = deps;
  // Reconexão Google do admin: mesma base pública das rotas /cliente (proxy /hub do app quando configurado).
  const callbackGoogle = config.clientes?.hubUrl ? `${config.clientes.hubUrl}/google/callback` : GOOGLE_CALLBACK;

  function autorizar(ch: Chamador | null, soAdmin = false): void {
    if (!ch || ch.banido) throw new HttpErro(401, "UNAUTHENTICATED", "Sessão inválida ou conta desligada.");
    if (ch.role === "NO_ADMIN") {
      if (ch.aal !== "aal2") throw new HttpErro(403, "MFA_REQUIRED", "Conclua o segundo fator para usar o planner.");
      return;
    }
    if (ch.role === "MARKETING_AGENT" && !soAdmin) return;
    throw new HttpErro(403, "FORBIDDEN", "Esta conta não tem acesso a esta área.");
  }

  function periodo(url: URL): Periodo {
    const p = parsePeriodo(url.searchParams.get("periodo"), deps.agora());
    if (!p) throw new HttpErro(422, "PERIODO_INVALIDO", "Use periodo=7d, 30d, mes-passado ou AAAA-MM-DD..AAAA-MM-DD.");
    return p;
  }

  async function metaCtx(): Promise<MetaCtx | null> {
    if (!config.metaToken) return null;
    const a = await store.ativos();
    return {
      token: config.metaToken,
      adAccountId: a.metaAds?.externalId ?? null,
      pageId: a.metaPage?.externalId ?? null,
      igUserId: a.metaInstagram?.externalId ?? null,
    };
  }

  async function googleCred() {
    const g = config.google;
    const refreshToken = (await store.googleRefreshLer?.()) || g.refreshToken;
    return g.clientId && g.clientSecret && refreshToken
      ? { clientId: g.clientId, clientSecret: g.clientSecret, refreshToken }
      : null;
  }

  async function adsCtx(): Promise<AdsCtx | null> {
    const cred = await googleCred();
    const g = config.google;
    if (!cred || !g.developerToken || !g.customerId) return null;
    return {
      token: await googleAccessToken(cred, deps.agora().getTime()),
      developerToken: g.developerToken,
      customerId: g.customerId,
      loginCustomerId: g.loginCustomerId,
    };
  }

  // Um bloco que falha não derruba a visão geral: vira "indisponível" com o motivo.
  // Sub-consulta que falha não derruba o bloco: entra em `estados` e no log.
  async function bloco<T>(chave: string, ttl: number, fresco: boolean, leitura: Leitura<T>): Promise<Bloco<T>> {
    const nome = chave.split(":")[0];
    if (!fresco) {
      const emCache = await store.cacheLer(chave).catch(() => null) as { v?: unknown; dados?: T; estados?: Record<string, EstadoMetrica> } | null;
      if (emCache?.v === VERSAO_CACHE && emCache.dados !== undefined) {
        return { ok: true, dados: emCache.dados, cache: true, estados: emCache.estados ?? {} };
      }
    }
    const reg = new Registro();
    try {
      const dados = await leitura.ler(reg);
      if (dados === null) return { ok: false, motivo: "nao_configurado", mensagem: "Integração ainda não configurada." };
      const estados = calcularEstados({ ...(leitura.metricas?.(dados) ?? {}), atrasado: leitura.atrasado }, reg);
      await store.cacheGravar(chave, { v: VERSAO_CACHE, dados, estados }, ttl).catch(() => undefined);
      return { ok: true, dados, cache: false, estados };
    } catch (e) {
      const mensagem = semSegredo(mensagemDe(e));
      deps.log("warn", "marketing_bloco_falhou", { chave: nome, mensagem: mensagem.slice(0, 300) });
      const motivo = mensagem.startsWith("Ativo Meta não configurado") ? "nao_configurado" : semPermissao(e) ? "sem_permissao" : "falha";
      return { ok: false, motivo, mensagem };
    } finally {
      // `variante` diz qual forma da consulta a plataforma recusou (ex.: posts do Facebook).
      for (const f of reg.falhas) {
        deps.log("warn", "marketing_subconsulta_falhou", { chave: nome, metricas: f.chaves, estado: f.estado, variante: f.variante, mensagem: f.mensagem });
      }
    }
  }

  function blocos(p: Periodo, fresco: boolean) {
    const ttl = ttlSegundos(p, deps.agora());
    const k = (nome: string) => `${nome}:${p.de}:${p.ate}`;
    const hoje = hojeSaoPaulo(deps.agora());
    // T2-9: atrasado quando o período inclui hoje; no Search Console, os últimos 3 dias.
    const atrasado = p.ate >= hoje;
    const atrasadoGsc = p.ate >= addDias(hoje, -3);
    return {
      meta_ads: () => bloco(k("meta_ads"), ttl, fresco, {
        atrasado,
        ler: async (reg) => {
          const ctx = await metaCtx();
          return ctx?.adAccountId ? await metaResumo(ctx, p, reg) : null;
        },
        metricas: pagas,
      }),
      google_ads: () => bloco(k("google_ads"), ttl, fresco, {
        atrasado,
        ler: async () => {
          const ctx = await adsCtx();
          return ctx ? await adsResumo(ctx, p) : null;
        },
        metricas: pagas,
      }),
      ga4: () => bloco(k("ga4"), ttl, fresco, {
        atrasado,
        ler: async () => {
          const cred = await googleCred();
          if (!cred || !config.google.ga4PropertyId) return null;
          return await ga4Resumo(await googleAccessToken(cred, deps.agora().getTime()), config.google.ga4PropertyId, p);
        },
        metricas: (d) => ({ periodo: { sessoes: d.sessoes, eventos_chave: d.eventos_chave } }),
      }),
      search_console: () => bloco(k("gsc"), ttl, fresco, {
        atrasado: atrasadoGsc,
        ler: async () => {
          const cred = await googleCred();
          if (!cred || !config.google.gscSiteUrl) return null;
          return await gscResumo(await googleAccessToken(cred, deps.agora().getTime()), config.google.gscSiteUrl, p);
        },
        metricas: (d) => ({ periodo: { cliques: d.cliques, impressoes: d.impressoes, ctr: d.ctr } }),
      }),
      instagram: () => bloco(k("instagram"), ttl, fresco, {
        atrasado,
        ler: async (reg) => {
          const ctx = await metaCtx();
          return ctx?.igUserId ? await instagramOrganico(ctx, p, reg) : null;
        },
        metricas: (d) => ({
          periodo: { alcance: d.alcance, visualizacoes: d.visualizacoes, contas_engajadas: d.contas_engajadas, interacoes: d.interacoes },
          fixas: { seguidores: d.seguidores },
        }),
      }),
      facebook: () => bloco(k("facebook"), ttl, fresco, {
        atrasado,
        ler: async (reg) => {
          const ctx = await metaCtx();
          return ctx?.pageId ? await facebookOrganico(ctx, p, reg) : null;
        },
        metricas: (d) => ({ periodo: { visualizacoes: d.visualizacoes, interacoes: d.interacoes }, fixas: { seguidores: d.seguidores } }),
      }),
      leads: () => bloco(k("leads"), Math.min(ttl, 15 * 60), fresco, {
        atrasado,
        ler: () => leadsResumo((i, f) => store.leadsOrigem(i, f), p),
        metricas: (d) => ({ periodo: { total: d.total, validos: d.validos } }),
      }),
    };
  }

  // T2 critérios 10–13. Mesmo padrão de cache do `bloco()`: 15 min, `fresco=1` refaz.
  async function conexoes(fresco: boolean) {
    if (!fresco) {
      const emCache = await store.cacheLer(CHAVE_CONEXOES).catch(() => null) as Record<string, unknown> | null;
      if (emCache?.v === VERSAO_CACHE) {
        const { v: _v, ...corpo } = emCache;
        return { ...corpo, cache: true };
      }
    } else {
      // O teste de OAuth precisa renovar de verdade, não reaproveitar o access token do worker.
      limparCacheGoogle();
    }
    const agora = deps.agora();
    const desde = new Date(agora.getTime() - JANELA_ESCRITA_MS).toISOString();
    const [meta, escritas] = await Promise.all([
      metaCtx(),
      store.escritasOk(desde).catch((e) => {
        deps.log("warn", "marketing_conexoes_registro_falhou", { mensagem: semSegredo(mensagemDe(e)).slice(0, 300) });
        return [] as EscritaOk[];
      }),
    ]);
    const g = config.google;
    const diagnostico = await diagnosticarConexoes({
      meta,
      google: {
        cred: await googleCred(), developerToken: g.developerToken, customerId: g.customerId, loginCustomerId: g.loginCustomerId,
        ga4PropertyId: g.ga4PropertyId, gscSiteUrl: g.gscSiteUrl, criacaoLiberada: config.googleCriacaoLiberada,
      },
      escritas,
      agora,
    });
    for (const c of diagnostico.capacidades) {
      if (c.estado === "erro" || c.estado === "sem_permissao") {
        deps.log("warn", "marketing_conexao_falhou", { capacidade: c.id, estado: c.estado, mensagem: c.detalhe });
      }
    }
    const corpo = { gerado_em: agora.toISOString(), ...diagnostico };
    await store.cacheGravar(CHAVE_CONEXOES, { v: VERSAO_CACHE, ...corpo }, TTL_CONEXOES).catch(() => undefined);
    return { ...corpo, cache: false };
  }

  // Contrato de toda escrita (R6): registra `executando` antes de chamar a API,
  // e o mesmo request_id nunca executa duas vezes (duplo clique do dot).
  async function acao(
    req: Request,
    ch: Chamador,
    corpo: Record<string, unknown>,
    tipo: string,
    alvo: string | null,
    payload: unknown,
    executar: () => Promise<{ result: unknown; external_ids?: unknown; privado?: Record<string, unknown> }>,
  ): Promise<Response> {
    const rid = validarRequestId(corpo.request_id);
    if (!rid) return erro(req, 422, "INVALID_REQUEST", "request_id ausente ou inválido.", { campos: ["request_id"] });
    const inicio = await store.acaoIniciar({
      request_id: rid, actor_user_id: ch.userId, actor_role: ch.role ?? "", kind: tipo, target: alvo, payload,
    });
    if ("existente" in inicio) {
      const a = inicio.existente;
      if (a.status === "executando") return erro(req, 409, "EM_ANDAMENTO", "Esta ação já está sendo executada.", { acao_id: a.id });
      return json(req, a.status === "ok" ? 200 : 502, {
        acao_id: a.id, status: a.status, idempotente: true, resultado: a.result, ids_externos: a.external_ids, erro: a.error,
      });
    }
    try {
      const saida = await executar();
      await store.acaoFinalizar(inicio.id, { status: "ok", result: saida.result, external_ids: saida.external_ids ?? null });
      deps.log("info", "marketing_acao_ok", { tipo, papel: ch.role });
      return json(req, 200, { acao_id: inicio.id, status: "ok", resultado: saida.result, ids_externos: saida.external_ids ?? null, ...(saida.privado ?? {}) });
    } catch (e) {
      if (e instanceof HttpErro) {
        await store.acaoFinalizar(inicio.id, { status: "erro", error: e.message });
        throw e;
      }
      const mensagem = mensagemDe(e);
      const ids = e instanceof MetaEscritaError ? e.externalIds : null;
      await store.acaoFinalizar(inicio.id, { status: "erro", error: mensagem, external_ids: ids });
      deps.log("warn", "marketing_acao_erro", { tipo, papel: ch.role, mensagem: mensagem.slice(0, 300) });
      return json(req, 502, { acao_id: inicio.id, status: "erro", erro: mensagem, ids_externos: ids });
    }
  }

  async function exigirMeta(): Promise<MetaCtx> {
    const ctx = await metaCtx();
    if (!ctx) throw new HttpErro(503, "NAO_CONFIGURADO", "Meta ainda não configurada: falta o token do usuário do sistema.");
    return ctx;
  }

  async function exigirAds(): Promise<AdsCtx> {
    const ctx = await adsCtx();
    if (!ctx) throw new HttpErro(503, "NAO_CONFIGURADO", "Google Ads ainda não configurado: faltam credenciais ou ids.");
    return ctx;
  }

  // ---------------------------------------------------------- Publicador (cron)

  async function publicarVencidos(): Promise<{ processados: number; publicados: number; falhas: number; em_processamento: number }> {
    const posts = await store.postsReservarVencidos(5);
    const saida = { processados: posts.length, publicados: 0, falhas: 0, em_processamento: 0 };
    if (!posts.length) return saida;
    const ativos = await store.ativos();
    const ctx = await metaCtx();

    for (const post of posts) {
      const rede = post.account_id === ativos.metaInstagram?.id ? "instagram" : post.account_id === ativos.metaPage?.id ? "facebook" : null;
      try {
        if (!ctx) throw new Error("Meta ainda não configurada.");
        if (!rede) throw new Error("Conta do post não é o Instagram nem a Página da nó.");
        const urls = await Promise.all((post.media_urls ?? []).map((m) => store.urlLeitura(m, 3600)));
        const alvo: PostParaPublicar = { rede, tipo: post.media_type, legenda: post.caption ?? "", urls, containerId: post.meta_container_id };
        const r = rede === "instagram" ? await publicarInstagram(ctx, alvo, deps.esperar) : await publicarFacebook(ctx, alvo);
        if (r.status === "processando") {
          await store.postAtualizar(post.id, { status: "scheduled", meta_container_id: r.containerId });
          saida.em_processamento += 1;
          continue;
        }
        await store.postAtualizar(post.id, {
          status: "published", published_at: deps.agora().toISOString(), external_post_id: r.externalPostId,
          meta_container_id: r.containerId, error_message: null,
        });
        await registrarSistema(`publicar:${post.id}:ok`, post, "ok", { external_post_id: r.externalPostId }, null);
        saida.publicados += 1;
      } catch (e) {
        const mensagem = mensagemDe(e);
        const tentativas = post.publish_attempts + 1;
        const desistir = tentativas >= 3;
        await store.postAtualizar(post.id, {
          status: desistir ? "failed" : "scheduled", publish_attempts: tentativas, error_message: mensagem.slice(0, 1000),
        });
        await registrarSistema(`publicar:${post.id}:${tentativas}`, post, "erro", null, mensagem);
        saida.falhas += 1;
      }
    }
    return saida;
  }

  async function registrarSistema(rid: string, post: PostRow, status: "ok" | "erro", ids: Record<string, string> | null, msg: string | null) {
    const inicio = await store.acaoIniciar({
      request_id: rid, actor_user_id: post.created_by, actor_role: "SISTEMA", kind: "post.publicar", target: post.id,
      payload: { post_id: post.id, agendado_por: post.created_by_role, tipo: post.media_type },
    }).catch(() => null);
    if (inicio && "id" in inicio) await store.acaoFinalizar(inicio.id, { status, external_ids: ids, error: msg, result: ids });
  }

  // --------------------------------------------------------------- Roteamento

  // Autorização própria (membro do cliente ou NO_ADMIN aal2); não passa por `autorizar`.
  const rotasCliente = criarRotasCliente({ deps, json, erro, bloco, periodo });

  async function atender(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const partes = rota(req);
    const m = req.method;
    const [r0, r1, r2, r3] = partes;

    // Auditor: /internal/auditor/*, /cliente/excluir-conta e /auditor/operacao; antes de /cliente/* e de autorizar().
    const doAuditor = deps.auditor ? await deps.auditor(req, partes, json, erro) : null;
    if (doAuditor) return doAuditor;
    if (r0 === "cliente") return await rotasCliente(req, url, partes);

    if (m === "POST" && r0 === "internal" && r1 === "publish-due" && partes.length === 2) {
      const segredo = req.headers.get("x-cron-secret") ?? "";
      if (!segredo || !(await store.cronSecretOk(segredo))) return erro(req, 401, "UNAUTHENTICATED", "Chamada interna sem segredo válido.");
      return json(req, 200, await publicarVencidos());
    }

    if (m === "GET" && r0 === "google" && r1 === "callback" && partes.length === 2) {
      const voltar = (motivo?: string) => {
        const destino = new URL("/no/marketing/conexoes", config.appUrl);
        destino.searchParams.set("google", motivo ? "erro" : "ok");
        if (motivo) destino.searchParams.set("motivo", motivo);
        return new Response(null, { status: 303, headers: { Location: destino.toString(),
          "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
      };
      const state = url.searchParams.get("state") ?? "";
      if (!/^[a-f0-9]{64}$/.test(state)) return voltar("state_invalido");
      let dono: { user_id: string } | null;
      try { dono = await store.googleStateConsumir?.(state) ?? null; }
      catch { return voltar("state_invalido"); }
      if (!dono) return voltar("state_invalido");
      if (url.searchParams.get("error") === "access_denied") return voltar("access_denied");
      const code = url.searchParams.get("code");
      if (url.searchParams.has("error") || !code || !config.google.clientId || !config.google.clientSecret || !store.googleConexaoSalvar) return voltar("troca_falhou");
      try {
        const refreshToken = await googleTrocarCodigo(config.google.clientId, config.google.clientSecret, code, callbackGoogle);
        await store.googleConexaoSalvar(dono.user_id, refreshToken, deps.uuid());
        limparCacheGoogle();
        for (const prefix of ["ga4:", "gsc:", "google_ads:", "campanhas_google:", "connections:", CHAVE_CONEXOES]) {
          await store.cacheLimpar(prefix).catch(() => undefined);
        }
        return voltar();
      } catch { return voltar("troca_falhou"); }
    }

    const token = bearer(req);
    const ch = token ? await deps.autenticar(token) : null;
    const soAdmin = r0 === "agent" || r0 === "leads" || (r0 === "google" && r1 === "connect");
    autorizar(ch, soAdmin);
    const chamador = ch as Chamador;
    const fresco = url.searchParams.get("fresco") === "1";
    const recebido: unknown = m === "GET" ? {} : await req.json().catch(() => ({}));
    const corpo = recebido && typeof recebido === "object" && !Array.isArray(recebido) ? recebido as Record<string, unknown> : {};

    if (r0 === "leads" && m === "GET" && partes.length === 1) {
      const { inicio, fimExclusivo } = limitesUtc(periodo(url));
      return json(req, 200, { leads: await store.leadsListar(inicio, fimExclusivo) });
    }
    if (r0 === "leads" && m === "POST" && partes.length === 3 && partes[2] === "classificacao") {
      const id = partes[1];
      const campos: string[] = [];
      if (!validarUuid(id)) campos.push("lead_id");
      if (typeof corpo.classe !== "string" || !["real", "teste", "invalido", "duplicado"].includes(corpo.classe)) campos.push("classe");
      if (corpo.motivo !== undefined && (typeof corpo.motivo !== "string" || [...corpo.motivo].length > 500)) campos.push("motivo");
      if (!campos.includes("lead_id") && !(await store.leadExiste(id))) campos.push("lead_id");
      if (campos.length) return erro(req, 422, "INVALID_REQUEST", "Classificação inválida.", { campos });
      const payload = { lead_id: id, classe: corpo.classe as ClasseLead, motivo: (corpo.motivo as string | undefined) ?? null };
      return acao(req, chamador, corpo, "lead.classificar", id, payload, async () => {
        await store.leadClassificar({ ...payload, classificado_por: chamador.userId, papel: chamador.role! });
        await store.cacheLimpar("leads:").catch(() => undefined);
        return { result: { lead_id: id, classe: payload.classe } };
      });
    }

    if (m === "POST" && r0 === "google" && r1 === "connect" && partes.length === 2) {
      if (!config.google.clientId || !config.google.clientSecret || !store.googleStateConsumir || !store.googleConexaoSalvar) {
        return erro(req, 503, "NAO_CONFIGURADO", "Conexão Google ainda não configurada.");
      }
      const state = googleState();
      await store.cacheGravar(`google_oauth_state:${state}`, { user_id: chamador.userId }, 600);
      const resposta = json(req, 200, { url: googleConsentimento(config.google.clientId, state, callbackGoogle) });
      resposta.headers.set("Cache-Control", "no-store");
      return resposta;
    }

    // ----------------------------------------------------------------- Leitura
    if (m === "GET") {
      if (r0 === "config" && partes.length === 1) {
        const a = await store.ativos();
        const g = config.google;
        return json(req, 200, {
          papel: chamador.role,
          meta: { token: Boolean(config.metaToken), conta_anuncios: a.metaAds?.externalId ?? null, pagina: a.metaPage?.externalId ?? null, instagram: a.metaInstagram?.externalId ?? null },
          google: {
            credenciais: Boolean(await googleCred()), ads: Boolean(g.developerToken && g.customerId), ga4: Boolean(g.ga4PropertyId),
            search_console: g.gscSiteUrl, criacao_liberada: config.googleCriacaoLiberada,
          },
        });
      }
      if (r0 === "overview" && partes.length === 1) {
        const p = periodo(url);
        const b = blocos(p, fresco);
        const [meta_ads, google_ads, ga4, search_console, instagram, facebook, leads] = await Promise.all([
          b.meta_ads(), b.google_ads(), b.ga4(), b.search_console(), b.instagram(), b.facebook(), b.leads(),
        ]);
        return json(req, 200, { periodo: p, gerado_em: deps.agora().toISOString(), blocos: { meta_ads, google_ads, ga4, search_console, instagram, facebook, leads } });
      }
      if (r0 === "organic" && partes.length === 1) {
        const p = periodo(url);
        const b = blocos(p, fresco);
        const [instagram, facebook] = await Promise.all([b.instagram(), b.facebook()]);
        return json(req, 200, { periodo: p, blocos: { instagram, facebook } });
      }
      if (r0 === "search" && partes.length === 1) {
        const p = periodo(url);
        return json(req, 200, { periodo: p, blocos: { search_console: await blocos(p, fresco).search_console() } });
      }
      if (r0 === "campaigns" && partes.length === 1) {
        const p = periodo(url);
        const plataforma = url.searchParams.get("plataforma") ?? "todas";
        const ttl = ttlSegundos(p, deps.agora());
        const k = (n: string) => `campanhas_${n}:${p.de}:${p.ate}`;
        // Nas linhas de campanha, métrica `null` (ex.: lpv) = `indisponivel`; o bloco só marca parcial/atrasado.
        const atrasado = p.ate >= hojeSaoPaulo(deps.agora());
        const meta = plataforma === "google" ? null : await bloco(k("meta"), ttl, fresco, {
          atrasado,
          ler: async () => {
            const ctx = await metaCtx();
            return ctx?.adAccountId ? await metaCampanhas(ctx, p) : null;
          },
        });
        const google = plataforma === "meta" ? null : await bloco(k("google"), ttl, fresco, {
          atrasado,
          ler: async () => {
            const ctx = await adsCtx();
            return ctx ? await adsCampanhas(ctx, p) : null;
          },
        });
        return json(req, 200, { periodo: p, blocos: { meta, google } });
      }
      if (r0 === "campaigns" && r1 && partes.length === 2) {
        const p = periodo(url);
        const plataforma = url.searchParams.get("plataforma");
        if (plataforma === "meta") {
          if (!/^\d{1,30}$/.test(r1)) return erro(req, 422, "INVALID_REQUEST", "Id de campanha inválido.");
          return json(req, 200, { periodo: p, ...(await metaCampanhaDetalhe(await exigirMeta(), r1, p)) });
        }
        if (plataforma === "google") return json(req, 200, { periodo: p, ...(await adsCampanhaDetalhe(await exigirAds(), r1, p)) });
        return erro(req, 422, "INVALID_REQUEST", "Informe plataforma=meta ou plataforma=google.");
      }
      if (r0 === "posts" && partes.length === 1) {
        const hoje = hojeSaoPaulo(deps.agora());
        const de = url.searchParams.get("de") ?? addDias(hoje, -7);
        const ate = url.searchParams.get("ate") ?? addDias(hoje, 35);
        const p = parsePeriodo(`${de}..${ate}`, new Date(`${addDias(ate, 1)}T12:00:00Z`));
        if (!p) return erro(req, 422, "PERIODO_INVALIDO", "Use de=AAAA-MM-DD e ate=AAAA-MM-DD.");
        const [posts, ativos] = await Promise.all([
          store.postsListar(new Date(`${p.de}T00:00:00-03:00`).toISOString(), new Date(`${addDias(p.ate, 1)}T00:00:00-03:00`).toISOString()),
          store.ativos(),
        ]);
        return json(req, 200, {
          de: p.de, ate: p.ate,
          posts: posts.map((post) => ({
            id: post.id,
            rede: post.account_id === ativos.metaInstagram?.id ? "instagram" : "facebook",
            tipo: post.media_type,
            legenda: post.caption ?? "",
            midias: post.media_urls ?? [],
            agendado_para: post.scheduled_at,
            publicado_em: post.published_at,
            status: post.status,
            id_externo: post.external_post_id,
            erro: post.error_message,
            criado_por_papel: post.created_by_role,
          })),
        });
      }
      if (r0 === "connections" && partes.length === 1) return json(req, 200, await conexoes(fresco));
      if (r0 === "actions" && partes.length === 1) {
        const limite = Math.min(Math.max(Number(url.searchParams.get("limite") ?? 100) || 100, 1), 500);
        return json(req, 200, { acoes: await store.acoesListar(limite) });
      }
      if ((r0 === "meta" || r0 === "google") && r1 === "locais" && partes.length === 2) {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (q.length < 2 || q.length > 80) return erro(req, 422, "INVALID_REQUEST", "Busca de local com 2 a 80 caracteres.");
        const locais = r0 === "meta" ? await metaSugerirLocais(await exigirMeta(), q) : await adsSugerirLocais(await exigirAds(), q);
        return json(req, 200, { locais });
      }
      if (r0 === "agent" && partes.length === 1) return json(req, 200, { agentes: await store.agentesListar() });
      return erro(req, 404, "NOT_FOUND", "Rota não encontrada.");
    }

    // ----------------------------------------------------------------- Escrita
    if (m === "POST" && r0 === "meta" && r1 === "campaigns" && partes.length === 2) {
      const v = validarCampanhaMeta(corpo);
      if (!v.ok) return erro(req, 422, "INVALID_REQUEST", "Campos inválidos.", { campos: v.campos });
      const ctx = await exigirMeta();
      const resp = await acao(req, chamador, corpo, "meta.campanha.criar", "meta", v.valor, async () => {
        const midia = v.valor.criativo.tipo === "imagem"
          ? { tipo: "imagem" as const, bytesBase64: base64(await store.baixarMidia(v.valor.criativo.midia)) }
          : { tipo: "video" as const, url: await store.urlLeitura(v.valor.criativo.midia, 3600) };
        return await metaCriarCampanha(ctx, v.valor, midia, deps.esperar);
      });
      await store.cacheLimpar("campanhas_meta");
      return resp;
    }
    if ((m === "PATCH" || m === "POST") && r0 === "meta" && ["campaign", "adset", "ad"].includes(r1 ?? "") && r2 && /^\d{1,30}$/.test(r2)) {
      if (m === "POST" && r3 === "status" && partes.length === 4) {
        const status = corpo.status === "ACTIVE" || corpo.status === "PAUSED" ? corpo.status : null;
        if (!status) return erro(req, 422, "INVALID_REQUEST", "status deve ser ACTIVE ou PAUSED.", { campos: ["status"] });
        const ctx = await exigirMeta();
        const nivel = r1 as "campaign" | "adset" | "ad";
        const resp = await acao(req, chamador, corpo, `meta.${nivel}.status`, r2, { status }, () => metaAlterarStatus(ctx, nivel, r2, status));
        await store.cacheLimpar("campanhas_meta");
        return resp;
      }
      if (m === "PATCH" && partes.length === 3) {
        const v = validarEdicaoMeta(r1, corpo);
        if (!v.ok) return erro(req, 422, "INVALID_REQUEST", "Campos inválidos.", { campos: v.campos });
        const ctx = await exigirMeta();
        const resp = await acao(req, chamador, corpo, `meta.${v.valor.nivel}.editar`, r2, v.valor.edicao,
          () => metaAtualizar(ctx, v.valor.nivel, r2, v.valor.edicao));
        await store.cacheLimpar("campanhas_meta");
        return resp;
      }
    }
    if (m === "POST" && r0 === "google" && r1 === "campaigns" && partes.length === 2) {
      if (!config.googleCriacaoLiberada) {
        return erro(req, 503, "GOOGLE_CRIACAO_BLOQUEADA", "Criação no Google Ads bloqueada até a prova V6 (Explorer Access).");
      }
      const v = validarCampanhaGoogle(corpo);
      if (!v.ok) return erro(req, 422, "INVALID_REQUEST", "Campos inválidos.", { campos: v.campos });
      const ctx = await exigirAds();
      const sufixo = String(corpo.request_id ?? "").slice(-8);
      const resp = await acao(req, chamador, corpo, "google.campanha.criar", "google", v.valor, () => adsCriarCampanhaPesquisa(ctx, v.valor, sufixo));
      await store.cacheLimpar("campanhas_google");
      return resp;
    }
    if ((m === "PATCH" || m === "POST") && r0 === "google" && r1 === "campaigns" && r2 && /^\d{1,20}$/.test(r2)) {
      if (m === "POST" && r3 === "status" && partes.length === 4) {
        const status = corpo.status === "ENABLED" || corpo.status === "PAUSED" ? corpo.status : null;
        if (!status) return erro(req, 422, "INVALID_REQUEST", "status deve ser ENABLED ou PAUSED.", { campos: ["status"] });
        const ctx = await exigirAds();
        const resp = await acao(req, chamador, corpo, "google.campanha.status", r2, { status }, () => adsAlterarStatus(ctx, r2, status));
        await store.cacheLimpar("campanhas_google");
        return resp;
      }
      if (m === "PATCH" && partes.length === 3) {
        const centavos = corpo.orcamento_diario_centavos;
        if (typeof centavos !== "number" || !Number.isInteger(centavos) || centavos < 100 || centavos > 100_000_000) {
          return erro(req, 422, "INVALID_REQUEST", "Campos inválidos.", { campos: ["orcamento_diario_centavos"] });
        }
        const ctx = await exigirAds();
        const resp = await acao(req, chamador, corpo, "google.campanha.orcamento", r2, { orcamento_diario_centavos: centavos },
          () => adsAtualizarOrcamento(ctx, r2, centavos));
        await store.cacheLimpar("campanhas_google");
        return resp;
      }
    }
    if (m === "POST" && r0 === "posts" && partes.length === 1) {
      const v = validarPost(corpo, deps.agora());
      if (!v.ok) return erro(req, 422, "INVALID_REQUEST", "Campos inválidos.", { campos: v.campos });
      const ativos = await store.ativos();
      const conta = v.valor.rede === "instagram" ? ativos.metaInstagram : ativos.metaPage;
      if (!conta || !ativos.clientId) {
        return erro(req, 503, "NAO_CONFIGURADO", `Conta ${v.valor.rede === "instagram" ? "do Instagram" : "da Página"} ainda não cadastrada.`);
      }
      return await acao(req, chamador, corpo, "post.agendar", v.valor.rede, v.valor, async () => {
        const post = await store.postInserir({
          client_id: ativos.clientId as string,
          account_id: conta.id,
          scheduled_at: v.valor.agendado_para,
          media_type: v.valor.tipo,
          caption: v.valor.legenda,
          media_urls: v.valor.midias,
          status: "scheduled",
          created_by: chamador.userId,
          created_by_role: chamador.role,
        });
        return { result: { post_id: post.id, agendado_para: post.scheduled_at }, external_ids: { post_id: post.id } };
      });
    }
    if (m === "DELETE" && r0 === "posts" && r1 && partes.length === 2) {
      const id = validarUuid(r1);
      if (!id) return erro(req, 422, "INVALID_REQUEST", "Id de post inválido.");
      const rid = corpo.request_id ?? url.searchParams.get("request_id");
      return await acao(req, chamador, { request_id: rid }, "post.cancelar", id, { post_id: id }, async () => {
        const post = await store.postBuscar(id);
        if (!post) throw new HttpErro(404, "NOT_FOUND", "Post não encontrado.");
        if (post.status !== "scheduled" && post.status !== "draft") {
          throw new HttpErro(409, "POST_JA_SAIU", `O post está "${post.status}" e não pode mais ser cancelado.`);
        }
        await store.postAtualizar(id, { status: "cancelled" });
        return { result: { status: "cancelled" }, external_ids: { post_id: id } };
      });
    }
    if (m === "POST" && r0 === "media" && partes.length === 1) {
      const v = validarUpload(corpo);
      if (!v.ok) return erro(req, 422, "INVALID_REQUEST", "Campos inválidos.", { campos: v.campos });
      const caminho = caminhoMidia(v.valor.nome, v.valor.mime, deps.uuid(), deps.agora());
      const up = await store.urlUpload(caminho);
      return json(req, 200, { caminho: up.path, url_upload: up.signedUrl, token: up.token });
    }
    if (m === "POST" && r0 === "agent" && partes.length === 2) {
      if (r1 === "create") {
        const email = validarEmail(corpo.email);
        if (!email) return erro(req, 422, "INVALID_REQUEST", "E-mail inválido.", { campos: ["email"] });
        return await acao(req, chamador, corpo, "dot.criar", email, { email }, async () => {
          try {
            const r = await store.agenteConvidar(email, `${config.appUrl}/no/marketing/acesso`);
            return { result: { user_id: r.userId }, external_ids: { user_id: r.userId }, privado: { convite_link: r.link } };
          } catch (e) {
            if (e instanceof ConflitoError) throw new HttpErro(409, "AUTH_ROLE_CONFLICT", e.message);
            throw e;
          }
        });
      }
      if (r1 === "disable" || r1 === "enable") {
        const alvo = validarUuid(corpo.user_id);
        if (!alvo) return erro(req, 422, "INVALID_REQUEST", "user_id inválido.", { campos: ["user_id"] });
        return await acao(req, chamador, corpo, r1 === "disable" ? "dot.desligar" : "dot.religar", alvo, { user_id: alvo }, async () => {
          // Nunca bane uma conta que não seja do dot (o próprio Lucca, clientes…).
          if ((await store.agentePapel(alvo)) !== "MARKETING_AGENT") throw new HttpErro(409, "NAO_E_DOT", "Esta conta não é do dot.");
          await store.agenteBanir(alvo, r1 === "disable");
          return { result: { banido: r1 === "disable" }, external_ids: { user_id: alvo } };
        });
      }
    }
    return erro(req, 404, "NOT_FOUND", "Rota não encontrada.");
  }

  return async function handler(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    try {
      return await atender(req);
    } catch (e) {
      if (e instanceof HttpErro) return erro(req, e.status, e.code, e.message, e.extra);
      const mensagem = mensagemDe(e);
      deps.log("error", "marketing_hub_falhou", { mensagem: mensagem.slice(0, 300) });
      const status = e instanceof GoogleApiError || e instanceof MetaApiError ? 502 : 500;
      return erro(req, status, status === 502 ? "PLATAFORMA_FALHOU" : "INTERNAL", mensagem);
    }
  };
}

