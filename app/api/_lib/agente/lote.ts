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
import { lerEnderecoEscrito, registrarSemEndereco } from '../endereco-tomador.js'
import { createOrGetInvoice } from '../invoices.js'
import { motivoDoLocal, PROBLEMAS_DE_LOCAL, problemaDoLocal, resolverMunicipio } from '../local-prestacao.js'
import { exigeObra, lerObra, type Obra } from '../obra.js'
import { ehLocacao, lerLocacao, locacaoLigada, type Locacao } from '../locacao.js'
import { logEvent } from '../log.js'
import { marcaSemTomador, MOTIVO_CODIGO_EXIGE_TOMADOR, NOME_TOMADOR_NAO_INFORMADO, problemaDoCodigoSemTomador } from '../tomador-nao-informado.js'
import type { InvoicePayload } from '../validation.js'
import {
  COLUNAS_DA_RETENCAO,
  lerAliquotaIss,
  lerSimNao,
  motivoDaRetencao,
  padraoDaLinha,
  PROBLEMAS_DE_RETENCAO,
  resolverRetencao,
  SEM_RETENCAO_PADRAO,
  type EnderecoDoTomador,
  type EnderecoNacional,
  type Retencao,
  type RetencaoDoPedido,
  type RetencaoPadrao,
} from '../retencao.js'
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
import { lerCodigoServico, type CatalogoDeServicos } from './catalogo-servicos.js'
import { cnpjValido, cpfValido, formatarReais } from './documentos.js'
import { blocos, campo, comRotulo, mensagem, topicos } from './formato.js'
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

// `iss_retido` e `inss_retido` (Lucca, 16/11/2026) são opcionais: a planilha de 6 colunas continua valendo, e a coluna
// vazia deixa o padrão de retenção da empresa. `codigo_servico` (Lucca, 17/11/2026), também opcional: a nota sai com o
// código da linha; vazia, com o do modelo do tomador ou, sem modelo, com o da empresa. `municipio_prestacao` (Lucca,
// 18/11/2026), opcional: o local da prestação (cLocPrestacao), por nome com UF ("Campinas/SP") ou código IBGE; vazia, o
// município da empresa. O cabeçalho `ibge_prestacao` também vale. `obra_*` (Robson, Bragantina, 19/11/2026), opcionais:
// o endereço (obra_cep, obra_logradouro, obra_numero, obra_complemento, obra_bairro) ou o obra_cno, obrigatórios nas
// linhas com código de construção civil (E0370, obra.ts) e ignorados nas demais. `tomador_*` (Robson, Bragantina,
// 24/11/2026), opcionais: o endereço do tomador, que prevalece sobre o da Receita; com CPF, é o único jeito de a nota
// sair com endereço. `tomador_municipio_ibge` aceita o código IBGE ou "Cidade/UF" (cabeçalho `tomador_municipio` vale).
// Tomador não informado (Bragantina, 27/11/2026; tomador-nao-informado.ts): `cpf_cnpj_tomador` vazio e `nome_tomador`
// NAO INFORMADO (ou "consumidor não identificado"), sem e-mail, endereço nem retenção. A nota sai sem tomador, não vira
// cliente salvo e não entra na checagem de nota repetida (várias notas iguais de consumidor são o normal numa clínica).
// `imovel_*` e `bem_*` (26/11/2026), opcionais: os dados da locação (locacao.ts), obrigatórios nas linhas com código
// 99.03.01 (imóvel: cidade, CEP, rua, número, residencial sim/não; ou o CIB) e 99.04.01 (bem: NCM, descrição,
// quantidade) e ignorados nas demais.
export const CAMPOS = [
  'cnpj_prestador',
  'cpf_cnpj_tomador',
  'nome_tomador',
  'email_tomador',
  'valor',
  'descricao',
  'iss_retido',
  'inss_retido',
  'codigo_servico',
  'municipio_prestacao',
  'obra_cep',
  'obra_logradouro',
  'obra_numero',
  'obra_complemento',
  'obra_bairro',
  'obra_cno',
  'tomador_cep',
  'tomador_logradouro',
  'tomador_numero',
  'tomador_complemento',
  'tomador_bairro',
  'tomador_municipio_ibge',
  'imovel_cidade',
  'imovel_cep',
  'imovel_logradouro',
  'imovel_numero',
  'imovel_complemento',
  'imovel_bairro',
  'imovel_inscricao',
  'imovel_cib',
  'imovel_residencial',
  'imovel_copropriedade',
  'imovel_valor_total',
  'imovel_vencimento',
  'bem_ncm',
  'bem_descricao',
  'bem_quantidade',
] as const
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
  'ISS_RETIDO_INVALIDO',
  'CODIGO_SERVICO_INVALIDO',
  'CODIGO_SERVICO_FORA_DA_LISTA',
  'CODIGO_SERVICO_FALTANDO',
  'MUNICIPIO_PRESTACAO_INVALIDO',
  'MUNICIPIO_PRESTACAO_AMBIGUO',
  'OBRA_SEM_DADOS',
  'OBRA_INVALIDA',
  'ENDERECO_TOMADOR_INVALIDO',
  'LOCACAO_INDISPONIVEL',
  'LOCACAO_SEM_DADOS',
  'LOCACAO_INVALIDA',
  'LOCACAO_COM_ISS',
  ...PROBLEMAS_DE_LOCAL,
  ...PROBLEMAS_DE_RETENCAO,
] as const

