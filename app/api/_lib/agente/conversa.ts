// Conversa do agente no WhatsApp (critérios 11, 15 a 22, 28, 30 a 34 e 39). Máquina de
// estados determinística sobre `fiscal_requests` (Landing, lote B - estado da conversa):
// a IA só preenche `parsed` de uma mensagem nova; "confirmar", "sim", "não", o número da
// nota e o CPF/CNPJ e o e-mail do tomador são lidos aqui, por código. Emitir e cancelar só
// acontecem no "confirmar", pelo motor (`createOrGetInvoice` e `requestCancel`).
import { requestCancel } from '../cancel.js'
import type { Db, Queryable } from '../db.js'
import { createOrGetInvoice } from '../invoices.js'
import { logEvent } from '../log.js'
import type { InvoicePayload } from '../validation.js'
import { confirmarNumero, numeroPodeEmitir } from './cadastro.js'
import { whatsappComRetentativa, type EnviaWhatsApp } from './canais.js'
import { documentoNoTexto, emailNoTexto, formatarDocumento, formatarReais, tipoDoDocumento } from './documentos.js'
import { validarParsed, type Interprete, type Parsed } from './interprete.js'
import { linksDoSite, type Links } from './links.js'
import { lerPayload, numeroDaNota, payloadDaNota, type ServicoDoPedido, type TomadorDoPedido } from './notas.js'
import { dataBr, diaLocal, partesLocais } from './tempo.js'
import { desmarcar, marcarUmaVez } from './uma-vez.js'

export const VALIDADE_DO_PEDIDO_MS = 24 * 3600_000
export const MAX_CANDIDATAS = 5
export const DESCRICAO_PADRAO = 'Prestação de serviços'
export const WHATSAPP_COMERCIAL = 'https://wa.me/5511939289413'

export type MensagemRecebida = {
  /** `messages[].id` da Meta. */
  id: string
  /** Remetente em E.164. */
  de: string
  /** `messages[].type`: `text`, `document`, `image`… */
  tipo: string
  texto: string | null
  arquivo: { nome: string | null; mime: string | null } | null
}

/** Nome do CNPJ nos dados públicos (porta; sem cliente real neste lote). */
export interface ConsultaCnpj {
  razaoSocial(cnpj: string): Promise<string | null>
}

export type ConversaDeps = {
  db: Db
  whatsapp: EnviaWhatsApp
  interprete: Interprete
  links?: Links
  consultaCnpj?: ConsultaCnpj
  now?: () => Date
}

export const TEXTOS = {
  emitindo: 'Emitindo…',
  expirou: 'Esse pedido expirou. Me mande de novo',
  semPedido: 'Não há pedido aguardando confirmação. Me mande o pedido da nota, por exemplo: nota pra Prontia, 10 reais.',
  descartado: 'Pedido descartado. Me mande de novo com a correção.',
  faltaValor: 'Qual é o valor da nota? Me mande o tomador e o valor juntos, por exemplo: nota pra Prontia, 10 reais.',
  faltaTomador: 'Para quem é a nota? Me mande o tomador e o valor juntos, por exemplo: nota pra Prontia, 10 reais.',
  faltaTudo: 'Para quem é a nota e qual é o valor? Por exemplo: nota pra Prontia, 10 reais.',
  ajuda: 'Eu emito e cancelo notas fiscais. Por exemplo: "nota pra Prontia, 10 reais" ou "cancela a nota da Prontia de hoje".',
  naoEntendi: 'Não consegui entender agora. Tente de novo em alguns minutos.',
  soTexto: 'Por enquanto eu só leio mensagens de texto. Me mande o pedido escrito, por exemplo: nota pra Prontia, 10 reais.',
  escolherAntes: 'Antes, me diga o número da nota que você quer cancelar.',
  numeroConfirmado: 'Número confirmado. Você já pode pedir notas por aqui.',
  codigoRecusado: 'Esse código não vale (errado ou vencido). Peça um novo ao dono da conta no site da Nó.',
  modeloNaoSalvo: 'Ok, não salvei o modelo.',
} as const

const naoAutorizado = (links: Links) =>
  `Este número não está autorizado a emitir notas pela Nó. Crie sua conta e faça uma simulação no site: ${links.site}`

const recusaDeCertificado = (links: Links) =>
  `Por segurança, eu não recebo certificado pelo WhatsApp e não guardei o arquivo. Apague a mensagem com o arquivo e envie o certificado A1 na página segura: ${links.certificado}`

