// PDFs das guias no Supabase Storage, bucket privado `fiscal-guias` (critério 6). O navegador do escritório sobe cada
// PDF direto ao Storage por URL assinada de upload: nenhum PDF passa pelo corpo de uma função da Vercel (limite de
// 4,5 MB). O motor só baixa (leitura e envio) e assina links curtos de download (página /g/<token>).
// API do Storage (supabase/storage, "object"): `POST /storage/v1/object/upload/sign/{bucket}/{caminho}` → `{url}`
// (relativa a /storage/v1, com `?token=`), `PUT` nessa URL com o arquivo; `GET /storage/v1/object/{bucket}/{caminho}`
// com a chave; `POST /storage/v1/object/sign/{bucket}/{caminho}` `{expiresIn}` → `{signedURL}`.
// A chave (`FISCAL_GUIAS_STORAGE_KEY`, a service role do projeto) só fala com o Storage e nunca vai a log.
export const BUCKET_GUIAS = 'fiscal-guias'
/** Uma guia tem ~300 KB; 10 MB é o teto do bucket. */
export const MAX_BYTES_DO_PDF = 10 * 1024 * 1024
const TIMEOUT_MS = 15_000

export class StorageHttpError extends Error {
  constructor(readonly status: number) {
    super(`Storage respondeu ${status}`)
    this.name = 'StorageHttpError'
  }
}

export interface ArmazemDeGuias {
  /** URL absoluta para o navegador fazer `PUT` do PDF (vale por 2 horas, padrão do Storage). */
  urlDeUpload(caminho: string): Promise<string>
  baixar(caminho: string, limite?: number): Promise<Uint8Array>
  /** URL absoluta de download que expira em `segundos`. */
  urlDeDownload(caminho: string, segundos: number, nomeDoArquivo?: string): Promise<string>
}

const codificar = (caminho: string) => caminho.split('/').map(encodeURIComponent).join('/')

export function storageSupabase(opcoes: { url: string; chave: string; bucket?: string; publico?: string; fetch?: typeof fetch }): ArmazemDeGuias {
  const doFetch = opcoes.fetch ?? fetch
  const base = `${opcoes.url.replace(/\/+$/, '')}/storage/v1`
  // URL que o navegador enxerga (na demonstração, a mesma; em produção, a do projeto).
  const publico = `${(opcoes.publico ?? opcoes.url).replace(/\/+$/, '')}/storage/v1`
  const bucket = opcoes.bucket ?? BUCKET_GUIAS
  const auth = { authorization: `Bearer ${opcoes.chave}`, apikey: opcoes.chave }

  async function assinar(rota: string, corpo: unknown): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}${rota}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new StorageHttpError(res.status)
    return ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>
  }

  return {
    async urlDeUpload(caminho) {
      const r = await assinar(`/object/upload/sign/${bucket}/${codificar(caminho)}`, {})
      if (typeof r.url !== 'string') throw new StorageHttpError(502)
      return `${publico}${r.url.startsWith('/') ? '' : '/'}${r.url}`
    },
    async baixar(caminho, limite = MAX_BYTES_DO_PDF) {
      const res = await doFetch(`${base}/object/${bucket}/${codificar(caminho)}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw new StorageHttpError(res.status)
      const declarado = Number(res.headers.get('content-length'))
      if (Number.isFinite(declarado) && declarado > limite) {
        await res.body?.cancel().catch(() => undefined)
        throw new StorageHttpError(413)
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.byteLength > limite) throw new StorageHttpError(413)
      return bytes
    },
    async urlDeDownload(caminho, segundos, nomeDoArquivo) {
      const r = await assinar(`/object/sign/${bucket}/${codificar(caminho)}`, { expiresIn: segundos })
      const assinada = typeof r.signedURL === 'string' ? r.signedURL : typeof r.signedUrl === 'string' ? r.signedUrl : null
      if (!assinada) throw new StorageHttpError(502)
      const url = `${publico}${assinada.startsWith('/') ? '' : '/'}${assinada}`
      return nomeDoArquivo ? `${url}${url.includes('?') ? '&' : '?'}download=${encodeURIComponent(nomeDoArquivo)}` : url
    },
  }
}

export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): ArmazemDeGuias | null {
  const url = env.FISCAL_GUIAS_STORAGE_URL || env.SUPABASE_URL
  const chave = env.FISCAL_GUIAS_STORAGE_KEY
  if (!url || !chave) return null
  return storageSupabase({ url, chave, publico: env.FISCAL_GUIAS_STORAGE_URL_PUBLICA || url })
}
