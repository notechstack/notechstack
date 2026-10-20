// Hash do teste grátis em Deno (Landing, "Hash do teste grátis", lote A): sha256(FISCAL_TRIAL_SALT +
// valor normalizado), em hex, sem separador. Reproduz app/api/_lib/agente/teste-gratis.ts e
// normalizacao.ts com Web Crypto; os vetores fixos do lote A conferem os dois.
// Sem Deno.*, sem import por URL: o núcleo também roda no `node --test`.

export type TipoDoTeste = "cpf" | "cnpj" | "email" | "phone";

const E164 = /^\+[1-9][0-9]{7,14}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizarEmail(valor: string): string | null {
  const email = valor.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export function normalizarTelefone(valor: string): string | null {
  const texto = valor.trim();
  const digitos = texto.replace(/\D/g, "");
  let e164: string;
  if (texto.startsWith("+")) e164 = `+${digitos}`;
  else if (digitos.length === 10 || digitos.length === 11) e164 = `+55${digitos}`;
  else if (digitos.startsWith("55") && (digitos.length === 12 || digitos.length === 13)) e164 = `+${digitos}`;
  else return null;
  return E164.test(e164) ? e164 : null;
}

function normalizarDocumento(valor: string, tamanho: 11 | 14): string | null {
  const digitos = valor.replace(/\D/g, "");
  return digitos.length === tamanho ? digitos : null;
}

export function normalizarParaTeste(tipo: TipoDoTeste, valor: string): string {
  const normalizado = tipo === "cpf"
    ? normalizarDocumento(valor, 11)
    : tipo === "cnpj"
    ? normalizarDocumento(valor, 14)
    : tipo === "email"
    ? normalizarEmail(valor)
    : normalizarTelefone(valor);
  if (normalizado === null) throw new Error(`valor inválido para ${tipo}`);
  return normalizado;
}

export async function hashDoTeste(tipo: TipoDoTeste, valor: string, sal: string | undefined): Promise<string> {
  if (!sal) throw new Error("FISCAL_TRIAL_SALT não configurado");
  const bytes = new TextEncoder().encode(sal + normalizarParaTeste(tipo, valor));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ValoresDoTeste = { cpf?: string; cnpj: string; email: string; phone: string };

/** O objeto `p_hashes` de `public.fiscal_reivindicar_teste`. */
export async function hashesDoTeste(
  valores: ValoresDoTeste,
  sal: string | undefined,
): Promise<Partial<Record<TipoDoTeste, string>>> {
  const hashes: Partial<Record<TipoDoTeste, string>> = {};
  for (const tipo of ["cpf", "cnpj", "email", "phone"] as const) {
    const valor = valores[tipo];
    if (valor !== undefined) hashes[tipo] = await hashDoTeste(tipo, valor, sal);
  }
  return hashes;
}
