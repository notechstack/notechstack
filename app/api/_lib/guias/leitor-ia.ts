// IA de reserva da leitura de guias (critério 10), no molde da importação de clientes (ia/leitor-pdf.ts): Haiku 4.5
// com saída estruturada, o PDF só em memória durante a chamada. Tudo o que a IA devolve passa pelas mesmas regras
// da leitura (DV da linha, data, CNPJ/CPF válido); o que não passa vira null. A IA só lê: nunca dispara nada.
import { cnpjValido, cpfValido } from '../agente/documentos.js'
import { pedirJson, type Ia } from '../ia/claude.js'
import { lerLinha } from './codigos.js'
import { TIPOS_DE_GUIA, type CamposGuia, type LeitorGuiaIa, type TipoDeGuia } from './leitura.js'

const TEXTO_OU_NULO = { anyOf: [{ type: 'string' }, { type: 'null' }] }

export const SCHEMA_GUIA = {
  type: 'object',
  properties: {
    e_guia: { type: 'boolean' },
    tipo: { anyOf: [{ type: 'string', enum: [...TIPOS_DE_GUIA] }, { type: 'null' }] },
    documento: TEXTO_OU_NULO,
    competencia: TEXTO_OU_NULO,
    vencimento: TEXTO_OU_NULO,
    valor: TEXTO_OU_NULO,
    linha_digitavel: TEXTO_OU_NULO,
  },
  required: ['e_guia', 'tipo', 'documento', 'competencia', 'vencimento', 'valor', 'linha_digitavel'],
  additionalProperties: false,
}

export const INSTRUCOES_GUIA = [
  'Você recebe o PDF de um documento de pagamento brasileiro enviado por um escritório de contabilidade a um cliente.',
  'Diga se é uma guia de pagamento (DAS, DAS-MEI, DARF, DARF da DCTFWeb, guia do FGTS Digital, guia de ISS, parcela de parcelamento ou boleto de honorários). Se não for, e_guia = false e os demais campos null.',
  'Se for, copie do documento:',
  '- tipo: das, das_mei, darf, dctfweb, fgts, iss, parcelamento, honorario ou outro;',
  '- documento: CNPJ ou CPF do contribuinte/pagador (nunca o do beneficiário ou do escritório), só dígitos;',
  '- competencia: o período de apuração/competência no formato AAAA-MM;',
  '- vencimento: a data de vencimento ("pagar este documento até") no formato AAAA-MM-DD;',
  '- valor: o valor total a pagar em reais com ponto decimal e duas casas, por exemplo "1234.56";',
  '- linha_digitavel: a linha digitável completa (47 ou 48 dígitos), só dígitos.',
  'Campo que não aparece fica null. Nunca invente.',
].join('\n')

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** O JSON da IA → campos que passam nas regras da leitura. */
export function camposDaIa(json: unknown, hoje?: Date): Partial<CamposGuia> {
  const j = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
  if (j.e_guia !== true) return {}
  const saida: Partial<CamposGuia> = {}
  const tipo = str(j.tipo)
  if (tipo && (TIPOS_DE_GUIA as readonly string[]).includes(tipo)) saida.tipo = tipo as TipoDeGuia
  const doc = str(j.documento)?.replace(/\D/g, '') ?? null
  if (doc && (doc.length === 14 ? cnpjValido(doc) : doc.length === 11 && cpfValido(doc))) saida.documento = doc
  const comp = /^(\d{4})-(\d{2})/.exec(str(j.competencia) ?? '')
  if (comp && Number(comp[2]) >= 1 && Number(comp[2]) <= 12) saida.competencia = `${comp[1]}-${comp[2]}-01`
  const venc = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(j.vencimento) ?? '')
  if (venc) {
    const d = new Date(`${venc[0]}T00:00:00Z`)
    if (!Number.isNaN(d.getTime()) && d.getUTCDate() === Number(venc[3])) saida.vencimento = venc[0]
  }
  const valor = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(str(j.valor) ?? '')
  if (valor) {
    const centavos = Number(valor[1]) * 100 + Number((valor[2] ?? '0').padEnd(2, '0'))
    if (centavos > 0) saida.valor_centavos = centavos
  }
  const linha = str(j.linha_digitavel)
  if (linha) {
    const lido = lerLinha(linha, hoje)
    if (lido) saida.linha_digitavel = lido.linha
  }
  return saida
}

export function leitorGuiaClaude(ia: Ia, hoje?: () => Date): LeitorGuiaIa {
  return {
    async ler(pdf) {
      const { json } = await pedirJson(ia, {
        system: INSTRUCOES_GUIA,
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pdf).toString('base64') } },
          { type: 'text', text: 'Leia esta guia.' },
        ],
        schema: SCHEMA_GUIA,
        maxTokens: 512,
      })
      return camposDaIa(json, hoje?.())
    },
  }
}
