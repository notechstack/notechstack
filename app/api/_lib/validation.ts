// Corpo de `POST /v1/nfse`, forma literal no Landing do checklist (lote 2a - corpo), ampliada para o parceiro
// (18/11/2026): `cnpj_prestador` (qual empresa da conta emite), `tomador.email`, `servico` opcional (vale o código da
// empresa e a descrição padrão) e `retencao` (vale o padrão da empresa quando ausente).
// Campo desconhecido em qualquer nível é recusado: é assim que nenhuma rota aceita PFX
// ou senha por engano (critério 31) e que um erro de digitação da Prontia aparece logo.
// Tomador: `cpf` (11 dígitos) ou `cnpj` (14 dígitos), exatamente um dos dois (Landing de
// .checks/agente-fiscal-whatsapp.md, lote B2 - tomador pessoa jurídica).
// Tomador não informado (consumidor não identificado, 27/11/2026; tomador-nao-informado.ts): `"tomador_nao_informado": true`
// e nenhum `tomador`. Sem os dois, o pedido é recusado (ninguém emite sem tomador por esquecimento).

import { normalizarEmail } from './agente/normalizacao.js'
import { lerEnderecoEscrito } from './endereco-tomador.js'
import { DpsInvalidError, parseNbs } from './dps-builder.js'
import { lerInfoComplementar, MAX_INFO_COMPLEMENTAR } from './info-complementar.js'
import { lerMunicipioPrestacao } from './local-prestacao.js'
import { lerObra, type Obra } from './obra.js'
import type { EnderecoNacional, Retencao, RetencaoDoPedido } from './retencao.js'

export type TomadorPayload = { cpf: string; nome: string } | { cnpj: string; nome: string }

export type InvoicePayload = {
  /** Ausente só com `tomador_nao_informado: true`. */
  tomador?: TomadorPayload & { email?: string; endereco?: EnderecoNacional }
  tomador_nao_informado?: true
  /** `nbs`, `c_ind_op` e `c_class_trib`: Reforma Tributária (IBS/CBS), opcionais; ver dps-builder.ts. */
  servico: {
    codigo_servico_nacional: string
    descricao: string
    nbs?: string
    c_ind_op?: string
    c_class_trib?: string
    /** `cLocPrestacao` (local-prestacao.ts): IBGE de 7 dígitos. Ausente = município da empresa. */
    municipio_prestacao_ibge?: string
    /** `serv/obra` (obra.ts): `{ cno }` ou o endereço. Obrigatório nos códigos de construção civil (E0370). */
    obra?: Record<string, string>
    /** `IBSCBS/imovel` ou `bensMoveis` (locacao.ts): `{ imovel }` ou `{ bens }`, nos códigos 99.03.01 e 99.04.01. */
    locacao?: Record<string, unknown>
  }
  valor: string
  /** Resolvida por retencao.ts (agente, painel e API) a partir do padrão da empresa e do pedido. */
  retencao?: Retencao
  /** `serv/infoCompl/xInfComp` (info-complementar.ts): dados bancários, observações. Ausente = sem o grupo. */
  informacoes_complementares?: string
}

export type NewInvoice = { external_id: string; payload: InvoicePayload; origem?: 'api' }

/** O pedido lido do corpo; o payload final (com o código da empresa e a retenção resolvida) sai na rota. */
export type PedidoDaApi = {
  external_id: string
  cnpj_prestador: string | null
  /** `endereco`: o informado (prevalece sobre o da Receita; com CPF, o único). Ausente = a Receita (CNPJ) ou nenhum. */
  /** `null` = tomador não informado (`tomador_nao_informado: true` no corpo). */
  tomador: { documento: string; nome: string; email: string | null; endereco?: EnderecoNacional | null } | null
  servico: {
    codigo: string | null
    descricao: string | null
    nbs?: string
    c_ind_op?: string
    c_class_trib?: string
    municipio_prestacao_ibge?: string
    obra?: Obra
    /** Como veio (locacao.ts): quem confere contra o código final, que pode vir da empresa, é a rota. */
    locacao?: unknown
  }
  valor: string
  /** Ausente = o padrão de retenção da empresa. */
  retencao?: RetencaoDoPedido
  informacoes_complementares?: string
}

