import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Session } from '@supabase/supabase-js'
import { BrowserRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from './App'
import { AuthProvider } from './auth/AuthProvider'
import { montarPedido, TEXTO_ACEITE, tokenizarCartao, validar, type DadosCheckout } from './auditor/checkout'
import { calcularNota, funil } from './auditor/retrospectiva-dados'
import { TEXTO_ACEITE_ASSINATURA } from '../../supabase/functions/assinatura-auditor/core.ts'
import type { Conta, Relatorio } from './auditor/auditor-service'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  auditor: {
    pedirLink: vi.fn(), eu: vi.fn(), iniciar: vi.fn(), suporte: vi.fn(), retrospectiva: vi.fn(), novoNegocio: vi.fn(), frequencia: vi.fn(),
    conexoes: vi.fn(), relatorios: vi.fn(), relatorio: vi.fn(), snapshots: vi.fn(), contasDisponiveis: vi.fn(), salvarAtivos: vi.fn(),
    assinaturaConfig: vi.fn(), assinar: vi.fn(), operacao: vi.fn(), conectar: vi.fn(), desconectar: vi.fn(), excluirConta: vi.fn(),
  },
}))

vi.mock('./lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signInWithPassword: vi.fn(), signOut: vi.fn(),
      mfa: { listFactors: vi.fn(async () => ({ data: { totp: [{ status: 'verified' }] }, error: null })), challengeAndVerify: vi.fn(), enroll: vi.fn(), unenroll: vi.fn() },
    },
    from: vi.fn(), rpc: vi.fn(), functions: { invoke: vi.fn() },
  },
}))

vi.mock('./auditor/auditor-service', async (original) => ({
  ...(await original<typeof import('./auditor/auditor-service')>()),
  auditor: mocks.auditor,
}))

const CLIENTE = 'c0000000-0000-4000-8000-000000000001'

function token(aal: string) {
  return `h.${btoa(JSON.stringify({ aal })).replace(/=+$/, '')}.s`
}
function sessao(role = 'AUDITOR_CLIENT', aal = 'aal1'): Session {
  return {
    access_token: token(aal), refresh_token: 'r', expires_in: 3600, token_type: 'bearer',
    user: { id: 'u1', email: 'dono@loja.com.br', app_metadata: { role }, user_metadata: {}, aud: 'authenticated', created_at: '2026-10-21T00:00:00Z' },
  }
}
function abrir(caminho: string, s: Session | null) {
  mocks.getSession.mockResolvedValue({ data: { session: s }, error: null })
  window.history.pushState({}, '', caminho)
  return render(<BrowserRouter><AuthProvider><AppRoutes /></AuthProvider></BrowserRouter>)
}

const CONTA: Conta = {
  conta_id: 'k1', plano: 'gratis', encerrada_em: null, excluir_apos: null, limite_negocios: 1,
  negocios: [{ client_id: CLIENTE, nome: 'loja.com.br', site_url: 'https://loja.com.br/', frequencia: null, retrospectiva_gerada_em: null, suporte_ate: null }],
}

function dados(extra: Partial<DadosCheckout> = {}): DadosCheckout {
  return {
    plano: 'semanal', nome: 'Ana Souza', email: 'ana@loja.com.br', telefone: '(11) 99999-8888', documento: '123.456.789-09',
    numero_cartao: '4111 1111 1111 1111', nome_cartao: 'ANA SOUZA', validade: '12/30', cvv: '123', termos_aceite: true,
    endereco: { cep: '01310-100', rua: 'Av. Paulista', numero: '1000', complemento: '', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'sp' },
    ...extra,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auditor.eu.mockResolvedValue(CONTA)
})

