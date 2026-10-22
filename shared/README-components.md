# Componentes do site

Home (`lp-narrador/cenas-lp/lp-v8.html`), Agência e Contato usam `card-nav.css` e `card-nav.js`. Os links do menu expandido são definidos apenas no JavaScript compartilhado; os três links principais continuam disponíveis no HTML sem JavaScript.

Home e Agência montam o mesmo mapa em `[data-client-network]`. Edite **`clients-network.js`** para alterar os logos, o texto e a animação; edite **`clients-network.css`** para alterar o desenho. Ambas as páginas carregam esses mesmos arquivos. As âncoras externas permanecem `/#clientes` e `/agencia/#empresas`.

O formulário da home e de Contato usa `home-contato.js`. A função pública `send-lead-email` v13 foi publicada em 28/09/2026 com suporte a anexos. O endpoint de capacidades confirmou o recurso; arquivo inválido foi rejeitado antes da criação de lead. O envio real de e-mail com anexos não foi exercitado nesta revisão.

As páginas públicas carregam `texticon-cursor.css`, `glossario.js` e `texticon-cursor.js` (22/10/2026, no lugar do `smooth-cursor`, que fica só para a lp-v7 antiga): o ponto âmbar segue o mouse e, sobre links e botões, abre uma pílula com ícone e texto (WhatsApp, nova aba ou o `data-cursor` do elemento; `data-cursor=""` desliga). Termos-chave do texto são links `<a class="no-termo" data-termo="chave" href="destino">`, numerados como nota de rodapé; o cursor mostra o cartão "nó explica" com o texto de `glossario.js`, e em toque, teclado ou movimento reduzido o mesmo cartão abre junto do termo. Campos editáveis, controles de vídeo e diálogos mantêm o cursor nativo. Novas páginas devem carregar os três arquivos.

A seção Organização da Agência usa largura total e enquadra as margens do vídeo; o diálogo oferece reprodução, zoom e rolagem para ler o painel em telas pequenas. As regras de layout estão em `agencia.css` e na versão servida `agencia.min.css`.
`prototype-devices.css` adapta iPhone 14 Pro e MacBook Pro da biblioteca pública Devices.css (MIT), com fontes/licença em `shared/vendor/devices/`. O protótipo usa proporções fixas, escala conforme o espaço e rolagem interna; não restaurar height:auto/overflow:visible na tela Loiê.

## Navegação pública e sitemap

As oito páginas do sitemap usam navbar e footer estáticos gerados por `shared/sync-site-layout.mjs`. Edite os grupos e links nessa fonte e execute `npm run sync:layout`; `npm run check:layout` detecta divergências. A interação do menu fica em `card-nav.js`, o visual em `card-nav.css` e `site-layout.css`. As páginas legais escondem a navegação somente no modo de iframe `?embed=1`.

Validação: `python .checks/seo/audit.py` e `node .checks/seo/test-site-layout.cjs` (usa o Playwright instalado em `app/`). Para verificar produção, defina `SITE_URL` com a origem publicada. As rotas retiradas têm redirecionamentos permanentes em `vercel.json`; `/colaboradores-digitais/` foi retirada em 22/10/2026 e redireciona para `/agentes/`.
