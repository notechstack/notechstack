// Conversa do agente no WhatsApp (critérios 11, 15 a 22, 28, 30 a 34 e 39). Máquina de
// estados determinística sobre `fiscal_requests` (Landing, lote B - estado da conversa):
// a IA só preenche `parsed` de uma mensagem nova; "confirmar", "sim", "não", o número da
// nota e o CPF/CNPJ e o e-mail do tomador são lidos aqui, por código. Emitir e cancelar só
// acontecem no "confirmar", pelo motor (`createOrGetInvoice` e `requestCancel`).
import { requestCancel } from '../cancel.js'
import type { Db, Queryable } from '../db.js'
import { lerInfoComplementar, MAX_INFO_COMPLEMENTAR, separarInfoComplementar } from '../info-complementar.js'
import { createOrGetInvoice } from '../invoices.js'
import {
  issNoLocalDaPrestacao,
  motivoDoLocal,
  PROBLEMAS_DE_LOCAL,
  problemaDoLocal,
  resolverMunicipio,
  rotuloMunicipio,
  ufDaResposta,
} from '../local-prestacao.js'
import { logEvent } from '../log.js'
import { exigeObra, lerObra, problemaDaObra, rotuloDaObra, type CampoDaObra, type Obra } from '../obra.js'
import type { InvoicePayload } from '../validation.js'
import {
  COLUNAS_DA_RETENCAO,
  linhasDaRetencao,
  motivoDaRetencao,
  padraoDaLinha,
  resolverRetencao,
  SEM_RETENCAO_PADRAO,
  type EnderecoNacional,
  type Retencao,
  type RetencaoDoPedido,
} from '../retencao.js'
import { tratarAtivacao } from './ativacao.js'
import { conversarNasBoasVindas } from './boas-vindas.js'
import { confirmarNumero, numeroPodeEmitir } from './cadastro.js'
import { textoComRetentativa, whatsappComRetentativa, type EnviaEmail, type EnviaWhatsApp } from './canais.js'
import { buscarServicos, type CatalogoDeServicos } from './catalogo-servicos.js'
import { conversaAssumida, registrarEvento } from './central.js'
import { tratarComando } from './comandos.js'
import { documentoNoTexto, emailNoTexto, formatarDocumento, formatarReais, tipoDoDocumento } from './documentos.js'
import {
  empresasDaConta,
  empresasDaResposta,
  empresasParaEscolher,
  empresasQueBatem,
  linhaDoEmitente,
  perguntaDoEmitente,
  type EmitenteDoPedido,
  type EmpresaDaConta,
} from './emitente.js'
import { validarParsed, type Interprete, type ObraEscrita, type Parsed } from './interprete.js'
import { linksDoSite, type Links } from './links.js'
import { lerPayload, numeroDaNota, payloadDaNota, type ServicoDoPedido, type TomadorDoPedido } from './notas.js'
import { registrarJanela } from './janela.js'
import { motivoDoProblema, receberPlanilha, responderAoLote, tipoDaPlanilha } from './lote.js'
import { MODELO_DA_PLANILHA, planoDeEscritorio, TEXTO_VER_NOTA } from './planos.js'
import { tratarPedidoDeModelo } from './modelo-emissao.js'
import { tratarVerNota } from './ver-nota.js'
import { dataBr, diaLocal, partesLocais } from './tempo.js'
import { ehSairDaEscolha, lerEscolhaDeNota, listaDeOpcoes, type Candidata } from './escolher-nota.js'
import { desmarcar, marcarUmaVez } from './uma-vez.js'
import type { BaixaMidia } from './whatsapp-cloud.js'
import { tratarNfeConversa } from './nfe-conversa.js'
import { tratarRespostaDeGuia } from '../guias/respostas.js'
import { blocos, campo, comRotulo, mensagem, topicos } from './formato.js'
import type { ArmazemDeGuias } from '../guias/storage.js'

export const VALIDADE_DO_PEDIDO_MS = 24 * 3600_000
export const MAX_CANDIDATAS = 5
export const DESCRICAO_PADRAO = 'Prestação de serviços'
/** Número oficial da Nó (Lucca, 22/10/2026): o dos Nós Agentes, dos disparos agendados e do atendimento. */
export const NUMERO_OFICIAL_DA_NO = '5511939289413'
export const WHATSAPP_COMERCIAL = `https://wa.me/${NUMERO_OFICIAL_DA_NO}`

export type MensagemRecebida = {
  /** `messages[].id` da Meta. */
  id: string
  /** Remetente em E.164, com o nono dígito (`comNonoDigito`): é por ele que o número acha a conta. */
  de: string
  /** O remetente exatamente como a Meta mandou (pode vir sem o 9); as respostas saem para ele. */
  enderecoRecebido?: string
  /** `messages[].type`: `text`, `document`, `image`… */
  tipo: string
  texto: string | null
  /** `midiaId` = `document.id` da Meta, para baixar a planilha do lote (conta Escritório). */
  arquivo: { nome: string | null; mime: string | null; midiaId?: string | null } | null
  /** Botão de resposta rápida de um modelo (`type: 'button'`): o texto do botão e o payload do envio (módulo Guias).
   * `texto` continua null nesse caso: a conversa das contas não muda. */
  botao?: { texto: string | null; payload: string | null } | null
}

/** Nome do CNPJ nos dados públicos (porta; sem cliente real neste lote). */
export interface ConsultaCnpj {
  razaoSocial(cnpj: string): Promise<string | null>
  /** Endereço do CNPJ na Receita, para a nota com ISS retido (E0237). Sem ele, o ISS retido não sai. */
  endereco?(cnpj: string): Promise<EnderecoNacional | null>
}

export type ConversaDeps = {
  db: Db
  whatsapp: EnviaWhatsApp
  interprete: Interprete
  links?: Links
  consultaCnpj?: ConsultaCnpj
  /** Descrição do código de serviço na conferência das boas-vindas (v2, lote C). */
  catalogo?: CatalogoDeServicos
  /** O agente tem número próprio, só do robô (Lucca, 29/10/2026): quem escreve sem conta é mandado ao número
   * oficial da Nó. Quem tem conta e pede uma pessoa é atendido no próprio número, pela central de conversas. */
  numeroProprio?: boolean
  /** Download da planilha do lote (`baixarMidia` da Cloud API); sem ele, a planilha é recusada com aviso. */
  midia?: BaixaMidia
  /** Módulo Guias: respostas dos contatos de guia (número que não emite). Sem ele, esses números seguem o caminho de sempre. */
  guias?: { email: EnviaEmail | null; storage: ArmazemDeGuias | null }
  now?: () => Date
}

// Textos revistos no "Roteiro do bot nó.fiscal" (Lucca, 22/10/2026): exemplo da LP (Studio Lima), confirmação
// que diz o que acontece e pontuação completa.
export const EXEMPLO_DE_PEDIDO = 'nota pra Studio Lima, 350 reais'
export const TEXTOS = {
  emitindo: 'Emitindo na Sefin. Em instantes mando a nota aqui e no seu e-mail.',
  expirou: 'Esse pedido expirou. Me mande o pedido de novo.',
  semPedido: `Não há pedido aguardando confirmação. Me mande o pedido da nota, por exemplo: ${EXEMPLO_DE_PEDIDO}.`,
  descartado: 'Ok, descartei esse pedido. Quando quiser, é só mandar outro.',
  oQueMuda: mensagem({
    titulo: 'Corrigir a nota',
    blocos: [
      [
        'O que muda? Me mande o cliente, o valor, a descrição ou o código do serviço certo. Por exemplo:',
        topicos(['valor 400 reais', 'descrição consultoria de outubro', 'código 04.08.02']),
      ],
    ],
    acao: 'Para desistir da nota, responda *descartar*.',
  }),
  naoEntendiACorrecao: mensagem({
    titulo: 'Corrigir a nota',
    blocos: ['Não entendi o que muda. Me mande o cliente, o valor, a descrição ou o código do serviço certo.'],
    acao: 'Responda *confirmar* para emitir como está ou *descartar* para desistir.',
  }),
  cancelamentoDesistido: 'Ok, nenhuma nota foi cancelada.',
  faltaValor: `Qual é o valor da nota? Me mande o cliente e o valor juntos, por exemplo: ${EXEMPLO_DE_PEDIDO}.`,
  faltaTomador: `Para quem é a nota? Me mande o cliente e o valor juntos, por exemplo: ${EXEMPLO_DE_PEDIDO}.`,
  faltaTudo: `Para quem é a nota e qual é o valor? Por exemplo: ${EXEMPLO_DE_PEDIDO}.`,
  ajuda: mensagem({
    titulo: 'O que eu faço',
    blocos: [
      [
        'Eu emito e cancelo notas fiscais. Por exemplo:',
        topicos([
          `"${EXEMPLO_DE_PEDIDO}"`,
          `"${EXEMPLO_DE_PEDIDO}, consultoria de outubro" (o serviço vai na descrição da nota)`,
          '"cancela a nota da Studio Lima de hoje"',
        ]),
      ],
      [
        'Para um serviço diferente do padrão, diga o código ou o serviço:',
        topicos([`"${EXEMPLO_DE_PEDIDO}, código 04.08.02"`, '"serviço de fisioterapia"']),
      ],
      TEXTO_VER_NOTA,
    ],
    acao: 'Para falar com a equipe da Nó, escreva *atendente*.',
  }),
  /** Conta Escritório: a ajuda cita também o pedido por empresa cliente, a planilha do mês (lote) e o modelo. */
  ajudaEscritorio: mensagem({
    titulo: 'O que eu faço',
    blocos: [
      ['Eu emito e cancelo notas fiscais. Por exemplo:', topicos([`"${EXEMPLO_DE_PEDIDO}"`, '"cancela a nota da Studio Lima de hoje"'])],
      ['Para emitir por uma empresa cliente, diga a empresa no pedido:', topicos(['"nota pela Oficina Trilho pra Studio Lima, 350 reais"'])],
      `Para emitir as notas do mês de uma vez, mande a planilha aqui (modelo: ${MODELO_DA_PLANILHA}). Se quiser o arquivo do modelo aqui, escreva *modelo*.`,
      'Para um serviço diferente do padrão, diga o código ou o serviço no pedido ("código 04.08.02", "serviço de fisioterapia") ou use a coluna codigo_servico da planilha.',
      TEXTO_VER_NOTA,
    ],
    acao: 'Para falar com a equipe da Nó, escreva *atendente*.',
  }),
  chamouAEquipe: 'Chamei a equipe da Nó: alguém te responde por aqui em breve. Enquanto isso, os pedidos de nota continuam funcionando.',
  naoEntendi: 'Não consegui entender agora. Tente de novo em alguns minutos.',
  soTexto: `Por enquanto eu só leio mensagens de texto. Me mande o pedido escrito, por exemplo: ${EXEMPLO_DE_PEDIDO}.`,
  escolherAntes: 'Antes, me diga qual nota você quer cancelar.',
  numeroConfirmado: 'Número confirmado. Você já pode pedir notas por aqui.',
  codigoRecusado: 'Esse código não vale (errado ou vencido). Peça um novo ao dono da conta no site da Nó.',
  modeloNaoSalvo: 'Ok, não salvei o modelo.',
  perguntaDeDescricao: mensagem({
    titulo: 'Descrição da nota',
    blocos: ['Como você quer descrever o serviço na nota? Me mande o texto, por exemplo: *Consultoria de marketing - outubro/2026*.'],
    acao: `Ou responda *padrão* para usar "${DESCRICAO_PADRAO}".`,
  }),
  descricaoLonga: 'Essa descrição passou de 2.000 caracteres. Me mande um texto mais curto ou responda *padrão*.',
  // Informações complementares (Lucca, 17/11/2026, pedido da Contabilidade Bragantina): duas mensagens depois do
  // primeiro resumo. A resposta em texto vira o campo; *confirmar* emite sem ele.
  perguntaInfoComplementar: mensagem({
    titulo: 'Informações complementares',
    blocos: ['Quer adicionar informações complementares (dados bancários, observações)?'],
    acao: 'Se sim, descreva aqui abaixo numa mensagem de até 2.000 caracteres.',
  }),
  semInfoComplementar: 'Se não, envie *CONFIRMAR*.',
  infoComplementarPedida: blocos(
    'Pode mandar: escreva aqui as informações complementares, numa mensagem de até 2.000 caracteres.',
    'Se não quiser, envie *confirmar*.',
  ),
  infoComplementarDispensada: 'Ok, sem informações complementares. Responda *confirmar* para emitir ou *corrigir* para mudar algo.',
} as const

/** A informação complementar passou do limite do leiaute (TSDescInfCompl). */
export const textoDeInfoLonga = (tamanho: number) =>
  `As informações complementares ficaram com ${tamanho.toLocaleString('pt-BR')} caracteres, e o limite da nota é ${MAX_INFO_COMPLEMENTAR.toLocaleString('pt-BR')}. Me mande um texto mais curto.`

// Quem não tem conta recebe esta resposta uma vez por dia e, no resto do dia, o bot fica quieto. No número
// dividido com o atendimento (Lucca, 22/10/2026), a equipe conversa pelo WhatsApp Business no mesmo número; no
// número próprio do agente (29/10/2026), a resposta manda a pessoa para o número oficial da Nó.
const recebidoPelaEquipe = (links: Links, numeroProprio = false) =>
  numeroProprio
    ? blocos(
        'Oi! Este é o número do nó.fiscal, que emite notas fiscais pelo WhatsApp para quem tem conta.',
        `Para criar a sua: ${links.site}.`,
        `Para falar com a equipe da Nó, chame no ${WHATSAPP_COMERCIAL}.`,
      )
    : blocos(
        'Oi! Aqui é a Nó. Recebi sua mensagem e alguém da nossa equipe te responde por aqui.',
        `Se você quer emitir notas fiscais pelo WhatsApp, crie sua conta no site: ${links.site}`,
      )

const recusaDeCertificado = (links: Links) =>
  blocos(
    'Por segurança, eu não recebo certificado pelo WhatsApp e não guardei o arquivo.',
    `Apague a mensagem com o arquivo e envie o certificado A1 na página segura: ${links.certificado}`,
  )

