import { useEffect, useId, useRef, useState } from 'react'
import type { Architecture, ArchitectureNode } from './project-presentation'
import { DEFAULT_SCENARIO, estimateInfrastructure, money, quantity, type CostScenario } from './infrastructure-costs'

const defaultInputs = [
  { id: 'react', brand: 'react', title: 'Interface do site e hub', tool: 'React', detail: 'Páginas e componentes', href: 'https://react.dev' },
  { id: 'vite', brand: 'vite', title: 'Build e publicação', tool: 'Vite', detail: 'Compilação do projeto', href: 'https://vite.dev' },
  { id: 'whatsapp', brand: 'whatsapp', title: 'Contato com a clínica', tool: 'WhatsApp', detail: 'Link direto de atendimento', href: 'https://www.whatsapp.com' },
]
const defaultServices = [
  { id: 'database', brand: 'supabase', title: 'Banco de dados', tool: 'Supabase', detail: 'Dados do hub · PostgreSQL', href: 'https://supabase.com/database' },
  { id: 'auth', brand: 'supabase', title: 'Autenticação', tool: 'Supabase Auth', detail: 'Login e controle de acesso', href: 'https://supabase.com/auth' },
  { id: 'storage', brand: 'supabase', title: 'Armazenamento', tool: 'Supabase Storage', detail: 'Arquivos e documentos', href: 'https://supabase.com/storage' },
]

const defaultCore = { id: 'core', brand: 'vercel', title: 'Seu sistema na nuvem', tool: 'Vercel', detail: 'Hospedagem · HTTPS · CDN', href: 'https://vercel.com' }

export function ProjectArchitecture({ architecture }: { architecture?: Architecture | null }) {
  const inputs = architecture?.inputs ?? defaultInputs
  const services = architecture?.services ?? defaultServices
  const core = architecture?.core ?? defaultCore
  const container = useRef<HTMLDivElement>(null)
  const [paths, setPaths] = useState<string[]>([])
  const marker = useId().replace(/:/g, '')
  useEffect(() => {
    const root = container.current
    if (!root) return
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = root.getBoundingClientRect()
        const core = root.querySelector('[data-flow-node="core"]')!.getBoundingClientRect()
        const curve = (x1: number, y1: number, x2: number, y2: number) => {
          const middle = (x1 + x2) / 2
          return `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`
        }
        setPaths([
          ...inputs.map((node, index) => {
            const rect = root.querySelector(`[data-flow-node="${node.id}"]`)!.getBoundingClientRect()
            return curve(rect.right - box.left, rect.top + rect.height / 2 - box.top, core.left - box.left - 2, core.top + core.height * (index + 1) / (inputs.length + 1) - box.top)
          }),
          ...services.map((node, index) => {
            const rect = root.querySelector(`[data-flow-node="${node.id}"]`)!.getBoundingClientRect()
            return curve(core.right - box.left, core.top + core.height * (index + 1) / (services.length + 1) - box.top, rect.left - box.left - 2, rect.top + rect.height / 2 - box.top)
          }),
        ])
      })
    }
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(root)
    root.querySelectorAll('[data-flow-node]').forEach((node) => observer?.observe(node))
    window.addEventListener('resize', measure)
    measure()
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(frame) }
  }, [inputs, services])

  const card = (node: ArchitectureNode) => (
    <a className="infra-node" data-flow-node={node.id} key={node.id} href={node.href} target="_blank" rel="noreferrer">
      <span className={`tool-logo brand-${node.brand}`}>{node.brand ? <img src={`/icons/brands/${node.brand}.svg`} alt="" /> : <b aria-hidden="true">{node.tool.slice(0, 2)}</b>}</span>
      <div><strong>{node.title}</strong><span className="infra-tool">{node.tool} <span aria-hidden="true">↗</span></span><small>{node.detail}</small></div>
    </a>
  )
  return <section className="overview-architecture">
    <header className="overview-section-heading"><p className="eyebrow">Stack e arquitetura</p><h2>{architecture?.title ?? 'Tecnologia moderna e integrada.'}</h2><p>{architecture?.description ?? 'A estrutura do Espaço Saúde Mental: site, hub interno e contato com a clínica. Clique nas ferramentas para conhecê-las.'}</p></header>
    <div className="infra-scroll" role="region" aria-label="Fluxograma da stack; role horizontalmente em telas pequenas" tabIndex={0}>
      <div className="infra-flow" ref={container}>
        <svg className="infra-connectors" aria-hidden="true"><defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1 L7 4 L1 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></marker></defs>{paths.map((path, index) => <path key={index} d={path} fill="none" stroke="currentColor" strokeWidth="1.7" markerEnd={`url(#${marker})`} />)}</svg>
        <div className="infra-column">{inputs.map(card)}</div>
        <a className="infra-hub" data-flow-node="core" href={core.href} target="_blank" rel="noreferrer">{core.brand ? <img className={`hub-logo brand-${core.brand}`} src={`/icons/brands/${core.brand}.svg`} alt="" /> : null}<strong>{core.title}</strong><span>{core.tool} ↗</span><small>{core.detail}</small></a>
        <div className="infra-column">{services.map(card)}</div>
      </div>
    </div>
    <p className="infra-caption">{architecture?.caption ?? 'Site em React + Vite · Hub com Supabase · Publicação na Vercel. O preview da V1 exibe apenas a página pública.'}</p>
  </section>
}

