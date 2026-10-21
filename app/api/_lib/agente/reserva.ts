// Reserva de boas-vindas (critério 28; Landing v2, lote C - ativação e envio por modelo): 1 hora
// depois do pagamento (`fiscal_tenants.pago_em`), quem ainda não ativou o WhatsApp recebe uma vez
// o modelo de utilidade `WHATSAPP_MODELO_BOAS_VINDAS` no número cadastrado. A resposta a ele,
// vinda desse número, ativa (`tratarAtivacao`).
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { whatsappComRetentativa, type EnviaWhatsApp } from './canais.js'
import { chaveDaReserva } from './ativacao.js'
import type { ModelosDoAgente } from './janela.js'
import { marcarUmaVez } from './uma-vez.js'

export const ESPERA_DA_RESERVA_MS = 3600_000

export async function enviarReservaDeBoasVindas(
  deps: { db: Queryable; whatsapp: EnviaWhatsApp; modelos?: ModelosDoAgente; now?: () => Date },
  opcoes: { tenantIds?: string[] } = {},
): Promise<number> {
  const agora = (deps.now ?? (() => new Date()))()
  const { rows } = await deps.db.query<{ tenant_id: string; razao_social: string; telefone: string }>(
    `select t.id as tenant_id, t.razao_social, a.phone_e164 as telefone
       from nofiscal.fiscal_tenants t
       join nofiscal.fiscal_accounts a on a.client_id = t.client_id
      where t.client_id is not null
        and t.pago_em is not null and t.pago_em <= $1
        and a.phone_verified_at is null
        and t.onboarding_etapa <> 'concluido'
        and not exists (select 1 from nofiscal.fiscal_agent_once o where o.chave = 'boas-vindas:' || t.id::text)
        and ($2::uuid[] is null or t.id = any($2::uuid[]))`,
    [new Date(agora.getTime() - ESPERA_DA_RESERVA_MS), opcoes.tenantIds ?? null],
  )
  if (!rows.length) return 0
  const modelo = deps.modelos?.boasVindas
  if (!modelo) {
    logEvent('agente.modelo_nao_configurado', { aviso: 'boas_vindas', pendentes: rows.length })
    return 0
  }

  const whatsapp = whatsappComRetentativa(deps.whatsapp)
  let enviados = 0
  for (const r of rows) {
    if (!(await marcarUmaVez(deps.db, chaveDaReserva(r.tenant_id), r.tenant_id))) continue
    await whatsapp.enviarModelo(r.telefone, modelo, [r.razao_social])
    enviados++
  }
  if (enviados) logEvent('agente.reserva_de_boas_vindas', { enviados })
  return enviados
}
