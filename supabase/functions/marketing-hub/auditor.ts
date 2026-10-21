// Rotas do auditor (Frente 3) na marketing-hub, despachadas antes de `autorizar()` e de `/cliente/*`:
//   POST /internal/auditor/processar   x-cron-secret   → até 3 relatórios + avisos (pg_cron a cada 10 min)
//   POST /cliente/excluir-conta        JWT do dono     → revoga no provedor, cancela no Pagar.me, apaga tudo
//   GET  /auditor/operacao             NO_ADMIN aal2   → metadados operacionais (sem métricas, achados ou texto)
// Spec 2026-10-21, seções 2, 4 e 5. Nada aqui lê o token ou as contas da Nó.

import { MetaApiError } from "../_shared/meta.ts";
import { codigoGraph } from "../_shared/marketing/estados.ts";
import { ga4Resumo } from "../_shared/marketing/ga4.ts";
import { adsCampanhas, adsResumo } from "../_shared/marketing/google-ads.ts";
import { GoogleApiError, googleAccessToken } from "../_shared/marketing/google-auth.ts";
import { gscResumo } from "../_shared/marketing/gsc.ts";
import { metaCampanhas, metaResumo } from "../_shared/marketing/meta.ts";
import type { Periodo } from "../_shared/marketing/normalize.ts";
import { revogarNoProvedor, type Provedor } from "../_shared/marketing/oauth-cliente.ts";
import { ErroFonte, processarFila, type Coletores, type PeriodoColeta, type ProcessarStore } from "../_shared/auditor/processar.ts";
import type { GeradorIa } from "../_shared/auditor/redacao.ts";
import type { Email } from "../_shared/auditor/email.ts";
import type { Site } from "../_shared/auditor/regras.ts";
import type { ClienteStore } from "./clientes.ts";
import type { Chamador } from "./handler.ts";

export type ContaDoDono = {
  conta_id: string;
  negocios: string[];
  assinatura: { subscription_id: string; status: string } | null;
};

export interface AuditorStore extends ProcessarStore {
  cronSecretOk(segredo: string): Promise<boolean>;
  contaDoDono(userId: string): Promise<ContaDoDono | null>;
  apagarConta(contaId: string): Promise<{ codigo: string; usuario_apagado: boolean }>;
  operacao(): Promise<unknown[]>;
  suporteVigente(userId: string, clientId: string): Promise<boolean>;
}

export type AuditorDeps = {
  store: AuditorStore;
  clienteStore: ClienteStore;
  autenticar: (jwt: string) => Promise<Chamador | null>;
  google: { clientId: string | null; clientSecret: string | null; developerToken: string | null };
  site: (url: string) => Promise<Site | null>;
  gerar: GeradorIa | null;
  enviar: (para: string, email: Email) => Promise<string>;
  // Cancela a assinatura no Pagar.me; false = não conseguiu (a exclusão para, para não seguir cobrando).
  cancelarAssinatura: (subscriptionId: string) => Promise<boolean>;
  appUrl: string;
  agora: () => Date;
  log: (nivel: "info" | "warn" | "error", evento: string, dados?: Record<string, unknown>) => void;
};

type Resp = (req: Request, status: number, corpo: unknown) => Response;
type Erro = (req: Request, status: number, code: string, mensagem: string, extra?: Record<string, unknown>) => Response;

function periodo(p: PeriodoColeta): Periodo {
  return { id: `${p.de}_${p.ate}`, de: p.de, ate: p.ate, dias: p.dias, rotulo: `${p.de} a ${p.ate}` };
}

// Coletores com o token do próprio negócio (Vault). Token recusado vira `expirado` na conexão e no relatório.
export function criarColetores(d: Pick<AuditorDeps, "clienteStore" | "google" | "agora">): Coletores {
  const cs = d.clienteStore;
  async function expirou(clientId: string, p: Provedor, e: unknown): Promise<never> {
    const codigo = p === "meta"
      ? (e instanceof MetaApiError && codigoGraph(e) === 190 ? "meta_190" : null)
      : (e instanceof GoogleApiError && (e.body as { error?: string } | null)?.error === "invalid_grant" ? "google_invalid_grant" : null);
    if (codigo) {
      await cs.conexaoMarcar(clientId, p, "expirado", codigo).catch(() => undefined);
      throw new ErroFonte("expirado");
    }
    throw new ErroFonte("erro");
  }
  async function metaToken(clientId: string): Promise<string> {
    const t = await cs.tokenLer(clientId, "meta");
    if (!t) throw new ErroFonte("expirado");
    return t.token;
  }
  async function googleToken(clientId: string): Promise<string> {
    const t = await cs.tokenLer(clientId, "google");
    if (!t || !d.google.clientId || !d.google.clientSecret) throw new ErroFonte("expirado");
    try {
      return await googleAccessToken({ clientId: d.google.clientId, clientSecret: d.google.clientSecret, refreshToken: t.token }, d.agora().getTime());
    } catch (e) {
      return await expirou(clientId, "google", e);
    }
  }
  return {
    async meta_ads(clientId, a, p, comCampanhas) {
      const token = await metaToken(clientId);
      try {
        const ctx = { token, adAccountId: a.external_id };
        const [r, campanhas] = await Promise.all([metaResumo(ctx, periodo(p)), comCampanhas ? metaCampanhas(ctx, periodo(p)) : Promise.resolve([])]);
        return { total: r.total, campanhas };
      } catch (e) {
        return await expirou(clientId, "meta", e);
      }
    },
    async google_ads(clientId, a, p, comCampanhas) {
      const token = await googleToken(clientId);
      try {
        const ctx = { token, developerToken: d.google.developerToken ?? "", customerId: a.external_id, loginCustomerId: a.login_customer_id };
        const [r, campanhas] = await Promise.all([adsResumo(ctx, periodo(p)), comCampanhas ? adsCampanhas(ctx, periodo(p)) : Promise.resolve([])]);
        return { total: r.total, campanhas };
      } catch (e) {
        return await expirou(clientId, "google", e);
      }
    },
    async ga4(clientId, a, p) {
      const token = await googleToken(clientId);
      try {
        const r = await ga4Resumo(token, a.external_id, periodo(p));
        return { sessoes: r.sessoes, eventos_chave: r.eventos_chave, google_ads_segundo_ga4: r.google_ads_segundo_ga4, por_canal: r.por_canal };
      } catch (e) {
        return await expirou(clientId, "google", e);
      }
    },
    async gsc(clientId, a, p) {
      const token = await googleToken(clientId);
      try {
        const r = await gscResumo(token, a.external_id, periodo(p));
        return { cliques: r.cliques, impressoes: r.impressoes, paginas_que_cresceram: r.paginas_que_cresceram };
      } catch (e) {
        return await expirou(clientId, "google", e);
      }
    },
  };
}

