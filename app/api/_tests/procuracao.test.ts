// Cadastro e emissão por procuração eletrônica (migração 20261111180000; handoff de 11/11/2026, P1).
// Banco local com os papéis de verdade (nofiscal_onboarding declara, nofiscal_service confere e emite); ADN e Sefin
// em dublê; a sessão é um verificador falso ("Bearer token-<user id>"). Confere: quem é o procurador, a declaração
// leva o cadastro aos dados fiscais, a conferência no ADN confirma ou segura a emissão (E2245), o motor assina com o
// A1 do procurador, a nota autorizada confirma a procuração, o E0718 fica registrado e o A1 próprio volta o modo.
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
  assinarTenant,
  createEscritorio,
  createSelfServiceTenant,
  dropEscritorio,
  dropSelfServiceTenant,
  openRoleDb,
  type Escritorio,
  type SelfServiceTenant,
} from './agente-fixtures.js'
import { createTestTenant, dropTestTenant, insertQueuedInvoice, openTestDb, readInvoice, sefinDouble, type TestTenant } from './fixtures.js'

const admin = openTestDb()
let onboarding: ReturnType<typeof openRoleDb>
let servico: ReturnType<typeof openRoleDb>
let configOriginal: string | null = null
let procurador: TestTenant
const outorgantes: SelfServiceTenant[] = []
const escritorios: Escritorio[] = []

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

async function novoOutorgante(etapa = 'certificado') {
  const s = await createSelfServiceTenant(admin.db, { notAfter: null, onboardingEtapa: etapa })
  outorgantes.push(s)
  await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
  return s
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
  // O procurador da plataforma é um tenant com A1 próprio (em produção, a nó).
  procurador = await createTestTenant(admin.db)
  const { rows } = await admin.db.query<{ valor: string }>(
    `select valor from nofiscal.fiscal_config where chave = 'procurador_plataforma_cnpj'`,
  )
  configOriginal = rows[0]?.valor ?? null
  await admin.db.query(
    `insert into nofiscal.fiscal_config (chave, valor) values ('procurador_plataforma_cnpj', $1)
     on conflict (chave) do update set valor = excluded.valor`,
    [procurador.cnpj],
  )
})

afterAll(async () => {
  for (const s of outorgantes) await dropSelfServiceTenant(admin.db, s)
  for (const e of escritorios) await dropEscritorio(admin.db, e)
  if (procurador) await dropTestTenant(admin.db, procurador.id)
  if (configOriginal !== null) {
    await admin.db.query(`update nofiscal.fiscal_config set valor = $1 where chave = 'procurador_plataforma_cnpj'`, [configOriginal])
  }
  await onboarding?.pool.end()
  await servico?.pool.end()
  await admin.pool.end()
  await closeSharedDb()
})

