import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { BrandShell } from '../components/BrandShell'
import { LoadingScreen } from '../components/LoadingScreen'
import { auditor, ErroAuditor } from './auditor-service'
import { botaoPrimario, campo } from '../marketing/ui'

// Entrada do auditor: pede o link mágico. Quando a pessoa volta pelo link (sessão criada pelo
// supabase-js a partir da URL), cria a conta grátis e o negócio no primeiro acesso e segue para /auditor.
export function EntrarPage() {
  const { loading, session } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const site = params.get('site')
  const [email, setEmail] = useState('')
  const [aceite, setAceite] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [enviado, setEnviado] = useState(false)
  const [erro, setErro] = useState('')

  useEffect(() => {
    if (loading || !session) return
    let ativo = true
    auditor.iniciar(site)
      .then(() => { if (ativo) navigate('/auditor', { replace: true }) })
      .catch((e: unknown) => { if (ativo) setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível abrir sua conta agora.') })
    return () => { ativo = false }
  }, [loading, session, site, navigate])

  if (loading || (session && !erro)) return <LoadingScreen />

  async function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault()
    setErro('')
    if (!aceite) {
      setErro('Para continuar, aceite os Termos e a Política de Privacidade.')
      return
    }
    setEnviando(true)
    try {
      await auditor.pedirLink(email, site)
      setEnviado(true)
    } catch (e) {
      setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível enviar o link agora.')
    } finally {
      setEnviando(false)
    }
  }

  return (
    <BrandShell eyebrow="Auditor · nó.agentes">
      <div className="rounded-2xl border border-borda bg-white p-7 shadow-card sm:p-9">
        {enviado ? (
          <div role="status">
            <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Confira seu e-mail<span className="text-ambar">.</span></h1>
            <p className="mt-3 text-sm leading-6 text-cinza">
              Se o e-mail puder entrar, o link chega em instantes. Ele vale por pouco tempo e só funciona uma vez.
            </p>
            <button type="button" className="mt-6 text-sm font-semibold underline" onClick={() => setEnviado(false)}>Usar outro e-mail</button>
          </div>
        ) : (
          <form onSubmit={enviar} noValidate>
            <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Conecte suas contas<span className="text-ambar">.</span></h1>
            <p className="mt-3 text-sm leading-6 text-cinza">
              Entre com seu e-mail para conectar Facebook e Google e ver a retrospectiva com os seus números. Sem senha: mandamos um link.
            </p>
            {site ? <p className="mt-3 rounded-lg bg-osso px-3 py-2 text-xs">Site: <strong>{site}</strong></p> : null}
            <label className="mt-6 block text-sm font-semibold" htmlFor="auditor-email">E-mail</label>
            <input id="auditor-email" type="email" autoComplete="email" required className={`${campo} mt-1`} value={email} onChange={(e) => setEmail(e.target.value)} />
            <label className="mt-4 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={aceite} onChange={(e) => setAceite(e.target.checked)} />
              <span>
                Li e aceito os <a className="underline" href="https://www.notechstack.com.br/termos/" target="_blank" rel="noreferrer">Termos</a> e
                a <a className="underline" href="https://www.notechstack.com.br/privacidade/" target="_blank" rel="noreferrer">Política de Privacidade</a>.
              </span>
            </label>
            {erro ? <p role="alert" className="mt-4 text-sm text-vermelho">{erro}</p> : null}
            <button type="submit" className={`${botaoPrimario} mt-6 w-full`} disabled={enviando}>{enviando ? 'Enviando…' : 'Receber link de acesso'}</button>
          </form>
        )}
      </div>
    </BrandShell>
  )
}
