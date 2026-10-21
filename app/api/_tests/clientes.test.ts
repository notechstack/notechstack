// POST /api/v1/onboarding/clientes. Checks C19 a C23 de .checks/agente-fiscal-v2.md (lote D).
// O banco é o local, com o papel nofiscal_service; a sessão é conferida num servidor local no
// papel do Supabase Auth (`/auth/v1/user`); a IA é o dublê da Anthropic por `ANTHROPIC_BASE_URL`;
// o ADN é um transporte injetado no cliente real (como o `sefin-fake` da v1). Nada sai da máquina.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAdnClient } from '../_lib/adn.js'
import { closeSharedDb, type Db } from '../_lib/db.js'
import { iaFromEnv } from '../_lib/ia/claude.js'
import { leitorPdfClaude } from '../_lib/ia/leitor-pdf.js'
import { handleOnboardingClientes, type OnboardingClientesDeps } from '../_lib/onboarding-clientes.js'
import { supabaseSessionVerifier } from '../_lib/session.js'
import { TransportError, type HttpRequest, type HttpResponse, type TlsCredentials } from '../_lib/sefin-client.js'
import {
  allowTestUserToAssume,
  createSelfServiceTenant,
  criarModelo,
  dropSelfServiceTenant,
  openRoleDb,
  roleDatabaseUrl,
  type SelfServiceTenant,
} from './agente-fixtures.js'
import { iniciarDubleIa, pdfDaChamada, type DubleIa } from './anthropic-fake.js'
import { sharedTestCertificate } from './certs.js'
import { openTestDb } from './fixtures.js'

// ---------------------------------------------------------------------------------------
// Sessão (Supabase Auth local) e IA (Anthropic local).
const ANON_KEY = 'anon-de-teste'
const auth: Server = createServer((req, res) => {
  const token = /^Bearer token-([0-9a-f-]{36})$/.exec(req.headers.authorization ?? '')
  if (req.method !== 'GET' || req.url !== '/auth/v1/user' || req.headers.apikey !== ANON_KEY || !token) {
    res.writeHead(401, { 'content-type': 'application/json' }).end('{"msg":"invalid JWT"}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: token[1], aud: 'authenticated' }))
})
await new Promise<void>((resolve) => auth.listen(0, '127.0.0.1', resolve))
const AUTH_URL = `http://127.0.0.1:${(auth.address() as AddressInfo).port}`

const MARCA_DANFSE = 'DANFSe-de-teste'
const MARCA_SEGREDO = 'conteudo-unico-do-pdf-7f3a9c'
/** Leitura que a IA de teste devolve para um DANFSe: com campos que o código precisa limpar. */
const LEITURA_DANFSE = {
  e_danfse: true,
  tomador_documento: '11.222.333/0001-81',
  tomador_nome: '  Clínica   Bem Estar Ltda ',
  tomador_email: 'não informado',
  tomador_endereco: {
    logradouro: 'Rua das Flores',
    numero: '100',
    complemento: null,
    bairro: 'Centro',
    codigo_municipio: '3550308',
    uf: 'sp',
    cep: '01001-000',
  },
  codigo_servico_nacional: '010701',
  descricao: 'Consultoria em sistemas',
  valor: '1500.00',
}

let iaFalha = false
const ia: DubleIa = await iniciarDubleIa((chamada) => {
  if (iaFalha) return { status: 529, erro: 'sobrecarregada' }
  const pdf = pdfDaChamada(chamada)
  if (!pdf) return { status: 400, erro: 'sem PDF' }
  const ehDanfse = pdf.toString('latin1').includes(MARCA_DANFSE)
  return ehDanfse
    ? { json: LEITURA_DANFSE, tokens: { entrada: 1800, saida: 120 } }
    : {
        json: {
          e_danfse: false,
          tomador_documento: null,
          tomador_nome: null,
          tomador_email: null,
          tomador_endereco: null,
          codigo_servico_nacional: null,
          descricao: null,
          valor: null,
        },
        tokens: { entrada: 900, saida: 30 },
      }
})

process.env.SUPABASE_URL = AUTH_URL
process.env.SUPABASE_ANON_KEY = ANON_KEY
process.env.NOFISCAL_DATABASE_URL = roleDatabaseUrl('nofiscal_service')
process.env.ANTHROPIC_API_KEY = 'sk-ant-chave-de-teste'
process.env.ANTHROPIC_BASE_URL = ia.url
process.env.AGENTE_FISCAL_IA_MODELO = 'claude-modelo-de-teste'
const { default: entry } = await import('../v1/onboarding/clientes.js')

const URL_ROTA = 'https://app.notechstack.com.br/api/v1/onboarding/clientes'
const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await closeSharedDb()
  await servico.pool.end()
  await admin.pool.end()
  await ia.fechar()
  await new Promise<void>((resolve) => auth.close(() => resolve()))
})

