import { useCallback, useState, type ReactNode } from 'react'
import { Link, Navigate, NavLink, Outlet, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useDados } from '../marketing/useDados'
import { botaoPrimario, botaoSecundario, Carregando, Selo, Vazio } from '../marketing/ui'
import {
  auditor, ErroAuditor, NOME_FONTE, NOME_PLANO,
  type Ativo, type Conexao, type Conta, type Provedor, type Relatorio, type ResumoRelatorio,
} from './auditor-service'

// Mesmo padrão do planner: `carregar` estável (useCallback) e os dados anteriores ficam na tela ao recarregar.
function useCarregar<T>(carregar: () => Promise<T>) {
  const r = useDados(carregar)
  const erro = r.erro ? (r.erro instanceof ErroAuditor ? r.erro.message : 'Não foi possível carregar.') : undefined
  return { carregando: r.carregando, dados: r.dados, erro, recarregar: r.recarregar }
}

function Falha({ texto, onTentar }: { texto: string; onTentar?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-vermelho/40 bg-vermelho-tint p-4 text-sm">
      <p>{texto}</p>
      {onTentar ? <button type="button" className={`${botaoSecundario} mt-3`} onClick={onTentar}>Tentar novamente</button> : null}
    </div>
  )
}

function Cartao({ titulo, children, acoes }: { titulo: string; children: ReactNode; acoes?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-borda bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold">{titulo}</h2>
        {acoes}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

const dataBr = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—')

// --------------------------------------------------------------------- layout

export function AuditorLayout() {
  return (
    <div className="min-h-screen bg-osso text-tinta">
      <img className="h-1.5 w-full object-cover" src="/barra-topo-4-cores.svg" alt="" />
      <div className="mx-auto max-w-4xl px-5 py-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <Link to="/auditor" className="font-mono text-xs font-semibold uppercase tracking-[0.16em]">Auditor · nó.agentes</Link>
          <nav className="flex items-center gap-4 text-sm" aria-label="Auditor">
            <NavLink to="/auditor" end className={({ isActive }) => (isActive ? 'font-semibold underline' : '')}>Meus negócios</NavLink>
            <NavLink to="/auditor/conta" className={({ isActive }) => (isActive ? 'font-semibold underline' : '')}>Conta</NavLink>
            <button type="button" className="text-cinza underline" onClick={() => void supabase.auth.signOut()}>Sair</button>
          </nav>
        </header>
        <main className="mt-8 space-y-5"><Outlet /></main>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ início

export function AuditorHomePage() {
  const conta = useCarregar(useCallback(() => auditor.eu(), []))
  if (conta.carregando && !conta.dados) return <Carregando />
  if (conta.erro) return <Falha texto={conta.erro} onTentar={conta.recarregar} />
  if (!conta.dados) return <Navigate to='/auditor/entrar' replace />
  const c: Conta = conta.dados
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-cinza">Plano {NOME_PLANO[c.plano]}</p>
          <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Meus negócios<span className="text-ambar">.</span></h1>
        </div>
        {c.plano === 'gratis' ? <a className={botaoPrimario} href="https://www.notechstack.com.br/agentes/auditor/retrospectiva/#t13">Ver planos</a> : null}
      </div>
      {c.encerrada_em ? <Falha texto={`Esta conta foi encerrada. Os dados serão apagados em ${dataBr(c.excluir_apos)}.`} /> : null}
      {c.negocios.map((n) => (
        <Cartao key={n.client_id} titulo={n.nome} acoes={<span className="text-xs text-cinza">{n.site_url ?? 'sem site'}</span>}>
          <p className="text-sm text-cinza">
            {n.frequencia ? `Relatório ${n.frequencia === 'semanal' ? 'toda segunda' : 'todo dia 1'}.` : 'Plano grátis: uma retrospectiva com os seus números.'}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className={botaoSecundario} to={`/auditor/${n.client_id}/conexoes`}>Conexões</Link>
            <Link className={botaoSecundario} to={`/auditor/${n.client_id}/relatorios`}>Relatórios</Link>
          </div>
          <Suporte clientId={n.client_id} ate={n.suporte_ate} onMudou={conta.recarregar} />
        </Cartao>
      ))}
      {c.plano === 'agencia' && c.negocios.length < c.limite_negocios ? <NovoNegocio onCriado={conta.recarregar} /> : null}
    </>
  )
}

function Suporte({ clientId, ate, onMudou }: { clientId: string; ate: string | null; onMudou: () => void }) {
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState(false)
  async function alternar(conceder: boolean) {
    setOcupado(true)
    setErro('')
    try { await auditor.suporte(clientId, conceder); onMudou() } catch (e) { setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível.') } finally { setOcupado(false) }
  }
  return (
    <div className="mt-4 border-t border-borda pt-3 text-sm">
      {ate ? (
        <p>A equipe nó pode ver seus relatórios até {new Date(ate).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.{' '}
          <button type="button" className="underline" disabled={ocupado} onClick={() => void alternar(false)}>Encerrar agora</button></p>
      ) : (
        <p className="text-cinza">A equipe nó não vê seus números sem a sua permissão.{' '}
          <button type="button" className="underline" disabled={ocupado} onClick={() => void alternar(true)}>Permitir por 72 horas</button></p>
      )}
      {erro ? <p role="alert" className="mt-1 text-vermelho">{erro}</p> : null}
    </div>
  )
}

function NovoNegocio({ onCriado }: { onCriado: () => void }) {
  const [site, setSite] = useState('')
  const [erro, setErro] = useState('')
  return (
    <Cartao titulo="Adicionar negócio">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => {
        e.preventDefault()
        setErro('')
        auditor.novoNegocio(site.trim(), null).then(() => { setSite(''); onCriado() })
          .catch((x: unknown) => setErro(x instanceof ErroAuditor ? x.message : 'Não foi possível.'))
      }}>
        <label className="sr-only" htmlFor="novo-site">Site do negócio</label>
        <input id="novo-site" className="min-w-0 flex-1 rounded-xl border border-borda px-3 py-2 text-sm" placeholder="https://site-do-cliente.com.br" value={site} onChange={(e) => setSite(e.target.value)} />
        <button type="submit" className={botaoPrimario}>Adicionar</button>
      </form>
      {erro ? <p role="alert" className="mt-2 text-sm text-vermelho">{erro}</p> : null}
    </Cartao>
  )
}

// --------------------------------------------------------------- conexões

const PROVEDORES: { id: Provedor; rotulo: string; tipos: Ativo['tipo'][] }[] = [
  { id: 'meta', rotulo: 'Facebook', tipos: ['meta_ads'] },
  { id: 'google', rotulo: 'Google', tipos: ['google_ads', 'ga4', 'gsc'] },
]

const ESTADO_CONEXAO: Record<Conexao['estado'], [string, 'ok' | 'alerta' | 'erro' | 'neutro']> = {
  conectado: ['Conectado', 'ok'], expirado: ['Expirou', 'alerta'], revogado: ['Acesso removido', 'erro'], erro: ['Com erro', 'erro'], desconectado: ['Desconectado', 'neutro'],
}

export function ConexoesPage() {
  const { clientId = '' } = useParams()
  const dados = useCarregar(useCallback(() => auditor.conexoes(clientId), [clientId]))
  const [erro, setErro] = useState('')
  const [ocupado, setOcupado] = useState<Provedor | null>(null)

  async function conectar(p: Provedor) {
    setOcupado(p)
    setErro('')
    try {
      const { url } = await auditor.conectar(clientId, p)
      window.location.assign(url)
    } catch (e) {
      setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível iniciar a conexão.')
      setOcupado(null)
    }
  }
  async function desconectar(p: Provedor) {
    if (!window.confirm(`Desconectar o ${p === 'meta' ? 'Facebook' : 'Google'}? O acesso é apagado na hora e os próximos relatórios saem sem essa fonte.`)) return
    setOcupado(p)
    try { await auditor.desconectar(clientId, p); dados.recarregar() } catch (e) { setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível desconectar.') } finally { setOcupado(null) }
  }

  if (dados.carregando && !dados.dados) return <Carregando />
  if (dados.erro) return <Falha texto={dados.erro} onTentar={dados.recarregar} />
  const { conexoes, ativos } = dados.dados!
  return (
    <>
      <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Conexões<span className="text-ambar">.</span></h1>
      <p className="text-sm text-cinza">Só leitura: o auditor nunca cria, pausa ou altera nada nas suas contas.</p>
      {erro ? <Falha texto={erro} /> : null}
      {PROVEDORES.map((p) => {
        const c = conexoes.find((x) => x.provedor === p.id)
        const escolhidos = ativos.filter((a) => p.tipos.includes(a.tipo))
        const [rotulo, tom] = c ? ESTADO_CONEXAO[c.estado] : ['Não conectado', 'neutro' as const]
        return (
          <Cartao key={p.id} titulo={p.rotulo} acoes={<Selo texto={rotulo} tom={tom} />}>
            {escolhidos.length ? (
              <ul className="text-sm">{escolhidos.map((a) => <li key={a.tipo}>{NOME_FONTE[a.tipo]}: <strong>{a.nome ?? a.external_id}</strong></li>)}</ul>
            ) : <p className="text-sm text-cinza">{c?.estado === 'conectado' ? 'Escolha quais contas o auditor lê.' : 'Nenhuma conta escolhida.'}</p>}
            {c?.estado === 'conectado' && c.expira_em ? <p className="mt-2 text-xs text-cinza">O acesso expira em {dataBr(c.expira_em)}.</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {!c || c.estado !== 'conectado'
                ? <button type="button" className={botaoPrimario} disabled={ocupado !== null} onClick={() => void conectar(p.id)}>{`Conectar com o ${p.rotulo}`}</button>
                : <button type="button" className={botaoSecundario} disabled={ocupado !== null} onClick={() => void desconectar(p.id)}>Desconectar</button>}
            </div>
          </Cartao>
        )
      })}
      <Link className="text-sm underline" to="/auditor">Voltar</Link>
    </>
  )
}

// -------------------------------------------------------------- relatórios

const ROTULO_TIPO: Record<ResumoRelatorio['tipo'], string> = { retrospectiva: 'Retrospectiva', semanal: 'Semanal', mensal: 'Mensal' }

export function RelatoriosPage() {
  const { clientId = '' } = useParams()
  const lista = useCarregar(useCallback(() => auditor.relatorios(clientId), [clientId]))
  const [aviso, setAviso] = useState('')
  async function gerarRetrospectiva() {
    try {
      const id = await auditor.retrospectiva(clientId)
      setAviso(id ? 'Sua retrospectiva está sendo preparada. Ela aparece aqui em alguns minutos.' : 'A retrospectiva grátis deste negócio já foi gerada.')
      lista.recarregar()
    } catch (e) { setAviso(e instanceof ErroAuditor ? e.message : 'Não foi possível.') }
  }
  if (lista.carregando && !lista.dados) return <Carregando />
  if (lista.erro) return <Falha texto={lista.erro} onTentar={lista.recarregar} />
  const itens = lista.dados ?? []
  return (
    <>
      <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Relatórios<span className="text-ambar">.</span></h1>
      {aviso ? <p role="status" className="text-sm">{aviso}</p> : null}
      {itens.length === 0 ? (
        <>
          <Vazio texto="Nenhum relatório ainda." />
          <button type="button" className={botaoPrimario} onClick={() => void gerarRetrospectiva()}>Gerar minha retrospectiva</button>
        </>
      ) : (
        <ul className="space-y-2">
          {itens.map((r) => (
            <li key={r.id}>
              <Link to={`/auditor/${clientId}/relatorios/${r.id}`} className="flex items-center justify-between rounded-xl border border-borda bg-white px-4 py-3 text-sm hover:border-azul">
                <span><strong>{ROTULO_TIPO[r.tipo]}</strong> · {dataBr(r.periodo_de)} a {dataBr(r.periodo_ate)}</span>
                {r.estado === 'parcial' ? <Selo texto="Parcial" tom="alerta" /> : <Selo texto="Pronto" tom="ok" />}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link className="text-sm underline" to="/auditor">Voltar</Link>
    </>
  )
}

const ESTADO_FONTE: Record<string, [string, 'ok' | 'alerta' | 'erro' | 'neutro']> = {
  ok: ['Lido', 'ok'], expirado: ['Reconecte', 'alerta'], revogado: ['Reconecte', 'erro'], erro: ['Falhou', 'erro'],
  sem_conexao: ['Não conectado', 'neutro'], nao_escolhido: ['Conta não escolhida', 'neutro'], nao_disponivel: ['Não disponível', 'neutro'],
}
const SEVERIDADE: Record<string, ['ok' | 'alerta' | 'erro' | 'neutro', string]> = {
  alta: ['erro', 'Prioridade alta'], media: ['alerta', 'Atenção'], baixa: ['neutro', 'Ajuste'], info: ['ok', 'Informativo'],
}

export function RelatorioPage() {
  const { clientId = '', relatorioId = '' } = useParams()
  const r = useCarregar(useCallback(() => auditor.relatorio(relatorioId), [relatorioId]))
  if (r.carregando && !r.dados) return <Carregando />
  if (r.erro) return <Falha texto={r.erro} onTentar={r.recarregar} />
  if (!r.dados) return <Vazio texto="Relatório não encontrado." />
  return <RelatorioConteudo relatorio={r.dados} clientId={clientId} />
}

export function RelatorioConteudo({ relatorio, clientId }: { relatorio: Relatorio; clientId: string }) {
  const achados = relatorio.achados ?? []
  const reconectar = Object.entries(relatorio.fontes).some(([, e]) => e === 'expirado' || e === 'revogado')
  return (
    <>
      <p className="font-mono text-xs uppercase tracking-[0.14em] text-cinza">{ROTULO_TIPO[relatorio.tipo]} · {dataBr(relatorio.periodo_de)} a {dataBr(relatorio.periodo_ate)}</p>
      <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Seu relatório<span className="text-ambar">.</span></h1>
      {reconectar ? (
        <div role="alert" className="rounded-xl border border-ambar bg-ambar-tint p-4 text-sm">
          Reconecte suas contas para o próximo relatório vir completo.{' '}
          <Link className="font-semibold underline" to={`/auditor/${clientId}/conexoes`}>Ir para conexões</Link>
        </div>
      ) : null}
      {relatorio.narrativa ? (
        <Cartao titulo="Resumo">
          <p className="text-sm leading-6">{relatorio.narrativa.resumo}</p>
          {relatorio.narrativa.prioridades.length ? (
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
              {relatorio.narrativa.prioridades.map((p) => <li key={p.achado_id}><strong>{p.titulo}</strong><br />{p.o_que_fazer}</li>)}
            </ol>
          ) : null}
        </Cartao>
      ) : null}
      <Cartao titulo="Fontes">
        <ul className="grid gap-2 text-sm sm:grid-cols-2">
          {Object.entries(relatorio.fontes).map(([f, e]) => {
            const [rotulo, tom] = ESTADO_FONTE[e] ?? ['—', 'neutro' as const]
            return <li key={f} className="flex items-center justify-between rounded-lg bg-osso px-3 py-2"><span>{NOME_FONTE[f] ?? f}</span><Selo texto={rotulo} tom={tom} /></li>
          })}
        </ul>
      </Cartao>
      <Cartao titulo="O que encontramos">
        {achados.length === 0 ? <Vazio texto="Nenhum ponto de atenção neste período." /> : (
          <ul className="space-y-3">
            {achados.map((a) => {
              const [tom, rotulo] = SEVERIDADE[a.severidade] ?? ['neutro', a.severidade]
              return (
                <li key={a.id} className="rounded-xl border border-borda p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2"><Selo texto={rotulo} tom={tom} /><span className="text-xs text-cinza">{NOME_FONTE[a.fonte] ?? a.fonte}</span></div>
                  <p className="mt-2 font-semibold">{a.titulo}</p>
                  <p className="mt-1 text-cinza">{a.evidencia}</p>
                  <p className="mt-2">{a.acao}</p>
                </li>
              )
            })}
          </ul>
        )}
      </Cartao>
      <Link className="text-sm underline" to={`/auditor/${clientId}/relatorios`}>Todos os relatórios</Link>
    </>
  )
}

// ------------------------------------------------------------------- conta

export function ContaPage() {
  const [confirmando, setConfirmando] = useState(false)
  const [texto, setTexto] = useState('')
  const [estado, setEstado] = useState<{ ocupado: boolean; erro: string; feito: string }>({ ocupado: false, erro: '', feito: '' })
  async function excluir() {
    setEstado({ ocupado: true, erro: '', feito: '' })
    try {
      const r = await auditor.excluirConta()
      setEstado({ ocupado: false, erro: '', feito: r.codigo })
      await supabase.auth.signOut()
    } catch (e) {
      setEstado({ ocupado: false, erro: e instanceof ErroAuditor ? e.message : 'Não foi possível excluir agora.', feito: '' })
    }
  }
  if (estado.feito) {
    return <Cartao titulo="Conta excluída"><p className="text-sm">Seus dados foram apagados. Código do pedido: <strong>{estado.feito}</strong>.</p></Cartao>
  }
  return (
    <>
      <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Conta<span className="text-ambar">.</span></h1>
      <Cartao titulo="Excluir conta e dados">
        <p className="text-sm text-cinza">
          Cancela a assinatura, desconecta Facebook e Google e apaga negócios, relatórios e o seu acesso. Os registros de cobrança ficam
          guardados sem seus dados de contato, como manda a lei. Não dá para desfazer.
        </p>
        {confirmando ? (
          <div className="mt-4 rounded-xl border border-vermelho/40 bg-vermelho-tint p-4">
            <label className="text-sm" htmlFor="confirmar-exclusao">Digite <strong>EXCLUIR</strong> para confirmar</label>
            <input id="confirmar-exclusao" className="mt-1 w-full rounded-lg border border-borda px-3 py-2 text-sm" value={texto} onChange={(e) => setTexto(e.target.value)} />
            <div className="mt-3 flex gap-2">
              <button type="button" className={botaoPrimario} disabled={texto !== 'EXCLUIR' || estado.ocupado} onClick={() => void excluir()}>Excluir definitivamente</button>
              <button type="button" className={botaoSecundario} onClick={() => setConfirmando(false)}>Cancelar</button>
            </div>
          </div>
        ) : <button type="button" className={`${botaoSecundario} mt-4`} onClick={() => setConfirmando(true)}>Excluir minha conta</button>}
        {estado.erro ? <p role="alert" className="mt-3 text-sm text-vermelho">{estado.erro}</p> : null}
      </Cartao>
    </>
  )
}
