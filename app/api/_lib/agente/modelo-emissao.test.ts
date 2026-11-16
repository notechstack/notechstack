// "Qual é o modelo da planilha?" no WhatsApp (Lucca, 16/11/2026): a conta Escritório recebe o arquivo .xlsx, lido por
// código, sem a IA; se o envio falha, vai o link. As outras contas seguem para a conversa de pedidos. O arquivo que o
// agente manda é o mesmo publicado no site, e passa pelo leitor do lote. Banco local; WhatsApp e IA são dublês.
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  canaisDouble,
  createEscritorio,
  createSelfServiceTenant,
  dropEscritorio,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDeTexto,
  openRoleDb,
  type Escritorio,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { processarMensagem, TEXTOS } from './conversa.js'
import { interpretarGrade, lerPlanilha } from './lote.js'
import { ehPedidoDeModelo, MIME_DO_MODELO, modeloDeEmissao, NOME_DO_MODELO, TEXTOS_DO_MODELO } from './modelo-emissao.js'
import { MODELO_DA_PLANILHA } from './planos.js'

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

describe('pedido do modelo, lido por código', () => {
  it('reconhece quem pede o modelo da planilha', () => {
    for (const texto of [
      'modelo',
      'Modelo?',
      'me manda o modelo',
      'qual o modelo?',
      'qual é o modelo da planilha?',
      'Qual o modelo de planilha que funciona',
      'tem um exemplo de planilha?',
      'como é o formato da tabela',
      'manda a planilha modelo',
      'modelo do excel',
      'quero o modelo de emissão',
    ]) {
      expect(ehPedidoDeModelo(texto), texto).toBe(true)
    }
  })

  it('não rouba pedido de nota nem conversa comum', () => {
    for (const texto of [
      'nota pra Studio Lima, 350 reais',
      'nota modelo Studio Lima 350',
      'nota pelo modelo da planilha',
      'emite pelo modelo Studio Lima',
      'planilha',
      'vou mandar a planilha',
      'oi, tudo bem?',
      'cancela a nota da Studio Lima de hoje',
      'salvar modelo',
      'modelo 2',
    ]) {
      expect(ehPedidoDeModelo(texto), texto).toBe(false)
    }
  })
})

describe('o arquivo que o agente manda', () => {
  it('é o mesmo publicado no site', () => {
    const doSite = readFileSync(new URL('../../../../agentes/fiscal/dados/modelo-emissao.xlsx', import.meta.url))
    expect(Buffer.from(modeloDeEmissao()).equals(doSite)).toBe(true)
    expect(MODELO_DA_PLANILHA.endsWith('/agentes/fiscal/dados/modelo-emissao.xlsx')).toBe(true)
  })

  it('passa pelo leitor do lote: colunas do modelo e as duas linhas de exemplo', async () => {
    const grade = await lerPlanilha(modeloDeEmissao(), 'xlsx')
    const planilha = interpretarGrade(grade, { prestadorObrigatorio: true })
    expect(planilha.ok).toBe(true)
    if (!planilha.ok) return
    expect(planilha.colunas).toEqual(['cnpj_prestador', 'cpf_cnpj_tomador', 'nome_tomador', 'email_tomador', 'valor', 'descricao'])
    expect(planilha.linhas).toHaveLength(2)
  })
})

function agente(opcoes: { documentoFalha?: boolean } = {}) {
  const canais = canaisDouble()
  const ia = interpreteDouble({ 'qual é o modelo da planilha?': { intencao: 'outro' } })
  const whatsapp = opcoes.documentoFalha
    ? {
        ...canais.whatsapp,
        async enviarDocumento() {
          throw new Error('Meta fora do ar')
        },
      }
    : canais.whatsapp
  const deps = { db: servico.db, whatsapp, email: canais.email, interprete: ia.interprete, links: LINKS_DE_TESTE }
  return {
    ia,
    async texto(de: string, texto: string) {
      const antes = canais.whatsapps.length
      await processarMensagem(deps, mensagemDeTexto(de, texto))
      return canais.whatsapps.slice(antes)
    },
  }
}

describe('pedido do modelo na conversa', () => {
  it('conta Escritório recebe o .xlsx, sem passar pela IA', async () => {
    const e = await createEscritorio(admin.db, { empresas: [{ razaoSocial: 'Oficina Trilho Ltda' }] })
    escritorios.push(e)
    const a = agente()
    const respostas = await a.texto(e.mae.ownerPhone, 'Qual é o modelo da planilha?')
    expect(respostas).toHaveLength(1)
    expect(respostas[0].texto).toBe(TEXTOS_DO_MODELO.legenda)
    expect(respostas[0].anexo?.nome).toBe(NOME_DO_MODELO)
    expect(respostas[0].anexo?.tipo).toBe(MIME_DO_MODELO)
    expect(Buffer.from(respostas[0].anexo!.conteudo).equals(Buffer.from(modeloDeEmissao()))).toBe(true)
    expect(a.ia.chamadas).toEqual([])
  })

  it('se o envio do arquivo falha, responde com o link', async () => {
    const e = await createEscritorio(admin.db)
    escritorios.push(e)
    const a = agente({ documentoFalha: true })
    const respostas = await a.texto(e.mae.ownerPhone, 'modelo')
    expect(respostas).toHaveLength(1)
    expect(respostas[0].anexo).toBeUndefined()
    expect(respostas[0].texto).toBe(TEXTOS_DO_MODELO.link)
    expect(respostas[0].texto).toContain(MODELO_DA_PLANILHA)
  })

  it('conta que não é Escritório segue para a conversa de pedidos', async () => {
    const s = await createSelfServiceTenant(admin.db, { plan: 'pro' })
    avulsos.push(s)
    const a = agente()
    const respostas = await a.texto(s.ownerPhone, 'qual é o modelo da planilha?')
    expect(a.ia.chamadas).toEqual(['qual é o modelo da planilha?'])
    expect(respostas.map((r) => r.texto)).toEqual([TEXTOS.ajuda])
    expect(respostas[0].anexo).toBeUndefined()
  })
})
