import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { inteiro, reais } from '../marketing/format'
import { botaoPrimario, Selo } from '../marketing/ui'
import type { EstadoFonte, Relatorio, Snapshot } from './auditor-service'

// Retrospectiva com dados reais (spec, seção 6), na ordem do protótipo agentes/auditor/retrospectiva/:
// capa (nota do site) → site → Meta → Google → onde o clique se perde. Cada número vem de um snapshot
// do período; fonte que não foi lida aparece como estado, nunca como número inventado.

import { calcularNota, funil, type Checagem, type DadosGa4, type DadosGsc, type DadosPago, type DadosSite } from './retrospectiva-dados'

const fmtNota = (n: number) => String(n).replace('.', ',')
const ESTADO: Record<string, [string, 'alerta' | 'erro' | 'neutro']> = {
  expirado: ['Reconecte', 'alerta'], revogado: ['Reconecte', 'erro'], erro: ['Não foi possível ler', 'erro'],
  sem_conexao: ['Não conectado', 'neutro'], nao_escolhido: ['Conta não escolhida', 'neutro'], nao_disponivel: ['Não disponível', 'neutro'],
}

function Tela({ rotulo, titulo, fundo, children }: { rotulo: string; titulo?: string; fundo: string; children: ReactNode }) {
  return (
    <section className={`rounded-2xl border border-borda p-5 shadow-card ${fundo}`} aria-label={rotulo}>
      <p className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-cinza">{rotulo}</p>
      {titulo ? <h2 className="mt-1 text-2xl font-extrabold tracking-[-0.02em]">{titulo}</h2> : null}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Numero({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="rounded-xl bg-white/80 p-3">
      <p className="text-xs text-cinza">{rotulo}</p>
      <p className="text-xl font-bold tabular-nums">{valor}</p>
    </div>
  )
}

function Indisponivel({ estado, clientId }: { estado: EstadoFonte | undefined; clientId: string }) {
  const [texto, tom] = ESTADO[estado ?? 'nao_disponivel'] ?? ESTADO.nao_disponivel
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Selo texto={texto} tom={tom} />
      {estado === 'expirado' || estado === 'revogado' || estado === 'sem_conexao' || estado === 'nao_escolhido'
        ? <Link className="underline" to={`/auditor/${clientId}/conexoes`}>Ir para conexões</Link> : null}
    </div>
  )
}

const STATUS_CHK: Record<Checagem['status'], [string, 'ok' | 'alerta' | 'erro' | 'neutro']> = {
  ok: ['ok', 'ok'], atencao: ['atenção', 'alerta'], problema: ['problema', 'erro'], nao_verificavel: ['não verificável', 'neutro'],
}

export function Retrospectiva({ relatorio, snapshots, plano }: { relatorio: Relatorio; snapshots: Snapshot[]; plano: string | null }) {
  const clientId = relatorio.client_id
  const pega = <T,>(tipo: Snapshot['tipo']) => (relatorio.fontes[tipo] === 'ok' ? (snapshots.find((s) => s.tipo === tipo)?.dados as T | undefined) ?? null : null)
  const site = pega<DadosSite>('site')
  const meta = pega<DadosPago>('meta_ads')
  const ads = pega<DadosPago>('google_ads')
  const ga4 = pega<DadosGa4>('ga4')
  const gsc = pega<DadosGsc>('gsc')
  const nota = site ? calcularNota(site.checagens) : null
  const caminho = funil(meta, ads, ga4)

  return (
    <div className="space-y-4">
      <Tela rotulo="Capa · seu site" fundo="bg-verde/10" titulo={nota?.nota != null ? `Sua implementação tirou ${fmtNota(nota.nota)}.` : 'Nota do site indisponível.'}>
        {nota?.nota != null ? (
          <>
            <p className="text-4xl font-extrabold tabular-nums" role="img" aria-label={`Nota ${fmtNota(nota.nota)} de 10`}>{fmtNota(nota.nota)}<small className="text-base text-cinza">/10</small></p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <Numero rotulo="ok" valor={String(nota.ok)} /><Numero rotulo="atenção" valor={String(nota.atencao)} /><Numero rotulo="problema" valor={String(nota.problema)} />
            </div>
          </>
        ) : <Indisponivel estado={relatorio.fontes.site} clientId={clientId} />}
      </Tela>

      {site ? (
        <Tela rotulo={`Site · ${site.checagens.length} checagens`} fundo="bg-ambar/10">
          <ul className="space-y-2">
            {site.checagens.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 rounded-xl bg-white/80 p-3 text-sm">
                <span><strong>{c.titulo}</strong><br /><span className="text-cinza">{c.evidencia}</span></span>
                <Selo texto={STATUS_CHK[c.status][0]} tom={STATUS_CHK[c.status][1]} />
              </li>
            ))}
          </ul>
        </Tela>
      ) : null}

      <Tela rotulo="Meta Ads" fundo="bg-azul/10">
        {meta ? (
          <>
            <p className="text-3xl font-extrabold tabular-nums">{reais(meta.total.gasto_centavos)}</p>
            <p className="text-sm text-cinza">de investimento no período</p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Numero rotulo="Impressões" valor={inteiro(meta.total.impressoes)} />
              <Numero rotulo="Cliques" valor={inteiro(meta.total.cliques)} />
              <Numero rotulo="Conversões" valor={inteiro(meta.total.conversoes)} />
              <Numero rotulo="Custo por conversão" valor={meta.total.conversoes ? reais(Math.round(meta.total.gasto_centavos / meta.total.conversoes)) : '—'} />
            </div>
            {meta.campanhas?.length ? (
              <table className="mt-3 w-full text-left text-sm">
                <caption className="sr-only">Campanhas de maior investimento</caption>
                <thead><tr className="text-xs text-cinza"><th className="py-1">Campanha</th><th className="py-1 text-right">Gasto</th><th className="py-1 text-right">Conversões</th></tr></thead>
                <tbody>{meta.campanhas.slice(0, 5).map((c) => (
                  <tr key={c.id} className="border-t border-borda"><td className="py-1">{c.nome}</td><td className="py-1 text-right tabular-nums">{reais(c.metricas.gasto_centavos)}</td><td className="py-1 text-right tabular-nums">{inteiro(c.metricas.conversoes)}</td></tr>
                ))}</tbody>
              </table>
            ) : null}
          </>
        ) : <Indisponivel estado={relatorio.fontes.meta_ads} clientId={clientId} />}
      </Tela>

      <Tela rotulo="Google" fundo="bg-verde/10">
        <div className="grid gap-2 sm:grid-cols-3">
          <div>
            <p className="mb-1 text-xs font-semibold">Google Ads</p>
            {ads ? <div className="grid gap-2"><Numero rotulo="Gasto" valor={reais(ads.total.gasto_centavos)} /><Numero rotulo="Cliques" valor={inteiro(ads.total.cliques)} /></div>
              : <Indisponivel estado={relatorio.fontes.google_ads} clientId={clientId} />}
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold">Analytics</p>
            {ga4 ? <div className="grid gap-2"><Numero rotulo="Sessões" valor={inteiro(ga4.sessoes)} /><Numero rotulo="Eventos-chave" valor={inteiro(ga4.eventos_chave)} /></div>
              : <Indisponivel estado={relatorio.fontes.ga4} clientId={clientId} />}
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold">Search Console</p>
            {gsc ? <Numero rotulo="Cliques na busca" valor={inteiro(gsc.cliques)} /> : <Indisponivel estado={relatorio.fontes.gsc} clientId={clientId} />}
          </div>
        </div>
      </Tela>

      {caminho ? (
        <Tela rotulo="Meta + Google + site" fundo="bg-vermelho-tint" titulo={caminho.perda !== null ? `${Math.round(caminho.perda * 100)}% dos cliques pagos não viraram visita.` : 'Do anúncio ao site'}>
          <ol className="space-y-2 text-sm">
            <li className="flex justify-between rounded-xl bg-white/80 p-3"><span>Impressões</span><strong className="tabular-nums">{inteiro(caminho.impressoes)}</strong></li>
            <li className="flex justify-between rounded-xl bg-white/80 p-3"><span>Cliques pagos</span><strong className="tabular-nums">{inteiro(caminho.cliques)}</strong></li>
            <li className="flex justify-between rounded-xl bg-white/80 p-3"><span>Visitas vindas de anúncio</span><strong className="tabular-nums">{caminho.visitas === null ? 'não disponível' : inteiro(caminho.visitas)}</strong></li>
            <li className="flex justify-between rounded-xl bg-white/80 p-3"><span>Eventos-chave dessas visitas</span><strong className="tabular-nums">{caminho.eventos === null ? 'não disponível' : inteiro(caminho.eventos)}</strong></li>
          </ol>
          {caminho.visitas === null ? <p className="mt-2 text-xs text-cinza">Conecte o Google Analytics para ver quantos cliques chegaram ao site.</p> : null}
        </Tela>
      ) : null}

      {plano === 'gratis' ? (
        <Tela rotulo="Próximo passo" fundo="bg-verde/10" titulo="Receba isto toda semana.">
          <p className="text-sm">O auditor refaz o relatório sozinho, no ritmo do plano.</p>
          <Link className={`${botaoPrimario} mt-3`} to="/auditor/planos">Ver planos</Link>
        </Tela>
      ) : null}
    </div>
  )
}
