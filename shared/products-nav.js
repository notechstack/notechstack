/* Navegação da home e das páginas de serviço/conteúdo.
   A marcação pode vir PRONTA no HTML (é o que o Google lê e segue — links
   montados só por JS são descoberta de segunda classe): nesse caso esta
   função só liga os menus. Sem marcação, ela escreve o menu. */
const SERVICOS = [
  ['/diagnostico-de-sistema/', 'Diagnóstico de sistema', '#EDA33B'],
  ['/sistemas-sob-medida/', 'Sistemas sob medida', '#3D63DB'],
  ['/desenvolvimento-de-aplicativos/', 'Aplicativos', '#E0543C'],
  ['/paineis-empresariais/', 'Painéis empresariais', '#30A46C'],
  ['/integracoes-e-automacoes/', 'Integrações e automações', '#EDA33B'],
  ['/cases/', 'Cases', '#3D63DB'],
  ['/conteudos/', 'Conteúdos', '#E0543C']
];
const PRODUTOS = [
  ['/agentes/', 'Agentes', '#EDA33B'],
  ['/roteador/', 'Roteador', '#3D63DB'],
  ['/health/', 'Nó Health', '#30A46C']
];

function itens(lista, active) {
  return lista.map(([href, rotulo, cor]) =>
    `<a href="${href}" style="--product-color:${cor}"${active === href ? ' aria-current="page"' : ''}>${rotulo}</a>`).join('');
}

export function productsNavHTML({ active = '/', contact = '/#diagnostico' } = {}) {
  return `<nav class="no-products-nav" aria-label="Navegação principal">
    <a class="no-products-brand" href="/" aria-label="Nó Tech Stack — página inicial"><img src="/brand/favicon/favicon-dark.svg" alt="nó." width="64" height="64"></a>
    <div class="no-products-pills">
      <div class="no-products-dropdown">
        <button type="button" aria-expanded="false" aria-controls="no-servicos-menu">Serviços <span aria-hidden="true">⌄</span></button>
        <div id="no-servicos-menu" class="no-products-menu" hidden>${itens(SERVICOS, active)}</div>
      </div>
      <div class="no-products-dropdown">
        <button type="button" aria-expanded="false" aria-controls="no-products-menu">Produtos <span aria-hidden="true">⌄</span></button>
        <div id="no-products-menu" class="no-products-menu" hidden>${itens(PRODUTOS, active)}</div>
      </div>
      <a href="${contact}">Contato</a>
    </div>
  </nav>`;
}

export function initProductsNav(root, opcoes = {}) {
  if (!root) return;
  if (!root.querySelector('.no-products-nav')) root.innerHTML = productsNavHTML(opcoes);
  const menus = Array.from(root.querySelectorAll('.no-products-dropdown')).map(dropdown => {
    const button = dropdown.querySelector('button');
    const menu = dropdown.querySelector('.no-products-menu');
    const setOpen = open => { button.setAttribute('aria-expanded', String(open)); menu.hidden = !open; };
    button.addEventListener('click', () => {
      const abrir = menu.hidden;
      menus.forEach(m => m.setOpen(false));
      setOpen(abrir);
    });
    dropdown.addEventListener('focusout', e => { if (!dropdown.contains(e.relatedTarget)) setOpen(false); });
    menu.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });
    return { dropdown, button, menu, setOpen };
  });
  root.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const aberto = menus.find(m => !m.menu.hidden);
    if (aberto) { aberto.setOpen(false); aberto.button.focus(); }
  });
  document.addEventListener('click', e => {
    menus.forEach(m => { if (!m.dropdown.contains(e.target)) m.setOpen(false); });
  });
}
