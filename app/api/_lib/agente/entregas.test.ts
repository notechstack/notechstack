// Destinatários das entregas por e-mail (C5, lote A) e entregas e avisos do agente (C25–C29,
// lote B) de .checks/agente-fiscal-whatsapp.md. O código sob teste conecta como
// `nofiscal_service`; WhatsApp, e-mail, IA e Sefin são dublês.
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
  rodarWorker,
  type SelfServiceOptions,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { sharedTestCertificate } from '../../_tests/certs.js'
import { openTestDb, sefinDouble } from '../../_tests/fixtures.js'
import { fakeSefin } from '../../_tests/sefin-fake.js'
import type { EmitirResultado } from '../sefin.js'
import { createSefinClient } from '../sefin-client.js'
import { definirContador } from './cadastro.js'
import { processarMensagem } from './conversa.js'
import { avisarCertificados, destinatariosDoEmail } from './entregas.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
  const { rows } = await servico.db.query<{ papel: string }>('select current_user as papel')
  expect(rows[0].papel).toBe('nofiscal_service')
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

describe('destinatários do e-mail', () => {
  it('contador recebe no Pro', async () => {
    const pro = await createSelfServiceTenant(admin.db, { plan: 'pro' })
    const inicial = await createSelfServiceTenant(admin.db, { plan: 'inicial' })
    tenants.push(pro, inicial)
    const canais = canaisDouble()
    const deps = { db: servico.db, email: canais.email, whatsapp: canais.whatsapp }

    // Antes de o contador ser informado, só dono e tomador.
    expect(await destinatariosDoEmail(servico.db, pro.tenant.id, { tomadorEmail: 'tomador@example.test' })).toEqual([
      { papel: 'dono', email: pro.ownerEmail },
      { papel: 'tomador', email: 'tomador@example.test' },
    ])

    expect(
      await definirContador(deps, { userId: pro.ownerUserId, tenantId: pro.tenant.id, email: ' Contador@Example.TEST ' }),
    ).toEqual({ ok: true })
    const { rows } = await admin.db.query<{ contador_email: string }>(
      'select contador_email from nofiscal.fiscal_tenants where id = $1',
      [pro.tenant.id],
    )
    expect(rows[0].contador_email).toBe('contador@example.test')

    expect(await destinatariosDoEmail(servico.db, pro.tenant.id, { tomadorEmail: 'tomador@example.test' })).toEqual([
      { papel: 'dono', email: pro.ownerEmail },
      { papel: 'tomador', email: 'tomador@example.test' },
      { papel: 'contador', email: 'contador@example.test' },
    ])
    expect(await destinatariosDoEmail(servico.db, pro.tenant.id, {})).toEqual([
      { papel: 'dono', email: pro.ownerEmail },
      { papel: 'contador', email: 'contador@example.test' },
    ])

    // No Inicial o contador gravado não recebe, nem o tomador.
    expect(
      await definirContador(deps, { userId: inicial.ownerUserId, tenantId: inicial.tenant.id, email: 'contador@example.test' }),
    ).toEqual({ ok: true })
    expect(await destinatariosDoEmail(servico.db, inicial.tenant.id, { tomadorEmail: 'tomador@example.test' })).toEqual([
      { papel: 'dono', email: inicial.ownerEmail },
    ])

    // Só o dono do tenant grava o contador, e só um e-mail.
    expect(
      await definirContador(deps, { userId: inicial.ownerUserId, tenantId: pro.tenant.id, email: 'outro@example.test' }),
    ).toEqual({ ok: false, erro: 'FORBIDDEN' })
    expect(await definirContador(deps, { userId: pro.ownerUserId, tenantId: pro.tenant.id, email: 'sem-arroba' })).toEqual({
      ok: false,
      erro: 'EMAIL_INVALIDO',
    })
    const { rows: depois } = await admin.db.query<{ contador_email: string }>(
      'select contador_email from nofiscal.fiscal_tenants where id = $1',
      [pro.tenant.id],
    )
    expect(depois[0].contador_email).toBe('contador@example.test')
  })
})

