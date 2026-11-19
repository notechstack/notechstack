// Grupo `obra` da DPS (Robson, Contabilidade Bragantina, 19/11/2026: E0370 numa nota de alvenaria). Leitura dos dados
// da obra, `serv/obra` validado nos dois XSD oficiais, a exigência nos 13 códigos de construção civil, API `/v1/nfse`,
// painel, planilha e as peças da conversa. Sem banco (a conversa com banco está em agente/obra-conversa.test.ts).
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { errosXsd, type PacoteXsd } from '../_tests/xsd.js'
import { comCidadeDaObra, juntarObra, textoDaObraQueFalta, textoDoResumo } from './agente/conversa.js'
import { validarParsed } from './agente/interprete.js'
import { interpretarGrade, motivoDoProblema, validarLinhas, type ContextoDoLote, type Empresa } from './agente/lote.js'
import { payloadDaNota } from './agente/notas.js'
import { buildDps, DpsInvalidError, type OpcoesDps } from './dps-builder.js'
import { CODIGOS_COM_OBRA, exigeObra, lerObra, problemaDaObra, rotuloDaObra, textoLatin1 } from './obra.js'
import { lerPedido } from './painel-emissao.js'
import type { SefinTenant } from './sefin.js'
import { parseNewInvoice } from './validation.js'

const NS = 'http://www.sped.fazenda.gov.br/nfse'
const PROD: PacoteXsd = 'producao-v1.01-20260209'
const PR: PacoteXsd = 'producao-restrita-20261020'
const V101: OpcoesDps = { leiaute: 'v1.01', ibscbs: false }
const NT009: OpcoesDps = { leiaute: 'nt009', ibscbs: false }
const now = new Date('2026-11-19T13:00:00Z')
const BRAGANCA = '3507605'
const CAMPINAS = '3509502'
const ENDERECO = { cep: '12900000', logradouro: 'Rua das Flores', numero: '120', bairro: 'Centro' }

const tenant = (overrides: Partial<SefinTenant> = {}): SefinTenant => ({
  id: 't-1',
  cnpj: '55706409000110',
  razao_social: 'ELISIO MEI',
  inscricao_municipal: null,
  codigo_municipio_ibge: BRAGANCA,
  regime: 'mei',
  ambiente: 'producao',
  p_tot_trib_sn: null,
  ...overrides,
})
const payload = (servico: Record<string, unknown> = {}) => ({
  tomador: { cnpj: '11222333000181', nome: 'Sakata Seed Sudamerica Ltda' },
  servico: { codigo_servico_nacional: '070201', descricao: 'Serviço de alvenaria', ...servico },
  valor: '3800.00',
})
const gerar = (opcoes: OpcoesDps, p: unknown, t: SefinTenant = tenant()) => buildDps({ tenant: t, serie: '1', numero: 9, payload: p, now, opcoes })
const texto = (xml: string, nome: string) =>
  Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(NS, nome)).map((n) => n.textContent)

