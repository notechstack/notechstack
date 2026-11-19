// Local da prestação por nota (Omni Contabilidade, 18/11/2026): resolução do município pela tabela do IBGE,
// `serv/locPrest/cLocPrestacao` nos dois leiautes (validado nos XSD oficiais), regras da Sefin (incidência, obra,
// evento, IBSCBS), API `/v1/nfse`, planilha, formulário do painel e leitura do pedido escrito. Sem banco.
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { errosXsd, type PacoteXsd } from '../_tests/xsd.js'
import { localDoPedido, localNoTexto, perguntaDaUf, rotuloDoLocal, textoDoResumo } from './agente/conversa.js'
import { interpretarGrade, motivoDoProblema, validarLinhas, type ContextoDoLote, type Empresa } from './agente/lote.js'
import { payloadDaNota } from './agente/notas.js'
import { buildDps, DpsInvalidError, type OpcoesDps } from './dps-builder.js'
import {
  CODIGOS_COM_EVENTO,
  CODIGOS_COM_OBRA,
  issNoLocalDaPrestacao,
  lerMunicipioPrestacao,
  problemaDoLocal,
  resolverMunicipio,
  rotuloMunicipio,
  ufDaResposta,
} from './local-prestacao.js'
import { lerPedido } from './painel-emissao.js'
import type { SefinTenant } from './sefin.js'
import { parseNewInvoice } from './validation.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const PROD: PacoteXsd = 'producao-v1.01-20260209'
const PR: PacoteXsd = 'producao-restrita-20261020'
const V101: OpcoesDps = { leiaute: 'v1.01', ibscbs: false }
const NT009: OpcoesDps = { leiaute: 'nt009', ibscbs: false }
const now = new Date('2026-11-18T13:00:00Z')
const SAO_PAULO = '3550308'
const CAMPINAS = '3509502'

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '56210013000140',
  razao_social: 'OMNI MODELO LTDA',
  inscricao_municipal: null,
  codigo_municipio_ibge: SAO_PAULO,
  regime: 'simples',
  ambiente: 'producao',
  p_tot_trib_sn: '6.00',
  ...overrides,
})

const payload = (servico: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  tomador: { cnpj: '11222333000181', nome: 'Cliente Tomador SA' },
  servico: { codigo_servico_nacional: '171901', descricao: 'Honorários contábeis de outubro/2026', ...servico },
  valor: '1500.00',
  ...extra,
})
const gerar = (opcoes: OpcoesDps, p: unknown = payload(), t: SefinTenant = tenant()) =>
  buildDps({ tenant: t, serie: '1', numero: 9, payload: p, now, opcoes })
const texto = (xml: string, nome: string) =>
  Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS, nome)).map((n) => n.textContent)

