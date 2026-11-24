// Endereço do tomador em toda NFS-e (Robson, Contabilidade Bragantina, 24/11/2026: as notas saíam só com CNPJ e nome).
// Sem banco: leitura do endereço escrito, a ordem informado > Receita, o cache, a consulta com reserva, a DPS contra os
// dois XSD, a planilha com as colunas tomador_* e o CEP do emitente que a Sefin devolve sem o zero.
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { pdfTexts } from '../_tests/pdf-text.js'
import { testNfseXml } from '../_tests/sefin-fake.js'
import { errosXsd, type PacoteXsd } from '../_tests/xsd.js'
import { consultaCnpjBrasilApi, consultaCnpjFromEnv, enderecoDaCnpjWs } from './agente/consulta-cnpj.js'
import { textoDoResumo } from './agente/conversa.js'
import { completarEnderecos, interpretarGrade, motivoDoProblema, textoSemEndereco, validarLinhas, type ContextoDoLote, type Empresa } from './agente/lote.js'
import { payloadDaNota } from './agente/notas.js'
import { renderDanfse } from './danfse-renderer.js'
import type { Queryable } from './db.js'
import { buildDps, type OpcoesDps } from './dps-builder.js'
import { enderecoComCache, lerEnderecoEscrito, resolverEnderecoDoTomador, rotuloDoEndereco, VALIDADE_DO_ENDERECO_MS } from './endereco-tomador.js'
import { lerPedido } from './painel-emissao.js'
import type { EnderecoNacional } from './retencao.js'
import type { SefinTenant } from './sefin.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const PROD: PacoteXsd = 'producao-v1.01-20260209'
const PR: PacoteXsd = 'producao-restrita-20261020'
const V101: OpcoesDps = { leiaute: 'v1.01', ibscbs: false }
const NT009: OpcoesDps = { leiaute: 'nt009', ibscbs: false }
const now = new Date('2026-11-24T13:00:00Z')

const CNPJ_TOMADOR = '52170735000833'
const CPF = '52998224725'
// O endereço da Receita do exemplo (BrasilAPI): CEP com zero à esquerda.
const DA_RECEITA: EnderecoNacional = { cMun: '3550308', cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', complemento: 'ANDAR 5', bairro: 'BELA VISTA' }
const INFORMADO: EnderecoNacional = { cMun: '3507605', cep: '09220140', logradouro: 'Rua Algeria', numero: '13', complemento: null, bairro: 'Vila Camilópolis' }

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '59575945000184',
  razao_social: 'BENEDITO MEI',
  inscricao_municipal: null,
  codigo_municipio_ibge: '3547809',
  regime: 'mei',
  ambiente: 'producao',
  p_tot_trib_sn: null,
  ...overrides,
})
const servico = { codigo: '171901', descricao: 'Honorários contábeis - novembro/2026' }
const gerar = (opcoes: OpcoesDps, payload: unknown, t: SefinTenant = tenant()) => buildDps({ tenant: t, serie: '1', numero: 56, payload, now, opcoes })
const filhos = (xml: string, nome: string) =>
  Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS, nome)[0]?.childNodes ?? []).map((n) => (n as Element).localName)