describe('leitura dos dados da obra', () => {
  it('endereço com CEP mascarado, s/n e complemento; CNO com máscara; vazio = sem obra', () => {
    expect(lerObra({ ...ENDERECO, cep: '12900-000', numero: 's/n', complemento: 'Lote 3' })).toEqual({
      ok: true,
      obra: { cep: '12900000', logradouro: 'Rua das Flores', numero: 's/n', complemento: 'Lote 3', bairro: 'Centro' },
    })
    expect(lerObra({ cno: '12.345.67890/12' })).toEqual({ ok: true, obra: { cno: '123456789012' } })
    expect(lerObra(undefined)).toEqual({ ok: true, obra: null })
    expect(lerObra({ cep: '', cno: ' ' })).toEqual({ ok: true, obra: null })
  })

  it('o que falta no endereço vem nomeado; CNO errado sem endereço é erro do CNO', () => {
    expect(lerObra({ logradouro: 'Rua das Flores', cep: '12900000' })).toMatchObject({ ok: false, faltando: ['numero', 'bairro'] })
    expect(lerObra({ ...ENDERECO, cep: '1290' })).toMatchObject({ ok: false, faltando: ['cep'] })
    expect(lerObra({ cno: '123' })).toMatchObject({ ok: false, erro: expect.stringMatching(/12 dígitos/) })
    // CNO errado com endereço completo: vale o endereço.
    expect(lerObra({ cno: '123', ...ENDERECO })).toMatchObject({ ok: true, obra: ENDERECO })
    expect(lerObra('Rua das Flores')).toMatchObject({ ok: false })
  })

  it('texto fora de U+0020–U+00FF (TSString) vira o equivalente simples', () => {
    expect(textoLatin1('Rua “Nova” – Jardim São José…')).toBe('Rua "Nova" - Jardim São José...')
    expect(textoLatin1('Rua 🏗 das   Flores')).toBe('Rua das Flores')
  })

  it('rótulo para o resumo', () => {
    expect(rotuloDaObra({ ...ENDERECO, complemento: 'Lote 3' })).toBe('Rua das Flores, 120, Lote 3 - Centro, CEP 12900-000')
    expect(rotuloDaObra({ cno: '123456789012' })).toBe('CNO 12.345.67890/12')
  })

  it('os 13 códigos do E0370 exigem a obra; os outros, não', () => {
    expect(CODIGOS_COM_OBRA.size).toBe(13)
    for (const c of ['070201', '070202', '070501', '070502', '141403', '141404']) expect(exigeObra(c)).toBe(true)
    expect(exigeObra('070901')).toBe(false)
    expect(problemaDaObra({ codigo: '070201', obra: null })).toBe('OBRA_SEM_DADOS')
    expect(problemaDaObra({ codigo: '070201', obra: { cno: '123456789012' } })).toBeNull()
    expect(problemaDaObra({ codigo: '171901', obra: null })).toBeNull()
  })
})

describe('DPS (serv/obra)', () => {
  it('endereço, endereço com complemento e CNO: válidos nos dois XSD, MEI e Simples, com e sem outro local', async () => {
    const casos = [
      payload({ obra: ENDERECO }),
      payload({ obra: { ...ENDERECO, complemento: 'Lote 3, quadra B' }, municipio_prestacao_ibge: CAMPINAS }),
      payload({ obra: { cno: '123456789012' } }),
    ]
    for (const [opcoes, pacote] of [
      [V101, PROD],
      [NT009, PR],
    ] as const) {
      for (const p of casos) {
        for (const t of [tenant(), tenant({ regime: 'simples', p_tot_trib_sn: '6.00' })]) {
          const { xml } = gerar(opcoes, p, t)
          expect(xml).toMatch(/<\/cServ><obra>.*<\/obra>/)
          expect(await errosXsd(xml, pacote)).toEqual([])
        }
      }
    }
    const end = gerar(V101, payload({ obra: ENDERECO })).xml
    expect(end).toContain('<obra><end><CEP>12900000</CEP><xLgr>Rua das Flores</xLgr><nro>120</nro><xBairro>Centro</xBairro></end></obra>')
    expect(texto(gerar(V101, payload({ obra: { cno: '123456789012' } })).xml, 'cObra')).toEqual(['123456789012'])
  })

  it('código de obra sem a obra não é montado (a Sefin recusaria com E0370)', () => {
    expect(() => gerar(V101, payload())).toThrow(DpsInvalidError)
    expect(() => gerar(V101, payload())).toThrow(/construção civil/)
    expect(() => gerar(V101, payload({ obra: { logradouro: 'Rua X' } }))).toThrow(/obra endereço da obra sem CEP/)
  })

  it('fora dos códigos de obra, a DPS sai igual à de antes, byte a byte, mesmo com obra no payload', () => {
    const antes = gerar(V101, payload({ codigo_servico_nacional: '171901' })).xml
    expect(antes).not.toContain('<obra>')
    expect(gerar(V101, payload({ codigo_servico_nacional: '171901', obra: ENDERECO })).xml).toBe(antes)
  })

  it('payload do agente leva a obra só quando há', () => {
    const tomador = { documento: '11222333000181', nome: 'Sakata', email: null }
    expect(payloadDaNota(tomador, { codigo: '070201', descricao: 'A', obra: { ...ENDERECO, complemento: null } }, '1.00').servico).toEqual({
      codigo_servico_nacional: '070201',
      descricao: 'A',
      obra: ENDERECO,
    })
    expect(payloadDaNota(tomador, { codigo: '171901', descricao: 'A' }, '1.00').servico).not.toHaveProperty('obra')
  })
})