export function textoDoBloqueio(codigo: string, links: Links): string {
  switch (codigo) {
    case 'PAYMENT_NOT_APPROVED':
      return `Seu pagamento não foi aprovado. Atualize o cartão para continuar emitindo: ${links.assinatura}`
    case 'CERT_EXPIRED':
      return `Seu certificado venceu. Envie o novo na página segura: ${links.certificado}`
    case 'CERT_MISSING':
      return `Ainda não há certificado A1 cadastrado. Envie na página segura: ${links.certificado}`
    // Procuração eletrônica (migração 20261111180000).
    case 'PROCURACAO_NAO_ENCONTRADA':
      return mensagem({
        titulo: 'Procuração',
        blocos: [
          'A Receita ainda não mostra a sua procuração para o serviço NFS-e. Confira no Portal de Serviços da Receita (servicos.receitafederal.gov.br, Procurações) se ela foi assinada para o CNPJ indicado.',
          'Eu confiro de novo sozinho a cada poucos minutos.',
        ],
        acao: `Situação: ${links.certificado}`,
      })
    case 'PROCURACAO_MISSING':
    case 'PROCURACAO_INVALIDA':
      return `A procuração da sua empresa não está valendo. Faça de novo no Portal de Serviços da Receita, serviço NFS-e, ou envie o certificado A1: ${links.certificado}`
    case 'PROCURACAO_VENCIDA':
      return `A procuração da sua empresa venceu. Faça uma nova no Portal de Serviços da Receita, serviço NFS-e, e avise na página: ${links.certificado}`
    case 'PROCURADOR_CERT_INVALIDO':
      return blocos(
        'O certificado A1 do escritório, que assina as notas desta empresa por procuração, venceu ou não está cadastrado.',
        `Envie o A1 do escritório na página segura: ${links.certificado}`,
      )
    case 'NO_SUBSCRIPTION':
      return `Sua empresa ainda não tem assinatura. Assine para emitir: ${links.assinatura}`
    case 'SUBSCRIPTION_CANCELLED':
      return `Sua assinatura foi cancelada. Assine de novo para emitir: ${links.assinatura}`
    case 'FISCAL_CONFIG_MISSING':
      return `Falta concluir a configuração fiscal (código de serviço e, no Simples, percentual de tributos) no cadastro: ${links.site}`
    default:
      return `A emissão está desativada para a sua empresa. Fale com a Nó: ${WHATSAPP_COMERCIAL}`
  }
}

// ---------------------------------------------------------------------------------------
// Palavras lidas por código.

export const semAcento = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
export const limpa = (texto: string) => semAcento(texto).replace(/[.!?\s]+$/g, '')

export const ehConfirmar = (texto: string) => /^(confirmar|confirmo|confirma|confirmado|confirmada)$/.test(limpa(texto))
// Respostas de "pode emitir" no resumo da nota (Lucca, 04/11/2026: um cliente respondeu "Sim" ao resumo e o robô
// não emitiu). Confirma quando cada palavra da resposta é de concordância ou de enchimento, com pelo menos uma de
// concordância; qualquer outra palavra ("não", "mas", um valor) segue para corrigir ou para a IA, como antes.
const CONCORDANCIA = new Set([
  'confirmar', 'confirmo', 'confirma', 'confirmado', 'confirmada', 'sim', 's', 'ss', 'ok', 'okay', 'okk', 'pode', 'emite',
  'emitir', 'emita', 'manda', 'isso', 'certo', 'certinho', 'correto', 'perfeito', 'bora', 'vai', 'claro', 'beleza', 'blz',
  'positivo', 'yes', 'exato', 'exatamente', 'show', 'otimo', 'top', 'fechado', 'segue',
])
const ENCHIMENTO = new Set(['por', 'favor', 'pfv', 'pf', 'obrigado', 'obrigada', 'ai', 'agora', 'mesmo', 'pra', 'para', 'e', 'a', 'nota', 'tudo', 'ta', 'esta'])
/** Só emoji de positivo (👍 👌 ✅ ✔️), com ou sem tom de pele. */
const SINAL_DE_POSITIVO = /^(?:(?:\u{1F44D}|\u{1F44C}|\u{2705}|\u{2714})(?:\u{FE0F}|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})*\s*)+$/u
/** No resumo da nota: "sim", "pode emitir", "ok, tá certo", "👍" e parecidos também confirmam. */
export const ehConfirmarEmissao = (texto: string) => {
  if (ehConfirmar(texto) || SINAL_DE_POSITIVO.test(texto.trim())) return true
  const palavras = semAcento(texto).replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (!palavras.length || palavras.length > 8) return false
  return palavras.some((p) => CONCORDANCIA.has(p)) && palavras.every((p) => CONCORDANCIA.has(p) || ENCHIMENTO.has(p))
}
export const ehSim = (texto: string) => /^(sim|s|pode|pode salvar|salvar|salva|quero|pode substituir|substituir|substitui)$/.test(limpa(texto))
// "cancelar" não é "não" (Lucca, 22/10/2026): na confirmação de cancelamento ele confirma, e no resumo da nota ele
// desiste dela. Cada etapa lê com a lista certa abaixo.
export const ehNao = (texto: string) => /^(nao|n|corrigir|corrige|desistir|deixa|deixa pra la)$/.test(limpa(texto))
/** No resumo da nota: quer mudar algo, sem perder o pedido. */
export const ehCorrigir = (texto: string) => /^(corrigir|corrige|nao|n|errado|ta errado|esta errado|mudar|alterar)$/.test(limpa(texto))
/** Depois da pergunta das informações complementares: "sim" sozinho é querer adicionar, não emitir. */
export const ehQuerAdicionarInfo = (texto: string) =>
  /^(sim|s|ss|quero|sim quero|quero sim|quero adicionar|sim quero adicionar|adicionar|quero incluir|incluir|sim por favor|pode ser)$/.test(limpa(texto))
/** Depois da pergunta das informações complementares: não quer o campo (o pedido continua no resumo). */
export const ehSemInfo = (texto: string) =>
  /^(nao|n|nao quero|nao precisa|nao obrigad[oa]|nao, obrigad[oa]|sem|nenhuma|nada|sem informac(ao|oes)( complementares?)?)$/.test(limpa(texto))
/**
 * Com a pergunta aberta, uma mensagem que começa como pedido de nota ("nota pra Maria, 300", "emite…", "cancela a
 * nota…") é um pedido novo, não a informação complementar do pedido anterior.
 */
export const pareceNovoPedido = (texto: string) => /^((uma|nova|outra)\s+)?(nota|nf|nfs|nfse|nfs-e)\b|^(emit|emite|emita|cancel)/.test(limpa(texto))
/** Desiste do pedido aberto (nota ou cancelamento). */
export const ehDesistir = (texto: string) => /^(descartar|descarta|desistir|desisto|cancelar|cancela|deixa|deixa pra la|esquece)$/.test(limpa(texto))
/** Na confirmação de cancelamento de nota: cancelar a nota. */
export const ehConfirmarCancelamento = (texto: string) =>
  ehConfirmar(texto) || /^(cancelar|cancela|pode cancelar|sim|s)$/.test(limpa(texto))
/** Na confirmação de cancelamento de nota: manter a nota. */
export const ehManterNota = (texto: string) => /^(nao|n|manter|mantem|mantenha|deixa|deixa pra la|desistir|desisto)$/.test(limpa(texto))
/** Pede uma pessoa da equipe (Lucca, 22/10/2026: quem pede ajuda é atendido pela equipe no mesmo número). */
export const ehPedidoDeAtendimento = (texto: string) => {
  const t = limpa(texto)
  return (
    /^(ajuda|socorro|help|suporte|atendente|atendimento|humano)$/.test(t) ||
    /\b(atendente|atendimento humano|preciso de ajuda|quero ajuda|pode me ajudar|falar com (um |uma |o |a )?(atendente|humano|pessoa|alguem|equipe|suporte|voces))\b/.test(t)
  )
}

function ehCertificado(arquivo: MensagemRecebida['arquivo']): boolean {
  const nome = semAcento(arquivo?.nome ?? '')
  const mime = (arquivo?.mime ?? '').toLowerCase()
  return /\.(pfx|p12)$/.test(nome) || mime === 'application/x-pkcs12' || mime === 'application/pkcs12'
}

// ---------------------------------------------------------------------------------------
// Pedidos.

type Conversa = {
  tomador?: Partial<TomadorDoPedido>
  servico?: ServicoDoPedido
  valor?: string
  modelo_id?: string | null
  modelo_nome?: string
  candidatas?: { id: string; numero: string }[]
  /** Depois de "corrigir": o resumo continua valendo e a próxima mensagem diz o que muda. */
  corrigindo?: boolean
  /** Antes do resumo, com a descrição padrão: a próxima mensagem é a descrição da nota ou *padrão* (Lucca, 30/10/2026). */
  pedindoDescricao?: boolean
  /** Conta Escritório com mais de uma empresa ativa: a empresa que emite (`tenant_id` do pedido), mostrada no resumo. */
  emitente?: EmitenteDoPedido
  /** Etapa `escolher_prestador`: o pedido lido, à espera da empresa, e as empresas listadas na pergunta (na ordem). */
  pendente?: Parsed
  opcoes?: string[]
  /** O que o pedido disse da retenção ("sem retenção", "ISS retido 2%", "retém INSS 11%"); o resto vem da empresa. */
  retencao_pedido?: RetencaoDoPedido
  /** Retenção resolvida no último resumo (a que vai na nota) e o endereço do tomador (só com ISS retido, E0237). */
  retencao?: Retencao | null
  endereco?: EnderecoNacional | null
  /** O último resumo achou um problema na retenção: o *confirmar* não emite até corrigir. */
  retencao_problema?: string | null
  /** `serv/infoCompl/xInfComp` da nota, já normalizada (info-complementar.ts). */
  informacoes_complementares?: string | null
  /** A pergunta das informações complementares já foi feita neste pedido (só uma vez). */
  info_perguntada?: boolean
  /** A pergunta está aberta: a próxima mensagem em texto livre é a informação complementar. */
  info_aberta?: boolean
  /**
   * Local da prestação com nome de mais de uma cidade (Lucca, 18/11/2026): a pergunta da UF fica aberta na etapa
   * `escolher_prestador` (sem etapa nova no banco), com o pedido em `pendente` e a empresa já escolhida.
   */
  pergunta_uf?: { nome: string; ufs: string[] }
  emitente_id?: string | null
  /**
   * Dados da obra escritos até aqui (Robson, Bragantina, 19/11/2026), ainda incompletos ou já válidos: cada mensagem
   * soma o que trouxe, e o endereço só vai para `servico.obra` quando tem CEP, rua, número e bairro (ou o CNO).
   */
  obra_rascunho?: ObraEscrita | null
}

type Pedido = {
  id: string
  tenant_id: string
  phone_id: string
  kind: 'emitir' | 'cancelar'
  status: 'awaiting_confirmation' | 'confirmed' | 'expired' | 'rejected_by_user'
  etapa: 'dados_tomador' | 'confirmar' | 'escolher_nota' | 'salvar_modelo' | 'substituir_modelo' | 'escolher_prestador' | null
  conversa: Conversa
  invoice_id: string | null
  expires_at: Date
}

const COLUNAS_DO_PEDIDO = 'id, tenant_id, phone_id, kind, status, etapa, conversa, invoice_id, expires_at'

export type Contexto = {
  deps: ConversaDeps
  whatsapp: EnviaWhatsApp
  links: Links
  agora: Date
  para: string
  phoneId: string
  tenantId: string
  /** Pedido a que esta mensagem pertence (C39); `null` quando não pertence a nenhum. */
  pedidoId: string | null
  enviadas: number
  /** O WhatsApp sem a retentativa embutida, para quem precisa saber se o envio saiu (registro de entregas). */
  whatsappBruto?: EnviaWhatsApp
}

export async function responder(ctx: Pick<Contexto, 'whatsapp' | 'para'> & Partial<Contexto>, texto: string): Promise<void> {
  await ctx.whatsapp.enviarTexto(ctx.para, texto)
  if (ctx.enviadas !== undefined) ctx.enviadas++
}

async function ultimoPedido(db: Queryable, phoneId: string): Promise<Pedido | null> {
  const { rows } = await db.query<Pedido>(
    `select ${COLUNAS_DO_PEDIDO} from nofiscal.fiscal_requests where phone_id = $1 order by created_at desc, id desc limit 1`,
    [phoneId],
  )
  return rows[0] ?? null
}

async function criarPedido(
  ctx: Contexto,
  dados: {
    kind: 'emitir' | 'cancelar'
    etapa: NonNullable<Pedido['etapa']>
    parsed: Parsed
    conversa: Conversa
    invoiceId?: string | null
    tokens: { entrada: number; saida: number }
    /** A empresa que emite (conta Escritório); sem ela, a do telefone. */
    tenantId?: string
    /** O pedido que estava em `escolher_prestador` continua o mesmo, agora com a empresa escolhida. */
    reusar?: Pedido
  },
): Promise<string> {
  if (dados.reusar) {
    await ctx.deps.db.query(
      `update nofiscal.fiscal_requests set tenant_id = $2, etapa = $3, conversa = $4::jsonb, updated_at = $5
        where id = $1 and status = 'awaiting_confirmation'`,
      [dados.reusar.id, dados.tenantId ?? ctx.tenantId, dados.etapa, JSON.stringify(dados.conversa), ctx.agora],
    )
    ctx.pedidoId = dados.reusar.id
    return dados.reusar.id
  }
  // `created_at` é a ordem real de chegada (relógio do banco): a conversa responde ao pedido
  // mais recente, e dois pedidos no mesmo instante do relógio da conversa não podem empatar.
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `insert into nofiscal.fiscal_requests
       (tenant_id, phone_id, kind, status, parsed, expires_at, invoice_id, etapa, conversa,
        ai_input_tokens, ai_output_tokens, created_at, updated_at)
     values ($1, $2, $3, 'awaiting_confirmation', $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10, clock_timestamp(), $11)
     returning id`,
    [
      dados.tenantId ?? ctx.tenantId,
      ctx.phoneId,
      dados.kind,
      JSON.stringify(dados.parsed),
      new Date(ctx.agora.getTime() + VALIDADE_DO_PEDIDO_MS),
      dados.invoiceId ?? null,
      dados.etapa,
      JSON.stringify(dados.conversa),
      dados.tokens.entrada,
      dados.tokens.saida,
      ctx.agora,
    ],
  )
  ctx.pedidoId = rows[0].id
  return rows[0].id
}

async function atualizarPedido(db: Queryable, id: string, etapa: Pedido['etapa'], conversa: Conversa, agora: Date): Promise<void> {
  await db.query('update nofiscal.fiscal_requests set etapa = $2, conversa = $3::jsonb, updated_at = $4 where id = $1', [
    id,
    etapa,
    JSON.stringify(conversa),
    agora,
  ])
}

/** Soma as mensagens de WhatsApp (recebidas e enviadas) ao pedido (C39). */
export async function contarMensagens(db: Queryable, pedidoId: string, quantidade: number): Promise<void> {
  if (quantidade <= 0) return
  await db.query('update nofiscal.fiscal_requests set message_count = message_count + $2 where id = $1', [pedidoId, quantidade])
}

/** Tarefa agendada (worker) e checagem no "confirmar": pedido sem confirmação em 24h vira `expired`. */
export async function expirarPedidos(db: Queryable, agora: Date, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const { rowCount } = await db.query(
    `update nofiscal.fiscal_requests
        set status = 'expired', etapa = null, updated_at = $1
      where status = 'awaiting_confirmation' and expires_at <= $1
        and ($2::uuid[] is null or tenant_id = any($2::uuid[]))`,
    [agora, opcoes.tenantIds ?? null],
  )
  return rowCount
}

