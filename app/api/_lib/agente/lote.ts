// Lote por planilha da conta Escritório (.design/agente-fiscal-escritorio.md: Journey "Emitir o mês" e as decisões
// Lote, Ligação da linha com a nota, Planilha v1, Códigos de problema, Nota duplicada, Confirmação parcial,
// Expiração, Franquia e Arquivo recebido). Leitura determinística: a IA não toca no lote.
// A planilha chega pelo telefone da conta-mãe (a empresa do próprio escritório, dona do login, da assinatura e dos
// telefones); cada linha emite pela empresa do `cnpj_prestador`, que é a conta-mãe ou uma empresa com
// `escritorio_tenant_id` = conta-mãe. Do arquivo, só o SHA-256 e as linhas são gravados.
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { readSheet } from 'read-excel-file/universal'
import type { Db, Queryable } from '../db.js'
import { createOrGetInvoice } from '../invoices.js'
import { logEvent } from '../log.js'
import type { InvoicePayload } from '../validation.js'
import {
  DESCRICAO_PADRAO,
  ehConfirmar,
  ehConfirmarEmissao,
  ehDesistir,
  responder,
  semAcento,
  type Contexto,
  type MensagemRecebida,
} from './conversa.js'
import { cnpjValido, cpfValido, formatarReais } from './documentos.js'
import { normalizarEmail } from './normalizacao.js'
import { payloadDaNota } from './notas.js'
import { MODELO_DA_PLANILHA, planoDeEscritorio } from './planos.js'

export { MODELO_DA_PLANILHA }
import { dataBr, FUSO, limitesDoMes, partesLocais } from './tempo.js'
import { LIMITE_DA_MIDIA, MidiaGrandeDemais } from './whatsapp-cloud.js'

export const VALIDADE_DO_LOTE_MS = 24 * 3600_000
export const MAX_LINHAS = 1000
export const MAX_BYTES = LIMITE_DA_MIDIA
/** Linhas com problema mostradas no resumo; o resto vai como "e mais N". */
export const MAX_PROBLEMAS_NO_RESUMO = 15
/** Descompactado, o .xlsx não passa disto (defesa contra zip bomb antes de entregar o arquivo ao leitor). */
const MAX_XLSX_DESCOMPACTADO = 60 * 1024 * 1024

export const CAMPOS = ['cnpj_prestador', 'cpf_cnpj_tomador', 'nome_tomador', 'email_tomador', 'valor', 'descricao'] as const
export type Campo = (typeof CAMPOS)[number]

export const CODIGOS_DE_PROBLEMA = [
  'COLUNAS_A_MAIS',
  'PRESTADOR_DESCONHECIDO',
  'DOCUMENTO_INVALIDO',
  'DOCUMENTO_AMBIGUO',
  'NOME_FALTANDO',
  'VALOR_INVALIDO',
  'EMAIL_INVALIDO',
  'DESCRICAO_LONGA',
  'LINHA_REPETIDA',
  'JA_EMITIDA_NO_MES',
] as const

export const TEXTOS_DO_LOTE = {
  soEscritorio: 'O envio por planilha é do plano Escritório. No seu plano, me mande cada nota por mensagem, por exemplo: nota pra Studio Lima, 350 reais.',
  formatoNaoAceito: `Eu leio planilhas em .xlsx ou .csv (planilhas com macro, .xls antigo e .ods não). Salve como .xlsx ou .csv e mande de novo. Modelo: ${MODELO_DA_PLANILHA}`,
  ilegivel: `Não consegui ler essa planilha. Confira se é um .xlsx ou .csv (UTF-8) e mande de novo. Modelo: ${MODELO_DA_PLANILHA}`,
  grandeDemais: 'A planilha passou de 5 MB. Divida em duas e mande uma de cada vez.',
  abaGrandeDemais:
    'A primeira aba da planilha tem células usadas muito longe das notas (mais de 1.000 linhas ou de 50 colunas). Apague as linhas e colunas vazias abaixo e à direita das notas, ou salve só as notas em .csv, e mande de novo.',
  semDownload: 'Não consegui baixar a planilha agora. Mande de novo em alguns minutos.',
  vazia: `A planilha não tem linhas de nota abaixo do cabeçalho. Modelo: ${MODELO_DA_PLANILHA}`,
  linhasDemais: `A planilha passou de ${MAX_LINHAS.toLocaleString('pt-BR')} linhas. Divida em duas e mande uma de cada vez.`,
  expirou: 'Essa planilha expirou (24 horas sem *confirmar*) e nenhuma nota foi emitida. Mande a planilha de novo.',
  descartado: 'Ok, descartei a planilha. Nenhuma nota foi emitida.',
} as const

// ---------------------------------------------------------------------------------------
// Arquivo: tipo, leitura e grade de células.

export type TipoDePlanilha = 'xlsx' | 'csv'
export type Celula = string | number | boolean | Date | null

const MIMES_XLSX = new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
const MIMES_CSV = new Set(['text/csv', 'application/csv', 'text/comma-separated-values', 'text/x-csv'])
const MIMES_OUTRAS = new Set([
  'application/vnd.ms-excel',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  'application/vnd.oasis.opendocument.spreadsheet',
])

/** Pela extensão e, sem ela, pelo mime. `outra` = planilha num formato que não é lido (.xls, .xlsm, .ods…). */
export function tipoDaPlanilha(arquivo: MensagemRecebida['arquivo']): TipoDePlanilha | 'outra' | null {
  const nome = semAcento(arquivo?.nome ?? '')
  const mime = (arquivo?.mime ?? '').toLowerCase().split(';')[0].trim()
  const extensao = /\.([a-z0-9]{1,8})$/.exec(nome)?.[1]
  if (extensao === 'xlsx') return 'xlsx'
  if (extensao === 'csv') return 'csv'
  if (extensao && ['xls', 'xlsm', 'xlsb', 'xltx', 'xltm', 'ods', 'numbers'].includes(extensao)) return 'outra'
  if (MIMES_XLSX.has(mime)) return 'xlsx'
  if (MIMES_CSV.has(mime)) return 'csv'
  if (MIMES_OUTRAS.has(mime)) return 'outra'
  return null
}

export class PlanilhaIlegivel extends Error {
  constructor(motivo: string) {
    super(motivo)
    this.name = 'PlanilhaIlegivel'
  }
}

/** Cabeçalho, até 1.000 linhas de nota e uma folga para linhas vazias no topo. */
export const MAX_LINHAS_DA_ABA = MAX_LINHAS + 1 + 20
export const MAX_COLUNAS_DA_ABA = 50

/** A primeira aba vai além de `MAX_LINHAS_DA_ABA` linhas ou `MAX_COLUNAS_DA_ABA` colunas. */
export class PlanilhaGrandeDemais extends Error {
  constructor(readonly alcance: { linhas: number; colunas: number }) {
    super(`aba até a linha ${alcance.linhas}, coluna ${alcance.colunas}`)
    this.name = 'PlanilhaGrandeDemais'
  }
}

/** `A` → 1, `Z` → 26, `AA` → 27, `XFD` → 16384. */
const numeroDaColuna = (letras: string) => [...letras.toUpperCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0)

/**
 * Até onde vai a primeira aba (a do workbook.xml, pelo .rels): a maior linha e coluna entre `<dimension ref>`,
 * `<row r>` e `<c r>`. Só a aba é descompactada, com o fflate.
 */
