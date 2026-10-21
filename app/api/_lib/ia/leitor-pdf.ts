// Leitura do PDF de uma nota (DANFSe) pela IA (critérios 20 e 22; Landing de
// .checks/agente-fiscal-v2.md, lote D - leitura de PDF pela IA). O PDF só existe em memória
// durante a chamada; o que a IA devolve passa pelo contrato do candidato antes de sair daqui.
import { pedirJson, type Ia, type Tokens } from './claude.js'
import { candidatoValidado, type Candidato } from './candidato.js'

export type LeituraPdf = { danfse: false; tokens: Tokens } | { danfse: true; candidato: Candidato; tokens: Tokens }

export interface LeitorPdf {
  ler(pdf: Uint8Array): Promise<LeituraPdf>
}

/** Os 5 bytes de todo arquivo PDF. */
export const pareceCabecalhoPdf = (bytes: Uint8Array) =>
  bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-'

const TEXTO_OU_NULO = { anyOf: [{ type: 'string' }, { type: 'null' }] }

export const SCHEMA_DANFSE = {
  type: 'object',
  properties: {
    e_danfse: { type: 'boolean' },
    tomador_documento: TEXTO_OU_NULO,
    tomador_nome: TEXTO_OU_NULO,
    tomador_email: TEXTO_OU_NULO,
    tomador_endereco: {
      anyOf: [
        {
          type: 'object',
          properties: {
            logradouro: TEXTO_OU_NULO,
            numero: TEXTO_OU_NULO,
            complemento: TEXTO_OU_NULO,
            bairro: TEXTO_OU_NULO,
            codigo_municipio: TEXTO_OU_NULO,
            uf: TEXTO_OU_NULO,
            cep: TEXTO_OU_NULO,
          },
          required: ['logradouro', 'numero', 'complemento', 'bairro', 'codigo_municipio', 'uf', 'cep'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
    codigo_servico_nacional: TEXTO_OU_NULO,
    descricao: TEXTO_OU_NULO,
    valor: TEXTO_OU_NULO,
  },
  required: [
    'e_danfse',
    'tomador_documento',
    'tomador_nome',
    'tomador_email',
    'tomador_endereco',
    'codigo_servico_nacional',
    'descricao',
    'valor',
  ],
  additionalProperties: false,
}

export const INSTRUCOES_DANFSE = [
  'Você recebe o PDF de um documento. Diga se ele é um DANFSe: o documento auxiliar de uma NFS-e (nota fiscal de serviço eletrônica) brasileira, do padrão nacional ou de uma prefeitura.',
  'Se não for, responda e_danfse = false e todos os outros campos null.',
  'Se for, copie do quadro do TOMADOR do serviço (nunca do prestador/emitente):',
  '- tomador_documento: CPF ou CNPJ, só os dígitos; tomador_nome; tomador_email; tomador_endereco (codigo_municipio é o código IBGE de 7 dígitos, se aparecer).',
  'Do serviço: codigo_servico_nacional (código de tributação nacional, 6 dígitos, sem pontos), descricao (a descrição do serviço) e valor (valor do serviço em reais, com ponto decimal e duas casas, por exemplo "1500.00").',
  'Campo que não aparece no documento fica null. Nunca invente.',
].join('\n')

export function leitorPdfClaude(ia: Ia): LeitorPdf {
  return {
    async ler(pdf) {
      const { json, tokens } = await pedirJson(ia, {
        system: INSTRUCOES_DANFSE,
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(pdf).toString('base64') } },
          { type: 'text', text: 'Leia este documento.' },
        ],
        schema: SCHEMA_DANFSE,
        maxTokens: 1024,
      })
      const campos = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
      if (campos.e_danfse !== true) return { danfse: false, tokens }
      const candidato = candidatoValidado({ ...campos, valor_padrao: campos.valor, nome: null }, 'importacao_pdf')
      return { danfse: true, candidato, tokens }
    },
  }
}
