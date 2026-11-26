// NF-e modelo 55, leiaute 4.00 (Pacote de Liberação 010h v1.03, Portal Nacional, nov/2026). Monta o <NFe> sem
// assinatura: a assinatura (rsa-sha1, c14n, Reference "#NFe<chave>") vem depois, em nfe-signer.ts.
// Escopo desta versão (.design/agente-fiscal-nfe.md): emitente de qualquer UF no Simples Nacional (CRT 1) ou MEI
// (CRT 4), venda ou remessa (natureza da operação pelo CFOP, natureza.ts) interna ou interestadual, vários itens, destinatário PF/PJ, frete, pagamento. ICMS
// por CSOSN 101/102/103/300/400/500; PIS/COFINS sem valor (CST 49, 99 ou 07/08/09). Transporte: modalidade do frete,
// transportador e volumes (grupo transp, sem retenção de ICMS do transporte nem veículo). Sem ST calculada, sem DIFAL,
// sem exportação. A ordem dos elementos segue o XSD; o teste valida contra ele.
import { randomInt } from 'node:crypto'
import { el, leaf } from '../xml.js'
import { cnpjValido, cpfValido } from '../agente/documentos.js'
import { CODIGO_UF, TP_AMB, UFS, type AmbienteNfe, type Uf } from './autorizadores.js'
import { MUNICIPIOS_IBGE } from './municipios-ibge.js'
import { avisosDaNatureza, LIMITE_NATUREZA, naturezaDaNota } from './natureza.js'

export const VERSAO_NFE = '4.00'
export const NS_NFE = 'http://www.portalfiscal.inf.br/nfe'
/** Exigência do leiaute para o nome do destinatário em homologação (rejeição 598). */
export const NOME_HOMOLOGACAO = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'

export type Endereco = {
  logradouro: string
  numero: string
  complemento?: string | null
  bairro: string
  /** Código IBGE do município, 7 dígitos. */
  codigoMunicipio: string
  uf: Uf
  cep: string
  fone?: string | null
}

export type Emitente = {
  cnpj: string
  razaoSocial: string
  nomeFantasia?: string | null
  inscricaoEstadual: string
  /** 1 Simples Nacional, 4 MEI. */
  crt: '1' | '4'
  endereco: Endereco
}

export type Destinatario = {
  /** CPF (11) ou CNPJ (14), só dígitos ou formatado. */
  documento: string
  nome: string
  /** 1 contribuinte com IE, 2 contribuinte isento, 9 não contribuinte. */
  indicadorIE: '1' | '2' | '9'
  inscricaoEstadual?: string | null
  email?: string | null
  endereco: Endereco
}

export type Csosn = '101' | '102' | '103' | '300' | '400' | '500'
export type CstPisCofins = '07' | '08' | '09' | '49' | '99'

export type Item = {
  codigo: string
  descricao: string
  ncm: string
  cest?: string | null
  cfop: string
  unidade: string
  quantidade: number
  valorUnitario: number
  /** Origem da mercadoria (0 nacional … 8). */
  origem?: string
  csosn: Csosn
  /** Só no CSOSN 101: alíquota do crédito do Simples (%). */
  aliquotaCreditoSN?: number | null
  cstPisCofins?: CstPisCofins
  gtin?: string | null
  frete?: number | null
  seguro?: number | null
  desconto?: number | null
  outros?: number | null
  informacoes?: string | null
}

export type Pagamento = {
  /** 01 dinheiro, 03 crédito, 04 débito, 15 boleto, 17 PIX, 90 sem pagamento, 99 outros. */
  forma: string
  valor: number
  descricao?: string | null
  /** 0 à vista, 1 a prazo. */
  indicador?: '0' | '1' | null
}

export type ModalidadeFrete = '0' | '1' | '2' | '3' | '4' | '9'
export const MODALIDADES_FRETE: Record<ModalidadeFrete, string> = {
  '0': 'Por conta do emitente (CIF)',
  '1': 'Por conta do destinatário (FOB)',
  '2': 'Por conta de terceiros',
  '3': 'Transporte próprio do remetente',
  '4': 'Transporte próprio do destinatário',
  '9': 'Sem frete',
}

/** Grupo transporta: todos os campos são opcionais no leiaute; vai ao XML o que estiver preenchido. */
export type Transportador = {
  /** CNPJ (14) ou CPF (11). */
  documento?: string | null
  nome?: string | null
  /** Inscrição estadual (só dígitos) ou "ISENTO". */
  inscricaoEstadual?: string | null
  /** Endereço completo numa linha (xEnder). */
  endereco?: string | null
  municipio?: string | null
  uf?: Uf | string | null
}

/** Grupo vol: um por volume transportado (ou um com a soma). */
export type Volume = {
  quantidade?: number | null
  especie?: string | null
  marca?: string | null
  numeracao?: string | null
  /** Em kg, até 3 casas. */
  pesoLiquido?: number | null
  pesoBruto?: number | null
}

export type ResponsavelTecnico = { cnpj: string; contato: string; email: string; fone: string }

