/* Telemetria do site — um ponto de saída só (dataLayer + fila do painel de
   percurso no Supabase). A home (lp-narrador/cenas-lp/lp-v8.html) também
   carrega este arquivo; o bloco inline que existia lá saiu. As LPs antigas
   (lp-v5, lp-v7, RASTREIO-lp-v5) ainda têm cópia inline própria.

   Carregar SÍNCRONO, antes do snippet do GTM: a primeira tag já quer o sid,
   e a ORIGEM (utm/gclid) só é gravada na primeira página da sessão — por
   isso ela roda em todas as páginas, não só nas que têm formulário. */
(function(){
  if (window.__noTelemetryLoaded) return;
  window.__noTelemetryLoaded = true;
  var SS; try { SS=window.sessionStorage; } catch(e) { SS={getItem:function(){return null},setItem:function(){}}; } var sid='';
  try { sid = SS.getItem('no_sid') || ''; } catch(e){}
  if (!sid){
    sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2,10);
    try { SS.setItem('no_sid', sid); } catch(e){}
  }
  window.leadSid = sid;

  /* ORIGEM: gravada na PRIMEIRA página da sessão e nunca mais tocada. Sem isto,
     quem chega por anúncio, lê os seis capítulos e só então preenche o
     formulário entrega um lead sem utm nenhum — e a campanha que pagou por ele
     fica sem crédito. */
  var orig = null;
  try { orig = JSON.parse(SS.getItem('no_orig') || 'null'); } catch(e){}
  if (!orig){
    var q = new URLSearchParams(location.search);
    orig = {
      utm_source:   q.get('utm_source')   || '',
      utm_medium:   q.get('utm_medium')   || '',
      utm_campaign: q.get('utm_campaign') || '',
      utm_content:  q.get('utm_content')  || '',
      utm_term:     q.get('utm_term')     || '',
      gclid:  q.get('gclid')  || '',
      fbclid: q.get('fbclid') || '',
      referrer: document.referrer || '(direto)'
    };
    try { SS.setItem('no_orig', JSON.stringify(orig)); } catch(e){}
  }
  if (!orig.utm_source && !orig.gclid && !orig.fbclid){
    try {
      var sourceHost = new URL(orig.referrer).hostname;
      var search = sourceHost.match(/(?:^|\.)(google|bing|duckduckgo|yahoo|ecosia)\./);
      if (search){ orig.utm_source=search[1]; orig.utm_medium='organic'; SS.setItem('no_orig',JSON.stringify(orig)); }
    } catch(e){}
  }
  window.leadOrig  = orig;
  window.leadEtapa = 0;          /* 0..5 — o quão longe esta sessão chegou */

  /* estado do caminho na árvore, mantido pelos próprios eventos: é o que a
     fila manda junto de cada lote pro banco costurar a sessão */
  window.leadEstado = { folha:null, nicho:null, caminho:null, modo:null };

  var vistos = Object.create(null);
  window.dataLayer = window.dataLayer || [];

  /* track(nome, params, chave)
     `chave` presente = evento de ETAPA: dispara uma vez só por sessão. Sem essa
     guarda o resetTerm() do scroll re-dispara diag_abrir toda vez que a pessoa
     sobe e desce a página, e o funil vira ficção. */
  window.track = function(nome, params, chave){
    if (chave){
      var k = nome + '::' + chave;
      if (vistos[k]) return;
      vistos[k] = 1;
    }
    var p = params || {};
    p.event = nome;
    p.lead_sid = sid;
    if (p.etapa > window.leadEtapa) window.leadEtapa = p.etapa;
    if (p.folha)   window.leadEstado.folha   = p.folha;
    if (p.nicho)   window.leadEstado.nicho   = p.nicho;
    if (p.caminho) window.leadEstado.caminho = p.caminho;
    if (p.modo)    window.leadEstado.modo    = p.modo;
    window.dataLayer.push(p);
    if (window.trackFila) window.trackFila(nome, p);
  };


  /* ---------- fila do painel de percurso ----------
     Um POST por clique competiria com a digitação do terminal pela banda e pelo
     main thread — a experiência é o produto ali. Acumula e manda a cada 3s, ou
     no pagehide via sendBeacon (que sobrevive ao fechamento da aba; um fetch
     comum, não). */
  var FN_TRACK = 'https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/track-evento';
  var fila = [], timer = null, mandados = 0;
  var TETO_SESSAO = 200;   /* o mesmo teto que o banco aplica: não adianta gastar
                              rede com o que a RPC vai recusar do outro lado */

  /* Página que exige consentimento (ex.: /agentes/auditor define window.noTelemetriaConsentKey):
     sem a escolha "granted" salva, nada sai do navegador. A fila fica parada; se a pessoa permitir,
     a página chama noTelemetriaLiberar() e o que estava na fila segue. Sem a chave, nada muda. */
  function permitido(){
    var k = window.noTelemetriaConsentKey;
    if (!k) return true;
    try { return localStorage.getItem(k) === 'granted'; } catch(e){ return false; }
  }

  function descarrega(beacon){
    if (timer){ clearTimeout(timer); timer = null; }
    if (!fila.length) return;
    if (!permitido()) return;
    var lote = fila.splice(0, 60);
    mandados += lote.length;
    var corpo = JSON.stringify({
      sid: sid, orig: orig,
      folha:   window.leadEstado.folha,
      nicho:   window.leadEstado.nicho,
      caminho: window.leadEstado.caminho,
      modo:    window.leadEstado.modo,
      fbp: (document.cookie.match(/_fbp=([^;]+)/) || [])[1] || null,
      fbc: (document.cookie.match(/_fbc=([^;]+)/) || [])[1] || null,
      eventos: lote
    });
    try {
      if (beacon && navigator.sendBeacon){
        navigator.sendBeacon(FN_TRACK, new Blob([corpo], { type:'text/plain' }));
      } else {
        fetch(FN_TRACK, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: corpo, keepalive: true
        }).catch(function(){});   /* medição não pode derrubar a página */
      }
    } catch(e){}
  }

  window.trackFila = function(nome, p){
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
    if (mandados + fila.length >= TETO_SESSAO) return;
    fila.push({ evento: nome, etapa: p.etapa || 0, params: p });
    if (fila.length >= 20) return descarrega(false);
    if (!timer) timer = setTimeout(function(){ descarrega(false); }, 3000);
  };
  window.noTelemetriaLiberar = function(){ descarrega(false); };
  /* pagehide e não beforeunload: o segundo não dispara no Safari do iPhone,
     que é justamente onde mais gente abandona no meio */
  addEventListener('pagehide', function(){ descarrega(true); });
  addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'hidden') descarrega(true);
  });
  track('site_visit',{pagina:location.pathname},'pagina');

  /* ---------- clique no WhatsApp ----------
     Delegado no document (capture): pega o rodapé (a.ft-whatsapp) e qualquer
     link wa.me / api.whatsapp.com, inclusive os que o componente monta depois
     do load. Sem `chave`: cada clique conta. Não chama preventDefault — a
     navegação segue; medição não pode segurar o clique. */
  var RE_WA = /^(?:https?:)?\/\/(?:www\.)?(?:wa\.me|api\.whatsapp\.com)(?:[\/?#]|$)/i;
  function linkWhats(ev){
    var nos = (ev.composedPath && ev.composedPath()) || [];
    if (!nos.length){
      for (var n = ev.target; n; n = n.parentNode) nos.push(n);
    }
    for (var i = 0; i < nos.length; i++){
      var el = nos[i];
      if (!el || !el.tagName || String(el.tagName).toUpperCase() !== 'A') continue;
      var href = (el.getAttribute && el.getAttribute('href')) || el.href || '';
      return RE_WA.test(href) ? el : null;   /* só o <a> mais próximo decide */
    }
    return null;
  }
  document.addEventListener('click', function(ev){
    try {
      var a = linkWhats(ev);
      if (!a) return;
      var rodape = (' ' + (a.getAttribute('class') || '') + ' ').indexOf(' ft-whatsapp ') > -1;
      window.track('whatsapp_click', { pagina: location.pathname, link: rodape ? 'rodape' : 'conteudo' });
      /* data-lead: o botão já manda Lead à Meta (agentes/fiscal/medicao.js); Contact aqui seria um segundo evento. */
      if (typeof window.fbq === 'function' && !(a.hasAttribute && a.hasAttribute('data-lead'))){
        window.fbq('track', 'Contact', { pagina: location.pathname });
      }
    } catch(e){}
  }, true);
})();