export const TEXTOS_DO_LOTE = {
  soEscritorio: 'O envio por planilha é do plano Escritório. No seu plano, me mande cada nota por mensagem, por exemplo: nota pra Studio Lima, 350 reais.',
  formatoNaoAceito: blocos(
    'Eu leio planilhas em .xlsx ou .csv (planilhas com macro, .xls antigo e .ods não). Salve como .xlsx ou .csv e mande de novo.',
    `Modelo: ${MODELO_DA_PLANILHA}`,
  ),
  ilegivel: blocos('Não consegui ler essa planilha. Confira se é um .xlsx ou .csv (UTF-8) e mande de novo.', `Modelo: ${MODELO_DA_PLANILHA}`),
  grandeDemais: 'A planilha passou de 5 MB. Divida em duas e mande uma de cada vez.',
  abaGrandeDemais: blocos(
    'A primeira aba da planilha tem células usadas muito longe das notas (mais de 1.000 linhas ou de 50 colunas).',
    'Apague as linhas e colunas vazias abaixo e à direita das notas, ou salve só as notas em .csv, e mande de novo.',
  ),
  semDownload: 'Não consegui baixar a planilha agora. Mande de novo em alguns minutos.',
  vazia: blocos('A planilha não tem linhas de nota abaixo do cabeçalho.', `Modelo: ${MODELO_DA_PLANILHA}`),
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
const CAMPO_DO_CABECALHO = new Map<string, Campo>([
  ...CAMPOS.map((campo): [string, Campo] => [normalizarCabecalho(campo), campo]),
  [normalizarCabecalho('ibge_prestacao'), 'municipio_prestacao'],
  [normalizarCabecalho('tomador_municipio'), 'tomador_municipio_ibge'],
])

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
  const problemas = [
    p.desconhecidas.length ? `Colunas que eu não conheço: ${p.desconhecidas.join(', ')}.` : null,
    p.faltando.length ? `Faltam as colunas: ${p.faltando.join(', ')}.` : null,
    p.repetidas.length ? `Colunas repetidas: ${p.repetidas.join(', ')}.` : null,
  ].filter((linha): linha is string => Boolean(linha))
  return mensagem({
    titulo: 'Colunas da planilha',
    blocos: [
      'Não reconheci as colunas da planilha, e nada foi gravado.',
      problemas.length ? topicos(problemas) : null,
      [
        'A primeira linha precisa ter estes nomes:',
        topicos([
          'cnpj_prestador (pode faltar se a conta tem uma só empresa ativa)',
          `cpf_cnpj_tomador (vazio, com ${NOME_TOMADOR_NAO_INFORMADO} em nome_tomador, para consumidor não identificado)`,
          'nome_tomador',
          'email_tomador (opcional)',
          'valor',
          'descricao (opcional)',
          'iss_retido (opcional)',
          'inss_retido (opcional)',
          'codigo_servico (opcional: o código da lista nacional, como 04.03.01; vazio = o do cliente ou o da empresa)',
          'municipio_prestacao (opcional: a cidade onde o serviço foi prestado, como Campinas/SP, ou o código IBGE; vazio = a cidade da empresa)',
        ]),
      ],
      'Nas notas de construção civil, também obra_cep, obra_logradouro, obra_numero, obra_complemento (opcional) e obra_bairro, ou obra_cno.',
      'Nas notas de locação (99.03.01 e 99.04.01), também imovel_cep, imovel_logradouro, imovel_numero, imovel_residencial (sim ou não) e, se quiser, imovel_complemento, imovel_bairro, imovel_cidade, imovel_inscricao, imovel_cib, imovel_copropriedade, imovel_valor_total e imovel_vencimento; ou bem_ncm, bem_descricao e bem_quantidade.',
    ],
    acao: `Modelo para baixar: ${MODELO_DA_PLANILHA}`,
  })
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
  /** Município da empresa (IBGE). Ausente = não conferido. */
  codigo_municipio_ibge?: string | null
  /** 'mei' ou 'simples' (MEI não tem retenção). Ausente = não conferido. */
  regime?: string | null
  /** Padrão de retenção da empresa (`fiscal_tenants`); ausente = sem retenção. */
  retencao?: RetencaoPadrao
}

export type ModeloDoTomador = { codigo: string; descricao: string; email: string | null }