export type NfeInput = {
  ambiente: AmbienteNfe
  emitente: Emitente
  destinatario: Destinatario
  itens: Item[]
  serie: number
  numero: number
  emissao: Date
  /** Natureza da operação (natOp). Sem ela, sai do CFOP dos itens (natureza.ts). */
  naturezaOperacao?: string | null
  /** 0 normal, 1 consumidor final. Padrão: 1 se o destinatário não é contribuinte, senão 0. */
  consumidorFinal?: '0' | '1'
  /** 1 presencial, 2 internet, 3 teleatendimento, 9 outros, 0 não se aplica. */
  presenca?: '0' | '1' | '2' | '3' | '4' | '5' | '9'
  /** 0 emitente (CIF), 1 destinatário (FOB), 2 terceiros, 3 próprio remetente, 4 próprio destinatário, 9 sem frete. */
  modalidadeFrete?: ModalidadeFrete
  transportador?: Transportador | null
  volumes?: Volume[] | null
  pagamentos: Pagamento[]
  informacoesComplementares?: string | null
  responsavelTecnico?: ResponsavelTecnico | null
  /** Código numérico de 8 dígitos da chave; sorteado quando ausente (nos testes, fixo). */
  codigoNumerico?: string
  versaoAplicativo?: string
}

export type NfeMontada = {
  xml: string
  chave: string
  id: string
  totais: { produtos: number; frete: number; seguro: number; desconto: number; outros: number; nota: number }
}

export class NfeInvalidaError extends Error {
  readonly code = 'NFE_INVALIDA'
  constructor(readonly problemas: string[]) {
    super(`NF-e inválida: ${problemas.join('; ')}`)
    this.name = 'NfeInvalidaError'
  }
}

export const soDigitos = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')

/**
 * O TString do leiaute só aceita Latin-1 (U+0020 a U+00FF): travessão, aspas tipográficas, reticências e emoji dão
 * rejeição 225 (falha de schema) e queimam o número. Troca os comuns pelo equivalente e tira o resto.
 */
export function latin1(s: string): string {
  return s
    .normalize('NFC')
    // TAB, CR e separadores de linha viram espaço (o txt() junta os espaços depois); nada de palavra grudada.
    .replace(/[\t\r\u2028\u2029]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u20AC/g, 'EUR')
    .replace(/\u2122/g, 'TM')
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ')
    .replace(/[^\u0020-\u00FF\n]/g, '')
}


/** O texto como vai ao XML (Latin-1, espaços juntados); a validação olha este, não o texto cru. */
export const limpo = (s: string | null | undefined) => latin1(s ?? '').replace(/\s+/g, ' ').trim()
const vazio = (s: string | null | undefined) => limpo(s) === ''

/** UFs cuja Sefaz não aceita destinatário "contribuinte isento" (indIEDest 2): rejeição 805. */
export const UFS_SEM_ISENTO = new Set(['AM', 'BA', 'CE', 'GO', 'MG', 'MS', 'MT', 'PE', 'RN', 'SE', 'SP'])

/**
 * Série da empresa: 0 a 888. O web service aceita até 889 para emitente com CNPJ (890+ é avulsa, SCAN ou pessoa
 * física: rejeição 266); a 889 fica para a nota de teste da conferência (conferencia.ts), para não disputar número com
 * a empresa em homologação.
 */
export const SERIE_MAXIMA = 888
/** Limite do web service para emitente com CNPJ (validado em toda nota, inclusive a de teste). */
export const SERIE_MAXIMA_WEB_SERVICE = 889

/** Dígito verificador GS1 (GTIN-8/12/13/14): módulo 10, pesos 3 e 1 da direita para a esquerda. */
export function gtinValido(gtin: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(gtin)) return false
  const corpo = gtin.slice(0, -1)
  let soma = 0
  for (let i = 0; i < corpo.length; i++) soma += Number(corpo[corpo.length - 1 - i]) * (i % 2 === 0 ? 3 : 1)
  return (10 - (soma % 10)) % 10 === Number(gtin.slice(-1))
}

// --- números ---------------------------------------------------------------------------------------------------

/** Valor em reais para centavos inteiros, arredondado meio para cima. */
export const centavos = (reais: number) => Math.round(reais * 100 + (reais >= 0 ? 1e-7 : -1e-7))
const dec2 = (cents: number) => (cents / 100).toFixed(2)
/** Até `max` casas, sem zeros à direita além de `min`. */
function decN(value: number, min: number, max: number): string {
  let text = value.toFixed(max)
  while (text.includes('.') && text.split('.')[1].length > min && text.endsWith('0')) text = text.slice(0, -1)
  return text
}

// --- chave de acesso -------------------------------------------------------------------------------------------

/** Dígito verificador da chave (módulo 11, pesos 2 a 9 da direita para a esquerda). */
export function digitoChave(chave43: string): string {
  let soma = 0
  let peso = 2
  for (let i = chave43.length - 1; i >= 0; i--) {
    soma += Number(chave43[i]) * peso
    peso = peso === 9 ? 2 : peso + 1
  }
  const resto = soma % 11
  return resto < 2 ? '0' : String(11 - resto)
}

