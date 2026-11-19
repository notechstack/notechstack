// Leitura de uma guia em PDF (módulo Guias, critérios 9 a 11). Primeiro por regra, no texto do PDF: tipo pelo título
// (DAS, DAS-MEI, DARF, DARF da DCTFWeb, FGTS Digital, ISS, parcelamento, honorários), CNPJ/CPF, competência
// ("Período de Apuração"), vencimento ("Pagar este documento até"), valor e linha digitável (boleto de 47 ou código
// de arrecadação de 48, conferidos pelos DVs). O valor do texto é conferido com o do código de barras. Só se faltar
// campo, ou se o PDF for imagem, entra a IA de reserva (Haiku), que só preenche o que faltou e nunca dispara nada.
import { cnpjValido, cpfValido } from '../agente/documentos.js'
import { lerLinha, type CodigoLido } from './codigos.js'

export const TIPOS_DE_GUIA = ['das', 'das_mei', 'darf', 'dctfweb', 'fgts', 'iss', 'parcelamento', 'honorario', 'outro'] as const
export type TipoDeGuia = (typeof TIPOS_DE_GUIA)[number]

export type CamposGuia = {
  tipo: TipoDeGuia | null
  documento: string | null
  /** Primeiro dia do mês, `AAAA-MM-01`. */
  competencia: string | null
  valor_centavos: number | null
  /** `AAAA-MM-DD`. */
  vencimento: string | null
  linha_digitavel: string | null
}

export type OrigemDoCampo = 'regra' | 'codigo_barras' | 'ia' | 'manual'
export type CampoDaGuia = keyof CamposGuia
export const CAMPOS: CampoDaGuia[] = ['tipo', 'documento', 'competencia', 'valor_centavos', 'vencimento', 'linha_digitavel']

export type LeituraGuia = {
  campos: CamposGuia
  origem: Partial<Record<CampoDaGuia, OrigemDoCampo>>
  faltando: CampoDaGuia[]
  /** O valor escrito no PDF não bate com o do código de barras (a guia fica amarela). */
  valor_divergente: boolean
  valor_codigo_barras: number | null
  com_texto: boolean
  ia: boolean
  /** Motivo da IA não ter completado (sem IA configurada, falha, resposta inválida). */
  ia_erro?: string
}

export type OpcoesDaLeitura = {
  /** CNPJs/CPFs que nunca são o do cliente (o do próprio escritório, beneficiário dos honorários). */
  excluir?: string[]
  /** Data de referência para o fator de vencimento do boleto. */
  hoje?: Date
}

const MESES: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
}

/** Minúsculas e sem acento, para as regras. */
export const normalizar = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

const pad2 = (n: number) => String(n).padStart(2, '0')

function dataValida(d: number, m: number, a: number): string | null {
  if (a < 2000 || a > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const iso = `${a}-${pad2(m)}-${pad2(d)}`
  const dt = new Date(`${iso}T00:00:00Z`)
  return dt.getUTCDate() === d ? iso : null
}

/** Primeira data dd/mm/aaaa nos `janela` caracteres depois de um dos rótulos (na ordem dos rótulos). */
function dataDepoisDe(texto: string, rotulos: RegExp[], janela = 160): string | null {
  for (const rotulo of rotulos) {
    for (const m of texto.matchAll(new RegExp(rotulo.source, 'g'))) {
      const trecho = texto.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + janela)
      const d = /(\d{2})\/(\d{2})\/(\d{4})/.exec(trecho)
      if (d) {
        const iso = dataValida(Number(d[1]), Number(d[2]), Number(d[3]))
        if (iso) return iso
      }
    }
  }
  return null
}

/** "Novembro/2026", "11/2026", "nov/26" ou "30/11/2026" depois do rótulo → `AAAA-MM-01`. */
function competenciaDepoisDe(texto: string, rotulos: RegExp[], janela = 160): string | null {
  for (const rotulo of rotulos) {
    for (const m of texto.matchAll(new RegExp(rotulo.source, 'g'))) {
      const trecho = texto.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + janela)
      const porNome = /\b([a-z]{3,9})\s*(?:\/|de|-)\s*(\d{4}|\d{2})\b/.exec(trecho)
      if (porNome && MESES[porNome[1]]) {
        const ano = porNome[2].length === 2 ? 2000 + Number(porNome[2]) : Number(porNome[2])
        if (ano >= 2000 && ano <= 2100) return `${ano}-${pad2(MESES[porNome[1]])}-01`
      }
      const data = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(trecho)
      const mesAno = /\b(\d{2})\/(\d{4})\b/.exec(trecho)
      const primeiro = [data, mesAno].filter((x): x is RegExpExecArray => !!x).sort((a, b) => a.index - b.index)[0]
      if (primeiro === data && data) {
        const iso = dataValida(Number(data[1]), Number(data[2]), Number(data[3]))
        if (iso) return `${iso.slice(0, 7)}-01`
      } else if (mesAno) {
        const mes = Number(mesAno[1])
        const ano = Number(mesAno[2])
        if (mes >= 1 && mes <= 12 && ano >= 2000 && ano <= 2100) return `${ano}-${pad2(mes)}-01`
      }
    }
  }
  return null
}

