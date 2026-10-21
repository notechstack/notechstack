// URLs base dos serviços externos do agente. Check C56c de .checks/agente-fiscal-v2.md: sem
// `WHATSAPP_GRAPH_URL` e `CNPJ_API_URL` (e `RESEND_API_URL`, do mesmo jeito), o app chama as URLs
// oficiais; com elas, a demonstração alcança os dublês. Nenhuma chamada sai da máquina: o
// `fetch` global é trocado por um dublê que só registra.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSharedDb } from '../db.js'
import { agenteFromEnv, conversaFromEnv } from './ambiente.js'
import { whatsappCloud } from './whatsapp-cloud.js'

const VARIAVEIS = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'RESEND_API_KEY',
  'NOFISCAL_DATABASE_URL',
  'WHATSAPP_GRAPH_URL',
  'CNPJ_API_URL',
  'RESEND_API_URL',
] as const
const antes = Object.fromEntries(VARIAVEIS.map((v) => [v, process.env[v]]))
let chamadas: { url: string; init?: RequestInit }[] = []

beforeEach(() => {
  chamadas = []
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init })
    const corpo = String(url).includes('/api/cnpj/v1/') ? { razao_social: 'EMPRESA OFICIAL LTDA' } : { id: 'x' }
    return new Response(JSON.stringify(corpo), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  process.env.WHATSAPP_ACCESS_TOKEN = 'token-de-teste'
  process.env.WHATSAPP_PHONE_NUMBER_ID = '123456'
  process.env.RESEND_API_KEY = 'chave-de-teste'
  // O pool só abre conexão na primeira consulta, e nenhuma acontece aqui.
  process.env.NOFISCAL_DATABASE_URL = 'postgres://ninguem@127.0.0.1:1/nada'
  delete process.env.WHATSAPP_GRAPH_URL
  delete process.env.CNPJ_API_URL
  delete process.env.RESEND_API_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
})

afterAll(async () => {
  for (const v of VARIAVEIS) {
    if (antes[v] === undefined) delete process.env[v]
    else process.env[v] = antes[v]
  }
  await closeSharedDb()
})

async function chamarTudo() {
  const conversa = conversaFromEnv()
  const agente = agenteFromEnv()
  await conversa.whatsapp.enviarTexto('+5511987654321', 'oi')
  await conversa.consultaCnpj?.razaoSocial('11444777000161')
  await agente?.email.enviar({ para: 'dono@example.test', assunto: 'a', texto: 'b' })
  return chamadas.map((c) => c.url)
}

describe('URLs base', () => {
  it('urls oficiais por padrão', async () => {
    const urls = await chamarTudo()
    expect(urls).toEqual([
      'https://graph.facebook.com/v26.0/123456/messages',
      'https://brasilapi.com.br/api/cnpj/v1/11444777000161',
      'https://api.resend.com/emails',
    ])
  })

  it('urls da demonstração quando definidas', async () => {
    process.env.WHATSAPP_GRAPH_URL = 'http://localhost:3004/'
    process.env.CNPJ_API_URL = 'http://localhost:3006'
    process.env.RESEND_API_URL = 'http://localhost:3003'
    const urls = await chamarTudo()
    expect(urls).toEqual([
      'http://localhost:3004/v26.0/123456/messages',
      'http://localhost:3006/api/cnpj/v1/11444777000161',
      'http://localhost:3003/emails',
    ])
  })

  it('modelo vai como template da Cloud API', async () => {
    const whatsapp = whatsappCloud({ token: 't', phoneNumberId: '123456' })
    await whatsapp.enviarModelo('+5511987654321', 'resumo_nofiscal', ['outubro/2026', '2', '1', 'R$ 100,00'])
    await whatsapp.enviarModelo('+5511987654321', 'sem_parametros', [])
    const corpos = chamadas.map((c) => JSON.parse(String(c.init?.body)))
    expect(corpos[0]).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511987654321',
      type: 'template',
      template: {
        name: 'resumo_nofiscal',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'outubro/2026' },
              { type: 'text', text: '2' },
              { type: 'text', text: '1' },
              { type: 'text', text: 'R$ 100,00' },
            ],
          },
        ],
      },
    })
    expect(corpos[1].template).toEqual({ name: 'sem_parametros', language: { code: 'pt_BR' } })
  })
})