export function textoDoBloqueio(codigo: string, links: Links): string {
  switch (codigo) {
    case 'PAYMENT_NOT_APPROVED':
      return `Seu pagamento não foi aprovado. Atualize o cartão para continuar emitindo: ${links.assinatura}`
    case 'CERT_EXPIRED':
      return `Seu certificado venceu. Envie o novo na página segura: ${links.certificado}`
    case 'CERT_MISSING':
      return `Ainda não há certificado A1 cadastrado. Envie na página segura: ${links.certificado}`
    case 'NO_SUBSCRIPTION':
      return `Sua empresa ainda não tem assinatura. Assine para emitir: ${links.assinatura}`
    case 'SUBSCRIPTION_CANCELLED':
      return `Sua assinatura foi cancelada. Assine de novo para emitir: ${links.assinatura}`
    case 'FISCAL_CONFIG_MISSING':
      return `Falta concluir a configuração fiscal (código de serviço e percentual de tributos) no cadastro: ${links.site}`
    default:
      return `A emissão está desativada para a sua empresa. Fale com a Nó: ${WHATSAPP_COMERCIAL}`
  }
}

// ---------------------------------------------------------------------------------------
// Palavras lidas por código.

const semAcento = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
const limpa = (texto: string) => semAcento(texto).replace(/[.!?\s]+$/g, '')

export const ehConfirmar = (texto: string) => /^(confirmar|confirmo|confirma|confirmado|confirmada)$/.test(limpa(texto))
const ehSim = (texto: string) => /^(sim|s|pode|pode salvar|salvar|salva|quero|pode substituir|substituir|substitui)$/.test(limpa(texto))
const ehNao = (texto: string) => /^(nao|n|corrigir|corrige|cancelar|desistir|deixa|deixa pra la)$/.test(limpa(texto))

function ehCertificado(arquivo: MensagemRecebida['arquivo']): boolean {
  const nome = semAcento(arquivo?.nome ?? '')
  const mime = (arquivo?.mime ?? '').toLowerCase()
  return /\.(pfx|p12)$/.test(nome) || mime === 'application/x-pkcs12' || mime === 'application/pkcs12'
}

// ---------------------------------------------------------------------------------------
// Pedidos.

type Conversa = {
  tomador?: Partial<TomadorDoPedido>
  servico?: ServicoDoPedido
  valor?: string
  modelo_id?: string | null
  modelo_nome?: string
  candidatas?: { id: string; numero: string }[]
}

type Pedido = {
  id: string
  tenant_id: string
  phone_id: string
  kind: 'emitir' | 'cancelar'
  status: 'awaiting_confirmation' | 'confirmed' | 'expired' | 'rejected_by_user'
  etapa: 'dados_tomador' | 'confirmar' | 'escolher_nota' | 'salvar_modelo' | 'substituir_modelo' | null
  conversa: Conversa
  invoice_id: string | null
  expires_at: Date
}

const COLUNAS_DO_PEDIDO = 'id, tenant_id, phone_id, kind, status, etapa, conversa, invoice_id, expires_at'

type Contexto = {
  deps: ConversaDeps
  whatsapp: EnviaWhatsApp
  links: Links
  agora: Date
  para: string
  phoneId: string
  tenantId: string
  /** Pedido a que esta mensagem pertence (C39); `null` quando não pertence a nenhum. */
  pedidoId: string | null
  enviadas: number
}

async function responder(ctx: Pick<Contexto, 'whatsapp' | 'para'> & Partial<Contexto>, texto: string): Promise<void> {
  await ctx.whatsapp.enviarTexto(ctx.para, texto)
  if (ctx.enviadas !== undefined) ctx.enviadas++
}

async function ultimoPedido(db: Queryable, phoneId: string): Promise<Pedido | null> {
  const { rows } = await db.query<Pedido>(
    `select ${COLUNAS_DO_PEDIDO} from nofiscal.fiscal_requests where phone_id = $1 order by created_at desc, id desc limit 1`,
    [phoneId],
  )
  return rows[0] ?? null
}

async function criarPedido(
  ctx: Contexto,
  dados: {
    kind: 'emitir' | 'cancelar'
    etapa: NonNullable<Pedido['etapa']>
    parsed: Parsed
    conversa: Conversa
    invoiceId?: string | null
    tokens: { entrada: number; saida: number }
  },
): Promise<string> {
  // `created_at` é a ordem real de chegada (relógio do banco): a conversa responde ao pedido
  // mais recente, e dois pedidos no mesmo instante do relógio da conversa não podem empatar.
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `insert into nofiscal.fiscal_requests
       (tenant_id, phone_id, kind, status, parsed, expires_at, invoice_id, etapa, conversa,
        ai_input_tokens, ai_output_tokens, created_at, updated_at)
     values ($1, $2, $3, 'awaiting_confirmation', $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10, clock_timestamp(), $11)
     returning id`,
    [
      ctx.tenantId,
      ctx.phoneId,
      dados.kind,
      JSON.stringify(dados.parsed),
      new Date(ctx.agora.getTime() + VALIDADE_DO_PEDIDO_MS),
      dados.invoiceId ?? null,
      dados.etapa,
      JSON.stringify(dados.conversa),
      dados.tokens.entrada,
      dados.tokens.saida,
      ctx.agora,
    ],
  )
  ctx.pedidoId = rows[0].id
  return rows[0].id
}

