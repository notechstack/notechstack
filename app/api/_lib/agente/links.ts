// Links que o agente manda no WhatsApp (Landing, lote B - conversa). As páginas do certificado
// e da assinatura ainda não foram desenhadas (Unresolved 2): os caminhos são os padrões abaixo.
export type Links = { site: string; certificado: string; assinatura: string }

const SITE_PADRAO = 'https://notechstack.com.br/agentes/fiscal/'

export function linksDoSite(site: string = SITE_PADRAO): Links {
  const base = site.endsWith('/') ? site : `${site}/`
  return { site: base, certificado: `${base}certificado/`, assinatura: `${base}assinatura/` }
}

export function linksFromEnv(): Links {
  return linksDoSite(process.env.AGENTE_FISCAL_SITE_URL || SITE_PADRAO)
}
