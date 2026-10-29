// Conversa do agente no WhatsApp. Checks C14–C21, C24, C30–C34 e C39 de
// .checks/agente-fiscal-whatsapp.md. O código sob teste conecta como `nofiscal_service`;
// a IA, o WhatsApp, o e-mail e a Sefin são dublês, e nada sai da máquina.
import { randomUUID } from 'node:crypto'
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
  mensagemDeArquivo,
  mensagemDeTexto,
  notasDoAgente,
  openRoleDb,
  pedidosDo,
  randomPhone,
  rodarWorker,
  type SelfServiceOptions,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { sharedTestCertificate } from '../../_tests/certs.js'
import { openTestDb, sefinDouble } from '../../_tests/fixtures.js'
import { fakeSefin } from '../../_tests/sefin-fake.js'
import { createSefinClient } from '../sefin-client.js'
import { DESCRICAO_PADRAO, ehPedidoDeAtendimento, expirarPedidos, processarMensagem, TEXTOS, WHATSAPP_COMERCIAL, type ConversaDeps } from './conversa.js'
import type { Parsed } from './interprete.js'
import { comNonoDigito } from './normalizacao.js'
import { mensagensDaNotificacao } from './webhook.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []
const HORA = 3600_000

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

type Assinatura = 'paga' | 'recusada' | 'nenhuma'

async function cenario(opcoes: SelfServiceOptions & { assinatura?: Assinatura } = {}): Promise<SelfServiceTenant> {
  const s = await createSelfServiceTenant(admin.db, opcoes)
  tenants.push(s)
  if ((opcoes.assinatura ?? 'paga') !== 'nenhuma') {
    await assinarTenant(admin.db, s.tenant.id, { status: opcoes.assinatura === 'recusada' ? 'recusada' : 'paga' })
  }
  return s
}

type Roteiro = Record<string, Partial<Parsed> & Record<string, unknown>>

function conversa(roteiro: Roteiro, extra: Partial<ConversaDeps> = {}, tokens?: { entrada: number; saida: number }) {
  const canais = canaisDouble()
  const ia = interpreteDouble(roteiro, tokens)
  let agora = new Date()
  const deps: ConversaDeps = {
    db: servico.db,
    whatsapp: canais.whatsapp,
    interprete: ia.interprete,
    links: LINKS_DE_TESTE,
    now: () => agora,
    ...extra,
  }
  return {
    canais,
    ia,
    deps,
    agora: () => agora,
    avancar(ms: number) {
      agora = new Date(agora.getTime() + ms)
    },
    enviar: (de: string, texto: string) => processarMensagem(deps, mensagemDeTexto(de, texto)),
    /** Respostas de WhatsApp a um número, na ordem. */
    respostasPara: (para: string) => canais.whatsapps.filter((m) => m.para === para).map((m) => m.texto),
    ultimaPara(para: string) {
      const todas = canais.whatsapps.filter((m) => m.para === para)
      return todas.at(-1)?.texto ?? ''
    },
  }
}

const PRONTIA_CNPJ = { nome: 'Prontia', documento: '12345678000195', nomeTomador: 'Prontia Saúde', email: 'financeiro@prontia.test', descricao: 'Consultoria em saúde' }
const PRONTIA_CPF = { nome: 'Prontia', documento: '52998224725', nomeTomador: 'Prontia Saúde', email: 'financeiro@prontia.test', descricao: 'Consultoria em saúde' }
const PEDIDO_PRONTIA = 'nota pra Prontia Saúde, 10 reais'
const ROTEIRO_PRONTIA: Roteiro = { [PEDIDO_PRONTIA]: { tomador: 'Prontia Saúde', valor: '10.00', intencao: 'emitir' } }

async function linhaDaNota(id: string) {
  const { rows } = await admin.db.query<{ status: string; tenant_id: string; external_id: string; payload: Record<string, unknown> }>(
    'select status, tenant_id, external_id, payload from nofiscal.fiscal_invoices where id = $1',
    [id],
  )
  return rows[0]
}

/** Nota emitida gravada direto (para os testes de cancelamento). */
async function notaEmitida(
  s: SelfServiceTenant,
  opcoes: { numero: number; nome?: string; cpf?: string; email?: string; valor?: string; emitidaEm?: Date },
): Promise<string> {
  const { rows } = await admin.db.query<{ id: string }>(
    `insert into nofiscal.fiscal_invoices
       (tenant_id, external_id, payload, status, dps_serie, dps_numero, chave_acesso, issued_at)
     values ($1, $2, $3::jsonb, 'issued', '1', $4, $5, $6) returning id`,
    [
      s.tenant.id,
      `emitida-${randomUUID()}`,
      JSON.stringify({
        tomador: { cpf: opcoes.cpf ?? '52998224725', nome: opcoes.nome ?? 'Prontia Saúde', email: opcoes.email ?? 'financeiro@prontia.test' },
        servico: { codigo_servico_nacional: '010701', descricao: 'Consultoria em saúde' },
        valor: opcoes.valor ?? '42.90',
      }),
      opcoes.numero,
      `CHAVE${randomUUID().replace(/-/g, '')}`,
      opcoes.emitidaEm ?? new Date(),
    ],
  )
  return rows[0].id
}

const dataLocal = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d)

