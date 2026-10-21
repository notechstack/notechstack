// Rotas /cliente/* do marketing-hub: "Conectar com Facebook/Google" do auditor,
// uma conexão por cliente, tokens no Vault. Nada aqui lê config.metaToken nem o
// refresh token da Nó: as credenciais da Nó continuam só nos caminhos do admin.
//
//   POST /cliente/{meta|google}/conectar   {client_id}          → { url } (para /ir)
//   GET  /cliente/{meta|google}/ir?state=…                      → cookie + 303 ao provedor
//   GET  /cliente/{meta|google}/callback?code&state             → Vault + 303 à retrospectiva
//   GET  /cliente/conexoes?client_id=…                          → estado + contas escolhidas
//   GET  /cliente/{meta|google}/contas?client_id=…              → contas que o cliente pode escolher
//   POST /cliente/{meta|google}/contas     {client_id, …}       → grava a seleção
//   POST /cliente/{meta|google}/revogar    {client_id}          → revoga no provedor e apaga do Vault
//   GET  /cliente/overview?client_id=…&periodo=…                → métricas com as credenciais do cliente

import { MetaApiError } from "../_shared/meta.ts";
import { type ContaSelecionavel, type TipoAtivo, googleContas, metaContasAnuncio } from "../_shared/marketing/contas-cliente.ts";
import { codigoGraph, semSegredo } from "../_shared/marketing/estados.ts";
import { ga4Resumo } from "../_shared/marketing/ga4.ts";
import { adsResumo } from "../_shared/marketing/google-ads.ts";
import { GoogleApiError, googleAccessToken } from "../_shared/marketing/google-auth.ts";
import { gscResumo } from "../_shared/marketing/gsc.ts";
import { metaResumo } from "../_shared/marketing/meta.ts";
import { type MetricasPagas, addDias, hojeSaoPaulo, ttlSegundos, type Periodo } from "../_shared/marketing/normalize.ts";
import {
  type MotivoOauth,
  OauthErro,
  PROVEDORES,
  type Provedor,
  STATE_TTL_S,
  assinarState,
  googleTrocarCodigoCliente,
  lerState,
  metaTrocarCodigo,
  novoNonce,
  pkceChallenge,
  pkceVerifier,
  revogarNoProvedor,
  urlConsentimentoGoogle,
  urlConsentimentoMeta,
} from "../_shared/marketing/oauth-cliente.ts";
import { validarUuid } from "../_shared/marketing/validacao.ts";
import type { Bloco, Chamador, Deps, Leitura } from "./handler.ts";

// ----------------------------------------------------------------- Contratos

export type EstadoConexao = "conectado" | "expirado" | "revogado" | "erro";

export type ConexaoCliente = {
  provedor: Provedor;
  estado: EstadoConexao;
  escopos: string[];
  expira_em: string | null;
  conectado_em: string | null;
  atualizado_em: string | null;
  ultimo_erro: string | null;
};

export type AtivoCliente = { tipo: TipoAtivo; external_id: string; nome: string | null; login_customer_id: string | null };

export interface ClienteStore {
  // Identidade provisória (Frente 3 decide): membro do cliente em `memberships`.
  clienteAutorizado(userId: string, clientId: string): Promise<boolean>;
  nonceRegistrar(nonce: string, expiraEm: string): Promise<void>;
  // true só na primeira vez e dentro da validade.
  nonceConsumir(nonce: string): Promise<boolean>;
  conexaoSalvar(l: {
    clientId: string; provedor: Provedor; token: string; escopos: string[]; expiraEm: string | null;
    usuarioExterno: string | null; userId: string;
  }): Promise<void>;
  // Só devolve o token de conexão `conectado`. Nunca sai da função.
  tokenLer(clientId: string, provedor: Provedor): Promise<{ token: string; escopos: string[] } | null>;
  conexoesListar(clientId: string): Promise<ConexaoCliente[]>;
  conexaoMarcar(clientId: string, provedor: Provedor, estado: "expirado" | "erro", erro: string): Promise<void>;
  conexaoRevogar(clientId: string, provedor: Provedor, userId: string | null): Promise<void>;
  ativosListar(clientId: string): Promise<AtivoCliente[]>;
  ativosSalvar(clientId: string, provedor: Provedor, ativos: AtivoCliente[], userId: string): Promise<void>;
}

