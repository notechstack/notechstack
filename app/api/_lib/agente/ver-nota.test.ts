// "nota 123" e "nota Maria" no WhatsApp (Lucca, 05/11/2026): o PDF de uma nota emitida, lido por código. A conta Pro
// só vê as próprias notas; a conta-mãe de um escritório vê as das empresas dela e não as de outra conta. Notas emitidas
// de verdade pelo worker, com o dublê da Sefin (nNFSe no XML), no banco local; WhatsApp, e-mail e IA são dublês.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createEscritorio,
  createSelfServiceTenant,
  dropEscritorio,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDeTexto,
  openRoleDb,
  rodarWorker,
  type Escritorio,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { sharedTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { fakeSefin } from '../../_tests/sefin-fake.js'
import { createSefinClient } from '../sefin-client.js'
import { processarMensagem, TEXTOS } from './conversa.js'
import { formatarDocumento } from './documentos.js'
import { MODELO_DA_PLANILHA } from './planos.js'
import { lerPedidoDeNota } from './ver-nota.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const avulsos: SelfServiceTenant[] = []
const escritorios: Escritorio[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const e of escritorios) await dropEscritorio(admin.db, e)
  for (const s of avulsos) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

const CPF = '52998224725'

/** Emite as notas pelo worker (uma Sefin de dublê por tenant: a numeração começa em 1 em cada um). */
async function emitir(tenantId: string, tomadores: { nome: string; valor: string }[]): Promise<void> {
  for (const t of tomadores) {
    await admin.db.query(`insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload) values ($1, $2, $3::jsonb)`, [
      tenantId,
      `teste-${randomBytes(6).toString('hex')}`,
      JSON.stringify({ tomador: { cpf: CPF, nome: t.nome }, servico: { codigo_servico_nacional: '010701', descricao: 'Consultoria' }, valor: t.valor }),
    ])
    // Uma por rodada, para a numeração seguir a ordem da lista.
    await rodarWorker(servico.db, { sefin: sefins.get(tenantId) ?? novaSefin(tenantId), tenantId, canais: canaisDouble(), now: () => new Date() })
  }
}
const sefins = new Map<string, ReturnType<typeof createSefinClient>>()
const novaSefin = (tenantId: string) => {
  const sefin = createSefinClient({ transport: fakeSefin().transport })
  sefins.set(tenantId, sefin)
  return sefin
}

function agente() {
  const canais = canaisDouble()
  const ia = interpreteDouble({ 'oi, tudo bem?': { intencao: 'outro' } })
  const deps = { db: servico.db, whatsapp: canais.whatsapp, email: canais.email, interprete: ia.interprete, links: LINKS_DE_TESTE }
  return {
    canais,
    ia,
    async texto(de: string, texto: string) {
      const antes = canais.whatsapps.length
      await processarMensagem(deps, mensagemDeTexto(de, texto))
      return canais.whatsapps.slice(antes)
    },
  }
}

const ehPdf = (m: { anexo?: { conteudo: Uint8Array; tipo: string } }) =>
  m.anexo?.tipo === 'application/pdf' && Buffer.from(m.anexo.conteudo.subarray(0, 5)).toString('latin1') === '%PDF-'

async function entregasDe(tenantId: string) {
  const { rows } = await admin.db.query<{ canal: string; papel: string; destino: string; status: string }>(
    `select e.canal, e.papel, e.destino, e.status from nofiscal.fiscal_invoice_entregas e
       join nofiscal.fiscal_invoices i on i.id = e.invoice_id
      where i.tenant_id = $1 and e.canal = 'whatsapp' order by e.created_at`,
    [tenantId],
  )
  return rows
}

describe('lerPedidoDeNota', () => {
  it('"nota 123", "pdf nº 123", "nota 123 <empresa>" e "nota <nome>"; o resto segue para os pedidos', () => {
    expect(lerPedidoDeNota('nota 123')).toEqual({ tipo: 'numero', numero: '123', empresa: null })
    expect(lerPedidoDeNota('Nota  0123.')).toEqual({ tipo: 'numero', numero: '123', empresa: null })
    expect(lerPedidoDeNota('PDF nº 45')).toEqual({ tipo: 'numero', numero: '45', empresa: null })
    expect(lerPedidoDeNota('nota 7 12.345.678/0001-95')).toEqual({ tipo: 'numero', numero: '7', empresa: '12.345.678/0001-95' })
    expect(lerPedidoDeNota('nota Maria Silva')).toEqual({ tipo: 'nome', nome: 'Maria Silva' })
    expect(lerPedidoDeNota('NÓTA maria')).toEqual({ tipo: 'nome', nome: 'maria' })
    expect(lerPedidoDeNota('notas 12')).toBeNull()
    // Pedidos de emissão não viram busca.
    expect(lerPedidoDeNota('nota pra Studio Lima, 350 reais')).toBeNull()
    expect(lerPedidoDeNota('nota para a Maria')).toBeNull()
    expect(lerPedidoDeNota('nota Studio Lima 350')).toBeNull()
    expect(lerPedidoDeNota('nota fiscal')).toBeNull()
    expect(lerPedidoDeNota('cancela a nota 12')).toBeNull()
  })
})

describe('ver uma nota pelo WhatsApp', () => {
  it('conta Pro: por número e por nome, só as próprias notas', async () => {
    const certificado = sharedTestCertificate().certificado
    const pro = await createSelfServiceTenant(admin.db, { plan: 'pro', certificado })
    const outra = await createSelfServiceTenant(admin.db, { plan: 'pro', certificado })
    avulsos.push(pro, outra)
    await assinarTenant(admin.db, pro.tenant.id, { status: 'paga' })
    await assinarTenant(admin.db, outra.tenant.id, { status: 'paga' })
    await emitir(pro.tenant.id, [
      { nome: 'Maria Silva', valor: '100.00' },
      { nome: 'Maria Souza', valor: '50.00' },
      { nome: 'João Pereira', valor: '70.00' },
    ])
    await emitir(outra.tenant.id, [{ nome: 'Maria Silva Outra Conta', valor: '999.00' }, { nome: 'Zélia', valor: '10.00' }])
    const a = agente()

    // Número único: o PDF, com a linha da nota na legenda, e a entrega registrada.
    const [n1] = await a.texto(pro.ownerPhone, 'nota 1')
    expect(ehPdf(n1)).toBe(true)
    expect(n1.texto).toBe('Nota 1 · Maria Silva · R$ 100,00')
    expect(n1.anexo?.nome).toBe('nfse-1.pdf')
    expect(await entregasDe(pro.tenant.id)).toContainEqual({ canal: 'whatsapp', papel: 'dono', destino: pro.ownerPhone, status: 'enviado' })

    // Número inexistente: não é busca, segue para os pedidos ("nota 99" = pedido de R$ 99), sem PDF.
    expect((await a.texto(pro.ownerPhone, 'nota 99')).some(ehPdf)).toBe(false)

    // Por nome: um resultado → PDF; vários → lista; nenhum → aviso. A nota da outra conta não aparece.
    const [silva] = await a.texto(pro.ownerPhone, 'nota maria silva')
    expect(ehPdf(silva)).toBe(true)
    expect(silva.texto).toBe('Nota 1 · Maria Silva · R$ 100,00')
    const [lista] = await a.texto(pro.ownerPhone, 'nota Maria')
    expect(lista.anexo).toBeUndefined()
    const linhas = lista.texto.split('\n')
    expect(linhas[0]).toBe('Achei 2 notas para Maria nos últimos 2 meses:')
    expect(linhas.slice(1, 3).sort()).toEqual([
      expect.stringMatching(/^- nº 1 · \d{2}\/\d{2}\/\d{4} · Maria Silva · R\$ 100,00$/),
      expect.stringMatching(/^- nº 2 · \d{2}\/\d{2}\/\d{4} · Maria Souza · R\$ 50,00$/),
    ])
    expect(linhas.at(-1)).toMatch(/^Me mande \*nota\* e o número para receber o PDF/)
    // Nome sem nota: segue para os pedidos ("nota Zélia" = pedido para a Zélia), sem PDF.
    expect((await a.texto(pro.ownerPhone, 'nota Zélia')).some(ehPdf)).toBe(false)
    // Sem acento também acha ("joao" → "João").
    expect((await a.texto(pro.ownerPhone, 'pdf joao'))[0].texto).toBe('Nota 3 · João Pereira · R$ 70,00')

    // A outra conta, com o mesmo número 1, vê a dela.
    expect((await a.texto(outra.ownerPhone, 'nota 1'))[0].texto).toBe('Nota 1 · Maria Silva Outra Conta · R$ 999,00')
    // Só os dois sem resultado passaram pela IA (viraram pedido); as buscas que acharam, não.
    expect(a.ia.chamadas).toHaveLength(2)
  })

  it('escritório: vê as notas das empresas dele, pergunta a empresa no número repetido, e não vê as de outra conta', async () => {
    const certificado = sharedTestCertificate().certificado
    const e = await createEscritorio(admin.db, { certificado, empresas: [{ certificado, razaoSocial: 'Padaria Cliente Ltda' }] })
    escritorios.push(e)
    const [cliente] = e.empresas
    const fora = await createSelfServiceTenant(admin.db, { plan: 'pro', certificado })
    avulsos.push(fora)
    await assinarTenant(admin.db, fora.tenant.id, { status: 'paga' })
    await emitir(e.mae.tenant.id, [{ nome: 'Honorários Cliente A', valor: '300.00' }])
    await emitir(cliente.id, [{ nome: 'Freguês da Padaria', valor: '45.00' }])
    await emitir(fora.tenant.id, [{ nome: 'Cliente de Outra Conta', valor: '80.00' }])
    const a = agente()

    // A nota nº 1 existe nas duas empresas do escritório: lista e pede a empresa.
    const [ambigua] = await a.texto(e.mae.ownerPhone, 'nota 1')
    expect(ambigua.anexo).toBeUndefined()
    expect(ambigua.texto).toContain('Achei a nota nº 1 em mais de uma empresa:')
    expect(ambigua.texto).toContain(`- Padaria Cliente Ltda (CNPJ ${formatarDocumento(cliente.cnpj)}) · Freguês da Padaria · R$ 45,00`)
    expect(ambigua.texto).toContain('Honorários Cliente A · R$ 300,00')
    expect(ambigua.texto).not.toContain('Cliente de Outra Conta')
    expect(ambigua.texto).toMatch(/Me mande o número com o CNPJ ou o nome da empresa, por exemplo: nota 1 \d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}$/)

    // Com o CNPJ (ou o nome) da empresa: o PDF, nomeando a empresa, e a entrega com papel "escritorio".
    const [porCnpj] = await a.texto(e.mae.ownerPhone, `nota 1 ${formatarDocumento(cliente.cnpj)}`)
    expect(ehPdf(porCnpj)).toBe(true)
    expect(porCnpj.texto).toBe('Nota 1 · Freguês da Padaria · R$ 45,00 · Padaria Cliente Ltda')
    expect(await entregasDe(cliente.id)).toContainEqual({ canal: 'whatsapp', papel: 'escritorio', destino: e.mae.ownerPhone, status: 'enviado' })
    expect((await a.texto(e.mae.ownerPhone, 'nota 1 padaria'))[0].texto).toBe('Nota 1 · Freguês da Padaria · R$ 45,00 · Padaria Cliente Ltda')

    // Por nome, nas empresas do escritório; a nota de outra conta não aparece.
    expect((await a.texto(e.mae.ownerPhone, 'nota freguês'))[0].texto).toBe('Nota 1 · Freguês da Padaria · R$ 45,00 · Padaria Cliente Ltda')
    const alheia = await a.texto(e.mae.ownerPhone, 'nota Cliente de Outra Conta')
    expect(alheia.some(ehPdf)).toBe(false)
    expect(alheia.map((m) => m.texto).join(' ')).not.toContain('R$ 80,00')
    // E a outra conta não vê as do escritório.
    const doEscritorio = await a.texto(fora.ownerPhone, 'nota Freguês')
    expect(doEscritorio.some(ehPdf)).toBe(false)
    expect(doEscritorio.map((m) => m.texto).join(' ')).not.toContain('R$ 45,00')
  })

  it('ajuda: a do escritório cita a planilha e o *nota*; a das outras contas, o *nota*', async () => {
    const e = await createEscritorio(admin.db)
    escritorios.push(e)
    const pro = await createSelfServiceTenant(admin.db, { plan: 'pro' })
    avulsos.push(pro)
    await assinarTenant(admin.db, pro.tenant.id, { status: 'paga' })
    const a = agente()
    const [doEscritorio] = await a.texto(e.mae.ownerPhone, 'oi, tudo bem?')
    expect(doEscritorio.texto).toBe(TEXTOS.ajudaEscritorio)
    expect(doEscritorio.texto).toContain(`mande a planilha aqui (modelo: ${MODELO_DA_PLANILHA})`)
    expect(doEscritorio.texto).toContain('escreva *nota* e o número ou o nome do cliente')
    const [doPro] = await a.texto(pro.ownerPhone, 'oi, tudo bem?')
    expect(doPro.texto).toBe(TEXTOS.ajuda)
    expect(doPro.texto).toContain('escreva *nota* e o número ou o nome do cliente')
    expect(doPro.texto).not.toContain('planilha')
  })
})
