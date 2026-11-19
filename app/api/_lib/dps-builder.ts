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
// - `cNBS` (0-1): `servico.nbs` da nota > NBS padrão da empresa (`tenant.nbs_padrao`) > Anexo VIII pelo código.
//   As duas primeiras vão sempre; a da tabela, só com o IBSCBS ligado.
// - O grupo IBSCBS é opcional para Simples e MEI em 2026 (Anexo I: obrigatório só a partir de 2027) e,
//   se enviado, exige todos os códigos (E0322 etc.). Fica atrás de `ibscbs` (desligado por padrão) e só
//   sai quando NBS, cIndOp e cClassTrib estão resolvidos; senão a DPS sai sem o grupo, como hoje.
// - `servico.municipio_prestacao_ibge` (local-prestacao.ts) vira `serv/locPrest/cLocPrestacao`; sem ele, o município da
//   empresa, como sempre. A Sefin calcula a incidência do ISS pelo código (E1317); com o local informado, o IBSCBS só
//   sai se o `cIndOp` vier na nota.
// - Lucro Presumido e Real (Lucca, 19/11/2026; pesquisa em side-session-notes/…/presumido-nt009-fontes.md): `opSimpNac 1`,
//   sem `regApTribSN` (E0162), `regEspTrib 0`; `totTrib/pTotTrib` (E0713 proíbe indTotTrib e pTotTribSN); sem `pAliq`
//   mesmo com ISS retido (E0617: só municípios de convênio ativo e emissor nacional pleno são atendidos). IRRF e
//   PIS/COFINS/CSLL retidos vão em `tribFed` (vRetIRRF; piscofins CST 01 + tpRetPisCofins 3 + vRetCSLL com a soma).
// - `informacoes_complementares` do payload vira `serv/infoCompl/xInfComp` (info-complementar.ts), o último filho
//   de `serv` nos dois leiautes. Sem o campo, a DPS sai igual à de antes, byte a byte.
import { lerInfoComplementar, MAX_INFO_COMPLEMENTAR } from './info-complementar.js'
import { lerMunicipioPrestacao } from './local-prestacao.js'
import { ALIQUOTA_ISS_MAX, ALIQUOTA_ISS_MIN, enderecoValido, type EnderecoNacional } from './retencao.js'
import { nbsExiste, resolverRtc, type Rtc } from './rtc/resolver.js'
import type { SefinTenant } from './sefin.js'
import { el, leaf } from './xml.js'

export const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse'
export const LEIAUTE_VERSAO = '1.01'
// Versão do aplicativo na DPS e nos eventos (até 20 caracteres). Sem marca (white label, 17/11/2026): o XML chega ao
// cliente final do parceiro.
export const VER_APLIC = 'EmissorNFSe-1.0'
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
    /** `cLocPrestacao` (local-prestacao.ts): IBGE de 7 dígitos; `null` = município da empresa. */
    municipio_prestacao_ibge: string | null
  }
  valor: string
  /**
   * Retenção (retencao.ts): ISS retido pelo tomador com a alíquota; INSS retido (vRetCP) em reais. Só Presumido e Real:
   * IRRF retido (vRetIRRF) e PIS/COFINS/CSLL retidos (`csrf`, a soma das três, em vRetCSLL), em reais.
   */
  retencao: {
    iss: { aliquota: string } | null
    inss: { valor: string } | null
    irrf: { valor: string } | null
    csrf: { valor: string } | null
  }
  /** `xInfComp` (TSDescInfCompl), já normalizado; `null` = sem o grupo `infoCompl`. */
  informacoes_complementares: string | null
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
      municipio_prestacao_ibge: parseMunicipioPrestacao(payload.servico.municipio_prestacao_ibge),
    },
    valor,
    retencao: parseRetencao(payload.retencao, valor),
    informacoes_complementares: parseInfoComplementar(payload.informacoes_complementares),
  }
}

