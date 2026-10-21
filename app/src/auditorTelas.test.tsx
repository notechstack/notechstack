import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Session } from '@supabase/supabase-js'
import { BrowserRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from './App'
import { AuthProvider } from './auth/AuthProvider'
import type { Conta, Relatorio } from './auditor/auditor-service'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  auditor: {
    pedirLink: vi.fn(), eu: vi.fn(), iniciar: vi.fn(), suporte: vi.fn(), retrospectiva: vi.fn(), novoNegocio: vi.fn(),
    frequencia: vi.fn(), conexoes: vi.fn(), relatorios: vi.fn(), relatorio: vi.fn(), snapshots: vi.fn(), conectar: vi.fn(), desconectar: vi.fn(), excluirConta: vi.fn(),
  },
}))

vi.mock('./lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
      mfa: { listFactors: vi.fn(), challengeAndVerify: vi.fn(), enroll: vi.fn(), unenroll: vi.fn() },
    },
    from: vi.fn(),
    rpc: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}))

vi.mock('./auditor/auditor-service', async (original) => ({
  ...(await original<typeof import('./auditor/auditor-service')>()),
  auditor: mocks.auditor,
}))

const CLIENTE = 'c0000000-0000-4000-8000-000000000001'

function sessao(): Session {
  return {
    access_token: 'h.e30.s', refresh_token: 'r', expires_in: 3600, token_type: 'bearer',
    user: { id: 'u1', app_metadata: { role: 'AUDITOR_CLIENT' }, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-21T00:00:00Z' },
  }
}

function abrir(caminho: string, s: Session | null) {
  mocks.getSession.mockResolvedValue({ data: { session: s }, error: null })
  window.history.pushState({}, '', caminho)
  return render(<BrowserRouter><AuthProvider><AppRoutes /></AuthProvider></BrowserRouter>)
}

const CONTA: Conta = {
  conta_id: 'k1', plano: 'gratis', encerrada_em: null, excluir_apos: null, limite_negocios: 1, copia_whatsapp: false, copia_whatsapp_numero: null,
  negocios: [{ client_id: CLIENTE, nome: 'loja.com.br', site_url: 'https://loja.com.br/', frequencia: null, retrospectiva_gerada_em: null, suporte_ate: null }],
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auditor.eu.mockResolvedValue(CONTA)
  mocks.auditor.iniciar.mockResolvedValue(CONTA)
  mocks.auditor.conexoes.mockResolvedValue({ conexoes: [], ativos: [] })
  mocks.auditor.relatorios.mockResolvedValue([])
  mocks.auditor.snapshots.mockResolvedValue([])
})