export type ValidationResult =
  | { ok: true; value: PedidoDaApi }
  | { ok: false; code: 'VALIDATION_FAILED' | 'UNKNOWN_FIELD'; message: string }

type Obj = Record<string, unknown>

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownField(obj: Obj, allowed: string[], prefix: string): string | null {
  const extra = Object.keys(obj).find((key) => !allowed.includes(key))
  return extra === undefined ? null : `${prefix}${extra}`
}

function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null
}

export function money(value: unknown): string | null {
  let raw: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    raw = String(value)
  } else if (typeof value === 'string') {
    raw = value.trim()
  } else {
    return null
  }
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(raw)
  if (!match) return null
  const normalized = `${BigInt(match[1])}.${(match[2] ?? '').padEnd(2, '0')}`
  return /^0\.00$/.test(normalized) ? null : normalized
}

const decimalTexto = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : null)

const CAMPOS_DO_IMOVEL = [
  'municipio_ibge', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'inscricao_imobiliaria', 'cib', 'residencial',
  'copropriedade', 'valor_total', 'vencimento',
]

/** Campo desconhecido dentro de `servico.locacao` (imóvel ou cada bem). */
function camposDaLocacao(servico: unknown): string | null {
  if (!isObject(servico) || !isObject(servico.locacao)) return null
  const l = servico.locacao
  const extra = unknownField(l, ['imovel', 'bens'], 'servico.locacao.')
  if (extra) return extra
  if (isObject(l.imovel)) {
    const e = unknownField(l.imovel, CAMPOS_DO_IMOVEL, 'servico.locacao.imovel.')
    if (e) return e
  }
  if (Array.isArray(l.bens)) {
    for (const [i, b] of l.bens.entries()) {
      if (!isObject(b)) continue
      const e = unknownField(b, ['ncm', 'descricao', 'quantidade'], `servico.locacao.bens[${i}].`)
      if (e) return e
    }
  }
  return null
}

type TomadorLido = { ok: true; tomador: PedidoDaApi['tomador'] } | { ok: false; erro: string }

/** `tomador` do corpo; não objeto (só com `tomador_nao_informado: true`, conferido antes) = sem tomador. */
function lerTomador(bruto: unknown): TomadorLido {
  if (!isObject(bruto)) return { ok: true, tomador: null }
  const t = bruto
  const falha = (erro: string): TomadorLido => ({ ok: false, erro })
  const temCpf = t.cpf !== undefined
  const temCnpj = t.cnpj !== undefined
  if (temCpf === temCnpj) return falha('tomador deve ter cpf ou cnpj, exatamente um dos dois')
  const cpf = typeof t.cpf === 'string' && /^\d{11}$/.test(t.cpf) ? t.cpf : null
  if (temCpf && !cpf) return falha('tomador.cpf deve ter 11 dígitos')
  const cnpj = typeof t.cnpj === 'string' && /^\d{14}$/.test(t.cnpj) ? t.cnpj : null
  if (temCnpj && !cnpj) return falha('tomador.cnpj deve ter 14 dígitos, só números')
  const nome = text(t.nome, 1, 150)
  if (!nome) return falha('tomador.nome deve ter de 1 a 150 caracteres')
  let email: string | null = null
  if (t.email !== undefined && t.email !== null && t.email !== '') {
    email = typeof t.email === 'string' ? normalizarEmail(t.email) : null
    if (!email) return falha('tomador.email inválido')
  }
  let endereco: EnderecoNacional | null = null
  if (t.endereco !== undefined && t.endereco !== null) {
    if (!isObject(t.endereco)) return falha('tomador.endereco deve ser um objeto')
    const e = t.endereco
    const lido = lerEnderecoEscrito({ cep: e.cep, logradouro: e.logradouro, numero: e.numero, complemento: e.complemento, bairro: e.bairro, municipio: e.municipio_ibge })
    if (!lido.ok) return falha(`tomador.endereco: ${lido.erro} (cep, logradouro, bairro e municipio_ibge são obrigatórios)`)
    endereco = lido.endereco
  }
  return { ok: true, tomador: { documento: (cpf ?? cnpj) as string, nome, email, ...(endereco ? { endereco } : {}) } }
}