async function bloqueioDaEmissao(db: Queryable, tenantId: string): Promise<string | null> {
  const { rows } = await db.query<{ bloqueio: string | null }>('select nofiscal.emission_block($1) as bloqueio', [tenantId])
  return rows[0]?.bloqueio ?? null
}

// ---------------------------------------------------------------------------------------
// Textos montados.

/** `040101` → `04.01.01`, como na lista nacional. */
export const formatarCodigoServico = (codigo: string) => (/^\d{6}$/.test(codigo) ? codigo.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1.$2.$3') : codigo)

export const PERGUNTA_DE_EMISSAO = 'Posso emitir? Responda *confirmar* para emitir ou *corrigir* para mudar algo.'

/** `nomeDoServico` = a descrição do código na lista nacional (catálogo), quando há. */
export function textoDoResumo(
  tomador: TomadorDoPedido,
  servico: ServicoDoPedido,
  valor: string,
  nomeDoServico?: string | null,
  emitente?: EmitenteDoPedido | null,
  retencao?: Retencao | null,
  informacoesComplementares?: string | null,
  /** "Campinas/SP": só quando o local da prestação é outro que não o município da empresa (ou o serviço é de obra). */
  localPrestacao?: string | null,
): string {
  return mensagem({
    titulo: 'Resumo da nota',
    blocos: [
      [
        emitente && comRotulo(linhaDoEmitente(emitente)),
        campo('Tomador', tomador.nome),
        campo(tipoDoDocumento(tomador.documento).toUpperCase(), formatarDocumento(tomador.documento)),
      ],
      [
        campo('Serviço', `${formatarCodigoServico(servico.codigo)}${nomeDoServico ? ` ${nomeDoServico}` : ''}`),
        campo('Descrição na nota', servico.descricao),
        localPrestacao && campo('Local da prestação', localPrestacao),
        servico.obra && campo('Obra', rotuloDaObra(servico.obra)),
      ],
      [campo('Valor', formatarReais(valor)), ...linhasDaRetencao(valor, retencao).map(comRotulo)],
      informacoesComplementares && campo('Informações complementares', informacoesComplementares),
    ],
    acao: PERGUNTA_DE_EMISSAO,
  })
}

export const TEXTO_LOCAL_CORRIGIR =
  'Responda *descartar* e emita esta nota pelo emissor da prefeitura ou da Sefin, ou *corrigir* e me diga outro código de serviço.'

/** "Campinas/SP", e o aviso de que o ISS é devido lá quando o código é dos tributados no local (E1317). */
export const rotuloDoLocal = (ibge: string, codigo: string) =>
  `${rotuloMunicipio(ibge)}${issNoLocalDaPrestacao(codigo) ? ' (o ISS deste serviço é devido nessa cidade)' : ''}`

const NOMES_DOS_CAMPOS: Record<CampoDaObra, string> = { cep: 'CEP', logradouro: 'rua', numero: 'número', bairro: 'bairro' }

/**
 * Código de construção civil sem os dados da obra (E0370). O pedido fica em correção: a próxima mensagem (o endereço
 * ou o CNO) completa o pedido, sem precisar escrever *corrigir*.
 */
export function textoDaObraQueFalta(rascunho: ObraEscrita | null | undefined, cidadeDaEmpresa: string | null): string {
  const lida = rascunho ? lerObra(rascunho) : null
  const faltando = lida && !lida.ok ? lida.faltando : []
  const cidade = cidadeDaEmpresa ? ` e a cidade, se não for ${cidadeDaEmpresa}` : ' e a cidade'
  if (faltando.length && faltando.length < 4) {
    const nomes = faltando.map((c) => NOMES_DOS_CAMPOS[c])
    const lista = nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0]
    return `Faltou no endereço da obra: ${lista}. Me mande o que falta, e eu monto a nota. Ou responda *descartar*.`
  }
  return mensagem({
    titulo: 'Dados da obra',
    blocos: [
      'Este serviço é de construção civil, e a Sefin exige os dados da obra na nota. Nada foi emitido ainda.',
      `Me mande o endereço da obra: rua, número, bairro, CEP${cidade}. Por exemplo: Rua das Flores, 120, Centro, CEP 12900-000, Atibaia/SP.`,
      'Se a obra tem CNO, pode mandar só o número dele.',
    ],
    acao: 'Para desistir, responda *descartar*.',
  })
}

/** Soma o que a mensagem trouxe da obra ao rascunho; `obra` só quando o resultado é válido. */
export function juntarObra(
  rascunho: ObraEscrita | null | undefined,
  nova: ObraEscrita | null | undefined,
): { rascunho: ObraEscrita | null; obra: Obra | null } {
  const semCidade: ObraEscrita = { ...(nova ?? {}) }
  delete semCidade.cidade
  // CNO novo ou endereço novo completo valem sozinhos; o resto soma ao que já veio.
  const novoCompleto = lerObra(semCidade)
  const base = novoCompleto.ok && novoCompleto.obra ? {} : (rascunho ?? {})
  const junto: ObraEscrita = { ...base, ...semCidade }
  if (!Object.values(junto).some(Boolean)) return { rascunho: null, obra: null }
  const lida = lerObra(junto)
  return { rascunho: junto, obra: lida.ok ? lida.obra : null }
}

/** A cidade da obra vira o local da prestação quando o pedido não diz outro (o ISS da obra é devido lá, E1317). */
export function comCidadeDaObra(parsed: Parsed): Parsed {
  if (parsed.municipio_prestacao || !parsed.obra?.cidade) return parsed
  return { ...parsed, municipio_prestacao: parsed.obra.cidade }
}

export const TEXTO_SEM_RETENCAO_POSSIVEL =
  'Responda *corrigir* e me diga a retenção certa (por exemplo: ISS retido 2%, INSS 11%, ou sem retenção), ou *descartar*.'

/**
 * Retenção pedida no WhatsApp e não cadastrada no painel (Lucca, 16/11/2026): o pedido só retém o que a empresa tem
 * marcado em Minha conta → Minhas empresas (Adicionar empresa ou Dados fiscais). A alíquota ou o valor escritos no
 * pedido valem para a nota; o que precisa estar cadastrado é o tipo de retenção (ISS, INSS).
 */
export const NAO_CADASTRADA = { ISS_NAO_CADASTRADO: 'ISS', INSS_NAO_CADASTRADO: 'INSS' } as const

function textoDoProblemaDeRetencao(ctx: Pick<Contexto, 'links'>, problema: string, empresa?: string | null): string {
  if ((PROBLEMAS_DE_LOCAL as readonly string[]).includes(problema)) {
    return mensagem({
      titulo: 'Local da prestação',
      blocos: [`Não dá para emitir esta nota com outro local da prestação: ${motivoDoLocal(problema)}. Nada foi emitido.`],
      acao: TEXTO_LOCAL_CORRIGIR,
    })
  }
  const tipo = NAO_CADASTRADA[problema as keyof typeof NAO_CADASTRADA]
  if (tipo) {
    return mensagem({
      titulo: 'Retenção não cadastrada',
      blocos: [
        `A retenção de ${tipo} não está cadastrada para ${empresa ?? 'a empresa que emite'}, e nada foi emitido.`,
        `Cadastre em Minha conta → Minhas empresas → Dados fiscais (${ctx.links.conta}#empresas), marcando "Tem retenção de ${tipo}?", e depois responda *corrigir* com a retenção.`,
      ],
      acao: 'Se a nota não tem retenção, responda *corrigir* e diga sem retenção.',
    })
  }
  return mensagem({
    titulo: 'Retenção',
    blocos: [`Não dá para emitir esta nota assim: ${motivoDaRetencao(problema)}.`],
    acao: TEXTO_SEM_RETENCAO_POSSIVEL,
  })
}

/**
 * Retenção desta nota (Lucca, 16/11/2026): o pedido manda, o resto é o padrão da empresa que emite. Com ISS retido, o
 * endereço do tomador vem da Receita (E0237). Grava o resultado no pedido, na etapa `confirmar`, e devolve o resumo
 * (com a descrição do código buscada no catálogo) ou o problema; com problema, o *confirmar* não emite.
 */
async function resumoDoPedido(ctx: Contexto, pedidoId: string, tenantId: string, conversa: Conversa): Promise<string[]> {
  const tomador = conversa.tomador as TomadorDoPedido
  const valor = conversa.valor as string
  const { rows } = await ctx.deps.db.query<Record<string, unknown>>(
    `select regime, razao_social, codigo_municipio_ibge, ${COLUNAS_DA_RETENCAO} from nofiscal.fiscal_tenants where id = $1`,
    [tenantId],
  )
  const linha = rows[0]
  // O local da prestação igual ao município da empresa sai do pedido: a nota fica como sempre foi.
  const sede = typeof linha?.codigo_municipio_ibge === 'string' ? linha.codigo_municipio_ibge : null
  const servicoLido = conversa.servico as ServicoDoPedido
  let servico: ServicoDoPedido =
    servicoLido.municipio_prestacao_ibge && servicoLido.municipio_prestacao_ibge === sede ? { ...servicoLido, municipio_prestacao_ibge: null } : servicoLido
  const local = servico.municipio_prestacao_ibge ?? null
  const padrao = linha ? padraoDaLinha(linha) : SEM_RETENCAO_PADRAO
  const regime = typeof linha?.regime === 'string' ? linha.regime : null
  const resolvida = resolverRetencao({ padrao, pedido: conversa.retencao_pedido, valor, regime, tomadorTipo: tipoDoDocumento(tomador.documento) })
  let problema: string | null = resolvida.ok ? null : resolvida.problema
  // O tipo de retenção pedido precisa estar cadastrado no painel (o MEI cai antes, em RETENCAO_MEI).
  if (resolvida.ok && resolvida.retencao) {
    if (resolvida.retencao.iss && !padrao.retem_iss) problema = 'ISS_NAO_CADASTRADO'
    else if (resolvida.retencao.inss && !padrao.retem_inss) problema = 'INSS_NAO_CADASTRADO'
  }
  const nomeDaEmpresa = typeof linha?.razao_social === 'string' ? linha.razao_social : null
  const retencao = resolvida.ok && !problema ? resolvida.retencao : null
  if (!problema) problema = problemaDoLocal({ codigo: servico.codigo, municipioPrestacao: local })
  // E0370: código de construção civil sem os dados da obra. Fora desses códigos, a obra não vai na nota.
  if (!exigeObra(servico.codigo) && servico.obra) servico = { ...servico, obra: null }
  const faltaObra = !problema && problemaDaObra({ codigo: servico.codigo, obra: servico.obra }) !== null
  if (faltaObra) problema = 'OBRA_SEM_DADOS'
  let endereco: EnderecoNacional | null = null
  if (retencao?.iss) {
    const consulta = ctx.deps.consultaCnpj
    endereco = consulta?.endereco ? await consulta.endereco(tomador.documento).catch(() => null) : null
    if (!endereco) problema = 'ENDERECO_TOMADOR'
  }
  // Informações complementares: no primeiro resumo sem elas, duas mensagens perguntam (uma vez por pedido).
  const perguntar = !problema && !conversa.informacoes_complementares && !conversa.info_perguntada
  const atualizada: Conversa = {
    ...conversa,
    servico,
    retencao,
    endereco,
    retencao_problema: problema,
    // Sem os dados da obra, a próxima mensagem já é lida como a correção (o endereço ou o CNO).
    corrigindo: faltaObra,
    info_perguntada: Boolean(conversa.info_perguntada || perguntar),
    info_aberta: perguntar,
  }
  await atualizarPedido(ctx.deps.db, pedidoId, 'confirmar', atualizada, ctx.agora)
  if (faltaObra) {
    logEvent('agente.obra_pedida', { request_id: pedidoId, tenant_id: tenantId, parcial: Boolean(conversa.obra_rascunho) })
    return [textoDaObraQueFalta(conversa.obra_rascunho, sede ? rotuloMunicipio(sede) : null)]
  }
  if (problema) {
    logEvent('agente.retencao_recusada', { request_id: pedidoId, tenant_id: tenantId, problema })
    return [textoDoProblemaDeRetencao(ctx, problema, nomeDaEmpresa)]
  }
  const nome = ctx.deps.catalogo ? await ctx.deps.catalogo.descricao(servico.codigo).catch(() => null) : null
  const resumo = textoDoResumo(
    tomador,
    servico,
    valor,
    nome,
    conversa.emitente,
    retencao,
    conversa.informacoes_complementares,
    // Na obra, o local aparece sempre (é onde o ISS é devido), mesmo sendo a cidade da empresa.
    local ? rotuloDoLocal(local, servico.codigo) : servico.obra && sede ? rotuloDoLocal(sede, servico.codigo) : null,
  )
  return perguntar ? [resumo, TEXTOS.perguntaInfoComplementar, TEXTOS.semInfoComplementar] : [resumo]
}

/** O resumo (e, no primeiro, a pergunta das informações complementares), uma mensagem por vez. */
async function enviarResumo(ctx: Contexto, pedidoId: string, tenantId: string, conversa: Conversa): Promise<void> {
  for (const texto of await resumoDoPedido(ctx, pedidoId, tenantId, conversa)) await responder(ctx, texto)
}

/**
 * Resposta à pergunta das informações complementares. *confirmar* (e "ok", o polegar…) emite; "sim" sozinho pede o
 * texto; "não" fecha a pergunta; *corrigir* e *descartar* como no resumo. Qualquer outro texto é a informação: o
 * resumo volta com ela e pede *confirmar*, sem perguntar de novo.
 */
async function responderInfoComplementar(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  ctx.pedidoId = pedido.id
  if (ehQuerAdicionarInfo(texto)) {
    await responder(ctx, TEXTOS.infoComplementarPedida)
    return true
  }
  if (ehConfirmarEmissao(texto)) {
    await confirmar(ctx, pedido)
    return true
  }
  if (ehDesistir(texto)) {
    await descartar(ctx, pedido)
    return true
  }
  if (ehSemInfo(texto)) {
    await atualizarPedido(ctx.deps.db, pedido.id, 'confirmar', { ...pedido.conversa, info_aberta: false }, ctx.agora)
    await responder(ctx, TEXTOS.infoComplementarDispensada)
    return true
  }
  if (ehCorrigir(texto)) {
    await atualizarPedido(ctx.deps.db, pedido.id, 'confirmar', { ...pedido.conversa, info_aberta: false, corrigindo: true }, ctx.agora)
    await responder(ctx, TEXTOS.oQueMuda)
    return true
  }
  // Pedido novo: segue para a IA, como antes desta pergunta existir (o pedido aberto fica como está).
  if (pareceNovoPedido(texto)) return false
  const lida = lerInfoComplementar(texto)
  if (!lida.ok) {
    await responder(ctx, textoDeInfoLonga(lida.tamanho))
    return true
  }
  if (!lida.texto) {
    await responder(ctx, TEXTOS.infoComplementarPedida)
    return true
  }
  logEvent('agente.info_complementar', { request_id: pedido.id, tamanho: lida.texto.length })
  await enviarResumo(ctx, pedido.id, pedido.tenant_id, { ...pedido.conversa, informacoes_complementares: lida.texto, info_aberta: false })
  return true
}

