// Shared, static navigation: run `npm run sync:layout` after changing this file.
// Keeping the markup in HTML makes links available without JavaScript.
import { readFile, writeFile } from 'node:fs/promises';

const pages = {
  '/': 'lp-narrador/cenas-lp/lp-v8.html',
  '/agencia/': 'agencia/index.html',
  '/colaboradores-digitais/': 'colaboradores-digitais/index.html',
  '/agentes/': 'agentes/index.html',
  '/agentes/auditor/': 'agentes/auditor/index.html',
  '/agentes/fiscal/': 'agentes/fiscal/index.html',
  '/health/': 'health/index.html',
  '/sobre/': 'sobre/index.html',
  '/contato/': 'contato/index.html',
  '/termos/': 'termos/index.html',
  '/privacidade/': 'privacidade/index.html',
};
const groups = [
  ['Home', [['Conheça a Nó', '/'], ['Como funciona', '/#como-funciona'], ['Nossos clientes', '/#clientes'], ['Colaboradores digitais', '/colaboradores-digitais/'], ['Nó Agentes', '/agentes/'], ['Auditor de marketing', '/agentes/auditor/'], ['nó.health', '/health/']]],
  ['Agência', [['Soluções', '/agencia/#solucoes'], ['Como funciona', '/agencia/#como-funciona'], ['Organização', '/agencia/#organizacao'], ['Acompanhamento', '/agencia/#acompanhamento'], ['Empresas', '/agencia/#empresas']]],
  ['Contato', [['Conte sua ideia', '/contato/'], ['Parceria com agências', '/agencia/#contato']]],
];
const link = ([label, href]) => `<a href="${href}">${label}</a>`;
const footer = `<footer class="no-site-footer">
  <div class="ft-brand">
    <a class="ft-logo" href="/" aria-label="Nó — página inicial"><img src="/brand/lockup/svg/no-tech-stack-branca-ponto-ambar.svg" alt="nó tech stack" width="198" height="27"></a>
    <div class="ft-txt">IA que arquiteta, integra e opera.</div>
    <a class="ft-whatsapp" href="https://wa.me/5511939289413?text=Ol%C3%A1%2C%20vim%20pelo%20site%21" target="_blank" rel="noopener noreferrer" aria-label="Falar com a nó pelo WhatsApp no número +55 11 93928-9413">WhatsApp <span aria-hidden="true">↗</span></a>
  </div>
  <nav class="ft-nav" aria-label="Mapa do site">${[['Home','/'],['Agência','/agencia/'],['nó.health','/health/'],['Colaboradores digitais','/colaboradores-digitais/'],['Nó Agentes','/agentes/'],['Sobre a Nó','/sobre/'],['Conte sua ideia','/contato/']].map(link).join('')}</nav>
  <div class="ft-legal ft-txt"><div class="ft-legal-links"><a href="/termos/" class="ft-link">Termos de uso</a><span aria-hidden="true"> · </span><a href="/privacidade/" class="ft-link">Privacidade e cookies</a></div><div>© 2026 nó. Todos os direitos reservados.</div></div>
</footer>`;
let stale = false;
for (const [route, file] of Object.entries(pages)) {
  const nav = `<nav class="no-card-nav" aria-label="Navegação principal"><div class="no-card-top"><button class="no-card-toggle" type="button" aria-label="Abrir menu" aria-expanded="false" aria-controls="no-card-panel"><span></span><span></span></button><a class="no-card-brand" href="/" aria-label="Nó — página inicial"><img src="/brand/logo/svg/no-tinta-ponto-ambar.svg" alt="nó." width="46" height="30"></a><div class="no-card-toplinks">${[['Home','/'],['Agência','/agencia/'],['Contato','/contato/']].map(([label, href]) => `<a href="${href}"${route === href ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</div></div><div id="no-card-panel" class="no-card-panel" aria-hidden="true" inert><div class="no-card-panel-inner"><div class="no-card-grid">${groups.map(([title, links]) => `<div class="no-card"><b>${title}</b><div>${links.map(link).join('')}</div></div>`).join('')}</div></div></div></nav>`;
  const url = new URL('../' + file, import.meta.url);
  const before = await readFile(url, 'utf8');
  let after = before;
  // Declare the fixed palette before CSS loads to avoid an initial dark repaint.
  if (!/<meta\s+name="color-scheme"/.test(after)) {
    after = after.replace(/<meta\s+charset=["']utf-8["']\s*\/?\s*>/i, '$&\n<meta name="color-scheme" content="only light">');
    if (!/<meta\s+name="color-scheme"/.test(after)) throw new Error(`Missing charset marker: ${file}`);
  }
  for (const [name, html] of [['nav',nav],['footer',footer]]) {
    const pattern = new RegExp(`<!-- site-${name}:start -->[\\s\\S]*?<!-- site-${name}:end -->`);
    if (!pattern.test(after)) throw new Error(`Missing ${name} markers: ${file}`);
    after = after.replace(pattern, `<!-- site-${name}:start -->\n${html}\n<!-- site-${name}:end -->`);
  }
  if (after !== before) {
    if (process.argv.includes('--check')) { console.error(`Layout out of sync: ${file}`); stale = true; }
    else await writeFile(url, after);
  }
}
if (stale) process.exitCode = 1;
