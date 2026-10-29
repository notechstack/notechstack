import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Session } from '@supabase/supabase-js'
import { BrowserRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from './App'
import { AuthProvider } from './auth/AuthProvider'
import type { ConversaAberta, Leitura } from './fiscal/central-service'

// Tela /no/fiscal/conversas: a lista, a conversa aberta e a resposta da equipe, com a rota
// /api/v1/fiscal/central de mentira (a rota tem os próprios testes contra o banco).

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }))

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

const TOKEN = `cabeca.${btoa(JSON.stringify({ aal: 'aal2' })).replace(/=+$/, '')}.assinatura`
const TELEFONE = '+5511987654321'
const AGORA = new Date()
const minutosAtras = (n: number) => new Date(AGORA.getTime() - n * 60_000).toISOString()

function sessao(): Session {
  return {
    access_token: TOKEN, refresh_token: 'r', expires_in: 3600, token_type: 'bearer',
    user: { id: 'admin', app_metadata: { role: 'NO_ADMIN' }, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-01T00:00:00Z' },
  }
}

function conversa(janelaAberta: boolean): ConversaAberta {
  return {
    telefone: TELEFONE,
    empresa: 'Studio Lima',
    papel: 'owner',
    plano: 'pro',
    janela: { aberta: janelaAberta, fecha_em: janelaAberta ? new Date(AGORA.getTime() + 23 * 3600_000 + 41 * 60_000).toISOString() : null },
    assumida_ate: null,
    mensagens: [
      { id: '1', direcao: 'entrada', autor: 'cliente', tipo: 'text', texto: 'atendente', arquivo: null, status: null, erro: null, em: minutosAtras(3) },
      { id: '2', direcao: 'saida', autor: 'robo', tipo: 'text', texto: 'Chamei a equipe da Nó.', arquivo: null, status: 'lida', erro: null, em: minutosAtras(2) },
      { id: '3', direcao: 'saida', autor: 'robo', tipo: 'document', texto: 'NFS-e nº 9 autorizada', arquivo: 'nfse-9.pdf', status: 'falhou', erro: '131042 · Sem forma de pagamento', em: minutosAtras(1) },
    ],
    eventos: [{ id: 'e1', tipo: 'pediu_atendente', detalhe: null, em: minutosAtras(3) }],
  }
}

function leitura(aberta: ConversaAberta | null): Leitura {
  return {
    agora: AGORA.toISOString(),
    conversas: [{
      telefone: TELEFONE,
      empresa: 'Studio Lima',
      ultima: { direcao: 'saida', autor: 'robo', tipo: 'document', texto: 'NFS-e nº 9 autorizada', arquivo: 'nfse-9.pdf', status: 'falhou', em: minutosAtras(1) },
      etiquetas: ['pediu_atendente', 'erro_de_envio'],
    }],
    conversa: aberta,
  }
}

type Chamada = { metodo: string; corpo: Record<string, unknown> | null; autorizacao: string | null }

function rota(janelaAberta = true) {
  const chamadas: Chamada[] = []
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    chamadas.push({ metodo: init?.method ?? 'GET', corpo, autorizacao: new Headers(init?.headers).get('authorization') })
    if (corpo?.acao === 'responder') return Response.json({ assumida_ate: AGORA.toISOString() })
    return Response.json(leitura(corpo?.acao === 'ler' ? conversa(janelaAberta) : null))
  })
  vi.stubGlobal('fetch', fetchMock)
  return chamadas
}

function abrir() {
  mocks.getSession.mockResolvedValue({ data: { session: sessao() }, error: null })
  window.history.pushState({}, '', '/no/fiscal/conversas')
  return render(<BrowserRouter><AuthProvider><AppRoutes /></AuthProvider></BrowserRouter>)
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('central de conversas do nó.fiscal', () => {
  it('lista as conversas com as etiquetas e abre a conversa em bolhas, com a janela e o erro de envio', async () => {
    const chamadas = rota()
    const user = userEvent.setup()
    abrir()

    const lista = await screen.findByRole('navigation', { name: 'Conversas' })
    expect(within(lista).getByText('Studio Lima')).toBeInTheDocument()
    expect(within(lista).getByText('pediu atendente')).toBeInTheDocument()
    expect(within(lista).getByText('erro de envio')).toBeInTheDocument()
    expect(chamadas[0]).toEqual({ metodo: 'GET', corpo: null, autorizacao: `Bearer ${TOKEN}` })

    await user.click(within(lista).getByRole('button', { name: /Studio Lima/ }))
    const aberta = await screen.findByRole('region', { name: 'Conversa aberta' })
    // O telefone vai no corpo, não na URL.
    expect(chamadas.some((c) => c.metodo === 'POST' && c.corpo?.acao === 'ler' && c.corpo.telefone === TELEFONE)).toBe(true)
    expect(within(aberta).getByText('atendente')).toBeInTheDocument()
    expect(within(aberta).getByText('Chamei a equipe da Nó.')).toBeInTheDocument()
    expect(within(aberta).getByText(/Arquivo: nfse-9\.pdf/)).toBeInTheDocument()
    expect(within(aberta).getByText('131042 · Sem forma de pagamento')).toBeInTheDocument()
    expect(within(aberta).getByText(/janela aberta · fecha em 23 h 4\d min/)).toBeInTheDocument()
    expect(within(aberta).getByText(/pediu atendente/)).toBeInTheDocument()
    expect(within(aberta).getByRole('button', { name: 'Assumir' })).toBeEnabled()
  })

  it('a resposta da equipe vai para a rota com o telefone e o texto, e a caixa limpa', async () => {
    const chamadas = rota()
    const user = userEvent.setup()
    abrir()
    await user.click(await screen.findByRole('button', { name: /Studio Lima/ }))
    const caixa = await screen.findByLabelText('Responder como equipe da Nó')
    await user.type(caixa, 'Oi! Já vejo isso.')
    await user.click(screen.getByRole('button', { name: 'Enviar' }))

    await waitFor(() => expect(chamadas.some((c) => c.corpo?.acao === 'responder')).toBe(true))
    expect(chamadas.find((c) => c.corpo?.acao === 'responder')?.corpo).toEqual({ acao: 'responder', telefone: TELEFONE, texto: 'Oi! Já vejo isso.' })
    await waitFor(() => expect(caixa).toHaveValue(''))
  })

  it('fora da janela de 24 horas, a caixa de resposta trava e avisa que só sai modelo', async () => {
    rota(false)
    const user = userEvent.setup()
    abrir()
    await user.click(await screen.findByRole('button', { name: /Studio Lima/ }))
    expect(await screen.findByText('janela fechada · só modelo aprovado')).toBeInTheDocument()
    expect(screen.getByLabelText('Responder como equipe da Nó')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled()
  })
})