export type ContextoDoLote = {
  empresas: Empresa[]
  /** `nofiscal.emission_block` de cada empresa (null = emite). */
  bloqueios: Map<string, string | null>
  /** Modelo do tomador por `${tenantId}:${documento}`. */
  modelos: Map<string, ModeloDoTomador>
  /** Notas do mês por `${tenantId}:${documento}:${centavos}:${codigo}` (`chaveDaNota`). */
  jaEmitidas: Set<string>
  /** Códigos da lista nacional de serviços. Ausente (lista fora do ar): o código da linha só tem o formato conferido. */
  codigosDaLista?: Set<string> | null
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
  /** Tomador com CNPJ cujo endereço a Receita não deu agora: a nota sai sem endereço (só o resumo usa). */
  semEndereco?: boolean
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

    const nome = textoDaCelula(celulas.nome_tomador).slice(0, 150).trim()
    // Sem tomador: documento vazio e a marca no nome. Documento vazio sem a marca é falta de dado, não nota sem tomador.
    const documentoEscrito = textoDaCelula(celulas.cpf_cnpj_tomador)
    const semTomador = !documentoEscrito && marcaSemTomador(nome)
    let documento = ''
    if (!semTomador) {
      if (!documentoEscrito) return falha('DOCUMENTO_FALTANDO', empresa.id)
      const lidoDocumento = lerDocumentoDaCelula(celulas.cpf_cnpj_tomador)
      if ('erro' in lidoDocumento) return falha(lidoDocumento.erro, empresa.id)
      documento = lidoDocumento.documento
      if (marcaSemTomador(nome)) return falha('NAO_INFORMADO_COM_DOCUMENTO', empresa.id)
      // E0202: a própria empresa não é tomadora da nota dela.
      if (documento === empresa.cnpj) return falha('TOMADOR_E_O_PRESTADOR', empresa.id)
    }
    if (!nome) return falha('NOME_FALTANDO', empresa.id)
    const valor = lerValor(celulas.valor ?? null, { pontoEhMilhar })
    if (!valor) return falha('VALOR_INVALIDO', empresa.id)
    const emailEscrito = textoDaCelula(celulas.email_tomador)
    if (semTomador && emailEscrito) return falha('EMAIL_SEM_TOMADOR', empresa.id)
    const email = emailEscrito ? normalizarEmail(emailEscrito) : null
    if (emailEscrito && !email) return falha('EMAIL_INVALIDO', empresa.id)
    const descricaoEscrita = textoDaCelula(celulas.descricao)
    if (descricaoEscrita.length > 2000) return falha('DESCRICAO_LONGA', empresa.id)
    const pedidoDeRetencao = lerRetencaoDaLinha(celulas)
    if (pedidoDeRetencao === 'ISS_RETIDO_INVALIDO') return falha('ISS_RETIDO_INVALIDO', empresa.id)
    const tomadorTipo = semTomador ? null : documento.length === 14 ? 'cnpj' : 'cpf'
    const resolvida = resolverRetencao({
      padrao: empresa.retencao ?? SEM_RETENCAO_PADRAO,
      pedido: pedidoDeRetencao,
      valor,
      regime: empresa.regime ?? null,
      tomadorTipo,
    })
    // O problema da retenção só conta depois do código: na locação, a retenção é outra (sem ISS).

    // Código de serviço: o da linha, senão o do modelo do tomador, senão o da empresa (Lucca, 17/11/2026: uma clínica
    // emite psicologia, fisioterapia e nutrição pela mesma empresa). A descrição escrita na planilha vale para esta
    // nota; sem ela, a do modelo ou a padrão.
    const codigoEscrito = textoDaCelula(celulas.codigo_servico)
    const codigoDaLinha = codigoEscrito ? lerCodigoServico(typeof celulas.codigo_servico === 'number' ? celulas.codigo_servico : codigoEscrito) : null
    if (codigoEscrito && !codigoDaLinha) return falha('CODIGO_SERVICO_INVALIDO', empresa.id)
    if (codigoDaLinha && ctx.codigosDaLista && !ctx.codigosDaLista.has(codigoDaLinha)) return falha('CODIGO_SERVICO_FORA_DA_LISTA', empresa.id)
    const modelo = semTomador ? undefined : ctx.modelos.get(`${empresa.id}:${documento}`)
    const codigo = codigoDaLinha ?? modelo?.codigo ?? empresa.codigo_servico_nacional ?? ''
    if (semTomador && ehLocacao(codigo)) return falha('LOCACAO_EXIGE_TOMADOR', empresa.id)
    if (!resolvida.ok && !ehLocacao(codigo)) return falha(resolvida.problema, empresa.id)
    if (!/^\d{6}$/.test(codigo)) return falha('CODIGO_SERVICO_FALTANDO', empresa.id)
    if (semTomador && problemaDoCodigoSemTomador(codigo)) return falha('CODIGO_EXIGE_TOMADOR', empresa.id)
    // Local da prestação: nome com UF ou código IBGE; o mesmo da sede fica de fora (a nota sai como antes).
    const localEscrito = textoDaCelula(celulas.municipio_prestacao)
    let municipioPrestacao: string | null = null
    if (localEscrito) {
      const r = resolverMunicipio(localEscrito)
      if (!r.ok) return falha(r.motivo === 'ambiguo' ? 'MUNICIPIO_PRESTACAO_AMBIGUO' : 'MUNICIPIO_PRESTACAO_INVALIDO', empresa.id)
      municipioPrestacao = r.municipio.ibge === empresa.codigo_municipio_ibge ? null : r.municipio.ibge
    }
    if (municipioPrestacao) {
      const barrado = problemaDoLocal({ codigo, municipioPrestacao })
      if (barrado) return falha(barrado, empresa.id)
    }
    // Dados da obra: só nas linhas de construção civil (E0370), onde são obrigatórios.
    let obra: Obra | null = null
    if (exigeObra(codigo)) {
      const lida = lerObra({
        cep: textoDaCelula(celulas.obra_cep),
        logradouro: textoDaCelula(celulas.obra_logradouro),
        numero: textoDaCelula(celulas.obra_numero),
        complemento: textoDaCelula(celulas.obra_complemento),
        bairro: textoDaCelula(celulas.obra_bairro),
        cno: textoDaCelula(celulas.obra_cno),
      })
      if (!lida.ok) return falha('OBRA_INVALIDA', empresa.id)
      if (!lida.obra) return falha('OBRA_SEM_DADOS', empresa.id)
      obra = lida.obra
    }
    // Dados da locação: só nas linhas com código 99.03.01 ou 99.04.01, onde são obrigatórios; com a flag desligada, a linha
    // volta com o motivo (a nota entra quando a Receita liberar).
    let locacao: Locacao | null = null
    let retencaoDaNota = resolvida.ok ? resolvida.retencao : null
    if (ehLocacao(codigo)) {
      if (!locacaoLigada()) return falha('LOCACAO_INDISPONIVEL', empresa.id)
      // Na locação o ISS não incide (E0532): pedido na linha, a linha volta; do padrão da empresa, não vale.
      if (pedidoDeRetencao.iss) return falha('LOCACAO_COM_ISS', empresa.id)
      const semIss = resolverRetencao({
        padrao: { ...(empresa.retencao ?? SEM_RETENCAO_PADRAO), retem_iss: false, aliquota_iss: null },
        pedido: pedidoDeRetencao,
        valor,
        regime: empresa.regime ?? null,
        tomadorTipo,
      })
      if (!semIss.ok) return falha(semIss.problema, empresa.id)
      retencaoDaNota = semIss.retencao
      const cidade = textoDaCelula(celulas.imovel_cidade)
      let municipioDoImovel: string | null = empresa.codigo_municipio_ibge ?? null
      if (cidade) {
        const r = resolverMunicipio(cidade)
        if (!r.ok) return falha('LOCACAO_INVALIDA', empresa.id)
        municipioDoImovel = r.municipio.ibge
      }
      const celula = (c: Campo) => textoDaCelula(celulas[c]) || undefined
      const bruto = codigo === '990301'
        ? {
            imovel: {
              municipio_ibge: municipioDoImovel,
              cep: celula('imovel_cep'),
              logradouro: celula('imovel_logradouro'),
              numero: celula('imovel_numero'),
              complemento: celula('imovel_complemento'),
              bairro: celula('imovel_bairro'),
              inscricao_imobiliaria: celula('imovel_inscricao'),
              cib: celula('imovel_cib'),
              residencial: celula('imovel_residencial'),
              copropriedade: celula('imovel_copropriedade'),
              valor_total: celula('imovel_valor_total'),
              vencimento: celula('imovel_vencimento'),
            },
          }
        : celula('bem_ncm') || celula('bem_descricao')
          ? { bens: [{ ncm: celula('bem_ncm'), descricao: celula('bem_descricao'), quantidade: celula('bem_quantidade') }] }
          : {}
      const lida = lerLocacao(bruto, codigo, valor)
      if (!lida.ok) return falha(lida.faltando.length ? 'LOCACAO_SEM_DADOS' : 'LOCACAO_INVALIDA', empresa.id)
      locacao = lida.locacao
    }
    const servico = { codigo, descricao: descricaoEscrita || modelo?.descricao || DESCRICAO_PADRAO, municipio_prestacao_ibge: municipioPrestacao, obra, locacao }
    // Endereço do tomador escrito na planilha: prevalece sobre o da Receita (que entra depois, em `completarEnderecos`).
    const enderecoEscrito = lerEnderecoEscrito({
      cep: celulas.tomador_cep,
      logradouro: celulas.tomador_logradouro,
      numero: celulas.tomador_numero,
      complemento: celulas.tomador_complemento,
      bairro: celulas.tomador_bairro,
      municipio: celulas.tomador_municipio_ibge,
    })
    if (semTomador && (!enderecoEscrito.ok || enderecoEscrito.endereco)) return falha('ENDERECO_SEM_TOMADOR', empresa.id)
    if (!enderecoEscrito.ok) return falha('ENDERECO_TOMADOR_INVALIDO', empresa.id)
    const payload = payloadDaNota(semTomador ? null : { documento, nome, email: email ?? modelo?.email ?? null }, servico, valor, {
      retencao: retencaoDaNota,
      endereco: enderecoEscrito.endereco,
    })
    const pronta = (problema: string | null, igualA?: number): ItemDoLote => ({
      linha,
      tenantId: empresa.id,
      payload,
      problema,
      valor,
      ...(igualA ? { igualA } : {}),
    })

    const bloqueio = ctx.bloqueios.get(empresa.id)
    // Sem tomador não há "mesmo tomador": a checagem de repetida e de já emitida no mês não vale.
    if (semTomador) return pronta(bloqueio ?? null)
    const chave = chaveDaNota(empresa.id, documento, centavosDe(valor), codigo)
    const anterior = primeiraLinha.get(chave)
    if (anterior === undefined) primeiraLinha.set(chave, linha)

    if (bloqueio) return pronta(bloqueio)
    if (anterior !== undefined) return pronta('LINHA_REPETIDA', anterior)
    if (ctx.jaEmitidas.has(chave)) return pronta('JA_EMITIDA_NO_MES')
    return pronta(null)
  })
}

