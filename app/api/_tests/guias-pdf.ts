// Guias sintéticas para os testes e a demonstração do módulo Guias (critério 11): PDFs gerados na hora com o pdf-lib,
// sem dado real de cliente. Os CNPJs são inventados (com DV válido), os códigos de barras são montados com os DVs da
// Febraban (codigos.ts), e o texto imita o leiaute das guias da Receita e de um boleto bancário.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { formatarLinha, montarArrecadacao, montarBoleto } from '../_lib/guias/codigos.js'

function dv(base: string, pesos: number[]): number {
  const soma = [...base].reduce((acc, d, i) => acc + Number(d) * pesos[i], 0)
  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

/** CNPJ válido a partir de 12 dígitos (raiz + filial). */
export function cnpjDe(base12: string): string {
  const b = base12.replace(/\D/g, '').padStart(12, '0').slice(0, 12)
  const d1 = dv(b, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = dv(b + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  return `${b}${d1}${d2}`
}

export const fmtCnpj = (c: string) => `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`
const reais = (centavos: number) =>
  (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

export type GuiaSintetica = {
  tipo: 'das' | 'das_mei' | 'darf' | 'dctfweb' | 'boleto' | 'arrecadacao'
  cnpj: string
  razao?: string
  /** `AAAA-MM`. */
  competencia?: string
  vencimento: string
  valorCentavos: number
  /** Valor impresso no texto, se diferente do código de barras (teste do valor divergente). */
  valorNoTexto?: number
  /** CNPJ do beneficiário (boleto de honorários do escritório). */
  beneficiario?: string
  semValorNoTexto?: boolean
}

export type GuiaGerada = { pdf: Uint8Array; linha: string; codigoBarras: string }

/** Linhas de texto de uma guia sintética, no leiaute de cada tipo. */
function linhasDe(g: GuiaSintetica, linha: string): string[] {
  const razao = g.razao ?? 'EMPRESA EXEMPLO LTDA'
  const [ano, mes] = (g.competencia ?? '2026-11').split('-')
  const valorTexto = g.semValorNoTexto ? null : reais(g.valorNoTexto ?? g.valorCentavos)
  const comum = (titulo: string[], extra: string[] = []) => [
    ...titulo,
    `CNPJ ${fmtCnpj(g.cnpj)} Razão Social ${razao}`,
    `Período de Apuração ${MESES[Number(mes) - 1]}/${ano}`,
    `Data de Vencimento ${dataBr(g.vencimento)}`,
    ...extra,
    `Pagar este documento até ${dataBr(g.vencimento)}`,
    ...(valorTexto ? [`Valor Total do Documento ${valorTexto}`] : []),
    formatarLinha(linha),
  ]
  switch (g.tipo) {
    case 'das':
      return comum(['Documento de Arrecadação do Simples Nacional'], ['Número do Documento 07.20.26324.1234567-8'])
    case 'das_mei':
      return comum(['Documento de Arrecadação do Simples Nacional', 'DAS de Microempreendedor Individual (MEI)'])
    case 'darf':
      return comum(['Ministério da Fazenda', 'Documento de Arrecadação de Receitas Federais'], ['Código da Receita 2089 IRPJ'])
    case 'dctfweb':
      return comum(['Documento de Arrecadação de Receitas Federais', 'DCTFWeb - Contribuições Previdenciárias'])
    case 'arrecadacao':
      return comum(['Prefeitura Municipal', 'Guia de Recolhimento do ISS - Imposto Sobre Serviços'])
    case 'boleto':
      return [
        'Recibo do Pagador',
        `Beneficiário Contabilidade Exemplo CNPJ ${fmtCnpj(g.beneficiario ?? cnpjDe('933333330001'))}`,
        `Pagador ${razao} CNPJ ${fmtCnpj(g.cnpj)}`,
        `Honorários contábeis referente a ${MESES[Number(mes) - 1].toLowerCase()}/${ano}`,
        `Vencimento ${dataBr(g.vencimento)}`,
        ...(valorTexto ? [`Valor do Documento ${valorTexto}`] : []),
        formatarLinha(linha),
      ]
  }
}

export async function gerarGuiaPdf(g: GuiaSintetica): Promise<GuiaGerada> {
  const codigo =
    g.tipo === 'boleto'
      ? montarBoleto({ vencimento: g.vencimento, valorCentavos: g.valorCentavos })
      : montarArrecadacao({ valorCentavos: g.valorCentavos, identificador: g.tipo === 'arrecadacao' ? '6' : '8' })
  const doc = await PDFDocument.create()
  doc.setTitle('Guia sintética de teste')
  const pagina = doc.addPage([595, 842])
  const fonte = await doc.embedFont(StandardFonts.Helvetica)
  let y = 790
  for (const texto of linhasDe(g, codigo.linha)) {
    pagina.drawText(texto, { x: 40, y, size: 10, font: fonte })
    y -= 22
  }
  return { pdf: await doc.save(), linha: codigo.linha, codigoBarras: codigo.codigoBarras }
}

/** PDF só com desenho, sem nenhum texto (como uma guia escaneada). */
export async function gerarPdfSemTexto(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const pagina = doc.addPage([595, 842])
  for (let i = 0; i < 12; i++) pagina.drawRectangle({ x: 40, y: 780 - i * 30, width: 300 + (i % 3) * 40, height: 8, color: rgb(0.1, 0.1, 0.1) })
  return doc.save()
}
