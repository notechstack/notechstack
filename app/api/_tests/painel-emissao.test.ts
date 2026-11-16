// Aba "Emitir" do painel "Minha conta" (conta Escritório), de ponta a ponta no banco local com o papel de produção
// (`nofiscal_service`, o mesmo do agente). Sessão: verificador falso ("Bearer token-<user id>"); Sefin, ADN, e-mail e
// WhatsApp em dublê. Prova: só o dono da conta Escritório emite, e só pelas empresas dela; a nota avulsa passa pelo
// mesmo `emission_block` e pelo mesmo motor (idempotente pela chave), sai por e-mail como a do WhatsApp e aparece em
// Relatórios; a empresa por procuração assina com o A1 do escritório (a nó nunca assina); a planilha tem a mesma
// leitura, validação, franquia e confirmação do WhatsApp, sem telefone, e o retorno vai ao e-mail da conta.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConferenciaProcuracao, DistribuicaoAdn } from '../_lib/adn.js'
import type { CatalogoDeServicos } from '../_lib/agente/catalogo-servicos.js'
import { closeSharedDb } from '../_lib/db.js'
import { runEmission } from '../_lib/emission.js'
import { handleOnboardingProcuracao } from '../_lib/onboarding-procuracao.js'
import { handlePainelEmissao } from '../_lib/painel-emissao.js'
import { createSefinClient } from '../_lib/sefin-client.js'
import type { SessionVerifier } from '../_lib/session.js'
import {
  allowTestUserToAssume,
  canaisDouble,
  createEscritorio,
  createSelfServiceTenant,
  criarModelo,
  dropEscritorio,
  dropSelfServiceTenant,
  openRoleDb,
  rodarWorker,
  type Escritorio,
  type SelfServiceTenant,
} from './agente-fixtures.js'
import { sharedTestCertificate } from './certs.js'
import { openTestDb, readInvoice, sefinDouble } from './fixtures.js'
import { fakeSefin } from './sefin-fake.js'

const admin = openTestDb()
let servico: ReturnType<typeof openRoleDb>
let onboarding: ReturnType<typeof openRoleDb>
const escritorios: Escritorio[] = []
const avulsos: SelfServiceTenant[] = []

const sessions: SessionVerifier = {
  async userIdFrom(request) {
    return /^Bearer token-([0-9a-f-]{36})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
  },
}
const catalogo: CatalogoDeServicos = { descricao: async (codigo) => (codigo === '010701' ? 'Suporte técnico em informática' : null) }

const URL_DA_ROTA = 'https://app.notechstack.com.br/api/v1/fiscal/emissao'
const CPF = '52998224725'
const CNPJ_TOMADOR = '11444777000161'

/** Corpo da rota: o erro e os campos lidos nos testes; o resto, conferido com toEqual/toMatchObject. */
type Corpo = { error: { code: string; message: string }; [campo: string]: unknown }
type Resposta = { status: number; corpo: Corpo }
type EmpresaDoContexto = { tenant_id: string; bloqueio: unknown }
type NotaDoRelatorio = { invoice_id: string; situacao: string; entregas: { canal: string; destino: string }[] }

async function chamar(userId: string | null, corpo: Record<string, unknown> | FormData, opcoes: { metodo?: string; agora?: Date } = {}): Promise<Resposta> {
  const headers: Record<string, string> = {}
  if (userId) headers.authorization = `Bearer token-${userId}`
  const form = corpo instanceof FormData
  if (!form) headers['content-type'] = 'application/json'
  const metodo = opcoes.metodo ?? 'POST'
  const response = await handlePainelEmissao(
    new Request(URL_DA_ROTA, { method: metodo, headers, body: metodo === 'GET' ? undefined : form ? corpo : JSON.stringify(corpo) }),
    { db: servico.db, sessions, catalogo, now: () => opcoes.agora ?? new Date() },
  )
  return { status: response.status, corpo: (await response.json()) as Corpo }
}

