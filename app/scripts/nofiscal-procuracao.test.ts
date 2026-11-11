// Bateria da procuração com dependências injetadas: Sefin e ADN em dublê (nenhuma chamada ao
// governo), terminal, arquivos e relógio falsos. Confere o que decide o teste: quem assina, quem
// conecta, que a nota autorizada é cancelada, as travas de produção e que o relatório sai sem segredos.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gzipBase64, type HttpResponse, type SefinTransport } from '../api/_lib/sefin-client.js'
import { makeTestCertificate, type TestCertificate } from '../api/_tests/certs.js'
import { fakeSefin, type FakeRequest } from '../api/_tests/sefin-fake.js'
import {
  CONFIRMACAO_PRODUCAO,
  estadoDaRodada,
  parseCadastradaEm,
  runProcuracao,
  type EmissaoReport,
  type ProcuracaoDeps,
  type SondaReport,
} from './nofiscal-procuracao-core.js'
import { SpikeRefused } from './nofiscal-spike-core.js'

const APP_DIR = fileURLToPath(new URL('../', import.meta.url))
const procurador = makeTestCertificate({ commonName: 'ESCRITORIO TESTE:11222333000181' })
const outorgante = makeTestCertificate({ commonName: 'NO TECH TESTE:56210013000140' })
const S = {
  cnpj: '56210013000140',
  im: '98765432',
  cpf: '12345678909',
  nome: 'Tomador de Teste da Procuracao',
  pfxProcurador: 'C:/certs/procurador.pfx',
  pfxOutorgante: 'C:/certs/outorgante.pfx',
}
const CHAVE_SONDA = '35503082256210013000140000000000000126110123456789'

const corpoDoCert = (c: TestCertificate) => c.certPem.replace(/-----[^-]+-----|\s/g, '')
const assinadoPor = (xml: string, c: TestCertificate) => xml.replace(/\s/g, '').includes(corpoDoCert(c))
const conectouCom = (r: FakeRequest, c: TestCertificate) => r.tls.cert.replace(/-----[^-]+-----|\s/g, '').startsWith(corpoDoCert(c))

function deps(argv: string[], transport: SefinTransport, extra: Record<string, string> = {}) {
  const asked: string[] = []
  const written = new Map<string, string>()
  const printed: string[] = []
  let clock = Date.parse('2026-11-11T17:00:00Z')
  const answers: Record<string, string> = {
    'CNPJ do outorgante': S.cnpj,
    'Inscrição municipal': S.im,
    'CPF do tomador': S.cpf,
    'Nome do tomador': S.nome,
    'Caminho do PFX do procurador': S.pfxProcurador,
    'Senha do PFX do procurador': procurador.certificado.password,
    'Caminho do PFX do outorgante': S.pfxOutorgante,
    'Senha do PFX do outorgante': outorgante.certificado.password,
    'Chave de acesso': '',
    ...extra,
  }
  const d: ProcuracaoDeps = {
    argv,
    ask: async (question, options) => {
      asked.push(`${question}${options?.hidden ? ' [sem eco]' : ''}`)
      const key = Object.keys(answers).find((k) => question.startsWith(k) || question.includes(k))
      if (key === undefined) throw new Error(`pergunta inesperada: ${question}`)
      return answers[key]
    },
    readFile: async (path) => {
      if (path === S.pfxProcurador) return Buffer.from(procurador.certificado.pfxBase64, 'base64')
      if (path === S.pfxOutorgante) return Buffer.from(outorgante.certificado.pfxBase64, 'base64')
      throw new Error(`arquivo inesperado: ${path}`)
    },
    writeFile: async (path, content) => {
      written.set(path, content)
    },
    transport: () => transport,
    now: () => new Date((clock += 1000)),
    sleep: async (ms) => {
      clock += ms
    },
    print: (line) => printed.push(line),
  }
  return { deps: d, asked, written, printed }
}

const EMITIR = ['emitir', '--serie=900', '--numero=1', '--ctribnac=010701', '--p-tot-trib-sn=6.00', '--saida=C:/relatorios']

function semSegredos(texto: string) {
  for (const segredo of [
    S.cnpj,
    S.cpf,
    S.nome,
    S.im,
    S.pfxProcurador,
    S.pfxOutorgante,
    procurador.certificado.password,
    outorgante.certificado.password,
  ]) {
    expect(texto).not.toContain(segredo)
  }
  expect(texto).not.toMatch(/\d{50}/)
}

