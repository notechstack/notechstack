/* Assinatura do Auditor: 3 planos + checkout. Cartão é tokenizado direto no Pagar.me; só o token vai à nossa função (CONTRATO.md). */
(function () {
  'use strict';
  var SUPABASE_BASE = 'https://sdeowbqmwkwseyktyemn.supabase.co'; // mesma base de auditor.js
  var ENDPOINT = SUPABASE_BASE + '/functions/v1/assinatura-auditor';
  var TOKENS_URL = 'https://api.pagar.me/core/v5/tokens';
  var PLANOS = {
    mensal: { nome: 'Mensal', valor: 47 },
    semanal: { nome: 'Semanal', valor: 97 },
    agencia: { nome: 'Agência', valor: 197 }
  };

  /* ---------- funções puras (testáveis sem DOM) ---------- */
  function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function texto(v) { return String(v == null ? '' : v).trim(); }

  function validar(d) {
    d = d || {};
    var erros = [];
    if (texto(d.nome).length < 2) erros.push('Informe seu nome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(texto(d.email))) erros.push('Informe um e-mail válido.');
    var doc = soDigitos(d.documento);
    if (doc.length !== 11 && doc.length !== 14) erros.push('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).');
    var tel = soDigitos(d.telefone);
    if (tel && (tel.length < 10 || tel.length > 11)) erros.push('O telefone com DDD precisa ter 10 ou 11 dígitos.');
    if (d.relatorio_aceite === true && !tel) erros.push('Para receber o relatório no WhatsApp, informe o telefone com DDD.');
    var num = soDigitos(d.numero_cartao);
    if (num.length < 13 || num.length > 19) erros.push('Confira o número do cartão.');
    if (texto(d.nome_cartao).length < 2) erros.push('Informe o nome impresso no cartão.');
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(texto(d.validade))) erros.push('Informe a validade do cartão no formato MM/AA.');
    var cvv = soDigitos(d.cvv);
    if (cvv.length < 3 || cvv.length > 4) erros.push('Informe o CVV (3 ou 4 dígitos).');
    if (d.termos_aceite !== true) erros.push('É preciso aceitar os Termos de uso e a Política de privacidade.');
    return erros;
  }

  /* Nunca inclui número, nome impresso, validade ou CVV: só o token do Pagar.me. */
  function montarPedido(d, cardToken, textoAceite) {
    d = d || {};
    var aceite = d.relatorio_aceite === true;
    var tel = soDigitos(d.telefone);
    var pedido = {
      plano: d.plano,
      nome: texto(d.nome),
      email: texto(d.email),
      documento: soDigitos(d.documento),
      card_token: cardToken,
      relatorio_aceite: aceite,
      relatorio_aceite_texto: aceite ? (texto(textoAceite) || null) : null,
      termos_aceite: true
    };
    if (tel) pedido.telefone = tel;
    return pedido;
  }

  function mensagem(resp) {
    if (resp && resp.ok === true) {
      if (resp.status === 'paga') return 'Assinatura confirmada. Seus relatórios seguem o ritmo do plano escolhido.';
      if (resp.status === 'pendente') return 'Recebemos sua assinatura. A confirmação do pagamento chega em instantes.';
    }
    return (resp && resp.mensagem) || 'Não deu para concluir agora. Tente de novo em alguns minutos.';
  }

  /* Medição do checkout segurada até a TASK da D4: só com a venda aberta E medicao_liberada vindos da função. */
  function medicaoLiberada(info) { return !!(info && info.venda_aberta === true && info.medicao_liberada === true); }

  var raiz = typeof window !== 'undefined' ? window : {};
  raiz.noAssinatura = { PLANOS: PLANOS, validar: validar, montarPedido: montarPedido, mensagem: mensagem, medicaoLiberada: medicaoLiberada };

  /* ---------- tela (só com a seção de planos na página) ---------- */
  if (typeof document === 'undefined' || !document.getElementById('planos')) return;

  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  if (isLocal) {
    var custom = new URLSearchParams(location.search).get('assinatura_endpoint');
    if (custom) ENDPOINT = custom;
  }

  function $(id) { return document.getElementById(id); }
  var dialog = $('au-checkout');
  var form = $('au-checkout-form');
  var msg = $('au-checkout-msg');
  var btnAssinar = $('au-checkout-assinar');
  var botoes = Array.prototype.slice.call(document.querySelectorAll('.au-plano-btn'));
  var estado = { publicKey: '', vendaAberta: false, plano: null, enviando: false };
  var CAMPOS_CARTAO = ['au-cc-numero', 'au-cc-nome', 'au-cc-validade', 'au-cc-cvv'];

  /* Medição segurada até a TASK da D4 (Lucca, 16/10): só com medicao_liberada vindo da função; o consentimento
     de cookies continua sendo conferido dentro de assinatura-medicao.js. */
  function medicao(fn, codigo) {
    if (!estado.medicaoLiberada) return;
    var m = window.noAssinaturaMedicao;
    if (m && typeof m[fn] === 'function') { try { m[fn](codigo); } catch (e) { /* medição nunca derruba o checkout */ } }
  }
  function mostrar(t, erro) {
    msg.textContent = t || '';
    msg.hidden = !t;
    msg.classList.toggle('is-erro', !!erro);
  }
  function limparCartao() {
    CAMPOS_CARTAO.forEach(function (id) { var el = $(id); if (el) el.value = ''; });
  }
  function fechar() {
    limparCartao();
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  }
  function abrir(codigo) {
    var p = PLANOS[codigo];
    if (!p) return;
    estado.plano = codigo;
    estado.concluida = false;
    btnAssinar.disabled = false;
    $('au-checkout-plano').textContent = p.nome + ' · R$ ' + p.valor + '/mês';
    mostrar('');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    medicao('iniciada', codigo);
  }

  /* Estado da venda: só abre o botão se a função disser venda_aberta e o plano disponível. Falhou? Fica "Assinatura em breve". */
  fetch(ENDPOINT, { method: 'GET' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function (info) {
      if (!info || info.venda_aberta !== true) return;
      estado.vendaAberta = true;
      estado.medicaoLiberada = medicaoLiberada(info);
      estado.publicKey = info.public_key || '';
      var disp = {};
      (info.planos || []).forEach(function (p) { if (p && p.codigo) disp[p.codigo] = p.disponivel === true; });
      botoes.forEach(function (b) {
        var c = b.getAttribute('data-plano');
        if (disp[c] && PLANOS[c]) { b.disabled = false; b.textContent = 'Assinar'; }
      });
    })
    .catch(function () { /* botões continuam "Assinatura em breve" */ });

  botoes.forEach(function (b) {
    b.addEventListener('click', function () { if (!b.disabled) abrir(b.getAttribute('data-plano')); });
  });
  $('au-checkout-cancelar').addEventListener('click', fechar);
  dialog.addEventListener('close', limparCartao);

  function lerDados() {
    return {
      plano: estado.plano,
      nome: $('au-as-nome').value,
      email: $('au-as-email').value,
      documento: $('au-as-documento').value,
      telefone: $('au-as-telefone').value,
      numero_cartao: $('au-cc-numero').value,
      nome_cartao: $('au-cc-nome').value,
      validade: $('au-cc-validade').value,
      cvv: $('au-cc-cvv').value,
      termos_aceite: $('au-ck-termos').checked,
      relatorio_aceite: $('au-ck-relatorio').checked
    };
  }

  function tokenizar(d) {
    var partes = texto(d.validade).split('/');
    var body = { type: 'card', card: {
      number: soDigitos(d.numero_cartao),
      holder_name: texto(d.nome_cartao),
      exp_month: parseInt(partes[0], 10),
      exp_year: parseInt('20' + partes[1], 10),
      cvv: soDigitos(d.cvv)
    } };
    return fetch(TOKENS_URL + '?appId=' + encodeURIComponent(estado.publicKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok || !j || !j.id) throw new Error('CARTAO');
        return j.id;
      });
    }, function () { throw new Error('CARTAO'); });
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (estado.enviando) return;
    var d = lerDados();
    var erros = validar(d);
    if (erros.length) { mostrar(erros.join(' '), true); return; }
    var codigo = d.plano;
    var textoAceite = $('au-ck-relatorio-texto').textContent;
    estado.enviando = true;
    btnAssinar.disabled = true;
    mostrar('Processando o pagamento…');
    tokenizar(d)
      .then(function (token) {
        limparCartao();
        d.numero_cartao = d.nome_cartao = d.validade = d.cvv = '';
        return fetch(ENDPOINT, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(montarPedido(d, token, textoAceite))
        }).then(function (r) { return r.json().catch(function () { return { ok: false }; }); });
      })
      .then(function (resp) {
        var ok = !!(resp && resp.ok === true);
        mostrar(mensagem(resp), !ok);
        if (ok) { estado.concluida = true; medicao('concluida', codigo); }
      })
      .catch(function (e) {
        mostrar(e && e.message === 'CARTAO' ? 'Confira os dados do cartão.' : 'Não deu para concluir agora. Tente de novo em alguns minutos.', true);
      })
      /* Assinatura feita: o botão não volta, para um segundo clique não criar outra cobrança. */
      .then(function () { estado.enviando = false; btnAssinar.disabled = !!estado.concluida; });
  });
})();