export function criarRotasAuditor(d: AuditorDeps) {
  const coletar = criarColetores(d);

  async function sessao(req: Request): Promise<Chamador | null> {
    const v = req.headers.get("authorization") ?? "";
    const jwt = v.startsWith("Bearer ") ? v.slice(7) : "";
    const ch = jwt ? await d.autenticar(jwt) : null;
    return ch && !ch.banido ? ch : null;
  }

  async function processar(req: Request, json: Resp, erro: Erro): Promise<Response> {
    const segredo = req.headers.get("x-cron-secret") ?? "";
    if (!segredo || !(await d.store.cronSecretOk(segredo))) return erro(req, 401, "UNAUTHENTICATED", "Chamada interna sem segredo válido.");
    const r = await processarFila({ store: d.store, coletar, site: d.site, gerar: d.gerar, enviar: d.enviar, appUrl: d.appUrl, log: d.log });
    d.log("info", "auditor_processar", { ...r.relatorios, avisos: r.avisos });
    return json(req, 200, r);
  }

  // LGPD (spec, seção 5, caminho 2): cancela a cobrança, revoga nas plataformas e apaga tudo do dono.
  async function excluirConta(req: Request, json: Resp, erro: Erro): Promise<Response> {
    const ch = await sessao(req);
    if (!ch) return erro(req, 401, "UNAUTHENTICATED", "Sessão inválida.");
    const corpo = await req.json().catch(() => ({})) as { confirmar?: unknown };
    if (corpo.confirmar !== true) return erro(req, 422, "INVALID_REQUEST", "Confirme a exclusão.", { campos: ["confirmar"] });
    const conta = await d.store.contaDoDono(ch.userId);
    if (!conta) return erro(req, 404, "NOT_FOUND", "Não há conta do auditor neste login.");
    if (conta.assinatura && conta.assinatura.status !== "cancelada") {
      if (!(await d.cancelarAssinatura(conta.assinatura.subscription_id))) {
        d.log("error", "auditor_exclusao_pagarme_falhou", {});
        return erro(req, 502, "PAGARME_FALHOU", "Não conseguimos cancelar a assinatura agora. Nada foi apagado; tente de novo em alguns minutos.");
      }
    }
    let revogadas = 0;
    for (const clientId of conta.negocios) {
      for (const p of ["meta", "google"] as Provedor[]) {
        const t = await d.clienteStore.tokenLer(clientId, p).catch(() => null);
        if (t && (await revogarNoProvedor(p, t.token))) revogadas++;
      }
    }
    const r = await d.store.apagarConta(conta.conta_id);
    d.log("info", "auditor_conta_excluida", { negocios: conta.negocios.length, revogadas_no_provedor: revogadas });
    return json(req, 200, { ok: true, codigo: r.codigo });
  }

  async function operacao(req: Request, json: Resp, erro: Erro): Promise<Response> {
    const ch = await sessao(req);
    if (!ch) return erro(req, 401, "UNAUTHENTICATED", "Sessão inválida.");
    if (ch.role !== "NO_ADMIN") return erro(req, 403, "FORBIDDEN", "Sem acesso.");
    if (ch.aal !== "aal2") return erro(req, 403, "MFA_REQUIRED", "Conclua o segundo fator.");
    return json(req, 200, { negocios: await d.store.operacao() });
  }

  // null = não é rota do auditor (o handler segue o roteamento de sempre).
  return async function rotasAuditor(req: Request, partes: string[], json: Resp, erro: Erro): Promise<Response | null> {
    const m = req.method;
    const [r0, r1, r2] = partes;
    if (r0 === "internal" && r1 === "auditor" && r2 === "processar" && partes.length === 3) {
      return m === "POST" ? await processar(req, json, erro) : erro(req, 405, "METHOD_NOT_ALLOWED", "Use POST.");
    }
    if (r0 === "cliente" && r1 === "excluir-conta" && partes.length === 2) {
      return m === "POST" ? await excluirConta(req, json, erro) : erro(req, 405, "METHOD_NOT_ALLOWED", "Use POST.");
    }
    if (r0 === "auditor" && r1 === "operacao" && partes.length === 2) {
      return m === "GET" ? await operacao(req, json, erro) : erro(req, 405, "METHOD_NOT_ALLOWED", "Use GET.");
    }
    return null;
  };
}