describe('município pela tabela do IBGE', () => {
  it('aceita código, Cidade/UF em vários formatos e nome único sem UF', () => {
    for (const entrada of ['3509502', 'Campinas/SP', 'campinas - sp', 'CAMPINAS, SP', 'Campinas (SP)', 'Campinas SP', 'Campinas', 'campínas']) {
      const r = resolverMunicipio(entrada)
      expect(r.ok && r.municipio, entrada).toEqual({ ibge: CAMPINAS, nome: 'Campinas', uf: 'SP' })
    }
    const sp = resolverMunicipio('São Paulo/SP')
    expect(sp.ok && sp.municipio.ibge).toBe(SAO_PAULO)
    const apostrofo = resolverMunicipio("santa barbara d'oeste")
    expect(apostrofo.ok && apostrofo.municipio.ibge).toBe('3545803')
  })

  it('nome de cidades homônimas sem UF volta ambíguo, com as UFs; com a UF, resolve', () => {
    const r = resolverMunicipio('Bom Jesus')
    expect(r.ok).toBe(false)
    if (r.ok || r.motivo !== 'ambiguo') throw new Error('esperava ambíguo')
    expect(r.opcoes.map((m) => m.uf).sort()).toEqual(['PB', 'PI', 'RN', 'RS', 'SC'])
    const pi = resolverMunicipio('Bom Jesus/PI')
    expect(pi.ok && pi.municipio).toMatchObject({ uf: 'PI', nome: 'Bom Jesus' })
  })

  it('cidade inexistente, UF errada e código fora da tabela', () => {
    expect(resolverMunicipio('Cidade Que Não Existe')).toMatchObject({ ok: false, motivo: 'nao_encontrado' })
    expect(resolverMunicipio('Campinas/RJ')).toMatchObject({ ok: false, motivo: 'uf_errada' })
    expect(resolverMunicipio('9999999')).toMatchObject({ ok: false, motivo: 'nao_encontrado' })
  })

  it('código do payload: 7 dígitos e na tabela; o mesmo da sede vira null', () => {
    expect(lerMunicipioPrestacao(undefined)).toEqual({ ok: true, ibge: null })
    expect(lerMunicipioPrestacao(CAMPINAS)).toEqual({ ok: true, ibge: CAMPINAS })
    expect(lerMunicipioPrestacao(SAO_PAULO, SAO_PAULO)).toEqual({ ok: true, ibge: null })
    expect(lerMunicipioPrestacao('350950')).toMatchObject({ ok: false })
    expect(lerMunicipioPrestacao('0000000')).toMatchObject({ ok: false })
    expect(rotuloMunicipio(CAMPINAS)).toBe('Campinas/SP')
  })

  it('a resposta da UF aceita a sigla e o nome do estado', () => {
    expect(ufDaResposta('pi')).toBe('PI')
    expect(ufDaResposta('Piauí')).toBe('PI')
    expect(ufDaResposta('no Rio Grande do Sul')).toBe('RS')
    expect(ufDaResposta('xx')).toBeNull()
    expect(ufDaResposta('confirmar')).toBeNull()
  })
})

describe('DPS (cLocPrestacao)', () => {
  it('sem o campo, a DPS sai igual à de antes, byte a byte, com o município da empresa', () => {
    const antes = gerar(V101).xml
    expect(texto(antes, 'cLocPrestacao')).toEqual([SAO_PAULO])
    expect(gerar(V101, payload({ municipio_prestacao_ibge: null })).xml).toBe(antes)
    expect(gerar(V101, payload({ municipio_prestacao_ibge: SAO_PAULO })).xml).toBe(antes)
  })

  it('com o campo, cLocPrestacao leva o IBGE informado; cLocEmi e o Id continuam da empresa; válida nos dois XSD', async () => {
    for (const [opcoes, pacote] of [
      [V101, PROD],
      [NT009, PR],
    ] as const) {
      const { xml, id } = gerar(opcoes, payload({ municipio_prestacao_ibge: CAMPINAS }))
      expect(texto(xml, 'cLocPrestacao')).toEqual([CAMPINAS])
      expect(texto(xml, 'cLocEmi')).toEqual([SAO_PAULO])
      expect(id.slice(3, 10)).toBe(SAO_PAULO)
      expect(await errosXsd(xml, pacote)).toEqual([])
    }
  })

  it('código de incidência no local (17.10, 07.02 sem obra é barrado no canal) e MEI: XML válido nos dois XSD', async () => {
    const mei = tenant({ regime: 'mei' })
    const xml = gerar(V101, payload({ codigo_servico_nacional: '171001', municipio_prestacao_ibge: CAMPINAS }), mei).xml
    expect(texto(xml, 'cLocPrestacao')).toEqual([CAMPINAS])
    expect(await errosXsd(xml, PROD)).toEqual([])
    const nt = gerar(NT009, payload({ codigo_servico_nacional: '171001', municipio_prestacao_ibge: CAMPINAS }), mei).xml
    expect(await errosXsd(nt, PR)).toEqual([])
  })

  it('com ISS retido e outro local, a DPS sai com pAliq e o endereço do tomador, válida', async () => {
    const p = payload(
      { codigo_servico_nacional: '070901', municipio_prestacao_ibge: CAMPINAS },
      { retencao: { iss: { aliquota: '2.00' }, inss: null } },
    )
    ;(p.tomador as Record<string, unknown>).endereco = { cMun: CAMPINAS, cep: '13010000', logradouro: 'Rua Um', numero: '10', bairro: 'Centro' }
    const xml = gerar(V101, p).xml
    expect(texto(xml, 'cLocPrestacao')).toEqual([CAMPINAS])
    expect(texto(xml, 'pAliq')).toEqual(['2.00'])
    expect(await errosXsd(xml, PROD)).toEqual([])
  })

  it('IBSCBS ligado: com outro local e cIndOp da tabela, o grupo fica de fora; com cIndOp na nota, vai', async () => {
    const ligado: OpcoesDps = { leiaute: 'nt009', ibscbs: true }
    const base = { codigo_servico_nacional: '100401', descricao: 'Agenciamento de contratos' }
    expect(gerar(ligado, payload(base)).xml).toMatch(/<IBSCBS>/)
    const semGrupo = gerar(ligado, payload({ ...base, municipio_prestacao_ibge: CAMPINAS })).xml
    expect(semGrupo).not.toMatch(/IBSCBS/)
    expect(await errosXsd(semGrupo, PR)).toEqual([])
    const comGrupo = gerar(ligado, payload({ ...base, municipio_prestacao_ibge: CAMPINAS, c_ind_op: '100301' })).xml
    expect(comGrupo).toMatch(/<IBSCBS>/)
    expect(await errosXsd(comGrupo, PR)).toEqual([])
  })

  it('código fora da tabela ou malformado no payload é recusado antes da Sefin', () => {
    expect(() => gerar(V101, payload({ municipio_prestacao_ibge: '9999999' }))).toThrow(DpsInvalidError)
    expect(() => gerar(V101, payload({ municipio_prestacao_ibge: 3509502 }))).toThrow(/7 dígitos/)
  })
})

