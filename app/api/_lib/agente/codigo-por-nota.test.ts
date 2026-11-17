// Código de serviço nota a nota (Lucca, 17/11/2026): a mesma empresa emite serviços diferentes (clínica com psicologia,
// fisioterapia e nutrição) pela planilha (coluna `codigo_servico`) e pelo WhatsApp ("código 04.08.02", "serviço de
// fisioterapia"). Ordem: o código da linha ou do pedido, depois o do cliente salvo, depois o da empresa.
// Funções puras e, de ponta a ponta, o banco local com WhatsApp, IA, mídia e lista nacional de dublês.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createEscritorio,
  createSelfServiceTenant,
  criarModelo,
  dropEscritorio,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDePlanilha,
  mensagemDeTexto,
  midiaDouble,
  openRoleDb,
  pedidosDo,
  type Escritorio,
  type SelfServiceTenant,
  ehPerguntaDeInfo,
} from '../../_tests/agente-fixtures.js'
import { sharedTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { buscarServicos, lerCodigoServico, type CatalogoDeServicos } from './catalogo-servicos.js'
import { codigoDoPedido, processarMensagem, TEXTOS, type ConversaDeps } from './conversa.js'
import type { Parsed } from './interprete.js'
import { validarParsed } from './interprete.js'
import {
  interpretarGrade,
  motivoDoProblema,
  textoDasColunas,
  textoDoResumoDoLote,
  validarLinhas,
  type Celula,
  type ContextoDoLote,
  type Empresa,
} from './lote.js'

// A lista nacional publicada pelo site, sem o ponto final (como o catálogo entrega).
const LISTA = new Map<string, string>(
  (JSON.parse(readFileSync(new URL('../../../../agentes/fiscal/dados/codigos-servico.json', import.meta.url), 'utf8')) as { itens: { codigo: string; descricao: string }[] }).itens.map(
    (i) => [i.codigo, i.descricao.trim().replace(/\.+$/, '')],
  ),
)
const catalogo = (lista: Map<string, string> | null = LISTA): CatalogoDeServicos => ({
  descricao: async (codigo) => lista?.get(codigo) ?? null,
  itens: async () => lista,
})

const CPF = '52998224725'
const CPF_2 = '11144477735'
const CNPJ_TOMADOR = '11444777000161'

describe('código de serviço: leitura e busca na lista', () => {
  it('aceita 6 dígitos com ou sem pontos e o número do Excel sem o zero', () => {
    expect(lerCodigoServico('04.08.02')).toBe('040802')
    expect(lerCodigoServico('040802')).toBe('040802')
    expect(lerCodigoServico(' 4.08.02 ')).toBe('040802')
    expect(lerCodigoServico(40802)).toBe('040802')
    expect(lerCodigoServico('40802')).toBe('040802')
    for (const ruim of ['abc', '04.08', '0408021', '04/08/02x', '', 123, 1.5, null]) expect(lerCodigoServico(ruim)).toBeNull()
  })

  it('acha o código pelo nome do serviço; com mais de um, devolve todos', () => {
    expect(buscarServicos(LISTA, 'fisioterapia')).toEqual(['040802'])
    expect(buscarServicos(LISTA, 'Psicologia')).toEqual(['041601'])
    expect(buscarServicos(LISTA, 'nutrição')).toEqual(['041001'])
    expect(buscarServicos(LISTA, 'serviço de odontologia')).toEqual(['041201'])
    // "Medicina." é igual ao termo: Biomedicina e Medicina veterinária não entram.
    expect(buscarServicos(LISTA, 'medicina')).toEqual(['040101'])
    expect(buscarServicos(LISTA, 'limpeza')).toEqual(['071001', '071002', '071801'])
    expect(buscarServicos(LISTA, 'xyzw')).toEqual([])
  })
})

describe('planilha: coluna codigo_servico', () => {
  const ESCRITORIO: Empresa = { id: 'e1', cnpj: '12345678000195', razao_social: 'Clínica Vida', active: true, codigo_servico_nacional: '041601' }
  const contexto = (parcial: Partial<ContextoDoLote> = {}): ContextoDoLote => ({
    empresas: [ESCRITORIO],
    bloqueios: new Map([['e1', null]]),
    modelos: new Map([[`e1:${CNPJ_TOMADOR}`, { codigo: '041001', descricao: 'Plano alimentar', email: null }]]),
    jaEmitidas: new Set(),
    codigosDaLista: new Set(LISTA.keys()),
    ...parcial,
  })
  const linha = (n: number, celulas: Record<string, Celula>) => ({ linha: n, celulas })
  const codigoDe = (p: Record<string, unknown>) => (p.servico as { codigo_servico_nacional: string } | undefined)?.codigo_servico_nacional

  it('a planilha de 6, de 8 e de 9 colunas é lida', () => {
    const seis = ['cnpj_prestador', 'cpf_cnpj_tomador', 'nome_tomador', 'email_tomador', 'valor', 'descricao']
    const oito = [...seis, 'iss_retido', 'inss_retido']
    for (const cabecalho of [seis, oito, [...oito, 'codigo_servico'], ['CPF/CNPJ Tomador', 'Nome Tomador', 'Valor', 'Código Serviço']]) {
      const grade: Celula[][] = [cabecalho, cabecalho.map((c) => (/valor/i.test(c) ? '100' : /cpf/i.test(c) ? CPF : /nome/i.test(c) ? 'Maria' : ''))]
      const planilha = interpretarGrade(grade, { prestadorObrigatorio: false })
      expect(planilha.ok).toBe(true)
    }
    expect(textoDasColunas({ desconhecidas: ['servico'], faltando: [], repetidas: [] })).toContain('codigo_servico (opcional')
  })

  it('o código da linha, depois o do cliente salvo, depois o da empresa; inválido ou fora da lista fica de fora', () => {
    const itens = validarLinhas(
      [
        linha(2, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '200', codigo_servico: '04.08.02' }),
        // Mesmo paciente e valor, outro serviço: não é linha repetida.
        linha(3, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '200', codigo_servico: '041001' }),
        linha(4, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '200', codigo_servico: 40802 }),
        linha(5, { cpf_cnpj_tomador: CNPJ_TOMADOR, nome_tomador: 'Empresa Cliente', valor: '300' }),
        linha(6, { cpf_cnpj_tomador: CNPJ_TOMADOR, nome_tomador: 'Empresa Cliente', valor: '310', codigo_servico: '04.08.02' }),
        linha(7, { cpf_cnpj_tomador: CPF_2, nome_tomador: 'João', valor: '150' }),
        linha(8, { cpf_cnpj_tomador: CPF_2, nome_tomador: 'João', valor: '150', codigo_servico: '99.99.99' }),
        linha(9, { cpf_cnpj_tomador: CPF_2, nome_tomador: 'João', valor: '150', codigo_servico: 'fisio' }),
      ],
      contexto(),
    )
    expect(itens.map((i) => [i.linha, i.problema, codigoDe(i.payload)])).toEqual([
      [2, null, '040802'],
      [3, null, '041001'],
      [4, 'LINHA_REPETIDA', '040802'],
      [5, null, '041001'],
      [6, null, '040802'],
      [7, null, '041601'],
      [8, 'CODIGO_SERVICO_FORA_DA_LISTA', undefined],
      [9, 'CODIGO_SERVICO_INVALIDO', undefined],
    ])
    expect(itens[2].igualA).toBe(2)
    expect(motivoDoProblema('CODIGO_SERVICO_FORA_DA_LISTA')).toContain('não está na lista nacional')
    expect(motivoDoProblema('CODIGO_SERVICO_INVALIDO')).toContain('04.03.01')

    const resumo = textoDoResumoDoLote({ arquivo: 'clinica.csv', itens, empresas: [ESCRITORIO], franquia: null })
    expect(resumo).toContain('Códigos de serviço: 04.08.02 (2 notas), 04.10.01 (2 notas), 04.16.01 (1 nota).')
    expect(resumo).toContain('- Linha 8: o codigo_servico não está na lista nacional de serviços: confira o código')
    expect(resumo).toContain('- Linha 9: codigo_servico inválido')
  })

  it('sem a lista nacional (site fora do ar), vale o formato; nota igual no mês conta o código', () => {
    const itens = validarLinhas(
      [
        linha(2, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '200', codigo_servico: '99.99.99' }),
        linha(3, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '200', codigo_servico: '04.08.02' }),
        linha(4, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '200' }),
      ],
      contexto({ codigosDaLista: null, jaEmitidas: new Set([`e1:${CPF}:20000:040802`]) }),
    )
    expect(itens.map((i) => [i.problema, codigoDe(i.payload)])).toEqual([
      [null, '999999'],
      ['JA_EMITIDA_NO_MES', '040802'],
      [null, '041601'],
    ])
  })

  it('empresa sem código padrão: a linha sem código fica de fora com o motivo', () => {
    const semCodigo = { ...ESCRITORIO, codigo_servico_nacional: null }
    const itens = validarLinhas(
      [linha(2, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '200' }), linha(3, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '250', codigo_servico: '041601' })],
      contexto({ empresas: [semCodigo], modelos: new Map() }),
    )
    expect(itens.map((i) => i.problema)).toEqual(['CODIGO_SERVICO_FALTANDO', null])
    expect(motivoDoProblema('CODIGO_SERVICO_FALTANDO', { empresa: 'Clínica Vida' })).toContain('preencha a coluna codigo_servico')
  })
})

