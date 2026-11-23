// Planilha de NF-e (modelo publicado em /agentes/fiscal/dados/modelo-nfe.xlsx e .csv): uma linha por item; as linhas com o
// mesmo `cnpj_emitente` + `nota` formam uma NF-e. Destinatário, frete, transporte (modalidade, transportador e volumes)
// e pagamento são da nota: valem o que estiver preenchido em qualquer linha dela, e linhas que os repetem diferente
// recusam a nota. Leitura determinística, sem
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
import {
  avisosNfe,
  calcularTotais,
  soDigitos,
  temTransportador,
  temVolume,
  type Csosn,
  type Item,
  type Transportador,
  type Volume,
} from './nfe-builder.js'
import type { PedidoNfe } from './servico.js'
import { FORMAS, lerNumero, modalidade, ratearFrete } from './campos.js'

// Os leitores de campo moram em campos.ts (sem depender do lote, para o WhatsApp importar sem ciclo); reexportados
// aqui para quem já importava da planilha.
export { FORMAS, lerNumero, modalidade, ratearFrete }

export const MODELO_DA_PLANILHA_NFE = 'https://www.notechstack.com.br/agentes/fiscal/dados/modelo-nfe.xlsx'
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
  'modalidade_frete', 'transportador_cpf_cnpj', 'transportador_nome', 'transportador_ie', 'transportador_endereco',
  'transportador_municipio', 'transportador_uf', 'volumes_quantidade', 'volumes_especie', 'volumes_marca',
  'volumes_numeracao', 'peso_liquido', 'peso_bruto',
] as const
type Coluna = (typeof COLUNAS_OBRIGATORIAS)[number] | (typeof COLUNAS_OPCIONAIS)[number]
const TODAS: Coluna[] = [...COLUNAS_OBRIGATORIAS, ...COLUNAS_OPCIONAIS]
const DO_CABECALHO = new Map<string, Coluna>(TODAS.map((c) => [normalizarCabecalho(c), c]))

/** Campos da nota (não do item): o valor é o que estiver preenchido nas linhas dela, e tem de ser um só. */
const CAMPOS_DA_NOTA = [
  'cpf_cnpj_destinatario', 'nome_destinatario', 'ie_destinatario', 'email_destinatario', 'cep', 'logradouro', 'numero',
  'complemento', 'bairro', 'municipio_ibge', 'uf', 'fone', 'frete', 'forma_pagamento', 'descricao_pagamento', 'informacoes',
  'modalidade_frete', 'transportador_cpf_cnpj', 'transportador_nome', 'transportador_ie', 'transportador_endereco',
  'transportador_municipio', 'transportador_uf', 'volumes_quantidade', 'volumes_especie', 'volumes_marca',
  'volumes_numeracao', 'peso_liquido', 'peso_bruto',
] as const

export type NotaDaPlanilha = {
  cnpjEmitente: string
  nota: string
  linhas: number[]
  pedido: PedidoNfe
  /** Não impedem a emissão (peso bruto menor que o líquido etc.); o painel mostra antes de emitir. */
  avisos: string[]
}

export type ProblemaDaPlanilha = { linha: number | null; nota: string | null; mensagem: string }

export type PlanilhaNfe =
  | { ok: true; notas: NotaDaPlanilha[]; problemas: ProblemaDaPlanilha[] }
  | { ok: false; mensagem: string }

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
  if (c === 'cpf_cnpj_destinatario' || c === 'transportador_cpf_cnpj' || c === 'cep' || c === 'municipio_ibge' || c === 'fone') {
    return soDigitos(texto).replace(/^0+/, '') || texto
  }
  if (c === 'frete') return String(lerNumero(celula, 2) ?? texto)
  if (c === 'peso_liquido' || c === 'peso_bruto') return String(lerNumero(celula, 3) ?? texto)
  if (c === 'volumes_quantidade') return String(lerNumero(celula, 0) ?? texto)
  if (c === 'modalidade_frete') return modalidade(texto) ?? normalizarCabecalho(texto)
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

    // Transporte: transportador e um volume (com a soma) por nota; sem as colunas, nada muda.
    // CPF/CNPJ do transportador: o mesmo leitor do destinatário (zeros que a célula numérica perde voltam).
    const docTransp = t('transportador_cpf_cnpj') ? lerDocumentoDaCelula(n('transportador_cpf_cnpj')) : null
    if (docTransp && 'erro' in docTransp) {
      erros.push(docTransp.erro === 'DOCUMENTO_AMBIGUO' ? 'CPF/CNPJ do transportador ambíguo: escreva com a pontuação (ou como texto)' : 'CPF ou CNPJ do transportador inválido')
    }
    const transportador: Transportador = {
      documento: docTransp && 'documento' in docTransp ? docTransp.documento : null,
      nome: t('transportador_nome') || null,
      inscricaoEstadual: t('transportador_ie') || null,
      endereco: t('transportador_endereco') || null,
      municipio: t('transportador_municipio') || null,
      uf: t('transportador_uf').toUpperCase() || null,
    }
    const numeroOuNulo = (c: (typeof CAMPOS_DA_NOTA)[number], casas: number, rotulo: string) => {
      if (!t(c)) return null
      const x = lerNumero(n(c), casas)
      if (x === null) erros.push(`${rotulo} inválido (${t(c)})`)
      return x
    }
    const volume: Volume = {
      quantidade: numeroOuNulo('volumes_quantidade', 0, 'volumes_quantidade (número inteiro)'),
      especie: t('volumes_especie') || null,
      marca: t('volumes_marca') || null,
      numeracao: t('volumes_numeracao') || null,
      pesoLiquido: numeroOuNulo('peso_liquido', 3, 'peso_liquido (kg, até 3 casas)'),
      pesoBruto: numeroOuNulo('peso_bruto', 3, 'peso_bruto (kg, até 3 casas)'),
    }
    const textoModalidade = t('modalidade_frete')
    const modalidadeInformada = textoModalidade ? modalidade(textoModalidade) : null
    if (textoModalidade && !modalidadeInformada) {
      erros.push(`modalidade_frete "${textoModalidade}" desconhecida (use 0 emitente/CIF, 1 destinatário/FOB, 2 terceiros, 3 próprio remetente, 4 próprio destinatário ou 9 sem frete)`)
    }
    if (!textoModalidade && temTransportador(transportador)) {
      erros.push('com transportador, preencha modalidade_frete (0 emitente/CIF, 1 destinatário/FOB, 2 terceiros, 3 próprio remetente, 4 próprio destinatário)')
    }

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
    if (freteTotal) ratearFrete(itens, freteTotal)
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
      modalidadeFrete: modalidadeInformada ?? (freteTotal ? '0' : '9'),
      ...(temTransportador(transportador) ? { transportador } : {}),
      ...(temVolume(volume) ? { volumes: [volume] } : {}),
      pagamentos: [{ forma: formaCodigo ?? '99', valor: formaCodigo === '90' ? 0 : vNF / 100, descricao: t('descricao_pagamento') || null }],
      informacoesComplementares: t('informacoes') || null,
    }
    if (erros.length) {
      for (const m of erros) problemas.push({ linha: g.linhas[0].numero, nota: g.nota, mensagem: m })
      continue
    }
    notas.push({ cnpjEmitente: g.cnpj, nota: g.nota, linhas: g.linhas.map((l) => l.numero), pedido, avisos: avisosNfe(pedido) })
  }
  return { ok: true, notas, problemas }
}
