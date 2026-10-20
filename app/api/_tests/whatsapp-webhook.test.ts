// Webhook da Meta: checks C22 e C23 de .checks/agente-fiscal-whatsapp.md. O C22 passa pela
// função publicada (`api/whatsapp/webhook.ts`) com as variáveis de ambiente de teste; o C23
// chama o mesmo handler com a conversa ligada aos dublês. Nada sai da máquina.
import { createHmac, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleWhatsAppWebhook } from '../_lib/agente/webhook.js'
import { closeSharedDb } from '../_lib/db.js'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createSelfServiceTenant,
  criarModelo,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  openRoleDb,
  pedidosDo,
  randomPhone,
  roleDatabaseUrl,
  type SelfServiceTenant,
} from './agente-fixtures.js'
import { openTestDb } from './fixtures.js'

const SEGREDO = `segredo-do-app-${randomBytes(8).toString('hex')}`
const TOKEN = `token-de-verificacao-${randomBytes(8).toString('hex')}`
process.env.WHATSAPP_APP_SECRET = SEGREDO
process.env.WHATSAPP_VERIFY_TOKEN = TOKEN
process.env.NOFISCAL_DATABASE_URL = roleDatabaseUrl('nofiscal_service')
const { default: entry } = await import('../whatsapp/webhook.js')

const URL_WEBHOOK = 'https://app.notechstack.com.br/api/whatsapp/webhook'
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
  await closeSharedDb()
})

const novoId = () => `wamid.HBgN${randomBytes(12).toString('base64url')}`

/** Mensagem de texto no formato da notificação `messages` da Cloud API. */
function notificacao(mensagens: { de: string; texto: string; id?: string }[]): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: '106540352242922' },
              contacts: mensagens.map((m) => ({ profile: { name: 'Pessoa' }, wa_id: m.de.replace('+', '') })),
              messages: mensagens.map((m) => ({
                from: m.de.replace('+', ''),
                id: m.id ?? novoId(),
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: m.texto },
              })),
            },
          },
        ],
      },
    ],
  })
}

const assinatura = (corpo: string, segredo = SEGREDO) => `sha256=${createHmac('sha256', segredo).update(corpo, 'utf8').digest('hex')}`

const post = (corpo: string, headers: Record<string, string> = {}) =>
  new Request(URL_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: corpo })

async function marcada(id: string): Promise<boolean> {
  const { rows } = await admin.db.query('select 1 from nofiscal.fiscal_agent_once where chave = $1', [`wa:${id}`])
  return rows.length === 1
}

async function cenario(): Promise<SelfServiceTenant> {
  const s = await createSelfServiceTenant(admin.db)
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  await criarModelo(admin.db, s.tenant.id, { nome: 'Prontia', documento: '12345678000195', nomeTomador: 'Prontia Saúde' })
  return s
}

describe('POST/GET /api/whatsapp/webhook', () => {
  it('assinatura e verificação', async () => {
    // GET: devolve o hub.challenge só com o token certo.
    const verificar = (params: Record<string, string>) =>
      entry.fetch(new Request(`${URL_WEBHOOK}?${new URLSearchParams(params)}`, { method: 'GET' }))
    const certo = await verificar({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' })
    expect(certo.status).toBe(200)
    expect(await certo.text()).toBe('1158201444')
    for (const params of [
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'token-errado', 'hub.challenge': '1158201444' } as Record<string, string>,
      { 'hub.mode': 'subscribe', 'hub.challenge': '1158201444' },
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' },
    ]) {
      const res = await verificar(params)
      expect(res.status).toBe(403)
      expect(await res.text()).not.toContain('1158201444')
    }

    // POST: sem assinatura, com segredo errado, com assinatura de outro corpo ou malformada → 401, sem processar.
    const s = await cenario()
    const id = novoId()
    const corpo = notificacao([{ de: s.ownerPhone, texto: 'nota pra Prontia Saúde, 10 reais', id }])
    for (const headers of [
      {} as Record<string, string>,
      { 'x-hub-signature-256': assinatura(corpo, 'outro-segredo') },
      { 'x-hub-signature-256': assinatura(`${corpo} `) },
      { 'x-hub-signature-256': assinatura(corpo).replace('sha256=', '') },
      { 'x-hub-signature-256': 'sha256=' },
    ]) {
      const res = await entry.fetch(post(corpo, headers))
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED')
    }
    expect(await marcada(id)).toBe(false)
    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(0)

    // Assinatura válida (aviso de status, sem mensagem): 200.
    const status = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id: novoId(), status: 'delivered' }] } }] }],
    })
    const ok = await entry.fetch(post(status, { 'x-hub-signature-256': assinatura(status) }))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })

    // Sem segredo configurado, nenhuma assinatura vale.
    delete process.env.WHATSAPP_APP_SECRET
    try {
      const res = await entry.fetch(post(status, { 'x-hub-signature-256': assinatura(status) }))
      expect(res.status).toBe(401)
    } finally {
      process.env.WHATSAPP_APP_SECRET = SEGREDO
    }
  })

  it('mensagem repetida', async () => {
    const s = await cenario()
    const canais = canaisDouble()
    const ia = interpreteDouble({ 'nota pra Prontia Saúde, 10 reais': { tomador: 'Prontia Saúde', valor: '10.00', intencao: 'emitir' } })
    const deps = {
      verifyToken: TOKEN,
      appSecret: SEGREDO,
      conversa: () => ({ db: servico.db, whatsapp: canais.whatsapp, interprete: ia.interprete, links: LINKS_DE_TESTE }),
    }
    const entregar = async (corpo: string) => {
      const res = await handleWhatsAppWebhook(post(corpo, { 'x-hub-signature-256': assinatura(corpo) }), deps)
      expect(res.status).toBe(200)
    }

    const id = novoId()
    const corpo = notificacao([{ de: s.ownerPhone, texto: 'nota pra Prontia Saúde, 10 reais', id }])
    await entregar(corpo)
    await entregar(corpo)
    // Reentrega simultânea também não duplica.
    await Promise.all([entregar(corpo), entregar(corpo)])

    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(1)
    expect(canais.whatsapps.filter((m) => m.para === s.ownerPhone)).toHaveLength(1)
    expect(ia.chamadas).toHaveLength(1)

    // A mesma id dentro de outra notificação, junto com uma mensagem nova: só a nova é processada.
    const desconhecido = randomPhone()
    const id2 = novoId()
    await entregar(notificacao([{ de: s.ownerPhone, texto: 'nota pra Prontia Saúde, 10 reais', id }, { de: desconhecido, texto: 'oi', id: id2 }]))
    await entregar(notificacao([{ de: desconhecido, texto: 'oi', id: id2 }]))
    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(1)
    expect(canais.whatsapps.filter((m) => m.para === desconhecido)).toHaveLength(1)
    expect(canais.whatsapps).toHaveLength(2)
  })
})
