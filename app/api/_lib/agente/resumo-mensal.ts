// Resumo mensal do Pro no WhatsApp (critério 38; Landing, lote B - entregas e avisos): no dia
// 1, a partir das 09:00 (America/Sao_Paulo, Unresolved 13), cada tenant Pro com nota emitida
// ou cancelada no mês anterior recebe uma vez: emitidas (`issued_at` no mês), canceladas
// (`cancelled_at` no mês) e o total autorizado (emitidas no mês que seguem `issued`).
import { logEvent } from '../log.js'
import { whatsappComRetentativa } from './canais.js'
import { formatarReais } from './documentos.js'
import type { EntregasDeps } from './entregas.js'
import { limitesDoMes, MESES, partesLocais, HORA_DOS_AVISOS } from './tempo.js'
import { marcarUmaVez } from './uma-vez.js'

export async function enviarResumoMensal(deps: EntregasDeps, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const agora = (deps.now ?? (() => new Date()))()
  const local = partesLocais(agora)
  if (local.dia !== 1 || local.hora < HORA_DOS_AVISOS) return 0

  const anterior = local.mes === 1 ? { ano: local.ano - 1, mes: 12 } : { ano: local.ano, mes: local.mes - 1 }
  const { inicio, fim } = limitesDoMes(anterior.ano, anterior.mes)
  const { rows } = await deps.db.query<{ tenant_id: string; dono_phone: string | null; emitidas: string; canceladas: string; total: string }>(
    `select t.id as tenant_id,
            (select p.phone_e164 from nofiscal.fiscal_phones p where p.tenant_id = t.id and p.role = 'owner') as dono_phone,
            (select count(*) from nofiscal.fiscal_invoices i
              where i.tenant_id = t.id and i.issued_at >= $1 and i.issued_at < $2) as emitidas,
            (select count(*) from nofiscal.fiscal_invoices i
              where i.tenant_id = t.id and i.cancelled_at >= $1 and i.cancelled_at < $2) as canceladas,
            (select coalesce(sum(case when i.payload->>'valor' ~ '^[0-9]{1,12}(\\.[0-9]{1,2})?$'
                                      then (i.payload->>'valor')::numeric end), 0)
               from nofiscal.fiscal_invoices i
              where i.tenant_id = t.id and i.status = 'issued' and i.issued_at >= $1 and i.issued_at < $2) as total
       from nofiscal.fiscal_tenants t
      where t.plan = 'pro'
        and t.client_id is not null
        and ($3::uuid[] is null or t.id = any($3::uuid[]))`,
    [inicio, fim, opcoes.tenantIds ?? null],
  )

  const whatsapp = whatsappComRetentativa(deps.whatsapp)
  const mes = `${MESES[anterior.mes - 1]}/${anterior.ano}`
  const chaveDoMes = `${anterior.ano}-${String(anterior.mes).padStart(2, '0')}`
  let enviados = 0
  for (const r of rows) {
    const emitidas = Number(r.emitidas)
    const canceladas = Number(r.canceladas)
    if ((emitidas === 0 && canceladas === 0) || !r.dono_phone) continue
    if (!(await marcarUmaVez(deps.db, `resumo:${r.tenant_id}:${chaveDoMes}`, r.tenant_id))) continue
    const texto =
      `Resumo de ${mes}: ${emitidas} ${emitidas === 1 ? 'nota emitida' : 'notas emitidas'}, ` +
      `${canceladas} ${canceladas === 1 ? 'cancelada' : 'canceladas'}, total autorizado ${formatarReais(Number(r.total))}.`
    await whatsapp.enviarTexto(r.dono_phone, texto)
    enviados++
  }
  if (enviados) logEvent('agente.resumo_mensal', { mes: chaveDoMes, enviados })
  return enviados
}
