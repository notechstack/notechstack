// Sandbox da API do parceiro (chave `nfk_test_…`), de ponta a ponta no banco local com o papel de produção
// (`nofiscal_service`). Prova: a chave sandbox valida igual à produção e grava só nas tabelas do sandbox; nada chega
// ao worker nem à Sefin (nem numeração de DPS, franquia ou `fiscal_invoices`); a chave de produção não enxerga nota
// sandbox e a sandbox não enxerga nota real; status, PDF com a tarja, cancelamento, valores mágicos e webhook sandbox.
import { createHmac, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeSharedDb } from '../_lib/db.js'
import { handleNfseRequest } from '../_lib/nfse-routes.js'
import { handlePainelEmissao } from '../_lib/painel-emissao.js'
import { gerarChave, gerarChaveSandbox } from '../_lib/parceiro/chave.js'
import type { FetchLike } from '../_lib/parceiro/webhook.js'
import type { EnderecoDoTomador } from '../_lib/retencao.js'
import { ATRASO_MS, SEFIN_FORA_MS } from '../_lib/sandbox/notas.js'
import type { SessionVerifier } from '../_lib/session.js'
import { createSefinClient } from '../_lib/sefin-client.js'
import { handleWorkerRequest } from '../_lib/worker-route.js'
import { allowTestUserToAssume, canaisDouble, createEscritorio, dropEscritorio, LINKS_DE_TESTE, openRoleDb, type Escritorio } from './agente-fixtures.js'
import { sharedTestCertificate } from './certs.js'
import { openTestDb } from './fixtures.js'
import { pdfTexts } from './pdf-text.js'
import { fakeSefin } from './sefin-fake.js'

const admin = openTestDb()
let servico: ReturnType<typeof openRoleDb>
const escritorios: Escritorio[] = []

const sessions: SessionVerifier = {
  async userIdFrom(request) {
    return /^Bearer token-([0-9a-f-]{36})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
  },
}

const API = 'https://app.notechstack.com.br/api'
const CPF = '52998224725'
const enderecos: EnderecoDoTomador = {
  endereco: async () => ({ cMun: '3550308', cep: '01001000', logradouro: 'Praça da Sé', numero: '1', complemento: null, bairro: 'Sé' }),
}

type Corpo = { error: { code: string; message: string }; [campo: string]: unknown }

/** Relógio e agenda controlados: as rodadas agendadas pela rota ficam na fila até o teste rodar. */
function ambiente(inicio = new Date()) {
  let agora = inicio
  const agendadas: { tarefa: () => Promise<void>; quando: number }[] = []
  const recebidos: { url: string; headers: Record<string, string>; body: string }[] = []
  const fetch: FetchLike = async (url, init) => {
    recebidos.push({ url, headers: init.headers, body: init.body })
    return { ok: true, status: 200 }
  }
  return {
    now: () => agora,
    avancar(ms: number) {
      agora = new Date(agora.getTime() + ms)
    },
    agendadas,
    recebidos,
    fetch,
    agendar: (tarefa: () => Promise<void>, atrasoMs: number) => agendadas.push({ tarefa, quando: agora.getTime() + atrasoMs }),
    /** Roda as rodadas agendadas cuja hora chegou (como o waitUntil faria). */
    async rodarAgendadas() {
      const prontas = agendadas.filter((a) => a.quando <= agora.getTime())
      for (const a of prontas) agendadas.splice(agendadas.indexOf(a), 1)
      for (const a of prontas) await a.tarefa()
      return prontas.length
    },
  }
}

type Amb = ReturnType<typeof ambiente>

