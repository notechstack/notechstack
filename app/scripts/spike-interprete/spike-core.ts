// Spike do intérprete (critério 50; Landing de .checks/agente-fiscal-v2.md, lote D - spike do
// intérprete). Percorre os 50 pedidos de `pedidos.json` com o `interpreteClaude` de produção e
// compara o `parsed` validado com o gabarito. "Acerto sem correção" = a conversa da v1 seguiria
// sem pedir nada de volta: intenção, valor e documento iguais, e o nome do gabarito igual ao
// `tomador` ou ao `modelo` (sem diferenciar maiúsculas, acentos e espaços).
// `--dry-run` troca a API por um `fetch` falso dentro do processo, que responde o gabarito: prova
// o caminho inteiro (SDK, schema, validação, contagem) sem rede e sem chave.
import { readFileSync } from 'node:fs'
import { interpreteClaude } from '../../api/_lib/agente/interprete-claude.js'
import type { Intencao, Parsed } from '../../api/_lib/agente/interprete.js'
import { clienteClaude, MODELO_PADRAO, type Ia } from '../../api/_lib/ia/claude.js'

export type Gabarito = { tomador: string | null; documento: string | null; valor: string | null; intencao: Intencao }
export type PedidoDoSpike = { id: number; texto: string; gabarito: Gabarito }

export const PEDIDOS_URL = new URL('./pedidos.json', import.meta.url)

export function lerPedidos(url: URL = PEDIDOS_URL): PedidoDoSpike[] {
  const arquivo = JSON.parse(readFileSync(url, 'utf8')) as { pedidos: PedidoDoSpike[] }
  return arquivo.pedidos
}

const normalizar = (texto: string | null) =>
  texto === null
    ? null
    : texto
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()

/** O `parsed` validado bate com o gabarito sem precisar de correção? */
export function acertou(parsed: Parsed, gabarito: Gabarito): boolean {
  if (parsed.intencao !== gabarito.intencao) return false
  if (parsed.valor !== gabarito.valor) return false
  if (parsed.documento !== gabarito.documento) return false
  const esperado = normalizar(gabarito.tomador)
  if (esperado === null) return parsed.tomador === null && parsed.modelo === null
  return normalizar(parsed.tomador) === esperado || normalizar(parsed.modelo) === esperado
}

export type Opcoes = { modelo: string; dryRun: boolean }

export function lerArgumentos(argv: string[], env: NodeJS.ProcessEnv = process.env): Opcoes {
  let modelo = env.AGENTE_FISCAL_IA_MODELO || MODELO_PADRAO
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--modelo') {
      const valor = argv[++i]
      if (!valor || valor.startsWith('--')) throw new Error('--modelo precisa do id do modelo')
      modelo = valor
    } else if (arg.startsWith('--modelo=')) modelo = arg.slice('--modelo='.length)
    else throw new Error(`argumento desconhecido: ${arg}`)
  }
  if (!modelo) throw new Error('--modelo precisa do id do modelo')
  return { modelo, dryRun }
}

/** Tokens que o dublê informa: proporcionais ao texto, para a média ter algo a medir. */
export const tokensDoDuble = (texto: string) => ({ entrada: 400 + texto.length, saida: 30 })

/**
 * `fetch` falso da API de mensagens: responde o gabarito do pedido cujo texto chegou, no formato do
 * `POST /v1/messages`. `alterar` deixa o teste simular uma IA que erra.
 */
