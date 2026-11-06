import { useState } from 'react'
import { calculateProgress, type KanbanItem, type ProjectVersion, type Roadmap } from './client-dashboard-service'
import './stages.css'
import { projectContact, projectPresentation, record, text } from './project-presentation'

const PHASES = [
  { key: 'idea', title: 'A ideia', icon: 'lightbulb' },
  { key: 'plan', title: 'O plano', icon: 'file-text' },
  { key: 'prototype', title: 'O protótipo', icon: 'box' },
  { key: 'system', title: 'O sistema', icon: 'code-xml' },
  { key: 'progress', title: 'Progresso', icon: 'chart-no-axes-column-increasing' },
] as const
type PhaseKey = typeof PHASES[number]['key']
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
function phaseOf(item: KanbanItem): PhaseKey {
  const phase = normalize(item.phase ?? '')
  if (/descoberta|briefing|ideia/.test(phase)) return 'idea'
  if (/plano|planejamento|escopo/.test(phase)) return 'plan'
  if (/evolucao|progresso|lancamento/.test(phase) || /go.live/i.test(item.title)) return 'progress'
  if (/prototipo|revisao/.test(phase) || item.macro_version === 'V1') return 'prototype'
  return 'system'
}
const dateLabel = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(value.length === 10 ? `${value}T00:00:00Z` : value)) : 'A definir'
const statusLabel = (item: KanbanItem) => item.status === 'concluido' ? 'Concluído' : item.status === 'em_andamento' ? 'Em andamento' : 'A fazer'
function Icon({ name }: { name: string }) { return <img src={`/icons/lucide/${name}.svg`} alt="" aria-hidden="true" /> }

