// Modelos de mensagem do módulo Guias (critério 13): utilidade, pt_BR, conta `nó.fiscal`. Este arquivo é a fonte
// única: o envio usa os nomes e a ordem dos parâmetros daqui, e `modeloParaMeta()` gera o corpo para criar cada
// modelo no WhatsApp Manager / Graph API (`POST /{waba-id}/message_templates`) — quem cria é o Lucca, não o código.
// Regras da Meta seguidas: sem oferta (senão vira marketing), variável nunca no começo nem no fim do corpo, rodapé
// com "Responda SAIR para não receber mais." e o nome do escritório no texto ({{1}}).
import type { ExtrasDoModelo } from '../agente/canais.js'
import type { TipoDeGuia } from './leitura.js'

export const RODAPE_SAIR = 'Responda SAIR para não receber mais.'

export type ModeloDeGuia = {
  nome: 'guia_nova' | 'guia_lembrete' | 'honorario_aviso'
  /** Corpo com {{n}}; `parametros` dá o nome de cada um, na ordem. */
  corpo: string
  parametros: string[]
  cabecalhoDocumento: boolean
  /** Botões na ordem do modelo (o índice do envio é a posição aqui). */
  botoes: ({ tipo: 'QUICK_REPLY'; texto: string; acao: AcaoDoBotao } | { tipo: 'URL'; texto: string; url: string })[]
}

/** O que o payload do botão de resposta rápida diz ao webhook. */
export type AcaoDoBotao = 'recebi' | 'escritorio' | 'paguei' | 'segunda_via'

export const MODELOS: Record<ModeloDeGuia['nome'], ModeloDeGuia> = {
  guia_nova: {
    nome: 'guia_nova',
    corpo:
      'Olá! {{1}} enviou a guia {{2}} de {{3}}, competência {{4}}.\n\nValor: R$ {{5}}\nVencimento: {{6}}\nLinha digitável: {{7}}\n\nO PDF da guia está nesta mensagem.',
    parametros: ['escritorio', 'tipo', 'empresa', 'competencia', 'valor', 'vencimento', 'linha'],
    cabecalhoDocumento: true,
    botoes: [
      // A Meta exige as respostas rápidas juntas: Recebi (0), Falar com o escritório (1), URL (2).
      { tipo: 'QUICK_REPLY', texto: 'Recebi', acao: 'recebi' },
      { tipo: 'QUICK_REPLY', texto: 'Falar com o escritório', acao: 'escritorio' },
      { tipo: 'URL', texto: 'Ver e copiar o código', url: 'https://app.notechstack.com.br/g/{{1}}' },
    ],
  },
  guia_lembrete: {
    nome: 'guia_lembrete',
    corpo: 'Lembrete de {{1}}: a guia {{2}} de {{3}} (R$ {{4}}) vence {{5}}. Se já pagou, toque em Já paguei.',
    parametros: ['escritorio', 'tipo', 'empresa', 'valor', 'quando'],
    cabecalhoDocumento: false,
    botoes: [
      { tipo: 'QUICK_REPLY', texto: 'Já paguei', acao: 'paguei' },
      { tipo: 'QUICK_REPLY', texto: 'Mandar de novo', acao: 'segunda_via' },
    ],
  },
  honorario_aviso: {
    nome: 'honorario_aviso',
    corpo:
      'Olá! {{1}}: honorários de {{2}}, R$ {{3}}, vencimento {{4}}.\nLinha digitável: {{5}}\n\nO boleto está nesta mensagem.',
    parametros: ['escritorio', 'mes', 'valor', 'vencimento', 'linha'],
    cabecalhoDocumento: true,
    botoes: [
      // A Meta exige as respostas rápidas juntas: Recebi (0), Falar com o escritório (1), URL (2).
      { tipo: 'QUICK_REPLY', texto: 'Recebi', acao: 'recebi' },
      { tipo: 'QUICK_REPLY', texto: 'Falar com o escritório', acao: 'escritorio' },
      { tipo: 'URL', texto: 'Ver e copiar o código', url: 'https://app.notechstack.com.br/g/{{1}}' },
    ],
  },
}

/** Exemplo de cada parâmetro (a Meta exige exemplo na revisão). */
const EXEMPLOS: Record<string, string> = {
  escritorio: 'Contabilidade Exemplo', tipo: 'DAS do Simples Nacional', empresa: 'Padaria Exemplo Ltda', competencia: '11/2026',
  valor: '1.234,56', vencimento: '20/12/2026', linha: '85890000012 3 34560328262 4 07202632412 3 45678901234 5', quando: 'amanhã', mes: 'novembro/2026',
}

