// OAuth por cliente do auditor ("Conectar com Facebook/Google"). Lógica pura e
// chamadas aos provedores; quem guarda token (Vault) e nonce é o store.
// Proteções do fluxo, todas obrigatórias:
//   state  = v1.<payload base64url>.<HMAC-SHA256>, expira em 10 min e tem nonce de uso único;
//   PKCE   = S256, com o verifier derivado do nonce por HMAC (nada a guardar entre ida e volta);
//   cookie = o nonce também vai num cookie HttpOnly do domínio da função, setado em /ir,
//            e a volta só é aceita no mesmo navegador.
// Erros remotos nunca atravessam esta fronteira com token ou segredo: viram `OauthErro(motivo)`.

import { GRAPH_BASE, metaFetch } from "../meta.ts";
import { GOOGLE_ESCOPOS } from "./google-oauth.ts";

export type Provedor = "meta" | "google";
export const PROVEDORES: readonly Provedor[] = ["meta", "google"];

// Leitura de anúncios e insights, nada além disso.
export const META_ESCOPOS_CLIENTE = ["ads_read"] as const;
export const GOOGLE_ESCOPOS_CLIENTE = GOOGLE_ESCOPOS;

export const STATE_TTL_S = 600;

export type MotivoOauth =
  | "state_invalido" | "state_expirado" | "state_reusado" | "navegador_diferente"
  | "access_denied" | "escopo_insuficiente" | "troca_falhou" | "nao_configurado";

export class OauthErro extends Error {
  constructor(readonly motivo: MotivoOauth) {
    super(motivo);
  }
}

