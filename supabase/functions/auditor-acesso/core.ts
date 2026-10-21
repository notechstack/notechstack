// auditor-acesso: pede o link mágico de entrada no auditor (spec 2026-10-21, seção 1; plan C6).
// Público (verify_jwt = false). Núcleo testável: sem Deno e sem supabase-js; index.ts liga as dependências.
// Regras:
//   - Resposta 202 igual exista ou não a conta (não revela quem é cliente).
//   - E-mail de NO_ADMIN ou MARKETING_AGENT: 202, nada é enviado nem alterado (contas do sistema não viram cliente).
//   - Usuário novo nasce com app_metadata.role = 'AUDITOR_CLIENT'. Conta que já existe NÃO é alterada (papel e
//     metadados ficam como estão; revisão I1): só quem tem o e-mail consegue usar o link.
//   - O aceite dos Termos é registrado depois do login, pelo próprio usuário (auditor_eu_iniciar; revisão B3).
//   - Limite: 3 links por e-mail, 20 por IP e 300 no total, por hora (RPC auditor_acesso_preparar; só hashes).
//     O IP é o da borda (cf-connecting-ip / x-real-ip / último salto do x-forwarded-for), não o primeiro
//     x-forwarded-for, que o cliente forja (revisão B4).

import { chaveIp, normalizarUrl, sha256 } from "../diagnostico-auditor/core.ts";
import { emailLinkAcesso, type Email } from "../_shared/auditor/email.ts";

export type Preparo = { permitido: boolean; user_id: string | null; papel: string | null };

export type AcessoDeps = {
  env: (k: string) => string | undefined;
  preparar: (email: string, chaveEmail: string, chaveIp: string) => Promise<Preparo>;
  criarUsuario: (email: string, appMetadata: Record<string, unknown>, userMetadata: Record<string, unknown>) => Promise<string>;
  gerarLink: (email: string, redirectTo: string) => Promise<string>;
  enviar: (para: string, email: Email) => Promise<string>;
  now?: () => Date;
  log?: (evento: string, detalhe?: Record<string, unknown>) => void;
};

const PAPEIS_DO_SISTEMA = new Set(["NO_ADMIN", "MARKETING_AGENT"]);
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
// Destino depois do login: só caminhos do auditor no próprio app (nada de URL externa).
const RE_VOLTA = /^\/auditor(\/[A-Za-z0-9._~%/-]*)?(\?[A-Za-z0-9._~%&=+-]*)?$/;

// IP visto pela borda. Ordem: cf-connecting-ip → x-real-ip → último salto do x-forwarded-for.
export function ipDaBorda(h: Headers): string {
  const direto = h.get("cf-connecting-ip") ?? h.get("x-real-ip");
  if (direto && direto.trim()) return direto.trim();
  const saltos = (h.get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return saltos.at(-1) ?? "";
}

function localhostLiberado(env: AcessoDeps["env"]): boolean {
  // M8: localhost no CORS só quando o próprio app roda em localhost (desenvolvimento).
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/|$)/.test(env("APP_URL") ?? "");
}

function origensPermitidas(env: AcessoDeps["env"]): Set<string> {
  // Mesmas origens do app que o _shared/cors.ts aceita (domínio próprio e o alias de produção na Vercel).
  const s = new Set(["https://app.notechstack.com.br", "https://notechstack-app.vercel.app"]);
  const app = env("APP_URL");
  if (app) {
    try { s.add(new URL(app).origin); } catch { /* APP_URL inválida: fica só o domínio fixo */ }
  }
  return s;
}

function cors(origem: string | null, permitidas: Set<string>, local: boolean): Record<string, string> {
  const ok = origem && (permitidas.has(origem) || (local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origem)));
  return ok
    ? { "Access-Control-Allow-Origin": origem!, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, apikey, authorization", Vary: "Origin" }
    : { Vary: "Origin" };
}

function resposta(status: number, corpo: Record<string, unknown>, h: Record<string, string>): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { ...h, "Content-Type": "application/json" } });
}

export async function handle(req: Request, deps: AcessoDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  const h = cors(req.headers.get("origin"), origensPermitidas(deps.env), localhostLiberado(deps.env));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return resposta(405, { ok: false, motivo: "metodo" }, h);

  const appUrl = (deps.env("APP_URL") ?? "https://app.notechstack.com.br").replace(/\/+$/, "");
  const salt = deps.env("DIAG_IP_SALT");
  if (!salt) {
    log("auditor_acesso_config_ausente");
    return resposta(503, { ok: false, motivo: "config_ausente" }, h);
  }

  const bruto = await req.text();
  if (bruto.length > 4096) return resposta(413, { ok: false, motivo: "grande_demais" }, h);
  let corpo: { email?: unknown; site?: unknown; volta?: unknown };
  try { corpo = JSON.parse(bruto); } catch { return resposta(400, { ok: false, motivo: "json" }, h); }

  const email = typeof corpo.email === "string" ? corpo.email.trim().toLowerCase() : "";
  if (!RE_EMAIL.test(email)) return resposta(400, { ok: false, motivo: "email_invalido" }, h);
  const site = corpo.site === undefined || corpo.site === null || corpo.site === "" ? null : normalizarUrl(corpo.site);
  if (corpo.site && !site) return resposta(400, { ok: false, motivo: "site_invalido" }, h);
  const volta = typeof corpo.volta === "string" && corpo.volta.length <= 300 && RE_VOLTA.test(corpo.volta) && !corpo.volta.includes("//")
    ? corpo.volta : null;

  const chaveEmail = await sha256(`${salt}:email:${email}`);
  const chaveIpHash = await sha256(`${salt}:ip:${chaveIp(ipDaBorda(req.headers))}`);

  let prep: Preparo;
  try {
    prep = await deps.preparar(email, chaveEmail, chaveIpHash);
  } catch {
    log("auditor_acesso_banco_indisponivel");
    return resposta(503, { ok: false, motivo: "indisponivel" }, h);
  }
  if (!prep.permitido) return resposta(429, { ok: false, motivo: "muitos_pedidos" }, h);

  try {
    if (prep.papel && PAPEIS_DO_SISTEMA.has(prep.papel)) {
      log("auditor_acesso_conta_sistema");
      return resposta(202, { ok: true }, h);
    }
    if (!prep.user_id) await deps.criarUsuario(email, { role: "AUDITOR_CLIENT" }, {});
    const destino = new URL(`${appUrl}/auditor/entrar`);
    if (site) destino.searchParams.set("site", site);
    if (volta) destino.searchParams.set("volta", volta);
    const link = await deps.gerarLink(email, destino.toString());
    await deps.enviar(email, emailLinkAcesso(link));
  } catch (e) {
    log("auditor_acesso_falhou", { codigo: e instanceof Error && /^[a-z_]{1,40}$/.test(e.message) ? e.message : "erro" });
    return resposta(502, { ok: false, motivo: "indisponivel" }, h);
  }
  return resposta(202, { ok: true }, h);
}
