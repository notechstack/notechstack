// Boas-vindas no WhatsApp (critério 29; Landing v2, lote C - boas-vindas: regras e textos).
// Uma pergunta só, guiada por `fiscal_tenants.onboarding_etapa`: conferir o cadastro. Com o "sim", o
// onboarding termina e a próxima mensagem já é um pedido de verdade.
// Até 04/11/2026 havia mais duas etapas (cliente mais frequente e nota de ensaio). O Lucca cortou as
// duas: quem acabou de assinar já chega querendo emitir, e elas pediam de novo dados que o pedido
// real pede. Tenants que ficaram parados em `boas_vindas_cliente` ou `boas_vindas_ensaio` são
// concluídos na próxima mensagem, que segue para o fluxo normal de pedido.
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { abrirBoasVindas, ETAPAS_ANTES_DA_ATIVACAO } from './ativacao.js'
import type { CatalogoDeServicos } from './catalogo-servicos.js'
import { ehNao, ehSim, limpa, responder, formatarCodigoServico, type Contexto } from './conversa.js'
import { LINHA_DA_PLANILHA, planoDeEscritorio } from './planos.js'

export const TEXTOS_BOAS_VINDAS = {
  antesDeEmitir: 'Antes de emitir, vamos terminar a configuração',
} as const

/** Etapas antigas, cortadas em 04/11/2026; quem estiver nelas é concluído na próxima mensagem. */
const ETAPAS_CORTADAS = ['boas_vindas_cliente', 'boas_vindas_ensaio'] as const

export const textoPronto = (cliente: string) =>
  `Pronto! Agora, para emitir uma nota, é só mandar uma mensagem aqui com o cliente e o valor, por exemplo: nota pra ${cliente}, 150 reais`

async function concluir(db: Queryable, tenantId: string, agora: Date): Promise<void> {
  await db.query(
    `update nofiscal.fiscal_tenants
        set onboarding_etapa = 'concluido', agente_conversa = agente_conversa - 'boas_vindas', updated_at = $2
      where id = $1`,
    [tenantId, agora],
  )
  logEvent('agente.onboarding_concluido', { tenant_id: tenantId })
}

/** Critério 29: a pergunta de conferência, montada com os dados atuais do tenant. */
export async function perguntaDeConferencia(db: Queryable, tenantId: string, catalogo?: CatalogoDeServicos): Promise<string> {
  const { rows } = await db.query<{ razao_social: string; codigo: string | null; importados: string }>(
    `select t.razao_social, t.codigo_servico_nacional as codigo,
            (select count(*) from nofiscal.fiscal_models m
              where m.tenant_id = t.id and m.origem in ('importacao_adn', 'importacao_pdf')) as importados
       from nofiscal.fiscal_tenants t where t.id = $1`,
    [tenantId],
  )
  const t = rows[0]
  const n = Number(t?.importados ?? 0)
  const descricao = t?.codigo && catalogo ? await catalogo.descricao(t.codigo).catch(() => null) : null
  const servico = t?.codigo ? `serviço ${formatarCodigoServico(t.codigo)}${descricao ? ` (${descricao})` : ''}` : 'serviço ainda não escolhido'
  return `Sua empresa: ${t?.razao_social ?? ''}, ${servico}, ${n} ${n === 1 ? 'cliente importado' : 'clientes importados'}. Está tudo certo?`
}

/** Um cliente que o dono já tem, para o exemplo do "Pronto!". */
async function clienteDeExemplo(db: Queryable, tenantId: string): Promise<string> {
  const { rows } = await db.query<{ nome: string }>(
    'select nome from nofiscal.fiscal_models where tenant_id = $1 order by created_at limit 1',
    [tenantId],
  )
  return rows[0]?.nome ?? 'seu cliente'
}

/**
 * Mensagem de um tenant com `onboarding_etapa` diferente de `concluido`. Devolve `true` quando a
 * mensagem foi respondida aqui; `false` quando o onboarding acabou de ser concluído e a mensagem
 * deve seguir para o fluxo normal de pedido.
 */
export async function conversarNasBoasVindas(ctx: Contexto, texto: string): Promise<boolean> {
  const { db } = ctx.deps
  const { rows } = await db.query<{ onboarding_etapa: string }>(
    'select onboarding_etapa from nofiscal.fiscal_tenants where id = $1',
    [ctx.tenantId],
  )
  if (!rows[0]) throw new Error('tenant do número não encontrado')
  const etapa = rows[0].onboarding_etapa

  if ((ETAPAS_ANTES_DA_ATIVACAO as readonly string[]).includes(etapa)) {
    await responder(ctx, `${TEXTOS_BOAS_VINDAS.antesDeEmitir}. Continue em ${ctx.links.conta}`)
    return true
  }
  if (etapa === 'clientes' || etapa === 'ativacao') {
    // O número foi ativado pela reserva antes de a pessoa terminar o site.
    await abrirBoasVindas(db, ctx.tenantId, ctx.agora)
    await responder(ctx, await perguntaDeConferencia(db, ctx.tenantId, ctx.deps.catalogo))
    return true
  }
  if ((ETAPAS_CORTADAS as readonly string[]).includes(etapa)) {
    await concluir(db, ctx.tenantId, ctx.agora)
    return false
  }
  if (etapa === 'boas_vindas_conferir') {
    await conferir(ctx, texto)
    return true
  }
  throw new Error(`etapa de onboarding desconhecida: ${etapa}`)
}

async function conferir(ctx: Contexto, texto: string): Promise<void> {
  const { db } = ctx.deps
  if (ehSim(texto)) {
    await concluir(db, ctx.tenantId, ctx.agora)
    const pronto = textoPronto(await clienteDeExemplo(db, ctx.tenantId))
    const { rows } = await db.query<{ plan: string }>('select plan from nofiscal.fiscal_tenants where id = $1', [ctx.tenantId])
    // Escritório: além do pedido avulso, a planilha com as notas do mês.
    await responder(ctx, planoDeEscritorio(rows[0]?.plan) ? [pronto, LINHA_DA_PLANILHA].join('\n') : pronto)
    return
  }
  if (ehNao(texto)) {
    await responder(ctx, `Corrija o que precisar em ${ctx.links.conta}. Quando terminar, me diga "pronto".`)
    return
  }
  if (limpa(texto) === 'pronto') {
    await responder(ctx, await perguntaDeConferencia(db, ctx.tenantId, ctx.deps.catalogo))
    return
  }
  await responder(ctx, `${TEXTOS_BOAS_VINDAS.antesDeEmitir}.\n${await perguntaDeConferencia(db, ctx.tenantId, ctx.deps.catalogo)}`)
}
