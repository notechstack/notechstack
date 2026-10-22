/* Cursor com texto e ícone das páginas públicas da nó (Lucca, 22/10/2026), no lugar do smooth-cursor. Inspirado no Text
   Icons Effect do Cursify (cursify.ui-layouts.com/components/texticon-cursor), reescrito sem React:
   - o ponto âmbar segue o mouse; sobre um link ou botão, abre ao lado uma pílula com ícone e, quando ajuda, um texto
     (WhatsApp, nova aba ou o data-cursor do elemento; data-cursor="" desliga);
   - sobre um termo marcado (a.no-termo[data-termo]), vira o cartão "nó explica" com o texto de glossario.js;
   - em toque, teclado ou movimento reduzido não há cursor: o mesmo cartão abre junto do termo (primeiro toque abre,
     o segundo segue o link).
   Campos editáveis, controles de vídeo e diálogos abertos mantêm o cursor nativo. */
(function () {
  'use strict';
  if (window.noTextIconCursor) return;
  window.noTextIconCursor = true;

  var fino = matchMedia('(hover:hover) and (pointer:fine)');
  var reduzido = matchMedia('(prefers-reduced-motion: reduce)');
  var NATIVO = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),video[controls],dialog[open]';
  var ALVO = '[data-cursor],a[href],button:not([disabled]),summary,[role="button"]';
  var SVG = function (d) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>'; };
  var ICONES = {
    seta: SVG('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    externo: SVG('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    descer: SVG('<path d="M12 5v14M6 13l6 6 6-6"/>'),
    play: SVG('<path d="M7 4.5v15l12-7.5z"/>'),
    email: SVG('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
    whatsapp: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.05 2a9.9 9.9 0 0 0-8.53 14.9L2 22l5.25-1.38A9.9 9.9 0 1 0 12.05 2Zm0 18.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.2 8.2 0 1 1 6.97 3.86Zm4.5-6.14c-.25-.12-1.46-.72-1.69-.8-.22-.08-.39-.12-.55.13-.17.24-.64.8-.78.96-.14.17-.29.19-.54.06a6.7 6.7 0 0 1-3.32-2.9c-.25-.43.25-.4.71-1.33a.45.45 0 0 0-.02-.42c-.06-.12-.55-1.33-.76-1.82-.2-.48-.4-.41-.55-.42h-.47a.9.9 0 0 0-.66.31 2.76 2.76 0 0 0-.86 2.05 4.8 4.8 0 0 0 1 2.55 11 11 0 0 0 4.21 3.72c1.57.68 2.18.74 2.97.62.48-.07 1.46-.6 1.67-1.18.2-.58.2-1.07.14-1.18-.06-.1-.22-.16-.47-.29Z"/></svg>'
  };
  function glossario() { return window.noGlossario || {}; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function cartaoHTML(termo, link) {
    var g = glossario()[termo.getAttribute('data-termo')];
    if (!g) return '';
    var acao = esc(g.acao || 'Saiba mais') + ' ' + ICONES.seta.replace('<svg', '<svg width="14" height="14"');
    return '<p class="no-explica-kicker">nó explica</p><p class="no-explica-titulo">' + esc(g.titulo) + '</p>' +
      '<p class="no-explica-texto">' + esc(g.texto) + '</p>' +
      (link ? '<a class="no-explica-acao" href="' + esc(termo.getAttribute('href') || '/contato/') + '">' + acao + '</a>'
        : '<span class="no-explica-acao">' + acao + '</span>');
  }

  /* ---------- acessibilidade: cada termo ganha a explicação como descrição ---------- */
  function prepararTermos() {
    var termos = document.querySelectorAll('a.no-termo[data-termo]');
    for (var i = 0; i < termos.length; i++) {
      var t = termos[i], g = glossario()[t.getAttribute('data-termo')];
      if (!g || t.getAttribute('aria-describedby')) continue;
      var id = 'no-termo-desc-' + i;
      var sr = document.createElement('span');
      sr.className = 'no-termo-sr'; sr.id = id; sr.textContent = g.titulo + ': ' + g.texto;
      t.after(sr);
      t.setAttribute('aria-describedby', id);
      t.setAttribute('aria-expanded', 'false');
    }
  }

  /* ---------- pop-up do termo (toque, teclado, movimento reduzido) ---------- */
  var pop = document.createElement('div');
  pop.className = 'no-termo-pop'; pop.setAttribute('role', 'tooltip'); pop.id = 'no-termo-pop'; pop.hidden = true;
  var popDe = null;
  function abrirPop(termo, comLink) {
    var html = cartaoHTML(termo, comLink);
    if (!html) return false;
    if (popDe && popDe !== termo) popDe.setAttribute('aria-expanded', 'false');
    pop.innerHTML = html; pop.hidden = false; popDe = termo;
    termo.setAttribute('aria-expanded', 'true');
    var r = termo.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    var left = Math.min(Math.max(16, r.left + window.scrollX), window.scrollX + document.documentElement.clientWidth - w - 16);
    var top = r.bottom + window.scrollY + 8;
    if (r.bottom + h + 16 > window.innerHeight && r.top - h - 8 > 0) top = r.top + window.scrollY - h - 8;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    return true;
  }
  function fecharPop() {
    if (!popDe) return;
    popDe.setAttribute('aria-expanded', 'false');
    pop.hidden = true; popDe = null;
  }

  /* ---------- cursor ---------- */
  var raiz = document.createElement('div');
  raiz.className = 'no-tic'; raiz.setAttribute('aria-hidden', 'true');
  raiz.innerHTML = '<span class="no-tic-ponto"></span><span class="no-tic-rotulo" hidden></span><div class="no-tic-cartao" hidden></div>';
  var rotulo = raiz.children[1], cartao = raiz.children[2];
  var x = 0, y = 0, quadro = 0, atual = null;

  function cursorLigado() { return fino.matches && !reduzido.matches; }
  function esconder() {
    raiz.classList.remove('is-visivel', 'is-ativo');
    document.documentElement.classList.remove('has-tic-cursor');
    atual = null; rotulo.hidden = true; cartao.hidden = true;
  }
  /* O que mostrar para o elemento sob o mouse: {cartao}, {icone, texto}, {} (só o ponto ativo) ou null. */
  function conteudo(el) {
    var termo = el.closest('a.no-termo[data-termo]');
    if (termo) return { termo: termo };
    var alvo = el.closest(ALVO);
    if (!alvo) return null;
    var proprio = alvo.getAttribute('data-cursor');
    if (proprio === '') return {};
    if (proprio) return { icone: alvo.getAttribute('data-cursor-icone') || 'seta', texto: proprio };
    if (alvo.tagName !== 'A') return {};
    var href = alvo.getAttribute('href') || '';
    if (/^(https?:)?\/\/(wa\.me|api\.whatsapp\.com)/i.test(href)) return { icone: 'whatsapp', texto: 'Conversar no WhatsApp' };
    if (/^mailto:/i.test(href)) return { icone: 'email', texto: 'Mandar e-mail' };
    if (/^#/.test(href)) return { icone: 'descer' };
    if (alvo.target === '_blank' || (alvo.host && alvo.host !== location.host)) return { icone: 'externo', texto: 'Abre em nova aba' };
    return { icone: 'seta' };
  }
  function mostrar(alvoEl, c) {
    atual = alvoEl;
    raiz.classList.toggle('is-ativo', !!c);
    rotulo.hidden = true; cartao.hidden = true;
    if (!c) return;
    if (c.termo) { cartao.innerHTML = cartaoHTML(c.termo, false); cartao.hidden = !cartao.innerHTML; }
    else if (c.icone) { rotulo.innerHTML = ICONES[c.icone] + (c.texto ? '<span>' + esc(c.texto) + '</span>' : ''); rotulo.hidden = false; }
    lado();
  }
  /* Vira para a esquerda ou para cima quando o rótulo sairia da tela. */
  function lado() {
    var caixa = !cartao.hidden ? cartao : (!rotulo.hidden ? rotulo : null);
    raiz.classList.remove('is-esquerda', 'is-acima');
    if (!caixa) return;
    if (x + 20 + caixa.offsetWidth > document.documentElement.clientWidth - 12) raiz.classList.add('is-esquerda');
    if (caixa === cartao && y + caixa.offsetHeight > window.innerHeight - 12) raiz.classList.add('is-acima');
  }
  function desenhar() { quadro = 0; raiz.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)'; }

  document.addEventListener('pointermove', function (ev) {
    if (!cursorLigado() || ev.pointerType !== 'mouse' || ev.target.closest(NATIVO)) { esconder(); return; }
    x = ev.clientX; y = ev.clientY;
    var alvo = ev.target.closest('a.no-termo[data-termo],' + ALVO);
    if (alvo !== atual) mostrar(alvo, alvo ? conteudo(ev.target) : null);
    else if (alvo) lado();
    document.documentElement.classList.add('has-tic-cursor');
    raiz.classList.add('is-visivel');
    if (!quadro) quadro = requestAnimationFrame(desenhar);
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', esconder, { passive: true });
  window.addEventListener('blur', esconder);
  window.addEventListener('pagehide', esconder);
  document.addEventListener('visibilitychange', function () { if (document.hidden) esconder(); });
  fino.addEventListener('change', esconder);
  reduzido.addEventListener('change', esconder);

  /* ---------- termos sem cursor: toque, teclado e movimento reduzido ---------- */
  var ultimoPonteiro = 'mouse';
  document.addEventListener('pointerdown', function (ev) {
    ultimoPonteiro = ev.pointerType || 'mouse';
    if (popDe && !pop.contains(ev.target) && !popDe.contains(ev.target)) fecharPop();
  }, { passive: true });
  document.addEventListener('click', function (ev) {
    var termo = ev.target.closest && ev.target.closest('a.no-termo[data-termo]');
    if (!termo || ultimoPonteiro === 'mouse') return;
    if (popDe === termo) return;           // segundo toque: segue o link
    if (abrirPop(termo, true)) ev.preventDefault();
  });
  document.addEventListener('focusin', function (ev) {
    var termo = ev.target.closest && ev.target.closest('a.no-termo[data-termo]');
    if (termo && termo.matches(':focus-visible')) abrirPop(termo, false);
  });
  document.addEventListener('focusout', function (ev) {
    if (popDe && ev.target === popDe && ultimoPonteiro === 'mouse') fecharPop();
  });
  document.addEventListener('pointerover', function (ev) {
    if (cursorLigado() || ev.pointerType !== 'mouse') return;
    var termo = ev.target.closest && ev.target.closest('a.no-termo[data-termo]');
    if (termo) abrirPop(termo, false);
    else if (popDe && !pop.contains(ev.target)) fecharPop();
  }, { passive: true });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') fecharPop(); });
  window.addEventListener('resize', fecharPop);

  function iniciar() {
    document.body.append(raiz, pop);
    prepararTermos();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