function parseMunicipioPrestacao(bruto: unknown): string | null {
  const lido = lerMunicipioPrestacao(bruto)
  if (!lido.ok) throw new DpsInvalidError(`municipio_prestacao_ibge (cLocPrestacao) ${lido.erro}`)
  return lido.ibge
}

function parseInfoComplementar(bruto: unknown): string | null {
  if (bruto === undefined || bruto === null) return null
  if (typeof bruto !== 'string') throw new DpsInvalidError('informacoes_complementares deve ser texto')
  const lida = lerInfoComplementar(bruto)
  if (!lida.ok) throw new DpsInvalidError(`informacoes_complementares passa de ${MAX_INFO_COMPLEMENTAR} caracteres`)
  return lida.texto
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

function valorRetido(bruto: unknown, valor: string, campo: string): { valor: string } | null {
  if (bruto === undefined || bruto === null) return null
  const v = isObject(bruto) ? bruto.valor : undefined
  if (typeof v !== 'string' || !/^\d{1,13}\.\d{2}$/.test(v) || Number(v) <= 0) {
    throw new DpsInvalidError(`${campo} deve ser decimal positivo com 2 casas`)
  }
  // E0699, E0700, E0701: maior que zero e menor que o valor do serviço.
  if (centavos(v) >= centavos(valor)) throw new DpsInvalidError(`${campo} deve ser menor que o valor do serviço`)
  return { valor: v }
}

/** `retencao` do payload: ausente = sem retenção. Formatos do leiaute (TSDec1V2 e TSDec15V2), E0595, E0699, E0428. */
function parseRetencao(bruto: unknown, valor: string): DpsPayload['retencao'] {
  if (bruto === undefined || bruto === null) return { iss: null, inss: null, irrf: null, csrf: null }
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
  const irrf = valorRetido(bruto.irrf, valor, 'IRRF retido (vRetIRRF)')
  const csrf = valorRetido(bruto.csrf, valor, 'PIS/COFINS/CSLL retidos (vRetCSLL)')
  // E0428/E1506: o serviço cobre todas as retenções.
  const iss$ = iss ? (centavos(valor) * centavos(iss.aliquota) + 5000n) / 10000n : 0n
  const soma = [inss, irrf, csrf].reduce((t, r) => t + (r ? centavos(r.valor) : 0n), iss$)
  if (soma > centavos(valor)) throw new DpsInvalidError('retenções passam do valor do serviço')
  return { iss, inss, irrf, csrf }
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

/** Presumido ou Real: prestador não optante do Simples (`opSimpNac 1`). */
export const regimeNaoOptante = (regime: string | null | undefined): boolean => regime === 'presumido' || regime === 'real'

/**
 * A empresa tem os percentuais que a DPS do regime dela exige? MEI não informa nenhum (indTotTrib 0); Simples, o
 * pTotTribSN; Presumido e Real, o federal e o municipal do pTotTrib (o estadual, sem valor, é 0). Mesma regra de
 * `nofiscal.dados_fiscais_completos` no banco.
 */
export function tributosConfigurados(
  t: Pick<SefinTenant, 'regime' | 'p_tot_trib_sn' | 'p_tot_trib'>,
): boolean {
  if (t.regime === 'mei') return true
  if (regimeNaoOptante(t.regime)) return Boolean(t.p_tot_trib && t.p_tot_trib.fed !== null && t.p_tot_trib.mun !== null)
  return t.p_tot_trib_sn !== null && t.p_tot_trib_sn !== undefined
}

/** Linha de `fiscal_tenants` (colunas `p_tot_trib_fed/est/mun`, texto) → `SefinTenant.p_tot_trib`. */
export function pTotTribDaLinha(row: {
  p_tot_trib_fed?: string | null
  p_tot_trib_est?: string | null
  p_tot_trib_mun?: string | null
}): SefinTenant['p_tot_trib'] {
  if (row.p_tot_trib_fed === null || row.p_tot_trib_fed === undefined) return null
  return { fed: row.p_tot_trib_fed, est: row.p_tot_trib_est ?? null, mun: row.p_tot_trib_mun ?? null }
}

/** `pTotTrib` (TSDec3V2): percentual de 0 a 100 com 2 casas. */
function percentualTotTrib(value: string | null | undefined, esfera: string): string {
  if (value === null || value === undefined || value === '') {
    throw new DpsInvalidError(`percentual aproximado dos tributos ${esfera} (Lei 12.741/2012) não configurado`)
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new DpsInvalidError(`percentual aproximado dos tributos ${esfera} fora de 0–100`)
  return n.toFixed(2)
}

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

/** Entrada da NT 009 em produção (notícia da CGNFS-e de 20/10/2026): 01/12/2026, 00:00 em Brasília. */
export const VIRADA_NT009 = new Date('2026-12-01T00:00:00-03:00')

/**
 * Leiaute da DPS (virada da NT 009, Lucca, 19/11/2026; method `nofiscal-virada-nt009`):
 * - produção restrita: sempre `nt009` (XSD de 20/10/2026);
 * - produção: `nt009` a partir de `VIRADA_NT009`, `v1.01` antes;
 * - `NOFISCAL_DPS_LEIAUTE` manda sobre a data, nos dois sentidos: `v1.01` é o rollback (a Sefin adiou ou rejeita o
 *   leiaute novo) e `nt009` antecipa. Outro valor é ignorado.
 * IBSCBS só com `NOFISCAL_DPS_IBSCBS=1` (opcional em 2026 para todos os regimes: a ausência não rejeita).
 */
export function opcoesDpsDoAmbiente(
  tenant: Pick<SefinTenant, 'ambiente'>,
  env: Record<string, string | undefined> = process.env,
  agora: Date = new Date(),
): OpcoesDps {
  const forcado = env.NOFISCAL_DPS_LEIAUTE === 'nt009' || env.NOFISCAL_DPS_LEIAUTE === 'v1.01' ? env.NOFISCAL_DPS_LEIAUTE : null
  const leiaute: LeiauteDps =
    tenant.ambiente === 'producao_restrita' ? 'nt009' : (forcado ?? (agora.getTime() >= VIRADA_NT009.getTime() ? 'nt009' : 'v1.01'))
  return { leiaute, ibscbs: env.NOFISCAL_DPS_IBSCBS === '1' }
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
  const naoOptante = regimeNaoOptante(tenant.regime)
  if (!mei && !naoOptante && tenant.regime !== 'simples') throw new DpsInvalidError(`regime ${tenant.regime} não atendido`)
  const regTrib = mei
    ? [leaf('opSimpNac', '2'), leaf('regEspTrib', '0')]
    : naoOptante
      ? [leaf('opSimpNac', '1'), leaf('regEspTrib', '0')]
      : [leaf('opSimpNac', '3'), leaf('regApTribSN', '1'), leaf('regEspTrib', '0')]
  const totTrib = mei
    ? leaf('indTotTrib', '0')
    : naoOptante
      ? el('pTotTrib', [
          leaf('pTotTribFed', percentualTotTrib(tenant.p_tot_trib?.fed, 'federais')),
          leaf('pTotTribEst', percentualTotTrib(tenant.p_tot_trib?.est ?? '0', 'estaduais')),
          leaf('pTotTribMun', percentualTotTrib(tenant.p_tot_trib?.mun, 'municipais')),
        ])
      : leaf('pTotTribSN', formatPercent(tenant.p_tot_trib_sn))

  const { iss, inss, irrf, csrf } = data.retencao
  // MEI não tem retenção: nem ISS (E0583) nem o grupo tribFed (E0676).
  if (mei && (iss || inss || irrf || csrf)) throw new DpsInvalidError('MEI não tem retenção de ISS nem de INSS')
  // IRRF e PIS/COFINS/CSLL retidos na fonte são do Presumido e do Real (o Simples recolhe pelo DAS).
  if (!naoOptante && (irrf || csrf)) throw new DpsInvalidError('IRRF e PIS/COFINS/CSLL retidos só para Lucro Presumido ou Real')
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
  // Sem retenção, pAliq fica de fora (E0625); com ISS retido de ME/EPP, é obrigatório (E0621/E0628). Não optante nunca
  // leva pAliq: o convênio dos municípios atendidos está ativo e a Sefin usa a alíquota municipal (E0617).
  const tribMun = iss
    ? el('tribMun', [leaf('tribISSQN', '1'), leaf('tpRetISSQN', '2'), naoOptante ? null : leaf('pAliq', iss.aliquota)])
    : el('tribMun', [leaf('tribISSQN', '1'), leaf('tpRetISSQN', '1')])
  // TCTribFederal: piscofins, vRetCP, vRetIRRF, vRetCSLL. PIS/COFINS/CSLL retidos: CST 01 (tributável, alíquota básica),
  // tpRetPisCofins 3 e a soma das três em vRetCSLL (E0724; nota do Anexo I). Sem base nem alíquotas: são 0-1 e nenhuma
  // regra as exige com CST 01; informadas, teriam de bater com E0694/E0696.
  const piscofins = csrf ? el('piscofins', [leaf('CST', '01'), leaf('tpRetPisCofins', '3')]) : null
  const tribFed =
    inss || irrf || csrf
      ? el('tribFed', [piscofins, leaf('vRetCP', inss?.valor ?? null), leaf('vRetIRRF', irrf?.valor ?? null), leaf('vRetCSLL', csrf?.valor ?? null)])
      : null

  const { leiaute } = opcoes
  // NBS padrão da empresa fora da lista atual (a lista mudou depois de gravada) fica de fora, sem travar a nota.
  const nbsEmpresa = tenant.nbs_padrao && nbsExiste(tenant.nbs_padrao) ? tenant.nbs_padrao : null
  const rtc = resolverRtc(data.servico.codigo_servico_nacional, {
    nbs: data.servico.nbs,
    nbsEmpresa,
    cIndOp: data.servico.c_ind_op,
    cClassTrib: data.servico.c_class_trib,
  })
  // A NBS informada (na nota ou como padrão da empresa) vai sempre; a da tabela, só junto do IBSCBS.
  const cNBS = rtc.nbs && (rtc.nbs.origem !== 'tabela' || opcoes.ibscbs) ? leaf('cNBS', rtc.nbs.codigo) : null
  // Outro local da prestação: o cIndOp da tabela supõe o local padrão, e o local muda a localidade do IBS/CBS (E1521,
  // Anexo B). Sem o cIndOp informado na nota, a DPS sai sem o grupo, que é opcional para Simples e MEI em 2026.
  const local = data.servico.municipio_prestacao_ibge
  const ibscbsPermitido = !local || data.servico.c_ind_op !== null
  const ibscbs = opcoes.ibscbs && ibscbsPermitido && 'cst' in rtc.ibscbs ? grupoIbsCbs(leiaute, rtc.ibscbs) : null
  const cTribNac = leaf('cTribNac', data.servico.codigo_servico_nacional)
  const xDescServ = leaf('xDescServ', data.servico.descricao)
  const cServ = el('cServ', leiaute === 'nt009' ? [cTribNac, cNBS, xDescServ] : [cTribNac, xDescServ, cNBS])
  // TCServ: locPrest, cServ, comExt, obra, atvEvento, infoCompl (igual nos dois XSD). Em TCInfoCompl, xInfComp é o
  // último (depois de idDocTec, docRef, xPed e gItemPed, que a nó não usa).
  const infoCompl = data.informacoes_complementares ? el('infoCompl', leaf('xInfComp', data.informacoes_complementares)) : null

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
        el('locPrest', leaf('cLocPrestacao', local ?? ibge)),
        cServ,
        infoCompl,
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
