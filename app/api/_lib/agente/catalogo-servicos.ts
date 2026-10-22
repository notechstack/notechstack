// Descrição do código de serviço nacional para a conferência das boas-vindas (critério 29;
// Landing v2, lote C - boas-vindas). A lista nacional é publicada pelo site em
// `<site>dados/codigos-servico.json` (`{fonte, consultado_em, itens:[{codigo, descricao}]}`,
// lote P). Sem a lista, a pergunta sai sem a descrição.
import { logEvent } from '../log.js'

export interface CatalogoDeServicos {
  descricao(codigo: string): Promise<string | null>
}

const TIMEOUT_MS = 5_000
const VALIDADE_MS = 3600_000

export function catalogoDoSite(opcoes: { site: string; fetch?: typeof fetch; now?: () => number }): CatalogoDeServicos {
  const doFetch = opcoes.fetch ?? fetch
  const agora = opcoes.now ?? Date.now
  const url = `${opcoes.site.endsWith('/') ? opcoes.site : `${opcoes.site}/`}dados/codigos-servico.json`
  let cache: { em: number; itens: Map<string, string> } | null = null

  async function carregar(): Promise<Map<string, string> | null> {
    if (cache && agora() - cache.em < VALIDADE_MS) return cache.itens
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw new Error(`lista respondeu ${res.status}`)
      const corpo = (await res.json()) as { itens?: unknown }
      const itens = new Map<string, string>()
      for (const item of Array.isArray(corpo.itens) ? corpo.itens : []) {
        const { codigo, descricao } = (item ?? {}) as { codigo?: unknown; descricao?: unknown }
        // Sem o ponto final da lista oficial ("Medicina."): a descrição entra no meio das frases do bot.
        if (typeof codigo === 'string' && typeof descricao === 'string') itens.set(codigo, descricao.trim().replace(/\.+$/, ''))
      }
      cache = { em: agora(), itens }
      return itens
    } catch (error) {
      logEvent('agente.catalogo_indisponivel', { error_name: error instanceof Error ? error.name : 'unknown' })
      return null
    }
  }

  return {
    async descricao(codigo) {
      return (await carregar())?.get(codigo) || null
    },
  }
}
