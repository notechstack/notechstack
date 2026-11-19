// Homologação da NT 009 com dependências injetadas: o transporte é o dublê da Sefin (nenhuma chamada de rede).
import { describe, expect, it } from 'vitest'
import { makeTestCertificate } from '../api/_tests/certs.js'
import { errosXsd } from '../api/_tests/xsd.js'
import { fakeSefin } from '../api/_tests/sefin-fake.js'
import { gerarRetencoesFederaisDeTeste, runHomologacao, type HomologacaoDeps } from './nofiscal-homologacao-core.js'
import { SpikeRefused } from './nofiscal-spike-core.js'

const cert = makeTestCertificate()
const SEGREDOS = { cnpj: '56210013000140', im: '98765432', tomador: '11222333000181', nome: 'Tomador de Teste Ltda', pfx: 'C:/a1/presumido.pfx' }

function deps(argv: string[], fake = fakeSefin()) {
  const perguntas: string[] = []
  const escritos: { path: string; content: string }[] = []
  let relogio = Date.parse('2026-11-19T13:00:00Z')
  const respostas: Record<string, string> = {
    'CNPJ do prestador': SEGREDOS.cnpj,
    'Inscrição municipal': SEGREDOS.im,
    'CPF ou CNPJ do tomador': SEGREDOS.tomador,
    'Nome do tomador': SEGREDOS.nome,
    'Caminho do arquivo PFX': SEGREDOS.pfx,
    'Senha do PFX': cert.certificado.password,
  }
  const d: HomologacaoDeps = {
    argv,
    ask: async (q) => {
      perguntas.push(q)
      const k = Object.keys(respostas).find((x) => q.startsWith(x))
      if (!k) throw new Error(`pergunta inesperada: ${q}`)
      return respostas[k]
    },
    readFile: async (path) => {
      if (path === SEGREDOS.pfx) return Buffer.from(cert.certificado.pfxBase64, 'base64')
      throw new Error(`arquivo inesperado: ${path}`)
    },
    writeFile: async (path, content) => void escritos.push({ path, content }),
    transport: () => fake.transport,
    now: () => new Date((relogio += 5)),
    print: () => undefined,
  }
  return { deps: d, perguntas, escritos, fake }
}

const PRESUMIDO = [
  '--regime=presumido', '--municipio=3304557', '--ctribnac=100401', '--serie=900', '--numero-inicial=1',
  '--p-tot-trib=13.45,0,5.00', '--nbs=1.1502.10.00', '--saida=C:/relatorios', '--valor=1000.00',
]

describe('homologação da NT 009', () => {
  it('recusa outro ambiente antes de perguntar qualquer coisa', async () => {
    const r = deps([...PRESUMIDO, '--ambiente=producao'])
    await expect(runHomologacao(r.deps)).rejects.toBeInstanceOf(SpikeRefused)
    expect(r.perguntas).toHaveLength(0)
    expect(r.fake.requests).toHaveLength(0)
  })

  it('Presumido: três notas no leiaute NT 009 (sem IBSCBS, com IBSCBS, com retenção federal), válidas no XSD; consulta e cancela', async () => {
    const r = deps(PRESUMIDO)
    const { relatorio, path } = await runHomologacao(r.deps)
    expect(relatorio?.notas.map((n) => [n.caso, n.resultado, n.cancelamento])).toEqual([
      ['nt009', 'authorized', 'accepted'],
      ['nt009+ibscbs', 'authorized', 'accepted'],
      ['nt009+retencao-federal', 'authorized', 'accepted'],
    ])
    const dps = r.fake.requests.filter((q) => q.method === 'POST' && q.path === '/nfse').map((q) => q.xml as string)
    expect(dps).toHaveLength(3)
    for (const xml of dps) {
      expect(xml).toContain('<opSimpNac>1</opSimpNac>')
      expect(xml).toContain('<finNFSe>0</finNFSe>')
      expect(await errosXsd(xml, 'producao-restrita-20261020')).toEqual([])
    }
    expect(dps[0]).not.toContain('<IBSCBS>')
    expect(dps[1]).toContain('<IBSCBS>')
    expect(dps[2]).toContain('<vRetIRRF>15.00</vRetIRRF><vRetCSLL>46.50</vRetCSLL>')
    // O relatório não leva nada que identifique a empresa ou o tomador.
    const texto = r.escritos[0].content
    expect(path).toMatch(/^C:\/relatorios\/homologacao-nt009-presumido-/)
    for (const segredo of [SEGREDOS.cnpj, SEGREDOS.im, SEGREDOS.tomador, SEGREDOS.nome, SEGREDOS.pfx, cert.certificado.password]) {
      expect(texto).not.toContain(segredo)
    }
  })

  it('MEI e Simples: uma nota cada sem --nbs; parâmetros do regime conferidos', async () => {
    const mei = deps(['--regime=mei', '--municipio=3550308', '--ctribnac=100401', '--serie=900', '--numero-inicial=1', '--saida=C:/r'])
    expect((await runHomologacao(mei.deps)).relatorio?.notas.map((n) => n.caso)).toEqual(['nt009'])
    expect(mei.fake.requests.find((q) => q.path === '/nfse')?.xml).toContain('<opSimpNac>2</opSimpNac>')
    const simples = deps(['--regime=simples', '--municipio=3550308', '--ctribnac=100401', '--serie=900', '--numero-inicial=1', '--saida=C:/r'])
    await expect(runHomologacao(simples.deps)).rejects.toThrow(/p-tot-trib-sn/)
    await expect(runHomologacao(deps([...PRESUMIDO.filter((a) => !a.startsWith('--p-tot-trib'))]).deps)).rejects.toThrow(/p-tot-trib/)
  })

  it('retenções federais de teste: 1,5% e 4,65%, arredondadas ao centavo', () => {
    expect(gerarRetencoesFederaisDeTeste('1000.00')).toEqual({ irrf: { valor: '15.00' }, csrf: { valor: '46.50' } })
    expect(gerarRetencoesFederaisDeTeste('333.33')).toEqual({ irrf: { valor: '5.00' }, csrf: { valor: '15.50' } })
  })
})
