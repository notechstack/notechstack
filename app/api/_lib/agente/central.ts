// Central de conversas do nó.fiscal (Lucca, 29/10/2026). Guarda as mensagens do número do robô
// por 90 dias: a entrada no webhook, logo depois da assinatura e do número conferidos; a saída
// no envio (texto, documento com o nome do arquivo, modelo); e as marcas de entregue, lida e
// falhou que a Meta devolve em `statuses[]`. Também guarda os eventos da conversa (pedido de
// atendente, IA que falhou ou não entendeu, recusa da Sefin, equipe que assumiu ou devolveu),
// que viram alerta por e-mail no worker. Com a conversa assumida pela equipe, o robô não
// responde àquele número; as entregas de nota continuam.
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { emailComRetentativa, type EnviaEmail, type Enviada, type EnviaWhatsApp } from './canais.js'
import type { MensagemRecebida } from './conversa.js'
import { comNonoDigito } from './normalizacao.js'
import { diaLocal, FUSO } from './tempo.js'
import { marcarUmaVez } from './uma-vez.js'
import { WhatsAppHttpError } from './whatsapp-cloud.js'

export const RETENCAO_DIAS = 90
const DIA_MS = 24 * 3600_000
/** O robô volta sozinho 2 horas depois da última mensagem da equipe (Lucca, 29/10/2026). */
export const PRAZO_DA_EQUIPE_MS = 2 * 3600_000
export const URL_DA_CENTRAL = 'https://app.notechstack.com.br/no/fiscal/conversas'

export type AutorDaSaida = 'robo' | 'equipe'
export type StatusDoEnvio = 'enviada' | 'entregue' | 'lida' | 'falhou'
export type TipoDeEvento = 'pediu_atendente' | 'ia_falhou' | 'ia_nao_entendeu' | 'sefin_recusou' | 'equipe_assumiu' | 'equipe_devolveu'

/** Eventos que vão por e-mail; a falha de envio vem das próprias mensagens. */
export const ALERTAS: TipoDeEvento[] = ['pediu_atendente', 'ia_falhou', 'ia_nao_entendeu', 'sefin_recusou']

export const ROTULO_DO_ALERTA: Record<string, string> = {
  pediu_atendente: 'pediu atendente',
  ia_falhou: 'a IA falhou',
  ia_nao_entendeu: 'a IA não entendeu',
  sefin_recusou: 'a Sefin recusou',
  envio_falhou: 'o envio falhou',
}

// A conta do número, se houver (o telefone é único em `fiscal_phones`).
const TENANT_DO_NUMERO = '(select p.tenant_id from nofiscal.fiscal_phones p where p.phone_e164 = $1)'

const errorName = (error: unknown) => (error instanceof Error ? error.name : 'unknown')

/** Número da conversa (com o 9) a partir do endereço do envio ou da Meta. */
export const numeroDaConversa = (endereco: string) => comNonoDigito(`+${endereco.replace(/\D/g, '')}`)

const ate = (texto: string | null | undefined, limite: number) => (texto == null ? null : texto.slice(0, limite))

// ---------------------------------------------------------------------------------------
// Entrada.

/** A mensagem recebida, uma vez por `wamid` (a Meta reentrega). */
export async function gravarEntrada(db: Queryable, msg: MensagemRecebida): Promise<void> {
  await db.query(
    `insert into nofiscal.fiscal_messages (phone_e164, endereco, tenant_id, direcao, autor, tipo, texto, arquivo, wamid)
     values ($1, $2, ${TENANT_DO_NUMERO}, 'entrada', 'cliente', $3, $4, $5, $6)
     on conflict (wamid) do nothing`,
    [msg.de, msg.enderecoRecebido ?? msg.de, ate(msg.tipo, 40), ate(msg.texto, 8000), ate(msg.arquivo?.nome, 300), msg.id],
  )
}

// ---------------------------------------------------------------------------------------
// Saída.

function textoDoErro(error: unknown): string {
  if (error instanceof WhatsAppHttpError) {
    return [`HTTP ${error.status}`, error.codigo, error.detalhe].filter((parte) => parte !== null && parte !== '').join(' · ')
  }
  return errorName(error)
}

/**
 * Grava cada envio no instante em que ele sai (ou falha), com o `wamid` da Meta. Fica por baixo de
 * `whatsappComRetentativa`, sobre o cliente cru: as tentativas de um mesmo envio viram uma linha só (a
 * falha grava a linha; a tentativa que sai a corrige). A gravação nunca derruba o envio: um envio que
 * saiu e lançasse erro seria repetido.
 */
