// Conferência da procuração eletrônica (migração 20261111180000; handoff de 11/11/2026, P1). O procurador consulta
// o ADN com `cnpjConsulta` do outorgante (Manual dos Contribuintes das APIs do ADN v1.1): passou = há procuração;
// E2245 = não há. Chamada na hora do "já fiz" (rota /api/v1/onboarding/procuracao) e pelo worker, a cada minuto:
// - declarada: a cada 2 min nas primeiras 2 horas, depois a cada 30 min, por até 30 dias;
// - invalida: a cada 10 min (a procuração pode ser refeita), por até 30 dias;
// - confirmada: uma vez por dia (pega a revogação).
// Usa o A1 do procurador direto (`read_certificate` do tenant procurador), porque procuração inválida some da
// view de emissão. Nada daqui vai a log além de ids e códigos.
import type { DistribuicaoAdn } from './adn.js'
import type { Queryable } from './db.js'
import { logEvent } from './log.js'
import type { Ambiente } from './sefin.js'

export type ResultadoConferencia = 'confirmada' | 'nao_encontrada' | 'indisponivel' | 'sem_procuracao_registrada'

export type ConferenciaDeps = { db: Queryable; adn: DistribuicaoAdn; now: () => Date }

export const LIMITE_POR_RODADA = 5

export async function conferirProcuracao(deps: ConferenciaDeps, tenantId: string): Promise<ResultadoConferencia> {
  const { rows } = await deps.db.query<{
    cnpj: string
    ambiente: Ambiente
    pfx_base64: string | null
    password: string | null
  }>(
    `select t.cnpj, t.ambiente, e.pfx_base64, e.password
       from nofiscal.fiscal_tenants t
       join nofiscal.fiscal_procuracoes p on p.tenant_id = t.id
       left join lateral nofiscal.read_certificate(p.procurador_tenant_id) e on true
      where t.id = $1 and t.modo_autenticacao = 'procuracao'`,
    [tenantId],
  )
  const row = rows[0]
  if (!row) return 'sem_procuracao_registrada'
  if (!row.pfx_base64 || row.password === null || !deps.adn.conferirProcuracao) {
    logEvent('nofiscal.procuracao_conferencia', { tenant_id: tenantId, result: 'SEM_CERTIFICADO_DO_PROCURADOR' })
    return 'indisponivel'
  }
  let resultado
  try {
    resultado = await deps.adn.conferirProcuracao({
      cnpjConsulta: row.cnpj,
      ambiente: row.ambiente,
      certificado: { pfxBase64: row.pfx_base64, password: row.password },
    })
  } catch (error) {
    logEvent('nofiscal.procuracao_conferencia', { tenant_id: tenantId, result: 'ERRO', error_name: error instanceof Error ? error.name : 'unknown' })
    return 'indisponivel'
  }
  const now = deps.now()
  if (resultado.kind === 'procuracao_ok') {
    await deps.db.query(
      `update nofiscal.fiscal_procuracoes
          set status = case when status = 'revogada' then status else 'confirmada' end,
              conferida_em = $2, fonte_conferencia = 'adn', ultimo_erro = null, updated_at = $2
        where tenant_id = $1`,
      [tenantId, now],
    )
    logEvent('nofiscal.procuracao_conferencia', { tenant_id: tenantId, result: 'CONFIRMADA' })
    return 'confirmada'
  }
  if (resultado.kind === 'sem_procuracao') {
    // Declarada continua declarada (pode estar propagando); a confirmada que some vira inválida (revogada ou vencida).
    await deps.db.query(
      `update nofiscal.fiscal_procuracoes
          set status = case when status = 'confirmada' then 'invalida' else status end,
              conferida_em = $2, fonte_conferencia = 'adn', ultimo_erro = $3, updated_at = $2
        where tenant_id = $1`,
      [tenantId, now, resultado.codigo],
    )
    logEvent('nofiscal.procuracao_conferencia', { tenant_id: tenantId, result: 'NAO_ENCONTRADA', codigo: resultado.codigo })
    return 'nao_encontrada'
  }
  logEvent('nofiscal.procuracao_conferencia', { tenant_id: tenantId, result: 'INDISPONIVEL', motivo: resultado.motivo })
  return 'indisponivel'
}

export type ResumoConferencias = { conferidas: number; confirmadas: number; nao_encontradas: number; indisponiveis: number }

/** Rodada do worker: as procurações que estão na hora de conferir, no máximo `limite`. */
export async function conferirPendentes(deps: ConferenciaDeps, opcoes: { limite?: number; tenantId?: string } = {}): Promise<ResumoConferencias> {
  const resumo: ResumoConferencias = { conferidas: 0, confirmadas: 0, nao_encontradas: 0, indisponiveis: 0 }
  if (!deps.adn.conferirProcuracao) return resumo
  const now = deps.now()
  const { rows } = await deps.db.query<{ tenant_id: string }>(
    `select p.tenant_id
       from nofiscal.fiscal_procuracoes p
       join nofiscal.fiscal_tenants t on t.id = p.tenant_id
      where t.active
        and t.modo_autenticacao = 'procuracao'
        and ($3::uuid is null or p.tenant_id = $3)
        and (
          (p.status = 'declarada' and p.declarada_em > $1::timestamptz - interval '30 days'
            and (p.conferida_em is null
                 or p.conferida_em < $1::timestamptz - case when p.declarada_em > $1::timestamptz - interval '2 hours'
                                                            then interval '2 minutes' else interval '30 minutes' end))
          or (p.status = 'invalida' and p.declarada_em > $1::timestamptz - interval '30 days'
              and (p.conferida_em is null or p.conferida_em < $1::timestamptz - interval '10 minutes'))
          or (p.status = 'confirmada' and (p.conferida_em is null or p.conferida_em < $1::timestamptz - interval '1 day')))
      order by p.conferida_em nulls first, p.declarada_em
      limit $2`,
    [now, opcoes.limite ?? LIMITE_POR_RODADA, opcoes.tenantId ?? null],
  )
  for (const { tenant_id } of rows) {
    const r = await conferirProcuracao(deps, tenant_id)
    resumo.conferidas++
    if (r === 'confirmada') resumo.confirmadas++
    else if (r === 'nao_encontrada') resumo.nao_encontradas++
    else resumo.indisponiveis++
  }
  return resumo
}
