// Informações complementares pelo WhatsApp (Lucca, 17/11/2026, pedido da Contabilidade Bragantina). Depois do primeiro
// resumo, duas mensagens perguntam; *confirmar* emite sem o campo, texto livre vira o campo e o resumo volta com ele.
// O que vem no próprio pedido ("Dados bancários: …") já entra no campo, por código. Banco local, IA, WhatsApp e Sefin
// de dublê; a DPS que chega à Sefin é validada no XSD oficial.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createSelfServiceTenant,
  criarModelo,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDeTexto,
  notasDoAgente,
  openRoleDb,
  pedidosDo,
  rodarWorker,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { sharedTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { fakeSefin } from '../../_tests/sefin-fake.js'
import { errosXsd } from '../../_tests/xsd.js'
import { createSefinClient } from '../sefin-client.js'
import { pareceNovoPedido, processarMensagem, TEXTOS, textoDeInfoLonga, type ConversaDeps } from './conversa.js'
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

async function cenario(comCertificado = false) {
  const s = await createSelfServiceTenant(admin.db, comCertificado ? { certificado: sharedTestCertificate().certificado } : {})
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  await criarModelo(admin.db, s.tenant.id, PRONTIA)
  return s
}

const PRONTIA = { nome: 'Prontia', documento: '12345678000195', nomeTomador: 'Prontia Saúde', email: 'financeiro@prontia.test', descricao: 'Consultoria em saúde' }
const PEDIDO = 'nota pra Prontia, 10 reais'
const BANCO = 'Dados bancários: Caixa Economica Federal - Agencia: 0001 - Conta Corrente: 00012345-6'

type Roteiro = Record<string, Partial<Parsed> & Record<string, unknown>>
function conversa(roteiro: Roteiro) {
  const canais = canaisDouble()
  const ia = interpreteDouble({ [PEDIDO]: { tomador: 'Prontia', modelo: 'Prontia', valor: '10.00', intencao: 'emitir' }, ...roteiro })
  const deps: ConversaDeps = { db: servico.db, whatsapp: canais.whatsapp, interprete: ia.interprete, links: LINKS_DE_TESTE }
  let lidas = 0
  return {
    canais,
    ia,
    enviar: (de: string, texto: string) => processarMensagem(deps, mensagemDeTexto(de, texto)),
    /** As respostas desde a última leitura. */
    novas(para: string): string[] {
      const todas = canais.whatsapps.filter((m) => m.para === para).map((m) => m.texto)
      const out = todas.slice(lidas)
      lidas = todas.length
      return out
    },
  }
}

const payloadDa = async (tenantId: string) => (await notasDoAgente(admin.db, tenantId)).map((n) => n.payload)

describe('informações complementares pelo WhatsApp', () => {
  it('o resumo vem seguido das duas mensagens; o texto vira o campo, o resumo volta com ele, e a DPS leva o xInfComp', async () => {
    const s = await cenario(true)
    const c = conversa({})
    await c.enviar(s.ownerPhone, PEDIDO)
    const [resumo, pergunta, senao, ...resto] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Resumo da nota*')
    expect(resumo).not.toContain('Informações complementares')
    expect(pergunta).toBe(
      '*Informações complementares*\n\nQuer adicionar informações complementares (dados bancários, observações)?\n\nSe sim, descreva aqui abaixo numa mensagem de até 2.000 caracteres.',
    )
    expect(senao).toBe('Se não, envie *CONFIRMAR*.')
    expect(resto).toEqual([])

    await c.enviar(s.ownerPhone, `${BANCO}\nFavorecido: Contabilidade Modelo`)
    const [deNovo, ...semPergunta] = c.novas(s.ownerPhone)
    expect(deNovo).toContain(`*Valor:* R$ 10,00\n\n*Informações complementares:* ${BANCO} - Favorecido: Contabilidade Modelo\n\nPosso emitir?`)
    // Não pergunta de novo, e a IA não foi chamada para ler a informação.
    expect(semPergunta).toEqual([])
    expect(c.ia.chamadas).toEqual([PEDIDO])

    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.emitindo])
    expect(await payloadDa(s.tenant.id)).toEqual([expect.objectContaining({ informacoes_complementares: `${BANCO} - Favorecido: Contabilidade Modelo` })])

    const sefin = fakeSefin()
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: sefin.transport }), tenantId: s.tenant.id, canais: c.canais, now: () => new Date() })
    const [dps] = sefin.requests.filter((r) => r.method === 'POST' && r.path === '/nfse').map((r) => r.xml ?? '')
    expect(dps).toContain(`<infoCompl><xInfComp>${BANCO} - Favorecido: Contabilidade Modelo</xInfComp></infoCompl></serv>`)
    expect(await errosXsd(dps, dps.includes('<finNFSe>') ? 'producao-restrita-20261020' : 'producao-v1.01-20260209')).toEqual([])
  })

  it('*confirmar* logo depois da pergunta emite como antes, sem o campo', async () => {
    const s = await cenario()
    const c = conversa({})
    await c.enviar(s.ownerPhone, PEDIDO)
    c.novas(s.ownerPhone)
    await c.enviar(s.ownerPhone, 'CONFIRMAR')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.emitindo])
    const [payload] = await payloadDa(s.tenant.id)
    expect(payload).not.toHaveProperty('informacoes_complementares')
  })

  it('caso real de 17/11/2026: os dados bancários do pedido vão para o campo, não para a descrição, e não há pergunta', async () => {
    const s = await cenario()
    const pedido = 'nota pra Prontia, 1.500,00, honorários contábeis realizados no mês 09/2026'
    // A IA só recebe o pedido sem os dados bancários.
    const c = conversa({ [pedido]: { tomador: 'Prontia', modelo: 'Prontia', valor: '1500.00', descricao: 'Honorários contábeis realizados no mês 09/2026', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, `${pedido} - ${BANCO}`)
    expect(c.ia.chamadas).toEqual([pedido])
    const respostas = c.novas(s.ownerPhone)
    expect(respostas).toHaveLength(1)
    expect(respostas[0]).toContain(`*Descrição na nota:* Honorários contábeis realizados no mês 09/2026\n\n*Valor:* R$ 1.500,00\n\n*Informações complementares:* ${BANCO}\n`)
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await payloadDa(s.tenant.id)).toEqual([
      expect.objectContaining({ servico: expect.objectContaining({ descricao: 'Honorários contábeis realizados no mês 09/2026' }), informacoes_complementares: BANCO }),
    ])
  })

  it('o que a IA ler como informação complementar (sem marcador) também entra', async () => {
    const s = await cenario()
    const pedido = 'nota pra Prontia, 10 reais, e coloca nas observações que foi pago via pix'
    const c = conversa({ [pedido]: { tomador: 'Prontia', modelo: 'Prontia', valor: '10.00', informacoes_complementares: 'Pago via PIX', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, pedido)
    const respostas = c.novas(s.ownerPhone)
    expect(respostas).toHaveLength(1)
    expect(respostas[0]).toContain('*Informações complementares:* Pago via PIX\n')
  })

  it('"sim" pede o texto; "não" fecha a pergunta; acima de 2.000, pede para encurtar', async () => {
    const s = await cenario()
    const c = conversa({})
    await c.enviar(s.ownerPhone, PEDIDO)
    c.novas(s.ownerPhone)
    await c.enviar(s.ownerPhone, 'sim')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.infoComplementarPedida])
    await c.enviar(s.ownerPhone, 'x'.repeat(2001))
    expect(c.novas(s.ownerPhone)).toEqual([textoDeInfoLonga(2001)])
    expect(textoDeInfoLonga(2001)).toBe('As informações complementares ficaram com 2.001 caracteres, e o limite da nota é 2.000. Me mande um texto mais curto.')
    await c.enviar(s.ownerPhone, 'não')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.infoComplementarDispensada])
    // Fechada a pergunta, texto livre não vira o campo: vai para a IA, como antes.
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.emitindo])
    expect((await payloadDa(s.tenant.id))[0]).not.toHaveProperty('informacoes_complementares')
  })

  it('*corrigir* funciona com a pergunta aberta, e a correção pode trazer a informação complementar', async () => {
    const s = await cenario()
    const c = conversa({ 'valor 20': { valor: '20.00', intencao: 'outro' }, 'Informações complementares: contrato 77': { intencao: 'outro' } })
    await c.enviar(s.ownerPhone, PEDIDO)
    c.novas(s.ownerPhone)
    await c.enviar(s.ownerPhone, 'corrigir')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.oQueMuda])
    await c.enviar(s.ownerPhone, 'valor 20')
    const [resumo, ...resto] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Valor:* R$ 20,00')
    // A pergunta já foi feita neste pedido: não volta.
    expect(resto).toEqual([])
    await c.enviar(s.ownerPhone, 'corrigir')
    c.novas(s.ownerPhone)
    await c.enviar(s.ownerPhone, 'Informações complementares: contrato 77')
    expect(c.novas(s.ownerPhone)[0]).toContain('*Valor:* R$ 20,00\n\n*Informações complementares:* contrato 77\n')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await payloadDa(s.tenant.id)).toEqual([expect.objectContaining({ valor: '20.00', informacoes_complementares: 'contrato 77' })])
  })

  it('com a pergunta aberta, um pedido novo de nota é pedido novo; *descartar* desiste', async () => {
    expect(pareceNovoPedido('nota pra Maria, 300')).toBe(true)
    expect(pareceNovoPedido('Emite uma nota pra Maria')).toBe(true)
    expect(pareceNovoPedido('Dados bancários: Caixa')).toBe(false)
    expect(pareceNovoPedido('Notação contábil')).toBe(false)

    const s = await cenario()
    const c = conversa({ 'nota pra Prontia, 30 reais': { tomador: 'Prontia', modelo: 'Prontia', valor: '30.00', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, PEDIDO)
    c.novas(s.ownerPhone)
    await c.enviar(s.ownerPhone, 'nota pra Prontia, 30 reais')
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Valor:* R$ 30,00')
    expect(resumo).not.toContain('Informações complementares')
    await c.enviar(s.ownerPhone, 'descartar')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.descartado])
    expect((await pedidosDo(admin.db, s.tenant.id)).map((p) => p.status).sort()).toEqual(['awaiting_confirmation', 'rejected_by_user'])
  })
})