export function montarChave(p: {
  uf: Uf
  emissao: Date
  cnpj: string
  serie: number
  numero: number
  tpEmis: string
  codigoNumerico: string
}): string {
  const { ano, mes } = partesBrasilia(p.emissao)
  const base =
    CODIGO_UF[p.uf] +
    ano.slice(2) +
    mes +
    soDigitos(p.cnpj).padStart(14, '0') +
    '55' +
    String(p.serie).padStart(3, '0') +
    String(p.numero).padStart(9, '0') +
    p.tpEmis +
    p.codigoNumerico
  return base + digitoChave(base)
}

/** cNF: 8 dígitos, diferente do número da nota (rejeição 539/236 em algumas UFs quando iguais). */
export function sortearCodigoNumerico(numero: number): string {
  for (;;) {
    const c = String(randomInt(0, 100_000_000)).padStart(8, '0')
    if (c !== String(numero).padStart(8, '0')) return c
  }
}

// --- datas -----------------------------------------------------------------------------------------------------

/** Data e hora no fuso de Brasília (-03:00, sem horário de verão desde 2019), no formato TDateTimeUTC. */
export function dataHoraBrasilia(date: Date): string {
  const p = partesBrasilia(date)
  return `${p.ano}-${p.mes}-${p.dia}T${p.hora}:${p.minuto}:${p.segundo}-03:00`
}
function partesBrasilia(date: Date) {
  const d = new Date(date.getTime() - 3 * 3600_000)
  const two = (n: number) => String(n).padStart(2, '0')
  return {
    ano: String(d.getUTCFullYear()),
    mes: two(d.getUTCMonth() + 1),
    dia: two(d.getUTCDate()),
    hora: two(d.getUTCHours()),
    minuto: two(d.getUTCMinutes()),
    segundo: two(d.getUTCSeconds()),
  }
}

// --- validação -------------------------------------------------------------------------------------------------

/** Erros de preenchimento em português, por campo; vazio quando a nota pode ser montada. */
export function validarNfe(input: NfeInput): string[] {
  const p: string[] = []
  const e = input.emitente
  const d = input.destinatario
  if (soDigitos(e.cnpj).length !== 14) p.push('emitente: CNPJ deve ter 14 dígitos')
  if (!/^\d{2,14}$/.test(soDigitos(e.inscricaoEstadual))) p.push('emitente: inscrição estadual obrigatória para NF-e')
  validarEndereco('emitente', e.endereco, p, true)
  const doc = soDigitos(d.documento)
  if (doc.length !== 11 && doc.length !== 14) p.push('destinatário: CPF ou CNPJ inválido')
  if (vazio(d.nome)) p.push('destinatário: nome obrigatório')
  if (d.indicadorIE === '1' && !/^\d{2,14}$/.test(soDigitos(d.inscricaoEstadual))) {
    p.push('destinatário: contribuinte (indicador 1) precisa de inscrição estadual')
  }
  if (doc.length === 11 && d.indicadorIE === '1') p.push('destinatário: pessoa física não pode ser contribuinte com IE nesta versão')
  if (d.indicadorIE === '2' && UFS_SEM_ISENTO.has(d.endereco.uf)) {
    p.push(`destinatário: a Sefaz de ${d.endereco.uf} não aceita contribuinte isento; informe a IE do destinatário ou deixe a IE vazia (não contribuinte)`)
  }
  validarEndereco('destinatário', d.endereco, p, false)
  if (input.itens.length === 0) p.push('a nota precisa de pelo menos um item')
  if (input.itens.length > 990) p.push('a NF-e aceita no máximo 990 itens')
  const interestadual = e.endereco.uf !== d.endereco.uf
  input.itens.forEach((item, i) => {
    const n = `item ${i + 1}`
    if (vazio(item.codigo)) p.push(`${n}: código do produto obrigatório`)
    if (vazio(item.descricao)) p.push(`${n}: descrição obrigatória`)
    if (!/^(\d{8}|00)$/.test(soDigitos(item.ncm))) p.push(`${n}: NCM deve ter 8 dígitos`)
    if (item.cest && !/^\d{7}$/.test(soDigitos(item.cest))) p.push(`${n}: CEST deve ter 7 dígitos`)
    const cfop = soDigitos(item.cfop)
    if (!/^\d{4}$/.test(cfop)) p.push(`${n}: CFOP deve ter 4 dígitos`)
    else if (interestadual && cfop[0] !== '6') p.push(`${n}: operação interestadual pede CFOP 6xxx`)
    else if (!interestadual && cfop[0] !== '5') p.push(`${n}: operação dentro do estado pede CFOP 5xxx`)
    if (!(item.quantidade > 0)) p.push(`${n}: quantidade deve ser maior que zero`)
    if (!(item.valorUnitario > 0)) p.push(`${n}: valor unitário deve ser maior que zero`)
    if (vazio(item.unidade) || limpo(item.unidade).length > 6) p.push(`${n}: unidade de 1 a 6 caracteres`)
    if (!['101', '102', '103', '300', '400', '500'].includes(item.csosn)) p.push(`${n}: CSOSN não suportado (${item.csosn})`)
    if (item.csosn === '101' && !(Number(item.aliquotaCreditoSN) > 0)) p.push(`${n}: CSOSN 101 pede a alíquota do crédito`)
    if (item.origem && !/^[0-8]$/.test(item.origem)) p.push(`${n}: origem da mercadoria de 0 a 8`)
    if (item.gtin && !gtinValido(item.gtin)) p.push(`${n}: GTIN inválido (8, 12, 13 ou 14 dígitos com o dígito verificador certo)`)
    if (item.desconto && centavos(item.desconto) >= centavos(item.quantidade * item.valorUnitario)) {
      p.push(`${n}: desconto maior ou igual ao valor do produto`)
    }
  })
  validarTransporte(input, p)
  if ((input.naturezaOperacao ?? '').replace(/\s+/g, ' ').trim().length > LIMITE_NATUREZA) p.push(`natureza da operação: até ${LIMITE_NATUREZA} caracteres`)
  if (input.pagamentos.length === 0) p.push('informe a forma de pagamento')
  for (const pag of input.pagamentos) {
    if (!/^\d{2}$/.test(pag.forma)) p.push(`pagamento: forma "${pag.forma}" inválida`)
    if (pag.forma === '99' && vazio(pag.descricao)) p.push('pagamento: forma 99 (outros) pede a descrição')
  }
  if (!(Number.isInteger(input.serie) && input.serie >= 0 && input.serie <= SERIE_MAXIMA_WEB_SERVICE)) p.push(`série de 0 a ${SERIE_MAXIMA_WEB_SERVICE}`)
  if (!(input.numero >= 1 && input.numero <= 999_999_999)) p.push('número de 1 a 999.999.999')
  if (p.length === 0) {
    const total = calcularTotais(input.itens).nota
    const pago = input.pagamentos.reduce((s, x) => s + centavos(x.valor), 0)
    const semPagamento = input.pagamentos.every((x) => x.forma === '90')
    if (!semPagamento && pago < total) p.push(`pagamento (R$ ${dec2(pago)}) menor que o total da nota (R$ ${dec2(total)})`)
  }
  return p
}

