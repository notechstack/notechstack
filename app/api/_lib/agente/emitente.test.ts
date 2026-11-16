// Emitente no pedido por mensagem (conta Escritório; .design/agente-fiscal-emitente-por-mensagem.md, 16/11/2026):
// "nota pela Oficina Trilho pra Clínica Saúde, 450" emite pela empresa cliente; sem a empresa na mensagem, o agente
// pergunta "Por qual empresa sai a nota?"; a IA só lê o nome, o código acha a empresa. Clientes salvos, bloqueio,
// nota e entrega seguem a empresa do pedido. Contas com uma empresa só e contas Pro não mudam. Banco local; IA,
// WhatsApp, e-mail e Sefin são dublês.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  canaisDouble,
  createEscritorio,
  createSelfServiceTenant,
  criarModelo,
  dropEscritorio,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDeTexto,
  notasDoAgente,
  openRoleDb,
  pedidosDo,
  assinarTenant,
  rodarWorker,
  type Escritorio,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { sharedTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { fakeSefin } from '../../_tests/sefin-fake.js'
import { createSefinClient } from '../sefin-client.js'
import { processarMensagem, TEXTOS, type ConversaDeps } from './conversa.js'
import { formatarDocumento } from './documentos.js'
import { empresasDaResposta, empresasQueBatem, perguntaDoEmitente, type EmpresaDaConta } from './emitente.js'
import type { Parsed } from './interprete.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const escritorios: Escritorio[] = []
const avulsos: SelfServiceTenant[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const e of escritorios) await dropEscritorio(admin.db, e)
  for (const s of avulsos) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

// ── a parte pura ────────────────────────────────────────────────────────────────────────

const EMPRESAS: EmpresaDaConta[] = [
  { id: 'mae', cnpj: '12345678000195', razao_social: 'Contábil Aurora Ltda', principal: true },
  { id: 'oficina', cnpj: '11444777000161', razao_social: 'Oficina Trilho Ltda', principal: false },
  { id: 'studio', cnpj: '11222333000181', razao_social: 'Studio Lima', principal: false },
  { id: 'padaria-sol', cnpj: '45723174000110', razao_social: 'Padaria Sol Ltda', principal: false },
  { id: 'padaria-lua', cnpj: '60701190000104', razao_social: 'Padaria Lua Ltda', principal: false },
]
const ids = (lista: EmpresaDaConta[]) => lista.map((e) => e.id)

describe('achar a empresa pelo que a pessoa escreveu', () => {
  it('parte do nome sem acento, CNPJ com ou sem pontuação, prefixos e "escritório"', () => {
    expect(ids(empresasQueBatem(EMPRESAS, 'Oficina Trilho'))).toEqual(['oficina'])
    expect(ids(empresasQueBatem(EMPRESAS, 'pela oficina trilho'))).toEqual(['oficina'])
    expect(ids(empresasQueBatem(EMPRESAS, 'da empresa Studio Lima'))).toEqual(['studio'])
    expect(ids(empresasQueBatem(EMPRESAS, 'STUDIO'))).toEqual(['studio'])
    expect(ids(empresasQueBatem(EMPRESAS, 'contabil aurora'))).toEqual(['mae'])
    expect(ids(empresasQueBatem(EMPRESAS, '11.444.777/0001-61'))).toEqual(['oficina'])
    expect(ids(empresasQueBatem(EMPRESAS, '11222333000181'))).toEqual(['studio'])
    expect(ids(empresasQueBatem(EMPRESAS, 'escritório'))).toEqual(['mae'])
    expect(ids(empresasQueBatem(EMPRESAS, 'pelo escritorio'))).toEqual(['mae'])
    expect(ids(empresasQueBatem(EMPRESAS, 'o próprio escritório'))).toEqual(['mae'])
  })

  it('nome que bate em várias devolve todas; nome inteiro vence o que só contém; sem batida, nada', () => {
    expect(ids(empresasQueBatem(EMPRESAS, 'Padaria'))).toEqual(['padaria-sol', 'padaria-lua'])
    expect(ids(empresasQueBatem(EMPRESAS, 'Padaria Sol Ltda'))).toEqual(['padaria-sol'])
    expect(ids(empresasQueBatem(EMPRESAS, 'Clínica Saúde'))).toEqual([])
    expect(ids(empresasQueBatem(EMPRESAS, 'a'))).toEqual([])
    expect(ids(empresasQueBatem(EMPRESAS, '00.000.000/0000-00'))).toEqual([])
  })

  it('a resposta à pergunta aceita o número da lista mostrada', () => {
    const opcoes = ['mae', 'oficina', 'studio']
    expect(ids(empresasDaResposta(EMPRESAS, opcoes, '2'))).toEqual(['oficina'])
    expect(ids(empresasDaResposta(EMPRESAS, opcoes, 'nº 3.'))).toEqual(['studio'])
    expect(ids(empresasDaResposta(EMPRESAS, opcoes, '9'))).toEqual([])
    expect(ids(empresasDaResposta(EMPRESAS, opcoes, 'studio lima'))).toEqual(['studio'])
    // Sem lista mostrada (conta grande), número solto não escolhe nada.
    expect(ids(empresasDaResposta(EMPRESAS, [], '2'))).toEqual([])
  })

  it('a pergunta lista até 10 empresas, com a do escritório marcada; acima disso, só pede o nome ou o CNPJ', () => {
    const p = perguntaDoEmitente(EMPRESAS.slice(0, 3))
    expect(p.texto).toBe(
      ['Por qual empresa sai a nota? Me mande o número, o nome ou o CNPJ.', '1. Contábil Aurora Ltda (escritório)', '2. Oficina Trilho Ltda', '3. Studio Lima'].join('\n'),
    )
    expect(p.opcoes).toEqual(['mae', 'oficina', 'studio'])

    const muitas = Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, cnpj: '0'.repeat(14), razao_social: `Empresa ${i}`, principal: i === 0 }))
    const grande = perguntaDoEmitente(muitas)
    expect(grande.texto).toBe('Por qual empresa sai a nota? Me mande o nome ou o CNPJ dela.')
    expect(grande.opcoes).toEqual([])
  })
})