export function parseNewInvoice(body: unknown): ValidationResult {
  const fail = (message: string): ValidationResult => ({ ok: false, code: 'VALIDATION_FAILED', message })
  if (!isObject(body)) return fail('o corpo deve ser um objeto JSON')

  const extra =
    unknownField(body, ['external_id', 'cnpj_prestador', 'tomador', 'tomador_nao_informado', 'servico', 'valor', 'retencao', 'informacoes_complementares'], '') ??
    (isObject(body.tomador) ? unknownField(body.tomador, ['cpf', 'cnpj', 'nome', 'email', 'endereco'], 'tomador.') : null) ??
    (isObject(body.tomador) && isObject(body.tomador.endereco)
      ? unknownField(body.tomador.endereco, ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'municipio_ibge'], 'tomador.endereco.')
      : null) ??
    (isObject(body.servico) ? unknownField(body.servico, ['codigo_servico_nacional', 'descricao', 'nbs', 'c_ind_op', 'c_class_trib', 'municipio_prestacao_ibge', 'obra', 'locacao'], 'servico.') : null) ??
    (isObject(body.servico) && isObject(body.servico.obra) ? unknownField(body.servico.obra, ['cno', 'cep', 'logradouro', 'numero', 'complemento', 'bairro'], 'servico.obra.') : null) ??
    camposDaLocacao(body.servico) ??
    (isObject(body.retencao) ? unknownField(body.retencao, ['retem_iss', 'aliquota_iss', 'retem_inss', 'inss', 'irrf', 'csrf'], 'retencao.') : null)
  if (extra) return { ok: false, code: 'UNKNOWN_FIELD', message: `campo não aceito: ${extra}` }

  const externalId = text(body.external_id, 1, 100)
  if (!externalId) return fail('external_id deve ter de 1 a 100 caracteres')
  let cnpjPrestador: string | null = null
  if (body.cnpj_prestador !== undefined && body.cnpj_prestador !== null) {
    cnpjPrestador = typeof body.cnpj_prestador === 'string' && /^\d{14}$/.test(body.cnpj_prestador) ? body.cnpj_prestador : null
    if (!cnpjPrestador) return fail('cnpj_prestador deve ter 14 dígitos, só números')
  }
  const naoInformado = body.tomador_nao_informado
  if (naoInformado !== undefined && naoInformado !== null && typeof naoInformado !== 'boolean') {
    return fail('tomador_nao_informado deve ser true ou false')
  }
  const semTomador = naoInformado === true
  if (semTomador && body.tomador !== undefined && body.tomador !== null) {
    return fail('tomador_nao_informado: true não aceita tomador; para identificar o cliente, mande só o tomador')
  }
  if (!semTomador && !isObject(body.tomador)) {
    return fail('tomador é obrigatório (para consumidor não identificado, envie "tomador_nao_informado": true)')
  }
  if (body.servico !== undefined && !isObject(body.servico)) return fail('servico deve ser um objeto')
  const servico: Obj = isObject(body.servico) ? body.servico : {}

  const tomador = lerTomador(body.tomador)
  if (!tomador.ok) return fail(tomador.erro)
  let codigo: string | null = null
  if (servico.codigo_servico_nacional !== undefined) {
    codigo = text(servico.codigo_servico_nacional, 1, 20)
    if (!codigo) return fail('servico.codigo_servico_nacional deve ter de 1 a 20 caracteres')
  }
  let descricao: string | null = null
  if (servico.descricao !== undefined) {
    descricao = text(servico.descricao, 1, 2000)
    if (!descricao) return fail('servico.descricao deve ter de 1 a 2000 caracteres')
  }
  const valor = money(body.valor)
  if (!valor) return fail('valor deve ser decimal positivo com até 2 casas')
  let nbs: string | null
  try {
    nbs = parseNbs(servico.nbs)
  } catch (error) {
    if (error instanceof DpsInvalidError) return fail(`servico.nbs: ${error.message}`)
    throw error
  }
  const rtc: { nbs?: string; c_ind_op?: string; c_class_trib?: string; municipio_prestacao_ibge?: string; obra?: Obra; locacao?: unknown } = nbs
    ? { nbs }
    : {}
  for (const campo of ['c_ind_op', 'c_class_trib'] as const) {
    const v = servico[campo]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string' || !/^\d{6}$/.test(v)) return fail(`servico.${campo} deve ter 6 dígitos`)
    rtc[campo] = v
  }
  const local = lerMunicipioPrestacao(servico.municipio_prestacao_ibge)
  if (!local.ok) return fail(`servico.municipio_prestacao_ibge ${local.erro}`)
  if (local.ibge) rtc.municipio_prestacao_ibge = local.ibge
  // A exigência do grupo (E0370) depende do código final, que pode vir da empresa: quem confere é a rota.
  const obra = lerObra(servico.obra)
  if (!obra.ok) return fail(`servico.obra ${obra.erro}`)
  if (obra.obra) rtc.obra = obra.obra
  if (servico.locacao !== undefined && servico.locacao !== null) {
    if (!isObject(servico.locacao)) return fail('servico.locacao deve ser um objeto: { imovel } ou { bens }')
    rtc.locacao = servico.locacao
  }

  const bruta = body.informacoes_complementares
  if (bruta !== undefined && bruta !== null && typeof bruta !== 'string') return fail('informacoes_complementares deve ser texto')
  const info = lerInfoComplementar(bruta)
  if (!info.ok) return fail(`informacoes_complementares deve ter até ${MAX_INFO_COMPLEMENTAR} caracteres`)

  let retencao: RetencaoDoPedido | undefined
  if (body.retencao !== undefined && body.retencao !== null) {
    if (!isObject(body.retencao)) return fail('retencao deve ser um objeto')
    const r = body.retencao
    for (const campo of ['retem_iss', 'retem_inss'] as const) {
      if (r[campo] !== undefined && typeof r[campo] !== 'boolean') return fail(`retencao.${campo} deve ser true ou false`)
    }
    retencao = {
      iss: typeof r.retem_iss === 'boolean' ? r.retem_iss : null,
      aliquotaIss: r.aliquota_iss === undefined ? null : decimalTexto(r.aliquota_iss),
      inss: typeof r.retem_inss === 'boolean' ? r.retem_inss : null,
      inssTexto: r.inss === undefined ? null : decimalTexto(r.inss),
      // Presumido/Real: IRRF e PIS/COFINS/CSLL retidos (somados), valor ou percentual.
      irrfTexto: r.irrf === undefined || r.irrf === null ? null : decimalTexto(r.irrf),
      csrfTexto: r.csrf === undefined || r.csrf === null ? null : decimalTexto(r.csrf),
    }
  }

  return {
    ok: true,
    value: {
      external_id: externalId,
      cnpj_prestador: cnpjPrestador,
      tomador: tomador.tomador,
      servico: { codigo, descricao, ...rtc },
      valor,
      ...(retencao ? { retencao } : {}),
      ...(info.texto ? { informacoes_complementares: info.texto } : {}),
    },
  }
}
