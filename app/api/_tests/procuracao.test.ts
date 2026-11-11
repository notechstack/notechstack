// Procuração eletrônica da empresa cliente ao ESCRITÓRIO (migrações 20261111180000 e 20261111220000).
// Banco local com os papéis de verdade (nofiscal_onboarding declara, nofiscal_service confere e emite); ADN e Sefin
// em dublê; a sessão é um verificador falso ("Bearer token-<user id>"). Confere: só empresa de escritório dá
// procuração, e sempre ao escritório (a nó não assina por ninguém); a declaração leva o cadastro aos dados fiscais;
// a conferência no ADN confirma ou segura a emissão (E2245); o motor assina com o A1 do escritório; a nota autorizada
// confirma a procuração; o E0718 fica registrado; e o A1 próprio volta o modo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConferenciaProcuracao, DistribuicaoAdn } from '../_lib/adn.js'
import { closeSharedDb, type Queryable } from '../_lib/db.js'
import { runEmission } from '../_lib/emission.js'
import { handleOnboardingProcuracao, type InfoProcuracao } from '../_lib/onboarding-procuracao.js'
import { conferirPendentes } from '../_lib/procuracao.js'
import type { Certificado } from '../_lib/sefin.js'
import type { SessionVerifier } from '../_lib/session.js'
import {
  allowTestUserToAssume,
  createEscritorio,
  createSelfServiceTenant,
  dropEscritorio,
  dropSelfServiceTenant,
  openRoleDb,
  type Escritorio,
  type SelfServiceTenant,
} from './agente-fixtures.js'
import { insertQueuedInvoice, openTestDb, readInvoice, sefinDouble, type TestTenant } from './fixtures.js'

const admin = openTestDb()
let onboarding: ReturnType<typeof openRoleDb>
let servico: ReturnType<typeof openRoleDb>
const escritorios: Escritorio[] = []
const avulsos: SelfServiceTenant[] = []

const sessions: SessionVerifier = {
  async userIdFrom(request) {
    return /^Bearer token-([0-9a-f-]{36})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
  },
}

function adnDouble(respostas: ConferenciaProcuracao[] = [{ kind: 'procuracao_ok' }]) {
  const chamadas: { cnpjConsulta: string; certificado: Certificado }[] = []
  const adn: DistribuicaoAdn = {
    async baixarNfse() {
      return { kind: 'ok', xmls: [] }
    },
    async conferirProcuracao(input) {
      chamadas.push({ cnpjConsulta: input.cnpjConsulta, certificado: input.certificado })
      return respostas.length > 1 ? respostas.shift()! : respostas[0]
    },
  }
  return { adn, chamadas }
}

function chamar(userId: string | null, corpo: Record<string, unknown>, adn: DistribuicaoAdn, now = () => new Date()) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (userId) headers.authorization = `Bearer token-${userId}`
  return handleOnboardingProcuracao(
    new Request('https://app.notechstack.com.br/api/v1/onboarding/procuracao', { method: 'POST', headers, body: JSON.stringify(corpo) }),
    { db: onboarding.db, servico: servico.db, adn, sessions, now },
  )
}

/** Escritório com A1 próprio (o procurador) e uma empresa cliente sem A1. */
async function novoEscritorio(opcoes: { a1DoEscritorio?: boolean } = {}) {
  const e = await createEscritorio(admin.db, {
    ...(opcoes.a1DoEscritorio === false ? { notAfter: null } : {}),
    empresas: [{ notAfter: null, razaoSocial: 'Padaria Cliente' }],
  })
  escritorios.push(e)
  return { e, empresa: e.empresas[0] as TestTenant, dono: e.mae.ownerUserId }
}

const bloqueio = async (db: Queryable, tenantId: string) =>
  (await db.query<{ b: string | null }>('select nofiscal.emission_block($1) as b', [tenantId])).rows[0].b

