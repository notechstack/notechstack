import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { sessionAal } from '../auth/aal'
import { BrandShell } from '../components/BrandShell'
import { supabase } from '../lib/supabase'
import { listAccessibleProjects } from '../projects/project-service'
import { destinoSeguro } from '../auditor/auditor-service'

const GENERIC_LOGIN_ERROR = 'Não foi possível entrar. Confira seus dados e tente novamente.'
const MFA_ERROR = 'Código não confere. Confira o horário do celular e tente o código novo.'

type MfaState =
  | { step: 'carregando' }
  | { step: 'cadastro'; factorId: string; qrCode: string; secret: string }
  | { step: 'desafio'; factorId: string }

const inputClass = 'w-full rounded-xl border border-borda bg-osso px-4 py-3 text-sm outline-none transition focus:border-azul focus:ring-2 focus:ring-azul/15'
const buttonClass = 'w-full rounded-xl bg-tinta px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-tinta/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ambar disabled:cursor-wait disabled:opacity-60'

// NO_ADMIN sempre passa pelo segundo fator (C2). Fator cadastrado → desafio;
// sem fator → cadastro. Cadastros abandonados (não verificados) são descartados.
async function prepararMfa(): Promise<MfaState> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error) throw error
  const verificado = data.totp[0]
  if (verificado) return { step: 'desafio', factorId: verificado.id }

  const pendentes = data.all.filter((f) => f.factor_type === 'totp' && f.status === 'unverified')
  for (const f of pendentes) await supabase.auth.mfa.unenroll({ factorId: f.id })

  const cadastro = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'nó admin' })
  if (cadastro.error) throw cadastro.error
  return { step: 'cadastro', factorId: cadastro.data.id, qrCode: cadastro.data.totp.qr_code, secret: cadastro.data.totp.secret }
}

function destinoAdmin(from: unknown): string {
  return typeof from === 'string' && from.startsWith('/no/') ? from : '/no/projetos'
}

function destinoDot(from: unknown): string {
  return typeof from === 'string' && from.startsWith('/no/marketing') ? from : '/no/marketing'
}

