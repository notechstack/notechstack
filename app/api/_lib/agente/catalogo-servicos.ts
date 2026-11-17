// Descrição do código de serviço nacional para a conferência das boas-vindas (critério 29;
// Landing v2, lote C - boas-vindas). A lista nacional é publicada pelo site em
// `<site>dados/codigos-servico.json` (`{fonte, consultado_em, itens:[{codigo, descricao}]}`,
// lote P). Sem a lista, a pergunta sai sem a descrição.
import { logEvent } from '../log.js'

export interface CatalogoDeServicos {
  descricao(codigo: string): Promise<string | null>
  /** A lista nacional inteira (código → descrição), ou `null` quando ela não carregou. */
  itens?(): Promise<Map<string, string> | null>
}

/**
 * Código de serviço como a pessoa escreve (Lucca, 17/11/2026): 6 dígitos, com ou sem pontos (`04.03.01`, `040301`).
 * Número do Excel que perdeu o zero à esquerda (`40301`) volta a ter 6 dígitos. Qualquer outra coisa: `null`.
 */
export function lerCodigoServico(valor: unknown): string | null {
  if (typeof valor === 'number') {
    return Number.isInteger(valor) && valor >= 10_000 && valor < 1_000_000 ? String(valor).padStart(6, '0') : null
  }
  if (typeof valor !== 'string') return null
  const texto = valor.trim()
  if (!/^\d[\d.\s-]*$/.test(texto)) return null
  const digitos = texto.replace(/\D/g, '')
  if (digitos.length === 6) return digitos
  // "4.03.01": o item da lista sem o zero do começo.
  if (/^\d\.\d{2}\.\d{2}$/.test(texto)) return `0${digitos}`
  if (digitos.length === 5 && /^\d+$/.test(texto)) return `0${digitos}`
  return null
}

const normalizar = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Os códigos da lista cuja descrição bate com o serviço escrito ("fisioterapia" → 040802). Vale a primeira faixa que
 * achar algo: descrição igual ao termo, descrição que começa com ele, e descrição com palavras que começam com cada
 * palavra do termo. Vários códigos na mesma faixa = ambíguo, e quem chama pergunta.
 */
export function buscarServicos(itens: Map<string, string>, termo: string): string[] {
  const t = normalizar(termo).replace(/^(servicos?|codigo) (de |do |da )?/, '')
  if (t.length < 3) return []
  const lista = [...itens].map(([codigo, descricao]) => ({ codigo, d: normalizar(descricao) }))
  const iguais = lista.filter((i) => i.d === t)
  if (iguais.length) return iguais.map((i) => i.codigo)
  const comecam = lista.filter((i) => i.d.startsWith(`${t} `))
  if (comecam.length) return comecam.map((i) => i.codigo)
  const palavras = t.split(' ').filter((p) => p.length >= 3)
  if (!palavras.length) return []
  return lista.filter((i) => palavras.every((p) => i.d.split(' ').some((w) => w.startsWith(p)))).map((i) => i.codigo)
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
    async itens() {
      return carregar()
    },
  }
}
