// Intérprete por Claude (critério 49; Landing de .checks/agente-fiscal-v2.md, lote D - SDK e
// cliente da IA). A IA só preenche o `parsed` (Decided da v1 "IA sem poder de emitir"); o código
// revalida tudo com `validarParsed`, e a conversa decide o resto.
import { pedirJson, type Ia } from '../ia/claude.js'
import { validarParsed, type Interprete } from './interprete.js'

const TEXTO_OU_NULO = { anyOf: [{ type: 'string' }, { type: 'null' }] }

export const SCHEMA_PARSED = {
  type: 'object',
  properties: {
    tomador: TEXTO_OU_NULO,
    documento: TEXTO_OU_NULO,
    valor: TEXTO_OU_NULO,
    modelo: TEXTO_OU_NULO,
    descricao: TEXTO_OU_NULO,
    intencao: { type: 'string', enum: ['emitir', 'cancelar', 'outro'] },
  },
  required: ['tomador', 'documento', 'valor', 'modelo', 'descricao', 'intencao'],
  additionalProperties: false,
}

export const INSTRUCOES = [
  'Você lê mensagens de WhatsApp de donos de pequenas empresas brasileiras que pedem notas fiscais de serviço (NFS-e).',
  'Extraia só o que estiver escrito na mensagem; nunca invente. Campo ausente fica null.',
  '- intencao: "emitir" quando pede uma nota nova; "cancelar" quando pede para cancelar uma nota; "outro" para o resto.',
  '- tomador: o nome do cliente para quem é a nota, como a pessoa escreveu, corrigindo só erros de digitação evidentes.',
  '- modelo: preencha com o mesmo nome do tomador quando a pessoa se refere a um cliente habitual pelo nome; senão null.',
  '- documento: CPF ou CNPJ do cliente, só os dígitos, quando aparecer na mensagem.',
  '- valor: o valor em reais com ponto decimal e duas casas, por exemplo "1500.00" para "mil e quinhentos" ou "1.500,00".',
  '- descricao: o serviço prestado, quando a pessoa disser o que foi, para ir na descrição da nota (por exemplo "Consultoria de outubro" em "nota pra Studio Lima, 350, consultoria de outubro"). Sem o nome do cliente, o valor ou o CPF/CNPJ; primeira letra maiúscula; senão null.',
  'Não emita nem confirme nada: você só lê o pedido.',
].join('\n')

export function interpreteClaude(ia: Ia): Interprete {
  return {
    async interpretar(texto) {
      const { json, tokens } = await pedirJson(ia, {
        system: INSTRUCOES,
        content: texto,
        schema: SCHEMA_PARSED,
        maxTokens: 512,
      })
      return { parsed: validarParsed(json), tokens }
    },
  }
}
