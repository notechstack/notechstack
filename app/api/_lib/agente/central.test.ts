// Central de conversas do nó.fiscal (Lucca, 29/10/2026). Prova contra o banco local, com o código sob
// teste conectado como `nofiscal_service`: a entrada (pelo webhook assinado) e a saída (texto, documento,
// modelo) ficam gravadas, com as marcas da Meta; "assumir" deixa o robô quieto no número; a equipe
// responde pela rota de administrador; os alertas saem num e-mail só; "Apagar conta" e a retenção
// apagam as mensagens. O WhatsApp, a IA e o e-mail são dublês: nada sai da máquina.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createSelfServiceTenant,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  openRoleDb,
  randomPhone,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { supabaseAdminVerifier, type AdminVerifier } from '../session.js'
import { whatsappComRetentativa, type EnviaEmail, type EnviaWhatsApp } from './canais.js'
import {
  apagarConversasAntigas,
  conversaAssumida,
  enviarAlertasDaCentral,
  PRAZO_DA_EQUIPE_MS,
  registrarEvento,
  URL_DA_CENTRAL,
  whatsappGravado,
} from './central.js'
import { TEXTOS, type ConversaDeps } from './conversa.js'
import { handleCentral, TEXTO_AO_ASSUMIR, TEXTO_AO_DEVOLVER } from './rota-central.js'
import { handleWhatsAppWebhook } from './webhook.js'
import { WhatsAppHttpError } from './whatsapp-cloud.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []
const avulsos: string[] = []
const SEGREDO = `segredo-da-central-${randomBytes(6).toString('hex')}`
const PHONE_NUMBER_ID = '1439483552576759'
const ADMIN_ID = randomUUID()

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const telefone of avulsos) {
    await admin.db.query('delete from nofiscal.fiscal_messages where phone_e164 = $1', [telefone])
    await admin.db.query('delete from nofiscal.fiscal_conversation_events where phone_e164 = $1', [telefone])
    await admin.db.query('delete from nofiscal.fiscal_conversations where phone_e164 = $1', [telefone])
  }
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

async function cenario(razaoSocial = `Studio Central ${randomBytes(3).toString('hex')}`): Promise<SelfServiceTenant> {
  const s = await createSelfServiceTenant(admin.db, { razaoSocial })
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  return s
}

function avulso(): string {
  const telefone = randomPhone()
  avulsos.push(telefone)
  return telefone
}

/** Dublê da Cloud API que devolve o `wamid`, como a real, e falha quantas vezes o teste mandar. */
function cloudDouble(falhas = 0) {
  const canais = canaisDouble()
  const ids: string[] = []
  let restantes = falhas
  const tentar = () => {
    if (restantes > 0) {
      restantes--
      throw new WhatsAppHttpError(400, 131026, 'Message undeliverable')
    }
    const wamid = `wamid.saida-${randomBytes(8).toString('hex')}`
    ids.push(wamid)
    return { wamid }
  }
  const whatsapp: EnviaWhatsApp = {
    async enviarTexto(para, texto) {
      const enviada = tentar()
      await canais.whatsapp.enviarTexto(para, texto)
      return enviada
    },
    async enviarDocumento(para, anexo, legenda) {
      const enviada = tentar()
      await canais.whatsapp.enviarDocumento(para, anexo, legenda)
      return enviada
    },
    async enviarModelo(para, nome, parametros) {
      const enviada = tentar()
      await canais.whatsapp.enviarModelo(para, nome, parametros)
      return enviada
    },
  }
  return { whatsapp, ids, enviadas: canais.whatsapps, falharMais: (n: number) => (restantes = n) }
}

const novoId = () => `wamid.entrada-${randomBytes(10).toString('hex')}`
const assinatura = (corpo: string) => `sha256=${createHmac('sha256', SEGREDO).update(corpo, 'utf8').digest('hex')}`

function notificacao(valor: Record<string, unknown>): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1112887808155242',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5511945146923', phone_number_id: PHONE_NUMBER_ID },
              ...valor,
            },
          },
        ],
      },
    ],
  })
}

