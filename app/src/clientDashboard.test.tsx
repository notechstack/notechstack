import gazeta from '../onboarding/gazeta-bragantina.json'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientDashboardPage } from './client-dashboard/ClientDashboardPage'
import type {
  DashboardData,
  KanbanItem,
  ModuleKey,
  TierKey,
} from './client-dashboard/client-dashboard-service'

const mocks = vi.hoisted(() => ({
  loadClientDashboard: vi.fn(),
  savePreferredTier: vi.fn(),
}))

vi.mock('./client-dashboard/client-dashboard-service', () => ({
  loadClientDashboard: mocks.loadClientDashboard,
  savePreferredTier: mocks.savePreferredTier,
  calculateProgress: (items: KanbanItem[]) => {
    if (items.length === 0) return 0
    return Math.round((items.filter((item) => item.status === 'concluido').length / items.length) * 100)
  },
}))

const routeByModule: Record<ModuleKey, string> = {
  como_funciona: 'como-funciona',
  prototipo: 'prototipo',
  etapas: 'etapas',
  editor: 'editor',
  versoes: 'versoes',
  marca: 'marca',
}

function kanbanItem(index: number, status: KanbanItem['status']): KanbanItem {
  return {
    id: `item-${index}`,
    title: `Etapa ${index}`,
    phase: `Fase ${index}`,
    macro_version: index % 2 === 0 ? 'V2' : 'V1',
    status,
    scheduled_date: '2026-09-20',
    position: index,
  }
}

function dashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    shell: {
      project_id: 'projeto-a',
      project_name: 'Projeto Alfa',
      effective_access_status: 'INICIAL_15_DIAS',
      access_released_at: '2026-09-15T00:00:00Z',
      modules: {
        como_funciona: 'ativo', prototipo: 'ativo', etapas: 'ativo',
        editor: 'bloqueado', versoes: 'bloqueado', marca: 'bloqueado',
      },
    },
    roadmap: {
      stack: ['React', 'Supabase'],
      costs: ['Hospedagem'],
      next_steps: ['Validar protótipo'],
      references: ['Referência editorial'],
      preferred_tier: null,
      prototype_url: 'https://example.test/prototipo',
      published_at: '2026-09-15T00:00:00Z',
      tiers: {
        essencial: {
          escopo: ['Núcleo'], profundidade: 'enxuta', exclusoes: ['Automações'],
          complexidade: 'baixa', prazo_dias: 15, valor_centavos: null, faixa: null,
        },
        basico: {
          escopo: ['Operação'], profundidade: 'intermediária', exclusoes: ['IA'],
          complexidade: 'média', prazo_dias: 30, valor_centavos: 450000, faixa: null,
        },
        completo: {
          escopo: ['Produto'], profundidade: 'completa', exclusoes: [],
          complexidade: 'alta', prazo_dias: 45, valor_centavos: null, faixa: 'Sob proposta',
        },
      },
    },
    kanban: [kanbanItem(1, 'a_fazer'), kanbanItem(2, 'em_andamento'), kanbanItem(3, 'concluido')],
    ...overrides,
  }
}

function renderDashboardRoute(module: ModuleKey) {
  return render(
    <MemoryRouter initialEntries={[`/p/projeto-a/${routeByModule[module]}`]}>
      <Routes>
        <Route
          path="/p/:projectId/:module"
          element={<ClientDashboardPage module={module} />}
        />
      </Routes>
    </MemoryRouter>,
  )
}

function renderDashboard(module: ModuleKey, data = dashboardData()) {
  mocks.loadClientDashboard.mockResolvedValue(data)
  return renderDashboardRoute(module)
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  mocks.savePreferredTier.mockImplementation(async (_projectId: string, tier: TierKey) => ({
    preferred_tier: tier,
    changed: true,
  }))
})

