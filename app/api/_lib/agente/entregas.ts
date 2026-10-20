// Entregas do agente (critérios 6 e 25 a 30). `destinatariosDoEmail` (lote A) decide **quem**
// recebe o e-mail: no Pro, o tomador e o contador recebem a cópia; no Inicial, só o dono. O
// dono é a conta com `fiscal_accounts.client_id` do tenant. O resto (lote B) entrega as
// transições do motor aos tenants self-service, no lugar do callback HTTP, e manda os avisos
// únicos de fila, certificado e limite (Landing, lote B - entregas, avisos e canais).
import { renderDanfse } from '../danfse-renderer.js'
import type { Queryable } from '../db.js'
import type { FinalStatus } from '../emission.js'
import { logEvent } from '../log.js'
import { emailComRetentativa, whatsappComRetentativa, type AnexoEmail, type EnviaEmail, type EnviaWhatsApp } from './canais.js'
import { contarMensagens } from './conversa.js'
import { formatarReais } from './documentos.js'
import { linksDoSite, type Links } from './links.js'
import { lerPayload, numeroDaNota } from './notas.js'
import { dataBr, horaDosAvisos, limitesDoMes, mesLocal, partesLocais } from './tempo.js'
import { marcarUmaVez } from './uma-vez.js'

export type PapelDoDestinatario = 'dono' | 'tomador' | 'contador'
export type Destinatario = { papel: PapelDoDestinatario; email: string }

export async function destinatariosDoEmail(
  db: Queryable,
  tenantId: string,
  opcoes: { tomadorEmail?: string | null },
): Promise<Destinatario[]> {
  const { rows } = await db.query<{ plan: string; contador_email: string | null; dono_email: string | null }>(
    `select t.plan, t.contador_email, a.email as dono_email
       from nofiscal.fiscal_tenants t
       left join nofiscal.fiscal_accounts a on a.client_id = t.client_id
      where t.id = $1`,
    [tenantId],
  )
  const tenant = rows[0]
  if (!tenant) return []

  const lista: Destinatario[] = []
  const incluir = (papel: PapelDoDestinatario, email: string | null | undefined) => {
    const limpo = email?.trim().toLowerCase()
    if (limpo && !lista.some((d) => d.email === limpo)) lista.push({ papel, email: limpo })
  }
  incluir('dono', tenant.dono_email)
  if (tenant.plan === 'pro') {
    incluir('tomador', opcoes.tomadorEmail)
    incluir('contador', tenant.contador_email)
  }
  return lista
}

// ---------------------------------------------------------------------------------------
// Lote B: transições da nota, avisos e limite.

export type EntregasDeps = {
  db: Queryable
  whatsapp: EnviaWhatsApp
  email: EnviaEmail
  links?: Links
  now?: () => Date
}

export const AVISO_DE_FILA = 'A Sefin está instável; a nota está na fila e eu te aviso quando sair'
export const AVISO_DE_LIMITE = 'Você passou do limite do seu plano este mês'

type Canais = { whatsapp: EnviaWhatsApp; email: EnviaEmail; links: Links; agora: Date }

function canaisDe(deps: EntregasDeps): Canais {
  return {
    whatsapp: whatsappComRetentativa(deps.whatsapp),
    email: emailComRetentativa(deps.email),
    links: deps.links ?? linksDoSite(),
    agora: (deps.now ?? (() => new Date()))(),
  }
}

type NotaDoAgente = {
  id: string
  tenant_id: string
  status: string
  payload: unknown
  dps_numero: string | null
  xml_nfse: string | null
  last_error_code: string | null
  last_error: string | null
  self_service: boolean
  dono_phone: string | null
}

async function lerNota(db: Queryable, invoiceId: string): Promise<NotaDoAgente | null> {
  const { rows } = await db.query<NotaDoAgente>(
    `select i.id, i.tenant_id, i.status, i.payload, i.dps_numero, i.xml_nfse, i.last_error_code, i.last_error,
            t.client_id is not null as self_service,
            (select p.phone_e164 from nofiscal.fiscal_phones p where p.tenant_id = t.id and p.role = 'owner') as dono_phone
       from nofiscal.fiscal_invoices i
       join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where i.id = $1`,
    [invoiceId],
  )
  return rows[0] ?? null
}

