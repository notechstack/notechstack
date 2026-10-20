// Cliente real do Resend, atrás de `EnviaEmail`. Nenhum teste o chama. Fonte: resend.com/docs,
// "Send Email": `POST https://api.resend.com/emails`, `Authorization: Bearer <chave>`, corpo
// `{from, to, subject, text, attachments: [{filename, content (base64), content_type}]}` e o
// header `Idempotency-Key` (até 256 caracteres, vale 24 horas). Mesma chave `RESEND_API_KEY`
// do auditor. A chave nunca vai para o log.
import type { EnviaEmail } from './canais.js'

export const RESEND_URL = 'https://api.resend.com/emails'
export const REMETENTE_PADRAO = 'nó tech stack <notas@notechstack.com.br>'
const TIMEOUT_MS = 10_000

export class ResendHttpError extends Error {
  constructor(readonly status: number) {
    super(`Resend respondeu ${status}`)
    this.name = 'ResendHttpError'
  }
}

export function emailResend(opcoes: { apiKey: string; from?: string; fetch?: typeof fetch }): EnviaEmail {
  const doFetch = opcoes.fetch ?? fetch
  return {
    async enviar(mensagem) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${opcoes.apiKey}`,
        'content-type': 'application/json',
      }
      if (mensagem.idempotencia) headers['idempotency-key'] = mensagem.idempotencia.slice(0, 256)
      const res = await doFetch(RESEND_URL, {
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
