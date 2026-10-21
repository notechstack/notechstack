// fiscal-acesso: código de 6 dígitos por e-mail para o cadastro e a conta do nó.fiscal (critérios 5, 7 e 9;
// Landing "fiscal-acesso: forma" e "fiscal-acesso {acao:'verificar'}", lote A). Molde: auditor-acesso
// (copiado). Público (verify_jwt = false). Núcleo testável: sem Deno e sem supabase-js.
// Enviar ({email} ou {acao:'enviar', email}):
//   - 202 igual exista ou não a conta (não revela quem é cliente).
//   - Contas do sistema (NO_ADMIN, MARKETING_AGENT): 202 sem envio.
//   - Usuário novo nasce com app_metadata.role = 'FISCAL_CLIENT'; conta existente não é alterada.
//   - Só o email_otp de generateLink vai no e-mail; o link mágico é descartado.
//   - Limite: 3 por e-mail, 20 por IP, 300 no total, por hora (public.fiscal_acesso_preparar; só hashes).
// Verificar ({acao:'verificar', email, codigo}):
//   - O código é conferido aqui (hash gravado no envio) antes do GoTrue: vencido, incorreto (5 tentativas)
//     e esgotado são decididos do lado servidor; na 5ª errada o código é descartado no GoTrue.
//   - Certo: a sessão vem do POST /auth/v1/verify {type:'email'} do GoTrue.

import { corsFiscal, json } from "../_shared/fiscal/cors.ts";
import { emailCodigo, type Email } from "../_shared/fiscal/email.ts";
import { chaveIp, ipDaBorda, sha256 } from "../_shared/fiscal/rede.ts";

export type Preparo = { permitido: boolean; user_id: string | null; papel: string | null };
export type Conferencia = { status: "correto" | "incorreto" | "esgotou" | "esgotado" | "vencido"; restantes?: number };
export type Sessao = { access_token: string; refresh_token: string; expires_at: number };
export type VerificacaoGoTrue = { ok: true; sessao: Sessao } | { ok: false };

export type AcessoDeps = {
  env: (k: string) => string | undefined;
  preparar: (email: string, chaveEmail: string, chaveIp: string) => Promise<Preparo>;
  criarUsuario: (email: string, appMetadata: Record<string, unknown>) => Promise<string>;
  /** properties.email_otp de auth.admin.generateLink({type:'magiclink'}). */
  gerarCodigo: (email: string) => Promise<string>;
  enviar: (para: string, email: Email) => Promise<string>;
  registrarCodigo: (chaveEmail: string, codigoHash: string) => Promise<void>;
  conferir: (chaveEmail: string, codigoHash: string, validadeS: number) => Promise<Conferencia>;
  consumir: (chaveEmail: string) => Promise<void>;
  /** Troca o código no GoTrue sem enviar e-mail (generateLink de novo, resultado jogado fora). */
  descartarCodigo: (email: string) => Promise<void>;
  /** POST /auth/v1/verify {type:'email', email, token}; 4xx → {ok:false}; rede ou 5xx → lança. */
  verificarNoGoTrue: (email: string, codigo: string) => Promise<VerificacaoGoTrue>;
  log?: (evento: string, detalhe?: Record<string, unknown>) => void;
};

const PAPEIS_DO_SISTEMA = new Set(["NO_ADMIN", "MARKETING_AGENT"]);
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const VALIDADE_PADRAO_S = 3600;
const TENTATIVAS = 5;

const MSG: Record<string, string> = {
  email_invalido: "Confira o e-mail digitado.",
  codigo_invalido: "O código tem 6 números.",
  limite: "Muitos pedidos de código. Espere um pouco e tente de novo.",
  indisponivel: "Não conseguimos concluir agora. Tente de novo em alguns minutos.",
  codigo_incorreto: "Código incorreto",
  codigo_vencido: "Peça um código novo",
  codigo_esgotado: "Peça um código novo",
};

type H = Record<string, string>;

function falha(status: number, motivo: string, h: H, extra: Record<string, unknown> = {}) {
  return json(status, { ok: false, motivo, error_code: motivo.toUpperCase(), mensagem: MSG[motivo] ?? MSG.indisponivel, ...extra }, h);
}

function validade(env: AcessoDeps["env"]): number {
  const n = Number(env("FISCAL_CODIGO_VALIDADE_S"));
  return Number.isInteger(n) && n > 0 ? n : VALIDADE_PADRAO_S;
}

export async function hashDoCodigo(sal: string, email: string, codigo: string): Promise<string> {
  return await sha256(`${sal}:codigo:${email}:${codigo}`);
}