describe('checkout (funções puras)', () => {
  it('o texto de aceite do app é idêntico ao que o servidor exige', () => {
    expect(TEXTO_ACEITE).toBe(TEXTO_ACEITE_ASSINATURA)
  })

  it('valida e monta o pedido sem nenhum dado do cartão', () => {
    expect(validar(dados())).toEqual([])
    expect(validar(dados({ termos_aceite: false, cvv: '1' }))).toHaveLength(2)
    const p = montarPedido(dados(), 'token_abc')
    expect(p).toMatchObject({ plano: 'semanal', documento: '12345678909', telefone: '11999998888', card_token: 'token_abc', termos_aceite: true, aceite_texto: TEXTO_ACEITE })
    expect(p.endereco.uf).toBe('SP')
    const texto = JSON.stringify(p)
    for (const proibido of ['4111', 'ANA SOUZA', '12/30', 'cvv', 'numero_cartao']) expect(texto).not.toContain(proibido)
  })

  it('tokeniza direto no Pagar.me com a chave pública', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 'token_x' }), { status: 200 }))
    expect(await tokenizarCartao(dados(), 'pk_test_1', f as unknown as typeof fetch)).toBe('token_x')
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.pagar.me/core/v5/tokens?appId=pk_test_1')
    expect(JSON.parse(init.body as string).card).toMatchObject({ number: '4111111111111111', exp_month: 12, exp_year: 2030 })
    const recusa = async () => new Response('{}', { status: 422 })
    await expect(tokenizarCartao(dados(), 'pk', recusa as unknown as typeof fetch)).rejects.toThrow('CARTAO')
  })
})

describe('retrospectiva (cálculos)', () => {
  it('nota do site segue a regra do protótipo (não verificável fica fora)', () => {
    const c = (status: 'ok' | 'atencao' | 'problema' | 'nao_verificavel') => ({ id: status, titulo: '', status, evidencia: '', recomendacao: '' })
    expect(calcularNota([c('ok'), c('ok'), c('atencao'), c('problema'), c('nao_verificavel')])).toEqual({ nota: 6.25, ok: 2, atencao: 1, problema: 1 })
    expect(calcularNota([c('nao_verificavel')]).nota).toBeNull()
  })

  it('funil usa só canais pagos do GA4; sem GA4 a visita fica indisponível', () => {
    const meta = { total: { gasto_centavos: 1, impressoes: 1000, cliques: 100, conversoes: 1, alcance: null } }
    const ga4 = { sessoes: 500, eventos_chave: 20, por_canal: [{ canal: 'Paid Social', sessoes: 40, eventos_chave: 3 }, { canal: 'Organic Search', sessoes: 400, eventos_chave: 15 }] }
    expect(funil(meta, null, ga4)).toEqual({ impressoes: 1000, cliques: 100, visitas: 40, eventos: 3, perda: 0.6 })
    expect(funil(meta, null, null)).toMatchObject({ visitas: null, eventos: null, perda: null })
    expect(funil(null, null, ga4)).toBeNull()
  })
})

