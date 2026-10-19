/* Assinatura do Auditor: 3 planos + checkout. Cartão é tokenizado direto no Pagar.me; só o token vai à nossa função (CONTRATO.md).
   Decisões de Lucca (16/10): os planos ficam na tela final da retrospectiva (não na LP); aceite único e obrigatório dos Termos,
   que já diz que o relatório chega no WhatsApp informado (não há mais caixa separada do relatório).
   Checkout em duas etapas (Lucca, 16/10): 1) cadastro base (nome, sobrenome, e-mail, WhatsApp) e o aceite dos Termos,
   no momento do cadastro pré-venda; 2) só depois abrem CPF/CNPJ, cartão e o endereço de cobrança que o Pagar.me pede. */
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
  /* mesma lista da função (core.ts): o endereço de cobrança é recusado lá se a UF não estiver aqui */
  var UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
    'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

  /* ---------- funções puras (testáveis sem DOM) ---------- */
  function soDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function texto(v) { return String(v == null ? '' : v).trim(); }
  /* textContent do label com espaços normalizados: é o que vai em aceite_texto, igual ao que a pessoa leu. */
  function normalizarTexto(v) { return texto(v).replace(/\s+/g, ' '); }
  function nomeCompleto(d) { return normalizarTexto(texto(d.nome) + ' ' + texto(d.sobrenome)); }

  /* Etapa 1: cadastro base + aceite. Sem isto, os campos de pagamento nem abrem. */
  function validarEtapa1(d) {
    d = d || {};
    var erros = [];
    if (texto(d.nome).length < 2) erros.push('Informe seu nome.');
    if (texto(d.sobrenome).length < 2) erros.push('Informe seu sobrenome.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(texto(d.email))) erros.push('Informe um e-mail válido.');
    var tel = soDigitos(d.telefone);
    if (tel.length < 10 || tel.length > 11) erros.push('Informe o WhatsApp com DDD (10 ou 11 dígitos): é nele que o relatório chega.');
    if (d.termos_aceite !== true) erros.push('Para continuar, marque o aceite dos Termos de Uso e da Política de Privacidade (o relatório chega no WhatsApp informado).');
    return erros;
  }

  /* Etapa 2: documento, cartão e endereço de cobrança (o que o Pagar.me pede para a assinatura). */
  function validarEtapa2(d) {
    d = d || {};
    var erros = [];
    var doc = soDigitos(d.documento);
    if (doc.length !== 11 && doc.length !== 14) erros.push('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).');
    var num = soDigitos(d.numero_cartao);
    if (num.length < 13 || num.length > 19) erros.push('Confira o número do cartão.');
    if (texto(d.nome_cartao).length < 2) erros.push('Informe o nome impresso no cartão.');
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(texto(d.validade))) erros.push('Informe a validade do cartão no formato MM/AA.');
    var cvv = soDigitos(d.cvv);
    if (cvv.length < 3 || cvv.length > 4) erros.push('Informe o CVV (3 ou 4 dígitos).');
    var e = d.endereco || {};
    var endOk = soDigitos(e.cep).length === 8 && texto(e.rua).length >= 2 && texto(e.numero).length >= 1 &&
      texto(e.bairro).length >= 2 && texto(e.cidade).length >= 2 && UFS.indexOf(texto(e.uf).toUpperCase()) >= 0;
    if (!endOk) erros.push('Confira o endereço de cobrança do cartão (CEP com 8 dígitos, rua, número, bairro, cidade e UF).');
    return erros;
  }

  function validar(d) { return validarEtapa1(d).concat(validarEtapa2(d)); }

  /* Corpo do POST, exatamente estas chaves. Nunca inclui número, nome impresso, validade ou CVV: só o token do Pagar.me.
     Nome e sobrenome vão juntos em "nome" (é o nome do cliente no Pagar.me). */
  function montarPedido(d, cardToken, textoAceite) {
    d = d || {};
    var e = d.endereco || {};
    return {
      plano: d.plano,
      nome: nomeCompleto(d),
      email: texto(d.email),
      documento: soDigitos(d.documento),
      telefone: soDigitos(d.telefone),
      card_token: cardToken,
      termos_aceite: true,
      aceite_texto: normalizarTexto(textoAceite),
      endereco: {
        cep: soDigitos(e.cep),
        rua: normalizarTexto(e.rua),
        numero: normalizarTexto(e.numero),
        complemento: normalizarTexto(e.complemento),
        bairro: normalizarTexto(e.bairro),
        cidade: normalizarTexto(e.cidade),
        uf: texto(e.uf).toUpperCase()
      }
    };
  }

  /* Linha que substitui a etapa 1 quando a 2 abre: a pessoa confere para onde vai o relatório. */
  function resumoEtapa1(d) {
    d = d || {};
    var t = soDigitos(d.telefone);
    var tel = t.length >= 10 ? '(' + t.slice(0, 2) + ') ' + t.slice(2, t.length - 4) + '-' + t.slice(-4) : t;
    return nomeCompleto(d) + ' · ' + texto(d.email) + ' · WhatsApp ' + tel;
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
  raiz.noAssinatura = {
    PLANOS: PLANOS, UFS: UFS, validar: validar, validarEtapa1: validarEtapa1, validarEtapa2: validarEtapa2,
    montarPedido: montarPedido, resumoEtapa1: resumoEtapa1, mensagem: mensagem, medicaoLiberada: medicaoLiberada,
    normalizarTexto: normalizarTexto
  };

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
  var etapa1 = $('au-etapa-1');
  var etapa2 = $('au-etapa-2');
  var resumo = $('au-etapa-1-resumo');
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
  /* Etapa visível: 1 = cadastro base + aceite; 2 = pagamento (o resumo da 1 fica no lugar dela, com "Alterar"). */
  function irEtapa(n) {
    var dois = n === 2;
    etapa1.hidden = dois;
    resumo.hidden = !dois;
    etapa2.hidden = !dois;
    btnAssinar.hidden = !dois;
    $('au-passo-1').classList.toggle('is-ativo', !dois);
    $('au-passo-2').classList.toggle('is-ativo', dois);
    var foco = $(dois ? 'au-as-documento' : 'au-as-nome');
    if (foco && typeof foco.focus === 'function') { try { foco.focus(); } catch (e) {} }
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
    irEtapa(1);
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
      sobrenome: $('au-as-sobrenome').value,
      email: $('au-as-email').value,
      telefone: $('au-as-telefone').value,
      termos_aceite: $('au-ck-termos').checked,
      documento: $('au-as-documento').value,
      numero_cartao: $('au-cc-numero').value,
      nome_cartao: $('au-cc-nome').value,
      validade: $('au-cc-validade').value,
      cvv: $('au-cc-cvv').value,
      endereco: {
        cep: $('au-en-cep').value,
        rua: $('au-en-rua').value,
        numero: $('au-en-numero').value,
        complemento: $('au-en-complemento').value,
        bairro: $('au-en-bairro').value,
        cidade: $('au-en-cidade').value,
        uf: $('au-en-uf').value
      }
    };
  }

  /* Continuar: só com a etapa 1 válida (inclusive o aceite) abrem os campos de pagamento. */
  function continuar() {
    var d = lerDados();
    var erros = validarEtapa1(d);
    if (erros.length) { mostrar(erros.join(' '), true); return false; }
    mostrar('');
    $('au-resumo-texto').textContent = resumoEtapa1(d);
    irEtapa(2);
    return true;
  }
  $('au-checkout-continuar').addEventListener('click', continuar);
  $('au-checkout-alterar').addEventListener('click', function () { mostrar(''); irEtapa(1); });

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
    /* Enter na etapa 1 vale como "Continuar", nunca como pagamento */
    if (etapa2.hidden) { continuar(); return; }
    var d = lerDados();
    var erros1 = validarEtapa1(d);
    if (erros1.length) { irEtapa(1); mostrar(erros1.join(' '), true); return; }
    var erros = validarEtapa2(d);
    if (erros.length) { mostrar(erros.join(' '), true); return; }
    var codigo = d.plano;
    var textoAceite = normalizarTexto($('au-ck-termos-rotulo').textContent);
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
