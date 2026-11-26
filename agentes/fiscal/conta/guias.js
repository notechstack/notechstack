/* Aba "Guias" do painel Minha conta (módulo Guias, conta Escritório com o módulo ligado), sobre /v1/fiscal/guias
   (app/api/_lib/guias/painel.ts). A aba só aparece quando a API diz que o módulo está ligado. Telas: Enviar e conferir
   (upload direto ao Storage por URL assinada, leitura, conferência verde/amarela/vermelha, criar contato, disparar
   agora ou agendar), Acompanhar (por guia, filtro por mês, CSV, uso do mês), Clientes (CSV, editar, desativar,
   aceite) e Ajustes. conta.js chama verificar() ao desenhar o escritório e abrir() quando a aba aparece. */
(function () {
  'use strict';
  var nf = window.noFiscal;
  if (!nf) return;
  var ROTA = '/v1/fiscal/guias';
  var GENERICO = 'Não deu para concluir agora. Tente de novo em alguns minutos.';
  var MAX_ARQUIVOS = 500, POR_PEDIDO = 50, PARALELOS = 4;
  var TIPOS = [['das', 'DAS'], ['das_mei', 'DAS-MEI'], ['darf', 'DARF'], ['dctfweb', 'DARF DCTFWeb'], ['fgts', 'FGTS'], ['iss', 'ISS'], ['parcelamento', 'Parcelamento'], ['honorario', 'Honorários'], ['outro', 'Outro']];
  var COR = { verde: ['Verde', 'verde'], amarelo: ['Amarela', 'amarelo'], vermelho: ['Vermelha', 'vermelho'] };
  var SITUACAO = {
    agendada: ['Agendada', ''], enviada: ['Enviada', ''], entregue: ['Entregue', 'ok'], lida: ['Lida', 'ok'], baixada: ['Baixada', 'ok'],
    paga_informada: ['Paga (informada)', 'ok'], paga: ['Paga', 'ok'], falhou: ['Falhou', 'erro'], cancelada: ['Cancelada', 'off'], vencida: ['Vencida', 'erro']
  };
  var CANAL = { pendente: 'enviando', enviada: 'enviada', entregue: 'entregue', lida: 'lida', falhou: 'falhou' };
  var st = { ligado: false, verificando: null, carregado: false, estado: null, tela: 'enviar', loteId: null, guias: [], contatos: [], enviando: false, criarPara: null };
  function $(id) { return document.getElementById(id); }
  function pill(s) { return '<span class="nf-status' + (s[1] ? ' nf-status--' + s[1] : '') + '">' + nf.esc(s[0]) + '</span>'; }
  function reais(c) { return c === null || c === undefined ? '' : (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function dataBr(iso) { return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : ''; }
  function docFmt(d) { return !d ? '' : d.length === 14 ? nf.formatarCnpj(d) : d.slice(0, 3) + '.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-' + d.slice(9); }
  function erroDe(r) { return r.mensagem || GENERICO; }
  function mesAtual() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }

  /* ---------- módulo ligado? ---------- */
  function verificar(escritorio) {
    if (!escritorio) { esconder(); return Promise.resolve(false); }
    if (st.verificando) return st.verificando;
    st.verificando = nf.app(ROTA, { acao: 'estado' }).then(function (r) {
      st.verificando = null;
      if (!r.ok || !r.dados.ligado) { esconder(); return false; }
      st.ligado = true;
      st.estado = r.dados;
      $('fa-aba-guias').hidden = false;
      desenharUso(r.dados.uso);
      desenharMensalidades(r.dados);
      // Entrou direto em #guias: a aba só existe agora.
      if (location.hash === '#guias' && window.contaAbas && window.contaAbas.atual() !== 'guias') window.contaAbas.mostrar('guias', { hash: false });
      return true;
    });
    return st.verificando;
  }
  /* Meus dados: "nó.fiscal Escritório" e "nó.fiscal Guias", cada uma com valor e próxima cobrança. */
  function desenharMensalidades(d) {
    var el = $('fa-plano-mensalidades'), c = d.cobranca, p = window.contaPlano || {};
    var guias;
    if (!c) guias = 'Sem mensalidade (piloto)';
    else if (c.status === 'cancelada' || c.status === 'cancelamento_pedido') guias = 'Cancelada';
    else {
      guias = nf.reais(c.valor_atual_centavos) + '/mês' +
        (c.valor_atual_centavos !== c.valor_centavos && c.desconto_ciclos_restantes ? ' nas próximas ' + c.desconto_ciclos_restantes + ' cobranças, depois ' + nf.reais(c.valor_centavos) : '') +
        (d.bloqueio ? ' · pagamento recusado: o disparo está bloqueado' : c.proxima_cobranca ? ' · próxima cobrança ' + nf.dataBR(c.proxima_cobranca) : '');
    }
    var linhas = [['nó.fiscal Escritório', (p.valor || '—') + (p.proxima ? ' · próxima cobrança ' + p.proxima : '')], ['nó.fiscal Guias', guias]];
    el.innerHTML = linhas.map(function (l) { return '<dt>' + nf.esc(l[0]) + '</dt><dd>' + nf.esc(l[1]) + '</dd>'; }).join('');
    el.hidden = false;
  }
  function esconder() {
    st.ligado = false;
    if ($('fa-plano-mensalidades')) $('fa-plano-mensalidades').hidden = true;
    $('fa-aba-guias').hidden = true;
    $('fa-painel-guias').hidden = true;
    if (window.contaAbas && window.contaAbas.atual() === 'guias') window.contaAbas.mostrar('dados', { hash: false });
  }
  function desenharUso(u) {
    if (!u) return;
    $('fa-guias-uso').textContent = 'Guias enviadas no mês: ' + u.enviadas + ' de ' + u.limite + ' (' + u.percentual + '%).';
    var av = $('fa-aviso-guias');
    if (u.aviso === '100') nf.aviso(av, 'Você chegou ao limite de guias do mês. Os envios continuam no piloto; fale com a nó para ajustar a faixa.', 'erro');
    else if (u.aviso === '80') nf.aviso(av, 'Você já usou 80% das guias do mês.', 'info');
    else nf.aviso(av, '');
  }

  function abrir() {
    if (!st.ligado) return;
    if (st.carregado) return;
    st.carregado = true;
    preencherAjustes();
    $('fa-guias-mes').value = mesAtual();
    carregarLotes();
    mostrarTela(st.tela);
  }

  /* ---------- telas ---------- */
  function mostrarTela(t) {
    st.tela = t;
    ['enviar', 'acompanhar', 'clientes', 'ajustes'].forEach(function (x) {
      $('fa-guias-tela-' + x).hidden = x !== t;
      var b = document.querySelector('[data-guias-tela="' + x + '"]');
      b.setAttribute('aria-pressed', x === t ? 'true' : 'false');
      b.className = 'fi-btn nf-btn-mini ' + (x === t ? 'fi-btn--tinta' : 'fi-btn--borda');
    });
    if (t === 'acompanhar') acompanhar();
    if (t === 'clientes') listarContatos();
  }

  /* ---------- Enviar: upload direto ao Storage ---------- */
  function carregarLotes(escolher) {
    return nf.app(ROTA, { acao: 'lotes_listar' }).then(function (r) {
      if (!r.ok) return;
      var lotes = r.dados.lotes || [];
      $('fa-guias-lotes-campo').hidden = !lotes.length;
      $('fa-guias-lote').innerHTML = lotes.map(function (l) {
        return '<option value="' + nf.esc(l.id) + '">' + nf.esc(new Date(l.criado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) + ' · ' + l.total_arquivos + ' PDFs · ' + rotuloLote(l)) + '</option>';
      }).join('');
      var alvo = escolher || (lotes[0] && lotes[0].id);
      if (alvo) { $('fa-guias-lote').value = alvo; verLote(alvo); }
    });
  }
  function rotuloLote(l) {
    return l.status === 'disparado' ? 'disparado' : l.status === 'lendo' || l.status === 'enviando' ? 'lendo' : (l.com_problema ? l.com_problema + ' para conferir' : 'pronto');
  }

  function subir(ev) {
    ev.preventDefault();
    if (st.enviando) return;
    nf.erroCampo('fa-guias-arquivos', '');
    var arquivos = Array.prototype.slice.call($('fa-guias-arquivos').files || []);
    if (!arquivos.length) { nf.erroCampo('fa-guias-arquivos', 'Escolha os PDFs das guias.'); return; }
    if (arquivos.length > MAX_ARQUIVOS) { nf.erroCampo('fa-guias-arquivos', 'No máximo ' + MAX_ARQUIVOS + ' PDFs por lote.'); return; }
    var ruins = arquivos.filter(function (f) { return !/\.pdf$/i.test(f.name) || f.size > 10 * 1024 * 1024; });
    if (ruins.length) { nf.erroCampo('fa-guias-arquivos', 'Só PDFs de até 10 MB: ' + ruins.slice(0, 3).map(function (f) { return f.name; }).join(', ') + (ruins.length > 3 ? '…' : '')); return; }
    st.enviando = true;
    var botao = $('fa-guias-subir'), prog = $('fa-guias-progresso');
    nf.ocupado(botao, true, 'Enviando…');
    var subidos = 0, falhas = 0;
    function progresso(t) { nf.aviso(prog, nf.esc(t), 'info'); }
    progresso('Preparando o lote…');
    nf.app(ROTA, { acao: 'lote_criar', total: arquivos.length }).then(function (r) {
      if (!r.ok) throw r;
      var loteId = r.dados.lote_id, blocos = [];
      for (var i = 0; i < arquivos.length; i += POR_PEDIDO) blocos.push(arquivos.slice(i, i + POR_PEDIDO));
      return blocos.reduce(function (anterior, bloco) {
        return anterior.then(function () {
          return nf.app(ROTA, { acao: 'lote_arquivos', lote_id: loteId, arquivos: bloco.map(function (f) { return { nome: f.name, tamanho: f.size }; }) }).then(function (u) {
            if (!u.ok) throw u;
            var itens = u.dados.arquivos.map(function (a, k) { return { a: a, f: bloco[k] }; }), ok = [];
            // PUT direto no Storage (o PDF nunca passa pela API), PARALELOS por vez.
            function proximo() {
              var item = itens.shift();
              if (!item) return Promise.resolve();
              return fetch(item.a.url, { method: 'PUT', headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body: item.f })
                .then(function (res) { if (res.ok) { ok.push(item.a.guia_id); subidos++; } else falhas++; }, function () { falhas++; })
                .then(function () { progresso('Enviando PDFs: ' + subidos + ' de ' + arquivos.length + (falhas ? ' (' + falhas + ' com falha)' : '') + '…'); return proximo(); });
            }
            var corredores = [];
            for (var p = 0; p < PARALELOS; p++) corredores.push(proximo());
            return Promise.all(corredores).then(function () {
              return nf.app(ROTA, { acao: 'lote_confirmar', lote_id: loteId, guia_ids: ok });
            });
          });
        });
      }, Promise.resolve()).then(function () {
        return nf.app(ROTA, { acao: 'lote_confirmar', lote_id: loteId, guia_ids: [], fim: true });
      }).then(function () { return lerTudo(loteId); });
    }).then(function (loteId) {
      st.enviando = false;
      nf.ocupado(botao, false);
      $('fa-guias-arquivos').value = '';
      progresso(subidos + ' PDFs enviados e lidos' + (falhas ? '; ' + falhas + ' não subiram (envie de novo)' : '') + '. Confira abaixo.');
      return carregarLotes(loteId);
    }).catch(function (r) {
      st.enviando = false;
      nf.ocupado(botao, false);
      if (r && r.status === 401) return;
      nf.aviso(prog, nf.esc((r && r.mensagem) || GENERICO), 'erro');
    });
  }
  /* Lê no servidor, 4 por pedido, até não sobrar nada (o worker também lê o que ficar). */
  function lerTudo(loteId, voltas) {
    voltas = voltas || 0;
    return nf.app(ROTA, { acao: 'ler', lote_id: loteId }).then(function (r) {
      if (!r.ok) throw r;
      nf.aviso($('fa-guias-progresso'), nf.esc('Lendo as guias… faltam ' + r.dados.pendentes + '.'), 'info');
      if (r.dados.pendentes > 0 && voltas < 200) return lerTudo(loteId, voltas + 1);
      return loteId;
    });
  }

  /* ---------- Conferência ---------- */
  function verLote(id) {
    st.loteId = id;
    return nf.app(ROTA, { acao: 'lote_ver', lote_id: id }).then(function (r) {
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-aviso-guias'), nf.esc(erroDe(r)), 'erro'); return; }
      st.guias = r.dados.guias || [];
      desenharConferencia(r.dados.lote);
    });
  }
  function opcoesTipo(atual) {
    return '<option value="">—</option>' + TIPOS.map(function (t) { return '<option value="' + t[0] + '"' + (t[0] === atual ? ' selected' : '') + '>' + t[1] + '</option>'; }).join('');
  }
  function desenharConferencia(lote) {
    $('fa-guias-conferencia').hidden = false;
    var cont = { verde: 0, amarelo: 0, vermelho: 0, outras: 0 };
    $('fa-guias-conf-linhas').innerHTML = st.guias.map(function (g) {
      var editavel = g.status === 'conferir' || g.status === 'falhou';
      if (editavel && g.cor) cont[g.cor]++; else cont.outras++;
      var sit = editavel ? pill(COR[g.cor] || ['Lendo', '']) : pill(SITUACAO[g.status] || [g.status, '']);
      var dis = editavel ? '' : ' disabled';
      var cliente = g.contato ? nf.esc(g.contato.nome) : '<span class="nf-sub">sem contato</span>';
      var criar = editavel && !g.contato && g.documento ? ' <button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-guia-criar="' + nf.esc(g.id) + '">Criar contato</button>' : '';
      return '<tr data-guia="' + nf.esc(g.id) + '">' +
        '<td><input type="checkbox" aria-label="Disparar ' + nf.esc(g.arquivo) + '" data-guia-marcar' + (editavel && g.cor === 'verde' ? ' checked' : ' disabled') + '></td>' +
        '<td>' + sit + (g.motivo && editavel ? '<span class="nf-sub">' + nf.esc(g.motivo) + '</span>' : '') + '</td>' +
        '<td><span class="nf-sub">' + nf.esc(g.arquivo) + '</span>' + cliente + criar + '</td>' +
        '<td><select data-campo="tipo" aria-label="Tipo"' + dis + '>' + opcoesTipo(g.tipo) + '</select></td>' +
        '<td><input data-campo="documento" aria-label="CNPJ ou CPF" inputmode="numeric" value="' + nf.esc(docFmt(g.documento)) + '"' + dis + '></td>' +
        '<td><input data-campo="competencia" aria-label="Competência" type="month" value="' + nf.esc(g.competencia || '') + '"' + dis + '></td>' +
        '<td><input data-campo="valor" aria-label="Valor" inputmode="decimal" value="' + nf.esc(reais(g.valor_centavos)) + '"' + dis + '>' + (g.valor_codigo_barras && g.valor_codigo_barras !== g.valor_centavos ? '<span class="nf-sub">Código de barras: ' + nf.esc(reais(g.valor_codigo_barras)) + '</span>' : '') + '</td>' +
        '<td><input data-campo="vencimento" aria-label="Vencimento" type="date" value="' + nf.esc(g.vencimento || '') + '"' + dis + '></td>' +
        '<td><input class="nf-linha-digitavel" data-campo="linha_digitavel" aria-label="Linha digitável" inputmode="numeric" value="' + nf.esc(g.linha_digitavel || '') + '"' + dis + '></td>' +
        '<td class="nf-acoes-linha">' + (editavel ? '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-guia-salvar>Salvar</button><button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-guia-cancelar>Descartar</button>' : '') + '</td></tr>';
    }).join('');
    $('fa-guias-conf-resumo').textContent = st.guias.length + ' guias no lote: ' + cont.verde + ' verdes, ' + cont.amarelo + ' amarelas, ' + cont.vermelho + ' vermelhas' + (cont.outras ? ', ' + cont.outras + ' já agendadas ou enviadas' : '') + '.';
    atualizarDisparo();
  }
  function marcadas() {
    return Array.prototype.slice.call(document.querySelectorAll('#fa-guias-conf-linhas input[data-guia-marcar]:checked')).map(function (c) { return c.closest('tr').getAttribute('data-guia'); });
  }
  function atualizarDisparo() {
    var n = marcadas().length;
    $('fa-guias-disparar').disabled = n === 0;
    $('fa-guias-disparar').textContent = n ? 'Disparar ' + n + (n === 1 ? ' guia' : ' guias') : 'Disparar';
  }
  function guiaPorId(id) { for (var i = 0; i < st.guias.length; i++) if (st.guias[i].id === id) return st.guias[i]; return null; }
  function salvarGuia(tr, botao) {
    var g = guiaPorId(tr.getAttribute('data-guia'));
    if (!g) return;
    var campos = {};
    tr.querySelectorAll('[data-campo]').forEach(function (el) {
      var c = el.getAttribute('data-campo'), v = el.value.trim();
      var antes = c === 'valor' ? reais(g.valor_centavos) : c === 'documento' ? docFmt(g.documento) : (g[c] || '');
      if (v !== antes) campos[c] = v;
    });
    if (!Object.keys(campos).length) return;
    nf.ocupado(botao, true, 'Salvando…');
    nf.app(ROTA, { acao: 'guia_editar', guia_id: g.id, campos: campos }).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-guias-disparo-aviso'), nf.esc(erroDe(r)), 'erro'); return; }
      nf.aviso($('fa-guias-disparo-aviso'), '');
      verLote(st.loteId);
    });
  }
  function cancelarGuia(tr, botao) {
    nf.ocupado(botao, true, '…');
    nf.app(ROTA, { acao: 'guia_cancelar', guia_id: tr.getAttribute('data-guia') }).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-guias-disparo-aviso'), nf.esc(erroDe(r)), 'erro'); return; }
      verLote(st.loteId);
    });
  }
  function abrirCriar(id) {
    var g = guiaPorId(id);
    if (!g) return;
    st.criarPara = g;
    $('fa-form-guias-contato-rapido').hidden = false;
    $('fa-guias-cr-titulo').textContent = 'Criar contato para ' + g.arquivo;
    $('fa-guias-cr-doc').value = docFmt(g.documento);
    ['fa-guias-cr-nome', 'fa-guias-cr-whatsapp', 'fa-guias-cr-email'].forEach(function (x) { $(x).value = ''; });
    $('fa-guias-cr-aceite').checked = false;
    nf.aviso($('fa-guias-cr-aviso'), '');
    $('fa-guias-cr-nome').focus();
  }
  function criarRapido(ev) {
    ev.preventDefault();
    if (!$('fa-guias-cr-aceite').checked) { nf.aviso($('fa-guias-cr-aviso'), 'Confirme que o cliente autorizou receber as guias.', 'erro'); return; }
    var botao = $('fa-guias-cr-salvar');
    nf.ocupado(botao, true, 'Salvando…');
    nf.app(ROTA, { acao: 'contato_salvar', contato: {
      documento: $('fa-guias-cr-doc').value, nome: $('fa-guias-cr-nome').value, whatsapps: $('fa-guias-cr-whatsapp').value, emails: $('fa-guias-cr-email').value,
      aceite_origem: 'Declarado na conferência das guias'
    } }).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-guias-cr-aviso'), nf.esc(erroDe(r)), 'erro'); return; }
      $('fa-form-guias-contato-rapido').hidden = true;
      st.contatos = [];
      verLote(st.loteId);
    });
  }
  function disparar() {
    var ids = marcadas();
    if (!ids.length) return;
    var agendar = document.querySelector('input[name="fa-guias-quando"]:checked').value === 'agendar';
    var quando = null;
    if (agendar) {
      var v = $('fa-guias-agendar').value;
      if (!v) { nf.aviso($('fa-guias-disparo-aviso'), 'Escolha a data e a hora do envio.', 'erro'); return; }
      quando = new Date(v).toISOString();
    }
    var botao = $('fa-guias-disparar');
    nf.ocupado(botao, true, 'Disparando…');
    nf.app(ROTA, { acao: 'disparar', guia_ids: ids, quando: quando }).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-guias-disparo-aviso'), nf.esc(erroDe(r)), 'erro'); return; }
      var d = r.dados;
      nf.aviso($('fa-guias-disparo-aviso'), nf.esc((d.agendadas === 1 ? '1 guia ' : d.agendadas + ' guias ') + (quando ? 'agendada' + (d.agendadas === 1 ? '' : 's') + ' para ' + new Date(quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'na fila: saem no próximo minuto') + (d.recusadas ? '; ' + d.recusadas + ' não estavam verdes.' : '.')), 'ok');
      desenharUso(d.uso);
      verLote(st.loteId);
    });
  }

  /* ---------- Acompanhar ---------- */
  function canal(envios, c) {
    var dele = (envios || []).filter(function (e) { return e.canal === c && e.motivo === 'envio'; });
    if (!dele.length) return '—';
    var ordem = ['lida', 'entregue', 'enviada', 'pendente', 'falhou'];
    for (var i = 0; i < ordem.length; i++) for (var k = 0; k < dele.length; k++) if (dele[k].status === ordem[i]) return CANAL[ordem[i]];
    return dele[0].status;
  }
  function acompanhar() {
    var mes = $('fa-guias-mes').value || mesAtual();
    return nf.app(ROTA, { acao: 'acompanhar', mes: mes }).then(function (r) {
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-aviso-guias'), nf.esc(erroDe(r)), 'erro'); return; }
      desenharUso(r.dados.uso);
      var guias = r.dados.guias || [];
      $('fa-guias-acomp-vazio').hidden = guias.length > 0;
      $('fa-guias-acomp-rolagem').hidden = !guias.length;
      $('fa-guias-acomp-linhas').innerHTML = guias.map(function (g) {
        var pagavel = ['enviada', 'entregue', 'lida', 'baixada', 'paga_informada', 'falhou'].indexOf(g.status) >= 0;
        var cancelavel = g.status === 'agendada';
        return '<tr data-guia="' + nf.esc(g.id) + '"><th scope="row">' + nf.esc(g.contato ? g.contato.nome : docFmt(g.documento)) + '<span class="nf-sub">' + nf.esc(docFmt(g.documento)) + '</span></th>' +
          '<td>' + nf.esc(g.tipo_rotulo || '—') + (g.competencia ? '<span class="nf-sub">' + nf.esc(g.competencia.slice(5) + '/' + g.competencia.slice(0, 4)) + '</span>' : '') + '</td>' +
          '<td class="nf-num">' + nf.esc(reais(g.valor_centavos)) + '</td><td class="nf-nowrap">' + nf.esc(dataBr(g.vencimento)) + '</td>' +
          '<td>' + pill(SITUACAO[g.status] || [g.status, '']) + (g.status === 'agendada' && g.agendada_para ? '<span class="nf-sub">' + nf.esc(new Date(g.agendada_para).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })) + '</span>' : '') + (g.baixada_em ? '<span class="nf-sub">baixada em ' + nf.esc(new Date(g.baixada_em).toLocaleDateString('pt-BR')) + '</span>' : '') + '</td>' +
          '<td>' + nf.esc(canal(g.envios, 'whatsapp')) + '</td><td>' + nf.esc(canal(g.envios, 'email')) + '</td>' +
          '<td>' + (g.ultima_resposta ? nf.esc(g.ultima_resposta) + '<span class="nf-sub">' + nf.esc(new Date(g.ultima_resposta_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })) + '</span>' : '—') + '</td>' +
          '<td class="nf-acoes-linha">' + (pagavel ? '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-acomp="guia_marcar_paga">Marcar paga</button>' : '') + (cancelavel ? '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-acomp="guia_cancelar">Cancelar envio</button>' : '') + '</td></tr>';
      }).join('');
    });
  }
  function exportar() {
    var botao = $('fa-guias-exportar'), mes = $('fa-guias-mes').value || mesAtual();
    nf.ocupado(botao, true, '…');
    nf.appArquivo(ROTA, { exportar: 'csv', mes: mes }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok && r.blob) { nf.baixarArquivo(r.blob, r.nome || 'guias-' + mes + '.csv'); return; }
      if (r.status !== 401) nf.aviso($('fa-aviso-guias'), nf.esc(erroDe(r)), 'erro');
    });
  }

  /* ---------- Clientes ---------- */
  function listarContatos() {
    return nf.app(ROTA, { acao: 'contatos_listar' }).then(function (r) {
      if (!r.ok) return;
      st.contatos = r.dados.contatos || [];
      $('fa-guias-contatos-vazio').hidden = st.contatos.length > 0;
      $('fa-guias-contatos-rolagem').hidden = !st.contatos.length;
      $('fa-guias-contatos-linhas').innerHTML = st.contatos.map(function (c) {
        var canais = function (l, sair) { return (l || []).map(function (x) { return nf.esc(x); }).join('<br>') + (sair && l && l.length ? '<span class="nf-sub">pediu para sair</span>' : '') || '—'; };
        return '<tr class="' + (c.ativo ? '' : 'nf-linha-off') + '"><th scope="row">' + nf.esc(c.nome) + (c.ativo ? '' : '<span class="nf-sub">desativado</span>') + '</th><td class="nf-nowrap">' + nf.esc(docFmt(c.documento)) + '</td>' +
          '<td>' + canais(c.whatsapps, c.sair_whatsapp_em) + '</td><td>' + canais(c.emails, c.sair_email_em) + '</td>' +
          '<td>' + (c.aceite_em ? nf.esc(new Date(c.aceite_em).toLocaleDateString('pt-BR')) + '<span class="nf-sub">' + nf.esc(c.aceite_origem || '') + '</span>' : '—') + '</td>' +
          '<td class="nf-acoes-linha"><button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-contato-editar="' + nf.esc(c.id) + '">Editar</button>' +
          '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-contato-ativar="' + nf.esc(c.id) + '" data-ativo="' + (c.ativo ? 'false' : 'true') + '">' + (c.ativo ? 'Desativar' : 'Reativar') + '</button>' +
          (c.sair_whatsapp_em ? '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-contato-canal="' + nf.esc(c.id) + '" data-sair-whatsapp="false">Reativar WhatsApp</button>' : '') +
          ((c.emails || []).length ? '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-contato-canal="' + nf.esc(c.id) + '" data-sair-email="' + (c.sair_email_em ? 'false' : 'true') + '">' + (c.sair_email_em ? 'Voltar o e-mail' : 'Pediu para sair do e-mail') + '</button>' : '') + '</td></tr>';
      }).join('');
    });
  }
  function abrirContato(id) {
    var c = null;
    for (var i = 0; i < st.contatos.length; i++) if (st.contatos[i].id === id) c = st.contatos[i];
    $('fa-form-guias-contato').hidden = false;
    $('fa-guias-novo-contato').setAttribute('aria-expanded', 'true');
    $('fa-guias-ct-titulo').textContent = c ? 'Editar ' + c.nome : 'Novo cliente';
    $('fa-guias-ct-id').value = c ? c.id : '';
    $('fa-guias-ct-doc').value = c ? docFmt(c.documento) : '';
    $('fa-guias-ct-nome').value = c ? c.nome : '';
    $('fa-guias-ct-whatsapp').value = c ? (c.whatsapps || []).join(' | ') : '';
    $('fa-guias-ct-email').value = c ? (c.emails || []).join(' | ') : '';
    $('fa-guias-ct-aceite-origem').value = c && c.aceite_origem ? c.aceite_origem : '';
    $('fa-guias-ct-aceite-data').value = c && c.aceite_em ? new Date(c.aceite_em).toISOString().slice(0, 10) : '';
    nf.aviso($('fa-guias-ct-aviso'), '');
    $('fa-guias-ct-doc').focus();
  }
  function salvarContato(ev) {
    ev.preventDefault();
    var botao = $('fa-guias-ct-salvar'), id = $('fa-guias-ct-id').value;
    var contato = { documento: $('fa-guias-ct-doc').value, nome: $('fa-guias-ct-nome').value, whatsapps: $('fa-guias-ct-whatsapp').value, emails: $('fa-guias-ct-email').value };
    if (id) contato.id = id;
    if ($('fa-guias-ct-aceite-origem').value.trim()) { contato.aceite_origem = $('fa-guias-ct-aceite-origem').value; contato.aceite_em = $('fa-guias-ct-aceite-data').value; }
    nf.ocupado(botao, true, 'Salvando…');
    nf.app(ROTA, { acao: 'contato_salvar', contato: contato }).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) nf.aviso($('fa-guias-ct-aviso'), nf.esc(erroDe(r)), 'erro'); return; }
      $('fa-form-guias-contato').hidden = true;
      $('fa-guias-novo-contato').setAttribute('aria-expanded', 'false');
      listarContatos();
    });
  }
  function mudarCanal(b) {
    var corpo = { acao: 'contato_canal', id: b.getAttribute('data-contato-canal') };
    if (b.hasAttribute('data-sair-email')) corpo.sair_email = b.getAttribute('data-sair-email') === 'true';
    if (b.hasAttribute('data-sair-whatsapp')) {
      var origem = window.prompt('O cliente pediu para sair do WhatsApp. Como ele autorizou receber de novo?');
      if (!origem || !origem.trim()) return;
      corpo.sair_whatsapp = false;
      corpo.aceite_origem = origem.trim();
    }
    nf.ocupado(b, true, '…');
    nf.app(ROTA, corpo).then(function (r) {
      nf.ocupado(b, false);
      if (!r.ok && r.status !== 401) nf.aviso($('fa-aviso-guias'), nf.esc(erroDe(r)), 'erro');
      listarContatos();
    });
  }
  function importar(ev) {
    ev.preventDefault();
    nf.erroCampo('fa-guias-csv', '');
    var f = $('fa-guias-csv').files && $('fa-guias-csv').files[0];
    if (!f) { nf.erroCampo('fa-guias-csv', 'Escolha o arquivo CSV.'); return; }
    if (f.size > 2 * 1024 * 1024) { nf.erroCampo('fa-guias-csv', 'O CSV passa de 2 MB.'); return; }
    if (!$('fa-guias-aceite').checked || !$('fa-guias-aceite-origem').value.trim()) { nf.erroCampo('fa-guias-csv', 'Informe como os clientes autorizaram e marque a declaração.'); return; }
    var botao = $('fa-guias-importar');
    nf.ocupado(botao, true, 'Importando…');
    f.text().then(function (csv) {
      return nf.app(ROTA, { acao: 'contatos_importar', csv: csv, aceite_origem: $('fa-guias-aceite-origem').value, aceite_em: $('fa-guias-aceite-data').value });
    }).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) nf.erroCampo('fa-guias-csv', erroDe(r)); return; }
      var d = r.dados;
      $('fa-guias-imp-resultado').hidden = false;
      $('fa-guias-imp-resumo').textContent = d.importados + (d.importados === 1 ? ' cliente importado' : ' clientes importados') + (d.erros.length ? '; ' + d.erros.length + (d.erros.length === 1 ? ' linha com erro:' : ' linhas com erro:') : '.') + (d.aviso ? ' ' + d.aviso : '');
      $('fa-guias-imp-erros').innerHTML = d.erros.map(function (e) { return '<li>Linha ' + e.linha + ': ' + nf.esc(e.motivo) + '</li>'; }).join('');
      $('fa-guias-csv').value = '';
      listarContatos();
    });
  }

  /* ---------- Ajustes ---------- */
  function preencherAjustes() {
    var r = (st.estado && st.estado.regras) || {};
    $('fa-guias-assinatura').value = r.assinatura || '';
    $('fa-guias-email-alerta').value = r.email_alerta || '';
    $('fa-guias-whatsapp-escritorio').value = r.whatsapp_escritorio || '';
  }
  function salvarAjustes(ev) {
    ev.preventDefault();
    ['fa-guias-assinatura', 'fa-guias-email-alerta', 'fa-guias-whatsapp-escritorio'].forEach(function (x) { nf.erroCampo(x, ''); });
    var botao = $('fa-guias-ajustes-salvar');
    nf.ocupado(botao, true, 'Salvando…');
    nf.app(ROTA, { acao: 'regras_salvar', assinatura: $('fa-guias-assinatura').value, email_alerta: $('fa-guias-email-alerta').value, whatsapp_escritorio: $('fa-guias-whatsapp-escritorio').value }).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) {
        if (r.status === 401) return;
        var campo = r.dados && r.dados.campo;
        if (campo) nf.erroCampo('fa-guias-' + campo.replace(/_/g, '-'), erroDe(r)); else nf.aviso($('fa-guias-ajustes-aviso'), nf.esc(erroDe(r)), 'erro');
        return;
      }
      st.estado = r.dados;
      preencherAjustes();
      nf.aviso($('fa-guias-ajustes-aviso'), 'Ajustes salvos.', 'ok');
    });
  }

  /* ---------- ligações ---------- */
  document.querySelector('.nf-guias-telas').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-guias-tela]');
    if (b) mostrarTela(b.getAttribute('data-guias-tela'));
  });
  $('fa-form-guias-upload').addEventListener('submit', subir);
  $('fa-guias-lote').addEventListener('change', function () { verLote($('fa-guias-lote').value); });
  $('fa-guias-conf-linhas').addEventListener('click', function (ev) {
    var t = ev.target;
    var criar = t.closest && t.closest('[data-guia-criar]');
    if (criar) { abrirCriar(criar.getAttribute('data-guia-criar')); return; }
    var tr = t.closest && t.closest('tr[data-guia]');
    if (!tr) return;
    var salvar = t.closest('[data-guia-salvar]'), cancelar = t.closest('[data-guia-cancelar]');
    if (salvar) salvarGuia(tr, salvar);
    else if (cancelar) cancelarGuia(tr, cancelar);
  });
  $('fa-guias-conf-linhas').addEventListener('change', function (ev) { if (ev.target.hasAttribute && ev.target.hasAttribute('data-guia-marcar')) atualizarDisparo(); });
  $('fa-form-guias-contato-rapido').addEventListener('submit', criarRapido);
  $('fa-guias-cr-cancelar').addEventListener('click', function () { $('fa-form-guias-contato-rapido').hidden = true; });
  document.querySelectorAll('input[name="fa-guias-quando"]').forEach(function (r) {
    r.addEventListener('change', function () { $('fa-guias-agendar').disabled = document.querySelector('input[name="fa-guias-quando"]:checked').value !== 'agendar'; });
  });
  $('fa-guias-disparar').addEventListener('click', disparar);
  $('fa-guias-acomp-atualizar').addEventListener('click', acompanhar);
  $('fa-guias-mes').addEventListener('change', acompanhar);
  $('fa-guias-exportar').addEventListener('click', exportar);
  $('fa-guias-acomp-linhas').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-acomp]');
    if (!b) return;
    nf.ocupado(b, true, '…');
    nf.app(ROTA, { acao: b.getAttribute('data-acomp'), guia_id: b.closest('tr').getAttribute('data-guia') }).then(function (r) {
      nf.ocupado(b, false);
      if (!r.ok && r.status !== 401) nf.aviso($('fa-aviso-guias'), nf.esc(erroDe(r)), 'erro');
      acompanhar();
    });
  });
  $('fa-form-guias-importar').addEventListener('submit', importar);
  $('fa-guias-novo-contato').addEventListener('click', function () { abrirContato(null); });
  $('fa-guias-ct-cancelar').addEventListener('click', function () { $('fa-form-guias-contato').hidden = true; $('fa-guias-novo-contato').setAttribute('aria-expanded', 'false'); });
  $('fa-form-guias-contato').addEventListener('submit', salvarContato);
  $('fa-guias-contatos-linhas').addEventListener('click', function (ev) {
    var ed = ev.target.closest && ev.target.closest('[data-contato-editar]');
    if (ed) { abrirContato(ed.getAttribute('data-contato-editar')); return; }
    var canalB = ev.target.closest && ev.target.closest('[data-contato-canal]');
    if (canalB) { mudarCanal(canalB); return; }
    var at = ev.target.closest && ev.target.closest('[data-contato-ativar]');
    if (!at) return;
    nf.ocupado(at, true, '…');
    nf.app(ROTA, { acao: 'contato_ativar', id: at.getAttribute('data-contato-ativar'), ativo: at.getAttribute('data-ativo') === 'true' }).then(function (r) {
      nf.ocupado(at, false);
      if (!r.ok && r.status !== 401) nf.aviso($('fa-aviso-guias'), nf.esc(erroDe(r)), 'erro');
      listarContatos();
    });
  });
  $('fa-form-guias-ajustes').addEventListener('submit', salvarAjustes);

  /* Outra conta (sair e entrar, sessão vencida): tudo recarrega e a aba some até a API dizer de novo. */
  function invalidar() {
    st.carregado = false;
    st.estado = null;
    st.guias = [];
    st.contatos = [];
    st.loteId = null;
    $('fa-guias-conf-linhas').innerHTML = '';
    $('fa-guias-contatos-linhas').innerHTML = '';
    $('fa-guias-acomp-linhas').innerHTML = '';
    $('fa-guias-conferencia').hidden = true;
    esconder();
  }
  window.addEventListener('nofiscal:sessao-vencida', invalidar);
  if ($('fa-sair')) $('fa-sair').addEventListener('click', invalidar);
  window.contaGuias = { verificar: verificar, abrir: abrir, invalidar: invalidar };
})();
