// Um refresh token OAuth só (escopos Ads, Analytics leitura e Search Console
// leitura) vira access token com cache em memória por worker.

export type GoogleCredenciais = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export class GoogleApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MARGEM_MS = 60_000;

// Um access token por credencial (hash): a Nó e cada cliente do auditor no mesmo
// worker nunca trocam de token entre si.
const MAX_CACHE = 200;
const cache = new Map<string, { token: string; expiraEm: number }>();

export function limparCacheGoogle(): void {
  cache.clear();
}

export async function googleAccessToken(cred: GoogleCredenciais, now = Date.now()): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${cred.clientId}:${cred.clientSecret}:${cred.refreshToken}`));
  const chave = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const emCache = cache.get(chave);
  if (emCache && emCache.expiraEm - MARGEM_MS > now) return emCache.token;

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      refresh_token: cred.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const body = await resp.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
  if (!resp.ok || !body.access_token) {
    // Nunca inclui o token nem o segredo na mensagem.
    const codigo = ["invalid_client", "invalid_grant", "unauthorized_client", "invalid_request", "invalid_scope", "temporarily_unavailable"].includes(body.error ?? "")
      ? body.error : "sem access_token";
    throw new GoogleApiError(resp.status, { error: codigo }, `Google OAuth ${resp.status}: ${codigo}`);
  }
  cache.delete(chave);
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string); // sai o mais antigo
  cache.set(chave, { token: body.access_token, expiraEm: now + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

export function mensagemGoogle(status: number, body: unknown): string {
  const erro = (body as { error?: { message?: string; status?: string; details?: unknown[] } } | null)?.error;
  const detalhe = extrairDetalheAds(erro?.details);
  const base = erro?.message ?? `HTTP ${status}`;
  return detalhe ? `${base} (${detalhe})` : base;
}

// O Google Ads devolve o motivo útil dentro de details[].errors[].message.
function extrairDetalheAds(details: unknown[] | undefined): string | null {
  if (!Array.isArray(details)) return null;
  const mensagens: string[] = [];
  for (const d of details) {
    const errors = (d as { errors?: { message?: string }[] })?.errors;
    if (Array.isArray(errors)) for (const e of errors) if (e?.message) mensagens.push(e.message);
  }
  return mensagens.length ? mensagens.slice(0, 3).join("; ") : null;
}

export async function googleFetch<T>(
  url: string,
  token: string,
  init: { method?: "GET" | "POST"; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const resp = await fetch(url, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const texto = await resp.text();
  let body: unknown = texto;
  try {
    body = texto ? JSON.parse(texto) : {};
  } catch (_) {
    // resposta não JSON; mantém texto
  }
  if (!resp.ok) throw new GoogleApiError(resp.status, body, mensagemGoogle(resp.status, body));
  return body as T;
}