describe('regras da Sefin para outro local (Anexo I v1.01)', () => {
  it('incidência no local da prestação (E1317): 57 subitens, entre eles obras, eventos e 17.10', () => {
    expect(issNoLocalDaPrestacao('070201')).toBe(true)
    expect(issNoLocalDaPrestacao('171001')).toBe(true)
    expect(issNoLocalDaPrestacao('171901')).toBe(false)
    expect(issNoLocalDaPrestacao('010101')).toBe(false)
  })

  it('evento (E0390) obrigatório: barrado com o local informado; a obra (E0370) tem regra própria (obra.test.ts)', () => {
    expect(CODIGOS_COM_OBRA.size).toBe(13)
    expect(CODIGOS_COM_EVENTO.size).toBe(19)
    expect(problemaDoLocal({ codigo: '120101', municipioPrestacao: CAMPINAS })).toBe('LOCAL_EXIGE_EVENTO')
    // Obra em outra cidade agora sai, com os dados da obra (obra.ts).
    expect(problemaDoLocal({ codigo: '070201', municipioPrestacao: CAMPINAS })).toBeNull()
    expect(problemaDoLocal({ codigo: '070901', municipioPrestacao: CAMPINAS })).toBeNull()
    expect(problemaDoLocal({ codigo: '120101', municipioPrestacao: null })).toBeNull()
    expect(motivoDoProblema('LOCAL_EXIGE_EVENTO')).toMatch(/dados do evento/)
  })
})

