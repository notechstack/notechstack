import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { BrandShell } from '../components/BrandShell'
import { LoadingScreen } from '../components/LoadingScreen'
import { ACEITE_VERSAO, auditor, destinoSeguro, ErroAuditor } from './auditor-service'
import { botaoPrimario, campo } from '../marketing/ui'

// Entrada do auditor.
// Sem sessão: pede o link mágico (só o e-mail). Com sessão (volta do link ou login com senha): cria ou reabre a
// conta. Se o aceite dos Termos ainda não foi registrado por esta pessoa, mostra a caixa e só então cria (revisão B3).
// Depois segue para ?volta=/auditor/... (link do relatório, Assinar…) ou para /auditor (revisão B1).

export function EntrarPage() {
  const { loading, session } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const site = params.get('site')
  const volta = params.get('volta')
  const [email, setEmail] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [enviado, setEnviado] = useState(false)
  const [erro, setErro] = useState('')
  const [pedeAceite, setPedeAceite] = useState(false)
  const [aceite, setAceite] = useState(false)

  useEffect(() => {
    if (loading || !session) return
    let ativo = true
    auditor.iniciar(site)
      .then(() => { if (ativo) navigate(destinoSeguro(volta), { replace: true }) })
      .catch((e: unknown) => {
        if (!ativo) return
        if (e instanceof ErroAuditor && e.codigo === 'aceite_pendente') setPedeAceite(true)
        else setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível abrir sua conta agora.')
      })
    return () => { ativo = false }
  }, [loading, session, site, volta, navigate])

  if (loading || (session && !erro && !pedeAceite)) return <LoadingScreen />

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault()
    setErro('')
    setEnviando(true)
    try {
      await auditor.pedirLink(email, site, volta)
      setEnviado(true)
    } catch (e) {
      setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível enviar o link agora.')
    } finally {
      setEnviando(false)
    }
  }

  async function aceitar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault()
    setErro('')
    if (!aceite) {
      setErro('Para continuar, aceite os Termos e a Política de Privacidade.')
      return
    }
    setEnviando(true)
    try {
      await auditor.iniciar(site, ACEITE_VERSAO)
      navigate(destinoSeguro(volta), { replace: true })
    } catch (e) {
      setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível abrir sua conta agora.')
      setEnviando(false)
    }
  }

  const termos = (
    <span>
      Li e aceito os <a className="underline" href="https://www.notechstack.com.br/termos/" target="_blank" rel="noreferrer">Termos</a> e
      a <a className="underline" href="https://www.notechstack.com.br/privacidade/" target="_blank" rel="noreferrer">Política de Privacidade</a>.
    </span>
  )

  return (
    <BrandShell eyebrow="Auditor · nó.agentes">
      <div className="rounded-2xl border border-borda bg-white p-7 shadow-card sm:p-9">
        {pedeAceite ? (
          <form onSubmit={aceitar} noValidate>
            <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Falta um passo<span className="text-ambar">.</span></h1>
            <p className="mt-3 text-sm leading-6 text-cinza">Para abrir sua conta no auditor, confirme que leu e aceita os Termos e a Política de Privacidade.</p>
            <label className="mt-6 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={aceite} onChange={(e) => setAceite(e.target.checked)} />
              {termos}
            </label>
            {erro ? <p role="alert" className="mt-4 text-sm text-vermelho">{erro}</p> : null}
            <button type="submit" className={`${botaoPrimario} mt-6 w-full`} disabled={enviando}>{enviando ? 'Abrindo…' : 'Abrir minha conta'}</button>
          </form>
        ) : session ? (
          <p role="alert" className="text-sm text-vermelho">{erro}</p>
        ) : enviado ? (
          <div role="status">
            <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Confira seu e-mail<span className="text-ambar">.</span></h1>
            <p className="mt-3 text-sm leading-6 text-cinza">
              Se o e-mail puder entrar, o link chega em instantes. Ele vale por pouco tempo e só funciona uma vez.
            </p>
            <button type="button" className="mt-6 text-sm font-semibold underline" onClick={() => setEnviado(false)}>Usar outro e-mail</button>
          </div>
        ) : (
          <form onSubmit={enviar} noValidate>
            <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Entre no auditor<span className="text-ambar">.</span></h1>
            <p className="mt-3 text-sm leading-6 text-cinza">
              Entre com seu e-mail para conectar Facebook e Google e ver seus relatórios. Sem senha: mandamos um link.
            </p>
            {site ? <p className="mt-3 rounded-lg bg-osso px-3 py-2 text-xs">Site: <strong>{site}</strong></p> : null}
            <label className="mt-6 block text-sm font-semibold" htmlFor="auditor-email">E-mail</label>
            <input id="auditor-email" type="email" autoComplete="email" required className={`${campo} mt-1`} value={email} onChange={(e) => setEmail(e.target.value)} />
            {erro ? <p role="alert" className="mt-4 text-sm text-vermelho">{erro}</p> : null}
            <button type="submit" className={`${botaoPrimario} mt-6 w-full`} disabled={enviando}>{enviando ? 'Enviando…' : 'Receber link de acesso'}</button>
          </form>
        )}
      </div>
    </BrandShell>
  )
}