async function atualizarPedido(db: Queryable, id: string, etapa: Pedido['etapa'], conversa: Conversa, agora: Date): Promise<void> {
  await db.query('update nofiscal.fiscal_requests set etapa = $2, conversa = $3::jsonb, updated_at = $4 where id = $1', [
    id,
    etapa,
    JSON.stringify(conversa),
    agora,
  ])
}

/** Soma as mensagens de WhatsApp (recebidas e enviadas) ao pedido (C39). */
export async function contarMensagens(db: Queryable, pedidoId: string, quantidade: number): Promise<void> {
  if (quantidade <= 0) return
  await db.query('update nofiscal.fiscal_requests set message_count = message_count + $2 where id = $1', [pedidoId, quantidade])
}

/** Tarefa agendada (worker) e checagem no "confirmar": pedido sem confirmação em 24h vira `expired`. */
export async function expirarPedidos(db: Queryable, agora: Date, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const { rowCount } = await db.query(
    `update nofiscal.fiscal_requests
        set status = 'expired', etapa = null, updated_at = $1
      where status = 'awaiting_confirmation' and expires_at <= $1
        and ($2::uuid[] is null or tenant_id = any($2::uuid[]))`,
    [agora, opcoes.tenantIds ?? null],
  )
  return rowCount
}

async function bloqueioDaEmissao(db: Queryable, tenantId: string): Promise<string | null> {
  const { rows } = await db.query<{ bloqueio: string | null }>('select nofiscal.emission_block($1) as bloqueio', [tenantId])
  return rows[0]?.bloqueio ?? null
}

// ---------------------------------------------------------------------------------------
// Textos montados.

export function textoDoResumo(tomador: TomadorDoPedido, servico: ServicoDoPedido, valor: string): string {
  return [
    'Resumo da nota:',
    `Tomador: ${tomador.nome}`,
    `${tipoDoDocumento(tomador.documento).toUpperCase()}: ${formatarDocumento(tomador.documento)}`,
    `Serviço: ${servico.codigo}`,
    `Descrição: ${servico.descricao}`,
    `Valor: ${formatarReais(valor)}`,
    'Confirma? Responda "confirmar" para emitir ou "corrigir" para descartar.',
  ].join('\n')
}

type Candidata = { id: string; numero: string; nome: string; valor: string | null; emitidaEm: Date }

const linhaDaCandidata = (c: Candidata) =>
  `nº ${c.numero} · ${c.nome} · ${c.valor ? formatarReais(c.valor) : '-'} · ${dataBr(c.emitidaEm)}`

const perguntaDeCancelamento = (c: Candidata) =>
  [
    `Nota nº ${c.numero}`,
    `Tomador: ${c.nome}`,
    `Valor: ${c.valor ? formatarReais(c.valor) : '-'}`,
    `Emitida em: ${dataBr(c.emitidaEm)}`,
    'Confirma o cancelamento? Responda "confirmar" para cancelar ou "não" para manter a nota.',
  ].join('\n')

// ---------------------------------------------------------------------------------------
// Entrada.

/**
 * Processa uma mensagem recebida, uma vez só por `messages[].id` (C23). Se algo falha, a
 * marca é desfeita e o erro sobe, para a Meta reentregar.
 */
export async function processarMensagem(deps: ConversaDeps, msg: MensagemRecebida): Promise<{ duplicada: boolean }> {
  const chave = `wa:${msg.id}`
  if (!(await marcarUmaVez(deps.db, chave))) return { duplicada: true }
  try {
    await tratar(deps, msg)
  } catch (error) {
    await desmarcar(deps.db, chave).catch(() => undefined)
    throw error
  }
  return { duplicada: false }
}

async function tratar(deps: ConversaDeps, msg: MensagemRecebida): Promise<void> {
  const whatsapp = whatsappComRetentativa(deps.whatsapp)
  const links = deps.links ?? linksDoSite()
  const agora = (deps.now ?? (() => new Date()))()
  const fora = { whatsapp, para: msg.de }

  // Critério 11: o A1 nunca entra pelo WhatsApp, de ninguém. A mídia nem é baixada.
  if (msg.tipo === 'document' && ehCertificado(msg.arquivo)) {
    logEvent('agente.certificado_recusado', { message_id: msg.id })
    await responder(fora, recusaDeCertificado(links))
    return
  }

  const numero = await numeroPodeEmitir(deps.db, msg.de)
  if (!numero) {
    await numeroSemPermissao(deps, msg, links, fora)
    return
  }
  if (msg.tipo !== 'text' || !msg.texto?.trim()) {
    await responder(fora, TEXTOS.soTexto)
    return
  }

  const ctx: Contexto = {
    deps,
    whatsapp,
    links,
    agora,
    para: msg.de,
    phoneId: numero.phoneId,
    tenantId: numero.tenantId,
    pedidoId: null,
    enviadas: 0,
  }
  const texto = msg.texto.trim()
  try {
    const pedido = await ultimoPedido(deps.db, ctx.phoneId)
    if (!(pedido && (await responderEtapa(ctx, pedido, texto)))) {
      if (ehConfirmar(texto)) await confirmarSemEtapa(ctx, pedido)
      else await novoPedido(ctx, texto)
    }
  } finally {
    // A mensagem recebida e as respostas contam no pedido a que pertencem (C39).
    if (ctx.pedidoId) await contarMensagens(deps.db, ctx.pedidoId, 1 + ctx.enviadas)
  }
}

