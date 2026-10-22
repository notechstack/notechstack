// `ConsultaCnpj` real pela BrasilAPI (Landing v2, lote C - consulta de CNPJ e URLs base): o
// nome do tomador PJ vem dos dados públicos. Fonte: brasilapi.com.br/docs, "CNPJ":
// `GET /api/cnpj/v1/{cnpj}` → `razao_social`, a mesma rota que o lote A usa no cadastro. Falha,
// 404 ou resposta sem nome → `null`, e a conversa fica com o nome escrito (como na v1).
import type { ConsultaCnpj } from './conversa.js'

export const CNPJ_API = 'https://brasilapi.com.br'
// A BrasilAPI responde 403 ao user-agent padrão do Node ("node") e 429 sem user-agent (conferido em 22/10/2026).
export const USER_AGENT = 'no-fiscal/1.0 (+https://www.notechstack.com.br)'
const TIMEOUT_MS = 5_000

export function consultaCnpjBrasilApi(opcoes: { baseUrl?: string; fetch?: typeof fetch } = {}): ConsultaCnpj {
  const doFetch = opcoes.fetch ?? fetch
  const raiz = (opcoes.baseUrl || CNPJ_API).replace(/\/+$/, '')
  return {
    async razaoSocial(cnpj) {
      const digitos = cnpj.replace(/\D/g, '')
      if (digitos.length !== 14) return null
      try {
        const res = await doFetch(`${raiz}/api/cnpj/v1/${digitos}`, {
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) return null
        const corpo = (await res.json().catch(() => null)) as { razao_social?: unknown } | null
        const nome = typeof corpo?.razao_social === 'string' ? corpo.razao_social.trim() : ''
        return nome || null
      } catch {
        return null
      }
    },
  }
}
