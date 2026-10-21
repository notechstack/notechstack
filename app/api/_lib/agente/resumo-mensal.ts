// Resumo periódico do Pro no WhatsApp (critérios 35 a 37 da v2, que substituem o resumo fixo do
// dia 1 da v1, C38; Landing v2, lote C - resumo configurável). Cada tenant Pro escolhe mensal
// (dia 1 a 28) ou semanal (dia da semana ISO, 1 = segunda); sem escolha, vale mensal dia 1.
// No dia escolhido, a partir das 09:00 (America/Sao_Paulo), o dono recebe uma vez o resumo do
// período anterior: emitidas (`issued_at` no período), canceladas (`cancelled_at` no período) e
// o total autorizado (emitidas no período que seguem `issued`). Fora da janela de 24 h da Meta,
// vai o modelo `WHATSAPP_MODELO_RESUMO`.
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { whatsappComRetentativa } from './canais.js'
import { formatarReais } from './documentos.js'
import type { EntregasDeps } from './entregas.js'
import { dentroDaJanela, type ModelosDoAgente } from './janela.js'
import { HORA_DOS_AVISOS, limitesDoMes, MESES, partesLocais } from './tempo.js'
import { marcarUmaVez } from './uma-vez.js'

export type ResumoDeps = EntregasDeps & { modelos?: ModelosDoAgente }

type Periodo = { chave: string; rotulo: string; inicio: Date; fim: Date }

const dois = (n: number) => String(n).padStart(2, '0')
const DIA_MS = 24 * 3600_000

/** Meia-noite local de uma data de calendário (São Paulo sem horário de verão desde 2019). */
const meiaNoiteLocal = (d: Date) => new Date(`${d.getUTCFullYear()}-${dois(d.getUTCMonth() + 1)}-${dois(d.getUTCDate())}T00:00:00-03:00`)

/** Semana ISO 8601 (`aaaa-Wss`) da segunda-feira dada (data de calendário em UTC). */
function semanaIso(segunda: Date): string {
  const quinta = new Date(segunda.getTime() + 3 * DIA_MS)
  const ano = quinta.getUTCFullYear()
  const semana = Math.floor((quinta.getTime() - Date.UTC(ano, 0, 1)) / DIA_MS / 7) + 1
  return `${ano}-W${dois(semana)}`
}

function periodoMensal(local: { ano: number; mes: number }): Periodo {
  const anterior = local.mes === 1 ? { ano: local.ano - 1, mes: 12 } : { ano: local.ano, mes: local.mes - 1 }
  return {
    chave: `${anterior.ano}-${dois(anterior.mes)}`,
    rotulo: `${MESES[anterior.mes - 1]}/${anterior.ano}`,
    ...limitesDoMes(anterior.ano, anterior.mes),
  }
}

/** A última semana completa (segunda a domingo) antes do dia local dado. */
function periodoSemanal(hoje: Date, diaIso: number): Periodo {
  const estaSegunda = new Date(hoje.getTime() - (diaIso - 1) * DIA_MS)
  const segunda = new Date(estaSegunda.getTime() - 7 * DIA_MS)
  const domingo = new Date(estaSegunda.getTime() - DIA_MS)
  const br = (d: Date) => `${dois(d.getUTCDate())}/${dois(d.getUTCMonth() + 1)}`
  return {
    chave: semanaIso(segunda),
    rotulo: `semana de ${br(segunda)} a ${br(domingo)}`,
    inicio: meiaNoiteLocal(segunda),
    fim: meiaNoiteLocal(estaSegunda),
  }
}

async function contar(db: Queryable, tenantId: string, p: Periodo) {
  const { rows } = await db.query<{ emitidas: string; canceladas: string; total: string }>(
    `select (select count(*) from nofiscal.fiscal_invoices i
              where i.tenant_id = $1 and i.issued_at >= $2 and i.issued_at < $3) as emitidas,
            (select count(*) from nofiscal.fiscal_invoices i
              where i.tenant_id = $1 and i.cancelled_at >= $2 and i.cancelled_at < $3) as canceladas,
            (select coalesce(sum(case when i.payload->>'valor' ~ '^[0-9]{1,12}(\\.[0-9]{1,2})?$'
                                      then (i.payload->>'valor')::numeric end), 0)
               from nofiscal.fiscal_invoices i
              where i.tenant_id = $1 and i.status = 'issued' and i.issued_at >= $2 and i.issued_at < $3) as total`,
    [tenantId, p.inicio, p.fim],
  )
  return { emitidas: Number(rows[0].emitidas), canceladas: Number(rows[0].canceladas), total: Number(rows[0].total) }
}

export async function enviarResumoMensal(deps: ResumoDeps, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const agora = (deps.now ?? (() => new Date()))()
  const local = partesLocais(agora)
  if (local.hora < HORA_DOS_AVISOS) return 0
  const hoje = new Date(Date.UTC(local.ano, local.mes - 1, local.dia))
  const diaDaSemana = hoje.getUTCDay() === 0 ? 7 : hoje.getUTCDay()

  const { rows } = await deps.db.query<{
    tenant_id: string
    dono_phone: string | null
    resumo_frequencia: 'mensal' | 'semanal' | null
    resumo_dia: number | null
  }>(
    `select t.id as tenant_id, t.resumo_frequencia, t.resumo_dia,
            (select p.phone_e164 from nofiscal.fiscal_phones p where p.tenant_id = t.id and p.role = 'owner') as dono_phone
       from nofiscal.fiscal_tenants t
      where t.plan = 'pro'
        and t.client_id is not null
        and ($1::uuid[] is null or t.id = any($1::uuid[]))`,
    [opcoes.tenantIds ?? null],
  )

  const whatsapp = whatsappComRetentativa(deps.whatsapp)
  let enviados = 0
  for (const r of rows) {
    if (!r.dono_phone) continue
    const frequencia = r.resumo_frequencia ?? 'mensal'
    const dia = r.resumo_dia ?? 1
    let periodo: Periodo
    if (frequencia === 'mensal') {
      if (local.dia !== dia) continue
      periodo = periodoMensal(local)
    } else {
      if (diaDaSemana !== dia) continue
      periodo = periodoSemanal(hoje, diaDaSemana)
    }

    const { emitidas, canceladas, total } = await contar(deps.db, r.tenant_id, periodo)
    if (emitidas === 0 && canceladas === 0) continue

    const dentro = await dentroDaJanela(deps.db, r.dono_phone, agora)
    if (!dentro && !deps.modelos?.resumo) {
      logEvent('agente.modelo_nao_configurado', { aviso: 'resumo', tenant_id: r.tenant_id })
      continue
    }
    if (!(await marcarUmaVez(deps.db, `resumo:${r.tenant_id}:${periodo.chave}`, r.tenant_id))) continue

    if (dentro) {
      const texto =
        `Resumo de ${periodo.rotulo}: ${emitidas} ${emitidas === 1 ? 'nota emitida' : 'notas emitidas'}, ` +
        `${canceladas} ${canceladas === 1 ? 'cancelada' : 'canceladas'}, total autorizado ${formatarReais(total)}.`
      await whatsapp.enviarTexto(r.dono_phone, texto)
    } else {
      await whatsapp.enviarModelo(r.dono_phone, deps.modelos?.resumo as string, [
        periodo.rotulo,
        String(emitidas),
        String(canceladas),
        formatarReais(total),
      ])
    }
    enviados++
  }
  if (enviados) logEvent('agente.resumo_periodico', { enviados })
  return enviados
}
