// Monta a DPS do leiaute nacional 1.01 (critério 4). Forma literal no Landing do checklist
// (lote 2b - DPS montada): prestador do Simples (ME/EPP ou MEI) emitindo a própria nota, tomador só com CPF
// ou CNPJ e nome (o CNPJ entrou no lote B2 do agente fiscal; XSD 1.01 `TCInfoPessoa`). O XML sai sem
// indentação: quem assina é o `xml-signer`, e o texto assinado não é reformatado.
//
// Reforma Tributária (pesquisa de 17/11/2026; XSD oficiais em `_tests/xsd/`):
// - Dois leiautes com o mesmo `versao="1.01"`. `v1.01` é o de produção (XSD de 09/02/2026, NT 004).
//   `nt009` é o release 1 da NT 009, em produção restrita desde 20/10/2026 e previsto para produção em
//   01/12/2026: `finNFSe` sai do IBSCBS e vira obrigatório em toda DPS, `cNBS` vem antes de `xDescServ`,
//   e CST/cClassTrib sobem de `gIBSCBS` para `IBSCBS/valores/trib`.
// - `cNBS` (0-1) vai quando a nota informa a NBS; com o IBSCBS ligado, também quando a tabela resolve.
// - O grupo IBSCBS é opcional para Simples e MEI em 2026 (Anexo I: obrigatório só a partir de 2027) e,
//   se enviado, exige todos os códigos (E0322 etc.). Fica atrás de `ibscbs` (desligado por padrão) e só
//   sai quando NBS, cIndOp e cClassTrib estão resolvidos; senão a DPS sai sem o grupo, como hoje.
import { ALIQUOTA_ISS_MAX, ALIQUOTA_ISS_MIN, enderecoValido, type EnderecoNacional } from './retencao.js'
import { nbsExiste, resolverRtc, type Rtc } from './rtc/resolver.js'
import type { SefinTenant } from './sefin.js'
import { el, leaf } from './xml.js'

export const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse'
export const LEIAUTE_VERSAO = '1.01'
export const VER_APLIC = 'NoFiscal-1.0'
/** `dhEmi` não pode passar da hora de processamento da Sefin (E0008): emitimos 60 s antes. */
export const DH_EMI_SKEW_MS = 60_000

export type DpsPayload = {
  /** `tag` é o elemento do leiaute: `<CPF>` ou `<CNPJ>`. */
  tomador: { tag: 'CPF' | 'CNPJ'; documento: string; nome: string; endereco: EnderecoNacional | null }
  /** `nbs`, `c_ind_op` e `c_class_trib` são opcionais: informados, mandam sobre a tabela (rtc/resolver.ts). */
  servico: {
    codigo_servico_nacional: string
    descricao: string
    nbs: string | null
    c_ind_op: string | null
    c_class_trib: string | null
  }
  valor: string
  /** Retenção (retencao.ts): ISS retido pelo tomador com a alíquota; INSS retido (vRetCP) em reais. */
  retencao: { iss: { aliquota: string } | null; inss: { valor: string } | null }
}