/** Critério 21, e a confirmação de número autorizado pelo próprio WhatsApp (critério 4). */
async function numeroSemPermissao(
  deps: ConversaDeps,
  msg: MensagemRecebida,
  links: Links,
  fora: Pick<Contexto, 'whatsapp' | 'para'>,
): Promise<void> {
  const codigo = msg.tipo === 'text' ? msg.texto?.trim() ?? '' : ''
  if (/^\d{6}$/.test(codigo)) {
    const { rows } = await deps.db.query(
      `select 1 from nofiscal.fiscal_phones
        where phone_e164 = $1 and role = 'authorized' and verified_at is null and revoked_at is null`,
      [msg.de],
    )
    if (rows.length === 1) {
      const semEmail = {
        async enviar() {
          throw new Error('a confirmação de número não manda e-mail')
        },
      }
      const resultado = await confirmarNumero(
        { db: deps.db, whatsapp: deps.whatsapp, email: semEmail, now: deps.now },
        { telefone: msg.de, codigo },
      )
      await responder(fora, resultado.ok ? TEXTOS.numeroConfirmado : TEXTOS.codigoRecusado)
      return
    }
  }
  logEvent('agente.numero_nao_autorizado', { message_id: msg.id })
  await responder(fora, naoAutorizado(links))
}

// ---------------------------------------------------------------------------------------
// Respostas a uma etapa aberta.

async function responderEtapa(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  if (!pedido.etapa) return false

  if (pedido.status === 'awaiting_confirmation' && pedido.expires_at.getTime() <= ctx.agora.getTime()) {
    await expirarPedido(ctx.deps.db, pedido.id, ctx.agora)
    if (!ehConfirmar(texto)) return false
    ctx.pedidoId = pedido.id
    await responder(ctx, TEXTOS.expirou)
    return true
  }

  switch (pedido.etapa) {
    case 'confirmar':
      if (pedido.status !== 'awaiting_confirmation') return false
      if (ehConfirmar(texto)) {
        ctx.pedidoId = pedido.id
        await confirmar(ctx, pedido)
        return true
      }
      if (ehNao(texto)) {
        await descartar(ctx, pedido)
        return true
      }
      return false

    case 'dados_tomador':
      if (pedido.status !== 'awaiting_confirmation') return false
      if (ehNao(texto)) {
        await descartar(ctx, pedido)
        return true
      }
      return completarTomador(ctx, pedido, texto)

    case 'escolher_nota':
      if (pedido.status !== 'awaiting_confirmation') return false
      if (ehNao(texto)) {
        await descartar(ctx, pedido)
        return true
      }
      if (ehConfirmar(texto)) {
        ctx.pedidoId = pedido.id
        await responder(ctx, TEXTOS.escolherAntes)
        return true
      }
      return escolherNota(ctx, pedido, texto)

    case 'salvar_modelo':
    case 'substituir_modelo':
      if (pedido.status !== 'confirmed') return false
      if (ehSim(texto)) {
        ctx.pedidoId = pedido.id
        if (pedido.etapa === 'salvar_modelo') await salvarModelo(ctx, pedido)
        else await substituirModelo(ctx, pedido)
        return true
      }
      await atualizarPedido(ctx.deps.db, pedido.id, null, pedido.conversa, ctx.agora)
      if (ehNao(texto)) {
        ctx.pedidoId = pedido.id
        await responder(
          ctx,
          pedido.etapa === 'salvar_modelo' ? TEXTOS.modeloNaoSalvo : `Ok, mantive o modelo ${pedido.conversa.modelo_nome ?? ''} como estava.`,
        )
        return true
      }
      return false
  }
}

async function expirarPedido(db: Queryable, id: string, agora: Date): Promise<void> {
  await db.query(
    `update nofiscal.fiscal_requests set status = 'expired', etapa = null, updated_at = $2
      where id = $1 and status = 'awaiting_confirmation'`,
    [id, agora],
  )
}

async function descartar(ctx: Contexto, pedido: Pedido): Promise<void> {
  ctx.pedidoId = pedido.id
  await ctx.deps.db.query(
    `update nofiscal.fiscal_requests set status = 'rejected_by_user', etapa = null, updated_at = $2
      where id = $1 and status = 'awaiting_confirmation'`,
    [pedido.id, ctx.agora],
  )
  await responder(ctx, TEXTOS.descartado)
}

