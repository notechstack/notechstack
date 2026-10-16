/* Auditor de Integridade de Marketing: fluxo URL -> diagnóstico -> retrospectiva (planos e checkout só no fim dela). Contrato v1. */
(function () {
  'use strict';
  var SUPABASE_BASE = 'https://sdeowbqmwkwseyktyemn.supabase.co'; // mesma base de shared/telemetria.js
  var ENDPOINT = SUPABASE_BASE + '/functions/v1/diagnostico-auditor';
  var APP_URL = 'https://app.notechstack.com.br/';
  var CONSENT_KEY = 'no_auditor_consent';
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (isLocal) {
    var custom = new URLSearchParams(location.search).get('endpoint');
    if (custom) ENDPOINT = custom;
  }

  /* Fundo de relevo animado na página inteira (pedido do Lucca): azul da marca, opacidade baixa para não competir com o texto. */
  var relevo = document.getElementById('au-relevo');
  if (relevo && window.NoTopography) {
    var azul = getComputedStyle(document.documentElement).getPropertyValue('--no-agentes-azul').trim() || '#2F56E5';
    var celular = window.matchMedia('(max-width: 699px)').matches;
    /* Topography completo do React Bits (porte em /shared/topography.js), em tinta sobre osso (lightMode) no azul nó.agentes.
       Celular: menos linhas, dpr 1,5 e sem reação ao dedo (rolar não mexe no relevo; toque ainda solta o pulso). */
    window.NoTopography.mount(relevo, {
      color: azul, lightMode: true, opacity: celular ? 0.26 : 0.55,
      lineCount: celular ? 16 : 22, lineWidth: 1.2, elevation: 1, foreground: 0.2, tilt: 32,
      speed: 0.25, direction: 'forward', glow: celular ? 0.6 : 0.8, depthOfField: celular ? 0 : 0.15, fog: celular ? 0.35 : 0.2,
      mouseInteraction: !celular, hoverEffect: 'lift', clickEffect: 'pulse', dpr: celular ? 1.5 : undefined
    });
  }

  /* Cards do "O que o auditor confere" e passos do "Como funciona": entram em sequência quando a lista aparece
     (.is-espera no carregamento, .is-animar na primeira vez que entra na tela, uma lista por vez). Sem observador
     ou com movimento reduzido, ficam como estão (visíveis). */
  var animados = document.querySelectorAll('.au-cards, .au-fluxo');
  if (animados.length && 'IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var obs = new IntersectionObserver(function (itens) {
      itens.forEach(function (it) { if (it.isIntersecting) { it.target.classList.add('is-animar'); obs.unobserve(it.target); } });
    }, { threshold: 0.2 });
    animados.forEach(function (el) { el.classList.add('is-espera'); obs.observe(el); });
  }

  var form = document.getElementById('au-form');
  var input = document.getElementById('au-url');
  var submit = document.getElementById('au-submit');
  var erro = document.getElementById('au-erro');
  var estado = document.getElementById('au-estado');
  var btnGrant = document.getElementById('au-consent-grant');
  var btnDeny = document.getElementById('au-consent-deny');
  var cookies = document.getElementById('au-cookies');
  var btnsPrefs = document.querySelectorAll('[data-consent-prefs]');
  var estadoConsent = document.getElementById('au-consent-estado');
  if (!form || !input || !estado) return;

  /* ---------- utilidades ---------- */
  function cookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function dl(obj) { window.dataLayer = window.dataLayer || []; window.dataLayer.push(obj); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }
  function utmFromUrl() {
    var q = new URLSearchParams(location.search), out = {};
    ['source', 'medium', 'campaign', 'content', 'term'].forEach(function (k) { out[k] = q.get('utm_' + k) || ''; });
    return out;
  }
  function gaClientId() {
    var ga = cookie('_ga'); // GA1.1.X.Y -> X.Y
    var parts = ga.split('.');
    return parts.length >= 4 ? parts.slice(2).join('.') : '';
  }
  function fbcValue(fbclid) {
    var c = cookie('_fbc');
    if (c) return c;
    if (fbclid) return 'fb.1.' + Date.now() + '.' + fbclid;
    return '';
  }
  function cadastroUrl() {
    var u = new URL(APP_URL);
    var q = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid'].forEach(function (k) { var v = q.get(k); if (v) u.searchParams.set(k, v); });
    u.searchParams.set('origem', 'auditor');
    return u.toString();
  }

  /* ---------- consentimento LGPD (padrão: recusado) ---------- */
  function consent() { try { return localStorage.getItem(CONSENT_KEY) === 'granted' ? 'granted' : 'denied'; } catch (e) { return 'denied'; } }
  /* O padrão (default) é definido no <head>, antes do GTM. Aqui só a escolha da pessoa vira update,
     e o evento consentimento_atualizado deixa o GTM disparar o pixel para quem aceita depois de carregar. */
  function applyConsent(value, persist) {
    var granted = value === 'granted';
    if (persist) { try { localStorage.setItem(CONSENT_KEY, value); } catch (e) {} }
    window.dataLayer = window.dataLayer || [];
    if (typeof window.gtag !== 'function') { window.gtag = function () { window.dataLayer.push(arguments); }; }
    var mode = granted ? 'granted' : 'denied';
    window.gtag('consent', 'update', { ad_storage: mode, ad_user_data: mode, ad_personalization: mode, analytics_storage: mode });
    if (typeof window.fbq === 'function') window.fbq('consent', granted ? 'grant' : 'revoke');
    if (estadoConsent) estadoConsent.textContent = granted ? 'permitida' : 'recusada';
    if (granted) { if (typeof window.noTelemetriaLiberar === 'function') window.noTelemetriaLiberar(); }
    else if (persist) apagarCookiesMedicao();
  }
  /* Revogar apaga os cookies de medição já gravados (_fbp, _fbc, _ga, _ga_*, _gcl_*) no host e no domínio pai. */
  function apagarCookiesMedicao() {
    var host = location.hostname, partes = host.split('.'), dominios = ['', host];
    for (var i = 1; i < partes.length - 1; i++) dominios.push('.' + partes.slice(i).join('.'));
    document.cookie.split(';').forEach(function (par) {
      var nome = par.split('=')[0].trim();
      if (!/^(_fbp|_fbc|_ga|_ga_.+|_gcl_.+)$/.test(nome)) return;
      dominios.forEach(function (d) {
        document.cookie = nome + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : '');
      });
    });
  }
  /* pop-up de cookies (#au-cookies): aria-modal="false", não bloqueia a página.
     Abre sozinho quando não há escolha salva; fecha com a escolha; Esc fecha sem salvar (continua recusado).
     Foco: ao abrir sozinho no carregamento NÃO rouba o foco (é não modal); só quando a pessoa clica em
     "Preferências de cookies" (devolverFoco=true) o foco vai para o pop-up e volta ao botão ao fechar. */
  var focoAnterior = null;
  function abrirCookies(devolverFoco) {
    if (!cookies) return;
    focoAnterior = devolverFoco ? document.activeElement : null;
    cookies.hidden = false;
    if (devolverFoco && btnGrant) btnGrant.focus({ preventScroll: true });
  }
  function fecharCookies() {
    if (!cookies || cookies.hidden) return;
    cookies.hidden = true;
    if (focoAnterior && typeof focoAnterior.focus === 'function') focoAnterior.focus({ preventScroll: true });
    focoAnterior = null;
  }
  var stored = null; try { stored = localStorage.getItem(CONSENT_KEY); } catch (e) {}
  applyConsent(stored === 'granted' ? 'granted' : 'denied', !!stored);
  if (!stored) abrirCookies(false);
  function escolher(v) { applyConsent(v, true); dl({ event: 'consentimento_atualizado', consentimento_medicao: v }); fecharCookies(); }
  if (btnGrant) btnGrant.addEventListener('click', function () { escolher('granted'); });
  if (btnDeny) btnDeny.addEventListener('click', function () { escolher('denied'); });
  /* Preferências de cookies: controle permanente (sob o formulário e no FAQ) para mudar ou revogar a escolha. */
  Array.prototype.forEach.call(btnsPrefs, function (b) { b.addEventListener('click', function () { abrirCookies(true); }); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && cookies && !cookies.hidden) { ev.preventDefault(); fecharCookies(); }
  });

  /* ---------- estados de tela ---------- */
  function render(html, busy) {
    estado.setAttribute('aria-busy', busy ? 'true' : 'false');
    estado.innerHTML = html;
    if (!busy) estado.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function ctaCadastro(texto) {
    return '<a class="ag-btn ag-btn--primario" href="' + esc(cadastroUrl()) + '">' + esc(texto || 'Criar minha conta') + '</a>';
  }
  var LABEL = { ok: 'OK', atencao: 'Atenção', problema: 'Problema', nao_verificavel: 'Não verificável' };

  /* Logo depois da URL, a pessoa segue para a retrospectiva (Lucca, 16/10): o diagnóstico vai no sessionStorage
     (chave lida por retrospectiva/diagnostico-real.js) e os utm_* e o fbclid seguem na query. Os preços e o
     checkout ficam só no fim da retrospectiva; esta página continua sem eles. Sem sessionStorage, o
     relatório aparece aqui mesmo, como antes. */
  var RETRO_KEY = 'no_auditor_diagnostico';
  function retrospectivaUrl() {
    var base = location.pathname.replace(/index\.html$/, '');
    if (!/\/$/.test(base)) base += '/';
    var u = new URL(base + 'retrospectiva/', location.origin);
    var q = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid'].forEach(function (k) { var v = q.get(k); if (v) u.searchParams.set(k, v); });
    u.hash = 't01';
    return u.toString();
  }
  function guardarDiagnostico(data) {
    try {
      sessionStorage.setItem(RETRO_KEY, JSON.stringify({ v: 1, salvo_em: Date.now(), cache: !!data.cache, report: data.report || {} }));
      return sessionStorage.getItem(RETRO_KEY) !== null;
    } catch (e) { return false; }
  }

  function renderReport(data) {
    var r = data.report || {}, s = r.resumo || {}, checagens = r.checagens || [];
    var resumo = ['ok', 'atencao', 'problema', 'nao_verificavel'].map(function (k) {
      return '<li class="is-' + k + '"><b>' + esc(s[k] != null ? s[k] : 0) + '</b><span>' + LABEL[k] + '</span></li>';
    }).join('');
    var lista = checagens.map(function (c) {
      var st = LABEL[c.status] ? c.status : 'nao_verificavel';
      return '<li><details><summary><span class="au-status is-' + st + '" aria-hidden="true"></span><span class="au-sr">' + LABEL[st] + ': </span>' + esc(c.titulo) + '</summary>' +
        '<div class="au-det">' + esc(c.evidencia) + (c.recomendacao ? '<b>Recomendação</b>' + esc(c.recomendacao) : '') + '</div></details></li>';
    }).join('');
    var gerado = r.gerado_em ? new Date(r.gerado_em) : null;
    var geradoTxt = gerado && !isNaN(gerado) ? gerado.toLocaleString('pt-BR') : '';
    render(
      '<div class="au-box au-box--relatorio">' +
      (data.cache ? '<span class="au-cache">Resultado das últimas 24h</span>' : '') +
      '<h2>Diagnóstico inicial pronto</h2>' +
      '<p class="au-meta">' + esc(r.url || '') + (geradoTxt ? ' · gerado em ' + esc(geradoTxt) : '') + '</p>' +
      '<ul class="au-resumo">' + resumo + '</ul>' +
      '<ul class="au-checagens">' + lista + '</ul>' +
      '<div class="au-fundo"><h3>Quer ir mais fundo? Conecte Meta e Google</h3><p>Eventos pelo servidor e o que roda dentro do GTM só aparecem com as contas conectadas: aí o auditor compara o que o site dispara com o que Meta e Google recebem.</p>' + ctaCadastro('Conectar Meta e Google') + '</div>' +
      '</div>', false);
  }
  function renderLimite(data) {
    dl({ event: 'diagnostico_limite_usuario' });
    render('<div class="au-box au-box--limite"><h2>Você já usou seus ' + esc(data.limite || 3) + ' diagnósticos gratuitos</h2><p>Crie sua conta para continuar auditando e conectar Meta e Google.</p>' + ctaCadastro('Criar minha conta') + '</div>', false);
  }
  function renderTeto() {
    dl({ event: 'diagnostico_teto_atingido' });
    render('<div class="au-box au-box--teto"><h2>Muita gente auditando hoje</h2><p>Chegamos ao teto diário de diagnósticos gratuitos. Deixe seu e-mail pela página de contato ou volte amanhã.</p><a class="ag-btn ag-btn--secundario" href="/contato/">Deixar meu e-mail</a></div>', false);
  }
  /* mesmoId: a resposta não chegou (rede), então o reenvio leva o mesmo event_id e o servidor
     não conta duas vezes. Depois de uma resposta de falha, a próxima tentativa ganha id novo. */
  function renderFalha(mesmoId) {
    dl({ event: 'diagnostico_falha' });
    render('<div class="au-box au-box--falha"><h2>Não conseguimos rodar o diagnóstico agora</h2><p>O site não respondeu ou a conexão caiu. Tente de novo em instantes.</p><button type="button" class="ag-btn ag-btn--secundario" id="au-retry">Tentar de novo</button></div>', false);
    var retry = document.getElementById('au-retry');
    if (retry) retry.addEventListener('click', function () { enviar(mesmoId); });
  }
  function renderAndamento() {
    render('<div class="au-box au-box--carregando"><h2>Ainda diagnosticando…</h2><p>Esse pedido já está rodando. Confira de novo em alguns segundos.</p><button type="button" class="ag-btn ag-btn--secundario" id="au-retry">Conferir</button></div>', false);
    var retry = document.getElementById('au-retry');
    if (retry) retry.addEventListener('click', function () { enviar(true); });
  }
  function showInputError(msg) {
    erro.textContent = msg; erro.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus();
  }
  function clearInputError() { erro.hidden = true; erro.textContent = ''; input.removeAttribute('aria-invalid'); }

  /* ---------- envio ---------- */
  var tentativa = null; // {event_id, url} — reenvio da mesma tentativa usa o MESMO id
  function normalizeUrl(raw) {
    var v = (raw || '').trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
    try { var u = new URL(v); if (!/\./.test(u.hostname)) return null; return u.toString(); } catch (e) { return null; }
  }
  function enviar(reenvio) {
    if (!reenvio) {
      var url = normalizeUrl(input.value);
      if (!url) { showInputError('Informe uma URL válida, por exemplo https://www.suaempresa.com.br'); return; }
      clearInputError();
      tentativa = { event_id: 'diag_' + uuid(), url: url };
    }
    if (!tentativa) return;
    var q = new URLSearchParams(location.search);
    var fbclid = q.get('fbclid') || '';
    /* LGPD: sem consentimento, nenhum identificador de anúncio sai do navegador */
    var ok = consent() === 'granted';
    var payload = {
      v: 1,
      url: tentativa.url,
      event_id: tentativa.event_id,
      consent: ok ? 'granted' : 'denied',
      fbp: ok ? cookie('_fbp') : '',
      fbc: ok ? fbcValue(fbclid) : '',
      fbclid: ok ? fbclid : '',
      ga_client_id: ok ? gaClientId() : '',
      utm: utmFromUrl(),
      page_url: ok ? location.href : location.origin + location.pathname
    };
    submit.disabled = true;
    render('<div class="au-box au-box--carregando"><h2>Diagnosticando…</h2><p>Lendo o site e conferindo pixel, GA4 e consentimento. Leva alguns segundos.</p></div>', true);
    dl({ event: 'diagnostico_solicitado' });

    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) {
        return res.text().then(function (txt) {
          var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
          return { status: res.status, data: data || {} };
        });
      })
      .then(function (r) {
        submit.disabled = false;
        if (r.status === 200 && r.data.status === 'entregue') {
          /* duplicado: o servidor já contou este event_id; não dispara de novo */
          var pixel = !r.data.duplicado && payload.consent === 'granted' && typeof window.fbq === 'function';
          if (pixel) window.fbq('trackCustom', 'DiagnosticoEntregue', {}, { eventID: r.data.event_id || tentativa.event_id });
          if (guardarDiagnostico(r.data)) {
            render('<div class="au-box au-box--carregando"><h2>Diagnóstico pronto</h2><p>Abrindo o seu relatório…</p></div>', true);
            submit.disabled = true;
            /* folga para o pixel sair antes de trocar de página */
            setTimeout(function () { location.assign(retrospectivaUrl()); }, pixel ? 400 : 0);
            return;
          }
          renderReport(r.data);
          return;
        }
        if (r.status === 400) { estado.innerHTML = ''; showInputError('URL inválida. Confira o endereço e tente de novo.'); return; }
        if (r.status === 409) { renderAndamento(); return; }
        if (r.status === 429) { renderLimite(r.data); return; }
        if (r.status === 503) { renderTeto(); return; }
        tentativa = null;
        renderFalha(false);
      })
      .catch(function () { submit.disabled = false; renderFalha(true); });
  }
  form.addEventListener('submit', function (ev) { ev.preventDefault(); enviar(false); });
  /* Voltar da retrospectiva pelo navegador (página restaurada do cache): a LP volta a aceitar outra URL. */
  window.addEventListener('pageshow', function (ev) {
    if (!ev.persisted) return;
    submit.disabled = false; estado.setAttribute('aria-busy', 'false'); estado.innerHTML = '';
  });
  input.addEventListener('input', clearInputError);
  // Só em localhost: ?auto=<url> preenche e envia (prova visual com navegador headless).
  if (isLocal) {
    var auto = new URLSearchParams(location.search).get('auto');
    if (auto) { input.value = auto; enviar(false); }
  }
})();
