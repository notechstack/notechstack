// Serviço da NF-e no banco local do Supabase, com o papel de produção (`nofiscal_service`) e a Sefaz dublê.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { allowTestUserToAssume, assinarTenant, openRoleDb } from '../../_tests/agente-fixtures.js'
import { makeTestCertificate } from '../../_tests/certs.js'
import { createTestTenant, dropTestTenant, openTestDb, type TestTenant } from '../../_tests/fixtures.js'
import { verifySignature } from '../../_tests/verify-signature.js'
import type { Db } from '../db.js'
import { notasDoMes } from '../agente/lote.js'
import type { HttpRequest, HttpResponse } from '../sefin-client.js'
import { lerNfeProc } from './danfe.js'
import { aprovarConferencia, notaExemplo } from './nfe-fixtures.js'
import { criarSefazClient } from './sefaz-client.js'
import {
  bloqueioNfe,
  criarNfe,
  DadosNfeInvalidos,
  pedirCancelamento,
  pedirCartaCorrecao,
  pedirInutilizacao,
  processarNfes,
  salvarDadosNfe,
  type PedidoNfe,
} from './servico.js'

const NS = 'http://www.portalfiscal.inf.br/nfe'
const soap = (corpo: string) =>
  `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>${corpo}</nfeResultMsg></soap:Body></soap:Envelope>`
const tag = (xml: string, n: string) => new RegExp(`<${n}>([^<]*)</${n}>`).exec(xml)?.[1] ?? ''