export class DpsInvalidError extends Error {
  readonly code = 'DPS_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'DpsInvalidError'
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function textField(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new DpsInvalidError(`${field} ausente`)
  const text = value.trim()
  if (text.length > max) throw new DpsInvalidError(`${field} passa de ${max} caracteres`)
  return text
}

/** Valida o `payload` gravado pela API contra os limites do leiaute (os da API são mais largos). */
export function parseDpsPayload(payload: unknown): DpsPayload {
  if (!isObject(payload) || !isObject(payload.tomador) || !isObject(payload.servico)) {
    throw new DpsInvalidError('payload sem tomador ou serviço')
  }
  const { cpf, cnpj } = payload.tomador
  if ((cpf === undefined) === (cnpj === undefined)) throw new DpsInvalidError('tomador deve ter CPF ou CNPJ, exatamente um')
  if (cpf !== undefined && (typeof cpf !== 'string' || !/^\d{11}$/.test(cpf))) {
    throw new DpsInvalidError('CPF do tomador deve ter 11 dígitos')
  }
  if (cnpj !== undefined && (typeof cnpj !== 'string' || !/^\d{14}$/.test(cnpj))) {
    throw new DpsInvalidError('CNPJ do tomador deve ter 14 dígitos')
  }
  const codigo = payload.servico.codigo_servico_nacional
  if (typeof codigo !== 'string' || !/^\d{6}$/.test(codigo)) {
    throw new DpsInvalidError('codigo_servico_nacional (cTribNac) deve ter 6 dígitos')
  }
  const valor = payload.valor
  if (typeof valor !== 'string' || !/^\d{1,13}\.\d{2}$/.test(valor) || Number(valor) <= 0) {
    throw new DpsInvalidError('valor deve ser decimal positivo com 2 casas')
  }
  let endereco: EnderecoNacional | null = null
  if (payload.tomador.endereco !== undefined && payload.tomador.endereco !== null) {
    endereco = enderecoValido(payload.tomador.endereco)
    if (!endereco) throw new DpsInvalidError('endereço do tomador inválido')
  }
  return {
    tomador: {
      tag: cnpj === undefined ? 'CPF' : 'CNPJ',
      documento: (cnpj ?? cpf) as string,
      nome: textField(payload.tomador.nome, 'nome do tomador', 150),
      endereco,
    },
    servico: {
      codigo_servico_nacional: codigo,
      descricao: textField(payload.servico.descricao, 'descrição do serviço', 2000),
      nbs: parseNbs(payload.servico.nbs),
      c_ind_op: codigo6(payload.servico.c_ind_op, 'c_ind_op (cIndOp)'),
      c_class_trib: codigo6(payload.servico.c_class_trib, 'c_class_trib (cClassTrib)'),
    },
    valor,
    retencao: parseRetencao(payload.retencao, valor),
  }
}

/** NBS com ou sem pontos (1.1502.10.00): 9 dígitos e na lista nacional, senão a Sefin recusa (E0316). */
export function parseNbs(bruto: unknown): string | null {
  if (bruto === undefined || bruto === null || bruto === '') return null
  if (typeof bruto !== 'string') throw new DpsInvalidError('NBS deve ser texto')
  const nbs = bruto.replace(/[.\s]/g, '')
  if (!/^\d{9}$/.test(nbs)) throw new DpsInvalidError('NBS deve ter 9 dígitos (ex.: 1.1502.10.00)')
  if (!nbsExiste(nbs)) throw new DpsInvalidError(`NBS ${bruto} não está na lista nacional (NBS 2.0)`)
  return nbs
}

function codigo6(bruto: unknown, campo: string): string | null {
  if (bruto === undefined || bruto === null || bruto === '') return null
  if (typeof bruto !== 'string' || !/^\d{6}$/.test(bruto)) throw new DpsInvalidError(`${campo} deve ter 6 dígitos`)
  return bruto
}

const centavos = (v: string) => {
  const [i, f = '0'] = v.split('.')
  return BigInt(i) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2))
}

