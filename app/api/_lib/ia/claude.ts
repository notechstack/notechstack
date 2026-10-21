// Cliente da IA do agente fiscal (Landing de .checks/agente-fiscal-v2.md, lote D - SDK e cliente
// da IA). Sem `ANTHROPIC_API_KEY` não há IA: quem chama decide o que fazer (o intérprete cai em
// `interpreteNaoConfigurado()` e a leitura de PDF responde `503 IA_INDISPONIVEL`). A chave nunca
// vai a log. `ANTHROPIC_BASE_URL` vazio deixa o SDK na URL oficial (critério 56).
import Anthropic from '@anthropic-ai/sdk'

/** Modelo padrão enquanto o spike não escolhe outro (Unresolved 10 da tarefa). */
export const MODELO_PADRAO = 'claude-haiku-4-5-20251001'
export const IA_TIMEOUT_MS = 30_000

export type Ia = { cliente: Anthropic; modelo: string }

export type Tokens = { entrada: number; saida: number }

export function clienteClaude(options: { apiKey: string; baseURL?: string | null; fetch?: typeof fetch }): Anthropic {
  return new Anthropic({
    apiKey: options.apiKey,
    // `undefined` deixa o SDK ler `ANTHROPIC_BASE_URL` e, sem ela, usar https://api.anthropic.com.
    baseURL: options.baseURL || undefined,
    maxRetries: 2,
    timeout: IA_TIMEOUT_MS,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
}

export function iaFromEnv(env: NodeJS.ProcessEnv = process.env): Ia | null {
  const apiKey = env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  return {
    cliente: clienteClaude({ apiKey, baseURL: env.ANTHROPIC_BASE_URL }),
    modelo: env.AGENTE_FISCAL_IA_MODELO || MODELO_PADRAO,
  }
}

export class RespostaDaIaInvalida extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RespostaDaIaInvalida'
  }
}

const inteiro = (valor: number | null | undefined) => Math.max(0, Math.trunc(Number(valor) || 0))

/**
 * Uma chamada com saída estruturada: devolve o JSON do bloco de texto e os tokens. Resposta
 * cortada, recusada ou fora de JSON é falha (`RespostaDaIaInvalida`); erros da API sobem como
 * os tipos do SDK.
 */
export async function pedirJson(
  ia: Ia,
  pedido: { system: string; content: Anthropic.MessageParam['content']; schema: Record<string, unknown>; maxTokens: number },
): Promise<{ json: unknown; tokens: Tokens }> {
  const resposta = await ia.cliente.messages.create({
    model: ia.modelo,
    max_tokens: pedido.maxTokens,
    system: pedido.system,
    messages: [{ role: 'user', content: pedido.content }],
    output_config: { format: { type: 'json_schema', schema: pedido.schema } },
  })
  const uso = resposta.usage
  const tokens = {
    entrada: inteiro(uso?.input_tokens) + inteiro(uso?.cache_creation_input_tokens) + inteiro(uso?.cache_read_input_tokens),
    saida: inteiro(uso?.output_tokens),
  }
  if (resposta.stop_reason !== 'end_turn') throw new RespostaDaIaInvalida(`stop_reason ${resposta.stop_reason}`)
  const texto = resposta.content
    .filter((bloco): bloco is Anthropic.TextBlock => bloco.type === 'text')
    .map((bloco) => bloco.text)
    .join('')
  try {
    return { json: JSON.parse(texto) as unknown, tokens }
  } catch {
    throw new RespostaDaIaInvalida('resposta fora de JSON')
  }
}
