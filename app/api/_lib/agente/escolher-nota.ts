// Escolha da nota a cancelar quando o pedido achou mais de uma (etapa `escolher_nota`).
//
// Caso real (16/11/2026, conta Escritório): duas empresas da conta tinham a NFS-e nº 2 (o número é por prestador) e o
// agente só aceitava o número da nota; a pessoa respondeu "2", colou a linha da lista, escreveu a empresa e o valor, e
// nunca conseguiu escolher. Agora as opções são numeradas pela posição na lista, e a resposta pode ser o número da
// opção, a linha colada, a empresa, o cliente, o valor, o nº da nota ou a data, sozinhos ou juntos. Só resolve quando
// sobra uma; sobrando mais, a lista volta só com as que restaram.
import { formatarReais } from './documentos.js'
import { dataBr } from './tempo.js'

/** `empresa` = a razão social de quem emitiu, só na conta Escritório com mais de uma empresa (a numeração é por empresa). */
export type Candidata = { id: string; tenantId: string; numero: string; nome: string; valor: string | null; emitidaEm: Date; empresa: string | null }

/** Uma opção da lista: na conta Escritório, a empresa que emitiu vem primeiro. */
export const linhaDaOpcao = (c: Candidata, posicao: number) => {
  const valorEData = `${c.valor ? formatarReais(c.valor) : '-'} · ${dataBr(c.emitidaEm)}`
  return c.empresa
    ? `${posicao}) nº ${c.numero} de ${c.empresa} para ${c.nome} · ${valorEData}`
    : `${posicao}) nº ${c.numero} · ${c.nome} · ${valorEData}`
}

export const COMO_RESPONDER =
  'Responda com o número da opção (1, 2…). Também vale o nome da empresa, do cliente ou o valor. Para sair, escreva *sair*.'

/** A lista numerada, com o cabeçalho e o jeito de responder no fim. */
export const listaDeOpcoes = (cabecalho: string, candidatas: Candidata[]) =>
  [cabecalho, ...candidatas.map((c, i) => linhaDaOpcao(c, i + 1)), COMO_RESPONDER].join('\n')

/** "sair", "cancelar pedido": larga a escolha sem cancelar nada. */
export const ehSairDaEscolha = (texto: string) =>
  /^(sair|sai|parar|cancelar pedido|cancela pedido|cancelar o pedido|cancela o pedido|nenhuma|nenhuma delas)$/.test(normalizar(texto).replace(/[.!?\s]+$/g, ''))

export type LeituraDaEscolha =
  /** Uma só: o índice na lista mostrada (base 0). */
  | { tipo: 'uma'; indice: number }
  /** Nenhuma ou várias batem com as pistas; `numericas` = havia valor, nº, data ou número de opção na resposta. */
  | { tipo: 'filtro'; indices: number[]; numericas: boolean }
  /** Nada que sirva de pista (só palavras soltas que não batem com nenhuma nota, ou nem isso). */
  | { tipo: 'nada' }

const ORDINAIS: Record<string, number> = { primeira: 1, segunda: 2, terceira: 3, quarta: 4, quinta: 5, sexta: 6, setima: 7, oitava: 8, nona: 9, decima: 10 }

/** Palavras que não distinguem uma nota de outra. */
const VAZIAS = new Set([
  'a', 'o', 'as', 'os', 'e', 'de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'pro', 'p', 'em', 'no', 'na', 'nos', 'nas', 'com', 'um', 'uma',
  'nota', 'notas', 'nf', 'nfs', 'nfse', 'fiscal', 'numero', 'opcao', 'empresa', 'cliente', 'tomador', 'prestador', 'emitente', 'valor',
  'emitida', 'quero', 'cancelar', 'cancela', 'cancele', 'essa', 'esta', 'esse', 'este', 'aquela', 'aquele', 'r', 'reais', 'real',
  'ltda', 'me', 'epp', 'eireli', 'sa', 'ss', 'mei', 'pela', 'pelo', 'que', 'eu', 'foi', 'feita',
])

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const tokens = (texto: string) => normalizar(texto).split(/[^a-z0-9]+/).filter(Boolean)
const centavos = (valor: string) => Math.round(Number(valor) * 100)

/** A resposta à lista: `lista` na ordem mostrada; `null` = a nota não está mais emitida (a posição continua valendo). */
export function lerEscolhaDeNota(lista: (Candidata | null)[], texto: string): LeituraDaEscolha {
  const leitura = lerPistas(lista, texto)
  return leitura.tipo === 'filtro' && leitura.indices.length === 1 ? { tipo: 'uma', indice: leitura.indices[0] } : leitura
}

