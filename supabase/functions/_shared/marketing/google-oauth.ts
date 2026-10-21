// OAuth do planner. Erros remotos nunca atravessam esta fronteira.
export const GOOGLE_ESCOPOS = [
  "https://www.googleapis.com/auth/adwords",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
] as const;

export const GOOGLE_CALLBACK = "https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/marketing-hub/google/callback";

export function googleState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
}

// `callback` segue a base pública do hub (MARKETING_HUB_PUBLIC_URL, ex.: o proxy /hub do app);
// sem ela, é a URL da função no supabase.co, como sempre foi.
export function googleConsentimento(clientId: string, state: string, callback: string = GOOGLE_CALLBACK): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback,
    response_type: "code", scope: GOOGLE_ESCOPOS.join(" "), access_type: "offline", prompt: "consent", state }).toString();
  return url.toString();
}

export async function googleTrocarCodigo(clientId: string, clientSecret: string, code: string, callback: string = GOOGLE_CALLBACK): Promise<string> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code,
        grant_type: "authorization_code", redirect_uri: callback }).toString(),
    });
    const body = await response.json();
    if (!response.ok || typeof body.refresh_token !== "string" || !body.refresh_token) throw new Error();
    // Consentimento parcial não substitui uma conexão completa.
    const scopes = typeof body.scope === "string" ? body.scope.split(" ") : [];
    if (!GOOGLE_ESCOPOS.every(scope => scopes.includes(scope))) throw new Error();
    return body.refresh_token;
  } catch {
    throw new Error("troca_falhou");
  }
}