/**
 * Pedido escrito com informações complementares ("Dados bancários: …", "Obs: …"): o trecho sai do texto que vai para
 * a IA e entra no campo, por código. Sem marcador, vale o que a IA leu (`informacoes_complementares`).
 */
function textoParaAIa(texto: string): { paraIa: string; info: string | null } {
  const separado = separarInfoComplementar(texto)
  if (!separado.info) return { paraIa: texto, info: null }
  // Marcador logo no começo ("Obs: … nota pra Maria 300"): a IA lê a mensagem inteira, e a descrição é limpa depois.
  return { paraIa: separado.pedido.length >= 3 ? separado.pedido : texto, info: separado.info }
}

function comInfoComplementar(parsed: Parsed, info: string | null): Parsed {
  if (!info) return parsed
  const descricao = parsed.descricao ? separarInfoComplementar(parsed.descricao).pedido || null : null
  return { ...parsed, descricao, informacoes_complementares: info }
}

/**
 * "serviço prestado em Campinas", "realizado em Santos/SP", "local da prestação: Jundiaí" (Lucca, 18/11/2026). Rede de
 * segurança para quando a IA não preenche `municipio_prestacao`: o trecho vai até a vírgula, o ponto ou o valor.
 */
const LOCAL_NO_TEXTO =
  /\b(?:(?:prestad|realizad|executad)[oa]s?\s+(?:em|no municipio de|na cidade de)|local da prestacao(?:\s+(?:em|e))?\s*:?)\s+([^,;\n]+?)(?:\s*,\s*([a-z]{2})\b)?(?=\s*(?:[,;\n]|\.(?:\s|$)|\s+(?:no valor|valor|por|para|pra|de r\$|r\$|\d)|$))/

export function localNoTexto(texto: string): string | null {
  const m = LOCAL_NO_TEXTO.exec(semAcento(texto))
  if (!m) return null
  return m[2] ? `${m[1].trim()}/${m[2]}` : m[1].trim()
}

const FRASE_DO_LOCAL = /[,;\s-]*\b(?:servi[cç]o\s+)?(?:prestad|realizad|executad)[oa]s?\s+(?:em|no munic[ií]pio de|na cidade de)\s+[^,;]+/i

/** `parsed` com o local escrito no texto, quando a IA não leu; a frase do local não fica na descrição. */
function comLocalDoTexto(parsed: Parsed, texto: string): Parsed {
  const municipio_prestacao = parsed.municipio_prestacao ?? localNoTexto(texto)
  if (!municipio_prestacao) return parsed
  const descricao = parsed.descricao ? parsed.descricao.replace(FRASE_DO_LOCAL, '').trim() || null : null
  return { ...parsed, descricao, municipio_prestacao }
}

/** Local da prestação do pedido: o código IBGE, a pergunta da UF (cidade homônima) ou o texto de recusa. */
export type LocalDoPedido = { ibge: string } | { ambiguo: { nome: string; ufs: string[] } } | { texto: string }

export function localDoPedido(escrito: string | null | undefined): LocalDoPedido | null {
  if (!escrito) return null
  const r = resolverMunicipio(escrito)
  if (r.ok) return { ibge: r.municipio.ibge }
  if (r.motivo === 'ambiguo') return { ambiguo: { nome: r.nome, ufs: r.opcoes.map((m) => m.uf) } }
  const comUf = r.motivo === 'uf_errada' ? ' com essa UF' : ''
  return { texto: `Não achei a cidade "${escrito}"${comUf} na tabela do IBGE. Escreva a cidade com a UF, por exemplo: prestado em Campinas/SP.` }
}

export const perguntaDaUf = (p: { nome: string; ufs: string[] }) =>
  `Há ${p.ufs.length} cidades chamadas ${p.nome} (${p.ufs.join(', ')}). Em qual estado o serviço foi prestado? Responda a UF, por exemplo: ${p.ufs[0]}.`

/**
 * O texto fala de retenção ("tem retenção de ISS pela tomadora na alíquota de 2,01%", "ISS retido", "retém INSS").
 * Caso real de 16/11/2026: o pedido citava a retenção e a nota saiu sem ela. Se a IA não ler qual é a retenção, o
 * pedido não segue (TEXTO_RETENCAO_NAO_ENTENDIDA): nota com retenção nunca sai sem ela.
 */
export const mencionaRetencao = (texto: string) => /\b(retenc\w*|retid[oa]s?|retem|reter)\b/.test(semAcento(texto))

const JEITOS_DE_DIZER_A_RETENCAO = topicos(['ISS retido 2% (a alíquota)', 'INSS retido 11% (ou o valor, 165,00)', 'sem retenção'])

export const TEXTO_RETENCAO_NAO_ENTENDIDA = mensagem({
  titulo: 'Retenção',
  blocos: ['Vi que o pedido fala de retenção, mas não entendi qual. Nada foi emitido.'],
  acao: `Mande o pedido de novo dizendo a retenção assim:\n${JEITOS_DE_DIZER_A_RETENCAO}`,
})

/** O que o pedido escrito diz da retenção (campos do intérprete); `undefined` quando não diz nada. */
export function retencaoDoParsed(parsed: Parsed): RetencaoDoPedido | undefined {
  const r: RetencaoDoPedido = {}
  if (typeof parsed.iss_retido === 'boolean') r.iss = parsed.iss_retido
  if (parsed.aliquota_iss) r.aliquotaIss = parsed.aliquota_iss
  if (typeof parsed.inss_retido === 'boolean') r.inss = parsed.inss_retido
  if (parsed.inss) r.inssTexto = parsed.inss
  return Object.keys(r).length ? r : undefined
}

/**
 * O serviço lido pela IA só vale quando a mensagem fala em serviço ou código ("serviço de fisioterapia", "código de
 * nutrição"): uma descrição comum ("consultoria de outubro") nunca troca o código da nota.
 */
export const pedeServicoNoTexto = (texto: string) => /\b(servic\w*|codigo|cod|item)\b/.test(semAcento(texto))

/** `parsed` sem o serviço quando o texto não pede serviço nem código. */
const servicoSoSePedido = (parsed: Parsed, texto: string): Parsed =>
  parsed.servico && !pedeServicoNoTexto(texto) ? { ...parsed, servico: null } : parsed

/** O código escolhido no pedido, ou o texto que explica por que não deu (e nada segue). */
export type CodigoDoPedido = { codigo: string } | { texto: string }

/**
 * Código de serviço pedido no WhatsApp (Lucca, 17/11/2026: a clínica emite psicologia, fisioterapia e nutrição pela
 * mesma empresa). "código 04.03.01" vale se estiver na lista nacional (lista fora do ar: vale o formato, e a Sefin
 * confere). "serviço de fisioterapia" acha o código pela descrição; com mais de um, fica o que a empresa já usa
 * (`conhecidos`: o padrão e os dos clientes salvos), senão a pessoa escolhe. `null` = o pedido não cita código nem
 * serviço, e vale o do cliente ou o da empresa. `fim` fecha o texto de recusa ("mande o pedido de novo…").
 */
export async function codigoDoPedido(
  catalogo: CatalogoDeServicos | undefined,
  parsed: Pick<Parsed, 'codigo_servico' | 'servico'>,
  conhecidos: () => Promise<string[]>,
  fim = 'Mande o pedido de novo com o código, por exemplo: nota pra Studio Lima, 350, código 04.08.02. Nada foi emitido.',
): Promise<CodigoDoPedido | null> {
  if (!parsed.codigo_servico && !parsed.servico) return null
  const itens = catalogo?.itens ? await catalogo.itens().catch(() => null) : null
  const lista = itens && itens.size ? itens : null
  if (parsed.codigo_servico) {
    if (lista && !lista.has(parsed.codigo_servico)) {
      return { texto: blocos(`O código ${formatarCodigoServico(parsed.codigo_servico)} não está na lista nacional de serviços. Confira o código.`, fim) }
    }
    return { codigo: parsed.codigo_servico }
  }
  const servico = parsed.servico as string
  if (!lista) return { texto: blocos(`Não consegui consultar a lista nacional de serviços agora para achar "${servico}".`, fim) }
  let achados = buscarServicos(lista, servico)
  if (achados.length > 1) {
    const usados = new Set(await conhecidos())
    const daEmpresa = achados.filter((c) => usados.has(c))
    if (daEmpresa.length === 1) achados = daEmpresa
  }
  if (achados.length === 1) return { codigo: achados[0] }
  if (!achados.length) return { texto: blocos(`Não achei "${servico}" na lista nacional de serviços.`, fim) }
  const MOSTRADOS = 6
  return {
    texto: mensagem({
      titulo: 'Código de serviço',
      blocos: [
        [
          `Achei mais de um serviço para "${servico}":`,
          topicos([
            ...achados.slice(0, MOSTRADOS).map((c) => `${formatarCodigoServico(c)} ${lista.get(c) ?? ''}`.trimEnd()),
            ...(achados.length > MOSTRADOS ? [`e mais ${achados.length - MOSTRADOS}.`] : []),
          ]),
        ],
      ],
      acao: fim.replace('código 04.08.02', `código ${formatarCodigoServico(achados[0])}`),
    }),
  }
}

/** Os códigos que a empresa já usa: o padrão e os dos clientes salvos. */
async function codigosDaEmpresa(db: Queryable, tenantId: string): Promise<string[]> {
  const { rows } = await db.query<{ codigo: string | null }>(
    `select codigo_servico_nacional as codigo from nofiscal.fiscal_tenants where id = $1
     union select codigo_servico_nacional from nofiscal.fiscal_models where tenant_id = $1`,
    [tenantId],
  )
  return rows.map((r) => r.codigo).filter((c): c is string => Boolean(c))
}

/**
 * O bloqueio da empresa que emite. Pela empresa do telefone, o texto de sempre; por outra empresa do escritório, o
 * motivo nomeando a empresa (como na planilha) e onde resolver. Assinatura e pagamento são da conta: texto de sempre.
 */
function textoDoBloqueioDoEmitente(ctx: Contexto, codigo: string, emitente?: EmitenteDoPedido | null): string {
  const daConta = ['PAYMENT_NOT_APPROVED', 'NO_SUBSCRIPTION', 'SUBSCRIPTION_CANCELLED'].includes(codigo)
  if (!emitente || emitente.id === ctx.tenantId || daConta) return textoDoBloqueio(codigo, ctx.links)
  return blocos(
    `Não dá para emitir por ${emitente.razao_social}: ${motivoDoProblema(codigo, { empresa: emitente.razao_social })}.`,
    `Resolva em Minha conta → Minhas empresas: ${ctx.links.conta}#empresas`,
  )
}

const perguntaDeCancelamento = (c: Candidata) =>
  mensagem({
    titulo: 'Cancelar nota',
    blocos: [
      [
        campo('Nota', `nº ${c.numero}`),
        c.empresa && campo('Emitente', c.empresa),
        campo('Tomador', c.nome),
        campo('Valor', c.valor ? formatarReais(c.valor) : '-'),
        campo('Emitida em', dataBr(c.emitidaEm)),
      ],
    ],
    acao: 'Cancelo esta nota? Responda *confirmar* para cancelar ou *manter* para deixar como está.',
  })

// ---------------------------------------------------------------------------------------
// Entrada.

/**
 * Processa uma mensagem recebida, uma vez só por `messages[].id` (C23). Se algo falha, a
 * marca é desfeita e o erro sobe, para a Meta reentregar.
 */
export async function processarMensagem(deps: ConversaDeps, msg: MensagemRecebida): Promise<{ duplicada: boolean }> {
  const chave = `wa:${msg.id}`
  if (!(await marcarUmaVez(deps.db, chave))) return { duplicada: true }
  try {
    await tratar(deps, msg)
  } catch (error) {
    await desmarcar(deps.db, chave).catch(() => undefined)
    throw error
  }
  return { duplicada: false }
}

/** Respostas a `msg.de` saem para o endereço que a Meta mandou (o número sem o 9, quando veio assim). */
function noEnderecoRecebido(whatsapp: EnviaWhatsApp, msg: MensagemRecebida): EnviaWhatsApp {
  const original = msg.enderecoRecebido
  if (!original || original === msg.de) return whatsapp
  const para = (destino: string) => (destino === msg.de ? original : destino)
  return {
    enviarTexto: (destino, texto) => whatsapp.enviarTexto(para(destino), texto),
    enviarDocumento: (destino, anexo, legenda) => whatsapp.enviarDocumento(para(destino), anexo, legenda),
    enviarModelo: (destino, nome, parametros, extras) => whatsapp.enviarModelo(para(destino), nome, parametros, extras),
  }
}