export function alcanceDaPrimeiraAba(conteudo: Uint8Array): { linhas: number; colunas: number } {
  const ler = (nomes: string[]) => {
    try {
      return unzipSync(conteudo, { filter: (f) => nomes.includes(f.name) })
    } catch {
      throw new PlanilhaIlegivel('zip inválido')
    }
  }
  const texto = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : '')
  const base = ler(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'])
  const primeira = /<(?:\w+:)?sheet\b[^>]*>/.exec(texto(base['xl/workbook.xml']))?.[0] ?? ''
  const rid = /\b\w+:id="([^"]+)"/.exec(primeira)?.[1]
  let caminho = 'xl/worksheets/sheet1.xml'
  if (rid) {
    for (const rel of texto(base['xl/_rels/workbook.xml.rels']).match(/<(?:\w+:)?Relationship\b[^>]*>/g) ?? []) {
      if (/\bId="([^"]+)"/.exec(rel)?.[1] !== rid) continue
      const alvo = /\bTarget="([^"]+)"/.exec(rel)?.[1]
      if (alvo) caminho = alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo.replace(/^\.\//, '')}`
    }
  }
  const aba = texto(ler([caminho])[caminho])
  let linhas = 0
  let colunas = 0
  const ref = (r: string) => {
    const m = /^\$?([A-Za-z]{1,4})?\$?(\d+)?$/.exec(r)
    if (!m) return
    if (m[1]) colunas = Math.max(colunas, numeroDaColuna(m[1]))
    if (m[2]) linhas = Math.max(linhas, Number(m[2]))
  }
  const dimensao = /<(?:\w+:)?dimension\b[^>]*\bref="([^"]+)"/.exec(aba)?.[1]
  for (const parte of dimensao?.split(':') ?? []) ref(parte)
  for (const m of aba.matchAll(/<(?:\w+:)?(?:row|c)\b[^>]*?\br="([^"]+)"/g)) ref(m[1])
  return { linhas, colunas }
}

export async function lerPlanilha(conteudo: Uint8Array, tipo: TipoDePlanilha): Promise<Celula[][]> {
  if (conteudo.byteLength > MAX_BYTES) throw new MidiaGrandeDemais(MAX_BYTES)
  return tipo === 'xlsx' ? lerXlsx(conteudo) : lerCsv(conteudo)
}

/** Só a primeira aba, com o valor guardado das fórmulas (nada é calculado) e sem macros (nada é executado). */
async function lerXlsx(conteudo: Uint8Array): Promise<Celula[][]> {
  if (!(conteudo[0] === 0x50 && conteudo[1] === 0x4b && conteudo[2] === 0x03 && conteudo[3] === 0x04)) {
    throw new PlanilhaIlegivel('não é um .xlsx (zip)')
  }
  // O diretório do zip diz o tamanho de cada parte; nada é descompactado aqui.
  let total = 0
  try {
    unzipSync(conteudo, {
      filter(arquivo) {
        total += arquivo.originalSize
        if (total > MAX_XLSX_DESCOMPACTADO) throw new PlanilhaIlegivel('xlsx grande demais descompactado')
        return false
      },
    })
  } catch (error) {
    if (error instanceof PlanilhaIlegivel) throw error
    throw new PlanilhaIlegivel('zip inválido')
  }
  // O leitor monta a grade inteira até a última célula usada: uma célula em XFD1048576 num arquivo de 2 KB estoura a
  // memória. Antes dele, o XML da primeira aba diz até onde a planilha vai.
  const alcance = alcanceDaPrimeiraAba(conteudo)
  if (alcance.linhas > MAX_LINHAS_DA_ABA || alcance.colunas > MAX_COLUNAS_DA_ABA) throw new PlanilhaGrandeDemais(alcance)
  try {
    const buffer = conteudo.buffer.slice(conteudo.byteOffset, conteudo.byteOffset + conteudo.byteLength) as ArrayBuffer
    const linhas = await readSheet(buffer, 1)
    return linhas.map((linha) => linha.map((celula) => celula as unknown as Celula))
  } catch (error) {
    logEvent('agente.planilha_ilegivel', { tipo: 'xlsx', error_name: error instanceof Error ? error.name : 'unknown' })
    throw new PlanilhaIlegivel('xlsx ilegível')
  }
}

/** UTF-8 com ou sem BOM; o que não é UTF-8 válido é lido como Windows-1252 (o "CSV" do Excel em português). */
export function decodificarTexto(conteudo: Uint8Array): string {
  let texto: string
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(conteudo)
  } catch {
    texto = new TextDecoder('windows-1252').decode(conteudo)
  }
  return texto.replace(/^\uFEFF/, '')
}

/** `;` ou `,`, pelo que mais aparece fora de aspas na primeira linha (empate fica com `;`, o do Excel em português). */
export function separadorDoCsv(texto: string): ';' | ',' {
  let pontoEVirgula = 0
  let virgula = 0
  let aspas = false
  for (const c of texto) {
    if (c === '"') aspas = !aspas
    else if (!aspas && (c === '\n' || c === '\r')) break
    else if (!aspas && c === ';') pontoEVirgula++
    else if (!aspas && c === ',') virgula++
  }
  return virgula > pontoEVirgula ? ',' : ';'
}

/** RFC 4180: aspas, `""` dentro de aspas, quebra de linha dentro de aspas, CRLF ou LF. */
export function lerCsvTexto(texto: string): string[][] {
  const separador = separadorDoCsv(texto)
  const linhas: string[][] = []
  let linha: string[] = []
  let campo = ''
  let aspas = false
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"'
          i++
        } else aspas = false
      } else campo += c
      continue
    }
    if (c === '"' && campo === '') aspas = true
    else if (c === separador) {
      linha.push(campo)
      campo = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++
      linha.push(campo)
      linhas.push(linha)
      linha = []
      campo = ''
    } else campo += c
  }
  if (campo !== '' || linha.length) {
    linha.push(campo)
    linhas.push(linha)
  }
  return linhas
}

function lerCsv(conteudo: Uint8Array): Celula[][] {
  return lerCsvTexto(decodificarTexto(conteudo))
}

// ---------------------------------------------------------------------------------------
// Cabeçalho e linhas.

/** Sem diferença de caixa, acento, espaço, `_` ou `-`: "CPF/CNPJ Tomador" = `cpf_cnpj_tomador`. */
// Sem o `semAcento` da conversa: este mapa é montado no carregamento do módulo, e conversa.ts importa este arquivo.
export const normalizarCabecalho = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
const CAMPO_DO_CABECALHO = new Map<string, Campo>(CAMPOS.map((campo) => [normalizarCabecalho(campo), campo]))

export const textoDaCelula = (celula: Celula | undefined): string => {
  if (celula === null || celula === undefined) return ''
  if (celula instanceof Date) return Number.isNaN(celula.getTime()) ? '' : dataBr(celula)
  if (typeof celula === 'number') return Number.isFinite(celula) ? String(celula) : ''
  return String(celula).replace(/\s+/g, ' ').trim()
}

/** `colunasAMais`: a linha tem mais colunas que o cabeçalho (no CSV com vírgula, quase sempre um "1234,56" sem aspas). */
export type LinhaLida = { linha: number; celulas: Partial<Record<Campo, Celula>>; colunasAMais?: boolean }

export type Planilha =
  | { ok: true; colunas: Campo[]; linhas: LinhaLida[] }
  | { ok: false; erro: 'COLUNAS'; desconhecidas: string[]; faltando: Campo[]; repetidas: string[] }
  | { ok: false; erro: 'VAZIA' | 'LINHAS_DEMAIS' }

