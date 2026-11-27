// Nota sem tomador pelo WhatsApp (Contabilidade Bragantina, 27/11/2026): "nota de 150 pra consumidor não identificado"
// sai sem `toma`, com "Tomador: não informado" no resumo, sem retenção e sem virar cliente salvo. A própria empresa
// nunca é o tomador: o caso que deu "DPS inválida: tomador é o próprio prestador" (E0202) agora pergunta. Banco local,
// IA, WhatsApp e Sefin de dublê; a DPS que chega à Sefin é validada no XSD oficial.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createSelfServiceTenant,
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
import { errosXsd, pacoteDaDps } from '../../_tests/xsd.js'
import { createSefinClient } from '../sefin-client.js'
import { comSemTomadorDoTexto, processarMensagem, TEXTOS, textoDaPropriaEmpresa, type ConversaDeps } from './conversa.js'
import { validarParsed, type Parsed } from './interprete.js'

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

/** CNPJ com dígito verificador válido (o leitor de documento confere o DV). */
function cnpjValido(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10))
  const dv = (nums: number[]) => {
    const pesos = nums.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const r = nums.reduce((t, n, i) => t + n * pesos[i], 0) % 11
    return r < 2 ? 0 : 11 - r
  }
  const d1 = dv(base)
  const d2 = dv([...base, d1])
  return [...base, d1, d2].join('')
}

const RAZAO = 'Clinica Bem Estar Ltda'

async function cenario(opcoes: { certificado?: boolean; retemIss?: boolean; codigo?: string } = {}) {
  const s = await createSelfServiceTenant(admin.db, {
    razaoSocial: RAZAO,
    ...(opcoes.certificado ? { certificado: sharedTestCertificate().certificado } : {}),
  })
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  const cnpj = cnpjValido()
  await admin.db.query(
    `update nofiscal.fiscal_tenants set cnpj = $2, retem_iss = $3, aliquota_iss = $4, codigo_servico_nacional = coalesce($5, codigo_servico_nacional)
      where id = $1`,
    [s.tenant.id, cnpj, Boolean(opcoes.retemIss), opcoes.retemIss ? '2.00' : null, opcoes.codigo ?? null],
  )
  return { ...s, cnpj }
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
    novas(para: string): string[] {
      const todas = canais.whatsapps.filter((m) => m.para === para).map((m) => m.texto)
      const out = todas.slice(lidas)
      lidas = todas.length
      return out
    },
  }
}

const PEDIDO = 'nota de 150 pra consumidor não identificado'
const DESCRICAO = 'Consulta avulsa'
const LINHA_DO_TOMADOR = '*Tomador:* não informado (consumidor não identificado)'

const modelosDe = async (tenantId: string) =>
  (await admin.db.query<{ n: number }>('select count(*)::int as n from nofiscal.fiscal_models where tenant_id = $1', [tenantId])).rows[0].n

describe('comSemTomadorDoTexto (código, sem IA)', () => {
  const p = (x: Partial<Parsed>) => validarParsed({ intencao: 'emitir', valor: '150', ...x })
  it('a IA leu a frase como o cliente, ou não leu cliente nenhum: vira NAO INFORMADO', () => {
    expect(comSemTomadorDoTexto(p({ tomador: 'consumidor não identificado' }), PEDIDO).tomador).toBe('NAO INFORMADO')
    expect(comSemTomadorDoTexto(p({ tomador: null }), 'nota de 150 sem tomador').tomador).toBe('NAO INFORMADO')
  })
  it('com CPF/CNPJ, ou com um cliente de verdade, fica como a IA leu', () => {
    expect(comSemTomadorDoTexto(p({ tomador: 'Maria', documento: '52998224725' }), 'nota de 150 pra Maria, consumidor final').tomador).toBe('Maria')
    expect(comSemTomadorDoTexto(p({ tomador: 'Maria' }), 'nota de 150 pra Maria').tomador).toBe('Maria')
  })
})

