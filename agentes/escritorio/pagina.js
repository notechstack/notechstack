// /agentes/ — "Escritório nó": página (frente A).
// Decide entre a versão animada e a estática, abre com o pôster (prévia), monta a cena
// (cena.js, frente B) no primeiro gesto e a gaveta (gaveta.js, frente C) e liga rolagem,
// toques e câmera.
// Contrato: .tasks/agentes-escritorio-frentes.md + "Landing" de .checks/agentes-escritorio.md.

// Caminhos dos módulos e pôsteres. A bancada de provas (.checks/agentes/test-pagina.cjs)
// troca por stubs via window.__agentesModulos antes de este arquivo rodar.
const PADRAO = {
  three: 'three',
  cena: '/agentes/escritorio/cena.js',
  gaveta: '/agentes/escritorio/gaveta.js',
  gavetaCss: '/agentes/escritorio/gaveta.css',
  glb: '/agentes/escritorio/escritorio.glb',
  posterEscritorio: '/agentes/escritorio/poster-escritorio.webp',
  posterFecho: '/agentes/escritorio/poster-fecho.webp',
};
const cfg = Object.assign({}, PADRAO, window.__agentesModulos || {});

const FOLGA_NAV = 8;           // px entre a navbar e o topo do canvas ao abrir a gaveta
// Trilho da rolagem (animada): a cena fica presa sob a navbar enquanto o trilho passa.
// Frações do trecho preso: até PINO_TELA1 a Tela 1 fica parada (dá para tocar nas mesas);
// o recuo até a sala termina em PINO_FECHO e o resto segura a sala antes de soltar a cena.
const PINO_TELA1 = 0.3;
const PINO_FECHO = 0.85;
// Prévia: a página abre com o pôster, que é o mesmo quadro em que a cena nasce (relógio da
// animação em 0, etiquetas em HTML no lugar dos chips). Depois do load, módulos e GLB baixam em
// segundo plano, sem rodar. No primeiro gesto (toque, rolagem, roda, tecla ou mouse) a cena monta
// parada nesse quadro, entra por cima do pôster num fade e só então começa a se mexer, devagar.
const FADE_MS = 600;      // pôster → cena (a transição de opacidade de .ag-canvas em agentes.css)
const ACORDAR_MS = 1800;  // da cena parada à velocidade normal
// Centro das etiquetas no pôster (fração da imagem 750×1040), os mesmos de agentes.css.
const ETIQUETAS_POSTER = { fiscal: [0.608, 0.083], auditor: [0.748, 0.296], vaga: [0.633, 0.568] };
const PROPORCAO_POSTER = 750 / 1040;
const ALTURA_PROJETO = 520; // altura do quadro em que as etiquetas da cena têm 1 px = 1 px CSS
const GESTOS = ['pointerdown', 'touchstart', 'wheel', 'keydown', 'scroll'];
const ESPERA_PREAQUECER_MS = 4000; // depois do pôster na tela, antes de baixar módulos e GLB

const html = document.documentElement;
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const canvas = $('#escritorio-canvas');
const escritorio = canvas.closest('.ag-escritorio');
const trilho = escritorio.closest('.ag-trilho') || escritorio;
const poster = $('#escritorio-poster');
const posterFecho = $('#fecho-poster');
const raizGaveta = $('#gaveta');
const titulo = $('#ag-titulo');
const navTopo = $('.no-card-top');
const listaMesas = $('.ag-mesas');
const mesas = new Map([...document.querySelectorAll('[data-mesa]')].map((el) => [el.dataset.mesa, el]));
const movimentoReduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const topoNoDocumento = (el) => el.getBoundingClientRect().top + scrollY;
const fundoDaNav = () => (navTopo ? navTopo.getBoundingClientRect().bottom : 0);

