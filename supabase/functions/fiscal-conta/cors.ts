// CORS das funções do agente fiscal chamadas pelo site (Surface de .tasks/agente-fiscal-v2.md): o site
// da nó (www e raiz), as origens do app e localhost só quando FISCAL_SITE_URL é localhost
// (demonstração). Mesma regra do lote A; _shared/cors.ts é compartilhado e não muda.

const ORIGENS_FIXAS = new Set([
  "https://www.notechstack.com.br",
  "https://notechstack.com.br",
  "https://app.notechstack.com.br",
  "https://notechstack-app.vercel.app",
]);
const RE_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function siteLocal(siteUrl: string | undefined): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/|$)/.test(siteUrl ?? "");
}

export function corsFiscal(origem: string | null, siteUrl: string | undefined): Record<string, string> {
  const ok = origem && (ORIGENS_FIXAS.has(origem) || (siteLocal(siteUrl) && RE_LOCAL.test(origem)));
  return ok
    ? {
      "Access-Control-Allow-Origin": origem!,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    }
    : { Vary: "Origin" };
}