export function fetchDoDuble(pedidos: PedidoDoSpike[], alterar?: (pedido: PedidoDoSpike) => Partial<Parsed> | null): typeof fetch {
  const porTexto = new Map(pedidos.map((p) => [p.texto, p]))
  return async (_url, init) => {
    const corpo = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] }
    const pedido = porTexto.get(corpo.messages[0]?.content)
    if (!pedido) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fora do roteiro' } }), { status: 400 })
    const g = pedido.gabarito
    const parsed = { tomador: g.tomador, documento: g.documento, valor: g.valor, modelo: null, intencao: g.intencao, ...(alterar?.(pedido) ?? {}) }
    const tokens = tokensDoDuble(pedido.texto)
    return new Response(
      JSON.stringify({
        id: `msg_dry_run_${pedido.id}`,
        type: 'message',
        role: 'assistant',
        model: corpo.model,
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: tokens.entrada, output_tokens: tokens.saida, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
}

export type Resultado = {
  modelo: string
  dryRun: boolean
  total: number
  acertos: number
  percentual: number
  tokensMedios: { total: number; entrada: number; saida: number }
  falhas: number
  divergencias: number[]
}

export type SpikeDeps = {
  argv: string[]
  env?: NodeJS.ProcessEnv
  print: (linha: string) => void
  pedidos?: PedidoDoSpike[]
  /** Só para o dry-run: o `fetch` falso (padrão: `fetchDoDuble(pedidos)`). */
  fetchDryRun?: typeof fetch
}

const umaCasa = (n: number) => n.toFixed(1)

export async function runSpike(deps: SpikeDeps): Promise<Resultado> {
  const env = deps.env ?? process.env
  const opcoes = lerArgumentos(deps.argv, env)
  const pedidos = deps.pedidos ?? lerPedidos()

  let ia: Ia
  if (opcoes.dryRun) {
    ia = {
      cliente: clienteClaude({ apiKey: 'dry-run', baseURL: 'http://dry-run.invalid', fetch: deps.fetchDryRun ?? fetchDoDuble(pedidos) }),
      modelo: opcoes.modelo,
    }
  } else {
    const apiKey = env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('defina ANTHROPIC_API_KEY ou rode com --dry-run')
    ia = { cliente: clienteClaude({ apiKey, baseURL: env.ANTHROPIC_BASE_URL }), modelo: opcoes.modelo }
  }
  const interprete = interpreteClaude(ia)

  deps.print(`Modelo: ${opcoes.modelo}${opcoes.dryRun ? ' (dry-run, dublê da API)' : ''}`)
  deps.print(`Pedidos: ${pedidos.length}`)
  let acertos = 0
  let falhas = 0
  let entrada = 0
  let saida = 0
  const divergencias: number[] = []
  for (const pedido of pedidos) {
    try {
      const { parsed, tokens } = await interprete.interpretar(pedido.texto)
      entrada += tokens.entrada
      saida += tokens.saida
      if (acertou(parsed, pedido.gabarito)) acertos++
      else divergencias.push(pedido.id)
    } catch (error) {
      // Só o nome do erro: a mensagem do SDK pode ecoar a requisição.
      falhas++
      divergencias.push(pedido.id)
      deps.print(`Pedido ${pedido.id}: falhou (${error instanceof Error ? error.name : 'erro'})`)
    }
  }

  const total = pedidos.length
  const percentual = total ? (acertos / total) * 100 : 0
  const media = (n: number) => (total ? n / total : 0)
  const resultado: Resultado = {
    modelo: opcoes.modelo,
    dryRun: opcoes.dryRun,
    total,
    acertos,
    percentual,
    tokensMedios: { total: media(entrada + saida), entrada: media(entrada), saida: media(saida) },
    falhas,
    divergencias,
  }
  deps.print(`Acerto sem correção: ${acertos}/${total} (${umaCasa(percentual)}%)`)
  deps.print(
    `Tokens médios por pedido: ${umaCasa(resultado.tokensMedios.total)} (entrada ${umaCasa(resultado.tokensMedios.entrada)}, saída ${umaCasa(resultado.tokensMedios.saida)})`,
  )
  deps.print(`Falhas da API: ${falhas}`)
  deps.print(`Divergências: ${divergencias.length ? divergencias.join(', ') : 'nenhuma'}`)
  return resultado
}