// Estado lido pelas provas e útil para depurar no console.
const estado = {
  fase: 'decidindo', // decidindo | previa | carregando | animada | estatica
  motivo: null,      // falha | sem-webgl | movimento-reduzido
  cena: null,
  gaveta: null,
  aberta: null,
};
window.__agentesPagina = estado;

// ── Medição (rodada 7, skill gtm-meta-google-tracking) ──
// Tudo passa por window.track (shared/telemetria.js): dataLayer → GTM (GA4, tags em
// tracking/gtm-agentes-escritorio.json) e a fila do painel de percurso. A Meta recebe só o
// ViewContent da página, no Pixel (vindo do GTM) e na CAPI (função meta-capi) com o MESMO
// event_id, para a Meta deduplicar. Fora do domínio de produção (marketing-host.js) a CAPI não
// sai do navegador: o corpo fica em estado.medicao.capi, para as provas.
//
//   agentes_view_content ..... página carregada               Meta ViewContent (Pixel + CAPI)
//   agentes_mesa_aberta ...... gaveta aberta (agente, origem)  -
//   agentes_cta .............. CTA para LP, simulador ou contato -
//   agentes_sala_vista ....... rolou até a sala (1× por sessão) -
//   agentes_versao_estatica .. caiu na versão estática (motivo) -
const FN_CAPI = 'https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/meta-capi';
const producao = () => typeof window.noMarketingHostAllowed === 'function' && window.noMarketingHostAllowed(location.hostname);
estado.medicao = { capi: [] };

