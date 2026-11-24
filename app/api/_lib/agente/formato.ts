// Formato das mensagens de texto livre do agente no WhatsApp (Lucca, 24/11/2026: as mensagens chegavam como um bloco
// corrido, difícil de ler). Só a forma muda; o conteúdo e o tom ficam como estão.
//
// O padrão:
// - mensagem de uma frase (ou curta) continua numa linha só;
// - mensagem com mais de um bloco abre com um título curto em negrito do WhatsApp (`*Resumo da nota*`);
// - blocos separados por uma linha em branco;
// - listas com "•";
// - campos com o rótulo em negrito (`*Tomador:* Studio Lima`);
// - a chamada para ação (o que responder) sozinha no último bloco.
// Sem emoji. Os modelos aprovados pela Meta (nofiscal_boas_vindas, nofiscal_resumo, guia_nova, guia_lembrete,
// honorario_aviso) ficam de fora: o texto deles é o aprovado.

/** `*texto*`: negrito do WhatsApp. */
export const negrito = (texto: string) => `*${texto}*`

/** `*Rótulo:* valor`. */
export const campo = (rotulo: string, valor: string) => `*${rotulo}:* ${valor}`

/**
 * Linha pronta "Rótulo: valor" (de outro módulo, como as da retenção) com o rótulo em negrito. Linha sem ": " ou com o
 * rótulo já em negrito fica como está.
 */
export function comRotulo(linha: string): string {
  if (linha.startsWith('*')) return linha
  const i = linha.indexOf(': ')
  if (i <= 0 || i > 60) return linha
  return `*${linha.slice(0, i)}:*${linha.slice(i + 1)}`
}

/** Um item de lista por linha, com "•". */
export const topicos = (itens: readonly string[]) => itens.map((item) => `• ${item}`).join('\n')

/** Um bloco: um parágrafo (texto) ou linhas seguidas (lista), sem linha em branco no meio. Vazio some. */
export type Bloco = string | readonly (string | null | undefined | false)[] | null | undefined | false

function textoDoBloco(bloco: Bloco): string {
  if (!bloco) return ''
  if (typeof bloco === 'string') return bloco.trim()
  return bloco
    .filter((linha): linha is string => Boolean(linha))
    .join('\n')
    .trim()
}

/** Blocos separados por uma linha em branco. */
export const blocos = (...partes: Bloco[]) => partes.map(textoDoBloco).filter(Boolean).join('\n\n')

/**
 * A mensagem no padrão: o título em negrito (só quando há mais de um bloco), os blocos e a ação sozinha no fim.
 * Uma mensagem de um bloco só, sem título nem ação, sai como veio.
 */
export function mensagem(partes: { titulo?: string | null; blocos: Bloco[]; acao?: string | null }): string {
  const corpo = partes.blocos.map(textoDoBloco).filter(Boolean)
  const todos = [...corpo, ...(partes.acao ? [partes.acao.trim()] : [])]
  const titulo = partes.titulo && todos.length > 1 ? [negrito(partes.titulo)] : []
  return [...titulo, ...todos].join('\n\n')
}

/** Limite de uma mensagem sem nenhuma quebra de linha (o teste de formato confere todas as mensagens do agente). */
export const MAX_SEM_QUEBRA = 280

/** A mensagem é um bloco corrido: passa do limite e não tem nenhuma quebra de linha. */
export const ehBlocoCorrido = (texto: string) => texto.length > MAX_SEM_QUEBRA && !texto.includes('\n')