describe('telas da rodada 2', () => {
  it('relatório mostra a retrospectiva com números dos snapshots; fonte expirada não mostra número', async () => {
    const rel: Relatorio = {
      id: 'r1', client_id: CLIENTE, tipo: 'retrospectiva', periodo_de: '2026-09-23', periodo_ate: '2026-10-20', estado: 'parcial', gerado_em: null, enviado_em: null,
      fontes: { meta_ads: 'ok', google_ads: 'expirado', ga4: 'ok', gsc: 'nao_escolhido', site: 'ok' },
      achados: [], narrativa: { origem: 'modelo', resumo: 'Resumo.', prioridades: [] },
    }
    mocks.auditor.relatorio.mockResolvedValue(rel)
    mocks.auditor.snapshots.mockResolvedValue([
      { tipo: 'meta_ads', external_id: 'act_1', dados: { total: { gasto_centavos: 482000, impressoes: 312000, cliques: 6140, conversoes: 74, alcance: 90000 }, campanhas: [{ id: 'c1', nome: 'Remarketing', metricas: { gasto_centavos: 200000, conversoes: 30 } }] } },
      { tipo: 'ga4', external_id: '123', dados: { sessoes: 9400, eventos_chave: 212, por_canal: [{ canal: 'Paid Social', sessoes: 3650, eventos_chave: 40 }] } },
      { tipo: 'site', external_id: 'https://loja.com.br/', dados: { url: 'https://loja.com.br/', checagens: [{ id: 'https', titulo: 'Site em HTTPS', status: 'ok', evidencia: 'ok', recomendacao: '' }, { id: 'tempo_resposta', titulo: 'Tempo de resposta', status: 'problema', evidencia: '7,2 s', recomendacao: '' }] } },
    ])
    abrir(`/auditor/${CLIENTE}/relatorios/r1`, sessao())
    expect(await screen.findByText('Sua implementação tirou 5.')).toBeInTheDocument()
    const meta = screen.getByRole('region', { name: 'Meta Ads' })
    expect(within(meta).getByText(/4\.820,00/)).toBeInTheDocument()
    expect(within(meta).getByText('Remarketing')).toBeInTheDocument()
    const google = screen.getByRole('region', { name: 'Google' })
    expect(within(google).getByText('Reconecte')).toBeInTheDocument()
    expect(within(google).getByText('9.400')).toBeInTheDocument()
    expect(within(google).getByText('Conta não escolhida')).toBeInTheDocument()
    const caminho = screen.getByRole('region', { name: 'Meta + Google + site' })
    expect(within(caminho).getByText('41% dos cliques pagos não viraram visita.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ver planos' })).toHaveAttribute('href', '/auditor/planos')
    expect(mocks.auditor.snapshots).toHaveBeenCalledWith(CLIENTE, '2026-09-23', '2026-10-20')
  })

  it('volta do OAuth e escolha de contas: manda só o que foi escolhido', async () => {
    mocks.auditor.conexoes.mockResolvedValue({ conexoes: [{ provedor: 'google', estado: 'conectado', expira_em: null, conectado_em: '2026-10-21T00:00:00Z', verificado_em: null, ultimo_erro: null }], ativos: [] })
    mocks.auditor.contasDisponiveis.mockResolvedValue({
      google_ads: [{ tipo: 'google_ads', external_id: '1234567890', nome: 'Loja Ads', login_customer_id: '999', detalhe: 'BRL' }],
      ga4: [{ tipo: 'ga4', external_id: '111', nome: 'Loja GA4', login_customer_id: null, detalhe: null }, { tipo: 'ga4', external_id: '222', nome: 'Outra', login_customer_id: null, detalhe: null }],
      gsc: null, falhas: [],
    })
    mocks.auditor.salvarAtivos.mockResolvedValue({ ativos: [] })
    abrir(`/auditor/${CLIENTE}/conexoes?conexao=google&resultado=ok`, sessao())
    expect(await screen.findByText(/Google conectado/)).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Escolher contas' }))
    await user.click(await screen.findByRole('radio', { name: /Outra/ }))
    expect(screen.getByText(/Sem permissão para listar/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Salvar escolha' }))
    await waitFor(() => expect(mocks.auditor.salvarAtivos).toHaveBeenCalledWith(CLIENTE, {
      google_ads: { customer_id: '1234567890', login_customer_id: '999' }, ga4: '222',
    }))
  })

  it('erro na volta do OAuth vira mensagem clara', async () => {
    mocks.auditor.conexoes.mockResolvedValue({ conexoes: [], ativos: [] })
    abrir(`/auditor/${CLIENTE}/conexoes?conexao=meta&resultado=erro&motivo=access_denied`, sessao())
    expect(await screen.findByRole('alert')).toHaveTextContent('Você não autorizou o acesso')
  })

  it('planos com venda fechada: botões desabilitados, nada é cobrado', async () => {
    mocks.auditor.assinaturaConfig.mockResolvedValue({ ambiente: 'sandbox', venda_aberta: false, public_key: '', planos: [{ codigo: 'semanal', disponivel: false }] })
    abrir('/auditor/planos', sessao())
    expect(await screen.findByText(/A assinatura abre em breve/)).toBeInTheDocument()
    for (const b of screen.getAllByRole('button', { name: 'Assinatura em breve' })) expect(b).toBeDisabled()
  })

  it('planos com venda aberta: tokeniza no navegador e envia o pedido com o token', async () => {
    mocks.auditor.assinaturaConfig.mockResolvedValue({ ambiente: 'sandbox', venda_aberta: true, public_key: 'pk_test_1', planos: ['mensal', 'semanal', 'agencia'].map((codigo) => ({ codigo, disponivel: true })) })
    mocks.auditor.assinar.mockResolvedValue({ ok: true, status: 'pendente' })
    const fetchOriginal = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'token_ok' }), { status: 200 })) as unknown as typeof fetch
    try {
      abrir('/auditor/planos', sessao())
      const user = userEvent.setup()
      await user.click(await screen.findByRole('button', { name: 'Assinar Semanal' }))
      const form = screen.getByRole('form', { name: 'Dados da assinatura' })
      expect(within(form).getByLabelText('E-mail de cobrança')).toHaveValue('dono@loja.com.br')
      const d = dados()
      await user.type(within(form).getByLabelText('Nome completo'), d.nome)
      await user.type(within(form).getByLabelText('WhatsApp com DDD'), d.telefone)
      await user.type(within(form).getByLabelText('CPF ou CNPJ'), d.documento)
      await user.type(within(form).getByLabelText('Número do cartão'), d.numero_cartao)
      await user.type(within(form).getByLabelText('Nome impresso'), d.nome_cartao)
      await user.type(within(form).getByLabelText('Validade (MM/AA)'), d.validade)
      await user.type(within(form).getByLabelText('CVV'), d.cvv)
      await user.type(within(form).getByLabelText('CEP'), d.endereco.cep)
      await user.type(within(form).getByLabelText('Rua'), d.endereco.rua)
      await user.type(within(form).getByLabelText('Número'), d.endereco.numero)
      await user.type(within(form).getByLabelText('Bairro'), d.endereco.bairro)
      await user.type(within(form).getByLabelText('Cidade'), d.endereco.cidade)
      await user.selectOptions(within(form).getByLabelText('UF'), 'SP')
      await user.click(within(form).getByRole('checkbox'))
      await user.click(within(form).getByRole('button', { name: 'Assinar' }))
      expect(await within(form).findByRole('status')).toHaveTextContent('Recebemos sua assinatura')
      const pedido = mocks.auditor.assinar.mock.calls[0][0]
      expect(pedido).toMatchObject({ plano: 'semanal', card_token: 'token_ok', email: 'dono@loja.com.br' })
      expect(JSON.stringify(pedido)).not.toContain('4111')
      expect(within(form).getByRole('button', { name: 'Assinar' })).toBeDisabled()
    } finally {
      globalThis.fetch = fetchOriginal
    }
  }, 20_000)

  it('/no/auditor: NO_ADMIN com aal2 vê só metadados', async () => {
    mocks.auditor.operacao.mockResolvedValue({ negocios: [{
      client_id: CLIENTE, negocio: 'loja.com.br', site_url: 'https://loja.com.br/', plano: 'semanal', conta_criada_em: '2026-10-21', encerrada_em: null,
      conexoes: { meta: { estado: 'expirado', expira_em: null } }, ultimo_relatorio: { estado: 'falhou', tipo: 'semanal', periodo_ate: '2026-10-18', erro: 'fonte_indisponivel' }, relatorios_falhos: 1,
    }] })
    abrir('/no/auditor', sessao('NO_ADMIN', 'aal2'))
    expect(await screen.findByText('loja.com.br')).toBeInTheDocument()
    expect(screen.getByText('expirado')).toBeInTheDocument()
    expect(screen.getByText(/fonte_indisponivel/)).toBeInTheDocument()
  })
})
