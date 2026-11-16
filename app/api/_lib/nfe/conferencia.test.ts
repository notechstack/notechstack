// Conferência da empresa para NF-e (consulta de cadastro + nota de teste em homologação) e o A1 para NF-e da empresa
// que emite NFS-e por procuração. Banco local com os papéis de produção; Sefaz e sessão em dublê.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowTestUserToAssume, createEscritorio, dropEscritorio, openRoleDb, type Escritorio } from '../../_tests/agente-fixtures.js'
import { makeTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { handleOnboardingCertificate } from '../onboarding-certificate.js'
import type { HttpRequest, HttpResponse } from '../sefin-client.js'
import type { SessionVerifier } from '../session.js'
import { conferirEmpresaNfe, motivoDaConferencia, SERIE_DE_TESTE } from './conferencia.js'
import { criarSefazClient } from './sefaz-client.js'
import { bloqueioNfe, salvarDadosNfe } from './servico.js'

const NS = 'http://www.portalfiscal.inf.br/nfe'
const soap = (corpo: string) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body><r>${corpo}</r></s:Body></s:Envelope>`
const ENDERECO = { logradouro: 'Rua Coronel Teofilo Leme', numero: '100', bairro: 'Centro', cep: '12900000', uf: 'SP' as const }
const IE = '222333444555'

type Roteiro = {
  cadastro?: (body: string) => HttpResponse
  autorizar?: (chave: string, body: string) => HttpResponse
}
export function sefazDeConferencia(roteiro: Roteiro = {}) {
  const chamadas: HttpRequest[] = []
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    chamadas.push(req)
    const body = req.body ?? ''
    if (body.includes('<ConsCad')) {
      if (roteiro.cadastro) return roteiro.cadastro(body)
      const cnpj = /<CNPJ>(\d{14})<\/CNPJ>/.exec(body)![1]
      return { status: 200, body: soap(`<retConsCad xmlns="${NS}" versao="2.00"><infCons><cStat>111</cStat><xMotivo>Consulta cadastro com uma ocorrencia</xMotivo><UF>SP</UF><infCad><IE>${IE}</IE><CNPJ>${cnpj}</CNPJ><UF>SP</UF><cSit>1</cSit><indCredNFe>1</indCredNFe><indCredCTe>4</indCredCTe><xNome>EMPRESA</xNome></infCad></infCons></retConsCad>`) }
    }
    if (body.includes('<enviNFe')) {
      const chave = /Id="NFe(\d{44})"/.exec(body)![1]
      if (roteiro.autorizar) return roteiro.autorizar(chave, body)
      return { status: 200, body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo><protNFe><infProt><chNFe>${chave}</chNFe><nProt>135260000000777</nProt><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe></retEnviNFe>`) }
    }
    return { status: 500, body: '' }
  }
  return { chamadas, sefaz: criarSefazClient({ transport }) }
}
const rejeita = (cStat: string, motivo: string) => (chave: string) => ({
  status: 200,
  body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo><protNFe><infProt><chNFe>${chave}</chNFe><cStat>${cStat}</cStat><xMotivo>${motivo}</xMotivo></infProt></protNFe></retEnviNFe>`),
})

const admin = openTestDb()
let servico: ReturnType<typeof openRoleDb>
let onboarding: ReturnType<typeof openRoleDb>
let esc: Escritorio
let empresaId: string
let cnpj: string

async function gravarA1(cn: string) {
  const c = makeTestCertificate({ commonName: cn })
  await admin.db.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [empresaId, c.certificado.pfxBase64, c.certificado.password, `CN=${cn}`, new Date(Date.now() + 86400_000 * 300)])
  return c
}
const now = () => new Date('2026-11-17T13:00:00Z')
const conferir = (sefaz: ReturnType<typeof sefazDeConferencia>['sefaz']) => conferirEmpresaNfe({ db: servico.db, sefaz, now, esperarMs: 1 }, empresaId)

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service', 'nofiscal_onboarding')
  servico = openRoleDb('nofiscal_service')
  onboarding = openRoleDb('nofiscal_onboarding')
  esc = await createEscritorio(admin.db, { empresas: [{ razaoSocial: 'Comercio Cliente Ltda' }] })
  empresaId = esc.empresas[0].id
  cnpj = esc.empresas[0].cnpj
  await admin.db.query(`update nofiscal.fiscal_tenants set codigo_municipio_ibge = '3507605' where id = $1`, [empresaId])
  await salvarDadosNfe(servico.db, empresaId, { inscricaoEstadual: IE, endereco: ENDERECO, serie: 1, proximoNumero: 1 })
})

afterAll(async () => {
  await admin.db.query('delete from nofiscal.fiscal_nfe_conferencias where tenant_id = $1', [empresaId])
  await admin.db.query('delete from nofiscal.fiscal_nfe_series where tenant_id = $1', [empresaId])
  await admin.db.query('delete from nofiscal.fiscal_certificate_attempts where tenant_id = $1', [empresaId])
  await dropEscritorio(admin.db, esc)
  await servico.pool.end()
  await onboarding.pool.end()
  await admin.pool.end()
})

describe('conferência da empresa para NF-e', () => {
  it('sem conferência a empresa não emite; aprovada (cadastro + nota de teste) ela emite', async () => {
    await gravarA1(`COMERCIO CLIENTE LTDA:${cnpj}`)
    expect(await bloqueioNfe(servico.db, empresaId)).toBe('NFE_NAO_CONFERIDA')
    const d = sefazDeConferencia()
    expect(await conferir(d.sefaz)).toMatchObject({ status: 'aprovada', etapa: 'nota_teste' })
    expect(await bloqueioNfe(servico.db, empresaId)).toBeNull()
    // Ordem: cadastro na Sefaz-SP de produção (leitura), depois a nota de teste na homologação de SP, série 990.
    expect(d.chamadas.map((c) => c.url)).toEqual([
      'https://nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx',
      'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
    ])
    expect(d.chamadas[0].headers['content-type']).toContain('action="http://www.portalfiscal.inf.br/nfe/wsdl/CadConsultaCadastro4/consultaCadastro"')
    expect(d.chamadas[1].body).toContain(`<serie>${SERIE_DE_TESTE}</serie>`)
    expect(d.chamadas[1].body).toContain('<tpAmb>2</tpAmb>')
  })

  it('trocar a IE pede conferência de novo', async () => {
    await salvarDadosNfe(servico.db, empresaId, { inscricaoEstadual: '111222333444', endereco: ENDERECO, serie: 1, proximoNumero: 1 })
    expect(await bloqueioNfe(servico.db, empresaId)).toBe('NFE_CONFERIR_DE_NOVO')
    await salvarDadosNfe(servico.db, empresaId, { inscricaoEstadual: IE, endereco: ENDERECO, serie: 1, proximoNumero: 1 })
  })

  it('cadastro diz "não credenciado" (indCredNFe 0): reprova com o que fazer, sem gastar nota de teste', async () => {
    const d = sefazDeConferencia({
      cadastro: () => ({ status: 200, body: soap(`<retConsCad xmlns="${NS}"><infCons><cStat>111</cStat><xMotivo>ok</xMotivo><infCad><IE>${IE}</IE><CNPJ>${cnpj}</CNPJ><cSit>1</cSit><indCredNFe>0</indCredNFe></infCad></infCons></retConsCad>`) }),
    })
    const r = await conferir(d.sefaz)
    expect(r).toEqual({
      status: 'reprovada',
      etapa: 'cadastro',
      codigo: 'NFE_NAO_CREDENCIADA',
      motivo: 'a Sefaz-SP informa que esta empresa não está credenciada para NF-e: peça o credenciamento no Posto Fiscal Eletrônico (PFE) da Sefaz-SP',
    })
    expect(d.chamadas).toHaveLength(1)
    expect(await bloqueioNfe(servico.db, empresaId)).toBe('NFE_NAO_CREDENCIADA')
  })

  it('cadastro sem a IE informada: reprova e mostra as IEs do CNPJ', async () => {
    const d = sefazDeConferencia({
      cadastro: () => ({ status: 200, body: soap(`<retConsCad xmlns="${NS}"><infCons><cStat>111</cStat><xMotivo>ok</xMotivo><infCad><IE>999888777666</IE><CNPJ>${cnpj}</CNPJ><cSit>1</cSit><indCredNFe>1</indCredNFe></infCad></infCons></retConsCad>`) }),
    })
    expect(await conferir(d.sefaz)).toMatchObject({ codigo: 'NFE_IE_NAO_E_DO_CNPJ', motivo: expect.stringContaining('IEs do CNPJ: 999888777666') })
  })

  it('cadastro fora do ar ou sem serviço: a nota de teste decide; 203 = falta credenciamento', async () => {
    const d = sefazDeConferencia({ cadastro: () => ({ status: 503, body: 'fora' }), autorizar: rejeita('203', 'Rejeicao: Emissor nao habilitado para emissao da NF-e') })
    expect(await conferir(d.sefaz)).toMatchObject({ status: 'reprovada', etapa: 'nota_teste', codigo: 'NFE_NAO_CREDENCIADA' })
    // Tentou os dois nomes de método do SOAPAction antes de seguir.
    expect(d.chamadas.filter((c) => c.body?.includes('<ConsCad'))).toHaveLength(2)
  })

  it('230/231: problema na IE; Sefaz sem resposta: erro, tentar de novo', async () => {
    expect(await conferir(sefazDeConferencia({ autorizar: rejeita('231', 'Rejeicao: IE do emitente nao vinculada ao CNPJ') }).sefaz)).toMatchObject({ codigo: 'NFE_IE_INVALIDA' })
    expect(await conferir(sefazDeConferencia({ autorizar: () => ({ status: 503, body: '' }) }).sefaz)).toMatchObject({ status: 'erro', codigo: 'SEFAZ_INDISPONIVEL' })
    expect(await bloqueioNfe(servico.db, empresaId)).toBe('SEFAZ_INDISPONIVEL')
  })

  it('número de teste já usado (539): vai o próximo, sem repetir', async () => {
    let n = 0
    const d = sefazDeConferencia({ autorizar: (chave) => (++n === 1 ? rejeita('539', 'Duplicidade de NF-e com diferenca na chave')(chave) : { status: 200, body: soap(`<retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo><protNFe><infProt><chNFe>${chave}</chNFe><nProt>1</nProt><cStat>100</cStat><xMotivo>ok</xMotivo></infProt></protNFe></retEnviNFe>`) }) })
    expect(await conferir(d.sefaz)).toMatchObject({ status: 'aprovada' })
    const numeros = d.chamadas.filter((c) => c.body?.includes('<enviNFe')).map((c) => /<nNF>(\d+)<\/nNF>/.exec(c.body ?? '')![1])
    expect(new Set(numeros).size).toBe(2)
  })

  it('A1 de outro CNPJ (do escritório): reprova no certificado, sem falar com a Sefaz', async () => {
    await gravarA1('ESCRITORIO CONTABIL:11222333000181')
    const d = sefazDeConferencia()
    expect(await conferir(d.sefaz)).toMatchObject({ status: 'reprovada', etapa: 'certificado', codigo: 'CERT_DE_OUTRO_CNPJ' })
    expect(d.chamadas).toHaveLength(0)
  })

  it('motivos em português, com o que fazer', () => {
    expect(motivoDaConferencia('NFE_NAO_CREDENCIADA', 'MG')).toBe('a Sefaz-MG informa que esta empresa não está credenciada para NF-e: peça o credenciamento como emissor de NF-e na Sefaz de Minas Gerais')
  })
})

describe('A1 para NF-e (uso=nfe) na empresa por procuração', () => {
  const sessions: SessionVerifier = { async userIdFrom(r) { return /^Bearer token-(.+)$/.exec(r.headers.get('authorization') ?? '')?.[1] ?? null } }
  async function enviar(cn: string, uso: string | null) {
    const c = makeTestCertificate({ commonName: cn })
    const form = new FormData()
    form.append('tenant_id', empresaId)
    form.append('pfx', new Blob([Buffer.from(c.certificado.pfxBase64, 'base64')]), 'a1.pfx')
    form.append('senha', c.certificado.password)
    if (uso) form.append('uso', uso)
    const res = await handleOnboardingCertificate(
      new Request('https://app.test/api/v1/onboarding/certificate', { method: 'POST', headers: { authorization: `Bearer token-${esc.mae.ownerUserId}` }, body: form }),
      { db: onboarding.db, sessions },
    )
    return res.status
  }

  it('aceita o A1 da matriz (mesma raiz), não muda o modo da NFS-e e põe a conferência em pendente', async () => {
    await admin.db.query('delete from nofiscal.fiscal_certificate_attempts where tenant_id = $1', [empresaId])
    await admin.db.query(`update nofiscal.fiscal_tenants set modo_autenticacao = 'procuracao' where id = $1`, [empresaId])
    const matriz = `${cnpj.slice(0, 8)}000191`
    expect(await enviar(`MATRIZ LTDA:${matriz}`, 'nfe')).toBe(201)
    const { rows } = await admin.db.query<{ modo: string; status: string }>(
      `select t.modo_autenticacao as modo, c.status from nofiscal.fiscal_tenants t join nofiscal.fiscal_nfe_conferencias c on c.tenant_id = t.id where t.id = $1`,
      [empresaId],
    )
    expect(rows[0]).toEqual({ modo: 'procuracao', status: 'pendente' })
    // Raiz diferente: recusa.
    expect(await enviar('OUTRA EMPRESA:11222333000181', 'nfe')).toBe(422)
  })

  it('com A1 próprio na NFS-e, o A1 tem de ser do CNPJ inteiro', async () => {
    await admin.db.query('delete from nofiscal.fiscal_certificate_attempts where tenant_id = $1', [empresaId])
    await admin.db.query(`update nofiscal.fiscal_tenants set modo_autenticacao = 'certificado_proprio' where id = $1`, [empresaId])
    expect(await enviar(`MATRIZ LTDA:${cnpj.slice(0, 8)}000191`, 'nfe')).toBe(422)
    expect(await enviar(`EMPRESA:${cnpj}`, 'nfe')).toBe(201)
  })
})
