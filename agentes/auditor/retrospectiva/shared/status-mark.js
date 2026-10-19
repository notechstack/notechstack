/* No app: componente StatusMark do React Bits (motion/react).
   Aqui: porte em JS puro para o protótipo (TASK-mv9ygtd3hgz, rodada 4), com window.Motion (Motion 14.3.0 local).
   API: StatusMark.criar(el, { status, progress, label, color, doneColor, errorColor, size, strokeWidth, dashes, fontSize, spinDuration })
        devolve { set(status, progress) }   status: idle | running | done | error   progress: 0..1
   Também aqui: comportamento das telas da rodada 4 (t02 switches e acordeão, t04 leitura por etapa, t06 medidor e filtros).
   Cores: só variáveis de tokens.css. */
(function () {
  'use strict';
  var M = window.Motion;
  var NS = 'http://www.w3.org/2000/svg';
  var reduzido = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var EASE = [0.22, 1, 0.36, 1];

  function no(tag, attrs, pai) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (pai) pai.appendChild(e);
    return e;
  }
  function anima(el, props, op) {
    if (!M || reduzido) { for (var k in props) { var v = props[k]; el.style[k] = Array.isArray(v) ? v[v.length - 1] : v; } return null; }
    try { return M.animate(el, props, op); } catch (e) { for (var j in props) { var w = props[j]; el.style[j] = Array.isArray(w) ? w[w.length - 1] : w; } return null; }
  }

  /* ── StatusMark ── */
  function criar(el, o) {
    o = o || {};
    var size = o.size || 20, sw = o.strokeWidth || 2, dashes = o.dashes || 8, spin = o.spinDuration || 1100;
    var cor = o.color || 'currentColor', corOk = o.doneColor || 'var(--no-verde)', corErro = o.errorColor || 'var(--no-vermelho)';
    var r = (24 - sw) / 2 - 0.5, circ = 2 * Math.PI * r, traco = circ / dashes;
    el.classList.add('status-mark');
    el.style.color = cor;
    el.innerHTML = '';
    var svg = no('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', fill: 'none' }, el);
    var anel = no('circle', { cx: 12, cy: 12, r: r, stroke: 'currentColor', 'stroke-width': sw, 'stroke-linecap': 'round',
      'stroke-dasharray': (traco * 0.55).toFixed(2) + ' ' + (traco * 0.45).toFixed(2), opacity: '.45', 'class': 'sm-anel' }, svg);
    var arco = no('circle', { cx: 12, cy: 12, r: r, stroke: 'currentColor', 'stroke-width': sw, 'stroke-linecap': 'round', pathLength: 1,
      'stroke-dasharray': '1 1', 'stroke-dashoffset': 1, transform: 'rotate(-90 12 12)', 'class': 'sm-arco' }, svg);
    var check = no('path', { d: 'M7.2 12.4l3.2 3.1 6.4-6.8', stroke: corOk, 'stroke-width': sw + 0.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      pathLength: 1, 'stroke-dasharray': '1 1', 'stroke-dashoffset': 1 }, svg);
    var xis = no('path', { d: 'M8.5 8.5l7 7M15.5 8.5l-7 7', stroke: corErro, 'stroke-width': sw + 0.4, 'stroke-linecap': 'round',
      pathLength: 1, 'stroke-dasharray': '1 1', 'stroke-dashoffset': 1 }, svg);
    var rot = null;
    if (o.label) {
      var l = document.createElement('span');
      l.className = 'sm-label'; l.textContent = o.label; l.style.fontSize = (o.fontSize || 14) + 'px';
      el.appendChild(l);
    }
    var atual = null;
    /* giro do anel em CSS (keyframes em telas-r4.css): transform de SVG via Motion travava o frameloop no Chromium */
    el.style.setProperty('--sm-giro', spin + 'ms');
    function giro(liga) { el.classList.toggle('sm-girando', !!liga && !reduzido); }
    function set(status, progress) {
      var p = Math.max(0, Math.min(1, progress == null ? (status === 'done' ? 1 : 0) : progress));
      el.setAttribute('data-status', status);
      el.setAttribute('role', 'img');
      el.setAttribute('aria-label', o.label || ({ idle: 'aguardando', running: 'lendo', done: 'pronto', error: 'com erro' })[status]);
      if (status === 'running') {
        giro(true);
        anel.style.opacity = '.45';
        arco.style.stroke = 'currentColor';
        arco.style.strokeDashoffset = String(1 - p);
        check.style.strokeDashoffset = '1'; xis.style.strokeDashoffset = '1';
      } else if (status === 'idle') {
        giro(false);
        anel.style.opacity = '.45';
        arco.style.strokeDashoffset = '1';
        check.style.strokeDashoffset = '1'; xis.style.strokeDashoffset = '1';
      } else {
        giro(false);
        var c = status === 'done' ? corOk : corErro;
        var marca = status === 'done' ? check : xis;
        (status === 'done' ? xis : check).style.strokeDashoffset = '1';
        arco.style.stroke = c;
        if (atual === status) { anel.style.opacity = '0'; arco.style.strokeDashoffset = '0'; marca.style.strokeDashoffset = '0'; }
        else {
          /* traço do check/X por transição CSS (telas-r4.css); Motion em atributo de SVG travava o frameloop */
          anel.style.opacity = '0';
          arco.style.strokeDashoffset = '0';
          marca.style.strokeDashoffset = '0';
        }
      }
      atual = status;
    }
    set(o.status || 'idle', o.progress || 0);
    return { set: set, el: el };
  }
  window.StatusMark = { criar: criar };

  /* ── Telas da rodada 4 ── */
  var vez = 0, paradas = [];
  function guarda(c) { if (c) paradas.push(c); return c; }
  function paraTudo() {
    paradas.forEach(function (c) { try { if (typeof c === 'function') c(); else c.stop(); } catch (e) {} });
    paradas = [];
  }

  /* t02 · switches, contador e acordeão */
  function montaT02() {
    var t = document.getElementById('t02');
    if (!t) return;
    t.querySelectorAll('.janela').forEach(function (j) {
      var cont = j.querySelector('[data-contador]');
      var ins = j.querySelectorAll('input[role="switch"]');
      function conta(pop) {
        var n = 0; ins.forEach(function (i) { if (i.checked) n++; });
        cont.textContent = n + ' de ' + ins.length + ' lidas';
        if (pop) anima(cont, { transform: ['translateY(-6px)', 'translateY(0px)'], opacity: [0, 1] }, { duration: 0.3, ease: EASE });
      }
      ins.forEach(function (i) {
        posBolinha(i, false);
        i.addEventListener('change', function () { posBolinha(i, true); conta(true); });
      });
      conta(false);
      var cab = j.querySelector('.janela__cab'), corpo = j.querySelector('.janela__corpo');
      cab.addEventListener('click', function () {
        var aberto = cab.getAttribute('aria-expanded') === 'true';
        cab.setAttribute('aria-expanded', aberto ? 'false' : 'true');
        var h = corpo.scrollHeight;
        corpo.style.overflow = 'hidden';
        if (!M || reduzido) { corpo.style.height = aberto ? '0px' : ''; return; }
        var a = M.animate(corpo, { height: aberto ? [h + 'px', '0px'] : ['0px', h + 'px'], opacity: aberto ? [1, 0] : [0, 1] }, { duration: 0.32, ease: EASE });
        if (!aberto && a && a.finished) a.finished.then(function () { corpo.style.height = ''; });
      });
    });
  }
  function posBolinha(input, mola) {
    var b = input.parentNode.querySelector('.switch__bolinha');
    if (!b) return;
    var x = input.checked ? 'translateX(18px)' : 'translateX(0px)';
    if (!mola || !M || reduzido) { b.style.transform = x; return; }
    try { M.animate(b, { transform: x }, { type: 'spring', stiffness: 520, damping: 28 }); }
    catch (e) { b.style.transform = x; }
  }

  /* t04 · leitura etapa por etapa + geral 0..100% */
  var marcasT04 = [];
  function montaT04() {
    var t = document.getElementById('t04');
    if (!t) return;
    marcasT04 = Array.prototype.map.call(t.querySelectorAll('.fonte'), function (f) {
      return { f: f, sub: f.querySelector('.fonte__sub'), etapas: f.getAttribute('data-etapas').split('|'),
        sm: criar(f.querySelector('.sm'), { size: 22, strokeWidth: 2.2 }) };
    });
  }
  function rodaT04(final) {
    var t = document.getElementById('t04');
    var num = t.querySelector('[data-geral]'), barra = t.querySelector('.barra-geral i');
    var n = marcasT04.length, prog = marcasT04.map(function () { return 0; });
    function geral() {
      var s = 0; prog.forEach(function (p) { s += p; });
      var g = s / n;
      num.firstChild.nodeValue = String(Math.round(g * 100));
      barra.style.transform = 'scaleX(' + g.toFixed(4) + ')';
    }
    marcasT04.forEach(function (m, k) {
      m.sub.textContent = m.etapas[final ? m.etapas.length - 1 : 0];
      m.f.classList.toggle('pronta', !!final);
      m.f.classList.toggle('lendo', false);
      m.sm.set(final ? 'done' : 'idle', final ? 1 : 0);
      prog[k] = final ? 1 : 0;
    });
    geral();
    if (final) return;
    var minha = vez, DUR = 1.0;
    /* relógio próprio (rAF), sem depender do frameloop do Motion */
    function relogio(dur, op) {
      var t0 = null, vivo = true;
      function q(ts) {
        if (!vivo) return;
        if (t0 === null) t0 = ts;
        var v = Math.min(1, (ts - t0) / (dur * 1000));
        op.onUpdate(v);
        if (v < 1) requestAnimationFrame(q); else op.onComplete();
      }
      requestAnimationFrame(q);
      return { stop: function () { vivo = false; } };
    }
    function fonte(k) {
      if (minha !== vez || k >= n) return;
      var m = marcasT04[k];
      m.f.classList.add('lendo');
      var etapa = -1;
      var a = guarda(relogio(DUR, {
        onUpdate: function (v) {
          if (minha !== vez) return;
          prog[k] = v; m.sm.set('running', v); geral();
          var e = Math.min(m.etapas.length - 1, Math.floor(v * m.etapas.length));
          if (e !== etapa) { etapa = e; m.sub.textContent = m.etapas[e]; anima(m.sub, { opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0px)'] }, { duration: 0.2 }); }
        },
        onComplete: function () {
          if (minha !== vez) return;
          prog[k] = 1; geral();
          m.f.classList.remove('lendo'); m.f.classList.add('pronta');
          m.sm.set('done', 1);
          fonte(k + 1);
        }
      }));
    }
    var tm = setTimeout(function () { fonte(0); }, 250);
    guarda(function () { clearTimeout(tm); });
  }

  /* t06 · medidor, barra segmentada, filtros e cartões que expandem */
  var marcasT06 = [];
  var SM_T06 = { ok: 'done', problema: 'error', atencao: 'running', nv: 'idle' };
  function montaT06() {
    var t = document.getElementById('t06');
    if (!t) return;
    t.querySelectorAll('.checagem[data-chk]').forEach(function (c) {
      var est = c.getAttribute('data-chk');
      var cor = est === 'atencao' ? 'var(--no-ambar-texto)' : 'var(--no-cinza)';
      var sm = criar(c.querySelector('.sm'), { size: 22, strokeWidth: 2.2, color: cor, dashes: est === 'nv' ? 10 : 8 });
      marcasT06.push({ c: c, sm: sm, est: est });
      c.addEventListener('click', function () {
        pausaStory();
        var aberto = c.getAttribute('aria-expanded') === 'true';
        c.setAttribute('aria-expanded', aberto ? 'false' : 'true');
        var ev = c.querySelector('.ev');
        if (!aberto) anima(ev, { opacity: [0, 1], transform: ['translateY(-4px)', 'translateY(0px)'] }, { duration: 0.25, ease: EASE });
      });
    });
    t.querySelectorAll('.filtro').forEach(function (b) {
      b.addEventListener('click', function () {
        pausaStory();
        t.querySelectorAll('.filtro').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        var f = b.getAttribute('data-filtro');
        var mostrar = [];
        marcasT06.forEach(function (m) {
          var ok = f === 'todas' || m.est === f;
          if (ok) { if (m.c.hidden) { m.c.hidden = false; mostrar.push(m.c); } }
          else m.c.hidden = true;
        });
        if (mostrar.length && M && !reduzido) {
          mostrar.forEach(function (el) { el.style.opacity = '0'; });
          M.animate(mostrar, { opacity: [0, 1], transform: ['translateY(10px) scale(.98)', 'translateY(0px) scale(1)'] },
            { duration: 0.3, delay: M.stagger(0.04), ease: EASE });
        }
      });
    });
  }
  function pausaStory() { if (window.RetroMotion && window.RetroMotion.pausaStory) window.RetroMotion.pausaStory(); }
  function rodaT06(final) {
    var t = document.getElementById('t06');
    var arco = t.querySelector('.medidor__arco'), num = t.querySelector('[data-medidor]');
    /* modo real: diagnostico-real.js grava data-ok e data-total no número; sem eles, a demonstração (6 de 10) */
    var total = +num.getAttribute('data-total') > 0 ? +num.getAttribute('data-total') : 10;
    var ok = +num.getAttribute('data-total') > 0 ? +num.getAttribute('data-ok') || 0 : 6;
    var alvo = ok / total;
    marcasT06.forEach(function (m) { m.sm.set(m.est === 'atencao' ? 'running' : m.est === 'nv' ? 'idle' : 'idle', m.est === 'atencao' ? 0.5 : 0); });
    var segs = t.querySelectorAll('.segmentos i');
    if (final || !M) {
      arco.style.strokeDashoffset = String(1 - alvo); num.textContent = String(ok);
      segs.forEach(function (s) { s.style.transform = 'scaleX(1)'; });
      marcasT06.forEach(function (m) { m.sm.set(SM_T06[m.est], m.est === 'atencao' ? 0.5 : 1); });
      return;
    }
    var minha = vez;
    arco.style.strokeDashoffset = '1';
    guarda(M.animate(0, alvo, { duration: 1.2, ease: EASE, delay: 0.15,
      onUpdate: function (v) { arco.style.strokeDashoffset = String(1 - v); num.textContent = String(Math.round(v * total)); } }));
    segs.forEach(function (s) { s.style.transform = 'scaleX(0)'; });
    guarda(M.animate(segs, { transform: ['scaleX(0)', 'scaleX(1)'] }, { duration: 0.45, delay: M.stagger(0.12, { startDelay: 0.3 }), ease: EASE }));
    marcasT06.forEach(function (m, k) {
      var tm = setTimeout(function () {
        if (minha !== vez) return;
        if (m.est === 'ok' || m.est === 'problema') m.sm.set(SM_T06[m.est], 1);
      }, 500 + k * 90);
      guarda(function () { clearTimeout(tm); });
    });
  }

  function aoMostrar(tela) {
    vez++;
    paraTudo();
    var final = reduzido || !M;
    if (tela.id === 't04') rodaT04(final);
    if (tela.id === 't06') rodaT06(final);
  }

  montaT02(); montaT04(); montaT06();
  window.TelasR4 = { aoMostrar: aoMostrar };
})();