const textoDaMeta = (de: string, texto: string, id = novoId()) => ({
  contacts: [{ profile: { name: 'Pessoa' }, wa_id: de.slice(1) }],
  messages: [{ from: de.slice(1), id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }],
})

const marcaDaMeta = (wamid: string, status: string, para: string, errors?: unknown[]) => ({
  statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: para.slice(1), ...(errors ? { errors } : {}) }],
})

function postar(corpo: string, conversa: ConversaDeps): Promise<Response> {
  return handleWhatsAppWebhook(
    new Request('https://app.notechstack.com.br/api/whatsapp/webhook', {
      method: 'POST',
      body: corpo,
      headers: { 'x-hub-signature-256': assinatura(corpo) },
    }),
    { verifyToken: 'token', appSecret: SEGREDO, phoneNumberId: PHONE_NUMBER_ID, conversa: () => conversa, central: () => conversa.db },
  )
}

/** O robô como em produção: o WhatsApp dele grava todo envio na central. A IA só conhece o roteiro. */
function robo() {
  const cloud = cloudDouble()
  let agora = new Date()
  const deps: ConversaDeps = {
    db: servico.db,
    whatsapp: whatsappGravado(cloud.whatsapp, servico.db),
    interprete: interpreteDouble({}).interprete,
    links: LINKS_DE_TESTE,
    now: () => agora,
  }
  return {
    cloud,
    deps,
    avancar: (ms: number) => (agora = new Date(agora.getTime() + ms)),
    receber: (de: string, texto: string, id?: string) => postar(notificacao(textoDaMeta(de, texto, id)), deps),
    respostasPara: (para: string) => cloud.enviadas.filter((m) => m.para === para).map((m) => m.texto),
  }
}

const admins: AdminVerifier = {
  async adminIdFrom(request) {
    return request.headers.get('authorization') === 'Bearer admin-aal2' ? ADMIN_ID : null
  },
}

type RespostaDaCentral = {
  aviso?: boolean | null
  error?: { code: string }
  conversas?: { telefone: string; empresa: string | null; etiquetas: string[] }[]
  conversa?: { mensagens: { texto: string | null }[] } & Record<string, unknown>
}