/**
 * Primeira linha não vazia = cabeçalho. O número da linha é o da planilha (o que a pessoa vê no Excel).
 * `prestadorObrigatorio` = a conta tem mais de uma empresa ativa (Planilha v1: `cnpj_prestador` é opcional com uma só).
 * Linha com célula preenchida além do cabeçalho fica com `colunasAMais`. Com `contarCampos` (CSV separado por vírgula),
 * basta ter mais campos que o cabeçalho, mesmo vazios: "1234,56" sem aspas empurra as colunas seguintes.
 */
export function interpretarGrade(grade: Celula[][], opcoes: { prestadorObrigatorio: boolean; contarCampos?: boolean }): Planilha {
  const vazia = (linha: Celula[]) => linha.every((c) => textoDaCelula(c) === '')
  const inicio = grade.findIndex((linha) => !vazia(linha))
  if (inicio < 0) return { ok: false, erro: 'VAZIA' }
  const cabecalho = grade[inicio]
  const corpo = grade.slice(inicio + 1).map((celulas, i) => ({ celulas, linha: inicio + 2 + i })).filter((l) => !vazia(l.celulas))

  const indice = new Map<Campo, number>()
  const desconhecidas: string[] = []
  const repetidas: string[] = []
  cabecalho.forEach((celula, i) => {
    const titulo = textoDaCelula(celula)
    if (!titulo) {
      // Coluna sem título só incomoda se tiver dado.
      if (corpo.some((l) => textoDaCelula(l.celulas[i]) !== '')) desconhecidas.push(`(coluna ${i + 1} sem título)`)
      return
    }
    const campo = CAMPO_DO_CABECALHO.get(normalizarCabecalho(titulo))
    if (!campo) desconhecidas.push(titulo)
    else if (indice.has(campo)) repetidas.push(titulo)
    else indice.set(campo, i)
  })
  const obrigatorios: Campo[] = ['cpf_cnpj_tomador', 'nome_tomador', 'valor', ...(opcoes.prestadorObrigatorio ? (['cnpj_prestador'] as Campo[]) : [])]
  const faltando = obrigatorios.filter((campo) => !indice.has(campo))
  if (desconhecidas.length || faltando.length || repetidas.length) return { ok: false, erro: 'COLUNAS', desconhecidas, faltando, repetidas }
  if (!corpo.length) return { ok: false, erro: 'VAZIA' }
  if (corpo.length > MAX_LINHAS) return { ok: false, erro: 'LINHAS_DEMAIS' }

  return {
    ok: true,
    colunas: CAMPOS.filter((campo) => indice.has(campo)),
    linhas: corpo.map(({ celulas, linha }) => {
      const colunasAMais = opcoes.contarCampos ? celulas.length > cabecalho.length : celulas.slice(cabecalho.length).some((c) => textoDaCelula(c) !== '')
      return {
        linha,
        celulas: Object.fromEntries([...indice].map(([campo, i]) => [campo, celulas[i] ?? null])) as Partial<Record<Campo, Celula>>,
        ...(colunasAMais ? { colunasAMais } : {}),
      }
    }),
  }
}

