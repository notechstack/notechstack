// Intérprete por Claude. Checks C49 e C56d de .checks/agente-fiscal-v2.md (lote D). A API da
// Anthropic é um servidor local alcançado pelo SDK oficial via `ANTHROPIC_BASE_URL`; o banco é o
// local, com o código da conversa no papel `nofiscal_service`, como na v1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createSelfServiceTenant,
  criarModelo,
  dropSelfServiceTenant,
  LINKS_DE_TESTE,
  mensagemDeTexto,
  openRoleDb,
  pedidosDo,
  roleDatabaseUrl,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { iniciarDubleIa, textoDoUsuario, type DubleIa } from '../../_tests/anthropic-fake.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { closeSharedDb } from '../db.js'
import { iaFromEnv, MODELO_PADRAO } from '../ia/claude.js'
import { conversaFromEnv, interpreteFromEnv } from './ambiente.js'
import { processarMensagem } from './conversa.js'
import { InterpreteNaoConfigurado } from './interprete.js'

const PEDIDO = 'nota pra Prontia Saúde, 10 reais'
const MODELO_DO_AMBIENTE = 'claude-modelo-de-teste'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []
let ia: DubleIa

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
  ia = await iniciarDubleIa((chamada) =>
    textoDoUsuario(chamada) === PEDIDO
      ? // Uma IA que obedece ao schema; o campo a mais prova que o código descarta o que sobra.
        { json: { tomador: 'Prontia Saúde', documento: null, valor: '10.00', modelo: null, intencao: 'emitir', emitir_agora: true }, tokens: { entrada: 321, saida: 45 } }
      : { status: 500, erro: 'pedido fora do roteiro' },
  )
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await ia.fechar()
  await closeSharedDb()
  await servico.pool.end()
  await admin.pool.end()
})

const ambienteComChave = () => ({
  ANTHROPIC_API_KEY: 'sk-ant-chave-de-teste',
  AGENTE_FISCAL_IA_MODELO: MODELO_DO_AMBIENTE,
  ANTHROPIC_BASE_URL: ia.url,
})

/** Roda `fn` com variáveis de ambiente trocadas e devolve tudo como estava. */
async function comAmbiente<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const antes = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('intérprete por Claude', () => {
  it('interpreta pelo claude', async () => {
    // Com chave e modelo: a mensagem vira o parsed esperado, validado pelo código.
    const antes = ia.chamadas.length
    const resultado = await interpreteFromEnv(ambienteComChave()).interpretar(PEDIDO)
    expect(resultado).toEqual({
      parsed: { tomador: 'Prontia Saúde', documento: null, valor: '10.00', modelo: null, descricao: null, intencao: 'emitir' },
      tokens: { entrada: 321, saida: 45 },
    })
    const chamada = ia.chamadas[antes]
    expect(chamada.path).toBe('/v1/messages')
    expect(chamada.apiKey).toBe('sk-ant-chave-de-teste')
    expect(chamada.corpo.model).toBe(MODELO_DO_AMBIENTE)
    expect(chamada.corpo.messages).toEqual([{ role: 'user', content: PEDIDO }])
    expect(chamada.corpo.output_config?.format?.type).toBe('json_schema')
    expect(chamada.corpo.output_config?.format?.schema).toMatchObject({
      required: ['tomador', 'documento', 'valor', 'modelo', 'descricao', 'intencao'],
      additionalProperties: false,
    })

    // Sem modelo no ambiente, vale o padrão do Unresolved 10.
    const semModelo = iaFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-chave-de-teste', ANTHROPIC_BASE_URL: ia.url })
    expect(semModelo?.modelo).toBe(MODELO_PADRAO)
    expect(MODELO_PADRAO).toBe('claude-haiku-4-5-20251001')

    // Os tokens são somados no pedido: a conversa do webhook, montada pelo ambiente, usa a IA.
    const s = await createSelfServiceTenant(admin.db)
    tenants.push(s)
    await assinarTenant(admin.db, s.tenant.id)
    await admin.db.query(`update nofiscal.fiscal_tenants set onboarding_etapa = 'concluido' where id = $1`, [s.tenant.id])
    await criarModelo(admin.db, s.tenant.id, { nome: 'Prontia', documento: '52998224725', nomeTomador: 'Prontia Saúde' })
    const canais = canaisDouble()
    const deps = await comAmbiente(
      {
        ...ambienteComChave(),
        WHATSAPP_ACCESS_TOKEN: 'token-de-teste',
        WHATSAPP_PHONE_NUMBER_ID: '123',
        NOFISCAL_DATABASE_URL: roleDatabaseUrl('nofiscal_service'),
      },
      () => conversaFromEnv(),
    )
    await processarMensagem({ ...deps, db: servico.db, whatsapp: canais.whatsapp, links: LINKS_DE_TESTE }, mensagemDeTexto(s.ownerPhone, PEDIDO))
    const [pedido] = await pedidosDo(admin.db, s.tenant.id)
    expect(pedido).toMatchObject({
      kind: 'emitir',
      status: 'awaiting_confirmation',
      parsed: { tomador: 'Prontia Saúde', documento: null, valor: '10.00', modelo: null, descricao: null, intencao: 'emitir' },
      ai_input_tokens: 321,
      ai_output_tokens: 45,
    })
    expect(canais.whatsapps.at(-1)?.texto).toContain('Resumo da nota:')

    // Sem a chave: o intérprete da v1, que não chama a IA.
    const chamadasAntes = ia.chamadas.length
    const desligado = interpreteFromEnv({ AGENTE_FISCAL_IA_MODELO: MODELO_DO_AMBIENTE, ANTHROPIC_BASE_URL: ia.url })
    await expect(desligado.interpretar(PEDIDO)).rejects.toBeInstanceOf(InterpreteNaoConfigurado)
    expect(iaFromEnv({ AGENTE_FISCAL_IA_MODELO: MODELO_DO_AMBIENTE })).toBeNull()
    expect(ia.chamadas).toHaveLength(chamadasAntes)
  })

  it('url oficial por padrão', async () => {
    await comAmbiente({ ANTHROPIC_BASE_URL: undefined }, () => {
      const cliente = iaFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-chave-de-teste' })?.cliente
      expect(cliente?.baseURL).toBe('https://api.anthropic.com')
    })
    // Vazia conta como ausente.
    await comAmbiente({ ANTHROPIC_BASE_URL: '' }, () => {
      const cliente = iaFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-chave-de-teste', ANTHROPIC_BASE_URL: '' })?.cliente
      expect(cliente?.baseURL).toBe('https://api.anthropic.com')
    })
    // Definida, é a usada (a demonstração e os testes apontam para o dublê).
    expect(iaFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-chave-de-teste', ANTHROPIC_BASE_URL: ia.url })?.cliente.baseURL).toBe(ia.url)
  })
})
