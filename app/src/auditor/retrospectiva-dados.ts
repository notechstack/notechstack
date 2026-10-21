// Cálculos da retrospectiva real (sem React): nota do site e funil do anúncio ao site.

export type Pagas = { gasto_centavos: number; impressoes: number; cliques: number; conversoes: number; alcance: number | null }
export type Campanha = { id: string; nome: string; metricas: Pagas }
export type DadosPago = { total: Pagas; campanhas?: Campanha[] }
export type DadosGa4 = { sessoes: number; eventos_chave: number; por_canal?: { canal: string; sessoes: number; eventos_chave: number }[] }
export type DadosGsc = { cliques: number; impressoes: number }
export type Checagem = { id: string; titulo: string; status: 'ok' | 'atencao' | 'problema' | 'nao_verificavel'; evidencia: string; recomendacao: string }
export type DadosSite = { url: string; checagens: Checagem[] }

// Canais pagos do GA4 (Default Channel Group): visitas que vieram de anúncio.
export const CANAIS_PAGOS = ['Paid Search', 'Paid Social', 'Paid Other', 'Paid Shopping', 'Paid Video', 'Display', 'Cross-network']

// Mesma regra do protótipo (shared/nota.js): ok = 1, atenção = 0,5, problema = 0; não verificável fica fora.
export function calcularNota(checagens: Checagem[]): { nota: number | null; ok: number; atencao: number; problema: number } {
  const c = { ok: 0, atencao: 0, problema: 0 }
  for (const x of checagens) {
    if (x.status === 'ok') c.ok++
    else if (x.status === 'atencao') c.atencao++
    else if (x.status === 'problema') c.problema++
  }
  const v = c.ok + c.atencao + c.problema
  return { ...c, nota: v ? Math.round(((2 * c.ok + c.atencao) * 500) / v) / 100 : null }
}

export function funil(meta: DadosPago | null, ads: DadosPago | null, ga4: DadosGa4 | null) {
  if (!meta && !ads) return null
  const impressoes = (meta?.total.impressoes ?? 0) + (ads?.total.impressoes ?? 0)
  const cliques = (meta?.total.cliques ?? 0) + (ads?.total.cliques ?? 0)
  const pagos = ga4?.por_canal?.filter((c) => CANAIS_PAGOS.includes(c.canal)) ?? null
  const visitas = pagos ? pagos.reduce((a, c) => a + c.sessoes, 0) : null
  const eventos = pagos ? pagos.reduce((a, c) => a + c.eventos_chave, 0) : null
  const perda = visitas !== null && cliques > 0 && visitas < cliques ? (cliques - visitas) / cliques : null
  return { impressoes, cliques, visitas, eventos, perda }
}