describe('marca da agência no painel do cliente', () => {
  it('exibe agência no cabeçalho e nó no rodapé do menu', async () => {
    renderDashboard('etapas', dashboardData({ agency: { name: 'Maisis Publicidade', logoUrl: '/agencies/maisis/logo.png' } }))
    const logo = await screen.findByRole('img', { name: 'Maisis Publicidade' })
    expect(logo.closest('.client-sidebar > a')).not.toBeNull()
    const navigation = screen.getByLabelText('Tecnologia nó')
    expect(within(navigation).getByRole('img', { name: 'nó tech stack' })).toBeVisible()
    expect(screen.getAllByRole('img', { name: 'nó tech stack' })).toHaveLength(1)
  })
  it('mantém nome da agência quando a imagem falha', async () => {
    renderDashboard('etapas', dashboardData({ agency: { name: 'Maisis Publicidade', logoUrl: '/missing.png' } }))
    fireEvent.error(await screen.findByRole('img', { name: 'Maisis Publicidade' }))
    expect(screen.getByText('Maisis Publicidade').closest('.client-sidebar > a')).not.toBeNull()
    expect(screen.getAllByRole('img', { name: 'nó tech stack' })).toHaveLength(1)
  })
  it('mantém a marca da nó no cabeçalho de um cliente direto', async () => {
    renderDashboard('etapas', dashboardData({ agency: null }))
    const logos = await screen.findAllByRole('img', { name: 'nó tech stack' })
    expect(logos.some(logo => logo.closest('.client-sidebar > a'))).toBe(true)
    expect(logos.some(logo => logo.closest('.sidebar-bottom'))).toBe(true)
  })
})

