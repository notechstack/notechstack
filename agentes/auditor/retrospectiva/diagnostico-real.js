/* nó.agentes · Auditor · retrospectiva com o diagnóstico REAL da LP (TASK-mvbcb35pbn0).
   A LP (../auditor.js) grava o resultado em sessionStorage["no_auditor_diagnostico"] (contrato v1) e navega para cá.
   Se a chave existir e for válida, este script troca a demonstração pelo site da pessoa:
     t01 (resumo + botões de conectar vão para o app), t06 (checagens reais), t13 (planos). Sequência: t01 → t06 → t13.
   Sem a chave (ou inválida) não faz nada: fica o protótipo de demonstração.
   Precisa rodar ANTES de telas-r5.js, retro-motion.js, status-mark.js e do script de navegação (que lê section[data-estado]
   e liga eventos por card no carregamento). ES5, sem dependência. Texto do diagnóstico só entra por textContent. */
(function () {
  'use strict';
  var CHAVE = 'no_auditor_diagnostico';
  var STATUS = ['ok', 'atencao', 'problema', 'nao_verificavel'];
  var CHK = { ok: 'ok', atencao: 'atencao', problema: 'problema', nao_verificavel: 'nv' };
  var ROTULO = { ok: 'ok', atencao: 'atenção', problema: 'problema', nao_verificavel: 'não verificável' };
  var DEMO = ['t02', 't04', 't05', 't07', 't-horario', 't08', 't-caminho', 't12'];
  var PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid'];
  var APP = 'https://app.notechstack.com.br/?origem=auditor';

  function texto(v) { return v == null ? '' : String(v); }
  function normalizaStatus(s) { return STATUS.indexOf(s) >= 0 ? s : 'nao_verificavel'; }
  function dec(s) { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return ''; } }

  /* a) lê e valida a chave. Devolve null se ausente/inválida. */
  function ler(bruto) {
    if (typeof bruto !== 'string' || !bruto) return null;
    var d;
    try { d = JSON.parse(bruto); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || d.v !== 1 || !d.report || typeof d.report !== 'object') return null;
    var lista = d.report.checagens;
    if (!Array.isArray(lista) || !lista.length) return null;
    var checagens = [];
    for (var i = 0; i < lista.length; i++) {
      var c = lista[i];
      if (!c || typeof c !== 'object') continue;
      checagens.push({
        id: texto(c.id), titulo: texto(c.titulo), status: normalizaStatus(c.status),
        evidencia: texto(c.evidencia), recomendacao: texto(c.recomendacao)
      });
    }
    if (!checagens.length) return null;
    return { cache: !!d.cache, url: texto(d.report.url), gerado_em: texto(d.report.gerado_em), resumo: d.report.resumo, checagens: checagens };
  }

  /* contagens: usa report.resumo se vier com números; senão conta pelas checagens. total = nº de checagens. */
  function contar(checagens, resumo) {
    var n = { ok: 0, atencao: 0, problema: 0, nao_verificavel: 0, total: checagens.length };
    var i;
    if (resumo && typeof resumo === 'object' && typeof resumo.ok === 'number') {
      for (i = 0; i < STATUS.length; i++) n[STATUS[i]] = Math.max(0, Math.round(+resumo[STATUS[i]] || 0));
    } else {
      for (i = 0; i < checagens.length; i++) n[normalizaStatus(checagens[i].status)]++;
    }
    return n;
  }

  /* destino dos botões de conectar: o app, levando utm_* e fbclid da query desta página (mesmo comportamento do CTA da LP). */
  function destinoApp(search) {
    var extra = [];
    var partes = texto(search).replace(/^\?/, '').split('&');
    for (var i = 0; i < partes.length; i++) {
      if (!partes[i]) continue;
      var par = partes[i].split('=');
      var k = dec(par[0]);
      if (PARAMS.indexOf(k) < 0) continue;
      var v = dec(par.slice(1).join('='));
      if (!v) continue;
      extra.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return APP + (extra.length ? '&' + extra.join('&') : '');
  }

  function setTexto(raiz, sel, txt) { var el = raiz.querySelector(sel); if (el) el.textContent = txt; return el; }

  /* card no MESMO molde dos de demonstração (status-mark.js liga clique/expansão e filtros por .checagem[data-chk]). */
  function cartao(doc, c) {
    var chk = CHK[c.status];
    var b = doc.createElement('button');
    b.setAttribute('type', 'button');
    b.setAttribute('class', 'checagem');
    b.setAttribute('data-chk', chk);
    b.setAttribute('aria-expanded', 'false');
    b.setAttribute('data-checagem', c.id);
    var sm = doc.createElement('span'); sm.setAttribute('class', 'sm');
    var txt = doc.createElement('span'); txt.setAttribute('class', 'checagem__txt');
    var tit = doc.createElement('b'); tit.textContent = c.titulo;
    var ev = doc.createElement('span'); ev.setAttribute('class', 'ev'); ev.textContent = c.evidencia;
    txt.appendChild(tit); txt.appendChild(ev);
    if (c.recomendacao) {
      var rec = doc.createElement('span'); rec.setAttribute('class', 'ev ev--rec');
      rec.textContent = 'Recomendação: ' + c.recomendacao;
      txt.appendChild(rec);
    }
    var est = doc.createElement('span'); est.setAttribute('class', 'estado estado--' + chk); est.textContent = ROTULO[c.status];
    b.appendChild(sm); b.appendChild(txt); b.appendChild(est);
    return b;
  }

  function aoConectar(e) {
    if (e && e.preventDefault) e.preventDefault();
    var destino = this.getAttribute('data-destino-app');
    if (destino && aoConectar.irPara) aoConectar.irPara(destino);
  }
  aoConectar.irPara = function (url) { window.location.href = url; };

  /* b) aplica o diagnóstico no documento. irPara(url) é opcional (padrão: window.location.href). */
  function aplicar(doc, dados, search, irPara) {
    if (irPara) aoConectar.irPara = irPara;
    var n = contar(dados.checagens, dados.resumo);
    var N = n.total;
    var i;
    doc.documentElement.classList.add('modo-real');

    var t01 = doc.getElementById('t01');
    if (t01) {
      var valores = t01.querySelectorAll('.resumo .cartao .valor');
      var ordem = [n.ok, n.atencao, n.problema, n.nao_verificavel];
      for (i = 0; i < valores.length && i < 4; i++) valores[i].textContent = String(ordem[i]);
      setTexto(t01, '.num', String(N));
      setTexto(t01, '.selo', 'SEU SITE');
      var destino = destinoApp(search);
      var botoes = t01.querySelectorAll('button[data-ir="t02"]');
      for (i = 0; i < botoes.length; i++) {
        botoes[i].removeAttribute('data-ir');
        botoes[i].setAttribute('data-destino-app', destino);
        botoes[i].addEventListener('click', aoConectar);
      }
      var continuar = t01.querySelector('a[data-ir="t05"]');
      if (continuar) { continuar.setAttribute('href', '#t06'); continuar.setAttribute('data-ir', 't06'); }
    }

    var t06 = doc.getElementById('t06');
    if (t06) {
      setTexto(t06, '.selo', 'SEU SITE');
      setTexto(t06, '.rot', 'Site · ' + N + ' checagens');
      var medidor = setTexto(t06, '[data-medidor]', String(n.ok));
      if (medidor) { medidor.setAttribute('data-ok', String(n.ok)); medidor.setAttribute('data-total', String(N)); }
      var segs = { 'seg--ok': n.ok, 'seg--atencao': n.atencao, 'seg--problema': n.problema, 'seg--nv': n.nao_verificavel };
      for (var classe in segs) {
        var seg = t06.querySelector('.segmentos .' + classe);
        if (!seg) continue;
        seg.style.flex = String(segs[classe]);
        if (!segs[classe]) seg.style.display = 'none';
      }
      setTexto(t06, '.medidor__num small', 'de ' + N + ' ok');
      var num = t06.querySelector('.medidor__num');
      if (num) num.setAttribute('aria-label', n.ok + ' de ' + N + ' checagens ok');
      var arco = t06.querySelector('.medidor__arco');
      if (arco) arco.setAttribute('stroke-dashoffset', (N ? 1 - n.ok / N : 1).toFixed(2));
      setTexto(t06, '.filtro[data-filtro="todas"]', 'Todas · ' + N);
      setTexto(t06, '.filtro[data-filtro="atencao"]', 'Atenção · ' + n.atencao);
      setTexto(t06, '.filtro[data-filtro="problema"]', 'Problema · ' + n.problema);
      setTexto(t06, '.filtro[data-filtro="nv"]', 'Não verif. · ' + n.nao_verificavel);
      var caixa = t06.querySelector('.cartoes-chk');
      if (caixa) {
        while (caixa.firstChild) caixa.removeChild(caixa.firstChild);
        for (i = 0; i < dados.checagens.length; i++) caixa.appendChild(cartao(doc, dados.checagens[i]));
      }
    }

    var t13 = doc.getElementById('t13');
    var seloPlanos = t13 && t13.querySelector('.selo');
    if (seloPlanos) seloPlanos.setAttribute('hidden', '');

    /* sequência real: t01 → t06 → t13. As telas de demonstração saem da navegação (sem apagar o elemento). */
    for (i = 0; i < DEMO.length; i++) {
      var s = doc.getElementById(DEMO[i]);
      if (s) { s.removeAttribute('data-estado'); s.setAttribute('hidden', ''); }
    }
    return n;
  }

  function iniciar() {
    var bruto = null;
    try { bruto = window.sessionStorage.getItem(CHAVE); } catch (e) { bruto = null; }
    var dados = ler(bruto);
    if (!dados) return false;
    aplicar(document, dados, window.location.search);
    return true;
  }

  window.NoDiagnosticoReal = { CHAVE: CHAVE, ler: ler, contar: contar, destinoApp: destinoApp, aplicar: aplicar, iniciar: iniciar };
  if (typeof document !== 'undefined' && document && document.getElementById) iniciar();
})();