describe('API /v1/nfse (servico.municipio_prestacao_ibge)', () => {
  const corpo = (servico: Record<string, unknown>) => ({
    external_id: 'x-1',
    tomador: { cnpj: '11222333000181', nome: 'Cliente' },
    servico: { codigo_servico_nacional: '171901', descricao: 'Honorários', ...servico },
    valor: '100.00',
  })
  it('aceita 7 dígitos da tabela e grava no payload; ausente, o payload fica como antes', () => {
    const ok = parseNewInvoice(corpo({ municipio_prestacao_ibge: CAMPINAS }))
    expect(ok.ok && ok.value.servico.municipio_prestacao_ibge).toBe(CAMPINAS)
    const sem = parseNewInvoice(corpo({}))
    expect(sem.ok && 'municipio_prestacao_ibge' in sem.value.servico).toBe(false)
  })
  it('recusa formato, código fora da tabela e número', () => {
    expect(parseNewInvoice(corpo({ municipio_prestacao_ibge: '35095' }))).toMatchObject({ ok: false, message: expect.stringMatching(/7 dígitos/) })
    expect(parseNewInvoice(corpo({ municipio_prestacao_ibge: '9999999' }))).toMatchObject({ ok: false, message: expect.stringMatching(/tabela/) })
    expect(parseNewInvoice(corpo({ municipio_prestacao_ibge: 3509502 }))).toMatchObject({ ok: false })
  })
})

describe('planilha (coluna municipio_prestacao ou ibge_prestacao)', () => {
  const EMPRESA: Empresa = { id: 'e1', cnpj: '12345678000195', razao_social: 'Omni', active: true, codigo_servico_nacional: '171901', codigo_municipio_ibge: SAO_PAULO }
  const ctx: ContextoDoLote = { empresas: [EMPRESA], bloqueios: new Map([['e1', null]]), modelos: new Map(), jaEmitidas: new Set() }
  const ler = (titulo: string, locais: (string | number | null)[], codigo = '') => {
    const grade = [
      ['cpf_cnpj_tomador', 'nome_tomador', 'valor', 'codigo_servico', titulo],
      ...locais.map((l, i) => ['52998224725', `Cliente ${i}`, `${100 + i},00`, codigo, l]),
    ]
    const planilha = interpretarGrade(grade, { prestadorObrigatorio: false })
    if (!planilha.ok) throw new Error('planilha')
    return validarLinhas(planilha.linhas, ctx)
  }

  it('nome com UF, código IBGE (texto ou número) e vazio', () => {
    const itens = ler('municipio_prestacao', ['Campinas/SP', '3509502', 3509502, null, 'São Paulo/SP'])
    expect(itens.map((i) => i.problema)).toEqual([null, null, null, null, null])
    const locais = itens.map((i) => (i.payload as { servico: { municipio_prestacao_ibge?: string } }).servico.municipio_prestacao_ibge)
    expect(locais).toEqual([CAMPINAS, CAMPINAS, CAMPINAS, undefined, undefined])
  })

  it('o cabeçalho ibge_prestacao também vale', () => {
    const [item] = ler('ibge_prestacao', ['3509502'])
    expect((item.payload as { servico: { municipio_prestacao_ibge?: string } }).servico.municipio_prestacao_ibge).toBe(CAMPINAS)
  })

  it('cidade que não existe, homônima sem UF e código com obra viram problema da linha', () => {
    expect(ler('municipio_prestacao', ['Cidade Nenhuma', 'Bom Jesus']).map((i) => i.problema)).toEqual([
      'MUNICIPIO_PRESTACAO_INVALIDO',
      'MUNICIPIO_PRESTACAO_AMBIGUO',
    ])
    expect(ler('municipio_prestacao', ['Campinas/SP'], '07.02.01')[0].problema).toBe('OBRA_SEM_DADOS')
    expect(motivoDoProblema('MUNICIPIO_PRESTACAO_AMBIGUO')).toMatch(/UF/)
  })
})