function ScenarioToggle({ checked, onChange, title, description, badge, highlighted = false }: { checked: boolean; onChange: () => void; title: string; description: string; badge: string; highlighted?: boolean }) {
  return <label className={`scenario-toggle${highlighted ? ' scenario-support' : ''}`}>
    <input type="checkbox" checked={checked} onChange={onChange} /><i aria-hidden="true" /><span><strong>{title}</strong><small>{description}</small></span><b>{badge}</b>
  </label>
}

export function ProjectCostCalculator() {
  const [users, setUsers] = useState(1000)
  const [scenario, setScenario] = useState<CostScenario>(DEFAULT_SCENARIO)
  const [hover, setHover] = useState<number | null>(null)
  const gradient = useId().replace(/:/g, '')
  const result = estimateInfrastructure(users, scenario)
  const domain = Math.max(2000, users * 1.5)
  const maxCost = Math.ceil(Math.max(100, estimateInfrastructure(domain, scenario).total) * 1.25 / 100) * 100
  // Dense samples plus exact tariff boundaries. No fixed user buckets or snapped cursor.
  const thresholds = [1_000_000 / (scenario.visits * 10), 1000 / (scenario.visits * 0.005), 60_000, 95_000, 100_000]
  if (scenario.email) for (let value = 25_000; value < domain; value += 500) thresholds.push(value)
  const samples = [...new Set([...Array.from({ length: 161 }, (_, index) => domain * index / 160), ...thresholds.flatMap((value) => [value, value + 0.01]).filter((value) => value <= domain)])].sort((a, b) => a - b)
  const x = (value: number) => 64 + value / domain * 676
  const y = (cost: number) => 264 - cost / maxCost * 228
  const path = samples.map((value, index) => `${index ? 'L' : 'M'} ${x(value).toFixed(2)} ${y(estimateInfrastructure(value, scenario).total).toFixed(2)}`).join(' ')
  const probe = hover ?? users
  const probeCost = estimateInfrastructure(probe, scenario).total
  const toggle = (key: 'storage' | 'email' | 'support') => setScenario((current) => ({ ...current, [key]: !current[key] }))

  return <section className="overview-costs infra-cost-section">
    <header className="overview-section-heading"><p className="eyebrow">Estimativa de custos</p><h2>Quanto custa manter sua plataforma?</h2><p>Simule o site + hub com a stack da clínica. Cada ferramenta, franquia e adicional aparece na conta.</p></header>
    <div className="cost-workbench">
      <div className="cost-controls">
        <div className="cost-control-title"><label htmlFor="monthly-users">Usuários ativos por mês</label><input id="monthly-users" type="number" min="0" max="100000" step="1" value={users} onChange={(event) => setUsers(Math.max(0, Math.min(100000, Math.round(Number(event.target.value) || 0))))} /></div>
        <input className="cost-range" type="range" aria-label="Número de usuários" min="0" max="100000" step="1" value={users} onChange={(event) => { setUsers(Number(event.target.value)); setHover(null) }} />
        <div className="range-endpoints"><span>0</span><span>100.000 usuários</span></div>
        <p className="cost-help">Arraste livremente ou digite a quantidade exata. A curva inteira e a escala acompanham sua simulação.</p>
        <div className="cost-control-title"><label htmlFor="monthly-visits">Visitas por usuário / mês</label><output>{scenario.visits}</output></div>
        <input id="monthly-visits" className="cost-range" type="range" min="1" max="20" step="1" value={scenario.visits} onChange={(event) => setScenario({ ...scenario, visits: Number(event.target.value) })} />
        <fieldset className="scenario-options"><legend>Ajuste seu cenário</legend>
          <ScenarioToggle checked={scenario.storage} onChange={() => toggle('storage')} title="Mais espaço para arquivos" description="Adiciona 100 GB à estimativa de uso no Supabase." badge="Por consumo" />
          <ScenarioToggle checked={scenario.email} onChange={() => toggle('email')} title="Simular e-mails automáticos" description="Expansão com Resend Pro: 2 envios por usuário/mês." badge={`+ ${money(20 * scenario.exchange)}*`} />
          <ScenarioToggle checked={scenario.support} onChange={() => toggle('support')} title="Suporte contínuo da Nó" description="Acompanhamento e manutenção do sistema." badge="+ R$ 500/mês" highlighted />
        </fieldset>
        <label className="exchange-control">Câmbio da simulação <span>US$ 1 = R$ <input aria-label="Câmbio da simulação" type="number" min="1" max="20" step="0.01" value={scenario.exchange} onChange={(event) => setScenario({ ...scenario, exchange: Math.max(1, Math.min(20, Number(event.target.value) || 1)) })} /></span></label>
        <p className="cost-help">Câmbio ilustrativo e editável, sem impostos. *E-mails podem gerar excedentes.</p>
      </div>
      <div className="cost-visual">
        <div className="cost-total"><span>Estimativa mensal</span><output aria-label="Custo mensal estimado">{money(result.total)}</output><p>{quantity(users)} usuários · {scenario.visits} visitas por usuário</p></div>
        <div className="cost-total-parts"><span>Ferramentas <b>{money(result.infrastructure)}</b></span><span>Suporte Nó <b>{scenario.support ? money(500) : 'Opcional'}</b></span></div>
        <div className="cost-graph-title"><strong>Como o custo acompanha o uso</strong><span>R$ / mês</span></div>
        <svg className="cost-live-chart" viewBox="0 0 780 316" role="img" aria-label={`Projeção de custo para até ${quantity(domain)} usuários. Cenário atual: ${money(result.total)} por mês.`} onPointerLeave={() => setHover(null)} onPointerMove={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const px = (event.clientX - rect.left) / rect.width * 780; setHover(Math.round(Math.max(0, Math.min(1, (px - 64) / 676)) * domain)) }}>
          <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#30a46c" stopOpacity=".23" /><stop offset="100%" stopColor="#30a46c" stopOpacity=".015" /></linearGradient></defs>
          {[0, 1, 2, 3, 4].map((tick) => <g key={tick}><line x1="64" x2="740" y1={y(maxCost * tick / 4)} y2={y(maxCost * tick / 4)} className="cost-gridline" /><text x="54" y={y(maxCost * tick / 4) + 4} textAnchor="end">{quantity(maxCost * tick / 4)}</text><text x={x(domain * tick / 4)} y="291" textAnchor="middle">{quantity(Math.round(domain * tick / 4))}</text></g>)}
          <path d={`${path} L740 264 L64 264 Z`} fill={`url(#${gradient})`} />
          <path className="cost-curve" d={path} fill="none" stroke="#23986a" strokeWidth="3" strokeLinejoin="round" />
          <line x1={x(probe)} x2={x(probe)} y1={y(probeCost)} y2="264" stroke="#23986a" strokeDasharray="4 5" opacity=".5" />
          <circle cx={x(probe)} cy={y(probeCost)} r="5" fill="#23986a" stroke="var(--surface)" strokeWidth="3" />
          <text x="740" y="313" textAnchor="end">usuários ativos / mês</text>
        </svg>
        <div className="cost-probe">{quantity(probe)} usuários <strong>{money(probeCost)}/mês</strong></div>
        <p className="cost-help">Trechos planos indicam uso incluído nas franquias. Mudanças de plano geram degraus reais; o controle de usuários não tem saltos predefinidos.</p>
      </div>
      <div className="cost-breakdown"><header><h3>Para onde vai cada real</h3><span>Valores mensais · cenário simulado</span></header>
        <div className="cost-lines">{result.rows.map((row) => <div className="cost-line" key={row.key}><a href={row.href} target="_blank" rel="noreferrer" className={`tool-logo brand-${row.brand}`} aria-label={`Tarifas de ${row.title}`}><img src={`/icons/brands/${row.brand}.svg`} alt="" /></a><div><a href={row.href} target="_blank" rel="noreferrer"><strong>{row.title} ↗</strong></a><p>{row.detail}</p></div><b>{row.brl === 0 && row.key !== 'email' ? 'Incluído' : money(row.brl)}</b></div>)}</div>
        <div className="cost-support-line"><strong>Suporte contínuo da Nó</strong><span>{scenario.support ? money(result.support) : 'Não adicionado'}</span></div>
      </div>
    </div>
    <details className="cost-assumptions"><summary>Premissas, tarifas e o que não entra nesta conta</summary><div><p>Referências consultadas em 21/09/2026. Modelo de conta dedicada: Vercel Pro com um assento e Flat Rate CDN habilitado; Supabase Pro com um projeto Micro e crédito de compute. Planos contratados e consumo real da clínica não foram consultados.</p><p>Por visita: 10 requisições e 5 MB na Vercel. Por usuário: 0,1 MB de banco, 1 MB de arquivos e 5 MB de tráfego do Supabase; base de 2 GB de banco e 5 GB de arquivos. São premissas de planejamento, não medições. Armazenamento representa o total guardado, não crescimento histórico.</p><p>React, Vite e link de WhatsApp não têm licença mensal neste modelo. Não inclui domínio, impostos, taxas de pagamentos, WhatsApp API, IA, aumento de compute ou serviços clínicos específicos. Resend é uma expansão opcional, não uma integração confirmada. Supabase Auth e Storage compartilham o plano Pro: a mensalidade é cobrada uma única vez.</p><p>Fontes: <a href="https://supabase.com/pricing" target="_blank" rel="noreferrer">Supabase</a> · <a href="https://vercel.com/docs/plans/pro-plan" target="_blank" rel="noreferrer">Vercel Pro</a> · <a href="https://vercel.com/docs/pricing/flat-rate-cdn" target="_blank" rel="noreferrer">CDN</a> · <a href="https://resend.com/pricing" target="_blank" rel="noreferrer">Resend</a>.</p></div></details>
  </section>
}