function medir(nome, dados, chave) {
  const p = Object.assign({ pagina: location.pathname }, dados);
  if (typeof window.track === 'function') { window.track(nome, p, chave); return; }
  (window.dataLayer = window.dataLayer || []).push(Object.assign({ event: nome }, p));
}
function idEvento(prefixo) {
  const c = window.crypto;
  const u = c && typeof c.randomUUID === 'function' ? c.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  return `${prefixo}-${u}`;
}
function cookie(nome) {
  const m = String(document.cookie || '').match(new RegExp(`(?:^|; )${nome}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}
function fbcAtual() {
  const c = cookie('_fbc');
  if (c) return c;
  let id = '';
  try { id = new URLSearchParams(location.search).get('fbclid') || ''; } catch { id = ''; }
  return id ? `fb.1.${Date.now()}.${id}` : '';
}
// O Pixel chega pelo GTM e pode demorar: tenta por até 5 s.
function fbqQuandoPronto(args, tentativas = 0) {
  if (typeof window.fbq === 'function') { window.fbq(...args); return; }
  if (tentativas >= 20) return;
  setTimeout(() => fbqQuandoPronto(args, tentativas + 1), 250);
}
function enviarCapi(eventName, eventId) {
  const corpo = {
    event_name: eventName,
    event_id: eventId,
    event_source_url: location.origin + location.pathname, // sem query: nada além da página vai à Meta
    fbp: cookie('_fbp') || undefined,
    fbc: fbcAtual() || undefined,
  };
  estado.medicao.capi.push(corpo);
  if (!producao()) return;
  try {
    fetch(FN_CAPI, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), keepalive: true })
      .catch(() => {}); // medição não pode derrubar a página
  } catch { /* idem */ }
}
function verPagina() {
  const eventId = idEvento('agentes-vc');
  medir('agentes_view_content', { event_id: eventId });
  fbqQuandoPronto(['track', 'ViewContent', {}, { eventID: eventId }]);
  enviarCapi('ViewContent', eventId);
}

// CTAs: os links da página e os botões da gaveta (montados por gaveta.js) saem por delegação,
// sem segurar a navegação.
const CTA_POR_HREF = new Map([
  ['/agentes/fiscal/#simulador', 'simular_emissao'],
  ['/agentes/auditor/', 'diagnosticar'],
]);
function ctaDoLink(a) {
  if (a.dataset.cta) return a.dataset.cta;
  if (a.dataset.mesa === 'vaga') return 'criar_automacao';
  if (raizGaveta.contains(a)) {
    const href = a.getAttribute('href') || '';
    return CTA_POR_HREF.get(href) || null;
  }
  return null;
}
document.addEventListener('click', (ev) => {
  try {
    const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
    if (!a) return;
    const cta = ctaDoLink(a);
    if (!cta) return;
    // A mesa vaga no modo animado é tratada em abrirMesa (canvas) ou pelo link comum (botão).
    medir('agentes_cta', { cta, destino: a.getAttribute('href'), origem: raizGaveta.contains(a) ? 'gaveta' : 'pagina' });
  } catch { /* medição não pode segurar o clique */ }
}, true);

let rolagemAntesDaGaveta = null;
let ultimoT = -1;

// ── Carga de módulos (memoizada: a estática reaproveita o que a animada já pediu) ──
let promGavetaJs = null;
let promGavetaCss = null;
const importarGaveta = () => (promGavetaJs ??= import(cfg.gaveta));
const carregarGavetaCss = () => (promGavetaCss ??= new Promise((ok, falhou) => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = cfg.gavetaCss;
  link.onload = () => ok();
  link.onerror = () => falhou(new Error(`não carregou ${cfg.gavetaCss}`));
  document.head.append(link);
}));

function temWebGL() {
  try {
    const teste = document.createElement('canvas');
    const gl = teste.getContext('webgl2') || teste.getContext('webgl');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

// ── Versão estática (critérios 25–27 e 29) ──
function entrarEstatica(motivo) {
  if (estado.fase === 'estatica') return;
  estado.fase = 'estatica';
  estado.motivo = motivo;
  console.info(`[agentes] versão estática: ${motivo}`);
  medir('agentes_versao_estatica', { motivo }, 'estatica');
  pararDeOuvirGestos();
  if (estado.cena) {
    try { estado.cena.destruir(); } catch { /* a cena já pode ter caído */ }
    estado.cena = null;
  }
  for (const [img, src] of [[poster, cfg.posterEscritorio], [posterFecho, cfg.posterFecho]]) {
    if (!img) continue;
    if (img.getAttribute('src') !== src) img.src = src;
    if (img === poster) img.loading = 'eager';
  }
  html.classList.remove('previa', 'revelando', 'animada');
  html.classList.add('estatica');
  // As etiquetas voltam às posições do CSS (porcentagens do pôster).
  for (const el of mesas.values()) {
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
    delete el.dataset.mx;
    delete el.dataset.my;
    el.classList.remove('ag-mesa--oculta');
  }
  listaMesas.style.removeProperty('--ag-escala');
  listaMesas.classList.remove('ag-mesas--longe');
  montarGaveta(true);
}

// ── Gaveta (frente C) ──
async function montarGaveta(estatico) {
  let modulo;
  try {
    [modulo] = await Promise.all([importarGaveta(), carregarGavetaCss()]);
  } catch (erro) {
    // Sem gaveta, os botões das mesas continuam links para as páginas dos agentes.
    console.warn('[agentes] gaveta indisponível; as mesas levam às páginas dos agentes.', erro);
    return;
  }
  if (estado.gaveta) return;
  estado.gaveta = modulo.montarGaveta(raizGaveta, { estatico });
  estado.gaveta.aoMudar(aoMudarGaveta);
  // A gaveta cresce conforme a conversa entra (até 75% da tela): a câmera reenquadra a mesa
  // a cada mudança de altura, para ela continuar acima da gaveta (critério 31).
  const painel = raizGaveta.querySelector('[role="dialog"]');
  if (painel && 'ResizeObserver' in window) new ResizeObserver(reenquadrarMesa).observe(painel);
  for (const [mesa, el] of mesas) {
    if (mesa === 'vaga') continue;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('aria-controls', 'gaveta');
  }
}

function abrirMesa(mesa, origem) {
  if (mesa === 'vaga') {
    const destino = mesas.get('vaga')?.getAttribute('href') || '/contato/';
    medir('agentes_cta', { cta: 'criar_automacao', destino, origem: 'cena' });
    location.assign(destino);
    return;
  }
  origemAbertura = tocouCena ? 'cena' : 'botao';
  tocouCena = false;
  if (!estado.gaveta || !origem) return;
  if (estado.cena) {
    // Celular: o canvas sobe para logo abaixo da navbar (início do trilho, ainda na Tela 1) e
    // a mesa aproximada fica acima da gaveta.
    if (rolagemAntesDaGaveta === null) rolagemAntesDaGaveta = scrollY;
    const alvo = topoNoDocumento(trilho) - fundoDaNav() - FOLGA_NAV;
    scrollTo({ top: Math.max(0, alvo), behavior: movimentoReduzido ? 'instant' : 'smooth' });
  }
  estado.gaveta.abrir(mesa, origem);
}

// O painel da gaveta é o [role=dialog] (ou a própria raiz) com altura menor que a viewport.
function folhaDaGaveta() {
  const candidatos = [...raizGaveta.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]'), raizGaveta];
  return candidatos.find((el) => el.offsetHeight > 0 && el.offsetHeight < innerHeight * 0.95) || null;
}

// alvoY: fração da altura do canvas onde fica o centro da mesa aproximada, no meio da faixa
// visível entre a navbar e o topo da gaveta (critério 31). Conta com o canvas já rolado.
function calcularAlvoY() {
  const altura = canvas.clientHeight || 1;
  const topoCanvas = fundoDaNav() + FOLGA_NAV;
  const folha = folhaDaGaveta();
  let topoGaveta = innerHeight * 0.4;
  const quadroCanvas = canvas.getBoundingClientRect();
  const meioCanvas = quadroCanvas.left + quadroCanvas.width / 2;
  if (folha) {
    const caixa = folha.getBoundingClientRect();
    // Painel ao lado (desktop, R23): não cobre a coluna da mesa, então a faixa vai até o fim do canvas.
    if (caixa.left >= meioCanvas + 120 || caixa.right <= meioCanvas - 120) {
      const faixaLivre = clamp(Math.min(innerHeight, quadroCanvas.bottom), topoCanvas + 40, topoCanvas + altura) - topoCanvas;
      return clamp(faixaLivre / 2 / altura, 0.06, 0.5);
    }
    // Folha presa embaixo: offsetHeight ignora a animação de subida (transform).
    topoGaveta = caixa.bottom >= innerHeight - 2 || caixa.top > innerHeight * 0.5
      ? innerHeight - folha.offsetHeight
      : caixa.top;
  }
  const faixa = clamp(topoGaveta, topoCanvas + 40, topoCanvas + altura) - topoCanvas;
  return clamp(faixa / 2 / altura, 0.06, 0.5);
}

// Enquadramento da mesa aproximada: centro em alvoY e altura visível (fração do canvas entre
// a navbar e o topo da gaveta), para a cena caber a pessoa e a mesa inteiras nessa faixa.
function quadroFoco() {
  const alvoY = calcularAlvoY();
  // No desktop a faixa livre é o canvas inteiro: limitar a 0,6 garante a aproximação da mesa
  // (critério 12) em vez de um quadro quase igual ao da Tela 1.
  return { alvoY, alturaVisivel: clamp(alvoY * 2, 0.12, 0.6) };
}

let reenquadrar = 0;
function reenquadrarMesa() {
  if (reenquadrar || !estado.aberta || !estado.cena) return;
  reenquadrar = requestAnimationFrame(() => {
    reenquadrar = 0;
    if (estado.aberta && estado.cena) estado.cena.focar(estado.aberta, quadroFoco());
  });
}

let origemAbertura = 'botao';
let tocouCena = false;
function aoMudarGaveta({ aberta, agente } = {}) {
  if (aberta) {
    if (estado.aberta !== agente) {
      medir('agentes_mesa_aberta', { agente, origem: origemAbertura, versao: estado.fase === 'estatica' ? 'estatica' : 'animada' });
    }
    estado.aberta = agente;
    if (!estado.cena) return;
    requestAnimationFrame(() => {
      if (estado.cena && estado.aberta === agente) estado.cena.focar(agente, quadroFoco());
    });
    return;
  }
  estado.aberta = null;
  if (!estado.cena) return;
  estado.cena.focar(null);
  if (rolagemAntesDaGaveta !== null) {
    scrollTo({ top: rolagemAntesDaGaveta, behavior: movimentoReduzido ? 'instant' : 'smooth' });
    rolagemAntesDaGaveta = null;
  }
  ultimoT = -1;
  agendarQuadro();
}

// Botões das mesas: abrem a gaveta; sem gaveta, seguem o link. Na prévia o toque pode chegar
// antes de a gaveta montar (ela monta junto do pré-carregamento): monta agora e abre.
for (const [mesa, el] of mesas) {
  if (mesa === 'vaga') continue; // link comum para /contato/
  el.addEventListener('click', (ev) => {
    if (estado.gaveta) { ev.preventDefault(); abrirMesa(mesa, el); return; }
    if (estado.fase === 'estatica' || estado.fase === 'decidindo') return;
    ev.preventDefault();
    montarGaveta(false).then(() => {
      if (estado.gaveta) abrirMesa(mesa, el);
      else location.assign(el.href);
    });
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== ' ' || !estado.gaveta) return;
    ev.preventDefault();
    abrirMesa(mesa, el);
  });
}

// ── Rolagem → cena.fecho(t) e etiquetas sobre a cena ──
// Na animada a cena é sticky dentro de .ag-trilho (agentes.css): ela encosta na navbar e fica
// parada enquanto o trilho rola. t vai de 0 a 1 entre PINO_TELA1 e PINO_FECHO desse trecho,
// então o recuo (Tela 3) acontece com a cena inteira à vista e sem disparar ao centralizá-la.
function progressoFecho() {
  const topoPino = topoNoDocumento(trilho) - fundoDaNav() - FOLGA_NAV;
  const pino = Math.max(1, trilho.offsetHeight - escritorio.offsetHeight);
  const inicio = topoPino + pino * PINO_TELA1;
  const fim = topoPino + pino * PINO_FECHO;
  return clamp((scrollY - inicio) / (fim - inicio), 0, 1);
}
// O topo da cena presa acompanha o fundo real da navbar (muda com safe-area e breakpoints).
function ajustarTopoPino() {
  html.style.setProperty('--ag-topo-pino', `${Math.round(fundoDaNav() + FOLGA_NAV)}px`);
}

let quadroAgendado = 0;
function agendarQuadro() {
  if (!quadroAgendado) quadroAgendado = requestAnimationFrame(atualizarRolagem);
}
function atualizarRolagem() {
  quadroAgendado = 0;
  if (estado.fase !== 'animada' || !estado.cena) return;
  const t = progressoFecho();
  listaMesas.classList.toggle('ag-mesas--longe', t > 0.5 && !estado.aberta);
  if (estado.aberta) return; // com a gaveta aberta a câmera é da mesa
  if (Math.abs(t - ultimoT) < 0.001) return;
  ultimoT = t;
  estado.cena.fecho(t);
  if (t >= 0.95) medir('agentes_sala_vista', {}, 'sala');
}

let cenaNaTela = true;
let ultimaEtiqueta = 0;
function posicionarEtiquetas(agora) {
  if (estado.fase !== 'animada' || !estado.cena) return;
  requestAnimationFrame(posicionarEtiquetas);
  if (!cenaNaTela || agora - ultimaEtiqueta < 50) return;
  ultimaEtiqueta = agora;
  let pontos;
  try { pontos = estado.cena.projetar(); } catch { return; }
  if (!pontos) return;
  const largura = escritorio.clientWidth;
  const altura = escritorio.clientHeight;
  // Área de toque transparente centrada na mesa. Em px inteiros e só quando muda: a câmera
  // assenta devagar, e uma posição que oscila décimos de px nunca fica parada sob o dedo.
  for (const [mesa, el] of mesas) {
    const p = pontos[`mesa-${mesa}`];
    if (!p) continue;
    const meia = el.offsetWidth / 2;
    const x = Math.round(clamp(p.x, meia, Math.max(meia, largura - meia)));
    const y = Math.round(clamp(p.y, el.offsetHeight * 0.62, altura));
    if (el.dataset.mx !== String(x)) { el.dataset.mx = x; el.style.setProperty('--mx', `${x}px`); }
    if (el.dataset.my !== String(y)) { el.dataset.my = y; el.style.setProperty('--my', `${y}px`); }
    el.classList.toggle('ag-mesa--oculta', !p.visivel);
  }
}

// ── Prévia: pôster primeiro (critérios 22 e 23) ──
// O pôster ocupa o quadro com object-fit: contain (a cena mantém a altura do mundo e ganha
// laterais quando o quadro é mais largo): as etiquetas seguem a área real da imagem e a escala
// dela, para cair exatamente sobre os chips da cena na troca.
function posicionarEtiquetasPoster() {
  if (estado.fase !== 'previa' && estado.fase !== 'carregando') return;
  const L = escritorio.clientWidth;
  const A = escritorio.clientHeight;
  if (!L || !A) return;
  const largura = Math.min(L, A * PROPORCAO_POSTER);
  const altura = largura / PROPORCAO_POSTER;
  const x0 = (L - largura) / 2;
  const y0 = (A - altura) / 2;
  listaMesas.style.setProperty('--ag-escala', (altura / ALTURA_PROJETO).toFixed(4));
  for (const [mesa, el] of mesas) {
    const [fx, fy] = ETIQUETAS_POSTER[mesa];
    el.style.setProperty('--mx', `${Math.round(x0 + fx * largura)}px`);
    el.style.setProperty('--my', `${Math.round(y0 + fy * altura)}px`);
  }
}

// Baixa sem executar: modulepreload compila fora da thread principal e o prefetch deixa o GLB no
// cache; a gaveta já monta, para as mesas abrirem antes da cena.
let preaquecido = false;
function preaquecer() {
  if (preaquecido || estado.fase === 'estatica') return;
  preaquecido = true;
  montarGaveta(false);
  const resolver = (m) => { try { return import.meta.resolve(m); } catch { return null; } };
  const modulos = [cfg.three, cfg.cena];
  if (cfg.three === PADRAO.three) {
    modulos.push('three/addons/loaders/GLTFLoader.js', 'three/addons/libs/meshopt_decoder.module.js', 'three/addons/utils/BufferGeometryUtils.js');
  }
  for (const m of modulos) {
    const href = resolver(m);
    if (!href) continue;
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = href;
    document.head.append(link);
  }
  if (cfg.cena === PADRAO.cena) {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = cfg.glb;
    document.head.append(link);
  }
}
// Só depois de o pôster estar na tela e de alguns segundos: o pré-carregamento não disputa a
// carga inicial. Quem toca antes pede tudo no gesto (carregarCena).
function agendarPreaquecer() {
  const ocioso = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  const posterPronto = typeof poster.decode === 'function' ? poster.decode().catch(() => {}) : Promise.resolve();
  posterPronto.then(() => setTimeout(() => ocioso(preaquecer, { timeout: 2000 }), ESPERA_PREAQUECER_MS));
}

function aoPrimeiroGesto(ev) {
  if (ev.type === 'pointermove' && ev.pointerType !== 'mouse') return;
  pararDeOuvirGestos();
  carregarCena();
}
function ouvirGestos() {
  for (const tipo of [...GESTOS, 'pointermove']) addEventListener(tipo, aoPrimeiroGesto, { passive: true, capture: true });
}
function pararDeOuvirGestos() {
  for (const tipo of [...GESTOS, 'pointermove']) removeEventListener(tipo, aoPrimeiroGesto, { capture: true });
}

function iniciarPrevia() {
  estado.fase = 'previa';
  html.classList.add('previa');
  ajustarTopoPino();
  posicionarEtiquetasPoster();
  addEventListener('scroll', agendarQuadro, { passive: true });
  addEventListener('resize', () => { ajustarTopoPino(); posicionarEtiquetasPoster(); ultimoT = -1; agendarQuadro(); });
  ouvirGestos();
  if (document.readyState === 'complete') agendarPreaquecer();
  else addEventListener('load', agendarPreaquecer, { once: true });
}

// ── Versão animada: a cena entra por cima do pôster ──
async function carregarCena() {
  if (estado.fase !== 'previa') return;
  // O teste de WebGL cria um contexto: fica para o gesto, fora da carga da página. Sem WebGL a
  // prévia já é igual à estática; só troca de layout.
  if (!temWebGL()) { entrarEstatica('sem-webgl'); return; }
  estado.fase = 'carregando';
  preaquecer(); // gesto antes do pré-carregamento: pede tudo agora
  let montada;
  try {
    const [, modulo] = await Promise.all([import(cfg.three), import(cfg.cena)]);
    montada = await modulo.montarEscritorio(canvas, { parado: true });
  } catch (erro) {
    if (estado.fase === 'carregando') {
      console.warn('[agentes] a cena não carregou', erro);
      entrarEstatica('falha');
    }
    return;
  }
  if (estado.fase !== 'carregando') { montada.destruir(); return; }
  estado.cena = montada;
  // O primeiro quadro (o do pôster) já está no canvas; a cena fica parada nele até o fim do fade,
  // para nada disputar a thread principal com a troca. Espera esse quadro chegar à tela.
  montada.pausar();
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  if (estado.fase !== 'carregando') return;
  revelar();
}

function revelar() {
  estado.fase = 'animada';
  const cena = estado.cena;
  // Com a gaveta aberta, a mesa aproximada ocupa quase toda a cena acima dela: tocar nela é
  // "tocar fora" e fecha (critério 20); tocar em outra mesa troca a gaveta (critério 21).
  cena.aoTocarMesa((mesa) => {
    if (estado.aberta && estado.aberta === mesa) estado.gaveta?.fechar();
    else { tocouCena = true; abrirMesa(mesa, mesas.get(mesa)); }
  });
  // Fade com a cena parada no quadro do pôster. O pôster só sai quando o fade termina de fato
  // (transitionend): com a thread ocupada, um timer acabaria antes do fade e piscaria a página.
  let concluido = false;
  const concluir = () => {
    if (concluido || estado.fase !== 'animada') return;
    concluido = true;
    canvas.removeEventListener('transitionend', aoTerminar);
    html.classList.remove('previa', 'revelando');
    html.classList.add('animada');
    listaMesas.style.removeProperty('--ag-escala');
    new IntersectionObserver(([entrada]) => { cenaNaTela = entrada.isIntersecting; }).observe(escritorio);
    cena.retomar();
    if (estado.aberta) cena.focar(estado.aberta, quadroFoco());
    ultimoT = -1;
    atualizarRolagem();
    requestAnimationFrame(posicionarEtiquetas);
    cena.acordar(ACORDAR_MS); // só agora a cena começa a se mexer, devagar
  };
  const aoTerminar = (ev) => { if (ev.target === canvas && ev.propertyName === 'opacity') concluir(); };
  canvas.addEventListener('transitionend', aoTerminar);
  html.classList.add('revelando');
  setTimeout(concluir, FADE_MS * 5); // rede de segurança se o transitionend não vier
}

// ── Decisão inicial ──
verPagina();
if (movimentoReduzido) entrarEstatica('movimento-reduzido');
else iniciarPrevia();