/** "confirmar" sem etapa aberta: pedido vencido (C19) ou nada a confirmar. */
async function confirmarSemEtapa(ctx: Contexto, ultimo: Pedido | null): Promise<void> {
  if (ultimo && ultimo.status === 'expired') {
    ctx.pedidoId = ultimo.id
    await responder(ctx, TEXTOS.expirou)
    return
  }
  await responder(ctx, TEXTOS.semPedido)
}

/** Critério 17 e 32: só aqui a nota é criada ou o cancelamento é pedido ao motor. */
async function confirmar(ctx: Contexto, pedido: Pedido): Promise<void> {
  const { db } = ctx.deps
  if (pedido.kind === 'emitir') {
    const bloqueio = await bloqueioDaEmissao(db, ctx.tenantId)
    if (bloqueio) {
      await responder(ctx, textoDoBloqueio(bloqueio, ctx.links))
      return
    }
    const { tomador, servico, valor } = pedido.conversa
    if (!tomador?.documento || !tomador.nome || !servico || !valor) throw new Error('pedido sem os dados do resumo')
    const criada = await db.transaction(async (tx) => {
      // Duas confirmações simultâneas: só uma muda o estado (Unresolved 14).
      const { rowCount } = await tx.query(
        `update nofiscal.fiscal_requests
            set status = 'confirmed', confirmed_at = $2, etapa = null, updated_at = $2
          where id = $1 and status = 'awaiting_confirmation' and expires_at > $2`,
        [pedido.id, ctx.agora],
      )
      if (rowCount !== 1) return null
      const payload = payloadDaNota(
        { documento: tomador.documento as string, nome: tomador.nome as string, email: tomador.email ?? null },
        servico,
        valor,
      )
      const nota = await createOrGetInvoice(tx, ctx.tenantId, { external_id: pedido.id, payload: payload as unknown as InvoicePayload })
      await tx.query('update nofiscal.fiscal_requests set invoice_id = $2 where id = $1', [pedido.id, nota.id])
      return nota
    })
    if (!criada) {
      await responder(ctx, TEXTOS.semPedido)
      return
    }
    logEvent('agente.pedido_confirmado', { request_id: pedido.id, invoice_id: criada.id })
    await responder(ctx, TEXTOS.emitindo)
    return
  }

  if (!pedido.invoice_id) throw new Error('pedido de cancelamento sem nota')
  const invoiceId = pedido.invoice_id
  const nota = await db.transaction(async (tx) => {
    const { rowCount } = await tx.query(
      `update nofiscal.fiscal_requests
          set status = 'confirmed', confirmed_at = $2, etapa = null, updated_at = $2
        where id = $1 and status = 'awaiting_confirmation' and expires_at > $2`,
      [pedido.id, ctx.agora],
    )
    if (rowCount !== 1) return null
    return requestCancel(tx, ctx.tenantId, invoiceId, ctx.agora)
  })
  if (!nota) {
    await responder(ctx, TEXTOS.semPedido)
    return
  }
  const numero = pedido.conversa.candidatas?.find((c) => c.id === invoiceId)?.numero ?? ''
  if (nota.status === 'cancel_requested' || nota.status === 'skipped') {
    logEvent('agente.cancelamento_confirmado', { request_id: pedido.id, invoice_id: invoiceId })
    await responder(ctx, `Pedido de cancelamento da nota nº ${numero} enviado. Eu te aviso quando a Sefin confirmar.`)
  } else {
    await responder(ctx, `A nota nº ${numero} não pode ser cancelada agora (situação: ${nota.status}).`)
  }
}

async function completarTomador(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  const documento = documentoNoTexto(texto)
  const email = emailNoTexto(texto)
  if (!documento && !email) {
    // Parece um CPF ou CNPJ, mas os dígitos verificadores não batem.
    if (texto.replace(/\D/g, '').length < 11) return false
    ctx.pedidoId = pedido.id
    await responder(ctx, 'Esse CPF ou CNPJ não é válido. Confira os números e me mande de novo, com o e-mail do tomador.')
    return true
  }
  ctx.pedidoId = pedido.id

  const conversa: Conversa = { ...pedido.conversa, tomador: { ...pedido.conversa.tomador } }
  const tomador = conversa.tomador as Partial<TomadorDoPedido>
  if (documento) tomador.documento = documento
  if (email) tomador.email = email
  const nomeEscrito = tomador.nome ?? 'o tomador'

  if (!tomador.documento) {
    await atualizarPedido(ctx.deps.db, pedido.id, 'dados_tomador', conversa, ctx.agora)
    await responder(ctx, `Falta o CPF ou CNPJ de ${nomeEscrito}. Me mande o CPF ou CNPJ e o e-mail do tomador.`)
    return true
  }
  if (!tomador.email) {
    await atualizarPedido(ctx.deps.db, pedido.id, 'dados_tomador', conversa, ctx.agora)
    await responder(ctx, `Falta o e-mail de ${nomeEscrito}. Me mande o e-mail do tomador.`)
    return true
  }
  // Critério 18: para CNPJ, o nome vem dos dados públicos; para CPF, do que a pessoa escreveu.
  if (documento && tipoDoDocumento(documento) === 'cnpj' && ctx.deps.consultaCnpj) {
    const razao = await ctx.deps.consultaCnpj.razaoSocial(documento).catch(() => null)
    if (razao) tomador.nome = razao.trim().slice(0, 150)
  }
  await atualizarPedido(ctx.deps.db, pedido.id, 'confirmar', conversa, ctx.agora)
  await responder(ctx, textoDoResumo(tomador as TomadorDoPedido, conversa.servico as ServicoDoPedido, conversa.valor as string))
  return true
}

