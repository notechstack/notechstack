// Informações complementares da nota (pedido da Contabilidade Bragantina, 17/11/2026): texto livre que vai em
// `DPS/infDPS/serv/infoCompl/xInfComp`, nos dois leiautes (XSD de produção 09/02/2026 e NT 009 de 20/10/2026).
// O tipo é `TSDescInfCompl`: 1 a 2.000 caracteres do padrão `TSString`, isto é, só de " " (0x20) a "ÿ" (0xFF),
// sem quebra de linha nem tabulação, e sem espaço no começo ou no fim. Quem grava a nota (API, painel, WhatsApp)
// normaliza aqui; o montador da DPS normaliza de novo, por garantia.

export const MAX_INFO_COMPLEMENTAR = 2000

const TROCAS: [RegExp, string][] = [
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/[\u2018\u2019\u201A\u201B\u2032]/g, "'"],
  [/[\u201C\u201D\u201E\u201F\u2033]/g, '"'],
  [/\u2026/g, '...'],
  [/[\u2022\u2023\u2043\u25AA\u25CF\u25E6]/g, '-'],
  [/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' '],
]

/**
 * Texto que o leiaute aceita: aspas e travessões tipográficos viram os simples, cada quebra de linha vira " - " (ou
 * só espaço, se a linha termina em ":", "," ou "-"), espaços se juntam, e o que fica fora de Latin-1 (emoji) sai.
 * Vazio vira `null`. Não corta: quem chama confere o limite.
 */
export function normalizarInfoComplementar(bruto: unknown): string | null {
  if (typeof bruto !== 'string') return null
  let texto = bruto.normalize('NFC')
  for (const [de, para] of TROCAS) texto = texto.replace(de, para)
  const linhas = texto
    .split(/\r\n|[\r\n\u2028\u2029\u0085]/)
    .map((l) => l.replace(/[\t\v\f]/g, ' ').replace(/[^\x20-\x7E\xA0-\xFF]/g, '').replace(/ {2,}/g, ' ').trim())
    .filter(Boolean)
  let saida = ''
  for (const linha of linhas) {
    if (!saida) saida = linha
    else saida += /[:,-]$/.test(saida) ? ` ${linha}` : ` - ${linha}`
  }
  saida = saida.trim()
  return saida || null
}

export type InfoComplementarLida = { ok: true; texto: string | null } | { ok: false; tamanho: number }

/** Normaliza e confere o limite do leiaute. Ausente ou vazio: `texto: null`. */
export function lerInfoComplementar(bruto: unknown): InfoComplementarLida {
  const texto = normalizarInfoComplementar(bruto)
  if (texto !== null && texto.length > MAX_INFO_COMPLEMENTAR) return { ok: false, tamanho: texto.length }
  return { ok: true, texto }
}

// Marcadores no pedido escrito. Os de rótulo ("Informações complementares:") saem do texto; os de conteúdo
// ("Dados bancários:", "Obs:", "Chave PIX:") ficam, porque dizem o que vem depois. Todos pedem ":" ou "-" depois,
// menos o rótulo completo, para não pegar uma descrição que só cita as palavras.
const ROTULO = /\b(?:informa[çc](?:[õo]es|[ãa]o)\s+complementa(?:res|r)|infos?\.?\s+compl(?:ementar(?:es)?)?\.?)\s*[:\-–—]?\s*/i
const CONTEUDO = [
  /\bdados\s+banc[áa]rios\s*[:\-–—]/i,
  /\bdados\s+(?:para|de|do|p\/)\s*pagamento\s*[:\-–—]/i,
  /\bchave\s+pix\s*[:\-–—]/i,
  /\b(?:obs\.?|observa[çc](?:[ãa]o|[õo]es))\s*:/i,
]

/**
 * Separa as informações complementares de um pedido escrito (caso real de 17/11/2026: "… realizados no mês 09/2026
 * - Dados bancários: Caixa Economica Federal - Agencia: … - Conta Corrente: …"; a IA jogava fora os dados
 * bancários). Do primeiro marcador até o fim é a informação; antes dele, o pedido, que segue para a IA. Por código:
 * agência e conta não passam pela IA, que poderia trocar um dígito ou ler um CNPJ do favorecido como o do tomador.
 */
export function separarInfoComplementar(texto: string): { pedido: string; info: string | null } {
  let inicio = -1
  let corpo = -1
  const rotulo = ROTULO.exec(texto)
  if (rotulo) {
    inicio = rotulo.index
    corpo = rotulo.index + rotulo[0].length
  }
  for (const re of CONTEUDO) {
    const m = re.exec(texto)
    if (m && (inicio < 0 || m.index < inicio)) {
      inicio = m.index
      corpo = m.index
    }
  }
  if (inicio < 0) return { pedido: texto, info: null }
  const pedido = texto.slice(0, inicio).replace(/[\s\-–—,;:.(]+$/, '').trim()
  const info = normalizarInfoComplementar(texto.slice(corpo))
  return { pedido, info }
}
