import { useEffect, useState, type ReactNode, useRef } from 'react'
import { Link, NavLink, useParams } from 'react-router-dom'
import {
  loadClientDashboard,
  savePreferredTier,
  type DashboardData,
  type JsonValue,
  type ModuleKey,
  type ProjectVersion,
  type Roadmap,
  type Tier,
  type TierKey,
} from './client-dashboard-service'
import { EditorModule } from './EditorModule'
import { StagesModule } from './StagesModule'
import './client-dashboard.css'
import { projectArchitecture, projectPresentation, record, text } from './project-presentation'
import { ProjectArchitecture, ProjectCostCalculator } from './ProjectInfrastructure'
import './project-infrastructure.css'

const MODULES: Array<{
  key: ModuleKey
  number: string
  label: string
  path: string
}> = [
  {
    key: 'como_funciona',
    number: '01',
    label: 'Como funciona',
    path: 'como-funciona',
  },
  { key: 'prototipo', number: '02', label: 'Protótipo', path: 'prototipo' },
  { key: 'etapas', number: '03', label: 'Etapas do plano', path: 'etapas' },
  { key: 'editor', number: '04', label: 'Editor', path: 'editor' },
  { key: 'versoes', number: '05', label: 'Versões', path: 'versoes' },
]

const TIER_ORDER: Array<{ key: TierKey; label: string; color: string }> = [
  { key: 'basico', label: 'Básico', color: 'border-azul' },
  { key: 'essencial', label: 'Essencial', color: 'border-ambar' },
  { key: 'completo', label: 'Completo', color: 'border-verde' },
]


type ClientDashboardPageProps = {
  module: ModuleKey
  previewData?: DashboardData
}

function ClientBrand({ agency, theme }: { agency: DashboardData['agency']; theme: DashboardTheme }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const logo = agency?.logoUrl
  const validLogo = logo && (/^\/(?!\/)/.test(logo) || /^https:\/\//.test(logo))
  if (!agency) return <img className="client-logo" src={theme === 'light' ? '/no-tech-stack-tinta-ponto-ambar.svg' : '/no-tech-stack-branca-ponto-ambar.svg'} alt="nó tech stack" />
  return validLogo && failedUrl !== logo
    ? <img className="client-agency-logo" src={logo} alt={agency.name} onError={() => setFailedUrl(logo)} />
    : <span className="client-agency-name">{agency.name}</span>
}

type DashboardTheme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'no-client-dashboard-theme'

function getInitialTheme(): DashboardTheme {
  const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
  return storedTheme === 'dark' ? 'dark' : 'light'
}

function toDisplayItems(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.map((item) =>
      typeof item === 'object' && item !== null
        ? JSON.stringify(item)
        : String(item),
    )
  }

  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([key, item]) => `${key}: ${String(item)}`)
  }

  return value === null || value === '' ? [] : [String(value)]
}

function TierCard({
  tier,
  tierKey,
  label,
  color,
  selected,
  saving,
  onSelect,
}: {
  tier: Tier
  tierKey: TierKey
  label: string
  color: string
  selected: boolean
  saving: boolean
  onSelect: (tier: TierKey) => void
}) {
  const features = toDisplayItems(tier.escopo)
  const monthlyMatch = String(tier.faixa ?? '').match(/R\$\s*([\d.]+(?:,\d+)?)\s*\/mês/i)
  const monthlyPrice = monthlyMatch ? `R$ ${monthlyMatch[1]}/mês` : 'Sob consulta'

  return (
    <article
      className={`flex h-full flex-col rounded-2xl border-t-4 bg-white p-5 shadow-card ${color} ${
        selected
          ? 'ring-2 ring-azul ring-offset-2'
          : 'border-x border-b border-x-borda border-b-borda'
      }`}
      data-tier={tierKey}
    >
      <div className="tier-card-heading">
        <h3 className="text-xl font-extrabold uppercase tracking-[-0.03em]">
          {label}
        </h3>
        {tierKey === 'essencial' ? (
          <span className="tier-recommended">
            Mais escolhido
          </span>
        ) : null}
      </div>
      <ul className="tier-features">
        {features.map((feature) => (
          <li key={feature}>
            <span aria-hidden="true">✓</span>
            {feature}
          </li>
        ))}
      </ul>
      <dl className="tier-pricing">
        <div>
          <dt>Implementação</dt>
          <dd>
            {tier.valor_centavos != null
              ? new Intl.NumberFormat('pt-BR', {
                  style: 'currency',
                  currency: 'BRL',
                  maximumFractionDigits: 0,
                }).format(tier.valor_centavos / 100)
              : 'Sob proposta'}
          </dd>
        </div>
        <div>
          <dt>Mensalidade</dt>
          <dd>{monthlyPrice}</dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={() => onSelect(tierKey)}
        disabled={saving || selected}
        className="mt-6 w-full rounded-xl bg-tinta px-4 py-3 text-sm font-semibold text-white transition hover:bg-azul disabled:cursor-default disabled:bg-cinza focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul"
      >
        {saving
          ? 'Salvando…'
          : selected
            ? 'Contratado'
            : 'Quero este plano'}
      </button>
    </article>
  )
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-borda bg-white p-8 text-center text-cinza">
      <span
        aria-hidden="true"
        className="mx-auto mb-4 block h-3 w-3 rounded-full bg-ambar"
      />
      {children}
    </div>
  )
}