describe('nota sem tomador pelo WhatsApp', () => {
  it('"nota de 150 pra consumidor não identificado": resumo sem CPF/CNPJ, DPS sem toma (XSD), sem cliente salvo', async () => {
    const s = await cenario({ certificado: true })
    const c = conversa({ [PEDIDO]: { tomador: 'consumidor não identificado', valor: '150.00', descricao: DESCRICAO, intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, PEDIDO)
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain('*Resumo da nota*')
    expect(resumo).toContain(LINHA_DO_TOMADOR)
    expect(resumo).not.toMatch(/\*CPF:\*|\*CNPJ:\*|E-mail de/)
    expect(resumo).toContain('*Valor:* R$ 150,00')

    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.novas(s.ownerPhone)).toEqual([TEXTOS.emitindo])
    const [nota] = await notasDoAgente(admin.db, s.tenant.id)
    expect(nota.payload).toEqual({ tomador_nao_informado: true, servico: { codigo_servico_nacional: '010701', descricao: DESCRICAO }, valor: '150.00' })

    const sefin = fakeSefin()
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: sefin.transport }), tenantId: s.tenant.id, canais: c.canais, now: () => new Date() })
    const [dps] = sefin.requests.filter((r) => r.method === 'POST' && r.path === '/nfse').map((r) => r.xml ?? '')
    expect(dps).not.toContain('<toma>')
    expect(await errosXsd(dps, pacoteDaDps(dps))).toEqual([])
    // Autorizada: o PDF vai no WhatsApp, e ninguém pergunta se quer guardar o cliente.
    const depois = c.novas(s.ownerPhone)
    expect(depois.some((t) => /autorizada/.test(t))).toBe(true)
    expect(depois.some((t) => /Quer que eu guarde/.test(t))).toBe(false)
    expect(await modelosDe(s.tenant.id)).toBe(0)
  })

  it('a IA não leu o cliente, mas a mensagem diz "sem tomador": segue sem tomador, sem pedir CPF', async () => {
    const s = await cenario()
    const texto = 'emite uma de 80 reais sem tomador'
    const c = conversa({ [texto]: { tomador: null, valor: '80.00', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, texto)
    const [pergunta] = c.novas(s.ownerPhone)
    // Descrição padrão: a pergunta da descrição vem antes do resumo; depois dela, o resumo sem tomador.
    expect(pergunta).toBe(TEXTOS.perguntaDeDescricao)
    await c.enviar(s.ownerPhone, 'padrão')
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain(LINHA_DO_TOMADOR)
    const [pedido] = await pedidosDo(admin.db, s.tenant.id)
    expect(pedido.etapa).toBe('confirmar')
  })

  it('o padrão de ISS retido da empresa não vale sem tomador; pedir retenção é recusado (E0204)', async () => {
    const s = await cenario({ retemIss: true })
    const c = conversa({
      [PEDIDO]: { tomador: 'consumidor não identificado', valor: '150.00', descricao: DESCRICAO, intencao: 'emitir' },
      'nota de 150 sem tomador com ISS retido 2%': { tomador: null, valor: '150.00', descricao: DESCRICAO, iss_retido: true, aliquota_iss: '2', intencao: 'emitir' },
    })
    await c.enviar(s.ownerPhone, PEDIDO)
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain(LINHA_DO_TOMADOR)
    expect(resumo).not.toContain('ISS retido')
    await c.enviar(s.ownerPhone, 'descartar')
    c.novas(s.ownerPhone)

    await c.enviar(s.ownerPhone, 'nota de 150 sem tomador com ISS retido 2%')
    const [recusa] = c.novas(s.ownerPhone)
    expect(recusa).toContain('nota sem tomador não tem retenção')
    expect(recusa).toContain('E0204')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toEqual([])
  })

  it('17.05.01 (mão de obra, ISS no endereço do tomador) não sai sem tomador', async () => {
    const s = await cenario({ codigo: '170501' })
    const c = conversa({ [PEDIDO]: { tomador: 'consumidor não identificado', valor: '150.00', descricao: 'Mão de obra', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, PEDIDO)
    const [recusa] = c.novas(s.ownerPhone)
    expect(recusa).toContain('*Tomador*')
    expect(recusa).toContain('17.05.01')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toEqual([])
  })
})

describe('a própria empresa nunca é o tomador (E0202)', () => {
  it('o nome do tomador é a razão social da empresa: pergunta, e nada é criado', async () => {
    const s = await cenario()
    const texto = 'nota de 150 pra Clínica Bem Estar'
    const c = conversa({ [texto]: { tomador: 'Clínica Bem Estar', valor: '150.00', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, texto)
    expect(c.novas(s.ownerPhone)).toEqual([textoDaPropriaEmpresa(RAZAO)])
    expect(await pedidosDo(admin.db, s.tenant.id)).toEqual([])
  })

  it('caso da Bragantina: pediu o CPF/CNPJ e veio o CNPJ da própria empresa; pergunta, e "sem tomador" segue', async () => {
    const s = await cenario({ certificado: true })
    const texto = 'nota de 150 pra consumidora Ana'
    const c = conversa({ [texto]: { tomador: 'consumidora Ana', valor: '150.00', descricao: DESCRICAO, intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, texto)
    expect(c.novas(s.ownerPhone)[0]).toMatch(/Me mande o CPF ou CNPJ e o e-mail/)

    // Antes: a nota ia com o CNPJ da empresa no tomador e a Sefin recusava ("tomador é o próprio prestador").
    await c.enviar(s.ownerPhone, `${s.cnpj} contato@clinica.test`)
    expect(c.novas(s.ownerPhone)).toEqual([textoDaPropriaEmpresa(RAZAO, true)])
    expect((await pedidosDo(admin.db, s.tenant.id))[0].etapa).toBe('dados_tomador')

    await c.enviar(s.ownerPhone, 'sem tomador')
    const [resumo] = c.novas(s.ownerPhone)
    expect(resumo).toContain(LINHA_DO_TOMADOR)
    await c.enviar(s.ownerPhone, 'confirmar')
    const [nota] = await notasDoAgente(admin.db, s.tenant.id)
    expect(nota.payload).toMatchObject({ tomador_nao_informado: true })
    expect(nota.payload).not.toHaveProperty('tomador')

    const sefin = fakeSefin()
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: sefin.transport }), tenantId: s.tenant.id, canais: c.canais, now: () => new Date() })
    const [dps] = sefin.requests.filter((r) => r.method === 'POST' && r.path === '/nfse').map((r) => r.xml ?? '')
    expect(dps).not.toContain('<toma>')
    expect(await modelosDe(s.tenant.id)).toBe(0)
  })
})