type PedidoDaNota = { id: string; kind: string; conversa: { modelo_id?: string | null; modelo_nome?: string }; phone: string | null }

/** Pedido mais recente do tipo que levou a nota a esta transição, e o número que pediu (se ainda emite). */
async function pedidoDaNota(db: Queryable, invoiceId: string, kind: 'emitir' | 'cancelar'): Promise<PedidoDaNota | null> {
  const { rows } = await db.query<PedidoDaNota>(
    `select r.id, r.kind, r.conversa,
            case when p.verified_at is not null and p.revoked_at is null then p.phone_e164 end as phone
       from nofiscal.fiscal_requests r
       join nofiscal.fiscal_phones p on p.id = r.phone_id
      where r.invoice_id = $1 and r.kind = $2
      order by r.created_at desc
      limit 1`,
    [invoiceId, kind],
  )
  return rows[0] ?? null
}

/** Manda ao dono e a quem pediu (se for outro número) e soma as mensagens ao pedido (C39). */
async function avisarNoWhatsApp(
  canais: Canais,
  db: Queryable,
  nota: NotaDoAgente,
  pedido: PedidoDaNota | null,
  mensagem: { texto: string; anexo?: AnexoEmail | null },
): Promise<void> {
  const numeros = [nota.dono_phone, pedido?.phone].filter((n, i, todos): n is string => Boolean(n) && todos.indexOf(n) === i)
  for (const para of numeros) {
    if (mensagem.anexo) await canais.whatsapp.enviarDocumento(para, mensagem.anexo, mensagem.texto)
    else await canais.whatsapp.enviarTexto(para, mensagem.texto)
  }
  if (pedido) await contarMensagens(db, pedido.id, numeros.length)
}

async function pdfDaNota(nota: NotaDoAgente, numero: string): Promise<AnexoEmail | null> {
  if (!nota.xml_nfse) return null
  try {
    const conteudo = await renderDanfse(nota.xml_nfse)
    return { nome: `nfse-${numero}.pdf`, tipo: 'application/pdf', conteudo }
  } catch (error) {
    logEvent('agente.pdf_falhou', { invoice_id: nota.id, error_name: error instanceof Error ? error.name : 'unknown' })
    return null
  }
}

/** O que corrigir, por código de rejeição (critério 26). */
function oQueCorrigir(codigo: string | null): string {
  if (codigo === 'SEFIN_UNAVAILABLE') return 'A Sefin ficou fora do ar e a nota não saiu. Me mande o pedido de novo mais tarde.'
  return 'O que corrigir: confira o dado indicado (no cadastro da empresa ou no pedido) e me mande o pedido de novo. A nota não é reenviada sozinha.'
}

/**
 * Transição final de uma nota de tenant self-service (Landing, lote B - destino do callback).
 * Chamada pelo worker no lugar do callback HTTP. Uma vez por nota e status.
 */
