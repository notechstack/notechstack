// Edge function pública (verify_jwt = false): link mágico de entrada no auditor. Lógica em core.ts.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handle } from "./core.ts";
import { enviarResend } from "../_shared/auditor/email.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

function falha(codigo: string): never {
  throw new Error(codigo);
}

Deno.serve((req: Request) =>
  handle(req, {
    env: (k) => Deno.env.get(k),
    preparar: async (email, chaveEmail, chaveIp) => {
      const { data, error } = await admin.rpc("auditor_acesso_preparar", { p_email: email, p_chave_email: chaveEmail, p_chave_ip: chaveIp });
      if (error) falha("banco");
      const linha = (data as { permitido: boolean; user_id: string | null; papel: string | null }[])[0];
      return linha ?? { permitido: false, user_id: null, papel: null };
    },
    criarUsuario: async (email, appMetadata, userMetadata) => {
      const { data, error } = await admin.auth.admin.createUser({
        email, email_confirm: true, app_metadata: appMetadata, user_metadata: userMetadata,
      });
      if (error || !data.user) falha("auth_criar");
      return data.user.id;
    },
    gerarLink: async (email, redirectTo) => {
      const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
      if (error || !data.properties?.action_link) falha("auth_link");
      return data.properties.action_link;
    },
    enviar: async (para, email) => {
      const apiKey = Deno.env.get("RESEND_API_KEY");
      if (!apiKey) falha("resend_ausente");
      return await enviarResend({ apiKey, para, email });
    },
    log: (evento, detalhe) => console.log(JSON.stringify({ fn: "auditor-acesso", evento, ...(detalhe ?? {}) })),
  })
);
