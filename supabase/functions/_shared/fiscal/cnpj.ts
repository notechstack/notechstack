// CNPJ do cadastro (critérios 2 e 3): dígitos verificadores, consulta na BrasilAPI
// (`GET <CNPJ_API_URL>/api/cnpj/v1/<cnpj>`, padrão oficial https://brasilapi.com.br, que espelha os
// dados abertos da Receita Federal), situação cadastral ativa e o município no padrão nacional.
// Sem Deno.*: roda também no node --test.

export const CNPJ_API_PADRAO = "https://brasilapi.com.br";
// A BrasilAPI responde 403 ao user-agent "node" e 429 sem user-agent (22/10/2026): o nosso vai sempre explícito.
export const USER_AGENT = "no-fiscal/1.0 (+https://www.notechstack.com.br)";
const TEMPO_MS = 8000;

export function soDigitos(v: unknown): string {
  return typeof v === "string" ? v.replace(/\D/g, "") : "";
}

function dv(base: string, pesos: number[]): number {
  const soma = pesos.reduce((s, p, i) => s + Number(base[i]) * p, 0);
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

export function cnpjValido(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const d1 = dv(cnpj, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(cnpj, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(cnpj[12]) && d2 === Number(cnpj[13]);
}

export type DadosCnpj = {
  cnpj: string;
  razao_social: string;
  municipio: string;
  uf: string;
  codigo_municipio_ibge: string;
  cnae: string | null;
};

export type Consulta =
  | { ok: true; dados: DadosCnpj }
  | { ok: false; motivo: "nao_encontrado" | "indisponivel" }
  | { ok: false; motivo: "inativo"; situacao: string };

function texto(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

function codigo(v: unknown, tamanho: number): string | null {
  const s = typeof v === "number" ? String(Math.trunc(v)) : typeof v === "string" ? v.replace(/\D/g, "") : "";
  if (!s) return null;
  const p = s.padStart(tamanho, "0");
  return p.length === tamanho ? p : null;
}

export async function consultarCnpj(
  cnpj: string,
  o: { apiUrl?: string; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = {},
): Promise<Consulta> {
  const f = o.fetch ?? fetch;
  const base = (o.apiUrl || CNPJ_API_PADRAO).replace(/\/+$/, "");
  let resp: Response;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TEMPO_MS);
  try {
    resp = await f(`${base}/api/cnpj/v1/${cnpj}`, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controle.signal,
    });
  } catch {
    return { ok: false, motivo: "indisponivel" };
  } finally {
    clearTimeout(relogio);
  }
  if (resp.status === 404) return { ok: false, motivo: "nao_encontrado" };
  if (!resp.ok) return { ok: false, motivo: "indisponivel" };
  const b = await resp.json().catch(() => null) as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { ok: false, motivo: "indisponivel" };
  const ibge = codigo(b.codigo_municipio_ibge, 7);
  const razao = texto(b.razao_social);
  if (!ibge || !razao) return { ok: false, motivo: "indisponivel" };
  // Só empresa ATIVA na Receita emite (pedido de Lucca, 22/10/2026). Sem o campo, a consulta não confirma nada.
  const situacao = texto(b.descricao_situacao_cadastral).toUpperCase();
  if (!situacao) return { ok: false, motivo: "indisponivel" };
  if (situacao !== "ATIVA") return { ok: false, motivo: "inativo", situacao };
  return {
    ok: true,
    dados: {
      cnpj,
      razao_social: razao.slice(0, 150),
      municipio: texto(b.municipio),
      uf: texto(b.uf).toUpperCase(),
      codigo_municipio_ibge: ibge,
      cnae: codigo(b.cnae_fiscal, 7),
    },
  };
}

/** Conteúdo de municipios-padrao-nacional.json (lote P). */
export type ListaMunicipios = { fonte: string | null; consultado_em?: string; codigos_ibge: string[] } | null;

// Sem lista, ou com fonte nula, todo município vale (Unresolved 1 da tarefa).
export function padraoNacional(ibge: string, lista: ListaMunicipios): boolean {
  if (!lista || !lista.fonte || !Array.isArray(lista.codigos_ibge)) return true;
  return lista.codigos_ibge.map(String).includes(ibge);
}

export function lerListaMunicipios(conteudo: string | null): ListaMunicipios {
  if (!conteudo) return null;
  try {
    const j = JSON.parse(conteudo) as Record<string, unknown>;
    if (!j || typeof j !== "object" || !Array.isArray(j.codigos_ibge)) return null;
    return { fonte: typeof j.fonte === "string" && j.fonte ? j.fonte : null, codigos_ibge: j.codigos_ibge.map(String) };
  } catch {
    return null;
  }
}