/** Corpo para `POST /{waba-id}/message_templates` (o Lucca cria; o código nunca chama). */
export function modeloParaMeta(m: ModeloDeGuia, exemploDoDocumento = '<handle do PDF de exemplo>'): Record<string, unknown> {
  const componentes: Record<string, unknown>[] = []
  if (m.cabecalhoDocumento) componentes.push({ type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [exemploDoDocumento] } })
  componentes.push({ type: 'BODY', text: m.corpo, example: { body_text: [m.parametros.map((p) => EXEMPLOS[p] ?? p)] } })
  componentes.push({ type: 'FOOTER', text: RODAPE_SAIR })
  componentes.push({
    type: 'BUTTONS',
    buttons: m.botoes.map((b) =>
      b.tipo === 'URL' ? { type: 'URL', text: b.texto, url: b.url, example: ['https://app.notechstack.com.br/g/exemplo'] } : { type: 'QUICK_REPLY', text: b.texto },
    ),
  })
  return { name: m.nome, language: 'pt_BR', category: 'UTILITY', components: componentes }
}

// ------------------------------------------------------------------ Textos dos parâmetros

export const ROTULO_DO_TIPO: Record<TipoDeGuia, string> = {
  das: 'DAS do Simples Nacional',
  das_mei: 'DAS-MEI',
  darf: 'DARF',
  dctfweb: 'DARF da DCTFWeb',
  fgts: 'FGTS Digital',
  iss: 'ISS',
  parcelamento: 'de parcelamento',
  honorario: 'de honorários',
  outro: 'de pagamento',
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

export const reaisSemSimbolo = (centavos: number) =>
  (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
export const competenciaBr = (iso: string | null) => (iso ? `${iso.slice(5, 7)}/${iso.slice(0, 4)}` : 'não informada')
export const mesPorExtenso = (iso: string | null) => (iso ? `${MESES[Number(iso.slice(5, 7)) - 1]}/${iso.slice(0, 4)}` : 'do mês')

/** A Meta recusa parâmetro com quebra de linha, tabulação ou mais de 4 espaços seguidos; e corta em 1.024. */
export const parametro = (v: string) => v.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000) || '-'

export type DadosDaMensagem = {
  guiaId: string
  escritorio: string
  empresa: string
  tipo: TipoDeGuia
  competencia: string | null
  valorCentavos: number
  vencimento: string
  linha: string
  /** Token do link /g/<token> (sufixo do botão de URL). */
  token: string
}

/** Payload do botão de resposta rápida: `guia:<id>:<ação>` (volta no webhook). */
export const payloadDoBotao = (guiaId: string, acao: AcaoDoBotao) => `guia:${guiaId}:${acao}`

export function lerPayload(payload: string | null | undefined): { guiaId: string; acao: AcaoDoBotao } | null {
  const m = /^guia:([0-9a-f-]{36}):(recebi|escritorio|paguei|segunda_via)$/i.exec(payload ?? '')
  return m ? { guiaId: m[1].toLowerCase(), acao: m[2] as AcaoDoBotao } : null
}

function extrasDe(m: ModeloDeGuia, guiaId: string, token: string, documento?: { mediaId: string; nome: string }): ExtrasDoModelo {
  return {
    ...(documento ? { documento } : {}),
    botoes: m.botoes.map((b, indice) =>
      b.tipo === 'URL' ? { tipo: 'url' as const, indice, texto: token } : { tipo: 'resposta' as const, indice, payload: payloadDoBotao(guiaId, b.acao) },
    ),
  }
}

/** Envio da guia nova (honorário usa `honorario_aviso`): nome, parâmetros do corpo e extras (PDF e botões). */
export function mensagemDeEnvio(d: DadosDaMensagem, documento: { mediaId: string; nome: string }) {
  const valor = reaisSemSimbolo(d.valorCentavos)
  if (d.tipo === 'honorario') {
    const m = MODELOS.honorario_aviso
    return {
      nome: m.nome,
      // Sem competência lida, vale o mês do vencimento ("honorários de dezembro/2026").
      parametros: [d.escritorio, mesPorExtenso(d.competencia ?? `${d.vencimento.slice(0, 7)}-01`), valor, dataBr(d.vencimento), d.linha].map(parametro),
      extras: extrasDe(m, d.guiaId, d.token, documento),
    }
  }
  const m = MODELOS.guia_nova
  return {
    nome: m.nome,
    parametros: [d.escritorio, ROTULO_DO_TIPO[d.tipo], d.empresa, competenciaBr(d.competencia), valor, dataBr(d.vencimento), d.linha].map(parametro),
    extras: extrasDe(m, d.guiaId, d.token, documento),
  }
}

export function mensagemDeLembrete(d: Omit<DadosDaMensagem, 'token' | 'linha'>, quando: string) {
  const m = MODELOS.guia_lembrete
  return {
    nome: m.nome,
    parametros: [d.escritorio, ROTULO_DO_TIPO[d.tipo], d.empresa, reaisSemSimbolo(d.valorCentavos), quando].map(parametro),
    extras: extrasDe(m, d.guiaId, ''),
  }
}