/** `retencao` do payload: ausente = sem retenção. Formatos do leiaute (TSDec1V2 e TSDec15V2), E0595, E0699, E0428. */
function parseRetencao(bruto: unknown, valor: string): DpsPayload['retencao'] {
  if (bruto === undefined || bruto === null) return { iss: null, inss: null }
  if (!isObject(bruto)) throw new DpsInvalidError('retencao deve ser um objeto')
  let iss: { aliquota: string } | null = null
  if (bruto.iss !== undefined && bruto.iss !== null) {
    const aliquota = isObject(bruto.iss) ? bruto.iss.aliquota : undefined
    if (typeof aliquota !== 'string' || !/^\d\.\d{2}$/.test(aliquota)) {
      throw new DpsInvalidError('alíquota do ISS retido (pAliq) deve ter o formato 0.00')
    }
    const n = Number(aliquota)
    if (n < ALIQUOTA_ISS_MIN || n > ALIQUOTA_ISS_MAX) throw new DpsInvalidError('alíquota do ISS retido fora de 2%–5%')
    iss = { aliquota }
  }
  let inss: { valor: string } | null = null
  if (bruto.inss !== undefined && bruto.inss !== null) {
    const v = isObject(bruto.inss) ? bruto.inss.valor : undefined
    if (typeof v !== 'string' || !/^\d{1,13}\.\d{2}$/.test(v) || Number(v) <= 0) {
      throw new DpsInvalidError('INSS retido (vRetCP) deve ser decimal positivo com 2 casas')
    }
    // E0699: maior que zero e menor que o valor do serviço.
    if (centavos(v) >= centavos(valor)) throw new DpsInvalidError('INSS retido (vRetCP) deve ser menor que o valor do serviço')
    inss = { valor: v }
  }
  // E0428: o serviço cobre o ISS retido mais o INSS retido.
  const iss$ = iss ? (centavos(valor) * centavos(iss.aliquota) + 5000n) / 10000n : 0n
  if (iss$ + (inss ? centavos(inss.valor) : 0n) > centavos(valor)) throw new DpsInvalidError('retenções passam do valor do serviço')
  return { iss, inss }
}

function checkSerie(serie: string): number {
  if (!/^\d{1,5}$/.test(serie)) throw new DpsInvalidError('série deve ter de 1 a 5 dígitos')
  const value = Number(serie)
  // 00001–49999: faixa de aplicativo próprio (E0010).
  if (value < 1 || value > 49999) throw new DpsInvalidError('série fora da faixa 1–49999 de aplicativo próprio')
  return value
}

function checkNumero(numero: number): void {
  if (!Number.isSafeInteger(numero) || numero < 1 || numero > 999_999_999_999_999) {
    throw new DpsInvalidError('número da DPS fora de 1–999999999999999')
  }
}

function checkTenant(tenant: SefinTenant): void {
  if (!/^\d{14}$/.test(tenant.cnpj)) throw new DpsInvalidError('CNPJ do prestador deve ter 14 dígitos')
  if (!/^\d{7}$/.test(tenant.codigo_municipio_ibge)) throw new DpsInvalidError('código IBGE do município deve ter 7 dígitos')
}

/** Id da DPS: "DPS" + IBGE (7) + tipo de inscrição 2 (CNPJ) + CNPJ (14) + série (5) + número (15). */
export function buildIdDps(tenant: SefinTenant, serie: string, numero: number): string {
  checkTenant(tenant)
  checkSerie(serie)
  checkNumero(numero)
  return `DPS${tenant.codigo_municipio_ibge}2${tenant.cnpj}${serie.padStart(5, '0')}${String(numero).padStart(15, '0')}`
}

/** `AAAA-MM-DDThh:mm:ss-03:00` (São Paulo não tem horário de verão desde 2019). */
export function formatDhSaoPaulo(date: Date): string {
  return `${new Date(date.getTime() - 3 * 3600_000).toISOString().slice(0, 19)}-03:00`
}

export const tpAmbOf = (tenant: Pick<SefinTenant, 'ambiente'>): '1' | '2' => (tenant.ambiente === 'producao' ? '1' : '2')

