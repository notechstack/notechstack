// NF-e avulsa pelo WhatsApp (Lucca, 23/11/2026): a conversa guiada no banco local, com WhatsApp, IA e Receita de
// dublê; a NF-e sai pela mesma fila do painel (origem 'whatsapp') e o DANFE volta a quem pediu quando a Sefaz autoriza.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  canaisDouble,
  createEscritorio,
  dropEscritorio,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDeTexto,
  openRoleDb,
  type Escritorio,
} from '../../_tests/agente-fixtures.js'
import { makeTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { aprovarConferencia, sefazQueAprova } from '../nfe/nfe-fixtures.js'
import { processarNfes, salvarDadosNfe, type PedidoNfe } from '../nfe/servico.js'
import { processarMensagem, type ConsultaCnpj } from './conversa.js'
import {
  avisarNfeDoWhatsApp,
  ehPedidoDeNfe,
  lerEndereco,
  lerLinhaDeItem,
  lerPagamento,
  lerProdutoNovo,
  lerTransporte,
  pedidoDoEstado,
  TEXTOS_NFE,
} from './nfe-conversa.js'

const IE = '222333444555'
const CNPJ_EMPRESA = '12345678000195'

describe('leitura das respostas (sem banco)', () => {
  const produtos = [{ codigo: 'EMB-4030', descricao: 'Caixa 40x30x20', ncm: '48191000', cfop: '5101', unidade: 'UN', valorUnitario: 2.45, origem: '0', csosn: '101' as const, aliquotaCreditoSN: 2.56 }]

  it('"nfe" começa; "nfe 123" e "nfe Maria" são a consulta do DANFE', () => {
    for (const t of ['nfe', 'NF-e', 'emitir nfe', 'quero emitir uma nfe', 'nova nfe', 'nota de produto', 'nota fiscal eletrônica']) expect(ehPedidoDeNfe(t), t).toBe(true)
    for (const t of ['nfe 123', 'nfe Maria', 'nota pra Maria 350', 'nota 12']) expect(ehPedidoDeNfe(t), t).toBe(false)
  })

  it('linha de item: número ou código, quantidade, preço e desconto opcionais; produto desconhecido não é inventado', () => {
    expect(lerLinhaDeItem('1 500 desconto 61,25', produtos)).toEqual({ item: expect.objectContaining({ codigo: 'EMB-4030', quantidade: 500, valorUnitario: 2.45, desconto: 61.25, cfop: '5101', csosn: '101' }) })
    expect(lerLinhaDeItem('emb-4030 x 10 preço 2,40', produtos)).toEqual({ item: expect.objectContaining({ quantidade: 10, valorUnitario: 2.4, desconto: null }) })
    expect(lerLinhaDeItem('XYZ 10', produtos)).toEqual({ erro: expect.stringContaining('Para produto novo, mande *novo*') })
    expect(lerLinhaDeItem('1 abc', produtos)).toEqual({ erro: expect.stringContaining('mande o número') })
  })

  it('produto novo: todos os campos escritos; CSOSN 101 pede a alíquota; NCM e CFOP conferidos', () => {
    expect(lerProdutoNovo('EMB-50; Caixa 50x40x30; 4819.10.00; 5101; 101; UN; 200; 3,10; 2,56')).toEqual({
      item: { codigo: 'EMB-50', descricao: 'Caixa 50x40x30', ncm: '48191000', cfop: '5101', csosn: '101', unidade: 'UN', quantidade: 200, valorUnitario: 3.1, origem: '0', aliquotaCreditoSN: 2.56 },
    })
    expect(lerProdutoNovo('EMB-50; Caixa; 4819.10.00; 5101; 101; UN; 200; 3,10')).toEqual({ erro: expect.stringContaining('alíquota do crédito') })
    expect(lerProdutoNovo('EMB-50; Caixa; 4819; 5101; 102; UN; 200; 3,10')).toEqual({ erro: 'NCM "4819" precisa de 8 dígitos.' })
    expect(lerProdutoNovo('EMB-50; Caixa; 48191000; 1102; 102; UN; 200; 3,10')).toEqual({ erro: expect.stringContaining('CFOP') })
    expect(lerProdutoNovo('EMB-50; Caixa; 48191000')).toEqual({ erro: expect.stringContaining('Faltou campo') })
  })

  it('pagamento, endereço e transporte', () => {
    expect(lerPagamento('Boleto')).toEqual({ forma: '15', descricao: null })
    expect(lerPagamento('cartão de crédito')).toEqual({ forma: '03', descricao: null })
    expect(lerPagamento('outros: permuta')).toEqual({ forma: '99', descricao: 'permuta' })
    expect(lerPagamento('outros')).toBeNull()
    expect(lerEndereco('Rua das Flores, 100, Jardim, Centro, 12900-000, Bragança Paulista/SP')).toEqual({
      endereco: { logradouro: 'Rua das Flores', numero: '100', complemento: null, bairro: 'Jardim, Centro', codigoMunicipio: '3507605', uf: 'SP', cep: '12900000' },
    })
    expect(lerEndereco('Rua A, 1, Centro, 123, Campinas/SP')).toEqual({ erro: 'O CEP "123" precisa de 8 dígitos.' })
    const t = lerTransporte('frete 25,00; FOB; transportadora 1; 10 caixas; peso 60,4; marca EXEMPLO; numeração 1 a 10', [{ documento: '11444777000161', nome: 'Transp' }])
    expect(t).toEqual({
      frete: 25,
      modalidade: '1',
      transportador: { documento: '11444777000161', nome: 'Transp' },
      volume: { quantidade: 10, especie: 'CAIXAS', pesoLiquido: 60.4, pesoBruto: 60.4, marca: 'EXEMPLO', numeracao: '1 a 10' },
    })
    expect(lerTransporte('por conta do emitente; peso liquido 60; peso bruto 61,5', [])).toEqual({ modalidade: '0', volume: { pesoLiquido: 60, pesoBruto: 61.5 } })
    expect(lerTransporte('de avião', [])).toEqual({ erro: 'Não entendi "de avião".' })
  })

  it('o pedido do estado: pagamento no valor da nota, frete rateado, só os grupos preenchidos', () => {
    const dest = { documento: '11222333000181', nome: 'X', indicadorIE: '9' as const, endereco: { logradouro: 'R', numero: '1', bairro: 'B', codigoMunicipio: '3550308', uf: 'SP' as const, cep: '01001000' } }
    const p = pedidoDoEstado({ passo: 'confirmar', destinatario: dest, itens: [{ ...produtos[0], quantidade: 500, desconto: 61.25 }], forma: '15', frete: 25 })
    expect(p.pagamentos).toEqual([{ forma: '15', valor: 1188.75, descricao: null }])
    expect(p.itens[0].frete).toBe(25)
    expect(Object.keys(p)).not.toContain('transportador')
  })
})

describe('conversa no WhatsApp (banco local)', () => {
  const admin = openTestDb()
  const servico = openRoleDb('nofiscal_service')
  let esc: Escritorio
  let empresa: string
  const receita: ConsultaCnpj = {
    async razaoSocial(cnpj) {
      return cnpj === '11444777000161' ? 'Transportadora Exemplo Ltda' : null
    },
    async endereco(cnpj) {
      return cnpj === '11444777000161' ? { cMun: '3504107', cep: '12940000', logradouro: 'Rua das Cargas', numero: '50', bairro: 'Distrito Industrial' } : null
    },
  }

  beforeAll(async () => {
    await allowTestUserToAssume(admin.db, 'nofiscal_service')
    esc = await createEscritorio(admin.db, { empresas: [{ razaoSocial: 'Embalagens Exemplo Ltda' }] })
    empresa = esc.empresas[0].id
    await admin.db.query(`update nofiscal.fiscal_tenants set tipos_nota = array['nfse','nfe'] where id = $1`, [esc.mae.tenant.id])
    await admin.db.query(`update nofiscal.fiscal_tenants set cnpj = $2, codigo_municipio_ibge = '3504107' where id = $1`, [empresa, CNPJ_EMPRESA.replace(/^1234/, String(1000 + Math.floor(Math.random() * 8999)))])
    const { rows } = await admin.db.query<{ cnpj: string }>('select cnpj from nofiscal.fiscal_tenants where id = $1', [empresa])
    // CNPJ com dígitos válidos para o certificado de teste e o builder.
    const base = rows[0].cnpj.slice(0, 12)
    const dv = (s: string) => {
      const pesos = s.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      const r = [...s].reduce((t, c, i) => t + Number(c) * pesos[i], 0) % 11
      return r < 2 ? '0' : String(11 - r)
    }
    const cnpj = base + dv(base) + dv(base + dv(base))
    await admin.db.query('update nofiscal.fiscal_tenants set cnpj = $2 where id = $1', [empresa, cnpj])
    const cert = makeTestCertificate({ commonName: `EMBALAGENS EXEMPLO LTDA:${cnpj}` })
    await admin.db.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [empresa, cert.certificado.pfxBase64, cert.certificado.password, 'CN=x', new Date(Date.now() + 86400_000 * 365)])
    await salvarDadosNfe(servico.db, empresa, { inscricaoEstadual: IE, endereco: { logradouro: 'Rua A', numero: '1', bairro: 'Centro', cep: '12940000', uf: 'SP' }, serie: 1, proximoNumero: 10 })
    await aprovarConferencia(servico.db, empresa, IE)
    // Uma NF-e anterior da empresa: o cliente e o produto que a conversa reaproveita.
    const anterior: PedidoNfe = {
      destinatario: { documento: '11222333000181', nome: 'Comercio de Embalagens Exemplo Ltda', indicadorIE: '1', inscricaoEstadual: '110042490114', endereco: { logradouro: 'Rua Barao de Jaguara', numero: '900', bairro: 'Centro', codigoMunicipio: '3509502', uf: 'SP', cep: '13015000' } },
      itens: [{ codigo: 'EMB-4030', descricao: 'Caixa de papelao 40x30x20', ncm: '48191000', cfop: '5101', unidade: 'UN', quantidade: 1, valorUnitario: 2.45, origem: '0', csosn: '101', aliquotaCreditoSN: 2.56 }],
      pagamentos: [{ forma: '15', valor: 2.45 }],
    }
    await admin.db.query(
      `insert into nofiscal.fiscal_nfe (tenant_id, external_id, origem, status, ambiente, payload, serie, numero, valor_total, destinatario_documento, destinatario_nome)
       values ($1, 'teste-anterior', 'painel', 'authorized', 'homologacao', $2::jsonb, 1, 9, 2.45, '11222333000181', 'Comercio de Embalagens Exemplo Ltda')`,
      [empresa, JSON.stringify(anterior)],
    )
  })

  afterAll(async () => {
    for (const t of [esc.mae.tenant.id, empresa]) {
      await admin.db.query('delete from nofiscal.fiscal_nfe_eventos where tenant_id = $1', [t])
      await admin.db.query('delete from nofiscal.fiscal_nfe where tenant_id = $1', [t])
      await admin.db.query('delete from nofiscal.fiscal_nfe_conferencias where tenant_id = $1', [t])
      await admin.db.query('delete from nofiscal.fiscal_nfe_series where tenant_id = $1', [t])
    }
    await dropEscritorio(admin.db, esc)
    await servico.pool.end()
    await admin.pool.end()
  })

  function agente() {
    const canais = canaisDouble()
    const deps = { db: servico.db, whatsapp: canais.whatsapp, email: canais.email, interprete: interpreteDouble({}).interprete, links: LINKS_DE_TESTE, consultaCnpj: receita, now: () => new Date('2026-11-23T13:00:00Z') }
    return {
      canais,
      async diz(texto: string): Promise<string> {
        const antes = canais.whatsapps.length
        await processarMensagem(deps, mensagemDeTexto(esc.mae.ownerPhone, texto))
        return canais.whatsapps.slice(antes).map((m) => m.texto).join('\n---\n')
      },
    }
  }

  it('cliente e produto das notas anteriores, transporte pelo CNPJ da Receita, confirmar, e o DANFE volta quando a Sefaz autoriza', async () => {
    const a = agente()
    expect(await a.diz('emitir nfe')).toMatch(/Por qual empresa sai a NF-e\?[\s\S]*Embalagens Exemplo Ltda/)
    expect(await a.diz('Embalagens')).toMatch(/1\. Comercio de Embalagens Exemplo Ltda · 11\.222\.333\/0001-81/)
    const produtos = await a.diz('1')
    expect(produtos).toMatch(/1\. EMB-4030 · Caixa de papelao 40x30x20 · R\$ 2,45\/UN · NCM 48191000 · CFOP 5101 · CSOSN 101/)
    expect(await a.diz('1 500 desconto 61,25')).toMatch(/Anotei:[\s\S]*EMB-4030[\s\S]*500 UN × R\$ 2,45 \(desconto R\$ 61,25\)/)
    expect(await a.diz('pronto')).toBe(TEXTOS_NFE.pagamento)
    expect(await a.diz('boleto')).toBe(TEXTOS_NFE.transporte)
    expect(await a.diz('por conta do emitente; transportadora 11.444.777/0001-61; 10 caixas; peso 60,4')).toBe(TEXTOS_NFE.info)
    const resumo = await a.diz('Documento emitido por ME ou EPP optante pelo Simples Nacional.')
    expect(resumo).toContain('*Total: R$ 1.163,75* · boleto')
    expect(resumo).toContain('Frete por conta: Por conta do emitente (CIF)')
    expect(resumo).toContain('Transportadora: Transportadora Exemplo Ltda · 11.444.777/0001-61')
    expect(resumo).toContain('Volumes: 10 CAIXAS · líquido 60,4 kg · bruto 60,4 kg')
    expect(resumo).toContain('CSOSN 101 (crédito 2,56%)')
    expect(resumo.endsWith(TEXTOS_NFE.pergunta)).toBe(true)

    expect(await a.diz('confirmar')).toBe('NF-e nº 10 (série 1) enviada à Sefaz. Quando for autorizada, mando o DANFE aqui.')
    const { rows } = await admin.db.query<{ id: string; origem: string; valor_total: string; payload: PedidoNfe }>(
      `select id, origem, valor_total, payload from nofiscal.fiscal_nfe where tenant_id = $1 and numero = 10`,
      [empresa],
    )
    expect(rows[0]).toMatchObject({ origem: 'whatsapp', valor_total: '1163.75' })
    expect(rows[0].payload).toMatchObject({
      modalidadeFrete: '0',
      transportador: { documento: '11444777000161', nome: 'Transportadora Exemplo Ltda', municipio: 'Atibaia', uf: 'SP' },
      volumes: [{ quantidade: 10, especie: 'CAIXAS', pesoLiquido: 60.4, pesoBruto: 60.4 }],
      pagamentos: [{ forma: '15', valor: 1163.75 }],
    })
    // "confirmar" de novo não emite outra nota.
    await a.diz('confirmar')
    expect((await admin.db.query('select 1 from nofiscal.fiscal_nfe where tenant_id = $1', [empresa])).rowCount).toBe(2)

    const avisos = canaisDouble()
    await processarNfes({
      db: servico.db,
      sefaz: sefazQueAprova(IE),
      now: () => new Date('2026-11-23T13:01:00Z'),
      tenantId: empresa,
      onFinal: async (id, status) => {
        await avisarNfeDoWhatsApp(servico.db, avisos.whatsapp, id, status)
      },
    })
    expect(avisos.whatsapps).toHaveLength(1)
    expect(avisos.whatsapps[0]).toMatchObject({ para: esc.mae.ownerPhone, anexo: { nome: 'danfe-10.pdf', tipo: 'application/pdf' } })
    expect(avisos.whatsapps[0].texto).toMatch(/^NF-e 10 autorizada · Comercio de Embalagens Exemplo Ltda · R\$ 1\.163,75\nChave: /)
  })

  it('cliente novo com CPF em outro estado, produto novo, CFOP perguntado (nunca trocado) e descartar', async () => {
    const a = agente()
    await a.diz('nfe')
    await a.diz('2')
    expect(await a.diz('529.982.247-25')).toBe('Cliente novo. Qual o nome (ou razão social)?')
    expect(await a.diz('Maria Exemplo da Silva')).toBe(TEXTOS_NFE.endereco)
    const produtos = await a.diz('Rua da Bahia, 500, Centro, 30130-000, Belo Horizonte/MG')
    expect(produtos).toMatch(/Cliente: Maria Exemplo da Silva\. Agora os produtos\./)
    expect(await a.diz('novo')).toBe(TEXTOS_NFE.produtoNovo)
    expect(await a.diz('EMB-50; Caixa 50x40x30; 4819.10.00; 6101; 102; un; 2; 3,10')).toMatch(/Anotei \(origem nacional[\s\S]*EMB-50/)
    expect(await a.diz('1 3')).toMatch(/EMB-4030[\s\S]*EMB-50|EMB-50[\s\S]*EMB-4030/)
    expect(await a.diz('pronto')).toBe('O CFOP do EMB-4030 é 5101, de dentro do estado; esta nota vai para MG. Qual CFOP uso? (começa com 6)')
    expect(await a.diz('5102')).toMatch(/começando com 6/)
    expect(await a.diz('6101')).toBe(TEXTOS_NFE.pagamento)
    expect(await a.diz('pix')).toBe(TEXTOS_NFE.transporte)
    expect(await a.diz('não')).toBe(TEXTOS_NFE.info)
    const resumo = await a.diz('não')
    expect(resumo).toContain('Cliente: Maria Exemplo da Silva · 529.982.247-25')
    expect(resumo).toContain('Rua da Bahia, 500, Centro, Belo Horizonte/MG')
    expect(resumo).toContain('CFOP 6101')
    expect(await a.diz('corrigir')).toBe(TEXTOS_NFE.corrigir)
    expect(await a.diz('pagamento')).toBe(TEXTOS_NFE.pagamento)
    expect(await a.diz('dinheiro')).toMatch(/\*Total: R\$ 13,55\* · dinheiro/)
    expect(await a.diz('descartar')).toBe(TEXTOS_NFE.descartada)
    expect((await admin.db.query('select 1 from nofiscal.fiscal_nfe where tenant_id = $1', [empresa])).rowCount).toBe(2)
  })

  it('conta sem a NF-e no plano: avisa e não abre pedido', async () => {
    await admin.db.query(`update nofiscal.fiscal_tenants set tipos_nota = array['nfse'] where id = $1`, [esc.mae.tenant.id])
    try {
      expect(await agente().diz('nfe')).toBe(TEXTOS_NFE.semPlano)
    } finally {
      await admin.db.query(`update nofiscal.fiscal_tenants set tipos_nota = array['nfse','nfe'] where id = $1`, [esc.mae.tenant.id])
    }
  })
})