describe('entrada do auditor', () => {
  it('sem sessão: pede o link só com o e-mail (o aceite é depois do login) e mostra a confirmação', async () => {
    mocks.auditor.pedirLink.mockResolvedValue(undefined)
    abrir('/auditor/entrar?site=https%3A%2F%2Floja.com.br%2F&volta=%2Fauditor%2Fplanos', null)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('E-mail'), 'pessoa@loja.com.br')
    expect(screen.queryByRole('checkbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Receber link de acesso' }))
    expect(await screen.findByText(/Confira seu e-mail/)).toBeInTheDocument()
    expect(mocks.auditor.pedirLink).toHaveBeenCalledWith('pessoa@loja.com.br', 'https://loja.com.br/', '/auditor/planos')
  })

  it('B3: com sessão e sem aceite registrado, pede o aceite e só então cria a conta', async () => {
    const { ErroAuditor } = await import('./auditor/auditor-service')
    mocks.auditor.iniciar
      .mockRejectedValueOnce(new ErroAuditor('aceite_pendente', 'Para continuar, aceite os Termos e a Política de Privacidade.'))
      .mockResolvedValue(CONTA)
    abrir('/auditor/entrar?site=https%3A%2F%2Floja.com.br%2F', sessao())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Abrir minha conta' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('aceite os Termos')
    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: 'Abrir minha conta' }))
    expect(await screen.findByRole('heading', { name: /Meus negócios/ })).toBeInTheDocument()
    expect(mocks.auditor.iniciar).toHaveBeenLastCalledWith('https://loja.com.br/', 'termos-2026-10-21')
  })

  it('B1: /auditor/* sem sessão vai para a entrada guardando o destino (não para o /login com senha)', async () => {
    abrir(`/auditor/${CLIENTE}/relatorios/r1?x=1`, null)
    expect(await screen.findByRole('button', { name: 'Receber link de acesso' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/auditor/entrar')
    expect(new URLSearchParams(window.location.search).get('volta')).toBe(`/auditor/${CLIENTE}/relatorios/r1?x=1`)
  })

  it('B1: com sessão, a entrada volta ao destino guardado; destino de fora vira /auditor', async () => {
    abrir('/auditor/entrar?volta=%2Fauditor%2Fconta', sessao())
    expect(await screen.findByRole('button', { name: 'Excluir minha conta' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/auditor/conta')
  })

  it('B7: conta encerrada mostra "Reativar minha conta"', async () => {
    mocks.auditor.eu.mockResolvedValue({ ...CONTA, encerrada_em: '2026-10-20T00:00:00Z', excluir_apos: '2027-01-18T00:00:00Z' })
    abrir('/auditor', sessao())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Reativar minha conta' }))
    expect(mocks.auditor.iniciar).toHaveBeenCalledWith(null)
  })

  it('volta do link (com sessão): cria a conta no primeiro acesso e abre os negócios', async () => {
    abrir('/auditor/entrar?site=https%3A%2F%2Floja.com.br%2F', sessao())
    expect(await screen.findByRole('heading', { name: /Meus negócios/ })).toBeInTheDocument()
    expect(mocks.auditor.iniciar).toHaveBeenCalledWith('https://loja.com.br/')
    expect(screen.getByText('Plano Grátis')).toBeInTheDocument()
    expect(screen.getByText(/não vê seus números sem a sua permissão/)).toBeInTheDocument()
  })

  it('sem conta ainda: /auditor manda para a entrada', async () => {
    mocks.auditor.eu.mockResolvedValue(null)
    mocks.auditor.iniciar.mockRejectedValue(new Error('x'))
    abrir('/auditor', sessao())
    expect(await screen.findByText(/Não foi possível abrir sua conta agora/)).toBeInTheDocument()
  })
})

describe('conexões e relatórios (C20)', () => {
  it('sem conexão: botões de conectar Facebook e Google', async () => {
    abrir(`/auditor/${CLIENTE}/conexoes`, sessao())
    expect(await screen.findByRole('button', { name: 'Conectar com o Facebook' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Conectar com o Google' })).toBeInTheDocument()
    expect(screen.getByText(/nunca cria, pausa ou altera/)).toBeInTheDocument()
  })

  it('sem relatório: estado vazio com a retrospectiva grátis', async () => {
    mocks.auditor.retrospectiva.mockResolvedValue('r1')
    abrir(`/auditor/${CLIENTE}/relatorios`, sessao())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Gerar minha retrospectiva' }))
    expect(await screen.findByRole('status')).toHaveTextContent('sendo preparada')
    expect(mocks.auditor.retrospectiva).toHaveBeenCalledWith(CLIENTE)
  })

  it('fonte expirada pede reconexão; fonte não disponível aparece sem número', async () => {
    const rel: Relatorio = {
      id: 'r1', client_id: CLIENTE, tipo: 'semanal', periodo_de: '2026-10-12', periodo_ate: '2026-10-18', estado: 'parcial',
      gerado_em: '2026-10-19T09:10:00Z', enviado_em: null,
      fontes: { meta_ads: 'expirado', google_ads: 'sem_conexao', ga4: 'ok', gsc: 'sem_conexao', site: 'nao_disponivel' },
      achados: [{ id: 'fonte:meta_ads:expirado', tipo: 'fonte_desconectada', severidade: 'alta', fonte: 'meta_ads', titulo: 'Reconecte o Facebook para ver Meta Ads', numeros: {}, evidencia: 'O acesso expirou.', acao: 'Clique em "Conectar com o Facebook" no seu painel.' }],
      narrativa: { origem: 'modelo', resumo: 'Resumo de 12/10 a 18/10. O site recebeu 1.234 sessões.', prioridades: [] },
    }
    mocks.auditor.relatorio.mockResolvedValue(rel)
    abrir(`/auditor/${CLIENTE}/relatorios/r1`, sessao())
    const alerta = await screen.findByRole('alert')
    expect(alerta).toHaveTextContent('Reconecte suas contas')
    expect(within(alerta).getByRole('link', { name: 'Ir para conexões' })).toHaveAttribute('href', `/auditor/${CLIENTE}/conexoes`)
    const fontes = screen.getByRole('heading', { name: 'Fontes' }).closest('section')!
    expect(within(fontes).getByText('Não disponível')).toBeInTheDocument()
    expect(within(fontes).getAllByText('Não conectado')).toHaveLength(2)
    expect(screen.getByText('Reconecte o Facebook para ver Meta Ads')).toBeInTheDocument()
  })
})

describe('conta', () => {
  it('exclusão só depois de digitar EXCLUIR; mostra o código do pedido', async () => {
    mocks.auditor.excluirConta.mockResolvedValue({ ok: true, codigo: 'abc123' })
    abrir('/auditor/conta', sessao())
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Excluir minha conta' }))
    const confirmar = screen.getByRole('button', { name: 'Excluir definitivamente' })
    expect(confirmar).toBeDisabled()
    await user.type(screen.getByLabelText(/Digite/), 'EXCLUIR')
    await user.click(confirmar)
    await waitFor(() => expect(screen.getByText(/abc123/)).toBeInTheDocument())
    // B2: o código fica na tela; sair é uma ação da pessoa
    expect(within(screen.getByRole('heading', { name: 'Conta excluída' }).closest('section')!).getByRole('button', { name: 'Sair' })).toBeInTheDocument()
  })
})