// ---------------------------------------------------------------- base64url

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deB64url(texto: string): Uint8Array<ArrayBuffer> {
  const b64 = texto.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(texto.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const enc = new TextEncoder();

async function chaveHmac(segredo: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", enc.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function hmac(segredo: string, texto: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await chaveHmac(segredo), enc.encode(texto)));
}

// -------------------------------------------------------------------- state

export type StatePayload = {
  n: string; // nonce, 32 bytes em hex
  c: string; // client_id
  u: string; // user_id de quem iniciou
  p: Provedor;
  e: number; // expiração, epoch em segundos
};

export function novoNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function assinarState(segredo: string, payload: StatePayload): Promise<string> {
  const corpo = b64url(enc.encode(JSON.stringify(payload)));
  return `v1.${corpo}.${b64url(await hmac(segredo, `v1.${corpo}`))}`;
}

// Confere assinatura (tempo constante via subtle.verify), forma e validade.
export async function lerState(segredo: string, state: string, agoraMs: number): Promise<StatePayload> {
  const partes = state.split(".");
  if (partes.length !== 3 || partes[0] !== "v1" || state.length > 1024) throw new OauthErro("state_invalido");
  let assinatura: Uint8Array<ArrayBuffer>;
  try { assinatura = deB64url(partes[2]); } catch { throw new OauthErro("state_invalido"); }
  const ok = await crypto.subtle.verify("HMAC", await chaveHmac(segredo), assinatura, enc.encode(`v1.${partes[1]}`));
  if (!ok) throw new OauthErro("state_invalido");
  let p: StatePayload;
  try { p = JSON.parse(new TextDecoder().decode(deB64url(partes[1]))); } catch { throw new OauthErro("state_invalido"); }
  const forma = p && /^[a-f0-9]{64}$/.test(p.n) && typeof p.c === "string" && typeof p.u === "string"
    && PROVEDORES.includes(p.p) && Number.isInteger(p.e);
  if (!forma) throw new OauthErro("state_invalido");
  if (p.e * 1000 <= agoraMs) throw new OauthErro("state_expirado");
  return p;
}

// --------------------------------------------------------------------- PKCE

export async function pkceVerifier(segredo: string, nonce: string): Promise<string> {
  return b64url(await hmac(segredo, `pkce:${nonce}`)); // 43 caracteres, dentro de RFC 7636
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
}

// ------------------------------------------------------------ Consentimento

export function urlConsentimentoMeta(o: {
  appId: string; configId: string | null; redirectUri: string; state: string; challenge: string;
}): string {
  const url = new URL(`https://www.facebook.com/${GRAPH_BASE.split("/").at(-1)}/dialog/oauth`);
  const params: Record<string, string> = {
    client_id: o.appId, redirect_uri: o.redirectUri, state: o.state, response_type: "code",
    code_challenge: o.challenge, code_challenge_method: "S256",
  };
  // Facebook Login for Business: as permissões vêm da configuração (config_id).
  if (o.configId) Object.assign(params, { config_id: o.configId, override_default_response_type: "true" });
  else params.scope = META_ESCOPOS_CLIENTE.join(",");
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export function urlConsentimentoGoogle(o: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code",
    scope: GOOGLE_ESCOPOS_CLIENTE.join(" "), access_type: "offline", prompt: "consent",
    include_granted_scopes: "false", state: o.state, code_challenge: o.challenge, code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

// ---------------------------------------------------------- Troca de código

export type TokenMeta = {
  token: string;
  expiraEm: string | null; // null = sem expiração (token de usuário do sistema do Login for Business)
  escopos: string[];
  usuarioExterno: string | null;
};

type DebugToken = {
  data?: { app_id?: string; is_valid?: boolean; expires_at?: number; scopes?: string[]; user_id?: string };
};

// code → token → (token de usuário: troca pelo longo, 60 dias) → debug_token confere app e escopos.
// Com o Login for Business configurado para token de usuário do sistema, o token já
// nasce sem expiração e a troca pelo longo não se aplica: ela é melhor esforço.
export async function metaTrocarCodigo(o: {
  appId: string; appSecret: string; redirectUri: string; code: string; verifier: string;
}): Promise<TokenMeta> {
  let token: string;
  let debug: DebugToken;
  try {
    const curto = await metaFetch<{ access_token?: string }>("/oauth/access_token", {
      client_id: o.appId, client_secret: o.appSecret, redirect_uri: o.redirectUri, code: o.code, code_verifier: o.verifier,
    }, { maxRetries: 1 });
    if (!curto.access_token) throw new Error();
    token = curto.access_token;
    const longo = await metaFetch<{ access_token?: string }>("/oauth/access_token", {
      grant_type: "fb_exchange_token", client_id: o.appId, client_secret: o.appSecret, fb_exchange_token: token,
    }, { maxRetries: 1 }).catch(() => null);
    if (longo?.access_token) token = longo.access_token;
    debug = await metaFetch<DebugToken>("/debug_token", {
      input_token: token, access_token: `${o.appId}|${o.appSecret}`,
    }, { maxRetries: 1 });
  } catch {
    throw new OauthErro("troca_falhou");
  }
  const d = debug.data ?? {};
  // Token emitido para outro app não entra, mesmo que a troca tenha dado certo.
  if (!d.is_valid || String(d.app_id ?? "") !== o.appId) throw new OauthErro("troca_falhou");
  const escopos = Array.isArray(d.scopes) ? d.scopes.map(String) : [];
  if (!META_ESCOPOS_CLIENTE.every((e) => escopos.includes(e))) throw new OauthErro("escopo_insuficiente");
  const expiraS = d.expires_at && d.expires_at > 0 ? d.expires_at : null;
  return {
    token,
    expiraEm: expiraS ? new Date(expiraS * 1000).toISOString() : null,
    escopos,
    usuarioExterno: d.user_id ? String(d.user_id) : null,
  };
}

export type TokenGoogle = { refreshToken: string; escopos: string[] };

// Consentimento granular do Google: o cliente pode negar parte dos escopos.
// Basta um dos três; a listagem de contas só consulta o que foi concedido.
export async function googleTrocarCodigoCliente(o: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string;
}): Promise<TokenGoogle> {
  let body: { refresh_token?: unknown; scope?: unknown };
  try {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: o.clientId, client_secret: o.clientSecret, code: o.code, code_verifier: o.verifier,
        grant_type: "authorization_code", redirect_uri: o.redirectUri,
      }).toString(),
    });
    body = await resp.json();
    if (!resp.ok) throw new Error();
  } catch {
    throw new OauthErro("troca_falhou");
  }
  if (typeof body.refresh_token !== "string" || !body.refresh_token) throw new OauthErro("troca_falhou");
  const escopos = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [];
  if (!GOOGLE_ESCOPOS_CLIENTE.some((e) => escopos.includes(e))) throw new OauthErro("escopo_insuficiente");
  return { refreshToken: body.refresh_token, escopos: escopos.filter((e) => (GOOGLE_ESCOPOS_CLIENTE as readonly string[]).includes(e)) };
}

// ------------------------------------------------------- signed_request da Meta

// Deauthorize e exclusão de dados: `<assinatura>.<payload>` em base64url, HMAC-SHA256
// do payload com o app secret. Devolve o user_id (app-scoped) ou null se não confere.
export async function metaSignedRequest(appSecret: string, signed: string): Promise<{ userId: string } | null> {
  const [sig, corpo, ...resto] = signed.split(".");
  if (!sig || !corpo || resto.length || signed.length > 4096) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await chaveHmac(appSecret), deB64url(sig), enc.encode(corpo));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(deB64url(corpo))) as { algorithm?: string; user_id?: unknown };
    if (String(p.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
    const userId = String(p.user_id ?? "");
    return /^\d{1,30}$/.test(userId) ? { userId } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Revogação

// Melhor esforço: o token pode já estar inválido. Quem chama apaga do Vault de qualquer jeito.
export async function revogarNoProvedor(provedor: Provedor, token: string): Promise<boolean> {
  try {
    const resp = provedor === "meta"
      ? await fetch(`${GRAPH_BASE}/me/permissions?access_token=${encodeURIComponent(token)}`, { method: "DELETE" })
      : await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      });
    await resp.body?.cancel();
    return resp.ok;
  } catch {
    return false;
  }
}