export function textoDasColunas(p: { desconhecidas: string[]; faltando: Campo[]; repetidas: string[] }): string {
  return [
    'Não reconheci as colunas da planilha, e nada foi gravado.',
    p.desconhecidas.length ? `Colunas que eu não conheço: ${p.desconhecidas.join(', ')}.` : null,
    p.faltando.length ? `Faltam as colunas: ${p.faltando.join(', ')}.` : null,
    p.repetidas.length ? `Colunas repetidas: ${p.repetidas.join(', ')}.` : null,
    'A primeira linha precisa ter estes nomes: cnpj_prestador (pode faltar se a conta tem uma só empresa ativa), cpf_cnpj_tomador, nome_tomador, email_tomador (opcional), valor e descricao (opcional).',
    `Modelo para baixar: ${MODELO_DA_PLANILHA}`,
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------------------------------
// Valores de uma célula.

/**
 * CPF ou CNPJ com dígito verificador. Número que pode ter perdido os zeros à esquerda (célula numérica do Excel, ou
 * só dígitos e menos de 11 no CSV) é testado como CPF (11) e como CNPJ (14): vale o que bater; se os dois baterem,
 * `DOCUMENTO_AMBIGUO`, e a pessoa formata a coluna como texto.
 */
export function lerDocumentoDaCelula(celula: Celula | undefined): { documento: string } | { erro: 'DOCUMENTO_INVALIDO' | 'DOCUMENTO_AMBIGUO' } {
  const invalido = { erro: 'DOCUMENTO_INVALIDO' as const }
  const numerico = typeof celula === 'number'
  const texto = numerico ? (Number.isInteger(celula) && celula > 0 ? String(celula) : '') : textoDaCelula(celula)
  if (!texto || !/^[\d.\-/\s]+$/.test(texto)) return invalido
  const digitos = texto.replace(/\D/g, '')
  const semZeros = numerico || (/^\d+$/.test(texto) && digitos.length < 11)
  const candidatos = semZeros
    ? [
        ...(digitos.length <= 11 ? [digitos.padStart(11, '0')] : []),
        ...(digitos.length <= 14 ? [digitos.padStart(14, '0')] : []),
      ]
    : [/^\d+$/.test(texto) && digitos.length > 11 && digitos.length < 14 ? digitos.padStart(14, '0') : digitos]
  const validos = candidatos.filter((d) => (d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false))
  if (validos.length > 1) return { erro: 'DOCUMENTO_AMBIGUO' }
  return validos.length ? { documento: validos[0] } : invalido
}

export function lerDocumento(celula: Celula | undefined): string | null {
  const lido = lerDocumentoDaCelula(celula)
  return 'documento' in lido ? lido.documento : null
}

const valorNormalizado = (inteiro: string, centavos: string) => {
  if (!/^\d{1,12}$/.test(inteiro) || !/^\d{0,2}$/.test(centavos)) return null
  const valor = `${BigInt(inteiro)}.${centavos.padEnd(2, '0')}`
  return valor === '0.00' ? null : valor
}

/**
 * Valor positivo com até 2 casas, no formato do motor (`1234.50`). Aceita número, "1.234,56", "1234,56", "1234.56",
 * "R$ 1.234,56" e "1.234.567". "150.000" (um ponto e 3 casas, sem vírgula) é ambíguo e só vale como milhar com
 * `pontoEhMilhar`, quando outra linha da mesma coluna usa vírgula decimal.
 */
export function lerValor(celula: Celula | undefined, opcoes: { pontoEhMilhar?: boolean } = {}): string | null {
  if (typeof celula === 'number') {
    if (!Number.isFinite(celula) || celula <= 0) return null
    const centavos = Math.round(celula * 100)
    // Número com mais de 2 casas de verdade (não só ruído de ponto flutuante) não vira nota arredondada.
    if (Math.abs(celula * 100 - centavos) > 1e-6) return null
    return valorNormalizado(String(Math.floor(centavos / 100)), String(centavos % 100).padStart(2, '0'))
  }
  if (typeof celula !== 'string') return null
  const texto = celula.replace(/^\s*R\$\s*/i, '').replace(/[\s\u00A0]/g, '')
  if (!/^\d[\d.,]*$/.test(texto)) return null
  const ultimoPonto = texto.lastIndexOf('.')
  const ultimaVirgula = texto.lastIndexOf(',')
  if (ultimoPonto >= 0 && ultimaVirgula >= 0) {
    const decimal = ultimoPonto > ultimaVirgula ? '.' : ','
    const milhar = decimal === '.' ? ',' : '.'
    const [inteiro, centavos, ...resto] = texto.split(decimal)
    if (resto.length || !new RegExp(`^\\d{1,3}(\\${milhar}\\d{3})*$`).test(inteiro)) return null
    return valorNormalizado(inteiro.split(milhar).join(''), centavos)
  }
  if (ultimaVirgula >= 0) {
    const [inteiro, centavos, ...resto] = texto.split(',')
    return resto.length ? null : valorNormalizado(inteiro, centavos)
  }
  if (ultimoPonto >= 0) {
    if (/^\d{1,3}\.\d{3}$/.test(texto)) return opcoes.pontoEhMilhar ? valorNormalizado(texto.replace('.', ''), '') : null
    if (/^\d{1,3}(\.\d{3}){2,}$/.test(texto)) return valorNormalizado(texto.split('.').join(''), '')
    const [inteiro, centavos, ...resto] = texto.split('.')
    return resto.length ? null : valorNormalizado(inteiro, centavos)
  }
  return valorNormalizado(texto, '')
}

export const centavosDe = (valor: string): bigint => {
  const [inteiro, centavos = '0'] = valor.split('.')
  return BigInt(inteiro) * 100n + BigInt(centavos.padEnd(2, '0').slice(0, 2))
}
export const reaisDeCentavos = (centavos: bigint) => `${centavos / 100n}.${String(centavos % 100n).padStart(2, '0')}`

// ---------------------------------------------------------------------------------------
// Validação por linha (pura: o que vem do banco chega pronto em `ContextoDoLote`).

export type Empresa = {
  id: string
  cnpj: string
  razao_social: string
  active: boolean
  codigo_servico_nacional: string | null
}

export type ModeloDoTomador = { codigo: string; descricao: string; email: string | null }

export type ContextoDoLote = {
  empresas: Empresa[]
  /** `nofiscal.emission_block` de cada empresa (null = emite). */
  bloqueios: Map<string, string | null>
  /** Modelo do tomador por `${tenantId}:${documento}`. */
  modelos: Map<string, ModeloDoTomador>
  /** Notas do mês por `${tenantId}:${documento}:${centavos}`. */
  jaEmitidas: Set<string>
}

export type ItemDoLote = {
  linha: number
  tenantId: string | null
  /** Linha pronta (ou barrada só pelo bloqueio, repetição ou duplicata): o payload da nota. Senão `{ lido }`. */
  payload: Record<string, unknown>
  problema: string | null
  /** LINHA_REPETIDA: a primeira linha igual. */
  igualA?: number
  valor?: string
}

const lido = (celulas: LinhaLida['celulas']) =>
  Object.fromEntries(Object.entries(celulas).map(([campo, c]) => [campo, textoDaCelula(c as Celula).slice(0, 300)]))

export function validarLinhas(linhas: LinhaLida[], ctx: ContextoDoLote): ItemDoLote[] {
  const porCnpj = new Map(ctx.empresas.map((e) => [e.cnpj, e]))
  const ativas = ctx.empresas.filter((e) => e.active)
  const primeiraLinha = new Map<string, number>()
  // "150.000" só é milhar se a coluna usa vírgula decimal em alguma linha ("1.234,56", "99,90").
  const pontoEhMilhar = linhas.some((l) => typeof l.celulas.valor === 'string' && /,\d{1,2}\s*$/.test(l.celulas.valor))

  return linhas.map(({ linha, celulas, colunasAMais }): ItemDoLote => {
    const falha = (problema: string, tenantId: string | null = null): ItemDoLote => ({ linha, tenantId, payload: { lido: lido(celulas) }, problema })
    if (colunasAMais) return falha('COLUNAS_A_MAIS')

    const cnpjPrestador = textoDaCelula(celulas.cnpj_prestador).replace(/\D/g, '')
    const empresa = cnpjPrestador ? porCnpj.get(cnpjPrestador.padStart(14, '0')) : ativas.length === 1 ? ativas[0] : undefined
    if (!empresa) return falha('PRESTADOR_DESCONHECIDO')

    const lidoDocumento = lerDocumentoDaCelula(celulas.cpf_cnpj_tomador)
    if ('erro' in lidoDocumento) return falha(lidoDocumento.erro, empresa.id)
    const { documento } = lidoDocumento
    const nome = textoDaCelula(celulas.nome_tomador).slice(0, 150).trim()
    if (!nome) return falha('NOME_FALTANDO', empresa.id)
    const valor = lerValor(celulas.valor ?? null, { pontoEhMilhar })
    if (!valor) return falha('VALOR_INVALIDO', empresa.id)
    const emailEscrito = textoDaCelula(celulas.email_tomador)
    const email = emailEscrito ? normalizarEmail(emailEscrito) : null
    if (emailEscrito && !email) return falha('EMAIL_INVALIDO', empresa.id)
    const descricaoEscrita = textoDaCelula(celulas.descricao)
    if (descricaoEscrita.length > 2000) return falha('DESCRICAO_LONGA', empresa.id)

    // Como no pedido avulso (conversa.ts): com modelo do tomador, código e descrição do modelo; sem modelo, o
    // código da empresa e a descrição padrão. A descrição escrita na planilha vale para esta nota.
    const modelo = ctx.modelos.get(`${empresa.id}:${documento}`)
    const servico = {
      codigo: modelo?.codigo ?? empresa.codigo_servico_nacional ?? '',
      descricao: descricaoEscrita || modelo?.descricao || DESCRICAO_PADRAO,
    }
    const payload = payloadDaNota({ documento, nome, email: email ?? modelo?.email ?? null }, servico, valor)
    const pronta = (problema: string | null, igualA?: number): ItemDoLote => ({
      linha,
      tenantId: empresa.id,
      payload,
      problema,
      valor,
      ...(igualA ? { igualA } : {}),
    })

    const chave = `${empresa.id}:${documento}:${centavosDe(valor)}`
    const anterior = primeiraLinha.get(chave)
    if (anterior === undefined) primeiraLinha.set(chave, linha)

    const bloqueio = ctx.bloqueios.get(empresa.id)
    if (bloqueio) return pronta(bloqueio)
    if (anterior !== undefined) return pronta('LINHA_REPETIDA', anterior)
    if (ctx.jaEmitidas.has(chave)) return pronta('JA_EMITIDA_NO_MES')
    return pronta(null)
  })
}

/** O motivo que a pessoa lê, por código (o do `emission_block` nomeia a empresa). */
export function motivoDoProblema(codigo: string, d: { empresa?: string | null; igualA?: number | null; semPrestador?: boolean } = {}): string {
  const empresa = d.empresa ?? 'a empresa'
  switch (codigo) {
    case 'PRESTADOR_DESCONHECIDO':
      return d.semPrestador
        ? 'falta o CNPJ do prestador (a conta tem mais de uma empresa ativa)'
        : 'o CNPJ do prestador não é de nenhuma empresa da sua conta'
    case 'COLUNAS_A_MAIS':
      return 'a linha tem mais colunas que o cabeçalho: confira se o valor usa vírgula sem aspas'
    case 'DOCUMENTO_INVALIDO':
      return 'CPF ou CNPJ do tomador inválido'
    case 'DOCUMENTO_AMBIGUO':
      return 'o CPF/CNPJ do tomador perdeu os zeros à esquerda e pode ser os dois: formate a coluna como texto'
    case 'NOME_FALTANDO':
      return 'falta o nome do tomador'
    case 'VALOR_INVALIDO':
      return 'valor inválido ou ambíguo (escreva, por exemplo, 1.234,56)'
    case 'EMAIL_INVALIDO':
      return 'e-mail do tomador inválido'
    case 'DESCRICAO_LONGA':
      return 'descrição com mais de 2.000 caracteres'
    case 'LINHA_REPETIDA':
      return d.igualA ? `igual à linha ${d.igualA} (mesmo prestador, tomador e valor)` : 'linha repetida (mesmo prestador, tomador e valor)'
    case 'JA_EMITIDA_NO_MES':
      return 'já há nota igual neste mês (mesmo prestador, tomador e valor)'
    case 'CERT_MISSING':
      return `${empresa} ainda não tem certificado A1`
    case 'CERT_EXPIRED':
      return `o certificado A1 de ${empresa} venceu`
    case 'PROCURACAO_NAO_ENCONTRADA':
      return `a Receita ainda não mostra a procuração de ${empresa}`
    case 'PROCURACAO_MISSING':
    case 'PROCURACAO_INVALIDA':
      return `a procuração de ${empresa} não está valendo`
    case 'PROCURACAO_VENCIDA':
      return `a procuração de ${empresa} venceu`
    case 'PROCURADOR_CERT_INVALIDO':
      return `o certificado A1 do escritório, que assina por procuração, não está valendo`
    case 'FISCAL_CONFIG_MISSING':
      return `faltam os dados fiscais de ${empresa} (código de serviço e percentual do Simples)`
    case 'TENANT_INACTIVE':
      return `${empresa} está desativada`
    case 'NO_SUBSCRIPTION':
    case 'SUBSCRIPTION_CANCELLED':
    case 'PAYMENT_NOT_APPROVED':
      return 'a assinatura da conta não está ativa'
    default:
      return `emissão bloqueada para ${empresa} (${codigo})`
  }
}

// ---------------------------------------------------------------------------------------
// Resumo (texto fixo, sem IA).

export type Franquia = { limite: number; noMes: number }

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`

export function textoDoResumoDoLote(dados: {
  arquivo: string | null
  itens: ItemDoLote[]
  empresas: Empresa[]
  franquia: Franquia | null
}): string {
  const nomeDe = new Map(dados.empresas.map((e) => [e.id, e.razao_social]))
  const prontas = dados.itens.filter((i) => !i.problema)
  const comProblema = dados.itens.filter((i) => i.problema)
  const total = prontas.reduce((soma, i) => soma + centavosDe(i.valor as string), 0n)
  const porEmpresa = new Map<string, number>()
  for (const i of prontas) porEmpresa.set(i.tenantId as string, (porEmpresa.get(i.tenantId as string) ?? 0) + 1)

  const linhas: string[] = [
    `Li a planilha${dados.arquivo ? ` ${dados.arquivo}` : ''}: ${plural(dados.itens.length, 'linha', 'linhas')}.`,
    prontas.length
      ? `Prontas para emitir: ${prontas.length.toLocaleString('pt-BR')}, total ${formatarReais(reaisDeCentavos(total))}.`
      : 'Nenhuma linha está pronta para emitir.',
  ]
  if (porEmpresa.size) {
    linhas.push(`Empresas: ${[...porEmpresa].map(([id, n]) => `${nomeDe.get(id) ?? id} (${plural(n, 'nota', 'notas')})`).join(', ')}.`)
  }
  if (comProblema.length) {
    linhas.push(`Com problema (ficam de fora): ${plural(comProblema.length, 'linha', 'linhas')}.`)
    for (const item of comProblema.slice(0, MAX_PROBLEMAS_NO_RESUMO)) {
      const semPrestador = !String((item.payload.lido as Record<string, string> | undefined)?.cnpj_prestador ?? '').trim()
      linhas.push(
        `- Linha ${item.linha}: ${motivoDoProblema(item.problema as string, { empresa: item.tenantId ? nomeDe.get(item.tenantId) : null, igualA: item.igualA, semPrestador })}`,
      )
    }
    if (comProblema.length > MAX_PROBLEMAS_NO_RESUMO) {
      linhas.push(`- e mais ${plural(comProblema.length - MAX_PROBLEMAS_NO_RESUMO, 'linha', 'linhas')} com problema.`)
    }
  }
  if (dados.franquia && prontas.length && dados.franquia.noMes + prontas.length > dados.franquia.limite) {
    const fica = dados.franquia.noMes + prontas.length
    linhas.push(
      `Franquia: com estas notas, o mês chega a ${fica.toLocaleString('pt-BR')} notas, ${(fica - dados.franquia.limite).toLocaleString('pt-BR')} acima das ${dados.franquia.limite.toLocaleString('pt-BR')} do seu plano. As notas saem normalmente.`,
    )
  }
  if (prontas.length) {
    linhas.push(
      `Responda *confirmar* para emitir ${prontas.length === 1 ? 'a nota pronta' : `as ${prontas.length.toLocaleString('pt-BR')} notas prontas`}, ou *cancelar* para descartar. Vale por 24 horas.`,
    )
  } else {
    linhas.push('Corrija a planilha e mande de novo.')
  }
  return linhas.join('\n')
}

// ---------------------------------------------------------------------------------------
// Banco.

const sha256 = (conteudo: Uint8Array) => createHash('sha256').update(conteudo).digest('hex')

const quando = (instante: Date) =>
  `${dataBr(instante)} às ${new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instante)}`

type Dono = { id: string; plan: string; limite: number }

/** A conta-mãe do tenant do telefone (ela própria, fora de escritório). */
async function donoDoTenant(db: Queryable, tenantId: string): Promise<Dono | null> {
  const { rows } = await db.query<Dono>(
    `select d.id, d.plan, d.monthly_note_limit as limite
       from nofiscal.fiscal_tenants t
       join nofiscal.fiscal_tenants d on d.id = coalesce(t.escritorio_tenant_id, t.id)
      where t.id = $1`,
    [tenantId],
  )
  return rows[0] ?? null
}

async function empresasDoDono(db: Queryable, donoId: string): Promise<Empresa[]> {
  const { rows } = await db.query<Empresa>(
    `select t.id, t.cnpj, t.razao_social, t.active, t.codigo_servico_nacional
       from nofiscal.fiscal_tenants t
      where t.id = $1 or t.escritorio_tenant_id = $1
      order by t.id = $1 desc, t.razao_social`,
    [donoId],
  )
  return rows
}

const valorDoPayload = (valor: unknown): bigint | null => {
  const v = typeof valor === 'string' ? lerValor(valor) : null
  return v ? centavosDe(v) : null
}

/** Bloqueios, modelos e as notas do mês (Brasília) das empresas que aparecem na planilha. */
async function contextoDoBanco(db: Queryable, empresas: Empresa[], agora: Date): Promise<ContextoDoLote> {
  const ids = empresas.map((e) => e.id)
  const bloqueios = new Map<string, string | null>()
  for (const id of ids) {
    const { rows } = await db.query<{ bloqueio: string | null }>('select nofiscal.emission_block($1) as bloqueio', [id])
    bloqueios.set(id, rows[0]?.bloqueio ?? null)
  }

  const modelos = new Map<string, ModeloDoTomador>()
  const { rows: linhasDeModelo } = await db.query<{ tenant_id: string; documento: string; codigo: string; descricao: string; email: string | null }>(
    `select tenant_id, tomador_documento as documento, codigo_servico_nacional as codigo, descricao, tomador_email as email
       from nofiscal.fiscal_models where tenant_id = any($1::uuid[])
      order by updated_at desc`,
    [ids],
  )
  for (const m of linhasDeModelo) {
    const chave = `${m.tenant_id}:${m.documento}`
    if (!modelos.has(chave)) modelos.set(chave, { codigo: m.codigo, descricao: m.descricao, email: m.email })
  }

  return { empresas, bloqueios, modelos, jaEmitidas: await notasIguaisDoMes(db, ids, agora) }
}

/**
 * Nota duplicada: as chaves `${tenant}:${documento}:${centavos}` das notas emitidas no mês de Brasília e das que
 * ainda estão na fila (um lote anterior que não fechou conta também). Usada no resumo e de novo no "confirmar".
 */
async function notasIguaisDoMes(db: Queryable, tenantIds: string[], agora: Date): Promise<Set<string>> {
  const local = partesLocais(agora)
  const { inicio, fim } = limitesDoMes(local.ano, local.mes)
  const { rows: notas } = await db.query<{ tenant_id: string; documento: string | null; valor: unknown }>(
    `select i.tenant_id, coalesce(i.payload->'tomador'->>'cpf', i.payload->'tomador'->>'cnpj') as documento, i.payload->>'valor' as valor
       from nofiscal.fiscal_invoices i
      where i.tenant_id = any($1::uuid[])
        and ((i.status = 'issued' and i.issued_at >= $2 and i.issued_at < $3)
             or (i.status in ('queued', 'signing', 'sent') and i.created_at >= $2))`,
    [tenantIds, inicio, fim],
  )
  const chaves = new Set<string>()
  for (const n of notas) {
    const centavos = valorDoPayload(n.valor)
    if (n.documento && centavos !== null) chaves.add(`${n.tenant_id}:${n.documento}:${centavos}`)
  }
  return chaves
}

/** A chave de nota duplicada de um payload do motor. */
function chaveDoPayload(tenantId: string, payload: unknown): string | null {
  const p = (payload ?? {}) as { tomador?: { cpf?: string; cnpj?: string }; valor?: unknown }
  const documento = p.tomador?.cpf ?? p.tomador?.cnpj
  const centavos = valorDoPayload(p.valor)
  return documento && centavos !== null ? `${tenantId}:${documento}:${centavos}` : null
}

/** Notas do mês de todas as empresas da conta-mãe, para a franquia (emitidas no mês e as que estão na fila). */
async function notasDoMes(db: Queryable, donoId: string, agora: Date): Promise<number> {
  const local = partesLocais(agora)
  const { inicio, fim } = limitesDoMes(local.ano, local.mes)
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from nofiscal.fiscal_invoices i
      where i.tenant_id in (select nofiscal.empresas_do_dono($1))
        and ((i.issued_at >= $2 and i.issued_at < $3) or i.status in ('queued', 'signing', 'sent'))`,
    [donoId, inicio, fim],
  )
  return Number(rows[0]?.n ?? 0)
}

