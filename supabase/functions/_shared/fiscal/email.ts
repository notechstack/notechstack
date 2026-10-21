// E-mail do código de acesso do nó.fiscal (critério 5): só o código de 6 dígitos, sem link nem URL.
// Envio pela Resend com a URL base em RESEND_API_URL (padrão oficial; o dublê só entra na demonstração).
// Molde: _shared/auditor/email.ts (copiado, não importado).

export type Email = { assunto: string; texto: string; html: string };

export const RESEND_API_PADRAO = "https://api.resend.com";
export const REMETENTE_PADRAO = "nó.fiscal <notas@notechstack.com.br>";
export const ASSUNTO_CODIGO = "Seu código nó.fiscal";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function emailCodigo(codigo: string): Email {
  if (!/^\d{6}$/.test(codigo)) throw new Error("codigo_invalido");
  const corpo = "Digite este código na página do nó.fiscal para continuar. Ele vale por 1 hora. " +
    "Se não foi você que pediu, ignore este e-mail.";
  return {
    assunto: ASSUNTO_CODIGO,
    texto: `${corpo}\n\n${codigo}`,
    // Nenhum outro número de 6 dígitos no corpo (cor em #1a1a1a, não #141414): só o código.
    html: `<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#1a1a1a;max-width:560px;margin:0 auto;padding:24px">` +
      `<h1 style="font-size:18px">${esc(ASSUNTO_CODIGO)}</h1>` +
      `<p style="font-size:15px;line-height:1.5">${esc(corpo)}</p>` +
      `<p style="font-size:32px;letter-spacing:.3em;font-weight:bold;font-family:monospace">${codigo}</p>` +
      `</body></html>`,
  };
}

export function urlResend(env: (k: string) => string | undefined): string {
  return (env("RESEND_API_URL") || RESEND_API_PADRAO).replace(/\/+$/, "");
}

// Devolve o id do e-mail; o erro não leva o destinatário.
export async function enviarResend(o: {
  apiUrl: string;
  apiKey: string;
  remetente: string;
  para: string;
  email: Email;
  fetch?: typeof fetch;
}): Promise<string> {
  const f = o.fetch ?? fetch;
  const resp = await f(`${o.apiUrl}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: o.remetente, to: [o.para], subject: o.email.assunto, text: o.email.texto, html: o.email.html }),
  });
  const corpo = await resp.json().catch(() => ({})) as { id?: string };
  if (!resp.ok || !corpo.id) throw new Error(resp.status >= 500 || resp.status === 429 ? "resend_transitorio" : "resend_recusou");
  return corpo.id;
}
