// Planilha de NF-e (modelo publicado em /agentes/fiscal/dados/modelo-nfe.csv): uma linha por item; as linhas com o
// mesmo `cnpj_emitente` + `nota` formam uma NF-e. Destinatário, frete e pagamento são da nota: valem o que estiver
// preenchido em qualquer linha dela, e linhas que os repetem diferente recusam a nota. Leitura determinística, sem
// IA; reaproveita o leitor de .xlsx/.csv do lote da NFS-e (agente/lote.ts).
import { cnpjValido } from '../agente/documentos.js'
import {
  decodificarTexto,
  lerDocumentoDaCelula,
  lerPlanilha,
  normalizarCabecalho,
  separadorDoCsv,
  textoDaCelula,
  type Celula,
  type TipoDePlanilha,
} from '../agente/lote.js'
import { UFS, type Uf } from './autorizadores.js'
import { calcularTotais, centavos, soDigitos, type Csosn, type Item } from './nfe-builder.js'
import type { PedidoNfe } from './servico.js'

export const MODELO_DA_PLANILHA_NFE = 'https://www.notechstack.com.br/agentes/fiscal/dados/modelo-nfe.csv'
export const MAX_LINHAS_NFE = 2000
export const MAX_TAMANHO_DA_NOTA = 30

export const COLUNAS_OBRIGATORIAS = [
  'cnpj_emitente', 'nota', 'cpf_cnpj_destinatario', 'nome_destinatario', 'cep', 'logradouro', 'numero', 'bairro',
  'municipio_ibge', 'uf', 'codigo_produto', 'descricao_produto', 'ncm', 'cfop', 'unidade', 'quantidade', 'valor_unitario',
  'csosn',
] as const
export const COLUNAS_OPCIONAIS = [
  'ie_destinatario', 'email_destinatario', 'complemento', 'fone', 'cest', 'origem', 'aliquota_credito_sn', 'gtin',
  'desconto', 'frete', 'forma_pagamento', 'descricao_pagamento', 'informacoes', 'informacoes_item',
] as const
type Coluna = (typeof COLUNAS_OBRIGATORIAS)[number] | (typeof COLUNAS_OPCIONAIS)[number]
const TODAS: Coluna[] = [...COLUNAS_OBRIGATORIAS, ...COLUNAS_OPCIONAIS]
const DO_CABECALHO = new Map<string, Coluna>(TODAS.map((c) => [normalizarCabecalho(c), c]))

/** Campos da nota (não do item): o valor é o que estiver preenchido nas linhas dela, e tem de ser um só. */
const CAMPOS_DA_NOTA = [
  'cpf_cnpj_destinatario', 'nome_destinatario', 'ie_destinatario', 'email_destinatario', 'cep', 'logradouro', 'numero',
  'complemento', 'bairro', 'municipio_ibge', 'uf', 'fone', 'frete', 'forma_pagamento', 'descricao_pagamento', 'informacoes',
] as const

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

/**
 * Número pt-BR ("1.234,5678", "2,5") ou da célula numérica; até `casas` decimais (também na célula numérica, sem
 * contar o ruído de ponto flutuante).
 */
export function lerNumero(celula: Celula | undefined, casas: number): number | null {
  if (typeof celula === 'number') {
    if (!Number.isFinite(celula)) return null
    // Compara no espaço do valor (19,99 vem como 19.990000000000002 em escala 1e10 e não pode ser recusado).
    return Number(celula.toFixed(casas)) === celula ? celula : null
  }
  let t = textoDaCelula(celula).replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!t) return null
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const [, dec = ''] = t.split('.')
  if (dec.length > casas) return null
  return Number(t)
}

/** Código numérico (CEP, NCM, CEST, IBGE): célula numérica do .xlsx perde zeros à esquerda; aqui eles voltam. */
function codigo(celula: Celula | undefined, tamanho: number): string {
  const d = soDigitos(typeof celula === 'number' && Number.isInteger(celula) ? String(celula) : textoDaCelula(celula))
  return typeof celula === 'number' && d && d.length < tamanho ? d.padStart(tamanho, '0') : d
}

const valorOpcional = (c: Celula | undefined) => (textoDaCelula(c) ? lerNumero(c, 2) : 0)

/**
 * Como dois preenchimentos do mesmo campo da nota são comparados: documento, CEP, município e telefone pelos dígitos;
 * frete pelo valor; texto sem caixa, acento, pontuação e espaços ("Padaria Ltda" = "PADARIA LTDA.").
 */
