// Edge function pública (verify_jwt = false): código de acesso do nó.fiscal por e-mail e conferência
// do código. Lógica em core.ts.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handle, verificarGoTrue } from "./core.ts";
import { enviarResend, REMETENTE_PADRAO, urlResend } from "../_shared/fiscal/email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});

const env = (k: string) => Deno.env.get(k);

function falha(codigo: string): never {
  throw new Error(codigo);
}

async function rpc(nome: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await admin.rpc(nome, args);
  if (error) falha("banco");
  return data;
}

async function gerarCodigo(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const otp = data?.properties?.email_otp;
  if (error || typeof otp !== "string") falha("auth_codigo");
  return otp;
}

Deno.serve((req: Request) =>
  handle(req, {
    env,
    preparar: async (email, chaveEmail, chaveIp) => {
      const data = await rpc("fiscal_acesso_preparar", { p_email: email, p_chave_email: chaveEmail, p_chave_ip: chaveIp });
      const linha = (data as { permitido: boolean; user_id: string | null; papel: string | null }[])[0];
      return linha ?? { permitido: false, user_id: null, papel: null };
    },
    criarUsuario: async (email, appMetadata) => {
      const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, app_metadata: appMetadata });
      if (error || !data.user) falha("auth_criar");
      return data.user.id;
    },
    gerarCodigo,
    enviar: async (para, email) => {
      const apiKey = env("RESEND_API_KEY");
      if (!apiKey) falha("resend_ausente");
      return await enviarResend({ apiUrl: urlResend(env), apiKey, remetente: env("FISCAL_EMAIL_FROM") || REMETENTE_PADRAO, para, email });
    },
    registrarCodigo: async (chaveEmail, codigoHash) => {
      await rpc("fiscal_acesso_registrar_codigo", { p_chave_email: chaveEmail, p_codigo_hash: codigoHash });
    },
    conferir: async (chaveEmail, codigoHash, validadeS) =>
      (await rpc("fiscal_acesso_conferir", { p_chave_email: chaveEmail, p_codigo_hash: codigoHash, p_validade_s: validadeS })) as {
        status: "correto" | "incorreto" | "esgotou" | "esgotado" | "vencido";
        restantes?: number;
      },
    consumir: async (chaveEmail) => {
      await rpc("fiscal_acesso_consumir", { p_chave_email: chaveEmail });
    },
    // Um generateLink novo troca o token guardado pelo GoTrue; o código novo não sai daqui.
    descartarCodigo: async (email) => {
      await gerarCodigo(email);
    },
    verificarNoGoTrue: (email, codigo) =>
      verificarGoTrue({ authUrl: `${SUPABASE_URL}/auth/v1`, apikey: env("SUPABASE_ANON_KEY"), email, codigo }),
    log: (evento, detalhe) => console.log(JSON.stringify({ fn: "fiscal-acesso", evento, ...(detalhe ?? {}) })),
  })
);