function lerPistas(lista: (Candidata | null)[], texto: string): LeituraDaEscolha {
  let t = normalizar(texto).replace(/[…·•|]/g, ' ').replace(/\s+/g, ' ').trim()
  const total = lista.length
  const existentes = lista.flatMap((c, i) => (c ? [i] : []))

  // Só a opção: "2", "2)", "opção 2", "a segunda". Fora da lista, é o nº da nota (como a lista antiga pedia).
  const soOpcao = /^(?:(?:a\s+)?op[cç]ao\s*|alternativa\s*|a\s+)?(\d{1,3})\s*(?:[).ªao])?$/.exec(t.replace(/[.!?]+$/, ''))
  if (soOpcao) {
    const n = Number(soOpcao[1])
    if (n >= 1 && n <= total) return { tipo: 'uma', indice: n - 1 }
    return { tipo: 'filtro', indices: existentes.filter((i) => Number(lista[i]?.numero) === n), numericas: true }
  }
  const ordinal = /^(?:a\s+)?(primeira|segunda|terceira|quarta|quinta|sexta|setima|oitava|nona|decima)(?:\s+(?:opcao|nota|da lista))?$/.exec(t.replace(/[.!?]+$/, ''))
  if (ordinal) {
    const n = ORDINAIS[ordinal[1]]
    return n <= total ? { tipo: 'uma', indice: n - 1 } : { tipo: 'filtro', indices: [], numericas: true }
  }

  // Pistas soltas, juntas ou numa linha colada da própria lista (a antiga ou a nova).
  let posicao: number | null = null
  let numero: number | null = null
  let valor: number | null = null
  let data: { dia: number; mes: number; ano: number | null } | null = null

  const comPosicao = /^(\d{1,3})\s*\)\s*/.exec(t)
  if (comPosicao) {
    posicao = Number(comPosicao[1])
    t = t.slice(comPosicao[0].length)
  }
  t = t.replace(/(?:^|[^a-z0-9])(?:n\s*\.?\s*[º°o]\s*\.?|numero|nota)\s*(\d{1,15})\b/, (_, n: string) => {
    numero = Number(n)
    return ' '
  })
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (_, d: string, m: string, a?: string) => {
    data = { dia: Number(d), mes: Number(m), ano: a ? (a.length === 2 ? 2000 + Number(a) : Number(a)) : null }
    return ' '
  })
  t = t.replace(/(?:r\$\s*)?\b(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\b|r\$\s*(\d+)(?:\.(\d{2}))?\b/, (_, i?: string, c?: string, i2?: string, c2?: string) => {
    valor = i !== undefined ? Number(i.replace(/\./g, '')) * 100 + Number(c) : Number(i2) * 100 + Number(c2 ?? 0)
    return ' '
  })
  const palavras = tokens(t).filter((p) => !VAZIAS.has(p))

  const numericas = posicao !== null || numero !== null || valor !== null || data !== null
  if (!numericas && !palavras.length) return { tipo: 'nada' }

  const bate = (c: Candidata) => {
    if (numero !== null && Number(c.numero) !== numero) return false
    if (valor !== null && (!c.valor || centavos(c.valor) !== valor)) return false
    if (data) {
      const [dia, mes, ano] = dataBr(c.emitidaEm).split('/').map(Number)
      const d = data as { dia: number; mes: number; ano: number | null }
      if (d.dia !== dia || d.mes !== mes || (d.ano !== null && d.ano !== ano)) return false
    }
    const dela = tokens(`${c.empresa ?? ''} ${c.nome}`)
    return palavras.every((p) => dela.some((d) => d === p || (p.length >= 3 && !/^\d+$/.test(p) && d.startsWith(p))))
  }
  const semPosicao = existentes.filter((i) => bate(lista[i] as Candidata))
  if (posicao === null) {
    if (semPosicao.length === 1) return { tipo: 'uma', indice: semPosicao[0] }
    if (!semPosicao.length && !numericas) return { tipo: 'nada' }
    return { tipo: 'filtro', indices: semPosicao, numericas }
  }
  // Com "N)" na frente (linha colada da lista nova): o resto da linha manda; a posição só desempata.
  const outras = numero !== null || valor !== null || data !== null || palavras.length > 0
  if (!outras) return posicao >= 1 && posicao <= total ? { tipo: 'uma', indice: posicao - 1 } : { tipo: 'filtro', indices: [], numericas: true }
  if (semPosicao.length === 1) return { tipo: 'uma', indice: semPosicao[0] }
  if (semPosicao.includes(posicao - 1)) return { tipo: 'uma', indice: posicao - 1 }
  return { tipo: 'filtro', indices: semPosicao, numericas: true }
}
