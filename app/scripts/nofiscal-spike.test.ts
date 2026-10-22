// Roteiro do spike com dependências injetadas: transporte em dublê (nenhuma chamada à Sefin),
// terminal, arquivos e relógio falsos. Landing do checklist, lote 2b - roteiro do spike.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeTestCertificate } from '../api/_tests/certs.js'
import { fakeSefin } from '../api/_tests/sefin-fake.js'
import { cpfComDvErrado, cpfValido, runSpike, SpikeRefused, type SpikeDeps } from './nofiscal-spike-core.js'

const APP_DIR = fileURLToPath(new URL('../', import.meta.url))
const cert = makeTestCertificate()
const SECRETS = {
  cnpj: '56210013000140',
  im: '98765432',
  cpf: '12345678909',
  nome: 'Lucca Tomador de Teste',
  pfxPath: 'C:/certificados/a1-primecare.pfx',
  password: cert.certificado.password,
}
const NUMERO_INICIAL = 987654

function deps(argv: string[], fake = fakeSefin()) {
  const asked: string[] = []
  const written: { path: string; content: string }[] = []
  const printed: string[] = []
  let transportCreated = 0
  let clock = Date.parse('2026-10-22T13:00:00Z')
  const answers: Record<string, string> = {
    'CNPJ do prestador': SECRETS.cnpj,
    'Inscrição municipal': SECRETS.im,
    'CPF do tomador': SECRETS.cpf,
    'Nome do tomador': SECRETS.nome,
    'Caminho do arquivo PFX': SECRETS.pfxPath,
    'Senha do PFX': SECRETS.password,
  }
  const d: SpikeDeps = {
    argv,
    ask: async (question, options) => {
      asked.push(`${question}${options?.hidden ? ' [sem eco]' : ''}`)
      const key = Object.keys(answers).find((k) => question.startsWith(k))
      if (!key) throw new Error(`pergunta inesperada: ${question}`)
      return answers[key]
    },
    readFile: async (path) => {
      if (path === SECRETS.pfxPath) return Buffer.from(cert.certificado.pfxBase64, 'base64')
      throw new Error(`arquivo inesperado: ${path}`)
    },
    writeFile: async (path, content) => {
      written.push({ path, content })
    },
    transport: () => {
      transportCreated++
      return fake.transport
    },
    now: () => new Date((clock += 7)),
    sleep: async () => undefined,
    print: (line) => printed.push(line),
  }
  return { deps: d, asked, written, printed, fake, transportCreated: () => transportCreated }
}

const ARGS = [
  `--serie=7`,
  `--numero-inicial=${NUMERO_INICIAL}`,
  '--ctribnac=040101',
  '--p-tot-trib-sn=6.00',
  '--saida=C:/relatorios/spike',
]

