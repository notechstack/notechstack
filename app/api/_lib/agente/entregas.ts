// Entregas do agente (critérios 6 e 25 a 30). `destinatariosDoEmail` (lote A) decide **quem**
// recebe o e-mail: no Pro e no Escritório (plano completo), o tomador e o contador recebem a cópia;
// no Inicial, só o dono. O dono é a conta com `fiscal_accounts.client_id` do tenant; numa empresa do
// escritório (`escritorio_tenant_id`), a conta e o contador são os da conta-mãe. O resto (lote B)
// entrega as transições do motor aos tenants self-service (e às empresas dos escritórios), no lugar do
// callback HTTP, e manda os avisos únicos de fila, certificado e limite (Landing, lote B - entregas,
// avisos e canais). Nota do lote por planilha: sem WhatsApp por nota nem oferta de modelo; o retorno
// vai agregado no fim (lote-retorno.ts). Toda tentativa de WhatsApp e e-mail de uma nota fica em
// `nofiscal.fiscal_invoice_entregas` (Registro de entregas, .design/agente-fiscal-escritorio.md).
import { renderDanfse } from '../danfse-renderer.js'
import type { Queryable } from '../db.js'
import type { FinalStatus } from '../emission.js'
import { logEvent } from '../log.js'
import {
  emailComRetentativa,
  saiuComRetentativa,
  whatsappComRetentativa,
  type AnexoEmail,
  type EnviaEmail,
  type EnviaWhatsApp,
} from './canais.js'
import { registrarEvento } from './central.js'
import { contarMensagens } from './conversa.js'
import { formatarDocumento, formatarReais } from './documentos.js'
import { linksDoSite, type Links } from './links.js'
import { lerPayload, numeroDaNota } from './notas.js'
import { dataBr, horaDosAvisos, limitesDoMes, mesLocal, partesLocais } from './tempo.js'
import { marcarUmaVez } from './uma-vez.js'

/** `escritorio` = a conta-mãe recebendo a cópia da nota de outra empresa do escritório. */
export type PapelDoDestinatario = 'dono' | 'tomador' | 'contador' | 'escritorio'
export type Destinatario = { papel: PapelDoDestinatario; email: string }

