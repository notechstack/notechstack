// Planilha de NF-e (modelo publicado em /agentes/fiscal/dados/modelo-nfe.csv): uma linha por item; as linhas com o
// mesmo `cnpj_emitente` + `nota` formam uma NF-e. Destinatário, frete e pagamento vêm da primeira linha da nota (as
// outras podem repetir ou deixar em branco; se repetirem diferente, a nota é recusada). Leitura determinística, sem
// IA; reaproveita o leitor de .xlsx/.csv do lote da NFS-e (agente/lote.ts).
import { cnpjValido, cpfValido } from '../agente/documentos.js'
import { lerPlanilha, normalizarCabecalho, textoDaCelula, type Celula, type TipoDePlanilha } from '../agente/lote.js'
import { UFS, type Uf } from './autorizadores.js'
import { soDigitos, type Csosn, type Item } from './nfe-builder.js'
import type { PedidoNfe } from './servico.js'

export const MODELO_DA_PLANILHA_NFE = 'https://www.notechstack.com.br/agentes/fiscal/dados/modelo-nfe.csv'
export const MAX_LINHAS_NFE = 2000

export const COLUNAS_OBRIGATORIAS = [
  'cnpj_emitente', 'nota', 'cpf_cnpj_destinatario', 'nome_destinatario', 'cep', 'logradouro', 'numero', 'bairro',
  'municipio_ibge', 'uf', 'codigo_produto', 'descricao_produto', 'ncm', 'cfop', 'unidade', 'quantidade', 'valor_unitario',
  'csosn',
] as const
export const COLUNAS_OPCIONAIS = [
  'ie_destinatario', 'email_destinatario', 'complemento', 'fone', 'cest', 'origem', 'aliquota_credito_sn', 'gtin',
  'desconto', 'frete', 'forma_pagamento', 'informacoes', 'informacoes_item',
] as const
type Coluna = (typeof COLUNAS_OBRIGATORIAS)[number] | (typeof COLUNAS_OPCIONAIS)[number]
const TODAS: Coluna[] = [...COLUNAS_OBRIGATORIAS, ...COLUNAS_OPCIONAIS]
const DO_CABECALHO = new Map<string, Coluna>(TODAS.map((c) => [normalizarCabecalho(c), c]))

/** Forma de pagamento: código do leiaute ou o nome que as pessoas escrevem. */
const FORMAS: Record<string, string> = {
  dinheiro: '01', cheque: '02', credito: '03', cartaodecredito: '03', debito: '04', cartaodedebito: '04',
  boleto: '15', pix: '17', transferencia: '18', sempagamento: '90', outros: '99',
}

export type NotaDaPlanilha = {
  cnpjEmitente: string
  nota: string
  linhas: number[]
  pedido: PedidoNfe
}

export type ProblemaDaPlanilha = { linha: number | null; nota: string | null; mensagem: string }

export type PlanilhaNfe =
  | { ok: true; notas: NotaDaPlanilha[]; problemas: ProblemaDaPlanilha[] }
  | { ok: false; mensagem: string }

/** Número pt-BR ("1.234,5678", "2,5") ou da célula numérica; até `casas` decimais. */
export function lerNumero(celula: Celula | undefined, casas: number): number | null {
  if (typeof celula === 'number') return Number.isFinite(celula) ? celula : null
  let t = textoDaCelula(celula).replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!t) return null
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const [, dec = ''] = t.split('.')
  if (dec.length > casas) return null
  return Number(t)
}

const valorOpcional = (c: Celula | undefined) => (textoDaCelula(c) ? lerNumero(c, 2) : 0)

export async function lerPlanilhaNfe(conteudo: Uint8Array, tipo: TipoDePlanilha): Promise<PlanilhaNfe> {
  const grade = await lerPlanilha(conteudo, tipo)
  return interpretarPlanilhaNfe(grade)
}