const tenantRow = async (tenantId: string) =>
  (
    await admin.db.query<{ modo_autenticacao: string; onboarding_etapa: string }>(
      'select modo_autenticacao, onboarding_etapa from nofiscal.fiscal_tenants where id = $1',
      [tenantId],
    )
  ).rows[0]

const procuracaoRow = async (tenantId: string) =>
  (
    await admin.db.query<{ status: string; fonte_conferencia: string | null; ultimo_erro: string | null; procurador_tenant_id: string }>(
      'select status, fonte_conferencia, ultimo_erro, procurador_tenant_id from nofiscal.fiscal_procuracoes where tenant_id = $1',
      [tenantId],
    )
  ).rows[0]

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service', 'nofiscal_onboarding')
  onboarding = openRoleDb('nofiscal_onboarding')
  servico = openRoleDb('nofiscal_service')
})

afterAll(async () => {
  for (const e of escritorios) await dropEscritorio(admin.db, e)
  for (const s of avulsos) await dropSelfServiceTenant(admin.db, s)
  await onboarding?.pool.end()
  await servico?.pool.end()
  await admin.pool.end()
  await closeSharedDb()
})

describe('quem pode dar procuração', () => {
  it('empresa cliente do escritório: o procurador é o escritório', async () => {
    const { e, empresa, dono } = await novoEscritorio()
    const { adn } = adnDouble()
    const r = await chamar(dono, { tenant_id: empresa.id, acao: 'consultar' }, adn)
    expect(r.status).toBe(200)
    expect((await r.json()) as InfoProcuracao).toMatchObject({
      modo: 'certificado_proprio',
      disponivel: true,
      motivo: null,
      procuracao: null,
      procurador: { documento: e.mae.tenant.cnpj, tipo: 'escritorio' },
    })
  })

  it('conta Inicial/Pro e a própria conta do escritório não dão procuração a ninguém (nem à nó)', async () => {
    const avulso = await createSelfServiceTenant(admin.db, { notAfter: null, onboardingEtapa: 'certificado' })
    avulsos.push(avulso)
    const { e, dono } = await novoEscritorio()
    const { adn, chamadas } = adnDouble()
    for (const [user, tenant] of [
      [avulso.ownerUserId, avulso.tenant.id],
      [dono, e.mae.tenant.id],
    ]) {
      const info = (await (await chamar(user, { tenant_id: tenant, acao: 'consultar' }, adn)).json()) as InfoProcuracao
      expect(info).toMatchObject({ disponivel: false, motivo: 'PROCURACAO_SO_NO_ESCRITORIO', procurador: null })
      const declarar = await chamar(user, { tenant_id: tenant, acao: 'declarar' }, adn)
      expect(declarar.status).toBe(409)
      expect(((await declarar.json()) as { error: { code: string } }).error.code).toBe('PROCURADOR_INDISPONIVEL')
      expect((await tenantRow(tenant)).modo_autenticacao).toBe('certificado_proprio')
    }
    expect(chamadas).toHaveLength(0)
    const { rows } = await admin.db.query(`select 1 from information_schema.tables where table_schema = 'nofiscal' and table_name = 'fiscal_config'`)
    expect(rows).toHaveLength(0)
  })

  it('escritório sem A1 próprio não recebe procuração', async () => {
    const { empresa, dono } = await novoEscritorio({ a1DoEscritorio: false })
    const { adn } = adnDouble()
    const info = (await (await chamar(dono, { tenant_id: empresa.id, acao: 'consultar' }, adn)).json()) as InfoProcuracao
    expect(info).toMatchObject({ disponivel: false, motivo: 'ESCRITORIO_SEM_CERTIFICADO' })
  })

  it('recusa sem sessão, de outra pessoa e com validade passada', async () => {
    const { empresa, dono } = await novoEscritorio()
    const outro = await novoEscritorio()
    const { adn, chamadas } = adnDouble()
    expect((await chamar(null, { tenant_id: empresa.id, acao: 'declarar' }, adn)).status).toBe(401)
    expect((await chamar(outro.dono, { tenant_id: empresa.id, acao: 'declarar' }, adn)).status).toBe(403)
    expect((await chamar(outro.dono, { tenant_id: empresa.id, acao: 'consultar' }, adn)).status).toBe(403)
    const passada = await chamar(dono, { tenant_id: empresa.id, acao: 'declarar', valida_ate: '2020-01-01' }, adn)
    expect(passada.status).toBe(422)
    expect(((await passada.json()) as { error: { code: string } }).error.code).toBe('VALIDADE_PASSADA')
    expect((await chamar(dono, { tenant_id: empresa.id, acao: 'declarar', valida_ate: 'amanhã' }, adn)).status).toBe(422)
    expect(chamadas).toHaveLength(0)
  })
})

