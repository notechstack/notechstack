// Intérprete por Claude (critério 49; Landing de .checks/agente-fiscal-v2.md, lote D - SDK e
// cliente da IA). A IA só preenche o `parsed` (Decided da v1 "IA sem poder de emitir"); o código
// revalida tudo com `validarParsed`, e a conversa decide o resto.
import { pedirJson, type Ia } from '../ia/claude.js'
import { validarParsed, type Interprete } from './interprete.js'

const TEXTO = { type: 'string' }
const TEXTO_OU_NULO = { anyOf: [TEXTO, { type: 'null' }] }
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
    municipio_prestacao: TEXTO_OU_NULO,
    // Sem `anyOf` aqui: a saída estruturada aceita no máximo 16 parâmetros com união no schema
    // inteiro (400 imediato, sem retry). Com o grupo obra nulável eram 22 e toda mensagem nova
    // caía em `ia_falhou` (19/11/2026). Campo não escrito vem "" e `obraEscrita` vira null.
    obra: {
      type: 'object',
      properties: {
        cno: TEXTO,
        cep: TEXTO,
        logradouro: TEXTO,
        numero: TEXTO,
        complemento: TEXTO,
        bairro: TEXTO,
        cidade: TEXTO,
      },
      required: ['cno', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade'],
      additionalProperties: false,
    },
    // Locação (26/11/2026), no mesmo formato da obra: sem `anyOf`, para caber no limite de 16 uniões da saída
    // estruturada. Campo não escrito vem "" e `locacaoEscrita` vira null; `tipo` "" = não é locação.
    locacao: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['imovel', 'movel', ''] },
        cidade: TEXTO,
        cep: TEXTO,
        logradouro: TEXTO,
        numero: TEXTO,
        complemento: TEXTO,
        bairro: TEXTO,
        inscricao_imobiliaria: TEXTO,
        residencial: TEXTO,
        copropriedade: TEXTO,
        valor_total: TEXTO,
        vencimento: TEXTO,
        bem: TEXTO,
        ncm: TEXTO,
        quantidade: TEXTO,
      },
      required: [
        'tipo', 'cidade', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'inscricao_imobiliaria', 'residencial',
        'copropriedade', 'valor_total', 'vencimento', 'bem', 'ncm', 'quantidade',
      ],
      additionalProperties: false,
    },
    intencao: { type: 'string', enum: ['emitir', 'cancelar', 'outro'] },
  },
  required: ['tomador', 'documento', 'valor', 'modelo', 'descricao', 'prestador', 'iss_retido', 'aliquota_iss', 'inss_retido', 'inss', 'codigo_servico', 'servico', 'informacoes_complementares', 'municipio_prestacao', 'obra', 'locacao', 'intencao'],
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
  '- municipio_prestacao: a cidade onde o serviço foi prestado, só quando a mensagem diz ("serviço prestado em Campinas", "prestado em Campinas/SP", "realizado em Santos", "local da prestação: Jundiaí"), com a UF se vier escrita ("Campinas/SP"); senão null. A cidade do cliente, do endereço ou da empresa não é o local da prestação. Isso não entra em descricao.',
  '- obra: os dados da obra (construção civil, reforma, alvenaria) quando a mensagem traz o endereço ou o CNO da obra ("obra na Rua das Flores, 120, Centro, CEP 12900-000, Atibaia/SP", "endereço da obra: …", "CNO 12.345.67890/12"), ou quando a mensagem é só um endereço ou um CNO, que é a resposta à pergunta dos dados da obra. cno: o número do CNO ou CEI como escrito; cep: como escrito; logradouro: tipo e nome da rua ("Rua das Flores"); numero: o número do imóvel ("120", "s/n"); complemento: casa, bloco, lote, quadra, se houver; bairro; cidade: a cidade da obra com a UF se vier ("Atibaia/SP"). Campo não escrito fica "" (texto vazio); sem nada da obra, todos os campos de obra ficam "". O endereço da obra não entra em descricao nem em municipio_prestacao.',
  '- locacao: quando a nota é de aluguel ou locação ("nota de aluguel", "nota de locação", "aluguel do apartamento", "locação da betoneira"), ou quando a mensagem só traz os dados do imóvel ou do bem alugado, que é a resposta à pergunta da locação. tipo: "imovel" para casa, apartamento, sala, loja, galpão, terreno, imóvel; "movel" para carro, máquina, equipamento, betoneira, andaime, notebook, móvel; "" se a mensagem não diz. Do imóvel: cidade (com a UF se vier, "Campinas/SP"), cep, logradouro ("Rua das Flores"), numero, complemento (apto, sala, bloco), bairro, inscricao_imobiliaria (a inscrição do IPTU, se vier), residencial ("sim" para casa e apartamento ou quando diz residencial; "nao" para sala, loja, galpão ou quando diz comercial; senão null), copropriedade (a parte do dono quando diz, "50%"), valor_total (o aluguel inteiro, só quando a nota é de uma parte dele), vencimento (data do vencimento do aluguel, se vier). Do bem: bem (o que é, "Betoneira 400 litros"), ncm (como escrito), quantidade (o número de bens, "2"). Campo não escrito fica "" (texto vazio); sem nada de locação, tipo e todos os campos de locacao ficam "". Na locação, o tomador é o inquilino; o endereço e a cidade do imóvel não entram em descricao nem em municipio_prestacao, e não preencha servico nem codigo_servico.',
  'Não emita nem confirme nada: você só lê o pedido.',
].join('\n')

export function interpreteClaude(ia: Ia): Interprete {
  return {
    async interpretar(texto) {
      const { json, tokens } = await pedirJson(ia, {
        system: INSTRUCOES,
        content: texto,
        schema: SCHEMA_PARSED,
        maxTokens: 1024,
      })
      return { parsed: validarParsed(json), tokens }
    },
  }
}