/** Tarefa agendada (worker) e checagem na chegada e no "confirmar": lote sem confirmação em 24 h expira. */
export async function expirarLotes(db: Queryable, agora: Date, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const { rowCount } = await db.query(
    `update nofiscal.fiscal_lotes
        set status = 'expirado', updated_at = $1
      where status = 'aguardando_confirmacao' and expires_at <= $1
        and ($2::uuid[] is null or escritorio_tenant_id = any($2::uuid[]))`,
    [agora, opcoes.tenantIds ?? null],
  )
  return rowCount
}

/**
 * A mesma planilha (hash) só é recusada enquanto um lote dela espera o "confirmar". Depois de confirmada, ela pode
 * voltar: as linhas que já viraram nota ficam de fora por `JA_EMITIDA_NO_MES`.
 */
async function loteComOMesmoArquivo(db: Queryable, donoId: string, hash: string) {
  const { rows } = await db.query<{ id: string; status: string; created_at: Date }>(
    `select id, status, created_at from nofiscal.fiscal_lotes
      where escritorio_tenant_id = $1 and arquivo_sha256 = $2 and status = 'aguardando_confirmacao'
      order by created_at desc limit 1`,
    [donoId, hash],
  )
  return rows[0] ?? null
}

const textoDoArquivoRepetido = (lote: { created_at: Date }) =>
  `Essa planilha já foi enviada em ${quando(lote.created_at)} e está esperando o *confirmar*. Para eu ler de novo, responda *cancelar* e mande a planilha outra vez.`

