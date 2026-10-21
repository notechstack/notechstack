import { useCallback } from 'react'
import { useDados } from '../marketing/useDados'
import { Carregando, Selo, tabela, td, th, Vazio } from '../marketing/ui'
import { auditor, ErroAuditor, NOME_PLANO, type Operacao } from './auditor-service'
import { CopiaWhatsappEquipe } from './CopiaWhatsapp'

// /no/auditor (NO_ADMIN, aal2): só metadados operacionais (spec, "O Lucca vê o quê").
// Nada de métricas, achados ou texto de relatório; para isso o cliente concede acesso de suporte.

const TOM: Record<string, 'ok' | 'alerta' | 'erro' | 'neutro'> = {
  conectado: 'ok', expirado: 'alerta', revogado: 'erro', erro: 'erro',
  enviado: 'ok', pronto: 'ok', parcial: 'alerta', falhou: 'erro', agendado: 'neutro', coletando: 'neutro', gerando: 'neutro',
}

export function OperacaoPage() {
  const r = useDados(useCallback(() => auditor.operacao(), []))
  if (r.carregando && !r.dados) return <Carregando />
  if (r.erro) return <p role="alert" className="text-sm">{r.erro instanceof ErroAuditor ? r.erro.message : 'Não foi possível carregar.'}</p>
  const lista: Operacao[] = r.dados?.negocios ?? []
  return (
    <main className="mx-auto max-w-6xl space-y-4 p-6">
      <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Auditor · operação<span className="text-ambar">.</span></h1>
      <p className="text-sm text-cinza">Estado das conexões e dos relatórios. Números e textos de clientes só com a permissão deles. Com a cópia por WhatsApp ligada pelo cliente, aparece só o texto final do relatório, e cada abertura fica registrada.</p>
      {lista.length === 0 ? <Vazio texto="Nenhum negócio no auditor ainda." /> : (
        <div className="overflow-x-auto rounded-2xl border border-borda bg-white">
          <table className={tabela}>
            <thead><tr><th className={th}>Negócio</th><th className={th}>Plano</th><th className={th}>Facebook</th><th className={th}>Google</th><th className={th}>Último relatório</th><th className={th}>Falhas</th><th className={th}>Cópia WhatsApp</th></tr></thead>
            <tbody>
              {lista.map((n) => (
                <tr key={n.client_id}>
                  <td className={td}><strong>{n.negocio}</strong><br /><span className="text-xs text-cinza">{n.site_url ?? 'sem site'}</span></td>
                  <td className={td}>{NOME_PLANO[n.plano]}{n.encerrada_em ? ' (encerrada)' : ''}</td>
                  {(['meta', 'google'] as const).map((p) => {
                    const c = n.conexoes[p]
                    return <td key={p} className={td}>{c ? <Selo texto={c.estado} tom={TOM[c.estado] ?? 'neutro'} /> : '—'}</td>
                  })}
                  <td className={td}>{n.ultimo_relatorio
                    ? <><Selo texto={n.ultimo_relatorio.estado} tom={TOM[n.ultimo_relatorio.estado] ?? 'neutro'} /> <span className="text-xs text-cinza">{n.ultimo_relatorio.tipo} até {n.ultimo_relatorio.periodo_ate}{n.ultimo_relatorio.erro ? ` · ${n.ultimo_relatorio.erro}` : ''}</span></>
                    : '—'}</td>
                  <td className={td}>{n.relatorios_falhos}</td>
                  <td className={td}>{n.copia_whatsapp && n.ultimo_relatorio && ['pronto', 'enviado', 'parcial'].includes(n.ultimo_relatorio.estado)
                    ? <CopiaWhatsappEquipe relatorioId={n.ultimo_relatorio.id} />
                    : n.copia_whatsapp ? 'aguardando relatório' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