function formatPercent(value: string | number | null): string {
  if (value === null || value === undefined || value === '') {
    throw new DpsInvalidError('percentual aproximado dos tributos do Simples (p_tot_trib_sn) não configurado')
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new DpsInvalidError('p_tot_trib_sn fora de 0–100')
  return n.toFixed(2)
}

export type LeiauteDps = 'v1.01' | 'nt009'
export type OpcoesDps = {
  /** `v1.01`: produção (XSD 09/02/2026). `nt009`: NT 009 release 1 (produção restrita desde 20/10/2026). */
  leiaute: LeiauteDps
  /** Monta o grupo IBSCBS (e o cNBS da tabela). Desligado: só o cNBS informado na nota. */
  ibscbs: boolean
}

/**
 * Produção restrita já roda a NT 009 (XSD de 20/10/2026). Produção troca quando
 * `NOFISCAL_DPS_LEIAUTE=nt009` (data prevista: 01/12/2026). IBSCBS só com `NOFISCAL_DPS_IBSCBS=1`.
 */
export function opcoesDpsDoAmbiente(
  tenant: Pick<SefinTenant, 'ambiente'>,
  env: Record<string, string | undefined> = process.env,
): OpcoesDps {
  const nt009 = tenant.ambiente === 'producao_restrita' || env.NOFISCAL_DPS_LEIAUTE === 'nt009'
  return { leiaute: nt009 ? 'nt009' : 'v1.01', ibscbs: env.NOFISCAL_DPS_IBSCBS === '1' }
}

export type BuildDpsInput = {
  tenant: SefinTenant
  serie: string
  numero: number
  payload: unknown
  /** Relógio do motor; `dhEmi` = agora − 60 s. */
  now: Date
  /** Padrão: leiaute de produção, sem IBSCBS (a DPS de antes desta mudança). */
  opcoes?: OpcoesDps
}

const OPCOES_PADRAO: OpcoesDps = { leiaute: 'v1.01', ibscbs: false }

/** `infDPS/IBSCBS` de prestador do Simples ou MEI, serviço no país, tomador = destinatário. */
function grupoIbsCbs(leiaute: LeiauteDps, g: { cIndOp: string; cst: string; cClassTrib: string }): string {
  const classif = [leaf('CST', g.cst), leaf('cClassTrib', g.cClassTrib)]
  // indDest 0: o destinatário é o próprio tomador. indFinal (0-1) fica de fora: o motor não sabe se é
  // uso ou consumo pessoal (art. 57 da LC 214/2025). Alíquotas e valores quem calcula é a Sefin.
  return leiaute === 'nt009'
    ? el('IBSCBS', [leaf('cIndOp', g.cIndOp), leaf('indDest', '0'), el('valores', el('trib', classif))])
    : el('IBSCBS', [
        leaf('finNFSe', '0'),
        leaf('cIndOp', g.cIndOp),
        leaf('indDest', '0'),
        el('valores', el('trib', el('gIBSCBS', classif))),
      ])
}

export function buildDps({ tenant, serie, numero, payload, now, opcoes = OPCOES_PADRAO }: BuildDpsInput): {
  id: string
  xml: string
  /** NBS e classificação resolvidas, para quem precisar explicar por que o grupo foi ou não. */
  rtc: Rtc
} {
  const data = parseDpsPayload(payload)
  const id = buildIdDps(tenant, serie, numero)
  // E0202: o tomador não pode ser o próprio prestador.
  if (data.tomador.tag === 'CNPJ' && data.tomador.documento === tenant.cnpj) {
    throw new DpsInvalidError('tomador é o próprio prestador')
  }
  const im = tenant.inscricao_municipal?.trim() || null
  if (im !== null && im.length > 15) throw new DpsInvalidError('inscrição municipal passa de 15 caracteres')
  const dhEmi = formatDhSaoPaulo(new Date(now.getTime() - DH_EMI_SKEW_MS))
  const ibge = tenant.codigo_municipio_ibge
  // MEI (Anexo I v1.01): opSimpNac 2, sem regApTribSN (E0162), regEspTrib 0 (E0174) e sem pTotTribSN
  // (E0710); no lugar, indTotTrib 0 (não informar tributos aproximados, Decreto 8.264/2014).
  const mei = tenant.regime === 'mei'
  const regTrib = mei
    ? [leaf('opSimpNac', '2'), leaf('regEspTrib', '0')]
    : [leaf('opSimpNac', '3'), leaf('regApTribSN', '1'), leaf('regEspTrib', '0')]
  const totTrib = mei ? leaf('indTotTrib', '0') : leaf('pTotTribSN', formatPercent(tenant.p_tot_trib_sn))

  const { iss, inss } = data.retencao
  // MEI não tem retenção: nem ISS (E0583) nem o grupo tribFed (E0676).
  if (mei && (iss || inss)) throw new DpsInvalidError('MEI não tem retenção de ISS nem de INSS')
  const end = data.tomador.endereco
  if (iss) {
    // E0237: ISS retido pelo tomador exige o endereço nacional dele. Tomador CPF: E0667 (decisão de 16/11/2026).
    if (data.tomador.tag !== 'CNPJ') throw new DpsInvalidError('ISS retido só para tomador com CNPJ')
    if (!end) throw new DpsInvalidError('ISS retido exige o endereço do tomador')
  }
  const tomaEnd = end
    ? el('end', [
        el('endNac', [leaf('cMun', end.cMun), leaf('CEP', end.cep)]),
        leaf('xLgr', end.logradouro),
        leaf('nro', end.numero),
        leaf('xCpl', end.complemento ?? null),
        leaf('xBairro', end.bairro),
      ])
    : null
  // Sem retenção, pAliq fica de fora (E0625); com ISS retido de ME/EPP, é obrigatório (E0621/E0628).
  const tribMun = iss
    ? el('tribMun', [leaf('tribISSQN', '1'), leaf('tpRetISSQN', '2'), leaf('pAliq', iss.aliquota)])
    : el('tribMun', [leaf('tribISSQN', '1'), leaf('tpRetISSQN', '1')])
  const tribFed = inss ? el('tribFed', leaf('vRetCP', inss.valor)) : null

  const { leiaute } = opcoes
  const rtc = resolverRtc(data.servico.codigo_servico_nacional, {
    nbs: data.servico.nbs,
    cIndOp: data.servico.c_ind_op,
    cClassTrib: data.servico.c_class_trib,
  })
  // A NBS informada na nota vai sempre; a da tabela, só junto do IBSCBS.
  const cNBS = rtc.nbs && (rtc.nbs.origem === 'nota' || opcoes.ibscbs) ? leaf('cNBS', rtc.nbs.codigo) : null
  const ibscbs = opcoes.ibscbs && 'cst' in rtc.ibscbs ? grupoIbsCbs(leiaute, rtc.ibscbs) : null
  const cTribNac = leaf('cTribNac', data.servico.codigo_servico_nacional)
  const xDescServ = leaf('xDescServ', data.servico.descricao)
  const cServ = el('cServ', leiaute === 'nt009' ? [cTribNac, cNBS, xDescServ] : [cTribNac, xDescServ, cNBS])

  const infDps = el(
    'infDPS',
    [
      leaf('tpAmb', tpAmbOf(tenant)),
      leaf('dhEmi', dhEmi),
      leaf('verAplic', VER_APLIC),
      leaf('serie', serie),
      leaf('nDPS', String(numero)),
      leaf('dCompet', dhEmi.slice(0, 10)),
      leaf('tpEmit', '1'),
      leiaute === 'nt009' ? leaf('finNFSe', '0') : null,
      leaf('cLocEmi', ibge),
      el('prest', [
        leaf('CNPJ', tenant.cnpj),
        leaf('IM', im),
        el('regTrib', regTrib),
      ]),
      el('toma', [leaf(data.tomador.tag, data.tomador.documento), leaf('xNome', data.tomador.nome), tomaEnd]),
      el('serv', [
        el('locPrest', leaf('cLocPrestacao', ibge)),
        cServ,
      ]),
      el('valores', [
        el('vServPrest', leaf('vServ', data.valor)),
        el('trib', [tribMun, tribFed, el('totTrib', totTrib)]),
      ]),
      ibscbs,
    ],
    { Id: id },
  )
  return { id, xml: el('DPS', infDps, { xmlns: NFSE_NAMESPACE, versao: LEIAUTE_VERSAO }), rtc }
}