async function naCentral(corpo: Record<string, unknown> | null, whatsapp: EnviaWhatsApp | null, token = 'admin-aal2') {
  const request = new Request('https://app.notechstack.com.br/api/v1/fiscal/central', {
    method: corpo ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, ...(corpo ? { 'content-type': 'application/json' } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  })
  const resposta = await handleCentral(request, { db: servico.db, admins, whatsapp })
  return { status: resposta.status, corpo: (await resposta.json()) as RespostaDaCentral }
}

type Linha = {
  direcao: string
  autor: string
  tipo: string
  texto: string | null
  arquivo: string | null
  wamid: string | null
  status: string | null
  erro: string | null
  tenant_id: string | null
  user_id: string | null
}

async function mensagensDo(telefone: string): Promise<Linha[]> {
  const { rows } = await admin.db.query<Linha>(
    `select direcao, autor, tipo, texto, arquivo, wamid, status, erro, tenant_id, user_id
       from nofiscal.fiscal_messages where phone_e164 = $1 order by created_at, id`,
    [telefone],
  )
  return rows
}

async function eventosDo(telefone: string): Promise<string[]> {
  const { rows } = await admin.db.query<{ tipo: string }>(
    'select tipo from nofiscal.fiscal_conversation_events where phone_e164 = $1 order by created_at, id',
    [telefone],
  )
  return rows.map((r) => r.tipo)
}

describe('guardar as mensagens', () => {
  it('a mensagem recebida pelo webhook e a resposta do robô ficam gravadas, uma vez só', async () => {
    const s = await cenario()
    const r = robo()
    const id = novoId()
    const corpo = notificacao(textoDaMeta(s.ownerPhone, 'atendente', id))
    expect((await postar(corpo, r.deps)).status).toBe(200)
    // A Meta reentrega: nem a mensagem nem a resposta se repetem.
    expect((await postar(corpo, r.deps)).status).toBe(200)

    expect(await mensagensDo(s.ownerPhone)).toEqual([
      expect.objectContaining({ direcao: 'entrada', autor: 'cliente', tipo: 'text', texto: 'atendente', wamid: id, status: null, tenant_id: s.tenant.id }),
      expect.objectContaining({
        direcao: 'saida',
        autor: 'robo',
        tipo: 'text',
        texto: TEXTOS.chamouAEquipe,
        wamid: r.cloud.ids[0],
        status: 'enviada',
        tenant_id: s.tenant.id,
      }),
    ])
    expect(await eventosDo(s.ownerPhone)).toEqual(['pediu_atendente'])
  })

  it('documento e modelo entram com o nome do arquivo e os parâmetros', async () => {
    const telefone = avulso()
    const cloud = cloudDouble()
    const whatsapp = whatsappGravado(cloud.whatsapp, servico.db)
    await whatsapp.enviarDocumento(telefone, { nome: 'nfse-123.pdf', tipo: 'application/pdf', conteudo: new Uint8Array([37, 80]) }, 'NFS-e nº 123 autorizada')
    await whatsapp.enviarModelo(telefone, 'nofiscal_resumo', ['Studio Lima', 'outubro'])

    expect(await mensagensDo(telefone)).toEqual([
      expect.objectContaining({ tipo: 'document', arquivo: 'nfse-123.pdf', texto: 'NFS-e nº 123 autorizada', wamid: cloud.ids[0], status: 'enviada', tenant_id: null }),
      expect.objectContaining({ tipo: 'template', arquivo: null, texto: 'nofiscal_resumo · Studio Lima · outubro', wamid: cloud.ids[1], status: 'enviada' }),
    ])
  })

  it('as tentativas do mesmo envio viram uma linha só; a que não sai fica com o erro da Meta', async () => {
    const telefone = avulso()
    const cloud = cloudDouble(2)
    const whatsapp = whatsappComRetentativa(whatsappGravado(cloud.whatsapp, servico.db))
    await whatsapp.enviarTexto(telefone, 'saiu na terceira')
    cloud.falharMais(3)
    await whatsapp.enviarTexto(telefone, 'não saiu')

    expect(await mensagensDo(telefone)).toEqual([
      expect.objectContaining({ texto: 'saiu na terceira', status: 'enviada', erro: null, wamid: cloud.ids[0] }),
      expect.objectContaining({ texto: 'não saiu', status: 'falhou', erro: 'HTTP 400 · 131026 · Message undeliverable', wamid: null }),
    ])
  })

  it('as marcas da Meta não voltam para trás, e a falha que chega depois fica na mensagem', async () => {
    const telefone = avulso()
    const r = robo()
    const whatsapp = whatsappGravado(r.cloud.whatsapp, servico.db)
    await whatsapp.enviarTexto(telefone, 'primeira')
    await whatsapp.enviarTexto(telefone, 'segunda')
    const [primeira, segunda] = r.cloud.ids

    for (const status of ['delivered', 'read', 'delivered']) {
      expect((await postar(notificacao(marcaDaMeta(primeira, status, telefone)), r.deps)).status).toBe(200)
    }
    const erro = [{ code: 131042, title: 'Business eligibility payment issue', error_data: { details: 'Sem forma de pagamento' } }]
    await postar(notificacao(marcaDaMeta(segunda, 'failed', telefone, erro)), r.deps)
    // Marca de uma mensagem que saiu por fora do app: a linha nasce com o que a marca diz.
    const externa = `wamid.externa-${randomBytes(6).toString('hex')}`
    await postar(notificacao(marcaDaMeta(externa, 'delivered', telefone)), r.deps)

    expect(await mensagensDo(telefone)).toEqual([
      expect.objectContaining({ texto: 'primeira', status: 'lida' }),
      expect.objectContaining({ texto: 'segunda', status: 'falhou', erro: '131042 · Sem forma de pagamento' }),
      expect.objectContaining({ wamid: externa, tipo: 'desconhecido', texto: null, status: 'entregue' }),
    ])
  })

  it('marca de outro número da conta é ignorada', async () => {
    const telefone = avulso()
    const r = robo()
    await whatsappGravado(r.cloud.whatsapp, servico.db).enviarTexto(telefone, 'oi')
    const corpo = notificacao(marcaDaMeta(r.cloud.ids[0], 'read', telefone)).replace(PHONE_NUMBER_ID, '1220974874440430')
    await postar(corpo, r.deps)
    expect(await mensagensDo(telefone)).toEqual([expect.objectContaining({ status: 'enviada' })])
  })

  it('a marca atrasada de uma conversa apagada não recria a conversa', async () => {
    const telefone = avulso()
    const r = robo()
    await postar(notificacao(marcaDaMeta(`wamid.apagada-${randomBytes(6).toString('hex')}`, 'read', telefone)), r.deps)
    expect(await mensagensDo(telefone)).toEqual([])
  })

  it('com a central fora do ar, o robô continua respondendo', async () => {
    const quebrado = {
      async query(): Promise<never> {
        throw new Error('relation "nofiscal.fiscal_conversations" does not exist')
      },
    }
    expect(await conversaAssumida(quebrado, avulso(), new Date())).toBe(false)
  })
})

describe('assumir e responder', () => {
  it('assumir deixa o robô quieto; a equipe responde pelo número do robô; devolver traz o robô de volta', async () => {
    const s = await cenario()
    const r = robo()
    await r.receber(s.ownerPhone, 'atendente')
    const equipe = cloudDouble()

    const assumida = await naCentral({ acao: 'assumir', telefone: s.ownerPhone }, equipe.whatsapp)
    expect(assumida.status).toBe(200)
    expect(assumida.corpo.aviso).toBe(true)
    expect(equipe.enviadas).toEqual([{ para: s.ownerPhone, texto: TEXTO_AO_ASSUMIR }])

    // Com a conversa assumida, nem a IA é chamada: o robô não responde.
    const antes = r.cloud.enviadas.length
    await r.receber(s.ownerPhone, 'quero emitir uma nota')
    expect(r.cloud.enviadas).toHaveLength(antes)

    const resposta = await naCentral({ acao: 'responder', telefone: s.ownerPhone, texto: 'Oi! Me conta o que aconteceu.' }, equipe.whatsapp)
    expect(resposta.status).toBe(200)

    const devolvida = await naCentral({ acao: 'devolver', telefone: s.ownerPhone }, equipe.whatsapp)
    expect(devolvida.status).toBe(200)
    expect(devolvida.corpo.aviso).toBe(true)
    await r.receber(s.ownerPhone, 'atendente')
    expect(r.respostasPara(s.ownerPhone)).toEqual([TEXTOS.chamouAEquipe, TEXTOS.chamouAEquipe])

    const linhas = await mensagensDo(s.ownerPhone)
    expect(linhas.map((l) => [l.direcao, l.autor, l.texto])).toEqual([
      ['entrada', 'cliente', 'atendente'],
      ['saida', 'robo', TEXTOS.chamouAEquipe],
      ['saida', 'equipe', TEXTO_AO_ASSUMIR],
      ['entrada', 'cliente', 'quero emitir uma nota'],
      ['saida', 'equipe', 'Oi! Me conta o que aconteceu.'],
      ['saida', 'robo', TEXTO_AO_DEVOLVER],
      ['entrada', 'cliente', 'atendente'],
      ['saida', 'robo', TEXTOS.chamouAEquipe],
    ])
    expect(linhas.filter((l) => l.autor === 'equipe').every((l) => l.user_id === ADMIN_ID)).toBe(true)
    expect(await eventosDo(s.ownerPhone)).toEqual(['pediu_atendente', 'equipe_assumiu', 'equipe_devolveu', 'pediu_atendente'])
  })

  it('a resposta da equipe que não sai devolve o prazo ao que era: o robô continua atendendo', async () => {
    const s = await cenario()
    const r = robo()
    await r.receber(s.ownerPhone, 'atendente')
    const resposta = await naCentral({ acao: 'responder', telefone: s.ownerPhone, texto: 'Oi!' }, cloudDouble(3).whatsapp)
    expect(resposta.status).toBe(502)
    expect(resposta.corpo.error?.code).toBe('ENVIO_FALHOU')

    await r.receber(s.ownerPhone, 'atendente')
    expect(r.respostasPara(s.ownerPhone)).toEqual([TEXTOS.chamouAEquipe, TEXTOS.chamouAEquipe])
    expect((await mensagensDo(s.ownerPhone)).filter((l) => l.autor === 'equipe')).toEqual([
      expect.objectContaining({ texto: 'Oi!', status: 'falhou', erro: 'HTTP 400 · 131026 · Message undeliverable' }),
    ])
    expect(await eventosDo(s.ownerPhone)).toEqual(['pediu_atendente', 'pediu_atendente'])
  })

  it('com a conversa já assumida, a resposta que não sai mantém o robô quieto', async () => {
    const s = await cenario()
    const r = robo()
    await r.receber(s.ownerPhone, 'atendente')
    expect((await naCentral({ acao: 'assumir', telefone: s.ownerPhone }, cloudDouble().whatsapp)).status).toBe(200)
    expect((await naCentral({ acao: 'responder', telefone: s.ownerPhone, texto: 'Oi!' }, cloudDouble(3).whatsapp)).status).toBe(502)

    await r.receber(s.ownerPhone, 'atendente')
    expect(r.respostasPara(s.ownerPhone)).toEqual([TEXTOS.chamouAEquipe])
  })

  it('o robô volta sozinho 2 horas depois da última mensagem da equipe', async () => {
    const s = await cenario()
    const r = robo()
    await r.receber(s.ownerPhone, 'atendente')
    await naCentral({ acao: 'responder', telefone: s.ownerPhone, texto: 'Estou por aqui.' }, cloudDouble().whatsapp)

    r.avancar(PRAZO_DA_EQUIPE_MS - 60_000)
    await r.receber(s.ownerPhone, 'atendente')
    expect(r.respostasPara(s.ownerPhone)).toHaveLength(1)

    r.avancar(2 * 60_000)
    await r.receber(s.ownerPhone, 'atendente')
    expect(r.respostasPara(s.ownerPhone)).toHaveLength(2)
  })

  it('fora da janela de 24 horas a resposta é recusada e o "assumir" não avisa o cliente', async () => {
    const telefone = avulso()
    await admin.db.query(
      `insert into nofiscal.fiscal_messages (phone_e164, endereco, direcao, autor, tipo, texto, wamid, created_at)
       values ($1, $1, 'entrada', 'cliente', 'text', 'oi', $2, now() - interval '25 hours')`,
      [telefone, novoId()],
    )
    const equipe = cloudDouble()
    const assumida = await naCentral({ acao: 'assumir', telefone }, equipe.whatsapp)
    expect(assumida.status).toBe(200)
    expect(assumida.corpo.aviso).toBeNull()

    const resposta = await naCentral({ acao: 'responder', telefone, texto: 'oi' }, equipe.whatsapp)
    expect(resposta.status).toBe(409)
    expect(resposta.corpo.error?.code).toBe('JANELA_FECHADA')
    expect(equipe.enviadas).toEqual([])
  })

  it('a tela lê a lista com as etiquetas e a conversa aberta', async () => {
    const s = await cenario()
    const r = robo()
    await r.receber(s.ownerPhone, 'atendente')

    const lida = await naCentral({ acao: 'ler', telefone: s.ownerPhone }, null)
    expect(lida.status).toBe(200)
    const resumo = lida.corpo.conversas?.find((c) => c.telefone === s.ownerPhone)
    expect(resumo?.empresa).toMatch(/^Studio Central /)
    expect(resumo?.etiquetas).toEqual(['pediu_atendente'])
    expect(lida.corpo.conversa).toEqual(
      expect.objectContaining({
        telefone: s.ownerPhone,
        papel: 'owner',
        janela: expect.objectContaining({ aberta: true }),
        assumida_ate: null,
        eventos: [expect.objectContaining({ tipo: 'pediu_atendente' })],
      }),
    )
    expect(lida.corpo.conversa?.mensagens.map((m) => m.texto)).toEqual(['atendente', TEXTOS.chamouAEquipe])
  })

  it('só administrador com segundo fator usa a central', async () => {
    const telefone = avulso()
    expect((await naCentral(null, null, 'cliente')).status).toBe(401)
    expect((await naCentral({ acao: 'assumir', telefone }, null, 'cliente')).status).toBe(401)
  })
})

describe('sessão de administrador', () => {
  const id = randomUUID()
  const token = (claims: Record<string, unknown>) => `cabeca.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.assinatura`
  const verificar = (claims: Record<string, unknown>, role: string, ok = true) =>
    supabaseAdminVerifier({
      url: 'https://auth.test',
      anonKey: 'anon',
      fetch: async () => (ok ? Response.json({ id, app_metadata: { role } }) : new Response('{}', { status: 401 })),
    }).adminIdFrom(new Request('https://app.test', { headers: { authorization: `Bearer ${token(claims)}` } }))

  it('NO_ADMIN com aal2 entra; sem o segundo fator, outro papel, outro usuário ou token recusado, não', async () => {
    expect(await verificar({ sub: id, aal: 'aal2' }, 'NO_ADMIN')).toBe(id)
    expect(await verificar({ sub: id, aal: 'aal1' }, 'NO_ADMIN')).toBeNull()
    expect(await verificar({ sub: id, aal: 'aal2' }, 'CLIENT')).toBeNull()
    expect(await verificar({ sub: randomUUID(), aal: 'aal2' }, 'NO_ADMIN')).toBeNull()
    expect(await verificar({ sub: id, aal: 'aal2' }, 'NO_ADMIN', false)).toBeNull()
  })
})

describe('alertas, Apagar conta e retenção', () => {
  it('pedido de atendente, IA que falhou e envio que não saiu vão num e-mail só, uma vez', async () => {
    const s = await cenario()
    const r = robo()
    await r.receber(s.ownerPhone, 'atendente')
    // Texto fora do roteiro: o dublê da IA falha, como a IA fora do ar.
    await r.receber(s.ownerPhone, 'faz aquela nota de sempre')
    await admin.db.query(
      `insert into nofiscal.fiscal_messages (phone_e164, endereco, tenant_id, direcao, autor, tipo, texto, status, erro, updated_at)
       values ($1, $1, $2, 'saida', 'robo', 'text', 'NFS-e nº 9', 'falhou', '131042 · Sem forma de pagamento', now() - interval '2 minutes')`,
      [s.ownerPhone, s.tenant.id],
    )
    const email = canaisDouble()
    expect(await enviarAlertasDaCentral({ db: servico.db, email: email.email }, { tenantIds: [s.tenant.id] })).toBe(0)

    const deps = { db: servico.db, email: email.email, alertaEmail: 'alertas@example.test' }
    expect(await enviarAlertasDaCentral(deps, { tenantIds: [s.tenant.id] })).toBe(3)
    expect(email.emails).toHaveLength(1)
    const [aviso] = email.emails
    expect(aviso.para).toBe('alertas@example.test')
    expect(aviso.assunto).toBe('nó.fiscal: 3 alertas na central de conversas')
    for (const trecho of ['pediu atendente', 'a IA falhou', 'o envio falhou · 131042 · Sem forma de pagamento', URL_DA_CENTRAL]) {
      expect(aviso.texto).toContain(trecho)
    }
    // O detalhe do evento fica só na central.
    expect(aviso.texto).not.toContain('na mensagem nova')
    expect(await enviarAlertasDaCentral(deps, { tenantIds: [s.tenant.id] })).toBe(0)
    expect(email.emails).toHaveLength(1)
  })

  it('e-mail que não sai deixa os alertas para a rodada seguinte, com a mesma chave de idempotência', async () => {
    const s = await cenario()
    const r = robo()
    await r.receber(s.ownerPhone, 'atendente')
    const chaves: string[] = []
    let foraDoAr = true
    const email: EnviaEmail = {
      async enviar(mensagem) {
        chaves.push(mensagem.idempotencia ?? '')
        if (foraDoAr) throw new Error('Resend fora do ar')
      },
    }
    const deps = { db: servico.db, email, alertaEmail: 'alertas@example.test' }
    expect(await enviarAlertasDaCentral(deps, { tenantIds: [s.tenant.id] })).toBe(0)
    expect(chaves).toHaveLength(3)

    foraDoAr = false
    expect(await enviarAlertasDaCentral(deps, { tenantIds: [s.tenant.id] })).toBe(1)
    expect(new Set(chaves).size).toBe(1)
    expect(await enviarAlertasDaCentral(deps, { tenantIds: [s.tenant.id] })).toBe(0)
    expect(chaves).toHaveLength(4)
  })

  it('quem não tem conta aparece no e-mail só pelos 4 últimos dígitos', async () => {
    const telefone = avulso()
    await admin.db.query(
      `insert into nofiscal.fiscal_messages (phone_e164, endereco, direcao, autor, tipo, texto, status, erro, updated_at)
       values ($1, $1, 'saida', 'robo', 'text', 'oi', 'falhou', 'HTTP 400 · 131026', now() - interval '2 minutes')`,
      [telefone],
    )
    // Sem filtro de empresa: pode haver alertas antigos do banco local na frente; esvazia a fila.
    const email = canaisDouble()
    while ((await enviarAlertasDaCentral({ db: servico.db, email: email.email, alertaEmail: 'alertas@example.test' })) > 0);
    const texto = email.emails.map((e) => e.texto).join('\n')
    expect(texto).toContain(`número terminado em ${telefone.slice(-4)} (sem conta) · o envio falhou · HTTP 400 · 131026`)
    expect(texto).not.toContain(telefone)
  })

  it('o e-mail de alerta não leva o tomador, o texto da Sefin nem o CPF da razão social de MEI', async () => {
    const s = await cenario('JOAO DA SILVA 12345678900')
    await registrarEvento(servico.db, s.ownerPhone, 'sefin_recusou', { detalhe: 'nota para Maria Souza · código E0310: CPF do tomador inválido' })
    const email = canaisDouble()
    expect(await enviarAlertasDaCentral({ db: servico.db, email: email.email, alertaEmail: 'alertas@example.test' }, { tenantIds: [s.tenant.id] })).toBe(1)
    const [aviso] = email.emails
    expect(aviso.texto).toContain('JOAO DA SILVA · a Sefin recusou')
    for (const dado of ['12345678900', 'Maria Souza', 'E0310', s.ownerPhone]) expect(aviso.texto).not.toContain(dado)
  })

  it('"Apagar conta" apaga as mensagens e os eventos do número', async () => {
    const s = await cenario()
    const r = robo()
    await r.receber(s.ownerPhone, 'atendente')
    expect((await mensagensDo(s.ownerPhone)).length).toBeGreaterThan(0)

    await admin.db.query('select public.fiscal_apagar_conta($1)', [s.ownerUserId])
    expect(await mensagensDo(s.ownerPhone)).toEqual([])
    expect(await eventosDo(s.ownerPhone)).toEqual([])
  })

  it('mensagens com mais de 90 dias saem do banco', async () => {
    const s = await cenario()
    for (const [texto, dias] of [['antiga', 91], ['recente', 1]] as const) {
      await admin.db.query(
        `insert into nofiscal.fiscal_messages (phone_e164, tenant_id, direcao, autor, tipo, texto, wamid, created_at)
         values ($1, $2, 'entrada', 'cliente', 'text', $3, $4, now() - make_interval(days => $5))`,
        [s.ownerPhone, s.tenant.id, texto, novoId(), dias],
      )
    }
    expect(await apagarConversasAntigas(servico.db, new Date(), { tenantIds: [s.tenant.id] })).toBe(1)
    expect((await mensagensDo(s.ownerPhone)).map((m) => m.texto)).toEqual(['recente'])
  })
})
