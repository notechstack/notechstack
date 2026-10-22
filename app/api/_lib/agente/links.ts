// Links que o agente manda no WhatsApp (Landing, lote B - conversa; v2, lote C - conta). As
// páginas próprias do certificado e da assinatura da v1 não existem: na v2 tudo isso fica em
// "Minha conta" (`/agentes/fiscal/conta/`, decisão de Lucca de 21/10/2026), com âncora por seção.
export type Links = { site: string; certificado: string; assinatura: string; conta: string }

const SITE_PADRAO = 'https://notechstack.com.br/agentes/fiscal/'

export function linksDoSite(site: string = SITE_PADRAO): Links {
  const base = site.endsWith('/') ? site : `${site}/`
  return { site: base, certificado: `${base}conta/#certificado`, assinatura: `${base}conta/#assinatura`, conta: `${base}conta/` }
}

export function linksFromEnv(): Links {
  return linksDoSite(process.env.AGENTE_FISCAL_SITE_URL || SITE_PADRAO)
}