/** Transportador com algum campo preenchido (o grupo vazio não vai ao XML). */
export function temTransportador(t: Transportador | null | undefined): t is Transportador {
  return !!t && [t.documento, t.nome, t.inscricaoEstadual, t.endereco, t.municipio, t.uf].some((v) => !vazio(v))
}
/** Volume com algum campo preenchido (zero conta como preenchido nos números). */
export function temVolume(v: Volume | null | undefined): v is Volume {
  return !!v && ([v.especie, v.marca, v.numeracao].some((x) => !vazio(x)) || [v.quantidade, v.pesoLiquido, v.pesoBruto].some((x) => x !== null && x !== undefined))
}
export const volumesDaNota = (input: Pick<NfeInput, 'volumes'>) => (input.volumes ?? []).filter(temVolume)
/** Peso em kg com até 3 casas (TDec_1203). */
const pesoValido = (x: number | null | undefined) =>
  x === null || x === undefined || (Number.isFinite(x) && x >= 0 && x < 1e12 && Math.abs(x * 1000 - Math.round(x * 1000)) < 1e-6)

function validarTransporte(input: NfeInput, p: string[]) {
  const mod = input.modalidadeFrete
  if (mod !== undefined && mod !== null && !(mod in MODALIDADES_FRETE)) p.push(`modalidade do frete "${mod}" inválida (0, 1, 2, 3, 4 ou 9)`)
  const t = input.transportador
  if (temTransportador(t)) {
    if (mod === undefined || mod === null) {
      p.push('transportador informado: informe também a modalidade do frete (0 emitente, 1 destinatário, 2 terceiros, 3 próprio remetente, 4 próprio destinatário)')
    }
    const doc = soDigitos(t.documento)
    if (doc && !(doc.length === 14 ? cnpjValido(doc) : doc.length === 11 && cpfValido(doc))) p.push('transportador: CPF ou CNPJ inválido')
    const nome = limpo(t.nome)
    if (nome && nome.length < 2) p.push('transportador: nome com pelo menos 2 letras')
    const ie = limpo(t.inscricaoEstadual)
    if (ie && !/^isento$/i.test(ie) && !/^\d{2,14}$/.test(soDigitos(ie))) p.push('transportador: inscrição estadual de 2 a 14 dígitos (ou ISENTO)')
    if (ie && !doc) p.push('transportador: a inscrição estadual pede o CPF ou CNPJ do transportador')
    if (!vazio(t.uf) && !UFS.includes(limpo(t.uf).toUpperCase() as Uf)) p.push(`transportador: UF "${limpo(t.uf)}" inválida`)
  }
  const vols = volumesDaNota(input)
  if (vols.length > 5000) p.push('a NF-e aceita no máximo 5.000 volumes')
  vols.forEach((v, i) => {
    const n = vols.length > 1 ? `volume ${i + 1}` : 'volumes'
    if (v.quantidade !== null && v.quantidade !== undefined && !(Number.isInteger(v.quantidade) && v.quantidade >= 0 && v.quantidade < 1e15)) {
      p.push(`${n}: quantidade de volumes deve ser um número inteiro, zero ou mais`)
    }
    if (!pesoValido(v.pesoLiquido)) p.push(`${n}: peso líquido deve ser zero ou mais, com até 3 casas (kg)`)
    if (!pesoValido(v.pesoBruto)) p.push(`${n}: peso bruto deve ser zero ou mais, com até 3 casas (kg)`)
  })
}