const DINHEIRO = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})(?!\d)/

function valorDepoisDe(texto: string, rotulos: RegExp[], janela = 120): number | null {
  for (const rotulo of rotulos) {
    for (const m of texto.matchAll(new RegExp(rotulo.source, 'g'))) {
      const trecho = texto.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + janela)
      const v = DINHEIRO.exec(trecho)
      if (v) {
        const centavos = Number(v[1].replace(/\./g, '').replace(',', ''))
        if (centavos > 0) return centavos
      }
    }
  }
  return null
}

const CNPJ_NO_TEXTO = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g
const CPF_NO_TEXTO = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g

/** CNPJ/CPF do cliente: o primeiro válido (fora os excluídos); no boleto, de preferência o do pagador. */
function documentoDoTexto(texto: string, excluir: Set<string>, preferirApos: RegExp | null): string | null {
  const achados: { doc: string; pos: number }[] = []
  for (const re of [CNPJ_NO_TEXTO, CPF_NO_TEXTO]) {
    for (const m of texto.matchAll(re)) {
      const doc = m[0].replace(/\D/g, '')
      const ok = doc.length === 14 ? cnpjValido(doc) : cpfValido(doc)
      if (ok && !excluir.has(doc)) achados.push({ doc, pos: m.index ?? 0 })
    }
  }
  if (!achados.length) return null
  achados.sort((a, b) => a.pos - b.pos)
  if (preferirApos) {
    const marco = preferirApos.exec(texto)
    const depois = marco ? achados.find((a) => a.pos > (marco.index ?? 0)) : undefined
    if (depois) return depois.doc
  }
  return achados[0].doc
}

/** A linha digitável no texto: sequências de dígitos com pontos, espaços e traços que fechem 47 ou 48 dígitos válidos. */
export function codigoDoTexto(texto: string, hoje?: Date): CodigoLido | null {
  const candidatos = texto.match(/\d[\d.\s-]{38,90}\d/g) ?? []
  for (const bruto of candidatos) {
    const d = bruto.replace(/\D/g, '')
    // Janela deslizante: o trecho pode ter números antes ou depois da linha.
    for (const tamanho of [48, 47]) {
      for (let i = 0; i + tamanho <= d.length; i++) {
        const lido = lerLinha(d.slice(i, i + tamanho), hoje)
        if (lido) return lido
      }
    }
  }
  return null
}

function tipoDoTexto(t: string, codigo: CodigoLido | null): TipoDeGuia | null {
  const simples = /documento de arrecadacao do simples nacional|\bdas\b/.test(t)
  const parcelamento = /parcelamento|\bparcsn\b|\bparcmei\b|\bpert\b|\brelp\b/.test(t)
  if (simples && /microempreendedor individual|das[\s-]*mei|\bpgmei\b/.test(t)) return parcelamento ? 'parcelamento' : 'das_mei'
  if (/documento de arrecadacao do simples nacional/.test(t)) return parcelamento ? 'parcelamento' : 'das'
  if (/documento de arrecadacao de receitas federais|\bdarf\b/.test(t)) {
    if (/dctf\s*web/.test(t)) return 'dctfweb'
    return parcelamento ? 'parcelamento' : 'darf'
  }
  if (/fgts digital|guia do fgts|\bgfd\b/.test(t)) return 'fgts'
  if (/honorario/.test(t)) return 'honorario'
  if (parcelamento) return 'parcelamento'
  if (/\biss\b|issqn|imposto sobre servicos/.test(t)) return 'iss'
  if (codigo) return 'outro'
  return null
}

