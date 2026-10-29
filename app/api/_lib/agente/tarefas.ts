// O agente dentro do worker do motor (Landing, lote B - destino do callback do motor para
// tenants self-service): as transições das notas desses tenants vão ao agente, no mesmo
// processo, e as tarefas agendadas do agente rodam na mesma chamada do agendador.
import type { Queryable } from '../db.js'
import type { FinalStatus } from '../emission.js'
import { logEvent } from '../log.js'
import { enviarListaDeAbandono } from './abandono.js'
import type { EnviaEmail, EnviaWhatsApp } from './canais.js'
import { enviarAlertasDaCentral, retencaoDaCentral } from './central.js'
import { expirarPedidos } from './conversa.js'
import { avisarCertificados, avisarFila, entregarTransicao } from './entregas.js'
import type { ModelosDoAgente } from './janela.js'
import type { Links } from './links.js'
import { enviarReservaDeBoasVindas } from './reserva.js'
import { enviarResumoMensal } from './resumo-mensal.js'

export type AgenteDeps = {
  whatsapp: EnviaWhatsApp
  email: EnviaEmail
  links?: Links
  now?: () => Date
  /** Modelos aprovados na Meta (v2, lote C): reserva de boas-vindas e resumo fora da janela. */
  modelos?: ModelosDoAgente
  /** `FISCAL_ALERTA_EMAIL`: destino da lista diária de abandono (v2, lote C) e dos alertas da central de conversas. */
  alertaEmail?: string
}

/** A nota é de um tenant self-service (`fiscal_tenants.client_id` preenchido)? */
export async function notaDoAgente(db: Queryable, invoiceId: string): Promise<boolean> {
  const { rows } = await db.query<{ self_service: boolean }>(
    `select t.client_id is not null as self_service
       from nofiscal.fiscal_invoices i join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where i.id = $1`,
    [invoiceId],
  )
  return rows[0]?.self_service ?? false
}

export function entregar(db: Queryable, agente: AgenteDeps, invoiceId: string, status: FinalStatus): Promise<void> {
  return entregarTransicao({ db, ...agente }, invoiceId, status)
}

/** Cada tarefa falha sozinha: uma não impede as outras nem a resposta do worker. */
export async function tarefasDoAgente(
  db: Queryable,
  agente: AgenteDeps,
  opcoes: { tenantId?: string } = {},
): Promise<Record<string, number | null>> {
  const deps = { db, ...agente }
  const tenantIds = opcoes.tenantId ? [opcoes.tenantId] : undefined
  const agora = (agente.now ?? (() => new Date()))()
  const resultado: Record<string, number | null> = {}
  const tarefas: [string, () => Promise<number>][] = [
    ['avisos_de_fila', () => avisarFila(deps, { tenantIds })],
    ['avisos_de_certificado', () => avisarCertificados(deps, { tenantIds })],
    ['resumos_mensais', () => enviarResumoMensal(deps, { tenantIds })],
    ['pedidos_expirados', () => expirarPedidos(db, agora, { tenantIds })],
    ['reservas_de_boas_vindas', () => enviarReservaDeBoasVindas(deps, { tenantIds })],
    ['lista_de_abandono', () => enviarListaDeAbandono(deps, { tenantIds })],
    ['alertas_da_central', () => enviarAlertasDaCentral(deps, { tenantIds })],
    ['retencao_da_central', () => retencaoDaCentral(db, agora, { tenantIds })],
  ]
  for (const [nome, tarefa] of tarefas) {
    try {
      resultado[nome] = await tarefa()
    } catch (error) {
      resultado[nome] = null
      logEvent('agente.tarefa_falhou', { tarefa: nome, error_name: error instanceof Error ? error.name : 'unknown' })
    }
  }
  return resultado
}