async function escolherNota(ctx: Contexto, pedido: Pedido, texto: string): Promise<boolean> {
  const m = /^\D*(\d{1,15})\D*$/.exec(texto)
  if (!m) return false
  ctx.pedidoId = pedido.id
  const candidatas = pedido.conversa.candidatas ?? []
  const escolhida = candidatas.find((c) => c.numero === String(BigInt(m[1])))
  if (!escolhida) {
    await responder(ctx, `Não achei a nota nº ${m[1]} entre as candidatas. Me mande um destes números: ${candidatas.map((c) => c.numero).join(', ')}.`)
    return true
  }
  const [nota] = await buscarNotas(ctx.deps.db, ctx.tenantId, { ids: [escolhida.id] })
  if (!nota) {
    await responder(ctx, `A nota nº ${escolhida.numero} não está mais emitida. Me mande o pedido de novo.`)
    return true
  }
  await ctx.deps.db.query(
    `update nofiscal.fiscal_requests set invoice_id = $2, etapa = 'confirmar', updated_at = $3 where id = $1`,
    [pedido.id, nota.id, ctx.agora],
  )
  await responder(ctx, perguntaDeCancelamento(nota))
  return true
}

// ---------------------------------------------------------------------------------------
// Modelos (critérios 30 e 31).

async function salvarModelo(ctx: Contexto, pedido: Pedido): Promise<void> {
  const { tomador, servico, modelo_nome: nome } = pedido.conversa
  if (!tomador?.documento || !tomador.nome || !servico || !nome || !pedido.invoice_id) throw new Error('pedido sem dados de modelo')
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `insert into nofiscal.fiscal_models
       (tenant_id, nome, tomador_documento, tomador_nome, tomador_email, codigo_servico_nacional, descricao,
        created_from_invoice_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     on conflict (tenant_id, (lower(nome))) do nothing
     returning id`,
    [ctx.tenantId, nome, tomador.documento, tomador.nome, tomador.email ?? null, servico.codigo, servico.descricao, pedido.invoice_id, ctx.agora],
  )
  if (rows[0]) {
    await atualizarPedido(ctx.deps.db, pedido.id, null, pedido.conversa, ctx.agora)
    await responder(ctx, `Modelo ${nome} salvo. Da próxima vez, é só escrever: nota pra ${nome}, e o valor.`)
    return
  }
  const existente = await ctx.deps.db.query<{ nome: string }>(
    'select nome from nofiscal.fiscal_models where tenant_id = $1 and lower(nome) = lower($2)',
    [ctx.tenantId, nome],
  )
  await atualizarPedido(ctx.deps.db, pedido.id, 'substituir_modelo', pedido.conversa, ctx.agora)
  await responder(
    ctx,
    `Já existe um modelo ${existente.rows[0]?.nome ?? nome}. Quer substituir pelo de ${tomador.nome} (${formatarDocumento(tomador.documento)})? Responda sim ou não.`,
  )
}

async function substituirModelo(ctx: Contexto, pedido: Pedido): Promise<void> {
  const { tomador, servico, modelo_nome: nome } = pedido.conversa
  if (!tomador?.documento || !tomador.nome || !servico || !nome || !pedido.invoice_id) throw new Error('pedido sem dados de modelo')
  await ctx.deps.db.query(
    `update nofiscal.fiscal_models
        set nome = $3, tomador_documento = $4, tomador_nome = $5, tomador_email = $6, tomador_whatsapp = null,
            codigo_servico_nacional = $7, descricao = $8, valor_padrao = null, created_from_invoice_id = $9, updated_at = $10
      where tenant_id = $1 and lower(nome) = lower($2)`,
    [ctx.tenantId, nome, nome, tomador.documento, tomador.nome, tomador.email ?? null, servico.codigo, servico.descricao, pedido.invoice_id, ctx.agora],
  )
  await atualizarPedido(ctx.deps.db, pedido.id, null, pedido.conversa, ctx.agora)
  await responder(ctx, `Modelo ${nome} substituído.`)
}

