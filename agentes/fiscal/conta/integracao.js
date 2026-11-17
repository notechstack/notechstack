/* Aba "API" do painel Minha conta (conta Escritório), sobre /v1/fiscal/emissao (app/api/_lib/parceiro/painel-integracao.ts).
   Chave da API do parceiro (gerar e trocar; aparece uma vez só), webhook de retorno (URL, segredo, teste, entregas e
   reenvio) e a opção de desligar os e-mails de nota da nó (white label). conta.js chama abrir() quando a aba aparece. */
(function () {
  'use strict';
  var nf = window.noFiscal;
  if (!nf) return;
  var ROTA = '/v1/fiscal/emissao';
  var GENERICO = 'Não deu para concluir agora. Tente de novo em alguns minutos.';
  var SITUACAO = { pendente: ['Tentando de novo', ''], entregue: ['Entregue', 'ok'], desistiu: ['Não entregue', 'erro'] };
  var st = { carregado: false, estado: null };
  function $(id) { return document.getElementById(id); }
  function pill(s) { return '<span class="nf-status' + (s[1] ? ' nf-status--' + s[1] : '') + '">' + nf.esc(s[0]) + '</span>'; }
  function dataHora(iso) { return iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'; }

  function abrir() {
    if (st.carregado) return;
    st.carregado = true;
    carregar();
  }
  function carregar() {
    return nf.app(ROTA, { acao: 'integracao' }).then(function (r) {
      if (!r.ok) { st.carregado = false; if (r.status !== 401) nf.aviso($('fa-aviso-api'), nf.esc(r.mensagem || GENERICO), 'erro'); return; }
      st.estado = r.dados;
      desenhar();
    });
  }
  function desenhar() {
    var d = st.estado || {};
    $('fa-api-base').textContent = d.base_url || '';
    $('fa-api-docs').href = d.docs_url || '/agentes/fiscal/dados/api/README.md';
    var c = d.chave;
    $('fa-api-chave-atual').textContent = c
      ? 'Chave em uso: ' + c.prefixo + '… (gerada em ' + dataHora(c.gerada_em) + ').'
      : 'Nenhuma chave gerada ainda.';
    $('fa-api-gerar').textContent = c ? 'Trocar chave' : 'Gerar chave';
    var w = d.webhook || {};
    $('fa-api-url').value = w.url || '';
    $('fa-api-testar').hidden = !w.url;
    $('fa-api-remover').hidden = !w.url;
    $('fa-api-novo-segredo').hidden = !w.url;
    $('fa-api-emails').checked = d.emails_da_no !== false;
    var linhas = (d.entregas || []).map(function (e) {
      var s = SITUACAO[e.status] || [e.status, ''];
      var detalhe = e.status === 'pendente' && e.proxima_em ? 'próxima em ' + dataHora(e.proxima_em)
        : e.ultimo_erro ? e.ultimo_erro : e.ultimo_http ? 'HTTP ' + e.ultimo_http : '';
      return '<tr><td class="nf-nowrap">' + nf.esc(dataHora(e.created_at)) + '</td><td>' + nf.esc(e.evento) + '</td><td>' + pill(s) +
        (detalhe ? '<small class="nf-sub">' + nf.esc(detalhe) + ' · ' + e.tentativas + (e.tentativas === 1 ? ' tentativa' : ' tentativas') + '</small>' : '') +
        '</td><td>' + (e.status === 'pendente' ? '' : '<button type="button" class="fi-link-btn" data-reenviar="' + nf.esc(e.id) + '">Reenviar</button>') + '</td></tr>';
    });
    $('fa-api-entregas').innerHTML = linhas.length ? linhas.join('') : '<tr><td colspan="4">Nenhum evento ainda.</td></tr>';
  }
  function mostrarSegredo(el, rotulo, valor) {
    el.hidden = false;
    el.innerHTML = '<p class="nf-texto"><b>' + nf.esc(rotulo) + '</b> Copie agora: ela não aparece de novo.</p>' +
      '<p class="nf-texto"><code class="nf-codigo-api">' + nf.esc(valor) + '</code> <button type="button" class="fi-link-btn" data-copiar="' + nf.esc(valor) + '">Copiar</button></p>';
  }

  $('fa-api-gerar').addEventListener('click', function () {
    var b = this;
    if (st.estado && st.estado.chave && !window.confirm('A chave atual para de funcionar na hora, e o seu sistema precisa da nova. Trocar?')) return;
    nf.ocupado(b, true, 'Gerando…');
    nf.app(ROTA, { acao: 'chave_gerar' }).then(function (r) {
      nf.ocupado(b, false);
      if (!r.ok) return nf.aviso($('fa-aviso-api'), nf.esc(r.mensagem || GENERICO), 'erro');
      mostrarSegredo($('fa-api-chave-nova'), 'Esta é a chave da API.', r.dados.chave);
      st.estado.chave = { prefixo: r.dados.prefixo, gerada_em: r.dados.gerada_em };
      desenhar();
    });
  });

  function salvarWebhook(novoSegredo) {
    var b = $('fa-api-salvar');
    nf.ocupado(b, true, 'Salvando…');
    return nf.app(ROTA, { acao: 'webhook_salvar', url: $('fa-api-url').value, novo_segredo: novoSegredo === true }).then(function (r) {
      nf.ocupado(b, false);
      if (!r.ok) return nf.aviso($('fa-aviso-webhook'), nf.esc(r.mensagem || GENERICO), 'erro');
      nf.aviso($('fa-aviso-webhook'), 'URL salva.', 'ok');
      if (r.dados.segredo) mostrarSegredo($('fa-api-segredo'), 'Este é o segredo do webhook (HMAC-SHA256).', r.dados.segredo);
      return carregar();
    });
  }
  $('fa-form-webhook').addEventListener('submit', function (ev) { ev.preventDefault(); salvarWebhook(false); });
  $('fa-api-novo-segredo').addEventListener('click', function () {
    if (!window.confirm('O segredo atual deixa de valer na hora. Gerar um novo?')) return;
    salvarWebhook(true);
  });
  $('fa-api-remover').addEventListener('click', function () {
    if (!window.confirm('Sem URL, as notas deixam de ser avisadas ao seu sistema. Remover?')) return;
    nf.app(ROTA, { acao: 'webhook_remover' }).then(function (r) {
      if (!r.ok) return nf.aviso($('fa-aviso-webhook'), nf.esc(r.mensagem || GENERICO), 'erro');
      nf.aviso($('fa-aviso-webhook'), 'URL removida.', 'ok');
      carregar();
    });
  });
  $('fa-api-testar').addEventListener('click', function () {
    var b = this;
    nf.ocupado(b, true, 'Testando…');
    nf.app(ROTA, { acao: 'webhook_testar' }).then(function (r) {
      nf.ocupado(b, false);
      if (!r.ok) return nf.aviso($('fa-aviso-webhook'), nf.esc(r.mensagem || GENERICO), 'erro');
      nf.aviso($('fa-aviso-webhook'), r.dados.ok
        ? 'Seu sistema respondeu ' + r.dados.http + '. O webhook está funcionando.'
        : nf.esc('Não funcionou: ' + (r.dados.erro || 'sem resposta') + '.'), r.dados.ok ? 'ok' : 'erro');
    });
  });
  $('fa-api-entregas').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-reenviar]');
    if (!b) return;
    nf.ocupado(b, true, 'Reenviando…');
    nf.app(ROTA, { acao: 'webhook_reenviar', entrega_id: b.getAttribute('data-reenviar') }).then(function (r) {
      nf.ocupado(b, false);
      if (!r.ok) return nf.aviso($('fa-aviso-webhook'), nf.esc(r.mensagem || GENERICO), 'erro');
      nf.aviso($('fa-aviso-webhook'), 'O evento volta para a fila e sai na próxima rodada (em até um minuto).', 'ok');
      carregar();
    });
  });
  $('fa-api-emails').addEventListener('change', function () {
    var caixa = this, ativo = caixa.checked;
    nf.app(ROTA, { acao: 'emails_da_no', ativo: ativo }).then(function (r) {
      if (!r.ok) { caixa.checked = !ativo; return nf.aviso($('fa-aviso-emails'), nf.esc(r.mensagem || GENERICO), 'erro'); }
      nf.aviso($('fa-aviso-emails'), ativo ? 'A nó volta a mandar as notas por e-mail.' : 'Pronto: a nó não manda mais e-mail de nota. O seu sistema entrega.', 'ok');
    });
  });
  $('fa-painel-api').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-copiar]');
    if (!b || !navigator.clipboard) return;
    navigator.clipboard.writeText(b.getAttribute('data-copiar')).then(function () { b.textContent = 'Copiado'; });
  });

  window.contaApi = { abrir: abrir, desatualizar: function () { st.carregado = false; } };
  // Entrou direto em #api: conta.js já mostrou a aba antes deste arquivo carregar.
  if (!$('fa-painel-api').hidden) abrir();
})();
