// Edge function pública (verify_jwt = false): código de acesso do nó.fiscal por e-mail. Lógica em core.ts.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handle } from "./core.ts";
import { enviarResend, REMETENTE_PADRAO, urlResend } from "../_shared/fiscal/email.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const env = (k: string) => Deno.env.get(k);

function falha(codigo: string): never {
  throw new Error(codigo);
}

Deno.serve((req: Request) =>
  handle(req, {
    env,
    preparar: async (email, chaveEmail, chaveIp) => {
      const { data, error } = await admin.rpc("fiscal_acesso_preparar", { p_email: email, p_chave_email: chaveEmail, p_chave_ip: chaveIp });
      if (error) falha("banco");
      const linha = (data as { permitido: boolean; user_id: string | null; papel: string | null }[])[0];
      return linha ?? { permitido: false, user_id: null, papel: null };
    },
    criarUsuario: async (email, appMetadata) => {
      const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, app_metadata: appMetadata });
      if (error || !data.user) falha("auth_criar");
      return data.user.id;
    },
    gerarCodigo: async (email) => {
      const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      const otp = data?.properties?.email_otp;
      if (error || typeof otp !== "string") falha("auth_codigo");
      return otp;
    },
    enviar: async (para, email) => {
      const apiKey = env("RESEND_API_KEY");
      if (!apiKey) falha("resend_ausente");
      return await enviarResend({ apiUrl: urlResend(env), apiKey, remetente: env("FISCAL_EMAIL_FROM") || REMETENTE_PADRAO, para, email });
    },
    log: (evento, detalhe) => console.log(JSON.stringify({ fn: "fiscal-acesso", evento, ...(detalhe ?? {}) })),
  })
);