async function tratar(deps: ConversaDeps, msg: MensagemRecebida): Promise<void> {
  const whatsapp = whatsappComRetentativa(noEnderecoRecebido(deps.whatsapp, msg))
  const links = deps.links ?? linksDoSite()
  const agora = (deps.now ?? (() => new Date()))()
  const fora = { whatsapp, para: msg.de }

  // Critério 11: o A1 nunca entra pelo WhatsApp, de ninguém. A mídia nem é baixada.
  if (msg.tipo === 'document' && ehCertificado(msg.arquivo)) {
    logEvent('agente.certificado_recusado', { message_id: msg.id })
    await responder(fora, recusaDeCertificado(links))
    return
  }

  // Janela de 24 h da Meta (v2, lote C): toda mensagem de um número cadastrado conta.
  await registrarJanela(deps.db, msg.de, agora)

  // Conversa assumida na central (29/10/2026): a equipe responde e o robô fica quieto neste número.
  if (await conversaAssumida(deps.db, msg.de, agora)) {
    logEvent('agente.conversa_com_a_equipe', { message_id: msg.id })
    return
  }

  // Ativação do WhatsApp do dono (critérios 26 a 28): o número ainda não emite.
  if (await tratarAtivacao({ db: deps.db, whatsapp, links, agora, catalogo: deps.catalogo }, msg)) return

  const numero = await numeroPodeEmitir(deps.db, msg.de)
  if (!numero) {
    // Módulo Guias: o contato que recebe guias responde ao escritório ("paguei", "2ª via", "SAIR"…).
    if (deps.guias) {
      const guias = { db: deps.db, whatsapp: noEnderecoRecebido(deps.whatsapp, msg), email: deps.guias.email, storage: deps.guias.storage, now: deps.now }
      // Falha do módulo (ex.: tabela ainda não migrada) nunca tira a resposta de sempre de quem não é contato de guia.
      const tratada = await tratarRespostaDeGuia(guias, msg).catch((error: unknown) => {
        logEvent('guias.resposta_falhou', { message_id: msg.id, error_name: error instanceof Error ? error.name : 'unknown' })
        return false
      })
      if (tratada) return
    }
    await numeroSemPermissao(deps, msg, links, fora, agora)
    return
  }
  const ctx: Contexto = {
    deps,
    whatsapp,
    links,
    agora,
    para: msg.de,
    phoneId: numero.phoneId,
    tenantId: numero.tenantId,
    pedidoId: null,
    enviadas: 0,
    whatsappBruto: noEnderecoRecebido(deps.whatsapp, msg),
  }
  // Planilha do lote (conta Escritório): antes da regra que só lê texto; o certificado já foi recusado lá em cima.
  if (msg.tipo === 'document' && tipoDaPlanilha(msg.arquivo)) {
    await receberPlanilha(ctx, msg.arquivo)
    return
  }
  if (msg.tipo !== 'text' || !msg.texto?.trim()) {
    await responder(fora, TEXTOS.soTexto)
    return
  }
  const texto = msg.texto.trim()
  // Pedido de uma pessoa: a equipe responde no mesmo número, pela central (alerta por e-mail); o pedido de nota
  // aberto, se houver, continua valendo.
  if (ehPedidoDeAtendimento(texto)) {
    logEvent('agente.atendimento_humano', { message_id: msg.id, tenant_id: ctx.tenantId, origem: 'assinante' })
    await registrarEvento(deps.db, msg.de, 'pediu_atendente')
    await responder(ctx, TEXTOS.chamouAEquipe)
    return
  }
  // Comandos do dono (critérios 44 e 46) e boas-vindas (29) vêm antes dos pedidos.
  if (await tratarComando(ctx, texto)) return
  // "confirmar"/"cancelar" de um lote aguardando, quando ele é mais recente que o pedido avulso aguardando.
  if (await responderAoLote(ctx, texto)) return
  // NF-e avulsa (nota de produto), conversa guiada sem a IA: "nfe" começa; a resposta a uma NF-e aberta segue aqui.
  if (await tratarNfeConversa(ctx, texto, pareceNovoPedido)) {
    if (ctx.pedidoId) await contarMensagens(deps.db, ctx.pedidoId, 1 + ctx.enviadas)
    return
  }
  // "nota 123" / "nota Maria": o PDF de uma nota, por código, sem a IA.
  if (await tratarVerNota(ctx, texto)) return
  // "qual é o modelo da planilha?" (conta Escritório): o arquivo .xlsx, por código, sem a IA.
  if (await tratarPedidoDeModelo(ctx, texto)) return
  if ((await etapaDoOnboarding(deps.db, ctx.tenantId)) !== 'concluido' && (await conversarNasBoasVindas(ctx, texto))) return
  try {
    const pedido = await ultimoPedido(deps.db, ctx.phoneId)
    if (!(pedido && (await responderEtapa(ctx, pedido, texto)))) {
      if (ehConfirmar(texto)) await confirmarSemEtapa(ctx, pedido)
      else await novoPedido(ctx, texto, escolhendoNota(pedido, agora))
    }
  } finally {
    // A mensagem recebida e as respostas contam no pedido a que pertencem (C39).
    if (ctx.pedidoId) await contarMensagens(deps.db, ctx.pedidoId, 1 + ctx.enviadas)
  }
}

/** A conta do telefone é de um plano de escritório? (a conta-mãe; o telefone é sempre dela) */
async function ehEscritorio(ctx: Contexto): Promise<boolean> {
  const { rows } = await ctx.deps.db.query<{ plan: string }>('select plan from nofiscal.fiscal_tenants where id = $1', [ctx.tenantId])
  return planoDeEscritorio(rows[0]?.plan)
}

async function etapaDoOnboarding(db: Queryable, tenantId: string): Promise<string> {
  const { rows } = await db.query<{ etapa: string }>('select onboarding_etapa as etapa from nofiscal.fiscal_tenants where id = $1', [
    tenantId,
  ])
  return rows[0]?.etapa ?? 'concluido'
}

/** Critério 21 (com o repasse à equipe), e a confirmação de número autorizado pelo próprio WhatsApp (critério 4). */
async function numeroSemPermissao(
  deps: ConversaDeps,
  msg: MensagemRecebida,
  links: Links,
  fora: Pick<Contexto, 'whatsapp' | 'para'>,
  agora: Date,
): Promise<void> {
  const codigo = msg.tipo === 'text' ? msg.texto?.trim() ?? '' : ''
  if (/^\d{6}$/.test(codigo)) {
    const { rows } = await deps.db.query(
      `select 1 from nofiscal.fiscal_phones
        where phone_e164 = $1 and role = 'authorized' and verified_at is null and revoked_at is null`,
      [msg.de],
    )
    if (rows.length === 1) {
      const semEmail = {
        async enviar() {
          throw new Error('a confirmação de número não manda e-mail')
        },
      }
      const resultado = await confirmarNumero(
        { db: deps.db, whatsapp: deps.whatsapp, email: semEmail, now: deps.now },
        { telefone: msg.de, codigo },
      )
      await responder(fora, resultado.ok ? TEXTOS.numeroConfirmado : TEXTOS.codigoRecusado)
      return
    }
  }
  logEvent('agente.numero_nao_autorizado', { message_id: msg.id })
  const chave = `atendimento:${msg.de}:${diaLocal(agora)}`
  if (!(await marcarUmaVez(deps.db, chave))) return
  logEvent('agente.atendimento_humano', { message_id: msg.id, origem: 'sem_conta' })
  // A resposta do dia só conta se saiu (30/10/2026): com o envio falho, a próxima mensagem do dia tenta de novo.
  const saiu = await textoComRetentativa(noEnderecoRecebido(deps.whatsapp, msg), msg.de, recebidoPelaEquipe(links, deps.numeroProprio))
  if (!saiu) await desmarcar(deps.db, chave)
}

// ---------------------------------------------------------------------------------------
// Respostas a uma etapa aberta.

async function responderEtapa(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  if (!pedido.etapa) return false

  if (pedido.status === 'awaiting_confirmation' && pedido.expires_at.getTime() <= ctx.agora.getTime()) {
    await expirarPedido(ctx.deps.db, pedido.id, ctx.agora)
    if (!(pedido.kind === 'emitir' ? ehConfirmarEmissao(texto) : ehConfirmar(texto))) return false
    ctx.pedidoId = pedido.id
    await responder(ctx, TEXTOS.expirou)
    return true
  }

  switch (pedido.etapa) {
    case 'confirmar':
      if (pedido.status !== 'awaiting_confirmation') return false
      if (pedido.kind === 'cancelar') {
        if (ehConfirmarCancelamento(texto)) {
          ctx.pedidoId = pedido.id
          await confirmar(ctx, pedido)
          return true
        }
        if (ehManterNota(texto)) {
          await descartar(ctx, pedido, TEXTOS.cancelamentoDesistido)
          return true
        }
        return false
      }
      // A pergunta da descrição vem antes do resumo: a resposta é a descrição, *padrão* ou a desistência.
      if (pedido.conversa.pedindoDescricao) {
        if (ehDesistir(texto)) {
          await descartar(ctx, pedido)
          return true
        }
        return escolherDescricao(ctx, pedido, texto)
      }
      if (pedido.conversa.info_aberta && !pedido.conversa.corrigindo) return responderInfoComplementar(ctx, pedido, texto)
      if (ehConfirmarEmissao(texto)) {
        ctx.pedidoId = pedido.id
        await confirmar(ctx, pedido)
        return true
      }
      if (ehDesistir(texto)) {
        await descartar(ctx, pedido)
        return true
      }
      // "corrigir" mantém o pedido e pergunta o que muda (Lucca, 22/10/2026).
      if (ehCorrigir(texto)) {
        ctx.pedidoId = pedido.id
        await atualizarPedido(ctx.deps.db, pedido.id, 'confirmar', { ...pedido.conversa, corrigindo: true }, ctx.agora)
        await responder(ctx, TEXTOS.oQueMuda)
        return true
      }
      if (pedido.conversa.corrigindo) return corrigirPedido(ctx, pedido, texto)
      return false

    case 'dados_tomador':
      if (pedido.status !== 'awaiting_confirmation') return false
      if (ehNao(texto) || ehDesistir(texto)) {
        await descartar(ctx, pedido)
        return true
      }
      return completarTomador(ctx, pedido, texto)

    case 'escolher_prestador':
      if (pedido.status !== 'awaiting_confirmation') return false
      if (ehNao(texto) || ehDesistir(texto)) {
        await descartar(ctx, pedido)
        return true
      }
      if (pedido.conversa.pergunta_uf) return escolherUf(ctx, pedido, texto)
      return escolherPrestador(ctx, pedido, texto)

    case 'escolher_nota':
      if (pedido.status !== 'awaiting_confirmation') return false
      if (ehManterNota(texto) || ehDesistir(texto) || ehSairDaEscolha(texto)) {
        await descartar(ctx, pedido, TEXTOS.cancelamentoDesistido)
        return true
      }
      if (ehConfirmar(texto)) {
        await repetirOpcoes(ctx, pedido, TEXTOS.escolherAntes)
        return true
      }
      return escolherNota(ctx, pedido, texto)

    case 'salvar_modelo':
    case 'substituir_modelo':
      if (pedido.status !== 'confirmed') return false
      if (ehSim(texto)) {
        ctx.pedidoId = pedido.id
        if (pedido.etapa === 'salvar_modelo') await salvarModelo(ctx, pedido)
        else await substituirModelo(ctx, pedido)
        return true
      }
      await atualizarPedido(ctx.deps.db, pedido.id, null, pedido.conversa, ctx.agora)
      if (ehNao(texto)) {
        ctx.pedidoId = pedido.id
        await responder(
          ctx,
          pedido.etapa === 'salvar_modelo' ? TEXTOS.modeloNaoSalvo : `Ok, mantive o modelo ${pedido.conversa.modelo_nome ?? ''} como estava.`,
        )
        return true
      }
      return false
  }
}

async function expirarPedido(db: Queryable, id: string, agora: Date): Promise<void> {
  await db.query(
    `update nofiscal.fiscal_requests set status = 'expired', etapa = null, updated_at = $2
      where id = $1 and status = 'awaiting_confirmation'`,
    [id, agora],
  )
}

async function descartar(ctx: Contexto, pedido: Pedido, texto: string = TEXTOS.descartado): Promise<void> {
  ctx.pedidoId = pedido.id
  await ctx.deps.db.query(
    `update nofiscal.fiscal_requests set status = 'rejected_by_user', etapa = null, updated_at = $2
      where id = $1 and status = 'awaiting_confirmation'`,
    [pedido.id, ctx.agora],
  )
  await responder(ctx, texto)
}

/**
 * A mensagem depois de "corrigir": a IA lê cliente, valor e descrição. Valor ou descrição novos → o mesmo pedido com
 * eles trocados e o resumo de novo. Cliente novo → este pedido sai e um novo nasce com o cliente novo, o valor (novo
 * ou o de antes) e a descrição que veio na correção.
 */
