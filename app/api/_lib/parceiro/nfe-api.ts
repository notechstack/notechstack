// Corpo de `POST /v1/nfe` (NF-e modelo 55 pela API do parceiro). Os nomes são os da planilha de NF-e (snake_case) e
// viram o `PedidoNfe` do motor (nfe/servico.ts, PR #114). Aqui só a forma (campo desconhecido é recusado, tipos e
// tamanhos básicos); as regras fiscais (NCM, CFOP, CSOSN, totais, pagamento) são as de `validarNfe`, chamadas por
// `criarNfe` com a empresa já carregada, iguais às do painel e da planilha.
import type { Uf } from '../nfe/autorizadores.js'
import { calcularTotais, type Csosn, type CstPisCofins, type Item, type Pagamento, type Transportador, type Volume } from '../nfe/nfe-builder.js'
import type { PedidoNfe } from '../nfe/servico.js'
import { formaPadrao } from '../nfe/natureza.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export type PedidoNfeDaApi = { external_id: string; cnpj_emitente: string | null; pedido: PedidoNfe }
export type LeituraNfe = { ok: true; valor: PedidoNfeDaApi } | { ok: false; codigo: 'VALIDATION_FAILED' | 'UNKNOWN_FIELD'; mensagem: string }

const MAX_ITENS = 990

class Recusa extends Error {
  constructor(readonly codigo: 'VALIDATION_FAILED' | 'UNKNOWN_FIELD', mensagem: string) {
    super(mensagem)
  }
}

function campos(o: Obj, permitidos: readonly string[], prefixo: string) {
  const extra = Object.keys(o).find((k) => !permitidos.includes(k))
  if (extra) throw new Recusa('UNKNOWN_FIELD', `campo não aceito: ${prefixo}${extra}`)
}

