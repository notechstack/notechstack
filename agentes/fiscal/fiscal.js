/* nó.fiscal: LP do agente fiscal. Fundo fluido do bloco do simulador, simulador de emissão encenado no navegador
   (nada sai para a Sefin), 3 testes por navegador em localStorage, entradas por rolagem e consentimento LGPD. */
(function () {
  'use strict';
  var APP_URL = 'https://app.notechstack.com.br/';
  var CONSENT_KEY = 'no_fiscal_consent';
  var SIM_KEY = 'no_fiscal_simulacoes';
  var LIMITE = 3;
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var reduzido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('js');
  // Só em localhost: ?reset=1 zera a contagem dos testes grátis para rever o fluxo.
  if (isLocal && new URLSearchParams(location.search).get('reset')) { try { localStorage.removeItem(SIM_KEY); } catch (e) {} }

  /* Fundo líquido do bloco do simulador: shader com as cores da marca (âmbar, âmbar claro, osso, vermelho claro).
     Sem WebGL o canvas fica vazio e o degradê do CSS aparece. Com movimento reduzido, só um quadro. */
  var fluido = document.getElementById('fi-fluido');
  if (fluido && window.NoFluido) {
    var cs = getComputedStyle(document.documentElement);
    var cor = function (n, f) { return cs.getPropertyValue(n).trim() || f; };
    window.NoFluido.mount(fluido, {
      cores: [cor('--no-ambar', '#EDA33B'), cor('--no-ambar-claro', '#F3CA91'), cor('--no-osso', '#FAFAF7'), cor('--no-vermelho-claro', '#EC9F92')],
      dpr: window.matchMedia('(max-width: 699px)').matches ? 0.5 : 0.6, velocidade: 0.9, estatico: reduzido
    });
  }

  /* Entrada por rolagem (.fi-reveal): ganha .is-in na primeira vez em tela; filhos escalonam pelo --i. */
  var reveals = document.querySelectorAll('.fi-reveal');
  if (reveals.length && 'IntersectionObserver' in window && !reduzido) {
    reveals.forEach(function (el) {
      Array.prototype.forEach.call(el.children, function (c, i) { c.style.setProperty('--i', String(i)); });
    });
    var obs = new IntersectionObserver(function (itens) {
      itens.forEach(function (it) { if (it.isIntersecting) { it.target.classList.add('is-in'); obs.unobserve(it.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -5% 0px' });
    reveals.forEach(function (el) { obs.observe(el); });
  } else { reveals.forEach(function (el) { el.classList.add('is-in'); }); }

  /* ---------- utilidades ---------- */
  function dl(obj) { window.dataLayer = window.dataLayer || []; window.dataLayer.push(obj); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function hora() { var d = new Date(); return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }
  function brl(n) { try { return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); } catch (e) { return 'R$ ' + n.toFixed(2).replace('.', ','); } }
  function espera(ms) { return new Promise(function (r) { setTimeout(r, reduzido ? Math.min(ms, 120) : ms); }); }
  function cadastroUrl() {
    var u = new URL(APP_URL);
    var q = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid'].forEach(function (k) { var v = q.get(k); if (v) u.searchParams.set(k, v); });
    u.searchParams.set('origem', 'fiscal');
    return u.toString();
  }
  function irPara(id) { var el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: reduzido ? 'auto' : 'smooth', block: 'start' }); }

  /* ---------- consentimento LGPD (padrão: recusado) ---------- */
  var cookies = document.getElementById('fi-cookies');
  var btnGrant = document.getElementById('fi-consent-grant');
  var btnDeny = document.getElementById('fi-consent-deny');
  var estadoConsent = document.getElementById('fi-consent-estado');
  var btnsPrefs = document.querySelectorAll('[data-consent-prefs]');
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
  function apagarCookiesMedicao() {
    var host = location.hostname, partes = host.split('.'), dominios = ['', host];
    for (var i = 1; i < partes.length - 1; i++) dominios.push('.' + partes.slice(i).join('.'));
    document.cookie.split(';').forEach(function (par) {
      var nome = par.split('=')[0].trim();
      if (!/^(_fbp|_fbc|_ga|_ga_.+|_gcl_.+)$/.test(nome)) return;
      dominios.forEach(function (d) { document.cookie = nome + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + (d ? '; domain=' + d : ''); });
    });
  }
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
  Array.prototype.forEach.call(btnsPrefs, function (b) { b.addEventListener('click', function () { abrirCookies(true); }); });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && cookies && !cookies.hidden) { ev.preventDefault(); fecharCookies(); } });

  /* ---------- simulador ---------- */
  var chat = document.getElementById('fi-chat');
  var form = document.getElementById('fi-form');
  var input = document.getElementById('fi-input');
  var enviar = document.getElementById('fi-enviar');
  var chips = document.getElementById('fi-chips');
  var selo = document.getElementById('fi-sim-restantes');
  if (!chat || !form || !input) return;

  var usadas = 0; try { usadas = parseInt(localStorage.getItem(SIM_KEY) || '0', 10) || 0; } catch (e) {}
  var ocupado = false;
  var pendente = null;      // {tomador, valor, modelo} em montagem
  var aguardando = null;    // 'confirmar' | 'cancelar' | null
  var ultimaNota = null;    // {numero, chave, tomador, valor}
  var numeroBase = 142;

  function atualizarSelo() {
    if (!selo) return;
    var r = Math.max(0, LIMITE - usadas);
    selo.textContent = r === 0 ? 'testes grátis usados' : r + (r === 1 ? ' teste grátis' : ' testes grátis');
    selo.classList.toggle('is-zerado', r === 0);
  }
  function mostrarChat() { if (chat.hidden) { chat.hidden = false; } }
  function rolar() { chat.scrollTop = chat.scrollHeight; }
  function balao(classe, html) {
    mostrarChat();
    var el = document.createElement('div');
    el.className = 'fi-msg ' + classe;
    el.innerHTML = html + '<span class="fi-msg-hora">' + hora() + '</span>';
    chat.appendChild(el); rolar();
    return el;
  }
  function pessoa(texto) { return balao('fi-msg--pessoa', '<p>' + esc(texto) + '</p>'); }
  function agente(html) { return balao('fi-msg--agente', html); }
  function digitando(ms) {
    mostrarChat();
    var el = document.createElement('div');
    el.className = 'fi-msg fi-msg--agente';
    el.innerHTML = '<span class="fi-digitando" aria-label="agente digitando"><i></i><i></i><i></i></span>';
    chat.appendChild(el); rolar();
    return espera(ms).then(function () { el.remove(); });
  }
  function travar(sim) { ocupado = sim; enviar.disabled = sim; input.disabled = sim; if (!sim) input.focus({ preventScroll: true }); }

  /* Leitura da mensagem: valor em reais, nome do tomador e modelo. Pontuação de cada número para não confundir
     "nota 142" com "142 reais". Formato pt-BR (1.250,50) e "2 mil". */
  function lerValor(t) {
    var re = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?(\s*mil)?/gi, m, melhor = null;
    while ((m = re.exec(t))) {
      var antes = t.slice(Math.max(0, m.index - 14), m.index).toLowerCase();
      var depois = t.slice(m.index + m[0].length, m.index + m[0].length + 10).toLowerCase();
      var pontos = 0;
      if (/\breais?\b|\bconto|\bpila/.test(depois)) pontos += 3;
      if (/r\$\s*$/.test(antes)) pontos += 3;
      if (/(valor|de|por)\s*$/.test(antes)) pontos += 1;
      if (/(nota|n[º°o]\.?|numero|número|serie|série)\s*$/.test(antes)) pontos -= 4;
      if (!melhor || pontos > melhor.pontos) melhor = { pontos: pontos, m: m };
    }
    if (!melhor || melhor.pontos < 0) return null;
    var inteiro = parseInt(melhor.m[1].replace(/\./g, ''), 10);
    var cent = melhor.m[2] ? parseInt((melhor.m[2] + '0').slice(0, 2), 10) : 0;
    var v = inteiro + cent / 100;
    if (melhor.m[3]) v *= 1000;
    return v > 0 ? v : null;
  }
  function titulo(s) {
    return s.trim().replace(/\s+/g, ' ').split(' ').map(function (p) {
      if (/^(de|da|do|dos|das|e|&)$/i.test(p)) return p.toLowerCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    }).join(' ');
  }
  function lerTomador(t) {
    var m = /\b(?:pra|para|p\/|ao|à)\s+(?:a\s+|o\s+)?([A-Za-zÀ-ÿ0-9&.'\- ]+?)(?=\s*(?:,|\.|;|!|$|\bno valor\b|\bvalor\b|\bde\s*r\$|\bde\s+\d|\bpor\s+\d|\br\$|\d|\buse\b|\busa\b|\busando\b|\bcom\b|\bmodelo\b|\bno\b))/i.exec(t);
    if (!m) return null;
    var nome = m[1].trim();
    if (!nome || /^(a|o|um|uma|nota|emitir|mim|ela|ele)$/i.test(nome)) return null;
    return titulo(nome);
  }
  function lerModelo(t) {
    var m = /\bmodelos?\s+(?:da|de|do|dos|das|o|a)?\s*([A-Za-zÀ-ÿ0-9 ]+?)(?=\s*(?:,|\.|;|!|$|\bno\b|\bvalor\b|\bpra\b|\bpara\b|\bde\b))/i.exec(t);
    return m && m[1].trim() ? titulo(m[1]) : null;
  }
  function ler(t) { return { tomador: lerTomador(t), valor: lerValor(t), modelo: lerModelo(t) }; }

  function resumoHtml(p) {
    return '<ul class="fi-resumo">' +
      '<li><span>Tomador</span><b>' + esc(p.tomador) + '</b></li>' +
      '<li><span>Valor</span><b>' + esc(brl(p.valor)) + '</b></li>' +
      '<li><span>Serviço</span><b>' + (p.modelo ? 'Modelo “' + esc(p.modelo) + '”' : 'Modelo padrão') + ' · 04.01.01</b></li>' +
      '</ul>';
  }
  function botoes(lista) {
    return '<div class="fi-msg-botoes">' + lista.map(function (b) {
      return '<button type="button" class="fi-btn ' + (b.primario ? 'fi-btn--tinta' : 'fi-btn--borda') + '" data-acao="' + b.acao + '">' + esc(b.rotulo) + '</button>';
    }).join('') + '</div>';
  }
  function desativarBotoes(el) { Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) { b.disabled = true; }); }
  function ctaFinal(el) {
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-acao]'); if (!b) return;
      if (b.dataset.acao === 'conta') { dl({ event: 'fiscal_cta_conta', origem: 'simulador' }); location.assign(cadastroUrl()); }
      else irPara('planos');
    });
  }

  function pedirConfirmacao() {
    aguardando = 'confirmar';
    var el = agente('<p>Entendi assim:</p>' + resumoHtml(pendente) +
      '<p>Confirmo a emissão?</p>' + botoes([{ acao: 'confirmar', rotulo: 'Confirmar emissão', primario: true }, { acao: 'corrigir', rotulo: 'Corrigir' }]));
    el.addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-acao]'); if (!b || b.disabled || ocupado) return;
      desativarBotoes(el);
      if (b.dataset.acao === 'confirmar') { pessoa('Confirmo'); emitir(); }
      else { pessoa('Corrigir'); aguardando = null; agente('<p>Sem problema. Me diga o que muda: o nome do cliente, o valor ou o modelo.</p>'); }
    });
  }

  function chave() {
    var s = '3550308' + String(Date.now()).slice(-6); // só aparência de chave de 50 dígitos; é simulação
    while (s.length < 50) s += Math.floor(Math.random() * 10);
    return s.slice(0, 4) + ' ' + s.slice(4, 8) + ' … ' + s.slice(-4);
  }
  function emitir() {
    if (usadas >= LIMITE) { aguardando = null; limite(); return; }
    aguardando = null; travar(true);
    var p = pendente; pendente = null;
    var passos = ['Montando a DPS 1.01', 'Assinando com o certificado A1', 'Transmitindo à Sefin Nacional', 'NFS-e autorizada'];
    var el = agente('<p>Emitindo…</p><ol class="fi-progresso">' + passos.map(function (s) { return '<li><i aria-hidden="true"></i>' + esc(s) + '</li>'; }).join('') + '</ol>');
    var itens = el.querySelectorAll('.fi-progresso li');
    dl({ event: 'fiscal_simulacao_emitir' });
    var seq = Promise.resolve();
    Array.prototype.forEach.call(itens, function (li, i) {
      seq = seq.then(function () { li.classList.add('is-ativo'); rolar(); return espera(i === 2 ? 1100 : 700); })
        .then(function () { li.classList.remove('is-ativo'); li.classList.add('is-feito'); });
    });
    seq.then(function () { return espera(350); }).then(function () {
      usadas += 1; try { localStorage.setItem(SIM_KEY, String(usadas)); } catch (e) {}
      atualizarSelo();
      var numero = numeroBase + usadas;
      var num = String(numero).padStart(6, '0');
      ultimaNota = { numero: numero, chave: chave(), tomador: p.tomador, valor: p.valor };
      agente(
        '<p>Pronto! NFS-e autorizada.</p>' +
        '<div class="fi-nota"><div class="fi-nota-cab"><b>NFS-e · série 1 · nº ' + num + '</b><span>' + esc(new Date().toLocaleDateString('pt-BR')) + '</span></div>' +
        '<dl><dt>Emitente</dt><dd>Sua Empresa LTDA (demonstração)</dd><dt>Tomador</dt><dd>' + esc(p.tomador) + '</dd>' +
        '<dt>Serviço</dt><dd>' + (p.modelo ? esc(p.modelo) : 'Padrão') + ' · cód. nacional 04.01.01</dd>' +
        '<dt>Valor</dt><dd class="fi-nota-valor">' + esc(brl(p.valor)) + '</dd><dt>Chave</dt><dd>' + esc(ultimaNota.chave) + '</dd></dl>' +
        '<span class="fi-carimbo" aria-label="simulação">simulação</span></div>' +
        '<div class="fi-anexos"><span class="fi-anexo">danfse-' + num + '.pdf</span><span class="fi-anexo">nfse-' + num + '.xml</span></div>' +
        '<ul class="fi-entregas"><li><i aria-hidden="true"></i>cópia no seu WhatsApp</li><li><i aria-hidden="true"></i>cópia no seu e-mail</li><li><i aria-hidden="true"></i>cópia para o cliente</li></ul>'
      );
      dl({ event: 'fiscal_simulacao_emitida', simulacoes: usadas });
      return espera(1700);
    }).then(function () {
      var r = LIMITE - usadas;
      var el2 = agente('<p>Isso foi uma simulação: nada foi enviado à Sefin. Na conta real, a nota sai do seu CNPJ, assinada com o seu A1, e a cópia chega no WhatsApp e no e-mail de verdade.</p>' +
        (r > 0 ? '<p>Você ainda tem ' + r + (r === 1 ? ' teste grátis' : ' testes grátis') + '. Pode mandar outra mensagem ou cancelar esta nota.</p>' : '<p>Esse foi o seu último teste grátis.</p>') +
        botoes([{ acao: 'conta', rotulo: 'Criar minha conta', primario: true }, { acao: 'planos', rotulo: 'Ver os planos' }]));
      ctaFinal(el2);
      travar(false);
    });
  }

  function cancelar() {
    aguardando = null; travar(true);
    var n = ultimaNota; ultimaNota = null;
    var num = String(n.numero).padStart(6, '0');
    var el = agente('<p>Cancelando…</p><ol class="fi-progresso"><li><i aria-hidden="true"></i>Montando o evento de cancelamento (e101101)</li><li><i aria-hidden="true"></i>Assinando com o certificado A1</li><li><i aria-hidden="true"></i>Transmitindo à Sefin Nacional</li></ol>');
    var itens = el.querySelectorAll('.fi-progresso li');
    var seq = Promise.resolve();
    Array.prototype.forEach.call(itens, function (li, i) {
      seq = seq.then(function () { li.classList.add('is-ativo'); rolar(); return espera(i === 2 ? 1000 : 650); })
        .then(function () { li.classList.remove('is-ativo'); li.classList.add('is-feito'); });
    });
    seq.then(function () { return espera(300); }).then(function () {
      agente('<p>Nota cancelada e o cliente avisado.</p>' +
        '<div class="fi-nota"><div class="fi-nota-cab"><b>NFS-e · série 1 · nº ' + num + '</b><span>' + esc(new Date().toLocaleDateString('pt-BR')) + '</span></div>' +
        '<dl><dt>Tomador</dt><dd>' + esc(n.tomador) + '</dd><dt>Valor</dt><dd>' + esc(brl(n.valor)) + '</dd><dt>Evento</dt><dd>e101101 aceito</dd></dl>' +
        '<span class="fi-carimbo fi-carimbo--cancelada" aria-label="cancelada (simulação)">cancelada</span></div>' +
        '<ul class="fi-entregas"><li><i aria-hidden="true"></i>aviso no seu WhatsApp</li><li><i aria-hidden="true"></i>aviso no e-mail do cliente</li></ul>');
      dl({ event: 'fiscal_simulacao_cancelada' });
      travar(false);
    });
  }

  function limite() {
    dl({ event: 'fiscal_simulacao_limite' });
    var el = balao('fi-msg--agente fi-msg--limite', '<p>Você já usou seus ' + LIMITE + ' testes grátis por aqui. Para emitir de verdade, crie a sua conta: cadastro do CNPJ, certificado A1 e um plano de notas por mês, com os primeiros 7 dias grátis.</p>' +
      botoes([{ acao: 'conta', rotulo: 'Criar minha conta', primario: true }, { acao: 'planos', rotulo: 'Ver os planos' }]));
    ctaFinal(el);
  }

  function responder(texto) {
    var t = texto.toLowerCase();
    var sim = /^(sim|s|ok|pode|confirmo|confirma|isso|certo|beleza|manda|vai|bora|pode ser|positivo)\b/.test(t);
    var nao = /^(n[ãa]o|n|nope|negativo|corrig|errad|muda|troca|cancela isso|deixa)/.test(t);

    if (aguardando === 'cancelar') {
      if (sim) { cancelar(); return; }
      if (nao) { aguardando = null; agente('<p>Certo, a nota fica como está.</p>'); return; }
    }
    if (aguardando === 'confirmar') {
      if (sim) { emitir(); return; }
      if (nao) { aguardando = null; agente('<p>Sem problema. Me diga o que muda: o nome do cliente, o valor ou o modelo.</p>'); return; }
    }
    if (/cancel/.test(t) && !/n[ãa]o cancel/.test(t)) {
      if (!ultimaNota) { agente('<p>Nesta simulação ainda não há nota emitida. Emita uma primeiro; depois é só dizer “cancela a última nota”.</p>'); return; }
      aguardando = 'cancelar';
      var el = agente('<p>Cancelar a NFS-e nº ' + String(ultimaNota.numero).padStart(6, '0') + ', de ' + esc(ultimaNota.tomador) + ' (' + esc(brl(ultimaNota.valor)) + ')? Vou enviar o evento oficial de cancelamento à Sefin.</p>' +
        botoes([{ acao: 'sim', rotulo: 'Sim, cancelar', primario: true }, { acao: 'nao', rotulo: 'Manter a nota' }]));
      el.addEventListener('click', function (ev) {
        var b = ev.target.closest('button[data-acao]'); if (!b || b.disabled || ocupado) return;
        desativarBotoes(el);
        if (b.dataset.acao === 'sim') { pessoa('Sim, cancelar'); cancelar(); }
        else { pessoa('Manter a nota'); aguardando = null; agente('<p>Certo, a nota fica como está.</p>'); }
      });
      return;
    }
    if (usadas >= LIMITE) { limite(); return; }

    var lido = ler(texto);
    pendente = pendente || { tomador: null, valor: null, modelo: null };
    if (lido.tomador) pendente.tomador = lido.tomador;
    if (lido.valor) pendente.valor = lido.valor;
    if (lido.modelo) pendente.modelo = lido.modelo;
    // resposta curta só com um nome, quando o agente perguntou "para quem?"
    if (!lido.tomador && !lido.valor && !lido.modelo && !pendente.tomador && /^[A-Za-zÀ-ÿ0-9&.'\- ]{2,60}$/.test(texto.trim())) pendente.tomador = titulo(texto);

    if (!pendente.tomador && !pendente.valor) {
      agente('<p>Não achei o cliente nem o valor. Tente algo como: “nota pra Clínica Aurora de 350 reais”.</p>');
      return;
    }
    if (!pendente.tomador) { agente('<p>' + esc(brl(pendente.valor)) + ', anotado. Para quem é a nota?</p>'); return; }
    if (!pendente.valor) { agente('<p>Nota para ' + esc(pendente.tomador) + '. Qual é o valor?</p>'); return; }
    pedirConfirmacao();
  }

  function enviarMensagem(texto) {
    var t = (texto || '').trim();
    if (!t || ocupado) return;
    input.value = '';
    pessoa(t);
    dl({ event: 'fiscal_simulacao_mensagem' });
    travar(true);
    digitando(Math.min(1400, 500 + t.length * 12)).then(function () { travar(false); responder(t); });
  }
  form.addEventListener('submit', function (ev) { ev.preventDefault(); enviarMensagem(input.value); });
  if (chips) chips.addEventListener('click', function (ev) {
    var c = ev.target.closest('.fi-chip'); if (!c) return;
    enviarMensagem(c.dataset.exemplo || c.textContent);
  });
  atualizarSelo();
  // Só em localhost: ?auto=<mensagem> envia de cara (prova visual com navegador headless).
  if (isLocal) { var auto = new URLSearchParams(location.search).get('auto'); if (auto) enviarMensagem(auto); }
})();