async function corrigirPedido(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  ctx.pedidoId = pedido.id
  const { paraIa, info: infoEscrita } = textoParaAIa(texto)
  let parsed: Parsed
  let tokens: { entrada: number; saida: number }
  try {
    const resultado = await ctx.deps.interprete.interpretar(paraIa)
    parsed = comCidadeDaObra(comLocalDoTexto(comInfoComplementar(servicoSoSePedido(validarParsed(resultado.parsed), paraIa), infoEscrita), paraIa))
    tokens = {
      entrada: Math.max(0, Math.trunc(Number(resultado.tokens?.entrada) || 0)),
      saida: Math.max(0, Math.trunc(Number(resultado.tokens?.saida) || 0)),
    }
  } catch (error) {
    logEvent('agente.interprete_falhou', { error_name: error instanceof Error ? error.name : 'unknown' })
    await registrarEvento(ctx.deps.db, ctx.para, 'ia_falhou', { detalhe: 'na correção do pedido' })
    await responder(ctx, TEXTOS.naoEntendi)
    return true
  }
  const atual = pedido.conversa
  const nomeAtual = (atual.tomador?.nome ?? '').toLowerCase()
  const outroCliente = Boolean(
    (parsed.tomador && parsed.tomador.toLowerCase() !== nomeAtual && parsed.tomador.toLowerCase() !== (atual.modelo_nome ?? '').toLowerCase()) ||
      (parsed.documento && parsed.documento !== atual.tomador?.documento),
  )
  if (outroCliente) {
    await ctx.deps.db.query(
      `update nofiscal.fiscal_requests set status = 'rejected_by_user', etapa = null, updated_at = $2
        where id = $1 and status = 'awaiting_confirmation'`,
      [pedido.id, ctx.agora],
    )
    logEvent('agente.pedido_corrigido', { request_id: pedido.id, mudou: 'cliente' })
    ctx.pedidoId = null
    // Cliente novo, mesma empresa: o emitente do pedido continua valendo (a não ser que a correção diga outro).
    const informacoes_complementares = parsed.informacoes_complementares ?? atual.informacoes_complementares ?? null
    const municipio_prestacao = parsed.municipio_prestacao ?? atual.servico?.municipio_prestacao_ibge ?? null
    const obra = juntarObra(atual.obra_rascunho, parsed.obra).rascunho
    await pedidoDeEmissao(ctx, { ...parsed, intencao: 'emitir', valor: parsed.valor ?? atual.valor ?? null, informacoes_complementares, municipio_prestacao, obra }, tokens, {
      emitenteId: parsed.prestador ? undefined : pedido.tenant_id,
    })
    return true
  }
  // "emitente Studio Lima" / "pela Studio Lima": o mesmo cliente e valor, por outra empresa. Os clientes salvos são
  // por empresa, então o pedido recomeça nela (pode pedir o e-mail de novo).
  if (parsed.prestador && atual.tomador?.nome) {
    const empresas = await empresasParaEscolher(ctx.deps.db, ctx.tenantId)
    const achadas = empresas.length ? empresasQueBatem(empresas, parsed.prestador) : []
    if (achadas.length === 1 && achadas[0].id !== pedido.tenant_id) {
      await ctx.deps.db.query(
        `update nofiscal.fiscal_requests set status = 'rejected_by_user', etapa = null, updated_at = $2
          where id = $1 and status = 'awaiting_confirmation'`,
        [pedido.id, ctx.agora],
      )
      logEvent('agente.pedido_corrigido', { request_id: pedido.id, mudou: 'emitente' })
      ctx.pedidoId = null
      const descricao = parsed.descricao ?? (atual.servico && atual.servico.descricao !== DESCRICAO_PADRAO ? atual.servico.descricao : null)
      await pedidoDeEmissao(
        ctx,
        {
          tomador: atual.tomador.nome,
          documento: atual.tomador.documento ?? null,
          valor: parsed.valor ?? atual.valor ?? null,
          modelo: null,
          descricao,
          prestador: null,
          codigo_servico: parsed.codigo_servico ?? null,
          servico: parsed.servico ?? null,
          informacoes_complementares: parsed.informacoes_complementares ?? atual.informacoes_complementares ?? null,
          municipio_prestacao: parsed.municipio_prestacao ?? atual.servico?.municipio_prestacao_ibge ?? null,
          obra: juntarObra(atual.obra_rascunho, parsed.obra).rascunho,
          intencao: 'emitir',
        },
        tokens,
        { emitenteId: achadas[0].id },
      )
      return true
    }
    if (empresas.length && achadas.length !== 1) {
      const nenhuma = achadas.length === 0
      await responder(
        ctx,
        perguntaDoEmitente(empresas, nenhuma ? { naoAchei: parsed.prestador } : { candidatas: achadas }).texto.replace(
          /Por qual empresa sai a nota\?[^\n]*/,
          'Para trocar a empresa, responda *corrigir* e me mande o nome ou o CNPJ dela.',
        ),
      )

      return true
    }
  }
  const valor = parsed.valor ?? atual.valor
  const retencaoNova = retencaoDoParsed(parsed)
  if (mencionaRetencao(paraIa) && !retencaoNova) {
    // O pedido continua em correção: a próxima mensagem é lida de novo como a correção.
    await responder(
      ctx,
      mensagem({
        titulo: 'Retenção',
        blocos: ['Vi que a correção fala de retenção, mas não entendi qual.'],
        acao: `Me diga assim:\n${JEITOS_DE_DIZER_A_RETENCAO}`,
      }),
    )
    return true
  }
  // "código 04.08.02" ou "serviço de fisioterapia" na correção: o mesmo pedido, com o código novo.
  const codigoNovo = await codigoDoPedido(ctx.deps.catalogo, parsed, () => codigosDaEmpresa(ctx.deps.db, pedido.tenant_id), 'Me mande o código certo, por exemplo: código 04.08.02.')
  if (codigoNovo && 'texto' in codigoNovo) {
    await responder(ctx, codigoNovo.texto)
    return true
  }
  const infoNova = parsed.informacoes_complementares ?? null
  if (infoNova && infoNova.length > MAX_INFO_COMPLEMENTAR) {
    await responder(ctx, textoDeInfoLonga(infoNova.length))
    return true
  }
  // "prestado em Campinas/SP" na correção: o mesmo pedido, com o local novo (homônima: a pessoa repete com a UF).
  const localNovo = localDoPedido(parsed.municipio_prestacao)
  if (localNovo && 'texto' in localNovo) {
    await responder(ctx, localNovo.texto)
    return true
  }
  if (localNovo && 'ambiguo' in localNovo) {
    const { nome, ufs } = localNovo.ambiguo
    await responder(ctx, `Há ${ufs.length} cidades chamadas ${nome} (${ufs.join(', ')}). Me diga com a UF, por exemplo: prestado em ${nome}/${ufs[0]}.`)
    return true
  }
  // Endereço ou CNO da obra na correção (ou como resposta à pergunta da obra): soma ao que já veio.
  const obraNova = parsed.obra ? juntarObra(atual.obra_rascunho, parsed.obra) : null
  if ((parsed.valor || parsed.descricao || retencaoNova || codigoNovo || infoNova || localNovo || obraNova) && valor && atual.tomador && atual.servico) {
    const servico: ServicoDoPedido = {
      ...atual.servico,
      ...(parsed.descricao ? { descricao: parsed.descricao } : {}),
      ...(codigoNovo ? { codigo: codigoNovo.codigo } : {}),
      ...(localNovo ? { municipio_prestacao_ibge: localNovo.ibge } : {}),
      ...(obraNova ? { obra: obraNova.obra } : {}),
    }
    const retencao_pedido = retencaoNova ? { ...atual.retencao_pedido, ...retencaoNova } : atual.retencao_pedido
    const conversa: Conversa = {
      ...atual,
      servico,
      valor,
      retencao_pedido,
      corrigindo: false,
      ...(infoNova ? { informacoes_complementares: infoNova, info_aberta: false } : {}),
      ...(obraNova ? { obra_rascunho: obraNova.rascunho } : {}),
    }
    const mudou = [parsed.valor && 'valor', parsed.descricao && 'descricao', retencaoNova && 'retencao', codigoNovo && 'codigo', infoNova && 'info_complementar', localNovo && 'local', obraNova && 'obra']
      .filter(Boolean)
      .join(' e ')
    logEvent('agente.pedido_corrigido', { request_id: pedido.id, mudou })
    await enviarResumo(ctx, pedido.id, pedido.tenant_id, conversa)
    return true
  }
  await registrarEvento(ctx.deps.db, ctx.para, 'ia_nao_entendeu', { detalhe: 'não entendi a correção do pedido' })
  await responder(ctx, TEXTOS.naoEntendiACorrecao)
  return true
}

/** "confirmar" sem etapa aberta: pedido vencido (C19) ou nada a confirmar. */
async function confirmarSemEtapa(ctx: Contexto, ultimo: Pedido | null): Promise<void> {
  if (ultimo && ultimo.status === 'expired') {
    ctx.pedidoId = ultimo.id
    await responder(ctx, TEXTOS.expirou)
    return
  }
  await responder(ctx, TEXTOS.semPedido)
}

/** Critério 17 e 32: só aqui a nota é criada ou o cancelamento é pedido ao motor. */
async function confirmar(ctx: Contexto, pedido: Pedido): Promise<void> {
  const { db } = ctx.deps
  if (pedido.kind === 'emitir') {
    // A nota sai pela empresa do pedido: a do telefone ou, na conta Escritório, a que a pessoa escolheu.
    const bloqueio = await bloqueioDaEmissao(db, pedido.tenant_id)
    if (bloqueio) {
      await responder(ctx, textoDoBloqueioDoEmitente(ctx, bloqueio, pedido.conversa.emitente))
      return
    }
    const { tomador, servico, valor } = pedido.conversa
    if (!tomador?.documento || !tomador.nome || !servico || !valor) throw new Error('pedido sem os dados do resumo')
    if (pedido.conversa.retencao_problema) {
      // Sem os dados da obra, a pergunta de novo: o pedido continua esperando o endereço ou o CNO.
      const problema = pedido.conversa.retencao_problema
      await responder(
        ctx,
        problema === 'OBRA_SEM_DADOS'
          ? textoDaObraQueFalta(pedido.conversa.obra_rascunho, null)
          : textoDoProblemaDeRetencao(ctx, problema, pedido.conversa.emitente?.razao_social),
      )
      return
    }
    const criada = await db.transaction(async (tx) => {
      // Duas confirmações simultâneas: só uma muda o estado (Unresolved 14).
      const { rowCount } = await tx.query(
        `update nofiscal.fiscal_requests
            set status = 'confirmed', confirmed_at = $2, etapa = null, updated_at = $2
          where id = $1 and status = 'awaiting_confirmation' and expires_at > $2`,
        [pedido.id, ctx.agora],
      )
      if (rowCount !== 1) return null
      const payload = payloadDaNota(
        { documento: tomador.documento as string, nome: tomador.nome as string, email: tomador.email ?? null },
        servico,
        valor,
        {
          retencao: pedido.conversa.retencao,
          endereco: pedido.conversa.endereco,
          informacoes_complementares: pedido.conversa.informacoes_complementares,
        },
      )
      const nota = await createOrGetInvoice(tx, pedido.tenant_id, { external_id: pedido.id, payload: payload as unknown as InvoicePayload })
      await tx.query('update nofiscal.fiscal_requests set invoice_id = $2 where id = $1', [pedido.id, nota.id])
      // Cliente salvo e outro código nesta nota (Lucca, 17/11/2026): o cliente passa a sair com ele, e a próxima nota
      // para ele repete o código.
      const modeloAtualizado = pedido.conversa.modelo_id
        ? (
            await tx.query<{ nome: string }>(
              `update nofiscal.fiscal_models set codigo_servico_nacional = $3, updated_at = $4
                where id = $1 and tenant_id = $2 and codigo_servico_nacional is distinct from $3
              returning nome`,
              [pedido.conversa.modelo_id, pedido.tenant_id, servico.codigo, ctx.agora],
            )
          ).rows[0]?.nome ?? null
        : null
      return { nota, modeloAtualizado }
    })
    if (!criada) {
      await responder(ctx, TEXTOS.semPedido)
      return
    }
    logEvent('agente.pedido_confirmado', { request_id: pedido.id, invoice_id: criada.nota.id, tenant_id: pedido.tenant_id })
    await responder(
      ctx,
      criada.modeloAtualizado
        ? `${TEXTOS.emitindo}\n\nGuardei o código ${formatarCodigoServico(servico.codigo)} no cliente ${criada.modeloAtualizado}: as próximas notas para ele saem com esse código.`
        : TEXTOS.emitindo,
    )
    return
  }

  if (!pedido.invoice_id) throw new Error('pedido de cancelamento sem nota')
  const invoiceId = pedido.invoice_id
  const nota = await db.transaction(async (tx) => {
    const { rowCount } = await tx.query(
      `update nofiscal.fiscal_requests
          set status = 'confirmed', confirmed_at = $2, etapa = null, updated_at = $2
        where id = $1 and status = 'awaiting_confirmation' and expires_at > $2`,
      [pedido.id, ctx.agora],
    )
    if (rowCount !== 1) return null
    // A nota pode ser de outra empresa do escritório: o pedido guarda de qual (novoCancelamento e escolherNota).
    return requestCancel(tx, pedido.tenant_id, invoiceId, ctx.agora)
  })
  if (!nota) {
    await responder(ctx, TEXTOS.semPedido)
    return
  }
  const numero = pedido.conversa.candidatas?.find((c) => c.id === invoiceId)?.numero ?? ''
  if (nota.status === 'cancel_requested' || nota.status === 'skipped') {
    logEvent('agente.cancelamento_confirmado', { request_id: pedido.id, invoice_id: invoiceId })
    await responder(ctx, `Pedido de cancelamento da nota nº ${numero} enviado. Eu te aviso quando a Sefin confirmar.`)
  } else {
    await responder(ctx, `A nota nº ${numero} não pode ser cancelada agora (situação: ${nota.status}).`)
  }
}

async function completarTomador(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  const documento = documentoNoTexto(texto)
  const email = emailNoTexto(texto)
  if (!documento && !email) {
    // Parece um CPF ou CNPJ, mas os dígitos verificadores não batem.
    if (texto.replace(/\D/g, '').length < 11) return false
    ctx.pedidoId = pedido.id
    await responder(ctx, 'Esse CPF ou CNPJ não é válido. Confira os números e me mande de novo, com o e-mail do tomador.')
    return true
  }
  ctx.pedidoId = pedido.id

  const conversa: Conversa = { ...pedido.conversa, tomador: { ...pedido.conversa.tomador } }
  const tomador = conversa.tomador as Partial<TomadorDoPedido>
  if (documento) tomador.documento = documento
  if (email) tomador.email = email
  const nomeEscrito = tomador.nome ?? 'o tomador'

  if (!tomador.documento) {
    await atualizarPedido(ctx.deps.db, pedido.id, 'dados_tomador', conversa, ctx.agora)
    await responder(ctx, `Falta o CPF ou CNPJ de ${nomeEscrito}. Me mande o CPF ou CNPJ e o e-mail do tomador.`)
    return true
  }
  if (!tomador.email) {
    await atualizarPedido(ctx.deps.db, pedido.id, 'dados_tomador', conversa, ctx.agora)
    await responder(ctx, `Falta o e-mail de ${nomeEscrito}. Me mande o e-mail do tomador.`)
    return true
  }
  // Critério 18: para CNPJ, o nome vem dos dados públicos; para CPF, do que a pessoa escreveu.
  if (documento && tipoDoDocumento(documento) === 'cnpj' && ctx.deps.consultaCnpj) {
    const razao = await ctx.deps.consultaCnpj.razaoSocial(documento).catch(() => null)
    if (razao) tomador.nome = razao.trim().slice(0, 150)
  }
  conversa.pedindoDescricao = precisaDeDescricao(conversa.servico)
  if (conversa.pedindoDescricao) {
    await atualizarPedido(ctx.deps.db, pedido.id, 'confirmar', conversa, ctx.agora)
    await responder(ctx, TEXTOS.perguntaDeDescricao)
  } else {
    await enviarResumo(ctx, pedido.id, pedido.tenant_id, conversa)
  }
  return true
}

// ---------------------------------------------------------------------------------------
// Descrição da nota (Lucca, 30/10/2026): com a descrição padrão, o robô pergunta antes do resumo; quem já disse o
// serviço no pedido, ou tem um modelo com descrição própria, vai direto ao resumo.

const precisaDeDescricao = (servico: ServicoDoPedido | undefined) => !servico || servico.descricao === DESCRICAO_PADRAO

/** "padrão", "pular", "não"…: fica a descrição padrão. "confirmar" também, mas só mostra o resumo, não emite. */
export const ehDescricaoPadrao = (texto: string) =>
  ehConfirmar(texto) ||
  /^(padrao|pular|pula|nao|n|generica|pode usar a padrao|pode ser a padrao|usar a padrao|usa a padrao|tanto faz|sem descricao)$/.test(limpa(texto))

async function escolherDescricao(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  ctx.pedidoId = pedido.id
  const atual = pedido.conversa
  if (!atual.tomador || !atual.servico || !atual.valor) return false
  let descricao = atual.servico.descricao
  if (!ehDescricaoPadrao(texto)) {
    const escrita = texto.trim().replace(/\s+/g, ' ')
    // Mesmo limite do motor (servico.descricao em validation.ts).
    if (escrita.length > 2000) {
      await responder(ctx, TEXTOS.descricaoLonga)
      return true
    }
    descricao = escrita.charAt(0).toUpperCase() + escrita.slice(1)
  }
  const servico: ServicoDoPedido = { ...atual.servico, descricao }
  const conversa: Conversa = { ...atual, servico, pedindoDescricao: false }
  await enviarResumo(ctx, pedido.id, pedido.tenant_id, conversa)
  return true
}

/** As notas do pedido, na ordem da lista mostrada; `null` onde a nota não está mais emitida. */
async function opcoesDoPedido(ctx: Contexto, pedido: Pedido): Promise<(Candidata | null)[]> {
  const ids = (pedido.conversa.candidatas ?? []).map((c) => c.id)
  if (!ids.length) return []
  const notas = await buscarNotas(ctx.deps.db, await escopoDeNotas(ctx), { ids })
  return ids.map((id) => notas.find((n) => n.id === id) ?? null)
}

