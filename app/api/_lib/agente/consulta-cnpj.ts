// `ConsultaCnpj` real pela BrasilAPI (Landing v2, lote C - consulta de CNPJ e URLs base): o
// nome do tomador PJ vem dos dados públicos. Fonte: brasilapi.com.br/docs, "CNPJ":
// `GET /api/cnpj/v1/{cnpj}` → `razao_social`, a mesma rota que o lote A usa no cadastro. Falha,
// 404 ou resposta sem nome → `null`, e a conversa fica com o nome escrito (como na v1).
// A mesma rota dá o endereço do tomador (`codigo_municipio_ibge`, `cep`, `logradouro`, `numero`, `complemento`,
// `bairro`), que vai em toda nota de tomador com CNPJ (endereco-tomador.ts, 24/11/2026).
// Se a BrasilAPI cai, demora ou responde sem o dado, pergunta ao espelho (minhareceita.org, mesma base e mesmos
// campos, como em supabase/functions/_shared/fiscal/cnpj.ts); sem endereço nos dois, à CNPJ.ws (reserva do cadastro).
import { enderecoDaReceita, type EnderecoNacional } from '../retencao.js'
import type { ConsultaCnpj } from './conversa.js'

export const CNPJ_API = 'https://brasilapi.com.br'
export const CNPJ_API_ESPELHO = 'https://minhareceita.org'
export const CNPJ_API_RESERVA = 'https://publica.cnpj.ws'
// A BrasilAPI responde 403 ao user-agent padrão do Node ("node") e 429 sem user-agent (conferido em 22/10/2026).
export const USER_AGENT = 'no-fiscal/1.0 (+https://www.notechstack.com.br)'
const TIMEOUT_MS = 5_000

type Corpo = Record<string, unknown>

const objeto = (v: unknown): Corpo => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Corpo) : {})

/** O endereço da resposta `GET /cnpj/{cnpj}` da CNPJ.ws (`estabelecimento`), no formato do `endNac`. */
export function enderecoDaCnpjWs(corpo: unknown): EnderecoNacional | null {
  const e = objeto(objeto(corpo).estabelecimento)
  return enderecoDaReceita({
    codigo_municipio_ibge: objeto(e.cidade).ibge_id,
    cep: e.cep,
    descricao_tipo_de_logradouro: e.tipo_logradouro,
    logradouro: e.logradouro,
    numero: e.numero,
    complemento: e.complemento,
    bairro: e.bairro,
  })
}

export function consultaCnpjBrasilApi(
  opcoes: { baseUrl?: string; espelhoUrl?: string | null; reservaUrl?: string | null; fetch?: typeof fetch } = {},
): ConsultaCnpj {
  const doFetch = opcoes.fetch ?? fetch
  const raiz = (opcoes.baseUrl || CNPJ_API).replace(/\/+$/, '')
  const espelho = opcoes.espelhoUrl === null ? null : (opcoes.espelhoUrl || CNPJ_API_ESPELHO).replace(/\/+$/, '')
  const reserva = opcoes.reservaUrl === null ? null : (opcoes.reservaUrl || CNPJ_API_RESERVA).replace(/\/+$/, '')

  async function pedir(url: string): Promise<Corpo | null> {
    try {
      const res = await doFetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) return null
      const corpo = await res.json().catch(() => null)
      return typeof corpo === 'object' && corpo !== null && !Array.isArray(corpo) ? (corpo as Corpo) : null
    } catch {
      return null
    }
  }

  /** O primeiro corpo de que `extrair` tira algo: BrasilAPI, depois o espelho. */
  async function publico<T>(cnpj: string, extrair: (c: Corpo | null) => T | null): Promise<T | null> {
    const digitos = cnpj.replace(/\D/g, '')
    if (digitos.length !== 14) return null
    const principal = extrair(await pedir(`${raiz}/api/cnpj/v1/${digitos}`))
    if (principal !== null || !espelho) return principal
    return extrair(await pedir(`${espelho}/${digitos}`))
  }

  return {
    async razaoSocial(cnpj) {
      return publico(cnpj, (corpo) => {
        const nome = typeof corpo?.razao_social === 'string' ? corpo.razao_social.trim() : ''
        return nome || null
      })
    },
    async endereco(cnpj) {
      const lido = await publico(cnpj, (corpo) => (corpo ? enderecoDaReceita(corpo) : null))
      if (lido || !reserva) return lido
      const digitos = cnpj.replace(/\D/g, '')
      if (digitos.length !== 14) return null
      return enderecoDaCnpjWs(await pedir(`${reserva}/cnpj/${digitos}`))
    },
  }
}

/**
 * A consulta do ambiente: `CNPJ_API_URL` (opcional) troca a BrasilAPI; `CNPJ_API_ESPELHO_URL` e
 * `CNPJ_API_RESERVA_URL` trocam o espelho e a reserva. Com a BrasilAPI num endereço local (a demo, com dublês),
 * espelho e reserva ficam desligados, salvo se apontados à mão: a demo não sai para a internet.
 */
export function consultaCnpjFromEnv(env: Record<string, string | undefined> = process.env): ConsultaCnpj {
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(env.CNPJ_API_URL ?? '')
  return consultaCnpjBrasilApi({
    baseUrl: env.CNPJ_API_URL || undefined,
    espelhoUrl: env.CNPJ_API_ESPELHO_URL || (local ? null : undefined),
    reservaUrl: env.CNPJ_API_RESERVA_URL || (local ? null : undefined),
  })
}