function comparavel(c: string, celula: Celula | undefined): string {
  const texto = textoDaCelula(celula)
  if (!texto) return ''
  if (c === 'cpf_cnpj_destinatario' || c === 'cep' || c === 'municipio_ibge' || c === 'fone') return soDigitos(texto).replace(/^0+/, '') || texto
  if (c === 'frete') return String(lerNumero(celula, 2) ?? texto)
  return normalizarCabecalho(texto) || texto
}

export async function lerPlanilhaNfe(conteudo: Uint8Array, tipo: TipoDePlanilha): Promise<PlanilhaNfe> {
  const grade = await lerPlanilha(conteudo, tipo)
  // CSV separado por vírgula com "1234,56" sem aspas empurra as colunas: basta ter mais campos que o cabeçalho.
  const contarCampos = tipo === 'csv' && separadorDoCsv(decodificarTexto(conteudo)) === ','
  return interpretarPlanilhaNfe(grade, { contarCampos })
}

export function interpretarPlanilhaNfe(grade: Celula[][], opcoes: { contarCampos?: boolean } = {}): PlanilhaNfe {
  const vazia = (l: Celula[]) => l.every((c) => textoDaCelula(c) === '')
  const inicio = grade.findIndex((l) => !vazia(l))
  if (inicio < 0) return { ok: false, mensagem: 'A planilha está vazia.' }
  const cabecalho = grade[inicio].map((c) => DO_CABECALHO.get(normalizarCabecalho(textoDaCelula(c))) ?? null)
  // Até a última coluna com nome no cabeçalho (colunas vazias à direita não contam).
  let largura = grade[inicio].length
  while (largura > 0 && textoDaCelula(grade[inicio][largura - 1]) === '') largura--
  const faltando = COLUNAS_OBRIGATORIAS.filter((c) => !cabecalho.includes(c))
  if (faltando.length) {
    return { ok: false, mensagem: `Faltam colunas da planilha de NF-e: ${faltando.join(', ')}. Use o modelo: ${MODELO_DA_PLANILHA_NFE}` }
  }
  const linhasDeDados = grade.slice(inicio + 1).map((l, i) => ({ numero: inicio + i + 2, l })).filter((x) => !vazia(x.l))
  if (linhasDeDados.length > MAX_LINHAS_NFE) return { ok: false, mensagem: `A planilha passou de ${MAX_LINHAS_NFE} linhas. Divida em duas.` }

  const problemas: ProblemaDaPlanilha[] = []
  type Linha = { numero: number; v: (c: Coluna) => Celula | undefined }
  const grupos = new Map<string, { cnpj: string; nota: string; linhas: Linha[]; recusada: boolean }>()
  for (const { numero, l } of linhasDeDados) {
    const v = (c: Coluna) => {
      const i = cabecalho.indexOf(c)
      return i < 0 ? undefined : l[i]
    }
    const cnpj = codigo(v('cnpj_emitente'), 14)
    const nota = textoDaCelula(v('nota'))
    // No CSV com vírgula conta o número de campos contra o cabeçalho inteiro (com as vírgulas finais que o Excel põe).
    const aMais = opcoes.contarCampos ? l.length > grade[inicio].length : l.slice(largura).some((c) => textoDaCelula(c) !== '')
    if (!cnpjValido(cnpj)) {
      problemas.push({ linha: numero, nota: nota || null, mensagem: 'CNPJ do emitente inválido.' })
      continue
    }
    if (!nota) {
      problemas.push({ linha: numero, nota: null, mensagem: 'Coluna "nota" vazia: ela agrupa os itens de uma mesma NF-e.' })
      continue
    }
    if (nota.length > MAX_TAMANHO_DA_NOTA) {
      problemas.push({ linha: numero, nota: nota.slice(0, MAX_TAMANHO_DA_NOTA), mensagem: `A coluna "nota" aceita até ${MAX_TAMANHO_DA_NOTA} caracteres.` })
      continue
    }
    const k = `${cnpj}:${nota}`
    if (!grupos.has(k)) grupos.set(k, { cnpj, nota, linhas: [], recusada: false })
    const g = grupos.get(k)!
    if (aMais) {
      // Uma linha com colunas a mais (vírgula decimal sem aspas no CSV) recusa a nota inteira: o item sairia errado.
      problemas.push({ linha: numero, nota, mensagem: 'A linha tem mais colunas que o cabeçalho (no CSV com vírgula, ponha os valores entre aspas ou use ponto e vírgula).' })
      g.recusada = true
    }
    g.linhas.push({ numero, v })
  }

  const notas: NotaDaPlanilha[] = []
  for (const g of grupos.values()) {
    if (g.recusada) continue
    const erros: string[] = []
    // O valor de cada campo da nota: o primeiro preenchido; outros preenchidos diferentes recusam a nota.
    const daNota = new Map<string, Celula | undefined>()
    for (const c of CAMPOS_DA_NOTA) {
      let escolhido: { celula: Celula | undefined; texto: string; linha: number } | null = null
      for (const linha of g.linhas) {
        const celula = linha.v(c)
        const texto = comparavel(c, celula)
        if (!texto) continue
        if (!escolhido) escolhido = { celula, texto, linha: linha.numero }
        else if (texto !== escolhido.texto) erros.push(`linha ${linha.numero}: "${c}" diferente da linha ${escolhido.linha}`)
      }
      daNota.set(c, escolhido?.celula)
    }
    const n = (c: (typeof CAMPOS_DA_NOTA)[number]) => daNota.get(c)
    const t = (c: (typeof CAMPOS_DA_NOTA)[number]) => textoDaCelula(n(c))

    const doc = lerDocumentoDaCelula(n('cpf_cnpj_destinatario'))
    if ('erro' in doc) erros.push(doc.erro === 'DOCUMENTO_AMBIGUO' ? 'CPF/CNPJ do destinatário ambíguo: escreva com a pontuação (ou como texto)' : 'CPF ou CNPJ do destinatário inválido')
    const documento = 'documento' in doc ? doc.documento : ''
    const uf = t('uf').toUpperCase()
    if (!UFS.includes(uf as Uf)) erros.push(`UF "${t('uf')}" inválida`)
    const ie = t('ie_destinatario')
    const indicadorIE: '1' | '2' | '9' = /^isent[oa]$/i.test(ie) ? '2' : soDigitos(ie) ? '1' : '9'
    const forma = t('forma_pagamento')
    const formaCodigo = !forma ? '17' : /^\d{2}$/.test(forma) ? forma : FORMAS[normalizarCabecalho(forma)] ?? null
    if (!formaCodigo) erros.push(`forma de pagamento "${forma}" desconhecida (use pix, boleto, dinheiro, credito, debito, transferencia ou o código)`)
    if (formaCodigo === '99' && !t('descricao_pagamento')) erros.push('forma de pagamento "outros" (99) pede a coluna descricao_pagamento')
    const freteTotal = valorOpcional(n('frete'))
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
      itens.push({
        codigo: tx('codigo_produto'),
        descricao: tx('descricao_produto'),
        ncm: codigo(v('ncm'), 8),
        cest: codigo(v('cest'), 7) || null,
        cfop: soDigitos(tx('cfop')),
        unidade: tx('unidade'),
        quantidade: quantidade ?? 0,
        valorUnitario: valorUnitario ?? 0,
        csosn: soDigitos(tx('csosn')) as Csosn,
        aliquotaCreditoSN: credito,
        origem: tx('origem') || '0',
        gtin: soDigitos(tx('gtin')) || null,
        desconto: desconto || null,
        informacoes: tx('informacoes_item') || null,
      })
    }
    // Frete da nota rateado pelos itens, proporcional ao valor, nos mesmos centavos do leiaute (o resto no último).
    if (freteTotal) {
      const total = centavos(freteTotal)
      const bases = itens.map((i) => centavos(i.quantidade * i.valorUnitario))
      const soma = bases.reduce((a, b) => a + b, 0) || 1
      let usado = 0
      itens.forEach((item, i) => {
        const parte = i === itens.length - 1 ? total - usado : Math.floor((total * bases[i]) / soma)
        usado += parte
        item.frete = parte / 100
      })
    }
    // O pagamento é o vNF calculado como o builder calcula (mesmo arredondamento).
    const vNF = calcularTotais(itens).nota
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
          codigoMunicipio: codigo(n('municipio_ibge'), 7),
          uf: uf as Uf,
          cep: codigo(n('cep'), 8),
          fone: t('fone') || null,
        },
      },
      itens,
      modalidadeFrete: freteTotal ? '0' : '9',
      pagamentos: [{ forma: formaCodigo ?? '99', valor: formaCodigo === '90' ? 0 : vNF / 100, descricao: t('descricao_pagamento') || null }],
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