type Modelo = {
  id: string
  nome: string
  tomador_documento: string
  tomador_nome: string
  tomador_email: string | null
  codigo_servico_nacional: string
  descricao: string
  valor_padrao: string | null
}

/** Landing, lote B - conversa: nome do modelo, documento, nome do tomador, prefixo. */
async function resolverModelo(db: Queryable, tenantId: string, parsed: Parsed): Promise<Modelo | { ambiguos: string[] } | null> {
  const { rows: modelos } = await db.query<Modelo>(
    `select id, nome, tomador_documento, tomador_nome, tomador_email, codigo_servico_nacional, descricao, valor_padrao::text
       from nofiscal.fiscal_models where tenant_id = $1 order by nome`,
    [tenantId],
  )
  const minusculo = (s: string) => s.toLowerCase()
  let achados: Modelo[] = []
  if (parsed.modelo) achados = modelos.filter((m) => minusculo(m.nome) === minusculo(parsed.modelo as string))
  if (!achados.length && parsed.documento) achados = modelos.filter((m) => m.tomador_documento === parsed.documento)
  if (!achados.length && parsed.tomador) {
    const t = minusculo(parsed.tomador)
    achados = modelos.filter((m) => minusculo(m.nome) === t || minusculo(m.tomador_nome) === t)
    if (!achados.length) achados = modelos.filter((m) => t.startsWith(`${minusculo(m.nome)} `))
  }
  if (achados.length > 1) return { ambiguos: achados.map((m) => m.nome) }
  const modelo = achados[0]
  if (!modelo) return null
  // Documento escrito diferente do modelo: é outro tomador.
  if (parsed.documento && parsed.documento !== modelo.tomador_documento) return null
  return modelo
}

// ---------------------------------------------------------------------------------------
// Mensagem nova: a IA interpreta, o código decide.

async function novoPedido(ctx: Contexto, texto: string): Promise<void> {
  let parsed: Parsed
  let tokens: { entrada: number; saida: number }
  try {
    const resultado = await ctx.deps.interprete.interpretar(texto)
    parsed = validarParsed(resultado.parsed)
    tokens = {
      entrada: Math.max(0, Math.trunc(Number(resultado.tokens?.entrada) || 0)),
      saida: Math.max(0, Math.trunc(Number(resultado.tokens?.saida) || 0)),
    }
  } catch (error) {
    logEvent('agente.interprete_falhou', { error_name: error instanceof Error ? error.name : 'unknown' })
    await responder(ctx, TEXTOS.naoEntendi)
    return
  }
  const semPedido = () => logEvent('agente.ia_sem_pedido', { tokens_entrada: tokens.entrada, tokens_saida: tokens.saida, intencao: parsed.intencao })

  if (parsed.intencao === 'cancelar') {
    await novoCancelamento(ctx, texto, parsed, tokens, semPedido)
    return
  }
  if (parsed.intencao !== 'emitir') {
    semPedido()
    await responder(ctx, TEXTOS.ajuda)
    return
  }

  const bloqueio = await bloqueioDaEmissao(ctx.deps.db, ctx.tenantId)
  if (bloqueio) {
    semPedido()
    await responder(ctx, textoDoBloqueio(bloqueio, ctx.links))
    return
  }

  const modelo = await resolverModelo(ctx.deps.db, ctx.tenantId, parsed)
  if (modelo && 'ambiguos' in modelo) {
    semPedido()
    await responder(ctx, `Achei mais de um modelo: ${modelo.ambiguos.join(', ')}. Me mande o pedido de novo com o nome do modelo.`)
    return
  }
  const valor = parsed.valor ?? (modelo?.valor_padrao ? (validarParsed({ valor: modelo.valor_padrao }).valor ?? null) : null)
  const nome = modelo?.tomador_nome ?? parsed.tomador
  if (!nome || !valor) {
    semPedido()
    await responder(ctx, !nome && !valor ? TEXTOS.faltaTudo : !valor ? TEXTOS.faltaValor : TEXTOS.faltaTomador)
    return
  }

  if (modelo) {
    const tomador: TomadorDoPedido = { documento: modelo.tomador_documento, nome: modelo.tomador_nome, email: modelo.tomador_email }
    const servico: ServicoDoPedido = { codigo: modelo.codigo_servico_nacional, descricao: modelo.descricao }
    await criarPedido(ctx, { kind: 'emitir', etapa: 'confirmar', parsed, tokens, conversa: { tomador, servico, valor, modelo_id: modelo.id } })
    await responder(ctx, textoDoResumo(tomador, servico, valor))
    return
  }

  // Tomador novo (critério 18): código do tenant e descrição padrão; documento e e-mail pela conversa.
  const { rows } = await ctx.deps.db.query<{ codigo: string }>(
    'select codigo_servico_nacional as codigo from nofiscal.fiscal_tenants where id = $1',
    [ctx.tenantId],
  )
  const conversa: Conversa = {
    tomador: { nome, documento: parsed.documento ?? undefined },
    servico: { codigo: rows[0].codigo, descricao: DESCRICAO_PADRAO },
    valor,
    modelo_id: null,
    modelo_nome: nome.slice(0, 60).trim(),
  }
  await criarPedido(ctx, { kind: 'emitir', etapa: 'dados_tomador', parsed, tokens, conversa })
  await responder(
    ctx,
    parsed.documento
      ? `É a primeira nota para ${nome}. Me mande o e-mail do tomador.`
      : `É a primeira nota para ${nome}. Me mande o CPF ou CNPJ e o e-mail do tomador.`,
  )
}

