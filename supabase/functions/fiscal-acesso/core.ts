// fiscal-acesso: código de 6 dígitos por e-mail para o cadastro e a conta do nó.fiscal (critérios 5 e 9;
// Landing "fiscal-acesso: forma", lote A). Molde: auditor-acesso (copiado). Público (verify_jwt = false).
// Núcleo testável: sem Deno e sem supabase-js; index.ts liga as dependências.
//   - 202 igual exista ou não a conta (não revela quem é cliente).
//   - Contas do sistema (NO_ADMIN, MARKETING_AGENT): 202 sem envio.
//   - Usuário novo nasce com app_metadata.role = 'FISCAL_CLIENT'; conta existente não é alterada.
//   - Só o email_otp de generateLink vai no e-mail; o link mágico é descartado.
//   - Limite: 3 por e-mail, 20 por IP, 300 no total, por hora (public.fiscal_acesso_preparar; só hashes).

import { corsFiscal, json } from "../_shared/fiscal/cors.ts";
import { emailCodigo, type Email } from "../_shared/fiscal/email.ts";
import { chaveIp, ipDaBorda, sha256 } from "../_shared/fiscal/rede.ts";

export type Preparo = { permitido: boolean; user_id: string | null; papel: string | null };

export type AcessoDeps = {
  env: (k: string) => string | undefined;
  preparar: (email: string, chaveEmail: string, chaveIp: string) => Promise<Preparo>;
  criarUsuario: (email: string, appMetadata: Record<string, unknown>) => Promise<string>;
  /** properties.email_otp de auth.admin.generateLink({type:'magiclink'}). */
  gerarCodigo: (email: string) => Promise<string>;
  enviar: (para: string, email: Email) => Promise<string>;
  log?: (evento: string, detalhe?: Record<string, unknown>) => void;
};

const PAPEIS_DO_SISTEMA = new Set(["NO_ADMIN", "MARKETING_AGENT"]);
const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

const MSG = {
  email_invalido: "Confira o e-mail digitado.",
  limite: "Muitos pedidos de código. Espere um pouco e tente de novo.",
  indisponivel: "Não conseguimos enviar o código agora. Tente de novo em alguns minutos.",
};

function falha(status: number, motivo: keyof typeof MSG | "config_ausente" | "json" | "metodo", h: Record<string, string>) {
  const mensagem = motivo in MSG ? MSG[motivo as keyof typeof MSG] : MSG.indisponivel;
  return json(status, { ok: false, motivo, error_code: motivo.toUpperCase(), mensagem }, h);
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
  let corpo: { email?: unknown };
  try { corpo = JSON.parse(bruto); } catch { return falha(400, "json", h); }
  const email = corpo && typeof corpo.email === "string" ? corpo.email.trim().toLowerCase() : "";
  if (!RE_EMAIL.test(email)) return falha(400, "email_invalido", h);

  const chaveEmail = await sha256(`${sal}:email:${email}`);
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
    await deps.enviar(email, emailCodigo(codigo));
  } catch (e) {
    log("fiscal_acesso_falhou", { codigo: e instanceof Error && /^[a-z_]{1,40}$/.test(e.message) ? e.message : "erro" });
    return falha(503, "indisponivel", h);
  }
  return json(202, { ok: true }, h);
}