export async function handle(req: Request, deps: AcessoDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  const h = corsFiscal(req.headers.get("origin"), deps.env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return falha(405, "metodo", h);

  const sal = deps.env("FISCAL_ACESSO_SALT");
  if (!sal) {
    log("fiscal_acesso_config_ausente");
    return falha(503, "config_ausente", h);
  }

  const bruto = await req.text();
  if (bruto.length > 4096) return falha(400, "json", h);
  let corpo: { email?: unknown; acao?: unknown; codigo?: unknown };
  try {
    corpo = JSON.parse(bruto);
    if (!corpo || typeof corpo !== "object") throw new Error();
  } catch {
    return falha(400, "json", h);
  }
  const email = typeof corpo.email === "string" ? corpo.email.trim().toLowerCase() : "";
  if (!RE_EMAIL.test(email)) return falha(400, "email_invalido", h);
  const chaveEmail = await sha256(`${sal}:email:${email}`);

  if (corpo.acao === "verificar") return await verificar(email, chaveEmail, corpo.codigo, sal, h, deps, log);
  if (corpo.acao !== undefined && corpo.acao !== "enviar") return falha(400, "acao_invalida", h);

  const chaveIpHash = await sha256(`${sal}:ip:${chaveIp(ipDaBorda(req.headers))}`);
  let prep: Preparo;
  try {
    prep = await deps.preparar(email, chaveEmail, chaveIpHash);
  } catch {
    log("fiscal_acesso_banco_indisponivel");
    return falha(503, "indisponivel", h);
  }
  if (!prep.permitido) {
    log("fiscal_acesso_limite");
    return falha(429, "limite", h);
  }

  try {
    if (prep.papel && PAPEIS_DO_SISTEMA.has(prep.papel)) {
      log("fiscal_acesso_conta_sistema");
      return json(202, { ok: true }, h);
    }
    if (!prep.user_id) await deps.criarUsuario(email, { role: "FISCAL_CLIENT" });
    const codigo = await deps.gerarCodigo(email);
    await deps.registrarCodigo(chaveEmail, await hashDoCodigo(sal, email, codigo));
    await deps.enviar(email, emailCodigo(codigo));
  } catch (e) {
    log("fiscal_acesso_falhou", { codigo: e instanceof Error && /^[a-z_]{1,40}$/.test(e.message) ? e.message : "erro" });
    return falha(503, "indisponivel", h);
  }
  return json(202, { ok: true }, h);
}

async function verificar(
  email: string,
  chaveEmail: string,
  bruto: unknown,
  sal: string,
  h: H,
  deps: AcessoDeps,
  log: NonNullable<AcessoDeps["log"]>,
): Promise<Response> {
  const codigo = typeof bruto === "string" ? bruto.trim() : "";
  if (!/^\d{6}$/.test(codigo)) return falha(400, "codigo_invalido", h);

  let c: Conferencia;
  try {
    c = await deps.conferir(chaveEmail, await hashDoCodigo(sal, email, codigo), validade(deps.env));
  } catch {
    log("fiscal_acesso_banco_indisponivel");
    return falha(503, "indisponivel", h);
  }

  switch (c.status) {
    case "vencido":
      return falha(422, "codigo_vencido", h);
    case "esgotado":
      return falha(422, "codigo_esgotado", h);
    case "incorreto":
      return falha(422, "codigo_incorreto", h, { tentativas_restantes: c.restantes ?? 0 });
    case "esgotou":
      // 5ª errada: o código também deixa de valer no GoTrue (sem e-mail novo).
      try {
        await deps.descartarCodigo(email);
      } catch {
        log("fiscal_acesso_descarte_falhou");
      }
      log("fiscal_acesso_codigo_esgotado");
      return falha(422, "codigo_esgotado", h);
  }

  let v: VerificacaoGoTrue;
  try {
    v = await deps.verificarNoGoTrue(email, codigo);
  } catch {
    log("fiscal_acesso_gotrue_indisponivel");
    return falha(503, "indisponivel", h);
  }
  try {
    await deps.consumir(chaveEmail);
  } catch {
    log("fiscal_acesso_consumo_falhou");
  }
  if (!v.ok) return falha(422, "codigo_vencido", h);
  const { access_token, refresh_token, expires_at } = v.sessao;
  return json(200, { ok: true, access_token, refresh_token, expires_at }, h);
}

/** Cliente REST do POST /auth/v1/verify (pesquisa P4d), com fetch injetável. */
export async function verificarGoTrue(
  o: { authUrl: string; apikey?: string; email: string; codigo: string; fetch?: typeof fetch },
): Promise<VerificacaoGoTrue> {
  const f = o.fetch ?? fetch;
  const r = await f(`${o.authUrl.replace(/\/+$/, "")}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(o.apikey ? { apikey: o.apikey } : {}) },
    body: JSON.stringify({ type: "email", email: o.email, token: o.codigo }),
  });
  // Limite do GoTrue ou falha dele: transitório, o código não é consumido.
  if (r.status >= 500 || r.status === 429) throw new Error("gotrue_transitorio");
  if (!r.ok) return { ok: false };
  const b = await r.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b.access_token !== "string" || typeof b.refresh_token !== "string") throw new Error("gotrue_resposta");
  return {
    ok: true,
    sessao: { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Number(b.expires_at) },
  };
}
