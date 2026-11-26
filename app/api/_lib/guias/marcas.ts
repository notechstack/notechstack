// `statuses[]` da Meta nos envios de guia (critério 17): a mesma marca que vai à central de conversas atualiza
// guia_envios (pelo wamid) e o andamento da guia (entregue, lida), sempre para a frente. A falha só derruba a guia
// para `falhou` quando nenhum outro envio dela (outro número, o e-mail) saiu.
import type { Queryable } from '../db.js'
import type { MarcaDeEnvio } from '../agente/central.js'

const ORDEM_DO_ENVIO = `case e.status when 'pendente' then 0 when 'enviada' then 1 when 'entregue' then 2 when 'lida' then 3 when 'falhou' then 4 else 0 end`

export async function marcarEnviosDeGuia(db: Queryable, marcas: MarcaDeEnvio[]): Promise<number> {
  let n = 0
  for (const m of marcas) {
    if (m.status === 'enviada') continue
    const ordem = m.status === 'entregue' ? 2 : m.status === 'lida' ? 3 : 4
    const { rows } = await db.query<{ guia_id: string }>(
      `update nofiscal.guia_envios e
          set status = $2,
              entregue_em = case when $2 in ('entregue', 'lida') then coalesce(e.entregue_em, now()) else e.entregue_em end,
              lido_em = case when $2 = 'lida' then coalesce(e.lido_em, now()) else e.lido_em end,
              erro = case when $2 = 'falhou' then left($3, 500) else e.erro end
        where e.id_externo = $1 and e.canal = 'whatsapp'
          and (${ORDEM_DO_ENVIO} < $4 or ($2 = 'falhou' and e.status <> 'falhou'))
        returning e.guia_id`,
      [m.wamid, m.status, m.erro, ordem],
    )
    for (const r of rows) {
      n++
      if (m.status === 'falhou') {
        await db.query(
          `update nofiscal.guias g set status = 'falhou', updated_at = now()
            where g.id = $1 and g.status = 'enviada'
              and not exists (select 1 from nofiscal.guia_envios e where e.guia_id = g.id and e.motivo = 'envio'
                                and e.status in ('pendente', 'enviada', 'entregue', 'lida'))`,
          [r.guia_id],
        )
      } else {
        await db.query(
          `update nofiscal.guias set status = $2, updated_at = now()
            where id = $1 and status not in ('cancelada', 'falhou')
              and nofiscal.guia_status_ordem(status) < nofiscal.guia_status_ordem($2)`,
          [r.guia_id, m.status],
        )
      }
    }
  }
  return n
}