/** Sefaz dublê: autoriza tudo, a menos que o roteiro diga outra coisa. */
function sefazDuble(roteiro: { autorizar?: (body: string) => HttpResponse | null } = {}) {
  const chamadas: HttpRequest[] = []
  let nProt = 135260000000000
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    chamadas.push(req)
    const body = req.body ?? ''
    if (body.includes('<enviNFe')) {
      const r = roteiro.autorizar?.(body)
      if (r) return r
      const chave = /Id="NFe(\d{44})"/.exec(body)![1]
      return {
        status: 200,
        body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>Lote processado</xMotivo><protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><chNFe>${chave}</chNFe><dhRecbto>2026-11-17T10:00:00-03:00</dhRecbto><nProt>${++nProt}</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe></retEnviNFe>`),
      }
    }
    if (body.includes('<consSitNFe')) return { status: 200, body: soap(`<retConsSitNFe xmlns="${NS}"><cStat>217</cStat><xMotivo>NF-e nao consta</xMotivo></retConsSitNFe>`) }
    if (body.includes('<envEvento')) {
      const tp = tag(body, 'tpEvento')
      return {
        status: 200,
        body: soap(`<retEnvEvento xmlns="${NS}"><cStat>128</cStat><xMotivo>ok</xMotivo><retEvento versao="1.00"><infEvento><cStat>135</cStat><xMotivo>Evento registrado</xMotivo><tpEvento>${tp}</tpEvento><nProt>${++nProt}</nProt></infEvento></retEvento></retEnvEvento>`),
      }
    }
    if (body.includes('<inutNFe')) return { status: 200, body: soap(`<retInutNFe xmlns="${NS}"><infInut><cStat>102</cStat><xMotivo>Inutilizacao homologada</xMotivo><nProt>${++nProt}</nProt></infInut></retInutNFe>`) }
    return { status: 500, body: 'nao previsto' }
  }
  return { chamadas, sefaz: criarSefazClient({ transport }) }
}

const pedido = (): PedidoNfe => {
  const n = notaExemplo()
  return { destinatario: n.destinatario, itens: n.itens, pagamentos: n.pagamentos, informacoesComplementares: n.informacoesComplementares }
}

const ENDERECO = { logradouro: 'Rua Coronel Teofilo Leme', numero: '100', bairro: 'Centro', cep: '12900000', uf: 'SP' as const }

let admin: Db
let adminPool: { end: () => Promise<void> }
let db: Db
let pool: { end: () => Promise<void> }
let tenant: TestTenant
let cert: ReturnType<typeof makeTestCertificate>

beforeAll(async () => {
  const a = openTestDb()
  admin = a.db
  adminPool = a.pool
  await allowTestUserToAssume(admin, 'nofiscal_service')
  const r = openRoleDb('nofiscal_service')
  db = r.db
  pool = r.pool
})

afterAll(async () => {
  await pool.end()
  await adminPool.end()
})

async function limpar(t: TestTenant) {
  await admin.query('delete from nofiscal.fiscal_nfe_eventos where tenant_id = $1', [t.id])
  await admin.query('delete from nofiscal.fiscal_nfe where tenant_id = $1', [t.id])
  await admin.query('delete from nofiscal.fiscal_nfe_conferencias where tenant_id = $1', [t.id])
  await admin.query('delete from nofiscal.fiscal_nfe_series where tenant_id = $1', [t.id])
  await admin.query('delete from nofiscal.fiscal_subscriptions where tenant_id = $1', [t.id])
  await dropTestTenant(admin, t.id)
}

beforeEach(async (ctx) => {
  tenant = await createTestTenant(admin, { codigoMunicipioIbge: '3507605' } as never)
  await admin.query(`update nofiscal.fiscal_tenants set codigo_municipio_ibge = '3507605' where id = $1`, [tenant.id])
  cert = makeTestCertificate({ commonName: `EMPRESA TESTE:${tenant.cnpj}` })
  await admin.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [
    tenant.id,
    cert.certificado.pfxBase64,
    cert.certificado.password,
    `CN=EMPRESA TESTE:${tenant.cnpj}`,
    new Date(Date.now() + 365 * 24 * 3600_000),
  ])
  await assinarTenant(admin, tenant.id)
  const t = tenant
  ctx.onTestFinished(() => limpar(t))
})

const agora = () => new Date('2026-11-17T13:00:00Z')

describe('dados da empresa e bloqueio', () => {
  it('sem IE, endereço ou série a empresa não emite NF-e; com eles, emite', async () => {
    expect(await bloqueioNfe(db, tenant.id)).toBe('NFE_SEM_IE')
    await salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222.333.444.555', endereco: ENDERECO, serie: 1, proximoNumero: 150 })
    // Com os dados, falta a conferência (cadastro + nota de teste em homologação).
    expect(await bloqueioNfe(db, tenant.id)).toBe('NFE_NAO_CONFERIDA')
    await aprovarConferencia(db, tenant.id, '222333444555')
    expect(await bloqueioNfe(db, tenant.id)).toBeNull()
    const { rows } = await admin.query<{ next_number: string }>('select next_number from nofiscal.fiscal_nfe_series where tenant_id = $1', [tenant.id])
    expect(rows[0].next_number).toBe('150')
  })

  it('UF do endereço precisa ser a do município; o número não volta', async () => {
    await expect(salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222333444555', endereco: { ...ENDERECO, uf: 'MG' }, serie: 1, proximoNumero: 1 })).rejects.toThrow(DadosNfeInvalidos)
    await salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222333444555', endereco: ENDERECO, serie: 1, proximoNumero: 10 })
    await criarNfe(db, { tenantId: tenant.id, externalId: 'x1', origem: 'painel', pedido: pedido(), agora: agora() })
    await expect(salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222333444555', endereco: ENDERECO, serie: 1, proximoNumero: 5 })).rejects.toThrow(/não pode voltar/)
  })

  it('sem A1 da própria empresa: NFE_CERT_MISSING', async () => {
    await salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222333444555', endereco: ENDERECO, serie: 1, proximoNumero: 1 })
    await admin.query('delete from nofiscal.fiscal_certificates where tenant_id = $1', [tenant.id])
    expect(await bloqueioNfe(db, tenant.id)).toBe('NFE_CERT_MISSING')
  })
})

describe('emissão', () => {
  beforeEach(async () => {
    await salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222333444555', endereco: ENDERECO, serie: 1, proximoNumero: 42 })
    await aprovarConferencia(db, tenant.id, '222333444555')
  })

  it('cria com o próximo número, é idempotente e o worker autoriza com o A1 da empresa', async () => {
    const r = await criarNfe(db, { tenantId: tenant.id, externalId: 'pedido-1', origem: 'painel', pedido: pedido(), agora: agora() })
    expect(r).toMatchObject({ ok: true, serie: 1, numero: 42, jaExistia: false })
    expect(await criarNfe(db, { tenantId: tenant.id, externalId: 'pedido-1', origem: 'painel', pedido: pedido(), agora: agora() })).toMatchObject({ ok: true, numero: 42, jaExistia: true })
    const outra = await criarNfe(db, { tenantId: tenant.id, externalId: 'pedido-2', origem: 'painel', pedido: pedido(), agora: agora() })
    expect(outra).toMatchObject({ numero: 43 })

    const d = sefazDuble()
    const finais: string[] = []
    const resumo = await processarNfes({ db, sefaz: d.sefaz, now: agora, tenantId: tenant.id, onFinal: async (_id, s) => void finais.push(s) })
    expect(resumo).toMatchObject({ pegas: 2, autorizadas: 2 })
    expect(finais).toEqual(['authorized', 'authorized'])
    expect(d.chamadas[0].url).toBe('https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx')

    const { rows } = await admin.query<{ status: string; chave: string; protocolo: string; xml_proc: string; valor_total: string }>(
      'select status, chave, protocolo, xml_proc, valor_total from nofiscal.fiscal_nfe where id = $1',
      [r.ok ? r.nfeId : ''],
    )
    expect(rows[0]).toMatchObject({ status: 'authorized', valor_total: '89.56' })
    expect(rows[0].chave).toMatch(new RegExp(`^35\\d{4}${tenant.cnpj}55001000000042`))
    expect(verifySignature(rows[0].xml_proc, cert.certPem)).toBe(true)
    expect(lerNfeProc(rows[0].xml_proc)).toMatchObject({ numero: '42', protocolo: rows[0].protocolo })
  })

  it('pedido inválido não consome número', async () => {
    const ruim = { ...pedido(), itens: [{ ...pedido().itens[0], ncm: '12' }] }
    expect(await criarNfe(db, { tenantId: tenant.id, externalId: 'ruim', origem: 'painel', pedido: ruim, agora: agora() })).toEqual({
      ok: false,
      codigo: 'INVALIDA',
      problemas: ['item 1: NCM deve ter 8 dígitos'],
    })
    expect(await criarNfe(db, { tenantId: tenant.id, externalId: 'boa', origem: 'painel', pedido: pedido(), agora: agora() })).toMatchObject({ numero: 42 })
  })

  it('Sefaz fora do ar: volta para a fila; na rodada seguinte consulta a chave antes de reenviar o mesmo XML', async () => {
    const r = await criarNfe(db, { tenantId: tenant.id, externalId: 'p', origem: 'painel', pedido: pedido(), agora: agora() })
    const fora = sefazDuble({ autorizar: () => ({ status: 503, body: 'indisponivel' }) })
    expect(await processarNfes({ db, sefaz: fora.sefaz, now: agora, tenantId: tenant.id })).toMatchObject({ aguardando: 1 })
    const antes = (await admin.query<{ status: string; attempts: number; chave: string; xml_assinado: string }>('select status, attempts, chave, xml_assinado from nofiscal.fiscal_nfe where id = $1', [r.ok ? r.nfeId : ''])).rows[0]
    expect(antes).toMatchObject({ status: 'sending', attempts: 1 })

    const volta = sefazDuble()
    const depois = () => new Date(agora().getTime() + 2 * 60_000)
    expect(await processarNfes({ db, sefaz: volta.sefaz, now: depois, tenantId: tenant.id })).toMatchObject({ autorizadas: 1 })
    expect(volta.chamadas.map((c) => (c.body?.includes('<consSitNFe') ? 'consulta' : 'envio'))).toEqual(['consulta', 'envio'])
    expect(volta.chamadas[1].body).toContain(antes.xml_assinado)
  })

  it('rejeição da Sefaz: número fica com a nota rejeitada e pode ser inutilizado', async () => {
    const r = await criarNfe(db, { tenantId: tenant.id, externalId: 'rej', origem: 'painel', pedido: pedido(), agora: agora() })
    const id = r.ok ? r.nfeId : ''
    const rejeita = sefazDuble({
      autorizar: (body) => ({
        status: 200,
        body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo><protNFe versao="4.00"><infProt><chNFe>${/NFe(\d{44})/.exec(body)![1]}</chNFe><cStat>778</cStat><xMotivo>Rejeicao: NCM inexistente</xMotivo></infProt></protNFe></retEnviNFe>`),
      }),
    })
    expect(await processarNfes({ db, sefaz: rejeita.sefaz, now: agora, tenantId: tenant.id })).toMatchObject({ rejeitadas: 1 })
    expect(await pedirInutilizacao(db, id, 'curta')).toEqual({ ok: false, mensagem: 'A justificativa precisa ter de 15 a 255 caracteres.' })
    expect(await pedirInutilizacao(db, id, 'Nota rejeitada por NCM errado')).toMatchObject({ ok: true })
    const d = sefazDuble()
    await processarNfes({ db, sefaz: d.sefaz, now: agora, tenantId: tenant.id })
    expect(d.chamadas[0].url).toContain('nfeinutilizacao4')
    expect(d.chamadas[0].body).toContain('<nNFIni>42</nNFIni><nNFFin>42</nNFFin>')
    const { rows } = await admin.query<{ status: string }>('select status from nofiscal.fiscal_nfe where id = $1', [id])
    expect(rows[0].status).toBe('voided')
  })

  it('cancelamento e carta de correção pela fila de eventos', async () => {
    const r = await criarNfe(db, { tenantId: tenant.id, externalId: 'c', origem: 'painel', pedido: pedido(), agora: agora() })
    const id = r.ok ? r.nfeId : ''
    expect(await pedirCancelamento(db, id, 'Erro na digitacao do valor')).toEqual({ ok: false, mensagem: 'Só nota autorizada pode ser cancelada.' })
    const d = sefazDuble()
    await processarNfes({ db, sefaz: d.sefaz, now: agora, tenantId: tenant.id })
    expect(await pedirCartaCorrecao(db, id, 'Numero do endereco do destinatario e 1000.')).toMatchObject({ ok: true })
    expect(await pedirCartaCorrecao(db, id, 'Complemento do endereco do destinatario: sala 2.')).toMatchObject({ ok: true })
    await processarNfes({ db, sefaz: d.sefaz, now: agora, tenantId: tenant.id })
    const cces = d.chamadas.filter((c) => c.body?.includes('<tpEvento>110110</tpEvento>'))
    expect(cces.map((c) => tag(c.body ?? '', 'nSeqEvento'))).toEqual(['1', '2'])

    expect(await pedirCancelamento(db, id, 'Erro na digitacao do valor')).toMatchObject({ ok: true })
    await processarNfes({ db, sefaz: d.sefaz, now: agora, tenantId: tenant.id })
    const { rows } = await admin.query<{ status: string }>('select status from nofiscal.fiscal_nfe where id = $1', [id])
    expect(rows[0].status).toBe('cancelled')
  })

  it('a NF-e conta na mesma franquia das notas do mês', async () => {
    const antes = await notasDoMes(db, tenant.id, agora())
    await criarNfe(db, { tenantId: tenant.id, externalId: `f-${randomBytes(3).toString('hex')}`, origem: 'painel', pedido: pedido(), agora: agora() })
    expect(await notasDoMes(db, tenant.id, agora())).toBe(antes + 1)
  })

  it('A1 trocado depois da conferência (aqui, por um de outro CNPJ): a nota não sai até conferir de novo', async () => {
    await criarNfe(db, { tenantId: tenant.id, externalId: 'o', origem: 'painel', pedido: pedido(), agora: agora() })
    const outro = makeTestCertificate({ commonName: 'ESCRITORIO:11222333000181' })
    await admin.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [tenant.id, outro.certificado.pfxBase64, outro.certificado.password, 'CN=ESCRITORIO', new Date(Date.now() + 86400_000 * 30)])
    const d = sefazDuble()
    expect(await processarNfes({ db, sefaz: d.sefaz, now: agora, tenantId: tenant.id })).toMatchObject({ bloqueadas: 1 })
    expect(d.chamadas).toHaveLength(0)
    const { rows } = await admin.query<{ status: string; last_error_code: string }>('select status, last_error_code from nofiscal.fiscal_nfe where tenant_id = $1', [tenant.id])
    expect(rows[0]).toEqual({ status: 'queued', last_error_code: 'NFE_CONFERIR_DE_NOVO' })
  })
})