/**
 * As colunas de retenção da linha. `iss_retido`: sim/não, ou a alíquota ("2%", "2,5"); `inss_retido`: sim/não, o
 * percentual ("11%") ou o valor ("38,50"). Célula numérica do Excel abaixo de 1 é percentual formatado (0,11 = 11%).
 * Vazia = o padrão da empresa.
 */
export function lerRetencaoDaLinha(celulas: LinhaLida['celulas']): RetencaoDoPedido | 'ISS_RETIDO_INVALIDO' {
  const r: RetencaoDoPedido = {}
  const iss = celulas.iss_retido
  const simNaoIss = lerSimNao(typeof iss === 'number' ? '' : iss)
  if (typeof iss === 'number' && Number.isFinite(iss) && iss > 0) {
    r.iss = true
    r.aliquotaIss = String(iss < 1 ? Math.round(iss * 10000) / 100 : iss).replace('.', ',')
  } else if (simNaoIss === true || simNaoIss === false) {
    r.iss = simNaoIss
  } else if (simNaoIss === null) {
    if (!lerAliquotaIss(textoDaCelula(iss))) return 'ISS_RETIDO_INVALIDO'
    r.iss = true
    r.aliquotaIss = textoDaCelula(iss)
  }
  const inss = celulas.inss_retido
  if (typeof inss === 'number' && Number.isFinite(inss) && inss > 0) {
    r.inss = true
    r.inssTexto = inss < 1 ? `${Math.round(inss * 10000) / 100}%` : String(inss)
  } else {
    const simNaoInss = lerSimNao(inss)
    if (simNaoInss === true || simNaoInss === false) r.inss = simNaoInss
    else if (simNaoInss === null) {
      r.inss = true
      r.inssTexto = textoDaCelula(inss)
    }
  }
  return r
}

/** Consultas de endereço ao mesmo tempo, na planilha. */
const CONSULTAS_EM_PARALELO = 6

/**
 * Endereço do tomador com CNPJ em toda linha (Bragantina, 24/11/2026), da Receita, quando a planilha não trouxe as
 * colunas `tomador_*`. Um pedido por CNPJ, até `CONSULTAS_EM_PARALELO` ao mesmo tempo. Sem endereço: com ISS retido a
 * linha fica com `ENDERECO_TOMADOR` (E0237); sem, a nota sai sem endereço e a linha fica com `semEndereco`.
 */