/**
 * Avisos que não impedem a nota (a Sefaz aceita), mas costumam ser erro de digitação: peso bruto menor que o líquido,
 * transportador sem nome ou sem documento, modalidade "sem frete" com transportador.
 */
/** Peso para texto em português: 60,4 kg. */
export const kg = (x: number) => `${x.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg`

export function avisosNfe(
  input: Pick<NfeInput, 'transportador' | 'volumes' | 'modalidadeFrete'> & Partial<Pick<NfeInput, 'itens' | 'naturezaOperacao' | 'pagamentos'>>,
): string[] {
  const a: string[] = avisosDaNatureza(input)
  volumesDaNota(input).forEach((v, i, vols) => {
    const n = vols.length > 1 ? `volume ${i + 1}` : 'volumes'
    if (v.pesoLiquido != null && v.pesoBruto != null && v.pesoBruto < v.pesoLiquido) {
      a.push(`${n}: peso bruto (${kg(v.pesoBruto)}) menor que o peso líquido (${kg(v.pesoLiquido)}); confira`)
    }
  })
  const t = input.transportador
  if (temTransportador(t)) {
    if (vazio(t.nome)) a.push('transportador sem nome (razão social)')
    if (!soDigitos(t.documento)) a.push('transportador sem CPF ou CNPJ')
    if (input.modalidadeFrete === '9') a.push('modalidade "sem frete" (9) com transportador informado; confira a modalidade')
  }
  return a
}

function validarEndereco(quem: string, end: Endereco, p: string[], cepObrigatorio: boolean) {
  if (vazio(end.logradouro)) p.push(`${quem}: logradouro obrigatório`)
  if (vazio(end.numero)) p.push(`${quem}: número do endereço obrigatório (use "S/N")`)
  if (vazio(end.bairro)) p.push(`${quem}: bairro obrigatório`)
  const cMun = soDigitos(end.codigoMunicipio)
  if (!MUNICIPIOS_IBGE[cMun]) p.push(`${quem}: código IBGE do município "${end.codigoMunicipio}" não existe`)
  else if (!CODIGO_UF[end.uf] || cMun.slice(0, 2) !== CODIGO_UF[end.uf]) p.push(`${quem}: município ${cMun} não é de ${end.uf}`)
  const cep = soDigitos(end.cep)
  if ((cepObrigatorio || cep) && cep.length !== 8) p.push(`${quem}: CEP deve ter 8 dígitos`)
}

// --- totais ----------------------------------------------------------------------------------------------------

const valorProduto = (item: Item) => centavos(item.quantidade * item.valorUnitario)

export function calcularTotais(itens: Item[]) {
  const soma = (f: (i: Item) => number) => itens.reduce((s, i) => s + f(i), 0)
  const produtos = soma(valorProduto)
  const frete = soma((i) => centavos(i.frete ?? 0))
  const seguro = soma((i) => centavos(i.seguro ?? 0))
  const desconto = soma((i) => centavos(i.desconto ?? 0))
  const outros = soma((i) => centavos(i.outros ?? 0))
  return { produtos, frete, seguro, desconto, outros, nota: produtos - desconto + frete + seguro + outros }
}

// --- montagem --------------------------------------------------------------------------------------------------

/** Texto do leiaute: sem quebras e espaços duplicados, cortado no tamanho máximo do campo. */
const txt = (s: string, max: number) => latin1(s).replace(/\s+/g, ' ').trim().slice(0, max)
/** Opcional: some quando não sobra texto depois de sanear (um campo vazio daria a mesma rejeição 225). */
const opt = (s: string | null | undefined, max: number) => (s && txt(s, max) ? txt(s, max) : null)

function endereco(tag: string, end: Endereco): string {
  const cMun = soDigitos(end.codigoMunicipio)
  return el(tag, [
    leaf('xLgr', txt(end.logradouro, 60)),
    leaf('nro', txt(end.numero, 60)),
    leaf('xCpl', opt(end.complemento, 60)),
    leaf('xBairro', txt(end.bairro, 60)),
    leaf('cMun', cMun),
    leaf('xMun', MUNICIPIOS_IBGE[cMun]),
    leaf('UF', end.uf),
    soDigitos(end.cep) ? leaf('CEP', soDigitos(end.cep)) : null,
    leaf('cPais', '1058'),
    leaf('xPais', 'Brasil'),
    soDigitos(end.fone).length >= 6 ? leaf('fone', soDigitos(end.fone).slice(0, 14)) : null,
  ])
}

/** vCredICMSSN do item (centavos): alíquota do crédito sobre o valor do produto, arredondado no item. */
const creditoDoItem = (item: Item) => centavos((valorProduto(item) / 100) * (Number(item.aliquotaCreditoSN) / 100))

// --- crédito do Simples (CSOSN 101) nas informações complementares ---------------------------------------------
// Art. 23 da LC 123/2006 e art. 59 da Resolução CGSN 140/2018: com CSOSN 101, o documento traz a frase do crédito com
// o valor e a alíquota. O valor é a SOMA dos vCredICMSSN dos itens (o que o destinatário escritura), não a alíquota
// sobre o total: na NF-e 4081 da POLI BOX, 8 itens a 2,84% somam R$ 33,47, e 2,84% de R$ 1.178,75 daria R$ 33,48.
// Decisão (24/11/2026): itens com alíquotas diferentes levam o total e as alíquotas em ordem crescente, "às alíquotas de
// 2,56% e 3,95%"; não se quebra o crédito por alíquota (a lei pede o valor do crédito e a alíquota aplicada).