export function interpretarPlanilhaNfe(grade: Celula[][]): PlanilhaNfe {
  const vazia = (l: Celula[]) => l.every((c) => textoDaCelula(c) === '')
  const inicio = grade.findIndex((l) => !vazia(l))
  if (inicio < 0) return { ok: false, mensagem: 'A planilha está vazia.' }
  const cabecalho = grade[inicio].map((c) => DO_CABECALHO.get(normalizarCabecalho(textoDaCelula(c))) ?? null)
  const faltando = COLUNAS_OBRIGATORIAS.filter((c) => !cabecalho.includes(c))
  if (faltando.length) {
    return { ok: false, mensagem: `Faltam colunas da planilha de NF-e: ${faltando.join(', ')}. Use o modelo: ${MODELO_DA_PLANILHA_NFE}` }
  }
  const linhasDeDados = grade.slice(inicio + 1).map((l, i) => ({ numero: inicio + i + 2, l })).filter((x) => !vazia(x.l))
  if (linhasDeDados.length > MAX_LINHAS_NFE) return { ok: false, mensagem: `A planilha passou de ${MAX_LINHAS_NFE} linhas. Divida em duas.` }

  const problemas: ProblemaDaPlanilha[] = []
  const grupos = new Map<string, { cnpj: string; nota: string; linhas: { numero: number; v: (c: Coluna) => Celula | undefined }[] }>()
  for (const { numero, l } of linhasDeDados) {
    const v = (c: Coluna) => {
      const i = cabecalho.indexOf(c)
      return i < 0 ? undefined : l[i]
    }
    const cnpj = soDigitos(textoDaCelula(v('cnpj_emitente')))
    const nota = textoDaCelula(v('nota'))
    if (!cnpjValido(cnpj)) {
      problemas.push({ linha: numero, nota: nota || null, mensagem: 'CNPJ do emitente inválido.' })
      continue
    }
    if (!nota) {
      problemas.push({ linha: numero, nota: null, mensagem: 'Coluna "nota" vazia: ela agrupa os itens de uma mesma NF-e.' })
      continue
    }
    const k = `${cnpj}:${nota}`
    if (!grupos.has(k)) grupos.set(k, { cnpj, nota, linhas: [] })
    grupos.get(k)!.linhas.push({ numero, v })
  }

  const notas: NotaDaPlanilha[] = []
  for (const g of grupos.values()) {
    const erros: string[] = []
    const primeira = g.linhas[0].v
    const t = (c: Coluna) => textoDaCelula(primeira(c))
    // Campos da nota que, se repetidos noutra linha, têm de ser iguais.
    for (const c of ['cpf_cnpj_destinatario', 'municipio_ibge', 'forma_pagamento', 'frete'] as const) {
      const base = t(c)
      for (const outra of g.linhas.slice(1)) {
        const x = textoDaCelula(outra.v(c))
        if (x && base && x !== base) erros.push(`linha ${outra.numero}: "${c}" diferente da primeira linha da nota`)
      }
    }
    const documento = soDigitos(t('cpf_cnpj_destinatario'))
    if (!(documento.length === 11 ? cpfValido(documento) : documento.length === 14 ? cnpjValido(documento) : false)) {
      erros.push('CPF ou CNPJ do destinatário inválido')
    }
    const uf = t('uf').toUpperCase()
    if (!UFS.includes(uf as Uf)) erros.push(`UF "${t('uf')}" inválida`)
    const ie = t('ie_destinatario')
    const indicadorIE: '1' | '2' | '9' = /^isento$/i.test(ie) ? '2' : soDigitos(ie) ? '1' : '9'
    const forma = t('forma_pagamento')
    const formaCodigo = !forma ? '17' : /^\d{2}$/.test(forma) ? forma : FORMAS[normalizarCabecalho(forma)] ?? null
    if (!formaCodigo) erros.push(`forma de pagamento "${forma}" desconhecida (use pix, boleto, dinheiro, credito, debito, transferencia ou o código)`)
    const freteTotal = valorOpcional(primeira('frete'))
    if (freteTotal === null) erros.push('frete inválido')

    const itens: Item[] = []
    for (const { numero, v } of g.linhas) {
      const tx = (c: Coluna) => textoDaCelula(v(c))
      const quantidade = lerNumero(v('quantidade'), 4)
      const valorUnitario = lerNumero(v('valor_unitario'), 10)
      const desconto = valorOpcional(v('desconto'))
      const credito = tx('aliquota_credito_sn') ? lerNumero(v('aliquota_credito_sn'), 4) : null
      if (quantidade === null) erros.push(`linha ${numero}: quantidade inválida (até 4 casas)`)
      if (valorUnitario === null) erros.push(`linha ${numero}: valor unitário inválido`)
      if (desconto === null) erros.push(`linha ${numero}: desconto inválido`)
      const csosn = soDigitos(tx('csosn'))
      itens.push({
        codigo: tx('codigo_produto'),
        descricao: tx('descricao_produto'),
        ncm: soDigitos(tx('ncm')),
        cest: soDigitos(tx('cest')) || null,
        cfop: soDigitos(tx('cfop')),
        unidade: tx('unidade'),
        quantidade: quantidade ?? 0,
        valorUnitario: valorUnitario ?? 0,
        csosn: csosn as Csosn,
        aliquotaCreditoSN: credito,
        origem: tx('origem') || '0',
        gtin: soDigitos(tx('gtin')) || null,
        desconto: desconto || null,
        informacoes: tx('informacoes_item') || null,
      })
    }
    // Frete da nota rateado pelos itens, proporcional ao valor (o centavo que sobra vai no último).
    if (freteTotal) {
      const centavos = Math.round(freteTotal * 100)
      const bases = itens.map((i) => Math.round(i.quantidade * i.valorUnitario * 100))
      const soma = bases.reduce((a, b) => a + b, 0) || 1
      let usado = 0
      itens.forEach((item, i) => {
        const parte = i === itens.length - 1 ? centavos - usado : Math.floor((centavos * bases[i]) / soma)
        usado += parte
        item.frete = parte / 100
      })
    }
    const total = itens.reduce((s, i) => s + Math.round(i.quantidade * i.valorUnitario * 100) - Math.round((i.desconto ?? 0) * 100) + Math.round((i.frete ?? 0) * 100), 0)
    const pedido: PedidoNfe = {
      destinatario: {
        documento,
        nome: t('nome_destinatario'),
        indicadorIE,
        inscricaoEstadual: indicadorIE === '1' ? soDigitos(ie) : null,
        email: t('email_destinatario') || null,
        endereco: {
          logradouro: t('logradouro'),
          numero: t('numero') || 'S/N',
          complemento: t('complemento') || null,
          bairro: t('bairro'),
          codigoMunicipio: soDigitos(t('municipio_ibge')),
          uf: uf as Uf,
          cep: soDigitos(t('cep')),
          fone: t('fone') || null,
        },
      },
      itens,
      modalidadeFrete: freteTotal ? '0' : '9',
      pagamentos: [{ forma: formaCodigo ?? '99', valor: formaCodigo === '90' ? 0 : total / 100 }],
      informacoesComplementares: t('informacoes') || null,
    }
    if (erros.length) {
      for (const m of erros) problemas.push({ linha: g.linhas[0].numero, nota: g.nota, mensagem: m })
      continue
    }
    notas.push({ cnpjEmitente: g.cnpj, nota: g.nota, linhas: g.linhas.map((l) => l.numero), pedido })
  }
  return { ok: true, notas, problemas }
}