function texto(o: Obj, campo: string, prefixo: string, obrigatorio: true, max?: number): string
function texto(o: Obj, campo: string, prefixo: string, obrigatorio: false, max?: number): string | null
function texto(o: Obj, campo: string, prefixo: string, obrigatorio: boolean, max = 500): string | null {
  const v = o[campo]
  if (v === undefined || v === null || v === '') {
    if (obrigatorio) throw new Recusa('VALIDATION_FAILED', `${prefixo}${campo} é obrigatório`)
    return null
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new Recusa('VALIDATION_FAILED', `${prefixo}${campo} deve ser texto`)
  const s = String(v).trim()
  if (s.length > max) throw new Recusa('VALIDATION_FAILED', `${prefixo}${campo} passa de ${max} caracteres`)
  return s
}

function numero(o: Obj, campo: string, prefixo: string, obrigatorio: true): number
function numero(o: Obj, campo: string, prefixo: string, obrigatorio: false): number | null
function numero(o: Obj, campo: string, prefixo: string, obrigatorio: boolean): number | null {
  const v = o[campo]
  if (v === undefined || v === null || v === '') {
    if (obrigatorio) throw new Recusa('VALIDATION_FAILED', `${prefixo}${campo} é obrigatório`)
    return null
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new Recusa('VALIDATION_FAILED', `${prefixo}${campo} deve ser número (ponto como separador decimal)`)
  return n
}

function umDe<T extends string>(o: Obj, campo: string, prefixo: string, valores: readonly T[]): T | undefined {
  const v = texto(o, campo, prefixo, false)
  if (v === null) return undefined
  if (!(valores as readonly string[]).includes(v)) throw new Recusa('VALIDATION_FAILED', `${prefixo}${campo} deve ser um de: ${valores.join(', ')}`)
  return v as T
}

const CAMPOS_ENDERECO = ['logradouro', 'numero', 'complemento', 'bairro', 'codigo_municipio', 'uf', 'cep', 'fone'] as const

function endereco(o: unknown, prefixo: string) {
  if (!isObj(o)) throw new Recusa('VALIDATION_FAILED', `${prefixo.slice(0, -1)} é obrigatório`)
  campos(o, CAMPOS_ENDERECO, prefixo)
  return {
    logradouro: texto(o, 'logradouro', prefixo, true, 60),
    numero: texto(o, 'numero', prefixo, false, 60) ?? 'S/N',
    complemento: texto(o, 'complemento', prefixo, false, 60),
    bairro: texto(o, 'bairro', prefixo, true, 60),
    codigoMunicipio: texto(o, 'codigo_municipio', prefixo, true, 7),
    uf: texto(o, 'uf', prefixo, true, 2).toUpperCase() as Uf,
    cep: texto(o, 'cep', prefixo, true, 9),
    fone: texto(o, 'fone', prefixo, false, 14),
  }
}

const CAMPOS_ITEM = [
  'codigo', 'descricao', 'ncm', 'cest', 'cfop', 'unidade', 'quantidade', 'valor_unitario', 'origem', 'csosn',
  'aliquota_credito_sn', 'cst_pis_cofins', 'gtin', 'frete', 'seguro', 'desconto', 'outros', 'informacoes',
] as const

function item(o: unknown, i: number): Item {
  const p = `itens[${i}].`
  if (!isObj(o)) throw new Recusa('VALIDATION_FAILED', `itens[${i}] deve ser um objeto`)
  campos(o, CAMPOS_ITEM, p)
  return {
    codigo: texto(o, 'codigo', p, true, 60),
    descricao: texto(o, 'descricao', p, true, 120),
    ncm: texto(o, 'ncm', p, true, 8),
    cest: texto(o, 'cest', p, false, 7),
    cfop: texto(o, 'cfop', p, true, 4),
    unidade: texto(o, 'unidade', p, true, 6),
    quantidade: numero(o, 'quantidade', p, true),
    valorUnitario: numero(o, 'valor_unitario', p, true),
    origem: texto(o, 'origem', p, false, 1) ?? undefined,
    csosn: texto(o, 'csosn', p, true, 3) as Csosn,
    aliquotaCreditoSN: numero(o, 'aliquota_credito_sn', p, false),
    cstPisCofins: (texto(o, 'cst_pis_cofins', p, false, 2) ?? undefined) as CstPisCofins | undefined,
    gtin: texto(o, 'gtin', p, false, 14),
    frete: numero(o, 'frete', p, false),
    seguro: numero(o, 'seguro', p, false),
    desconto: numero(o, 'desconto', p, false),
    outros: numero(o, 'outros', p, false),
    informacoes: texto(o, 'informacoes', p, false, 500),
  }
}

function pagamento(o: unknown, i: number): Pagamento {
  const p = `pagamentos[${i}].`
  if (!isObj(o)) throw new Recusa('VALIDATION_FAILED', `pagamentos[${i}] deve ser um objeto`)
  campos(o, ['forma', 'valor', 'descricao', 'indicador'], p)
  return {
    forma: texto(o, 'forma', p, true, 2),
    valor: numero(o, 'valor', p, true),
    descricao: texto(o, 'descricao', p, false, 60),
    indicador: umDe(o, 'indicador', p, ['0', '1'] as const) ?? null,
  }
}

function transportador(o: unknown): Transportador {
  const p = 'transportador.'
  if (!isObj(o)) throw new Recusa('VALIDATION_FAILED', 'transportador deve ser um objeto')
  campos(o, ['documento', 'nome', 'inscricao_estadual', 'endereco', 'municipio', 'uf'], p)
  return {
    documento: texto(o, 'documento', p, false, 18),
    nome: texto(o, 'nome', p, false, 60),
    inscricaoEstadual: texto(o, 'inscricao_estadual', p, false, 14),
    endereco: texto(o, 'endereco', p, false, 60),
    municipio: texto(o, 'municipio', p, false, 60),
    uf: texto(o, 'uf', p, false, 2)?.toUpperCase() ?? null,
  }
}

function volume(o: unknown, i: number): Volume {
  const p = `volumes[${i}].`
  if (!isObj(o)) throw new Recusa('VALIDATION_FAILED', `volumes[${i}] deve ser um objeto`)
  campos(o, ['quantidade', 'especie', 'marca', 'numeracao', 'peso_liquido', 'peso_bruto'], p)
  return {
    quantidade: numero(o, 'quantidade', p, false),
    especie: texto(o, 'especie', p, false, 60),
    marca: texto(o, 'marca', p, false, 60),
    numeracao: texto(o, 'numeracao', p, false, 60),
    pesoLiquido: numero(o, 'peso_liquido', p, false),
    pesoBruto: numero(o, 'peso_bruto', p, false),
  }
}

const CAMPOS_TOPO = [
  'external_id', 'cnpj_emitente', 'natureza_operacao', 'consumidor_final', 'presenca', 'modalidade_frete',
  'transportador', 'volumes', 'destinatario', 'itens', 'pagamentos', 'informacoes_complementares',
] as const

function volumes(v: unknown): Volume[] {
  if (!Array.isArray(v)) throw new Recusa('VALIDATION_FAILED', 'volumes deve ser uma lista')
  if (v.length > 5000) throw new Recusa('VALIDATION_FAILED', 'volumes passa de 5000')
  return v.map(volume)
}

export function lerPedidoNfe(corpo: unknown): LeituraNfe {
  try {
    if (!isObj(corpo)) throw new Recusa('VALIDATION_FAILED', 'o corpo deve ser um objeto JSON')
    campos(corpo, CAMPOS_TOPO, '')
    const externalId = texto(corpo, 'external_id', '', true, 100)
    const cnpjEmitente = texto(corpo, 'cnpj_emitente', '', false, 14)
    if (cnpjEmitente !== null && !/^\d{14}$/.test(cnpjEmitente)) throw new Recusa('VALIDATION_FAILED', 'cnpj_emitente deve ter 14 dígitos, só números')

    const d = corpo.destinatario
    if (!isObj(d)) throw new Recusa('VALIDATION_FAILED', 'destinatario é obrigatório')
    campos(d, ['documento', 'nome', 'indicador_ie', 'inscricao_estadual', 'email', 'endereco'], 'destinatario.')
    const destinatario = {
      documento: texto(d, 'documento', 'destinatario.', true, 18),
      nome: texto(d, 'nome', 'destinatario.', true, 60),
      indicadorIE: umDe(d, 'indicador_ie', 'destinatario.', ['1', '2', '9'] as const) ?? '9',
      inscricaoEstadual: texto(d, 'inscricao_estadual', 'destinatario.', false, 14),
      email: texto(d, 'email', 'destinatario.', false, 60),
      endereco: endereco(d.endereco, 'destinatario.endereco.'),
    }

    if (!Array.isArray(corpo.itens) || corpo.itens.length === 0) throw new Recusa('VALIDATION_FAILED', 'itens deve ter pelo menos um item')
    if (corpo.itens.length > MAX_ITENS) throw new Recusa('VALIDATION_FAILED', `itens passa de ${MAX_ITENS}`)
    const itens = corpo.itens.map(item)

    let pagamentos: Pagamento[]
    if (corpo.pagamentos === undefined || corpo.pagamentos === null) {
      // Sem pagamento informado: "outros" (99) no valor da nota; na nota sem venda (CFOP de remessa, bonificação,
      // devolução, transferência), "sem pagamento" (90, vPag 0). A natureza, sem natureza_operacao, sai do CFOP.
      const forma = formaPadrao(itens, '99')
      pagamentos = [{ forma, valor: forma === '90' ? 0 : calcularTotais(itens).nota / 100 }]
    } else {
      if (!Array.isArray(corpo.pagamentos) || corpo.pagamentos.length === 0) throw new Recusa('VALIDATION_FAILED', 'pagamentos deve ser uma lista')
      pagamentos = corpo.pagamentos.map(pagamento)
    }

    const pedido: PedidoNfe = {
      destinatario,
      itens,
      pagamentos,
      naturezaOperacao: texto(corpo, 'natureza_operacao', '', false, 60) ?? undefined,
      consumidorFinal: umDe(corpo, 'consumidor_final', '', ['0', '1'] as const),
      presenca: umDe(corpo, 'presenca', '', ['0', '1', '2', '3', '4', '5', '9'] as const),
      modalidadeFrete: umDe(corpo, 'modalidade_frete', '', ['0', '1', '2', '3', '4', '9'] as const),
      ...(corpo.transportador === undefined || corpo.transportador === null ? {} : { transportador: transportador(corpo.transportador) }),
      ...(corpo.volumes === undefined || corpo.volumes === null ? {} : { volumes: volumes(corpo.volumes) }),
      informacoesComplementares: texto(corpo, 'informacoes_complementares', '', false, 2000),
    }
    return { ok: true, valor: { external_id: externalId, cnpj_emitente: cnpjEmitente, pedido } }
  } catch (error) {
    if (error instanceof Recusa) return { ok: false, codigo: error.codigo, mensagem: error.message }
    throw error
  }
}
