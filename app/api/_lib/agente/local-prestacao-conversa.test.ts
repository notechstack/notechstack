// Local da prestação pelo WhatsApp (Lucca, 18/11/2026, pergunta da Omni Contabilidade): "serviço prestado em Campinas"
// no pedido vira a linha "Local da prestação: Campinas/SP" no resumo e o `cLocPrestacao` da DPS. Cidade homônima: a UF
// é perguntada. Correção e sede também. Banco local, IA, WhatsApp e Sefin de dublê; a DPS enviada é validada no XSD.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createSelfServiceTenant,
  criarModelo,
  dropSelfServiceTenant,
  ehPerguntaDeInfo,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDeTexto,
  notasDoAgente,
  openRoleDb,
  rodarWorker,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { sharedTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { fakeSefin } from '../../_tests/sefin-fake.js'
import { errosXsd } from '../../_tests/xsd.js'
import { createSefinClient } from '../sefin-client.js'
import { processarMensagem, TEXTOS, type ConversaDeps } from './conversa.js'
import type { Parsed } from './interprete.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})
afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

const PRONTIA = { nome: 'Prontia', documento: '12345678000195', nomeTomador: 'Prontia Saúde', email: 'financeiro@prontia.test', descricao: 'Consultoria em saúde' }
const PRONTIA_PARSED = { tomador: 'Prontia', modelo: 'Prontia', valor: '10.00', intencao: 'emitir' } as const

async function cenario(comCertificado = false) {
  const s = await createSelfServiceTenant(admin.db, comCertificado ? { certificado: sharedTestCertificate().certificado } : {})
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  await criarModelo(admin.db, s.tenant.id, PRONTIA)
  const { rows } = await admin.db.query<{ ibge: string }>('select codigo_municipio_ibge as ibge from nofiscal.fiscal_tenants where id = $1', [s.tenant.id])
  return { ...s, sede: rows[0].ibge }
}

type Roteiro = Record<string, Partial<Parsed> & Record<string, unknown>>
function conversa(roteiro: Roteiro) {
  const canais = canaisDouble()
  const ia = interpreteDouble(roteiro)
  const deps: ConversaDeps = { db: servico.db, whatsapp: canais.whatsapp, interprete: ia.interprete, links: LINKS_DE_TESTE }
  let lidas = 0
  return {
    canais,
    ia,
    enviar: (de: string, texto: string) => processarMensagem(deps, mensagemDeTexto(de, texto)),
    /** As respostas desde a última leitura, sem a pergunta das informações complementares. */
    novas(para: string): string[] {
      const todas = canais.whatsapps.filter((m) => m.para === para).map((m) => m.texto)
      const out = todas.slice(lidas)
      lidas = todas.length
      return out.filter((t) => !ehPerguntaDeInfo(t))
    },
  }
}

const payloads = async (tenantId: string) => (await notasDoAgente(admin.db, tenantId)).map((n) => n.payload as { servico: Record<string, unknown> })

describe('local da prestação pelo WhatsApp', () => {
  it('"serviço prestado em Campinas" (a IA não leu): resumo com o local, payload com o IBGE e DPS com o cLocPrestacao', async () => {
    const s = await cenario(true)
    const pedido = 'nota pra Prontia, 10 reais, serviço prestado em Campinas'
    const c = conversa({ [pedido]: PRONTIA_PARSED })
    await c.enviar(s.ownerPhone, pedido)
    const [resumo, ...resto] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Descrição na nota:* Consultoria em saúde\n*Local da prestação:* Campinas/SP\n\n*Valor:* R$ 10,00')
    expect(resto).toEqual([])

    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.emitindo])
    const [payload] = await payloads(s.tenant.id)
    expect(payload.servico.municipio_prestacao_ibge).toBe('3509502')

    const sefin = fakeSefin()
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: sefin.transport }), tenantId: s.tenant.id, canais: c.canais, now: () => new Date() })
    const [dps] = sefin.requests.filter((r) => r.method === 'POST' && r.path === '/nfse').map((r) => r.xml ?? '')
    expect(dps).toContain('<serv><locPrest><cLocPrestacao>3509502</cLocPrestacao></locPrest>')
    expect(dps).toContain(`<cLocEmi>${s.sede}</cLocEmi>`)
    expect(await errosXsd(dps, dps.includes('<finNFSe>') ? 'producao-restrita-20261020' : 'producao-v1.01-20260209')).toEqual([])
  })

  it('cidade homônima: pergunta a UF; com a resposta, o resumo sai com Cidade/UF', async () => {
    const s = await cenario()
    const pedido = 'nota pra Prontia, 10 reais, prestado em Bom Jesus'
    const c = conversa({ [pedido]: { ...PRONTIA_PARSED, municipio_prestacao: 'Bom Jesus' } })
    await c.enviar(s.ownerPhone, pedido)
    expect(c.novas(s.ownerPhone)).toEqual([
      'Há 5 cidades chamadas Bom Jesus (PI, RN, PB, SC, RS). Em qual estado o serviço foi prestado? Responda a UF, por exemplo: PI.',
    ])
    await c.enviar(s.ownerPhone, 'MG')
    expect(c.novas(s.ownerPhone)[0]).toMatch(/^Há 5 cidades chamadas Bom Jesus/)
    await c.enviar(s.ownerPhone, 'Santa Catarina')
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Local da prestação:* Bom Jesus/SC\n')
    // A IA leu só o pedido: a resposta da UF é do código.
    expect(c.ia.chamadas).toEqual([pedido])
    await c.enviar(s.ownerPhone, 'confirmar')
    const [payload] = await payloads(s.tenant.id)
    expect(payload.servico.municipio_prestacao_ibge).toBe('4202537')
  })

  it('corrigir com o local: o mesmo pedido, agora com a linha; cidade da sede não muda nada', async () => {
    const s = await cenario()
    const c = conversa({
      'nota pra Prontia, 10 reais': PRONTIA_PARSED,
      'foi prestado em Campinas/SP': { municipio_prestacao: 'Campinas/SP', intencao: 'outro' },
      'nota pra Prontia, 10 reais, prestado em São Paulo/SP': { ...PRONTIA_PARSED, municipio_prestacao: 'São Paulo/SP' },
    })
    await c.enviar(s.ownerPhone, 'nota pra Prontia, 10 reais')
    expect(c.novas(s.ownerPhone)[0]).not.toContain('Local da prestação')
    await c.enviar(s.ownerPhone, 'corrigir')
    c.novas(s.ownerPhone)
    await c.enviar(s.ownerPhone, 'foi prestado em Campinas/SP')
    expect(c.novas(s.ownerPhone)[0]).toContain('*Local da prestação:* Campinas/SP\n')
    await c.enviar(s.ownerPhone, 'descartar')
    c.novas(s.ownerPhone)

    // A sede (o mesmo município da empresa) não entra: a nota sai como sempre.
    await c.enviar(s.ownerPhone, 'nota pra Prontia, 10 reais, prestado em São Paulo/SP')
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Resumo da nota*')
    if (s.sede === '3550308') expect(resumo).not.toContain('Local da prestação')
  })

  it('cidade que não existe: nada é criado e a mensagem pede Cidade/UF', async () => {
    const s = await cenario()
    const pedido = 'nota pra Prontia, 10 reais, prestado em Lugar Nenhum'
    const c = conversa({ [pedido]: { ...PRONTIA_PARSED, municipio_prestacao: 'Lugar Nenhum' } })
    await c.enviar(s.ownerPhone, pedido)
    expect(c.novas(s.ownerPhone)).toEqual([
      'Não achei a cidade "Lugar Nenhum" na tabela do IBGE. Escreva a cidade com a UF, por exemplo: prestado em Campinas/SP.\n\nMande o pedido de novo.',
    ])
  })
})