export async function entregarTransicao(deps: EntregasDeps, invoiceId: string, status: FinalStatus): Promise<void> {
  const nota = await lerNota(deps.db, invoiceId)
  if (!nota || !nota.self_service) return
  if (!(await marcarUmaVez(deps.db, `entrega:${invoiceId}:${status}`, nota.tenant_id))) return
  const canais = canaisDe(deps)
  const numero = numeroDaNota(nota)
  const tomador = lerPayload(nota.payload)

  if (status === 'issued') {
    const pedido = await pedidoDaNota(deps.db, invoiceId, 'emitir')
    const pdf = await pdfDaNota(nota, numero)
    const titulo = `NFS-e nº ${numero} autorizada`
    await avisarNoWhatsApp(canais, deps.db, nota, pedido, { texto: titulo, anexo: pdf })

    const anexos: AnexoEmail[] = []
    if (pdf) anexos.push(pdf)
    if (nota.xml_nfse) anexos.push({ nome: `nfse-${numero}.xml`, tipo: 'application/xml', conteudo: Buffer.from(nota.xml_nfse, 'utf8') })
    for (const destino of await destinatariosDoEmail(deps.db, nota.tenant_id, { tomadorEmail: tomador.email })) {
      await canais.email.enviar({
        para: destino.email,
        assunto: titulo,
        texto: `${titulo} para ${tomador.nome}${tomador.valor ? `, no valor de ${formatarReais(tomador.valor)}` : ''}. O PDF e o XML seguem anexos. A nota pode ser conferida em nfse.gov.br.`,
        anexos,
        idempotencia: `nfse-${invoiceId}-issued-${destino.email}`,
      })
    }

    // Critério 30: primeira nota para um tomador sem modelo.
    if (pedido?.phone && !pedido.conversa.modelo_id && pedido.conversa.modelo_nome) {
      await deps.db.query(`update nofiscal.fiscal_requests set etapa = 'salvar_modelo', updated_at = $2 where id = $1`, [
        pedido.id,
        canais.agora,
      ])
      await canais.whatsapp.enviarTexto(pedido.phone, `Salvar como modelo ${pedido.conversa.modelo_nome}?`)
      await contarMensagens(deps.db, pedido.id, 1)
    }
    await avisarLimite(deps, canais, nota)
    return
  }

  if (status === 'rejected') {
    const pedido = await pedidoDaNota(deps.db, invoiceId, 'emitir')
    const texto = [
      `A Sefin recusou a nota para ${tomador.nome}${tomador.valor ? ` (${formatarReais(tomador.valor)})` : ''}.`,
      `Código ${nota.last_error_code ?? '-'}: ${nota.last_error ?? 'sem motivo informado'}`,
      oQueCorrigir(nota.last_error_code),
    ].join('\n')
    await avisarNoWhatsApp(canais, deps.db, nota, pedido, { texto })
    return
  }

  if (status === 'cancelled') {
    const pedido = await pedidoDaNota(deps.db, invoiceId, 'cancelar')
    const texto = `Nota ${numero} cancelada`
    await avisarNoWhatsApp(canais, deps.db, nota, pedido, { texto })
    for (const destino of await destinatariosDoEmail(deps.db, nota.tenant_id, { tomadorEmail: tomador.email })) {
      await canais.email.enviar({
        para: destino.email,
        assunto: texto,
        texto: `A NFS-e nº ${numero} para ${tomador.nome}${tomador.valor ? `, de ${formatarReais(tomador.valor)}` : ''}, foi cancelada na Sefin Nacional.`,
        idempotencia: `nfse-${invoiceId}-cancelled-${destino.email}`,
      })
    }
    return
  }

  // cancel_refused (critério 34)
  const pedido = await pedidoDaNota(deps.db, invoiceId, 'cancelar')
  const texto = [
    `A Sefin recusou o cancelamento da nota nº ${numero}: ${nota.last_error ?? 'sem motivo informado'} (código ${nota.last_error_code ?? '-'}).`,
    'A nota continua valendo. Para cancelar, use o portal da prefeitura (Emissor Nacional) ou peça ao seu contador.',
  ].join('\n')
  await avisarNoWhatsApp(canais, deps.db, nota, pedido, { texto })
}

/** Critério 29: a nota sai; o dono é avisado uma vez por mês, e nunca durante o teste. */
async function avisarLimite(deps: EntregasDeps, canais: Canais, nota: NotaDoAgente): Promise<void> {
  const local = partesLocais(canais.agora)
  const { inicio, fim } = limitesDoMes(local.ano, local.mes)
  const { rows } = await deps.db.query<{ limite: number; emitidas: string; em_teste: boolean }>(
    `select t.monthly_note_limit as limite,
            (select count(*) from nofiscal.fiscal_invoices i
              where i.tenant_id = t.id and i.issued_at >= $2 and i.issued_at < $3) as emitidas,
            coalesce((select s.status = 'pendente' and t.trial_ends_at > $4
                        from nofiscal.fiscal_subscriptions s
                       where s.tenant_id = t.id
                       order by (s.status <> 'cancelada') desc, s.created_at desc
                       limit 1), false) as em_teste
       from nofiscal.fiscal_tenants t
      where t.id = $1`,
    [nota.tenant_id, inicio, fim, canais.agora],
  )
  const t = rows[0]
  if (!t || t.em_teste || Number(t.emitidas) <= t.limite || !nota.dono_phone) return
  if (!(await marcarUmaVez(deps.db, `limite:${nota.tenant_id}:${mesLocal(canais.agora)}`, nota.tenant_id))) return
  logEvent('agente.limite_passou', { tenant_id: nota.tenant_id, emitidas: Number(t.emitidas), limite: t.limite })
  await canais.whatsapp.enviarTexto(nota.dono_phone, `${AVISO_DE_LIMITE} (${t.limite} notas). As notas continuam saindo normalmente.`)
}

