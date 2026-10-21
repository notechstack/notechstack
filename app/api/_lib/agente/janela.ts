// Janela de 24 h da Meta e envio por modelo (Landing v2, lote C - envio por modelo e janela).
// Fora da janela, a Cloud API só aceita modelo aprovado; dentro, aceita texto livre. A última
// mensagem recebida de cada número fica em `fiscal_agent_once`, agrupada por hora.
import type { Queryable } from '../db.js'

export const JANELA_MS = 24 * 3600_000

const chaveDaJanela = (telefone: string, agora: Date) => `janela:${telefone}:${agora.toISOString().slice(0, 13)}`

/** Registra a mensagem recebida de um número cadastrado (de qualquer tenant). */
export async function registrarJanela(db: Queryable, telefone: string, agora: Date): Promise<void> {
  await db.query(
    `insert into nofiscal.fiscal_agent_once (chave, tenant_id, created_at)
     select $1, p.tenant_id, $3 from nofiscal.fiscal_phones p where p.phone_e164 = $2
     on conflict (chave) do nothing`,
    [chaveDaJanela(telefone, agora), telefone, agora],
  )
}

export async function dentroDaJanela(db: Queryable, telefone: string, agora: Date): Promise<boolean> {
  const { rows } = await db.query<{ dentro: boolean }>(
    `select exists (
       select 1 from nofiscal.fiscal_agent_once
        where chave like $1 and created_at > $2 and created_at <= $3) as dentro`,
    [`janela:${telefone}:%`, new Date(agora.getTime() - JANELA_MS), agora],
  )
  return rows[0]?.dentro ?? false
}

export type ModelosDoAgente = {
  /** `WHATSAPP_MODELO_BOAS_VINDAS`: reserva de boas-vindas (critério 28). */
  boasVindas?: string
  /** `WHATSAPP_MODELO_RESUMO`: resumo fora da janela (critério 35). */
  resumo?: string
}