describe('painel: formulário da nota avulsa', () => {
  const empresa = { codigo_servico_nacional: '171901', codigo_municipio_ibge: SAO_PAULO }
  const corpo = (municipio_prestacao: string, codigo = '') => ({
    tenant_id: '77cf376d-e237-46e8-9277-1637ab6a8967',
    documento: '529.982.247-25',
    nome: 'Maria',
    valor: '350,00',
    codigo,
    municipio_prestacao,
  })
  it('Cidade/UF da lista vira o IBGE; vazio ou a sede, null', () => {
    const r = lerPedido(corpo('Campinas/SP'), empresa)
    expect(r.ok && r.pedido.municipio_prestacao_ibge).toBe(CAMPINAS)
    const vazio = lerPedido(corpo(''), empresa)
    expect(vazio.ok && vazio.pedido.municipio_prestacao_ibge).toBeNull()
    const sede = lerPedido(corpo('São Paulo/SP'), empresa)
    expect(sede.ok && sede.pedido.municipio_prestacao_ibge).toBeNull()
  })
  it('homônima, cidade inexistente e código com evento mostram o erro no campo', () => {
    expect(lerPedido(corpo('Bom Jesus'), empresa)).toMatchObject({ ok: false, campo: 'municipio_prestacao', mensagem: expect.stringMatching(/UF/) })
    expect(lerPedido(corpo('Lugar Nenhum'), empresa)).toMatchObject({ ok: false, campo: 'municipio_prestacao' })
    expect(lerPedido(corpo('Campinas/SP', '12.01.01'), empresa)).toMatchObject({ ok: false, campo: 'municipio_prestacao', mensagem: expect.stringMatching(/evento/) })
  })
})

describe('pedido escrito no WhatsApp', () => {
  it('acha o local na frase do pedido', () => {
    expect(localNoTexto('nota pra Studio Lima, 350, serviço prestado em Campinas')).toBe('campinas')
    expect(localNoTexto('nota pra Studio Lima, serviço prestado em Campinas/SP, 350 reais')).toBe('campinas/sp')
    expect(localNoTexto('emite nota pra Maria de 500 reais prestado em São José dos Campos')).toBe('sao jose dos campos')
    expect(localNoTexto('nota pra Maria, realizado em Bom Jesus, PI, valor 200')).toBe('bom jesus/pi')
    expect(localNoTexto('nota pra Studio Lima, 350, local da prestação: Jundiaí')).toBe('jundiai')
    expect(localNoTexto('nota pra Studio Lima, 350, consultoria de outubro')).toBeNull()
  })

  it('código, pergunta da UF ou recusa', () => {
    expect(localDoPedido('campinas/sp')).toEqual({ ibge: CAMPINAS })
    expect(localDoPedido(null)).toBeNull()
    const homonima = localDoPedido('Bom Jesus')
    expect(homonima && 'ambiguo' in homonima && homonima.ambiguo.ufs).toHaveLength(5)
    if (homonima && 'ambiguo' in homonima) expect(perguntaDaUf(homonima.ambiguo)).toMatch(/^Há 5 cidades chamadas Bom Jesus \(.+\)\. Em qual estado/)
    expect(localDoPedido('Lugar Nenhum')).toMatchObject({ texto: expect.stringMatching(/Campinas\/SP/) })
  })

  it('o resumo mostra o local; com código tributado no local, avisa onde o ISS é devido', () => {
    const resumo = textoDoResumo(
      { documento: '52998224725', nome: 'Maria', email: null },
      { codigo: '171901', descricao: 'Honorários' },
      '350.00',
      null,
      null,
      null,
      null,
      rotuloDoLocal(CAMPINAS, '171901'),
    )
    expect(resumo).toContain('Local da prestação: Campinas/SP\n')
    expect(rotuloDoLocal(CAMPINAS, '070901')).toBe('Campinas/SP (o ISS deste serviço é devido nessa cidade)')
    expect(textoDoResumo({ documento: '52998224725', nome: 'Maria', email: null }, { codigo: '171901', descricao: 'H' }, '1.00')).not.toContain('Local da prestação')
  })

  it('payload da nota: o local vai em servico só quando há', () => {
    const tomador = { documento: '52998224725', nome: 'Maria', email: null }
    expect(payloadDaNota(tomador, { codigo: '171901', descricao: 'H', municipio_prestacao_ibge: CAMPINAS }, '1.00').servico).toEqual({
      codigo_servico_nacional: '171901',
      descricao: 'H',
      municipio_prestacao_ibge: CAMPINAS,
    })
    expect(payloadDaNota(tomador, { codigo: '171901', descricao: 'H', municipio_prestacao_ibge: null }, '1.00').servico).toEqual({
      codigo_servico_nacional: '171901',
      descricao: 'H',
    })
  })
})