// ── a conversa ──────────────────────────────────────────────────────────────────────────

type Roteiro = Record<string, Partial<Parsed> & Record<string, unknown>>

function conversa(roteiro: Roteiro) {
  const canais = canaisDouble()
  const ia = interpreteDouble(roteiro)
  const agora = new Date()
  const deps: ConversaDeps = { db: servico.db, whatsapp: canais.whatsapp, interprete: ia.interprete, links: LINKS_DE_TESTE, now: () => agora }
  return {
    canais,
    ia,
    agora: () => agora,
    enviar: (de: string, texto: string) => processarMensagem(deps, mensagemDeTexto(de, texto)),
    respostasPara: (para: string) => canais.whatsapps.filter((m) => m.para === para).map((m) => m.texto),
    ultimaPara: (para: string) => canais.whatsapps.filter((m) => m.para === para).at(-1)?.texto ?? '',
    mensagensPara: (para: string) => canais.whatsapps.filter((m) => m.para === para),
  }
}

const CLINICA = { nome: 'Clínica Saúde', documento: '52998224725', nomeTomador: 'Clínica Saúde', email: 'financeiro@clinica.test', descricao: 'Consulta de novembro' }
const PELA_OFICINA = 'nota pela Oficina Trilho pra Clínica Saúde, 450'
const SEM_EMPRESA = 'nota pra Clínica Saúde, 450'

/** Escritório com A1 e duas empresas clientes prontas: Oficina Trilho Ltda e Studio Lima. */
async function escritorio(empresas?: Parameters<typeof createEscritorio>[1] extends infer O ? (O extends { empresas?: infer E } ? E : never) : never): Promise<Escritorio> {
  const certificado = sharedTestCertificate().certificado
  const e = await createEscritorio(admin.db, {
    certificado,
    razaoSocial: 'Contábil Aurora Ltda',
    empresas: empresas ?? [
      { certificado, razaoSocial: 'Oficina Trilho Ltda' },
      { certificado, razaoSocial: 'Studio Lima' },
    ],
  })
  escritorios.push(e)
  return e
}