/** Critério 27: um aviso por nota que ficou na fila por instabilidade da Sefin. */
export async function avisarFila(deps: EntregasDeps, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select i.id
       from nofiscal.fiscal_invoices i
       join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where t.client_id is not null
        and i.status = 'sent'
        and i.last_error_code = 'SEFIN_UNAVAILABLE'
        and ($1::uuid[] is null or i.tenant_id = any($1::uuid[]))
        and not exists (select 1 from nofiscal.fiscal_agent_once o where o.chave = 'fila:' || i.id::text)`,
    [opcoes.tenantIds ?? null],
  )
  const canais = canaisDe(deps)
  let enviados = 0
  for (const { id } of rows) {
    const nota = await lerNota(deps.db, id)
    if (!nota || !(await marcarUmaVez(deps.db, `fila:${id}`, nota.tenant_id))) continue
    await avisarNoWhatsApp(canais, deps.db, nota, await pedidoDaNota(deps.db, id, 'emitir'), { texto: AVISO_DE_FILA })
    enviados++
  }
  return enviados
}

/** Critério 28: A1 a 30 dias ou menos de vencer, e vencido; um aviso de cada por certificado, a partir das 09:00. */
export async function avisarCertificados(deps: EntregasDeps, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const canais = canaisDe(deps)
  if (!horaDosAvisos(canais.agora)) return 0
  const { rows } = await deps.db.query<{ tenant_id: string; not_after: Date; dono_phone: string | null; dono_email: string | null }>(
    `select t.id as tenant_id, c.not_after,
            (select p.phone_e164 from nofiscal.fiscal_phones p where p.tenant_id = t.id and p.role = 'owner') as dono_phone,
            a.email as dono_email
       from nofiscal.fiscal_certificates c
       join nofiscal.fiscal_tenants t on t.id = c.tenant_id
       left join nofiscal.fiscal_accounts a on a.client_id = t.client_id
      where t.client_id is not null
        and t.active
        and c.not_after <= $1::timestamptz + interval '30 days'
        and ($2::uuid[] is null or t.id = any($2::uuid[]))`,
    [canais.agora, opcoes.tenantIds ?? null],
  )
  let enviados = 0
  for (const cert of rows) {
    const vencido = cert.not_after.getTime() <= canais.agora.getTime()
    const chave = `${vencido ? 'cert-vencido' : 'cert'}:${cert.tenant_id}:${cert.not_after.toISOString()}`
    if (!(await marcarUmaVez(deps.db, chave, cert.tenant_id))) continue
    const data = dataBr(cert.not_after)
    const texto = vencido
      ? `Seu certificado A1 venceu em ${data}. A emissão está pausada até você enviar o novo na página segura: ${canais.links.certificado}`
      : `Seu certificado A1 vence em ${data}. Envie o novo na página segura para não parar de emitir: ${canais.links.certificado}`
    if (cert.dono_phone) await canais.whatsapp.enviarTexto(cert.dono_phone, texto)
    if (cert.dono_email) {
      await canais.email.enviar({
        para: cert.dono_email,
        assunto: vencido ? 'Seu certificado A1 venceu' : `Seu certificado A1 vence em ${data}`,
        texto,
        idempotencia: chave,
      })
    }
    enviados++
  }
  return enviados
}