type Corpo = {
  candidatos?: Record<string, unknown>[]
  candidato?: Record<string, unknown>
  salvos?: number
  ignorados?: { nome: string | null; motivo: string }[]
  error?: { code: string; message: string }
}

const token = (s: SelfServiceTenant) => `token-${s.ownerUserId}`

async function novoTenant(comCertificado = true): Promise<SelfServiceTenant> {
  const s = await createSelfServiceTenant(admin.db, comCertificado ? { certificado: sharedTestCertificate().certificado } : { notAfter: null })
  tenants.push(s)
  return s
}

function pedirJson(sessao: string | null, corpo: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sessao) headers.authorization = `Bearer ${sessao}`
  return new Request(URL_ROTA, { method: 'POST', headers, body: JSON.stringify(corpo) })
}

function pedirPdf(sessao: string | null, tenantId: string, bytes: Uint8Array): Request {
  const form = new FormData()
  form.set('tenant_id', tenantId)
  form.set('acao', 'ler_pdf')
  form.set('arquivo', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'nota.pdf')
  const headers: Record<string, string> = {}
  if (sessao) headers.authorization = `Bearer ${sessao}`
  return new Request(URL_ROTA, { method: 'POST', headers, body: form })
}

const pdf = (texto: string) => new TextEncoder().encode(`%PDF-1.4\n% ${texto}\n1 0 obj << >> endobj\n%%EOF\n`)
const PDF_DANFSE = pdf(`${MARCA_DANFSE} ${MARCA_SEGREDO}`)
const PDF_OUTRO = pdf('boleto de condominio')

async function corpo(res: Response): Promise<Corpo> {
  return (await res.json()) as Corpo
}

// ---------------------------------------------------------------------------------------
// ADN: NFS-e mínimas no leiaute nacional (o que `parseNfseXml` lê) e o transporte falso.
let sequencia = 0
function nfseXml(input: {
  emitente: string
  tomador: { tag: 'CPF' | 'CNPJ'; documento: string; nome: string; email?: string; cMun?: string; cep?: string }
  codigo: string
  descricao: string
  valor: string
  dhEmi: string
}): string {
  const chave = `3550308${'2'}${'2'}${input.emitente}${String(++sequencia).padStart(13, '0')}2611${'123456789'}0`.padEnd(50, '0').slice(0, 50)
  const t = input.tomador
  const endereco = t.cMun ? `<end><endNac><cMun>${t.cMun}</cMun><CEP>${t.cep}</CEP></endNac><xLgr>Avenida Central</xLgr><nro>10</nro><xBairro>Centro</xBairro></end>` : ''
  return (
    `<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01"><infNFSe Id="NFS${chave}">` +
    `<nNFSe>${sequencia}</nNFSe><dhProc>${input.dhEmi}</dhProc>` +
    `<emit><CNPJ>${input.emitente}</CNPJ><xNome>EMITENTE</xNome></emit>` +
    `<DPS versao="1.01"><infDPS Id="DPS${chave.slice(0, 42)}"><tpAmb>2</tpAmb><dhEmi>${input.dhEmi}</dhEmi>` +
    `<prest><CNPJ>${input.emitente}</CNPJ></prest>` +
    `<toma><${t.tag}>${t.documento}</${t.tag}><xNome>${t.nome}</xNome>${endereco}${t.email ? `<email>${t.email}</email>` : ''}</toma>` +
    `<serv><cServ><cTribNac>${input.codigo}</cTribNac><xDescServ>${input.descricao}</xDescServ></cServ></serv>` +
    `<valores><vServPrest><vServ>${input.valor}</vServ></vServPrest></valores>` +
    `</infDPS></DPS></infNFSe></NFSe>`
  )
}

