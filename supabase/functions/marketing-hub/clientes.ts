// Rotas /cliente/* da marketing-hub: "Conectar com Facebook/Google" do auditor
// (spec 2026-10-21-auditor-conexoes-clientes, seção 2). Uma conexão por negócio,
// tokens só no Vault. Nada aqui lê config.metaToken nem o refresh token da Nó.
//
// Públicas (o state assinado ou o signed_request é a credencial):
//   GET  /cliente/{meta|google}/ir?state=…            → cookie + 303 ao provedor
//   GET  /cliente/{meta|google}/callback?code&state   → Vault + 303 ao app
//   POST /cliente/meta/desautorizar  signed_request   → deauthorize da Meta
// Do negócio (o clientId vem da URL, nunca do corpo):
//   POST   /cliente/:clientId/:provedor/conectar      → { url } (para /ir)        membro
//   GET    /cliente/:clientId/conexoes                → estado + contas escolhidas membro ou suporte
//   GET    /cliente/:clientId/:provedor/contas        → contas que o token enxerga membro
//   POST   /cliente/:clientId/ativos                  → grava a escolha            membro
//   DELETE /cliente/:clientId/:provedor               → desconecta                 membro
//   GET    /cliente/:clientId/overview?periodo=…      → métricas do cliente        membro ou suporte

