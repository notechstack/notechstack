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
import { interpretarPlanilhaNfe, lerNumero } from './planilha.js'
import { lerCsvTexto } from '../agente/lote.js'
import { criarSefazClient } from './sefaz-client.js'
import { processarNfes } from './servico.js'
import { sefazQueAprova } from './nfe-fixtures.js'

const NS = 'http://www.portalfiscal.inf.br/nfe'
const MODELO = readFileSync(new URL('../../../../agentes/fiscal/dados/modelo-nfe.csv', import.meta.url), 'utf8')
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
  it('o modelo publicado vira 2 notas: a 1 com 2 itens, a 2 interestadual com frete e boleto', () => {
    const r = interpretarPlanilhaNfe(lerCsvTexto(MODELO.trimStart()))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.problemas).toEqual([])
    expect(r.notas.map((n) => [n.nota, n.linhas, n.pedido.itens.length])).toEqual([
      ['1', [2, 3], 2],
      ['2', [4], 1],
    ])
    const [um, dois] = r.notas
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
    linhas[2][2] = '52998224725'
    const r = interpretarPlanilhaNfe(linhas)
    expect(r.ok && r.problemas.map((p) => [p.nota, p.mensagem])).toEqual([['1', 'linha 3: "cpf_cnpj_destinatario" diferente da linha 2']])
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
    expect(await lida.json()).toMatchObject({ notas: [{ nota: '1', itens: 2, valor: '89.56' }, { nota: '2', itens: 1, valor: '224.00' }], problemas: [] })

    const emitida = await chamar(esc.mae.ownerUserId, planilha('planilha_emitir'))
    expect(emitida.status).toBe(202)
    expect(await emitida.json()).toMatchObject({ emitindo: 2 })
    // A mesma planilha de novo não cria notas novas.
    await chamar(esc.mae.ownerUserId, planilha('planilha_emitir'))
    // Nem com o arquivo regravado (bytes diferentes, mesmo conteúdo), nem com a nota 1 corrigida depois de sair.
    const regravada = new FormData()
    regravada.append('acao', 'planilha_emitir')
    regravada.append('arquivo', new File([MODELO.replaceAll('12.345.678/0001-95', cnpjEmitente) + String.fromCharCode(10).repeat(2)], 'nfe-copia.csv', { type: 'text/csv' }))
    const r2 = (await (await chamar(esc.mae.ownerUserId, regravada)).json()) as { emitindo: number; problemas: { nota: string; mensagem: string }[] }
    expect(r2.emitindo).toBe(0)
    expect(r2.problemas.map((p) => p.nota)).toEqual(['1', '2'])
    const corrigida = new FormData()
    corrigida.append('acao', 'planilha_ler')
    corrigida.append('arquivo', new File([MODELO.replaceAll('12.345.678/0001-95', cnpjEmitente).replace('19,90;102;;;pix', '18,90;102;;;pix')], 'nfe-corrigida.csv', { type: 'text/csv' }))
    const r3 = (await (await chamar(esc.mae.ownerUserId, corrigida)).json()) as { notas: unknown[]; problemas: { nota: string; mensagem: string }[] }
    expect(r3.problemas.find((p) => p.nota === '1')?.mensagem).toMatch(/já saiu neste mês \(NF-e nº 501\) com outro conteúdo/)
    const { rows } = await admin.db.query<{ numero: string }>('select numero from nofiscal.fiscal_nfe where tenant_id = $1 order by numero', [esc.empresas[0].id])
    expect(rows.map((r) => r.numero)).toEqual(['501', '502'])

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
    expect(await processarNfes({ db: servico.db, sefaz, now, tenantId: esc.empresas[0].id })).toMatchObject({ autorizadas: 2 })

    const lista = (await (await chamar(esc.mae.ownerUserId, { acao: 'listar' })).json()) as { notas: { nfe_id: string; status: string; numero: number; homologacao: boolean }[] }
    expect(lista.notas.map((n) => [n.numero, n.status, n.homologacao])).toEqual([[502, 'authorized', true], [501, 'authorized', true]])
    const id = lista.notas[1].nfe_id

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
    // Cancelada, a nota 1 pode sair de novo corrigida na planilha (só nota ativa do mês bloqueia).
    const depoisDoCancelamento = (await (await chamar(esc.mae.ownerUserId, corrigida)).json()) as { notas: { nota: string }[]; problemas: { nota: string }[] }
    expect(depoisDoCancelamento.notas.map((x) => x.nota)).toContain('1')
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