describe('cadastro por procuração', () => {
  it('consultar mostra o procurador da plataforma e que a empresa ainda usa o A1', async () => {
    const s = await novoOutorgante()
    const { adn } = adnDouble()
    const r = await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'consultar' }, adn)
    expect(r.status).toBe(200)
    const info = (await r.json()) as InfoProcuracao
    expect(info).toMatchObject({
      modo: 'certificado_proprio',
      disponivel: true,
      motivo: null,
      procuracao: null,
      procurador: { documento: procurador.cnpj, tipo: 'plataforma' },
    })
  })

  it('"já fiz" com a procuração no ADN: confirmada, modo procuração, cadastro nos dados fiscais e emissão liberada', async () => {
    const s = await novoOutorgante()
    const { adn, chamadas } = adnDouble([{ kind: 'procuracao_ok' }])
    const r = await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar', valida_ate: '2099-12-31' }, adn)
    expect(r.status).toBe(200)
    const corpo = (await r.json()) as InfoProcuracao & { conferencia: string }
    expect(corpo.conferencia).toBe('confirmada')
    expect(corpo.modo).toBe('procuracao')
    expect(corpo.procuracao).toMatchObject({ status: 'confirmada', fonte_conferencia: 'adn', valida_ate: '2099-12-31' })
    // O ADN foi consultado com o A1 do procurador e o CNPJ da empresa.
    expect(chamadas).toHaveLength(1)
    expect(chamadas[0].cnpjConsulta).toBe(s.tenant.cnpj)
    expect(chamadas[0].certificado.pfxBase64).toBe(procurador.certificado?.pfxBase64)
    expect(await tenantRow(s.tenant.id)).toEqual({ modo_autenticacao: 'procuracao', onboarding_etapa: 'dados_fiscais' })
    expect(await bloqueio(servico.db, s.tenant.id)).toBeNull()
  })

  it('E2245 no ADN: fica declarada, a emissão espera com PROCURACAO_NAO_ENCONTRADA e o worker confirma quando aparece', async () => {
    const s = await novoOutorgante()
    const semProcuracao = adnDouble([{ kind: 'sem_procuracao', codigo: 'E2245' }])
    const r = await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar' }, semProcuracao.adn)
    const corpo = (await r.json()) as InfoProcuracao & { conferencia: string }
    expect(corpo.conferencia).toBe('nao_encontrada')
    expect(corpo.procuracao).toMatchObject({ status: 'declarada', ultimo_erro: 'E2245' })
    expect(await bloqueio(servico.db, s.tenant.id)).toBe('PROCURACAO_NAO_ENCONTRADA')

    // "Conferir de novo" logo em seguida não chama o ADN (no máximo uma vez a cada 20 s).
    const recente = await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'conferir' }, semProcuracao.adn)
    expect(((await recente.json()) as { conferencia: string }).conferencia).toBe('recente')
    expect(semProcuracao.chamadas).toHaveLength(1)

    // Três minutos depois, o worker confere de novo e a procuração apareceu.
    const apareceu = adnDouble([{ kind: 'procuracao_ok' }])
    const daqui3min = () => new Date(Date.now() + 3 * 60_000)
    const resumo = await conferirPendentes({ db: servico.db, adn: apareceu.adn, now: daqui3min }, { tenantId: s.tenant.id })
    expect(resumo).toMatchObject({ conferidas: 1, confirmadas: 1 })
    expect(await procuracaoRow(s.tenant.id)).toMatchObject({ status: 'confirmada', ultimo_erro: null })
    expect(await bloqueio(servico.db, s.tenant.id)).toBeNull()
  })

  it('ADN fora do ar: fica declarada sem erro e a emissão não é segurada', async () => {
    const s = await novoOutorgante()
    const { adn } = adnDouble([{ kind: 'indisponivel', motivo: 'TRANSPORTE' }])
    const corpo = (await (await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar' }, adn)).json()) as InfoProcuracao & {
      conferencia: string
    }
    expect(corpo.conferencia).toBe('indisponivel')
    expect(corpo.procuracao).toMatchObject({ status: 'declarada', ultimo_erro: null })
    expect(await bloqueio(servico.db, s.tenant.id)).toBeNull()
  })

  it('recusa sem sessão, de outra pessoa, com validade passada e sem procurador configurado', async () => {
    const s = await novoOutorgante()
    const outro = await novoOutorgante()
    const { adn, chamadas } = adnDouble()
    expect((await chamar(null, { tenant_id: s.tenant.id, acao: 'declarar' }, adn)).status).toBe(401)
    expect((await chamar(outro.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar' }, adn)).status).toBe(403)
    expect((await chamar(outro.ownerUserId, { tenant_id: s.tenant.id, acao: 'consultar' }, adn)).status).toBe(403)
    const passada = await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar', valida_ate: '2020-01-01' }, adn)
    expect(passada.status).toBe(422)
    expect(((await passada.json()) as { error: { code: string } }).error.code).toBe('VALIDADE_PASSADA')
    expect((await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar', valida_ate: 'amanhã' }, adn)).status).toBe(422)

    await admin.db.query(`update nofiscal.fiscal_config set valor = '00000000000191' where chave = 'procurador_plataforma_cnpj'`)
    try {
      const sem = await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar' }, adn)
      expect(sem.status).toBe(409)
      expect(((await sem.json()) as { error: { code: string } }).error.code).toBe('PROCURADOR_INDISPONIVEL')
      const info = (await (await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'consultar' }, adn)).json()) as InfoProcuracao
      expect(info).toMatchObject({ disponivel: false, motivo: 'PROCURADOR_NAO_CONFIGURADO' })
    } finally {
      await admin.db.query(`update nofiscal.fiscal_config set valor = $1 where chave = 'procurador_plataforma_cnpj'`, [procurador.cnpj])
    }
    expect(chamadas).toHaveLength(0)
    expect(await tenantRow(s.tenant.id)).toEqual({ modo_autenticacao: 'certificado_proprio', onboarding_etapa: 'certificado' })
  })

  it('o procurador da plataforma não pode dar procuração a ele mesmo', async () => {
    const s = await novoOutorgante()
    await admin.db.query(`update nofiscal.fiscal_config set valor = $1 where chave = 'procurador_plataforma_cnpj'`, [s.tenant.cnpj])
    try {
      const { adn } = adnDouble()
      const info = (await (await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'consultar' }, adn)).json()) as InfoProcuracao
      expect(info).toMatchObject({ disponivel: false, motivo: 'PROCURADOR_E_A_PROPRIA_EMPRESA' })
    } finally {
      await admin.db.query(`update nofiscal.fiscal_config set valor = $1 where chave = 'procurador_plataforma_cnpj'`, [procurador.cnpj])
    }
  })
})

