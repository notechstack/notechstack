/* Venexia — protótipo Pacote 1: menu, revelação ao rolar, contadores, abas de produto e formulário. */
(function () {
  window.vxReady = true;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Menu do celular */
  var burger = document.querySelector('.burger'), nav = document.getElementById('nav');
  burger.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    burger.setAttribute('aria-expanded', open);
  });
  nav.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') { nav.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); }
  });

  /* Contadores */
  function fmt(n, el) { return el.dataset.fmt === 'pt' ? n.toLocaleString('pt-BR') : String(n); }
  function count(el) {
    if (el.dataset.done) return; el.dataset.done = '1';
    var end = +el.dataset.count;
    if (reduce) { el.textContent = fmt(end, el); return; }
    var t0 = null, dur = 1400;
    function step(t) {
      if (!t0) t0 = t;
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(Math.round(end * e), el);
      if (p < 1) requestAnimationFrame(step);
    }
    el.textContent = '0';
    requestAnimationFrame(step);
  }

  /* Revelação ao rolar (o root implícito considera o recorte do iframe no painel) */
  var targets = document.querySelectorAll('.rv, [data-count]');
  function show(el) {
    el.classList.add('in');
    if (el.classList.contains('rv')) setTimeout(function () { el.classList.add('done'); }, 1800);
    if (el.dataset.count) count(el);
    el.querySelectorAll && el.querySelectorAll('[data-count]').forEach(count);
  }
  if (!('IntersectionObserver' in window) || reduce) {
    targets.forEach(show);
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { show(en.target); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    targets.forEach(function (el) { io.observe(el); });
    /* rede de segurança: nada fica invisível se o observador não disparar */
    setTimeout(function () {
      document.querySelectorAll('.rv:not(.in)').forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.bottom < 0) show(el);
      });
    }, 4000);
  }

  /* Abas de produto com troca automática até a primeira interação */
  var tabs = [].slice.call(document.querySelectorAll('.tabs [role=tab]'));
  var stage = document.querySelector('.stage'), timer = null, idx = 0, AUTO = 6000;
  function select(i, user) {
    idx = (i + tabs.length) % tabs.length;
    tabs.forEach(function (t, k) {
      var on = k === idx, p = document.getElementById(t.getAttribute('aria-controls'));
      t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
      if (on) { p.classList.add('is-on'); p.removeAttribute('aria-hidden'); p.inert = false; p.querySelectorAll('[data-count]').forEach(function (c) { delete c.dataset.done; count(c); }); }
      else { p.classList.remove('is-on'); p.setAttribute('aria-hidden', 'true'); p.inert = true; }
    });
    if (user) stopAuto();
    else restartBar();
  }
  function restartBar() {
    stage.classList.remove('run'); void stage.offsetWidth; stage.classList.add('run');
  }
  function stopAuto() { clearInterval(timer); timer = null; stage.classList.remove('run'); stage.classList.add('stopped'); }
  tabs.forEach(function (t, k) {
    t.addEventListener('click', function () { select(k, true); });
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault(); select(idx + (e.key === 'ArrowRight' ? 1 : -1), true); tabs[idx].focus();
      }
    });
  });
  if (!reduce && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (en) {
      if (en[0].isIntersecting && !timer && !stage.classList.contains('stopped')) {
        restartBar();
        timer = setInterval(function () { select(idx + 1, false); }, AUTO);
      } else if (!en[0].isIntersecting && timer) { clearInterval(timer); timer = null; stage.classList.remove('run'); }
    }, { threshold: 0.4 }).observe(stage);
  }

  /* Formulário (protótipo: nada é enviado) */
  var f = document.getElementById('form'), note = document.getElementById('form-note');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!f.nome.value.trim() || !/.+@.+\..+/.test(f.email.value)) {
      note.textContent = 'Preencha nome e um e-mail válido.'; note.className = 'form-note err'; return;
    }
    note.textContent = 'Obrigado, ' + f.nome.value.trim().split(' ')[0] + '! Um consultor Venexia vai falar com você. (Protótipo: nada foi enviado.)';
    note.className = 'form-note ok'; f.reset();
  });
})();
