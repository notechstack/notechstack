// Intérprete por Claude (critério 49; Landing de .checks/agente-fiscal-v2.md, lote D - SDK e
// cliente da IA). A IA só preenche o `parsed` (Decided da v1 "IA sem poder de emitir"); o código
// revalida tudo com `validarParsed`, e a conversa decide o resto.
import { pedirJson, type Ia } from '../ia/claude.js'
import { validarParsed, type Interprete } from './interprete.js'

const TEXTO_OU_NULO = { anyOf: [{ type: 'string' }, { type: 'null' }] }
const SIM_NAO_OU_NULO = { anyOf: [{ type: 'boolean' }, { type: 'null' }] }

export const SCHEMA_PARSED = {
  type: 'object',
  properties: {
    tomador: TEXTO_OU_NULO,
    documento: TEXTO_OU_NULO,
    valor: TEXTO_OU_NULO,
    modelo: TEXTO_OU_NULO,
    descricao: TEXTO_OU_NULO,
    prestador: TEXTO_OU_NULO,
    iss_retido: SIM_NAO_OU_NULO,
    aliquota_iss: TEXTO_OU_NULO,
    inss_retido: SIM_NAO_OU_NULO,
    inss: TEXTO_OU_NULO,
    codigo_servico: TEXTO_OU_NULO,
    servico: TEXTO_OU_NULO,
    informacoes_complementares: TEXTO_OU_NULO,
    intencao: { type: 'string', enum: ['emitir', 'cancelar', 'outro'] },
  },
  required: ['tomador', 'documento', 'valor', 'modelo', 'descricao', 'prestador', 'iss_retido', 'aliquota_iss', 'inss_retido', 'inss', 'codigo_servico', 'servico', 'informacoes_complementares', 'intencao'],
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
  '- prestador: a empresa que EMITE a nota, só quando a mensagem diz por qual empresa a nota sai ("nota pela Oficina Trilho pra Clínica Saúde", "em nome da Studio Lima", "emitente Studio Lima", "pelo escritório", ou o CNPJ dela). Escreva o nome ou o CNPJ como a pessoa escreveu, sem "pela" ou "da". É diferente do tomador, que é para quem a nota vai: em "nota pra Studio Lima" ou "nota da Studio Lima, 350" não há prestador. Senão null.',
  '- iss_retido: true quando a mensagem diz que o ISS é retido ("com retenção de ISS", "ISS retido", "retém ISS 2%", "tem retenção de ISS pela tomadora na alíquota de 2,01%"); false quando diz que não há retenção ("sem retenção", "sem retenção de ISS"); senão null.',
  '- aliquota_iss: a alíquota do ISS retido, só o número como escrito ("2", "2,5", "2,01"), quando aparecer; senão null.',
  '- inss_retido: true quando diz que o INSS (ou a contribuição previdenciária) é retido ("retém INSS 11%", "INSS retido de 38,50"); false quando diz sem retenção de INSS ou "sem retenção"; senão null.',
  '- inss: o INSS retido como escrito: percentual com o símbolo ("11%") ou valor em reais com vírgula ("38,50"); senão null. Não confunda com o valor da nota.',
  '- codigo_servico: o código de serviço da lista nacional, quando a mensagem cita um ("código 04.03.01", "cód. 040301", "item 4.08.02"), como escrito; senão null. Não confunda com CPF, CNPJ, valor ou número de nota.',
  '- servico: o tipo de serviço, quando a pessoa pede um código ou serviço específico para a nota ("serviço de fisioterapia", "código de nutrição", "no serviço de odontologia"), só o nome do serviço ("fisioterapia"); senão null. Uma descrição comum do trabalho ("consultoria de outubro") vai só em descricao, não aqui.',
  '- informacoes_complementares: o que a pessoa pede para ir nas informações complementares da nota, e não na descrição do serviço: dados bancários (banco, agência, conta, PIX), observações ("obs: …"), número de pedido ou contrato, ou o que vier depois de "informações complementares". Copie como está escrito, sem mudar nenhum número. Isso não entra em descricao. Senão null.',
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
