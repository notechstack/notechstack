// API do parceiro (escritório com sistema próprio, white label), de ponta a ponta no banco local com o papel de
// produção (`nofiscal_service`). Sessão do painel: verificador falso; Sefin, e-mail, WhatsApp, Receita e a URL do
// webhook em dublê. Prova: a chave da conta-mãe é gerada e trocada no painel e emite por qualquer empresa ativa da
// conta (`cnpj_prestador`), passando pelo mesmo `emission_block` e pela retenção padrão da empresa; o webhook sai
// assinado, com reenvio e espera; a nota da API não vai ao WhatsApp, e `emails_da_no = false` corta os e-mails da nó;
// empresas entram e mostram a situação pela API, com o limite da conta e a procuração ao escritório.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedDb, type Db } from '../_lib/db.js'
import { handleNfseRequest } from '../_lib/nfse-routes.js'
import { handlePainelEmissao } from '../_lib/painel-emissao.js'
import type { Consulta } from '../_lib/parceiro/receita.js'
import { entregarWebhooks, type FetchLike } from '../_lib/parceiro/webhook.js'
import { urlDeWebhook } from '../_lib/parceiro/painel-integracao.js'
import type { EnderecoDoTomador } from '../_lib/retencao.js'
import type { SessionVerifier } from '../_lib/session.js'
import { createSefinClient } from '../_lib/sefin-client.js'
import { handleWorkerRequest } from '../_lib/worker-route.js'
import {
  allowTestUserToAssume,
  canaisDouble,
  createEscritorio,
  dropEscritorio,
  LINKS_DE_TESTE,
  openRoleDb,
  type Escritorio,
} from './agente-fixtures.js'
import { sharedTestCertificate } from './certs.js'
import { openTestDb, readInvoice, type TestTenant } from './fixtures.js'
import { fakeSefin } from './sefin-fake.js'

const admin = openTestDb()
let servico: ReturnType<typeof openRoleDb>
const escritorios: Escritorio[] = []

const sessions: SessionVerifier = {
  async userIdFrom(request) {
    return /^Bearer token-([0-9a-f-]{36})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
  },
}

const CPF = '52998224725'