describe('emitir (testes 3, 3b e 4)', () => {
  it('teste 3: o procurador assina e conecta, o outorgante é o prestador, e a nota autorizada é cancelada', async () => {
    const fake = fakeSefin()
    const t = deps(EMITIR, fake.transport)
    const { path } = await runProcuracao(t.deps)

    const post = fake.requests.find((r) => r.method === 'POST' && r.path === '/nfse')!
    expect(post.xml).toContain(`<CNPJ>${S.cnpj}</CNPJ>`)
    expect(assinadoPor(post.xml!, procurador)).toBe(true)
    expect(assinadoPor(post.xml!, outorgante)).toBe(false)
    expect(fake.requests.every((r) => conectouCom(r, procurador))).toBe(true)
    expect(fake.events.size).toBe(1)
    expect(t.asked.some((q) => q.includes('outorgante') && q.includes('PFX'))).toBe(false)

    const texto = t.written.get(path!)!
    const report = JSON.parse(texto) as EmissaoReport
    expect(report).toMatchObject({
      teste: '3',
      assinatura: 'procurador',
      conexao: 'procurador',
      emissao: { resultado: 'authorized', chave_formato_ok: true },
      cancelamento: { resultado: 'accepted', consulta_evento: { resultado: 'found' } },
      nota_pendente_de_cancelamento: false,
    })
    expect(report.leitura).toContain('dispensa o A1')
    semSegredos(texto)
    semSegredos(t.printed.join('\n'))
  })

  it('teste 3b: assina com o outorgante, mas a conexão continua sendo do procurador', async () => {
    const fake = fakeSefin()
    const t = deps([...EMITIR, '--assinatura=outorgante'], fake.transport)
    const { path } = await runProcuracao(t.deps)

    const post = fake.requests.find((r) => r.method === 'POST' && r.path === '/nfse')!
    expect(assinadoPor(post.xml!, outorgante)).toBe(true)
    expect(assinadoPor(post.xml!, procurador)).toBe(false)
    expect(fake.requests.every((r) => conectouCom(r, procurador))).toBe(true)
    const evento = fake.requests.find((r) => r.method === 'POST' && r.path.endsWith('/eventos'))!
    expect(assinadoPor(evento.xml!, outorgante)).toBe(true)
    const report = JSON.parse(t.written.get(path!)!) as EmissaoReport
    expect(report.teste).toBe('3b')
    expect(report.leitura).toContain('não elimina o A1')
  })

  it('rejeição: grava o código, não tenta cancelar e manda rodar o 3b', async () => {
    const fake = fakeSefin({
      emitir: () => ({ status: 400, body: JSON.stringify({ erros: [{ codigo: 'E0160', descricao: `Emitente ${S.cnpj} sem permissão` }] }) }),
    })
    const t = deps(EMITIR, fake.transport)
    const { path } = await runProcuracao(t.deps)
    const texto = t.written.get(path!)!
    const report = JSON.parse(texto) as EmissaoReport
    expect(report.emissao).toMatchObject({ resultado: 'rejected', codigo: 'E0160' })
    expect(report.cancelamento).toBeNull()
    expect(report.leitura).toContain('3b')
    expect(report.requisicoes).toEqual([expect.objectContaining({ metodo: 'POST', rota: '/nfse', status: 400, codigos: ['E0160'] })])
    expect(fake.requests.some((r) => r.path.endsWith('/eventos'))).toBe(false)
    semSegredos(texto)
  })

  it('teste 4: sem procuração, a rejeição vira o código da mensagem do agente', async () => {
    const fake = fakeSefin({ emitir: () => ({ status: 403, body: JSON.stringify({ erros: [{ codigo: 'E1235', descricao: 'x' }] }) }) })
    const t = deps([...EMITIR, '--rodada=sem-procuracao'], fake.transport)
    const { path } = await runProcuracao(t.deps)
    const report = JSON.parse(t.written.get(path!)!) as EmissaoReport
    expect(report.rodada).toBe('sem-procuracao')
    expect(report.leitura).toContain('E1235')
    expect(path).toContain('teste3-sem-procuracao')
  })

  it('cancelamento recusado: marca a nota como pendente e mostra a chave só no terminal', async () => {
    const fake = fakeSefin({ evento: () => ({ status: 400, body: JSON.stringify({ erro: [{ codigo: 'E0840', descricao: 'autor' }] }) }) })
    const t = deps(EMITIR, fake.transport)
    const { path } = await runProcuracao(t.deps)
    const texto = t.written.get(path!)!
    const report = JSON.parse(texto) as EmissaoReport
    expect(report.nota_pendente_de_cancelamento).toBe(true)
    expect(report.cancelamento).toMatchObject({ resultado: 'refused', codigo: 'E0840' })
    const chave = [...fake.issued.values()][0].chave
    expect(t.printed.join('\n')).toContain(chave)
    expect(t.printed.join('\n')).toContain('NÃO foi cancelada')
    semSegredos(texto)
  })

  it('produção: recusa sem a autorização, com valor acima de 1,00, com --nao-cancelar ou sem a frase, antes de enviar', async () => {
    const casos: [string[], Record<string, string>][] = [
      [[...EMITIR, '--ambiente=producao'], {}],
      [[...EMITIR, '--ambiente=producao', '--autorizado-por-lucca', '--valor=1.01'], {}],
      [[...EMITIR, '--ambiente=producao', '--autorizado-por-lucca', '--nao-cancelar'], {}],
      [[...EMITIR, '--ambiente=producao', '--autorizado-por-lucca'], { 'Vai emitir': 'sim' }],
    ]
    for (const [argv, extra] of casos) {
      const fake = fakeSefin()
      const t = deps(argv, fake.transport, extra)
      await expect(runProcuracao(t.deps)).rejects.toBeInstanceOf(SpikeRefused)
      expect(fake.requests).toHaveLength(0)
      expect(t.asked.some((q) => q.startsWith('CNPJ'))).toBe(false)
    }
  })

  it('produção: com a autorização e a frase, emite na URL de produção e cancela', async () => {
    const fake = fakeSefin()
    const t = deps([...EMITIR, '--ambiente=producao', '--autorizado-por-lucca'], fake.transport, { 'Vai emitir': CONFIRMACAO_PRODUCAO })
    const { path } = await runProcuracao(t.deps)
    expect(fake.requests[0].url.startsWith('https://sefin.nfse.gov.br/SefinNacional/nfse')).toBe(true)
    expect(fake.events.size).toBe(1)
    expect(JSON.parse(t.written.get(path!)!)).toMatchObject({ ambiente: 'producao', nota_pendente_de_cancelamento: false })
  })

  it('recusa ambiente desconhecido e comando desconhecido', async () => {
    const fake = fakeSefin()
    await expect(runProcuracao(deps([...EMITIR, '--ambiente=homologacao'], fake.transport).deps)).rejects.toBeInstanceOf(SpikeRefused)
    await expect(runProcuracao(deps(['emite'], fake.transport).deps)).rejects.toThrow('comando desconhecido')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('sonda (testes 1 e 4)', () => {
  const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body) })
  const loteComOutorgante = json(200, {
    LoteDFe: [{ NSU: 7, ChaveAcesso: CHAVE_SONDA, TipoDocumento: 'NFSE', ArquivoXml: gzipBase64(`<NFSe><emit><CNPJ>${S.cnpj}</CNPJ></emit></NFSe>`) }],
  })

  function roteiro(adn: HttpResponse[], sefin: HttpResponse[]) {
    const urls: string[] = []
    const tls: string[] = []
    const transport: SefinTransport = async (request, credenciais) => {
      urls.push(request.url)
      tls.push(credenciais.cert)
      const fila = request.url.includes('/contribuintes/') ? adn : sefin
      return fila.length > 1 ? fila.shift()! : fila[0]
    }
    return { transport, urls, tls }
  }

  it('registra quando a Sefin passa a responder ao procurador e para em "liberado"', async () => {
    const r = roteiro([json(404, {}), json(404, {}), loteComOutorgante], [json(403, { erros: [{ codigo: 'E0001', descricao: 'x' }] }), json(403, {}), json(200, {})])
    const t = deps(['sonda', '--saida=C:/relatorios', '--intervalo=120', '--minutos=60', '--cadastrada-em=2026-11-11T14:00', '--parar-quando=liberado'], r.transport, {
      'Chave de acesso': CHAVE_SONDA,
    })
    const { path } = await runProcuracao(t.deps)
    const texto = t.written.get(path!)!
    const report = JSON.parse(texto) as SondaReport

    expect(report.rodadas.map((x) => x.estado)).toEqual(['negado', 'negado', 'liberado'])
    expect(report.encerrada_por).toBe('parar_quando')
    expect(report.transicoes.map((x) => x.para)).toEqual(['negado', 'liberado'])
    expect(report.transicoes[1].minutos_desde_cadastro).toBeCloseTo(4, 0)
    expect(report.rodadas[0].sefin?.codigos).toEqual(['E0001'])
    expect(report.rodadas[2].adn).toMatchObject({ status: 200, documentos: 1, outorgante_visivel: true })
    expect(report.leitura).toContain('liberado a partir de')
    expect(r.urls.filter((u) => u.includes('/SefinNacional/nfse/'))).toHaveLength(3)
    expect(r.tls.every((c) => c.replace(/-----[^-]+-----|\s/g, '').startsWith(corpoDoCert(procurador)))).toBe(true)
    semSegredos(texto)
  })

  it('sem chave da Sefin, usa só o ADN e acrescenta o parâmetro do CNPJ quando informado', async () => {
    const r = roteiro([json(200, { LoteDFe: [] })], [])
    const t = deps(['sonda', '--saida=C:/relatorios', '--uma-vez', '--adn-parametro=cnpjConsulta'], r.transport)
    const { path } = await runProcuracao(t.deps)
    const report = JSON.parse(t.written.get(path!)!) as SondaReport
    expect(r.urls).toEqual([`https://adn.producaorestrita.nfse.gov.br/contribuintes/DFe/0?lote=true&cnpjConsulta=${S.cnpj}`])
    expect(report).toMatchObject({ sonda_sefin: false, encerrada_por: 'uma_vez', adn_parametro: 'cnpjConsulta' })
    expect(report.rodadas[0].estado).toBe('nao_visivel')
    expect(report.leitura).toContain('nunca liberou')
  })

  it('roda a janela inteira quando nada muda, regravando o relatório a cada rodada', async () => {
    const r = roteiro([json(403, {})], [])
    const t = deps(['sonda', '--saida=C:/relatorios', '--intervalo=600', '--minutos=30'], r.transport)
    const { report } = (await runProcuracao(t.deps)) as { report: SondaReport; path: string }
    expect(report.rodadas).toHaveLength(4)
    expect(report.encerrada_por).toBe('tempo')
    expect(report.rodadas.every((x) => x.estado === 'negado')).toBe(true)
  })

  it('estado: Sefin manda quando há chave; 5xx e falha de rede não contam como negado', () => {
    const adn = { status: 200, documentos: 0, outorgante_visivel: false, codigos: [] }
    expect(estadoDaRodada({ adn, sefin: { status: 502, codigos: [] } })).toBe('sem_resposta')
    expect(estadoDaRodada({ adn: { ...adn, status: null }, sefin: null })).toBe('sem_resposta')
    expect(estadoDaRodada({ adn: { ...adn, status: 403 }, sefin: null })).toBe('negado')
    expect(parseCadastradaEm('2026-11-11T14:05')?.toISOString()).toBe('2026-11-11T17:05:00.000Z')
    expect(() => parseCadastradaEm('ontem')).toThrow('--cadastrada-em')
  })
})

describe('CLI', () => {
  it('carrega com o Node puro, mostra a ajuda e recusa produção sem autorização sem pedir nada', () => {
    const help = spawnSync(process.execPath, ['scripts/nofiscal-procuracao.mjs', '--help'], { cwd: APP_DIR, encoding: 'utf8' })
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('sonda')
    expect(help.stdout).toContain(CONFIRMACAO_PRODUCAO)
    const refused = spawnSync(process.execPath, ['scripts/nofiscal-procuracao.mjs', ...EMITIR, '--ambiente=producao'], {
      cwd: APP_DIR,
      encoding: 'utf8',
      input: '',
    })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('--autorizado-por-lucca')
    expect(refused.stdout).not.toContain('CNPJ')
  })
})