// ---------------------------------------------------------------------------------------
// Lote B: entregas e avisos.

const PEDIDO = 'nota pra Prontia Saúde, 10 reais'
const ROTEIRO = { [PEDIDO]: { tomador: 'Prontia Saúde', valor: '10.00', intencao: 'emitir' as const } }

async function cenario(opcoes: SelfServiceOptions = {}): Promise<SelfServiceTenant> {
  const s = await createSelfServiceTenant(admin.db, opcoes)
  tenants.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  await criarModelo(admin.db, s.tenant.id, {
    nome: 'Prontia',
    documento: '52998224725',
    nomeTomador: 'Prontia Saúde',
    email: 'financeiro@prontia.test',
    descricao: 'Consultoria em saúde',
  })
  return s
}

/** Pedido e "confirmar" pelo WhatsApp do dono, como a pessoa faria. */
function agente(agora: () => Date) {
  const canais = canaisDouble()
  const ia = interpreteDouble(ROTEIRO)
  const deps = { db: servico.db, whatsapp: canais.whatsapp, email: canais.email, interprete: ia.interprete, links: LINKS_DE_TESTE, now: agora }
  return {
    canais,
    deps,
    async pedirNota(s: SelfServiceTenant) {
      await processarMensagem(deps, mensagemDeTexto(s.ownerPhone, PEDIDO))
      await processarMensagem(deps, mensagemDeTexto(s.ownerPhone, 'confirmar'))
    },
    paraODono: (s: SelfServiceTenant) => canais.whatsapps.filter((m) => m.para === s.ownerPhone),
  }
}

/** 10:00 de hoje em São Paulo (os avisos agendados saem a partir das 09:00). */
function hojeAs(hora: string): Date {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  return new Date(`${dia}T${hora}:00-03:00`)
}

