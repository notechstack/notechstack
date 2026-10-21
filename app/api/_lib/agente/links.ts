// Links que o agente manda no WhatsApp (Landing, lote B - conversa; v2, lote C - conta). As
// páginas do certificado e da assinatura da v1 não foram desenhadas (Unresolved 2 da v1): os
// caminhos são os padrões abaixo. A conta é a página `/agentes/fiscal/conta/` da v2.
export type Links = { site: string; certificado: string; assinatura: string; conta: string }

const SITE_PADRAO = 'https://notechstack.com.br/agentes/fiscal/'

export function linksDoSite(site: string = SITE_PADRAO): Links {
  const base = site.endsWith('/') ? site : `${site}/`
  return { site: base, certificado: `${base}certificado/`, assinatura: `${base}assinatura/`, conta: `${base}conta/` }
}

export function linksFromEnv(): Links {
  return linksDoSite(process.env.AGENTE_FISCAL_SITE_URL || SITE_PADRAO)
}
