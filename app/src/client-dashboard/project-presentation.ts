import type { JsonValue, Roadmap } from './client-dashboard-service'

export function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
export function text(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}
/** Destinos aceitos nos botões gravados no roadmap (`cta_href`, `contact_href`): só `https://` ou `mailto:`. */
export function isExternalHref(value: string): boolean {
  return /^(https:\/\/|mailto:)/.test(value)
}

export type ArchitectureNode = { id: string; brand: string; title: string; tool: string; detail: string; href: string }
export type Architecture = { title: string; description: string; caption: string; inputs: ArchitectureNode[]; services: ArchitectureNode[]; core: ArchitectureNode }
function isNode(value: JsonValue): value is ArchitectureNode {
  const node = record(value)
  return ['id', 'brand', 'title', 'tool', 'detail', 'href'].every((key) => typeof node[key] === 'string')
    && /^[a-z0-9-]+$/.test(String(node.id)) && /^[a-z0-9-]*$/.test(String(node.brand)) && /^https:\/\//.test(String(node.href))
}
export function projectArchitecture(roadmap: Roadmap | null): Architecture | null {
  const value = record(record(roadmap?.stack).architecture)
  if (!Array.isArray(value.inputs) || !Array.isArray(value.services) || !value.core
    || !value.inputs.every(isNode) || !value.services.every(isNode) || !isNode(value.core)) return null
  return { title: text(value.title), description: text(value.description), caption: text(value.caption), inputs: value.inputs, services: value.services, core: value.core }
}
/**
 * `roadmap.next_steps.presentation`: JSON livre gravado pelos scripts de onboarding (`app/onboarding/*`).
 * Todo campo é opcional; o painel usa o texto padrão quando falta. Campos lidos hoje:
 * - `phase_mode` ("source" mantém as fases do roadmap original), `hide_project_navigation`;
 * - `hero_title`, `hero_description`, `prototype_title`, `review_label`, `review_description`,
 *   `editor_lock_reason`, `infrastructure_title`, `scope_options[]`, `scope_note`;
 * - `started_on`, `delivery_from`, `delivery_to`, `delivery_note`;
 * - `contact_href`: destino do botão "Falar com a equipe" (hero de Como funciona) e do card
 *   "Dúvidas sobre o andamento?" das Etapas. Só `https://` ou `mailto:` (mesmo filtro dos `cta_href`
 *   dos `scope_options`); ausente ou inválido, cai no WhatsApp da nó. Cliente de agência deve
 *   apontar para a agência (ex.: `https://wa.me/55DDDNÚMERO?text=...`), senão a conversa cai na nó.
 * - `contact_label`: texto do botão nos dois lugares (opcional; padrão "Falar com a equipe da …"
 *   no hero e "Abrir WhatsApp" / "Enviar e-mail" no card).
 */
export function projectPresentation(roadmap: Roadmap | null) {
  return record(record(roadmap?.next_steps).presentation)
}

/** WhatsApp da nó: usado quando o roadmap não traz `contact_href` (clientes diretos). */
export const NO_CONTACT_HREF = 'https://wa.me/5511939289413'
export type ProjectContact = { href: string; label: string | null; channel: 'whatsapp' | 'email' | 'link' }
export function projectContact(roadmap: Roadmap | null): ProjectContact {
  const presentation = projectPresentation(roadmap)
  const candidate = text(presentation.contact_href).trim()
  const href = isExternalHref(candidate) ? candidate : NO_CONTACT_HREF
  const channel = href.startsWith('mailto:') ? 'email'
    : /^https:\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)\//.test(href) ? 'whatsapp' : 'link'
  return { href, label: text(presentation.contact_label).trim() || null, channel }
}
