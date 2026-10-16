/* nó.agentes · movimento das telas especiais da rodada 5 (#t-horario, #t-caminho).
   Gancho: no fim de mostrar(i) do index.html,
     if (window.TelasR5) window.TelasR5.aoMostrar(telas[atual]);
   Usa window.Motion local (shared/vendor/motion-14.3.0.js). O estado final é o padrão do CSS:
   sem Motion ou com prefers-reduced-motion não faz nada e o gráfico aparece completo.
   A cada chamada cancela o que estava rodando e devolve os números ao valor final. */
(function () {
  'use strict';
  var EASE = [0.22, 1, 0.36, 1];
  var COLS = 6;
  var rodando = [];

  function reduzido() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function guarda(c) { if (c) rodando.push(c); return c; }
  function fmt(v, sufixo) { return Math.round(v).toLocaleString('pt-BR') + (sufixo || ''); }

  function cancelaTudo() {
    rodando.forEach(function (c) { try { c.cancel ? c.cancel() : c.stop && c.stop(); } catch (e) {} });
    rodando = [];
    /* números voltam ao valor final (o CSS/HTML é a verdade) */
    document.querySelectorAll('#t-caminho .degrau__valor[data-alvo]').forEach(function (el) {
      el.textContent = fmt(+el.getAttribute('data-alvo'), el.getAttribute('data-sufixo'));
    });
    document.querySelectorAll('[data-nota]').forEach(function (el) { el.textContent = fmtNota(+el.getAttribute('data-nota')); });
  }

  /* rodada 6 · capa: nota de 0 a 10 conta até o valor e o trilho enche junto (até 2 casas, ex. 9,75) */
  function fmtNota(v) { return v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }); }
  function nota(tela, M) {
    var el = tela.querySelector('[data-nota]');
    var trilho = tela.querySelector('.nota__trilho i');
    if (!el) return;
    var alvo = +el.getAttribute('data-nota');
    var casas = (String(alvo).split('.')[1] || '').length;
    el.textContent = '0';
    guarda(M.animate(0, alvo, {
      duration: 1.4, delay: 0.3, ease: EASE,
      onUpdate: function (v) { el.textContent = v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }); },
      onComplete: function () { el.textContent = fmtNota(alvo); }
    }));
    if (trilho) guarda(M.animate(trilho, { transform: ['scaleX(0)', 'scaleX(1)'] }, { duration: 1.4, delay: 0.3, ease: EASE }));
  }

  function horario(tela, M) {
    var celulas = Array.prototype.slice.call(tela.querySelectorAll('.hm i'));
    var picos = tela.querySelectorAll('.hm i.pico');
    var rotulo = tela.querySelector('.hm__pico');
    var passo = 0.045, dur = 0.4, pulso = 0.55;
    function atraso(k) { return 0.15 + ((k / COLS | 0) + (k % COLS)) * passo; } /* onda diagonal: linha + coluna */
    var fimOnda = celulas.length ? atraso(celulas.length - 1) + dur : 0;
    var p = 0;
    celulas.forEach(function (c, k) {
      var d = atraso(k);
      if (!c.classList.contains('pico')) {
        guarda(M.animate(c, { opacity: [0, 1], transform: ['scale(0.55)', 'scale(1)'] }, { duration: dur, delay: d, ease: EASE }));
        return;
      }
      /* pico: entra na onda e, depois que a onda termina, pulsa uma vez (uma animação só de transform) */
      var ini = fimOnda + 0.05 + (p++) * 0.06;
      var total = ini + pulso - d;
      guarda(M.animate(c, { opacity: [0, 1] }, { duration: dur, delay: d, ease: EASE }));
      guarda(M.animate(c, { transform: ['scale(0.55)', 'scale(1)', 'scale(1)', 'scale(1.16)', 'scale(1)'] }, {
        duration: total, delay: d,
        times: [0, dur / total, (ini - d) / total, (ini - d + pulso / 2) / total, 1],
        ease: ['easeOut', 'linear', 'easeInOut', 'easeInOut']
      }));
    });
    if (rotulo) {
      guarda(M.animate(rotulo, { opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0px)'] },
        { duration: 0.4, delay: fimOnda + 0.45, ease: EASE }));
    }
    var barras = tela.querySelectorAll('.gasto-clique .trilho i');
    if (barras.length) {
      guarda(M.animate(barras, { transform: ['scaleX(0)', 'scaleX(1)'] },
        { duration: 0.7, delay: M.stagger(0.12, { startDelay: fimOnda + 0.3 }), ease: EASE }));
    }
  }

  function caminho(tela, M) {
    var degraus = Array.prototype.slice.call(tela.querySelectorAll('.degrau'));
    var passo = 0.32;
    var fim = 0.2 + degraus.length * passo + 0.4;
    degraus.forEach(function (dg, k) {
      var d = 0.2 + k * passo;
      var barra = dg.querySelector('.degrau__barra');
      var valor = dg.querySelector('.degrau__valor[data-alvo]');
      var fantasma = dg.querySelector('.degrau__fantasma');
      if (barra) guarda(M.animate(barra, { transform: ['scaleX(0)', 'scaleX(1)'] }, { duration: 0.7, delay: d, ease: EASE }));
      if (fantasma) guarda(M.animate(fantasma, { opacity: [0, 1] }, { duration: 0.35, delay: d + 0.45, ease: EASE }));
      if (valor) {
        var alvo = +valor.getAttribute('data-alvo');
        var suf = valor.getAttribute('data-sufixo');
        valor.textContent = fmt(0, suf);
        guarda(M.animate(0, alvo, {
          duration: 0.8, delay: d, ease: EASE,
          onUpdate: function (v) { valor.textContent = fmt(v, suf); },
          onComplete: function () { valor.textContent = fmt(alvo, suf); }
        }));
      }
    });
    var perda = tela.querySelector('.perda');
    if (perda) {
      guarda(M.animate(perda, { opacity: [0, 1], transform: ['translateY(-4px) scale(0.96)', 'translateY(0px) scale(1)'] },
        { duration: 0.45, delay: fim, ease: EASE }));
    }
  }

  window.TelasR5 = {
    aoMostrar: function (tela) {
      cancelaTudo();
      var M = window.Motion;
      if (!tela || !M || !M.animate || reduzido()) return;
      if (tela.id === 't05') nota(tela, M);
      else if (tela.id === 't-horario') horario(tela, M);
      else if (tela.id === 't-caminho') caminho(tela, M);
    }
  };
})();