const ehViolacaoDeUnicidade = (error: unknown) => (error as { code?: string } | null)?.code === '23505'

async function gravarLote(
  db: Db,
  dados: { donoId: string; phoneId: string; arquivo: string | null; hash: string; agora: Date; itens: ItemDoLote[] },
): Promise<string> {
  // Sem linha pronta, o lote nasce descartado: fica o registro, e a mesma planilha (com a empresa já acertada no
  // painel) pode voltar.
  const status = dados.itens.some((i) => !i.problema) ? 'aguardando_confirmacao' : 'descartado'
  return db.transaction((tx) => gravarLoteNa(tx, dados, status))
}

async function gravarLoteNa(
  db: Queryable,
  dados: { donoId: string; phoneId: string; arquivo: string | null; hash: string; agora: Date; itens: ItemDoLote[] },
  status: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into nofiscal.fiscal_lotes
       (escritorio_tenant_id, phone_id, origem, arquivo_nome, arquivo_sha256, status, expires_at, created_at, updated_at)
     values ($1, $2, 'planilha', $3, $4, $5, $6, clock_timestamp(), $7)
     returning id`,
    [dados.donoId, dados.phoneId, dados.arquivo, dados.hash, status, new Date(dados.agora.getTime() + VALIDADE_DO_LOTE_MS), dados.agora],
  )
  const loteId = rows[0].id
  await db.query(
    `insert into nofiscal.fiscal_lote_itens (lote_id, linha, tenant_id, payload, problema)
     select $1, x.linha, x.tenant_id, x.payload, x.problema
       from unnest($2::integer[], $3::uuid[], $4::jsonb[], $5::text[]) as x(linha, tenant_id, payload, problema)`,
    [
      loteId,
      dados.itens.map((i) => i.linha),
      dados.itens.map((i) => i.tenantId),
      dados.itens.map((i) => JSON.stringify(i.payload)),
      dados.itens.map((i) => i.problema),
    ],
  )
  return loteId
}

const nomeDoArquivo = (nome: string | null | undefined) => {
  // Sem caracteres de controle (o nome vem do remetente).
  const limpo = [...(nome ?? '')].filter((c) => c >= ' ').join('').trim()
  return limpo ? limpo.slice(0, 200) : null
}

/**
 * Documento .xlsx/.csv de um telefone que emite. Conta de plano Escritório: baixa, lê, valida, grava o lote
 * (`aguardando_confirmacao`, 24 h) e responde o resumo. Outros planos: a resposta curta do plano.
 */
export async function receberPlanilha(ctx: Contexto, arquivo: MensagemRecebida['arquivo']): Promise<void> {
  const { db } = ctx.deps
  const dono = await donoDoTenant(db, ctx.tenantId)
  if (!dono || !planoDeEscritorio(dono.plan)) {
    await responder(ctx, TEXTOS_DO_LOTE.soEscritorio)
    return
  }
  const tipo = tipoDaPlanilha(arquivo)
  if (tipo !== 'xlsx' && tipo !== 'csv') {
    await responder(ctx, TEXTOS_DO_LOTE.formatoNaoAceito)
    return
  }
  if (!ctx.deps.midia || !arquivo?.midiaId) {
    logEvent('agente.planilha_sem_download', { tenant_id: dono.id, configurado: Boolean(ctx.deps.midia) })
    await responder(ctx, TEXTOS_DO_LOTE.semDownload)
    return
  }

  let conteudo: Uint8Array
  try {
    conteudo = (await ctx.deps.midia.baixarMidia(arquivo.midiaId, MAX_BYTES)).conteudo
  } catch (error) {
    if (error instanceof MidiaGrandeDemais) {
      await responder(ctx, TEXTOS_DO_LOTE.grandeDemais)
      return
    }
    logEvent('agente.planilha_download_falhou', { tenant_id: dono.id, error_name: error instanceof Error ? error.name : 'unknown' })
    await responder(ctx, TEXTOS_DO_LOTE.semDownload)
    return
  }

  await expirarLotes(db, ctx.agora, { tenantIds: [dono.id] })
  const hash = sha256(conteudo)
  const repetido = await loteComOMesmoArquivo(db, dono.id, hash)
  if (repetido) {
    await responder(ctx, textoDoArquivoRepetido(repetido))
    return
  }

  let grade: Celula[][]
  try {
    grade = await lerPlanilha(conteudo, tipo)
  } catch (error) {
    await responder(
      ctx,
      error instanceof MidiaGrandeDemais
        ? TEXTOS_DO_LOTE.grandeDemais
        : error instanceof PlanilhaGrandeDemais
          ? TEXTOS_DO_LOTE.abaGrandeDemais
          : TEXTOS_DO_LOTE.ilegivel,
    )
    return
  }

  const empresas = await empresasDoDono(db, dono.id)
  const planilha = interpretarGrade(grade, {
    prestadorObrigatorio: empresas.filter((e) => e.active).length > 1,
    contarCampos: tipo === 'csv' && separadorDoCsv(decodificarTexto(conteudo)) === ',',
  })
  if (!planilha.ok) {
    logEvent('agente.planilha_recusada', { tenant_id: dono.id, erro: planilha.erro })
    await responder(
      ctx,
      planilha.erro === 'COLUNAS' ? textoDasColunas(planilha) : planilha.erro === 'VAZIA' ? TEXTOS_DO_LOTE.vazia : TEXTOS_DO_LOTE.linhasDemais,
    )
    return
  }

  const contexto = await contextoDoBanco(db, empresas, ctx.agora)
  const itens = validarLinhas(planilha.linhas, contexto)
  const nome = nomeDoArquivo(arquivo?.nome)
  // Tudo o que pode falhar vem antes de gravar: se a mensagem falhar depois do lote gravado, a reentrega da Meta
  // cairia em "já foi enviada" sem a pessoa ter visto o resumo.
  const resumo = textoDoResumoDoLote({
    arquivo: nome,
    itens,
    empresas,
    franquia: { limite: dono.limite, noMes: await notasDoMes(db, dono.id, ctx.agora) },
  })
  let loteId: string
  try {
    loteId = await gravarLote(db, { donoId: dono.id, phoneId: ctx.phoneId, arquivo: nome, hash, agora: ctx.agora, itens })
  } catch (error) {
    // Duas mensagens com a mesma planilha ao mesmo tempo: o índice único deixa uma só passar.
    if (!ehViolacaoDeUnicidade(error)) throw error
    const outro = await loteComOMesmoArquivo(db, dono.id, hash)
    await responder(ctx, outro ? textoDoArquivoRepetido(outro) : TEXTOS_DO_LOTE.semDownload)
    return
  }
  const prontas = itens.filter((i) => !i.problema).length
  logEvent('agente.lote_recebido', { tenant_id: dono.id, lote_id: loteId, linhas: itens.length, prontas })
  await responder(ctx, resumo)
}

// ---------------------------------------------------------------------------------------
// "confirmar" e "cancelar".

type LoteAberto = { id: string; status: string; expires_at: Date; created_at: Date; confirmed_at: Date | null; prontas: string }

/**
 * Lote mais recente das últimas 48 h que este telefone mandou: "confirmar" e "cancelar" só alcançam a planilha do
 * próprio telefone, nunca a que outro número da conta mandou.
 */
async function loteMaisRecente(db: Queryable, donoId: string, phoneId: string, agora: Date): Promise<LoteAberto | null> {
  const { rows } = await db.query<LoteAberto>(
    `select l.id, l.status, l.expires_at, l.created_at, l.confirmed_at,
            (select count(*) from nofiscal.fiscal_lote_itens li where li.lote_id = l.id and li.problema is null) as prontas
       from nofiscal.fiscal_lotes l
      where l.escritorio_tenant_id = $1 and l.phone_id = $2 and l.created_at > $3::timestamptz - interval '48 hours'
      order by l.created_at desc, l.id desc
      limit 1`,
    [donoId, phoneId, agora],
  )
  return rows[0] ?? null
}

/**
 * O pedido avulso do telefone que tem a vez: um aguardando confirmação mais novo que o lote, ou (para "sim", "ok"…)
 * a pergunta de salvar o modelo em aberto.
 */
async function pedidoTemAVez(db: Queryable, phoneId: string, lote: LoteAberto, soConfirmar: boolean): Promise<boolean> {
  const { rows } = await db.query<{ aguardando: boolean; modelo: boolean }>(
    `select exists (select 1 from nofiscal.fiscal_requests
                     where phone_id = $1 and status = 'awaiting_confirmation' and created_at > $2) as aguardando,
            exists (select 1 from nofiscal.fiscal_requests
                     where phone_id = $1 and etapa in ('salvar_modelo', 'substituir_modelo')) as modelo`,
    [phoneId, lote.created_at],
  )
  return Boolean(rows[0]?.aguardando || (!soConfirmar && rows[0]?.modelo))
}

/**
 * "confirmar" (ou "cancelar") quando o mais recente aguardando é um lote. `true` quando respondeu; `false` deixa a
 * mensagem para o pedido avulso e o resto da conversa.
 */
export async function responderAoLote(ctx: Contexto, texto: string): Promise<boolean> {
  const confirmar = ehConfirmar(texto)
  const cancelar = !confirmar && ehDesistir(texto)
  const quaseConfirmar = !confirmar && !cancelar && ehConfirmarEmissao(texto)
  if (!confirmar && !cancelar && !quaseConfirmar) return false

  const dono = await donoDoTenant(ctx.deps.db, ctx.tenantId)
  if (!dono || !planoDeEscritorio(dono.plan)) return false
  const lote = await loteMaisRecente(ctx.deps.db, dono.id, ctx.phoneId, ctx.agora)
  if (!lote || lote.status === 'descartado') return false
  if (await pedidoTemAVez(ctx.deps.db, ctx.phoneId, lote, confirmar || cancelar)) return false

  const vencido = lote.status === 'expirado' || (lote.status === 'aguardando_confirmacao' && lote.expires_at.getTime() <= ctx.agora.getTime())
  if (vencido) {
    if (cancelar) return false
    await expirarLotes(ctx.deps.db, ctx.agora, { tenantIds: [dono.id] })
    await responder(ctx, TEXTOS_DO_LOTE.expirou)
    return true
  }
  if (lote.status !== 'aguardando_confirmacao') {
    if (!confirmar) return false
    await responder(
      ctx,
      `Essa planilha já foi confirmada${lote.confirmed_at ? ` em ${quando(lote.confirmed_at)}` : ''}. ${lote.status === 'concluido' ? 'As notas dela já fecharam; o retorno vai (ou foi) para cá.' : 'As notas estão saindo; eu mando o retorno quando todas fecharem.'}`,
    )
    return true
  }
  const prontas = Number(lote.prontas)
  if (quaseConfirmar) {
    await responder(ctx, `Para emitir ${prontas === 1 ? 'a nota pronta da planilha' : `as ${prontas.toLocaleString('pt-BR')} notas prontas da planilha`}, responda *confirmar*.`)
    return true
  }
  if (cancelar) {
    await ctx.deps.db.query(
      `update nofiscal.fiscal_lotes set status = 'descartado', updated_at = $2 where id = $1 and status = 'aguardando_confirmacao'`,
      [lote.id, ctx.agora],
    )
    logEvent('agente.lote_descartado', { tenant_id: dono.id, lote_id: lote.id })
    await responder(ctx, TEXTOS_DO_LOTE.descartado)
    return true
  }
  await confirmarLote(ctx, lote.id, dono.id)
  return true
}

export type ResultadoDaConfirmacao = { emitindo: number; barradas: { linha: number; problema: string; empresa: string }[] } | null

/**
 * Ligação da linha com a nota: numa transação, cada linha sem problema vira `createOrGetInvoice(tx, item.tenant_id,
 * { external_id: 'lote:' + item.id, payload })`, e o lote vai para `emitindo`. Só a primeira confirmação muda o estado.
 * A empresa que ficou bloqueada desde o resumo (assinatura, A1) tem as linhas barradas com o código do bloqueio.
 */
export async function confirmarItensDoLote(db: Db, loteId: string, agora: Date): Promise<ResultadoDaConfirmacao> {
  return db.transaction(async (tx) => {
    const { rowCount } = await tx.query(
      `update nofiscal.fiscal_lotes
          set status = 'emitindo', confirmed_at = $2, updated_at = $2
        where id = $1 and status = 'aguardando_confirmacao' and expires_at > $2`,
      [loteId, agora],
    )
    if (rowCount !== 1) return null
    const { rows: itens } = await tx.query<{ id: string; linha: number; tenant_id: string; payload: InvoicePayload; razao_social: string }>(
      `select li.id, li.linha, li.tenant_id, li.payload, t.razao_social
         from nofiscal.fiscal_lote_itens li join nofiscal.fiscal_tenants t on t.id = li.tenant_id
        where li.lote_id = $1 and li.problema is null and li.invoice_id is null
        order by li.linha`,
      [loteId],
    )
    // Dois lotes da mesma conta confirmados ao mesmo tempo: um espera o outro, e o segundo vê as notas do primeiro.
    const { rows: donos } = await tx.query<{ dono: string }>('select escritorio_tenant_id as dono from nofiscal.fiscal_lotes where id = $1', [loteId])
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('fiscal_lote_dono:' || $1::text, 0))`, [donos[0].dono])
    const tenantIds = [...new Set(itens.map((i) => i.tenant_id))]
    const bloqueios = new Map<string, string | null>()
    for (const tenantId of tenantIds) {
      const { rows } = await tx.query<{ bloqueio: string | null }>('select nofiscal.emission_block($1) as bloqueio', [tenantId])
      bloqueios.set(tenantId, rows[0]?.bloqueio ?? null)
    }
    // Nota duplicada de novo, agora: desde o resumo pode ter saído nota igual (pedido avulso, outro lote).
    const iguais = tenantIds.length ? await notasIguaisDoMes(tx, tenantIds, agora) : new Set<string>()
    const ligados: { item: string; nota: string }[] = []
    const barradas: { id: string; linha: number; problema: string; empresa: string }[] = []
    for (const item of itens) {
      const bloqueio = bloqueios.get(item.tenant_id)
      const chave = chaveDoPayload(item.tenant_id, item.payload)
      const problema = bloqueio ?? (chave && iguais.has(chave) ? 'JA_EMITIDA_NO_MES' : null)
      if (problema) {
        barradas.push({ id: item.id, linha: item.linha, problema, empresa: item.razao_social })
        continue
      }
      const nota = await createOrGetInvoice(tx, item.tenant_id, { external_id: `lote:${item.id}`, payload: item.payload })
      ligados.push({ item: item.id, nota: nota.id })
    }
    if (ligados.length) {
      await tx.query(
        `update nofiscal.fiscal_lote_itens li set invoice_id = x.nota
           from unnest($1::uuid[], $2::uuid[]) as x(item, nota)
          where li.id = x.item`,
        [ligados.map((l) => l.item), ligados.map((l) => l.nota)],
      )
    }
    if (barradas.length) {
      await tx.query(
        `update nofiscal.fiscal_lote_itens li set problema = x.problema
           from unnest($1::uuid[], $2::text[]) as x(item, problema)
          where li.id = x.item`,
        [barradas.map((b) => b.id), barradas.map((b) => b.problema)],
      )
    }
    // Nada para emitir: o lote não fica esperando um retorno que não vai existir.
    if (!ligados.length) {
      await tx.query(`update nofiscal.fiscal_lotes set status = 'descartado', updated_at = $2 where id = $1`, [loteId, agora])
    }
    return { emitindo: ligados.length, barradas: barradas.map(({ linha, problema, empresa }) => ({ linha, problema, empresa })) }
  })
}

