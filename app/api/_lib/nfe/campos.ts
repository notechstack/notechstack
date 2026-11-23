// Leitura de campos da NF-e escritos por pessoas, comum à planilha (planilha.ts), ao painel e à conversa no WhatsApp
// (agente/nfe-conversa.ts): número pt-BR, forma de pagamento, modalidade do frete e o rateio do frete pelos itens.
// Sem dependência do leitor de planilhas (agente/lote.ts): a conversa importa daqui sem fechar o ciclo
// lote → conversa → nfe-conversa → planilha → lote.
import { centavos, type Item, type ModalidadeFrete } from './nfe-builder.js'

/** Sem acento, minúsculo, só letras e dígitos ("Sem frete" → "semfrete"), como o cabeçalho da planilha. */
const normalizar = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')

/** Forma de pagamento: código do leiaute ou o nome que as pessoas escrevem. */
export const FORMAS: Record<string, string> = {
  dinheiro: '01', cheque: '02', credito: '03', cartaodecredito: '03', debito: '04', cartaodedebito: '04',
  boleto: '15', pix: '17', transferencia: '18', sempagamento: '90', outros: '99',
}

/** Modalidade do frete: código do leiaute ou o nome que as pessoas escrevem (normalizado, sem acento e espaço). */
const MODALIDADES: Record<string, ModalidadeFrete> = {
  emitente: '0', remetente: '0', cif: '0', porcontadoemitente: '0', porcontadoremetente: '0',
  destinatario: '1', fob: '1', porcontadodestinatario: '1',
  terceiros: '2', porcontadeterceiros: '2',
  proprioremetente: '3', transporteproprioremetente: '3', proprioemitente: '3', transporteproprioemitente: '3',
  propriodestinatario: '4', transportepropriodestinatario: '4',
  semfrete: '9', semtransporte: '9', semocorrenciadetransporte: '9',
}

/** "0".."4", "9", "CIF", "FOB", "emitente", "sem frete"… → código do leiaute; null se não reconhece. */
export function modalidade(texto: string): ModalidadeFrete | null {
  const t = texto.trim()
  if (/^[012349]$/.test(t)) return t as ModalidadeFrete
  // "0 - Emitente" e "0-CIF": vale o código no começo.
  const m = /^([012349])\s*[-–:.]/.exec(t)
  if (m) return m[1] as ModalidadeFrete
  return MODALIDADES[normalizar(t)] ?? null
}

/**
 * Número pt-BR ("1.234,5678", "2,5") ou da célula numérica; até `casas` decimais (também na célula numérica, sem
 * contar o ruído de ponto flutuante).
 */
export function lerNumero(celula: string | number | boolean | Date | null | undefined, casas: number): number | null {
  if (typeof celula === 'number') {
    if (!Number.isFinite(celula)) return null
    // Compara no espaço do valor (19,99 vem como 19.990000000000002 em escala 1e10 e não pode ser recusado).
    return Number(celula.toFixed(casas)) === celula ? celula : null
  }
  if (celula === null || celula === undefined || typeof celula === 'boolean' || celula instanceof Date) return null
  let t = String(celula).trim().replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!t) return null
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const [, dec = ''] = t.split('.')
  if (dec.length > casas) return null
  return Number(t)
}

/** Frete da nota rateado pelos itens, proporcional ao valor, nos mesmos centavos do leiaute (o resto no último). */
export function ratearFrete(itens: Item[], freteTotal: number): void {
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
