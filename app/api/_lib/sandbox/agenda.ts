// Trabalho do sandbox depois da resposta: a "Sefin" simulada responde alguns segundos depois do POST, e o webhook
// sandbox sai em seguida. Na Vercel, a promessa entra no `waitUntil` do contexto da requisição (o mesmo que o pacote
// `@vercel/functions` usa por dentro), e a função espera por ela antes de encerrar. Fora da Vercel (teste, script),
// a promessa corre sem ninguém esperar. Se nada disso rodar, a rodada preguiçosa da próxima chamada sandbox avança.
import { logEvent } from '../log.js'

export type Agendar = (tarefa: () => Promise<void>, atrasoMs: number) => void

const CONTEXTO_DA_VERCEL = Symbol.for('@vercel/request-context')

type ContextoDaVercel = { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined }

export const agendarNaVercel: Agendar = (tarefa, atrasoMs) => {
  const promessa = new Promise<void>((resolve) => setTimeout(resolve, atrasoMs))
    .then(tarefa)
    .catch((error) => logEvent('nofiscal.sandbox_rodada_falhou', { error_name: error instanceof Error ? error.name : 'unknown' }))
  const contexto = (globalThis as Record<symbol, ContextoDaVercel | undefined>)[CONTEXTO_DA_VERCEL]
  contexto?.get?.()?.waitUntil?.(promessa)
}