const doc = (nsu: number, tipo: string, xml: string) => ({
  NSU: nsu,
  ChaveAcesso: `chave-${nsu}`,
  TipoDocumento: tipo,
  TipoEvento: null,
  ArquivoXml: gzipSync(Buffer.from(xml, 'utf8')).toString('base64'),
  DataHoraGeracao: '2026-10-01T10:00:00',
})

function adnFalso(paginas: Record<number, HttpResponse | (() => never)>) {
  const chamadas: { request: HttpRequest; tls: TlsCredentials }[] = []
  return {
    chamadas,
    transport: async (request: HttpRequest, tls: TlsCredentials): Promise<HttpResponse> => {
      chamadas.push({ request, tls })
      const nsu = Number(/\/DFe\/(\d+)\?lote=true$/.exec(request.url)?.[1])
      const pagina = paginas[nsu]
      if (!pagina) return { status: 404, body: JSON.stringify({ StatusProcessamento: 'NENHUM_DOCUMENTO_LOCALIZADO', LoteDFe: [] }) }
      return typeof pagina === 'function' ? pagina() : pagina
    },
  }
}

function depsComAdn(transport: ReturnType<typeof adnFalso>['transport'], db: Db = servico.db): OnboardingClientesDeps {
  const iaDoAmbiente = iaFromEnv()
  return {
    db,
    sessions: supabaseSessionVerifier({ url: AUTH_URL, anonKey: ANON_KEY }),
    adn: createAdnClient({ transport }),
    leitor: iaDoAmbiente ? leitorPdfClaude(iaDoAmbiente) : null,
  }
}

const CNPJ_CLIENTE = '11222333000181'
const CPF_CLIENTE = '52998224725'