export async function completarEnderecos(itens: ItemDoLote[], consulta: EnderecoDoTomador | null | undefined): Promise<void> {
  type P = { tomador?: { cnpj?: string; endereco?: EnderecoNacional }; retencao?: Retencao }
  const precisam = itens.filter((i) => {
    const p = i.payload as P
    return p.tomador?.cnpj && !p.tomador.endereco
  })
  const cnpjs = [...new Set(precisam.map((i) => (i.payload as P).tomador?.cnpj as string))]
  const achados = new Map<string, EnderecoNacional | null>()
  let proximo = 0
  const trabalhador = async () => {
    while (proximo < cnpjs.length) {
      const cnpj = cnpjs[proximo++]
      achados.set(cnpj, consulta ? await consulta.endereco(cnpj).catch(() => null) : null)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONSULTAS_EM_PARALELO, cnpjs.length) }, trabalhador))
  for (const item of precisam) {
    const p = item.payload as P
    const endereco = achados.get(p.tomador?.cnpj as string) ?? null
    if (endereco) (p.tomador as { endereco?: EnderecoNacional }).endereco = endereco
    else if (p.retencao?.iss) {
      if (!item.problema) item.problema = 'ENDERECO_TOMADOR'
    } else item.semEndereco = true
  }
  const sem = precisam.filter((i) => i.semEndereco).length
  if (sem) registrarSemEndereco('planilha', { notas: sem })
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
    case 'DOCUMENTO_FALTANDO':
      return `falta o CPF ou CNPJ do tomador (para consumidor não identificado, deixe cpf_cnpj_tomador vazio e escreva ${NOME_TOMADOR_NAO_INFORMADO} em nome_tomador)`
    case 'NAO_INFORMADO_COM_DOCUMENTO':
      return `nome_tomador diz ${NOME_TOMADOR_NAO_INFORMADO}, mas a linha tem CPF/CNPJ: para nota sem tomador, apague o cpf_cnpj_tomador; senão, escreva o nome do cliente`
    case 'TOMADOR_E_O_PRESTADOR':
      return `o CPF/CNPJ do tomador é o da própria ${empresa}, e a Sefin não aceita a empresa como tomadora da própria nota (para consumidor não identificado, deixe cpf_cnpj_tomador vazio e escreva ${NOME_TOMADOR_NAO_INFORMADO} em nome_tomador)`
    case 'EMAIL_SEM_TOMADOR':
      return 'nota sem tomador não tem e-mail do tomador: deixe email_tomador vazio'
    case 'ENDERECO_SEM_TOMADOR':
      return 'nota sem tomador não tem endereço do tomador: deixe as colunas tomador_* vazias'
    case 'CODIGO_EXIGE_TOMADOR':
      return `sem tomador não dá: ${MOTIVO_CODIGO_EXIGE_TOMADOR}`
    case 'LOCACAO_EXIGE_TOMADOR':
      return 'nota de locação exige o tomador (o inquilino) identificado'
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
      return d.igualA
        ? `igual à linha ${d.igualA} (mesmo prestador, tomador, valor e código de serviço)`
        : 'linha repetida (mesmo prestador, tomador, valor e código de serviço)'
    case 'JA_EMITIDA_NO_MES':
      return 'já há nota igual neste mês (mesmo prestador, tomador, valor e código de serviço)'
    case 'ISS_RETIDO_INVALIDO':
      return 'iss_retido inválido: escreva sim, não ou a alíquota (de 2% a 5%)'
    case 'CODIGO_SERVICO_INVALIDO':
      return 'codigo_servico inválido: escreva os 6 dígitos da lista nacional, como 04.03.01 ou 040301'
    case 'CODIGO_SERVICO_FORA_DA_LISTA':
      return 'o codigo_servico não está na lista nacional de serviços: confira o código'
    case 'CODIGO_SERVICO_FALTANDO':
      return `${empresa} não tem código de serviço padrão: preencha a coluna codigo_servico`
    case 'MUNICIPIO_PRESTACAO_INVALIDO':
      return 'municipio_prestacao não encontrado: escreva a cidade com a UF, como Campinas/SP, ou o código IBGE de 7 dígitos'
    case 'OBRA_SEM_DADOS':
      return 'o código de serviço é de construção civil, e a Sefin exige os dados da obra: preencha obra_cep, obra_logradouro, obra_numero e obra_bairro, ou obra_cno'
    case 'ENDERECO_TOMADOR_INVALIDO':
      return 'endereço do tomador incompleto ou inválido: preencha tomador_cep (8 dígitos), tomador_logradouro, tomador_bairro e tomador_municipio_ibge (código IBGE ou Cidade/UF), ou deixe todas as colunas tomador_* vazias'
    case 'LOCACAO_INDISPONIVEL':
      return 'nota de locação (99.03.01 ou 99.04.01): entra no sistema assim que a Receita liberar esses códigos no ambiente nacional; por enquanto, esta linha não é emitida'
    case 'LOCACAO_SEM_DADOS':
      return 'nota de locação sem os dados que a Receita exige: no imóvel (99.03.01), imovel_cep, imovel_logradouro, imovel_numero e imovel_residencial (sim ou não), ou imovel_cib; no bem móvel (99.04.01), bem_ncm (8 dígitos) e bem_descricao'
    case 'LOCACAO_INVALIDA':
      return 'dados da locação inválidos: confira imovel_cidade (cidade com UF), imovel_cep (8 dígitos), imovel_copropriedade (até 100) com imovel_valor_total, imovel_vencimento (data), bem_ncm (8 dígitos) e bem_quantidade (1 a 999)'
    case 'LOCACAO_COM_ISS':
      return 'locação não tem ISS (não incidência): deixe iss_retido vazio ou "não"'
    case 'OBRA_INVALIDA':
      return 'dados da obra incompletos ou inválidos: o endereço precisa de obra_cep (8 dígitos), obra_logradouro, obra_numero e obra_bairro; o obra_cno, de 12 dígitos'
    case 'LOCAL_EXIGE_EVENTO':
      return motivoDoLocal(codigo)
    case 'MUNICIPIO_PRESTACAO_AMBIGUO':
      return 'há mais de uma cidade com esse nome em municipio_prestacao: escreva com a UF, como Bom Jesus/PI'
    case 'RETENCAO_MEI':
    case 'ISS_RETIDO_CPF':
    case 'ALIQUOTA_ISS_FALTANDO':
    case 'ALIQUOTA_ISS_INVALIDA':
    case 'INSS_FALTANDO':
    case 'INSS_INVALIDO':
    case 'RETENCOES_ACIMA_DO_VALOR':
    case 'ENDERECO_TOMADOR':
    case 'RETENCAO_SEM_TOMADOR':
      return motivoDaRetencao(codigo)
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
    case 'MUNICIPIO_SEM_PRESUMIDO':
      return `a prefeitura de ${empresa} não aceita Lucro Presumido/Real no Emissor Nacional (a Sefin recusou); a empresa está na lista de espera`
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