function LockedState({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="rounded-3xl border border-borda bg-white p-7 shadow-card sm:p-10">
      <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-vermelho">
        Bloqueado
      </span>
      <h2 className="mt-4 text-3xl font-extrabold uppercase tracking-[-0.04em]">
        {title}
      </h2>
      <div className="mt-4 max-w-2xl space-y-3 font-light leading-7 text-cinza">
        {children}
      </div>
    </section>
  )
}

function OverviewModule({
  roadmap,
  selectedTier,
  savingTier,
  saveError,
  onSelectTier,
}: {
  roadmap: Roadmap | null
  selectedTier: TierKey | null
  savingTier: TierKey | null
  saveError: boolean
  onSelectTier: (tier: TierKey) => void
}) {
  if (!roadmap?.published_at) {
    return (
      <EmptyState>
        Seu plano ainda está sendo preparado. Assim que for publicado, ele
        aparece aqui.
      </EmptyState>
    )
  }

  const architecture = projectArchitecture(roadmap)
  const presentation = projectPresentation(roadmap)
  if (architecture) return <div className="overview-details">
    <ProjectArchitecture architecture={architecture} />
    <section className="overview-section-heading"><p className="eyebrow">Estado do projeto</p><h2>{text(presentation.review_label)}</h2><p>{text(presentation.review_description)}</p></section>
    <section className="overview-section-heading">
      <p className="eyebrow">Infraestrutura e ativação</p>
      <h2>{text(presentation.infrastructure_title, 'O que já funciona e o que vem a seguir.')}</h2>
      {Array.isArray(presentation.scope_options) ? <>
        <div className="scope-comparison">{presentation.scope_options.map((value) => {
          const option = record(value)
          const price = text(option.price)
          const ctaLabel = text(option.cta_label)
          const ctaHref = text(option.cta_href)
          return <article key={text(option.label)} className={`scope-option${option.selected === true ? ' scope-option-selected' : ''}${price ? ' scope-option-priced' : ''}`}>
            <p className="eyebrow">{option.selected === true ? 'Proposta aprovada' : text(option.badge, 'Alternativa apresentada')}</p>
            <h3>{text(option.label)}</h3>
            {price ? <p className="scope-price"><strong>{price}</strong>{text(option.price_note) ? <small>{text(option.price_note)}</small> : null}</p> : null}
            {text(option.tagline) ? <p className="scope-tagline">{text(option.tagline)}</p> : null}
            <ul>{toDisplayItems(option.features ?? []).map((feature) => <li key={feature}>{feature}</li>)}</ul>
            {ctaLabel && /^(https:\/\/|mailto:)/.test(ctaHref) ? <a className="scope-cta" href={ctaHref} target="_blank" rel="noreferrer noopener">{ctaLabel} <span aria-hidden="true">→</span></a> : null}
          </article>
        })}</div>
        <p className="infra-caption">{text(presentation.scope_note)}</p>
      </> : <ul>{toDisplayItems(roadmap.costs).map((item) => <li key={item}>{item}</li>)}</ul>}
    </section>
  </div>

  return (
    <div className="overview-details">
      <ProjectArchitecture />
      <ProjectCostCalculator />

      <section className="overview-tiers">
        <p className="eyebrow">Caminhos de execução</p>
        <h2 className="mt-3 max-w-3xl text-3xl font-extrabold tracking-[-0.04em] sm:text-4xl">
          Três profundidades para a mesma base.
        </h2>
        <p className="mt-4 max-w-3xl font-light leading-7 text-cinza">
          Escolha o plano ideal para o seu momento. Todos incluem acompanhamento da nossa equipe e podem ser ajustados conforme a evolução do projeto.
        </p>
        {saveError ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border-l-4 border-vermelho bg-vermelho-tint px-4 py-3 text-sm"
          >
            Não foi possível salvar sua escolha. Tente novamente.
          </p>
        ) : null}
        <div
          className="mt-7 grid gap-5 lg:grid-cols-3"
          aria-label="Opções de execução"
        >
          {TIER_ORDER.map(({ key, label, color }) => {
            const tier = roadmap.tiers[key]
            return tier ? (
              <TierCard
                key={key}
                tier={tier}
                tierKey={key}
                label={label}
                color={color}
                selected={selectedTier === key}
                saving={savingTier !== null}
                onSelect={onSelectTier}
              />
            ) : null
          })}
        </div>
      </section>
      <div className="overview-benefits">
        {[
          ['calendar-clock', 'Prazo de entrega', 'De 30 a 45 dias', 'conforme o escopo'],
          ['headphones', 'Suporte e manutenção', 'Acompanhamento contínuo', 'da nossa equipe'],
          ['credit-card', 'Pagamentos', 'Parcelamento via Pagar.me', ''],
        ].map(([icon, title, line, detail]) => (
          <div key={title}>
            <span><img src={`/icons/lucide/${icon}.svg`} alt="" /></span>
            <p><strong>{title}</strong>{line}<small>{detail}</small></p>
          </div>
        ))}
        <a
          className="overview-whatsapp-card"
          href="https://wa.me/5511939289413"
          target="_blank"
          rel="noreferrer"
        >
          <span><img src="/icons/brands/whatsapp.svg" alt="" /></span>
          <p><strong>Pronto para começar?</strong>Fale com a gente e vamos dar o próximo passo.</p>
        </a>
      </div>
    </div>
  )
}