describe('emissão por procuração', () => {
  it('o motor assina e conecta com o A1 do procurador, e a nota autorizada confirma a procuração', async () => {
    const s = await novoOutorgante('concluido')
    const { adn } = adnDouble([{ kind: 'indisponivel', motivo: 'TRANSPORTE' }])
    await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar' }, adn)
    expect(await procuracaoRow(s.tenant.id)).toMatchObject({ status: 'declarada', fonte_conferencia: 'declaracao' })

    const nota = await insertQueuedInvoice(admin.db, s.tenant.id)
    const sefin = sefinDouble()
    const resumo = await runEmission({ db: servico.db, sefin: sefin.client, now: () => new Date(), tenantId: s.tenant.id })
    expect(resumo.issued).toBe(1)
    const emitir = sefin.calls.find((c) => c.op === 'emitir')
    expect(emitir?.certificado.pfxBase64).toBe(procurador.certificado?.pfxBase64)
    expect((await readInvoice(admin.db, nota.id)).status).toBe('issued')
    expect(await procuracaoRow(s.tenant.id)).toMatchObject({ status: 'confirmada', fonte_conferencia: 'emissao' })
  })

  it('E0718 da Sefin fica registrado na procuração', async () => {
    const s = await novoOutorgante('concluido')
    const { adn } = adnDouble([{ kind: 'indisponivel', motivo: 'TRANSPORTE' }])
    await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar' }, adn)
    const nota = await insertQueuedInvoice(admin.db, s.tenant.id)
    const sefin = sefinDouble({
      emitir: () => ({ kind: 'rejected', code: 'E0718', message: 'A assinatura deve ser feita com o certificado digital do emitente da DPS.' }),
    })
    await runEmission({ db: servico.db, sefin: sefin.client, now: () => new Date(), tenantId: s.tenant.id })
    expect((await readInvoice(admin.db, nota.id)).last_error_code).toBe('E0718')
    expect(await procuracaoRow(s.tenant.id)).toMatchObject({ status: 'declarada', ultimo_erro: 'E0718' })
  })

  it('procuração inválida ou vencida tira a empresa da fila e bloqueia com o código certo', async () => {
    const s = await novoOutorgante('concluido')
    const { adn } = adnDouble([{ kind: 'procuracao_ok' }])
    await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar' }, adn)
    const nota = await insertQueuedInvoice(admin.db, s.tenant.id)

    await admin.db.query(`update nofiscal.fiscal_procuracoes set status = 'invalida' where tenant_id = $1`, [s.tenant.id])
    expect(await bloqueio(servico.db, s.tenant.id)).toBe('PROCURACAO_INVALIDA')
    const sefin = sefinDouble()
    await runEmission({ db: servico.db, sefin: sefin.client, now: () => new Date(), tenantId: s.tenant.id })
    expect(sefin.calls).toHaveLength(0)
    expect((await readInvoice(admin.db, nota.id)).status).toBe('queued')

    await admin.db.query(`update nofiscal.fiscal_procuracoes set status = 'confirmada', valida_ate = '2020-01-01' where tenant_id = $1`, [s.tenant.id])
    expect(await bloqueio(servico.db, s.tenant.id)).toBe('PROCURACAO_VENCIDA')

    // A confirmada que some do ADN vira inválida na conferência diária.
    await admin.db.query(`update nofiscal.fiscal_procuracoes set valida_ate = null, conferida_em = now() - interval '2 days' where tenant_id = $1`, [s.tenant.id])
    const sumiu = adnDouble([{ kind: 'sem_procuracao', codigo: 'E2245' }])
    await conferirPendentes({ db: servico.db, adn: sumiu.adn, now: () => new Date() }, { tenantId: s.tenant.id })
    expect(await procuracaoRow(s.tenant.id)).toMatchObject({ status: 'invalida', ultimo_erro: 'E2245' })
  })

  it('enviar o A1 próprio depois volta a empresa ao modo certificado', async () => {
    const s = await novoOutorgante()
    const { adn } = adnDouble()
    await chamar(s.ownerUserId, { tenant_id: s.tenant.id, acao: 'declarar' }, adn)
    const { rows } = await onboarding.db.query<{ r: string }>(
      `select nofiscal.onboarding_set_certificate($1, $2, 'cGZ4', 'senha', $3, now() + interval '1 year') as r`,
      [s.ownerUserId, s.tenant.id, `EMPRESA TESTE:${s.tenant.cnpj}`],
    )
    expect(rows[0].r).toBe('OK')
    expect((await tenantRow(s.tenant.id)).modo_autenticacao).toBe('certificado_proprio')
    const certificado = await servico.db.query<{ modo: string }>('select modo from nofiscal.read_emission_certificate($1)', [s.tenant.id])
    expect(certificado.rows).toEqual([{ modo: 'certificado_proprio' }])
  })
})