/** "Com retenção: 3 notas com ISS retido, 2 com INSS retido." (nada sem retenção). */
export function textoDasRetencoes(prontas: ItemDoLote[]): string | null {
  const ret = (i: ItemDoLote) => (i.payload as { retencao?: Retencao }).retencao
  const iss = prontas.filter((i) => ret(i)?.iss).length
  const inss = prontas.filter((i) => ret(i)?.inss).length
  if (!iss && !inss) return null
  return `Com retenção: ${[iss ? `${plural(iss, 'nota', 'notas')} com ISS retido` : null, inss ? `${plural(inss, 'nota', 'notas')} com INSS retido` : null].filter(Boolean).join(', ')}.`
}

/** "Códigos de serviço: 04.08.02 (3 notas), 04.16.01 (2 notas)." quando as notas prontas usam mais de um código. */
export function textoDosCodigos(prontas: ItemDoLote[]): string | null {
  const porCodigo = new Map<string, number>()
  for (const i of prontas) {
    const codigo = (i.payload as { servico?: { codigo_servico_nacional?: string } }).servico?.codigo_servico_nacional
    if (codigo) porCodigo.set(codigo, (porCodigo.get(codigo) ?? 0) + 1)
  }
  if (porCodigo.size < 2) return null
  const formatar = (c: string) => c.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1.$2.$3')
  return `Códigos de serviço: ${[...porCodigo].map(([c, n]) => `${formatar(c)} (${plural(n, 'nota', 'notas')})`).join(', ')}.`
}

/** Notas prontas de CNPJ cujo endereço a Receita não deu agora: saem sem o endereço do tomador. */
export function textoSemEndereco(prontas: ItemDoLote[]): string | null {
  const linhas = prontas.filter((i) => i.semEndereco).map((i) => i.linha)
  if (!linhas.length) return null
  const quais = linhas.length <= 10 ? ` (${linhas.length === 1 ? 'linha' : 'linhas'} ${linhas.join(', ')})` : ''
  return `Sem endereço do cliente: ${plural(linhas.length, 'nota sai', 'notas saem')} sem o endereço${quais}, porque não achei o CNPJ na Receita agora. Para pôr o endereço, preencha as colunas tomador_* e mande de novo.`
}

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

  // Números das notas prontas: quanto, por empresa, retenções e códigos (só o que houver).
  const numeros: (string | null)[] = [
    prontas.length ? campo('Prontas para emitir', `${prontas.length.toLocaleString('pt-BR')}, total ${formatarReais(reaisDeCentavos(total))}.`) : null,
    porEmpresa.size
      ? campo('Empresas', `${[...porEmpresa].map(([id, n]) => `${nomeDe.get(id) ?? id} (${plural(n, 'nota', 'notas')})`).join(', ')}.`)
      : null,
  ]
  const retencoes = textoDasRetencoes(prontas)
  if (retencoes) numeros.push(comRotulo(retencoes))
  const codigos = textoDosCodigos(prontas)
  if (codigos) numeros.push(comRotulo(codigos))
  const semEndereco = textoSemEndereco(prontas)
  if (semEndereco) numeros.push(comRotulo(semEndereco))

  const problemas: string[] = []
  for (const item of comProblema.slice(0, MAX_PROBLEMAS_NO_RESUMO)) {
    const semPrestador = !String((item.payload.lido as Record<string, string> | undefined)?.cnpj_prestador ?? '').trim()
    problemas.push(
      `Linha ${item.linha}: ${motivoDoProblema(item.problema as string, { empresa: item.tenantId ? nomeDe.get(item.tenantId) : null, igualA: item.igualA, semPrestador })}`,
    )
  }
  if (comProblema.length > MAX_PROBLEMAS_NO_RESUMO) {
    problemas.push(`e mais ${plural(comProblema.length - MAX_PROBLEMAS_NO_RESUMO, 'linha', 'linhas')} com problema.`)
  }

  let franquia: string | null = null
  if (dados.franquia && prontas.length && dados.franquia.noMes + prontas.length > dados.franquia.limite) {
    const fica = dados.franquia.noMes + prontas.length
    franquia = campo(
      'Franquia',
      `com estas notas, o mês chega a ${fica.toLocaleString('pt-BR')} notas, ${(fica - dados.franquia.limite).toLocaleString('pt-BR')} acima das ${dados.franquia.limite.toLocaleString('pt-BR')} do seu plano. As notas saem normalmente.`,
    )
  }

  return mensagem({
    titulo: 'Resumo da planilha',
    blocos: [
      `Li a planilha${dados.arquivo ? ` ${dados.arquivo}` : ''}: ${plural(dados.itens.length, 'linha', 'linhas')}.`,
      prontas.length ? numeros : 'Nenhuma linha está pronta para emitir.',
      comProblema.length ? [campo('Com problema (ficam de fora)', `${plural(comProblema.length, 'linha', 'linhas')}.`), topicos(problemas)] : null,
      franquia,
    ],
    acao: prontas.length
      ? `Responda *confirmar* para emitir ${prontas.length === 1 ? 'a nota pronta' : `as ${prontas.length.toLocaleString('pt-BR')} notas prontas`}, ou *cancelar* para descartar. Vale por 24 horas.`
      : 'Corrija a planilha e mande de novo.',
  })
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