/** Leitura por regra do texto do PDF (puro, sem rede). */
export function lerGuiaPorRegra(texto: string, opcoes: OpcoesDaLeitura = {}): LeituraGuia {
  const t = normalizar(texto)
  const origem: LeituraGuia['origem'] = {}
  const excluir = new Set((opcoes.excluir ?? []).map((d) => d.replace(/\D/g, '')))
  const codigo = codigoDoTexto(texto, opcoes.hoje)
  const boleto = codigo?.tipo === 'boleto'

  const campos: CamposGuia = {
    tipo: tipoDoTexto(t, codigo),
    documento: documentoDoTexto(t, excluir, boleto ? /\b(pagador|sacado)\b/ : null),
    competencia: competenciaDepoisDe(t, [/periodo de apuracao/, /competencia/, /mes de referencia/, /referente (?:a|ao)/]),
    vencimento: dataDepoisDe(t, [/pagar este documento ate/, /data de vencimento/, /vencimento/, /pagavel ate/]),
    valor_centavos: valorDepoisDe(t, [/valor total do documento/, /valor total/, /valor do documento/, /\(=\) valor cobrado/, /valor a pagar/, /valor/]),
    linha_digitavel: codigo?.linha ?? null,
  }
  for (const c of CAMPOS) if (campos[c] !== null) origem[c] = 'regra'

  // Conferência cruzada com o código de barras: o valor (arrecadação com identificador 6/8 e boleto) e, no boleto,
  // o vencimento do fator quando o texto não trouxe.
  const valorCodigo = codigo?.valorCentavos ?? null
  let divergente = false
  if (valorCodigo !== null) {
    if (campos.valor_centavos === null) {
      campos.valor_centavos = valorCodigo
      origem.valor_centavos = 'codigo_barras'
    } else if (campos.valor_centavos !== valorCodigo) divergente = true
  }
  if (codigo?.tipo === 'boleto' && campos.vencimento === null && codigo.vencimento) {
    campos.vencimento = codigo.vencimento
    origem.vencimento = 'codigo_barras'
  }
  return {
    campos,
    origem,
    faltando: faltando(campos),
    valor_divergente: divergente,
    valor_codigo_barras: valorCodigo,
    com_texto: t.replace(/\s/g, '').length >= 20,
    ia: false,
  }
}

/** Campos obrigatórios que ficaram vazios (competência não é cobrada de honorário e "outro"). */
export function faltando(c: CamposGuia): CampoDaGuia[] {
  return CAMPOS.filter((k) => c[k] === null && !(k === 'competencia' && (c.tipo === 'honorario' || c.tipo === 'outro')))
}

// ------------------------------------------------------------------ IA de reserva

/** O que a IA devolve, já validado: só campos que passaram nas mesmas regras (DV, data, documento). */
export interface LeitorGuiaIa {
  ler(pdf: Uint8Array): Promise<Partial<CamposGuia>>
}

export type LerGuiaDeps = {
  texto: (pdf: Uint8Array) => Promise<string>
  ia?: LeitorGuiaIa | null
}

/** Regra primeiro; a IA só entra se faltar campo (ou não houver texto) e só preenche o que faltou. */
export async function lerGuia(pdf: Uint8Array, deps: LerGuiaDeps, opcoes: OpcoesDaLeitura = {}): Promise<LeituraGuia> {
  const texto = await deps.texto(pdf).catch(() => '')
  const leitura = lerGuiaPorRegra(texto, opcoes)
  if (leitura.faltando.length === 0 && leitura.com_texto) return leitura
  if (!deps.ia) return { ...leitura, ia_erro: 'IA_INDISPONIVEL' }
  let daIa: Partial<CamposGuia>
  try {
    daIa = await deps.ia.ler(pdf)
  } catch (error) {
    return { ...leitura, ia_erro: error instanceof Error ? error.name : 'IA_FALHOU' }
  }
  const excluir = new Set((opcoes.excluir ?? []).map((d) => d.replace(/\D/g, '')))
  const campos = { ...leitura.campos }
  const origem = { ...leitura.origem }
  for (const c of CAMPOS) {
    const v = daIa[c]
    if (campos[c] !== null || v === null || v === undefined) continue
    if (c === 'documento' && excluir.has(String(v))) continue
    ;(campos as Record<string, unknown>)[c] = v
    origem[c] = 'ia'
  }
  // A linha que a IA leu também confere o valor.
  let divergente = leitura.valor_divergente
  let valorCodigo = leitura.valor_codigo_barras
  if (origem.linha_digitavel === 'ia' && campos.linha_digitavel) {
    valorCodigo = lerLinha(campos.linha_digitavel, opcoes.hoje)?.valorCentavos ?? null
    if (valorCodigo !== null && campos.valor_centavos !== null && campos.valor_centavos !== valorCodigo) divergente = true
  }
  return { ...leitura, campos, origem, faltando: faltando(campos), valor_divergente: divergente, valor_codigo_barras: valorCodigo, ia: true }
}