export function whatsappGravado(
  whatsapp: EnviaWhatsApp,
  db: Queryable,
  autor: AutorDaSaida = 'robo',
  userId: string | null = null,
): EnviaWhatsApp {
  const falhas = new Map<string, string>()

  async function registrar(chave: string, para: string, envio: { tipo: string; texto: string | null; arquivo: string | null }, resultado: { wamid: string | null } | { erro: string }) {
    const anterior = falhas.get(chave)
    if ('erro' in resultado) {
      if (anterior) {
        await db.query('update nofiscal.fiscal_messages set erro = $2, updated_at = now() where id = $1', [anterior, ate(resultado.erro, 500)])
        return
      }
      const { rows } = await db.query<{ id: string }>(
        `insert into nofiscal.fiscal_messages
           (phone_e164, endereco, tenant_id, direcao, autor, tipo, texto, arquivo, status, erro, user_id)
         values ($1, $2, ${TENANT_DO_NUMERO}, 'saida', $3, $4, $5, $6, 'falhou', $7, $8)
         returning id`,
        [numeroDaConversa(para), para, autor, envio.tipo, ate(envio.texto, 8000), ate(envio.arquivo, 300), ate(resultado.erro, 500), userId],
      )
      if (rows[0]) falhas.set(chave, rows[0].id)
      return
    }
    if (anterior) {
      falhas.delete(chave)
      await db.query(
        `update nofiscal.fiscal_messages set status = 'enviada', erro = null, wamid = $2, updated_at = now() where id = $1`,
        [anterior, resultado.wamid],
      )
      return
    }
    // A marca da Meta pode chegar antes desta linha: ela já está lá, só sem o conteúdo.
    await db.query(
      `insert into nofiscal.fiscal_messages
         (phone_e164, endereco, tenant_id, direcao, autor, tipo, texto, arquivo, wamid, status, user_id)
       values ($1, $2, ${TENANT_DO_NUMERO}, 'saida', $3, $4, $5, $6, $7, 'enviada', $8)
       on conflict (wamid) do update
         set autor = excluded.autor, tipo = excluded.tipo, texto = excluded.texto, arquivo = excluded.arquivo,
             endereco = excluded.endereco, user_id = excluded.user_id`,
      [numeroDaConversa(para), para, autor, envio.tipo, ate(envio.texto, 8000), ate(envio.arquivo, 300), resultado.wamid, userId],
    )
  }

  async function gravar(
    para: string,
    envio: { tipo: string; texto: string | null; arquivo: string | null },
    enviar: () => Promise<Enviada | void>,
  ): Promise<Enviada | void> {
    const chave = [para, envio.tipo, envio.texto, envio.arquivo].join('\u0000')
    let resultado: Enviada | void
    try {
      resultado = await enviar()
    } catch (error) {
      await registrar(chave, para, envio, { erro: textoDoErro(error) }).catch((falha) =>
        logEvent('agente.mensagem_nao_gravada', { direcao: 'saida', error_name: errorName(falha) }),
      )
      throw error
    }
    await registrar(chave, para, envio, { wamid: resultado?.wamid ?? null }).catch((falha) =>
      logEvent('agente.mensagem_nao_gravada', { direcao: 'saida', error_name: errorName(falha) }),
    )
    return resultado
  }

  return {
    enviarTexto: (para, texto) => gravar(para, { tipo: 'text', texto, arquivo: null }, () => whatsapp.enviarTexto(para, texto)),
    enviarDocumento: (para, anexo, legenda) =>
      gravar(para, { tipo: 'document', texto: legenda, arquivo: anexo.nome }, () => whatsapp.enviarDocumento(para, anexo, legenda)),
    enviarModelo: (para, nome, parametros) =>
      gravar(para, { tipo: 'template', texto: [nome, ...parametros].join(' · '), arquivo: null }, () =>
        whatsapp.enviarModelo(para, nome, parametros),
      ),
  }
}

// ---------------------------------------------------------------------------------------
// Marcas da Meta (`statuses[]`).

export type MarcaDeEnvio = { wamid: string; status: StatusDoEnvio; para: string | null; erro: string | null }

/**
 * Entregue, lida ou falhou, sem nunca voltar para trás. Sem a linha ainda (a marca chegou antes da
 * gravação do envio, ou a mensagem saiu por fora do app), a linha nasce com o que a marca diz.
 */
export async function gravarMarca(db: Queryable, marca: MarcaDeEnvio): Promise<void> {
  if (!marca.para) {
    await db.query(
      `update nofiscal.fiscal_messages
          set status = $2, erro = coalesce($3, erro), updated_at = now()
        where wamid = $1 and nofiscal.fiscal_status_ordem(status) < nofiscal.fiscal_status_ordem($2)`,
      [marca.wamid, marca.status, ate(marca.erro, 500)],
    )
    return
  }
  await db.query(
    `insert into nofiscal.fiscal_messages (phone_e164, endereco, tenant_id, direcao, autor, tipo, wamid, status, erro)
     values ($1, $2, ${TENANT_DO_NUMERO}, 'saida', 'robo', 'desconhecido', $3, $4, $5)
     on conflict (wamid) do update
       set status = excluded.status, erro = coalesce(excluded.erro, nofiscal.fiscal_messages.erro), updated_at = now()
     where nofiscal.fiscal_status_ordem(nofiscal.fiscal_messages.status) < nofiscal.fiscal_status_ordem(excluded.status)`,
    [numeroDaConversa(marca.para), marca.para, marca.wamid, marca.status, ate(marca.erro, 500)],
  )
}

// ---------------------------------------------------------------------------------------
// Conversa assumida e eventos.