describe('endereço escrito (planilha, painel, API)', () => {
  it('tudo vazio = sem endereço; completo com cidade por nome ou IBGE; número vazio = S/N', () => {
    expect(lerEnderecoEscrito(undefined)).toEqual({ ok: true, endereco: null })
    expect(lerEnderecoEscrito({ cep: '', logradouro: ' ', municipio: null })).toEqual({ ok: true, endereco: null })
    expect(lerEnderecoEscrito({ cep: '12900-000', logradouro: 'Rua das Flores', numero: '', bairro: 'Centro', municipio: 'Bragança Paulista/SP' })).toEqual({
      ok: true,
      endereco: { cMun: '3507605', cep: '12900000', logradouro: 'Rua das Flores', numero: 'S/N', complemento: null, bairro: 'Centro' },
    })
    expect(lerEnderecoEscrito({ cep: '12900000', logradouro: 'Rua X', numero: '10', complemento: 'Sala 2', bairro: 'Centro', municipio: '3507605' })).toMatchObject({
      ok: true,
      endereco: { cMun: '3507605', complemento: 'Sala 2' },
    })
  })

  it('CEP que o Excel guardou como número (sem o zero) volta a ter 8 dígitos', () => {
    const r = lerEnderecoEscrito({ cep: 9220140, logradouro: 'Rua Algeria', numero: 13, bairro: 'Vila Camilópolis', municipio: 'Santo André/SP' })
    expect(r).toEqual({ ok: true, endereco: { cMun: '3547809', cep: '09220140', logradouro: 'Rua Algeria', numero: '13', complemento: null, bairro: 'Vila Camilópolis' } })
    expect(lerEnderecoEscrito({ cep: '9220140', logradouro: 'Rua A', bairro: 'B', municipio: '3547809' })).toMatchObject({ ok: true, endereco: { cep: '09220140' } })
  })

  it('incompleto ou cidade ambígua: erro que diz o que falta', () => {
    expect(lerEnderecoEscrito({ cep: '12900000', logradouro: 'Rua X' })).toEqual({ ok: false, erro: expect.stringMatching(/bairro, cidade/) })
    expect(lerEnderecoEscrito({ cep: '123', logradouro: 'Rua X', bairro: 'Centro', municipio: '3507605' })).toEqual({ ok: false, erro: expect.stringMatching(/CEP/) })
    expect(lerEnderecoEscrito({ cep: '12900000', logradouro: 'Rua X', bairro: 'Centro', municipio: 'Bom Jesus' })).toEqual({ ok: false, erro: expect.stringMatching(/com a UF/) })
    expect(lerEnderecoEscrito({ cep: '12900000', logradouro: 'Rua X', bairro: 'Centro', municipio: 'Cidade Inventada/SP' })).toEqual({ ok: false, erro: expect.stringMatching(/cidade/) })
  })

  it('rótulo para os resumos', () => {
    expect(rotuloDoEndereco(DA_RECEITA)).toBe('AVENIDA PAULISTA, 1000, ANDAR 5 - BELA VISTA, São Paulo/SP, CEP 01310-100')
  })
})

describe('informado > Receita > nenhum', () => {
  const consulta = (achado: EnderecoNacional | null, pedidos: string[] = []) => ({
    async endereco(cnpj: string) {
      pedidos.push(cnpj)
      return achado
    },
  })

  it('CNPJ sem endereço informado: o da Receita', async () => {
    const pedidos: string[] = []
    expect(await resolverEnderecoDoTomador({ documento: CNPJ_TOMADOR, consulta: consulta(DA_RECEITA, pedidos) })).toEqual({
      endereco: DA_RECEITA,
      origem: 'receita',
      consultaFalhou: false,
    })
    expect(pedidos).toEqual([CNPJ_TOMADOR])
  })

  it('o informado prevalece e nem consulta', async () => {
    const pedidos: string[] = []
    expect(await resolverEnderecoDoTomador({ documento: CNPJ_TOMADOR, informado: INFORMADO, consulta: consulta(DA_RECEITA, pedidos) })).toMatchObject({
      endereco: INFORMADO,
      origem: 'informado',
    })
    expect(pedidos).toEqual([])
  })

  it('consulta que falha ou lança: sem endereço, marcado como falha; CPF não consulta', async () => {
    expect(await resolverEnderecoDoTomador({ documento: CNPJ_TOMADOR, consulta: consulta(null) })).toEqual({ endereco: null, origem: null, consultaFalhou: true })
    const lanca = { endereco: async () => Promise.reject(new Error('fora do ar')) }
    expect(await resolverEnderecoDoTomador({ documento: CNPJ_TOMADOR, consulta: lanca })).toMatchObject({ consultaFalhou: true })
    const pedidos: string[] = []
    expect(await resolverEnderecoDoTomador({ documento: CPF, consulta: consulta(DA_RECEITA, pedidos) })).toEqual({ endereco: null, origem: null, consultaFalhou: false })
    expect(pedidos).toEqual([])
    expect(await resolverEnderecoDoTomador({ documento: CPF, informado: INFORMADO })).toMatchObject({ endereco: INFORMADO, origem: 'informado' })
  })
})