async function api(amb: Amb, chave: string | null, metodo: string, caminho: string, corpo?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (chave) headers['x-api-key'] = chave
  const r = await handleNfseRequest(new Request(`${API}${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) }), {
    db: servico.db,
    enderecos,
    now: amb.now,
    fetch: amb.fetch,
    agendar: amb.agendar,
  })
  const tipo = r.headers.get('content-type') ?? ''
  if (tipo.includes('json')) return { status: r.status, tipo, corpo: (await r.json()) as Corpo, bytes: null }
  return { status: r.status, tipo, corpo: { error: { code: '', message: '' } } as Corpo, bytes: new Uint8Array(await r.arrayBuffer()) }
}

/** Escritório com A1 próprio, uma empresa com A1 (Padaria) e uma sem A1 (Oficina). */
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

/** A chave sandbox entra no banco como o script da nó grava: só o hash, pela função do service_role. */
async function chaveSandbox(contaId: string): Promise<string> {
  const g = gerarChaveSandbox()
  const { rows } = await admin.db.query<{ r: { ok: boolean } }>('select public.fiscal_definir_chave_sandbox($1, $2, $3) as r', [contaId, g.hash, g.prefixo])
  expect(rows[0].r.ok).toBe(true)
  return g.chave
}

async function chaveDeProducao(dono: string): Promise<string> {
  const r = await handlePainelEmissao(
    new Request(`${API}/v1/fiscal/emissao`, {
      method: 'POST',
      headers: { authorization: `Bearer token-${dono}`, 'content-type': 'application/json' },
      body: JSON.stringify({ acao: 'chave_gerar' }),
    }),
    { db: servico.db, sessions },
  )
  return ((await r.json()) as { chave: string }).chave
}

const venda = (externalId: string, extra: Record<string, unknown> = {}) => ({
  external_id: externalId,
  tomador: { cpf: CPF, nome: 'Maria Tomadora', email: 'maria@tomador.test' },
  valor: '150.00',
  ...extra,
})

/** Tudo o que o motor real conta de uma empresa: notas, numeração de DPS, eventos e webhooks de produção. */
async function retratoDoMotor(tenantIds: string[]) {
  const { rows } = await admin.db.query<{ notas: string; numeros: string; eventos: string; webhooks: string }>(
    `select (select count(*) from nofiscal.fiscal_invoices where tenant_id = any($1::uuid[]))::text as notas,
            (select coalesce(string_agg(tenant_id || ':' || serie || ':' || next_number, ',' order by tenant_id, serie), '')
               from nofiscal.fiscal_dps_series where tenant_id = any($1::uuid[])) as numeros,
            (select count(*) from nofiscal.fiscal_invoice_events e join nofiscal.fiscal_invoices i on i.id = e.invoice_id
              where i.tenant_id = any($1::uuid[]))::text as eventos,
            (select count(*) from nofiscal.fiscal_webhook_entregas w
              where w.dono_tenant_id in (select coalesce(escritorio_tenant_id, id) from nofiscal.fiscal_tenants where id = any($1::uuid[])))::text as webhooks`,
    [tenantIds],
  )
  return rows[0]
}

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

describe('chave sandbox', () => {
  it('valida igual, simula a emissão e nunca chega ao worker, à Sefin, à numeração nem à franquia', async () => {
    const amb = ambiente()
    const { e, padaria, oficina } = await novoEscritorio()
    const chave = await chaveSandbox(e.mae.tenant.id)
    expect(chave).toMatch(/^nfk_test_[A-Za-z0-9_-]{43}$/)
    const antes = await retratoDoMotor([e.mae.tenant.id, padaria.id, oficina.id])

    // A mesma validação da produção: corpo, campo desconhecido, empresa da conta, retenção.
    expect((await api(amb, chave, 'POST', '/v1/nfse', { ...venda('x'), certificado: 'pfx' })).corpo.error.code).toBe('UNKNOWN_FIELD')
    expect((await api(amb, chave, 'POST', '/v1/nfse', venda('x', { valor: '1,5' }))).corpo.error.code).toBe('VALIDATION_FAILED')
    expect((await api(amb, chave, 'POST', '/v1/nfse', venda('x', { cnpj_prestador: '11444777000161' }))).corpo.error.code).toBe('EMPRESA_NAO_ENCONTRADA')
    const issCpf = await api(amb, chave, 'POST', '/v1/nfse', venda('x', { cnpj_prestador: padaria.cnpj, retencao: { retem_iss: true, aliquota_iss: '2' } }))
    expect(issCpf.corpo).toMatchObject({ error: { code: 'VALIDATION_FAILED' }, motivo: 'ISS_RETIDO_CPF' })

    const criada = await api(amb, chave, 'POST', '/v1/nfse', venda('pedido-1', { cnpj_prestador: padaria.cnpj }))
    expect(criada.status).toBe(202)
    expect(criada.corpo).toMatchObject({ status: 'queued', ambiente: 'sandbox', cnpj_prestador: padaria.cnpj, valor: '150.00', avisos: [] })
    // Idempotência por empresa, como na produção.
    expect((await api(amb, chave, 'POST', '/v1/nfse', venda('pedido-1', { cnpj_prestador: padaria.cnpj, valor: '9.00' }))).corpo.id).toBe(criada.corpo.id)

    // Empresa sem A1: na produção, 409; no sandbox, emite e avisa o que barraria.
    const semA1 = await api(amb, chave, 'POST', '/v1/nfse', venda('pedido-2', { cnpj_prestador: oficina.cnpj }))
    expect(semA1.status).toBe(202)
    expect((semA1.corpo.avisos as string[])[0]).toMatch(/^Sandbox: em produção esta nota seria barrada agora \(CERT_MISSING\)/)

    // O worker roda para as empresas: não pega nada do sandbox e não fala com a Sefin.
    const sefin = fakeSefin()
    for (const t of [padaria.id, oficina.id, e.mae.tenant.id]) {
      const r = await handleWorkerRequest(new Request(`${API}/internal/nfse-worker`, { headers: { authorization: 'Bearer segredo' } }), {
        db: servico.db,
        sefin: createSefinClient({ transport: sefin.transport }),
        cronSecret: 'segredo',
        fetch: amb.fetch,
        now: amb.now,
        tenantId: t,
        agente: { whatsapp: canaisDouble().whatsapp, email: canaisDouble().email, links: LINKS_DE_TESTE, now: amb.now },
      })
      expect(r.status).toBe(200)
      expect(await r.json()).toMatchObject({ claimed: 0, issued: 0 })
    }
    expect(sefin.requests).toEqual([])
    expect((await api(amb, chave, 'GET', `/v1/nfse/${criada.corpo.id}`)).corpo.status).toBe('queued')

    // A "Sefin" do sandbox responde depois de ATRASO_MS: pela rodada agendada (waitUntil) ou na próxima chamada.
    amb.avancar(ATRASO_MS + 500)
    expect(await amb.rodarAgendadas()).toBeGreaterThan(0)
    const emitida = await api(amb, chave, 'GET', `/v1/nfse/${criada.corpo.id}`)
    expect(emitida.corpo).toMatchObject({ status: 'issued', numero: '1', numero_dps: '1', ambiente: 'sandbox' })
    expect(emitida.corpo.chave_acesso).toMatch(/^\d{7}22\d{14}0{12}1\d{4}\d{9}0$/)
    expect(String(emitida.corpo.chave_acesso).slice(9, 23)).toBe(padaria.cnpj)
    expect((await api(amb, chave, 'GET', `/v1/nfse?external_id=pedido-1&cnpj_prestador=${padaria.cnpj}`)).corpo.id).toBe(criada.corpo.id)

    // XML: DPS do buildDps, produção restrita, série do sandbox; PDF com a tarja.
    const xml = await api(amb, chave, 'GET', `/v1/nfse/${criada.corpo.id}/xml`)
    const texto = Buffer.from(xml.bytes!).toString('utf8')
    expect(texto).toContain('<tpAmb>2</tpAmb>')
    expect(texto).toContain('<serie>49999</serie>')
    expect(texto).toContain('<xNome>Padaria Cliente Ltda</xNome>')
    const pdf = await api(amb, chave, 'GET', `/v1/nfse/${criada.corpo.id}/pdf`)
    expect(pdf.tipo).toBe('application/pdf')
    expect(pdfTexts(pdf.bytes!).join(' ')).toContain('NFS-e SEM VALIDADE JURÍDICA')

    // Nada mudou no motor: nenhuma nota real, nenhum número de DPS, nenhum evento, nenhum webhook de produção.
    expect(await retratoDoMotor([e.mae.tenant.id, padaria.id, oficina.id])).toEqual(antes)
    const { rows } = await admin.db.query<{ n: string }>(
      `select count(*)::text as n from nofiscal.fiscal_sandbox_invoices where dono_tenant_id = $1`,
      [e.mae.tenant.id],
    )
    expect(rows[0].n).toBe('2')
  })

  it('a chave de produção não enxerga nota sandbox, e a sandbox não enxerga nota real', async () => {
    const amb = ambiente()
    const { e, dono, padaria } = await novoEscritorio()
    const sandbox = await chaveSandbox(e.mae.tenant.id)
    const producao = await chaveDeProducao(dono)
    expect(producao).toMatch(/^nfk_(?!test_)/)

    const real = await api(amb, producao, 'POST', '/v1/nfse', venda('mesmo-pedido', { cnpj_prestador: padaria.cnpj }))
    const teste = await api(amb, sandbox, 'POST', '/v1/nfse', venda('mesmo-pedido', { cnpj_prestador: padaria.cnpj }))
    expect(real.status).toBe(202)
    expect(teste.status).toBe(202)
    expect(teste.corpo.id).not.toBe(real.corpo.id)
    expect(real.corpo).not.toHaveProperty('ambiente')

    // Por id, por external_id, cancelamento, PDF e XML: cada chave só no seu mundo.
    for (const acao of ['', '/pdf', '/xml']) {
      expect((await api(amb, producao, 'GET', `/v1/nfse/${teste.corpo.id}${acao}`)).status).toBe(404)
      expect((await api(amb, sandbox, 'GET', `/v1/nfse/${real.corpo.id}${acao}`)).status).toBe(404)
    }
    expect((await api(amb, producao, 'POST', `/v1/nfse/${teste.corpo.id}/cancel`)).status).toBe(404)
    expect((await api(amb, sandbox, 'POST', `/v1/nfse/${real.corpo.id}/cancel`)).status).toBe(404)
    const { rows } = await admin.db.query<{ status: string }>('select status from nofiscal.fiscal_invoices where id = $1', [real.corpo.id])
    expect(rows[0].status).toBe('queued')
    const q = `/v1/nfse?external_id=mesmo-pedido&cnpj_prestador=${padaria.cnpj}`
    expect((await api(amb, producao, 'GET', q)).corpo.id).toBe(real.corpo.id)
    expect((await api(amb, sandbox, 'GET', q)).corpo.id).toBe(teste.corpo.id)

    // Sandbox de outra conta não vê a nota sandbox desta.
    const outra = await novoEscritorio()
    const daOutra = await chaveSandbox(outra.e.mae.tenant.id)
    expect((await api(amb, daOutra, 'GET', `/v1/nfse/${teste.corpo.id}`)).status).toBe(404)

    // Rotas de cada mundo.
    expect((await api(amb, producao, 'GET', '/v1/sandbox/webhook')).corpo.error.code).toBe('SO_SANDBOX')
    expect((await api(amb, sandbox, 'POST', '/v1/nfe', {})).corpo.error.code).toBe('SANDBOX_SEM_NFE')
    expect((await api(amb, sandbox, 'POST', '/v1/empresas', { cnpj: '11444777000161' })).corpo.error.code).toBe('SANDBOX_SOMENTE_LEITURA')
    expect((await api(amb, sandbox, 'PATCH', `/v1/empresas/${padaria.cnpj}`, {})).corpo.error.code).toBe('SANDBOX_SOMENTE_LEITURA')
    const lista = await api(amb, sandbox, 'GET', '/v1/empresas')
    expect(lista.status).toBe(200)
    expect((lista.corpo.empresas as { cnpj: string }[]).map((x) => x.cnpj)).toContain(padaria.cnpj)

    // Chave revogada para de funcionar; a de produção segue.
    await admin.db.query('select public.fiscal_definir_chave_sandbox($1, null, null)', [e.mae.tenant.id])
    expect((await api(amb, sandbox, 'GET', '/v1/empresas')).status).toBe(401)
    expect((await api(amb, producao, 'GET', '/v1/empresas')).status).toBe(200)
    // Uma chave sandbox gravada como de produção (ou vice-versa) não autentica: o prefixo decide a tabela.
    const trocada = gerarChave()
    await admin.db.query('select public.fiscal_definir_chave_sandbox($1, $2, $3)', [e.mae.tenant.id, trocada.hash, 'nfk_test_AAAAAA'])
    expect((await api(amb, trocada.chave, 'GET', '/v1/empresas')).status).toBe(401)
  })

  it('valores mágicos, erro de leiaute, cancelamento e webhook sandbox assinado', async () => {
    const amb = ambiente()
    const { e, padaria } = await novoEscritorio()
    const chave = await chaveSandbox(e.mae.tenant.id)

    // Webhook sandbox: URL própria, segredo whsec_test_ devolvido uma vez.
    expect((await api(amb, chave, 'PUT', '/v1/sandbox/webhook', { url: 'http://localhost/hook' })).corpo.error.code).toBe('VALIDATION_FAILED')
    const hook = await api(amb, chave, 'PUT', '/v1/sandbox/webhook', { url: 'https://erp.parceiro.test/sandbox-hook' })
    const segredo = hook.corpo.segredo as string
    expect(segredo).toMatch(/^whsec_test_[A-Za-z0-9_-]{43}$/)
    expect((await api(amb, chave, 'PUT', '/v1/sandbox/webhook', { url: 'https://erp.parceiro.test/sandbox-hook' })).corpo.segredo).toBeNull()
    expect((await api(amb, chave, 'GET', '/v1/sandbox/webhook')).corpo).toMatchObject({ webhook: { url: 'https://erp.parceiro.test/sandbox-hook', tem_segredo: true } })

    const de = { cnpj_prestador: padaria.cnpj }
    const normal = (await api(amb, chave, 'POST', '/v1/nfse', venda('n', de))).corpo.id as string
    const recusa = (await api(amb, chave, 'POST', '/v1/nfse', venda('r', { ...de, valor: '1.11' }))).corpo.id as string
    const fora = (await api(amb, chave, 'POST', '/v1/nfse', venda('f', { ...de, valor: '2.22' }))).corpo.id as string
    const semCancelar = (await api(amb, chave, 'POST', '/v1/nfse', venda('c', { ...de, valor: '3.33' }))).corpo.id as string
    // Erro de leiaute que só o buildDps pega (E0202: tomador é o próprio prestador): recusa DPS_INVALID, como o worker.
    const leiaute = (await api(amb, chave, 'POST', '/v1/nfse', { ...venda('l', de), tomador: { cnpj: padaria.cnpj, nome: 'Ela mesma' } })).corpo.id as string
    const naFila = (await api(amb, chave, 'POST', '/v1/nfse', venda('q', de))).corpo.id as string

    // Cancelar ainda na fila: skipped, como o requestCancel do motor.
    expect((await api(amb, chave, 'POST', `/v1/nfse/${naFila}/cancel`)).corpo).toMatchObject({ status: 'skipped', last_error: 'Cancelada antes da transmissão' })

    amb.avancar(ATRASO_MS + 500)
    const status = async (id: string) => (await api(amb, chave, 'GET', `/v1/nfse/${id}`)).corpo
    expect(await status(normal)).toMatchObject({ status: 'issued' })
    expect(await status(recusa)).toMatchObject({ status: 'rejected', last_error_code: 'E0718' })
    expect(await status(fora)).toMatchObject({ status: 'queued', last_error_code: 'SEFIN_UNAVAILABLE' })
    expect(await status(semCancelar)).toMatchObject({ status: 'issued' })
    expect(await status(leiaute)).toMatchObject({ status: 'rejected', last_error_code: 'DPS_INVALID', last_error: 'tomador é o próprio prestador' })
    expect((await api(amb, chave, 'GET', `/v1/nfse/${recusa}/pdf`)).corpo.error.code).toBe('NOT_ISSUED')

    amb.avancar(SEFIN_FORA_MS)
    expect(await status(fora)).toMatchObject({ status: 'issued', last_error_code: null })

    // Cancelamento: o normal cancela; o 3.33 fica em cancel_requested com o motivo, como o motor.
    expect((await api(amb, chave, 'POST', `/v1/nfse/${normal}/cancel`)).corpo).toMatchObject({ status: 'cancel_requested' })
    expect((await api(amb, chave, 'POST', `/v1/nfse/${semCancelar}/cancel`)).corpo).toMatchObject({ status: 'cancel_requested' })
    amb.avancar(ATRASO_MS + 500)
    expect(await status(normal)).toMatchObject({ status: 'cancelled' })
    expect(await status(semCancelar)).toMatchObject({ status: 'cancel_requested', last_error_code: 'SANDBOX_CANCELAMENTO_RECUSADO' })
    const cancelada = await api(amb, chave, 'GET', `/v1/nfse/${normal}/pdf`)
    expect(pdfTexts(cancelada.bytes!).join(' ')).toContain('CANCELADA')

    // Webhook: assinado com o segredo do sandbox, marcado como sandbox, um evento por transição.
    await api(amb, chave, 'GET', '/v1/sandbox/webhook')
    const eventos = amb.recebidos.map((r) => {
      expect(r.url).toBe('https://erp.parceiro.test/sandbox-hook')
      expect(r.headers['x-nofiscal-ambiente']).toBe('sandbox')
      expect(r.headers['x-nofiscal-signature']).toBe(`sha256=${createHmac('sha256', segredo).update(r.body).digest('hex')}`)
      const corpo = JSON.parse(r.body) as { evento: string; id: string; ambiente: string }
      expect(corpo.ambiente).toBe('sandbox')
      return `${corpo.evento}:${corpo.id}`
    })
    expect(eventos.sort()).toEqual(
      [
        `nfse.emitida:${normal}`,
        `nfse.recusada:${recusa}`,
        `nfse.emitida:${semCancelar}`,
        `nfse.recusada:${leiaute}`,
        `nfse.emitida:${fora}`,
        `nfse.cancelada:${normal}`,
        `nfse.cancelamento_recusado:${semCancelar}`,
      ].sort(),
    )
    // Nada foi para a fila do webhook de produção.
    const { rows } = await admin.db.query<{ n: string }>('select count(*)::text as n from nofiscal.fiscal_webhook_entregas where dono_tenant_id = $1', [e.mae.tenant.id])
    expect(rows[0].n).toBe('0')
  })
})

describe('isolamento no código', () => {
  it('só o sandbox (e a autenticação) toca as tabelas do sandbox; o motor nunca as lê', () => {
    const raiz = fileURLToPath(new URL('../_lib/', import.meta.url))
    const arquivos: string[] = []
    const andar = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome)
        if (statSync(caminho).isDirectory()) andar(caminho)
        else if (nome.endsWith('.ts') && !nome.endsWith('.test.ts')) arquivos.push(caminho)
      }
    }
    andar(raiz)
    const tocam = arquivos
      .filter((f) => /fiscal_sandbox_|read_sandbox_webhook_secret|set_sandbox_webhook_secret/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(raiz.length).replace(/\\/g, '/'))
      .sort()
    expect(tocam).toEqual(['auth.ts', 'sandbox/conta.ts', 'sandbox/notas.ts'])
    // E o sandbox nunca toca a tabela de notas reais nem a numeração da Sefin.
    for (const f of ['sandbox/conta.ts', 'sandbox/notas.ts']) {
      const codigo = readFileSync(join(raiz, f), 'utf8').replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '')
      expect(codigo).not.toMatch(/fiscal_invoices\b|fiscal_dps_series|allocate_dps_number|sefin-client|signXml/)
    }
  })

  it('o script da nó gera a chave no mesmo formato da API', async () => {
    const caminho = new URL('../../../scripts/nofiscal-sandbox/gerar-chave.mjs', import.meta.url).href
    const script = (await import(/* @vite-ignore */ caminho)) as {
      gerarChaveSandbox: (bytes?: () => Buffer) => { chave: string; hash: string; prefixo: string }
      sqlDaChave: (a: { conta?: string | null; cnpj?: string | null; hash: string | null; prefixo: string | null }) => string
    }
    const bytes = () => Buffer.alloc(32, 7)
    expect(script.gerarChaveSandbox(bytes)).toEqual(gerarChaveSandbox(bytes))
    const g = script.gerarChaveSandbox()
    expect(script.sqlDaChave({ cnpj: '12345678000190', hash: g.hash, prefixo: g.prefixo })).toContain(`'${g.hash}', '${g.prefixo}'`)
    expect(script.sqlDaChave({ conta: randomUUID(), hash: null, prefixo: null })).toContain('null, null')
    expect(() => script.sqlDaChave({ cnpj: "1'; drop table x; --", hash: g.hash, prefixo: g.prefixo })).toThrow()
    expect(script.sqlDaChave({ cnpj: '12345678000190', hash: g.hash, prefixo: g.prefixo })).not.toContain(g.chave)
  })
})