// ---------------------------------------------------------------------------------------
// De ponta a ponta no banco local.

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

async function codigosDasNotas(tenantId: string) {
  const { rows } = await admin.db.query<{ codigo: string; documento: string }>(
    `select payload->'servico'->>'codigo_servico_nacional' as codigo, coalesce(payload->'tomador'->>'cpf', payload->'tomador'->>'cnpj') as documento
       from nofiscal.fiscal_invoices where tenant_id = $1 and external_id not like 'origem-modelo-%' order by payload->>'valor', 1`,
    [tenantId],
  )
  return rows
}

describe('planilha com codigo_servico, de ponta a ponta', () => {
  it('cada linha sai com o seu código; código fora da lista fica de fora', async () => {
    const certificado = sharedTestCertificate().certificado
    const e = await createEscritorio(admin.db, { certificado })
    escritorios.push(e)
    await criarModelo(admin.db, e.mae.tenant.id, { nome: 'Empresa Cliente', documento: CNPJ_TOMADOR, nomeTomador: 'Empresa Cliente', codigo: '041001' })
    const canais = canaisDouble()
    const midia = midiaDouble()
    const deps: ConversaDeps = {
      db: servico.db,
      whatsapp: canais.whatsapp,
      interprete: interpreteDouble({}).interprete,
      links: LINKS_DE_TESTE,
      midia: midia.midia,
      catalogo: catalogo(),
    }
    const csv = [
      'cpf_cnpj_tomador;nome_tomador;valor;codigo_servico',
      `${CPF};Maria Paciente;200,00;04.16.01`,
      `${CPF};Maria Paciente;200,00;04.08.02`,
      `${CNPJ_TOMADOR};Empresa Cliente;300,00;`,
      `${CPF_2};João Paciente;150,00;`,
      `${CPF_2};João Paciente;160,00;99.99.99`,
    ].join('\r\n')
    midia.guardar('m1', csv)
    await processarMensagem(deps, mensagemDePlanilha(e.mae.ownerPhone, 'clinica.csv', 'text/csv', 'm1'))
    const resumo = canais.whatsapps.at(-1)?.texto ?? ''
    expect(resumo).toContain('Prontas para emitir: 4')
    expect(resumo).toContain('Códigos de serviço:')
    expect(resumo).toContain('- Linha 6: o codigo_servico não está na lista nacional de serviços')

    await processarMensagem(deps, mensagemDeTexto(e.mae.ownerPhone, 'confirmar'))
    expect(canais.whatsapps.at(-1)?.texto).toContain('Emitindo 4 notas')
    expect(await codigosDasNotas(e.mae.tenant.id)).toEqual([
      { codigo: '010701', documento: CPF_2 },
      { codigo: '040802', documento: CPF },
      { codigo: '041601', documento: CPF },
      { codigo: '041001', documento: CNPJ_TOMADOR },
    ])
  })
})

