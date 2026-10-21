// Comandos leves no WhatsApp (critérios 44 e 46; Landing v2, lote C - comandos). Lidos por
// código, antes das boas-vindas e da IA, e só do número do dono. O cancelamento usa o contrato
// do lote B (`nofiscal.agendar_cancelamento`): a data mostrada antes do "confirmar" sai da mesma
// função, numa transação desfeita, para o app não repetir a regra do fim do período pago.
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { ehConfirmar, ehNao, responder, semAcento, type Contexto } from './conversa.js'
import { emailNoTexto } from './documentos.js'
import { dataBr } from './tempo.js'

export const TEXTOS_COMANDOS = {
  soPro: 'Disponível no plano Pro',
  soDono: 'Só o WhatsApp do dono da conta pode fazer isso.',
  semAssinatura: 'Não encontrei assinatura ativa para cancelar.',
  mantida: 'Ok, a assinatura continua.',
  canceladaNoTeste: 'Assinatura cancelada. Nada será cobrado.',
} as const

export const DIAS_DA_SEMANA = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'] as const
const NOMES_DOS_DIAS = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']

type Comando =
  | { tipo: 'cancelar_assinatura' }
  | { tipo: 'contador'; email: string | null }
  | { tipo: 'resumo'; frequencia: 'mensal' | 'semanal'; dia: number | null }

export function lerComando(texto: string): Comando | null {
  const t = semAcento(texto).replace(/[.!?\s]+$/g, '').replace(/\s+/g, ' ')
  if (/^cancelar (a )?assinatura$/.test(t)) return { tipo: 'cancelar_assinatura' }
  const contador = /^contador(?: (.+))?$/.exec(t)
  if (contador) return { tipo: 'contador', email: contador[1] ? emailNoTexto(contador[1]) : null }
  const resumo = /^resumo (mensal|semanal)(?: (.+))?$/.exec(t)
  if (resumo) {
    const frequencia = resumo[1] as 'mensal' | 'semanal'
    const arg = (resumo[2] ?? '').replace(/-feira$/, '').replace(/^dia /, '').trim()
    let dia: number | null = /^\d{1,2}$/.test(arg) ? Number(arg) : null
    if (frequencia === 'semanal' && dia === null) {
      const i = DIAS_DA_SEMANA.indexOf(arg as (typeof DIAS_DA_SEMANA)[number])
      dia = i >= 0 ? i + 1 : null
    }
    const valido = dia !== null && (frequencia === 'mensal' ? dia >= 1 && dia <= 28 : dia >= 1 && dia <= 7)
    return { tipo: 'resumo', frequencia, dia: valido ? dia : null }
  }
  return null
}

type Assinatura = { emTeste: boolean } | null

async function assinaturaAtual(db: Queryable, tenantId: string, agora: Date): Promise<Assinatura> {
  const { rows } = await db.query<{ em_teste: boolean }>(
    `select s.status = 'pendente' and t.trial_ends_at is not null and t.trial_ends_at > $2 as em_teste
       from nofiscal.fiscal_subscriptions s join nofiscal.fiscal_tenants t on t.id = s.tenant_id
      where s.tenant_id = $1 and s.status <> 'cancelada'
      order by s.created_at desc limit 1`,
    [tenantId, agora],
  )
  return rows[0] ? { emTeste: rows[0].em_teste } : null
}

type RespostaDoAgendamento = { status: 'agendado'; cancelamento_agendado_para: string } | { status: 'sem_assinatura' }

/** Pergunta à função do lote B qual seria a data, sem gravar (a transação é desfeita). */
async function previaDoCancelamento(ctx: Contexto): Promise<RespostaDoAgendamento> {
  const desfazer = new Error('prévia do cancelamento')
  let resposta: RespostaDoAgendamento | null = null
  try {
    await ctx.deps.db.transaction(async (tx) => {
      resposta = await agendar(tx, ctx.tenantId)
      throw desfazer
    })
  } catch (error) {
    if (error !== desfazer) throw error
  }
  if (!resposta) throw new Error('agendar_cancelamento sem resposta')
  return resposta
}

async function agendar(db: Queryable, tenantId: string): Promise<RespostaDoAgendamento> {
  const { rows } = await db.query<{ r: RespostaDoAgendamento }>("select nofiscal.agendar_cancelamento($1, 'whatsapp') as r", [tenantId])
  return rows[0].r
}

async function lerEstado(db: Queryable, tenantId: string): Promise<{ plan: string; comando: { tipo: string } | null }> {
  const { rows } = await db.query<{ plan: string; comando: { tipo: string } | null }>(
    `select plan, agente_conversa->'comando' as comando from nofiscal.fiscal_tenants where id = $1`,
    [tenantId],
  )
  return rows[0] ?? { plan: 'inicial', comando: null }
}