describe('declaração e conferência', () => {
  it('"já fiz" com a procuração no ADN: confirmada, modo procuração e emissão liberada', async () => {
    const { e, empresa, dono } = await novoEscritorio()
    const { adn, chamadas } = adnDouble([{ kind: 'procuracao_ok' }])
    const r = await chamar(dono, { tenant_id: empresa.id, acao: 'declarar', valida_ate: '2099-12-31' }, adn)
    expect(r.status).toBe(200)
    const corpo = (await r.json()) as InfoProcuracao & { conferencia: string }
    expect(corpo.conferencia).toBe('confirmada')
    expect(corpo.modo).toBe('procuracao')
    expect(corpo.procuracao).toMatchObject({ status: 'confirmada', fonte_conferencia: 'adn', valida_ate: '2099-12-31' })
    // O ADN foi consultado com o A1 do escritório e o CNPJ da empresa cliente.
    expect(chamadas).toHaveLength(1)
    expect(chamadas[0].cnpjConsulta).toBe(empresa.cnpj)
    expect(chamadas[0].certificado.pfxBase64).toBe(e.mae.tenant.certificado?.pfxBase64)
    expect((await procuracaoRow(empresa.id)).procurador_tenant_id).toBe(e.mae.tenant.id)
    expect((await tenantRow(empresa.id)).modo_autenticacao).toBe('procuracao')
    expect(await bloqueio(servico.db, empresa.id)).toBeNull()

    const { rows } = await admin.db.query<{ estado: { empresas: { tenant_id: string; situacao: string; modo_autenticacao: string }[] } }>(
      'select public.fiscal_escritorio_estado($1) as estado',
      [dono],
    )
    expect(rows[0].estado.empresas.find((x) => x.tenant_id === empresa.id)).toMatchObject({ modo_autenticacao: 'procuracao', situacao: 'pronta' })
  })

  it('a declaração leva o cadastro da empresa de "certificado" para "dados fiscais"', async () => {
    const { empresa, dono } = await novoEscritorio()
    await admin.db.query(`update nofiscal.fiscal_tenants set onboarding_etapa = 'certificado' where id = $1`, [empresa.id])
    const { adn } = adnDouble()
    await chamar(dono, { tenant_id: empresa.id, acao: 'declarar' }, adn)
    expect(await tenantRow(empresa.id)).toEqual({ modo_autenticacao: 'procuracao', onboarding_etapa: 'dados_fiscais' })
  })

  it('E2245 no ADN: fica declarada, a emissão espera com PROCURACAO_NAO_ENCONTRADA e o worker confirma quando aparece', async () => {
    const { empresa, dono } = await novoEscritorio()
    const semProcuracao = adnDouble([{ kind: 'sem_procuracao', codigo: 'E2245' }])
    const corpo = (await (await chamar(dono, { tenant_id: empresa.id, acao: 'declarar' }, semProcuracao.adn)).json()) as InfoProcuracao & {
      conferencia: string
    }
    expect(corpo.conferencia).toBe('nao_encontrada')
    expect(corpo.procuracao).toMatchObject({ status: 'declarada', ultimo_erro: 'E2245' })
    expect(await bloqueio(servico.db, empresa.id)).toBe('PROCURACAO_NAO_ENCONTRADA')

    // "Conferir de novo" logo em seguida não chama o ADN (no máximo uma vez a cada 20 s).
    const recente = await chamar(dono, { tenant_id: empresa.id, acao: 'conferir' }, semProcuracao.adn)
    expect(((await recente.json()) as { conferencia: string }).conferencia).toBe('recente')
    expect(semProcuracao.chamadas).toHaveLength(1)

    const apareceu = adnDouble([{ kind: 'procuracao_ok' }])
    const daqui3min = () => new Date(Date.now() + 3 * 60_000)
    const resumo = await conferirPendentes({ db: servico.db, adn: apareceu.adn, now: daqui3min }, { tenantId: empresa.id })
    expect(resumo).toMatchObject({ conferidas: 1, confirmadas: 1 })
    expect(await procuracaoRow(empresa.id)).toMatchObject({ status: 'confirmada', ultimo_erro: null })
    expect(await bloqueio(servico.db, empresa.id)).toBeNull()
  })

  it('ADN fora do ar: fica declarada sem erro e a emissão não é segurada', async () => {
    const { empresa, dono } = await novoEscritorio()
    const { adn } = adnDouble([{ kind: 'indisponivel', motivo: 'TRANSPORTE' }])
    const corpo = (await (await chamar(dono, { tenant_id: empresa.id, acao: 'declarar' }, adn)).json()) as InfoProcuracao & {
      conferencia: string
    }
    expect(corpo.conferencia).toBe('indisponivel')
    expect(corpo.procuracao).toMatchObject({ status: 'declarada', ultimo_erro: null })
    expect(await bloqueio(servico.db, empresa.id)).toBeNull()
  })
})

