#!/usr/bin/env node

/**
 * Nó Fiscal — homologação do leiaute da NT 009 na PRODUÇÃO RESTRITA, por regime (MEI, Simples, Presumido, Real).
 *
 * Roda só na máquina do Lucca, com o A1 de uma empresa de teste do regime. Transmite a DPS no leiaute novo (sem e com
 * IBSCBS; no Presumido/Real com tomador CNPJ, também com IRRF e PIS/COFINS/CSLL retidos), confere na NFS-e o que a
 * Sefin gravou, consulta e cancela cada nota, e grava um relatório JSON mascarado em --saida. CNPJ, inscrição
 * municipal, tomador, caminho do PFX e senha são pedidos no terminal (a senha sem eco) e não são gravados.
 *
 *   node scripts/nofiscal-homologacao.mjs --regime=presumido --municipio=3304557 --ctribnac=170201  *     --serie=900 --numero-inicial=1 --p-tot-trib=13.45,0,5.00 --nbs=1.1502.10.00 --saida=<pasta>
 *
 * A lógica está em `nofiscal-homologacao-core.ts`.
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
  const { runHomologacao } = await import('./nofiscal-homologacao-core.ts')
  const { httpsTransport } = await import('../api/_lib/sefin-client.ts')
  try {
    await runHomologacao({
      argv: process.argv.slice(2),
      ask,
      readFile: (path) => readFile(path),
      writeFile: (path, content) => writeFile(path, content, { encoding: 'utf8', flag: 'wx' }),
      transport: ({ extraCa }) => httpsTransport({ extraCa }),
      now: () => new Date(),
      print: (line) => process.stdout.write(`${line}
`),
    })
  } catch (error) {
    // Só a mensagem: nunca o objeto, que pode carregar opções com o certificado.
    process.stderr.write(`Erro: ${error instanceof Error ? error.message : 'falha desconhecida'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