export type CreditoSn = { centavos: number; aliquotas: number[] }

/** Crédito do Simples da nota (null sem item com CSOSN 101). */
export function creditoIcmsSn(itens: Item[]): CreditoSn | null {
  const com = itens.filter((i) => i.csosn === '101' && Number(i.aliquotaCreditoSN) > 0)
  if (com.length === 0) return null
  const aliquotas = [...new Set(com.map((i) => Number(i.aliquotaCreditoSN)))].sort((a, b) => a - b)
  return { centavos: com.reduce((s, i) => s + creditoDoItem(i), 0), aliquotas }
}

const reaisBr = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const percentualBr = (x: number) => `${decN(x, 2, 4).replace('.', ',')}%`
const listaBr = (xs: string[]) => (xs.length === 1 ? xs[0] : `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`)

/** "Permite o aproveitamento do crédito de ICMS no valor de R$ X, correspondente à alíquota de Y%" (sem o fim). */
function nucleoDaFrase(c: CreditoSn): string {
  const aliq = listaBr(c.aliquotas.map(percentualBr))
  return `Permite o aproveitamento do crédito de ICMS no valor de R$ ${reaisBr(c.centavos)}, correspondente ${c.aliquotas.length > 1 ? 'às alíquotas' : 'à alíquota'} de ${aliq}`
}

/** Para os resumos antes de emitir: "R$ 33,47 (alíquota de 2,84%)"; null sem item com CSOSN 101. */
export function resumoCreditoSn(itens: Item[]): string | null {
  const c = creditoIcmsSn(itens)
  if (!c) return null
  return `R$ ${reaisBr(c.centavos)} (${c.aliquotas.length > 1 ? 'alíquotas de' : 'alíquota de'} ${listaBr(c.aliquotas.map(percentualBr))})`
}

/** A frase completa, como vai quando o texto do usuário não a traz. */
export function fraseCreditoSn(c: CreditoSn): string {
  return `${nucleoDaFrase(c)}, nos termos do art. 23 da LC 123/2006.`
}

// A frase como o usuário costuma escrever (com ou sem acento, maiúsculas, "R$0,00", "à/a/às alíquota(s)"): o valor e as
// alíquotas que vierem são trocados pelos calculados; o resto do texto fica como está.
const FRASE_CREDITO =
  /permite\s+o\s+aproveitamento\s+do\s+cr[eé]dito\s+de\s+icms\s+no\s+valor\s+de\s+r\$\s*[\d.,]*\s*,?\s*correspondente\s+(?:[aà]s?\s+)?al[ií]quotas?\s+de\s+[\d.,]*\s*%(?:\s*(?:,|e)\s*[\d.,]+\s*%)*/giu

/** A frase com o fim "nos termos do art. 23 da LC 123/2006" (para tirá-la inteira quando vai para o início). */
const FRASE_CREDITO_INTEIRA = new RegExp(
  String.raw`${FRASE_CREDITO.source}(?:\s*,?\s*nos\s+termos\s+do\s+art\.?\s*23[^.]*(?:\.\d+[^.]*)*)?\.?`,
  'giu',
)

const LIMITE_INF_CPL = 5000
/** Mesmo saneamento do txt() da montagem, sem cortar: o limite é aplicado aqui, protegendo a frase. */
const sanear = (s: string) => latin1(s).replace(/\s+/g, ' ').trim()

/**
 * Informações complementares que vão ao XML (infCpl). Sem item com CSOSN 101, o texto do usuário como está. Com 101:
 * se o texto já traz a frase do crédito, o valor e a alíquota são trocados pelos calculados; se não traz, a frase vai
 * no início, antes do texto do usuário. A frase nunca é cortada pelo limite de 5.000 caracteres: corta-se o texto do usuário.
 */
export function informacoesComplementaresDaNota(texto: string | null | undefined, itens: Item[]): string | null {
  const usuario = sanear(texto ?? '')
  const credito = creditoIcmsSn(itens)
  if (!credito) return usuario ? usuario.slice(0, LIMITE_INF_CPL) : null
  const nucleo = nucleoDaFrase(credito)
  let achou = false
  const trocado = usuario.replace(FRASE_CREDITO, (m) => {
    achou = true
    return m === m.toUpperCase() ? nucleo.toUpperCase() : nucleo
  })
  if (achou && sanear(trocado).length <= LIMITE_INF_CPL) return sanear(trocado)
  // Sem a frase (ou com ela e o texto passando do limite): a frase completa no início e o resto do texto depois.
  const frase = sanear(fraseCreditoSn(credito))
  const resto = sanear(usuario.replace(FRASE_CREDITO_INTEIRA, '').replace(/^[\s.,;:-]+/, '').replace(/\s+([.,;])/g, '$1'))
  if (!resto) return frase
  return `${frase} ${resto}`.slice(0, LIMITE_INF_CPL).trim()
}

