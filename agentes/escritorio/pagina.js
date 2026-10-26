// /agentes/ — "Escritório nó": página (frente A).
// Liga a tela de carregamento, decide entre a versão animada e a estática, monta a cena
// (cena.js, frente B) e a gaveta (gaveta.js, frente C) e liga rolagem, toques e câmera.
// Contrato: .tasks/agentes-escritorio-frentes.md + "Landing" de .checks/agentes-escritorio.md.

// Caminhos dos módulos e pôsteres. A bancada de provas (.checks/agentes/test-pagina.cjs)
// troca por stubs via window.__agentesModulos antes de este arquivo rodar.
const PADRAO = {
  three: 'three',
  cena: '/agentes/escritorio/cena.js',
  gaveta: '/agentes/escritorio/gaveta.js',
  gavetaCss: '/agentes/escritorio/gaveta.css',
  posterEscritorio: '/agentes/escritorio/poster-escritorio.webp',
  posterFecho: '/agentes/escritorio/poster-fecho.webp',
};
const cfg = Object.assign({}, PADRAO, window.__agentesModulos || {});

const ESPERA_BOTAO_MS = 4000;  // "Ver sem animações" (critério 24)
const FOLGA_NAV = 8;           // px entre a navbar e o topo do canvas ao abrir a gaveta
const FIM_FECHO = 0.6;         // t = 1 quando o h2 do fecho chega a 60% da altura da viewport
// Pesos do progresso de 0 a 100%.
const PESOS = { fontes: 0.1, three: 0.3, gaveta: 0.1, gavetaCss: 0.05, cena: 0.45 };

const html = document.documentElement;
const $ = (sel, raiz = document) => raiz.querySelector(sel);
const canvas = $('#escritorio-canvas');
const escritorio = canvas.closest('.ag-escritorio');
const poster = $('#escritorio-poster');
const posterFecho = $('#fecho-poster');
const raizGaveta = $('#gaveta');
const tituloFecho = $('#ag-fecho-titulo');
const titulo = $('#ag-titulo');
const navTopo = $('.no-card-top');
const listaMesas = $('.ag-mesas');
const tela = $('.ag-carregamento');
const botaoSemAnimacoes = $('.ag-sem-animacoes', tela);
const pctTexto = $('.ag-progresso-pct', tela);
const barra = $('.ag-progresso', tela);
const mesas = new Map([...document.querySelectorAll('[data-mesa]')].map((el) => [el.dataset.mesa, el]));
const movimentoReduzido = matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const topoNoDocumento = (el) => el.getBoundingClientRect().top + scrollY;
const fundoDaNav = () => (navTopo ? navTopo.getBoundingClientRect().bottom : 0);

// Estado lido pelas provas e útil para depurar no console.
const estado = {
  fase: 'decidindo', // decidindo | carregando | animada | estatica
  motivo: null,      // pediu | falha | sem-webgl | movimento-reduzido
  cena: null,
  gaveta: null,
  aberta: null,
};
window.__agentesPagina = estado;

let timerBotao = 0;
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