export type ClientesConfig = {
  stateSecret: string | null;
  // Base pública da função (redirect_uri) e destino da volta. Fixos por config: sem redirect aberto.
  hubUrl: string;
  retroUrl: string;
  meta: { appId: string | null; appSecret: string | null; configId: string | null };
};

type Resp = (req: Request, status: number, corpo: unknown) => Response;
type Erro = (req: Request, status: number, code: string, mensagem: string, extra?: Record<string, unknown>) => Response;

type BlocoFn = <T>(chave: string, ttl: number, fresco: boolean, leitura: Leitura<T>) => Promise<Bloco<T>>;

type Ferramentas = {
  deps: Deps;
  json: Resp;
  erro: Erro;
  bloco: BlocoFn;
  periodo: (url: URL) => Periodo;
};

const COOKIE = (p: Provedor) => `__Host-no_oauth_${p}`;
const pagas = (d: { total: MetricasPagas }) => ({ periodo: { ...d.total } });

class Negado extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------- Rotas

export function criarRotasCliente(f: Ferramentas) {
  const { deps, json, erro } = f;
  const cfg = deps.config.clientes;
  const store = deps.clienteStore;
  const google = deps.config.google;

  const callbackUrl = (p: Provedor) => `${cfg!.hubUrl}/cliente/${p}/callback`;

  function configurado(p: Provedor): boolean {
    // Segredo curto demais deixaria o state forjável por força bruta.
    if (!cfg?.stateSecret || cfg.stateSecret.length < 32 || !store) return false;
    return p === "meta"
      ? Boolean(cfg.meta.appId && cfg.meta.appSecret)
      : Boolean(google.clientId && google.clientSecret);
  }

  async function autorizar(req: Request, clientId: string | null): Promise<{ ch: Chamador; clientId: string }> {
    const v = req.headers.get("authorization") ?? "";
    const token = v.startsWith("Bearer ") ? v.slice(7) : "";
    const ch = token ? await deps.autenticar(token) : null;
    if (!ch || ch.banido) throw new Negado(401, "UNAUTHENTICATED", "Sessão inválida ou conta desligada.");
    const id = validarUuid(clientId);
    if (!id) throw new Negado(422, "INVALID_REQUEST", "client_id ausente ou inválido.");
    if (ch.role === "NO_ADMIN") {
      if (ch.aal !== "aal2") throw new Negado(403, "MFA_REQUIRED", "Conclua o segundo fator.");
      return { ch, clientId: id };
    }
    // O dot opera o marketing da Nó, não as contas dos clientes.
    if (ch.role !== "MARKETING_AGENT" && store && await store.clienteAutorizado(ch.userId, id)) return { ch, clientId: id };
    // Mesma resposta para cliente inexistente e cliente de outro: não revela ids.
    throw new Negado(403, "FORBIDDEN", "Sem acesso a este cliente.");
  }

  function voltar(p: Provedor | null, motivo?: MotivoOauth, limparCookie = true): Response {
    const destino = new URL(cfg?.retroUrl ?? "https://www.notechstack.com.br/agentes/auditor/retrospectiva/");
    if (p) destino.searchParams.set("conexao", p);
    destino.searchParams.set("resultado", motivo ? "erro" : "ok");
    if (motivo) destino.searchParams.set("motivo", motivo);
    const h = new Headers({ Location: destino.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    if (p && limparCookie) h.append("Set-Cookie", `${COOKIE(p)}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    return new Response(null, { status: 303, headers: h });
  }

  function lerCookie(req: Request, nome: string): string | null {
    for (const parte of (req.headers.get("cookie") ?? "").split(";")) {
      const [k, ...v] = parte.trim().split("=");
      if (k === nome) return v.join("=");
    }
    return null;
  }

  async function corpoJson(req: Request): Promise<Record<string, unknown>> {
    const r: unknown = await req.json().catch(() => ({}));
    return r && typeof r === "object" && !Array.isArray(r) ? r as Record<string, unknown> : {};
  }

  // Token do cliente que a plataforma recusou vira "expirado" para a tela pedir reconexão.
  async function marcarSeExpirou(clientId: string, p: Provedor, e: unknown): Promise<void> {
    const expirou = p === "meta"
      ? e instanceof MetaApiError && codigoGraph(e) === 190
      : e instanceof GoogleApiError && (e.body as { error?: string } | null)?.error === "invalid_grant";
    if (expirou) {
      await store!.conexaoMarcar(clientId, p, "expirado", p === "meta" ? "Token da Meta expirado ou revogado." : "Google: invalid_grant").catch(() => undefined);
      await deps.store.cacheLimpar(`cliente:${clientId}:`).catch(() => undefined);
    }
  }

  async function googleToken(clientId: string): Promise<{ token: string; escopos: string[] } | null> {
    const t = await store!.tokenLer(clientId, "google");
    if (!t || !google.clientId || !google.clientSecret) return null;
    try {
      const token = await googleAccessToken({ clientId: google.clientId, clientSecret: google.clientSecret, refreshToken: t.token }, deps.agora().getTime());
      return { token, escopos: t.escopos };
    } catch (e) {
      await marcarSeExpirou(clientId, "google", e);
      throw e;
    }
  }

  // ------------------------------------------------------------ OAuth: ida

  async function conectar(req: Request, p: Provedor): Promise<Response> {
    const corpo = await corpoJson(req);
    const { ch, clientId } = await autorizar(req, typeof corpo.client_id === "string" ? corpo.client_id : null);
    if (!configurado(p)) return erro(req, 503, "NAO_CONFIGURADO", `Conexão ${p === "meta" ? "Meta" : "Google"} ainda não configurada.`);
    const nonce = novoNonce();
    const exp = Math.floor(deps.agora().getTime() / 1000) + STATE_TTL_S;
    await store!.nonceRegistrar(nonce, new Date(exp * 1000).toISOString());
    const state = await assinarState(cfg!.stateSecret!, { n: nonce, c: clientId, u: ch.userId, p, e: exp });
    const url = new URL(`${cfg!.hubUrl}/cliente/${p}/ir`);
    url.searchParams.set("state", state);
    const r = json(req, 200, { url: url.toString(), expira_em: new Date(exp * 1000).toISOString() });
    r.headers.set("Cache-Control", "no-store");
    return r;
  }

  // Navegação de topo: prende o fluxo a este navegador antes de ir ao provedor.
  async function ir(url: URL, p: Provedor): Promise<Response> {
    if (!configurado(p)) return voltar(p, "nao_configurado");
    const state = url.searchParams.get("state") ?? "";
    let s;
    try { s = await lerState(cfg!.stateSecret!, state, deps.agora().getTime()); }
    catch (e) { return voltar(p, e instanceof OauthErro ? e.motivo : "state_invalido"); }
    if (s.p !== p) return voltar(p, "state_invalido");
    const challenge = await pkceChallenge(await pkceVerifier(cfg!.stateSecret!, s.n));
    const destino = p === "meta"
      ? urlConsentimentoMeta({ appId: cfg!.meta.appId!, configId: cfg!.meta.configId, redirectUri: callbackUrl(p), state, challenge })
      : urlConsentimentoGoogle({ clientId: google.clientId!, redirectUri: callbackUrl(p), state, challenge });
    const restante = Math.max(1, s.e - Math.floor(deps.agora().getTime() / 1000));
    return new Response(null, {
      status: 303,
      headers: {
        Location: destino, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "Set-Cookie": `${COOKIE(p)}=${s.n}; Path=/; Max-Age=${restante}; Secure; HttpOnly; SameSite=Lax`,
      },
    });
  }

  // ---------------------------------------------------------- OAuth: volta

  async function callback(req: Request, url: URL, p: Provedor): Promise<Response> {
    if (!configurado(p)) return voltar(p, "nao_configurado");
    let s;
    try { s = await lerState(cfg!.stateSecret!, url.searchParams.get("state") ?? "", deps.agora().getTime()); }
    catch (e) { return voltar(p, e instanceof OauthErro ? e.motivo : "state_invalido"); }
    if (s.p !== p) return voltar(p, "state_invalido");
    // O cookie só existe no navegador que passou por /ir com este state.
    if (lerCookie(req, COOKIE(p)) !== s.n) return voltar(p, "navegador_diferente", false);
    if (!(await store!.nonceConsumir(s.n))) return voltar(p, "state_reusado");
    if (url.searchParams.get("error") === "access_denied" || url.searchParams.get("error_reason") === "user_denied") return voltar(p, "access_denied");
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) return voltar(p, "troca_falhou");
    // Quem começou pode ter perdido o acesso enquanto estava no provedor.
    const ainda = await store!.clienteAutorizado(s.u, s.c).catch(() => false) || await adminAtivo(s.u);
    if (!ainda) return voltar(p, "state_invalido");
    try {
      const verifier = await pkceVerifier(cfg!.stateSecret!, s.n);
      if (p === "meta") {
        const t = await metaTrocarCodigo({ appId: cfg!.meta.appId!, appSecret: cfg!.meta.appSecret!, redirectUri: callbackUrl(p), code, verifier });
        await store!.conexaoSalvar({ clientId: s.c, provedor: p, token: t.token, escopos: t.escopos, expiraEm: t.expiraEm, usuarioExterno: t.usuarioExterno, userId: s.u });
      } else {
        const t = await googleTrocarCodigoCliente({ clientId: google.clientId!, clientSecret: google.clientSecret!, redirectUri: callbackUrl(p), code, verifier });
        await store!.conexaoSalvar({ clientId: s.c, provedor: p, token: t.refreshToken, escopos: t.escopos, expiraEm: null, usuarioExterno: null, userId: s.u });
      }
      await deps.store.cacheLimpar(`cliente:${s.c}:`).catch(() => undefined);
      deps.log("info", "marketing_cliente_conectou", { provedor: p });
      return voltar(p);
    } catch (e) {
      const motivo = e instanceof OauthErro ? e.motivo : "troca_falhou";
      deps.log("warn", "marketing_cliente_conexao_falhou", { provedor: p, motivo });
      return voltar(p, motivo);
    }
  }

  // O NO_ADMIN pode conectar por um cliente (suporte); o store responde por membros.
  async function adminAtivo(userId: string): Promise<boolean> {
    return (await deps.store.agentePapel(userId).catch(() => null)) === "NO_ADMIN";
  }

  // ---------------------------------------------------------- Contas e seleção

  async function listarContas(clientId: string, p: Provedor): Promise<Partial<Record<TipoAtivo, ContaSelecionavel[] | null>> & { falhas: { tipo: TipoAtivo; mensagem: string }[] }> {
    if (p === "meta") {
      const t = await store!.tokenLer(clientId, "meta");
      if (!t) throw new Negado(409, "NAO_CONECTADO", "Conecte o Facebook antes de escolher as contas.");
      try {
        return { meta_ads: await metaContasAnuncio(t.token), falhas: [] };
      } catch (e) {
        await marcarSeExpirou(clientId, "meta", e);
        throw e;
      }
    }
    const g = await googleToken(clientId);
    if (!g) throw new Negado(409, "NAO_CONECTADO", "Conecte o Google antes de escolher as contas.");
    const r = await googleContas(g.token, g.escopos, google.developerToken);
    return { ...r, falhas: r.falhas.map((x) => ({ ...x, mensagem: semSegredo(x.mensagem) })) };
  }

  const TIPOS_DO: Record<Provedor, TipoAtivo[]> = { meta: ["meta_ads"], google: ["google_ads", "ga4", "gsc"] };

  // Só aceita o que o próprio token do cliente lista agora: nada de id digitado.
  async function salvarSelecao(req: Request, p: Provedor): Promise<Response> {
    const corpo = await corpoJson(req);
    const { ch, clientId } = await autorizar(req, typeof corpo.client_id === "string" ? corpo.client_id : null);
    const pedidos: { tipo: TipoAtivo; id: string; login: string | null }[] = [];
    const campos: string[] = [];
    for (const tipo of TIPOS_DO[p]) {
      const v = corpo[tipo];
      if (v === undefined || v === null) continue;
      if (typeof v === "string" && v.length > 0 && v.length <= 300) pedidos.push({ tipo, id: v, login: null });
      else if (tipo === "google_ads" && v && typeof v === "object" && typeof (v as { customer_id?: unknown }).customer_id === "string") {
        const o = v as { customer_id: string; login_customer_id?: unknown };
        pedidos.push({ tipo, id: o.customer_id, login: typeof o.login_customer_id === "string" ? o.login_customer_id : null });
      } else campos.push(tipo);
    }
    if (campos.length || !pedidos.length) return erro(req, 422, "INVALID_REQUEST", "Seleção inválida.", { campos: campos.length ? campos : TIPOS_DO[p] });
    const disponiveis = await listarContas(clientId, p);
    const escolhidos: AtivoCliente[] = [];
    for (const pd of pedidos) {
      const achado = (disponiveis[pd.tipo] ?? []).find((c) => c.external_id === pd.id && (pd.tipo !== "google_ads" || c.login_customer_id === pd.login));
      if (!achado) campos.push(pd.tipo);
      else escolhidos.push({ tipo: pd.tipo, external_id: achado.external_id, nome: achado.nome, login_customer_id: achado.login_customer_id });
    }
    if (campos.length) return erro(req, 422, "CONTA_NAO_DISPONIVEL", "Conta fora da lista que esta conexão enxerga.", { campos });
    await store!.ativosSalvar(clientId, p, escolhidos, ch.userId);
    await deps.store.cacheLimpar(`cliente:${clientId}:`).catch(() => undefined);
    return json(req, 200, { ativos: escolhidos });
  }

  async function revogar(req: Request, p: Provedor): Promise<Response> {
    const corpo = await corpoJson(req);
    const { ch, clientId } = await autorizar(req, typeof corpo.client_id === "string" ? corpo.client_id : null);
    const t = await store!.tokenLer(clientId, p).catch(() => null);
    const noProvedor = t ? await revogarNoProvedor(p, t.token) : false;
    await store!.conexaoRevogar(clientId, p, ch.userId);
    await deps.store.cacheLimpar(`cliente:${clientId}:`).catch(() => undefined);
    deps.log("info", "marketing_cliente_revogou", { provedor: p, no_provedor: noProvedor });
    return json(req, 200, { provedor: p, estado: "revogado", revogado_no_provedor: noProvedor });
  }

  // ----------------------------------------------------------------- Leitura

  async function conexoes(clientId: string) {
    const agora = deps.agora().toISOString();
    const [lista, ativos] = await Promise.all([store!.conexoesListar(clientId), store!.ativosListar(clientId)]);
    const porProvedor = Object.fromEntries(PROVEDORES.map((p) => {
      const c = lista.find((x) => x.provedor === p);
      if (!c) return [p, { estado: "desconectado", configurado: configurado(p) }];
      // Token longo da Meta não renova sozinho: passou de expira_em, pede reconexão.
      const estado = c.estado === "conectado" && c.expira_em && c.expira_em <= agora ? "expirado" : c.estado;
      return [p, { ...c, estado, configurado: configurado(p) }];
    }));
    return { conexoes: porProvedor, ativos };
  }

  async function overview(clientId: string, p: Periodo, fresco: boolean) {
    const ativos = await store!.ativosListar(clientId);
    const ativo = (t: TipoAtivo) => ativos.find((a) => a.tipo === t) ?? null;
    const ttl = ttlSegundos(p, deps.agora());
    const k = (nome: string) => `cliente:${clientId}:${nome}:${p.de}:${p.ate}`;
    const hoje = hojeSaoPaulo(deps.agora());
    const atrasado = p.ate >= hoje;
    const comMarca = async <T>(prov: Provedor, f: () => Promise<T>): Promise<T> => {
      try { return await f(); } catch (e) { await marcarSeExpirou(clientId, prov, e); throw e; }
    };
    const [meta_ads, google_ads, ga4, search_console] = await Promise.all([
      f.bloco(k("meta_ads"), ttl, fresco, {
        atrasado,
        ler: async (reg) => {
          const conta = ativo("meta_ads");
          const t = conta ? await store!.tokenLer(clientId, "meta") : null;
          return t && conta ? await comMarca("meta", () => metaResumo({ token: t.token, adAccountId: conta.external_id }, p, reg)) : null;
        },
        metricas: pagas,
      }),
      f.bloco(k("google_ads"), ttl, fresco, {
        atrasado,
        ler: async () => {
          const conta = ativo("google_ads");
          if (!conta) return null;
          const g = await googleToken(clientId);
          return g ? await comMarca("google", () => adsResumo({ token: g.token, developerToken: google.developerToken ?? "", customerId: conta.external_id, loginCustomerId: conta.login_customer_id }, p)) : null;
        },
        metricas: pagas,
      }),
      f.bloco(k("ga4"), ttl, fresco, {
        atrasado,
        ler: async () => {
          const prop = ativo("ga4");
          const g = prop ? await googleToken(clientId) : null;
          return g && prop ? await comMarca("google", () => ga4Resumo(g.token, prop.external_id, p)) : null;
        },
        metricas: (d) => ({ periodo: { sessoes: d.sessoes, eventos_chave: d.eventos_chave } }),
      }),
      f.bloco(k("gsc"), ttl, fresco, {
        atrasado: p.ate >= addDias(hoje, -3),
        ler: async () => {
          const site = ativo("gsc");
          const g = site ? await googleToken(clientId) : null;
          return g && site ? await comMarca("google", () => gscResumo(g.token, site.external_id, p)) : null;
        },
        metricas: (d) => ({ periodo: { cliques: d.cliques, impressoes: d.impressoes, ctr: d.ctr } }),
      }),
    ]);
    return { periodo: p, gerado_em: deps.agora().toISOString(), blocos: { meta_ads, google_ads, ga4, search_console } };
  }

  // --------------------------------------------------------------- Roteamento

  return async function rotasCliente(req: Request, url: URL, partes: string[]): Promise<Response> {
    const m = req.method;
    const [, r1, r2] = partes;
    const prov = PROVEDORES.includes(r1 as Provedor) ? r1 as Provedor : null;
    try {
      if (!cfg || !store) return erro(req, 503, "NAO_CONFIGURADO", "Conexão de clientes ainda não configurada.");
      if (prov && m === "GET" && r2 === "ir" && partes.length === 3) return await ir(url, prov);
      if (prov && m === "GET" && r2 === "callback" && partes.length === 3) return await callback(req, url, prov);
      if (prov && m === "POST" && r2 === "conectar" && partes.length === 3) return await conectar(req, prov);
      if (prov && m === "POST" && r2 === "revogar" && partes.length === 3) return await revogar(req, prov);
      if (prov && m === "POST" && r2 === "contas" && partes.length === 3) return await salvarSelecao(req, prov);
      if (prov && m === "GET" && r2 === "contas" && partes.length === 3) {
        const { clientId } = await autorizar(req, url.searchParams.get("client_id"));
        return json(req, 200, await listarContas(clientId, prov));
      }
      if (r1 === "conexoes" && m === "GET" && partes.length === 2) {
        const { clientId } = await autorizar(req, url.searchParams.get("client_id"));
        return json(req, 200, await conexoes(clientId));
      }
      if (r1 === "overview" && m === "GET" && partes.length === 2) {
        const { clientId } = await autorizar(req, url.searchParams.get("client_id"));
        return json(req, 200, await overview(clientId, f.periodo(url), url.searchParams.get("fresco") === "1"));
      }
      return erro(req, 404, "NOT_FOUND", "Rota não encontrada.");
    } catch (e) {
      if (e instanceof Negado) return erro(req, e.status, e.code, e.message);
      throw e; // o handler converte (HttpErro, falha de plataforma) sem vazar segredo
    }
  };
}