/** A lista de novo, com o que ainda está emitido, e o jeito de responder: dentro da escolha, nunca a ajuda genérica. */
async function repetirOpcoes(ctx: Contexto, pedido: Pedido, cabecalho: string): Promise<void> {
  ctx.pedidoId = pedido.id
  const opcoes = (await opcoesDoPedido(ctx, pedido)).filter((c): c is Candidata => c !== null)
  if (!opcoes.length) {
    await descartar(ctx, pedido, 'As notas da lista não estão mais emitidas. Se precisar, me mande o pedido de novo.')
    return
  }
  // A lista mostrada passa a ser só a das notas ainda emitidas, para os números das opções baterem.
  const candidatas = opcoes.map((c) => ({ id: c.id, numero: c.numero }))
  await atualizarPedido(ctx.deps.db, pedido.id, 'escolher_nota', { ...pedido.conversa, candidatas }, ctx.agora)
  await responder(ctx, listaDeOpcoes(cabecalho, opcoes))
}

/**
 * A resposta à lista de notas (caso de 16/11/2026: duas empresas da conta com a nota nº 2): o número da opção, a
 * linha colada, a empresa, o cliente, o valor, o nº ou a data. Só segue com uma; com várias, a lista volta só com
 * elas. Palavras que não batem com nenhuma nota vão para a IA (pode ser um pedido novo); se ela também não achar
 * pedido, a lista volta (`novoPedido` com `escolhendo`), nunca a ajuda genérica.
 */
async function escolherNota(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  const lista = await opcoesDoPedido(ctx, pedido)
  const leitura = lerEscolhaDeNota(lista, texto)
  if (leitura.tipo === 'nada') return false
  ctx.pedidoId = pedido.id
  if (leitura.tipo === 'filtro') {
    if (!leitura.indices.length) {
      await repetirOpcoes(ctx, pedido, 'Nenhuma nota da lista bate com isso. Qual delas você quer cancelar?')
      return true
    }
    const restantes = leitura.indices.map((i) => lista[i] as Candidata)
    const candidatas = restantes.map((c) => ({ id: c.id, numero: c.numero }))
    await atualizarPedido(ctx.deps.db, pedido.id, 'escolher_nota', { ...pedido.conversa, candidatas }, ctx.agora)
    await responder(ctx, listaDeOpcoes(`${restantes.length} notas batem com isso. Qual delas você quer cancelar?`, restantes))
    return true
  }
  const nota = lista[leitura.indice]
  if (!nota) {
    const numero = pedido.conversa.candidatas?.[leitura.indice]?.numero
    await repetirOpcoes(ctx, pedido, `A nota nº ${numero} não está mais emitida. Qual das outras você quer cancelar?`)
    return true
  }
  await ctx.deps.db.query(
    `update nofiscal.fiscal_requests set invoice_id = $2, tenant_id = $4, etapa = 'confirmar', updated_at = $3 where id = $1`,
    [pedido.id, nota.id, ctx.agora, nota.tenantId],
  )
  await responder(ctx, perguntaDeCancelamento(nota))
  return true
}

// ---------------------------------------------------------------------------------------
// Modelos (critérios 30 e 31).

async function salvarModelo(ctx: Contexto, pedido: Pedido): Promise<void> {
  const { tomador, servico, modelo_nome: nome } = pedido.conversa
  if (!tomador?.documento || !tomador.nome || !servico || !nome || !pedido.invoice_id) throw new Error('pedido sem dados de modelo')
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `insert into nofiscal.fiscal_models
       (tenant_id, nome, tomador_documento, tomador_nome, tomador_email, codigo_servico_nacional, descricao,
        created_from_invoice_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     on conflict (tenant_id, (lower(nome))) do nothing
     returning id`,
    [pedido.tenant_id, nome, tomador.documento, tomador.nome, tomador.email ?? null, servico.codigo, servico.descricao, pedido.invoice_id, ctx.agora],
  )
  if (rows[0]) {
    await atualizarPedido(ctx.deps.db, pedido.id, null, pedido.conversa, ctx.agora)
    const emitente = pedido.conversa.emitente
    await responder(
      ctx,
      emitente
        ? blocos(`Modelo ${nome} salvo em ${emitente.razao_social}.`, `Da próxima vez, é só escrever: nota pela ${emitente.razao_social} pra ${nome}, e o valor.`)
        : blocos(`Modelo ${nome} salvo.`, `Da próxima vez, é só escrever: nota pra ${nome}, e o valor.`),
    )
    return
  }
  const existente = await ctx.deps.db.query<{ nome: string }>(
    'select nome from nofiscal.fiscal_models where tenant_id = $1 and lower(nome) = lower($2)',
    [pedido.tenant_id, nome],
  )
  await atualizarPedido(ctx.deps.db, pedido.id, 'substituir_modelo', pedido.conversa, ctx.agora)
  await responder(
    ctx,
    blocos(
      `Já existe um modelo ${existente.rows[0]?.nome ?? nome}. Quer substituir pelo de ${tomador.nome} (${formatarDocumento(tomador.documento)})?`,
      'Responda sim ou não.',
    ),
  )
}

async function substituirModelo(ctx: Contexto, pedido: Pedido): Promise<void> {
  const { tomador, servico, modelo_nome: nome } = pedido.conversa
  if (!tomador?.documento || !tomador.nome || !servico || !nome || !pedido.invoice_id) throw new Error('pedido sem dados de modelo')
  await ctx.deps.db.query(
    `update nofiscal.fiscal_models
        set nome = $3, tomador_documento = $4, tomador_nome = $5, tomador_email = $6, tomador_whatsapp = null,
            codigo_servico_nacional = $7, descricao = $8, valor_padrao = null, created_from_invoice_id = $9, updated_at = $10
      where tenant_id = $1 and lower(nome) = lower($2)`,
    [pedido.tenant_id, nome, nome, tomador.documento, tomador.nome, tomador.email ?? null, servico.codigo, servico.descricao, pedido.invoice_id, ctx.agora],
  )
  await atualizarPedido(ctx.deps.db, pedido.id, null, pedido.conversa, ctx.agora)
  await responder(ctx, `Modelo ${nome} substituído.`)
}

export type Modelo = {
  id: string
  nome: string
  tomador_documento: string
  tomador_nome: string
  tomador_email: string | null
  codigo_servico_nacional: string
  descricao: string
  valor_padrao: string | null
}

/** Landing, lote B - conversa: nome do modelo, documento, nome do tomador, prefixo. */
export async function resolverModelo(db: Queryable, tenantId: string, parsed: Parsed): Promise<Modelo | { ambiguos: string[] } | null> {
  const { rows: modelos } = await db.query<Modelo>(
    `select id, nome, tomador_documento, tomador_nome, tomador_email, codigo_servico_nacional, descricao, valor_padrao::text
       from nofiscal.fiscal_models where tenant_id = $1 order by nome`,
    [tenantId],
  )
  const minusculo = (s: string) => s.toLowerCase()
  let achados: Modelo[] = []
  if (parsed.modelo) achados = modelos.filter((m) => minusculo(m.nome) === minusculo(parsed.modelo as string))
  if (!achados.length && parsed.documento) achados = modelos.filter((m) => m.tomador_documento === parsed.documento)
  if (!achados.length && parsed.tomador) {
    const t = minusculo(parsed.tomador)
    achados = modelos.filter((m) => minusculo(m.nome) === t || minusculo(m.tomador_nome) === t)
    if (!achados.length) achados = modelos.filter((m) => t.startsWith(`${minusculo(m.nome)} `))
  }
  if (achados.length > 1) return { ambiguos: achados.map((m) => m.nome) }
  const modelo = achados[0]
  if (!modelo) return null
  // Documento escrito diferente do modelo: é outro tomador.
  if (parsed.documento && parsed.documento !== modelo.tomador_documento) return null
  return modelo
}

// ---------------------------------------------------------------------------------------
// Mensagem nova: a IA interpreta, o código decide.

/** O pedido de cancelamento ainda à espera da escolha da nota, se for ele o aberto. */
const escolhendoNota = (pedido: Pedido | null | undefined, agora: Date) =>
  pedido?.etapa === 'escolher_nota' && pedido.status === 'awaiting_confirmation' && pedido.expires_at.getTime() > agora.getTime()
    ? pedido
    : undefined

/** `escolhendo`: há uma lista de notas esperando escolha; se a mensagem não for pedido, a lista volta no lugar da ajuda. */
async function novoPedido(ctx: Contexto, texto: string, escolhendo?: Pedido): Promise<void> {
  const naoEntendeuAEscolha = escolhendo
    ? () => repetirOpcoes(ctx, escolhendo, 'Não entendi qual nota você quer cancelar.')
    : null
  const { paraIa, info: infoEscrita } = textoParaAIa(texto)
  let parsed: Parsed
  let tokens: { entrada: number; saida: number }
  try {
    const resultado = await ctx.deps.interprete.interpretar(paraIa)
    parsed = comCidadeDaObra(comLocalDoTexto(comInfoComplementar(servicoSoSePedido(validarParsed(resultado.parsed), paraIa), infoEscrita), paraIa))
    tokens = {
      entrada: Math.max(0, Math.trunc(Number(resultado.tokens?.entrada) || 0)),
      saida: Math.max(0, Math.trunc(Number(resultado.tokens?.saida) || 0)),
    }
  } catch (error) {
    logEvent('agente.interprete_falhou', { error_name: error instanceof Error ? error.name : 'unknown' })
    await registrarEvento(ctx.deps.db, ctx.para, 'ia_falhou', { detalhe: 'na mensagem nova' })
    if (naoEntendeuAEscolha) await naoEntendeuAEscolha()
    else await responder(ctx, TEXTOS.naoEntendi)
    return
  }
  const semPedido = () => logEvent('agente.ia_sem_pedido', { tokens_entrada: tokens.entrada, tokens_saida: tokens.saida, intencao: parsed.intencao })

  if (parsed.intencao === 'cancelar') {
    await novoCancelamento(ctx, texto, parsed, tokens, semPedido)
    return
  }
  if (parsed.intencao !== 'emitir') {
    semPedido()
    if (naoEntendeuAEscolha) {
      await registrarEvento(ctx.deps.db, ctx.para, 'ia_nao_entendeu', { detalhe: 'escolhendo a nota a cancelar; repeti a lista' })
      await naoEntendeuAEscolha()
      return
    }
    await registrarEvento(ctx.deps.db, ctx.para, 'ia_nao_entendeu', { detalhe: 'não era pedido de nota; mandei a ajuda' })
    await responder(ctx, (await ehEscritorio(ctx)) ? TEXTOS.ajudaEscritorio : TEXTOS.ajuda)
    return
  }
  if (mencionaRetencao(paraIa) && !retencaoDoParsed(parsed)) {
    semPedido()
    await registrarEvento(ctx.deps.db, ctx.para, 'ia_nao_entendeu', { detalhe: 'pedido fala de retenção, e a IA não leu qual' })
    await responder(ctx, TEXTO_RETENCAO_NAO_ENTENDIDA)
    return
  }
  await pedidoDeEmissao(ctx, parsed, tokens)
}


/**
 * Do pedido já interpretado ao resumo (ou às perguntas que faltam). Na conta Escritório com mais de uma empresa ativa,
 * antes de tudo vem a empresa que emite: a escrita no pedido (`parsed.prestador`), a já escolhida (`emitenteId`) ou a
 * pergunta "Por qual empresa sai a nota?" (etapa `escolher_prestador`). Nas outras contas, a empresa do telefone.
 */
