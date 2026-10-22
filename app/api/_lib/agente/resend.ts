// Cliente real do Resend, atrás de `EnviaEmail`. Nenhum teste o chama fora do Resend: os testes
// passam um `fetch` de dublê. Fonte: resend.com/docs, "Send Email": `POST https://api.resend.com/emails`,
// `Authorization: Bearer <chave>`, corpo `{from, to, subject, text, attachments: [{filename,
// content (base64), content_type}]}` e o header `Idempotency-Key` (até 256 caracteres, vale 24
// horas). Mesma chave `RESEND_API_KEY` do auditor. A base vem de `RESEND_API_URL` (padrão
// oficial; Landing v2, lote C), para a demonstração. A chave nunca vai para o log.
import type { EnviaEmail } from './canais.js'

export const RESEND_API = 'https://api.resend.com'
export const RESEND_URL = `${RESEND_API}/emails`
export const REMETENTE_PADRAO = 'nó tech stack <notas@notechstack.com.br>'
const TIMEOUT_MS = 10_000

export class ResendHttpError extends Error {
  constructor(readonly status: number) {
    super(`Resend respondeu ${status}`)
    this.name = 'ResendHttpError'
  }
}

export function emailResend(opcoes: { apiKey: string; from?: string; baseUrl?: string; fetch?: typeof fetch }): EnviaEmail {
  const doFetch = opcoes.fetch ?? fetch
  const endpoint = `${(opcoes.baseUrl || RESEND_API).replace(/\/+$/, '')}/emails`
  return {
    async enviar(mensagem) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${opcoes.apiKey}`,
        'content-type': 'application/json',
      }
      if (mensagem.idempotencia) headers['idempotency-key'] = mensagem.idempotencia.slice(0, 256)
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          from: opcoes.from ?? REMETENTE_PADRAO,
          to: [mensagem.para],
          subject: mensagem.assunto,
          text: mensagem.texto,
          ...(mensagem.anexos?.length
            ? {
                attachments: mensagem.anexos.map((a) => ({
                  filename: a.nome,
                  content: Buffer.from(a.conteudo).toString('base64'),
                  content_type: a.tipo,
                })),
              }
            : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new ResendHttpError(res.status)
    },
  }
}
