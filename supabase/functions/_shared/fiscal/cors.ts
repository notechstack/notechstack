// CORS das edge functions do agente fiscal (Surface de .tasks/agente-fiscal-v2.md): o site da nó
// (www e raiz), as origens do app e localhost só quando FISCAL_SITE_URL é localhost (demonstração).
// Separado de _shared/cors.ts, que é compartilhado e não muda.

const ORIGENS_FIXAS = new Set([
  "https://www.notechstack.com.br",
  "https://notechstack.com.br",
  "https://app.notechstack.com.br",
  "https://notechstack-app.vercel.app",
]);
const RE_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function siteLocal(env: (k: string) => string | undefined): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/|$)/.test(env("FISCAL_SITE_URL") ?? "");
}

export function corsFiscal(origem: string | null, env: (k: string) => string | undefined): Record<string, string> {
  const ok = origem && (ORIGENS_FIXAS.has(origem) || (siteLocal(env) && RE_LOCAL.test(origem)));
  return ok
    ? {
      "Access-Control-Allow-Origin": origem!,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    }
    : { Vary: "Origin" };
}

export function json(status: number, corpo: unknown, h: Record<string, string>): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { ...h, "Content-Type": "application/json" } });
}