// ---------------------------------------------------------------------------------------
// Cancelamento (critérios 32 a 34).

/** "hoje", "ontem" ou "dd/mm[/aaaa]" no texto → `aaaa-mm-dd` local. */
function dataNoTexto(texto: string, agora: Date): string | null {
  const t = semAcento(texto)
  if (/\bhoje\b/.test(t)) return diaLocal(agora)
  if (/\bontem\b/.test(t)) return diaLocal(new Date(agora.getTime() - 24 * 3600_000))
  const m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/.exec(t)
  if (!m) return null
  const ano = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : partesLocais(agora).ano
  const mes = Number(m[2])
  const dia = Number(m[1])
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
}

const escaparLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

async function buscarNotas(
  db: Queryable,
  tenantId: string,
  filtro: { ids?: string[]; documentos?: string[]; nomes?: string[]; dia?: string | null },
): Promise<Candidata[]> {
  const porTomador = Boolean(filtro.documentos?.length || filtro.nomes?.length)
  const { rows } = await db.query<{ id: string; dps_numero: string | null; xml_nfse: string | null; issued_at: Date; payload: unknown }>(
    `select i.id, i.dps_numero, i.xml_nfse, i.issued_at, i.payload
       from nofiscal.fiscal_invoices i
      where i.tenant_id = $1
        and i.status = 'issued'
        and i.issued_at is not null
        and ($2::uuid[] is null or i.id = any($2::uuid[]))
        and (not $3::boolean
             or coalesce(i.payload->'tomador'->>'cpf', i.payload->'tomador'->>'cnpj') = any($4::text[])
             or lower(i.payload->'tomador'->>'nome') like any($5::text[]))
        and ($6::date is null or (i.issued_at at time zone 'America/Sao_Paulo')::date = $6::date)
      order by i.issued_at desc, i.id
      limit $7`,
    [
      tenantId,
      filtro.ids ?? null,
      porTomador,
      filtro.documentos ?? [],
      (filtro.nomes ?? []).map((n) => `${escaparLike(n.toLowerCase())}%`),
      filtro.dia ?? null,
      MAX_CANDIDATAS,
    ],
  )
  return rows.map((r) => {
    const p = lerPayload(r.payload)
    return { id: r.id, numero: numeroDaNota(r), nome: p.nome, valor: p.valor, emitidaEm: r.issued_at }
  })
}

async function novoCancelamento(
  ctx: Contexto,
  texto: string,
  parsed: Parsed,
  tokens: { entrada: number; saida: number },
  semPedido: () => void,
): Promise<void> {
  const documentos = new Set<string>()
  const nomes = new Set<string>()
  if (parsed.documento) documentos.add(parsed.documento)
  if (parsed.tomador) nomes.add(parsed.tomador)
  if (parsed.modelo || parsed.tomador || parsed.documento) {
    const modelo = await resolverModelo(ctx.deps.db, ctx.tenantId, parsed)
    if (modelo && !('ambiguos' in modelo)) {
      documentos.add(modelo.tomador_documento)
      nomes.add(modelo.tomador_nome)
    }
  }
  const dia = dataNoTexto(texto, ctx.agora)
  const candidatas = await buscarNotas(ctx.deps.db, ctx.tenantId, { documentos: [...documentos], nomes: [...nomes], dia })

  if (!candidatas.length) {
    semPedido()
    const quem = parsed.tomador ?? parsed.modelo
    await responder(ctx, `Não achei nota emitida${quem ? ` para ${quem}` : ''}${dia ? ` em ${dia.split('-').reverse().join('/')}` : ''}.`)
    return
  }
  const conversa: Conversa = { candidatas: candidatas.map((c) => ({ id: c.id, numero: c.numero })) }
  if (candidatas.length === 1) {
    await criarPedido(ctx, { kind: 'cancelar', etapa: 'confirmar', parsed, tokens, conversa, invoiceId: candidatas[0].id })
    await responder(ctx, perguntaDeCancelamento(candidatas[0]))
    return
  }
  await criarPedido(ctx, { kind: 'cancelar', etapa: 'escolher_nota', parsed, tokens, conversa })
  await responder(
    ctx,
    ['Achei mais de uma nota. Qual delas você quer cancelar? Me mande o número.', ...candidatas.map(linhaDaCandidata)].join('\n'),
  )
}
