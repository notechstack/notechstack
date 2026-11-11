#!/usr/bin/env node

/**
 * Nó Fiscal — bateria de testes da emissão por procuração eletrônica (handoff de 11/11/2026).
 *
 *   node scripts/nofiscal-procuracao.mjs sonda  --saida=<pasta> [...]   testes 1 e 4 (só leitura)
 *   node scripts/nofiscal-procuracao.mjs emitir --serie=<n> --numero=<n> --ctribnac=<6> --saida=<pasta> [...]
 *                                                                         testes 3, 3b e 4
 *   node scripts/nofiscal-procuracao.mjs --help
 *
 * Roda só na máquina de Lucca. CNPJ, CPF, nome, caminhos dos PFX, senhas e chave de acesso são
 * pedidos no terminal (senhas sem eco) e não vão ao relatório. Emissão em produção exige
 * --autorizado-por-lucca e a frase de confirmação. A lógica está em `nofiscal-procuracao-core.ts`,
 * carregada pela remoção de tipos nativa do Node 24 (mesmo gancho do nofiscal-spike.mjs).
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import readline from 'node:readline'
import { Writable } from 'node:stream'
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

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    let muted = false
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding)
        callback()
      },
    })
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true })
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer)
    })
    muted = hidden
  })
}

async function main() {
  const { runProcuracao } = await import('./nofiscal-procuracao-core.ts')
  const { httpsTransport } = await import('../api/_lib/sefin-client.ts')
  try {
    await runProcuracao({
      argv: process.argv.slice(2),
      ask,
      readFile: (path) => readFile(path),
      // A sonda regrava o relatório a cada rodada; o nome leva data e hora, então não colide.
      writeFile: (path, content) => writeFile(path, content, { encoding: 'utf8' }),
      transport: ({ extraCa }) => httpsTransport({ extraCa }),
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      print: (line) => process.stdout.write(`${line}\n`),
    })
  } catch (error) {
    // Só a mensagem: nunca o objeto, que pode carregar opções com o certificado.
    process.stderr.write(`Erro: ${error instanceof Error ? error.message : 'falha desconhecida'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
