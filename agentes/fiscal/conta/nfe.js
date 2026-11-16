/* Aba "NF-e" do painel Minha conta (conta Escritório), sobre /v1/fiscal/nfe (app/api/_lib/nfe/painel-nfe.ts).
   Dados da empresa para NF-e (IE, endereço, série e próximo número), planilha (conferir e emitir), lista com DANFE,
   XML, cancelamento, carta de correção e inutilização do número de nota rejeitada. conta.js chama abrir() quando a
   aba aparece. */
(function () {
  'use strict';
  var nf = window.noFiscal;
  if (!nf) return;
  var ROTA = '/v1/fiscal/nfe';
  var GENERICO = 'Não deu para concluir agora. Tente de novo em alguns minutos.';
  var SITUACAO = {
    queued: ['Na fila', ''], sending: ['Enviando', ''], processing: ['Em processamento', ''],
    authorized: ['Autorizada', 'ok'], denied: ['Denegada', 'erro'], rejected: ['Rejeitada', 'erro'],
    cancel_requested: ['Cancelamento pedido', ''], cancelled: ['Cancelada', 'off'], voided: ['Número inutilizado', 'off']
  };
  var st = { carregado: false, empresas: [], arquivo: null, pedida: null };
  function $(id) { return document.getElementById(id); }
  function empresa(id) {
    for (var i = 0; i < st.empresas.length; i++) if (st.empresas[i].tenant_id === id) return st.empresas[i];
    return null;
  }
  function reais(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pill(s) { return '<span class="nf-status' + (s[1] ? ' nf-status--' + s[1] : '') + '">' + nf.esc(s[0]) + '</span>'; }

  function abrir() {
    if (st.carregado) return;
    st.carregado = true;
    carregar().then(listar);
  }
  function carregar() {
    return nf.app(ROTA, { acao: 'contexto' }).then(function (r) {
      if (!r.ok) { st.carregado = false; if (r.status !== 401) nf.aviso($('fa-aviso-nfe'), nf.esc(r.mensagem || GENERICO), 'erro'); return; }
      desenharContexto(r.dados);
    });
  }
  function desenharContexto(d) {
    st.empresas = d.empresas || [];
    var f = d.franquia || {};
    $('fa-nfe-franquia').textContent = 'Notas do mês (serviço e produto): ' + (f.no_mes || 0) + ' de ' + (f.limite || 0) + '.';
    var sel = $('fa-nfe-empresa'), antes = sel.value;
    sel.innerHTML = st.empresas.map(function (e) {
      return '<option value="' + nf.esc(e.tenant_id) + '">' + nf.esc(e.razao_social + ' · ' + nf.formatarCnpj(e.cnpj)) + '</option>';
    }).join('');
    if (st.pedida && empresa(st.pedida)) { sel.value = st.pedida; st.pedida = null; } else if (antes && empresa(antes)) sel.value = antes;
    preencherDados();
  }
  function preencherDados() {
    var e = empresa($('fa-nfe-empresa').value) || {};
    var end = e.endereco || {};
    $('fa-nfe-ie').value = e.inscricao_estadual || '';
    $('fa-nfe-cep').value = end.cep || '';
    $('fa-nfe-logradouro').value = end.logradouro || '';
    $('fa-nfe-numero').value = end.numero || '';
    $('fa-nfe-complemento').value = end.complemento || '';
    $('fa-nfe-bairro').value = end.bairro || '';
    $('fa-nfe-uf').value = end.uf || '';
    $('fa-nfe-fone').value = end.fone || '';
    $('fa-nfe-serie').value = e.serie === null || e.serie === undefined ? '1' : String(e.serie);
    $('fa-nfe-proximo').value = e.proximo_numero ? String(e.proximo_numero) : '1';
    var b = e.bloqueio;
    nf.aviso($('fa-nfe-bloqueio'), b ? nf.esc('Esta empresa ainda não emite NF-e: ' + b.motivo + '.') : (e.tenant_id ? 'Pronta para emitir NF-e' + (e.ambiente === 'homologacao' ? ' (em homologação, sem valor fiscal).' : '.') : ''), b ? 'erro' : 'ok');
    $('fa-nfe-regime').textContent = e.tenant_id ? 'Regime: ' + (e.crt === '4' ? 'MEI (CRT 4)' : 'Simples Nacional (CRT 1)') + '. A NF-e sai assinada com o A1 desta empresa' + (e.modo_nfse === 'procuracao' ? '; a NFS-e dela continua pela procuração.' : '.') : '';
    $('fa-nfe-a1-atual').textContent = e.certificado
      ? 'Certificado A1 gravado, válido até ' + new Date(e.certificado.not_after).toLocaleDateString('pt-BR') + (e.modo_nfse === 'procuracao' ? ' (usado só na NF-e).' : '.')
      : 'Nenhum certificado A1 desta empresa gravado.';
    var c = e.conferencia;
    var textoConf = !c ? 'Ainda não conferida na Sefaz.'
      : c.status === 'aprovada' ? 'Conferida: a nota de teste foi autorizada' + (c.conferida_em ? ' em ' + new Date(c.conferida_em).toLocaleDateString('pt-BR') : '') + '.'
      : c.status === 'pendente' ? 'Conferência pendente.'
      : 'Última conferência: ' + (c.motivo || c.codigo) + '.';
    nf.aviso($('fa-nfe-conferencia'), nf.esc(textoConf), !c || c.status === 'pendente' ? '' : c.status === 'aprovada' ? 'ok' : 'erro');
  }
  function conferir() {
    var id = $('fa-nfe-empresa').value;
    if (!id) return Promise.resolve();
    var botao = $('fa-nfe-conferir');
    nf.ocupado(botao, true, 'Conferindo na Sefaz…');
    return nf.app(ROTA, { acao: 'conferir', tenant_id: id }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) { desenharContexto(r.dados); return; }
      if (r.status !== 401) nf.aviso($('fa-nfe-conferencia'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }
  function enviarA1(ev) {
    ev.preventDefault();
    nf.erroCampo('fa-nfe-pfx', ''); nf.erroCampo('fa-nfe-pfx-senha', '');
    var arquivo = $('fa-nfe-pfx').files && $('fa-nfe-pfx').files[0], senha = $('fa-nfe-pfx-senha').value;
    if (!arquivo) { nf.erroCampo('fa-nfe-pfx', 'Escolha o arquivo do certificado.'); return; }
    if (!senha) { nf.erroCampo('fa-nfe-pfx-senha', 'Informe a senha do certificado.'); return; }
    var form = new FormData();
    form.append('tenant_id', $('fa-nfe-empresa').value);
    form.append('pfx', arquivo, arquivo.name || 'certificado.pfx');
    form.append('senha', senha);
    form.append('uso', 'nfe');
    var botao = $('fa-nfe-enviar-a1');
    nf.ocupado(botao, true, 'Enviando…');
    nf.app('/v1/onboarding/certificate', form).then(function (r) {
      nf.ocupado(botao, false);
      $('fa-nfe-pfx-senha').value = '';
      if (!r.ok) {
        if (r.status === 401) return;
        var msg = r.codigo === 'CERT_CNPJ_DIFERENTE' ? 'Este certificado não é desta empresa (nem da matriz dela).'
          : r.codigo === 'CERT_SENHA_INVALIDA' ? 'A senha não abre este certificado.'
          : r.codigo === 'CERT_VENCIDO' ? 'Este certificado está vencido.'
          : (r.mensagem || GENERICO);
        nf.erroCampo('fa-nfe-pfx', msg);
        return;
      }
      $('fa-nfe-pfx').value = '';
      // Com o A1 gravado, a conferência roda em seguida.
      conferir();
    });
  }
  function salvarDados(ev) {
    ev.preventDefault();
    var botao = $('fa-nfe-salvar');
    nf.ocupado(botao, true, 'Salvando…');
    nf.app(ROTA, {
      acao: 'dados_salvar', tenant_id: $('fa-nfe-empresa').value, inscricao_estadual: $('fa-nfe-ie').value,
      endereco: {
        logradouro: $('fa-nfe-logradouro').value, numero: $('fa-nfe-numero').value, complemento: $('fa-nfe-complemento').value,
        bairro: $('fa-nfe-bairro').value, cep: $('fa-nfe-cep').value, uf: $('fa-nfe-uf').value, fone: $('fa-nfe-fone').value
      },
      serie: $('fa-nfe-serie').value, proximo_numero: $('fa-nfe-proximo').value
    }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) {
        desenharContexto(r.dados);
        nf.aviso($('fa-aviso-nfe'), 'Dados da NF-e salvos.', 'ok');
        // Dados novos pedem conferência nova; com o A1 gravado, ela roda em seguida.
        var e = empresa($('fa-nfe-empresa').value);
        if (e && e.certificado && e.bloqueio && /CONFERI|NAO_CONFERIDA/.test(e.bloqueio.codigo)) conferir();
        return;
      }
      if (r.status !== 401) nf.aviso($('fa-nfe-bloqueio'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  /* ---------- planilha ---------- */
  function formulario(acao) {
    var form = new FormData();
    form.append('acao', acao);
    form.append('arquivo', st.arquivo, st.arquivo.name);
    return form;
  }
  function conferir(ev) {
    ev.preventDefault();
    nf.erroCampo('fa-nfe-arquivo', '');
    var a = $('fa-nfe-arquivo').files && $('fa-nfe-arquivo').files[0];
    if (!a) { nf.erroCampo('fa-nfe-arquivo', 'Escolha a planilha (.xlsx ou .csv).'); return; }
    if (!/\.(xlsx|csv)$/i.test(a.name || '')) { nf.erroCampo('fa-nfe-arquivo', 'Envie a planilha em .xlsx ou .csv.'); return; }
    if (a.size > 4 * 1024 * 1024) { nf.erroCampo('fa-nfe-arquivo', 'A planilha passou de 4 MB. Divida em duas.'); return; }
    st.arquivo = a;
    var botao = $('fa-nfe-ler');
    nf.ocupado(botao, true, 'Conferindo…');
    $('fa-nfe-resumo').hidden = true;
    nf.app(ROTA, formulario('planilha_ler')).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) nf.erroCampo('fa-nfe-arquivo', r.mensagem || GENERICO); return; }
      desenharResumo(r.dados, false);
    });
  }
  function desenharResumo(d, emitido) {
    var notas = d.notas || [], problemas = d.problemas || [];
    var total = notas.reduce(function (s, n) { return s + Number(n.valor || 0); }, 0);
    var f = d.franquia || {};
    $('fa-nfe-resumo-texto').textContent = emitido
      ? (d.emitindo || 0) + ' NF-e na fila de emissão. Acompanhe na lista abaixo.'
      : notas.length + (notas.length === 1 ? ' NF-e pronta' : ' NF-e prontas') + ' (R$ ' + reais(total) + ')' +
        (problemas.length ? '; ' + problemas.length + (problemas.length === 1 ? ' problema' : ' problemas') + ' (as notas com problema ficam de fora)' : '') +
        '. Franquia: ' + (f.no_mes || 0) + ' de ' + (f.limite || 0) + ' notas no mês.';
    $('fa-nfe-problemas').innerHTML = problemas.slice(0, 30).map(function (p) {
      return '<li>' + nf.esc((p.linha ? 'Linha ' + p.linha + (p.nota ? ' (nota ' + p.nota + ')' : '') + ': ' : '') + p.mensagem) + '</li>';
    }).join('') + (problemas.length > 30 ? '<li>e mais ' + (problemas.length - 30) + '</li>' : '');
    $('fa-nfe-emitir').hidden = emitido || notas.length === 0;
    $('fa-nfe-resumo').hidden = false;
  }
  function emitir() {
    if (!st.arquivo) return;
    var botao = $('fa-nfe-emitir');
    nf.ocupado(botao, true, 'Emitindo…');
    nf.app(ROTA, formulario('planilha_emitir')).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-aviso-nfe'), nf.esc(r.mensagem || GENERICO), 'erro'); return; }
      desenharResumo(r.dados, true);
      listar();
    });
  }

  /* ---------- lista ---------- */
  function listar() {
    return nf.app(ROTA, { acao: 'listar' }).then(function (r) {
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-aviso-nfe'), nf.esc(r.mensagem || GENERICO), 'erro'); return; }
      var notas = r.dados.notas || [];
      $('fa-nfe-vazio').hidden = notas.length > 0;
      $('fa-nfe-rolagem').hidden = notas.length === 0;
      $('fa-nfe-linhas').innerHTML = notas.map(linha).join('');
    });
  }
  function linha(n) {
    var e = empresa(n.tenant_id) || {};
    var s = SITUACAO[n.status] || [n.status, ''];
    var temArquivo = ['authorized', 'cancel_requested', 'cancelled', 'denied'].indexOf(n.status) >= 0;
    var arquivos = temArquivo
      ? '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-nfe-baixar="danfe" data-nfe="' + nf.esc(n.nfe_id) + '">DANFE</button> ' +
        '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-nfe-baixar="xml" data-nfe="' + nf.esc(n.nfe_id) + '">XML</button>'
      : '—';
    var acoes = n.status === 'authorized'
      ? '<button type="button" class="fi-link-btn" data-nfe-acao="corrigir" data-nfe="' + nf.esc(n.nfe_id) + '">Carta de correção</button> ' +
        '<button type="button" class="fi-link-btn" data-nfe-acao="cancelar" data-nfe="' + nf.esc(n.nfe_id) + '">Cancelar</button>'
      : n.status === 'rejected'
        ? '<button type="button" class="fi-link-btn" data-nfe-acao="inutilizar" data-nfe="' + nf.esc(n.nfe_id) + '">Inutilizar número</button>'
        : '';
    var erro = n.erro && ['rejected', 'denied', 'queued', 'sending'].indexOf(n.status) >= 0
      ? '<br><small>' + nf.esc(n.erro.codigo + (n.erro.motivo ? ': ' + n.erro.motivo : '')) + '</small>' : '';
    return '<tr><td>' + nf.esc(n.serie + '-' + n.numero) + (n.homologacao ? ' <small>(homologação)</small>' : '') + '</td>' +
      '<td>' + nf.esc(e.razao_social || '') + '</td><td>' + nf.esc(n.destinatario) + '</td>' +
      '<td class="nf-num">' + reais(n.valor) + '</td><td>' + pill(s) + erro + (n.cartas_de_correcao ? '<br><small>' + n.cartas_de_correcao + ' carta(s) de correção</small>' : '') + '</td>' +
      '<td>' + arquivos + '</td><td>' + acoes + '</td></tr>';
  }
  var PERGUNTA = {
    cancelar: 'Por que cancelar esta NF-e? (de 15 a 255 caracteres; o prazo para cancelar é definido pela Sefaz do estado)',
    corrigir: 'O que a carta de correção corrige? (de 15 a 1.000 caracteres; não vale para valores, impostos, quantidade, emitente, destinatário ou data)',
    inutilizar: 'Justificativa para inutilizar o número desta nota rejeitada (de 15 a 255 caracteres)'
  };
  function clique(ev) {
    var b = ev.target.closest && ev.target.closest('[data-nfe]');
    if (!b) return;
    var id = b.getAttribute('data-nfe');
    var tipo = b.getAttribute('data-nfe-baixar');
    if (tipo) {
      nf.ocupado(b, true, '…');
      nf.appArquivo(ROTA, { baixar: tipo, nfe_id: id }).then(function (r) {
        nf.ocupado(b, false);
        if (r.ok && r.blob) { nf.baixarArquivo(r.blob, r.nome || (tipo === 'xml' ? 'nfe.xml' : 'danfe.pdf')); return; }
        if (r.status !== 401) nf.aviso($('fa-aviso-nfe'), nf.esc(r.mensagem || GENERICO), 'erro');
      });
      return;
    }
    var acao = b.getAttribute('data-nfe-acao');
    var texto = window.prompt(PERGUNTA[acao] || '');
    if (!texto) return;
    nf.app(ROTA, { acao: acao, nfe_id: id, texto: texto }).then(function (r) {
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-aviso-nfe'), nf.esc(r.mensagem || GENERICO), 'erro'); return; }
      nf.aviso($('fa-aviso-nfe'), 'Pedido enviado à Sefaz. A situação muda na lista em instantes.', 'ok');
      listar();
    });
  }

  $('fa-nfe-empresa').addEventListener('change', preencherDados);
  $('fa-form-nfe-dados').addEventListener('submit', salvarDados);
  $('fa-form-nfe-planilha').addEventListener('submit', conferir);
  $('fa-nfe-emitir').addEventListener('click', emitir);
  $('fa-nfe-atualizar').addEventListener('click', listar);
  $('fa-form-nfe-a1').addEventListener('submit', enviarA1);
  $('fa-nfe-conferir').addEventListener('click', conferir);
  // Botão NF-e na linha da empresa (Minhas empresas): abre a aba já nela.
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-nfe-empresa]');
    if (!b) return;
    st.pedida = b.getAttribute('data-nfe-empresa');
    if (st.carregado && empresa(st.pedida)) { $('fa-nfe-empresa').value = st.pedida; st.pedida = null; preencherDados(); }
  });
  $('fa-nfe-linhas').addEventListener('click', clique);
  // Outra conta entrou (sair e entrar de novo): recarrega na próxima vez que a aba abrir.
  window.addEventListener('nofiscal:sessao-vencida', function () { st.carregado = false; });
  window.contaNfe = { abrir: abrir };
  // Entrou direto em #nfe: conta.js já mostrou a aba antes deste arquivo carregar.
  if (!$('fa-painel-nfe').hidden) abrir();
})();
