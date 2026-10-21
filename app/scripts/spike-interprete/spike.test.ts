// Spike do intérprete. Check C50 de .checks/agente-fiscal-v2.md (lote D): `npm run
// spike:interprete -- --modelo <id> --dry-run` percorre os 50 pedidos com o dublê e imprime o
// acerto (%) e os tokens médios. Nenhuma chamada sai da máquina.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validarParsed } from '../../api/_lib/agente/interprete.js'
import { fetchDoDuble, lerPedidos, runSpike, tokensDoDuble } from './spike-core.js'

const APP_DIR = fileURLToPath(new URL('../../', import.meta.url))

describe('spike do intérprete', () => {
  it('spike imprime acerto e tokens', async () => {
    // O comando do critério, pelo npm script, com o dublê.
    const scripts = (JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    expect(scripts['spike:interprete']).toBe('node scripts/spike-interprete/spike.mjs')
    const execucao = spawnSync(process.execPath, ['scripts/spike-interprete/spike.mjs', '--modelo', 'claude-haiku-4-5-20251001', '--dry-run'], {
      cwd: APP_DIR,
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: '' },
      timeout: 60_000,
    })
    expect(execucao.stderr).toBe('')
    expect(execucao.status).toBe(0)
    const pedidos = lerPedidos()
    const mediaEsperada =
      pedidos.reduce((soma, p) => soma + tokensDoDuble(p.texto).entrada + tokensDoDuble(p.texto).saida, 0) / pedidos.length
    expect(execucao.stdout).toContain('Modelo: claude-haiku-4-5-20251001 (dry-run, dublê da API)')
    expect(execucao.stdout).toContain('Pedidos: 50')
    expect(execucao.stdout).toContain('Acerto sem correção: 50/50 (100.0%)')
    expect(execucao.stdout).toContain(`Tokens médios por pedido: ${mediaEsperada.toFixed(1)} (entrada `)

    // A conta do acerto: uma IA que erra o valor de 2 pedidos e o nome de 1 dá 47/50 = 94%.
    const linhas: string[] = []
    const resultado = await runSpike({
      argv: ['--dry-run', '--modelo=modelo-x'],
      print: (l) => linhas.push(l),
      pedidos,
      fetchDryRun: fetchDoDuble(pedidos, (p) =>
        p.id === 1 || p.id === 2 ? { valor: '999.00' } : p.id === 3 ? { tomador: 'Outra Padaria' } : null,
      ),
    })
    expect(resultado).toMatchObject({ modelo: 'modelo-x', total: 50, acertos: 47, falhas: 0, divergencias: [1, 2, 3] })
    expect(linhas).toContain('Acerto sem correção: 47/50 (94.0%)')

    // O nome do gabarito vale em `modelo` também, sem diferenciar maiúsculas e acentos.
    const comoModelo = await runSpike({
      argv: ['--dry-run'],
      print: () => undefined,
      pedidos,
      fetchDryRun: fetchDoDuble(pedidos, (p) => (p.gabarito.tomador ? { tomador: null, modelo: p.gabarito.tomador.toUpperCase() } : null)),
    })
    expect(comoModelo.acertos).toBe(50)

    // Sem --dry-run e sem chave, não chama nada.
    await expect(runSpike({ argv: [], env: {}, print: () => undefined, pedidos })).rejects.toThrow('ANTHROPIC_API_KEY')
  })

  it('pedidos do spike', () => {
    const pedidos = lerPedidos()
    expect(pedidos).toHaveLength(50)
    expect(new Set(pedidos.map((p) => p.id)).size).toBe(50)
    expect(new Set(pedidos.map((p) => p.texto)).size).toBe(50)
    // O gabarito está no formato que o código aceita (o que a validação devolveria).
    for (const p of pedidos) {
      const { tomador, documento, valor, intencao } = p.gabarito
      expect(validarParsed({ tomador, documento, valor, intencao })).toEqual({ tomador, documento, valor, modelo: null, intencao })
    }
    // A mistura que o critério pede: com e sem documento, cancelamentos, conversas sem pedido,
    // valores por extenso, com vírgula e erros de digitação.
    const por = (f: (p: (typeof pedidos)[number]) => boolean) => pedidos.filter(f).length
    expect(por((p) => p.gabarito.intencao === 'cancelar')).toBeGreaterThanOrEqual(5)
    expect(por((p) => p.gabarito.intencao === 'outro')).toBeGreaterThanOrEqual(4)
    expect(por((p) => p.gabarito.documento?.length === 11)).toBeGreaterThanOrEqual(2)
    expect(por((p) => p.gabarito.documento?.length === 14)).toBeGreaterThanOrEqual(2)
    expect(por((p) => /\b(dez|cento|duzentos|trezentos|quinhentos|mil e)\b/.test(p.texto))).toBeGreaterThanOrEqual(3)
    expect(por((p) => /\d,\d{2}/.test(p.texto))).toBeGreaterThanOrEqual(5)
    expect(por((p) => /presiso|reias|Clinca/.test(p.texto))).toBeGreaterThanOrEqual(2)
  })
})