// ---------------------------------------------------------------------------------------
describe('POST /api/v1/onboarding/clientes', () => {
  it('candidatos do adn', async () => {
    const s = await novoTenant()
    const outroEmitente = '99888777000166'
    const antiga = nfseXml({
      emitente: s.tenant.cnpj,
      tomador: { tag: 'CNPJ', documento: CNPJ_CLIENTE, nome: 'Clinica Antiga Razao', email: 'antigo@clinica.test' },
      codigo: '010701',
      descricao: 'Consultoria de janeiro',
      valor: '100.00',
      dhEmi: '2026-01-10T10:00:00-03:00',
    })
    const recente = nfseXml({
      emitente: s.tenant.cnpj,
      tomador: { tag: 'CNPJ', documento: CNPJ_CLIENTE, nome: 'Clínica Bem Estar Ltda', email: 'financeiro@clinica.test', cMun: '3550308', cep: '01001000' },
      codigo: '010702',
      descricao: 'Consultoria de setembro',
      valor: '250.00',
      dhEmi: '2026-09-10T10:00:00-03:00',
    })
    const pessoa = nfseXml({
      emitente: s.tenant.cnpj,
      tomador: { tag: 'CPF', documento: CPF_CLIENTE, nome: 'Maria Souza' },
      codigo: '040101',
      descricao: 'Consulta',
      valor: '80',
      dhEmi: '2026-05-02T09:00:00-03:00',
    })
    // O tenant como tomador de outro prestador: não vira cliente.
    const recebida = nfseXml({
      emitente: outroEmitente,
      tomador: { tag: 'CNPJ', documento: s.tenant.cnpj, nome: 'O próprio tenant' },
      codigo: '010101',
      descricao: 'Serviço tomado',
      valor: '999.00',
      dhEmi: '2026-09-20T10:00:00-03:00',
    })
    const adn = adnFalso({
      0: { status: 200, body: JSON.stringify({ StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', LoteDFe: [doc(1, 'NFSE', recente), doc(2, 'NFSE', recebida), doc(3, 'NFSE', antiga)] }) },
      3: { status: 200, body: JSON.stringify({ StatusProcessamento: 'DOCUMENTOS_LOCALIZADOS', LoteDFe: [doc(4, 'EVENTO', '<evento/>'), doc(5, 'NFSE', pessoa)] }) },
    })

    const res = await handleOnboardingClientes(pedirJson(token(s), { tenant_id: s.tenant.id, acao: 'buscar_adn' }), depsComAdn(adn.transport))
    expect(res.status).toBe(200)
    const { candidatos } = await corpo(res)
    expect(candidatos).toEqual([
      {
        nome: 'Clínica Bem Estar Ltda',
        tomador_documento: CNPJ_CLIENTE,
        tomador_nome: 'Clínica Bem Estar Ltda',
        tomador_email: 'financeiro@clinica.test',
        tomador_endereco: {
          logradouro: 'Avenida Central',
          numero: '10',
          complemento: null,
          bairro: 'Centro',
          codigo_municipio: '3550308',
          uf: null,
          cep: '01001000',
        },
        codigo_servico_nacional: '010702',
        descricao: 'Consultoria de setembro',
        valor_padrao: '250.00',
        origem: 'importacao_adn',
      },
      {
        nome: 'Maria Souza',
        tomador_documento: CPF_CLIENTE,
        tomador_nome: 'Maria Souza',
        tomador_email: null,
        tomador_endereco: null,
        codigo_servico_nacional: '040101',
        descricao: 'Consulta',
        valor_padrao: '80.00',
        origem: 'importacao_adn',
      },
    ])

    // Caminho oficial do ADN Contribuintes, pelo ambiente do tenant, com o A1 do tenant no mTLS.
    expect(adn.chamadas.map((c) => c.request.url)).toEqual([
      'https://adn.producaorestrita.nfse.gov.br/contribuintes/DFe/0?lote=true',
      'https://adn.producaorestrita.nfse.gov.br/contribuintes/DFe/3?lote=true',
      'https://adn.producaorestrita.nfse.gov.br/contribuintes/DFe/5?lote=true',
    ])
    expect(adn.chamadas.every((c) => c.request.method === 'GET')).toBe(true)
    expect(adn.chamadas[0].tls.cert).toContain(sharedTestCertificate().certPem.trim())
    expect(adn.chamadas[0].tls.key).toMatch(/PRIVATE KEY/)

    // Buscar não grava nada: os candidatos só viram modelo no `salvar`.
    const { rows } = await admin.db.query('select 1 from nofiscal.fiscal_models where tenant_id = $1', [s.tenant.id])
    expect(rows).toHaveLength(0)

    // Sem notas no ADN: 200 com a lista vazia.
    const vazio = adnFalso({})
    const semNotas = await handleOnboardingClientes(pedirJson(token(s), { tenant_id: s.tenant.id, acao: 'buscar_adn' }), depsComAdn(vazio.transport))
    expect(semNotas.status).toBe(200)
    expect(await corpo(semNotas)).toEqual({ candidatos: [] })

    // Sessão e dono, na ordem da rota do A1.
    const outro = await novoTenant(false)
    const semSessao = await entry.fetch(pedirJson(null, { tenant_id: s.tenant.id, acao: 'buscar_adn' }))
    expect(semSessao.status).toBe(401)
    expect((await corpo(semSessao)).error?.code).toBe('UNAUTHORIZED')
    const estranho = await entry.fetch(pedirJson(token(outro), { tenant_id: s.tenant.id, acao: 'buscar_adn' }))
    expect(estranho.status).toBe(403)
    expect((await corpo(estranho)).error?.code).toBe('FORBIDDEN')
    const acaoErrada = await entry.fetch(pedirJson(token(s), { tenant_id: s.tenant.id, acao: 'apagar' }))
    expect(acaoErrada.status).toBe(422)
    expect((await corpo(acaoErrada)).error?.code).toBe('VALIDATION_FAILED')
  })

  it('pdf lido pela ia', async () => {
    const s = await novoTenant()

    // ADN fora do ar (rede, HTTP 5xx ou formato desconhecido) → 503 ADN_INDISPONIVEL.
    const foraDoAr = adnFalso({
      0: () => {
        throw new TransportError('ECONNREFUSED')
      },
    })
    const respostas = [
      await handleOnboardingClientes(pedirJson(token(s), { tenant_id: s.tenant.id, acao: 'buscar_adn' }), depsComAdn(foraDoAr.transport)),
      await handleOnboardingClientes(
        pedirJson(token(s), { tenant_id: s.tenant.id, acao: 'buscar_adn' }),
        depsComAdn(adnFalso({ 0: { status: 503, body: 'Service Unavailable' } }).transport),
      ),
      await handleOnboardingClientes(
        pedirJson(token(s), { tenant_id: s.tenant.id, acao: 'buscar_adn' }),
        depsComAdn(adnFalso({ 0: { status: 200, body: '<html>manutenção</html>' } }).transport),
      ),
    ]
    for (const res of respostas) {
      expect(res.status).toBe(503)
      expect((await corpo(res)).error?.code).toBe('ADN_INDISPONIVEL')
    }
    // Sem A1 gravado, nem chega a chamar o ADN (pela função publicada).
    const semA1 = await novoTenant(false)
    const resSemA1 = await entry.fetch(pedirJson(token(semA1), { tenant_id: semA1.tenant.id, acao: 'buscar_adn' }))
    expect(resSemA1.status).toBe(503)
    expect((await corpo(resSemA1)).error?.code).toBe('ADN_INDISPONIVEL')

    // DANFSe → 200 {candidato} com os campos da IA, validados pelo código.
    const antes = ia.chamadas.length
    const res = await entry.fetch(pedirPdf(token(s), s.tenant.id, PDF_DANFSE))
    expect(res.status).toBe(200)
    expect(await corpo(res)).toEqual({
      candidato: {
        nome: 'Clínica Bem Estar Ltda',
        tomador_documento: CNPJ_CLIENTE,
        tomador_nome: 'Clínica Bem Estar Ltda',
        tomador_email: null,
        tomador_endereco: {
          logradouro: 'Rua das Flores',
          numero: '100',
          complemento: null,
          bairro: 'Centro',
          codigo_municipio: '3550308',
          uf: 'SP',
          cep: '01001000',
        },
        codigo_servico_nacional: '010701',
        descricao: 'Consultoria em sistemas',
        valor_padrao: '1500.00',
        origem: 'importacao_pdf',
      },
    })
    expect(ia.chamadas).toHaveLength(antes + 1)
    const chamada = ia.chamadas[antes]
    expect(chamada.corpo.model).toBe('claude-modelo-de-teste')
    expect(pdfDaChamada(chamada)?.equals(Buffer.from(PDF_DANFSE))).toBe(true)
    expect(chamada.corpo.output_config?.format?.type).toBe('json_schema')

    // Valores que a IA devolve fora do formato não passam: viram null.
    const iaDoAmbiente = iaFromEnv()
    if (!iaDoAmbiente) throw new Error('IA de teste não configurada')
    const leitorTorto = leitorPdfClaude(iaDoAmbiente)
    const respostaOriginal = ia.responder
    ia.responder = () => ({
      json: { ...LEITURA_DANFSE, tomador_documento: '11.222.333/0001-82', codigo_servico_nacional: '01.07', valor: '-5', tomador_email: 'contato@clinica.test' },
    })
    try {
      const leitura = await leitorTorto.ler(PDF_DANFSE)
      expect(leitura.danfse && leitura.candidato).toMatchObject({
        tomador_documento: null,
        codigo_servico_nacional: null,
        valor_padrao: null,
        tomador_email: 'contato@clinica.test',
      })
    } finally {
      ia.responder = respostaOriginal
    }

    // PDF que não é DANFSe → 422 PDF_ILEGIVEL; arquivo que nem é PDF não chega à IA.
    const naoDanfse = await entry.fetch(pedirPdf(token(s), s.tenant.id, PDF_OUTRO))
    expect(naoDanfse.status).toBe(422)
    expect((await corpo(naoDanfse)).error?.code).toBe('PDF_ILEGIVEL')
    const chamadasAntes = ia.chamadas.length
    const naoPdf = await entry.fetch(pedirPdf(token(s), s.tenant.id, new TextEncoder().encode('isto é uma planilha')))
    expect(naoPdf.status).toBe(422)
    expect((await corpo(naoPdf)).error?.code).toBe('PDF_ILEGIVEL')
    expect(ia.chamadas).toHaveLength(chamadasAntes)
  })

  it('salvar clientes', async () => {
    const s = await novoTenant(false)
    await criarModelo(admin.db, s.tenant.id, { nome: 'Prontia', documento: CPF_CLIENTE, nomeTomador: 'Prontia Saúde' })
    const base = {
      tomador_email: 'financeiro@clinica.test',
      tomador_endereco: null,
      codigo_servico_nacional: '010701',
      descricao: 'Consultoria',
      valor_padrao: '250.00',
    }
    const modelos = [
      {
        ...base,
        nome: 'Clínica Bem Estar',
        tomador_documento: CNPJ_CLIENTE,
        tomador_nome: 'Clínica Bem Estar Ltda',
        tomador_endereco: { logradouro: 'Rua das Flores', numero: '100', complemento: null, bairro: 'Centro', codigo_municipio: '3550308', uf: 'SP', cep: '01001000' },
        origem: 'importacao_adn',
      },
      { ...base, nome: 'Maria', tomador_documento: '111.444.777-35', tomador_nome: 'Maria Souza', tomador_email: null, valor_padrao: null, origem: 'importacao_pdf' },
      { ...base, nome: 'Documento Errado', tomador_documento: '11222333000182', tomador_nome: 'Empresa X', origem: 'importacao_adn' },
      { ...base, nome: '  ', tomador_documento: '39053344705', tomador_nome: null, origem: 'importacao_pdf' },
      { ...base, nome: 'Código Curto', tomador_documento: '39053344705', tomador_nome: 'Pessoa Y', codigo_servico_nacional: '12345', origem: 'importacao_pdf' },
      { ...base, nome: 'PRONTIA', tomador_documento: '39053344705', tomador_nome: 'Prontia Outra', origem: 'importacao_adn' },
      { ...base, nome: 'clínica bem estar', tomador_documento: '39053344705', tomador_nome: 'Outra Clínica', origem: 'importacao_pdf' },
    ]
    const res = await entry.fetch(pedirJson(token(s), { tenant_id: s.tenant.id, acao: 'salvar', modelos }))
    expect(res.status).toBe(201)
    expect(await corpo(res)).toEqual({
      salvos: 2,
      ignorados: [
        { nome: 'Documento Errado', motivo: 'documento_invalido' },
        { nome: null, motivo: 'sem_nome' },
        { nome: 'Código Curto', motivo: 'codigo_servico_invalido' },
        { nome: 'PRONTIA', motivo: 'nome_repetido' },
        { nome: 'clínica bem estar', motivo: 'nome_repetido' },
      ],
    })

    const { rows } = await admin.db.query<Record<string, unknown>>(
      `select nome, tomador_documento, tomador_nome, tomador_email, tomador_endereco, codigo_servico_nacional,
              descricao, valor_padrao, origem, created_from_invoice_id
         from nofiscal.fiscal_models where tenant_id = $1 and origem <> 'nota' order by nome`,
      [s.tenant.id],
    )
    expect(rows).toEqual([
      {
        nome: 'Clínica Bem Estar',
        tomador_documento: CNPJ_CLIENTE,
        tomador_nome: 'Clínica Bem Estar Ltda',
        tomador_email: 'financeiro@clinica.test',
        tomador_endereco: { logradouro: 'Rua das Flores', numero: '100', complemento: null, bairro: 'Centro', codigo_municipio: '3550308', uf: 'SP', cep: '01001000' },
        codigo_servico_nacional: '010701',
        descricao: 'Consultoria',
        valor_padrao: '250.00',
        origem: 'importacao_adn',
        created_from_invoice_id: null,
      },
      {
        nome: 'Maria',
        tomador_documento: '11144477735',
        tomador_nome: 'Maria Souza',
        tomador_email: null,
        tomador_endereco: null,
        codigo_servico_nacional: '010701',
        descricao: 'Consultoria',
        valor_padrao: null,
        origem: 'importacao_pdf',
        created_from_invoice_id: null,
      },
    ])
    // O modelo que já existia continua o mesmo.
    const { rows: prontia } = await admin.db.query<{ n: number }>(
      `select count(*)::int as n from nofiscal.fiscal_models where tenant_id = $1 and lower(nome) = 'prontia'`,
      [s.tenant.id],
    )
    expect(prontia[0].n).toBe(1)

    // Lista vazia é erro de corpo, e nada muda.
    const vazio = await entry.fetch(pedirJson(token(s), { tenant_id: s.tenant.id, acao: 'salvar', modelos: [] }))
    expect(vazio.status).toBe(422)
  })

  it('pdf não é guardado', async () => {
    const s = await novoTenant()
    const BASE64 = Buffer.from(PDF_DANFSE).toString('base64')

    // Banco: cada comando da rota passa por aqui.
    const comandos: { sql: string; params: string }[] = []
    const gravador: Db = {
      query: (sql, params) => {
        comandos.push({ sql, params: JSON.stringify(params ?? []) })
        return servico.db.query(sql, params)
      },
      transaction: (work) => servico.db.transaction(work),
    }
    // Disco: arquivos novos na pasta temporária e na pasta do app.
    const pastas = [tmpdir(), fileURLToPath(new URL('../../', import.meta.url))]
    const listar = () => new Set(pastas.flatMap((p) => readdirSync(p).map((n) => join(p, n))))
    const antes = listar()
    // Storage: objetos do Supabase Storage.
    const contarStorage = async () => (await admin.db.query<{ n: number }>('select count(*)::int as n from storage.objects')).rows[0].n
    const storageAntes = await contarStorage()
    // Log: nada do conteúdo.
    const log = vi.spyOn(console, 'log')

    const res = await handleOnboardingClientes(pedirPdf(token(s), s.tenant.id, PDF_DANFSE), depsComAdn(adnFalso({}).transport, gravador))
    expect(res.status).toBe(200)

    const escritas = comandos.filter((c) => /^\s*(insert|update|delete|copy|select\s+.*lo_)/i.test(c.sql))
    expect(escritas).toHaveLength(1)
    expect(escritas[0].sql).toMatch(/insert into nofiscal\.fiscal_importacao_pdfs/)
    for (const c of comandos) {
      expect(c.params).not.toContain(MARCA_SEGREDO)
      expect(c.params).not.toContain(BASE64.slice(0, 40))
      expect(c.sql).not.toMatch(/storage\./)
    }
    expect(await contarStorage()).toBe(storageAntes)
    const novos = [...listar()].filter((p) => !antes.has(p))
    for (const p of novos) {
      if (statSync(p).isFile()) expect(readFileSync(p).includes(MARCA_SEGREDO)).toBe(false)
    }
    for (const chamada of log.mock.calls) expect(JSON.stringify(chamada)).not.toContain(MARCA_SEGREDO)
    log.mockRestore()
    // O que fica no banco é só a contagem.
    const { rows } = await admin.db.query('select * from nofiscal.fiscal_importacao_pdfs where tenant_id = $1', [s.tenant.id])
    expect(rows).toEqual([{ tenant_id: s.tenant.id, enviados: 1, atualizado_em: expect.any(Date) }])

    // E o código da rota não tem caminho de escrita em disco ou storage.
    const fontes = ['../_lib/onboarding-clientes.ts', '../_lib/ia/leitor-pdf.ts', '../_lib/ia/claude.ts', '../v1/onboarding/clientes.ts']
    for (const f of fontes) {
      const fonte = readFileSync(new URL(f, import.meta.url), 'utf8')
      expect(fonte).not.toMatch(/node:fs|writeFile|createWriteStream|\.storage\b|storage\.from|from 'fs'/)
    }
  })

  it('limite de pdfs', async () => {
    const s = await novoTenant()
    await admin.db.query('insert into nofiscal.fiscal_importacao_pdfs (tenant_id, enviados) values ($1, 29)', [s.tenant.id])

    // O 30º ainda é lido.
    const trigesimo = await entry.fetch(pedirPdf(token(s), s.tenant.id, PDF_DANFSE))
    expect(trigesimo.status).toBe(200)

    // O 31º responde 429 sem chamar a IA.
    const chamadas = ia.chamadas.length
    const res = await entry.fetch(pedirPdf(token(s), s.tenant.id, PDF_DANFSE))
    expect(res.status).toBe(429)
    expect((await corpo(res)).error?.code).toBe('LIMITE_PDFS')
    expect(ia.chamadas).toHaveLength(chamadas)
    const { rows } = await admin.db.query<{ enviados: number }>('select enviados from nofiscal.fiscal_importacao_pdfs where tenant_id = $1', [s.tenant.id])
    expect(rows[0].enviados).toBe(30)

    // A cota é do tenant: outro tenant segue lendo.
    const outro = await novoTenant()
    const doOutro = await entry.fetch(pedirPdf(token(outro), outro.tenant.id, PDF_DANFSE))
    expect(doOutro.status).toBe(200)

    // Falha da API da IA: 503 e a vaga volta.
    iaFalha = true
    try {
      const falha = await entry.fetch(pedirPdf(token(outro), outro.tenant.id, PDF_DANFSE))
      expect(falha.status).toBe(503)
      expect((await corpo(falha)).error?.code).toBe('IA_INDISPONIVEL')
    } finally {
      iaFalha = false
    }
    const { rows: doOutroRows } = await admin.db.query<{ enviados: number }>(
      'select enviados from nofiscal.fiscal_importacao_pdfs where tenant_id = $1',
      [outro.tenant.id],
    )
    expect(doOutroRows[0].enviados).toBe(1)
  })
})