describe('procuração no Escritório', () => {
  it('a empresa do escritório dá procuração ao escritório, que assina com o A1 dele', async () => {
    const e = await createEscritorio(admin.db, { empresas: [{ notAfter: null, razaoSocial: 'Padaria Cliente' }] })
    escritorios.push(e)
    const empresa = e.empresas[0]
    const { adn, chamadas } = adnDouble()
    const info = (await (await chamar(e.mae.ownerUserId, { tenant_id: empresa.id, acao: 'consultar' }, adn)).json()) as InfoProcuracao
    expect(info).toMatchObject({ disponivel: true, procurador: { documento: e.mae.tenant.cnpj, tipo: 'escritorio' } })

    await chamar(e.mae.ownerUserId, { tenant_id: empresa.id, acao: 'declarar' }, adn)
    expect(chamadas[0].certificado.pfxBase64).toBe(e.mae.tenant.certificado?.pfxBase64)
    expect((await procuracaoRow(empresa.id)).procurador_tenant_id).toBe(e.mae.tenant.id)

    const { rows } = await admin.db.query<{ estado: { empresas: { tenant_id: string; situacao: string; modo_autenticacao: string }[] } }>(
      'select public.fiscal_escritorio_estado($1) as estado',
      [e.mae.ownerUserId],
    )
    const linha = rows[0].estado.empresas.find((x) => x.tenant_id === empresa.id)
    expect(linha).toMatchObject({ modo_autenticacao: 'procuracao', situacao: 'pronta' })
  })

  it('escritório sem A1 próprio não recebe procuração', async () => {
    const e = await createEscritorio(admin.db, { notAfter: null, empresas: [{ notAfter: null }] })
    escritorios.push(e)
    const { adn } = adnDouble()
    const info = (await (await chamar(e.mae.ownerUserId, { tenant_id: e.empresas[0].id, acao: 'consultar' }, adn)).json()) as InfoProcuracao
    expect(info).toMatchObject({ disponivel: false, motivo: 'ESCRITORIO_SEM_CERTIFICADO' })
  })
})