describe('roteiro do spike', () => {
  it('recusa rodar fora da produção restrita, antes de pedir qualquer dado', async () => {
    for (const ambiente of ['producao', 'homologacao', '']) {
      const run = deps([...ARGS, `--ambiente=${ambiente}`])
      await expect(runSpike(run.deps)).rejects.toBeInstanceOf(SpikeRefused)
      expect(run.asked).toHaveLength(0)
      expect(run.transportCreated()).toBe(0)
      expect(run.fake.requests).toHaveLength(0)
      expect(run.written).toHaveLength(0)
    }
  })

  it('transmite, consulta, cancela, testa a Unresolved 1 e grava o relatório sem segredos', async () => {
    // Sefin simulada: CPF com DV errado é rejeitado com E0206; o resto é autorizado.
    const fake = fakeSefin({
      emitir: (xml) => {
        const cpf = /<CPF>(\d{11})<\/CPF>/.exec(xml)?.[1] ?? ''
        if (!cpfValido(cpf)) {
          return { status: 400, body: JSON.stringify({ erros: [{ Codigo: 'E0206', Descricao: `CPF ${cpf} com DV inválido` }] }) }
        }
        return undefined
      },
    })
    const run = deps(ARGS, fake)
    const { report, path } = await runSpike(run.deps)

    // A senha é pedida sem eco; nada sensível vem por flag.
    expect(run.asked.find((q) => q.startsWith('Senha'))).toMatch(/\[sem eco\]$/)

    // (a) 10 DPS por padrão, (d) lacuna, rejeição provocada e reenvio: 13 POST /nfse.
    const posts = fake.requests.filter((r) => r.method === 'POST' && r.path === '/nfse')
    expect(posts).toHaveLength(13)
    expect(posts.every((r) => r.url.startsWith('https://sefin.producaorestrita.nfse.gov.br/SefinNacional/'))).toBe(true)
    expect(posts.every((r) => r.xml!.includes('<tpAmb>2</tpAmb>'))).toBe(true)
    const numeros = posts.map((r) => Number(/<nDPS>(\d+)<\/nDPS>/.exec(r.xml!)![1]) - NUMERO_INICIAL)
    expect(numeros).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 12])
    expect(posts[11].xml).toContain(`<CPF>${cpfComDvErrado(SECRETS.cpf)}</CPF>`)
    expect(posts[12].xml).toContain(`<CPF>${SECRETS.cpf}</CPF>`)

    // (b) uma consulta por DPS; (c) um cancelamento e a consulta do evento.
    expect(fake.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/dps/'))).toHaveLength(10)
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/eventos'))).toHaveLength(1)
    expect(fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/eventos/101101/1'))).toHaveLength(1)

    expect(report).not.toBeNull()
    expect(report!.emissoes.map((e) => e.resultado)).toEqual(Array(10).fill('authorized'))
    expect(report!.consultas.map((c) => c.resultado)).toEqual(Array(10).fill('found'))
    expect(report!.cancelamento).toMatchObject({ numero: 'n0+0', resultado: 'accepted', consulta_evento: { resultado: 'found' } })
    expect(report!.unresolved_1.lacuna).toMatchObject({ numero: 'n0+11', pulado: 'n0+10', resultado: 'authorized', aceita: true })
    expect(report!.unresolved_1.reuso_apos_rejeicao).toMatchObject({
      numero: 'n0+12',
      rejeicao_provocada: { resultado: 'rejected', codigo: 'E0206' },
      reenvio: { resultado: 'authorized' },
      aceito: true,
    })
    expect(report!.unresolved_3).toEqual({ alguma_dps_autorizada: true, codigos_vistos: ['E0206'] })
    expect(report!.numeros_consumidos).toEqual([...Array.from({ length: 10 }, (_, k) => `n0+${k}`), 'n0+11', 'n0+12'])
    expect(report!.requisicoes.find((r) => r.metodo === 'POST' && r.rota === '/nfse')?.chaves_json).toContain('chaveAcesso')

    // (e) um arquivo na pasta pedida, sem PFX, senha, XML assinado, identificação ou numeração real.
    expect(run.written).toHaveLength(1)
    expect(path).toBe(run.written[0].path)
    expect(path).toMatch(/^C:\/relatorios\/spike\/nofiscal-spike-.+\.json$/)
    const content = run.written[0].content
    expect(() => JSON.parse(content)).not.toThrow()
    for (const forbidden of [
      SECRETS.cnpj,
      SECRETS.cpf,
      cpfComDvErrado(SECRETS.cpf),
      SECRETS.nome,
      SECRETS.im,
      SECRETS.password,
      SECRETS.pfxPath,
      cert.certificado.pfxBase64.slice(0, 64),
      String(NUMERO_INICIAL),
      '<Signature',
      'SignatureValue',
      'BEGIN',
      '<DPS',
    ]) {
      expect(content, forbidden).not.toContain(forbidden)
    }
    expect(content).not.toMatch(/\d{42,}/)
    // Nada sensível no terminal também.
    const printed = run.printed.join('\n')
    for (const forbidden of [SECRETS.cnpj, SECRETS.cpf, SECRETS.nome, SECRETS.password, SECRETS.pfxPath]) {
      expect(printed, forbidden).not.toContain(forbidden)
    }
  })

  it('o CLI carrega o roteiro com o Node puro e recusa produção sem pedir nada', () => {
    const help = spawnSync(process.execPath, ['scripts/nofiscal-spike.mjs', '--help'], { cwd: APP_DIR, encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('Uso: node scripts/nofiscal-spike.mjs')

    const refused = spawnSync(process.execPath, ['scripts/nofiscal-spike.mjs', ...ARGS, '--ambiente=producao'], {
      cwd: APP_DIR,
      encoding: 'utf8',
      input: '',
    })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('o spike só roda na produção restrita')
    expect(refused.stdout).not.toContain('CNPJ do prestador')
  })
})