describe('cache por CNPJ (nofiscal.fiscal_tomador_enderecos)', () => {
  function banco(linha: { endereco: unknown; consultado_em: Date } | null, opcoes: { quebrado?: boolean } = {}) {
    const gravados: unknown[][] = []
    const db: Queryable = {
      async query<R>(sql: string, valores?: unknown[]) {
        if (opcoes.quebrado) throw new Error('relation "nofiscal.fiscal_tomador_enderecos" does not exist')
        if (sql.startsWith('select')) return { rows: (linha ? [linha] : []) as R[], rowCount: linha ? 1 : 0 }
        gravados.push(valores ?? [])
        return { rows: [] as R[], rowCount: 1 }
      },
    }
    return { db, gravados }
  }
  const contar = (achado: EnderecoNacional | null) => {
    const pedidos: string[] = []
    return { pedidos, consulta: { endereco: async (cnpj: string) => (pedidos.push(cnpj), achado) } }
  }

  it('guardado há menos de 30 dias: não consulta', async () => {
    const { db } = banco({ endereco: DA_RECEITA, consultado_em: new Date(now.getTime() - 3600_000) })
    const c = contar(INFORMADO)
    expect(await enderecoComCache(c.consulta, db, () => now).endereco(CNPJ_TOMADOR)).toEqual(DA_RECEITA)
    expect(c.pedidos).toEqual([])
  })

  it('sem guardado: consulta e grava; vencido com a consulta fora do ar: usa o vencido', async () => {
    const vazio = banco(null)
    const c = contar(DA_RECEITA)
    expect(await enderecoComCache(c.consulta, vazio.db, () => now).endereco(CNPJ_TOMADOR)).toEqual(DA_RECEITA)
    expect(c.pedidos).toEqual([CNPJ_TOMADOR])
    expect(vazio.gravados).toEqual([[CNPJ_TOMADOR, JSON.stringify(DA_RECEITA), now]])

    const vencido = banco({ endereco: DA_RECEITA, consultado_em: new Date(now.getTime() - VALIDADE_DO_ENDERECO_MS - 1) })
    const fora = contar(null)
    expect(await enderecoComCache(fora.consulta, vencido.db, () => now).endereco(CNPJ_TOMADOR)).toEqual(DA_RECEITA)
    expect(fora.pedidos).toEqual([CNPJ_TOMADOR])
    expect(vencido.gravados).toEqual([])
  })

  it('banco com erro (tabela ainda não criada): consulta direto, sem travar', async () => {
    const c = contar(DA_RECEITA)
    expect(await enderecoComCache(c.consulta, banco(null, { quebrado: true }).db, () => now).endereco(CNPJ_TOMADOR)).toEqual(DA_RECEITA)
  })
})

