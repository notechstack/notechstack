// Aba "NF-e" do painel, de ponta a ponta no banco local com o papel de produção (`nofiscal_service`): sessão falsa
// ("Bearer token-<user id>") e Sefaz dublê. Prova: só o dono da conta Escritório usa, e só pelas empresas dela; a
// planilha confere, emite sem duplicar e a nota sai autorizada, com DANFE e XML para baixar; cancelar pela fila.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { allowTestUserToAssume, createEscritorio, dropEscritorio, openRoleDb, type Escritorio } from '../../_tests/agente-fixtures.js'
import { makeTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import type { HttpRequest, HttpResponse } from '../sefin-client.js'
import type { SessionVerifier } from '../session.js'
import { handlePainelNfe } from './painel-nfe.js'
import { informacoesComplementaresDaNota } from './nfe-builder.js'
import { interpretarPlanilhaNfe, lerNumero, lerPlanilhaNfe } from './planilha.js'
import { lerCsvTexto } from '../agente/lote.js'
import { criarSefazClient } from './sefaz-client.js'
import { processarNfes } from './servico.js'
import { sefazQueAprova } from './nfe-fixtures.js'

const NS = 'http://www.portalfiscal.inf.br/nfe'
const MODELO = readFileSync(new URL('../../../../agentes/fiscal/dados/modelo-nfe.csv', import.meta.url), 'utf8')
const MODELO_XLSX = new Uint8Array(readFileSync(new URL('../../../../agentes/fiscal/dados/modelo-nfe.xlsx', import.meta.url)))
/** CNPJ com dígitos verificadores válidos e base aleatória (o banco local é compartilhado entre testes). */
function cnpjAleatorio(): string {
  const base = Array.from(randomBytes(8), (b) => String(b % 10)).join('') + '0001'
  const dv = (s: string) => {
    const pesos = s.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const r = [...s].reduce((t, c, i) => t + Number(c) * pesos[i], 0) % 11
    return r < 2 ? '0' : String(11 - r)
  }
  const d1 = dv(base)
  return base + d1 + dv(base + d1)
}

const sessions: SessionVerifier = {
  async userIdFrom(request) {
    return /^Bearer token-([0-9a-f-]{36})$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
  },
}

describe('planilha de NF-e (pura)', () => {
  it('o modelo publicado vira 3 notas: a 1 com transporte, a 2 com 2 itens, a 3 interestadual com frete e boleto', () => {
    const r = interpretarPlanilhaNfe(lerCsvTexto(MODELO.trimStart()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.problemas).toEqual([])
    expect(r.notas.map((n) => [n.nota, n.linhas, n.pedido.itens.length, n.avisos])).toEqual([
      ['1', [2], 1, []],
      ['2', [3, 4], 2, []],
      ['3', [5], 1, []],
      ['4', [6], 1, []],
    ])
    const [transporte, um, dois, remessa] = r.notas
    // Nota 4: remessa 6949 com a natureza na coluna; sem forma_pagamento, sai "sem pagamento".
    expect(remessa.pedido).toMatchObject({ naturezaOperacao: 'Simples remessa', pagamentos: [{ forma: '90', valor: 0 }] })
    expect(remessa.pedido.itens[0]).toMatchObject({ cfop: '6949', csosn: '400' })
    expect(transporte.pedido).toMatchObject({
      modalidadeFrete: '0',
      transportador: { documento: '11444777000161', nome: 'Transportadora Exemplo Ltda', inscricaoEstadual: '190.123.456.110', municipio: 'Atibaia', uf: 'SP' },
      volumes: [{ quantidade: 10, especie: 'CAIXA', marca: 'EXEMPLO', numeracao: '1 a 10', pesoLiquido: 60.4, pesoBruto: 60.4 }],
      pagamentos: [{ forma: '15', valor: 1163.75 }],
      destinatario: { indicadorIE: '1', inscricaoEstadual: '110042490114' },
    })
    expect(transporte.pedido.itens[0]).toMatchObject({ csosn: '101', aliquotaCreditoSN: 2.56, desconto: 61.25, cfop: '5101' })
    // A coluna informacoes do modelo não traz mais a frase do crédito: ela sai do builder, com o valor calculado (500 × 2,45 × 2,56%).
    expect(transporte.pedido.informacoesComplementares).not.toMatch(/aproveitamento do crédito/)
    expect(informacoesComplementaresDaNota(transporte.pedido.informacoesComplementares, transporte.pedido.itens)).toMatch(
      /^Permite o aproveitamento do crédito de ICMS no valor de R\$ 31,36, correspondente à alíquota de 2,56%, nos termos do art\. 23 da LC 123\/2006\. Documento emitido/,
    )
    // Sem as colunas de transporte (notas 2 e 3), o pedido é o de antes: nem a chave da planilha muda.
    expect(Object.keys(um.pedido)).not.toContain('transportador')
    expect(Object.keys(dois.pedido)).not.toContain('volumes')
    expect(um.pedido.itens[1]).toMatchObject({ quantidade: 2.5, valorUnitario: 12.345, desconto: 1 })
    expect(um.pedido.pagamentos).toEqual([{ forma: '17', valor: 89.56, descricao: null }])
    expect(um.pedido.destinatario).toMatchObject({ documento: '11222333000181', indicadorIE: '9', endereco: { codigoMunicipio: '3550308', uf: 'SP', cep: '01310100' } })
    expect(dois.pedido).toMatchObject({ modalidadeFrete: '0', pagamentos: [{ forma: '15', valor: 224 }] })
    expect(dois.pedido.itens[0].frete).toBe(25)
  })

  it('colunas faltando recusam a planilha com o link do modelo', () => {
    const r = interpretarPlanilhaNfe([['cnpj_emitente', 'nota']])
    expect(r).toEqual({ ok: false, mensagem: expect.stringContaining('Faltam colunas da planilha de NF-e: cpf_cnpj_destinatario') })
  })

  it('destinatário diferente entre linhas da mesma nota é problema da nota', () => {
    const linhas = lerCsvTexto(MODELO.trimStart())
    linhas[3][2] = '52998224725'
    const r = interpretarPlanilhaNfe(linhas)
    expect(r.ok && r.problemas.map((p) => [p.nota, p.mensagem])).toEqual([['2', 'linha 4: "cpf_cnpj_destinatario" diferente da linha 3']])
  })

  it('o modelo .xlsx publicado é lido pelo leitor de produção e dá as mesmas notas do .csv', async () => {
    const xlsx = await lerPlanilhaNfe(MODELO_XLSX, 'xlsx')
    const csv = interpretarPlanilhaNfe(lerCsvTexto(MODELO.trimStart()))
    expect(xlsx.ok && xlsx.problemas).toEqual([])
    expect(xlsx.ok && xlsx.notas).toEqual(csv.ok && csv.notas)
  })

  it('números em pt-BR', () => {
    expect(lerNumero('1.234,5678', 4)).toBe(1234.5678)
    expect(lerNumero('2,5', 4)).toBe(2.5)
    expect(lerNumero('1.000', 4)).toBe(1000)
    expect(lerNumero('1,23456', 4)).toBeNull()
    expect(lerNumero(3, 4)).toBe(3)
  })
})

describe('rota do painel', () => {
  const admin = openTestDb()
  let servico: ReturnType<typeof openRoleDb>
  let esc: Escritorio
  let outro: Escritorio
  let cnpjEmitente: string

  beforeAll(async () => {
    await allowTestUserToAssume(admin.db, 'nofiscal_service')
    servico = openRoleDb('nofiscal_service')
    esc = await createEscritorio(admin.db, { empresas: [{ razaoSocial: 'Comercio Cliente Ltda' }] })
    outro = await createEscritorio(admin.db, {})
    // Planos por módulo (23/11/2026): a NF-e só abre para a conta que a tem entre os tipos de nota.
    await admin.db.query(`update nofiscal.fiscal_tenants set tipos_nota = array['nfse','nfe'] where id = any($1::uuid[])`, [[esc.mae.tenant.id, outro.mae.tenant.id]])
    // A empresa cliente: CNPJ do modelo, em Bragança Paulista, com A1 do próprio CNPJ.
    const empresa = esc.empresas[0]
    cnpjEmitente = cnpjAleatorio()
    await admin.db.query(`update nofiscal.fiscal_tenants set cnpj = $2, codigo_municipio_ibge = '3507605' where id = $1`, [empresa.id, cnpjEmitente])
    const cert = makeTestCertificate({ commonName: `COMERCIO CLIENTE LTDA:${cnpjEmitente}` })
    await admin.db.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [empresa.id, cert.certificado.pfxBase64, cert.certificado.password, 'CN=x', new Date(Date.now() + 86400_000 * 365)])
  })

  afterAll(async () => {
    for (const e of [esc, outro]) {
      for (const t of [e.mae.tenant, ...e.empresas]) {
        await admin.db.query('delete from nofiscal.fiscal_nfe_eventos where tenant_id = $1', [t.id])
        await admin.db.query('delete from nofiscal.fiscal_nfe where tenant_id = $1', [t.id])
        await admin.db.query('delete from nofiscal.fiscal_nfe_conferencias where tenant_id = $1', [t.id])
        await admin.db.query('delete from nofiscal.fiscal_nfe_series where tenant_id = $1', [t.id])
      }
      await dropEscritorio(admin.db, e)
    }
    await servico.pool.end()
    await admin.pool.end()
  })

  async function chamar(userId: string | null, corpo: Record<string, unknown> | FormData | null, metodo = 'POST', query = '') {
    const headers: Record<string, string> = {}
    if (userId) headers.authorization = `Bearer token-${userId}`
    if (corpo && !(corpo instanceof FormData)) headers['content-type'] = 'application/json'
    const res = await handlePainelNfe(
      new Request(`https://app.notechstack.com.br/api/v1/fiscal/nfe${query}`, { method: metodo, headers, body: corpo instanceof FormData ? corpo : corpo ? JSON.stringify(corpo) : undefined }),
      { db: servico.db, sessions, now: () => new Date('2026-11-17T13:00:00Z'), sefaz: sefazQueAprova('222333444555') },
    )
    return res
  }
  const planilha = (acao: string) => {
    const f = new FormData()
    f.append('acao', acao)
    f.append('arquivo', new File([MODELO.replaceAll('12.345.678/0001-95', cnpjEmitente)], 'nfe.csv', { type: 'text/csv' }))
    return f
  }

  it('conta sem a NF-e entre os tipos de nota: 403 NFE_NAO_CONTRATADA, e volta a abrir quando a NF-e entra', async () => {
    await admin.db.query(`update nofiscal.fiscal_tenants set tipos_nota = array['nfse'] where id = $1`, [outro.mae.tenant.id])
    const fechada = await chamar(outro.mae.ownerUserId, { acao: 'contexto' })
    expect(fechada.status).toBe(403)
    expect(((await fechada.json()) as { error: { code: string } }).error.code).toBe('NFE_NAO_CONTRATADA')
    // Só NF-e (sem NFS-e) também abre: o que vale é a NF-e estar na lista.
    await admin.db.query(`update nofiscal.fiscal_tenants set tipos_nota = array['nfe'] where id = $1`, [outro.mae.tenant.id])
    expect((await chamar(outro.mae.ownerUserId, { acao: 'contexto' })).status).toBe(200)
  })

  it('sem login 401; conta de outro escritório não vê a empresa', async () => {
    expect((await chamar(null, { acao: 'contexto' })).status).toBe(401)
    const r = await chamar(outro.mae.ownerUserId, { acao: 'dados_salvar', tenant_id: esc.empresas[0].id, inscricao_estadual: '222333444555' })
    expect(r.status).toBe(404)
  })

  it('contexto mostra o que falta; dados salvos liberam a empresa', async () => {
    const antes = (await (await chamar(esc.mae.ownerUserId, { acao: 'contexto' })).json()) as { empresas: { tenant_id: string; bloqueio: { codigo: string; motivo: string } | null }[] }
    const empresa = antes.empresas.find((e) => e.tenant_id === esc.empresas[0].id)!
    expect(empresa.bloqueio).toEqual({ codigo: 'NFE_SEM_IE', motivo: 'falta a inscrição estadual' })
    const r = await chamar(esc.mae.ownerUserId, {
      acao: 'dados_salvar',
      tenant_id: esc.empresas[0].id,
      inscricao_estadual: '222.333.444.555',
      endereco: { logradouro: 'Rua Coronel Teofilo Leme', numero: '100', bairro: 'Centro', cep: '12900-000', uf: 'SP' },
      serie: 1,
      proximo_numero: 501,
    })
    expect(r.status).toBe(200)
    const salvo = (await r.json()) as { empresas: { tenant_id: string; bloqueio: { codigo: string } | null; proximo_numero: number }[] }
    expect(salvo.empresas.find((e) => e.tenant_id === esc.empresas[0].id)).toMatchObject({ bloqueio: { codigo: 'NFE_NAO_CONFERIDA' }, proximo_numero: 501 })
    // Conferir na Sefaz (cadastro + nota de teste em homologação) libera a empresa.
    const conferida = await chamar(esc.mae.ownerUserId, { acao: 'conferir', tenant_id: esc.empresas[0].id })
    const depois = (await conferida.json()) as { empresas: { tenant_id: string; bloqueio: unknown; conferencia: { status: string } }[] }
    expect(depois.empresas.find((e) => e.tenant_id === esc.empresas[0].id)).toMatchObject({ bloqueio: null, conferencia: { status: 'aprovada' } })
  })

  it('planilha: ler confere; emitir põe na fila sem duplicar; worker autoriza; DANFE e XML baixam; cancelar entra na fila', async () => {
    const lida = await chamar(esc.mae.ownerUserId, planilha('planilha_ler'))
    expect(lida.status).toBe(200)
    expect(await lida.json()).toMatchObject({
      // Nota 1 (CSOSN 101): o resumo mostra o crédito antes de emitir; as outras (102) não têm.
      notas: [
        { nota: '1', itens: 1, valor: '1163.75', avisos: [], credito_icms_sn: 'R$ 31,36 (alíquota de 2,56%)' },
        { nota: '2', itens: 2, valor: '89.56', credito_icms_sn: null },
        { nota: '3', itens: 1, valor: '224.00', credito_icms_sn: null, natureza_operacao: 'Venda de mercadoria', pagamento: 'Boleto' },
        { nota: '4', itens: 1, valor: '362.61', natureza_operacao: 'Simples remessa', pagamento: 'Sem pagamento', avisos: [] },
      ],
      problemas: [],
    })

    const emitida = await chamar(esc.mae.ownerUserId, planilha('planilha_emitir'))
    expect(emitida.status).toBe(202)
    expect(await emitida.json()).toMatchObject({ emitindo: 4 })
    // A mesma planilha de novo não cria notas novas.
    await chamar(esc.mae.ownerUserId, planilha('planilha_emitir'))
    // Nem com o arquivo regravado (bytes diferentes, mesmo conteúdo), nem com a nota 2 corrigida depois de sair.
    const regravada = new FormData()
    regravada.append('acao', 'planilha_emitir')
    regravada.append('arquivo', new File([MODELO.replaceAll('12.345.678/0001-95', cnpjEmitente) + String.fromCharCode(10).repeat(2)], 'nfe-copia.csv', { type: 'text/csv' }))
    const r2 = (await (await chamar(esc.mae.ownerUserId, regravada)).json()) as { emitindo: number; problemas: { nota: string; mensagem: string }[] }
    expect(r2.emitindo).toBe(0)
    expect(r2.problemas.map((p) => p.nota)).toEqual(['1', '2', '3', '4'])
    const corrigida = new FormData()
    corrigida.append('acao', 'planilha_ler')
    corrigida.append('arquivo', new File([MODELO.replaceAll('12.345.678/0001-95', cnpjEmitente).replace('19,90;102;;;;pix', '18,90;102;;;;pix')], 'nfe-corrigida.csv', { type: 'text/csv' }))
    const r3 = (await (await chamar(esc.mae.ownerUserId, corrigida)).json()) as { notas: unknown[]; problemas: { nota: string; mensagem: string }[] }
    expect(r3.problemas.find((p) => p.nota === '2')?.mensagem).toMatch(/já saiu neste mês \(NF-e nº 502\) com outro conteúdo/)
    const { rows } = await admin.db.query<{ numero: string }>('select numero from nofiscal.fiscal_nfe where tenant_id = $1 order by numero', [esc.empresas[0].id])
    expect(rows.map((r) => r.numero)).toEqual(['501', '502', '503', '504'])

    let nProt = 135260000000100
    const transport = async (req: HttpRequest): Promise<HttpResponse> => {
      const chave = /Id="NFe(\d{44})"/.exec(req.body ?? '')?.[1]
      if (req.body?.includes('<envEvento')) {
        return { status: 200, body: `<r><retEnvEvento xmlns="${NS}"><cStat>128</cStat><retEvento><infEvento><cStat>135</cStat><xMotivo>ok</xMotivo><nProt>${++nProt}</nProt></infEvento></retEvento></retEnvEvento></r>` }
      }
      return { status: 200, body: `<r><retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo><protNFe><infProt><chNFe>${chave}</chNFe><dhRecbto>2026-11-17T10:00:00-03:00</dhRecbto><nProt>${++nProt}</nProt><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe></retEnviNFe></r>` }
    }
    const sefaz = criarSefazClient({ transport })
    const now = () => new Date('2026-11-17T13:00:00Z')
    expect(await processarNfes({ db: servico.db, sefaz, now, tenantId: esc.empresas[0].id })).toMatchObject({ autorizadas: 4 })

    const lista = (await (await chamar(esc.mae.ownerUserId, { acao: 'listar' })).json()) as { notas: { nfe_id: string; status: string; numero: number; homologacao: boolean }[] }
    expect(lista.notas.map((n) => [n.numero, n.status, n.homologacao]).sort()).toEqual([[501, 'authorized', true], [502, 'authorized', true], [503, 'authorized', true], [504, 'authorized', true]])
    const id = lista.notas.find((n) => n.numero === 502)!.nfe_id
    // A nota 1 do modelo (NF-e 501) sai com transportador e volumes no XML autorizado.
    const comTransporte = lista.notas.find((n) => n.numero === 501)!.nfe_id
    const xmlTransporte = await (await chamar(esc.mae.ownerUserId, null, 'GET', `?baixar=xml&nfe_id=${comTransporte}`)).text()
    expect(xmlTransporte).toContain('<transp><modFrete>0</modFrete><transporta><CNPJ>11444777000161</CNPJ>')
    // A frase do crédito sai calculada no XML autorizado, sem estar na coluna informacoes da planilha.
    expect(xmlTransporte).toContain(
      '<infCpl>Permite o aproveitamento do crédito de ICMS no valor de R$ 31,36, correspondente à alíquota de 2,56%, nos termos do art. 23 da LC 123/2006. Documento emitido por ME ou EPP',
    )
    expect(xmlTransporte).toContain('<vol><qVol>10</qVol><esp>CAIXA</esp><marca>EXEMPLO</marca><nVol>1 a 10</nVol><pesoL>60.400</pesoL><pesoB>60.400</pesoB></vol>')

    const pdf = await chamar(esc.mae.ownerUserId, null, 'GET', `?baixar=danfe&nfe_id=${id}`)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect((await PDFDocument.load(new Uint8Array(await pdf.arrayBuffer()))).getPageCount()).toBe(1)
    const xml = await chamar(esc.mae.ownerUserId, null, 'GET', `?baixar=xml&nfe_id=${id}`)
    expect(await xml.text()).toMatch(/^<nfeProc xmlns="http:\/\/www.portalfiscal.inf.br\/nfe" versao="4.00"><NFe/)
    expect((await chamar(outro.mae.ownerUserId, null, 'GET', `?baixar=xml&nfe_id=${id}`)).status).toBe(404)

    expect((await chamar(esc.mae.ownerUserId, { acao: 'cancelar', nfe_id: id, texto: 'curto' })).status).toBe(422)
    expect((await chamar(esc.mae.ownerUserId, { acao: 'cancelar', nfe_id: id, texto: 'Venda desfeita pelo cliente' })).status).toBe(202)
    await processarNfes({ db: servico.db, sefaz, now, tenantId: esc.empresas[0].id })
    const final = (await (await chamar(esc.mae.ownerUserId, { acao: 'listar' })).json()) as { notas: { nfe_id: string; status: string }[] }
    expect(final.notas.find((n) => n.nfe_id === id)?.status).toBe('cancelled')
    // Cancelada, a nota 2 pode sair de novo corrigida na planilha (só nota ativa do mês bloqueia).
    const depoisDoCancelamento = (await (await chamar(esc.mae.ownerUserId, corrigida)).json()) as { notas: { nota: string }[]; problemas: { nota: string }[] }
    expect(depoisDoCancelamento.notas.map((x) => x.nota)).toContain('2')
  })
})

describe('NF-e avulsa do painel (23/11/2026)', () => {
  const admin = openTestDb()
  let servico: ReturnType<typeof openRoleDb>
  let esc: Escritorio
  let tenant: string

  beforeAll(async () => {
    await allowTestUserToAssume(admin.db, 'nofiscal_service')
    servico = openRoleDb('nofiscal_service')
    esc = await createEscritorio(admin.db, { empresas: [{ razaoSocial: 'Embalagens Exemplo Ltda' }] })
    await admin.db.query(`update nofiscal.fiscal_tenants set tipos_nota = array['nfse','nfe'] where id = $1`, [esc.mae.tenant.id])
    tenant = esc.empresas[0].id
    const cnpj = cnpjAleatorio()
    await admin.db.query(`update nofiscal.fiscal_tenants set cnpj = $2, codigo_municipio_ibge = '3504107' where id = $1`, [tenant, cnpj])
    const cert = makeTestCertificate({ commonName: `EMBALAGENS EXEMPLO LTDA:${cnpj}` })
    await admin.db.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [tenant, cert.certificado.pfxBase64, cert.certificado.password, 'CN=x', new Date(Date.now() + 86400_000 * 365)])
  })

  afterAll(async () => {
    for (const t of [esc.mae.tenant, ...esc.empresas]) {
      await admin.db.query('delete from nofiscal.fiscal_nfe_eventos where tenant_id = $1', [t.id])
      await admin.db.query('delete from nofiscal.fiscal_nfe where tenant_id = $1', [t.id])
      await admin.db.query('delete from nofiscal.fiscal_nfe_conferencias where tenant_id = $1', [t.id])
      await admin.db.query('delete from nofiscal.fiscal_nfe_series where tenant_id = $1', [t.id])
    }
    await dropEscritorio(admin.db, esc)
    await servico.pool.end()
    await admin.pool.end()
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Corpo = Record<string, any>
  const chamar = async (corpo: Record<string, unknown>) => {
    const res = await handlePainelNfe(
      new Request('https://app.notechstack.com.br/api/v1/fiscal/nfe', {
        method: 'POST',
        headers: { authorization: `Bearer token-${esc.mae.ownerUserId}`, 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
      }),
      { db: servico.db, sessions, now: () => new Date('2026-11-23T13:00:00Z'), sefaz: sefazQueAprova('222333444555') },
    )
    return { status: res.status, corpo: (await res.json()) as Corpo }
  }
  const nota = () => ({
    destinatario: {
      documento: '11222333000181', nome: 'Comercio de Embalagens Exemplo Ltda', indicador_ie: '1', inscricao_estadual: '110042490114',
      endereco: { logradouro: 'Rua Barao de Jaguara', numero: '900', bairro: 'Centro', codigo_municipio: 'Campinas/SP', uf: '', cep: '13015000' },
    },
    itens: [{ codigo: 'EMB-4030', descricao: 'Caixa de papelao 40x30x20', ncm: '48191000', cfop: '5101', unidade: 'UN', quantidade: 500, valor_unitario: 2.45, desconto: 61.25, csosn: '101', aliquota_credito_sn: 2.56 }],
    modalidade_frete: '0',
    transportador: { documento: '11444777000161', nome: 'Transportadora Exemplo Ltda', uf: 'SP' },
    volumes: [{ quantidade: 10, especie: 'CAIXA', peso_liquido: 60.4, peso_bruto: 60 }],
    informacoes_complementares: 'Documento emitido por ME ou EPP optante pelo Simples Nacional.',
  })
  const CHAVE = '6b3c1d8e-0f1a-4b2c-9d3e-4f5a6b7c8d9e'

  it('conferir antes dos dados da empresa: resumo com o bloqueio; emitir recusado', async () => {
    const r = await chamar({ acao: 'avulsa_conferir', tenant_id: tenant, nota: nota(), forma_pagamento: '15' })
    expect(r.status).toBe(200)
    expect(r.corpo.bloqueio).toMatchObject({ codigo: 'NFE_SEM_IE' })
    const e = await chamar({ acao: 'avulsa_emitir', tenant_id: tenant, nota: nota(), forma_pagamento: '15', chave: CHAVE })
    expect(e.status).toBe(409)
  })

  it('com a empresa pronta: resumo, aviso do peso, emissão idempotente pela chave e histórico', async () => {
    await chamar({ acao: 'dados_salvar', tenant_id: tenant, inscricao_estadual: '222.333.444.555', endereco: { logradouro: 'Rua A', numero: '1', bairro: 'Centro', cep: '12940-000', uf: 'SP' }, serie: 1, proximo_numero: 10 })
    await chamar({ acao: 'conferir', tenant_id: tenant })

    const c = await chamar({ acao: 'avulsa_conferir', tenant_id: tenant, nota: nota(), forma_pagamento: '15', frete: '25,00' })
    expect(c.status).toBe(200)
    expect(c.corpo).toMatchObject({ bloqueio: null, problemas: [] })
    expect(c.corpo.avisos).toEqual(['volumes: peso bruto (60 kg) menor que o peso líquido (60,4 kg); confira'])
    expect(c.corpo.resumo).toMatchObject({ pagamento: 'Boleto', destinatario: { municipio_ibge: '3509502', uf: 'SP' } })
    expect(c.corpo.resumo.totais.nota).toMatch(/1\.188,75/)
    expect(c.corpo.resumo.transporte).toMatch(/Por conta do emitente/)
    expect(c.corpo.resumo.credito_icms_sn).toBe('R$ 31,36 (alíquota de 2,56%)')
    expect(c.corpo.resumo.informacoes_complementares).toBe(
      'Permite o aproveitamento do crédito de ICMS no valor de R$ 31,36, correspondente à alíquota de 2,56%, nos termos do art. 23 da LC 123/2006. Documento emitido por ME ou EPP optante pelo Simples Nacional.',
    )

    const e1 = await chamar({ acao: 'avulsa_emitir', tenant_id: tenant, nota: nota(), forma_pagamento: '15', frete: '25,00', chave: CHAVE })
    expect(e1.status).toBe(202)
    expect(e1.corpo).toMatchObject({ numero: 10, ja_existia: false })
    const e2 = await chamar({ acao: 'avulsa_emitir', tenant_id: tenant, nota: nota(), forma_pagamento: '15', frete: '25,00', chave: CHAVE })
    expect(e2.corpo).toMatchObject({ nfe_id: e1.corpo.nfe_id, ja_existia: true })

    const { rows } = await admin.db.query<{ origem: string; payload: Corpo; valor_total: string }>('select origem, payload, valor_total from nofiscal.fiscal_nfe where id = $1', [e1.corpo.nfe_id])
    expect(rows[0]).toMatchObject({ origem: 'painel', valor_total: '1188.75' })
    expect(rows[0].payload.pagamentos).toEqual([{ forma: '15', valor: 1188.75, descricao: null }])
    expect(rows[0].payload.itens[0].frete).toBe(25)

    const h = await chamar({ acao: 'historico', tenant_id: tenant })
    expect(h.corpo.destinatarios).toEqual([expect.objectContaining({ documento: '11222333000181', municipio: 'Campinas/SP' })])
    expect(h.corpo.produtos).toEqual([expect.objectContaining({ codigo: 'EMB-4030', ncm: '48191000', cfop: '5101', csosn: '101', aliquotaCreditoSN: 2.56 })])
    expect(h.corpo.transportadores).toEqual([expect.objectContaining({ documento: '11444777000161' })])
  })

  it('problemas da nota voltam na conferência; município ambíguo e forma inválida são recusados', async () => {
    const ruim = nota()
    ruim.itens[0].cfop = '6101'
    const c = await chamar({ acao: 'avulsa_conferir', tenant_id: tenant, nota: ruim, forma_pagamento: '17' })
    expect(c.corpo.problemas).toEqual(['item 1: operação dentro do estado pede CFOP 5xxx'])
    const amb = nota()
    amb.destinatario.endereco.codigo_municipio = 'Bom Jesus'
    expect((await chamar({ acao: 'avulsa_conferir', tenant_id: tenant, nota: amb })).corpo.error.message).toMatch(/mais de um estado/)
    expect((await chamar({ acao: 'avulsa_conferir', tenant_id: tenant, nota: nota(), forma_pagamento: '42' })).status).toBe(422)
    expect((await chamar({ acao: 'historico', tenant_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(404)
  })
})

describe('planilha depois da revisão de 17/11/2026', () => {
  const CAB = ['cnpj_emitente', 'nota', 'cpf_cnpj_destinatario', 'nome_destinatario', 'cep', 'logradouro', 'numero', 'bairro', 'municipio_ibge', 'uf', 'codigo_produto', 'descricao_produto', 'ncm', 'cfop', 'unidade', 'quantidade', 'valor_unitario', 'csosn', 'frete', 'forma_pagamento', 'descricao_pagamento']
  const linha = (o: Record<string, unknown>) => CAB.map((c) => (c in o ? o[c] : '')) as (string | number)[]
  const base = { cnpj_emitente: '12.345.678/0001-95', nota: '1', cpf_cnpj_destinatario: '11.222.333/0001-81', nome_destinatario: 'Padaria', cep: '01310-100', logradouro: 'Av. Paulista', numero: '1', bairro: 'Bela Vista', municipio_ibge: '3550308', uf: 'SP', codigo_produto: 'P1', descricao_produto: 'Farinha', ncm: '1101.00.10', cfop: '5102', unidade: 'UN', quantidade: '1', valor_unitario: '10,00', csosn: '102' }

  it('células numéricas do .xlsx: CEP e NCM voltam com os zeros; quantidade com 5 casas é recusada', () => {
    const r = interpretarPlanilhaNfe([CAB, linha({ ...base, cep: 1310100, ncm: 1012100, cpf_cnpj_destinatario: '11.222.333/0001-81' })])
    expect(r.ok && r.notas[0].pedido.destinatario.endereco.cep).toBe('01310100')
    expect(r.ok && r.notas[0].pedido.itens[0].ncm).toBe('01012100')
    const q = interpretarPlanilhaNfe([CAB, linha({ ...base, quantidade: 1.23456 })])
    expect(q.ok && q.problemas.map((p) => p.mensagem)).toEqual(['linha 2: quantidade inválida (até 4 casas)'])
  })

  it('CSV com vírgula e decimal sem aspas (colunas a mais) recusa a nota em vez de deslocar', () => {
    const r = interpretarPlanilhaNfe([CAB, [...linha(base), 'sobra']], { contarCampos: true })
    expect(r.ok && r.notas).toEqual([])
    expect(r.ok && r.problemas[0].mensagem).toMatch(/mais colunas que o cabeçalho/)
  })

  it('frete e forma de pagamento numa linha de continuação valem para a nota; o pagamento é o vNF do leiaute', () => {
    const r = interpretarPlanilhaNfe([CAB, linha(base), linha({ ...base, codigo_produto: 'P2', valor_unitario: '0,005', quantidade: '1', frete: '5,00', forma_pagamento: 'boleto' })])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = r.notas[0].pedido
    expect(p.pagamentos[0].forma).toBe('15')
    expect(p.itens.reduce((s, i) => s + (i.frete ?? 0), 0)).toBeCloseTo(5)
    // 10,00 + 0,005 (meio centavo, arredonda para 0,01) + 5,00 de frete = 15,01
    expect(p.pagamentos[0].valor).toBe(15.01)
  })

  it('forma "outros" pede descricao_pagamento', () => {
    const sem = interpretarPlanilhaNfe([CAB, linha({ ...base, forma_pagamento: 'outros' })])
    expect(sem.ok && sem.problemas.map((p) => p.mensagem)).toEqual(['forma de pagamento "outros" (99) pede a coluna descricao_pagamento'])
    const com = interpretarPlanilhaNfe([CAB, linha({ ...base, forma_pagamento: 'outros', descricao_pagamento: 'Permuta' })])
    expect(com.ok && com.notas[0].pedido.pagamentos[0]).toMatchObject({ forma: '99', descricao: 'Permuta' })
  })
})

describe('planilha depois da conferência das correções', () => {
  const CAB = ['cnpj_emitente', 'nota', 'cpf_cnpj_destinatario', 'nome_destinatario', 'cep', 'logradouro', 'numero', 'bairro', 'municipio_ibge', 'uf', 'codigo_produto', 'descricao_produto', 'ncm', 'cfop', 'unidade', 'quantidade', 'valor_unitario', 'csosn']
  const linha = (o: Record<string, unknown>) => CAB.map((c) => (c in o ? o[c] : '')) as (string | number)[]
  const base = { cnpj_emitente: '12.345.678/0001-95', nota: '1', cpf_cnpj_destinatario: '11.222.333/0001-81', nome_destinatario: 'Padaria Ltda', cep: '01310-100', logradouro: 'Av. Paulista', numero: '1', bairro: 'Bela Vista', municipio_ibge: '3550308', uf: 'SP', codigo_produto: 'P1', descricao_produto: 'Farinha', ncm: '1101.00.10', cfop: '5102', unidade: 'UN', quantidade: '1', valor_unitario: '10,00', csosn: '102' }

  it('preço numérico do .xlsx (19,99; 1,13; 4,56) é aceito', () => {
    for (const v of [19.99, 1.13, 4.56, 1234.57]) {
      const r = interpretarPlanilhaNfe([CAB, linha({ ...base, valor_unitario: v })])
      expect(r.ok && r.problemas).toEqual([])
    }
    expect(lerNumero(1.23456, 4)).toBeNull()
  })

  it('CSV com vírgulas finais no cabeçalho e nas linhas (como o Excel exporta) passa', () => {
    const r = interpretarPlanilhaNfe([[...CAB, '', ''], [...linha(base), '', '']], { contarCampos: true })
    expect(r.ok && r.problemas).toEqual([])
    expect(r.ok && r.notas).toHaveLength(1)
  })

  it('mesmo dado escrito de outro jeito em outra linha não recusa a nota (CEP com e sem hífen, caixa do nome)', () => {
    const r = interpretarPlanilhaNfe([CAB, linha(base), linha({ ...base, codigo_produto: 'P2', cep: '01310100', nome_destinatario: 'PADARIA LTDA.' })])
    expect(r.ok && r.problemas).toEqual([])
  })
})

describe('planilha: transporte e volumes (23/11/2026)', () => {
  const CAB = ['cnpj_emitente', 'nota', 'cpf_cnpj_destinatario', 'nome_destinatario', 'cep', 'logradouro', 'numero', 'bairro', 'municipio_ibge', 'uf', 'codigo_produto', 'descricao_produto', 'ncm', 'cfop', 'unidade', 'quantidade', 'valor_unitario', 'csosn', 'modalidade_frete', 'transportador_cpf_cnpj', 'transportador_nome', 'transportador_ie', 'transportador_uf', 'volumes_quantidade', 'volumes_especie', 'peso_liquido', 'peso_bruto']
  const linha = (o: Record<string, unknown>) => CAB.map((c) => (c in o ? o[c] : '')) as (string | number)[]
  const base = { cnpj_emitente: '12.345.678/0001-95', nota: '1', cpf_cnpj_destinatario: '11.222.333/0001-81', nome_destinatario: 'Padaria Ltda', cep: '01310-100', logradouro: 'Av. Paulista', numero: '1', bairro: 'Bela Vista', municipio_ibge: '3550308', uf: 'SP', codigo_produto: 'P1', descricao_produto: 'Farinha', ncm: '1101.00.10', cfop: '5102', unidade: 'UN', quantidade: '1', valor_unitario: '10,00', csosn: '102' }
  const transp = { modalidade_frete: 'FOB', transportador_cpf_cnpj: '11444777000161', transportador_nome: 'Transp Ltda', transportador_uf: 'sp', volumes_quantidade: '3', volumes_especie: 'CAIXA', peso_liquido: '12,5', peso_bruto: '13,125' }

  it('campos da nota repetidos iguais passam; numa linha só também; modalidade pelo nome', () => {
    const r = interpretarPlanilhaNfe([CAB, linha({ ...base, ...transp }), linha({ ...base, ...transp, codigo_produto: 'P2', transportador_cpf_cnpj: '11.444.777/0001-61', peso_bruto: 13.125 })])
    expect(r.ok && r.problemas).toEqual([])
    expect(r.ok && r.notas[0].pedido).toMatchObject({
      modalidadeFrete: '1',
      transportador: { documento: '11444777000161', nome: 'Transp Ltda', uf: 'SP' },
      volumes: [{ quantidade: 3, especie: 'CAIXA', pesoLiquido: 12.5, pesoBruto: 13.125 }],
    })
    const so = interpretarPlanilhaNfe([CAB, linha({ ...base, codigo_produto: 'P0' }), linha({ ...base, ...transp })])
    expect(so.ok && so.notas[0].pedido.volumes).toHaveLength(1)
  })

  it('campos de transporte divergentes entre linhas da mesma nota recusam a nota', () => {
    const r = interpretarPlanilhaNfe([CAB, linha({ ...base, ...transp }), linha({ ...base, ...transp, codigo_produto: 'P2', transportador_nome: 'Outra Transp', peso_bruto: '14' })])
    expect(r.ok && r.notas).toEqual([])
    expect(r.ok && r.problemas.map((p) => p.mensagem)).toEqual([
      'linha 3: "transportador_nome" diferente da linha 2',
      'linha 3: "peso_bruto" diferente da linha 2',
    ])
  })

  it('valores inválidos: modalidade, documento, quantidade, peso; transportador sem modalidade', () => {
    const r = interpretarPlanilhaNfe([CAB, linha({ ...base, ...transp, modalidade_frete: 'avião', transportador_cpf_cnpj: '11444777000162', volumes_quantidade: '2,5', peso_liquido: '1,2345' })])
    expect(r.ok && r.problemas.map((p) => p.mensagem)).toEqual([
      'CPF ou CNPJ do transportador inválido',
      'volumes_quantidade (número inteiro) inválido (2,5)',
      'peso_liquido (kg, até 3 casas) inválido (1,2345)',
      'modalidade_frete "avião" desconhecida (use 0 emitente/CIF, 1 destinatário/FOB, 2 terceiros, 3 próprio remetente, 4 próprio destinatário ou 9 sem frete)',
    ])
    const sem = interpretarPlanilhaNfe([CAB, linha({ ...base, transportador_nome: 'Transp Ltda' })])
    expect(sem.ok && sem.problemas.map((p) => p.mensagem)).toEqual([
      'com transportador, preencha modalidade_frete (0 emitente/CIF, 1 destinatário/FOB, 2 terceiros, 3 próprio remetente, 4 próprio destinatário)',
    ])
  })

  it('peso bruto menor que o líquido: a nota passa com aviso', () => {
    const r = interpretarPlanilhaNfe([CAB, linha({ ...base, ...transp, peso_bruto: '10' })])
    expect(r.ok && r.problemas).toEqual([])
    expect(r.ok && r.notas[0].avisos).toEqual(['volumes: peso bruto (10 kg) menor que o peso líquido (12,5 kg); confira'])
  })

  it('só volumes, sem transportador nem modalidade: modFrete segue o frete (9 sem frete)', () => {
    const r = interpretarPlanilhaNfe([CAB, linha({ ...base, volumes_quantidade: '1', volumes_especie: 'FARDO' })])
    expect(r.ok && r.problemas).toEqual([])
    expect(r.ok && r.notas[0].pedido).toMatchObject({ modalidadeFrete: '9', volumes: [{ quantidade: 1, especie: 'FARDO' }] })
    expect(r.ok && Object.keys(r.notas[0].pedido)).not.toContain('transportador')
  })
})
