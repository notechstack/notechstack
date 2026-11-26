// Obra pelo WhatsApp (Robson, Contabilidade Bragantina, 19/11/2026): nota de alvenaria (07.02.01) recusada pela Sefin
// com E0370, porque a nó não mandava o grupo `obra`. Agora o agente pede o endereço (ou o CNO) antes do resumo, a
// próxima mensagem completa o pedido sem *corrigir*, e a DPS sai com `serv/obra`, validada no XSD. Banco local, IA,
// WhatsApp e Sefin de dublê.
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
import { errosXsd, pacoteDaDps } from '../../_tests/xsd.js'
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

const SAKATA = { nome: 'Sakata', documento: '12345678000195', nomeTomador: 'Sakata Seed Sudamerica Ltda', email: 'fiscal@sakata.test', descricao: 'Serviço de alvenaria', codigo: '070201' }
const SAKATA_PARSED = { tomador: 'Sakata', modelo: 'Sakata', valor: '3800.00', intencao: 'emitir' } as const
const ENDERECO = { logradouro: 'Rua das Flores', numero: '120', bairro: 'Centro', cep: '12900-000' }

async function cenario(comCertificado = false) {
  const s = await createSelfServiceTenant(admin.db, comCertificado ? { certificado: sharedTestCertificate().certificado } : {})
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  await criarModelo(admin.db, s.tenant.id, SAKATA)
  return s
}

type Roteiro = Record<string, Partial<Parsed> & Record<string, unknown>>
function conversa(roteiro: Roteiro) {
  const canais = canaisDouble()
  const ia = interpreteDouble(roteiro)
  const deps: ConversaDeps = { db: servico.db, whatsapp: canais.whatsapp, interprete: ia.interprete, links: LINKS_DE_TESTE }
  let lidas = 0
  return {
    canais,
    enviar: (de: string, texto: string) => processarMensagem(deps, mensagemDeTexto(de, texto)),
    novas(para: string): string[] {
      const todas = canais.whatsapps.filter((m) => m.para === para).map((m) => m.texto)
      const out = todas.slice(lidas)
      lidas = todas.length
      return out.filter((t) => !ehPerguntaDeInfo(t))
    },
  }
}

const payloads = async (tenantId: string) => (await notasDoAgente(admin.db, tenantId)).map((n) => n.payload as { servico: Record<string, unknown> })