describe('consulta: BrasilAPI, espelho e CNPJ.ws', () => {
  const BRASILAPI = { codigo_municipio_ibge: 3550308, cep: '1310100', descricao_tipo_de_logradouro: 'AVENIDA', logradouro: 'PAULISTA', numero: '1000', complemento: 'ANDAR 5', bairro: 'BELA VISTA', razao_social: 'X' }
  const CNPJ_WS = {
    razao_social: 'X',
    estabelecimento: { tipo_logradouro: 'Avenida', logradouro: 'Paulista', numero: '1000', complemento: 'ANDAR 5', bairro: 'Bela Vista', cep: '01310100', cidade: { ibge_id: 3550308 } },
  }
  function rede(respostas: Record<string, { status: number; corpo?: unknown } | 'erro'>) {
    const urls: string[] = []
    const f = (async (url: string) => {
      urls.push(url)
      const r = Object.entries(respostas).find(([prefixo]) => url.startsWith(prefixo))?.[1] ?? { status: 404 }
      if (r === 'erro') throw new TypeError('fetch failed')
      return new Response(JSON.stringify(r.corpo ?? {}), { status: r.status })
    }) as typeof fetch
    return { urls, f }
  }

  it('BrasilAPI responde: o endereço com o zero do CEP e o tipo de logradouro', async () => {
    const r = rede({ 'https://brasilapi.com.br': { status: 200, corpo: BRASILAPI } })
    expect(await consultaCnpjBrasilApi({ fetch: r.f }).endereco?.(CNPJ_TOMADOR)).toEqual(DA_RECEITA)
    expect(r.urls).toEqual([`https://brasilapi.com.br/api/cnpj/v1/${CNPJ_TOMADOR}`])
  })

  it('BrasilAPI fora do ar: o espelho; sem endereço nos dois: a CNPJ.ws', async () => {
    const espelho = rede({ 'https://brasilapi.com.br': 'erro', 'https://minhareceita.org': { status: 200, corpo: BRASILAPI } })
    expect(await consultaCnpjBrasilApi({ fetch: espelho.f }).endereco?.(CNPJ_TOMADOR)).toEqual(DA_RECEITA)
    expect(espelho.urls).toEqual([`https://brasilapi.com.br/api/cnpj/v1/${CNPJ_TOMADOR}`, `https://minhareceita.org/${CNPJ_TOMADOR}`])

    const reserva = rede({ 'https://publica.cnpj.ws': { status: 200, corpo: CNPJ_WS } })
    expect(await consultaCnpjBrasilApi({ fetch: reserva.f }).endereco?.(CNPJ_TOMADOR)).toEqual({ ...DA_RECEITA, logradouro: 'Avenida Paulista', bairro: 'Bela Vista' })
    expect(reserva.urls).toHaveLength(3)

    const nada = rede({})
    expect(await consultaCnpjBrasilApi({ fetch: nada.f }).endereco?.(CNPJ_TOMADOR)).toBeNull()
  })

  it('CNPJ.ws sem cidade ou CEP: sem endereço', () => {
    expect(enderecoDaCnpjWs({ estabelecimento: { ...CNPJ_WS.estabelecimento, cidade: {} } })).toBeNull()
    expect(enderecoDaCnpjWs(null)).toBeNull()
  })

  it('BrasilAPI local (demo, testes): espelho e reserva desligados', async () => {
    const urls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => (urls.push(String(url)), new Response('{}', { status: 404 }))) as typeof fetch
    try {
      await consultaCnpjFromEnv({ CNPJ_API_URL: 'http://127.0.0.1:4010' }).endereco?.(CNPJ_TOMADOR)
    } finally {
      globalThis.fetch = original
    }
    expect(urls).toEqual([`http://127.0.0.1:4010/api/cnpj/v1/${CNPJ_TOMADOR}`])
  })
})

describe('DPS: toma/end em toda nota com endereço', () => {
  it('CNPJ sem retenção (MEI e Simples) e CPF com endereço: end/endNac na ordem do XSD, válida nos dois leiautes', async () => {
    const casos = [
      payloadDaNota({ documento: CNPJ_TOMADOR, nome: 'Sindicato dos Professores', email: null }, servico, '1500.00', { endereco: DA_RECEITA }),
      payloadDaNota({ documento: CPF, nome: 'Maria Exemplo', email: null }, servico, '350.00', { endereco: INFORMADO }),
    ]
    for (const [opcoes, pacote] of [
      [V101, PROD],
      [NT009, PR],
    ] as const) {
      for (const p of casos) {
        for (const t of [tenant(), tenant({ regime: 'simples', p_tot_trib_sn: '6.00' })]) {
          const { xml } = gerar(opcoes, p, t)
          expect(filhos(xml, 'toma').slice(1)).toEqual(['xNome', 'end'])
          expect(filhos(xml, 'end')).toEqual(p === casos[0] ? ['endNac', 'xLgr', 'nro', 'xCpl', 'xBairro'] : ['endNac', 'xLgr', 'nro', 'xBairro'])
          expect(filhos(xml, 'endNac')).toEqual(['cMun', 'CEP'])
          expect(await errosXsd(xml, pacote)).toEqual([])
        }
      }
    }
    expect(gerar(V101, casos[1]).xml).toContain('<end><endNac><cMun>3507605</cMun><CEP>09220140</CEP></endNac><xLgr>Rua Algeria</xLgr><nro>13</nro>')
  })

  it('CPF sem endereço e CNPJ cuja consulta falhou: a nota sai sem end, como antes', async () => {
    for (const documento of [CPF, CNPJ_TOMADOR]) {
      const { xml } = gerar(V101, payloadDaNota({ documento, nome: 'Fulano', email: null }, servico, '100.00', { endereco: null }))
      expect(filhos(xml, 'toma').slice(1)).toEqual(['xNome'])
      expect(await errosXsd(xml, PROD)).toEqual([])
    }
  })
})