async function gravarComando(db: Queryable, tenantId: string, comando: { tipo: string } | null, agora: Date): Promise<void> {
  await db.query(
    `update nofiscal.fiscal_tenants
        set agente_conversa = case when $2::jsonb is null then agente_conversa - 'comando'
                                   else jsonb_set(agente_conversa, '{comando}', $2::jsonb) end,
            updated_at = $3
      where id = $1`,
    [tenantId, comando === null ? null : JSON.stringify(comando), agora],
  )
}

async function ehDono(db: Queryable, phoneId: string): Promise<boolean> {
  const { rows } = await db.query<{ role: string }>('select role from nofiscal.fiscal_phones where id = $1', [phoneId])
  return rows[0]?.role === 'owner'
}

/**
 * Trata o comando pendente e os comandos novos. `true` quando respondeu; `false` quando a
 * mensagem segue para as boas-vindas ou para a conversa de notas.
 */
export async function tratarComando(ctx: Contexto, texto: string): Promise<boolean> {
  const { db } = ctx.deps
  const estado = await lerEstado(db, ctx.tenantId)

  // O comando pendente vale só para a mensagem seguinte.
  if (estado.comando) {
    await gravarComando(db, ctx.tenantId, null, ctx.agora)
    if (estado.comando.tipo === 'cancelar_assinatura') {
      if (ehConfirmar(texto)) {
        await cancelarAssinatura(ctx)
        return true
      }
      if (ehNao(texto)) {
        await responder(ctx, TEXTOS_COMANDOS.mantida)
        return true
      }
    }
  }

  const comando = lerComando(texto)
  if (!comando) return false
  if (!(await ehDono(db, ctx.phoneId))) {
    await responder(ctx, TEXTOS_COMANDOS.soDono)
    return true
  }

  if (comando.tipo === 'cancelar_assinatura') {
    const previa = await previaDoCancelamento(ctx)
    if (previa.status !== 'agendado') {
      await responder(ctx, TEXTOS_COMANDOS.semAssinatura)
      return true
    }
    const assinatura = await assinaturaAtual(db, ctx.tenantId, ctx.agora)
    await gravarComando(db, ctx.tenantId, { tipo: 'cancelar_assinatura' }, ctx.agora)
    await responder(
      ctx,
      assinatura?.emTeste
        ? 'Você está no teste: a assinatura é cancelada agora e nada é cobrado. Responda "confirmar" para cancelar.'
        : `Cancelar a assinatura? Você emite até ${dataBr(new Date(previa.cancelamento_agendado_para))}. Responda "confirmar" para cancelar.`,
    )
    return true
  }

  if (estado.plan !== 'pro') {
    await responder(ctx, TEXTOS_COMANDOS.soPro)
    return true
  }

  if (comando.tipo === 'contador') {
    if (!comando.email) {
      await responder(ctx, 'Me mande o e-mail junto, por exemplo: contador maria@contabilidade.com.br')
      return true
    }
    await db.query('update nofiscal.fiscal_tenants set contador_email = $2, updated_at = $3 where id = $1', [
      ctx.tenantId,
      comando.email,
      ctx.agora,
    ])
    logEvent('agente.comando', { tenant_id: ctx.tenantId, comando: 'contador' })
    await responder(ctx, `Pronto: ${comando.email} vai receber cópia das notas.`)
    return true
  }

  if (comando.dia === null) {
    await responder(
      ctx,
      comando.frequencia === 'mensal'
        ? 'Escolha um dia de 1 a 28, por exemplo: resumo mensal 5'
        : 'Escolha um dia da semana de 1 (segunda) a 7 (domingo), por exemplo: resumo semanal segunda',
    )
    return true
  }
  await db.query(
    'update nofiscal.fiscal_tenants set resumo_frequencia = $2, resumo_dia = $3, updated_at = $4 where id = $1',
    [ctx.tenantId, comando.frequencia, comando.dia, ctx.agora],
  )
  logEvent('agente.comando', { tenant_id: ctx.tenantId, comando: `resumo_${comando.frequencia}` })
  await responder(
    ctx,
    comando.frequencia === 'mensal'
      ? `Pronto: resumo mensal todo dia ${comando.dia}, às 9h.`
      : `Pronto: resumo semanal toda ${NOMES_DOS_DIAS[comando.dia - 1]}, às 9h.`,
  )
  return true
}

async function cancelarAssinatura(ctx: Contexto): Promise<void> {
  const { db } = ctx.deps
  const assinatura = await assinaturaAtual(db, ctx.tenantId, ctx.agora)
  const resposta = await agendar(db, ctx.tenantId)
  if (resposta.status !== 'agendado') {
    await responder(ctx, TEXTOS_COMANDOS.semAssinatura)
    return
  }
  logEvent('agente.cancelamento_agendado', { tenant_id: ctx.tenantId, em_teste: Boolean(assinatura?.emTeste) })
  await responder(
    ctx,
    assinatura?.emTeste
      ? TEXTOS_COMANDOS.canceladaNoTeste
      : `Cancelamento agendado. Você emite até ${dataBr(new Date(resposta.cancelamento_agendado_para))}.`,
  )
}