function icms(item: Item): string {
  const orig = item.origem ?? '0'
  switch (item.csosn) {
    case '101': {
      const credito = creditoDoItem(item)
      return el('ICMS', el('ICMSSN101', [
        leaf('orig', orig),
        leaf('CSOSN', '101'),
        leaf('pCredSN', decN(Number(item.aliquotaCreditoSN), 2, 4)),
        leaf('vCredICMSSN', dec2(credito)),
      ]))
    }
    case '500':
      return el('ICMS', el('ICMSSN500', [leaf('orig', orig), leaf('CSOSN', '500')]))
    default:
      return el('ICMS', el('ICMSSN102', [leaf('orig', orig), leaf('CSOSN', item.csosn)]))
  }
}

function pisCofins(tag: 'PIS' | 'COFINS', cst: CstPisCofins): string {
  if (cst === '07' || cst === '08' || cst === '09') return el(tag, el(`${tag}NT`, leaf('CST', cst)))
  const aliq = tag === 'PIS' ? 'pPIS' : 'pCOFINS'
  const valor = tag === 'PIS' ? 'vPIS' : 'vCOFINS'
  return el(tag, el(`${tag}Outr`, [leaf('CST', cst), leaf('vBC', '0.00'), leaf(aliq, '0.0000'), leaf(valor, '0.00')]))
}

function detalhe(item: Item, n: number): string {
  const gtin = item.gtin ? item.gtin : 'SEM GTIN'
  const qCom = decN(item.quantidade, 4, 4)
  const vUn = decN(item.valorUnitario, 2, 10)
  const unidade = txt(item.unidade, 6)
  const cst = item.cstPisCofins ?? '49'
  return el(
    'det',
    [
      el('prod', [
        leaf('cProd', txt(item.codigo, 60)),
        leaf('cEAN', gtin),
        leaf('xProd', txt(item.descricao, 120)),
        leaf('NCM', soDigitos(item.ncm)),
        item.cest ? leaf('CEST', soDigitos(item.cest)) : null,
        leaf('CFOP', soDigitos(item.cfop)),
        leaf('uCom', unidade),
        leaf('qCom', qCom),
        leaf('vUnCom', vUn),
        leaf('vProd', dec2(valorProduto(item))),
        leaf('cEANTrib', gtin),
        leaf('uTrib', unidade),
        leaf('qTrib', qCom),
        leaf('vUnTrib', vUn),
        item.frete ? leaf('vFrete', dec2(centavos(item.frete))) : null,
        item.seguro ? leaf('vSeg', dec2(centavos(item.seguro))) : null,
        item.desconto ? leaf('vDesc', dec2(centavos(item.desconto))) : null,
        item.outros ? leaf('vOutro', dec2(centavos(item.outros))) : null,
        leaf('indTot', '1'),
      ]),
      el('imposto', [icms(item), pisCofins('PIS', cst), pisCofins('COFINS', cst)]),
      leaf('infAdProd', opt(item.informacoes, 500)),
    ],
    { nItem: String(n) },
  )
}

const peso = (x: number | null | undefined) => (x === null || x === undefined ? null : x.toFixed(3))

function grupoTransp(input: NfeInput, freteCentavos: number): string {
  const tr = input.transportador
  let transporta: string | null = null
  if (temTransportador(tr)) {
    const doc = soDigitos(tr.documento)
    const ie = limpo(tr.inscricaoEstadual)
    transporta = el('transporta', [
      doc.length === 14 ? leaf('CNPJ', doc) : doc.length === 11 ? leaf('CPF', doc) : null,
      leaf('xNome', opt(tr.nome, 60)),
      ie ? leaf('IE', /^isento$/i.test(ie) ? 'ISENTO' : soDigitos(ie)) : null,
      leaf('xEnder', opt(tr.endereco, 60)),
      leaf('xMun', opt(tr.municipio, 60)),
      vazio(tr.uf) ? null : leaf('UF', limpo(tr.uf).toUpperCase()),
    ])
  }
  const vols = volumesDaNota(input).map((v) =>
    el('vol', [
      v.quantidade === null || v.quantidade === undefined ? null : leaf('qVol', String(v.quantidade)),
      leaf('esp', opt(v.especie, 60)),
      leaf('marca', opt(v.marca, 60)),
      leaf('nVol', opt(v.numeracao, 60)),
      leaf('pesoL', peso(v.pesoLiquido)),
      leaf('pesoB', peso(v.pesoBruto)),
    ]),
  )
  return el('transp', [leaf('modFrete', input.modalidadeFrete ?? (freteCentavos > 0 ? '0' : '9')), transporta, ...vols])
}