describe('entregas e avisos do agente', () => {
  it('entrega por plano', async () => {
    const certificado = sharedTestCertificate().certificado
    const pro = await cenario({ plan: 'pro', contadorEmail: 'contador@example.test', certificado })
    const inicial = await cenario({ plan: 'inicial', contadorEmail: 'contador-inicial@example.test', certificado })
    const agora = () => new Date()

    for (const [s, destinos] of [
      [pro, [pro.ownerEmail, 'financeiro@prontia.test', 'contador@example.test']],
      [inicial, [inicial.ownerEmail]],
    ] as const) {
      const a = agente(agora)
      await a.pedirNota(s)
      await rodarWorker(servico.db, { sefin: createSefinClient({ transport: fakeSefin().transport }), tenantId: s.tenant.id, canais: a.canais, now: agora })

      const [nota] = await notasDoAgente(admin.db, s.tenant.id)
      expect(nota.status).toBe('issued')

      // WhatsApp do dono: a mensagem com o PDF anexado (a 1ª NFS-e do dublê da Sefin é a nº 1).
      const comPdf = a.paraODono(s).filter((m) => m.anexo)
      expect(comPdf).toHaveLength(1)
      expect(comPdf[0].texto).toBe('NFS-e nº 1 autorizada')
      expect(comPdf[0].anexo?.tipo).toBe('application/pdf')
      expect(Buffer.from(comPdf[0].anexo?.conteudo ?? []).subarray(0, 5).toString('latin1')).toBe('%PDF-')

      // E-mail: PDF e XML para cada destinatário do plano, e para mais ninguém.
      expect(a.canais.emails.map((e) => e.para).sort()).toEqual([...destinos].sort())
      for (const email of a.canais.emails) {
        expect(email.assunto).toContain('NFS-e nº 1 autorizada')
        expect(email.anexos?.map((x) => x.tipo).sort()).toEqual(['application/pdf', 'application/xml'])
        const xml = email.anexos?.find((x) => x.tipo === 'application/xml')
        expect(Buffer.from(xml?.conteudo ?? []).toString('utf8')).toContain('<nNFSe>1</nNFSe>')
      }
    }
  })

  it('rejeição explicada', async () => {
    const s = await cenario()
    let agora = new Date()
    const a = agente(() => agora)
    await a.pedirNota(s)

    const { client, calls } = sefinDouble({
      emitir: () => ({ kind: 'rejected', code: 'E0310', message: 'CPF do tomador não encontrado na base da Receita Federal' }),
    })
    await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: a.canais, now: () => agora })
    const [nota] = await notasDoAgente(admin.db, s.tenant.id)
    expect(nota.status).toBe('rejected')

    const aviso = a.paraODono(s).at(-1)?.texto ?? ''
    expect(aviso).toContain('E0310')
    expect(aviso).toContain('CPF do tomador não encontrado na base da Receita Federal')
    expect(aviso).toMatch(/corrig/i)

    // Sem retentativa: outra rodada, horas depois, não chama a Sefin nem repete o aviso.
    agora = new Date(agora.getTime() + 6 * 3600_000)
    const mensagens = a.paraODono(s).length
    await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: a.canais, now: () => agora })
    expect(calls.filter((c) => c.op === 'emitir')).toHaveLength(1)
    expect(a.paraODono(s)).toHaveLength(mensagens)
    expect((await notasDoAgente(admin.db, s.tenant.id))[0].status).toBe('rejected')
  })

  it('aviso único de fila', async () => {
    const s = await cenario()
    let agora = new Date()
    const a = agente(() => agora)
    await a.pedirNota(s)

    let resposta: EmitirResultado = { kind: 'unavailable', reason: 'HTTP 503' }
    const { client } = sefinDouble({ emitir: () => resposta })
    const FILA = 'A Sefin está instável; a nota está na fila e eu te aviso quando sair'
    const avisosDeFila = () => a.paraODono(s).filter((m) => m.texto === FILA)

    await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: a.canais, now: () => agora })
    expect((await notasDoAgente(admin.db, s.tenant.id))[0].status).toBe('sent')
    expect(avisosDeFila()).toHaveLength(1)

    // Mais duas rodadas com a Sefin fora: nenhum aviso novo.
    for (const minutos of [2, 10]) {
      agora = new Date(agora.getTime() + minutos * 60_000)
      await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: a.canais, now: () => agora })
    }
    expect(avisosDeFila()).toHaveLength(1)

    // A Sefin volta: a nota sai e o dono recebe a entrega, sem novo aviso de fila.
    resposta = { kind: 'authorized', chaveAcesso: 'CHAVE-FILA', xmlDps: '<DPS/>', xmlNfse: '<NFSe/>' }
    agora = new Date(agora.getTime() + 20 * 60_000)
    await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: a.canais, now: () => agora })
    expect((await notasDoAgente(admin.db, s.tenant.id))[0].status).toBe('issued')
    expect(a.paraODono(s).at(-1)?.texto).toMatch(/^NFS-e nº \d+ autorizada$/)
    expect(avisosDeFila()).toHaveLength(1)
  })

  it('certificado vencendo e vencido', async () => {
    const vencendo = await cenario({ notAfter: new Date(Date.now() + 20 * 24 * 3600_000) })
    const longe = await cenario({ notAfter: new Date(Date.now() + 60 * 24 * 3600_000) })
    const vencido = await cenario({ notAfter: new Date(Date.now() - 24 * 3600_000) })
    const canais = canaisDouble()
    const deps = (now: Date) => ({ db: servico.db, whatsapp: canais.whatsapp, email: canais.email, links: LINKS_DE_TESTE, now: () => now })
    const ids = [vencendo.tenant.id, longe.tenant.id, vencido.tenant.id]

    // Antes das 09:00 nada sai.
    await avisarCertificados(deps(hojeAs('07:00')), { tenantIds: ids })
    expect(canais.whatsapps).toHaveLength(0)
    expect(canais.emails).toHaveLength(0)

    await avisarCertificados(deps(hojeAs('10:00')), { tenantIds: ids })
    for (const s of [vencendo, vencido]) {
      const whats = canais.whatsapps.filter((m) => m.para === s.ownerPhone)
      expect(whats).toHaveLength(1)
      expect(whats[0].texto).toContain(LINKS_DE_TESTE.certificado)
      const emails = canais.emails.filter((m) => m.para === s.ownerEmail)
      expect(emails).toHaveLength(1)
      expect(emails[0].texto).toContain(LINKS_DE_TESTE.certificado)
    }
    expect(canais.whatsapps.filter((m) => m.para === vencido.ownerPhone)[0].texto).toContain('venceu')
    expect(canais.whatsapps.filter((m) => m.para === longe.ownerPhone)).toHaveLength(0)

    // Uma vez por certificado: a rodada seguinte não repete.
    await avisarCertificados(deps(hojeAs('11:00')), { tenantIds: ids })
    expect(canais.whatsapps).toHaveLength(2)
    expect(canais.emails).toHaveLength(2)

    // Vencido: o pedido de emissão recebe "Seu certificado venceu" e o link, sem pedido nem nota.
    const a = agente(() => new Date())
    await processarMensagem(a.deps, mensagemDeTexto(vencido.ownerPhone, PEDIDO))
    const resposta = a.paraODono(vencido).at(-1)?.texto ?? ''
    expect(resposta).toContain('Seu certificado venceu')
    expect(resposta).toContain(LINKS_DE_TESTE.certificado)
    expect(await notasDoAgente(admin.db, vencido.tenant.id)).toHaveLength(0)
    const { rows } = await admin.db.query('select 1 from nofiscal.fiscal_requests where tenant_id = $1', [vencido.tenant.id])
    expect(rows).toHaveLength(0)
  })

  it('limite avisa e não bloqueia', async () => {
    const s = await cenario({ plan: 'inicial' })
    // 20 notas já emitidas neste mês: o limite do Inicial.
    await admin.db.query(
      `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, status, issued_at)
       select $1, 'limite-' || g, '{"valor": "1.00"}'::jsonb, 'issued', now() from generate_series(1, 20) g`,
      [s.tenant.id],
    )
    const LIMITE = 'Você passou do limite do seu plano este mês'
    const agora = () => new Date()
    const { client } = sefinDouble()

    const a = agente(agora)
    await a.pedirNota(s)
    await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: a.canais, now: agora })
    expect((await notasDoAgente(admin.db, s.tenant.id)).map((n) => n.status)).toEqual(['issued'])
    expect(a.paraODono(s).filter((m) => m.texto.startsWith(LIMITE))).toHaveLength(1)

    // A 22ª também sai, sem repetir o aviso no mesmo mês.
    const b = agente(agora)
    await b.pedirNota(s)
    expect(b.paraODono(s).at(-1)?.texto).toBe('Emitindo…')
    await rodarWorker(servico.db, { sefin: client, tenantId: s.tenant.id, canais: b.canais, now: agora })
    expect((await notasDoAgente(admin.db, s.tenant.id)).map((n) => n.status)).toEqual(['issued', 'issued'])
    expect(b.paraODono(s).filter((m) => m.texto.startsWith(LIMITE))).toHaveLength(0)

    // Durante o teste grátis não há limite, nem aviso.
    const teste = await createSelfServiceTenant(admin.db, { plan: 'inicial' })
    tenants.push(teste)
    await assinarTenant(admin.db, teste.tenant.id, { status: 'pendente', trialEndsAt: new Date(Date.now() + 3 * 24 * 3600_000) })
    await criarModelo(admin.db, teste.tenant.id, { nome: 'Prontia', documento: '52998224725', nomeTomador: 'Prontia Saúde' })
    await admin.db.query(
      `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, status, issued_at)
       select $1, 'limite-' || g, '{"valor": "1.00"}'::jsonb, 'issued', now() from generate_series(1, 25) g`,
      [teste.tenant.id],
    )
    const t = agente(agora)
    await t.pedirNota(teste)
    await rodarWorker(servico.db, { sefin: client, tenantId: teste.tenant.id, canais: t.canais, now: agora })
    expect((await notasDoAgente(admin.db, teste.tenant.id)).map((n) => n.status)).toEqual(['issued'])
    expect(t.paraODono(teste).filter((m) => m.texto.startsWith(LIMITE))).toHaveLength(0)
  })
})
