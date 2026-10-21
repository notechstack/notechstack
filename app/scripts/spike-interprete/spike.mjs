#!/usr/bin/env node

/**
 * Nó Fiscal — spike do intérprete por IA (critério 50 do agente fiscal v2).
 *
 *   npm run spike:interprete -- [--modelo <id>] [--dry-run]
 *
 * Percorre os 50 pedidos de `pedidos.json` contra o gabarito e imprime o acerto sem correção (%)
 * e a média de tokens por pedido. Sem `--dry-run`, chama a API da Anthropic com
 * `ANTHROPIC_API_KEY` (e `ANTHROPIC_BASE_URL`, se houver); a chave nunca é impressa. Com
 * `--dry-run`, a API é um dublê dentro do processo, que responde o gabarito.
 *
 * A lógica está em `spike-core.ts`, carregada pela remoção de tipos nativa do Node 24; o gancho
 * abaixo troca `.js` por `.ts` nos imports relativos, como em `nofiscal-spike.mjs`.
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromTs = context.parentURL?.endsWith('.ts')
    if (fromTs && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
    }
    return nextResolve(specifier, context)
  },
})

async function main() {
  const { runSpike } = await import('./spike-core.ts')
  try {
    await runSpike({ argv: process.argv.slice(2), print: (linha) => process.stdout.write(`${linha}\n`) })
  } catch (error) {
    process.stderr.write(`Erro: ${error instanceof Error ? error.message : 'falha desconhecida'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