export function montarNfe(input: NfeInput): NfeMontada {
  const problemas = validarNfe(input)
  if (problemas.length) throw new NfeInvalidaError(problemas)
  const e = input.emitente
  const d = input.destinatario
  const tpEmis = '1'
  const codigoNumerico = input.codigoNumerico ?? sortearCodigoNumerico(input.numero)
  const chave = montarChave({
    uf: e.endereco.uf,
    emissao: input.emissao,
    cnpj: e.cnpj,
    serie: input.serie,
    numero: input.numero,
    tpEmis,
    codigoNumerico,
  })
  const id = `NFe${chave}`
  const t = calcularTotais(input.itens)
  const idDest = e.endereco.uf === d.endereco.uf ? '1' : '2'
  const consumidorFinal = input.consumidorFinal ?? (d.indicadorIE === '9' ? '1' : '0')
  const docDest = soDigitos(d.documento)
  const nomeDest = input.ambiente === 'homologacao' ? NOME_HOMOLOGACAO : txt(d.nome, 60)

  const ide = el('ide', [
    leaf('cUF', CODIGO_UF[e.endereco.uf]),
    leaf('cNF', codigoNumerico),
    leaf('natOp', txt(naturezaDaNota(input.itens, input.naturezaOperacao).natureza, LIMITE_NATUREZA)),
    leaf('mod', '55'),
    leaf('serie', String(input.serie)),
    leaf('nNF', String(input.numero)),
    leaf('dhEmi', dataHoraBrasilia(input.emissao)),
    leaf('tpNF', '1'),
    leaf('idDest', idDest),
    leaf('cMunFG', soDigitos(e.endereco.codigoMunicipio)),
    leaf('tpImp', '1'),
    leaf('tpEmis', tpEmis),
    leaf('cDV', chave.slice(-1)),
    leaf('tpAmb', TP_AMB[input.ambiente]),
    leaf('finNFe', '1'),
    leaf('indFinal', consumidorFinal),
    leaf('indPres', input.presenca ?? '9'),
    // NT 2020.006 (rejeição 434): com indPres 2, 3, 4 ou 9, o indicativo de intermediador é obrigatório. 0 = operação sem
    // intermediador (venda no site ou na loja da própria empresa).
    ['2', '3', '4', '9'].includes(input.presenca ?? '9') ? leaf('indIntermed', '0') : null,
    leaf('procEmi', '0'),
    // Sem marca (white label, 17/11/2026): o XML chega ao cliente final do parceiro.
    leaf('verProc', txt(input.versaoAplicativo ?? 'Emissor NF-e 1.0', 20)),
  ])

  const emit = el('emit', [
    leaf('CNPJ', soDigitos(e.cnpj)),
    leaf('xNome', txt(e.razaoSocial, 60)),
    leaf('xFant', opt(e.nomeFantasia, 60)),
    endereco('enderEmit', e.endereco),
    leaf('IE', soDigitos(e.inscricaoEstadual)),
    leaf('CRT', e.crt),
  ])

  const dest = el('dest', [
    docDest.length === 14 ? leaf('CNPJ', docDest) : leaf('CPF', docDest),
    leaf('xNome', nomeDest),
    endereco('enderDest', d.endereco),
    leaf('indIEDest', d.indicadorIE),
    d.indicadorIE === '1' ? leaf('IE', soDigitos(d.inscricaoEstadual)) : null,
    leaf('email', opt(d.email, 60)),
  ])

  const zero = '0.00'
  const total = el('total', el('ICMSTot', [
    leaf('vBC', zero),
    leaf('vICMS', zero),
    leaf('vICMSDeson', zero),
    leaf('vFCP', zero),
    leaf('vBCST', zero),
    leaf('vST', zero),
    leaf('vFCPST', zero),
    leaf('vFCPSTRet', zero),
    leaf('vProd', dec2(t.produtos)),
    leaf('vFrete', dec2(t.frete)),
    leaf('vSeg', dec2(t.seguro)),
    leaf('vDesc', dec2(t.desconto)),
    leaf('vII', zero),
    leaf('vIPI', zero),
    leaf('vIPIDevol', zero),
    leaf('vPIS', zero),
    leaf('vCOFINS', zero),
    leaf('vOutro', dec2(t.outros)),
    leaf('vNF', dec2(t.nota)),
  ]))

  const transp = grupoTransp(input, t.frete)

  const pago = input.pagamentos.reduce((s, x) => s + centavos(x.valor), 0)
  const pag = el('pag', [
    ...input.pagamentos.map((x) =>
      el('detPag', [
        x.indicador ? leaf('indPag', x.indicador) : null,
        leaf('tPag', x.forma),
        x.forma === '99' ? leaf('xPag', txt(x.descricao ?? '', 60)) : null,
        leaf('vPag', dec2(x.forma === '90' ? 0 : centavos(x.valor))),
      ]),
    ),
    pago > t.nota && input.pagamentos.every((x) => x.forma !== '90') ? leaf('vTroco', dec2(pago - t.nota)) : null,
  ])

  const infCpl = informacoesComplementaresDaNota(input.informacoesComplementares, input.itens)
  const infAdic = infCpl ? el('infAdic', leaf('infCpl', txt(infCpl, LIMITE_INF_CPL))) : null

  const rt = input.responsavelTecnico
  const infRespTec = rt
    ? el('infRespTec', [
        leaf('CNPJ', soDigitos(rt.cnpj)),
        leaf('xContato', txt(rt.contato, 60)),
        leaf('email', txt(rt.email, 60)),
        leaf('fone', soDigitos(rt.fone)),
      ])
    : null

  const infNFe = el(
    'infNFe',
    [ide, emit, dest, ...input.itens.map((item, i) => detalhe(item, i + 1)), total, transp, pag, infAdic, infRespTec],
    { Id: id, versao: VERSAO_NFE },
  )
  return { xml: el('NFe', infNFe, { xmlns: NS_NFE }), chave, id, totais: { ...t } }
}