const cnpjDe = async (tenantId: string) =>
  (await admin.db.query<{ cnpj: string }>('select cnpj from nofiscal.fiscal_tenants where id = $1', [tenantId])).rows[0].cnpj

describe('emitente no pedido por mensagem (conta Escritório)', () => {
  it('com a empresa no pedido: resumo com o emitente, nota no tenant da empresa e PDF nomeando a empresa', async () => {
    const e = await escritorio()
    const [oficina, studio] = e.empresas
    await criarModelo(admin.db, oficina.id, CLINICA)
    const c = conversa({ [PELA_OFICINA]: { tomador: 'Clínica Saúde', valor: '450.00', prestador: 'Oficina Trilho', intencao: 'emitir' } })

    await c.enviar(e.mae.ownerPhone, PELA_OFICINA)
    const resumo = c.ultimaPara(e.mae.ownerPhone).split('\n')
    expect(resumo[0]).toBe('Resumo da nota:')
    expect(resumo[1]).toBe(`Emitente: Oficina Trilho Ltda (CNPJ ${formatarDocumento(await cnpjDe(oficina.id))})`)
    expect(resumo[2]).toBe('Tomador: Clínica Saúde')
    expect(resumo.at(-1)).toContain('Posso emitir?')
    // Nada foi perguntado: uma resposta só, e o pedido já nasceu na empresa.
    expect(c.respostasPara(e.mae.ownerPhone)).toHaveLength(1)
    expect(await pedidosDo(admin.db, e.mae.tenant.id)).toHaveLength(0)
    expect(await pedidosDo(admin.db, studio.id)).toHaveLength(0)
    const [pedido] = await pedidosDo(admin.db, oficina.id)
    expect(pedido).toMatchObject({ kind: 'emitir', status: 'awaiting_confirmation', etapa: 'confirmar' })

    await c.enviar(e.mae.ownerPhone, 'confirmar')
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(TEXTOS.emitindo)
    expect(await notasDoAgente(admin.db, e.mae.tenant.id)).toHaveLength(0)
    const [nota] = await notasDoAgente(admin.db, oficina.id)
    expect(nota.status).toBe('queued')
    expect(nota.payload).toEqual({
      tomador: { cpf: '52998224725', nome: 'Clínica Saúde', email: 'financeiro@clinica.test' },
      servico: { codigo_servico_nacional: '010701', descricao: 'Consulta de novembro' },
      valor: '450.00',
    })

    // O worker emite pela empresa e a nota chega no WhatsApp de quem pediu, nomeando a empresa; o e-mail vai ao tomador.
    const sefin = createSefinClient({ transport: fakeSefin().transport })
    await rodarWorker(servico.db, { sefin, tenantId: oficina.id, canais: c.canais, now: c.agora })
    expect((await notasDoAgente(admin.db, oficina.id))[0].status).toBe('issued')
    const comPdf = c.mensagensPara(e.mae.ownerPhone).filter((m) => m.anexo?.tipo === 'application/pdf')
    expect(comPdf).toHaveLength(1)
    expect(comPdf[0].texto).toContain(`de Oficina Trilho Ltda (CNPJ ${formatarDocumento(await cnpjDe(oficina.id))})`)
    expect(c.canais.emails.some((m) => [m.para].flat().includes('financeiro@clinica.test'))).toBe(true)
    expect(c.ia.chamadas).toEqual([PELA_OFICINA])
  })

  it('sem a empresa no pedido: pergunta, e a resposta pelo número segue no mesmo pedido', async () => {
    const e = await escritorio()
    const [oficina] = e.empresas
    await criarModelo(admin.db, oficina.id, CLINICA)
    const c = conversa({ [SEM_EMPRESA]: { tomador: 'Clínica Saúde', valor: '450.00', intencao: 'emitir' } })

    await c.enviar(e.mae.ownerPhone, SEM_EMPRESA)
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(
      ['Por qual empresa sai a nota? Me mande o número, o nome ou o CNPJ.', '1. Contábil Aurora Ltda (escritório)', '2. Oficina Trilho Ltda', '3. Studio Lima'].join('\n'),
    )
    const [esperando] = await pedidosDo(admin.db, e.mae.tenant.id)
    expect(esperando).toMatchObject({ kind: 'emitir', status: 'awaiting_confirmation', etapa: 'escolher_prestador', invoice_id: null })

    await c.enviar(e.mae.ownerPhone, '2')
    const resumo = c.ultimaPara(e.mae.ownerPhone)
    expect(resumo).toContain('Emitente: Oficina Trilho Ltda (CNPJ ')
    expect(resumo).toContain('Tomador: Clínica Saúde')
    expect(resumo).toContain('R$ 450,00')
    // O mesmo pedido, agora da empresa escolhida; a IA leu só o pedido.
    expect(await pedidosDo(admin.db, e.mae.tenant.id)).toHaveLength(0)
    const [pedido] = await pedidosDo(admin.db, oficina.id)
    expect(pedido).toMatchObject({ id: esperando.id, etapa: 'confirmar', status: 'awaiting_confirmation' })
    expect(c.ia.chamadas).toEqual([SEM_EMPRESA])

    await c.enviar(e.mae.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, oficina.id)).toHaveLength(1)
    expect(await notasDoAgente(admin.db, e.mae.tenant.id)).toHaveLength(0)
  })

  it('a resposta pode ser parte do nome, o CNPJ ou "escritório"; "descartar" desiste', async () => {
    const e = await escritorio()
    const [, studio] = e.empresas
    await criarModelo(admin.db, studio.id, CLINICA)
    await criarModelo(admin.db, e.mae.tenant.id, CLINICA)
    const roteiro = { [SEM_EMPRESA]: { tomador: 'Clínica Saúde', valor: '450.00', intencao: 'emitir' as const } }

    const porNome = conversa(roteiro)
    await porNome.enviar(e.mae.ownerPhone, SEM_EMPRESA)
    await porNome.enviar(e.mae.ownerPhone, 'studio')
    expect(porNome.ultimaPara(e.mae.ownerPhone)).toContain('Emitente: Studio Lima (CNPJ ')
    await porNome.enviar(e.mae.ownerPhone, 'descartar')

    const porCnpj = conversa(roteiro)
    await porCnpj.enviar(e.mae.ownerPhone, SEM_EMPRESA)
    await porCnpj.enviar(e.mae.ownerPhone, formatarDocumento(await cnpjDe(studio.id)))
    expect(porCnpj.ultimaPara(e.mae.ownerPhone)).toContain('Emitente: Studio Lima (CNPJ ')
    await porCnpj.enviar(e.mae.ownerPhone, 'descartar')

    const peloEscritorio = conversa(roteiro)
    await peloEscritorio.enviar(e.mae.ownerPhone, SEM_EMPRESA)
    await peloEscritorio.enviar(e.mae.ownerPhone, 'escritório')
    expect(peloEscritorio.ultimaPara(e.mae.ownerPhone)).toContain('Emitente: Contábil Aurora Ltda (CNPJ ')
    await peloEscritorio.enviar(e.mae.ownerPhone, 'confirmar')
    expect(await notasDoAgente(admin.db, e.mae.tenant.id)).toHaveLength(1)

    const desiste = conversa(roteiro)
    await desiste.enviar(e.mae.ownerPhone, SEM_EMPRESA)
    await desiste.enviar(e.mae.ownerPhone, 'descartar')
    expect(desiste.ultimaPara(e.mae.ownerPhone)).toBe(TEXTOS.descartado)
    expect((await pedidosDo(admin.db, e.mae.tenant.id)).at(-1)).toMatchObject({ status: 'rejected_by_user', etapa: null })
  })

  it('nome que bate em duas empresas ou em nenhuma: a pergunta volta com as opções', async () => {
    const certificado = sharedTestCertificate().certificado
    const e = await escritorio([
      { certificado, razaoSocial: 'Padaria Lua Ltda' },
      { certificado, razaoSocial: 'Padaria Sol Ltda' },
    ])
    const [lua] = e.empresas
    await criarModelo(admin.db, lua.id, CLINICA)
    const pedido = 'nota pela Padaria pra Clínica Saúde, 450'
    const c = conversa({
      [pedido]: { tomador: 'Clínica Saúde', valor: '450.00', prestador: 'Padaria', intencao: 'emitir' },
      'nota pela Xpto pra Clínica Saúde, 450': { tomador: 'Clínica Saúde', valor: '450.00', prestador: 'Xpto', intencao: 'emitir' },
    })

    await c.enviar(e.mae.ownerPhone, pedido)
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(
      ['Achei mais de uma empresa com esse nome.', 'Por qual empresa sai a nota? Me mande o número, o nome ou o CNPJ.', '1. Padaria Lua Ltda', '2. Padaria Sol Ltda'].join('\n'),
    )
    // Resposta que não bate em nenhuma: a pergunta volta, com a conta inteira.
    await c.enviar(e.mae.ownerPhone, 'mercado')
    expect(c.ultimaPara(e.mae.ownerPhone).split('\n')[0]).toBe('Não achei "mercado" entre as empresas ativas de Minhas empresas.')
    expect(c.ultimaPara(e.mae.ownerPhone)).toContain('1. Contábil Aurora Ltda (escritório)')
    await c.enviar(e.mae.ownerPhone, 'padaria lua')
    expect(c.ultimaPara(e.mae.ownerPhone)).toContain('Emitente: Padaria Lua Ltda (CNPJ ')
    await c.enviar(e.mae.ownerPhone, 'descartar')

    await c.enviar(e.mae.ownerPhone, 'nota pela Xpto pra Clínica Saúde, 450')
    const resposta = c.ultimaPara(e.mae.ownerPhone).split('\n')
    expect(resposta[0]).toBe('Não achei "Xpto" entre as empresas ativas de Minhas empresas.')
    expect(resposta[1]).toBe('Por qual empresa sai a nota? Me mande o número, o nome ou o CNPJ.')
    expect(resposta).toHaveLength(5)
  })

  it('a IA leu o cliente como empresa: nome que não é de empresa da conta vira o tomador', async () => {
    const e = await escritorio()
    const pedido = 'nota da Clínica Saúde, 450'
    const c = conversa({ [pedido]: { prestador: 'Clínica Saúde', valor: '450.00', intencao: 'emitir' } })
    await c.enviar(e.mae.ownerPhone, pedido)
    expect(c.ultimaPara(e.mae.ownerPhone).split('\n')[0]).toBe('Por qual empresa sai a nota? Me mande o número, o nome ou o CNPJ.')
    await c.enviar(e.mae.ownerPhone, '2')
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe('É a primeira nota de Oficina Trilho Ltda para Clínica Saúde. Me mande o CPF ou CNPJ e o e-mail de Clínica Saúde.')
  })

  it('pedido sem cliente não chega a perguntar a empresa', async () => {
    const e = await escritorio()
    const c = conversa({ 'nota de 450': { valor: '450.00', intencao: 'emitir' }, 'nota pela Oficina Trilho': { prestador: 'Oficina Trilho', intencao: 'emitir' } })
    await c.enviar(e.mae.ownerPhone, 'nota de 450')
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(TEXTOS.faltaTomador)
    await c.enviar(e.mae.ownerPhone, 'nota pela Oficina Trilho')
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(TEXTOS.faltaTudo)
    for (const t of [e.mae.tenant.id, ...e.empresas.map((x) => x.id)]) expect(await pedidosDo(admin.db, t)).toHaveLength(0)
  })

  it('empresa sem certificado: o motivo nomeia a empresa e nada fica aguardando', async () => {
    const certificado = sharedTestCertificate().certificado
    const e = await escritorio([
      { certificado, razaoSocial: 'Oficina Trilho Ltda' },
      { notAfter: null, razaoSocial: 'Oficina Sem Certificado' },
    ])
    const [, semCert] = e.empresas
    const pedido = 'nota pela Oficina Sem Certificado pra Clínica Saúde, 450'
    const c = conversa({
      [pedido]: { tomador: 'Clínica Saúde', valor: '450.00', prestador: 'Oficina Sem Certificado', intencao: 'emitir' },
      [SEM_EMPRESA]: { tomador: 'Clínica Saúde', valor: '450.00', intencao: 'emitir' },
    })
    const esperado =
      'Não dá para emitir por Oficina Sem Certificado: Oficina Sem Certificado ainda não tem certificado A1. Resolva em Minha conta → Minhas empresas: https://site.test/agentes/fiscal/conta/#empresas'

    await c.enviar(e.mae.ownerPhone, pedido)
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(esperado)
    expect(await pedidosDo(admin.db, semCert.id)).toHaveLength(0)

    // Escolhida na pergunta, o mesmo motivo; o pedido que esperava a empresa sai.
    await c.enviar(e.mae.ownerPhone, SEM_EMPRESA)
    await c.enviar(e.mae.ownerPhone, 'oficina sem certificado')
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(esperado)
    const todos = [...(await pedidosDo(admin.db, e.mae.tenant.id)), ...(await pedidosDo(admin.db, semCert.id))]
    expect(todos.filter((p) => p.status === 'awaiting_confirmation')).toHaveLength(0)
  })

  it('cliente novo pela empresa: o modelo salvo fica na empresa, não no escritório', async () => {
    const e = await escritorio()
    const [oficina] = e.empresas
    const pedido = 'nota pela Oficina Trilho pra Ana Souza, 100'
    const c = conversa({ [pedido]: { tomador: 'Ana Souza', valor: '100.00', prestador: 'Oficina Trilho', intencao: 'emitir' } })
    const sefin = createSefinClient({ transport: fakeSefin().transport })

    await c.enviar(e.mae.ownerPhone, pedido)
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe('É a primeira nota de Oficina Trilho Ltda para Ana Souza. Me mande o CPF ou CNPJ e o e-mail de Ana Souza.')
    await c.enviar(e.mae.ownerPhone, '529.982.247-25 ana@souza.test')
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(TEXTOS.perguntaDeDescricao)
    await c.enviar(e.mae.ownerPhone, 'padrão')
    expect(c.ultimaPara(e.mae.ownerPhone)).toContain('Emitente: Oficina Trilho Ltda (CNPJ ')
    await c.enviar(e.mae.ownerPhone, 'confirmar')
    await rodarWorker(servico.db, { sefin, tenantId: oficina.id, canais: c.canais, now: c.agora })
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe('Quer que eu guarde Ana Souza para as próximas notas? Responda sim ou não.')

    await c.enviar(e.mae.ownerPhone, 'sim')
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(
      'Modelo Ana Souza salvo em Oficina Trilho Ltda. Da próxima vez, é só escrever: nota pela Oficina Trilho Ltda pra Ana Souza, e o valor.',
    )
    const modelos = async (tenantId: string) =>
      (await admin.db.query<{ nome: string }>('select nome from nofiscal.fiscal_models where tenant_id = $1', [tenantId])).rows.map((r) => r.nome)
    expect(await modelos(oficina.id)).toEqual(['Ana Souza'])
    expect(await modelos(e.mae.tenant.id)).toEqual([])
  })

  it('corrigir a empresa: o pedido recomeça na outra, com o mesmo cliente e valor', async () => {
    const e = await escritorio()
    const [oficina, studio] = e.empresas
    await criarModelo(admin.db, oficina.id, CLINICA)
    await criarModelo(admin.db, studio.id, { ...CLINICA, descricao: 'Consulta pelo Studio' })
    const c = conversa({
      [PELA_OFICINA]: { tomador: 'Clínica Saúde', valor: '450.00', prestador: 'Oficina Trilho', intencao: 'emitir' },
      'pela Studio Lima': { prestador: 'Studio Lima', intencao: 'outro' },
    })
    await c.enviar(e.mae.ownerPhone, PELA_OFICINA)
    await c.enviar(e.mae.ownerPhone, 'corrigir')
    await c.enviar(e.mae.ownerPhone, 'pela Studio Lima')
    const resumo = c.ultimaPara(e.mae.ownerPhone)
    expect(resumo).toContain('Emitente: Studio Lima (CNPJ ')
    expect(resumo).toContain('Tomador: Clínica Saúde')
    expect(resumo).toContain('R$ 450,00')
    expect((await pedidosDo(admin.db, oficina.id)).map((p) => p.status)).toEqual(['rejected_by_user'])
    expect((await pedidosDo(admin.db, studio.id)).map((p) => p.status)).toEqual(['awaiting_confirmation'])
  })
})