export function StagesModule({ items, versions = [], roadmap }: { items: KanbanItem[]; versions?: ProjectVersion[]; roadmap: Roadmap | null }) {
  const [allUpdates, setAllUpdates] = useState(false)
  const [allNext, setAllNext] = useState(false)
  const sorted = [...items].sort((a, b) => a.position - b.position)
  const presentation = projectPresentation(roadmap)
  // Contato do roadmap (agência) ou, na falta dele, o WhatsApp da nó — ver project-presentation.ts.
  const contact = projectContact(roadmap)
  const contactCopy = {
    whatsapp: { note: 'Fale diretamente pelo WhatsApp.', label: 'Abrir WhatsApp' },
    email: { note: 'Fale diretamente por e-mail.', label: 'Enviar e-mail' },
    link: { note: 'Fale diretamente com a equipe.', label: 'Abrir contato' },
  }[contact.channel]
  const sourcePhases = presentation.phase_mode === 'source'
  const phases: Array<{ key: string; title: string; icon: string }> = sourcePhases
    ? [...new Set(sorted.map((item) => item.phase ?? 'Etapas'))].map((phase) => ({ key: phase, title: phase, icon: 'layers' }))
    : [...PHASES]
  const phaseKey = (item: KanbanItem) => sourcePhases ? item.phase ?? 'Etapas' : phaseOf(item)
  const details = record(record(roadmap?.next_steps).task_details)
  const detail = (item: KanbanItem) => record(details[item.id])
  const progress = calculateProgress(items)
  const done = items.filter((item) => item.status === 'concluido').length
  const dates = items.flatMap((item) => item.scheduled_date ? [item.scheduled_date] : []).sort()
  const currentVersion = versions.find((version) => version.is_current)
  const currentMacro = currentVersion?.label ?? items.find((item) => item.status === 'em_andamento')?.macro_version ?? text(presentation.review_label, 'A definir')
  const next = sorted.filter((item) => item.status !== 'concluido').sort((a, b) => {
    if (a.status !== b.status) return a.status === 'em_andamento' ? -1 : 1
    return (a.scheduled_date ?? '9999').localeCompare(b.scheduled_date ?? '9999') || a.position - b.position
  })
  const updates = [
    ...versions.map((version) => ({ id: `version-${version.id}`, date: version.published_at, title: `${version.label} publicada`, description: version.changelog || 'Uma nova versão está disponível para acompanhamento.', planned: false })),
    ...sorted.filter((item) => item.status === 'concluido').map((item) => ({ id: item.id, date: item.scheduled_date, title: item.title, description: text(detail(item).note, `${item.phase ?? 'Etapa do projeto'}${item.macro_version ? ` · ${item.macro_version}` : ''} · Etapa concluída.`), planned: true })),
  ].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))

  return <section className="stages-redesign">
    <header className="stages-hero">
      <div><p className="eyebrow">Acompanhamento do projeto</p><h1>Do planejamento<br />ao sistema no ar.</h1><p>Acompanhe cada etapa do seu projeto em tempo real. Aqui você vê o que já foi entregue, o que está em andamento e os próximos passos.</p></div>
      <div className="stages-hero-art" role="img" aria-label="Mascotes da Nó planejando e construindo um projeto em equipe" />
    </header>
    {!items.length ? <div className="stages-empty">As etapas entram aqui assim que o plano de execução for organizado.</div> : <>
      <section className="stages-summary" aria-label="Resumo do progresso">
        <div className="stages-summary-main"><p className="eyebrow">Progresso do projeto</p><div className="stages-progress-heading"><h2>{progress}% concluído</h2><div className="stages-total-track" role="progressbar" aria-label="Progresso total do projeto" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div></div><p>{done} de {items.length} itens entregues. Acompanhe abaixo o detalhamento por etapa.</p></div>
        <div className="stages-meta"><Icon name="calendar-days" /><div><span>{presentation.started_on ? 'Início do projeto' : 'Início planejado'}</span><strong>{dateLabel(text(presentation.started_on) || dates[0])}</strong></div></div>
        <div className="stages-meta"><Icon name="flag" /><div><span>Previsão de entrega</span><strong>{presentation.delivery_from && presentation.delivery_to ? `${dateLabel(text(presentation.delivery_from))} a ${dateLabel(text(presentation.delivery_to))}` : dateLabel(dates.at(-1))}</strong><small>{text(presentation.delivery_note, 'Conforme cronograma')}</small></div></div>
        <div className="stages-meta"><Icon name="layers" /><div><span>Versão atual</span><strong>{currentMacro}</strong><small>{currentVersion?.status ?? text(presentation.review_description, 'Conforme etapas')}</small></div></div>
      </section>
      <div className="stages-phase-grid">
        {phases.map((phase, index) => {
          const phaseItems = sorted.filter((item) => phaseKey(item) === phase.key)
          const publishedPlan = !sourcePhases && phase.key === 'plan' && phaseItems.length === 0 && Boolean(roadmap?.published_at)
          const completed = phaseItems.filter((item) => item.status === 'concluido').length + Number(publishedPlan)
          const total = phaseItems.length + Number(publishedPlan)
          const active = phaseItems.some((item) => item.status === 'em_andamento') || (next[0] && phaseKey(next[0]) === phase.key)
          const state = total > 0 && completed === total ? 'complete' : active ? 'active' : completed > 0 ? 'partial' : 'pending'
          return <section key={phase.key} className={`stage-phase stage-phase-${state}`} aria-label={`Etapa ${index + 1}: ${phase.title}`}>
            <header><span className="stage-phase-icon"><Icon name={phase.icon} /></span><div><span className="stage-phase-number">{String(index + 1).padStart(2, '0')}</span><h3>{phase.title}</h3></div></header>
            <p className="stage-phase-count"><b>{completed}/{total}</b> {state === 'complete' ? 'concluído' : phaseItems.some((item) => item.status === 'em_andamento') ? 'em andamento' : state === 'active' ? 'próxima etapa' : state === 'partial' ? 'concluído' : total ? 'não iniciado' : 'sem itens cadastrados'}</p>
            <div className="stage-phase-track"><span style={{ width: `${total ? completed / total * 100 : 0}%` }} /></div>
            <ul>{publishedPlan ? <li><span className="stage-item-state is-complete"><Icon name="check" /></span><span>Roadmap do projeto publicado<small>Marco do plano · {dateLabel(roadmap?.published_at)}</small></span></li> : null}
              {phaseItems.map((item) => <li key={item.id}><span aria-label={statusLabel(item)} className={`stage-item-state ${item.status === 'concluido' ? 'is-complete' : item.status === 'em_andamento' ? 'is-active' : ''}`}>{item.status === 'concluido' ? <Icon name="check" /> : null}</span><span>{item.title}<small>{item.macro_version ?? ''}{item.scheduled_date ? ` · ${dateLabel(item.scheduled_date)}` : ''}</small>{text(detail(item).note) ? <details><summary>Detalhes da etapa</summary><p>{text(detail(item).note)}</p></details> : null}</span></li>)}
              {!total ? <li className="stage-phase-empty">Os itens desta fase aparecerão aqui conforme o planejamento.</li> : null}
            </ul>
          </section>
        })}
      </div>
      <div className="stages-lower-grid">
        <section className="stages-updates"><header><h3>Últimas atualizações</h3>{updates.length > 4 ? <button onClick={() => setAllUpdates(!allUpdates)}>{allUpdates ? 'Ver menos' : 'Ver todas'} <Icon name="arrow-right" /></button> : null}</header>
          <ol>{(allUpdates ? updates : updates.slice(0, 4)).map((update) => <li key={update.id}><span className="update-dot" /><div className="update-date">{dateLabel(update.date)}{update.planned ? <small>Data planejada</small> : null}</div><div><strong>{update.title}</strong><p>{update.description}</p></div></li>)}</ol>
          {!updates.length ? <p className="stage-phase-empty">As entregas e versões publicadas aparecerão aqui.</p> : null}
        </section>
        <section className="stages-next"><header><h3>Próximos passos</h3>{next.length > 3 ? <button onClick={() => setAllNext(!allNext)}>{allNext ? 'Ver menos' : 'Ver todas'} <Icon name="arrow-right" /></button> : null}</header>
          <ol>{(allNext ? next : next.slice(0, 3)).map((item) => <li key={item.id}><span className="next-icon"><Icon name={phases.find((phase) => phase.key === phaseKey(item))?.icon ?? 'layers'} /></span><div><strong>{item.title}</strong><p>Previsão: {dateLabel(item.scheduled_date)}</p></div></li>)}</ol>
          {!next.length ? <p className="stage-phase-empty">Todas as etapas cadastradas foram concluídas.</p> : null}
          <a className="stages-contact" href={contact.href} target="_blank" rel="noreferrer"><Icon name="messages-square" /><span><strong>Dúvidas sobre o andamento?</strong><small>{contactCopy.note}</small></span><b>{contact.label ?? contactCopy.label} <Icon name="arrow-up-right" /></b></a>
        </section>
      </div>
      <p className="stages-readonly">Acompanhamento somente leitura · O progresso total considera os {items.length} itens do cronograma; {sourcePhases ? 'as fases e os estados seguem o roadmap original.' : 'a publicação do roadmap é um marco adicional do plano.'}</p>
    </>}
  </section>
}
