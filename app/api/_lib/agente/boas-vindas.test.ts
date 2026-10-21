// Ativação e boas-vindas no WhatsApp. Checks C26 a C34 de .checks/agente-fiscal-v2.md. O código
// sob teste conecta como `nofiscal_service`; WhatsApp, intérprete, catálogo e CNPJ são dublês.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  canaisDouble,
  createSelfServiceTenant,
  criarModelo,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDeArquivo,
  mensagemDeTexto,
  openRoleDb,
  randomPhone,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { gerarCodigoDeAtivacao } from './ativacao.js'
import type { CatalogoDeServicos } from './catalogo-servicos.js'
import { processarMensagem, type ConversaDeps } from './conversa.js'
import type { Parsed } from './interprete.js'
import { tarefasDoAgente } from './tarefas.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []

const DESCRICAO = 'Serviço de teste da lista nacional'
const catalogo: CatalogoDeServicos = {
  async descricao(codigo) {
    return codigo === '010701' ? DESCRICAO : null
  },
}
const RAZAO = 'EMPRESA BOAS VINDAS LTDA'
const PERGUNTA_1 = `Sua empresa: ${RAZAO}, serviço 010701 (${DESCRICAO}), 0 clientes importados. Está tudo certo?`

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

async function novoTenant(opcoes: { ativado?: boolean; onboardingEtapa?: string; pagoEm?: Date } = {}) {
  const s = await createSelfServiceTenant(admin.db, {
    ativado: opcoes.ativado ?? false,
    onboardingEtapa: opcoes.onboardingEtapa ?? 'ativacao',
    pagoEm: opcoes.pagoEm ?? new Date(Date.now() - 2 * 3600_000),
    razaoSocial: RAZAO,
  })
  tenants.push(s)
  return s
}

function conversa(respostas: Record<string, Partial<Parsed>> = {}, now: () => Date = () => new Date()) {
  const canais = canaisDouble()
  const ia = interpreteDouble(respostas)
  const deps: ConversaDeps = {
    db: servico.db,
    whatsapp: canais.whatsapp,
    interprete: ia.interprete,
    links: LINKS_DE_TESTE,
    catalogo,
    consultaCnpj: { razaoSocial: async () => 'TOMADOR PJ LTDA' },
    now,
  }
  const enviar = async (de: string, texto: string) => {
    await processarMensagem(deps, mensagemDeTexto(de, texto))
    return canais.whatsapps.filter((m) => m.para === de).at(-1)?.texto ?? ''
  }
  return { deps, canais, ia, enviar }
}

async function codigoPara(s: SelfServiceTenant): Promise<string> {
  const r = await gerarCodigoDeAtivacao({ db: servico.db, numeroDoAgente: '5511900000001' }, { userId: s.ownerUserId, tenantId: s.tenant.id })
  if (!r.ok) throw new Error(`código não gerado: ${r.erro}`)
  return r.codigo
}

async function estadoDe(s: SelfServiceTenant) {
  const { rows } = await admin.db.query<{
    conta: Date | null
    telefone: Date | null
    etapa: string
    consumidos: number
    pendentes: number
  }>(
    `select a.phone_verified_at as conta,
            (select p.verified_at from nofiscal.fiscal_phones p where p.tenant_id = t.id and p.role = 'owner') as telefone,
            t.onboarding_etapa as etapa,
            (select count(*)::int from nofiscal.fiscal_verification_codes c
              where c.user_id = a.user_id and c.purpose = 'whatsapp_activation' and c.consumed_at is not null) as consumidos,
            (select count(*)::int from nofiscal.fiscal_verification_codes c
              where c.user_id = a.user_id and c.purpose = 'whatsapp_activation' and c.consumed_at is null) as pendentes
       from nofiscal.fiscal_tenants t join nofiscal.fiscal_accounts a on a.client_id = t.client_id
      where t.id = $1`,
    [s.tenant.id],
  )
  return rows[0]
}

