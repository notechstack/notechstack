import { useParams, useSearchParams } from 'react-router-dom'
import { ClientDashboardPage } from './ClientDashboardPage'
import type { DashboardData, JsonValue, KanbanItem, KanbanStatus, ModuleKey } from './client-dashboard-service'
import conexaoEquestre from '../../onboarding/conexao-equestre/conexao-equestre.json'

// Developer-only presentation of the real dashboard. No database records or memberships.
const preview: DashboardData = {
  agency: { name: 'Maisis Publicidade', logoUrl: '/agencies/maisis/logo.png' },
  shell: {
    project_id: 'visual-preview', project_name: 'Prévia do painel do cliente',
    effective_access_status: 'ATIVO_ATE_FIM_DO_PROJETO', access_released_at: null,
    modules: { como_funciona: 'ativo', etapas: 'ativo', prototipo: 'bloqueado', editor: 'bloqueado', versoes: 'bloqueado', marca: 'bloqueado' },
  },
  roadmap: null, kanban: [], versions: [],
}

// Onboarding snapshots rendered in memory before the production transaction runs.
type Snapshot = typeof conexaoEquestre
function fromSnapshot(snapshot: Snapshot): DashboardData {
  const kanban: KanbanItem[] = snapshot.tasks.map((task) => ({
    id: `preview-${task.source_id}`, title: task.title, phase: task.phase, macro_version: null,
    status: task.status as KanbanStatus, scheduled_date: null, position: task.position,
  }))
  const taskDetails = Object.fromEntries(snapshot.tasks.map((task) => [`preview-${task.source_id}`, { source_id: task.source_id, note: task.note, week: task.week }]))
  const nextSteps = { ...snapshot.roadmap.next_steps, task_details: taskDetails } as unknown as JsonValue
  return {
    agency: { name: 'Maisis Publicidade', logoUrl: '/agencies/maisis/logo.png' },
    shell: {
      project_id: `preview-${snapshot.client.slug}`, project_name: snapshot.project.name,
      effective_access_status: 'ATIVO_ATE_FIM_DO_PROJETO', access_released_at: null,
      modules: snapshot.project.modules as Partial<Record<ModuleKey, 'ativo' | 'bloqueado'>>,
    },
    roadmap: {
      stack: snapshot.roadmap.stack as unknown as JsonValue, costs: snapshot.roadmap.costs as unknown as JsonValue,
      next_steps: nextSteps, references: snapshot.roadmap.references as unknown as JsonValue,
      tiers: {}, preferred_tier: null, prototype_url: snapshot.roadmap.prototype_url, published_at: '2026-10-20T12:00:00Z', // prévia: o SQL grava now() na publicação real
    },
    kanban, versions: [],
  }
}
const snapshots: Record<string, DashboardData> = { 'conexao-equestre': fromSnapshot(conexaoEquestre) }

const modules: Record<string, ModuleKey> = {
  'como-funciona': 'como_funciona', etapas: 'etapas', prototipo: 'prototipo',
  editor: 'editor', versoes: 'versoes', marca: 'marca',
}
export default function ClientBrandingPreview() {
  const { module = 'etapas' } = useParams()
  const [params] = useSearchParams()
  // Keep the chosen snapshot while navigating between modules (sidebar links carry no query).
  const requested = params.get('projeto')
  if (requested) sessionStorage.setItem('preview-projeto', requested)
  const data = snapshots[requested ?? sessionStorage.getItem('preview-projeto') ?? ''] ?? preview
  return <ClientDashboardPage module={modules[module] ?? 'etapas'} previewData={data} />
}