// Enquanto a tela de carregamento cobre a página, nada atrás dela recebe foco.
function travarPagina(travar) {
  for (const el of document.body.children) {
    if (el === tela || el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT') continue;
    el.inert = travar;
  }
}

// ── Versão estática (critérios 24–27 e 29) ──
function entrarEstatica(motivo) {
  if (estado.fase === 'estatica') return;
  const estavaCarregando = estado.fase === 'carregando';
  estado.fase = 'estatica';
  estado.motivo = motivo;
  console.info(`[agentes] versão estática: ${motivo}`);
  clearTimeout(timerBotao);
  if (estado.cena) {
    try { estado.cena.destruir(); } catch { /* a cena já pode ter caído */ }
    estado.cena = null;
  }
  for (const [img, src] of [[poster, cfg.posterEscritorio], [posterFecho, cfg.posterFecho]]) {
    if (!img) continue;
    if (img.getAttribute('src') !== src) img.src = src;
    if (img === poster) img.loading = 'eager';
  }
  html.classList.remove('carregando', 'saindo', 'animada');
  html.classList.add('estatica');
  travarPagina(false);
  if (estavaCarregando && motivo === 'pediu') titulo?.focus({ preventScroll: true });
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
  for (const [mesa, el] of mesas) {
    if (mesa === 'vaga') continue;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-haspopup', 'dialog');
    el.setAttribute('aria-controls', 'gaveta');
  }
}

function abrirMesa(mesa, origem) {
  if (mesa === 'vaga') {
    location.assign(mesas.get('vaga')?.getAttribute('href') || '/contato/');
    return;
  }
  if (!estado.gaveta || !origem) return;
  if (estado.cena) {
    // Celular: o canvas sobe para logo abaixo da navbar e a mesa aproximada fica acima da gaveta.
    if (rolagemAntesDaGaveta === null) rolagemAntesDaGaveta = scrollY;
    const alvo = topoNoDocumento(escritorio) - fundoDaNav() - FOLGA_NAV;
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
  if (folha) {
    const caixa = folha.getBoundingClientRect();
    // Folha presa embaixo: offsetHeight ignora a animação de subida (transform).
    topoGaveta = caixa.bottom >= innerHeight - 2 || caixa.top > innerHeight * 0.5
      ? innerHeight - folha.offsetHeight
      : caixa.top;
  }
  const faixa = clamp(topoGaveta, topoCanvas + 40, topoCanvas + altura) - topoCanvas;
  return clamp(faixa / 2 / altura, 0.06, 0.5);
}

function aoMudarGaveta({ aberta, agente } = {}) {
  if (aberta) {
    estado.aberta = agente;
    if (!estado.cena) return;
    requestAnimationFrame(() => {
      if (estado.cena && estado.aberta === agente) estado.cena.focar(agente, { alvoY: calcularAlvoY() });
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

// Botões das mesas: na animada e na estática abrem a gaveta; sem gaveta, seguem o link.
for (const [mesa, el] of mesas) {
  if (mesa === 'vaga') continue; // link comum para /contato/
  el.addEventListener('click', (ev) => {
    if (!estado.gaveta) return;
    ev.preventDefault();
    abrirMesa(mesa, el);
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== ' ' || !estado.gaveta) return;
    ev.preventDefault();
    abrirMesa(mesa, el);
  });
}

// ── Rolagem → cena.fecho(t) e etiquetas sobre a cena ──
// t = 0 enquanto o canvas ainda cabe inteiro sob a navbar (inclui o topo da página) e
// 1 quando o h2 do fecho chega a FIM_FECHO da viewport.
function progressoFecho() {
  const inicio = Math.max(0, topoNoDocumento(escritorio) - fundoDaNav() - FOLGA_NAV);
  const fim = topoNoDocumento(tituloFecho) - innerHeight * FIM_FECHO;
  if (fim <= inicio) return scrollY >= fim ? 1 : 0;
  return clamp((scrollY - inicio) / (fim - inicio), 0, 1);
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
}

let cenaNaTela = true;
let ultimaEtiqueta = 0;
function posicionarEtiquetas(agora) {
  if (estado.fase !== 'animada' || !estado.cena) return;
  requestAnimationFrame(posicionarEtiquetas);
  if (!cenaNaTela || agora - ultimaEtiqueta < 50) return;
  ultimaEtiqueta = agora;
  let info;
  try { info = estado.cena.inspecionar?.(); } catch { return; }
  const pontos = info?.projetados;
  if (!pontos) return;
  const largura = escritorio.clientWidth;
  const altura = escritorio.clientHeight;
  for (const [mesa, el] of mesas) {
    const p = pontos[`mesa-${mesa}`];
    if (!p) continue;
    const meia = el.offsetWidth / 2;
    const x = clamp(p.x, meia + 6, Math.max(meia + 6, largura - meia - 6));
    const y = clamp(p.y, el.offsetHeight + 28, altura);
    el.style.setProperty('--mx', `${x.toFixed(1)}px`);
    el.style.setProperty('--my', `${y.toFixed(1)}px`);
    el.classList.toggle('ag-mesa--oculta', !p.visivel);
  }
}

// ── Versão animada (critérios 22 e 23) ──
function mostrarProgresso(valor) {
  const pct = Math.round(valor * 100);
  if (pctTexto.textContent !== `${pct}%`) pctTexto.textContent = `${pct}%`;
  barra.setAttribute('aria-valuenow', String(pct));
  barra.style.setProperty('--ag-progresso', String(pct));
}

async function iniciarAnimada() {
  estado.fase = 'carregando';
  html.classList.add('carregando');
  travarPagina(true);
  mostrarProgresso(0);

  timerBotao = setTimeout(() => {
    if (estado.fase === 'carregando') botaoSemAnimacoes.hidden = false;
  }, ESPERA_BOTAO_MS);
  botaoSemAnimacoes.addEventListener('click', () => entrarEstatica('pediu'), { once: true });

  const partes = { fontes: 0, three: 0, gaveta: 0, gavetaCss: 0, cena: 0 };
  let mostrado = 0;
  const marcar = (parte, valor = 1) => {
    partes[parte] = Math.max(partes[parte], clamp(valor, 0, 1));
    const total = Object.entries(PESOS).reduce((soma, [k, peso]) => soma + peso * partes[k], 0);
    mostrado = Math.max(mostrado, Math.min(total, 0.99)); // 100% só quando tudo terminar
    if (estado.fase === 'carregando') mostrarProgresso(mostrado);
  };

  const fontes = Promise.all([
    document.fonts.load('800 1em Sora'),
    document.fonts.load('500 1em "JetBrains Mono"'),
  ]).catch(() => {}).then(() => marcar('fontes'));
  const three = import(cfg.three).then(() => marcar('three'));
  const gavetaJs = importarGaveta().then(() => marcar('gaveta'));
  const gavetaCss = carregarGavetaCss().then(() => marcar('gavetaCss'));
  const cena = import(cfg.cena)
    .then((modulo) => modulo.montarEscritorio(canvas, { aoProgresso: (p) => marcar('cena', p) }))
    .then((montada) => {
      // "Ver sem animações" já foi tocado (ou outra falha decidiu): a cena não entra.
      if (estado.fase !== 'carregando') { montada.destruir(); return; }
      estado.cena = montada;
      montada.pausar(); // parada enquanto a tela de carregamento está aberta
      marcar('cena');
    });

  try {
    await Promise.all([fontes, three, gavetaJs, gavetaCss, cena]);
  } catch (erro) {
    if (estado.fase === 'carregando') {
      console.warn('[agentes] a cena não carregou', erro);
      entrarEstatica('falha');
    }
    return;
  }
  if (estado.fase !== 'carregando' || !estado.cena) return;
  mostrarProgresso(1);
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  if (estado.fase !== 'carregando') return;
  revelar();
}

function revelar() {
  clearTimeout(timerBotao);
  estado.fase = 'animada';
  const cena = estado.cena;
  html.classList.add('animada', 'saindo');
  cena.retomar();
  setTimeout(() => {
    html.classList.remove('carregando', 'saindo');
    travarPagina(false);
  }, 260);

  cena.aoTocarMesa((mesa) => abrirMesa(mesa, mesas.get(mesa)));
  montarGaveta(false);

  addEventListener('scroll', agendarQuadro, { passive: true });
  addEventListener('resize', () => { ultimoT = -1; agendarQuadro(); });
  new IntersectionObserver(([entrada]) => { cenaNaTela = entrada.isIntersecting; }).observe(escritorio);
  atualizarRolagem();
  requestAnimationFrame(posicionarEtiquetas);
}

// ── Decisão inicial ──
if (movimentoReduzido) entrarEstatica('movimento-reduzido');
else if (!temWebGL()) entrarEstatica('sem-webgl');
else iniciarAnimada();