describe('API /v1/nfse (servico.obra)', () => {
  const corpo = (servico: Record<string, unknown>) => ({
    external_id: 'x-1',
    tomador: { cnpj: '11222333000181', nome: 'Cliente' },
    servico: { codigo_servico_nacional: '070201', descricao: 'Alvenaria', ...servico },
    valor: '100.00',
  })
  it('aceita endereço ou CNO; recusa incompleto e campo desconhecido', () => {
    const ok = parseNewInvoice(corpo({ obra: { ...ENDERECO, cep: '12900-000' } }))
    expect(ok.ok && ok.value.servico.obra).toEqual({ ...ENDERECO, complemento: null })
    const cno = parseNewInvoice(corpo({ obra: { cno: '12.345.67890/12' } }))
    expect(cno.ok && cno.value.servico.obra).toEqual({ cno: '123456789012' })
    expect(parseNewInvoice(corpo({ obra: { logradouro: 'Rua X' } }))).toMatchObject({ ok: false, message: expect.stringMatching(/servico\.obra endereço da obra sem CEP/) })
    expect(parseNewInvoice(corpo({ obra: { ...ENDERECO, cidade: 'Campinas' } }))).toMatchObject({ ok: false, code: 'UNKNOWN_FIELD' })
    const sem = parseNewInvoice(corpo({}))
    expect(sem.ok && 'obra' in sem.value.servico).toBe(false)
  })
})

describe('painel: nota avulsa', () => {
  const empresa = { codigo_servico_nacional: '070201', codigo_municipio_ibge: BRAGANCA }
  const corpo = (extra: Record<string, unknown> = {}) => ({
    tenant_id: '77cf376d-e237-46e8-9277-1637ab6a8967',
    documento: '11.222.333/0001-81',
    nome: 'Sakata',
    valor: '3.800,00',
    ...extra,
  })
  it('código de obra exige os campos obra_*; com eles, o pedido leva a obra', () => {
    expect(lerPedido(corpo(), empresa)).toMatchObject({ ok: false, campo: 'obra', mensagem: expect.stringMatching(/construção civil/) })
    expect(lerPedido(corpo({ obra_cep: '12900-000', obra_logradouro: 'Rua das Flores' }), empresa)).toMatchObject({ ok: false, campo: 'obra', mensagem: expect.stringMatching(/número, bairro/) })
    const r = lerPedido(corpo({ obra_cep: '12900-000', obra_logradouro: 'Rua das Flores', obra_numero: '120', obra_bairro: 'Centro', obra_complemento: '' }), empresa)
    expect(r.ok && r.pedido.obra).toEqual({ ...ENDERECO, complemento: null })
    const cno = lerPedido(corpo({ obra_cno: '12.345.67890/12' }), empresa)
    expect(cno.ok && cno.pedido.obra).toEqual({ cno: '123456789012' })
  })
  it('outro código ignora os campos da obra', () => {
    const r = lerPedido(corpo({ codigo: '17.19.01', obra_cep: 'x' }), empresa)
    expect(r.ok && r.pedido.obra).toBeNull()
  })
})