async function contagens(tenantId: string) {
  const { rows } = await admin.db.query<{ notas: number; pedidos: number }>(
    `select (select count(*)::int from nofiscal.fiscal_invoices where tenant_id = $1) as notas,
            (select count(*)::int from nofiscal.fiscal_requests where tenant_id = $1) as pedidos`,
    [tenantId],
  )
  return rows[0]
}

/** Tenant ativado pelo `ATIVAR` e já na etapa pedida, pelo caminho real da conversa. */
async function ateAEtapa(etapa: 'boas_vindas_conferir' | 'boas_vindas_cliente', c = conversa()) {
  const s = await novoTenant()
  await c.enviar(s.ownerPhone, `ATIVAR ${await codigoPara(s)}`)
  if (etapa === 'boas_vindas_cliente') await c.enviar(s.ownerPhone, 'sim')
  expect((await estadoDe(s)).etapa).toBe(etapa)
  return s
}

describe('ativação pelo WhatsApp', () => {
  it('ativar pelo número do dono', async () => {
    const s = await novoTenant()
    const codigo = await codigoPara(s)
    expect(await estadoDe(s)).toMatchObject({ conta: null, telefone: null, consumidos: 0, pendentes: 1 })

    const c = conversa()
    const resposta = await c.enviar(s.ownerPhone, `ativar ${codigo}`)

    const depois = await estadoDe(s)
    expect(depois.conta).not.toBeNull()
    expect(depois.telefone).not.toBeNull()
    expect(depois).toMatchObject({ consumidos: 1, pendentes: 0, etapa: 'boas_vindas_conferir' })
    expect(resposta).toBe(PERGUNTA_1)

    // O código consumido não ativa de novo.
    expect(await c.enviar(s.ownerPhone, `ATIVAR ${codigo}`)).toContain('Código de ativação inválido')
  })

  it('ativar de outro número ou código errado', async () => {
    const s = await novoTenant()
    const codigo = await codigoPara(s)
    const c = conversa()

    const estranho = randomPhone()
    const deOutro = await c.enviar(estranho, `ATIVAR ${codigo}`)
    expect(deOutro).toBe(`A ativação precisa sair do WhatsApp cadastrado: +55 11 *****-${s.ownerPhone.slice(-4)}`)
    expect(deOutro).not.toContain(s.ownerPhone.slice(3, 9))
    expect(await estadoDe(s)).toMatchObject({ conta: null, telefone: null, consumidos: 0, pendentes: 1 })

    const errado = codigo === '000000' ? '000001' : '000000'
    expect(await c.enviar(s.ownerPhone, `ATIVAR ${errado}`)).toBe(`Código de ativação inválido. Gere outro em ${LINKS_DE_TESTE.conta}`)
    expect(await estadoDe(s)).toMatchObject({ conta: null, consumidos: 0 })

    // Vencido (25 h depois): o código certo também é recusado.
    const tarde = conversa({}, () => new Date(Date.now() + 25 * 3600_000))
    expect(await tarde.enviar(s.ownerPhone, `ATIVAR ${codigo}`)).toBe(`Código de ativação inválido. Gere outro em ${LINKS_DE_TESTE.conta}`)
    expect(await estadoDe(s)).toMatchObject({ conta: null, telefone: null, consumidos: 0 })

    // O certo, no prazo, ainda vale.
    expect(await c.enviar(s.ownerPhone, `ATIVAR ${codigo}`)).toBe(PERGUNTA_1)
  })

  it('reserva de boas-vindas', async () => {
    const pagoEm = new Date(Date.now() - 10 * 60_000)
    const s = await novoTenant({ pagoEm })
    const canais = canaisDouble()
    const rodar = (depoisDoPagamento: number, modelos: { boasVindas?: string } = { boasVindas: 'boas_vindas_nofiscal' }) =>
      tarefasDoAgente(
        servico.db,
        { whatsapp: canais.whatsapp, email: canais.email, links: LINKS_DE_TESTE, modelos, now: () => new Date(pagoEm.getTime() + depoisDoPagamento) },
        { tenantId: s.tenant.id },
      )

    // Antes de 1 hora: nada.
    await rodar(59 * 60_000)
    expect(canais.whatsapps).toHaveLength(0)
    // Sem o nome do modelo no ambiente: nada, e a vez não é gasta.
    await rodar(61 * 60_000, {})
    expect(canais.whatsapps).toHaveLength(0)

    await rodar(61 * 60_000)
    expect(canais.whatsapps).toEqual([
      { para: s.ownerPhone, texto: expect.any(String), modelo: { nome: 'boas_vindas_nofiscal', parametros: [RAZAO] } },
    ])
    // Uma vez só.
    await rodar(2 * 3600_000)
    await rodar(30 * 3600_000)
    expect(canais.whatsapps).toHaveLength(1)

    // Um número qualquer respondendo não ativa.
    const c = conversa()
    await c.enviar(randomPhone(), 'Quero ativar')
    expect((await estadoDe(s)).conta).toBeNull()

    // A resposta ao modelo (um botão, sem texto), vinda do número cadastrado, ativa.
    await processarMensagem(c.deps, { ...mensagemDeArquivo(s.ownerPhone, 'x', 'x'), tipo: 'button', arquivo: null })
    const depois = await estadoDe(s)
    expect(depois.conta).not.toBeNull()
    expect(depois.telefone).not.toBeNull()
    expect(depois.etapa).toBe('boas_vindas_conferir')
    expect(c.canais.whatsapps.at(-1)).toEqual({ para: s.ownerPhone, texto: PERGUNTA_1 })

    // Quem já ativou não recebe a reserva.
    const ativo = await novoTenant({ ativado: true, onboardingEtapa: 'boas_vindas_conferir', pagoEm })
    await tarefasDoAgente(
      servico.db,
      { whatsapp: canais.whatsapp, email: canais.email, modelos: { boasVindas: 'boas_vindas_nofiscal' }, now: () => new Date(pagoEm.getTime() + 2 * 3600_000) },
      { tenantId: ativo.tenant.id },
    )
    expect(canais.whatsapps).toHaveLength(1)
  })
})