async function confirmarLote(ctx: Contexto, loteId: string, donoId: string): Promise<void> {
  const resultado = await confirmarItensDoLote(ctx.deps.db, loteId, ctx.agora)
  if (!resultado) {
    // Outra confirmação chegou antes (ou o lote venceu neste instante).
    const lote = await loteMaisRecente(ctx.deps.db, donoId, ctx.phoneId, ctx.agora)
    await responder(ctx, lote?.id === loteId && lote.status === 'emitindo' ? 'Essa planilha já foi confirmada. As notas estão saindo.' : TEXTOS_DO_LOTE.expirou)
    return
  }
  logEvent('agente.lote_confirmado', { tenant_id: donoId, lote_id: loteId, notas: resultado.emitindo, barradas: resultado.barradas.length })
  const barradas = resultado.barradas.length
    ? `${plural(resultado.barradas.length, 'linha ficou', 'linhas ficaram')} de fora: ${[
        ...new Set(resultado.barradas.map((b) => motivoDoProblema(b.problema, { empresa: b.empresa }))),
      ].join('; ')}.`
    : null
  if (!resultado.emitindo) {
    await responder(ctx, [barradas, 'Nenhuma nota foi emitida. Corrija e mande a planilha de novo.'].filter(Boolean).join('\n'))
    return
  }
  await responder(
    ctx,
    [
      `Confirmado. Emitindo ${plural(resultado.emitindo, 'nota', 'notas')} na Sefin.`,
      barradas,
      // O retorno (CSV e, se couber, o .zip) vai por e-mail à conta; aqui só o aviso (PR #101, lote-retorno.ts).
      'Cada tomador com e-mail recebe a nota por e-mail. Quando todas fecharem, mando o retorno de cada linha para o e-mail da conta e te aviso aqui. Os PDFs também ficam em Minha conta → Relatórios.',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

