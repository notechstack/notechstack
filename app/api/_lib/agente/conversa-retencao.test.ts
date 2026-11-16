// Retenção no pedido pelo WhatsApp (Lucca, 16/11/2026): o pedido herda o padrão da empresa ("nota pro João, 350"), o
// texto do pedido muda ("sem retenção", "com retenção de ISS 2%", "retém INSS 11%"), o resumo mostra a retenção antes
// do *confirmar*, e o que a Sefin recusaria não chega a virar nota. Banco local, IA e WhatsApp de dublê.
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
  type SelfServiceOptions,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { openTestDb } from '../../_tests/fixtures.js'
import type { EnderecoNacional } from '../retencao.js'
import { processarMensagem, TEXTO_RETENCAO_NAO_ENTENDIDA, type ConversaDeps } from './conversa.js'
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

async function cenario(opcoes: SelfServiceOptions = {}) {
  const s = await createSelfServiceTenant(admin.db, opcoes)
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  return s
}

const ENDERECO: EnderecoNacional = { cMun: '3550308', cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', complemento: null, bairro: 'BELA VISTA' }
const CNPJ_TOMADOR = '12345678000195'

type Roteiro = Record<string, Partial<Parsed> & Record<string, unknown>>
function conversa(roteiro: Roteiro, opcoes: { semEndereco?: boolean } = {}) {
  const canais = canaisDouble()
  const consultas: string[] = []
  const deps: ConversaDeps = {
    db: servico.db,
    whatsapp: canais.whatsapp,
    interprete: interpreteDouble(roteiro).interprete,
    links: LINKS_DE_TESTE,
    consultaCnpj: {
      async razaoSocial() {
        return null
      },
      async endereco(cnpj) {
        consultas.push(cnpj)
        return opcoes.semEndereco ? null : ENDERECO
      },
    },
  }
  return {
    consultas,
    enviar: (de: string, texto: string) => processarMensagem(deps, mensagemDeTexto(de, texto)),
    ultimaPara: (para: string) => canais.whatsapps.filter((m) => m.para === para).at(-1)?.texto ?? '',
  }
}

const modelo = (documento: string) => ({ nome: 'Clínica', documento, nomeTomador: 'Clínica Saúde', email: 'fin@clinica.test', descricao: 'Manutenção predial' })
const PEDIDO = 'nota pra Clínica, 1500'
const pedido = (extra: Partial<Parsed> = {}) => ({ tomador: 'Clínica', valor: '1500.00', intencao: 'emitir' as const, ...extra })

async function padraoDaEmpresa(tenantId: string, v: { retem_iss?: boolean; aliquota_iss?: string | null; retem_inss?: boolean; inss_percentual?: string | null }) {
  await admin.db.query(
    'update nofiscal.fiscal_tenants set retem_iss = $2, aliquota_iss = $3, retem_inss = $4, inss_percentual = $5 where id = $1',
    [tenantId, v.retem_iss ?? false, v.aliquota_iss ?? null, v.retem_inss ?? false, v.inss_percentual ?? null],
  )
}

async function payloadDaUnicaNota(tenantId: string) {
  const notas = await notasDoAgente(admin.db, tenantId)
  expect(notas).toHaveLength(1)
  const { rows } = await admin.db.query<{ payload: Record<string, unknown> }>('select payload from nofiscal.fiscal_invoices where id = $1', [notas[0].id])
  return rows[0].payload as { tomador: Record<string, unknown>; retencao?: unknown }
}

describe('retenção no pedido pelo WhatsApp', () => {
  // Caso real (16/11/2026, 18h14): o pedido citava a retenção, e a nota saiu com tpRetISSQN 1 (depois cancelada).
  const BRAGANTINA =
    'Emitir uma nota fiscal da 4 ESTACOES BRAGANCA LTDA para tomadora CONTABILIDADE BRAGANTINA LTDA no valor de 1,00. Tem retenção de ISS pela tomadora na alíquota de 2,01%.'

  it('pedido real da Bragantina: a retenção de 2,01% aparece no resumo e vai na nota', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, { ...modelo(CNPJ_TOMADOR), nome: 'Contabilidade Bragantina', nomeTomador: 'CONTABILIDADE BRAGANTINA LTDA' })
    const c = conversa({
      [BRAGANTINA]: { tomador: 'CONTABILIDADE BRAGANTINA LTDA', valor: '1.00', iss_retido: true, aliquota_iss: '2,01', intencao: 'emitir' },
    })
    await c.enviar(s.ownerPhone, BRAGANTINA)
    expect(c.ultimaPara(s.ownerPhone)).toContain('Valor: R$ 1,00\nISS retido pelo tomador: 2,01% (R$ 0,02)\nValor líquido: R$ 0,98\nPosso emitir?')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect((await payloadDaUnicaNota(s.tenant.id)).retencao).toEqual({ iss: { aliquota: '2.01' } })
  })

  it('pedido que fala de retenção sem a IA ler qual: não emite e pede a retenção por extenso', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, { ...modelo(CNPJ_TOMADOR), nome: 'Contabilidade Bragantina', nomeTomador: 'CONTABILIDADE BRAGANTINA LTDA' })
    const c = conversa({ [BRAGANTINA]: { tomador: 'CONTABILIDADE BRAGANTINA LTDA', valor: '1.00', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, BRAGANTINA)
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTO_RETENCAO_NAO_ENTENDIDA)
    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(0)
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
  })

  it('o pedido herda a retenção da empresa; o resumo mostra antes do confirmar; a nota leva retenção e endereço', async () => {
    const s = await cenario()
    await padraoDaEmpresa(s.tenant.id, { retem_iss: true, aliquota_iss: '2.00', retem_inss: true, inss_percentual: '11.00' })
    await criarModelo(admin.db, s.tenant.id, modelo(CNPJ_TOMADOR))
    const c = conversa({ [PEDIDO]: pedido() })

    await c.enviar(s.ownerPhone, PEDIDO)
    const resumo = c.ultimaPara(s.ownerPhone)
    expect(resumo).toContain('Valor: R$ 1.500,00\nISS retido pelo tomador: 2% (R$ 30,00)\nINSS retido: R$ 165,00\nValor líquido: R$ 1.305,00\nPosso emitir?')
    expect(c.consultas).toEqual([CNPJ_TOMADOR])
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)

    await c.enviar(s.ownerPhone, 'confirmar')
    const payload = await payloadDaUnicaNota(s.tenant.id)
    expect(payload.retencao).toEqual({ iss: { aliquota: '2.00' }, inss: { valor: '165.00' } })
    expect(payload.tomador.endereco).toEqual(ENDERECO)
  })

  it('"sem retenção" no pedido desliga o padrão; a nota sai como antes', async () => {
    const s = await cenario()
    await padraoDaEmpresa(s.tenant.id, { retem_inss: true, inss_percentual: '11.00' })
    await criarModelo(admin.db, s.tenant.id, modelo(CNPJ_TOMADOR))
    const texto = 'nota pra Clínica, 1500, sem retenção'
    const c = conversa({ [texto]: pedido({ iss_retido: false, inss_retido: false }) })

    await c.enviar(s.ownerPhone, texto)
    expect(c.ultimaPara(s.ownerPhone)).not.toContain('retido')
    await c.enviar(s.ownerPhone, 'confirmar')
    const payload = await payloadDaUnicaNota(s.tenant.id)
    expect(payload.retencao).toBeUndefined()
    expect(payload.tomador.endereco).toBeUndefined()
    expect(c.consultas).toEqual([])
  })

  it('ISS retido de tomador CPF não emite; corrigir com "sem retenção de ISS" e "retém INSS 11%" libera', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, modelo('52998224725'))
    const texto = 'nota pra Clínica, 1500, com retenção de ISS 2%'
    const correcao = 'sem retenção de ISS, retém INSS 11%'
    const c = conversa({ [texto]: pedido({ iss_retido: true, aliquota_iss: '2' }), [correcao]: { iss_retido: false, inss_retido: true, inss: '11%', intencao: 'outro' } })

    await c.enviar(s.ownerPhone, texto)
    expect(c.ultimaPara(s.ownerPhone)).toContain('ISS retido só para cliente com CNPJ')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Não dá para emitir esta nota assim')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)

    await c.enviar(s.ownerPhone, 'corrigir')
    await c.enviar(s.ownerPhone, correcao)
    const resumo = c.ultimaPara(s.ownerPhone)
    expect(resumo).toContain('INSS retido: R$ 165,00')
    expect(resumo).not.toContain('ISS retido pelo tomador')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect((await payloadDaUnicaNota(s.tenant.id)).retencao).toEqual({ inss: { valor: '165.00' } })
  })

  it('MEI não tem retenção; sem endereço na Receita, o ISS retido também para', async () => {
    const mei = await cenario({ regime: 'mei' })
    await criarModelo(admin.db, mei.tenant.id, modelo(CNPJ_TOMADOR))
    const texto = 'nota pra Clínica, 1500, retém INSS 11%'
    const c = conversa({ [texto]: pedido({ inss_retido: true, inss: '11%' }) })
    await c.enviar(mei.ownerPhone, texto)
    expect(c.ultimaPara(mei.ownerPhone)).toContain('MEI não tem retenção')

    const s = await cenario()
    await padraoDaEmpresa(s.tenant.id, { retem_iss: true, aliquota_iss: '3.00' })
    await criarModelo(admin.db, s.tenant.id, modelo(CNPJ_TOMADOR))
    const d = conversa({ [PEDIDO]: pedido() }, { semEndereco: true })
    await d.enviar(s.ownerPhone, PEDIDO)
    expect(d.ultimaPara(s.ownerPhone)).toContain('não achei o endereço deste CNPJ na Receita')
    await d.enviar(s.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
  })
})