export async function empresasDoDono(db: Queryable, donoId: string): Promise<Empresa[]> {
  const { rows } = await db.query<Omit<Empresa, 'retencao'> & Record<string, unknown>>(
    `select t.id, t.cnpj, t.razao_social, t.active, t.codigo_servico_nacional, t.codigo_municipio_ibge, t.regime, ${COLUNAS_DA_RETENCAO.replace(/(^|, )/g, '$1t.')}
       from nofiscal.fiscal_tenants t
      where t.id = $1 or t.escritorio_tenant_id = $1
      order by t.id = $1 desc, t.razao_social`,
    [donoId],
  )
  return rows.map((r) => ({
    id: r.id,
    cnpj: r.cnpj,
    razao_social: r.razao_social,
    active: r.active,
    codigo_servico_nacional: r.codigo_servico_nacional,
    codigo_municipio_ibge: r.codigo_municipio_ibge ?? null,
    regime: r.regime ?? null,
    retencao: padraoDaLinha(r as Parameters<typeof padraoDaLinha>[0]),
  }))
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
 * A chave de nota duplicada: mesma empresa, tomador, valor e código de serviço. O código entra desde 17/11/2026: a
 * clínica que atende o mesmo paciente em psicologia e em nutrição, pelo mesmo valor, emite as duas notas.
 */
export const chaveDaNota = (tenantId: string, documento: string, centavos: bigint, codigo: string | null | undefined) =>
  `${tenantId}:${documento}:${centavos}:${codigo ?? ''}`

/**
 * Nota duplicada: as chaves (`chaveDaNota`) das notas emitidas no mês de Brasília e das que
 * ainda estão na fila (um lote anterior que não fechou conta também). Usada no resumo e de novo no "confirmar".
 */
export async function notasIguaisDoMes(db: Queryable, tenantIds: string[], agora: Date): Promise<Set<string>> {
  const local = partesLocais(agora)
  const { inicio, fim } = limitesDoMes(local.ano, local.mes)
  const { rows: notas } = await db.query<{ tenant_id: string; documento: string | null; valor: unknown; codigo: string | null }>(
    `select i.tenant_id, coalesce(i.payload->'tomador'->>'cpf', i.payload->'tomador'->>'cnpj') as documento, i.payload->>'valor' as valor,
            i.payload->'servico'->>'codigo_servico_nacional' as codigo
       from nofiscal.fiscal_invoices i
      where i.tenant_id = any($1::uuid[])
        and ((i.status = 'issued' and i.issued_at >= $2 and i.issued_at < $3)
             or (i.status in ('queued', 'signing', 'sent') and i.created_at >= $2))`,
    [tenantIds, inicio, fim],
  )
  const chaves = new Set<string>()
  for (const n of notas) {
    const centavos = valorDoPayload(n.valor)
    if (n.documento && centavos !== null) chaves.add(chaveDaNota(n.tenant_id, n.documento, centavos, n.codigo))
  }
  return chaves
}

/** A chave de nota duplicada de um payload do motor. */
export function chaveDoPayload(tenantId: string, payload: unknown): string | null {
  const p = (payload ?? {}) as { tomador?: { cpf?: string; cnpj?: string }; valor?: unknown; servico?: { codigo_servico_nacional?: string } }
  const documento = p.tomador?.cpf ?? p.tomador?.cnpj
  const centavos = valorDoPayload(p.valor)
  return documento && centavos !== null ? chaveDaNota(tenantId, documento, centavos, p.servico?.codigo_servico_nacional) : null
}

/**
 * Notas do mês de todas as empresas da conta-mãe, para a franquia (emitidas no mês e as que estão na fila). A NF-e
 * (nota de produto, `nofiscal.nfe_do_mes`) soma na mesma franquia. Nota recusada pela Sefin não consome a franquia —
 * inclusive a do Presumido/Real recusada porque a cidade não aceita o regime (E0037/E0038/E0039; Lucca, 19/11/2026):
 * ela sai da fila como `rejected`, sem `issued_at`.
 */
export async function notasDoMes(db: Queryable, donoId: string, agora: Date): Promise<number> {
  const local = partesLocais(agora)
  const { inicio, fim } = limitesDoMes(local.ano, local.mes)
  const { rows } = await db.query<{ n: string }>(
    `select (select count(*) from nofiscal.fiscal_invoices i
              where i.tenant_id in (select nofiscal.empresas_do_dono($1))
                and ((i.issued_at >= $2 and i.issued_at < $3) or i.status in ('queued', 'signing', 'sent')))
            + nofiscal.nfe_do_mes($1, $2, $3) as n`,
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
  dados: { donoId: string; phoneId: string | null; arquivo: string | null; hash: string; agora: Date; itens: ItemDoLote[] },
): Promise<string> {
  // Sem linha pronta, o lote nasce descartado: fica o registro, e a mesma planilha (com a empresa já acertada no
  // painel) pode voltar.
  const status = dados.itens.some((i) => !i.problema) ? 'aguardando_confirmacao' : 'descartado'
  return db.transaction((tx) => gravarLoteNa(tx, dados, status))
}

async function gravarLoteNa(
  db: Queryable,
  dados: { donoId: string; phoneId: string | null; arquivo: string | null; hash: string; agora: Date; itens: ItemDoLote[] },
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

/** Por que a planilha não virou lote; `texto` é a resposta que a pessoa lê (a mesma no WhatsApp e no painel). */
export type PlanilhaRecusada = {
  ok: false
  motivo: 'repetida' | 'grande_demais' | 'aba_grande_demais' | 'ilegivel' | 'colunas' | 'vazia' | 'linhas_demais' | 'indisponivel'
  texto: string
  /** Só em `repetida`: o lote da mesma planilha que espera o "confirmar". */
  loteId?: string
}

export type LoteLido = {
  ok: true
  loteId: string
  /** `descartado` quando nenhuma linha ficou pronta (fica o registro, nada para confirmar). */
  status: 'aguardando_confirmacao' | 'descartado'
  arquivo: string | null
  itens: ItemDoLote[]
  empresas: Empresa[]
  franquia: Franquia
  expiraEm: Date
  /** O resumo de texto fixo, o mesmo do WhatsApp. */
  resumo: string
}

/**
 * Da planilha já baixada ao lote gravado: expira os lotes vencidos da conta, recusa a mesma planilha aguardando,
 * lê, valida cada linha contra o banco e grava o lote (`aguardando_confirmacao`, 24 h). O WhatsApp (`receberPlanilha`)
 * e o painel "Minha conta" (`painel-emissao.ts`) passam por aqui; no painel não há telefone (`phoneId` null), e o
 * retorno do lote vai ao `owner` da conta-mãe e ao e-mail da conta (lote-retorno.ts).
 */
export async function lerLoteDaPlanilha(
  db: Db,
  dados: {
    donoId: string
    limite: number
    phoneId: string | null
    arquivo: string | null
    conteudo: Uint8Array
    tipo: TipoDePlanilha
    agora: Date
    /** Endereço do tomador na Receita, para as linhas de CNPJ sem as colunas `tomador_*`. */
    consulta?: EnderecoDoTomador | null
    /** A lista nacional de serviços, para conferir a coluna `codigo_servico`. */
    catalogo?: CatalogoDeServicos | null
  },
): Promise<LoteLido | PlanilhaRecusada> {
  const { donoId, conteudo, tipo, agora } = dados
  await expirarLotes(db, agora, { tenantIds: [donoId] })
  const hash = sha256(conteudo)
  const repetido = await loteComOMesmoArquivo(db, donoId, hash)
  if (repetido) return { ok: false, motivo: 'repetida', texto: textoDoArquivoRepetido(repetido), loteId: repetido.id }

  let grade: Celula[][]
  try {
    grade = await lerPlanilha(conteudo, tipo)
  } catch (error) {
    if (error instanceof MidiaGrandeDemais) return { ok: false, motivo: 'grande_demais', texto: TEXTOS_DO_LOTE.grandeDemais }
    if (error instanceof PlanilhaGrandeDemais) return { ok: false, motivo: 'aba_grande_demais', texto: TEXTOS_DO_LOTE.abaGrandeDemais }
    return { ok: false, motivo: 'ilegivel', texto: TEXTOS_DO_LOTE.ilegivel }
  }

  const empresas = await empresasDoDono(db, donoId)
  const planilha = interpretarGrade(grade, {
    prestadorObrigatorio: empresas.filter((e) => e.active).length > 1,
    contarCampos: tipo === 'csv' && separadorDoCsv(decodificarTexto(conteudo)) === ',',
  })
  if (!planilha.ok) {
    logEvent('agente.planilha_recusada', { tenant_id: donoId, erro: planilha.erro })
    if (planilha.erro === 'COLUNAS') return { ok: false, motivo: 'colunas', texto: textoDasColunas(planilha) }
    return planilha.erro === 'VAZIA'
      ? { ok: false, motivo: 'vazia', texto: TEXTOS_DO_LOTE.vazia }
      : { ok: false, motivo: 'linhas_demais', texto: TEXTOS_DO_LOTE.linhasDemais }
  }

  const contexto = await contextoDoBanco(db, empresas, agora)
  if (planilha.colunas.includes('codigo_servico')) contexto.codigosDaLista = await codigosDoCatalogo(dados.catalogo)
  const itens = validarLinhas(planilha.linhas, contexto)
  await completarEnderecos(itens, dados.consulta)
  const nome = nomeDoArquivo(dados.arquivo)
  const franquia = { limite: dados.limite, noMes: await notasDoMes(db, donoId, agora) }
  // Tudo o que pode falhar vem antes de gravar: se a mensagem falhar depois do lote gravado, a reentrega da Meta
  // cairia em "já foi enviada" sem a pessoa ter visto o resumo.
  const resumo = textoDoResumoDoLote({ arquivo: nome, itens, empresas, franquia })
  let loteId: string
  try {
    loteId = await gravarLote(db, { donoId, phoneId: dados.phoneId, arquivo: nome, hash, agora, itens })
  } catch (error) {
    // Duas mensagens com a mesma planilha ao mesmo tempo: o índice único deixa uma só passar.
    if (!ehViolacaoDeUnicidade(error)) throw error
    const outro = await loteComOMesmoArquivo(db, donoId, hash)
    return outro
      ? { ok: false, motivo: 'repetida', texto: textoDoArquivoRepetido(outro), loteId: outro.id }
      : { ok: false, motivo: 'indisponivel', texto: TEXTOS_DO_LOTE.semDownload }
  }
  const prontas = itens.filter((i) => !i.problema).length
  logEvent('agente.lote_recebido', { tenant_id: donoId, lote_id: loteId, linhas: itens.length, prontas, origem: dados.phoneId ? 'whatsapp' : 'painel' })
  return {
    ok: true,
    loteId,
    status: prontas ? 'aguardando_confirmacao' : 'descartado',
    arquivo: nome,
    itens,
    empresas,
    franquia,
    expiraEm: new Date(agora.getTime() + VALIDADE_DO_LOTE_MS),
    resumo,
  }
}

/** Os códigos da lista nacional, ou `null` sem catálogo ou com a lista fora do ar (aí só o formato é conferido). */
async function codigosDoCatalogo(catalogo: CatalogoDeServicos | null | undefined): Promise<Set<string> | null> {
  const itens = catalogo?.itens ? await catalogo.itens().catch(() => null) : null
  return itens && itens.size ? new Set(itens.keys()) : null
}

/**
 * Documento .xlsx/.csv de um telefone que emite. Conta de plano Escritório: baixa, lê, valida, grava o lote
 * (`aguardando_confirmacao`, 24 h) e responde o resumo. Outros planos: a resposta curta do plano.
 */
/** A consulta de CNPJ da conversa, se ela sabe buscar endereço. */
export const enderecoDaConsulta = (c: { endereco?: EnderecoDoTomador['endereco'] } | undefined): EnderecoDoTomador | null =>
  c?.endereco ? { endereco: (cnpj) => (c.endereco as EnderecoDoTomador['endereco'])(cnpj) } : null

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

  const lido = await lerLoteDaPlanilha(db, {
    donoId: dono.id,
    limite: dono.limite,
    phoneId: ctx.phoneId,
    arquivo: arquivo?.nome ?? null,
    conteudo,
    tipo,
    agora: ctx.agora,
    consulta: enderecoDaConsulta(ctx.deps.consultaCnpj),
    catalogo: ctx.deps.catalogo,
  })
  await responder(ctx, lido.ok ? lido.resumo : lido.texto)
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
    await responder(ctx, blocos(barradas, 'Nenhuma nota foi emitida. Corrija e mande a planilha de novo.'))
    return
  }
  await responder(
    ctx,
    mensagem({
      titulo: 'Planilha confirmada',
      blocos: [
        `Confirmado. Emitindo ${plural(resultado.emitindo, 'nota', 'notas')} na Sefin.`,
        barradas,
        // O retorno (CSV e, se couber, o .zip) vai por e-mail à conta; aqui só o aviso (PR #101, lote-retorno.ts).
        'Cada tomador com e-mail recebe a nota por e-mail. Quando todas fecharem, mando o retorno de cada linha para o e-mail da conta e te aviso aqui.',
        'Os PDFs também ficam em Minha conta → Relatórios.',
      ],
    }),

  )
}