describe('boas-vindas', () => {
  it('conferir o cadastro', async () => {
    const c = conversa()
    const s = await novoTenant()
    // Dois clientes importados entram na conta.
    for (const [nome, origem] of [['Importado A', 'importacao_adn'], ['Importado B', 'importacao_pdf']]) {
      await admin.db.query(
        `insert into nofiscal.fiscal_models (tenant_id, nome, tomador_documento, tomador_nome, codigo_servico_nacional, descricao, origem)
         values ($1, $2, '52998224725', $2, '010701', 'x', $3)`,
        [s.tenant.id, nome, origem],
      )
    }
    await criarModelo(admin.db, s.tenant.id, { nome: 'Da nota', documento: '52998224725', nomeTomador: 'Da nota' })
    const pergunta = await c.enviar(s.ownerPhone, `ATIVAR ${await codigoPara(s)}`)
    expect(pergunta).toBe(`Sua empresa: ${RAZAO}, serviço 010701 (${DESCRICAO}), 2 clientes importados. Está tudo certo?`)

    // "não" manda o link da conta e fica na mesma pergunta; "pronto" repete a pergunta.
    const nao = await c.enviar(s.ownerPhone, 'não')
    expect(nao).toContain(LINKS_DE_TESTE.conta)
    expect((await estadoDe(s)).etapa).toBe('boas_vindas_conferir')
    expect(await c.enviar(s.ownerPhone, 'pronto')).toBe(pergunta)

    // "sim" passa ao cliente frequente.
    expect(await c.enviar(s.ownerPhone, 'Sim')).toBe('Para quem você mais emite?')
    expect((await estadoDe(s)).etapa).toBe('boas_vindas_cliente')
  })

  it('cliente mais frequente', async () => {
    // Com modelo: mostra o modelo e pergunta "Está certo?".
    const c = conversa()
    const comModelo = await ateAEtapa('boas_vindas_cliente', c)
    await criarModelo(admin.db, comModelo.tenant.id, {
      nome: 'Prontia',
      documento: '52998224725',
      nomeTomador: 'Prontia Saúde',
      email: 'financeiro@prontia.test',
      descricao: 'Consultoria em saúde',
    })
    const cartao = await c.enviar(comModelo.ownerPhone, 'Prontia')
    expect(cartao).toContain('Tomador: Prontia Saúde')
    expect(cartao).toContain('CPF: 529.982.247-25')
    expect(cartao).toContain('Serviço: 010701')
    expect(cartao).toContain('Descrição: Consultoria em saúde')
    expect(cartao).toContain('E-mail: financeiro@prontia.test')
    expect(cartao.trim().endsWith('Está certo?')).toBe(true)
    expect(await c.enviar(comModelo.ownerPhone, 'sim')).toContain('Me diga uma nota que você emitiria, como se fosse de verdade')
    expect((await estadoDe(comModelo)).etapa).toBe('boas_vindas_ensaio')

    // Sem modelo: pede CPF/CNPJ e e-mail, como no tomador novo, e oferece salvar como modelo.
    const semModelo = await ateAEtapa('boas_vindas_cliente', c)
    const pedido = await c.enviar(semModelo.ownerPhone, 'Clínica Aurora')
    expect(pedido).toMatch(/CPF ou CNPJ/)
    expect(pedido).toMatch(/e-mail/)
    expect(await c.enviar(semModelo.ownerPhone, '11.444.777/0001-61')).toContain('Falta o e-mail')
    expect(await c.enviar(semModelo.ownerPhone, 'contato@aurora.test')).toBe('Salvar Clínica Aurora como modelo? Responda sim ou não.')
    const salvo = await c.enviar(semModelo.ownerPhone, 'sim')
    expect(salvo).toContain('Modelo Clínica Aurora salvo.')
    expect(salvo).toContain('Me diga uma nota que você emitiria')
    const { rows } = await admin.db.query(
      `select nome, tomador_documento, tomador_nome, tomador_email, codigo_servico_nacional, origem, created_from_invoice_id
         from nofiscal.fiscal_models where tenant_id = $1`,
      [semModelo.tenant.id],
    )
    expect(rows).toEqual([
      {
        nome: 'Clínica Aurora',
        tomador_documento: '11444777000161',
        tomador_nome: 'TOMADOR PJ LTDA',
        tomador_email: 'contato@aurora.test',
        codigo_servico_nacional: '010701',
        origem: 'boas_vindas',
        created_from_invoice_id: null,
      },
    ])
    expect(await contagens(semModelo.tenant.id)).toEqual({ notas: 0, pedidos: 0 })
  })

  it('ensaio não emite', async () => {
    const c = conversa({ 'nota pra Prontia, 150 reais': { intencao: 'emitir', tomador: 'Prontia', valor: '150' } })
    const s = await ateAEtapa('boas_vindas_cliente', c)
    await criarModelo(admin.db, s.tenant.id, { nome: 'Prontia', documento: '52998224725', nomeTomador: 'Prontia Saúde' })
    await c.enviar(s.ownerPhone, 'Prontia')
    await c.enviar(s.ownerPhone, 'sim')
    const antes = await contagens(s.tenant.id)

    const resumo = await c.enviar(s.ownerPhone, 'nota pra Prontia, 150 reais')
    expect(resumo.split('\n')[0]).toBe('EXEMPLO — não será emitida')
    expect(resumo).toContain('Tomador: Prontia Saúde')
    expect(resumo).toContain('Valor: R$ 150,00')
    expect(c.ia.chamadas).toEqual(['nota pra Prontia, 150 reais'])
    expect(await contagens(s.tenant.id)).toEqual(antes)
    expect(antes.pedidos).toBe(0)
  })

  it('confirmar no ensaio', async () => {
    const c = conversa({ 'nota pra Prontia, 150 reais': { intencao: 'emitir', tomador: 'Prontia', valor: '150' } })
    const s = await ateAEtapa('boas_vindas_cliente', c)
    await criarModelo(admin.db, s.tenant.id, { nome: 'Prontia', documento: '52998224725', nomeTomador: 'Prontia Saúde' })
    await c.enviar(s.ownerPhone, 'Prontia')
    await c.enviar(s.ownerPhone, 'sim')
    await c.enviar(s.ownerPhone, 'nota pra Prontia, 150 reais')
    // A única nota do tenant é a de origem do modelo (fixture).
    const antes = await contagens(s.tenant.id)
    expect(antes).toEqual({ notas: 1, pedidos: 0 })

    const depois = c.canais.whatsapps.length
    await c.enviar(s.ownerPhone, 'confirmar')
    const respostas = c.canais.whatsapps.slice(depois).map((m) => m.texto)
    expect(respostas[0]).toBe('Isso foi só um exemplo. Para emitir de verdade, mande o pedido de novo')
    expect(await contagens(s.tenant.id)).toEqual(antes)
  })

  it('pronto conclui', async () => {
    const c = conversa({ 'nota pra Prontia, 150 reais': { intencao: 'emitir', tomador: 'Prontia', valor: '150' } })
    const s = await ateAEtapa('boas_vindas_cliente', c)
    await criarModelo(admin.db, s.tenant.id, { nome: 'Prontia', documento: '52998224725', nomeTomador: 'Prontia Saúde' })
    await c.enviar(s.ownerPhone, 'Prontia')
    await c.enviar(s.ownerPhone, 'sim')
    await c.enviar(s.ownerPhone, 'nota pra Prontia, 150 reais')
    expect((await estadoDe(s)).etapa).toBe('boas_vindas_ensaio')
    const antes = await contagens(s.tenant.id)

    const pronto = await c.enviar(s.ownerPhone, 'confirmar')
    expect(pronto).toBe(
      'Pronto! Agora, para emitir uma nova nota, é só mandar uma mensagem aqui com o cliente e o valor, por exemplo: nota pra Prontia, 150 reais',
    )
    expect((await estadoDe(s)).etapa).toBe('concluido')
    expect(await contagens(s.tenant.id)).toEqual(antes)
  })

  it('pedido antes de concluir', async () => {
    const c = conversa()
    const s = await ateAEtapa('boas_vindas_conferir', c)

    const naConferencia = await c.enviar(s.ownerPhone, 'nota pra Prontia, 10 reais')
    expect(naConferencia.startsWith('Antes de emitir, vamos terminar a configuração')).toBe(true)
    expect(naConferencia).toContain('Está tudo certo?')

    await c.enviar(s.ownerPhone, 'sim')
    const noCliente = await c.enviar(s.ownerPhone, 'nota pra Prontia, 10 reais')
    expect(noCliente.startsWith('Antes de emitir, vamos terminar a configuração')).toBe(true)
    expect(noCliente).toContain('Para quem você mais emite?')
    expect((await estadoDe(s)).etapa).toBe('boas_vindas_cliente')

    // Site incompleto: o mesmo aviso, com o link da conta.
    const noSite = await novoTenant({ ativado: true, onboardingEtapa: 'certificado' })
    const resposta = await c.enviar(noSite.ownerPhone, 'nota pra Prontia, 10 reais')
    expect(resposta.startsWith('Antes de emitir, vamos terminar a configuração')).toBe(true)
    expect(resposta).toContain(LINKS_DE_TESTE.conta)

    // A IA nem foi chamada, e nenhum pedido nasceu.
    expect(c.ia.chamadas).toEqual([])
    expect(await contagens(s.tenant.id)).toEqual({ notas: 0, pedidos: 0 })
    expect(await contagens(noSite.tenant.id)).toEqual({ notas: 0, pedidos: 0 })
  })
})