describe('emissão por procuração', () => {
  it('o motor assina e conecta com o A1 do escritório, e a nota autorizada confirma a procuração', async () => {
    const { e, empresa, dono } = await novoEscritorio()
    const { adn } = adnDouble([{ kind: 'indisponivel', motivo: 'TRANSPORTE' }])
    await chamar(dono, { tenant_id: empresa.id, acao: 'declarar' }, adn)
    expect(await procuracaoRow(empresa.id)).toMatchObject({ status: 'declarada', fonte_conferencia: 'declaracao' })

    const nota = await insertQueuedInvoice(admin.db, empresa.id)
    const sefin = sefinDouble()
    const resumo = await runEmission({ db: servico.db, sefin: sefin.client, now: () => new Date(), tenantId: empresa.id })
    expect(resumo.issued).toBe(1)
    const emitir = sefin.calls.find((c) => c.op === 'emitir')
    expect(emitir?.certificado.pfxBase64).toBe(e.mae.tenant.certificado?.pfxBase64)
    expect((await readInvoice(admin.db, nota.id)).status).toBe('issued')
    expect(await procuracaoRow(empresa.id)).toMatchObject({ status: 'confirmada', fonte_conferencia: 'emissao' })
  })

  it('E0718 da Sefin fica registrado na procuração', async () => {
    const { empresa, dono } = await novoEscritorio()
    const { adn } = adnDouble([{ kind: 'indisponivel', motivo: 'TRANSPORTE' }])
    await chamar(dono, { tenant_id: empresa.id, acao: 'declarar' }, adn)
    const nota = await insertQueuedInvoice(admin.db, empresa.id)
    const sefin = sefinDouble({
      emitir: () => ({ kind: 'rejected', code: 'E0718', message: 'A assinatura deve ser feita com o certificado digital do emitente da DPS.' }),
    })
    await runEmission({ db: servico.db, sefin: sefin.client, now: () => new Date(), tenantId: empresa.id })
    expect((await readInvoice(admin.db, nota.id)).last_error_code).toBe('E0718')
    expect(await procuracaoRow(empresa.id)).toMatchObject({ status: 'declarada', ultimo_erro: 'E0718' })
  })

  it('procurador que não é o escritório da empresa não assina, mesmo gravado no banco', async () => {
    const { empresa, dono } = await novoEscritorio()
    const outro = await novoEscritorio()
    const { adn } = adnDouble()
    await chamar(dono, { tenant_id: empresa.id, acao: 'declarar' }, adn)
    const nota = await insertQueuedInvoice(admin.db, empresa.id)
    // Alguém grava outro procurador direto no banco: a view e o bloqueio recusam.
    await admin.db.query('update nofiscal.fiscal_procuracoes set procurador_tenant_id = $2 where tenant_id = $1', [empresa.id, outro.e.mae.tenant.id])
    expect(await bloqueio(servico.db, empresa.id)).toBe('PROCURACAO_INVALIDA')
    const certificados = await servico.db.query('select 1 from nofiscal.fiscal_certificados_de_emissao where tenant_id = $1', [empresa.id])
    expect(certificados.rows).toHaveLength(0)
    const sefin = sefinDouble()
    await runEmission({ db: servico.db, sefin: sefin.client, now: () => new Date(), tenantId: empresa.id })
    expect(sefin.calls).toHaveLength(0)
    expect((await readInvoice(admin.db, nota.id)).status).toBe('queued')
  })

  it('procuração inválida ou vencida tira a empresa da fila e bloqueia com o código certo', async () => {
    const { empresa, dono } = await novoEscritorio()
    const { adn } = adnDouble([{ kind: 'procuracao_ok' }])
    await chamar(dono, { tenant_id: empresa.id, acao: 'declarar' }, adn)
    const nota = await insertQueuedInvoice(admin.db, empresa.id)

    await admin.db.query(`update nofiscal.fiscal_procuracoes set status = 'invalida' where tenant_id = $1`, [empresa.id])
    expect(await bloqueio(servico.db, empresa.id)).toBe('PROCURACAO_INVALIDA')
    const sefin = sefinDouble()
    await runEmission({ db: servico.db, sefin: sefin.client, now: () => new Date(), tenantId: empresa.id })
    expect(sefin.calls).toHaveLength(0)
    expect((await readInvoice(admin.db, nota.id)).status).toBe('queued')

    await admin.db.query(`update nofiscal.fiscal_procuracoes set status = 'confirmada', valida_ate = '2020-01-01' where tenant_id = $1`, [empresa.id])
    expect(await bloqueio(servico.db, empresa.id)).toBe('PROCURACAO_VENCIDA')

    // A confirmada que some do ADN vira inválida na conferência diária.
    await admin.db.query(`update nofiscal.fiscal_procuracoes set valida_ate = null, conferida_em = now() - interval '2 days' where tenant_id = $1`, [empresa.id])
    const sumiu = adnDouble([{ kind: 'sem_procuracao', codigo: 'E2245' }])
    await conferirPendentes({ db: servico.db, adn: sumiu.adn, now: () => new Date() }, { tenantId: empresa.id })
    expect(await procuracaoRow(empresa.id)).toMatchObject({ status: 'invalida', ultimo_erro: 'E2245' })
  })

  it('enviar o A1 da empresa depois volta ao modo certificado próprio', async () => {
    const { empresa, dono } = await novoEscritorio()
    const { adn } = adnDouble()
    await chamar(dono, { tenant_id: empresa.id, acao: 'declarar' }, adn)
    const { rows } = await onboarding.db.query<{ r: string }>(
      `select nofiscal.onboarding_set_certificate($1, $2, 'cGZ4', 'senha', $3, now() + interval '1 year') as r`,
      [dono, empresa.id, `EMPRESA TESTE:${empresa.cnpj}`],
    )
    expect(rows[0].r).toBe('OK')
    expect((await tenantRow(empresa.id)).modo_autenticacao).toBe('certificado_proprio')
    const certificado = await servico.db.query<{ modo: string }>('select modo from nofiscal.read_emission_certificate($1)', [empresa.id])
    expect(certificado.rows).toEqual([{ modo: 'certificado_proprio' }])
  })
})
