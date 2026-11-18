// Intérprete por IA (Decided "IA sem poder de emitir"; Landing, lote B - intérprete). A IA só
// devolve a saída estruturada abaixo, que vai para `fiscal_requests.parsed`; emitir e cancelar
// acontecem só no código da conversa, depois do "confirmar". Com `ANTHROPIC_API_KEY`, a v2 usa
// `interpreteClaude` (interprete-claude.ts); sem ela, vale `interpreteNaoConfigurado()`.
import { normalizarInfoComplementar } from '../info-complementar.js'
import { lerCodigoServico } from './catalogo-servicos.js'
import { cnpjValido, cpfValido } from './documentos.js'

export type Intencao = 'emitir' | 'cancelar' | 'outro'

export type Parsed = {
  tomador: string | null
  documento: string | null
  valor: string | null
  modelo: string | null
  /** O que foi o serviço, quando a pessoa diz (Lucca, 30/10/2026); sem ela, vale a descrição do modelo ou a padrão. */
  descricao: string | null
  /**
   * Conta Escritório (16/11/2026): a empresa que emite, como a pessoa escreveu ("pela Oficina Trilho", um CNPJ). A IA
   * só lê; quem acha a empresa entre as da conta é o código (emitente.ts). Ausente nos pedidos gravados antes disso.
   */
  prestador?: string | null
  /**
   * Retenção escrita no pedido (Lucca, 16/11/2026): `true` "com retenção de ISS", `false` "sem retenção"; `null` = o
   * pedido não diz, e vale o padrão da empresa. A IA só lê; quem confere alíquota e valor é retencao.ts.
   */
  iss_retido?: boolean | null
  /** Alíquota do ISS retido como escrita ("2", "2,5"). */
  aliquota_iss?: string | null
  inss_retido?: boolean | null
  /** INSS retido como escrito: percentual com % ("11%") ou valor em reais ("38,50"). */
  inss?: string | null
  /**
   * Código de serviço escrito no pedido (Lucca, 17/11/2026), em 6 dígitos ("código 04.03.01" → "040301"). Vale para
   * esta nota no lugar do código do cliente ou da empresa. Ausente nos pedidos gravados antes disso.
   */
  codigo_servico?: string | null
  /** O tipo de serviço pedido para escolher o código ("serviço de fisioterapia"); o código acha na lista nacional. */
  servico?: string | null
  /**
   * Informações complementares da nota (Lucca, 17/11/2026): dados bancários, observações. Vira `serv/infoCompl/xInfComp`.
   * Com marcador no texto ("Dados bancários:", "Obs:"), quem lê é o código (info-complementar.ts), não a IA.
   */
  informacoes_complementares?: string | null
  /**
   * Local da prestação como escrito ("Campinas", "Campinas/SP"), quando o pedido diz onde o serviço foi prestado
   * (Lucca, 18/11/2026). Quem acha o código IBGE é o código (local-prestacao.ts).
   */
  municipio_prestacao?: string | null
  intencao: Intencao
}

export type Interpretacao = { parsed: Parsed; tokens: { entrada: number; saida: number } }

export interface Interprete {
  interpretar(texto: string): Promise<Interpretacao>
}

const VALOR = /^(\d{1,12})(?:\.(\d{1,2}))?$/

function texto(valor: unknown, max: number): string | null {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim().replace(/\s+/g, ' ')
  return limpo.length >= 1 && limpo.length <= max ? limpo : null
}

/** Valor decimal positivo com 2 casas (`"10.00"`), ou `null`. */
export function valorValido(valor: unknown): string | null {
  const bruto = typeof valor === 'number' && Number.isFinite(valor) ? String(valor) : valor
  if (typeof bruto !== 'string') return null
  const m = VALOR.exec(bruto.trim())
  if (!m) return null
  const normalizado = `${BigInt(m[1])}.${(m[2] ?? '').padEnd(2, '0')}`
  return normalizado === '0.00' ? null : normalizado
}

/**
 * Revalida a saída da IA: só os campos do tipo, cada um no formato que o código aceita. Campo
 * a mais é descartado; campo inválido vira `null` (e a conversa pergunta o que falta).
 */
export function validarParsed(bruto: unknown): Parsed {
  const obj = typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {}
  const digitos = typeof obj.documento === 'string' ? obj.documento.replace(/\D/g, '') : ''
  const documento = (digitos.length === 11 && cpfValido(digitos)) || (digitos.length === 14 && cnpjValido(digitos)) ? digitos : null
  const intencao: Intencao = obj.intencao === 'emitir' || obj.intencao === 'cancelar' ? obj.intencao : 'outro'
  return {
    tomador: texto(obj.tomador, 150),
    documento,
    valor: valorValido(obj.valor),
    modelo: texto(obj.modelo, 60),
    // Mesmo limite do motor (servico.descricao em validation.ts).
    descricao: texto(obj.descricao, 2000),
    prestador: texto(obj.prestador, 150),
    iss_retido: typeof obj.iss_retido === 'boolean' ? obj.iss_retido : null,
    aliquota_iss: texto(obj.aliquota_iss, 10),
    inss_retido: typeof obj.inss_retido === 'boolean' ? obj.inss_retido : null,
    inss: texto(obj.inss, 20),
    codigo_servico: lerCodigoServico(typeof obj.codigo_servico === 'string' ? obj.codigo_servico : null),
    servico: texto(obj.servico, 80),
    // Sem corte: acima de 2.000 caracteres a conversa pede um texto mais curto.
    informacoes_complementares: normalizarInfoComplementar(obj.informacoes_complementares),
    municipio_prestacao: texto(obj.municipio_prestacao, 80),
    intencao,
  }
}

export class InterpreteNaoConfigurado extends Error {
  constructor() {
    super('INTERPRETE_NAO_CONFIGURADO')
    this.name = 'InterpreteNaoConfigurado'
  }
}

/** Até o spike 3 escolher o modelo (Unresolved 7), nenhuma IA é chamada. */
export function interpreteNaoConfigurado(): Interprete {
  return {
    async interpretar() {
      throw new InterpreteNaoConfigurado()
    },
  }
}
