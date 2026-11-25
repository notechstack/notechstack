// Natureza da operação (natOp, tag B04 do leiaute 4.00; até 60 caracteres, texto livre) e o tipo da operação pelo CFOP.
// Bug de 24/11/2026 (Contabilidade Bragantina, NF-e 2232): uma remessa CFOP 6949 saiu como "Venda de mercadoria" porque
// o texto era fixo. Agora: vale a natureza que a pessoa informou (planilha `natureza_operacao`, campo do painel, passo do
// WhatsApp, `natureza_operacao` da API); sem ela, sai desta tabela pelo CFOP.
//
// A tabela é pelos três últimos dígitos do CFOP (5xxx dentro do estado e 6xxx interestadual têm a mesma natureza), com o
// texto que os emissores costumam usar para cada CFOP do Anexo do Convênio s/nº de 1970 (Ajuste SINIEF 07/01). A 5949/
// 6949 é "outra saída de mercadoria não especificada": na prática, a remessa sem venda, que o mercado chama de "Simples
// remessa" (o texto que a Bragantina pediu).
//
// Nota com itens de naturezas diferentes e sem natureza informada (decisão de 24/11/2026): a venda prevalece (venda com
// brinde, com amostra), senão vale a do primeiro item; nos dois casos o resumo avisa, para a pessoa informar se não for
// isso. CFOP fora da tabela, sem natureza informada: "Venda de mercadoria", como antes, com aviso no resumo.
import type { Item, Pagamento } from './nfe-builder.js'

export type TipoDaOperacao = 'venda' | 'remessa' | 'retorno' | 'devolucao' | 'transferencia'

export const NATUREZA_PADRAO = 'Venda de mercadoria'
export const LIMITE_NATUREZA = 60

const VENDA = 'Venda de mercadoria'

/** Três últimos dígitos do CFOP → natureza e tipo. Vale para 5xxx e 6xxx. */
export const NATUREZA_POR_CFOP: Record<string, { natureza: string; tipo: TipoDaOperacao }> = {
  // Vendas (produção própria, revenda, a não contribuinte, com ST, entrega futura, à ordem)
  ...Object.fromEntries(
    ['101', '102', '103', '104', '105', '106', '107', '108', '109', '110', '116', '117', '118', '119', '120', '122', '123', '401', '402', '403', '405'].map(
      (c) => [c, { natureza: VENDA, tipo: 'venda' as const }],
    ),
  ),
  // Transferências entre estabelecimentos da mesma empresa
  '151': { natureza: 'Transferência de mercadoria', tipo: 'transferencia' },
  '152': { natureza: 'Transferência de mercadoria', tipo: 'transferencia' },
  '408': { natureza: 'Transferência de mercadoria', tipo: 'transferencia' },
  '409': { natureza: 'Transferência de mercadoria', tipo: 'transferencia' },
  // Devoluções
  '201': { natureza: 'Devolução de compra', tipo: 'devolucao' },
  '202': { natureza: 'Devolução de compra', tipo: 'devolucao' },
  '410': { natureza: 'Devolução de compra', tipo: 'devolucao' },
  '411': { natureza: 'Devolução de compra', tipo: 'devolucao' },
  '553': { natureza: 'Devolução de compra', tipo: 'devolucao' },
  '556': { natureza: 'Devolução de compra', tipo: 'devolucao' },
  // Remessas e retornos
  '901': { natureza: 'Remessa para industrialização', tipo: 'remessa' },
  '902': { natureza: 'Retorno de industrialização', tipo: 'retorno' },
  '904': { natureza: 'Remessa para venda fora do estabelecimento', tipo: 'remessa' },
  '905': { natureza: 'Remessa para depósito fechado ou armazém geral', tipo: 'remessa' },
  '908': { natureza: 'Remessa em comodato', tipo: 'remessa' },
  '909': { natureza: 'Retorno de comodato', tipo: 'retorno' },
  '910': { natureza: 'Remessa em bonificação, doação ou brinde', tipo: 'remessa' },
  '911': { natureza: 'Remessa de amostra grátis', tipo: 'remessa' },
  '912': { natureza: 'Remessa para demonstração', tipo: 'remessa' },
  '913': { natureza: 'Retorno de demonstração', tipo: 'retorno' },
  '914': { natureza: 'Remessa para exposição ou feira', tipo: 'remessa' },
  '915': { natureza: 'Remessa para conserto', tipo: 'remessa' },
  '916': { natureza: 'Retorno de conserto', tipo: 'retorno' },
  '917': { natureza: 'Remessa em consignação mercantil', tipo: 'remessa' },
  '920': { natureza: 'Remessa de vasilhame ou sacaria', tipo: 'remessa' },
  '921': { natureza: 'Devolução de vasilhame ou sacaria', tipo: 'retorno' },
  '923': { natureza: 'Remessa por conta e ordem de terceiros', tipo: 'remessa' },
  '924': { natureza: 'Remessa para industrialização por conta e ordem', tipo: 'remessa' },
  '949': { natureza: 'Simples remessa', tipo: 'remessa' },
}

const digitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')

/** Natureza e tipo do CFOP pela tabela; null quando o CFOP não está nela. */
export function naturezaDoCfop(cfop: string): { natureza: string; tipo: TipoDaOperacao } | null {
  const c = digitos(cfop)
  if (!/^[56]\d{3}$/.test(c)) return null
  return NATUREZA_POR_CFOP[c.slice(1)] ?? null
}

export type NaturezaDaNota = {
  natureza: string
  /** informada: veio da pessoa; cfop: da tabela; padrao: CFOP fora da tabela, ficou "Venda de mercadoria". */
  origem: 'informada' | 'cfop' | 'padrao'
  /** Todos os itens têm CFOP da tabela e nenhum é de venda: a nota não tem pagamento (tPag 90) se ninguém disse outro. */
  semVenda: boolean
  avisos: string[]
}

/** A natureza que vai ao natOp: a informada (sem espaços nas pontas) ou a do CFOP, com os avisos para o resumo. */
export function naturezaDaNota(itens: Pick<Item, 'cfop'>[], informada?: string | null): NaturezaDaNota {
  const daTabela = itens.map((i) => ({ cfop: digitos(i.cfop), n: naturezaDoCfop(i.cfop) }))
  const semVenda = daTabela.length > 0 && daTabela.every((x) => x.n && x.n.tipo !== 'venda')
  const texto = (informada ?? '').replace(/\s+/g, ' ').trim()
  if (texto) return { natureza: texto, origem: 'informada', semVenda, avisos: [] }

  const avisos: string[] = []
  const fora = [...new Set(daTabela.filter((x) => !x.n).map((x) => x.cfop))]
  const conhecidas = daTabela.filter((x) => x.n)
  if (conhecidas.length === 0) {
    if (fora.length) {
      avisos.push(`natureza da operação: o CFOP ${fora.join(', ')} não está na tabela; a nota sai como "${NATUREZA_PADRAO}". Se não for venda, informe a natureza da operação`)
    }
    return { natureza: NATUREZA_PADRAO, origem: 'padrao', semVenda: false, avisos }
  }
  const distintas = [...new Set(conhecidas.map((x) => x.n!.natureza))]
  const venda = conhecidas.find((x) => x.n!.tipo === 'venda')
  const natureza = (venda ?? conhecidas[0]).n!.natureza
  if (distintas.length > 1) {
    const lista = distintas.map((d) => `${d} (CFOP ${[...new Set(conhecidas.filter((x) => x.n!.natureza === d).map((x) => x.cfop))].join(', ')})`).join('; ')
    avisos.push(`natureza da operação: itens de naturezas diferentes (${lista}); a nota sai como "${natureza}". Se não for isso, informe a natureza da operação`)
  }
  if (fora.length) {
    avisos.push(`natureza da operação: o CFOP ${fora.join(', ')} não está na tabela; a nota sai como "${natureza}". Se não for isso, informe a natureza da operação`)
  }
  return { natureza, origem: 'cfop', semVenda, avisos }
}

/**
 * Forma de pagamento quando a pessoa não disse: numa nota sem venda (remessa, bonificação, devolução, transferência)
 * é 90 "sem pagamento" (vPag 0); na venda, o padrão de cada canal (PIX na planilha, no painel e no WhatsApp; 99 na API).
 */
export function formaPadrao(itens: Pick<Item, 'cfop'>[], padraoDaVenda: string): string {
  return naturezaDaNota(itens).semVenda ? '90' : padraoDaVenda
}

/** Avisos da natureza para o resumo: a escolha automática duvidosa e o pagamento numa nota sem venda. */
export function avisosDaNatureza(input: { itens?: Pick<Item, 'cfop'>[]; naturezaOperacao?: string | null; pagamentos?: Pick<Pagamento, 'forma'>[] }): string[] {
  if (!input.itens?.length) return []
  const n = naturezaDaNota(input.itens, input.naturezaOperacao)
  const a = [...n.avisos]
  if (n.semVenda && input.pagamentos?.some((p) => p.forma !== '90')) {
    a.push(`"${n.natureza}" é uma operação sem venda, mas a nota tem forma de pagamento; numa remessa, o comum é "sem pagamento" (90)`)
  }
  return a
}
