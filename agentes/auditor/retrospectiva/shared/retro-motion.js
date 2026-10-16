/* nó.agentes · movimento da retrospectiva (TASK-mv9ygtd3hgz, rodada 3)
   Biblioteca: Motion 14.3.0 local (shared/vendor/motion-14.3.0.js, window.Motion). No app vira motion/react.
   Gancho: o index.html chama RetroMotion.aoMostrar(tela, i, ctx) no fim de mostrar(i).
   Regra de cor: só variáveis de tokens.css. Destaque = --no-ambar (cor padrão da marca-mãe).
   prefers-reduced-motion: reduce desliga tudo, mostra o estado final e não faz autoplay. */
(function () {
  'use strict';
  var M = window.Motion;
  var reduzido = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var STORY = { t05: 1, t06: 1, t07: 1, 't-horario': 1, t08: 1, 't-caminho': 1 }; /* rodada 5: telas novas 07 e 09 entram na retrospectiva */
  var DURACAO_STORY = 6;
  var EASE = [0.22, 1, 0.36, 1];
  var pausado = false; /* rodada 6: pausa do autoplay, vale para todas as telas da retrospectiva */
  var storyFim = false;

  /* ── CSS do movimento (só tokens) ── */
  var css = [
    '.celular { --destaque: var(--no-ambar); }',
    '.progresso i b { display: none; height: 100%; border-radius: inherit; background: var(--sobre); transform-origin: left center; transform: scaleX(0); }',
    '.progresso i.enchendo { background: color-mix(in srgb, var(--sobre) 32%, transparent); }',
    '.progresso i.enchendo b { display: block; }',
    '.fita { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; }',
    '.fita path { fill: none; stroke: var(--destaque); stroke-width: 46; stroke-linecap: butt; }',
    '#t05 > :not(.fita) { position: relative; z-index: 1; }',
    '.palavra { display: inline-block; transform-origin: 50% 70%; }',
    /* rodada 6: botão de pausa no fim do .topo */
    '.topo .selo { margin-left: auto; }',
    '.pausa { width: 32px; height: 32px; border: 0; border-radius: var(--raio-tag); background: var(--no-tinta); color: var(--no-osso);',
    '  display: grid; place-items: center; cursor: pointer; flex: none; margin-left: 8px; padding: 0; }',
    '.pausa svg { width: 14px; height: 14px; }',
    '.pausa .pausa__play { display: none; }',
    '.pausa[aria-pressed="true"] .pausa__pausa { display: none; }',
    '.pausa[aria-pressed="true"] .pausa__play { display: block; }',
    '.pausa:focus-visible { outline: 2px solid var(--sobre); outline-offset: 2px; }',
    '.grafico .barras { display: flex; align-items: flex-end; gap: 6px; height: 64px; }',
    '.grafico .barras i { flex: 1; height: calc(var(--h) * 100%); background: var(--no-azul); border-radius: 4px 4px 0 0; transform-origin: center bottom; transition: background-color .3s; }',
    '.grafico .barras i.maior { background: var(--destaque); }',
    '.grafico .barras.animando i.maior:not(.acesa) { background: var(--no-azul); }',
    '.leitura { font: var(--peso-display) 28px/1.1 var(--font-core); letter-spacing: -0.03em; min-height: 2.25em; }',
    '@media (prefers-reduced-motion: reduce) { .toast { transition: none; } }'
  ].join('\n');
  var estilo = document.createElement('style');
  estilo.setAttribute('data-retro-motion', '');
  estilo.textContent = css;
  document.head.appendChild(estilo);

  /* ── Preparação única da marcação (fita, palavras, botão de pausa) ── */
  var SVGNS = 'http://www.w3.org/2000/svg';
  var t05 = document.getElementById('t05');
  if (t05) {
    var svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'fita');
    svg.setAttribute('viewBox', '0 0 390 844');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    svg.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', 'M -60 610 C 70 470, 190 470, 215 560 S 330 720, 450 520');
    svg.appendChild(p);
    t05.insertBefore(svg, t05.firstChild);
    var h1 = t05.querySelector('h1.titulo');
    if (h1) partePalavras(h1, h1.textContent);
  }
  /* rodada 6: um botão de pausa no fim do .topo de cada tela da retrospectiva (sem autoplay, sem botão) */
  var ICONE_PAUSA = '<svg class="pausa__pausa" viewBox="0 0 14 14" aria-hidden="true" focusable="false">' +
    '<rect x="2.5" y="1.5" width="3" height="11" rx="1" fill="currentColor"/>' +
    '<rect x="8.5" y="1.5" width="3" height="11" rx="1" fill="currentColor"/></svg>';
  var ICONE_PLAY = '<svg class="pausa__play" viewBox="0 0 14 14" aria-hidden="true" focusable="false">' +
    '<path d="M3.5 1.8 L12 7 L3.5 12.2 Z" fill="currentColor"/></svg>';
  if (M && !reduzido) {
    Object.keys(STORY).forEach(function (id) {
      var tela = document.getElementById(id);
      var topo = tela && tela.querySelector('.topo');
      if (!topo || topo.querySelector('.pausa')) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pausa';
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', 'Pausar');
      b.innerHTML = ICONE_PAUSA + ICONE_PLAY;
      b.addEventListener('click', function (e) { e.stopPropagation(); alternaPausa(); });
      topo.appendChild(b);
    });
  }

  function partePalavras(el, texto) {
    el.textContent = '';
    texto.trim().split(/\s+/).forEach(function (w, k) {
      if (k) el.appendChild(document.createTextNode(' '));
      var s = document.createElement('span');
      s.className = 'palavra';
      s.textContent = w;
      el.appendChild(s);
    });
    return el.querySelectorAll('.palavra');
  }

  /* ── Controle de animações ativas ── */
  var ativos = [];
  var restaurar = [];
  var vez = 0;
  var story = null;
  function guarda(c) { if (c) ativos.push(c); return c; }
  function quandoAcabar(c, fn) {
    var pr = c && (c.finished || c);
    if (pr && typeof pr.then === 'function') pr.then(fn, function () {});
  }
  function paraTudo() {
    ativos.forEach(function (c) { try { c.stop(); } catch (e) {} });
    ativos = [];
    restaurar.forEach(function (fn) { try { fn(); } catch (e) {} });
    restaurar = [];
    story = null;
  }
  function inicial(els, props) {
    Array.prototype.forEach.call(els, function (el) { for (var k in props) el.style[k] = props[k]; });
  }

  /* 2 · fita da marca na capa */
  function fita(tela) {
    var path = tela.querySelector('.fita path');
    if (!path) return;
    var len = 1200;
    try { len = Math.ceil(path.getTotalLength()) || len; } catch (e) {}
    path.style.strokeDasharray = len + ' ' + len;
    path.style.strokeDashoffset = String(len);
    guarda(M.animate(path, { strokeDashoffset: [len, 0] }, { duration: 1.0, ease: [0.65, 0, 0.35, 1] }));
  }

  /* 3 · título cinético */
  function tituloCinetico(tela) {
    var ps = tela.querySelectorAll('h1 .palavra');
    if (!ps.length) return;
    inicial(ps, { opacity: '0', transform: 'scale(1.4)' });
    guarda(M.animate(ps, { opacity: [0, 1], transform: ['scale(1.4)', 'scale(1)'] },
      { duration: 0.5, delay: M.stagger(0.08, { startDelay: 0.15 }), ease: EASE }));
  }

  /* 4 · contagem de número (pt-BR); o valor final é o texto original */
  var RE_NUM = /^(\D*?)(\d{1,3}(?:\.\d{3})+|\d+)(,\d+)?(\D*)$/;
  function contagem(tela) {
    tela.querySelectorAll('.num, .valor').forEach(function (el) {
      if (el.classList.contains('valor--off')) return;
      var no = null;
      for (var k = 0; k < el.childNodes.length; k++) {
        var n = el.childNodes[k];
        if (n.nodeType === 3 && /\d/.test(n.nodeValue)) { no = n; break; }
      }
      if (!no) return;
      if (no.__orig == null) no.__orig = no.nodeValue;
      var orig = no.__orig;
      var m = orig.match(RE_NUM);
      if (!m) return;
      var casas = m[3] ? m[3].length - 1 : 0;
      var alvo = parseFloat(m[2].replace(/\./g, '') + (m[3] ? '.' + m[3].slice(1) : ''));
      var fmt = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
      var escreve = function (v) { no.nodeValue = m[1] + fmt.format(casas ? v : Math.round(v)) + m[4]; };
      escreve(0);
      restaurar.push(function () { no.nodeValue = orig; });
      guarda(M.animate(0, alvo, {
        duration: 1.2, ease: 'easeOut',
        onUpdate: escreve,
        onComplete: function () { no.nodeValue = orig; }
      }));
    });
  }

  /* 5 · barras crescem da base; a maior cai por último e acende no destaque */
  function grafico(tela) {
    var caixa = tela.querySelector('.grafico .barras');
    if (!caixa) return;
    var todas = Array.prototype.slice.call(caixa.children);
    var maior = caixa.querySelector('.maior');
    var ordem = todas.filter(function (b) { return b !== maior; });
    if (maior) ordem.push(maior);
    caixa.classList.add('animando');
    if (maior) maior.classList.remove('acesa');
    inicial(ordem, { transform: 'scaleY(0)' });
    var minha = vez;
    var a = guarda(M.animate(ordem, { transform: ['scaleY(0)', 'scaleY(1)'] },
      { duration: 0.5, delay: M.stagger(0.05, { startDelay: 0.25 }), ease: EASE }));
    restaurar.push(function () { caixa.classList.remove('animando'); });
    quandoAcabar(a, function () { if (minha === vez && maior) maior.classList.add('acesa'); });
    /* frase de comparação: entra depois das barras, se existir na tela */
    var frase = tela.querySelector('[data-comparacao]');
    if (frase) {
      inicial([frase], { opacity: '0' });
      guarda(M.animate(frase, { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0px)'] },
        { duration: 0.4, delay: 0.25 + ordem.length * 0.05 + 0.5, ease: EASE }));
    }
  }

  /* 6 · listas em cascata */
  function cascata(itens) {
    if (!itens.length) return;
    inicial(itens, { opacity: '0', transform: 'translateY(12px)' });
    guarda(M.animate(itens, { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0px)'] },
      { duration: 0.4, delay: M.stagger(0.06, { startDelay: 0.15 }), ease: EASE }));
  }

  /* 8 · t04: "Lendo a Meta" → "Lendo o Google" → "Montando sua retrospectiva" */
  function leitura(tela) {
    var el = tela.querySelector('[data-leitura]');
    if (!el) return;
    var linhas = el.getAttribute('data-leitura').split('|');
    var minha = vez;
    var j = 0;
    function passo() {
      if (minha !== vez) return;
      var ps = partePalavras(el, linhas[j]);
      inicial(ps, { opacity: '0', transform: 'translateY(24px)' });
      var a = guarda(M.animate(ps, { opacity: [0, 1], transform: ['translateY(24px)', 'translateY(0px)'] },
        { duration: 0.35, delay: M.stagger(0.08), ease: EASE }));
      if (j === linhas.length - 1) return;
      quandoAcabar(a, function () {
        if (minha !== vez) return;
        var tm = setTimeout(function () {
          if (minha !== vez) return;
          var s = guarda(M.animate(ps, { opacity: [1, 0], transform: ['translateY(0px)', 'translateY(-16px)'] },
            { duration: 0.22, ease: 'easeIn' }));
          quandoAcabar(s, function () { j++; passo(); });
        }, 700);
        restaurar.push(function () { clearTimeout(tm); });
      });
    }
    passo();
  }

  /* 1 · autoplay de story (6 s), segurar pausa */
  function autoplay(i, ctx) {
    var barra = ctx.barras[i];
    if (!barra) return;
    var enche = barra.querySelector('b') || barra.appendChild(document.createElement('b'));
    barra.classList.add('enchendo');
    enche.style.transform = 'scaleX(0)';
    var minha = vez;
    story = guarda(M.animate(enche, { transform: ['scaleX(0)', 'scaleX(1)'] }, { duration: DURACAO_STORY, ease: 'linear' }));
    /* rodada 6: pausa ligada vale também ao trocar de tela */
    if (pausado) { try { story.pause(); } catch (e) {} }
    storyFim = false;
    /* só avança dentro da retrospectiva; na última tela dela (t-caminho) a barra enche e para */
    var prox = document.querySelectorAll('section.tela')[i + 1];
    quandoAcabar(story, function () {
      if (minha !== vez) return;
      storyFim = true; /* rodada 6: barra cheia não recomeça ao retomar */
      if (prox && STORY[prox.id]) ctx.ir(i + 1);
    });
  }

  /* rodada 6: liga/desliga a pausa e atualiza todos os botões .pausa */
  function alternaPausa() {
    pausado = !pausado;
    var rotulo = pausado ? 'Continuar' : 'Pausar';
    Array.prototype.forEach.call(document.querySelectorAll('.pausa'), function (b) {
      b.setAttribute('aria-pressed', pausado ? 'true' : 'false');
      b.setAttribute('aria-label', rotulo);
    });
    try { if (story && !storyFim) { if (pausado) story.pause(); else story.play(); } } catch (e) {}
  }

  /* rodada 6: espaço alterna a pausa, só numa tela da retrospectiva */
  if (M && !reduzido) {
    document.addEventListener('keydown', function (e) {
      if (e.key !== ' ') return;
      var ativa = document.querySelector('section.tela.ativa');
      if (!ativa || !STORY[ativa.id]) return;
      /* foco num controle: deixa o espaço com ele (no próprio .pausa o clique nativo já alterna) */
      if (e.target.closest && e.target.closest('button, a, label, input, select, textarea')) return;
      e.preventDefault();
      if (e.repeat) return;
      alternaPausa();
    });
  }

  var celular = document.getElementById('celular');
  var inicioToque = 0;
  var segurando = false;
  if (celular && M && !reduzido) {
    celular.addEventListener('pointerdown', function (e) {
      /* rodada 6: toque no botão de pausa não é "segurar"; zera o relógio para o clique dele passar */
      if (e.target.closest && e.target.closest('.pausa')) { inicioToque = 0; return; }
      if (!story) return;
      inicioToque = Date.now();
      segurando = true;
      try { story.pause(); } catch (e2) {}
    });
    var solta = function () {
      if (!segurando) return;
      segurando = false;
      /* rodada 6: com a pausa ligada, soltar não retoma */
      try { if (story && !pausado && !storyFim) story.play(); } catch (e) {}
    };
    celular.addEventListener('pointerup', solta);
    celular.addEventListener('pointercancel', solta);
    celular.addEventListener('pointerleave', solta);
    /* segurar não conta como toque de navegação */
    celular.addEventListener('click', function (e) {
      if (inicioToque && Date.now() - inicioToque > 300) { e.stopImmediatePropagation(); e.preventDefault(); }
      inicioToque = 0;
    }, true);
  }

  function estadoFinal(tela) {
    var el = tela.querySelector('[data-leitura]');
    if (el) { var l = el.getAttribute('data-leitura').split('|'); el.textContent = l[l.length - 1]; }
  }

  /* rodada 7 · rede de segurança: se o navegador segurar as animações (prévia embutida, aba em segundo plano,
     economia de energia), em 4,5 s tudo o que é da tela vai ao estado final. A barra da story fica de fora. */
  var rede = null;
  function redeDeSeguranca(tela) {
    clearTimeout(rede);
    var minha = vez;
    rede = setTimeout(function () {
      if (minha !== vez || !document.getAnimations) return;
      document.getAnimations().forEach(function (a) {
        var alvo = a.effect && a.effect.target;
        if (!alvo || !tela.contains(alvo) || a.playState === 'finished') return;
        try { a.finish(); } catch (e) {}
      });
    }, 4500);
  }

  /* 9 · roda de novo cada vez que a tela fica ativa */
  function aoMostrar(tela, i, ctx) {
    vez++;
    paraTudo();
    redeDeSeguranca(tela);
    segurando = false;
    for (var k = 0; k < ctx.barras.length; k++) ctx.barras[k].classList.remove('enchendo');
    /* rodada 4: t02/t04/t06 ganham comportamento próprio em status-mark.js (window.TelasR4) */
    if (window.TelasR4) window.TelasR4.aoMostrar(tela, i, ctx);
    /* rodada 5: gráficos animados das telas novas (t-horario, t-caminho) em telas-r5.js */
    if (window.TelasR5) window.TelasR5.aoMostrar(tela, i, ctx);
    if (!M || reduzido) { estadoFinal(tela); return; }
    var id = tela.id;
    if (id === 't02') cascata(tela.querySelectorAll('.opcao'));
    if (id === 't04') leitura(tela);
    if (id === 't05') { fita(tela); tituloCinetico(tela); }
    if (id === 't06') { contagem(tela); cascata(tela.querySelectorAll('.checagem')); }
    if (id === 't07') { contagem(tela); grafico(tela); }
    if (id === 't08') contagem(tela);
    if (STORY[id]) autoplay(i, ctx);
  }

  /* rodada 4: tocar num controle (filtro, cartão) pausa o autoplay da story */
  function pausaStory() { try { if (story) story.pause(); } catch (e) {} }
  window.RetroMotion = { aoMostrar: aoMostrar, reduzido: reduzido, pausaStory: pausaStory };
})();