async function pedidoDeEmissao(
  ctx: Contexto,
  parsed: Parsed,
  tokens: { entrada: number; saida: number },
  opcoes: { emitenteId?: string; reusar?: Pedido } = {},
): Promise<void> {
  const semPedido = () => logEvent('agente.ia_sem_pedido', { tokens_entrada: tokens.entrada, tokens_saida: tokens.saida, intencao: parsed.intencao })

  const empresas = await empresasParaEscolher(ctx.deps.db, ctx.tenantId)
  let escolhida: EmpresaDaConta | null = null
  if (empresas.length) {
    // A IA às vezes lê o cliente como empresa ("nota da Studio Lima, 350"): nome que não é de nenhuma empresa da
    // conta, num pedido sem tomador, é o tomador.
    if (parsed.prestador && !parsed.tomador && !parsed.modelo && !parsed.documento && !empresasQueBatem(empresas, parsed.prestador).length) {
      parsed = { ...parsed, tomador: parsed.prestador, prestador: null }
    }
    if (!parsed.tomador && !parsed.modelo && !parsed.documento) {
      semPedido()
      await responder(ctx, parsed.valor ? TEXTOS.faltaTomador : TEXTOS.faltaTudo)
      return
    }
    if (opcoes.emitenteId) escolhida = empresas.find((e) => e.id === opcoes.emitenteId) ?? null
    if (!escolhida) {
      const achadas = parsed.prestador ? empresasQueBatem(empresas, parsed.prestador) : []
      if (achadas.length === 1) escolhida = achadas[0]
      else {
        const pergunta = perguntaDoEmitente(
          empresas,
          achadas.length > 1 ? { candidatas: achadas } : parsed.prestador ? { naoAchei: parsed.prestador } : {},
        )
        await criarPedido(ctx, {
          kind: 'emitir',
          etapa: 'escolher_prestador',
          parsed,
          tokens,
          conversa: { pendente: { ...parsed, prestador: null }, opcoes: pergunta.opcoes },
          reusar: opcoes.reusar,
        })
        logEvent('agente.emitente_perguntado', { tenant_id: ctx.tenantId, empresas: empresas.length, motivo: achadas.length > 1 ? 'varias' : parsed.prestador ? 'nenhuma' : 'sem_empresa' })
        await responder(ctx, pergunta.texto)
        return
      }
    }
  }
  // Informação complementar escrita no pedido acima do limite do leiaute: o pedido não segue.
  const info = parsed.informacoes_complementares ?? null
  if (info && info.length > MAX_INFO_COMPLEMENTAR) {
    semPedido()
    if (opcoes.reusar) await descartarSemResposta(ctx, opcoes.reusar)
    await responder(ctx, blocos(textoDeInfoLonga(info.length), 'Mande o pedido de novo.'))
    return
  }
  /** A empresa que emite: a escolhida ou a do telefone. */
  const tenantId = escolhida?.id ?? ctx.tenantId
  const emitente: EmitenteDoPedido | undefined = escolhida ? { id: escolhida.id, razao_social: escolhida.razao_social, cnpj: escolhida.cnpj } : undefined

  const bloqueio = await bloqueioDaEmissao(ctx.deps.db, tenantId)
  if (bloqueio) {
    semPedido()
    if (opcoes.reusar) await descartarSemResposta(ctx, opcoes.reusar)
    await responder(ctx, textoDoBloqueioDoEmitente(ctx, bloqueio, emitente))
    return
  }

  const modelo = await resolverModelo(ctx.deps.db, tenantId, parsed)
  if (modelo && 'ambiguos' in modelo) {
    semPedido()
    if (opcoes.reusar) await descartarSemResposta(ctx, opcoes.reusar)
    await responder(ctx, `Achei mais de um modelo: ${modelo.ambiguos.join(', ')}. Me mande o pedido de novo com o nome do modelo.`)
    return
  }
  const valor = parsed.valor ?? (modelo?.valor_padrao ? (validarParsed({ valor: modelo.valor_padrao }).valor ?? null) : null)
  const nome = modelo?.tomador_nome ?? parsed.tomador
  if (!nome || !valor) {
    semPedido()
    if (opcoes.reusar) await descartarSemResposta(ctx, opcoes.reusar)
    await responder(ctx, !nome && !valor ? TEXTOS.faltaTudo : !valor ? TEXTOS.faltaValor : TEXTOS.faltaTomador)
    return
  }

  // Código ou serviço escrito no pedido: vale para esta nota no lugar do código do cliente ou da empresa.
  const codigoPedido = await codigoDoPedido(ctx.deps.catalogo, parsed, () => codigosDaEmpresa(ctx.deps.db, tenantId))
  if (codigoPedido && 'texto' in codigoPedido) {
    semPedido()
    if (opcoes.reusar) await descartarSemResposta(ctx, opcoes.reusar)
    await responder(ctx, codigoPedido.texto)
    return
  }

  // Local da prestação escrito no pedido ("serviço prestado em Campinas"): sem ele, o município da empresa.
  const local = localDoPedido(parsed.municipio_prestacao)
  if (local && 'texto' in local) {
    semPedido()
    if (opcoes.reusar) await descartarSemResposta(ctx, opcoes.reusar)
    await responder(ctx, blocos(local.texto, 'Mande o pedido de novo.'))
    return
  }
  if (local && 'ambiguo' in local) {
    await criarPedido(ctx, {
      kind: 'emitir',
      etapa: 'escolher_prestador',
      parsed,
      tokens,
      conversa: { pendente: parsed, pergunta_uf: local.ambiguo, emitente_id: escolhida?.id ?? null },
      tenantId,
      reusar: opcoes.reusar,
    })
    logEvent('agente.uf_perguntada', { tenant_id: tenantId, cidades: local.ambiguo.ufs.length })
    await responder(ctx, perguntaDaUf(local.ambiguo))
    return
  }
  const noLocal = local ? { municipio_prestacao_ibge: local.ibge } : {}
  // Dados da obra escritos no pedido: completos vão para o serviço; incompletos ficam no rascunho, e o resumo pede o resto.
  const daObra = juntarObra(null, parsed.obra)
  const naObra = { ...noLocal, ...(daObra.obra ? { obra: daObra.obra } : {}) }
  const rascunhoDaObra = daObra.rascunho ? { obra_rascunho: daObra.rascunho } : {}

  if (modelo) {
    const tomador: TomadorDoPedido = { documento: modelo.tomador_documento, nome: modelo.tomador_nome, email: modelo.tomador_email }
    // A descrição escrita no pedido vale para esta nota; o modelo continua com a dele.
    const servico: ServicoDoPedido = {
      codigo: codigoPedido?.codigo ?? modelo.codigo_servico_nacional,
      descricao: parsed.descricao ?? modelo.descricao,
      ...naObra,
    }
    const pedindoDescricao = precisaDeDescricao(servico)
    const conversa: Conversa = {
      tomador,
      servico,
      valor,
      modelo_id: modelo.id,
      pedindoDescricao,
      emitente,
      retencao_pedido: retencaoDoParsed(parsed),
      ...(info ? { informacoes_complementares: info } : {}),
      ...rascunhoDaObra,
    }
    const id = await criarPedido(ctx, { kind: 'emitir', etapa: 'confirmar', parsed, tokens, conversa, tenantId, reusar: opcoes.reusar })
    if (pedindoDescricao) await responder(ctx, TEXTOS.perguntaDeDescricao)
    else await enviarResumo(ctx, id, tenantId, conversa)
    return
  }

  // Tomador novo (critério 18): código do tenant e a descrição do pedido (ou a padrão); documento e e-mail pela conversa.
  const { rows } = await ctx.deps.db.query<{ codigo: string }>(
    'select codigo_servico_nacional as codigo from nofiscal.fiscal_tenants where id = $1',
    [tenantId],
  )
  const conversa: Conversa = {
    tomador: { nome, documento: parsed.documento ?? undefined },
    servico: { codigo: codigoPedido?.codigo ?? rows[0].codigo, descricao: parsed.descricao ?? DESCRICAO_PADRAO, ...naObra },
    valor,
    modelo_id: null,
    modelo_nome: nome.slice(0, 60).trim(),
    emitente,
    retencao_pedido: retencaoDoParsed(parsed),
    ...(info ? { informacoes_complementares: info } : {}),
    ...rascunhoDaObra,
  }
  await criarPedido(ctx, { kind: 'emitir', etapa: 'dados_tomador', parsed, tokens, conversa, tenantId, reusar: opcoes.reusar })
  await responder(
    ctx,
    parsed.documento
      ? `É a primeira nota${emitente ? ` de ${emitente.razao_social}` : ''} para ${nome}. Me mande o e-mail de ${nome}.`
      : `É a primeira nota${emitente ? ` de ${emitente.razao_social}` : ''} para ${nome}. Me mande o CPF ou CNPJ e o e-mail de ${nome}.`,
  )
}

/** O pedido que esperava a empresa não segue (bloqueio, falta de dado): sai sem mensagem própria; a resposta é a do motivo. */
async function descartarSemResposta(ctx: Contexto, pedido: Pedido): Promise<void> {
  ctx.pedidoId = pedido.id
  await ctx.deps.db.query(
    `update nofiscal.fiscal_requests set status = 'rejected_by_user', etapa = null, updated_at = $2
      where id = $1 and status = 'awaiting_confirmation'`,
    [pedido.id, ctx.agora],
  )
}

/**
 * A resposta a "Por qual empresa sai a nota?": o número da lista, o nome, o CNPJ ou "escritório". Uma empresa → o
 * pedido segue nela (o mesmo pedido). Nenhuma ou várias → a pergunta volta. Mensagem longa que não é resposta
 * (um pedido novo, por exemplo) segue para a conversa de pedidos.
 */
async function escolherPrestador(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  const pendente = pedido.conversa.pendente
  if (!pendente) return false
  const empresas = await empresasParaEscolher(ctx.deps.db, ctx.tenantId)
  ctx.pedidoId = pedido.id
  // A conta ficou com uma empresa ativa só no meio da conversa: não há mais o que escolher.
  if (!empresas.length) {
    await pedidoDeEmissao(ctx, pendente, { entrada: 0, saida: 0 }, { reusar: pedido })
    return true
  }
  const achadas = empresasDaResposta(empresas, pedido.conversa.opcoes ?? [], texto)
  if (achadas.length === 1) {
    logEvent('agente.emitente_escolhido', { request_id: pedido.id, tenant_id: achadas[0].id })
    await pedidoDeEmissao(ctx, pendente, { entrada: 0, saida: 0 }, { emitenteId: achadas[0].id, reusar: pedido })
    return true
  }
  if (!achadas.length && texto.trim().split(/\s+/).length > 6) {
    ctx.pedidoId = null
    return false
  }
  const pergunta = perguntaDoEmitente(empresas, achadas.length > 1 ? { candidatas: achadas } : { naoAchei: texto.trim().slice(0, 60) })
  await atualizarPedido(ctx.deps.db, pedido.id, 'escolher_prestador', { ...pedido.conversa, opcoes: pergunta.opcoes }, ctx.agora)
  await responder(ctx, pergunta.texto)
  return true
}

/**
 * A resposta a "Em qual estado o serviço foi prestado?": a UF ("PI") ou o nome do estado. Achou → o mesmo pedido segue
 * com "Cidade/UF". Mensagem longa que não é resposta (um pedido novo) segue para a conversa; o resto repete a pergunta.
 */
async function escolherUf(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  const { pendente, pergunta_uf: pergunta, emitente_id } = pedido.conversa
  if (!pendente || !pergunta) return false
  ctx.pedidoId = pedido.id
  const uf = ufDaResposta(texto)
  if (uf && pergunta.ufs.includes(uf)) {
    logEvent('agente.uf_escolhida', { request_id: pedido.id, uf })
    await pedidoDeEmissao(ctx, { ...pendente, municipio_prestacao: `${pergunta.nome}/${uf}` }, { entrada: 0, saida: 0 }, {
      emitenteId: emitente_id ?? undefined,
      reusar: pedido,
    })
    return true
  }
  if (!uf && texto.trim().split(/\s+/).length > 4) {
    ctx.pedidoId = null
    return false
  }
  await responder(ctx, perguntaDaUf(pergunta))
  return true
}

// ---------------------------------------------------------------------------------------
// Cancelamento (critérios 32 a 34).

/** "hoje", "ontem" ou "dd/mm[/aaaa]" no texto → `aaaa-mm-dd` local. */
function dataNoTexto(texto: string, agora: Date): string | null {
  const t = semAcento(texto)
  if (/\bhoje\b/.test(t)) return diaLocal(agora)
  if (/\bontem\b/.test(t)) return diaLocal(new Date(agora.getTime() - 24 * 3600_000))
  const m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/.exec(t)
  if (!m) return null
  const ano = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : partesLocais(agora).ano
  const mes = Number(m[2])
  const dia = Number(m[1])
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Onde procurar a nota: na conta Escritório, todas as empresas dela (ativas ou não); nas outras, a do telefone. */
type EscopoDeNotas = { tenantIds: string[]; variasEmpresas: boolean; empresas: EmpresaDaConta[] }

async function escopoDeNotas(ctx: Contexto): Promise<EscopoDeNotas> {
  const empresas = await empresasDaConta(ctx.deps.db, ctx.tenantId)
  if (empresas.length < 2) return { tenantIds: [ctx.tenantId], variasEmpresas: false, empresas: [] }
  return { tenantIds: empresas.map((e) => e.id), variasEmpresas: true, empresas }
}

async function buscarNotas(
  db: Queryable,
  escopo: EscopoDeNotas,
  filtro: { ids?: string[]; documentos?: string[]; nomes?: string[]; dia?: string | null; tenantIds?: string[] },
): Promise<Candidata[]> {
  const porTomador = Boolean(filtro.documentos?.length || filtro.nomes?.length)
  const { rows } = await db.query<{ id: string; tenant_id: string; razao_social: string; dps_numero: string | null; xml_nfse: string | null; issued_at: Date; payload: unknown }>(
    `select i.id, i.tenant_id, t.razao_social, i.dps_numero, i.xml_nfse, i.issued_at, i.payload
       from nofiscal.fiscal_invoices i
       join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where i.tenant_id = any($1::uuid[])
        and i.status = 'issued'
        and i.issued_at is not null
        and ($2::uuid[] is null or i.id = any($2::uuid[]))
        and (not $3::boolean
             or coalesce(i.payload->'tomador'->>'cpf', i.payload->'tomador'->>'cnpj') = any($4::text[])
             or lower(i.payload->'tomador'->>'nome') like any($5::text[]))
        and ($6::date is null or (i.issued_at at time zone 'America/Sao_Paulo')::date = $6::date)
      order by i.issued_at desc, i.id
      limit $7`,
    [
      filtro.tenantIds ?? escopo.tenantIds,
      filtro.ids ?? null,
      porTomador,
      filtro.documentos ?? [],
      (filtro.nomes ?? []).map((n) => `${escaparLike(n.toLowerCase())}%`),
      filtro.dia ?? null,
      MAX_CANDIDATAS,
    ],
  )
  return rows.map((r) => {
    const p = lerPayload(r.payload)
    return { id: r.id, tenantId: r.tenant_id, numero: numeroDaNota(r), nome: p.nome, valor: p.valor, emitidaEm: r.issued_at, empresa: escopo.variasEmpresas ? r.razao_social : null }
  })
}

async function novoCancelamento(
  ctx: Contexto,
  texto: string,
  parsed: Parsed,
  tokens: { entrada: number; saida: number },
  semPedido: () => void,
): Promise<void> {
  const documentos = new Set<string>()
  const nomes = new Set<string>()
  if (parsed.documento) documentos.add(parsed.documento)
  if (parsed.tomador) nomes.add(parsed.tomador)
  if (parsed.modelo || parsed.tomador || parsed.documento) {
    const modelo = await resolverModelo(ctx.deps.db, ctx.tenantId, parsed)
    if (modelo && !('ambiguos' in modelo)) {
      documentos.add(modelo.tomador_documento)
      nomes.add(modelo.tomador_nome)
    }
  }
  const dia = dataNoTexto(texto, ctx.agora)
  const escopo = await escopoDeNotas(ctx)
  // Conta Escritório: "cancela a nota da Oficina Trilho pra Clínica Saúde" procura só na empresa dita; sem ela (ou
  // com um nome que não é de empresa da conta), em todas. O cliente salvo em qualquer empresa também serve de pista.
  let tenantIds: string[] | undefined
  if (escopo.variasEmpresas) {
    if (parsed.prestador) {
      const ditas = empresasQueBatem(escopo.empresas, parsed.prestador)
      if (ditas.length) tenantIds = ditas.map((e) => e.id)
      else nomes.add(parsed.prestador)
    }
    const pista = parsed.modelo ?? parsed.tomador
    if (pista) {
      const { rows: salvos } = await ctx.deps.db.query<{ tomador_documento: string; tomador_nome: string }>(
        `select tomador_documento, tomador_nome from nofiscal.fiscal_models
          where tenant_id = any($1::uuid[]) and (lower(nome) = lower($2) or lower(tomador_nome) = lower($2)) limit 20`,
        [tenantIds ?? escopo.tenantIds, pista],
      )
      for (const m of salvos) {
        documentos.add(m.tomador_documento)
        nomes.add(m.tomador_nome)
      }
    }
  }
  const candidatas = await buscarNotas(ctx.deps.db, escopo, { documentos: [...documentos], nomes: [...nomes], dia, tenantIds })

  if (!candidatas.length) {
    semPedido()
    const quem = parsed.tomador ?? parsed.modelo
    await responder(ctx, `Não achei nota emitida${quem ? ` para ${quem}` : ''}${dia ? ` em ${dia.split('-').reverse().join('/')}` : ''}.`)
    return
  }
  const conversa: Conversa = { candidatas: candidatas.map((c) => ({ id: c.id, numero: c.numero })) }
  if (candidatas.length === 1) {
    await criarPedido(ctx, { kind: 'cancelar', etapa: 'confirmar', parsed, tokens, conversa, invoiceId: candidatas[0].id, tenantId: candidatas[0].tenantId })
    await responder(ctx, perguntaDeCancelamento(candidatas[0]))
    return
  }
  await criarPedido(ctx, { kind: 'cancelar', etapa: 'escolher_nota', parsed, tokens, conversa })
  await responder(ctx, listaDeOpcoes('Achei mais de uma nota. Qual delas você quer cancelar?', candidatas))
}