function planilha(conteudo: string, nome = 'novembro.csv', tipo = 'text/csv'): FormData {
  const form = new FormData()
  form.append('arquivo', new File([conteudo], nome, { type: tipo }))
  return form
}

async function notasDoTenant(tenantId: string) {
  const { rows } = await admin.db.query<{ id: string; external_id: string; status: string; payload: Record<string, unknown> }>(
    'select id, external_id, status, payload from nofiscal.fiscal_invoices where tenant_id = $1 order by created_at',
    [tenantId],
  )
  return rows
}

/** Escritório com A1 próprio, uma empresa cliente com A1 e uma sem A1 (bloqueada). */
async function novoEscritorio(opcoes: { semA1?: boolean } = {}) {
  const certificado = sharedTestCertificate().certificado
  const e = await createEscritorio(admin.db, {
    certificado,
    empresas: [
      { certificado, razaoSocial: 'Padaria Cliente Ltda' },
      { notAfter: null, razaoSocial: opcoes.semA1 === false ? 'Oficina' : 'Oficina Sem Certificado' },
    ],
  })
  escritorios.push(e)
  return { e, dono: e.mae.ownerUserId, cliente: e.empresas[0], semA1: e.empresas[1] }
}

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service', 'nofiscal_onboarding')
  servico = openRoleDb('nofiscal_service')
  onboarding = openRoleDb('nofiscal_onboarding')
})

afterAll(async () => {
  for (const e of escritorios) await dropEscritorio(admin.db, e)
  for (const s of avulsos) await dropSelfServiceTenant(admin.db, s)
  await servico?.pool.end()
  await onboarding?.pool.end()
  await admin.pool.end()
  await closeSharedDb()
})

describe('quem emite pelo painel', () => {
  it('sem sessão é 401, GET é 405 e conta Inicial/Pro não tem a aba', async () => {
    expect((await chamar(null, { acao: 'contexto' })).status).toBe(401)
    const { dono } = await novoEscritorio()
    expect((await chamar(dono, {}, { metodo: 'GET' })).status).toBe(405)

    const pro = await createSelfServiceTenant(admin.db, { plan: 'pro' })
    avulsos.push(pro)
    const r = await chamar(pro.ownerUserId, { acao: 'contexto' })
    expect(r.status).toBe(403)
    expect(r.corpo.error.code).toBe('SO_ESCRITORIO')
  })

  it('contexto: empresas ativas com o mesmo bloqueio do agente e a franquia do mês', async () => {
    const { e, dono, cliente, semA1 } = await novoEscritorio()
    const r = await chamar(dono, { acao: 'contexto' })
    expect(r.status).toBe(200)
    const porId = new Map((r.corpo.empresas as EmpresaDoContexto[]).map((x) => [x.tenant_id, x]))
    expect(porId.get(e.mae.tenant.id)).toMatchObject({ principal: true, bloqueio: null, codigo_servico_nacional: '010701' })
    expect(porId.get(cliente.id)).toMatchObject({ principal: false, bloqueio: null })
    expect(porId.get(semA1.id)?.bloqueio).toEqual({ codigo: 'CERT_MISSING', motivo: 'Oficina Sem Certificado ainda não tem certificado A1' })
    expect(r.corpo.franquia).toEqual({ limite: expect.any(Number), no_mes: 0 })
  })
})