function PrototypeModule({ roadmap }: { roadmap: Roadmap | null }) {
  const [expanded, setExpanded] = useState(false)
  const [contentHeight, setContentHeight] = useState<number | null>(null)
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop')
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [])
  // Mockup infinito: o quadro cresce até a altura do protótipo (mesma origem), sem rolagem interna.
  useEffect(() => {
    const iframe = frame.current
    if (!iframe) return
    let observer: ResizeObserver | null = null
    const measure = () => {
      try {
        const doc = iframe.contentDocument
        const height = doc?.documentElement ? Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0) : 0
        if (height > 0) setContentHeight(height)
      } catch {
        setContentHeight(null)
      }
    }
    const attach = () => {
      observer?.disconnect()
      measure()
      try {
        const body = iframe.contentDocument?.body
        if (body && typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(measure)
          observer.observe(body)
        }
      } catch {
        // Origem diferente: mantém a altura padrão da moldura.
      }
    }
    iframe.addEventListener('load', attach)
    if (iframe.contentDocument?.readyState === 'complete') attach()
    return () => {
      iframe.removeEventListener('load', attach)
      observer?.disconnect()
    }
  }, [roadmap?.prototype_url, device])
  const presentation = projectPresentation(roadmap)
  if (!roadmap?.published_at || !roadmap.prototype_url)
    return (
      <EmptyState>
        O protótipo ainda não foi publicado para este projeto.
      </EmptyState>
    )
  return (
    <section
      className={`prototype-layout ${expanded ? 'prototype-expanded' : ''}`}
    >
      <div className="prototype-stage">
        {expanded ? (
          <button className="close-preview" onClick={() => setExpanded(false)}>
            Fechar tela cheia ×
          </button>
        ) : null}
        <div
          className="prototype-device-toggle"
          role="group"
          aria-label="Formato do protótipo"
        >
          <button
            type="button"
            aria-pressed={device === 'desktop'}
            onClick={() => setDevice('desktop')}
          >
            ▱ Desktop
          </button>
          <button
            type="button"
            aria-pressed={device === 'mobile'}
            onClick={() => setDevice('mobile')}
          >
            ▯ Celular
          </button>
        </div>
        <div className={`prototype-phone infinite ${device}`}>
          {device === 'mobile' ? (
            <div className="phone-status">
              <span>9:41</span>
              <i />
              <span>▱</span>
            </div>
          ) : null}
          <iframe
            ref={frame}
            src={roadmap.prototype_url}
            title="Protótipo navegável do projeto"
            style={!expanded && contentHeight ? { height: `${contentHeight}px` } : undefined}
          />
        </div>
      </div>
      <aside className="prototype-info">
        <p className="eyebrow">Protótipo navegável</p>
        <h2>{text(presentation.prototype_title, 'Teste a primeira direção.')}</h2>
        <p>
          Navegue pelo protótipo e explore a direção de fluxo e interface do seu
          produto.
        </p>
        <dl className="prototype-meta">
          <div>
            <dt>Estado</dt>
            <dd>{text(presentation.review_label, 'Publicado')}</dd>
          </div>
          <div>
            <dt>Publicado</dt>
            <dd>{formatDate(roadmap.published_at)}</dd>
          </div>
        </dl>
        <button className="button-light" onClick={() => setExpanded(true)}>
          Abrir em tela cheia
        </button>
        <a
          className="button-outline"
          href={roadmap.prototype_url}
          target="_blank"
          rel="noreferrer noopener"
        >
          Abrir protótipo em nova aba ↗
        </a>
        <p className="prototype-note">
          {text(presentation.editor_lock_reason, 'Somente visualização. Os ajustes que você quiser pedir entram pelo Editor, quando liberado para o projeto.')}
        </p>
      </aside>
    </section>
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(value))
}