describe('obra pelo WhatsApp (E0370)', () => {
  it('sem os dados da obra, o agente pede o endereço; a resposta completa o pedido e a DPS sai com serv/obra', async () => {
    const s = await cenario(true)
    const resposta = 'Rua das Flores, 120, Centro, CEP 12900-000, Campinas/SP'
    const c = conversa({
      'nota pra Sakata, 3800': SAKATA_PARSED,
      [resposta]: { obra: { ...ENDERECO, cidade: 'Campinas/SP' }, intencao: 'outro' },
    })
    await c.enviar(s.ownerPhone, 'nota pra Sakata, 3800')
    const [pergunta] = c.novas(s.ownerPhone)
    expect(pergunta).toMatch(/^\*Dados da obra\*\n\nEste serviço é de construção civil, e a Sefin exige os dados da obra na nota\. Nada foi emitido ainda\./)
    expect(pergunta).toContain('Me mande o endereço da obra: rua, número, bairro, CEP e a cidade')

    // "confirmar" antes dos dados da obra não emite.
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
    expect(c.novas(s.ownerPhone)[0]).toMatch(/^\*Dados da obra\*\n\nEste serviço é de construção civil/)


    // O endereço, sem *corrigir*: o resumo sai com a obra e o local (o ISS da obra é devido lá).
    await c.enviar(s.ownerPhone, resposta)
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Local da prestação:* Campinas/SP (o ISS deste serviço é devido nessa cidade)\n*Obra:* Rua das Flores, 120 - Centro, CEP 12900-000\n\n*Valor:* R$ 3.800,00')

    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.emitindo])
    const [payload] = await payloads(s.tenant.id)
    expect(payload.servico.obra).toEqual({ cep: '12900000', logradouro: 'Rua das Flores', numero: '120', bairro: 'Centro' })
    expect(payload.servico.municipio_prestacao_ibge).toBe('3509502')

    const sefin = fakeSefin()
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: sefin.transport }), tenantId: s.tenant.id, canais: c.canais, now: () => new Date() })
    const [dps] = sefin.requests.filter((r) => r.method === 'POST' && r.path === '/nfse').map((r) => r.xml ?? '')
    expect(dps).toContain('<obra><end><CEP>12900000</CEP><xLgr>Rua das Flores</xLgr><nro>120</nro><xBairro>Centro</xBairro></end></obra>')
    expect(dps).toContain('<cLocPrestacao>3509502</cLocPrestacao>')
    expect(await errosXsd(dps, pacoteDaDps(dps))).toEqual([])
  })

  it('endereço no próprio pedido: o resumo sai direto; endereço incompleto pede só o que falta', async () => {
    const s = await cenario()
    const completo = 'nota pra Sakata, 3800, obra na Rua das Flores, 120, Centro, CEP 12900-000'
    const parcial = 'nota pra Sakata, 3800, obra na Rua das Flores, CEP 12900-000'
    const c = conversa({
      [completo]: { ...SAKATA_PARSED, obra: ENDERECO },
      [parcial]: { ...SAKATA_PARSED, obra: { logradouro: 'Rua das Flores', cep: '12900-000' } },
      'número 120, bairro Centro': { obra: { numero: '120', bairro: 'Centro' }, intencao: 'outro' },
    })
    await c.enviar(s.ownerPhone, completo)
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Obra:* Rua das Flores, 120 - Centro, CEP 12900-000\n')
    await c.enviar(s.ownerPhone, 'descartar')
    c.novas(s.ownerPhone)

    await c.enviar(s.ownerPhone, parcial)
    expect(c.novas(s.ownerPhone)).toEqual(['Faltou no endereço da obra: número e bairro. Me mande o que falta, e eu monto a nota. Ou responda *descartar*.'])
    await c.enviar(s.ownerPhone, 'número 120, bairro Centro')
    expect(c.novas(s.ownerPhone)[0]).toContain('*Obra:* Rua das Flores, 120 - Centro, CEP 12900-000\n')
    await c.enviar(s.ownerPhone, 'confirmar')
    const [payload] = await payloads(s.tenant.id)
    expect(payload.servico.obra).toEqual({ cep: '12900000', logradouro: 'Rua das Flores', numero: '120', bairro: 'Centro' })
    // Sem cidade da obra, vale a da empresa: o local não entra no payload.
    expect(payload.servico.municipio_prestacao_ibge).toBeUndefined()
  })

  it('o CNO basta; código que não é de obra ignora os dados da obra', async () => {
    const s = await cenario()
    const c = conversa({
      'nota pra Sakata, 3800': SAKATA_PARSED,
      'CNO 12.345.67890/12': { obra: { cno: '12.345.67890/12' }, intencao: 'outro' },
      'nota pra Sakata, 3800, código 17.19.01, obra na Rua das Flores, 120, Centro, CEP 12900-000': {
        ...SAKATA_PARSED,
        codigo_servico: '171901',
        obra: ENDERECO,
      },
    })
    await c.enviar(s.ownerPhone, 'nota pra Sakata, 3800')
    c.novas(s.ownerPhone)
    await c.enviar(s.ownerPhone, 'CNO 12.345.67890/12')
    expect(c.novas(s.ownerPhone)[0]).toContain('*Obra:* CNO 12.345.67890/12\n')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect((await payloads(s.tenant.id))[0].servico.obra).toEqual({ cno: '123456789012' })

    await c.enviar(s.ownerPhone, 'nota pra Sakata, 3800, código 17.19.01, obra na Rua das Flores, 120, Centro, CEP 12900-000')
    const [resumo] = c.novas(s.ownerPhone).slice(-1)
    expect(resumo).toContain('*Resumo da nota*')
    expect(resumo).not.toContain('Obra:')
  })
})
