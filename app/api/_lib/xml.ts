// Serialização de XML do leiaute nacional: sem declaração, sem indentação e sem espaço entre
// tags (E0714 aparece quando espaço ou quebra de linha muda depois da assinatura; Landing do
// checklist, lote 2b - perfil da assinatura). CR vira LF nos textos (`&#13;` em `xDescServ`
// também dá E0714, §4 da referência).

// Caracteres proibidos no XML 1.0 (controle, exceto TAB e LF).
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(INVALID_XML_CHARS, '')
}

export function escapeXml(text: string): string {
  return normalizeText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

type Child = string | null | undefined | false

/** Elemento com filhos já serializados; filhos vazios somem. */
export function el(name: string, children: Child | Child[], attrs: Record<string, string> = {}): string {
  const inner = (Array.isArray(children) ? children : [children]).filter((c): c is string => typeof c === 'string').join('')
  const attrText = Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join('')
  return `<${name}${attrText}>${inner}</${name}>`
}

/** Elemento de texto; `null`/`undefined` omite o elemento (campo opcional). */
export function leaf(name: string, value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return `<${name}>${escapeXml(String(value))}</${name}>`
}
