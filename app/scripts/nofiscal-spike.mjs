#!/usr/bin/env node

/**
 * Nó Fiscal — spike na PRODUÇÃO RESTRITA da Sefin Nacional (Unresolved 1, 2 e 3 da tarefa).
 *
 * Roda só na máquina de Lucca, com o A1 da PRIMECARE. Transmite N DPS (padrão 10), consulta
 * cada uma, cancela uma, testa lacuna na numeração e reuso do número de uma DPS rejeitada de
 * propósito, e grava um relatório JSON na pasta de --saida. Recusa qualquer ambiente que não
 * seja a produção restrita. CNPJ, inscrição municipal, CPF e nome do tomador de teste, caminho
 * do PFX e senha são pedidos no terminal (a senha sem eco) e não são gravados nem exibidos.
 *
 *   node scripts/nofiscal-spike.mjs --serie=<1-49999> --numero-inicial=<n> --ctribnac=040101 \
 *     --p-tot-trib-sn=<percentual> --saida=<pasta> [--quantidade=10] [--perfil-assinatura=sha256|sha1]
 *
 * A lógica está em `nofiscal-spike-core.ts` (TypeScript), carregada pela remoção de tipos
 * nativa do Node 24; o gancho abaixo troca `.js` por `.ts` nos imports relativos do motor.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import readline from 'node:readline'
import { Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

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
  const { runSpike } = await import('./nofiscal-spike-core.ts')
  const { httpsTransport } = await import('../api/_lib/sefin-client.ts')
  try {
    await runSpike({
      argv: process.argv.slice(2),
      ask,
      readFile: (path) => readFile(path),
      writeFile: (path, content) => writeFile(path, content, { encoding: 'utf8', flag: 'wx' }),
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