describe('planilha (colunas obra_*)', () => {
  const EMPRESA: Empresa = { id: 'e1', cnpj: '55706409000110', razao_social: 'Elisio', active: true, codigo_servico_nacional: '070201', codigo_municipio_ibge: BRAGANCA }
  const ctx: ContextoDoLote = { empresas: [EMPRESA], bloqueios: new Map([['e1', null]]), modelos: new Map(), jaEmitidas: new Set() }
  const ler = (linhas: (string | null)[][], cabecalho = ['cpf_cnpj_tomador', 'nome_tomador', 'valor', 'codigo_servico', 'obra_cep', 'obra_logradouro', 'obra_numero', 'obra_bairro', 'obra_cno']) => {
    const planilha = interpretarGrade([cabecalho, ...linhas], { prestadorObrigatorio: false })
    if (!planilha.ok) throw new Error('planilha')
    return validarLinhas(planilha.linhas, ctx)
  }
  it('endereço ou CNO na linha de obra; sem eles, a linha fica de fora com o motivo', () => {
    const itens = ler([
      ['11222333000181', 'Sakata', '3800,00', '', '12900-000', 'Rua das Flores', '120', 'Centro', ''],
      ['52998224725', 'Maria', '100,00', '', '', '', '', '', '123456789012'],
      ['52998224725', 'João', '100,00', '', '', '', '', '', ''],
      ['52998224725', 'Ana', '100,00', '', '12900-000', 'Rua X', '', '', ''],
      ['52998224725', 'Bia', '100,00', '17.19.01', '', '', '', '', ''],
    ])
    expect(itens.map((i) => i.problema)).toEqual([null, null, 'OBRA_SEM_DADOS', 'OBRA_INVALIDA', null])
    const obras = itens.map((i) => (i.payload as { servico?: { obra?: unknown } } | undefined)?.servico?.obra)
    expect(obras).toEqual([ENDERECO, { cno: '123456789012' }, undefined, undefined, undefined])
    expect(motivoDoProblema('OBRA_SEM_DADOS')).toMatch(/obra_cep/)
  })
})

describe('conversa: peças sem banco', () => {
  it('a IA lê a obra; só campos conhecidos, e nada escrito vira null', () => {
    expect(validarParsed({ intencao: 'emitir', obra: { cep: '12900-000', numero: 120, extra: 'x', bairro: '' } }).obra).toEqual({ cep: '12900-000', numero: '120' })
    expect(validarParsed({ intencao: 'emitir', obra: { cep: null } }).obra).toBeNull()
    expect(validarParsed({ intencao: 'emitir' }).obra).toBeNull()
  })

  it('juntarObra soma ao rascunho; endereço completo ou CNO novos valem sozinhos; a cidade não entra', () => {
    const parcial = juntarObra(null, { logradouro: 'Rua das Flores', cep: '12900-000', cidade: 'Campinas' })
    expect(parcial).toEqual({ rascunho: { logradouro: 'Rua das Flores', cep: '12900-000' }, obra: null })
    const completo = juntarObra(parcial.rascunho, { numero: '120', bairro: 'Centro' })
    expect(completo.obra).toEqual({ ...ENDERECO, complemento: null })
    expect(juntarObra(completo.rascunho, { cno: '123456789012' }).obra).toEqual({ cno: '123456789012' })
    expect(juntarObra(null, null)).toEqual({ rascunho: null, obra: null })
  })

  it('a cidade da obra vira o local da prestação, a não ser que o pedido diga outro', () => {
    const base = validarParsed({ intencao: 'emitir', obra: { cidade: 'Campinas/SP' } })
    expect(comCidadeDaObra(base).municipio_prestacao).toBe('Campinas/SP')
    expect(comCidadeDaObra({ ...base, municipio_prestacao: 'Jundiaí' }).municipio_prestacao).toBe('Jundiaí')
  })

  it('texto da pergunta e do que falta; resumo com a linha da obra', () => {
    expect(textoDaObraQueFalta(null, 'Bragança Paulista/SP')).toContain('CEP e a cidade, se não for Bragança Paulista/SP.')
    expect(textoDaObraQueFalta({ cep: '12900000', logradouro: 'Rua X', numero: '1' }, null)).toBe(
      'Faltou no endereço da obra: bairro. Me mande o que falta, e eu monto a nota. Ou responda *descartar*.',
    )
    const resumo = textoDoResumo({ documento: '11222333000181', nome: 'Sakata', email: null }, { codigo: '070201', descricao: 'Alvenaria', obra: { cno: '123456789012' } }, '3800.00')
    expect(resumo).toContain('Obra: CNO 12.345.67890/12\nValor: R$ 3.800,00')
  })
})