describe('dashboard do cliente', () => {
  it('C17 mostra loading e recupera erro com retry', async () => {
    mocks.loadClientDashboard
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(dashboardData())
    renderDashboardRoute('como_funciona')

    expect(screen.getByRole('status')).toHaveTextContent('Carregando dados…')
    expect(await screen.findByRole('heading', { name: 'Não foi possível carregar o projeto.' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByRole('heading', { name: 'Da ideia a um sistema real, sem complicação.' })).toBeVisible()
    expect(mocks.loadClientDashboard).toHaveBeenCalledTimes(2)
  })

  it('C1 shell inicial e ordem dos cinco módulos visíveis', async () => {
    renderDashboard('como_funciona')
    expect(await screen.findByRole('heading', { name: 'Da ideia a um sistema real, sem complicação.' })).toBeVisible()
    expect(screen.getByText('Projeto Alfa')).toBeVisible()
    const nav = screen.getByRole('navigation', { name: 'Módulos do projeto' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual([
      '01Como funciona', '02Protótipo', '03Etapas do plano', '04Editor', '05Versões',
    ])
  })

  it('C2 aviso de quinze dias', async () => {
    renderDashboard('como_funciona')
    expect(await screen.findByText('Seu acesso de análise fica disponível por 15 dias.')).toBeVisible()
    expect(screen.getByText(/dias restantes/)).toBeVisible()
  })

  it('C3 acesso ativo omite aviso', async () => {
    const data = dashboardData()
    data.shell!.effective_access_status = 'ATIVO_ATE_FIM_DO_PROJETO'
    renderDashboard('como_funciona', data)
    await screen.findByRole('heading', { name: 'Da ideia a um sistema real, sem complicação.' })
    expect(screen.queryByText('Seu acesso de análise fica disponível por 15 dias.')).not.toBeInTheDocument()
  })

  it.each(Object.keys(routeByModule) as ModuleKey[])('C4 expirado cobre as seis rotas — %s', async (module) => {
    const data = dashboardData()
    data.shell!.effective_access_status = 'EXPIRADO'
    renderDashboard(module, data)
    expect(await screen.findByRole('heading', { name: 'Sua janela de análise terminou.' })).toBeVisible()
    expect(screen.queryByText('Projeto Alfa')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Módulos do projeto' })).not.toBeInTheDocument()
  })

  it('C6 conteúdo publicado e três caminhos', async () => {
    renderDashboard('como_funciona')
    expect(await screen.findByRole('link', { name: /Interface do site e hub React/ })).toHaveAttribute('href', 'https://react.dev')
    expect(screen.getByRole('link', { name: /Build e publicação Vite/ })).toHaveAttribute('href', 'https://vite.dev')
    expect(screen.getByRole('link', { name: /Banco de dados Supabase Dados/ })).toHaveAttribute('href', 'https://supabase.com/database')
    expect(screen.getByText('Quanto custa manter sua plataforma?')).toBeVisible()
    expect(screen.getByLabelText('Número de usuários')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Três profundidades para a mesma base.' })).toBeVisible()
    expect(screen.getByText(/Escolha o plano ideal para o seu momento/)).toBeVisible()
  })

  it('C7 três tiers campos e nulidade de preço', async () => {
    renderDashboard('como_funciona')
    await screen.findByRole('heading', { name: 'Essencial' })
    const options = screen.getByLabelText('Opções de execução')
    expect(within(options).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Básico', 'Essencial', 'Completo'])
    expect(screen.getByText(/4\.500/)).toBeVisible()
    expect(screen.getAllByText('Sob proposta')).toHaveLength(2)
    expect(within(options).getAllByText('Implementação')).toHaveLength(3)
    expect(within(options).getAllByText('Mensalidade')).toHaveLength(3)
  })

  it('C8 primeira preferência fica marcada', async () => {
    renderDashboard('como_funciona')
    const essential = (await screen.findByRole('heading', { name: 'Essencial' })).closest('article')!
    await userEvent.click(within(essential).getByRole('button', { name: 'Quero este plano' }))
    expect(mocks.savePreferredTier).toHaveBeenCalledWith('projeto-a', 'essencial')
    expect(await screen.findByRole('button', { name: 'Contratado' })).toBeDisabled()
  })

  it('C9 seleção exclusiva troca de tier', async () => {
    const data = dashboardData()
    data.roadmap!.preferred_tier = 'essencial'
    renderDashboard('como_funciona', data)
    const basic = (await screen.findByRole('heading', { name: 'Básico' })).closest('article')!
    const essential = screen.getByRole('heading', { name: 'Essencial' }).closest('article')!
    await userEvent.click(within(basic).getByRole('button', { name: 'Quero este plano' }))
    expect(within(essential).getByRole('button', { name: 'Quero este plano' })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: 'Contratado' })).toHaveLength(1)
    expect(mocks.savePreferredTier).toHaveBeenCalledTimes(1)
  })

  it('C10 protótipo usa iframe em mockup infinito e link externo', async () => {
    const { container } = renderDashboard('prototipo')
    expect(await screen.findByTitle('Protótipo navegável do projeto')).toHaveAttribute('src', 'https://example.test/prototipo')
    expect(screen.getByRole('link', { name: /Abrir protótipo em nova aba/ })).toHaveAttribute('target', '_blank')
    expect(container.querySelector('.prototype-phone')).toHaveClass('infinite')
    expect(screen.queryByRole('button', { name: /Desktop|Celular/ })).toBeNull()
    expect(screen.queryByText(/Anote suas observações/)).toBeNull()
  })

  it('C11 etapas por fase mantêm progresso real, datas e versões', async () => {
    const items = Array.from({ length: 27 }, (_, index) => kanbanItem(index + 1, index < 17 ? 'concluido' : index < 22 ? 'em_andamento' : 'a_fazer'))
    renderDashboard('etapas', dashboardData({ kanban: items }))
    expect(await screen.findByRole('heading', { name: '63% concluído' })).toBeVisible()
    expect(screen.getAllByRole('heading', { level: 3, name: /^(A ideia|O plano|O protótipo|O sistema|Progresso)$/ }).map((heading) => heading.textContent)).toEqual(['A ideia', 'O plano', 'O protótipo', 'O sistema', 'Progresso'])
    expect(screen.getByRole('progressbar', { name: 'Progresso total do projeto' })).toHaveAttribute('aria-valuenow', '63')
    expect(screen.getAllByText(/V1/).length).toBeGreaterThan(0)
    expect(screen.getAllByText('20/09/2026').length).toBeGreaterThan(0)
  })

  it('C12 Kanban do cliente é somente leitura', async () => {
    const { container } = renderDashboard('etapas')
    await screen.findByText(/Acompanhamento somente leitura/)
    const content = container.querySelector('.client-content') as HTMLElement
    expect(within(content).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(content).queryByRole('button', { name: /salvar|editar|mover/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/mover|concluir/i)).not.toBeInTheDocument()
  })

  it('C13 Editor bloqueado usa copy exata', async () => {
    renderDashboard('editor')
    expect(await screen.findByText('O Editor é liberado quando a primeira versão do seu projeto fica pronta.')).toBeVisible()
    expect(screen.getByText('Você poderá testar textos, cores, logos e ajustes visuais antes de nos enviar suas preferências para a próxima versão.')).toBeVisible()
  })

  it('C14 Versões bloqueadas usa copy exata', async () => {
    renderDashboard('versoes')
    expect(await screen.findByText('Suas versões aparecem aqui quando a construção começar.')).toBeVisible()
    expect(screen.getByText('Cada entrega fica registrada para você acompanhar a evolução do produto até o go-live.')).toBeVisible()
  })

  it('F2-09 C4 e C12 exibem histórico ativo da versão mais recente', async () => {
    const data = dashboardData({
      shell: { ...dashboardData().shell!, modules: { ...dashboardData().shell!.modules, editor: 'ativo', versoes: 'ativo' } },
      versions: [
        { id: 'v2', label: 'V2', macro: 'V2', status: 'publicada', published_at: '2026-09-16T12:00:00Z', changelog: 'Segunda entrega', build_reference: 'build-v2', is_current: true, created_at: '2026-09-16T12:00:00Z', editor_checklists: [{ id: 'check-1', versionId: 'v2', status: 'ingerido', baseVersionLabel: 'V1', items: [{ screen: 'home', component: 'hero', changes: [{ before: {}, after: { text: 'Novo' } }] }] }] },
        { id: 'v1', label: 'V1', macro: 'V1', status: 'publicada', published_at: '2026-09-15T12:00:00Z', changelog: 'Primeira entrega', build_reference: 'build-v1', is_current: false, created_at: '2026-09-15T12:00:00Z', editor_checklists: [] },
      ],
    })
    renderDashboard('versoes', data)
    expect((await screen.findAllByText('V2'))[0]).toBeVisible()
    expect(screen.getByText('Atual')).toBeVisible()
    expect(screen.getAllByText('Segunda entrega')[0]).toBeVisible()
    expect(screen.getByText('Primeira entrega')).toBeVisible()
    expect(screen.getByText('Build: build-v2')).toBeVisible()
    expect(screen.getByText('Build: build-v1')).toBeVisible()
    expect(screen.getByText('Ajustes do Editor incorporados')).toBeVisible()
    expect(screen.getByText('home / hero')).toBeVisible()
  })

  it('C15 Marca e arquivos permanece bloqueado', async () => {
    const { container } = renderDashboard('marca')
    expect(await screen.findByRole('heading', { name: 'Marca & arquivos', level: 2 })).toBeVisible()
    expect(screen.getByText('Texto provisório · revisar copy')).toBeVisible()
    const content = container.querySelector('.client-content') as HTMLElement
    expect(within(content).queryByRole('button')).not.toBeInTheDocument()
  })

  it('tema claro é padrão e o seletor persiste o tema escuro', async () => {
    renderDashboard('como_funciona')
    const dashboard = await screen.findByRole('main')
    expect(dashboard).toHaveAttribute('data-theme', 'light')

    await userEvent.click(screen.getByRole('button', { name: /Escuro/ }))

    expect(dashboard).toHaveAttribute('data-theme', 'dark')
    expect(window.localStorage.getItem('no-client-dashboard-theme')).toBe('dark')
  })

  it.each([
    ['como_funciona', 'Seu plano ainda está sendo preparado. Assim que for publicado, ele aparece aqui.'],
    ['prototipo', 'O protótipo ainda não foi publicado para este projeto.'],
  ] as const)('C16 vazios de roadmap e protótipo — %s', async (module, copy) => {
    const data = dashboardData()
    data.roadmap!.published_at = null
    renderDashboard(module, data)
    expect(await screen.findByText(copy)).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps dashboard data mounted across tab changes without refetching', async () => {
    mocks.loadClientDashboard.mockResolvedValue(dashboardData())
    render(<MemoryRouter initialEntries={['/p/projeto-a/como-funciona']}>
      <Routes>
        <Route path="/p/:projectId/como-funciona" element={<ClientDashboardPage module="como_funciona" />} />
        <Route path="/p/:projectId/etapas" element={<ClientDashboardPage module="etapas" />} />
      </Routes>
    </MemoryRouter>)
    await screen.findByText('Tecnologia moderna e integrada.')
    const initialLoads = mocks.loadClientDashboard.mock.calls.length
    await userEvent.click(screen.getByRole('link', { name: /03\s*Etapas do plano/ }))
    expect(await screen.findByRole('heading', { name: /Do planejamento/ })).toBeVisible()
    await userEvent.click(screen.getByRole('link', { name: /01\s*Como funciona/ }))
    expect(await screen.findByText('Tecnologia moderna e integrada.')).toBeVisible()
    expect(mocks.loadClientDashboard).toHaveBeenCalledTimes(initialLoads)
  })

  it('C16 vazio de Kanban', async () => {
    renderDashboard('etapas', dashboardData({ kanban: [] }))
    expect(await screen.findByText('As etapas entram aqui assim que o plano de execução for organizado.')).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})


describe('Gazeta: conteúdo específico e revisão final', () => {
  function gazetaData(): DashboardData {
    const base = dashboardData()
    return {
      ...base,
      roadmap: { ...gazeta.roadmap, published_at: '2026-09-23T20:00:00Z' },
      kanban: gazeta.tasks.map((item) => ({ ...item, status: item.status as KanbanItem['status'], macro_version: null, scheduled_date: null })),
    }
  }
  it('mostra a stack editorial e as ativações pendentes sem a simulação da clínica', async () => {
    mocks.loadClientDashboard.mockResolvedValue(gazetaData())
    renderDashboardRoute('como_funciona')
    expect(await screen.findByText('A tecnologia por trás da Gazeta.')).toBeInTheDocument()
    expect(screen.getByText('Next.js + React')).toBeInTheDocument()
    expect(screen.getByText('Cloudflare R2')).toBeInTheDocument()
    expect(screen.getByText('Código pronto · chave e domínio pendentes')).toBeInTheDocument()
    expect(screen.queryByText(/stack da clínica/)).not.toBeInTheDocument()
    expect(screen.queryByText('Três profundidades para a mesma base.')).not.toBeInTheDocument()
  })
  it('preserva as cinco fases, os 30 itens e as ressalvas do roadmap', async () => {
    mocks.loadClientDashboard.mockResolvedValue(gazetaData())
    renderDashboardRoute('etapas')
    expect(await screen.findByText('90% concluído')).toBeInTheDocument()
    expect(screen.getByText('22/07/2026')).toBeInTheDocument()
    expect(screen.getByText('09/09/2026 a 23/09/2026')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Meus projetos/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Voltar aos projetos' })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Etapa 1: Fase 0 · Preparação' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Etapa 5: Fase 4 · Go-live' })).toBeInTheDocument()
    expect(screen.getByText(/27 de 30 itens entregues/)).toBeInTheDocument()
    expect(screen.getAllByText(/Ainda falta transpor a experiência visual completa/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Roadmap do projeto publicado')).not.toBeInTheDocument()
  })
  it('explica o bloqueio final sem carregar o Editor', async () => {
    mocks.loadClientDashboard.mockResolvedValue(gazetaData())
    renderDashboardRoute('editor')
    expect(await screen.findByText(gazeta.roadmap.next_steps.presentation.editor_lock_reason)).toBeInTheDocument()
    expect(screen.queryByText(/O Editor é liberado quando/)).not.toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
  })
  it('mantém o pacote de aprovação navegável independente do bloqueio do Editor', async () => {
    mocks.loadClientDashboard.mockResolvedValue(gazetaData())
    renderDashboardRoute('prototipo')
    expect(await screen.findByTitle('Protótipo navegável do projeto')).toHaveAttribute('src', gazeta.roadmap.prototype_url)
    expect(screen.getByText('Versão final em análise')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Abrir protótipo em nova aba ↗' })).toHaveAttribute('href', gazeta.roadmap.prototype_url)
  })
})