export function LoginPage() {
  const { session, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: unknown } | null)?.from
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [mfa, setMfa] = useState<MfaState | null>(null)
  const mfaIniciado = useRef(false)

  async function iniciarMfa() {
    if (mfaIniciado.current) return
    mfaIniciado.current = true
    setMfa({ step: 'carregando' })
    try {
      setMfa(await prepararMfa())
    } catch {
      mfaIniciado.current = false
      setMfa(null)
      setErrorMessage('Não foi possível preparar o segundo fator. Tente entrar de novo.')
    }
  }

  // Sessão NO_ADMIN sem segundo fator (recarregou a página ou veio do RoleRoute).
  useEffect(() => {
    if (session?.user.app_metadata.role === 'NO_ADMIN' && sessionAal(session) !== 'aal2' && !mfaIniciado.current) {
      void iniciarMfa()
    }
  }, [session])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErrorMessage('')
    setSubmitting(true)

    const { user, error } = await signIn(email, password)

    if (error || !user) {
      setPassword('')
      setErrorMessage(GENERIC_LOGIN_ERROR)
      setSubmitting(false)
      return
    }

    if (user.app_metadata.role === 'NO_ADMIN') {
      setPassword('')
      setSubmitting(false)
      await iniciarMfa()
      return
    }

    if (user.app_metadata.role === 'MARKETING_AGENT') {
      navigate(destinoDot(from), { replace: true })
      return
    }

    if (user.app_metadata.role === 'AGENCY_ADMIN') {
      navigate('/agencia', { replace: true })
      return
    }

    // Cliente do auditor (inclui a conta de revisor da Meta/Google, que entra com senha).
    if (user.app_metadata.role === 'AUDITOR_CLIENT') {
      navigate(destinoSeguro(typeof from === 'string' ? from : null), { replace: true })
      return
    }

    const { projects, error: projectsError } = await listAccessibleProjects()

    if (projectsError) {
      setPassword('')
      setErrorMessage(GENERIC_LOGIN_ERROR)
      setSubmitting(false)
      return
    }

    if (projects.length === 1) {
      navigate(`/p/${projects[0].id}/como-funciona`, { replace: true })
      return
    }

    navigate('/p/projetos', { replace: true, state: { projects } })
  }

  async function handleMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!mfa || mfa.step === 'carregando') return
    setErrorMessage('')
    setSubmitting(true)
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: mfa.factorId, code: code.trim() })
    if (error) {
      setCode('')
      setErrorMessage(MFA_ERROR)
      setSubmitting(false)
      return
    }
    navigate(destinoAdmin(from), { replace: true })
  }

  async function sair() {
    await supabase.auth.signOut()
    mfaIniciado.current = false
    setMfa(null)
    setCode('')
    setErrorMessage('')
  }

  if (mfa) {
    return (
      <BrandShell eyebrow="Segundo fator">
        <div className="rounded-2xl border border-borda bg-white p-7 shadow-card sm:p-9">
          <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em] sm:text-4xl">
            {mfa.step === 'cadastro' ? 'Ative o segundo fator' : 'Confirme que é você'}<span className="text-ambar">.</span>
          </h1>
          {mfa.step === 'carregando' ? (
            <p role="status" className="mt-4 text-sm text-cinza">Preparando o segundo fator…</p>
          ) : null}
          {mfa.step === 'cadastro' ? (
            <div className="mt-4 space-y-4 text-sm font-light leading-6 text-cinza">
              <p>A área da nó exige um app autenticador (Google Authenticator, 1Password, Authy). Leia o QR code ou digite a chave.</p>
              <img className="mx-auto h-44 w-44 rounded-xl border border-borda bg-white p-2" src={mfa.qrCode} alt="QR code do segundo fator" />
              <p>
                <span className="block font-semibold text-tinta">Chave para digitar no app</span>
                <code data-testid="mfa-secret" className="mt-1 block break-all rounded-lg bg-osso px-3 py-2 font-mono text-xs text-tinta">{mfa.secret}</code>
              </p>
            </div>
          ) : null}
          {mfa.step === 'desafio' ? (
            <p className="mt-3 max-w-[42ch] text-sm font-light leading-6 text-cinza">Digite o código de 6 dígitos do seu app autenticador.</p>
          ) : null}

          {mfa.step !== 'carregando' ? (
            <form className="mt-6 space-y-5" onSubmit={handleMfa}>
              <div>
                <label className="mb-2 block text-sm font-semibold" htmlFor="mfa-code">Código de 6 dígitos</label>
                <input
                  id="mfa-code"
                  name="mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  className={`${inputClass} font-mono tracking-[0.3em]`}
                />
              </div>
              {errorMessage ? (
                <p role="alert" className="rounded-xl border-l-4 border-vermelho bg-vermelho-tint px-4 py-3 text-sm">{errorMessage}</p>
              ) : null}
              <button type="submit" disabled={submitting} className={buttonClass}>
                {submitting ? 'Confirmando…' : 'Confirmar código'}
              </button>
              <button type="button" onClick={() => void sair()} className="w-full text-sm text-cinza underline">
                Sair e entrar com outra conta
              </button>
            </form>
          ) : null}
        </div>
      </BrandShell>
    )
  }

  return (
    <BrandShell eyebrow="Portal do projeto">
      <div className="rounded-2xl border border-borda bg-white p-7 shadow-card sm:p-9">
        <span className="mb-5 inline-flex rounded-full bg-ambar-tint px-3 py-1 font-mono text-[0.625rem] font-medium uppercase tracking-[0.12em] text-tinta">
          Texto provisório · revisar copy
        </span>
        <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em] sm:text-4xl">
          Entre no seu projeto<span className="text-ambar">.</span>
        </h1>
        <p className="mt-3 max-w-[42ch] text-sm font-light leading-6 text-cinza">
          Acesse o espaço onde estratégia, entregas e próximos passos se conectam.
        </p>

        <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
          <div>
            <label className="mb-2 block text-sm font-semibold" htmlFor="email">
              E-mail
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold" htmlFor="password">
              Senha
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </div>

          {errorMessage ? (
            <p role="alert" className="rounded-xl border-l-4 border-vermelho bg-vermelho-tint px-4 py-3 text-sm">
              {errorMessage}
            </p>
          ) : null}

          <button type="submit" disabled={submitting} className={buttonClass}>
            {submitting ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </BrandShell>
  )
}