/** CNPJ aleatório com dígitos verificadores certos (as empresas cadastradas pela API passam por `cnpjValido`). */
function cnpjNovo(): string {
  const base = Array.from(randomBytes(12), (b) => b % 10)
  const dv = (n: number[], pesos: number[]) => {
    const r = n.reduce((s, d, i) => s + d * pesos[i], 0) % 11
    return r < 2 ? 0 : 11 - r
  }
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = dv([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  return [...base, d1, d2].join('')
}
const CNPJ_TOMADOR = '11444777000161'
const API = 'https://app.notechstack.com.br/api'

type Corpo = { error: { code: string; message: string }; [campo: string]: unknown }

/** Dublê da URL do webhook: guarda cada POST e responde com os status da fila (o último se repete). */
function urlDoParceiro(statuses: number[] = [200]) {
  const recebidos: { url: string; headers: Record<string, string>; body: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    recebidos.push({ url, headers: init.headers, body: init.body })
    const status = statuses[Math.min(recebidos.length - 1, statuses.length - 1)]
    return { ok: status >= 200 && status < 300, status }
  }
  return { fetch, recebidos }
}

async function painel(userId: string, corpo: Record<string, unknown>, fetch?: FetchLike): Promise<{ status: number; corpo: Corpo }> {
  const r = await handlePainelEmissao(
    new Request(`${API}/v1/fiscal/emissao`, {
      method: 'POST',
      headers: { authorization: `Bearer token-${userId}`, 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    }),
    { db: servico.db, sessions, fetch },
  )
  return { status: r.status, corpo: (await r.json()) as Corpo }
}

const RECEITA: Record<string, Consulta> = {}
// Como a consulta real: Presumido/Real declarado só vale quando a Receita diz "fora do Simples" (com os dados).
const receita = async (cnpj: string, regimeDeclarado?: 'presumido' | 'real' | null): Promise<Consulta> => {
  const r = RECEITA[cnpj] ?? { ok: false, motivo: 'nao_encontrado' }
  if (!r.ok && r.motivo === 'fora_do_simples' && r.dados && regimeDeclarado) return { ok: true, dados: { ...r.dados, regime: regimeDeclarado } }
  return r
}
const enderecos: EnderecoDoTomador = {
  endereco: async () => ({ cMun: '3550308', cep: '01001000', logradouro: 'Praça da Sé', numero: '1', complemento: null, bairro: 'Sé' }),
}

async function api(chave: string | null, metodo: string, caminho: string, corpo?: unknown): Promise<{ status: number; corpo: Corpo }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (chave) headers['x-api-key'] = chave
  const r = await handleNfseRequest(new Request(`${API}${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) }), {
    db: servico.db,
    receita,
    enderecos,
  })
  const tipo = r.headers.get('content-type') ?? ''
  return { status: r.status, corpo: (tipo.includes('json') ? await r.json() : { error: { code: '', message: '' }, bruto: await r.text() }) as Corpo }
}

async function rodarWorker(db: Db, tenantId: string, fetch: FetchLike, canais = canaisDouble()) {
  const now = () => new Date()
  const r = await handleWorkerRequest(new Request(`${API}/internal/nfse-worker`, { headers: { authorization: 'Bearer segredo' } }), {
    db,
    sefin: createSefinClient({ transport: fakeSefin().transport }),
    cronSecret: 'segredo',
    fetch,
    now,
    tenantId,
    agente: { whatsapp: canais.whatsapp, email: canais.email, links: LINKS_DE_TESTE, now },
  })
  expect(r.status).toBe(200)
  return { resumo: (await r.json()) as Record<string, unknown>, canais }
}

/** Escritório com A1 próprio, uma empresa com A1 (Padaria) e uma sem A1 (Oficina, bloqueada). */
async function novoEscritorio() {
  const certificado = sharedTestCertificate().certificado
  const e = await createEscritorio(admin.db, {
    certificado,
    empresas: [
      { certificado, razaoSocial: 'Padaria Cliente Ltda' },
      { notAfter: null, razaoSocial: 'Oficina Sem Certificado' },
    ],
  })
  escritorios.push(e)
  return { e, dono: e.mae.ownerUserId, padaria: e.empresas[0], oficina: e.empresas[1] }
}

async function chaveDoPainel(dono: string): Promise<string> {
  const r = await painel(dono, { acao: 'chave_gerar' })
  expect(r.status).toBe(200)
  return r.corpo.chave as string
}

const venda = (externalId: string, extra: Record<string, unknown> = {}) => ({
  external_id: externalId,
  tomador: { cpf: CPF, nome: 'Maria Tomadora', email: 'maria@tomador.test' },
  valor: '150.00',
  ...extra,
})

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
  servico = openRoleDb('nofiscal_service')
})

afterAll(async () => {
  for (const e of escritorios) await dropEscritorio(admin.db, e)
  await servico?.pool.end()
  await admin.pool.end()
  await closeSharedDb()
})

describe('chave do parceiro', () => {
  it('é gerada no painel, aparece uma vez, troca invalida a anterior e emite por qualquer empresa ativa da conta', async () => {
    const { e, dono, padaria, oficina } = await novoEscritorio()

    const vazio = await painel(dono, { acao: 'integracao' })
    expect(vazio.corpo).toMatchObject({ chave: null, webhook: { url: null, tem_segredo: false }, emails_da_no: true, entregas: [] })

    const primeira = await chaveDoPainel(dono)
    expect(primeira).toMatch(/^nfk_[A-Za-z0-9_-]{43}$/)
    const estado = await painel(dono, { acao: 'integracao' })
    expect(estado.corpo.chave).toMatchObject({ prefixo: primeira.slice(0, 10) })
    expect(JSON.stringify(estado.corpo)).not.toContain(primeira)
    const { rows } = await admin.db.query<{ h: string }>('select api_key_hash as h from nofiscal.fiscal_tenants where id = $1', [e.mae.tenant.id])
    expect(rows[0].h).toMatch(/^[0-9a-f]{64}$/)

    // Troca: a anterior para na hora.
    const chave = await chaveDoPainel(dono)
    expect(chave).not.toBe(primeira)
    expect((await api(primeira, 'GET', '/v1/empresas')).status).toBe(401)
    expect((await api(e.mae.tenant.apiKey, 'GET', '/v1/empresas')).status).toBe(401)

    // Sem cnpj_prestador, a conta-mãe emite; com ele, a empresa.
    const daMae = await api(chave, 'POST', '/v1/nfse', venda('pedido-mae'))
    expect(daMae.status).toBe(202)
    expect(daMae.corpo).toMatchObject({ status: 'queued', cnpj_prestador: e.mae.tenant.cnpj, origem: 'api', avisos: [] })
    const daPadaria = await api(chave, 'POST', '/v1/nfse', venda('pedido-1', { cnpj_prestador: padaria.cnpj }))
    expect(daPadaria.status).toBe(202)
    expect(daPadaria.corpo).toMatchObject({ cnpj_prestador: padaria.cnpj, valor: '150.00', tomador_documento: CPF })
    const nota = await readInvoice(admin.db, daPadaria.corpo.id as string)
    expect(nota).toMatchObject({ tenant_id: padaria.id, origem: 'api' })
    // Código da empresa e descrição padrão quando o pedido não traz o serviço.
    expect(nota.payload).toEqual({
      tomador: { cpf: CPF, nome: 'Maria Tomadora', email: 'maria@tomador.test' },
      servico: { codigo_servico_nacional: '010701', descricao: 'Prestação de serviços' },
      valor: '150.00',
    })

    // Idempotência por empresa: o mesmo external_id devolve a mesma nota; em outra empresa é outra nota.
    const repetido = await api(chave, 'POST', '/v1/nfse', venda('pedido-1', { cnpj_prestador: padaria.cnpj, valor: '999.00' }))
    expect(repetido.corpo.id).toBe(daPadaria.corpo.id)
    expect((await api(chave, 'POST', '/v1/nfse', venda('pedido-1'))).corpo.id).not.toBe(daPadaria.corpo.id)

    // Consulta por id (qualquer empresa da conta) e por external_id.
    expect((await api(chave, 'GET', `/v1/nfse/${daPadaria.corpo.id}`)).corpo).toMatchObject({ id: daPadaria.corpo.id, cnpj_prestador: padaria.cnpj })
    expect((await api(chave, 'GET', `/v1/nfse?external_id=pedido-1&cnpj_prestador=${padaria.cnpj}`)).corpo.id).toBe(daPadaria.corpo.id)

    // Empresa sem A1: o mesmo emission_block do WhatsApp e do painel.
    const bloqueada = await api(chave, 'POST', '/v1/nfse', venda('pedido-2', { cnpj_prestador: oficina.cnpj }))
    expect(bloqueada.status).toBe(409)
    expect(bloqueada.corpo).toMatchObject({ bloqueio: 'CERT_MISSING', error: { code: 'EMISSAO_BLOQUEADA' } })

    // Empresa de outra conta, ou desativada.
    const outra = await novoEscritorio()
    const deOutra = await api(chave, 'POST', '/v1/nfse', venda('pedido-3', { cnpj_prestador: outra.padaria.cnpj }))
    expect(deOutra.status).toBe(404)
    expect(deOutra.corpo.error.code).toBe('EMPRESA_NAO_ENCONTRADA')
    expect((await api(chave, 'GET', `/v1/nfse/${(await api(await chaveDoPainel(outra.dono), 'POST', '/v1/nfse', venda('x'))).corpo.id}`)).status).toBe(404)
    await admin.db.query('update nofiscal.fiscal_tenants set active = false where id = $1', [padaria.id])
    const inativa = await api(chave, 'POST', '/v1/nfse', venda('pedido-4', { cnpj_prestador: padaria.cnpj }))
    expect(inativa.corpo.error.code).toBe('EMPRESA_INATIVA')
    await admin.db.query('update nofiscal.fiscal_tenants set active = true where id = $1', [padaria.id])

    // Franquia: avisa e a nota sai.
    await admin.db.query('update nofiscal.fiscal_tenants set monthly_note_limit = 1 where id = $1', [e.mae.tenant.id])
    const acima = await api(chave, 'POST', '/v1/nfse', venda('pedido-5', { cnpj_prestador: padaria.cnpj }))
    expect(acima.status).toBe(202)
    expect((acima.corpo.avisos as string[])[0]).toMatch(/^Franquia: o mês está em \d+ notas, acima das 1 do plano/)
  })

  it('leva NBS, IBS/CBS, local da prestação e informações complementares ao payload do worker', async () => {
    const { dono, padaria } = await novoEscritorio()
    const chave = await chaveDoPainel(dono)
    const r = await api(chave, 'POST', '/v1/nfse', {
      ...venda('rtc-1', { cnpj_prestador: padaria.cnpj }),
      servico: { descricao: 'Consultoria', nbs: '1.1502.10.00', c_ind_op: '100301', c_class_trib: '000001', municipio_prestacao_ibge: '3509502' },
      informacoes_complementares: 'Banco 001, agência 1234',
    })
    expect(r.status).toBe(202)
    expect((await readInvoice(admin.db, r.corpo.id as string)).payload).toEqual({
      tomador: { cpf: CPF, nome: 'Maria Tomadora', email: 'maria@tomador.test' },
      servico: {
        codigo_servico_nacional: '010701',
        descricao: 'Consultoria',
        municipio_prestacao_ibge: '3509502',
        nbs: '115021000',
        c_ind_op: '100301',
        c_class_trib: '000001',
      },
      valor: '150.00',
      informacoes_complementares: 'Banco 001, agência 1234',
    })
  })

  it('aplica a retenção padrão da empresa e aceita a retenção do pedido', async () => {
    const { dono, padaria } = await novoEscritorio()
    const chave = await chaveDoPainel(dono)
    await admin.db.query(`update nofiscal.fiscal_tenants set retem_inss = true, inss_percentual = 11 where id = $1`, [padaria.id])

    const comPadrao = await api(chave, 'POST', '/v1/nfse', {
      ...venda('ret-1', { cnpj_prestador: padaria.cnpj }),
      tomador: { cnpj: CNPJ_TOMADOR, nome: 'Hospital Alfa' },
      valor: '1000.00',
    })
    expect(comPadrao.status).toBe(202)
    expect((await readInvoice(admin.db, comPadrao.corpo.id as string)).payload).toMatchObject({ retencao: { inss: { valor: '110.00' } } })

    // ISS retido no pedido: endereço do tomador vem da Receita.
    const comIss = await api(chave, 'POST', '/v1/nfse', {
      ...venda('ret-2', { cnpj_prestador: padaria.cnpj }),
      tomador: { cnpj: CNPJ_TOMADOR, nome: 'Hospital Alfa' },
      valor: '1000.00',
      retencao: { retem_iss: true, aliquota_iss: '2.5', retem_inss: false },
    })
    expect(comIss.status).toBe(202)
    const payload = (await readInvoice(admin.db, comIss.corpo.id as string)).payload as Record<string, unknown>
    expect(payload.retencao).toMatchObject({ iss: { aliquota: '2.50' } })
    expect((payload.tomador as Record<string, unknown>).endereco).toMatchObject({ cMun: '3550308' })

    // ISS retido para CPF: recusado com o campo.
    const cpf = await api(chave, 'POST', '/v1/nfse', venda('ret-3', { cnpj_prestador: padaria.cnpj, retencao: { retem_iss: true, aliquota_iss: 2 } }))
    expect(cpf.status).toBe(422)
    expect(cpf.corpo).toMatchObject({ motivo: 'ISS_RETIDO_CPF' })

    // Campo desconhecido continua recusado (nenhuma rota aceita certificado por engano).
    expect((await api(chave, 'POST', '/v1/nfse', venda('ret-4', { pfx: 'MIIK' }))).corpo.error.code).toBe('UNKNOWN_FIELD')
  })
})

describe('webhook de retorno', () => {
  it('assina com HMAC, entrega cada evento uma vez e reenvia com espera quando a URL falha', async () => {
    const { e, dono, padaria } = await novoEscritorio()
    const chave = await chaveDoPainel(dono)

    expect((await painel(dono, { acao: 'webhook_salvar', url: 'http://parceiro.test/x' })).status).toBe(422)
    expect((await painel(dono, { acao: 'webhook_salvar', url: 'https://169.254.169.254/latest' })).status).toBe(422)
    const salvo = await painel(dono, { acao: 'webhook_salvar', url: 'https://erp.parceiro.test/nofiscal/webhook' })
    expect(salvo.status).toBe(200)
    const segredo = salvo.corpo.segredo as string
    expect(segredo).toMatch(/^whsec_/)
    // Mudar a URL mantém o segredo; pedir um novo troca.
    expect((await painel(dono, { acao: 'webhook_salvar', url: 'https://erp.parceiro.test/nofiscal/webhook' })).corpo.segredo).toBeNull()

    // Teste do painel: uma tentativa, assinada.
    const teste = urlDoParceiro([204])
    expect((await painel(dono, { acao: 'webhook_testar' }, teste.fetch)).corpo).toEqual({ ok: true, http: 204 })
    expect(JSON.parse(teste.recebidos[0].body)).toMatchObject({ evento: 'teste' })
    expect(teste.recebidos[0].headers['x-nofiscal-signature']).toBe(`sha256=${createHmac('sha256', segredo).update(teste.recebidos[0].body).digest('hex')}`)

    const pedido = await api(chave, 'POST', '/v1/nfse', venda('wh-1', { cnpj_prestador: padaria.cnpj }))
    const url = urlDoParceiro([500, 200])
    const { canais, resumo } = await rodarWorker(servico.db, padaria.id, url.fetch)
    expect((await readInvoice(admin.db, pedido.corpo.id as string)).status).toBe('issued')
    expect(resumo.webhooks).toEqual({ entregues: 0, reagendadas: 1, desistidas: 0 })

    // Nota da API: nada no WhatsApp; os e-mails da nó saem (padrão).
    expect(canais.whatsapps).toEqual([])
    expect(canais.emails.map((m) => m.para).sort()).toEqual(['maria@tomador.test', e.mae.ownerEmail].sort())

    // A primeira tentativa falhou (500): fica pendente com espera de 1 minuto.
    const { rows: fila } = await admin.db.query<{ id: string; status: string; tentativas: number; ultimo_http: number; espera: number }>(
      `select id, status, tentativas, ultimo_http, extract(epoch from proxima_em - updated_at)::int as espera
         from nofiscal.fiscal_webhook_entregas where documento_id = $1`,
      [pedido.corpo.id],
    )
    expect(fila).toEqual([{ id: expect.any(String), status: 'pendente', tentativas: 1, ultimo_http: 500, espera: 60 }])

    // Antes da hora não reenvia; depois, entrega com a mesma entrega_id e a assinatura certa.
    expect(await entregarWebhooks({ db: servico.db, fetch: url.fetch, now: () => new Date(), donoId: e.mae.tenant.id })).toEqual({ entregues: 0, reagendadas: 0, desistidas: 0 })
    expect(await entregarWebhooks({ db: servico.db, fetch: url.fetch, now: () => new Date(Date.now() + 2 * 60_000), donoId: e.mae.tenant.id })).toEqual({
      entregues: 1,
      reagendadas: 0,
      desistidas: 0,
    })
    expect(url.recebidos).toHaveLength(2)
    const ultimo = url.recebidos[1]
    expect(ultimo.url).toBe('https://erp.parceiro.test/nofiscal/webhook')
    expect(ultimo.headers['x-nofiscal-signature']).toBe(`sha256=${createHmac('sha256', segredo).update(ultimo.body).digest('hex')}`)
    expect(ultimo.headers['x-nofiscal-entrega']).toBe(fila[0].id)
    expect(ultimo.headers['x-nofiscal-tentativa']).toBe('2')
    const corpo = JSON.parse(ultimo.body)
    expect(corpo).toMatchObject({
      evento: 'nfse.emitida',
      recurso: 'nfse',
      entrega_id: fila[0].id,
      id: pedido.corpo.id,
      external_id: 'wh-1',
      status: 'issued',
      cnpj_prestador: padaria.cnpj,
      chave_acesso: expect.stringMatching(/^\d{50}$/),
      numero: expect.any(String),
    })
    expect(JSON.parse(url.recebidos[0].body).entrega_id).toBe(fila[0].id)

    // Painel mostra a entrega; outra rodada não reenvia o que já foi entregue.
    const estado = await painel(dono, { acao: 'integracao' })
    expect((estado.corpo.entregas as { status: string; evento: string }[])[0]).toMatchObject({ status: 'entregue', evento: 'nfse.emitida' })
    expect((await rodarWorker(servico.db, padaria.id, url.fetch)).resumo.webhooks).toEqual({ entregues: 0, reagendadas: 0, desistidas: 0 })

    // Cancelamento pela API: evento próprio.
    const cancel = await api(chave, 'POST', `/v1/nfse/${pedido.corpo.id}/cancel`)
    expect(cancel.status).toBe(202)
    expect(cancel.corpo.status).toBe('cancel_requested')
    await rodarWorker(servico.db, padaria.id, url.fetch)
    expect(JSON.parse(url.recebidos[url.recebidos.length - 1].body)).toMatchObject({ evento: 'nfse.cancelada', status: 'cancelled' })
  })

  it('desiste depois de 8 tentativas, e o painel reenvia', async () => {
    const { e, dono, padaria } = await novoEscritorio()
    const chave = await chaveDoPainel(dono)
    await painel(dono, { acao: 'webhook_salvar', url: 'https://erp.parceiro.test/hook' })
    const fora = urlDoParceiro([503])
    await api(chave, 'POST', '/v1/nfse', venda('wh-2', { cnpj_prestador: padaria.cnpj }))
    await rodarWorker(servico.db, padaria.id, fora.fetch)
    let agora = Date.now()
    for (let i = 0; i < 7; i++) {
      agora += 25 * 3600_000
      await entregarWebhooks({ db: servico.db, fetch: fora.fetch, now: () => new Date(agora), donoId: e.mae.tenant.id })
    }
    expect(fora.recebidos).toHaveLength(8)
    const { rows } = await admin.db.query<{ id: string; status: string; tentativas: number }>(
      'select id, status, tentativas from nofiscal.fiscal_webhook_entregas where dono_tenant_id = $1',
      [e.mae.tenant.id],
    )
    expect(rows).toEqual([{ id: expect.any(String), status: 'desistiu', tentativas: 8 }])

    expect((await painel(dono, { acao: 'webhook_reenviar', entrega_id: rows[0].id })).status).toBe(200)
    const volta = urlDoParceiro([200])
    expect(await entregarWebhooks({ db: servico.db, fetch: volta.fetch, now: () => new Date(agora), donoId: e.mae.tenant.id })).toMatchObject({ entregues: 1 })
  })

  it('emails_da_no = false: a nó não manda e-mail de nota (o parceiro entrega)', async () => {
    const { dono, padaria } = await novoEscritorio()
    const chave = await chaveDoPainel(dono)
    expect((await painel(dono, { acao: 'emails_da_no', ativo: false })).corpo).toEqual({ emails_da_no: false })
    const pedido = await api(chave, 'POST', '/v1/nfse', venda('wl-1', { cnpj_prestador: padaria.cnpj }))
    const { canais } = await rodarWorker(servico.db, padaria.id, urlDoParceiro().fetch)
    expect((await readInvoice(admin.db, pedido.corpo.id as string)).status).toBe('issued')
    expect(canais.emails.filter((m) => m.assunto.startsWith('NFS-e'))).toEqual([])
    expect(canais.whatsapps).toEqual([])
  })
})

describe('conta parceira (white label)', () => {
  it('nenhum e-mail nem WhatsApp de nota da nó, nem para nota pedida pelo painel; o webhook avisa', async () => {
    const { e, dono, padaria } = await novoEscritorio()
    // Só a nó liga (função do service_role); o painel mostra e trava a caixa dos e-mails.
    const { rows } = await admin.db.query<{ r: { ok: boolean } }>('select public.fiscal_definir_white_label($1, true) as r', [e.mae.tenant.id])
    expect(rows[0].r.ok).toBe(true)
    expect((await painel(dono, { acao: 'integracao' })).corpo).toMatchObject({ white_label: true, emails_da_no: false })
    await painel(dono, { acao: 'emails_da_no', ativo: true })
    await painel(dono, { acao: 'webhook_salvar', url: 'https://erp.parceiro.test/hook' })

    // Nota do painel (não da API), com e-mail do tomador: mesmo assim nada sai da nó.
    const chave = randomUUID()
    const avulsa = await painel(dono, { acao: 'avulsa_emitir', chave, tenant_id: padaria.id, documento: CPF, nome: 'Maria Tomadora', email: 'maria@tomador.test', valor: '80,00' })
    expect(avulsa.status).toBe(200)
    const url = urlDoParceiro()
    const { canais } = await rodarWorker(servico.db, padaria.id, url.fetch)
    expect((await readInvoice(admin.db, avulsa.corpo.invoice_id as string)).status).toBe('issued')
    expect(canais.emails).toEqual([])
    expect(canais.whatsapps).toEqual([])
    expect(url.recebidos.map((r) => JSON.parse(r.body).evento)).toEqual(['nfse.emitida'])
  })
})

describe('empresas pela API', () => {
  it('cadastra a empresa cliente, mostra a situação, declara a procuração e respeita o limite da conta', async () => {
    const { e, dono, padaria, oficina } = await novoEscritorio()
    const chave = await chaveDoPainel(dono)

    const lista = await api(chave, 'GET', '/v1/empresas')
    expect(lista.status).toBe(200)
    const porCnpj = new Map((lista.corpo.empresas as { cnpj: string; situacao: string; principal: boolean }[]).map((x) => [x.cnpj, x]))
    expect(porCnpj.get(e.mae.tenant.cnpj)).toMatchObject({ principal: true, situacao: 'pronta' })
    expect(porCnpj.get(padaria.cnpj)).toMatchObject({ situacao: 'pronta' })
    expect(porCnpj.get(oficina.cnpj)).toMatchObject({ situacao: 'falta_a1', bloqueio: { codigo: 'CERT_MISSING' } })

    // CNPJ novo: dados da Receita, código de serviço e percentual do Simples; sem A1 → falta_a1.
    const cnpj = cnpjNovo()
    RECEITA[cnpj] = {
      ok: true,
      dados: { cnpj, razao_social: 'Clínica Nova Ltda', municipio: 'SAO PAULO', uf: 'SP', codigo_municipio_ibge: '3550308', cnae: '8630503', regime: 'simples' },
    }
    expect((await api(chave, 'POST', '/v1/empresas', { cnpj, codigo_servico_nacional: '040101' })).corpo).toMatchObject({ campo: 'simples_percentual' })
    const criada = await api(chave, 'POST', '/v1/empresas', {
      cnpj,
      codigo_servico_nacional: '040101',
      simples_percentual: '6.00',
      retencao: { retem_iss: true, aliquota_iss: '2', retem_inss: false },
    })
    expect(criada.status).toBe(201)
    expect(criada.corpo.empresa).toMatchObject({
      cnpj,
      razao_social: 'Clínica Nova Ltda',
      regime: 'simples',
      situacao: 'falta_a1',
      autenticacao: 'certificado_proprio',
      procurador: { cnpj: e.mae.tenant.cnpj },
      dados_fiscais: { codigo_servico_nacional: '040101', simples_percentual: '6.00' },
      retencao: { retem_iss: true, aliquota_iss: '2.00', retem_inss: false },
    })
    const { rows } = await admin.db.query<{ id: string; ambiente: string }>('select id, ambiente from nofiscal.fiscal_tenants where cnpj = $1', [cnpj])
    e.empresas.push({ id: rows[0].id } as TestTenant)
    expect(rows[0].ambiente).toBe('producao_restrita')

    // Repetir o POST não muda nada.
    expect((await api(chave, 'POST', '/v1/empresas', { cnpj, codigo_servico_nacional: '010101', simples_percentual: '4' })).corpo).toMatchObject({
      criada: false,
      empresa: { dados_fiscais: { codigo_servico_nacional: '040101' } },
    })

    // Procuração ao escritório (PATCH): passa a emitir com o A1 do escritório; a nó nunca assina.
    const proc = await api(chave, 'PATCH', `/v1/empresas/${cnpj}`, { procuracao: { valida_ate: null } })
    expect(proc.status).toBe(200)
    expect(proc.corpo.empresa).toMatchObject({ autenticacao: 'procuracao', situacao: 'pronta', procuracao: { status: 'declarada' } })
    const { rows: procuradores } = await admin.db.query<{ procurador: string }>(
      'select procurador_tenant_id as procurador from nofiscal.fiscal_procuracoes where tenant_id = $1',
      [rows[0].id],
    )
    expect(procuradores).toEqual([{ procurador: e.mae.tenant.id }])

    // PATCH de dados fiscais e consulta individual.
    expect((await api(chave, 'PATCH', `/v1/empresas/${cnpj}`, { simples_percentual: '8.5' })).corpo.empresa).toMatchObject({
      dados_fiscais: { codigo_servico_nacional: '040101', simples_percentual: '8.50' },
    })
    expect((await api(chave, 'GET', `/v1/empresas/${cnpj}`)).corpo.empresa).toMatchObject({ cnpj })
    expect((await api(chave, 'GET', '/v1/empresas/00000000000000')).status).toBe(404)

    // Receita: não encontrado, fora do Simples; CNPJ de outra conta; limite da conta (escritorio_5).
    expect((await api(chave, 'POST', '/v1/empresas', { cnpj: '11444777000161', codigo_servico_nacional: '040101', simples_percentual: '6' })).corpo.error.code).toBe(
      'CNPJ_NAO_ENCONTRADO',
    )
    const outra = await novoEscritorio()
    outra.padaria.cnpj = cnpjNovo()
    await admin.db.query('update nofiscal.fiscal_tenants set cnpj = $2 where id = $1', [outra.padaria.id, outra.padaria.cnpj])
    RECEITA[outra.padaria.cnpj] = { ok: true, dados: { ...(RECEITA[cnpj] as { ok: true; dados: { cnpj: string } }).dados, cnpj: outra.padaria.cnpj } as never }
    expect((await api(chave, 'POST', '/v1/empresas', { cnpj: outra.padaria.cnpj, codigo_servico_nacional: '040101', simples_percentual: '6' })).status).toBe(409)
    const quinta = cnpjNovo()
    RECEITA[quinta] = { ok: true, dados: { cnpj: quinta, razao_social: 'Quinta', municipio: 'X', uf: 'SP', codigo_municipio_ibge: '3550308', cnae: null, regime: 'mei' } }
    const r5 = await api(chave, 'POST', '/v1/empresas', { cnpj: quinta, codigo_servico_nacional: '040101' })
    expect(r5.status).toBe(201)
    const { rows: q } = await admin.db.query<{ id: string }>('select id from nofiscal.fiscal_tenants where cnpj = $1', [quinta])
    e.empresas.push({ id: q[0].id } as TestTenant)
    await admin.db.query('update nofiscal.fiscal_tenants set max_empresas_override = 5 where id = $1', [e.mae.tenant.id])
    const sexta = cnpjNovo()
    RECEITA[sexta] = { ok: true, dados: { cnpj: sexta, razao_social: 'Sexta', municipio: 'X', uf: 'SP', codigo_municipio_ibge: '3550308', cnae: null, regime: 'mei' } }
    const acima = await api(chave, 'POST', '/v1/empresas', { cnpj: sexta, codigo_servico_nacional: '040101' })
    expect(acima.status).toBe(409)
    expect(acima.corpo).toMatchObject({ limite: 5, error: { code: 'EMPRESAS_ACIMA_DO_LIMITE' } })
  })
})

describe('empresas do Lucro Presumido pela API (19/11/2026)', () => {
  it('pede o regime no Rio, recusa fora das cidades de emissor pleno e grava os percentuais da Lei 12.741', async () => {
    const { e, dono } = await novoEscritorio()
    const chave = await chaveDoPainel(dono)
    const rio = cnpjNovo()
    RECEITA[rio] = {
      ok: false,
      motivo: 'fora_do_simples',
      dados: { cnpj: rio, razao_social: 'Consultoria Rio Ltda', municipio: 'RIO DE JANEIRO', uf: 'RJ', codigo_municipio_ibge: '3304557', cnae: null },
    }
    const semRegime = await api(chave, 'POST', '/v1/empresas', { cnpj: rio, codigo_servico_nacional: '170201' })
    expect(semRegime.status).toBe(422)
    expect(semRegime.corpo).toMatchObject({ campo: 'regime', error: { code: 'REGIME_A_DECLARAR' } })
    const semTributos = await api(chave, 'POST', '/v1/empresas', { cnpj: rio, regime: 'presumido', codigo_servico_nacional: '170201' })
    expect(semTributos.corpo).toMatchObject({ campo: 'tributos_aproximados' })
    const criada = await api(chave, 'POST', '/v1/empresas', {
      cnpj: rio,
      regime: 'presumido',
      codigo_servico_nacional: '170201',
      tributos_aproximados: { federal: '13.45', municipal: 5 },
    })
    expect(criada.status).toBe(201)
    expect(criada.corpo.empresa).toMatchObject({
      regime: 'presumido',
      situacao: 'falta_a1',
      dados_fiscais: { codigo_servico_nacional: '170201', simples_percentual: null, tributos_aproximados: { federal: '13.45', estadual: '0.00', municipal: '5.00' } },
    })
    const { rows } = await admin.db.query<{ id: string }>('select id from nofiscal.fiscal_tenants where cnpj = $1', [rio])
    e.empresas.push({ id: rows[0].id } as TestTenant)
    const patch = await api(chave, 'PATCH', `/v1/empresas/${rio}`, { tributos_aproximados: { federal: '14', municipal: '2' } })
    expect(patch.status).toBe(200)
    expect((patch.corpo.empresa as { dados_fiscais: { tributos_aproximados: unknown } }).dados_fiscais.tributos_aproximados).toEqual({ federal: '14.00', estadual: '0.00', municipal: '2.00' })

    const sp = cnpjNovo()
    RECEITA[sp] = {
      ok: false,
      motivo: 'fora_do_simples',
      dados: { cnpj: sp, razao_social: 'Consultoria SP Ltda', municipio: 'SAO PAULO', uf: 'SP', codigo_municipio_ibge: '3550308', cnae: null },
    }
    const fora = await api(chave, 'POST', '/v1/empresas', { cnpj: sp, regime: 'presumido', codigo_servico_nacional: '170201' })
    expect(fora.status).toBe(422)
    expect(fora.corpo).toMatchObject({ lista_espera: true, error: { code: 'FORA_DO_SIMPLES' } })
    expect(fora.corpo.error.message).toMatch(/Lucro Presumido e Real/)
    expect((await api(chave, 'POST', '/v1/empresas', { cnpj: sp, regime: 'arbitrado', codigo_servico_nacional: '170201' })).corpo).toMatchObject({ campo: 'regime' })
  })
})

describe('NF-e pela API', () => {
  it('passa pelo mesmo bloqueio e pela mesma validação do painel', async () => {
    const { dono, padaria } = await novoEscritorio()
    const chave = await chaveDoPainel(dono)
    const pedido = {
      external_id: 'nfe-1',
      cnpj_emitente: padaria.cnpj,
      destinatario: {
        documento: CPF,
        nome: 'Maria Compradora',
        endereco: { logradouro: 'Rua A', numero: '10', bairro: 'Centro', codigo_municipio: '3550308', uf: 'SP', cep: '01001000' },
      },
      itens: [{ codigo: 'P1', descricao: 'Produto', ncm: '61091000', cfop: '5102', unidade: 'UN', quantidade: 1, valor_unitario: 50, csosn: '102' }],
    }
    expect((await api(chave, 'POST', '/v1/nfe', { ...pedido, certificado: 'x' })).corpo.error.code).toBe('UNKNOWN_FIELD')
    expect((await api(chave, 'POST', '/v1/nfe', { ...pedido, itens: [{ ...pedido.itens[0], quantidade: 'um' }] })).corpo.error.message).toMatch(/itens\[0\]\.quantidade/)
    // A empresa ainda não tem IE nem endereço para NF-e: o mesmo nfe_emission_block do painel.
    const bloqueada = await api(chave, 'POST', '/v1/nfe', pedido)
    expect(bloqueada.status).toBe(409)
    expect(bloqueada.corpo).toMatchObject({ bloqueio: 'NFE_SEM_IE', error: { code: 'EMISSAO_BLOQUEADA' } })
    expect((await api(chave, 'GET', '/v1/nfe?external_id=nfe-1&cnpj_emitente=' + padaria.cnpj)).status).toBe(404)
    expect((await api(chave, 'GET', `/v1/nfe/${randomUUID()}`)).status).toBe(404)
  })
})

describe('URL do webhook', () => {
  it('só https público', () => {
    expect(urlDeWebhook('https://erp.parceiro.com.br/hook?x=1#a')).toBe('https://erp.parceiro.com.br/hook?x=1')
    for (const ruim of ['http://erp.com/x', 'https://localhost/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://user:pw@erp.com/x', 'https://intranet/x', 'https://192.168.0.10/x', 'ftp://x.com', 42]) {
      expect(urlDeWebhook(ruim), String(ruim)).toBeNull()
    }
  })
})