function VersionsModule({ versions }: { versions: ProjectVersion[] }) {
  if (versions.length === 0) {
    return (
      <EmptyState>A primeira versão ainda está sendo preparada.</EmptyState>
    )
  }

  const currentVersion = versions.find((version) => version.is_current)
  return (
    <section className="versions-module">
      <p className="eyebrow">Histórico de entregas</p>
      <h2 className="mt-2 text-4xl font-extrabold tracking-[-0.04em]">
        Versões do projeto
      </h2>
      {currentVersion ? (
        <div className="current-version">
          <div>
            <p className="eyebrow">Versão atual</p>
            <strong>{currentVersion.label}</strong>
            <p>
              Esta é a versão publicada e a base dos seus ajustes no Editor.
            </p>
            <span className="live-badge">● No ar</span>
          </div>
          <div className="current-changelog">
            <p className="eyebrow">Changelog</p>
            <p>{currentVersion.changelog}</p>
          </div>
        </div>
      ) : null}
      <ol className="version-timeline">
        {versions.map((version) => (
          <li
            className={`version-card ${version.is_current ? 'current' : ''}`}
            key={version.id}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold">{version.label}</h3>
                <p className="mt-1 text-sm text-cinza">
                  {version.status} ·{' '}
                  {new Intl.DateTimeFormat('pt-BR', {
                    dateStyle: 'medium',
                    timeZone: 'America/Sao_Paulo',
                  }).format(new Date(version.published_at))}
                </p>
              </div>
              {version.is_current ? (
                <span className="rounded-full bg-verde px-3 py-1 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.1em] text-white">
                  Atual
                </span>
              ) : null}
            </div>
            <p className="mt-4 whitespace-pre-wrap text-sm leading-6">
              {version.changelog}
            </p>
            <p className="mt-3 font-mono text-xs text-cinza">
              Build: {version.build_reference}
            </p>
            {version.editor_checklists.map((checklist) => (
              <div className="mt-4 rounded-xl bg-osso p-4" key={checklist.id}>
                <p className="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-azul">
                  Ajustes do Editor incorporados
                </p>
                <p className="mt-1 text-xs text-cinza">
                  Solicitados sobre {checklist.baseVersionLabel}
                </p>
                <ul className="mt-3 space-y-2">
                  {checklist.items.map((group) => (
                    <li
                      className="text-sm"
                      key={`${group.screen}:${group.component}`}
                    >
                      <span className="font-semibold">
                        {group.screen} / {group.label ?? group.component}
                      </span>
                      <span className="text-cinza">
                        {' '}
                        · {group.changes.length} ajuste(s)
                      </span>
                      <details className="change-details">
                        <summary>Ver alterações</summary>
                        {group.changes.map((change, index) => (
                          <div
                            className="mt-2 grid gap-2 text-xs sm:grid-cols-2"
                            key={index}
                          >
                            <p className="rounded bg-white p-2">
                              Antes:{' '}
                              {toDisplayItems(change.before).join(' · ') ||
                                'Versão original'}
                            </p>
                            <p className="rounded bg-white p-2">
                              Depois: {toDisplayItems(change.after).join(' · ')}
                            </p>
                          </div>
                        ))}
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </li>
        ))}
      </ol>
    </section>
  )
}

function DashboardModule({
  module,
  data,
  selectedTier,
  savingTier,
  saveError,
  onSelectTier,
}: {
  module: ModuleKey
  data: DashboardData
  selectedTier: TierKey | null
  savingTier: TierKey | null
  saveError: boolean
  onSelectTier: (tier: TierKey) => void
}) {
  if (module === 'editor' && data.shell?.modules.editor !== 'ativo') {
    return (
      <LockedState title="Editor">
        <p>
          {text(projectPresentation(data.roadmap).editor_lock_reason, 'O Editor é liberado quando a primeira versão do seu projeto fica pronta.')}
        </p>
        {!projectPresentation(data.roadmap).editor_lock_reason ? <p>
          Você poderá testar textos, cores, logos e ajustes visuais antes de nos
          enviar suas preferências para a próxima versão.
        </p> : null}
      </LockedState>
    )
  }
  if (module === 'versoes' && data.shell?.modules.versoes !== 'ativo') {
    return (
      <LockedState title="Versões">
        <p>Suas versões aparecem aqui quando a construção começar.</p>
        <p>
          Cada entrega fica registrada para você acompanhar a evolução do
          produto até o go-live.
        </p>
      </LockedState>
    )
  }
  if (module === 'como_funciona') {
    return (
      <OverviewModule
        roadmap={data.roadmap}
        selectedTier={selectedTier}
        savingTier={savingTier}
        saveError={saveError}
        onSelectTier={onSelectTier}
      />
    )
  }
  if (module === 'prototipo') {
    return <PrototypeModule roadmap={data.roadmap} />
  }
  if (module === 'etapas') {
    return <StagesModule items={data.kanban} versions={data.versions} roadmap={data.roadmap} />
  }
  if (module === 'editor') {
    return (
      <EditorModule
        key={data.shell?.project_id}
        projectId={data.shell?.project_id ?? ''}
      />
    )
  }
  if (module === 'versoes') {
    return <VersionsModule versions={data.versions ?? []} />
  }

  return (
    <LockedState title="Marca & arquivos">
      <p>
        Este espaço será liberado quando os arquivos e definições de marca
        entrarem na construção.
      </p>
      <p className="font-mono text-xs uppercase tracking-[0.1em]">
        Texto provisório · revisar copy
      </p>
    </LockedState>
  )
}

function ProjectNavigation({
  projectId,
  currentModule,
  modules,
  preview = false,
}: {
  projectId: string
  currentModule: ModuleKey
  modules: NonNullable<DashboardData['shell']>['modules']
  preview?: boolean
}) {
  return (
    <nav aria-label="Módulos do projeto" className="lg:w-64 lg:shrink-0">
      <div className="flex gap-2 overflow-x-auto pb-3 lg:flex-col lg:overflow-visible lg:pb-0">
        {MODULES.map((item) => (
          <NavLink
            key={item.key}
            to={preview ? `/__preview/cliente-agencia/${item.path}` : `/p/${encodeURIComponent(projectId)}/${item.path}`}
            aria-current={currentModule === item.key ? 'page' : undefined}
            className={({ isActive }) =>
              `group flex min-w-max items-center gap-3 rounded-xl px-4 py-3 text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul ${isActive ? 'bg-tinta text-white shadow-card' : 'bg-white text-tinta hover:bg-azul-tint'}`
            }
          >
            <span className="font-mono text-[0.625rem] tracking-[0.1em] text-cinza group-aria-[current=page]:text-ambar">
              {item.number}
            </span>
            <span className="font-semibold">{item.label}</span>
            {modules[item.key] !== 'ativo' ? (
              <svg
                className="nav-lock"
                aria-label="Bloqueado"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="5" y="10" width="14" height="11" rx="2" />
                <path d="M8 10V6a4 4 0 0 1 8 0v4" />
              </svg>
            ) : null}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

export function ClientDashboardPage({ module, previewData }: ClientDashboardPageProps) {
  const { projectId = '' } = useParams()
  const [now] = useState(() => Date.now())
  const [theme, setTheme] = useState<DashboardTheme>(getInitialTheme)
  const [data, setData] = useState<DashboardData | null>(null)
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null)
  const [loadErrorProjectId, setLoadErrorProjectId] = useState<string | null>(
    null,
  )
  const [reloadKey, setReloadKey] = useState(0)
  const [selectedTier, setSelectedTier] = useState<TierKey | null>(null)
  const [savingTier, setSavingTier] = useState<TierKey | null>(null)
  const [saveError, setSaveError] = useState(false)

  useEffect(() => {
    let active = true

    void (previewData ? Promise.resolve(previewData) : loadClientDashboard(projectId))
      .then((nextData) => {
        if (!active) return
        setData(nextData)
        setLoadedProjectId(projectId)
        setLoadErrorProjectId(null)
        setSelectedTier(nextData.roadmap?.preferred_tier ?? null)
      })
      .catch(() => {
        if (!active) return
        setLoadErrorProjectId(projectId)
      })

    return () => {
      active = false
    }
  }, [projectId, reloadKey, previewData])

  async function selectTier(tier: TierKey) {
    if (previewData) return
    if (tier === selectedTier || savingTier !== null) return
    setSavingTier(tier)
    setSaveError(false)
    try {
      const result = await savePreferredTier(projectId, tier)
      setSelectedTier(result.preferred_tier)
    } catch {
      setSaveError(true)
    } finally {
      setSavingTier(null)
    }
  }

  if (loadErrorProjectId === projectId) {
    return (
      <main className="grid min-h-screen place-items-center bg-osso px-6 text-tinta">
        <div className="max-w-md rounded-2xl border border-borda bg-white p-8 text-center shadow-card">
          <h1 className="text-2xl font-extrabold">
            Não foi possível carregar o projeto.
          </h1>
          <p className="mt-3 text-sm leading-6 text-cinza">
            Confira sua conexão e tente novamente.
          </p>
          <button
            type="button"
            onClick={() => {
              setLoadErrorProjectId(null)
              setData(null)
              setLoadedProjectId(null)
              setReloadKey((value) => value + 1)
            }}
            className="mt-6 rounded-xl bg-tinta px-5 py-3 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-azul"
          >
            Tentar de novo
          </button>
        </div>
      </main>
    )
  }

  if (!data || loadedProjectId !== projectId) {
    return (
      <main
        className="grid min-h-screen place-items-center bg-osso text-cinza"
        role="status"
      >
        Carregando dados…
      </main>
    )
  }

  if (!data.shell) {
    return (
      <main className="grid min-h-screen place-items-center bg-osso px-6 text-center">
        <div>
          <h1 className="text-3xl font-extrabold">Projeto não disponível.</h1>
          <Link
            className="mt-5 inline-block text-azul underline"
            to="/p/projetos"
          >
            Voltar aos projetos
          </Link>
        </div>
      </main>
    )
  }

  if (data.shell.effective_access_status === 'EXPIRADO') {
    return (
      <main className="grid min-h-screen place-items-center bg-osso px-6 text-tinta">
        <section className="max-w-xl rounded-3xl border border-borda bg-white p-8 text-center shadow-card sm:p-12">
          <span className="font-mono text-xs font-semibold uppercase tracking-[0.14em] text-vermelho">
            Acesso expirado
          </span>
          <h1 className="mt-4 text-4xl font-extrabold tracking-[-0.04em]">
            Sua janela de análise terminou.
          </h1>
          <p className="mt-5 font-light leading-7 text-cinza">
            Fale com {data.agency?.name ?? 'a Nó'} para retomar o projeto e manter o dashboard disponível
            durante a construção.
          </p>
          <p className="mt-5 font-mono text-xs uppercase tracking-[0.1em] text-cinza">
            Texto provisório · revisar copy
          </p>
        </section>
      </main>
    )
  }

  const shell = data.shell
  const showTrialNotice = shell.effective_access_status === 'INICIAL_15_DIAS'
  const remaining = shell.access_released_at
    ? Math.max(
        0,
        Math.ceil(
          (new Date(shell.access_released_at).getTime() + 15 * 86400000 - now) /
            86400000,
        ),
      )
    : null
  return (
    <main className={`client-dashboard module-${module}`} data-theme={theme}>
      <div className="brand-stripe" />
      <aside className="client-sidebar">
        {projectPresentation(data.roadmap).hide_project_navigation === true
          ? <ClientBrand agency={data.agency} theme={theme} />
          : <Link to="/p/projetos" aria-label="Voltar aos projetos"><ClientBrand agency={data.agency} theme={theme} /></Link>}
        <p className="sidebar-label">Projeto</p>
        <strong className="sidebar-project-name">{shell.project_name}</strong>
        <ProjectNavigation
          projectId={projectId}
          currentModule={module}
          modules={shell.modules}
          preview={Boolean(previewData)}
        />
        <div className="sidebar-bottom">
          <div className="agency-powered-by" aria-label="Tecnologia nó">
            <p>Tecnologia e desenvolvimento</p>
            <img src={theme === 'light' ? '/no-tech-stack-tinta-ponto-ambar.svg' : '/no-tech-stack-branca-ponto-ambar.svg'} alt="nó tech stack" />
          </div>
          {projectPresentation(data.roadmap).hide_project_navigation !== true ? <Link to="/p/projetos">← Meus projetos</Link> : null}
          <div className="theme-switch" role="group" aria-label="Tema do painel">
            <button
              type="button"
              aria-pressed={theme === 'light'}
              onClick={() => {
                setTheme('light')
                window.localStorage.setItem(THEME_STORAGE_KEY, 'light')
              }}
            >
              <span aria-hidden="true">☼</span>
              Claro
            </button>
            <button
              type="button"
              aria-pressed={theme === 'dark'}
              onClick={() => {
                setTheme('dark')
                window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
              }}
            >
              <span aria-hidden="true">◐</span>
              Escuro
            </button>
          </div>
        </div>
      </aside>
      <div className={`client-main${module === 'editor' ? ' editor-main' : ''}`}>
        {previewData ? <p className="agency-preview-notice">Prévia visual · nenhum cliente cadastrado · alterações não são salvas</p> : null}
        {module === 'como_funciona' ? (
          <>
            <section className="project-hero">
              <div className="home-hero-art" role="img" aria-label="Mascotes da Nó transformando uma ideia em um sistema" />
              <div className="project-hero-copy">
                <p className="hero-kicker">01 · Como funciona</p>
                <h2>{text(projectPresentation(data.roadmap).hero_title, 'Da ideia a um sistema real, sem complicação.')}</h2>
                <p className="hero-description">
                  {text(projectPresentation(data.roadmap).hero_description, 'Um processo organizado, com tecnologia moderna e suporte da nossa equipe, para você tirar sua ideia do papel e colocar no ar em 30 ou 45 dias.')}
                </p>
                <div className="hero-actions">
                  <Link
                    className="hero-primary-action"
                    to={previewData ? '/__preview/cliente-agencia/etapas' : `/p/${encodeURIComponent(projectId)}/etapas`}
                  >
                    Falar com a equipe {data.agency ? `da ${data.agency.name}` : 'da Nó'} <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </div>
            </section>
            {showTrialNotice ? (
              <aside className="trial-notice home-trial-notice">
                <div><strong>Seu acesso de análise fica disponível por 15 dias.</strong></div>
                {remaining !== null ? <span>{remaining} dias restantes</span> : null}
              </aside>
            ) : null}
          </>
        ) : null}
        <div className="client-content">
          <DashboardModule
            module={module}
            data={data}
            selectedTier={selectedTier}
            savingTier={savingTier}
            saveError={saveError}
            onSelectTier={selectTier}
          />
        </div>
        {module !== 'editor' && module !== 'prototipo' ? (
          <footer className="client-footer">
            <span>
              nó<span className="amber">.</span>
            </span>
            <p>
              Sistemas, pessoas e IA.
              <br />
              Tudo no mesmo nó.
            </p>
            <Link
              to={`${previewData ? '/__preview/cliente-agencia' : `/p/${encodeURIComponent(projectId)}`}/${module === 'versoes' && shell.modules.editor === 'ativo' ? 'editor' : 'como-funciona'}`}
            >
              {module === 'versoes' && shell.modules.editor === 'ativo'
                ? 'Abrir o Editor →'
                : module === 'etapas' ? 'Voltar para como funciona →' : 'Visão geral do projeto →'}
            </Link>
          </footer>
        ) : null}
      </div>
    </main>
  )
}
