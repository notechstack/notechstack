// Lista diária de abandono (critério 48; Landing v2, lote C - lista diária de abandono): às
// 08:00 (America/Sao_Paulo), uma vez por dia, quem pagou há mais de 1 hora e não concluiu vai
// por e-mail para `FISCAL_ALERTA_EMAIL`. Lucca chama à mão; não há lembrete automático (Out of
// scope da tarefa). Lista vazia não envia.
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { emailComRetentativa, type EnviaEmail } from './canais.js'
import { dataBr, diaLocal, partesLocais } from './tempo.js'
import { marcarUmaVez } from './uma-vez.js'

export const HORA_DA_LISTA = 8
const UMA_HORA_MS = 3600_000
const DIA_MS = 24 * UMA_HORA_MS

type Linha = {
  tenant_id: string
  razao_social: string
  responsavel: string | null
  telefone: string | null
  plano: string
  etapa: string
  trial_ends_at: Date | null
}

export function diasDeTeste(trialEndsAt: Date | null, agora: Date): string {
  if (!trialEndsAt || trialEndsAt.getTime() <= agora.getTime()) return 'sem teste'
  const dias = Math.ceil((trialEndsAt.getTime() - agora.getTime()) / DIA_MS)
  return `${dias} ${dias === 1 ? 'dia' : 'dias'} de teste`
}

export async function enviarListaDeAbandono(
  deps: { db: Queryable; email: EnviaEmail; alertaEmail?: string; now?: () => Date },
  opcoes: { tenantIds?: string[] } = {},
): Promise<number> {
  if (!deps.alertaEmail) return 0
  const agora = (deps.now ?? (() => new Date()))()
  if (partesLocais(agora).hora < HORA_DA_LISTA) return 0
  const chave = `abandono:${diaLocal(agora)}`
  if (!(await marcarUmaVez(deps.db, chave))) return 0

  const { rows } = await deps.db.query<Linha>(
    `select tenant_id, razao_social, responsavel, telefone, plano, etapa, trial_ends_at
       from nofiscal.lista_de_abandono($1)
      where $2::uuid[] is null or tenant_id = any($2::uuid[])`,
    [new Date(agora.getTime() - UMA_HORA_MS), opcoes.tenantIds ?? null],
  )
  if (!rows.length) return 0

  const linhas = rows.map((r) =>
    [r.razao_social, r.responsavel ?? '-', r.telefone ?? '-', r.plano, r.etapa, diasDeTeste(r.trial_ends_at, agora)].join(' · '),
  )
  await emailComRetentativa(deps.email).enviar({
    para: deps.alertaEmail,
    assunto: `nó.fiscal: quem parou no meio (${dataBr(agora)})`,
    texto: [
      `Pagaram há mais de 1 hora e ainda não concluíram (${rows.length}):`,
      '',
      'empresa · responsável · WhatsApp · plano · etapa · teste',
      ...linhas,
    ].join('\n'),
    idempotencia: chave,
  })
  logEvent('agente.lista_de_abandono', { linhas: rows.length })
  return rows.length
}
