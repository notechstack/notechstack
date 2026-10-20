// Monta a DPS do leiaute nacional 1.01 (critério 4). Forma literal no Landing do checklist
// (lote 2b - DPS montada): prestador do Simples emitindo a própria nota, tomador PF só com CPF
// e nome, sem endereço do tomador e sem o grupo IBSCBS. O XML sai sem indentação: quem assina
// é o `xml-signer`, e o texto assinado não é reformatado.
import type { SefinTenant } from './sefin.js'
import { el, leaf } from './xml.js'

export const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse'
export const LEIAUTE_VERSAO = '1.01'
export const VER_APLIC = 'NoFiscal-1.0'
/** `dhEmi` não pode passar da hora de processamento da Sefin (E0008): emitimos 60 s antes. */
export const DH_EMI_SKEW_MS = 60_000

export type DpsPayload = {
  tomador: { cpf: string; nome: string }
  servico: { codigo_servico_nacional: string; descricao: string }
  valor: string
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
  const cpf = payload.tomador.cpf
  if (typeof cpf !== 'string' || !/^\d{11}$/.test(cpf)) throw new DpsInvalidError('CPF do tomador deve ter 11 dígitos')
  const codigo = payload.servico.codigo_servico_nacional
  if (typeof codigo !== 'string' || !/^\d{6}$/.test(codigo)) {
    throw new DpsInvalidError('codigo_servico_nacional (cTribNac) deve ter 6 dígitos')
  }
  const valor = payload.valor
  if (typeof valor !== 'string' || !/^\d{1,13}\.\d{2}$/.test(valor) || Number(valor) <= 0) {
    throw new DpsInvalidError('valor deve ser decimal positivo com 2 casas')
  }
  return {
    tomador: { cpf, nome: textField(payload.tomador.nome, 'nome do tomador', 150) },
    servico: { codigo_servico_nacional: codigo, descricao: textField(payload.servico.descricao, 'descrição do serviço', 2000) },
    valor,
  }
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

export type BuildDpsInput = {
  tenant: SefinTenant
  serie: string
  numero: number
  payload: unknown
  /** Relógio do motor; `dhEmi` = agora − 60 s. */
  now: Date
}

export function buildDps({ tenant, serie, numero, payload, now }: BuildDpsInput): { id: string; xml: string } {
  const data = parseDpsPayload(payload)
  const id = buildIdDps(tenant, serie, numero)
  const im = tenant.inscricao_municipal?.trim() || null
  if (im !== null && im.length > 15) throw new DpsInvalidError('inscrição municipal passa de 15 caracteres')
  const dhEmi = formatDhSaoPaulo(new Date(now.getTime() - DH_EMI_SKEW_MS))
  const ibge = tenant.codigo_municipio_ibge

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
      leaf('cLocEmi', ibge),
      el('prest', [
        leaf('CNPJ', tenant.cnpj),
        leaf('IM', im),
        el('regTrib', [leaf('opSimpNac', '3'), leaf('regApTribSN', '1'), leaf('regEspTrib', '0')]),
      ]),
      el('toma', [leaf('CPF', data.tomador.cpf), leaf('xNome', data.tomador.nome)]),
      el('serv', [
        el('locPrest', leaf('cLocPrestacao', ibge)),
        el('cServ', [leaf('cTribNac', data.servico.codigo_servico_nacional), leaf('xDescServ', data.servico.descricao)]),
      ]),
      el('valores', [
        el('vServPrest', leaf('vServ', data.valor)),
        el('trib', [
          el('tribMun', [leaf('tribISSQN', '1'), leaf('tpRetISSQN', '1')]),
          el('totTrib', leaf('pTotTribSN', formatPercent(tenant.p_tot_trib_sn))),
        ]),
      ]),
    ],
    { Id: id },
  )
  return { id, xml: el('DPS', infDps, { xmlns: NFSE_NAMESPACE, versao: LEIAUTE_VERSAO }) }
}
