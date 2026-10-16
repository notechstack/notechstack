/* nó.agentes · movimento das leituras do agente (#t07, #t08). Rodada 4.
   As barras de recorte crescem quando entram na área visível da tela (a tela rola).
   Usa window.Motion local; com prefers-reduced-motion mostra o estado final. */
(function () {
  'use strict';
  var M = window.Motion;
  var reduzido = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!M || reduzido || !('IntersectionObserver' in window)) return;
  var EASE = [0.22, 1, 0.36, 1];

  function anima(bloco) {
    var barras = bloco.querySelectorAll('.recorte .trilho i, .pilha-canal i, .compara .trilho i');
    if (barras.length) {
      M.animate(barras, { transform: ['scaleX(0)', 'scaleX(1)'] },
        { duration: 0.7, delay: M.stagger(0.07, { startDelay: 0.1 }), ease: EASE });
    }
    M.animate(bloco, { opacity: [0, 1], transform: ['translateY(14px)', 'translateY(0px)'] }, { duration: 0.45, ease: EASE });
  }

  ['t07', 't08'].forEach(function (id) {
    var tela = document.getElementById(id);
    if (!tela) return;
    var blocos = tela.querySelectorAll('.leituras .cartao');
    var obs = new IntersectionObserver(function (entradas) {
      entradas.forEach(function (e) {
        if (!e.isIntersecting || e.target.__lido) return;
        e.target.__lido = true;
        anima(e.target);
      });
    }, { root: tela, threshold: 0.35 });
    blocos.forEach(function (b) { obs.observe(b); });
    /* cada vez que a tela volta a ficar ativa, as barras animam de novo */
    new MutationObserver(function () {
      if (!tela.classList.contains('ativa')) return;
      blocos.forEach(function (b) { b.__lido = false; obs.unobserve(b); obs.observe(b); });
    }).observe(tela, { attributes: true, attributeFilter: ['class'] });
  });
})();