import { MetaApiError } from "../_shared/meta.ts";
import { type ContaSelecionavel, type TipoAtivo, TIPOS_ATIVO, googleContas, metaContasAnuncio } from "../_shared/marketing/contas-cliente.ts";
import { codigoGraph, semSegredo } from "../_shared/marketing/estados.ts";
import { ga4Resumo } from "../_shared/marketing/ga4.ts";
import { adsResumo } from "../_shared/marketing/google-ads.ts";
import { GoogleApiError, googleAccessToken } from "../_shared/marketing/google-auth.ts";
import { gscResumo } from "../_shared/marketing/gsc.ts";
import { metaResumo } from "../_shared/marketing/meta.ts";
import { type MetricasPagas, type Periodo, addDias, hojeSaoPaulo, ttlSegundos } from "../_shared/marketing/normalize.ts";
import {
  type MotivoOauth,
  OauthErro,
  PROVEDORES,
  type Provedor,
  STATE_TTL_S,
  assinarState,
  googleTrocarCodigoCliente,
  lerState,
  metaSignedRequest,
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

export type EstadoConexao = "conectado" | "expirado" | "revogado" | "erro" | "desconectado";

export type ConexaoCliente = {
  provedor: Provedor;
  estado: EstadoConexao;
  escopos: string[];
  expira_em: string | null;
  conectado_em: string | null;
  verificado_em: string | null;
  ultimo_erro: string | null;
  encerrado_em: string | null;
};

export type AtivoCliente = {
  tipo: TipoAtivo; external_id: string; nome: string | null; login_customer_id: string | null;
  moeda: string | null; detalhe: string | null;
};

// Leituras com o JWT do usuário: a RLS (auditor_pode_ler) é a segunda trava.
export interface LeitorCliente {
  conexoesListar(clientId: string): Promise<ConexaoCliente[]>;
  ativosListar(clientId: string): Promise<AtivoCliente[]>;
}

export interface ClienteStore {
  // Membro AUDITOR de um negócio com origem 'auditor' (spec D-identidade).
  membroAuditor(userId: string, clientId: string): Promise<boolean>;
  // NO_ADMIN aal2 com acesso de suporte vigente (migration B). Ausente = nunca.
  suporteVigente?(userId: string, clientId: string): Promise<boolean>;
  leitor(jwt: string): LeitorCliente;
  evento(e: { clientId: string | null; ator: string | null; papel: string | null; acao: string; detalhe?: Record<string, unknown> }): Promise<void>;
  nonceRegistrar(nonce: string, expiraEm: string): Promise<void>;
  // true só na primeira vez e dentro da validade.
  nonceConsumir(nonce: string): Promise<boolean>;
  conexaoSalvar(l: {
    clientId: string; provedor: Provedor; token: string; escopos: string[]; expiraEm: string | null;
    usuarioExterno: string | null; userId: string;
  }): Promise<void>;
  // Só devolve o token de conexão `conectado`. Nunca sai da função.
  tokenLer(clientId: string, provedor: Provedor): Promise<{ token: string; escopos: string[] } | null>;
  conexaoMarcar(clientId: string, provedor: Provedor, estado: "expirado" | "erro" | "verificado", codigo: string | null): Promise<void>;
  conexaoEncerrar(clientId: string, provedor: Provedor, estado: "desconectado" | "revogado", userId: string | null, papel: string): Promise<boolean>;
  metaDesautorizar(usuarioExterno: string): Promise<number>;
  ativosSalvar(clientId: string, provedor: Provedor, ativos: AtivoCliente[], userId: string): Promise<void>;
}

export type ClientesConfig = {
  stateSecret: string | null;
  // Base pública da função (redirect_uri) e destino da volta, com {client_id}. Fixos: sem redirect aberto.
  hubUrl: string;
  voltaUrl: string;
  meta: { appId: string | null; appSecret: string | null; configId: string | null };
};

type Resp = (req: Request, status: number, corpo: unknown) => Response;
type Erro = (req: Request, status: number, code: string, mensagem: string, extra?: Record<string, unknown>) => Response;
type BlocoFn = <T>(chave: string, ttl: number, fresco: boolean, leitura: Leitura<T>) => Promise<Bloco<T>>;

type Ferramentas = { deps: Deps; json: Resp; erro: Erro; bloco: BlocoFn; periodo: (url: URL) => Periodo };

type Acesso = { ch: Chamador; clientId: string; jwt: string; modo: "membro" | "suporte" };

const COOKIE = (p: Provedor) => `__Host-no_oauth_${p}`;
const TIPOS_DO: Record<Provedor, TipoAtivo[]> = { meta: ["meta_ads"], google: ["google_ads", "ga4", "gsc"] };
const PROVEDOR_DO = (t: TipoAtivo): Provedor => (t === "meta_ads" ? "meta" : "google");
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
    return p === "meta" ? Boolean(cfg.meta.appId && cfg.meta.appSecret) : Boolean(google.clientId && google.clientSecret);
  }

  // Spec seção 2: membro AUDITOR → tudo; NO_ADMIN aal2 com suporte vigente → só leitura; o resto, 403.
  async function autorizar(req: Request, clientIdBruto: string, escrita: boolean): Promise<Acesso> {
    const v = req.headers.get("authorization") ?? "";
    const jwt = v.startsWith("Bearer ") ? v.slice(7) : "";
    const ch = jwt ? await deps.autenticar(jwt) : null;
    if (!ch || ch.banido) throw new Negado(401, "UNAUTHENTICATED", "Sessão inválida ou conta desligada.");
    const clientId = validarUuid(clientIdBruto);
    // Mesma resposta para negócio inexistente, de outro ou id torto: não revela ids.
    const negar = new Negado(403, "FORBIDDEN", "Sem acesso a este negócio.");
    if (!clientId || ch.role === "MARKETING_AGENT") throw negar;
    if (ch.role === "NO_ADMIN") {
      if (ch.aal !== "aal2") throw new Negado(403, "MFA_REQUIRED", "Conclua o segundo fator.");
      if (escrita || !(await store!.suporteVigente?.(ch.userId, clientId))) throw negar;
      return { ch, clientId, jwt, modo: "suporte" };
    }
    if (await store!.membroAuditor(ch.userId, clientId)) return { ch, clientId, jwt, modo: "membro" };
    throw negar;
  }

  // Cada leitura do suporte fica na trilha (spec: "O Lucca vê o quê").
  async function registrarSuporte(a: Acesso, rota: string): Promise<void> {
    if (a.modo === "suporte") await store!.evento({ clientId: a.clientId, ator: a.ch.userId, papel: "NO_ADMIN", acao: "suporte_leu", detalhe: { rota } });
  }

  function voltar(p: Provedor | null, clientId: string | null, motivo?: MotivoOauth, limparCookie = true): Response {
    const base = cfg?.voltaUrl ?? "https://app.notechstack.com.br/auditor/{client_id}/conexoes";
    const destino = new URL(clientId ? base.replace("{client_id}", clientId) : base.replace(/\{client_id\}.*$/, ""));
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

  // Token que a plataforma recusou vira "expirado" (só o código) para a tela pedir reconexão.
  async function marcarSeExpirou(clientId: string, p: Provedor, e: unknown): Promise<void> {
    const codigo = p === "meta"
      ? (e instanceof MetaApiError && codigoGraph(e) === 190 ? "meta_190" : null)
      : (e instanceof GoogleApiError && (e.body as { error?: string } | null)?.error === "invalid_grant" ? "google_invalid_grant" : null);
    if (!codigo) return;
    await store!.conexaoMarcar(clientId, p, "expirado", codigo).catch(() => undefined);
    await deps.store.cacheLimpar(`cli:${clientId}:`).catch(() => undefined);
  }

  async function comMarca<T>(clientId: string, p: Provedor, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      store!.conexaoMarcar(clientId, p, "verificado", null).catch(() => undefined);
      return r;
    } catch (e) {
      await marcarSeExpirou(clientId, p, e);
      throw e;
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

  async function conectar(req: Request, a: Acesso, p: Provedor): Promise<Response> {
    if (!configurado(p)) return erro(req, 503, "NAO_CONFIGURADO", `Conexão ${p === "meta" ? "Meta" : "Google"} ainda não configurada.`);
    const nonce = novoNonce();
    const exp = Math.floor(deps.agora().getTime() / 1000) + STATE_TTL_S;
    await store!.nonceRegistrar(nonce, new Date(exp * 1000).toISOString());
    const state = await assinarState(cfg!.stateSecret!, { n: nonce, c: a.clientId, u: a.ch.userId, p, e: exp });
    const url = new URL(`${cfg!.hubUrl}/cliente/${p}/ir`);
    url.searchParams.set("state", state);
    const r = json(req, 200, { url: url.toString(), expira_em: new Date(exp * 1000).toISOString() });
    r.headers.set("Cache-Control", "no-store");
    return r;
  }

  // Navegação de topo: prende o fluxo a este navegador antes de ir ao provedor.
  async function ir(url: URL, p: Provedor): Promise<Response> {
    if (!configurado(p)) return voltar(p, null, "nao_configurado");
    const state = url.searchParams.get("state") ?? "";
    let s;
    try { s = await lerState(cfg!.stateSecret!, state, deps.agora().getTime()); }
    catch (e) { return voltar(p, null, e instanceof OauthErro ? e.motivo : "state_invalido"); }
    if (s.p !== p) return voltar(p, null, "state_invalido");
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
    if (!configurado(p)) return voltar(p, null, "nao_configurado");
    let s;
    try { s = await lerState(cfg!.stateSecret!, url.searchParams.get("state") ?? "", deps.agora().getTime()); }
    catch (e) { return voltar(p, null, e instanceof OauthErro ? e.motivo : "state_invalido"); }
    if (s.p !== p) return voltar(p, null, "state_invalido");
    // O cookie só existe no navegador que passou por /ir com este state.
    if (lerCookie(req, COOKIE(p)) !== s.n) return voltar(p, s.c, "navegador_diferente", false);
    if (!(await store!.nonceConsumir(s.n))) return voltar(p, s.c, "state_reusado");
    if (url.searchParams.get("error") === "access_denied" || url.searchParams.get("error_reason") === "user_denied") return voltar(p, s.c, "access_denied");
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) return voltar(p, s.c, "troca_falhou");
    // Quem começou pode ter perdido o acesso enquanto estava no provedor.
    if (!(await store!.membroAuditor(s.u, s.c).catch(() => false))) return voltar(p, null, "state_invalido");
    try {
      const verifier = await pkceVerifier(cfg!.stateSecret!, s.n);
      if (p === "meta") {
        const t = await metaTrocarCodigo({ appId: cfg!.meta.appId!, appSecret: cfg!.meta.appSecret!, redirectUri: callbackUrl(p), code, verifier });
        await store!.conexaoSalvar({ clientId: s.c, provedor: p, token: t.token, escopos: t.escopos, expiraEm: t.expiraEm, usuarioExterno: t.usuarioExterno, userId: s.u });
      } else {
        const t = await googleTrocarCodigoCliente({ clientId: google.clientId!, clientSecret: google.clientSecret!, redirectUri: callbackUrl(p), code, verifier });
        await store!.conexaoSalvar({ clientId: s.c, provedor: p, token: t.refreshToken, escopos: t.escopos, expiraEm: null, usuarioExterno: null, userId: s.u });
      }
      await deps.store.cacheLimpar(`cli:${s.c}:`).catch(() => undefined);
      deps.log("info", "marketing_cliente_conectou", { provedor: p });
      return voltar(p, s.c);
    } catch (e) {
      const motivo = e instanceof OauthErro ? e.motivo : "troca_falhou";
      deps.log("warn", "marketing_cliente_conexao_falhou", { provedor: p, motivo });
      return voltar(p, s.c, motivo);
    }
  }

  // Deauthorize da Meta: o usuário removeu o app nas configurações do Facebook.
  async function desautorizar(req: Request): Promise<Response> {
    if (!cfg?.meta.appSecret || !store) return erro(req, 503, "NAO_CONFIGURADO", "Meta ainda não configurada.");
    const form = await req.formData().catch(() => null);
    const sr = await metaSignedRequest(cfg.meta.appSecret, String(form?.get("signed_request") ?? ""));
    if (!sr) return erro(req, 400, "INVALID_REQUEST", "signed_request inválido.");
    const n = await store.metaDesautorizar(sr.userId);
    deps.log("info", "marketing_cliente_meta_desautorizou", { conexoes: n });
    return json(req, 200, { ok: true });
  }

  // ---------------------------------------------------------- Contas e seleção

  type Listagem = Partial<Record<TipoAtivo, ContaSelecionavel[] | null>> & { falhas: { tipo: TipoAtivo; mensagem: string }[] };

  async function listarContas(clientId: string, p: Provedor): Promise<Listagem> {
    if (p === "meta") {
      const t = await store!.tokenLer(clientId, "meta");
      if (!t) throw new Negado(409, "NAO_CONECTADO", "Conecte o Facebook antes de escolher as contas.");
      return { meta_ads: await comMarca(clientId, "meta", () => metaContasAnuncio(t.token)), falhas: [] };
    }
    const g = await googleToken(clientId);
    if (!g) throw new Negado(409, "NAO_CONECTADO", "Conecte o Google antes de escolher as contas.");
    const r = await googleContas(g.token, g.escopos, google.developerToken);
    return { ...r, falhas: r.falhas.map((x) => ({ ...x, mensagem: semSegredo(x.mensagem) })) };
  }

  // Só aceita o que o próprio token do cliente lista agora: nada de id digitado.
  async function salvarAtivos(req: Request, a: Acesso): Promise<Response> {
    const corpo = await corpoJson(req);
    const pedidos: { tipo: TipoAtivo; id: string; login: string | null }[] = [];
    const campos: string[] = [];
    for (const tipo of TIPOS_ATIVO) {
      const v = corpo[tipo];
      if (v === undefined || v === null) continue;
      if (tipo !== "google_ads" && typeof v === "string" && v.length > 0 && v.length <= 300) pedidos.push({ tipo, id: v, login: null });
      else if (tipo === "google_ads" && v && typeof v === "object" && typeof (v as { customer_id?: unknown }).customer_id === "string") {
        const o = v as { customer_id: string; login_customer_id?: unknown };
        pedidos.push({ tipo, id: o.customer_id, login: typeof o.login_customer_id === "string" ? o.login_customer_id : null });
      } else campos.push(tipo);
    }
    if (campos.length || !pedidos.length) return erro(req, 422, "INVALID_REQUEST", "Seleção inválida.", { campos: campos.length ? campos : [...TIPOS_ATIVO] });
    const porProvedor = new Map<Provedor, AtivoCliente[]>();
    for (const p of PROVEDORES) {
      const meus = pedidos.filter((pd) => PROVEDOR_DO(pd.tipo) === p);
      if (!meus.length) continue;
      const disponiveis = await listarContas(a.clientId, p);
      for (const pd of meus) {
        const c = (disponiveis[pd.tipo] ?? []).find((x) => x.external_id === pd.id && (pd.tipo !== "google_ads" || x.login_customer_id === pd.login));
        if (!c) campos.push(pd.tipo);
        else porProvedor.set(p, [...(porProvedor.get(p) ?? []), { tipo: pd.tipo, external_id: c.external_id, nome: c.nome, login_customer_id: c.login_customer_id, moeda: c.moeda, detalhe: c.detalhe }]);
      }
    }
    if (campos.length) return erro(req, 422, "CONTA_NAO_DISPONIVEL", "Conta fora da lista que esta conexão enxerga.", { campos });
    for (const [p, ativos] of porProvedor) await store!.ativosSalvar(a.clientId, p, ativos, a.ch.userId);
    await deps.store.cacheLimpar(`cli:${a.clientId}:`).catch(() => undefined);
    return json(req, 200, { ativos: [...porProvedor.values()].flat() });
  }

  // Desconectar: revoga no provedor (melhor esforço), apaga do Vault e marca `desconectado`.
  async function desconectar(req: Request, a: Acesso, p: Provedor): Promise<Response> {
    const t = await store!.tokenLer(a.clientId, p).catch(() => null);
    const noProvedor = t ? await revogarNoProvedor(p, t.token) : false;
    const havia = await store!.conexaoEncerrar(a.clientId, p, "desconectado", a.ch.userId, "AUDITOR");
    await deps.store.cacheLimpar(`cli:${a.clientId}:`).catch(() => undefined);
    deps.log("info", "marketing_cliente_desconectou", { provedor: p, no_provedor: noProvedor });
    return json(req, 200, { provedor: p, estado: "desconectado", havia_conexao: havia, revogado_no_provedor: noProvedor });
  }

  // ----------------------------------------------------------------- Leitura

  async function conexoes(a: Acesso) {
    const leitor = store!.leitor(a.jwt);
    const [lista, ativos] = await Promise.all([leitor.conexoesListar(a.clientId), leitor.ativosListar(a.clientId)]);
    const agora = deps.agora().toISOString();
    const porProvedor = Object.fromEntries(PROVEDORES.map((p) => {
      const c = lista.find((x) => x.provedor === p && x.estado !== "desconectado");
      if (!c) return [p, { estado: "desconectado", configurado: configurado(p) }];
      // Token longo da Meta não renova sozinho: passou de expira_em, pede reconexão.
      const estado = c.estado === "conectado" && c.expira_em && c.expira_em <= agora ? "expirado" : c.estado;
      return [p, { ...c, estado, configurado: configurado(p) }];
    }));
    return { conexoes: porProvedor, ativos };
  }

  async function overview(a: Acesso, p: Periodo, fresco: boolean) {
    const ativos = await store!.leitor(a.jwt).ativosListar(a.clientId);
    const ativo = (t: TipoAtivo) => ativos.find((x) => x.tipo === t) ?? null;
    const ttl = ttlSegundos(p, deps.agora());
    const k = (nome: string) => `cli:${a.clientId}:${nome}:${p.de}:${p.ate}`;
    const hoje = hojeSaoPaulo(deps.agora());
    const atrasado = p.ate >= hoje;
    const id = a.clientId;
    const [meta_ads, google_ads, ga4, search_console] = await Promise.all([
      f.bloco(k("meta_ads"), ttl, fresco, {
        atrasado,
        ler: async (reg) => {
          const conta = ativo("meta_ads");
          const t = conta ? await store!.tokenLer(id, "meta") : null;
          return t && conta ? await comMarca(id, "meta", () => metaResumo({ token: t.token, adAccountId: conta.external_id }, p, reg)) : null;
        },
        metricas: pagas,
      }),
      f.bloco(k("google_ads"), ttl, fresco, {
        atrasado,
        ler: async () => {
          const conta = ativo("google_ads");
          const g = conta ? await googleToken(id) : null;
          return g && conta
            ? await comMarca(id, "google", () => adsResumo({ token: g.token, developerToken: google.developerToken ?? "", customerId: conta.external_id, loginCustomerId: conta.login_customer_id }, p))
            : null;
        },
        metricas: pagas,
      }),
      f.bloco(k("ga4"), ttl, fresco, {
        atrasado,
        ler: async () => {
          const prop = ativo("ga4");
          const g = prop ? await googleToken(id) : null;
          return g && prop ? await comMarca(id, "google", () => ga4Resumo(g.token, prop.external_id, p)) : null;
        },
        metricas: (d) => ({ periodo: { sessoes: d.sessoes, eventos_chave: d.eventos_chave } }),
      }),
      f.bloco(k("gsc"), ttl, fresco, {
        atrasado: p.ate >= addDias(hoje, -3),
        ler: async () => {
          const site = ativo("gsc");
          const g = site ? await googleToken(id) : null;
          return g && site ? await comMarca(id, "google", () => gscResumo(g.token, site.external_id, p)) : null;
        },
        metricas: (d) => ({ periodo: { cliques: d.cliques, impressoes: d.impressoes, ctr: d.ctr } }),
      }),
    ]);
    return { periodo: p, gerado_em: deps.agora().toISOString(), blocos: { meta_ads, google_ads, ga4, search_console } };
  }

  // --------------------------------------------------------------- Roteamento

  return async function rotasCliente(req: Request, url: URL, partes: string[]): Promise<Response> {
    const m = req.method;
    const [, r1, r2, r3] = partes;
    const prov = (x: string | undefined) => (PROVEDORES.includes(x as Provedor) ? x as Provedor : null);
    try {
      if (!cfg || !store) return erro(req, 503, "NAO_CONFIGURADO", "Conexão de clientes ainda não configurada.");

      // Públicas, por provedor.
      const p1 = prov(r1);
      if (p1 && partes.length === 3) {
        if (m === "GET" && r2 === "ir") return await ir(url, p1);
        if (m === "GET" && r2 === "callback") return await callback(req, url, p1);
        if (m === "POST" && r2 === "desautorizar" && p1 === "meta") return await desautorizar(req);
        return erro(req, 404, "NOT_FOUND", "Rota não encontrada.");
      }

      // Do negócio: /cliente/:clientId/…
      if (!r1) return erro(req, 404, "NOT_FOUND", "Rota não encontrada.");
      const p2 = prov(r2);
      if (m === "GET" && r2 === "conexoes" && partes.length === 3) {
        const a = await autorizar(req, r1, false);
        await registrarSuporte(a, "conexoes");
        return json(req, 200, await conexoes(a));
      }
      if (m === "GET" && r2 === "overview" && partes.length === 3) {
        const a = await autorizar(req, r1, false);
        const p = f.periodo(url);
        await registrarSuporte(a, "overview");
        return json(req, 200, await overview(a, p, url.searchParams.get("fresco") === "1"));
      }
      // POST (não PUT): o CORS do hub é compartilhado com o admin e não muda.
      if (m === "POST" && r2 === "ativos" && partes.length === 3) return await salvarAtivos(req, await autorizar(req, r1, true));
      if (p2 && m === "POST" && r3 === "conectar" && partes.length === 4) return await conectar(req, await autorizar(req, r1, true), p2);
      if (p2 && m === "GET" && r3 === "contas" && partes.length === 4) {
        const a = await autorizar(req, r1, true);
        return json(req, 200, await listarContas(a.clientId, p2));
      }
      if (p2 && m === "DELETE" && partes.length === 3) return await desconectar(req, await autorizar(req, r1, true), p2);
      return erro(req, 404, "NOT_FOUND", "Rota não encontrada.");
    } catch (e) {
      if (e instanceof Negado) return erro(req, e.status, e.code, e.message);
      throw e; // o handler converte (HttpErro, falha de plataforma) sem vazar segredo
    }
  };
}