describe('nota avulsa', () => {
  it('confere, emite uma vez só pela chave, sai por e-mail e aparece em Relatórios', async () => {
    const { e, dono, cliente } = await novoEscritorio()
    const pedido = { tenant_id: cliente.id, documento: '529.982.247-25', nome: 'Maria Tomadora', email: 'Maria@Tomador.test', valor: '1.234,50', codigo: '', descricao: '' }

    // Formulário com erro: o campo volta junto.
    const ruim = await chamar(dono, { ...pedido, acao: 'avulsa_conferir', documento: '123.456.789-00' })
    expect(ruim.status).toBe(422)
    expect(ruim.corpo).toMatchObject({ campo: 'documento', error: { code: 'VALIDATION_FAILED' } })

    // Resumo: código da empresa e descrição padrão quando ficam em branco, nome do serviço do catálogo.
    const conferido = await chamar(dono, { ...pedido, acao: 'avulsa_conferir' })
    expect(conferido.status).toBe(200)
    expect(conferido.corpo.resumo).toEqual({
      empresa: { tenant_id: cliente.id, razao_social: 'Padaria Cliente Ltda', cnpj: cliente.cnpj },
      tomador: { documento: CPF, tipo: 'cpf', nome: 'Maria Tomadora', email: 'maria@tomador.test' },
      servico: { codigo: '010701', nome: 'Suporte técnico em informática', descricao: 'Prestação de serviços' },
      valor: '1234.50',
      valor_texto: 'R$ 1.234,50',
    })
    expect(conferido.corpo.bloqueio).toBeNull()
    expect(conferido.corpo.avisos).toEqual([])
    expect(await notasDoTenant(cliente.id)).toHaveLength(0)

    // Emitir: a nota nasce na fila do motor, com o payload do agente; repetir a chave devolve a mesma nota.
    const chave = randomUUID()
    const emitida = await chamar(dono, { ...pedido, acao: 'avulsa_emitir', chave })
    expect(emitida.status).toBe(200)
    expect(emitida.corpo.status).toBe('queued')
    expect((await chamar(dono, { ...pedido, acao: 'avulsa_emitir', chave })).corpo.invoice_id).toBe(emitida.corpo.invoice_id)
    const [nota] = await notasDoTenant(cliente.id)
    expect(await notasDoTenant(cliente.id)).toHaveLength(1)
    expect(nota.external_id).toBe(`painel:${chave}`)
    expect(nota.payload).toEqual({
      tomador: { cpf: CPF, nome: 'Maria Tomadora', email: 'maria@tomador.test' },
      servico: { codigo_servico_nacional: '010701', descricao: 'Prestação de serviços' },
      valor: '1234.50',
    })

    // Sem chave não emite.
    expect((await chamar(dono, { ...pedido, acao: 'avulsa_emitir' })).corpo.campo).toBe('chave')

    // O resumo de uma nota igual avisa, e a franquia estourada também (a nota sai normalmente).
    await admin.db.query('update nofiscal.fiscal_tenants set monthly_note_limit = 1 where id = $1', [e.mae.tenant.id])
    const deNovo = await chamar(dono, { ...pedido, acao: 'avulsa_conferir' })
    expect(deNovo.corpo.avisos).toEqual([
      'Já há uma nota igual neste mês (mesma empresa, cliente e valor). Confira antes de emitir de novo.',
      'Franquia: com esta nota, o mês chega a 2 notas, acima das 1 do seu plano. A nota sai normalmente.',
    ])

    // Worker de sempre: autoriza e entrega por e-mail ao tomador e à conta do escritório, como a do WhatsApp.
    const canais = canaisDouble()
    const sefin = createSefinClient({ transport: fakeSefin().transport })
    await rodarWorker(servico.db, { sefin, tenantId: cliente.id, canais, now: () => new Date() })
    expect((await readInvoice(admin.db, nota.id)).status).toBe('issued')
    expect(canais.emails.filter((m) => m.assunto.startsWith('NFS-e')).map((m) => m.para).sort()).toEqual(
      ['maria@tomador.test', e.mae.ownerEmail].sort(),
    )

    // Relatórios (a mesma função do painel) mostra a nota, com as entregas.
    const mes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date())
    const { rows } = await admin.db.query<{ r: { notas: NotaDoRelatorio[] } }>('select public.fiscal_relatorio($1, $2::date, null) as r', [dono, `${mes}-01`])
    const daNota = rows[0].r.notas.find((n) => n.invoice_id === nota.id)
    expect(daNota).toMatchObject({ situacao: 'issued' })
    // Como a nota pedida no WhatsApp, o PDF também vai ao WhatsApp do dono da conta (entregas.ts, `dono_phone`).
    expect((daNota?.entregas ?? []).map((x) => [x.canal, x.destino]).sort()).toEqual(
      [['email', 'maria@tomador.test'], ['email', e.mae.ownerEmail], ['whatsapp', e.mae.ownerPhone]].sort(),
    )
  })

  it('empresa bloqueada não emite (mesmo emission_block do WhatsApp), e empresa de outra conta nem é aceita', async () => {
    const { dono, semA1 } = await novoEscritorio()
    const outro = await novoEscritorio()
    const pedido = { documento: CNPJ_TOMADOR, nome: 'Freguesa', valor: '50', chave: randomUUID() }

    const conferido = await chamar(dono, { ...pedido, tenant_id: semA1.id, acao: 'avulsa_conferir' })
    expect(conferido.corpo.bloqueio).toEqual({ codigo: 'CERT_MISSING', motivo: 'Oficina Sem Certificado ainda não tem certificado A1' })
    const barrada = await chamar(dono, { ...pedido, tenant_id: semA1.id, acao: 'avulsa_emitir' })
    expect(barrada.status).toBe(409)
    expect(barrada.corpo).toMatchObject({ bloqueio: 'CERT_MISSING', error: { code: 'EMISSAO_BLOQUEADA' } })
    expect(await notasDoTenant(semA1.id)).toHaveLength(0)

    const deOutro = await chamar(dono, { ...pedido, tenant_id: outro.cliente.id, acao: 'avulsa_emitir' })
    expect(deOutro.status).toBe(422)
    expect(deOutro.corpo.campo).toBe('tenant_id')
    expect(await notasDoTenant(outro.cliente.id)).toHaveLength(0)
    expect((await chamar(dono, { acao: 'modelos', tenant_id: outro.cliente.id })).status).toBe(404)

    // Empresa desativada também fica de fora.
    await admin.db.query('update nofiscal.fiscal_tenants set active = false where id = $1', [semA1.id])
    expect((await chamar(dono, { ...pedido, tenant_id: semA1.id, acao: 'avulsa_conferir' })).corpo.campo).toBe('tenant_id')
  })

  it('modelos salvos da empresa vêm para o formulário', async () => {
    const { dono, cliente } = await novoEscritorio()
    await criarModelo(admin.db, cliente.id, { nome: 'Prontia', documento: CNPJ_TOMADOR, nomeTomador: 'Prontia Ltda', email: 'fin@prontia.test', descricao: 'Consultoria mensal', valorPadrao: '350.00' })
    const r = await chamar(dono, { acao: 'modelos', tenant_id: cliente.id })
    expect(r.status).toBe(200)
    expect(r.corpo.modelos).toEqual([
      expect.objectContaining({ nome: 'Prontia', documento: CNPJ_TOMADOR, nome_tomador: 'Prontia Ltda', email: 'fin@prontia.test', codigo: '010701', descricao: 'Consultoria mensal', valor_padrao: '350.00' }),
    ])
  })

  it('empresa por procuração: a nota do painel assina com o A1 do escritório', async () => {
    const { e, dono, semA1 } = await novoEscritorio({ semA1: false })
    const adn: DistribuicaoAdn = {
      async baixarNfse() {
        return { kind: 'ok', xmls: [] }
      },
      async conferirProcuracao(): Promise<ConferenciaProcuracao> {
        return { kind: 'procuracao_ok' }
      },
    }
    const declarada = await handleOnboardingProcuracao(
      new Request('https://app.notechstack.com.br/api/v1/onboarding/procuracao', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer token-${dono}` },
        body: JSON.stringify({ tenant_id: semA1.id, acao: 'declarar' }),
      }),
      { db: onboarding.db, servico: servico.db, adn, sessions, now: () => new Date() },
    )
    expect(declarada.status).toBe(200)

    const r = await chamar(dono, { acao: 'avulsa_emitir', tenant_id: semA1.id, documento: CPF, nome: 'Maria', valor: '10', chave: randomUUID() })
    expect(r.status).toBe(200)
    const sefin = sefinDouble()
    const resumo = await runEmission({ db: servico.db, sefin: sefin.client, now: () => new Date(), tenantId: semA1.id })
    expect(resumo.issued).toBe(1)
    const emitir = sefin.calls.find((c) => c.op === 'emitir')
    expect(emitir?.certificado.pfxBase64).toBe(e.mae.tenant.certificado?.pfxBase64)
  })
})

describe('lote por planilha pelo painel', () => {
  it('resumo com erro por linha, mesma planilha recusada, confirmação uma vez só e retorno por e-mail', async () => {
    const { e, dono, cliente, semA1 } = await novoEscritorio()
    const csv = [
      'cnpj_prestador;cpf_cnpj_tomador;nome_tomador;email_tomador;valor;descricao',
      `${e.mae.tenant.cnpj};529.982.247-25;Maria Tomadora;maria@tomador.test;150,00;Honorários de novembro`,
      `${cliente.cnpj};11.444.777/0001-61;Padaria Freguesa;fin@freguesa.test;1.000,00;`,
      `${semA1.cnpj};${CPF};Maria Tomadora;;50;`,
      `${e.mae.tenant.cnpj};123;Zé;;10;`,
    ].join('\r\n')

    // Formato que o agente não lê: recusa sem gravar nada.
    const ods = await chamar(dono, planilha(csv, 'novembro.ods', 'application/vnd.oasis.opendocument.spreadsheet'))
    expect(ods.status).toBe(422)
    expect(ods.corpo).toMatchObject({ motivo: 'formato', error: { code: 'PLANILHA_RECUSADA' } })

    const lido = await chamar(dono, planilha(csv))
    expect(lido.status).toBe(200)
    expect(lido.corpo).toMatchObject({
      status: 'aguardando_confirmacao',
      arquivo: 'novembro.csv',
      linhas: 4,
      prontas: 2,
      total: '1150.00',
      franquia: { no_mes: 0, acima: 0 },
    })
    expect(lido.corpo.por_empresa).toEqual(
      expect.arrayContaining([
        { tenant_id: e.mae.tenant.id, razao_social: 'Escritório Toledo Contabilidade', notas: 1, total: '150.00' },
        { tenant_id: cliente.id, razao_social: 'Padaria Cliente Ltda', notas: 1, total: '1000.00' },
      ]),
    )
    expect(lido.corpo.problemas).toEqual([
      { linha: 4, codigo: 'CERT_MISSING', motivo: 'Oficina Sem Certificado ainda não tem certificado A1' },
      { linha: 5, codigo: 'DOCUMENTO_INVALIDO', motivo: 'CPF ou CNPJ do tomador inválido' },
    ])
    expect(lido.corpo.resumo_texto).toContain('Prontas para emitir: 2, total R$ 1.150,00.')
    const { rows: lotes } = await admin.db.query<{ phone_id: string | null; status: string }>(
      'select phone_id, status from nofiscal.fiscal_lotes where id = $1',
      [lido.corpo.lote_id],
    )
    expect(lotes).toEqual([{ phone_id: null, status: 'aguardando_confirmacao' }])

    // A mesma planilha esperando confirmação: recusa e aponta o lote aberto.
    const repetida = await chamar(dono, planilha(csv, 'novembro (1).csv'))
    expect(repetida.status).toBe(422)
    expect(repetida.corpo).toMatchObject({
      motivo: 'repetida',
      lote_id: lido.corpo.lote_id,
      error: { message: 'Esta planilha já foi lida e está esperando confirmação (aqui ou no WhatsApp). Descarte a anterior para ler de novo.' },
    })

    // Outra conta não confirma nem descarta este lote.
    const outro = await novoEscritorio()
    expect((await chamar(outro.dono, { acao: 'lote_confirmar', lote_id: lido.corpo.lote_id })).status).toBe(404)
    expect((await chamar(outro.dono, { acao: 'lote_descartar', lote_id: lido.corpo.lote_id })).status).toBe(404)

    // Confirmar: as linhas prontas viram nota ("lote:" + id da linha), uma vez só.
    const confirmado = await chamar(dono, { acao: 'lote_confirmar', lote_id: lido.corpo.lote_id })
    expect(confirmado.status).toBe(200)
    expect(confirmado.corpo).toEqual({ emitindo: 2, barradas: [] })
    const deNovo = await chamar(dono, { acao: 'lote_confirmar', lote_id: lido.corpo.lote_id })
    expect(deNovo.status).toBe(409)
    expect(deNovo.corpo.error.code).toBe('LOTE_FECHADO')
    expect((await notasDoTenant(e.mae.tenant.id)).map((n) => n.external_id)).toEqual([expect.stringMatching(/^lote:/)])
    expect(await notasDoTenant(cliente.id)).toHaveLength(1)

    // Worker: emite, e o retorno vai ao e-mail da conta (sem telefone de origem, sem janela aberta, nada no WhatsApp).
    const canais = canaisDouble()
    const sefin = createSefinClient({ transport: fakeSefin().transport })
    await rodarWorker(servico.db, { sefin, tenantId: cliente.id, canais, now: () => new Date() })
    await rodarWorker(servico.db, { sefin, tenantId: e.mae.tenant.id, canais, now: () => new Date() })
    const { rows: fechado } = await admin.db.query<{ status: string; retorno_enviado_em: Date | null }>(
      'select status, retorno_enviado_em from nofiscal.fiscal_lotes where id = $1',
      [lido.corpo.lote_id],
    )
    expect(fechado[0].status).toBe('concluido')
    expect(fechado[0].retorno_enviado_em).not.toBeNull()
    const retorno = canais.emails.filter((m) => m.assunto.startsWith('Retorno da planilha'))
    expect(retorno.map((m) => m.para)).toEqual([e.mae.ownerEmail])
    expect(canais.whatsapps).toEqual([])
  })

  it('descartar um lote aberto, e lote sem linha pronta já nasce descartado', async () => {
    const { e, dono } = await novoEscritorio()
    const lido = await chamar(dono, planilha(`cnpj_prestador;cpf_cnpj_tomador;nome_tomador;valor\n${e.mae.tenant.cnpj};${CPF};Maria;99,90\n`))
    expect(lido.corpo.status).toBe('aguardando_confirmacao')
    expect((await chamar(dono, { acao: 'lote_descartar', lote_id: lido.corpo.lote_id })).corpo).toEqual({ descartado: true })
    expect((await chamar(dono, { acao: 'lote_confirmar', lote_id: lido.corpo.lote_id })).status).toBe(409)
    expect(await notasDoTenant(e.mae.tenant.id)).toHaveLength(0)

    const semProntas = await chamar(dono, planilha(`cnpj_prestador;cpf_cnpj_tomador;nome_tomador;valor\n${e.mae.tenant.cnpj};123;Zé;10\n`, 'ruim.csv'))
    expect(semProntas.corpo).toMatchObject({ status: 'descartado', prontas: 0, problemas: [{ linha: 2, codigo: 'DOCUMENTO_INVALIDO' }] })

    const colunas = await chamar(dono, planilha('nome;valor\nMaria;10\n', 'colunas.csv'))
    expect(colunas.status).toBe(422)
    expect(colunas.corpo.motivo).toBe('colunas')
    expect(colunas.corpo.error.message).toContain('Faltam as colunas: cpf_cnpj_tomador')
  })
})
