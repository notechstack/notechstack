/* Lista de espera do nó.auditor: nome, e-mail e WhatsApp vão para a send-lead-email (tabela leads, e-mail para a nó
   e Lead no Meta CAPI), com modo 'auditor_lista' para separar dos outros formulários. Fica no ar enquanto a Meta
   não aprova o app como provedor de tecnologia; quando aprovar, sai junto com o #au-lista do index.html. */
(function () {
  'use strict';
  var ENDPOINT = 'https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/send-lead-email';
  var CONSENT_KEY = 'no_auditor_consent';
  // Só em localhost: ?lista=<url> troca o destino (teste sem gravar lead real).
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    var custom = new URLSearchParams(location.search).get('lista');
    if (custom) ENDPOINT = custom;
  }

  var form = document.getElementById('au-lista');
  var ok = document.getElementById('au-lista-ok');
  if (!form || !ok) return;
  var nome = document.getElementById('au-nome');
  var email = document.getElementById('au-email');
  var fone = document.getElementById('au-whatsapp');
  var enviar = document.getElementById('au-lista-enviar');
  var erro = document.getElementById('au-lista-erro');

  function cookie(n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : ''; }
  function consentido() { try { return localStorage.getItem(CONSENT_KEY) === 'granted'; } catch (e) { return false; } }
  function digitos(v) { return String(v || '').replace(/\D/g, ''); }

  /* mesma máscara do formulário da /agencia/ */
  fone.addEventListener('input', function () {
    var v = digitos(fone.value).slice(0, 11);
    if (v.length > 6) v = '(' + v.slice(0, 2) + ') ' + v.slice(2, 7) + '-' + v.slice(7);
    else if (v.length > 2) v = '(' + v.slice(0, 2) + ') ' + v.slice(2);
    else if (v.length) v = '(' + v;
    fone.value = v;
  });

  function mostrarErro(campo, msg) {
    erro.textContent = msg; erro.hidden = false;
    if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.focus(); }
  }
  function limparErro() {
    erro.hidden = true; erro.textContent = '';
    [nome, email, fone].forEach(function (c) { c.removeAttribute('aria-invalid'); });
  }
  form.addEventListener('input', limparErro);
  form.addEventListener('input', function () { if (window.track) window.track('form_etapa', { etapa: 1, modo: 'auditor_lista' }, 'auditor_lista_inicio'); }, { once: true });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    limparErro();
    var n = nome.value.trim(), e = email.value.trim(), f = digitos(fone.value);
    if (n.length < 2) return mostrarErro(nome, 'Informe seu nome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return mostrarErro(email, 'Informe um e-mail válido, por exemplo voce@empresa.com.br');
    if (f.length < 10 || f.length > 11) return mostrarErro(fone, 'Informe o WhatsApp com DDD, por exemplo (11) 91234-5678');

    /* LGPD: sem a medição permitida no aviso de cookies, nada de _fbp/_fbc e o servidor não manda o Lead à Meta */
    var permitido = consentido();
    var orig = window.leadOrig || {};
    var payload = {
      sid: window.leadSid || null,
      origem: orig,
      modo: 'auditor_lista',
      contexto: 'nó.auditor — lista de espera (aviso no WhatsApp no lançamento)',
      event_source_url: permitido ? location.href : location.origin + location.pathname,
      valor: 0,
      consent: permitido ? 'granted' : 'denied',
      fbp: permitido ? cookie('_fbp') : '',
      fbc: permitido ? cookie('_fbc') : '',
      nome: n, email: e, whatsapp: fone.value.trim()
    };
    enviar.disabled = true;
    var rotulo = enviar.textContent;
    enviar.textContent = 'Enviando…';

    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { ok: res.ok, d: d }; }); })
      .then(function (r) {
        if (!r.ok || !r.d.success || !(r.d.saved || r.d.emailSent)) throw new Error('falha');
        if (window.track) window.track('lead_submit', { etapa: 5, modo: 'auditor_lista', valor: 0 }, 'auditor_lista');
        var primeiro = n.split(/\s+/)[0];
        document.getElementById('au-lista-ok-titulo').textContent = 'Pronto, ' + primeiro + '! Você está na lista';
        document.getElementById('au-lista-ok-texto').textContent = 'Quando o nó.auditor for ao ar, mandamos uma mensagem no WhatsApp ' + fone.value.trim().replace(/[\s-]/g, function (c) { return c === '-' ? '‑' : ' '; }) + '.';
        form.hidden = true;
        ok.hidden = false;
        ok.focus({ preventScroll: true });
      })
      .catch(function () {
        enviar.disabled = false;
        enviar.textContent = rotulo;
        mostrarErro(null, 'Não conseguimos registrar agora. Tente de novo em instantes ou fale com a nó pelo WhatsApp no rodapé.');
      });
  });
})();