export async function destinatariosDoEmail(
  db: Queryable,
  tenantId: string,
  opcoes: { tomadorEmail?: string | null },
): Promise<Destinatario[]> {
  // Empresa do escritório: plano, conta (e-mail do login) e contador vêm da conta-mãe.
  const { rows } = await db.query<{ completo: boolean; do_escritorio: boolean; contador_email: string | null; dono_email: string | null }>(
    `select nofiscal.plano_completo(coalesce(m.plan, t.plan)) as completo,
            t.escritorio_tenant_id is not null as do_escritorio,
            coalesce(m.contador_email, t.contador_email) as contador_email,
            a.email as dono_email
       from nofiscal.fiscal_tenants t
       left join nofiscal.fiscal_tenants m on m.id = t.escritorio_tenant_id
       left join nofiscal.fiscal_accounts a on a.client_id = coalesce(m.client_id, t.client_id)
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
  incluir(tenant.do_escritorio ? 'escritorio' : 'dono', tenant.dono_email)
  if (tenant.completo) {
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

export const AVISO_DE_FILA = 'A Sefin está instável; a nota está na fila e eu te aviso quando sair.'
export const AVISO_DE_LIMITE = 'Você passou do limite do seu plano este mês'

/** `whatsapp` e `email` com retentativa (nunca lançam); `brutos` para quem precisa saber se saiu. */
type Canais = {
  whatsapp: EnviaWhatsApp
  email: EnviaEmail
  brutos: { whatsapp: EnviaWhatsApp; email: EnviaEmail }
  links: Links
  agora: Date
}

function canaisDe(deps: EntregasDeps): Canais {
  return {
    whatsapp: whatsappComRetentativa(deps.whatsapp),
    email: emailComRetentativa(deps.email),
    brutos: { whatsapp: deps.whatsapp, email: deps.email },
    links: deps.links ?? linksDoSite(),
    agora: (deps.now ?? (() => new Date()))(),
  }
}

/** Registro de entregas: uma linha por tentativa de WhatsApp ou e-mail de uma nota. Falha ao gravar não para a entrega. */
export async function registrarEntrega(
  db: Queryable,
  entrega: { invoiceId: string; canal: 'whatsapp' | 'email'; papel: PapelDoDestinatario; destino: string; enviado: boolean },
): Promise<void> {
  try {
    await db.query(
      'insert into nofiscal.fiscal_invoice_entregas (invoice_id, canal, papel, destino, status) values ($1, $2, $3, $4, $5)',
      [entrega.invoiceId, entrega.canal, entrega.papel, entrega.destino.slice(0, 254), entrega.enviado ? 'enviado' : 'falhou'],
    )
  } catch (error) {
    logEvent('agente.entrega_nao_registrada', { invoice_id: entrega.invoiceId, error_name: error instanceof Error ? error.name : 'unknown' })
  }
}

/** E-mail de uma nota, com retentativa e registro. */
async function emailDaNota(
  canais: Canais,
  db: Queryable,
  invoiceId: string,
  destino: Destinatario,
  mensagem: { assunto: string; texto: string; anexos?: AnexoEmail[]; idempotencia: string },
): Promise<void> {
  const enviado = await saiuComRetentativa('email', () => canais.brutos.email.enviar({ para: destino.email, ...mensagem }))
  await registrarEntrega(db, { invoiceId, canal: 'email', papel: destino.papel, destino: destino.email, enviado })
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
  /** WhatsApp `owner` da conta-mãe (do próprio tenant, fora de escritório). */
  dono_phone: string | null
  /** Empresa de um escritório: os avisos nomeiam a empresa. */
  do_escritorio: boolean
  razao_social: string
  cnpj: string
  /** Nota nascida de uma linha do lote por planilha. */
  do_lote: boolean
}

async function lerNota(db: Queryable, invoiceId: string): Promise<NotaDoAgente | null> {
  const { rows } = await db.query<NotaDoAgente>(
    `select i.id, i.tenant_id, i.status, i.payload, i.dps_numero, i.xml_nfse, i.last_error_code, i.last_error,
            (t.client_id is not null or t.escritorio_tenant_id is not null) as self_service,
            (select p.phone_e164 from nofiscal.fiscal_phones p
              where p.tenant_id = coalesce(t.escritorio_tenant_id, t.id) and p.role = 'owner') as dono_phone,
            t.escritorio_tenant_id is not null as do_escritorio, t.razao_social, t.cnpj,
            exists (select 1 from nofiscal.fiscal_lote_itens li where li.invoice_id = i.id) as do_lote
       from nofiscal.fiscal_invoices i
       join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where i.id = $1`,
    [invoiceId],
  )
  return rows[0] ?? null
}

/** " de Empresa X (CNPJ …)" nos avisos de uma empresa do escritório; vazio nas demais. */
const daEmpresa = (t: { do_escritorio: boolean; razao_social: string; cnpj: string }) =>
  t.do_escritorio ? ` de ${t.razao_social} (CNPJ ${formatarDocumento(t.cnpj)})` : ''

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

/** Manda ao dono e a quem pediu (se for outro número), registra cada tentativa e soma as mensagens ao pedido (C39). */
async function avisarNoWhatsApp(
  canais: Canais,
  db: Queryable,
  nota: NotaDoAgente,
  pedido: PedidoDaNota | null,
  mensagem: { texto: string; anexo?: AnexoEmail | null },
): Promise<void> {
  const numeros = [nota.dono_phone, pedido?.phone].filter((n, i, todos): n is string => Boolean(n) && todos.indexOf(n) === i)
  const { whatsapp } = canais.brutos
  for (const para of numeros) {
    const anexo = mensagem.anexo
    const enviado = await saiuComRetentativa('whatsapp', () =>
      anexo ? whatsapp.enviarDocumento(para, anexo, mensagem.texto) : whatsapp.enviarTexto(para, mensagem.texto),
    )
    await registrarEntrega(db, { invoiceId: nota.id, canal: 'whatsapp', papel: 'dono', destino: para, enviado })
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
  // E0718: assinatura sem o certificado do emitente. Com procuração, a Sefin não achou a procuração vigente.
  if (codigo === 'E0718')
    return 'O que corrigir: a Receita não reconheceu a assinatura. Se você cadastrou por procuração, confira no Portal de Serviços da Receita se ela está ativa para o serviço NFS-e e me mande o pedido de novo.'
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
    const pedido = nota.do_lote ? null : await pedidoDaNota(deps.db, invoiceId, 'emitir')
    const pdf = await pdfDaNota(nota, numero)
    const titulo = `NFS-e nº ${numero} autorizada`
    // Lote por planilha: nenhum WhatsApp por nota; o retorno agregado sai quando o lote fecha (lote-retorno.ts).
    if (!nota.do_lote) await avisarNoWhatsApp(canais, deps.db, nota, pedido, { texto: titulo, anexo: pdf })

    const anexos: AnexoEmail[] = []
    if (pdf) anexos.push(pdf)
    if (nota.xml_nfse) anexos.push({ nome: `nfse-${numero}.xml`, tipo: 'application/xml', conteudo: Buffer.from(nota.xml_nfse, 'utf8') })
    for (const destino of await destinatariosDoEmail(deps.db, nota.tenant_id, { tomadorEmail: tomador.email })) {
      await emailDaNota(canais, deps.db, invoiceId, destino, {
        assunto: titulo,
        texto: `${titulo} para ${tomador.nome}${tomador.valor ? `, no valor de ${formatarReais(tomador.valor)}` : ''}. O PDF e o XML seguem anexos. A nota pode ser conferida em nfse.gov.br.`,
        anexos,
        idempotencia: `nfse-${invoiceId}-issued-${destino.email}`,
      })
    }

    // Critério 30: primeira nota para um tomador sem modelo (nunca numa nota do lote: lá não há pedido).
    if (pedido?.phone && !pedido.conversa.modelo_id && pedido.conversa.modelo_nome) {
      await deps.db.query(`update nofiscal.fiscal_requests set etapa = 'salvar_modelo', updated_at = $2 where id = $1`, [
        pedido.id,
        canais.agora,
      ])
      await canais.whatsapp.enviarTexto(
        pedido.phone,
        `Quer que eu guarde ${pedido.conversa.modelo_nome} para as próximas notas? Responda sim ou não.`,
      )
      await contarMensagens(deps.db, pedido.id, 1)
    }
    await avisarLimite(deps, canais, nota)
    return
  }

  if (status === 'rejected') {
    // Lote: a recusa entra no retorno do lote, com o motivo; não sai uma mensagem por nota.
    if (nota.do_lote) return
    const pedido = await pedidoDaNota(deps.db, invoiceId, 'emitir')
    const texto = [
      `A Sefin recusou a nota para ${tomador.nome}${tomador.valor ? ` (${formatarReais(tomador.valor)})` : ''}.`,
      `Código ${nota.last_error_code ?? '-'}: ${nota.last_error ?? 'sem motivo informado'}`,
      oQueCorrigir(nota.last_error_code),
    ].join('\n')
    await avisarNoWhatsApp(canais, deps.db, nota, pedido, { texto })
    await alertarRecusa(deps.db, nota, pedido, `nota para ${tomador.nome}`)
    return
  }

  if (status === 'cancelled') {
    const pedido = await pedidoDaNota(deps.db, invoiceId, 'cancelar')
    const texto = `Nota ${numero} cancelada`
    await avisarNoWhatsApp(canais, deps.db, nota, pedido, { texto })
    for (const destino of await destinatariosDoEmail(deps.db, nota.tenant_id, { tomadorEmail: tomador.email })) {
      await emailDaNota(canais, deps.db, invoiceId, destino, {
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
  await alertarRecusa(deps.db, nota, pedido, `cancelamento da nota nº ${numero}`)
}

/** Recusa da Sefin na conversa de quem pediu (ou do dono): linha na central e alerta por e-mail. */
async function alertarRecusa(db: Queryable, nota: NotaDoAgente, pedido: PedidoDaNota | null, oQue: string): Promise<void> {
  const telefone = pedido?.phone ?? nota.dono_phone
  if (!telefone) return
  await registrarEvento(db, telefone, 'sefin_recusou', {
    detalhe: `${oQue} · código ${nota.last_error_code ?? '-'}: ${nota.last_error ?? 'sem motivo informado'}`,
  })
}

/**
 * Critério 29: a nota sai; o dono é avisado uma vez por mês, e nunca durante o teste. No Escritório (Franquia), as
 * notas de todas as empresas da conta-mãe somam contra o limite dela, e o aviso vai ao telefone dela.
 */
async function avisarLimite(deps: EntregasDeps, canais: Canais, nota: NotaDoAgente): Promise<void> {
  const local = partesLocais(canais.agora)
  const { inicio, fim } = limitesDoMes(local.ano, local.mes)
  const { rows } = await deps.db.query<{ dono_id: string; limite: number; emitidas: string; em_teste: boolean }>(
    `select d.id as dono_id, d.monthly_note_limit as limite,
            (select count(*) from nofiscal.fiscal_invoices i
              where i.tenant_id in (select nofiscal.empresas_do_dono(d.id))
                and i.issued_at >= $2 and i.issued_at < $3) as emitidas,
            coalesce((select s.status = 'pendente' and d.trial_ends_at > $4
                        from nofiscal.fiscal_subscriptions s
                       where s.tenant_id = d.id
                       order by (s.status <> 'cancelada') desc, s.created_at desc
                       limit 1), false) as em_teste
       from nofiscal.fiscal_tenants t
       join nofiscal.fiscal_tenants d on d.id = coalesce(t.escritorio_tenant_id, t.id)
      where t.id = $1`,
    [nota.tenant_id, inicio, fim, canais.agora],
  )
  const t = rows[0]
  if (!t || t.em_teste || Number(t.emitidas) <= t.limite || !nota.dono_phone) return
  if (!(await marcarUmaVez(deps.db, `limite:${t.dono_id}:${mesLocal(canais.agora)}`, t.dono_id))) return
  logEvent('agente.limite_passou', { tenant_id: t.dono_id, emitidas: Number(t.emitidas), limite: t.limite })
  await canais.whatsapp.enviarTexto(nota.dono_phone, `${AVISO_DE_LIMITE} (${t.limite} notas). As notas continuam saindo normalmente.`)
}

/**
 * Critério 27: um aviso por nota que ficou na fila por instabilidade da Sefin. Nota do lote não tem aviso por nota (o
 * lote tem o aviso parcial de 6 h); a de uma empresa do escritório vai ao WhatsApp da conta-mãe, nomeando a empresa.
 */
export async function avisarFila(deps: EntregasDeps, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const { rows } = await deps.db.query<{ id: string }>(
    `select i.id
       from nofiscal.fiscal_invoices i
       join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where (t.client_id is not null or t.escritorio_tenant_id is not null)
        and i.status = 'sent'
        and i.last_error_code = 'SEFIN_UNAVAILABLE'
        and ($1::uuid[] is null or i.tenant_id = any($1::uuid[]) or t.escritorio_tenant_id = any($1::uuid[]))
        and not exists (select 1 from nofiscal.fiscal_lote_itens li where li.invoice_id = i.id)
        and not exists (select 1 from nofiscal.fiscal_agent_once o where o.chave = 'fila:' || i.id::text)`,
    [opcoes.tenantIds ?? null],
  )
  const canais = canaisDe(deps)
  let enviados = 0
  for (const { id } of rows) {
    const nota = await lerNota(deps.db, id)
    if (!nota || !(await marcarUmaVez(deps.db, `fila:${id}`, nota.tenant_id))) continue
    const texto = nota.do_escritorio ? `A Sefin está instável; a nota${daEmpresa(nota)} está na fila e eu te aviso quando sair.` : AVISO_DE_FILA
    await avisarNoWhatsApp(canais, deps.db, nota, await pedidoDaNota(deps.db, id, 'emitir'), { texto })
    enviados++
  }
  return enviados
}

/**
 * Critério 28: A1 a 30 dias ou menos de vencer, e vencido; um aviso de cada por certificado, a partir das 09:00.
 * Empresa do escritório: o aviso vai ao WhatsApp `owner` e ao e-mail da conta-mãe, nomeando a empresa.
 */
export async function avisarCertificados(deps: EntregasDeps, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const canais = canaisDe(deps)
  if (!horaDosAvisos(canais.agora)) return 0
  const { rows } = await deps.db.query<{
    tenant_id: string
    not_after: Date
    dono_phone: string | null
    dono_email: string | null
    do_escritorio: boolean
    razao_social: string
    cnpj: string
  }>(
    `select t.id as tenant_id, c.not_after,
            (select p.phone_e164 from nofiscal.fiscal_phones p
              where p.tenant_id = coalesce(t.escritorio_tenant_id, t.id) and p.role = 'owner') as dono_phone,
            a.email as dono_email,
            t.escritorio_tenant_id is not null as do_escritorio, t.razao_social, t.cnpj
       from nofiscal.fiscal_certificates c
       join nofiscal.fiscal_tenants t on t.id = c.tenant_id
       left join nofiscal.fiscal_tenants m on m.id = t.escritorio_tenant_id
       left join nofiscal.fiscal_accounts a on a.client_id = coalesce(m.client_id, t.client_id)
      where (t.client_id is not null or t.escritorio_tenant_id is not null)
        and t.active
        and c.not_after <= $1::timestamptz + interval '30 days'
        and ($2::uuid[] is null or t.id = any($2::uuid[]) or t.escritorio_tenant_id = any($2::uuid[]))`,
    [canais.agora, opcoes.tenantIds ?? null],
  )
  let enviados = 0
  for (const cert of rows) {
    const vencido = cert.not_after.getTime() <= canais.agora.getTime()
    const chave = `${vencido ? 'cert-vencido' : 'cert'}:${cert.tenant_id}:${cert.not_after.toISOString()}`
    if (!(await marcarUmaVez(deps.db, chave, cert.tenant_id))) continue
    const data = dataBr(cert.not_after)
    const empresa = daEmpresa(cert)
    let texto: string
    let assunto: string
    if (cert.do_escritorio) {
      texto = vencido
        ? `O certificado A1${empresa} venceu em ${data}. A emissão dessa empresa está pausada até você enviar o novo em Minhas empresas: ${canais.links.conta}#empresas`
        : `O certificado A1${empresa} vence em ${data}. Envie o novo em Minhas empresas para essa empresa não parar de emitir: ${canais.links.conta}#empresas`
      assunto = vencido ? `O certificado A1 de ${cert.razao_social} venceu` : `O certificado A1 de ${cert.razao_social} vence em ${data}`
    } else {
      texto = vencido
        ? `Seu certificado A1 venceu em ${data}. A emissão está pausada até você enviar o novo na página segura: ${canais.links.certificado}`
        : `Seu certificado A1 vence em ${data}. Envie o novo na página segura para não parar de emitir: ${canais.links.certificado}`
      assunto = vencido ? 'Seu certificado A1 venceu' : `Seu certificado A1 vence em ${data}`
    }
    if (cert.dono_phone) await canais.whatsapp.enviarTexto(cert.dono_phone, texto)
    if (cert.dono_email) {
      await canais.email.enviar({
        para: cert.dono_email,
        assunto,
        texto,
        idempotencia: chave,
      })
    }
    enviados++
  }
  return enviados
}