describe('fila depois da revisão de 17/11/2026', () => {
  beforeEach(async () => {
    await salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222333444555', endereco: ENDERECO, serie: 1, proximoNumero: 70 })
    await aprovarConferencia(db, tenant.id, '222333444555')
  })

  it('539 (mesmo número, outra chave) rejeita na hora, sem consulta nem laço', async () => {
    const r = await criarNfe(db, { tenantId: tenant.id, externalId: 'n539', origem: 'painel', pedido: pedido(), agora: agora() })
    const d = sefazDuble({ autorizar: (body) => ({ status: 200, body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo><protNFe><infProt><chNFe>${/NFe(\d{44})/.exec(body)![1]}</chNFe><cStat>539</cStat><xMotivo>Duplicidade de NF-e com diferenca na Chave de Acesso</xMotivo></infProt></protNFe></retEnviNFe>`) }) })
    expect(await processarNfes({ db, sefaz: d.sefaz, now: agora, tenantId: tenant.id })).toMatchObject({ rejeitadas: 1 })
    expect(d.chamadas.filter((c) => c.body?.includes('<consSitNFe'))).toHaveLength(0)
    const { rows } = await admin.query<{ status: string; last_error_code: string }>('select status, last_error_code from nofiscal.fiscal_nfe where id = $1', [r.ok ? r.nfeId : ''])
    expect(rows[0]).toEqual({ status: 'rejected', last_error_code: '539' })
  })

  it('nota já transmitida não para no bloqueio (A1 trocado): segue para a consulta', async () => {
    await criarNfe(db, { tenantId: tenant.id, externalId: 'tx', origem: 'painel', pedido: pedido(), agora: agora() })
    await processarNfes({ db, sefaz: sefazDuble({ autorizar: () => ({ status: 503, body: '' }) }).sefaz, now: agora, tenantId: tenant.id })
    // Renova o A1 (mesmo CNPJ): a conferência fica a refazer, mas a nota em 'sending' já foi para a Sefaz.
    await admin.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [tenant.id, cert.certificado.pfxBase64, cert.certificado.password, `CN=EMPRESA TESTE:${tenant.cnpj}`, new Date(Date.now() + 86400_000 * 200)])
    expect(await bloqueioNfe(db, tenant.id)).toBe('NFE_CONFERIR_DE_NOVO')
    const d = sefazDuble()
    expect(await processarNfes({ db, sefaz: d.sefaz, now: () => new Date(agora().getTime() + 5 * 60_000), tenantId: tenant.id })).toMatchObject({ autorizadas: 1 })
    expect(d.chamadas[0].body).toContain('<consSitNFe')
  })

  it('cancelamento com resposta perdida: o 573 do reenvio vira cancelada pela consulta da chave', async () => {
    const r = await criarNfe(db, { tenantId: tenant.id, externalId: 'c573', origem: 'painel', pedido: pedido(), agora: agora() })
    const id = r.ok ? r.nfeId : ''
    await processarNfes({ db, sefaz: sefazDuble().sefaz, now: agora, tenantId: tenant.id })
    const { rows: n } = await admin.query<{ chave: string }>('select chave from nofiscal.fiscal_nfe where id = $1', [id])
    await pedirCancelamento(db, id, 'Erro na digitacao do valor')
    const proc = `<procEventoNFe versao="1.00"><evento><infEvento Id="ID110111${n[0].chave}01"><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento></infEvento></evento><retEvento><infEvento><cStat>135</cStat><nProt>135260000088888</nProt></infEvento></retEvento></procEventoNFe>`
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      if (req.body?.includes('<envEvento')) return { status: 200, body: soap(`<retEnvEvento xmlns="${NS}"><cStat>128</cStat><retEvento><infEvento><cStat>573</cStat><xMotivo>Duplicidade de evento</xMotivo></infEvento></retEvento></retEnvEvento>`) }
      return { status: 200, body: soap(`<retConsSitNFe xmlns="${NS}"><cStat>101</cStat><xMotivo>Cancelamento homologado</xMotivo>${proc}</retConsSitNFe>`) }
    }
    await processarNfes({ db, sefaz: criarSefazClient({ transport }), now: agora, tenantId: tenant.id })
    const { rows } = await admin.query<{ status: string; protocolo: string; xml_proc: string }>(
      `select n.status, e.protocolo, e.xml_proc from nofiscal.fiscal_nfe n join nofiscal.fiscal_nfe_eventos e on e.nfe_id = n.id where n.id = $1`,
      [id],
    )
    expect(rows[0]).toEqual({ status: 'cancelled', protocolo: '135260000088888', xml_proc: proc })
  })

  it('prazo da rodada: o que não coube volta para a fila na hora', async () => {
    await criarNfe(db, { tenantId: tenant.id, externalId: 'p1', origem: 'painel', pedido: pedido(), agora: agora() })
    await criarNfe(db, { tenantId: tenant.id, externalId: 'p2', origem: 'painel', pedido: pedido(), agora: agora() })
    let t = 0
    const resumo = await processarNfes({ db, sefaz: sefazDuble().sefaz, now: agora, tenantId: tenant.id, prazoMs: 1000, relogio: () => (t += 600) })
    expect(resumo).toMatchObject({ pegas: 1, adiadas: 1 })
    const { rows } = await admin.query<{ n: string }>(`select count(*) as n from nofiscal.fiscal_nfe where tenant_id = $1 and status = 'queued' and next_attempt_at <= $2`, [tenant.id, agora()])
    expect(rows[0].n).toBe('1')
  })

  it('trocar a série: a nova passa a ser a única ativa e as notas saem nela', async () => {
    await salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222333444555', endereco: ENDERECO, serie: 2, proximoNumero: 1 })
    expect(await criarNfe(db, { tenantId: tenant.id, externalId: 's2', origem: 'painel', pedido: pedido(), agora: agora() })).toMatchObject({ ok: true, serie: 2, numero: 1 })
    await expect(salvarDadosNfe(db, tenant.id, { inscricaoEstadual: '222333444555', endereco: ENDERECO, serie: 890, proximoNumero: 1 })).rejects.toThrow(DadosNfeInvalidos)
  })
})