describe('contas sem escolha de empresa não mudam', () => {
  it('Escritório com uma empresa ativa só: sem pergunta e sem a linha "Emitente"', async () => {
    const e = await escritorio([])
    await criarModelo(admin.db, e.mae.tenant.id, CLINICA)
    const c = conversa({ [PELA_OFICINA]: { tomador: 'Clínica Saúde', valor: '450.00', prestador: 'Oficina Trilho', intencao: 'emitir' } })
    await c.enviar(e.mae.ownerPhone, PELA_OFICINA)
    const resumo = c.ultimaPara(e.mae.ownerPhone)
    expect(resumo.split('\n').slice(0, 2)).toEqual(['Resumo da nota:', 'Tomador: Clínica Saúde'])
    expect(resumo).not.toContain('Emitente')
    expect(await pedidosDo(admin.db, e.mae.tenant.id)).toHaveLength(1)
  })

  it('empresa desativada não entra na escolha', async () => {
    const e = await escritorio()
    const [oficina, studio] = e.empresas
    await admin.db.query('update nofiscal.fiscal_tenants set active = false where id = $1', [studio.id])
    const c = conversa({ [SEM_EMPRESA]: { tomador: 'Clínica Saúde', valor: '450.00', intencao: 'emitir' } })
    await c.enviar(e.mae.ownerPhone, SEM_EMPRESA)
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe(
      ['Por qual empresa sai a nota? Me mande o número, o nome ou o CNPJ.', '1. Contábil Aurora Ltda (escritório)', '2. Oficina Trilho Ltda'].join('\n'),
    )
    expect(oficina.id).toBeTruthy()
  })

  it('conta Pro: o nome de empresa lido pela IA é ignorado', async () => {
    const s = await createSelfServiceTenant(admin.db, { plan: 'pro' })
    avulsos.push(s)
    await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
    await criarModelo(admin.db, s.tenant.id, CLINICA)
    const c = conversa({ [PELA_OFICINA]: { tomador: 'Clínica Saúde', valor: '450.00', prestador: 'Oficina Trilho', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, PELA_OFICINA)
    const resumo = c.ultimaPara(s.ownerPhone)
    expect(resumo).toContain('Posso emitir?')
    expect(resumo).not.toContain('Emitente')
    expect(await pedidosDo(admin.db, s.tenant.id)).toHaveLength(1)
  })
})

// ── cancelar pela conta inteira ─────────────────────────────────────────────────────────

/** Nota emitida gravada direto no tenant (como em conversa.test.ts). */
async function notaEmitida(tenantId: string, opcoes: { numero: number; nome?: string; valor?: string }): Promise<string> {
  const { rows } = await admin.db.query<{ id: string }>(
    `insert into nofiscal.fiscal_invoices
       (tenant_id, external_id, payload, status, dps_serie, dps_numero, chave_acesso, issued_at)
     values ($1, $2, $3::jsonb, 'issued', '1', $4, $5, now()) returning id`,
    [
      tenantId,
      `emitida-${randomUUID()}`,
      JSON.stringify({
        tomador: { cpf: '52998224725', nome: opcoes.nome ?? 'Clínica Saúde', email: 'financeiro@clinica.test' },
        servico: { codigo_servico_nacional: '010701', descricao: 'Consulta de novembro' },
        valor: opcoes.valor ?? '450.00',
      }),
      opcoes.numero,
      `CHAVE${randomUUID().replace(/-/g, '')}`,
    ],
  )
  return rows[0].id
}

const situacaoDa = async (id: string) =>
  (await admin.db.query<{ status: string }>('select status from nofiscal.fiscal_invoices where id = $1', [id])).rows[0].status

describe('cancelar nota de qualquer empresa da conta (conta Escritório)', () => {
  const CANCELA = 'cancela a nota da Clínica Saúde de hoje'

  it('nota de empresa cliente é achada, a pergunta diz a empresa e o cancelamento vai pelo tenant dela', async () => {
    const e = await escritorio()
    const [oficina] = e.empresas
    const nota = await notaEmitida(oficina.id, { numero: 5 })
    const c = conversa({ [CANCELA]: { tomador: 'Clínica Saúde', intencao: 'cancelar' } })

    await c.enviar(e.mae.ownerPhone, CANCELA)
    const pergunta = c.ultimaPara(e.mae.ownerPhone).split('\n')
    expect(pergunta.slice(0, 3)).toEqual(['Nota nº 5', 'Emitente: Oficina Trilho Ltda', 'Tomador: Clínica Saúde'])
    expect(pergunta.at(-1)).toContain('Cancelo esta nota?')
    expect(await pedidosDo(admin.db, e.mae.tenant.id)).toHaveLength(0)
    expect((await pedidosDo(admin.db, oficina.id))[0]).toMatchObject({ kind: 'cancelar', etapa: 'confirmar', invoice_id: nota })

    await c.enviar(e.mae.ownerPhone, 'confirmar')
    expect(c.ultimaPara(e.mae.ownerPhone)).toBe('Pedido de cancelamento da nota nº 5 enviado. Eu te aviso quando a Sefin confirmar.')
    expect(await situacaoDa(nota)).toBe('cancel_requested')
  })

  it('mesmo número em duas empresas: a lista diz a empresa, e a empresa no pedido desempata', async () => {
    const e = await escritorio()
    const [oficina] = e.empresas
    const doEscritorio = await notaEmitida(e.mae.tenant.id, { numero: 5, valor: '100.00' })
    const daOficina = await notaEmitida(oficina.id, { numero: 5, valor: '450.00' })
    const comEmpresa = 'cancela a nota da Oficina Trilho pra Clínica Saúde'
    const c = conversa({
      [CANCELA]: { tomador: 'Clínica Saúde', intencao: 'cancelar' },
      [comEmpresa]: { tomador: 'Clínica Saúde', prestador: 'Oficina Trilho', intencao: 'cancelar' },
    })

    await c.enviar(e.mae.ownerPhone, CANCELA)
    const lista = c.ultimaPara(e.mae.ownerPhone)
    expect(lista).toContain('Achei mais de uma nota.')
    expect(lista).toContain('R$ 100,00')
    expect(lista).toContain('· Contábil Aurora Ltda')
    expect(lista).toContain('· Oficina Trilho Ltda')

    // O número sozinho não escolhe entre as duas empresas.
    await c.enviar(e.mae.ownerPhone, '5')
    expect(c.ultimaPara(e.mae.ownerPhone).split('\n')[0]).toBe('Há mais de uma nota nº 5. Cancele uma de cada vez, dizendo a empresa e o cliente no pedido:')
    expect(await situacaoDa(doEscritorio)).toBe('issued')
    expect(await situacaoDa(daOficina)).toBe('issued')

    await c.enviar(e.mae.ownerPhone, comEmpresa)
    const pergunta = c.ultimaPara(e.mae.ownerPhone)
    expect(pergunta).toContain('Emitente: Oficina Trilho Ltda')
    expect(pergunta).toContain('R$ 450,00')
    await c.enviar(e.mae.ownerPhone, 'confirmar')
    expect(await situacaoDa(daOficina)).toBe('cancel_requested')
    expect(await situacaoDa(doEscritorio)).toBe('issued')
  })

  it('nota de outra conta não aparece', async () => {
    const e = await escritorio()
    const outro = await escritorio()
    await notaEmitida(outro.empresas[0].id, { numero: 9 })
    const c = conversa({ [CANCELA]: { tomador: 'Clínica Saúde', intencao: 'cancelar' } })
    await c.enviar(e.mae.ownerPhone, CANCELA)
    expect(c.ultimaPara(e.mae.ownerPhone)).toMatch(/^Não achei nota emitida para Clínica Saúde em /)
  })
})