export async function conversaAssumida(db: Queryable, telefone: string, agora: Date): Promise<boolean> {
  const { rows } = await db.query<{ assumida: boolean }>(
    'select assumida_ate > $2 as assumida from nofiscal.fiscal_conversations where phone_e164 = $1',
    [telefone, agora],
  )
  return rows[0]?.assumida ?? false
}

/** Linha de sistema na conversa (e alerta, nos tipos de `ALERTAS`). Nunca derruba a conversa. */
export async function registrarEvento(
  db: Queryable,
  telefone: string,
  tipo: TipoDeEvento,
  opcoes: { detalhe?: string | null; userId?: string | null } = {},
): Promise<void> {
  try {
    await db.query(
      `insert into nofiscal.fiscal_conversation_events (phone_e164, tenant_id, tipo, detalhe, user_id)
       values ($1, ${TENANT_DO_NUMERO}, $2, $3, $4)`,
      [telefone, tipo, ate(opcoes.detalhe, 500), opcoes.userId ?? null],
    )
  } catch (error) {
    logEvent('agente.evento_nao_gravado', { tipo, error_name: errorName(error) })
  }
}

// ---------------------------------------------------------------------------------------
// Worker: alertas por e-mail e retenção.

const horaLocal = (instante: Date) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(instante)

type Alerta = { phone_e164: string; tipo: string; detalhe: string | null; created_at: Date; razao_social: string | null }

/**
 * Os alertas novos num e-mail só para `FISCAL_ALERTA_EMAIL`, a cada rodada do worker. A falha de
 * envio espera 1 minuto: até lá, as tentativas do mesmo envio ainda podem corrigir a linha.
 */
export async function enviarAlertasDaCentral(
  deps: { db: Queryable; email: EnviaEmail; alertaEmail?: string; now?: () => Date },
  opcoes: { tenantIds?: string[] } = {},
): Promise<number> {
  if (!deps.alertaEmail) return 0
  const agora = (deps.now ?? (() => new Date()))()
  const { rows } = await deps.db.query<Alerta>(
    `with eventos as (
       update nofiscal.fiscal_conversation_events e set avisado_em = $1
        where e.avisado_em is null and e.tipo = any($2::text[])
          and ($3::uuid[] is null or e.tenant_id = any($3::uuid[]))
       returning e.phone_e164, e.tenant_id, e.tipo, e.detalhe, e.created_at
     ), falhas as (
       update nofiscal.fiscal_messages m set avisado_em = $1
        where m.status = 'falhou' and m.avisado_em is null and m.updated_at <= $1::timestamptz - interval '1 minute'
          and ($3::uuid[] is null or m.tenant_id = any($3::uuid[]))
       returning m.phone_e164, m.tenant_id, 'envio_falhou'::text as tipo, m.erro as detalhe, m.created_at
     )
     select a.phone_e164, a.tipo, a.detalhe, a.created_at, t.razao_social
       from (select * from eventos union all select * from falhas) a
       left join nofiscal.fiscal_tenants t on t.id = a.tenant_id
      order by a.created_at`,
    [agora, ALERTAS, opcoes.tenantIds ?? null],
  )
  if (!rows.length) return 0
  const linhas = rows.map((r) =>
    [horaLocal(new Date(r.created_at)), r.razao_social ?? `${r.phone_e164} (sem conta)`, ROTULO_DO_ALERTA[r.tipo] ?? r.tipo, r.detalhe]
      .filter(Boolean)
      .join(' · '),
  )
  await emailComRetentativa(deps.email).enviar({
    para: deps.alertaEmail,
    assunto: `nó.fiscal: ${rows.length === 1 ? '1 alerta' : `${rows.length} alertas`} na central de conversas`,
    texto: [...linhas, '', `Ver e responder: ${URL_DA_CENTRAL}`].join('\n'),
    idempotencia: `central:${agora.toISOString()}`,
  })
  logEvent('agente.alertas_da_central', { alertas: rows.length })
  return rows.length
}

/** Tarefa do worker: a retenção roda uma vez por dia. */
export async function retencaoDaCentral(db: Queryable, agora: Date, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  if (!(await marcarUmaVez(db, `retencao_central:${diaLocal(agora)}`))) return 0
  return apagarConversasAntigas(db, agora, opcoes)
}

/** Mensagens e eventos com mais de 90 dias saem do banco. Devolve as mensagens apagadas. */
export async function apagarConversasAntigas(db: Queryable, agora: Date, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const limite = new Date(agora.getTime() - RETENCAO_DIAS * DIA_MS)
  const filtro = '($2::uuid[] is null or tenant_id = any($2::uuid[]))'
  const valores = [limite, opcoes.tenantIds ?? null]
  const { rowCount } = await db.query(`delete from nofiscal.fiscal_messages where created_at < $1 and ${filtro}`, valores)
  await db.query(`delete from nofiscal.fiscal_conversation_events where created_at < $1 and ${filtro}`, valores)
  if (!opcoes.tenantIds) {
    await db.query('delete from nofiscal.fiscal_conversations where updated_at < $1 and coalesce(assumida_ate, $1) <= $1', [limite])
  }
  return rowCount
}