describe('planilha: colunas tomador_*', () => {
  const EMPRESA: Empresa = { id: 'e1', cnpj: '59575945000184', razao_social: 'Benedito', active: true, codigo_servico_nacional: '171901', regime: 'simples', retencao: { retem_iss: true, aliquota_iss: '2.00', retem_inss: false, inss_percentual: null } }
  const ctx: ContextoDoLote = { empresas: [EMPRESA], bloqueios: new Map([['e1', null]]), modelos: new Map(), jaEmitidas: new Set() }
  const CAB = ['cpf_cnpj_tomador', 'nome_tomador', 'valor', 'iss_retido', 'tomador_cep', 'tomador_logradouro', 'tomador_numero', 'tomador_complemento', 'tomador_bairro', 'tomador_municipio']
  const ler = (linhas: (string | number | null)[][]) => {
    const planilha = interpretarGrade([CAB, ...linhas], { prestadorObrigatorio: false })
    if (!planilha.ok) throw new Error(JSON.stringify(planilha))
    return validarLinhas(planilha.linhas, ctx)
  }
  const enderecoDe = (i: { payload: Record<string, unknown> }) => (i.payload.tomador as { endereco?: EnderecoNacional } | undefined)?.endereco

  it('informado prevalece; CNPJ sem colunas usa a Receita; CPF só com o informado; consulta que falha sem ISS: sai sem, com aviso', async () => {
    const itens = ler([
      [CNPJ_TOMADOR, 'Sindicato', '1500,00', 'não', '09220-140', 'Rua Algeria', '13', '', 'Vila Camilópolis', 'Bragança Paulista/SP'],
      [CNPJ_TOMADOR, 'Sindicato', '1600,00', 'não', '', '', '', '', '', ''],
      [CPF, 'Maria', '350,00', 'não', 12900000, 'Rua das Flores', '', 'Apto 12', 'Centro', '3507605'],
      [CPF, 'João', '360,00', 'não', '', '', '', '', '', ''],
      ['11222333000181', 'Sem Receita', '370,00', 'não', '', '', '', '', '', ''],
      ['11222333000181', 'Sem Receita', '380,00', '2%', '', '', '', '', '', ''],
      [CPF, 'Ana', '390,00', 'não', '12900000', 'Rua X', '', '', '', ''],
    ])
    const pedidos: string[] = []
    await completarEnderecos(itens, { endereco: async (cnpj) => (pedidos.push(cnpj), cnpj === CNPJ_TOMADOR ? DA_RECEITA : null) })
    expect(pedidos.sort()).toEqual(['11222333000181', CNPJ_TOMADOR])
    expect(itens.map((i) => i.problema)).toEqual([null, null, null, null, null, 'ENDERECO_TOMADOR', 'ENDERECO_TOMADOR_INVALIDO'])
    expect(itens.map(enderecoDe)).toEqual([
      { cMun: '3507605', cep: '09220140', logradouro: 'Rua Algeria', numero: '13', complemento: null, bairro: 'Vila Camilópolis' },
      DA_RECEITA,
      { cMun: '3507605', cep: '12900000', logradouro: 'Rua das Flores', numero: 'S/N', complemento: 'Apto 12', bairro: 'Centro' },
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(itens.map((i) => Boolean(i.semEndereco))).toEqual([false, false, false, false, true, false, false])
    expect(textoSemEndereco(itens.filter((i) => !i.problema))).toBe(
      'Sem endereço do cliente: 1 nota sai sem o endereço (linha 6), porque não achei o CNPJ na Receita agora. Para pôr o endereço, preencha as colunas tomador_* e mande de novo.',
    )
    expect(motivoDoProblema('ENDERECO_TOMADOR_INVALIDO')).toMatch(/tomador_cep/)
  })
})

describe('painel: campos tomador_* do formulário', () => {
  const empresa = { codigo_servico_nacional: '171901', codigo_municipio_ibge: '3547809' }
  const corpo = (extra: Record<string, unknown> = {}) => ({
    tenant_id: '6f1d2c3b-1a2b-4c5d-8e9f-0a1b2c3d4e5f',
    documento: '529.982.247-25',
    nome: 'Maria',
    valor: '350,00',
    ...extra,
  })
  it('vazio = sem endereço; completo entra no pedido; incompleto volta no campo endereco', () => {
    expect(lerPedido(corpo(), empresa)).toMatchObject({ ok: true, pedido: { endereco: null } })
    const r = lerPedido(corpo({ tomador_cep: '12900-000', tomador_logradouro: 'Rua das Flores', tomador_numero: '120', tomador_bairro: 'Centro', tomador_municipio: 'Bragança Paulista/SP' }), empresa)
    expect(r).toMatchObject({ ok: true, pedido: { endereco: { cMun: '3507605', cep: '12900000', numero: '120' } } })
    expect(lerPedido(corpo({ tomador_cep: '12900-000' }), empresa)).toMatchObject({ ok: false, campo: 'endereco' })
  })
})

describe('resumo do WhatsApp', () => {
  const tomador = { documento: CNPJ_TOMADOR, nome: 'Sindicato', email: null }
  it('mostra o endereço que vai na nota, ou avisa que a Receita não achou', () => {
    expect(textoDoResumo(tomador, servico, '1500.00', null, null, null, null, null, DA_RECEITA)).toContain(
      '*CNPJ:* 52.170.735/0008-33\n*Endereço:* AVENIDA PAULISTA, 1000, ANDAR 5 - BELA VISTA, São Paulo/SP, CEP 01310-100',
    )
    expect(textoDoResumo(tomador, servico, '1500.00', null, null, null, null, null, null, true)).toContain('*Endereço:* não achei o endereço deste CNPJ na Receita agora')
    expect(textoDoResumo({ ...tomador, documento: CPF }, servico, '1500.00')).not.toContain('Endereço')
  })
})

describe('DANFSe: CEP com zero à esquerda e município pelo nome', () => {
  it('o CEP de 7 dígitos que a Sefin devolve no emitente ganha o zero; o tomador sai com o endereço', async () => {
    const { xml: dps } = gerar(V101, payloadDaNota({ documento: CNPJ_TOMADOR, nome: 'Sindicato', email: null }, servico, '1500.00', { endereco: DA_RECEITA }))
    const nfse = testNfseXml({ dpsXml: dps, chave: '35478092259575945000184000000000005611250000000010', nNFSe: 56 }).replace('<CEP>01310100</CEP></enderNac>', '<CEP>9220140</CEP></enderNac>')
    expect(nfse).toContain('<CEP>9220140</CEP>')
    const texto = pdfTexts(await renderDanfse(nfse)).join('\n')
    expect(texto).toContain('09220-140')
    expect(texto).not.toMatch(/\b9220140\b/)
    expect(texto).toContain('AVENIDA PAULISTA, 1000, ANDAR 5, BELA VISTA')
    expect(texto).toContain('São Paulo/SP / 3550308 / 01310-100')
  })
})
