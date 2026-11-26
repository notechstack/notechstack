// Nota de locação pelo WhatsApp (26/11/2026): "nota de aluguel do imóvel da rua X pra Fulano, 2.500 reais". Com a flag
// desligada, o agente diz que a nota entra quando a Receita liberar e nada é criado. Ligada, o tipo escolhe o código
// (99.03.01 ou 99.04.01), o agente pergunta só o que falta do imóvel ou do bem, o resumo diz que é locação e a DPS sai
// sem ISS, com o grupo da locação, validada no XSD do release 2. Banco local, IA, WhatsApp e Sefin de dublê.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { MENSAGEM_LOCACAO_DESLIGADA } from '../locacao.js'
import { createSefinClient } from '../sefin-client.js'
import { processarMensagem, TEXTOS, type ConversaDeps } from './conversa.js'
import type { Parsed } from './interprete.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})
afterEach(() => {
  vi.unstubAllEnvs()
})
afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

// Inquilino já salvo (cliente do escritório), com o código comum da empresa: o tipo da locação troca o código.
const FULANO = { nome: 'Fulano', documento: '12345678909', nomeTomador: 'Fulano de Tal', email: 'fulano@exemplo.test', descricao: 'Aluguel', codigo: '040101' }

async function cenario(comCertificado = false) {
  const s = await createSelfServiceTenant(admin.db, comCertificado ? { certificado: sharedTestCertificate().certificado } : {})
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  await criarModelo(admin.db, s.tenant.id, FULANO)
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

const PEDIDO = 'nota de aluguel do imóvel da rua das Flores 120 pra Fulano, 2.500 reais'
const PEDIDO_PARSED = {
  tomador: 'Fulano',
  modelo: 'Fulano',
  valor: '2500.00',
  descricao: 'Aluguel de dezembro',
  locacao: { tipo: 'imovel', logradouro: 'Rua das Flores', numero: '120' },
  intencao: 'emitir',
} as const

const payloads = async (tenantId: string) =>
  (await notasDoAgente(admin.db, tenantId)).map((n) => n.payload as { servico: Record<string, unknown>; retencao?: unknown })

describe('nota de locação pelo WhatsApp', () => {
  it('flag desligada: diz que a nota entra quando a Receita liberar e não cria nada', async () => {
    vi.stubEnv('NOFISCAL_LOCACAO', '')
    const s = await cenario()
    const c = conversa({ [PEDIDO]: PEDIDO_PARSED })
    await c.enviar(s.ownerPhone, PEDIDO)
    expect(c.novas(s.ownerPhone)).toEqual([MENSAGEM_LOCACAO_DESLIGADA])
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
  })

  it('imóvel: pergunta só o que falta, o resumo diz que é locação, e a DPS sai sem ISS e com o imóvel', async () => {
    vi.stubEnv('NOFISCAL_LOCACAO', '1')
    const s = await cenario(true)
    const resposta = 'CEP 13015-100, bairro Centro, residencial'
    const c = conversa({
      [PEDIDO]: PEDIDO_PARSED,
      [resposta]: { locacao: { cep: '13015-100', bairro: 'Centro', residencial: 'sim' }, intencao: 'outro' },
    })
    await c.enviar(s.ownerPhone, PEDIDO)
    expect(c.novas(s.ownerPhone)).toEqual([
      'Para a nota de locação, faltou o CEP e se é residencial ou comercial. Me mande o que falta, e eu monto a nota. Ou responda *descartar*.',
    ])
    // "confirmar" antes dos dados do imóvel não emite.
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
    expect(c.novas(s.ownerPhone)[0]).toMatch(/faltou o CEP e se é residencial ou comercial/)

    // A resposta completa o pedido, sem *corrigir*.
    await c.enviar(s.ownerPhone, resposta)
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Serviço:* 99.03.01')
    expect(resumo).toContain('*Tipo:* locação de imóvel residencial (99.03.01), sem ISS\n*Imóvel:* Rua das Flores, 120 - Centro, CEP 13015-100, ')
    expect(resumo).toContain('*Valor:* R$ 2.500,00')
    // Empresa do Simples: locação de imóvel próprio é atividade impeditiva (aviso, não bloqueio).
    expect(resumo).toMatch(/\*Atenção:\* Locação de imóvel próprio é atividade impeditiva do Simples Nacional/)

    await c.enviar(s.ownerPhone, 'confirmar')
    // O cliente salvo passa a sair com o código da locação (regra de 17/11/2026 para código trocado na nota).
    expect(c.novas(s.ownerPhone)).toEqual([`${TEXTOS.emitindo}

Guardei o código 99.03.01 no cliente Fulano: as próximas notas para ele saem com esse código.`])
    const [payload] = await payloads(s.tenant.id)
    expect(payload.servico.codigo_servico_nacional).toBe('990301')
    expect(payload.servico.locacao).toMatchObject({
      imovel: { cep: '13015100', logradouro: 'Rua das Flores', numero: '120', bairro: 'Centro', residencial: true, copropriedade: '100.00', valor_total: '2500.00' },
    })
    expect(payload.retencao).toBeUndefined()

    const sefin = fakeSefin()
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: sefin.transport }), tenantId: s.tenant.id, canais: c.canais, now: () => new Date() })
    const [dps] = sefin.requests.filter((r) => r.method === 'POST' && r.path === '/nfse').map((r) => r.xml ?? '')
    expect(dps).toContain('<cTribNac>990301</cTribNac><cNBS>110021000</cNBS>')
    expect(dps).toContain('<tribMun><tribISSQN>4</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>')
    expect(dps).toContain('<gUnidImob><end><CEP>13015100</CEP><xLgr>Rua das Flores</xLgr><nro>120</nro><xBairro>Centro</xBairro></end></gUnidImob>')
    expect(pacoteDaDps(dps)).toBe('producao-restrita-20261124')
    expect(await errosXsd(dps, pacoteDaDps(dps))).toEqual([])
  })

  it('bem móvel: pede o NCM; o resumo mostra o bem; endereço sozinho na resposta vale como o do imóvel', async () => {
    vi.stubEnv('NOFISCAL_LOCACAO', '1')
    const s = await cenario()
    const pedido = 'nota de locação de 2 betoneiras pra Fulano, 3000'
    const c = conversa({
      [pedido]: { tomador: 'Fulano', modelo: 'Fulano', valor: '3000.00', locacao: { tipo: 'movel', bem: 'Betoneira 400 litros', quantidade: '2' }, intencao: 'emitir' },
      'NCM 8474.31.00': { locacao: { ncm: '8474.31.00' }, intencao: 'outro' },
      [PEDIDO]: PEDIDO_PARSED,
      // A IA leu o endereço como o da obra: no pedido de locação, vale como o do imóvel.
      'CEP 13015-100, comercial': { obra: { cep: '13015-100' }, locacao: null, intencao: 'outro' },
      comercial: { locacao: { residencial: 'nao' }, intencao: 'outro' },
    })
    await c.enviar(s.ownerPhone, pedido)
    expect(c.novas(s.ownerPhone)).toEqual([
      'Para a nota de locação, faltou o NCM do bem (8 dígitos, está na nota de compra). Me mande o que falta, e eu monto a nota. Ou responda *descartar*.',
    ])
    await c.enviar(s.ownerPhone, 'NCM 8474.31.00')
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Tipo:* locação de bem móvel (99.04.01), sem ISS\n*Bem:* 2 × Betoneira 400 litros (NCM 8474.31.00)')
    expect(resumo).not.toContain('Atenção:')
    await c.enviar(s.ownerPhone, 'confirmar')
    const [payload] = await payloads(s.tenant.id)
    expect(payload.servico.codigo_servico_nacional).toBe('990401')
    expect(payload.servico.locacao).toEqual({ bens: [{ ncm: '84743100', descricao: 'Betoneira 400 litros', quantidade: 2 }] })

    await c.enviar(s.ownerPhone, PEDIDO)
    c.novas(s.ownerPhone)
    await c.enviar(s.ownerPhone, 'CEP 13015-100, comercial')
    expect(c.novas(s.ownerPhone)[0]).toMatch(/faltou se é residencial ou comercial/)
    await c.enviar(s.ownerPhone, 'comercial')
    expect(c.novas(s.ownerPhone)[0]).toContain('*Tipo:* locação de imóvel não residencial (99.03.01), sem ISS\n*Imóvel:* Rua das Flores, 120, CEP 13015-100')
  })
})