describe('WhatsApp: código ou serviço no pedido', () => {
  async function cenario() {
    const s = await createSelfServiceTenant(admin.db)
    avulsos.push(s)
    await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
    return s
  }
  function conversa(roteiro: Record<string, Partial<Parsed> & Record<string, unknown>>, lista: Map<string, string> | null = LISTA) {
    const canais = canaisDouble()
    const deps: ConversaDeps = { db: servico.db, whatsapp: canais.whatsapp, interprete: interpreteDouble(roteiro).interprete, links: LINKS_DE_TESTE, catalogo: catalogo(lista) }
    return {
      enviar: (de: string, texto: string) => processarMensagem(deps, mensagemDeTexto(de, texto)),
      ultimaPara: (para: string) => canais.whatsapps.filter((m) => m.para === para && !ehPerguntaDeInfo(m.texto)).at(-1)?.texto ?? '',
    }
  }
  const modeloDaClinica = { nome: 'Clínica', documento: CNPJ_TOMADOR, nomeTomador: 'Clínica Saúde', email: 'fin@clinica.test', codigo: '041601', descricao: 'Atendimento' }

  it('o intérprete devolve o código em 6 dígitos e o serviço como escrito', () => {
    const parsed = validarParsed({ tomador: 'Maria', valor: '300', codigo_servico: '04.03.01', servico: 'fisioterapia', intencao: 'emitir' })
    expect(parsed.codigo_servico).toBe('040301')
    expect(parsed.servico).toBe('fisioterapia')
    expect(validarParsed({ codigo_servico: 'abc', intencao: 'emitir' }).codigo_servico).toBeNull()
  })

  it('cliente salvo com psicologia: "serviço de fisioterapia" sai com 04.08.02, e o cliente passa a repetir o código', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, modeloDaClinica)
    const c = conversa({
      'nota pra Clínica, 200, serviço de fisioterapia': { tomador: 'Clínica', valor: '200.00', servico: 'fisioterapia', intencao: 'emitir' },
      'nota pra Clínica, 150': { tomador: 'Clínica', valor: '150.00', intencao: 'emitir' },
    })
    await c.enviar(s.ownerPhone, 'nota pra Clínica, 200, serviço de fisioterapia')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Serviço: 04.08.02 Fisioterapia\n')
    await c.enviar(s.ownerPhone, 'confirmar')
    const resposta = c.ultimaPara(s.ownerPhone)
    expect(resposta).toContain(TEXTOS.emitindo)
    expect(resposta).toContain('Guardei o código 04.08.02 no cliente Clínica')
    expect(await codigosDasNotas(s.tenant.id)).toEqual([{ codigo: '040802', documento: CNPJ_TOMADOR }])
    const { rows } = await admin.db.query<{ codigo: string }>('select codigo_servico_nacional as codigo from nofiscal.fiscal_models where tenant_id = $1', [s.tenant.id])
    expect(rows).toEqual([{ codigo: '040802' }])

    // A próxima nota para a Clínica, sem citar serviço, repete o código.
    await c.enviar(s.ownerPhone, 'nota pra Clínica, 150')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Serviço: 04.08.02 Fisioterapia\n')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.emitindo)
  })

  it('cliente novo com "código 04.10.01": o resumo mostra o código e a descrição, e a nota sai com ele', async () => {
    const s = await cenario()
    const c = conversa({
      'nota de 300 pra Maria, código 04.10.01': { tomador: 'Maria', valor: '300.00', codigo_servico: '04.10.01', descricao: null, intencao: 'emitir' },
    })
    await c.enviar(s.ownerPhone, 'nota de 300 pra Maria, código 04.10.01')
    expect(c.ultimaPara(s.ownerPhone)).toContain('É a primeira nota para Maria')
    await c.enviar(s.ownerPhone, `${CPF} maria@paciente.test`)
    await c.enviar(s.ownerPhone, 'Plano alimentar')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Serviço: 04.10.01 Nutrição\nDescrição na nota: Plano alimentar')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await codigosDasNotas(s.tenant.id)).toEqual([{ codigo: '041001', documento: CPF }])
    // O pedido guarda o código: ao salvar o cliente (salvarModelo), é ele que vai para o modelo.
    const { rows: [pedido] } = await admin.db.query<{ conversa: Record<string, unknown> }>('select conversa from nofiscal.fiscal_requests where tenant_id = $1', [s.tenant.id])
    expect(pedido.conversa).toMatchObject({ servico: { codigo: '041001' }, modelo_nome: 'Maria' })
  })

  it('código fora da lista e serviço ambíguo não viram pedido; a correção troca o código', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, modeloDaClinica)
    const c = conversa({
      'nota pra Clínica, 200, código 99.99.99': { tomador: 'Clínica', valor: '200.00', codigo_servico: '999999', intencao: 'emitir' },
      'nota pra Clínica, 200, serviço de limpeza': { tomador: 'Clínica', valor: '200.00', servico: 'limpeza', intencao: 'emitir' },
      'nota pra Clínica, 200': { tomador: 'Clínica', valor: '200.00', intencao: 'emitir' },
      'código 04.08.02': { codigo_servico: '040802', intencao: 'outro' },
    })
    await c.enviar(s.ownerPhone, 'nota pra Clínica, 200, código 99.99.99')
    expect(c.ultimaPara(s.ownerPhone)).toContain('O código 99.99.99 não está na lista nacional de serviços.')
    await c.enviar(s.ownerPhone, 'nota pra Clínica, 200, serviço de limpeza')
    const ambiguo = c.ultimaPara(s.ownerPhone)
    expect(ambiguo).toContain('Achei mais de um serviço para "limpeza":')
    expect(ambiguo).toContain('- 07.10.01 ')
    expect(await pedidosDo(admin.db, s.tenant.id)).toEqual([])

    await c.enviar(s.ownerPhone, 'nota pra Clínica, 200')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Serviço: 04.16.01 Psicologia\n')
    await c.enviar(s.ownerPhone, 'corrigir')
    expect(c.ultimaPara(s.ownerPhone)).toBe(TEXTOS.oQueMuda)
    await c.enviar(s.ownerPhone, 'código 04.08.02')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Serviço: 04.08.02 Fisioterapia\n')
    await c.enviar(s.ownerPhone, 'confirmar')
    expect(await codigosDasNotas(s.tenant.id)).toEqual([{ codigo: '040802', documento: CNPJ_TOMADOR }])
  })

  it('descrição comum não troca o código: o serviço só vale quando a mensagem fala em serviço ou código', async () => {
    const s = await cenario()
    await criarModelo(admin.db, s.tenant.id, modeloDaClinica)
    // A IA leu "consultoria" como serviço; a mensagem não pede serviço nem código: fica o código do cliente.
    const c = conversa({ 'nota pra Clínica, 200, consultoria de outubro': { tomador: 'Clínica', valor: '200.00', descricao: 'Consultoria de outubro', servico: 'consultoria', intencao: 'emitir' } })
    await c.enviar(s.ownerPhone, 'nota pra Clínica, 200, consultoria de outubro')
    expect(c.ultimaPara(s.ownerPhone)).toContain('Serviço: 04.16.01 Psicologia\nDescrição na nota: Consultoria de outubro')
  })

  it('serviço ambíguo: fica o código que a empresa já usa; lista fora do ar: o código vale pelo formato', async () => {
    const naoDeveConsultar = async (): Promise<string[]> => {
      throw new Error('não precisava consultar')
    }
    expect(await codigoDoPedido(catalogo(), { codigo_servico: null, servico: 'limpeza' }, async () => ['071002', '041601'])).toEqual({ codigo: '071002' })
    expect(await codigoDoPedido(catalogo(null), { codigo_servico: '999999', servico: null }, naoDeveConsultar)).toEqual({ codigo: '999999' })
    expect(await codigoDoPedido(catalogo(null), { codigo_servico: null, servico: 'fisioterapia' }, naoDeveConsultar)).toMatchObject({
      texto: expect.stringContaining('Não consegui consultar a lista nacional de serviços'),
    })
    expect(await codigoDoPedido(catalogo(), { codigo_servico: null, servico: null }, naoDeveConsultar)).toBeNull()
  })
})