describe('conversa no WhatsApp', () => {
  it('pagamento recusado bloqueia emissão', async () => {
    const s = await cenario({ assinatura: 'recusada' })
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA)

    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    const resposta = c.ultimaPara(s.ownerPhone)
    expect(resposta).toContain('Seu pagamento não foi aprovado. Atualize o cartão para continuar emitindo')
    expect(resposta).toContain(LINKS_DE_TESTE.assinatura)
    expect(resposta).not.toContain('Posso emitir?')
    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(0)
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)

    // Teste vencido sem cobrança aprovada: mesmo bloqueio.
    const t = await cenario({ assinatura: 'nenhuma' })
    await assinarTenant(admin.db, t.tenant.id, { status: 'pendente', trialEndsAt: new Date(Date.now() - HORA) })
    await criarModelo(admin.db, t.tenant.id, PRONTIA_CNPJ)
    await c.enviar(t.ownerPhone, PEDIDO_PRONTIA)
    expect(c.ultimaPara(t.ownerPhone)).toContain('Seu pagamento não foi aprovado')
    expect(await pedidosDo(admin.db, t.tenant.id)).toHaveLength(0)

    // Pagamento recusado entre o resumo e o "confirmar": nenhuma nota.
    const u = await cenario()
    await criarModelo(admin.db, u.tenant.id, PRONTIA_CNPJ)
    await c.enviar(u.ownerPhone, PEDIDO_PRONTIA)
    expect(c.ultimaPara(u.ownerPhone)).toContain('Posso emitir?')
    await admin.db.query(`update nofiscal.fiscal_subscriptions set status = 'recusada' where tenant_id = $1`, [u.tenant.id])
    await c.enviar(u.ownerPhone, 'confirmar')
    expect(c.ultimaPara(u.ownerPhone)).toContain('Seu pagamento não foi aprovado')
    expect(await notasDoAgente(admin.db, u.tenant.id)).toHaveLength(0)
    expect((await pedidosDo(admin.db, u.tenant.id))[0].status).not.toBe('confirmed')
  })

  // Lucca, 22/10/2026: o número fica preso à conta desde a ativação; não há login no WhatsApp nem prazo. O WhatsApp
  // pode mandar o celular sem o nono dígito (wa_id antigo): o bot casa com o 9 e responde no endereço que chegou.
  it('o número do dono é reconhecido 15 dias depois, mesmo sem o nono dígito', async () => {
    const s = await cenario()
    const comNove = `+551198${String(Date.now()).slice(-7)}`
    const semNove = comNove.replace(/^\+55119/, '+5511')
    await admin.db.query('update nofiscal.fiscal_phones set phone_e164 = $2 where phone_e164 = $1', [s.ownerPhone, comNove])
    await admin.db.query('update nofiscal.fiscal_accounts set phone_e164 = $2 where phone_e164 = $1', [s.ownerPhone, comNove])
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA)
    c.avancar(15 * 24 * 3600_000)

    // A mensagem passa pelo leitor do webhook, como chega da Meta.
    const daMeta = (texto: string) =>
      mensagensDaNotificacao({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ value: { messages: [{ id: `wamid.nove-${randomUUID()}`, from: semNove.slice(1), type: 'text', text: { body: texto } }] } }] }],
      })[0]
    const pedido = daMeta(PEDIDO_PRONTIA)
    expect(pedido).toMatchObject({ de: comNove, enderecoRecebido: semNove })
    await processarMensagem(c.deps, pedido)
    expect(c.ultimaPara(semNove)).toContain('Posso emitir?')
    expect(c.respostasPara(comNove)).toEqual([])
    await processarMensagem(c.deps, daMeta('confirmar'))
    expect(c.ultimaPara(semNove)).toBe(TEXTOS.emitindo)
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(1)
  })

  it('nono dígito: só celular sem o 9 ganha o 9', () => {
    expect(comNonoDigito('+551187654321')).toBe('+5511987654321')
    expect(comNonoDigito('+5511987654321')).toBe('+5511987654321')
    expect(comNonoDigito('+551132654321')).toBe('+551132654321')
    expect(comNonoDigito('+12025550123')).toBe('+12025550123')
  })

  it('resumo antes de emitir', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA)

    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    const resumo = c.ultimaPara(s.ownerPhone)
    expect(resumo).toContain('Prontia Saúde')
    expect(resumo).toContain('12.345.678/0001-95')
    expect(resumo).toContain('01.07.01')
    expect(resumo).toContain('Consultoria em saúde')
    expect(resumo).toContain('R$ 10,00')
    expect(resumo).toContain('Posso emitir?')

    const pedidos = await pedidosDo(admin.db, s.tenant.id)
    expect(pedidos).toHaveLength(1)
    expect(pedidos[0]).toMatchObject({ kind: 'emitir', status: 'awaiting_confirmation', invoice_id: null })
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)

    // "descartar" desiste do pedido sem nota ("corrigir" agora mantém o pedido: teste abaixo).
    await c.enviar(s.ownerPhone, 'descartar')
    expect((await pedidosDo(admin.db, s.tenant.id))[0].status).toBe('rejected_by_user')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.descartado)
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
  })

  // Roteiro do bot (Lucca, 22/10/2026): "corrigir" pergunta o que muda e mantém o resto do pedido.
  it('corrigir troca o valor e mantém o pedido', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa({ ...ROTEIRO_PRONTIA, 'valor 400 reais': { valor: '400.00', intencao: 'outro' }, hmm: { intencao: 'outro' } })

    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    await c.enviar(s.ownerPhone, 'corrigir')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.oQueMuda)
    const [aberto] = await pedidosDo(admin.db, s.tenant.id)
    expect(aberto.status).toBe('awaiting_confirmation')

    await c.enviar(s.ownerPhone, 'hmm')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.naoEntendiACorrecao)

    await c.enviar(s.ownerPhone, 'valor 400 reais')
    const resumo = c.ultimaPara(s.ownerPhone)
    expect(resumo).toContain('R$ 400,00')
    expect(resumo).toContain('Prontia Saúde')
    expect(resumo).toContain('Posso emitir?')
    const pedidos = await pedidosDo(admin.db, s.tenant.id)
    expect(pedidos).toHaveLength(1)

    await c.enviar(s.ownerPhone, 'confirmar')
    const [nota] = await notasDoAgente(admin.db, s.tenant.id)
    expect(nota).toBeTruthy()
    expect(nota.payload).toMatchObject({ valor: '400.00' })
  })

  it('corrigir troca o cliente: o pedido antigo sai e o novo nasce com o mesmo valor', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa({ ...ROTEIRO_PRONTIA, 'é pra Clínica Aurora': { tomador: 'Clínica Aurora', intencao: 'outro' } })

    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    await c.enviar(s.ownerPhone, 'corrigir')
    await c.enviar(s.ownerPhone, 'é pra Clínica Aurora')
    expect(c.ultimaPara(s.ownerPhone)).toBe('É a primeira nota para Clínica Aurora. Me mande o CPF ou CNPJ e o e-mail de Clínica Aurora.')
    const pedidos = await pedidosDo(admin.db, s.tenant.id)
    expect(pedidos.map((p) => p.status).sort()).toEqual(['awaiting_confirmation', 'rejected_by_user'])
  })

  it('"cancelar" no resumo da nota desiste do pedido', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA)
    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    await c.enviar(s.ownerPhone, 'cancelar')
    expect((await pedidosDo(admin.db, s.tenant.id))[0].status).toBe('rejected_by_user')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.descartado)
  })

  it('confirmar chama o motor', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA)

    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.ultimaPara(s.ownerPhone)).toBe('Emitindo na Sefin. Em instantes mando a nota aqui e no seu e-mail.')

    const [pedido] = await pedidosDo(admin.db, s.tenant.id)
    expect(pedido.status).toBe('confirmed')
    expect(pedido.invoice_id).not.toBeNull()
    const nota = await linhaDaNota(pedido.invoice_id as string)
    expect(nota).toMatchObject({ status: 'queued', tenant_id: s.tenant.id, external_id: pedido.id })
    expect(nota.payload).toEqual({
      tomador: { cnpj: '12345678000195', nome: 'Prontia Saúde', email: 'financeiro@prontia.test' },
      servico: { codigo_servico_nacional: '010701', descricao: 'Consultoria em saúde' },
      valor: '10.00',
    })
    // "confirmar" é lido pelo código, nunca pela IA.
    expect(c.ia.chamadas).toEqual([PEDIDO_PRONTIA])

    // Um segundo "confirmar" não cria outra nota.
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(1)
  })

  it('tomador novo pede documento', async () => {
    const s = await cenario()
    const c = conversa(
      {
        'nota pra Clínica Nova, 150 reais': { tomador: 'Clínica Nova', valor: '150.00', intencao: 'emitir' },
        'nota pra Hospital Alfa, 80 reais': { tomador: 'Hospital Alfa', valor: '80.00', intencao: 'emitir' },
      },
      { consultaCnpj: { async razaoSocial(cnpj) { return cnpj === '11444777000161' ? 'HOSPITAL ALFA LTDA' : null } } },
    )

    // CPF: o nome é o que a pessoa escreveu.
    await c.enviar(s.ownerPhone, 'nota pra Clínica Nova, 150 reais')
    const pergunta = c.ultimaPara(s.ownerPhone)
    expect(pergunta).toContain('CPF ou CNPJ')
    expect(pergunta).toContain('e-mail')
    expect(pergunta).not.toContain('Posso emitir?')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)

    // Só o e-mail ainda não basta.
    await c.enviar(s.ownerPhone, 'contato@clinicanova.test')
    expect(c.ultimaPara(s.ownerPhone)).toContain('CPF ou CNPJ')
    expect(c.ultimaPara(s.ownerPhone)).not.toContain('Posso emitir?')

    await c.enviar(s.ownerPhone, '529.982.247-25')
    // Sem descrição no pedido, a pergunta da descrição vem antes do resumo (Lucca, 30/10/2026).
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.perguntaDeDescricao)
    await c.enviar(s.ownerPhone, 'padrão')
    const resumo = c.ultimaPara(s.ownerPhone)
    expect(resumo).toContain('Clínica Nova')
    expect(resumo).toContain('529.982.247-25')
    expect(resumo).toContain('R$ 150,00')
    expect(resumo).toContain('Posso emitir?')

    // CNPJ: o nome vem dos dados públicos.
    await c.enviar(s.ownerPhone, 'nota pra Hospital Alfa, 80 reais')
    expect(c.ultimaPara(s.ownerPhone)).toContain('CPF ou CNPJ')
    await c.enviar(s.ownerPhone, 'CNPJ 11.444.777/0001-61, compras@alfa.test')
    await c.enviar(s.ownerPhone, 'padrão')
    const resumoCnpj = c.ultimaPara(s.ownerPhone)
    expect(resumoCnpj).toContain('HOSPITAL ALFA LTDA')
    expect(resumoCnpj).toContain('11.444.777/0001-61')
    expect(resumoCnpj).toContain('Posso emitir?')

    // Documento e e-mail não passam pela IA.
    expect(c.ia.chamadas).toEqual(['nota pra Clínica Nova, 150 reais', 'nota pra Hospital Alfa, 80 reais'])

    await c.enviar(s.ownerPhone, 'confirmar')
    const notas = await notasDoAgente(admin.db, s.tenant.id)
    expect(notas).toHaveLength(1)
    expect(notas[0].payload).toMatchObject({ tomador: { cnpj: '11444777000161', nome: 'HOSPITAL ALFA LTDA', email: 'compras@alfa.test' } })
  })

  it('falta dado', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa({
      'nota pra Prontia': { tomador: 'Prontia', intencao: 'emitir' },
      'uma nota de 10 reais': { valor: '10.00', intencao: 'emitir' },
      'quero emitir uma nota': { intencao: 'emitir' },
      'nota pra Prontia, dez mil reais e uns trocados': { tomador: 'Prontia', valor: 'dez mil', intencao: 'emitir' },
    })

    await c.enviar(s.ownerPhone, 'nota pra Prontia')
    expect(c.ultimaPara(s.ownerPhone)).toMatch(/^Qual é o valor da nota\?/)
    await c.enviar(s.ownerPhone, 'uma nota de 10 reais')
    expect(c.ultimaPara(s.ownerPhone)).toMatch(/^Para quem é a nota\?/)
    await c.enviar(s.ownerPhone, 'quero emitir uma nota')
    expect(c.ultimaPara(s.ownerPhone)).toMatch(/^Para quem é a nota e qual é o valor\?/)
    // Valor que não é número (a IA errou) conta como falta.
    await c.enviar(s.ownerPhone, 'nota pra Prontia, dez mil reais e uns trocados')
    expect(c.ultimaPara(s.ownerPhone)).toMatch(/^Qual é o valor da nota\?/)

    for (const resposta of c.respostasPara(s.ownerPhone)) expect(resposta).not.toContain('Posso emitir?')
    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(0)
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
  })

  it('pedido expira em 24h', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA)

    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    const [pedido] = await pedidosDo(admin.db, s.tenant.id)
    expect(pedido.expires_at.getTime()).toBe(c.agora().getTime() + 24 * HORA)

    c.avancar(24 * HORA + 1000)
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.ultimaPara(s.ownerPhone)).toBe('Esse pedido expirou. Me mande o pedido de novo.')
    expect((await pedidosDo(admin.db, s.tenant.id))[0].status).toBe('expired')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)

    // A tarefa agendada também expira, e o "confirmar" depois dela recebe a mesma resposta.
    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    c.avancar(25 * HORA)
    // Restrita ao tenant: com o relógio adiantado, a tarefa expiraria os pedidos dos outros testes.
    expect(await expirarPedidos(servico.db, c.agora(), { tenantIds: [s.tenant.id] })).toBe(1)
    expect((await pedidosDo(admin.db, s.tenant.id))[1].status).toBe('expired')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.ultimaPara(s.ownerPhone)).toBe('Esse pedido expirou. Me mande o pedido de novo.')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
  })

  it('número não autorizado', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA)

    const desconhecido = randomPhone()
    const revogado = randomPhone()
    const pendente = randomPhone()
    await admin.db.query(
      `insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role, verified_at, revoked_at)
       values ($1, $2, 'authorized', now() - interval '2 days', now() - interval '1 day'),
              ($1, $3, 'authorized', null, null)`,
      [s.tenant.id, revogado, pendente],
    )

    for (const numero of [desconhecido, revogado, pendente]) {
      await c.enviar(numero, PEDIDO_PRONTIA)
      const resposta = c.ultimaPara(numero)
      expect(resposta).toContain(LINKS_DE_TESTE.site)
      expect(resposta).toContain('alguém da nossa equipe te responde por aqui')
      expect(resposta).not.toContain('Posso emitir?')
    }
    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(0)
    // Nem a IA vê a mensagem de quem não pode emitir.
    expect(c.ia.chamadas).toEqual([])

    // Lucca, 22/10/2026: o número é o mesmo do atendimento. No resto do dia o bot fica quieto e a equipe conversa;
    // no dia seguinte, a primeira mensagem recebe a resposta de novo.
    await c.enviar(desconhecido, 'oi, vocês fazem site também?')
    await c.enviar(desconhecido, 'obrigado!')
    expect(c.respostasPara(desconhecido)).toHaveLength(1)
    c.avancar(24 * 3600_000)
    await c.enviar(desconhecido, 'bom dia')
    expect(c.respostasPara(desconhecido)).toHaveLength(2)
  })

  it('número não autorizado: envio que falha não gasta a resposta do dia', async () => {
    // 30/10/2026: o envio falhou (número errado na Cloud API) e a marca do dia ficou, então a pessoa não teve
    // resposta nenhuma naquele dia. A resposta só conta se saiu.
    const canais = canaisDouble()
    let falhar = true
    const whatsapp = {
      ...canais.whatsapp,
      async enviarTexto(para: string, texto: string) {
        if (falhar) throw new Error('Cloud API fora')
        await canais.whatsapp.enviarTexto(para, texto)
      },
    }
    const c = conversa(ROTEIRO_PRONTIA, { whatsapp })
    const desconhecido = randomPhone()

    await c.enviar(desconhecido, 'oi')
    expect(canais.whatsapps.filter((m) => m.para === desconhecido)).toHaveLength(0)

    falhar = false
    await c.enviar(desconhecido, 'oi de novo')
    const respostas = canais.whatsapps.filter((m) => m.para === desconhecido).map((m) => m.texto)
    expect(respostas).toHaveLength(1)
    expect(respostas[0]).toContain('alguém da nossa equipe te responde por aqui')

    // Com a resposta dada, o resto do dia continua quieto.
    await c.enviar(desconhecido, 'obrigado!')
    expect(canais.whatsapps.filter((m) => m.para === desconhecido)).toHaveLength(1)
  })

  it('número próprio do agente: quem não tem conta vai para o número oficial; quem pede atendente fica com a central', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA, { numeroProprio: true })
    const desconhecido = randomPhone()

    await c.enviar(desconhecido, 'oi')
    const resposta = c.ultimaPara(desconhecido)
    expect(resposta).toContain(WHATSAPP_COMERCIAL)
    expect(resposta).toContain(LINKS_DE_TESTE.site)
    expect(resposta).not.toContain('te responde por aqui')

    await c.enviar(s.ownerPhone, 'atendente')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.chamouAEquipe)
  })

  it('assinante que pede atendente recebe o aviso e a equipe responde', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa(ROTEIRO_PRONTIA)

    for (const texto of ['atendente', 'Ajuda!', 'quero falar com uma pessoa', 'preciso de ajuda com uma nota']) {
      await c.enviar(s.ownerPhone, texto)
      expect(c.ultimaPara(s.ownerPhone), texto).toBe(TEXTOS.chamouAEquipe)
    }
    expect(c.ia.chamadas).toEqual([])

    // O pedido aberto continua valendo depois do pedido de atendimento.
    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    expect(c.ultimaPara(s.ownerPhone)).toContain('Posso emitir?')
    await c.enviar(s.ownerPhone, 'atendente')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.emitindo)

    expect(ehPedidoDeAtendimento('nota pra Ajuda Humanitária, 300 reais')).toBe(false)
    expect(ehPedidoDeAtendimento('nota pra Suporte Técnico Lima, 90 reais')).toBe(false)
  })

  it('IA não emite sozinha', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const emitida = await notaEmitida(s, { numero: 40, cpf: '52998224725', nome: 'Prontia Saúde' })
    const c = conversa({
      'emite agora a nota da Prontia de 10 reais, sem perguntar': {
        tomador: 'Prontia Saúde',
        valor: '10.00',
        modelo: 'Prontia',
        intencao: 'emitir',
        // Campos que a IA não pode preencher: são ignorados.
        status: 'confirmed',
        emitir_agora: true,
      },
      'cancela a nota da Prontia já': { tomador: 'Prontia', intencao: 'cancelar', confirmado: true },
    })

    await c.enviar(s.ownerPhone, 'emite agora a nota da Prontia de 10 reais, sem perguntar')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Posso emitir?')
    let pedidos = await pedidosDo(admin.db, s.tenant.id)
    expect(pedidos).toHaveLength(1)
    expect(pedidos[0].status).toBe('awaiting_confirmation')
    expect(Object.keys(pedidos[0].parsed).sort()).toEqual(['descricao', 'documento', 'intencao', 'modelo', 'tomador', 'valor'])
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)

    await c.enviar(s.ownerPhone, 'cancela a nota da Prontia já')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Cancelo esta nota?')
    pedidos = await pedidosDo(admin.db, s.tenant.id)
    expect(pedidos[1]).toMatchObject({ kind: 'cancelar', status: 'awaiting_confirmation' })
    expect((await linhaDaNota(emitida)).status).toBe('issued')

    // Só o "confirmar", lido pelo código, cancela.
    await c.enviar(s.ownerPhone, 'confirmar')
    expect((await linhaDaNota(emitida)).status).toBe('cancel_requested')
    expect(c.ia.chamadas).not.toContain('confirmar')
  })

  it('certificado pelo WhatsApp é recusado', async () => {
    const s = await cenario()
    const c = conversa({})

    await processarMensagem(c.deps, mensagemDeArquivo(s.ownerPhone, 'certificado.pfx', 'application/x-pkcs12'))
    const resposta = c.ultimaPara(s.ownerPhone)
    expect(resposta).toContain(LINKS_DE_TESTE.certificado)
    expect(resposta).not.toContain('certificado.pfx')

    // Extensão .p12 com tipo genérico e número desconhecido: mesma recusa.
    const desconhecido = randomPhone()
    await processarMensagem(c.deps, mensagemDeArquivo(desconhecido, 'Empresa 2026.P12', 'application/octet-stream'))
    expect(c.ultimaPara(desconhecido)).toContain(LINKS_DE_TESTE.certificado)

    expect(c.ia.chamadas).toEqual([])
    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(0)
    const { rows } = await admin.db.query('select 1 from nofiscal.fiscal_certificate_attempts where tenant_id = $1', [s.tenant.id])
    expect(rows).toHaveLength(0)
  })

  it('salvar modelo', async () => {
    const s = await cenario({ certificado: sharedTestCertificate().certificado })
    const c = conversa({ 'nota pra Clínica Nova, 150 reais': { tomador: 'Clínica Nova', valor: '150.00', intencao: 'emitir' } })
    const sefin = createSefinClient({ transport: fakeSefin().transport })

    await c.enviar(s.ownerPhone, 'nota pra Clínica Nova, 150 reais')
    await c.enviar(s.ownerPhone, '529.982.247-25 contato@clinicanova.test')
    await c.enviar(s.ownerPhone, 'padrão')
    await c.enviar(s.ownerPhone, 'confirmar')
    // Antes de a nota sair, nenhuma oferta.
    expect(c.respostasPara(s.ownerPhone).some((t) => t.includes('para as próximas notas'))).toBe(false)

    await rodarWorker(servico.db, { sefin, tenantId: s.tenant.id, canais: c.canais, now: c.agora })
    const [nota] = await notasDoAgente(admin.db, s.tenant.id)
    expect(nota.status).toBe('issued')
    expect(c.ultimaPara(s.ownerPhone)).toBe('Quer que eu guarde Clínica Nova para as próximas notas? Responda sim ou não.')

    await c.enviar(s.ownerPhone, 'sim')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Modelo Clínica Nova salvo')
    const { rows } = await admin.db.query(
      `select nome, tomador_documento, tomador_nome, tomador_email, codigo_servico_nacional, descricao, created_from_invoice_id
         from nofiscal.fiscal_models where tenant_id = $1`,
      [s.tenant.id],
    )
    expect(rows).toEqual([
      {
        nome: 'Clínica Nova',
        tomador_documento: '52998224725',
        tomador_nome: 'Clínica Nova',
        tomador_email: 'contato@clinicanova.test',
        codigo_servico_nacional: '010701',
        descricao: 'Prestação de serviços',
        created_from_invoice_id: nota.id,
      },
    ])
    expect(c.ia.chamadas).toEqual(['nota pra Clínica Nova, 150 reais'])

    // Com o modelo salvo, o próximo pedido não pede CPF nem e-mail e não oferece de novo. O modelo ficou com a
    // descrição padrão, então a pergunta da descrição volta antes do resumo.
    const d = conversa({ 'nota pra Clínica Nova, 90 reais': { tomador: 'Clínica Nova', valor: '90.00', intencao: 'emitir' } })
    await d.enviar(s.ownerPhone, 'nota pra Clínica Nova, 90 reais')
    expect(d.ultimaPara(s.ownerPhone)).toBe(TEXTOS.perguntaDeDescricao)
    await d.enviar(s.ownerPhone, 'padrão')
    expect(d.ultimaPara(s.ownerPhone)).toContain('Posso emitir?')
    await d.enviar(s.ownerPhone, 'confirmar')
    await rodarWorker(servico.db, { sefin, tenantId: s.tenant.id, canais: d.canais, now: d.agora })
    expect(d.respostasPara(s.ownerPhone).some((t) => t.includes('para as próximas notas'))).toBe(false)
  })

  it('descrição da nota: perguntada antes do resumo, dita no pedido ou corrigida', async () => {
    // Lucca, 30/10/2026: sem descrição no pedido, o robô pergunta antes do "Posso emitir?"; quem já disse o serviço
    // no pedido vai direto ao resumo; e a descrição pode mudar no "corrigir".
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa({
      'nota pra Clínica Nova, 150 reais': { tomador: 'Clínica Nova', valor: '150.00', intencao: 'emitir' },
      'descrição revisão de contrato': { descricao: 'Revisão de contrato', intencao: 'outro' },
      'nota pra Prontia, 10 reais, consultoria de outubro': {
        tomador: 'Prontia Saúde', modelo: 'Prontia', valor: '10.00', descricao: 'Consultoria de outubro', intencao: 'emitir',
      },
    })

    await c.enviar(s.ownerPhone, 'nota pra Clínica Nova, 150 reais')
    await c.enviar(s.ownerPhone, '529.982.247-25 contato@clinicanova.test')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.perguntaDeDescricao)
    // A resposta é lida pelo código, sem a IA, e entra com a primeira letra maiúscula.
    await c.enviar(s.ownerPhone, 'consultoria de marketing - outubro/2026')
    let resumo = c.ultimaPara(s.ownerPhone)
    expect(resumo).toContain('Descrição na nota: Consultoria de marketing - outubro/2026')
    expect(resumo).toContain('Posso emitir?')

    await c.enviar(s.ownerPhone, 'corrigir')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.oQueMuda)
    await c.enviar(s.ownerPhone, 'descrição revisão de contrato')
    resumo = c.ultimaPara(s.ownerPhone)
    expect(resumo).toContain('Descrição na nota: Revisão de contrato')
    expect(resumo).toContain('R$ 150,00')

    await c.enviar(s.ownerPhone, 'confirmar')
    const [nota] = await notasDoAgente(admin.db, s.tenant.id)
    expect((nota.payload.servico as { descricao: string }).descricao).toBe('Revisão de contrato')

    // Descrição dita no pedido: sem pergunta; o modelo continua com a descrição dele.
    await c.enviar(s.ownerPhone, 'nota pra Prontia, 10 reais, consultoria de outubro')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Descrição na nota: Consultoria de outubro')
    expect(c.respostasPara(s.ownerPhone).filter((t) => t === TEXTOS.perguntaDeDescricao)).toHaveLength(1)
    const { rows } = await admin.db.query('select descricao from nofiscal.fiscal_models where tenant_id = $1', [s.tenant.id])
    expect(rows).toEqual([{ descricao: PRONTIA_CNPJ.descricao }])

    expect(c.ia.chamadas).toEqual([
      'nota pra Clínica Nova, 150 reais',
      'descrição revisão de contrato',
      'nota pra Prontia, 10 reais, consultoria de outubro',
    ])
  })

  it('descrição da nota: "padrão" e desistir na pergunta', async () => {
    const s = await cenario()
    const c = conversa({ 'nota pra Clínica Nova, 150 reais': { tomador: 'Clínica Nova', valor: '150.00', intencao: 'emitir' } })

    for (const resposta of ['padrão', 'pode usar a padrão', 'não', 'pular']) {
      await c.enviar(s.ownerPhone, 'nota pra Clínica Nova, 150 reais')
      await c.enviar(s.ownerPhone, '529.982.247-25 contato@clinicanova.test')
      expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.perguntaDeDescricao)
      await c.enviar(s.ownerPhone, resposta)
      expect(c.ultimaPara(s.ownerPhone), resposta).toContain(`Descrição na nota: ${DESCRICAO_PADRAO}`)
      await c.enviar(s.ownerPhone, 'descartar')
    }

    // "confirmar" na pergunta usa a padrão e mostra o resumo, mas não emite.
    await c.enviar(s.ownerPhone, 'nota pra Clínica Nova, 150 reais')
    await c.enviar(s.ownerPhone, '529.982.247-25 contato@clinicanova.test')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Posso emitir?')
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)

    // Desistir na pergunta descarta o pedido.
    await c.enviar(s.ownerPhone, 'descartar')
    await c.enviar(s.ownerPhone, 'nota pra Clínica Nova, 150 reais')
    await c.enviar(s.ownerPhone, '529.982.247-25 contato@clinicanova.test')
    await c.enviar(s.ownerPhone, 'descartar')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.descartado)
    expect(await notasDoAgente(admin.db, s.tenant.id)).toHaveLength(0)
  })

  it('modelo repetido pergunta', async () => {
    const s = await cenario({ certificado: sharedTestCertificate().certificado })
    const original = await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa({
      'nota pra prontia, CPF 529.982.247-25, 50 reais': { tomador: 'prontia', documento: '52998224725', valor: '50.00', intencao: 'emitir' },
    })
    const sefin = createSefinClient({ transport: fakeSefin().transport })

    // Documento diferente do modelo "Prontia": é outro tomador, e falta só o e-mail.
    await c.enviar(s.ownerPhone, 'nota pra prontia, CPF 529.982.247-25, 50 reais')
    expect(c.ultimaPara(s.ownerPhone)).toContain('e-mail')
    await c.enviar(s.ownerPhone, 'filial@prontia.test')
    await c.enviar(s.ownerPhone, 'padrão')
    expect(c.ultimaPara(s.ownerPhone)).toContain('529.982.247-25')
    await c.enviar(s.ownerPhone, 'confirmar')
    await rodarWorker(servico.db, { sefin, tenantId: s.tenant.id, canais: c.canais, now: c.agora })
    const [nota] = await notasDoAgente(admin.db, s.tenant.id)
    expect(c.ultimaPara(s.ownerPhone)).toBe('Quer que eu guarde prontia para as próximas notas? Responda sim ou não.')

    await c.enviar(s.ownerPhone, 'sim')
    const pergunta = c.ultimaPara(s.ownerPhone)
    expect(pergunta).toContain('Já existe um modelo')
    expect(pergunta).toContain('substitu')
    const modelos = async () =>
      (
        await admin.db.query<{ id: string; nome: string; tomador_documento: string; created_from_invoice_id: string }>(
          'select id, nome, tomador_documento, created_from_invoice_id from nofiscal.fiscal_models where tenant_id = $1',
          [s.tenant.id],
        )
      ).rows
    expect(await modelos()).toEqual([
      { id: original.id, nome: 'Prontia', tomador_documento: '12345678000195', created_from_invoice_id: original.origemId },
    ])

    await c.enviar(s.ownerPhone, 'sim')
    expect(c.ultimaPara(s.ownerPhone)).toContain('substituído')
    expect(await modelos()).toEqual([
      { id: original.id, nome: 'prontia', tomador_documento: '52998224725', created_from_invoice_id: nota.id },
    ])
  })

  it('modelo repetido pergunta e "não" mantém o antigo', async () => {
    const s = await cenario({ certificado: sharedTestCertificate().certificado })
    const original = await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    const c = conversa({
      'nota pra prontia, CPF 529.982.247-25, 50 reais': { tomador: 'prontia', documento: '52998224725', valor: '50.00', intencao: 'emitir' },
    })
    await c.enviar(s.ownerPhone, 'nota pra prontia, CPF 529.982.247-25, 50 reais')
    await c.enviar(s.ownerPhone, 'filial@prontia.test')
    await c.enviar(s.ownerPhone, 'padrão')
    await c.enviar(s.ownerPhone, 'confirmar')
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: fakeSefin().transport }), tenantId: s.tenant.id, canais: c.canais, now: c.agora })
    await c.enviar(s.ownerPhone, 'sim')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Já existe um modelo')
    await c.enviar(s.ownerPhone, 'não')
    const { rows } = await admin.db.query('select id, tomador_documento from nofiscal.fiscal_models where tenant_id = $1', [s.tenant.id])
    expect(rows).toEqual([{ id: original.id, tomador_documento: '12345678000195' }])
  })

  // Roteiro do bot (Lucca, 22/10/2026): na confirmação de cancelamento, "cancelar" cancela e "manter" mantém.
  it('"cancelar" confirma o cancelamento e "manter" mantém a nota', async () => {
    const s = await cenario({ plan: 'pro' })
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CPF)
    const agora = new Date()
    const nota = await notaEmitida(s, { numero: 8, valor: '42.90', emitidaEm: agora })
    const c = conversa({ 'cancela a nota da Prontia de hoje': { tomador: 'Prontia', intencao: 'cancelar' } })

    await c.enviar(s.ownerPhone, 'cancela a nota da Prontia de hoje')
    await c.enviar(s.ownerPhone, 'manter')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.cancelamentoDesistido)
    expect((await linhaDaNota(nota)).status).toBe('issued')

    await c.enviar(s.ownerPhone, 'cancela a nota da Prontia de hoje')
    await c.enviar(s.ownerPhone, 'cancelar')
    expect((await linhaDaNota(nota)).status).toBe('cancel_requested')
  })

  it('cancelamento confirmado', async () => {
    const s = await cenario({ plan: 'pro' })
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CPF)
    const agora = new Date()
    const nota = await notaEmitida(s, { numero: 7, valor: '42.90', emitidaEm: agora })
    const c = conversa({ 'cancela a nota da Prontia de hoje': { tomador: 'Prontia', intencao: 'cancelar' } })

    await c.enviar(s.ownerPhone, 'cancela a nota da Prontia de hoje')
    const pergunta = c.ultimaPara(s.ownerPhone)
    expect(pergunta).toContain('7')
    expect(pergunta).toContain('Prontia Saúde')
    expect(pergunta).toContain('R$ 42,90')
    expect(pergunta).toContain(dataLocal(agora))
    expect(pergunta).toContain('Cancelo esta nota?')
    expect((await linhaDaNota(nota)).status).toBe('issued')

    await c.enviar(s.ownerPhone, 'confirmar')
    expect((await linhaDaNota(nota)).status).toBe('cancel_requested')
    const pedido = (await pedidosDo(admin.db, s.tenant.id))[0]
    expect(pedido).toMatchObject({ kind: 'cancelar', status: 'confirmed', invoice_id: nota })

    const { client, calls } = sefinDouble({ cancelar: () => ({ kind: 'accepted', xml: '<evento>aceito</evento>' }) })
    await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: c.canais, now: c.agora })
    expect(calls.filter((x) => x.op === 'cancelar')).toHaveLength(1)
    expect((await linhaDaNota(nota)).status).toBe('cancelled')
    expect(c.ultimaPara(s.ownerPhone)).toBe('Nota 7 cancelada')
    // Pro: o tomador recebe o aviso por e-mail.
    const paraTomador = c.canais.emails.filter((e) => e.para === 'financeiro@prontia.test')
    expect(paraTomador).toHaveLength(1)
    expect(paraTomador[0].assunto).toContain('7')
    expect(paraTomador[0].assunto).toContain('cancelada')

    // No Inicial, o tomador não recebe.
    const inicial = await cenario({ plan: 'inicial' })
    await criarModelo(admin.db, inicial.tenant.id, PRONTIA_CPF)
    const notaInicial = await notaEmitida(inicial, { numero: 3, email: 'tomador-inicial@prontia.test' })
    const d = conversa({ 'cancela a nota da Prontia de hoje': { tomador: 'Prontia', intencao: 'cancelar' } })
    await d.enviar(inicial.ownerPhone, 'cancela a nota da Prontia de hoje')
    await d.enviar(inicial.ownerPhone, 'confirmar')
    await rodarWorker(servico.db, { sefin: client, tenantId: inicial.tenant.id, canais: d.canais, now: d.agora })
    expect((await linhaDaNota(notaInicial)).status).toBe('cancelled')
    expect(d.ultimaPara(inicial.ownerPhone)).toBe('Nota 3 cancelada')
    expect(d.canais.emails.map((e) => e.para)).toEqual([inicial.ownerEmail])
  })

  it('cancelamento ambíguo', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CPF)
    const agora = new Date()
    const ontem = await notaEmitida(s, { numero: 10, emitidaEm: new Date(agora.getTime() - 24 * HORA) })
    const n11 = await notaEmitida(s, { numero: 11, valor: '11.00', emitidaEm: new Date(agora.getTime() - 3 * 60_000) })
    const n12 = await notaEmitida(s, { numero: 12, valor: '12.00', emitidaEm: new Date(agora.getTime() - 2 * 60_000) })
    const n13 = await notaEmitida(s, { numero: 13, valor: '13.00', emitidaEm: new Date(agora.getTime() - 1 * 60_000) })
    const c = conversa({
      'cancela a nota da Prontia de hoje': { tomador: 'Prontia', intencao: 'cancelar' },
      'cancela a nota da Prontia': { tomador: 'Prontia', intencao: 'cancelar' },
    })

    await c.enviar(s.ownerPhone, 'cancela a nota da Prontia de hoje')
    const lista = c.ultimaPara(s.ownerPhone)
    for (const n of ['11', '12', '13']) expect(lista).toContain(`nº ${n}`)
    expect(lista).not.toContain('nº 10')
    expect(lista).not.toContain('Cancelo esta nota?')
    expect(lista).toMatch(/número/)

    // "confirmar" antes de escolher não cancela nada.
    await c.enviar(s.ownerPhone, 'confirmar')
    for (const id of [ontem, n11, n12, n13]) expect((await linhaDaNota(id)).status).toBe('issued')

    await c.enviar(s.ownerPhone, '12')
    const pergunta = c.ultimaPara(s.ownerPhone)
    expect(pergunta).toContain('12')
    expect(pergunta).toContain('R$ 12,00')
    expect(pergunta).toContain('Cancelo esta nota?')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect((await linhaDaNota(n12)).status).toBe('cancel_requested')
    for (const id of [ontem, n11, n13]) expect((await linhaDaNota(id)).status).toBe('issued')

    // Mais de 5 candidatas: lista as 5 mais recentes (Unresolved 17).
    for (let n = 20; n < 23; n++) await notaEmitida(s, { numero: n, emitidaEm: new Date(agora.getTime() - (30 - n) * 1000) })
    await c.enviar(s.ownerPhone, 'cancela a nota da Prontia')
    const longa = c.ultimaPara(s.ownerPhone)
    expect(longa.match(/nº \d+/g)).toEqual(['nº 22', 'nº 21', 'nº 20', 'nº 13', 'nº 11'])
  })

  it('cancelamento recusado', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CPF)
    const nota = await notaEmitida(s, { numero: 8 })
    const c = conversa({ 'cancela a nota da Prontia de hoje': { tomador: 'Prontia', intencao: 'cancelar' } })

    await c.enviar(s.ownerPhone, 'cancela a nota da Prontia de hoje')
    await c.enviar(s.ownerPhone, 'confirmar')
    const { client } = sefinDouble({
      cancelar: () => ({ kind: 'refused', code: 'E1235', message: 'Prazo para cancelamento da NFS-e expirado' }),
    })
    await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: c.canais, now: c.agora })

    expect((await linhaDaNota(nota)).status).toBe('cancel_requested')
    const explicacao = c.ultimaPara(s.ownerPhone)
    expect(explicacao).toContain('8')
    expect(explicacao).toContain('Prazo para cancelamento da NFS-e expirado')
    expect(explicacao).toMatch(/portal/i)
    expect(explicacao).toMatch(/contador/i)
    expect(c.respostasPara(s.ownerPhone)).not.toContain('Nota 8 cancelada')
  })

  // C40 (lote B2): o tomador com CNPJ sai da conversa, passa pelo motor e vira <toma><CNPJ>.
  it('tomador CNPJ chega ao motor', async () => {
    const s = await cenario({ certificado: sharedTestCertificate().certificado })
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CNPJ)
    await criarModelo(admin.db, s.tenant.id, { nome: 'Maria', documento: '52998224725', nomeTomador: 'Maria da Silva' })
    const c = conversa(
      {
        'nota pra Hospital Alfa, 80 reais': { tomador: 'Hospital Alfa', valor: '80.00', intencao: 'emitir' },
        [PEDIDO_PRONTIA]: { tomador: 'Prontia Saúde', valor: '10.00', intencao: 'emitir' },
        'nota pra Maria, 30 reais': { tomador: 'Maria', valor: '30.00', intencao: 'emitir' },
      },
      { consultaCnpj: { async razaoSocial(cnpj) { return cnpj === '11444777000161' ? 'HOSPITAL ALFA LTDA' : null } } },
    )
    const sefin = fakeSefin()

    // Tomador novo com CNPJ (nome dos dados públicos), tomador de modelo com CNPJ e, para comparar, um com CPF.
    await c.enviar(s.ownerPhone, 'nota pra Hospital Alfa, 80 reais')
    await c.enviar(s.ownerPhone, 'CNPJ 11.444.777/0001-61, compras@alfa.test')
    await c.enviar(s.ownerPhone, 'padrão')
    await c.enviar(s.ownerPhone, 'confirmar')
    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA)
    await c.enviar(s.ownerPhone, 'confirmar')
    await c.enviar(s.ownerPhone, 'nota pra Maria, 30 reais')
    await c.enviar(s.ownerPhone, 'confirmar')
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: sefin.transport }), tenantId: s.tenant.id, canais: c.canais, now: c.agora })

    const dpsEnviadas = sefin.requests.filter((r) => r.method === 'POST' && r.path === '/nfse').map((r) => r.xml ?? '')
    expect(dpsEnviadas).toHaveLength(3)
    const toma = dpsEnviadas.map((xml) => /<toma>.*?<\/toma>/.exec(xml)?.[0]).sort()
    expect(toma).toEqual(
      [
        '<toma><CNPJ>11444777000161</CNPJ><xNome>HOSPITAL ALFA LTDA</xNome></toma>',
        '<toma><CNPJ>12345678000195</CNPJ><xNome>Prontia Saúde</xNome></toma>',
        '<toma><CPF>52998224725</CPF><xNome>Maria da Silva</xNome></toma>',
      ].sort(),
    )

    // As três saem autorizadas e chegam ao dono com o PDF.
    expect((await notasDoAgente(admin.db, s.tenant.id)).map((n) => n.status)).toEqual(['issued', 'issued', 'issued'])
    const entregues = c.canais.whatsapps.filter((m) => m.para === s.ownerPhone && m.anexo)
    expect(entregues.map((m) => m.texto).sort()).toEqual(['NFS-e nº 1 autorizada', 'NFS-e nº 2 autorizada', 'NFS-e nº 3 autorizada'])
    expect(c.respostasPara(s.ownerPhone).some((t) => t.includes('DPS_INVALID'))).toBe(false)
  })

  it('contagem de mensagens e tokens', async () => {
    const s = await cenario({ certificado: sharedTestCertificate().certificado })
    await criarModelo(admin.db, s.tenant.id, PRONTIA_CPF)
    const c = conversa(ROTEIRO_PRONTIA, {}, { entrada: 120, saida: 30 })

    await c.enviar(s.ownerPhone, PEDIDO_PRONTIA) // pedido + resumo
    await c.enviar(s.ownerPhone, 'confirmar') // confirmar + "Emitindo…"
    let [pedido] = await pedidosDo(admin.db, s.tenant.id)
    expect(pedido).toMatchObject({ message_count: 4, ai_input_tokens: 120, ai_output_tokens: 30 })

    // A entrega da nota no WhatsApp também conta.
    await rodarWorker(servico.db, { sefin: createSefinClient({ transport: fakeSefin().transport }), tenantId: s.tenant.id, canais: c.canais, now: c.agora })
    ;[pedido] = await pedidosDo(admin.db, s.tenant.id)
    expect(pedido).toMatchObject({ message_count: 5, ai_input_tokens: 120, ai_output_tokens: 30 })

    // Tomador novo: cada resposta da pessoa e do agente soma; a IA é chamada uma vez.
    const d = conversa({ 'nota pra Clínica Nova, 150 reais': { tomador: 'Clínica Nova', valor: '150.00', intencao: 'emitir' } }, {}, { entrada: 200, saida: 40 })
    await d.enviar(s.ownerPhone, 'nota pra Clínica Nova, 150 reais') // 2
    await d.enviar(s.ownerPhone, '529.982.247-25 contato@clinicanova.test') // 4
    await d.enviar(s.ownerPhone, 'descartar') // 6
    const segundo = (await pedidosDo(admin.db, s.tenant.id))[1]
    expect(segundo).toMatchObject({ status: 'rejected_by_user', message_count: 6, ai_input_tokens: 200, ai_output_tokens: 40 })
  })
})
