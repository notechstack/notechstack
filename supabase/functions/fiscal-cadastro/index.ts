// Edge function pública (verify_jwt = false): consulta do CNPJ e criação da empresa. Lógica em core.ts.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { handle } from "./core.ts";
import { type ListaMunicipios, lerListaMunicipios } from "../_shared/fiscal/cnpj.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  { auth: { persistSession: false, autoRefreshToken: false } },
);

// Lista do lote P, servida como static_files (config.toml). Ausente ou ilegível → null (todos valem).
let lista: Promise<ListaMunicipios> | null = null;
function municipios(): Promise<ListaMunicipios> {
  lista ??= Deno.readTextFile(new URL("../_shared/fiscal/municipios-padrao-nacional.json", import.meta.url))
    .then(lerListaMunicipios)
    .catch(() => null);
  return lista;
}

Deno.serve((req: Request) =>
  handle(req, {
    env: (k) => Deno.env.get(k),
    sessao: async (r) => {
      const token = (r.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      if (!token) return null;
      const { data, error } = await admin.auth.getUser(token);
      return error || !data?.user?.id ? null : data.user.id;
    },
    municipios,
    criar: async (a) => {
      const { data, error } = await admin.rpc("fiscal_cadastro_criar", {
        p_user_id: a.user_id,
        p_cnpj: a.cnpj,
        p_razao_social: a.razao_social,
        p_codigo_municipio_ibge: a.codigo_municipio_ibge,
        p_cnae: a.cnae,
        p_telefone: a.telefone,
        p_plano: a.plano,
        p_responsavel: a.responsavel,
        p_api_key_hash: a.api_key_hash,
        p_ambiente: a.ambiente,
      });
      if (error || !data) throw new Error("fiscal_cadastro_criar_falhou");
      return data as { status: string; tenant_id?: string; etapa?: string };
    },
    log: (evento, detalhe) => console.log(JSON.stringify({ fn: "fiscal-cadastro", evento, ...(detalhe ?? {}) })),
  })
);
