/* NF-e avulsa na aba "NF-e" do painel (23/11/2026), sobre /v1/fiscal/nfe (app/api/_lib/nfe/painel-nfe.ts):
   `historico` traz destinatários, produtos e transportadoras das notas anteriores da empresa escolhida em cima
   (#fa-nfe-empresa); `avulsa_conferir` devolve o resumo, os problemas e os avisos; `avulsa_emitir` põe na fila com a
   chave da emissão (uuid do formulário: clique duplo não emite duas vezes). O campo `nota` tem a forma do POST /v1/nfe.
   Nada de NCM, CFOP ou CSOSN inventado: o produto escolhido traz os da última nota, e a pessoa confere. */
(function () {
  'use strict';
  var nf = window.noFiscal;
  if (!nf || !document.getElementById('fa-form-nfa')) return;
  var ROTA = '/v1/fiscal/nfe';
  var GENERICO = 'Não deu para concluir agora. Tente de novo em alguns minutos.';
  var st = { tenant: null, hist: { destinatarios: [], produtos: [], transportadores: [] }, corpo: null, chave: null, municipios: false };
  function $(id) { return document.getElementById(id); }
  function v(id) { return ($(id).value || '').trim(); }

  /* Número pt-BR ("1.234,56", "2,5") → número; vazio → null; inválido → NaN. */
  function numero(t) {
    t = String(t || '').trim().replace(/^R\$\s*/i, '').replace(/\s/g, '');
    if (!t) return null;
    if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
    return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  }
  function decimalBR(n) { return n === null || n === undefined ? '' : String(n).replace('.', ','); }
  function novaChave() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }

  /* ---------- itens ---------- */
  var CSOSN = [['102', '102 - Sem permissão de crédito'], ['101', '101 - Com permissão de crédito'], ['103', '103 - Isenção na faixa de receita'],
    ['300', '300 - Imune'], ['400', '400 - Não tributada'], ['500', '500 - ICMS cobrado anteriormente por ST']];
  var ORIGEM = [['0', '0 - Nacional'], ['1', '1 - Estrangeira, importação direta'], ['2', '2 - Estrangeira, mercado interno'],
    ['3', '3 - Nacional, importado 40% a 70%'], ['4', '4 - Nacional, processo produtivo básico'], ['5', '5 - Nacional, importado até 40%'],
    ['6', '6 - Estrangeira sem similar, importação direta'], ['7', '7 - Estrangeira sem similar, mercado interno'], ['8', '8 - Nacional, importado acima de 70%']];
  function opcoes(lista) { return lista.map(function (o) { return '<option value="' + o[0] + '">' + nf.esc(o[1]) + '</option>'; }).join(''); }
  var seq = 0;
  function campo(n, c, rotulo, extra, largo) {
    var id = 'fa-nfa-i' + n + '-' + c;
    return '<div class="nf-campo' + (largo ? ' nf-campo--largo' : '') + '"><label for="' + id + '">' + rotulo + '</label><input id="' + id + '" data-c="' + c + '" autocomplete="off"' + (extra || '') + '></div>';
  }
  function adicionarItem(produto) {
    var n = ++seq;
    var div = document.createElement('fieldset');
    div.className = 'nf-grupo nf-nfa-item';
    div.setAttribute('data-item', String(n));
    div.innerHTML =
      '<legend style="grid-column:1/-1">Produto</legend>' +
      campo(n, 'codigo', 'Código', ' list="fa-nfa-produtos" maxlength="60"') +
      campo(n, 'descricao', 'Descrição', ' maxlength="120"') +
      campo(n, 'ncm', 'NCM (8 dígitos)', ' inputmode="numeric" maxlength="10"') +
      campo(n, 'cfop', 'CFOP', ' inputmode="numeric" maxlength="4" placeholder="5102"') +
      campo(n, 'unidade', 'Unidade', ' maxlength="6" placeholder="UN"') +
      campo(n, 'quantidade', 'Quantidade', ' inputmode="decimal" maxlength="15"') +
      campo(n, 'valor_unitario', 'Valor unitário (R$)', ' inputmode="decimal" maxlength="18"') +
      campo(n, 'desconto', 'Desconto do item (R$, opcional)', ' inputmode="decimal" maxlength="15"') +
      '<div class="nf-campo"><label for="fa-nfa-i' + n + '-csosn">CSOSN</label><select id="fa-nfa-i' + n + '-csosn" data-c="csosn">' + opcoes(CSOSN) + '</select></div>' +
      '<div class="nf-campo" data-credito hidden><label for="fa-nfa-i' + n + '-aliquota_credito_sn">Alíquota do crédito do Simples (%)</label><input id="fa-nfa-i' + n + '-aliquota_credito_sn" data-c="aliquota_credito_sn" inputmode="decimal" autocomplete="off" maxlength="8" placeholder="2,56"></div>' +
      '<div class="nf-campo"><label for="fa-nfa-i' + n + '-origem">Origem</label><select id="fa-nfa-i' + n + '-origem" data-c="origem">' + opcoes(ORIGEM) + '</select></div>' +
      '<div class="nf-acoes nf-campo--largo"><button type="button" class="fi-link-btn" data-remover>Remover este produto</button></div>';
    $('fa-nfa-itens').appendChild(div);
    if (produto) preencherItem(div, produto);
    atualizarItens();
    return div;
  }
  function c(div, nome) { return div.querySelector('[data-c="' + nome + '"]'); }
  function preencherItem(div, p) {
    c(div, 'codigo').value = p.codigo || '';
    c(div, 'descricao').value = p.descricao || '';
    c(div, 'ncm').value = p.ncm || '';
    c(div, 'cfop').value = p.cfop || '';
    c(div, 'unidade').value = p.unidade || '';
    c(div, 'valor_unitario').value = decimalBR(p.valorUnitario);
    c(div, 'csosn').value = p.csosn || '102';
    c(div, 'aliquota_credito_sn').value = decimalBR(p.aliquotaCreditoSN);
    c(div, 'origem').value = p.origem || '0';
    div._extra = { cest: p.cest || null, gtin: p.gtin || null, cst_pis_cofins: p.cstPisCofins || null };
    atualizarItens();
  }
  function atualizarItens() {
    var itens = $('fa-nfa-itens').querySelectorAll('.nf-nfa-item');
    Array.prototype.forEach.call(itens, function (div, i) {
      div.querySelector('legend').textContent = 'Produto ' + (i + 1);
      div.querySelector('[data-credito]').hidden = c(div, 'csosn').value !== '101';
      div.querySelector('[data-remover]').hidden = itens.length === 1;
    });
  }
  function produtoDoCodigo(codigo) {
    var k = String(codigo || '').trim().toUpperCase();
    for (var i = 0; i < st.hist.produtos.length; i++) if (String(st.hist.produtos[i].codigo).trim().toUpperCase() === k) return st.hist.produtos[i];
    return null;
  }

  /* ---------- histórico da empresa ---------- */
  function carregarHistorico() {
    var tenant = $('fa-nfe-empresa').value;
    if (!tenant || tenant === st.tenant) return;
    st.tenant = tenant;
    st.hist = { destinatarios: [], produtos: [], transportadores: [] };
    desenharHistorico();
    nf.app(ROTA, { acao: 'historico', tenant_id: tenant }).then(function (r) {
      if (!r.ok || tenant !== $('fa-nfe-empresa').value) return;
      st.hist = r.dados || st.hist;
      desenharHistorico();
    });
  }
  function desenharHistorico() {
    var h = st.hist;
    $('fa-nfa-cliente').innerHTML = '<option value="">Cliente novo</option>' + h.destinatarios.map(function (d, i) {
      return '<option value="' + i + '">' + nf.esc(d.nome + ' · ' + nf.formatarDocumento(d.documento || '')) + '</option>';
    }).join('');
    $('fa-nfa-produtos').innerHTML = h.produtos.map(function (p) {
      return '<option value="' + nf.esc(p.codigo) + '">' + nf.esc(p.descricao) + '</option>';
    }).join('');
    $('fa-nfa-transportadora').innerHTML = '<option value="">Nova (ou nenhuma)</option>' + h.transportadores.map(function (t, i) {
      return '<option value="' + i + '">' + nf.esc((t.nome || 'Sem nome') + (t.documento ? ' · ' + nf.formatarDocumento(t.documento) : '')) + '</option>';
    }).join('');
  }
  function escolherCliente() {
    var d = st.hist.destinatarios[Number($('fa-nfa-cliente').value)];
    var e = (d && d.endereco) || {};
    $('fa-nfa-documento').value = d ? nf.formatarDocumento(d.documento || '') : '';
    $('fa-nfa-nome').value = d ? d.nome || '' : '';
    $('fa-nfa-ie').value = d ? (d.indicadorIE === '2' ? 'ISENTO' : d.inscricaoEstadual || '') : '';
    $('fa-nfa-email').value = d ? d.email || '' : '';
    $('fa-nfa-cep').value = e.cep || '';
    $('fa-nfa-logradouro').value = e.logradouro || '';
    $('fa-nfa-numero').value = e.numero || '';
    $('fa-nfa-complemento').value = e.complemento || '';
    $('fa-nfa-bairro').value = e.bairro || '';
    $('fa-nfa-municipio').value = d ? d.municipio || e.codigoMunicipio || '' : '';
    $('fa-nfa-fone').value = e.fone || '';
  }
  function escolherTransportadora() {
    var t = st.hist.transportadores[Number($('fa-nfa-transportadora').value)] || {};
    $('fa-nfa-t-documento').value = t.documento ? nf.formatarDocumento(t.documento) : '';
    $('fa-nfa-t-nome').value = t.nome || '';
    $('fa-nfa-t-ie').value = t.inscricaoEstadual || '';
    $('fa-nfa-t-endereco').value = t.endereco || '';
    $('fa-nfa-t-municipio').value = t.municipio || '';
    $('fa-nfa-t-uf').value = t.uf || '';
  }
  function carregarMunicipios() {
    if (st.municipios) return;
    st.municipios = true;
    fetch('/agentes/fiscal/dados/municipios.json', { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !Array.isArray(d.municipios)) { st.municipios = false; return; }
        var lista = $('fa-nfa-municipios'), frag = document.createDocumentFragment();
        d.municipios.forEach(function (m) { var o = document.createElement('option'); o.value = m; frag.appendChild(o); });
        lista.appendChild(frag);
      })
      .catch(function () { st.municipios = false; });
  }

  /* ---------- montar e conferir ---------- */
  function erro(msg) {
    $('fa-nfa-erro').textContent = msg || '';
    $('fa-nfa-erro').hidden = !msg;
  }
  /* O corpo de avulsa_conferir/avulsa_emitir, ou { erro } com o primeiro campo que não fecha. */
  function montar() {
    var ie = v('fa-nfa-ie');
    var indicador = !ie ? '9' : /^isent[oa]$/i.test(ie) ? '2' : '1';
    var itens = [], problema = null;
    Array.prototype.forEach.call($('fa-nfa-itens').querySelectorAll('.nf-nfa-item'), function (div, i) {
      if (problema) return;
      var n = 'Produto ' + (i + 1) + ': ';
      var q = numero(c(div, 'quantidade').value), u = numero(c(div, 'valor_unitario').value), d = numero(c(div, 'desconto').value);
      var cred = numero(c(div, 'aliquota_credito_sn').value);
      var csosn = c(div, 'csosn').value;
      if (!(q > 0)) problema = n + 'quantidade inválida.';
      else if (!(u > 0)) problema = n + 'valor unitário inválido.';
      else if (d !== null && !(d >= 0)) problema = n + 'desconto inválido.';
      else if (csosn === '101' && !(cred > 0)) problema = n + 'o CSOSN 101 pede a alíquota do crédito.';
      var extra = div._extra || {};
      itens.push({
        codigo: c(div, 'codigo').value.trim(), descricao: c(div, 'descricao').value.trim(), ncm: nf.digitos(c(div, 'ncm').value),
        cfop: nf.digitos(c(div, 'cfop').value), unidade: c(div, 'unidade').value.trim(), quantidade: q, valor_unitario: u,
        desconto: d || null, csosn: csosn, aliquota_credito_sn: csosn === '101' ? cred : null, origem: c(div, 'origem').value,
        cest: extra.cest || null, gtin: extra.gtin || null, cst_pis_cofins: extra.cst_pis_cofins || null
      });
    });
    if (problema) return { erro: problema };
    var vq = numero(v('fa-nfa-v-quantidade')), pl = numero(v('fa-nfa-v-peso-liquido')), pb = numero(v('fa-nfa-v-peso-bruto'));
    if (vq !== null && !(vq >= 0 && Math.floor(vq) === vq)) return { erro: 'Quantidade de volumes: número inteiro.' };
    if ((pl !== null && !(pl >= 0)) || (pb !== null && !(pb >= 0))) return { erro: 'Peso em kg, por exemplo 60,4.' };
    var volume = { quantidade: vq, especie: v('fa-nfa-v-especie') || null, marca: v('fa-nfa-v-marca') || null, numeracao: v('fa-nfa-v-numeracao') || null, peso_liquido: pl, peso_bruto: pb };
    var temVolume = Object.keys(volume).some(function (k) { return volume[k] !== null; });
    var transportador = { documento: nf.digitos(v('fa-nfa-t-documento')) || null, nome: v('fa-nfa-t-nome') || null, inscricao_estadual: v('fa-nfa-t-ie') || null, endereco: v('fa-nfa-t-endereco') || null, municipio: v('fa-nfa-t-municipio') || null, uf: v('fa-nfa-t-uf') || null };
    var temTransportador = Object.keys(transportador).some(function (k) { return transportador[k] !== null; });
    var nota = {
      destinatario: {
        documento: nf.digitos(v('fa-nfa-documento')), nome: v('fa-nfa-nome'), indicador_ie: indicador,
        inscricao_estadual: indicador === '1' ? nf.digitos(ie) : null, email: v('fa-nfa-email') || null,
        endereco: { logradouro: v('fa-nfa-logradouro'), numero: v('fa-nfa-numero') || 'S/N', complemento: v('fa-nfa-complemento') || null, bairro: v('fa-nfa-bairro'), codigo_municipio: v('fa-nfa-municipio'), uf: '', cep: nf.digitos(v('fa-nfa-cep')), fone: nf.digitos(v('fa-nfa-fone')) || null }
      },
      itens: itens,
      informacoes_complementares: v('fa-nfa-info') || null
    };
    // Natureza da operação: vazia, o servidor tira do CFOP (5949/6949 → Simples remessa, 5102 → Venda de mercadoria…).
    if (v('fa-nfa-natureza')) nota.natureza_operacao = v('fa-nfa-natureza');
    // UF do município escrito como Cidade/UF (o servidor confere); com o código IBGE, o servidor completa.
    var uf = /\/\s*([A-Za-z]{2})\s*$/.exec(v('fa-nfa-municipio'));
    nota.destinatario.endereco.uf = uf ? uf[1].toUpperCase() : '';
    if (v('fa-nfa-modalidade')) nota.modalidade_frete = v('fa-nfa-modalidade');
    if (temTransportador) nota.transportador = transportador;
    if (temVolume) nota.volumes = [volume];
    return { tenant_id: $('fa-nfe-empresa').value, nota: nota, frete: v('fa-nfa-frete'), forma_pagamento: $('fa-nfa-forma').value, descricao_pagamento: v('fa-nfa-desc-pag') };
  }
  function conferir(ev) {
    ev.preventDefault();
    erro('');
    nf.aviso($('fa-aviso-nfa'), '');
    var corpo = montar();
    if (corpo.erro) { erro(corpo.erro); return; }
    var botao = $('fa-nfa-conferir');
    nf.ocupado(botao, true, 'Conferindo…');
    nf.app(ROTA, Object.assign({ acao: 'avulsa_conferir' }, corpo)).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) erro(r.mensagem || GENERICO); return; }
      st.corpo = corpo;
      if (!st.chave) st.chave = novaChave();
      desenharResumo(r.dados);
    });
  }
  function linhas(pares) {
    return pares.filter(function (p) { return p[1]; }).map(function (p) { return '<dt>' + nf.esc(p[0]) + '</dt><dd>' + nf.esc(p[1]) + '</dd>'; }).join('');
  }
  function desenharResumo(d) {
    var s = d.resumo || {}, de = s.destinatario || {}, t = s.totais || {};
    $('fa-nfa-resumo-dados').innerHTML = linhas([
      ['Empresa', (s.empresa ? s.empresa.razao_social + ' · ' + nf.formatarCnpj(s.empresa.cnpj) : '') + (s.homologacao ? ' (homologação, sem valor fiscal)' : '')],
      ['Destinatário', de.nome + ' · ' + nf.formatarDocumento(de.documento || '') + (de.ie ? ' · IE ' + de.ie : '')],
      ['Produtos', t.produtos],
      ['Desconto', t.desconto !== 'R$ 0,00' ? t.desconto : ''],
      ['Frete', t.frete !== 'R$ 0,00' ? t.frete : ''],
      ['Natureza da operação', s.natureza_operacao || ''],
      ['Total da nota', t.nota],
      ['Pagamento', s.pagamento],
      ['Transporte', s.transporte || ''],
      ['Crédito de ICMS (Simples)', s.credito_icms_sn || ''],
      ['Informações complementares', s.informacoes_complementares || '']
    ]);
    $('fa-nfa-itens-resumo').innerHTML = (s.itens || []).map(function (i) {
      return '<li>' + nf.esc(i.codigo + ' · ' + i.descricao + ' · ' + String(i.quantidade).replace('.', ',') + ' ' + i.unidade + ' · ' + i.total +
        (i.desconto ? ' (desconto ' + i.desconto + ')' : '') + ' · NCM ' + i.ncm + ' · CFOP ' + i.cfop + ' · CSOSN ' + i.csosn) + '</li>';
    }).join('');
    var problemas = d.problemas || [];
    $('fa-nfa-avisos').innerHTML =
      (d.bloqueio ? '<p class="nf-aviso nf-aviso--erro" role="status">' + nf.esc('Não dá para emitir: ' + d.bloqueio.motivo + '.') + '</p>' : '') +
      (problemas.length ? '<div class="nf-aviso nf-aviso--erro" role="status"><b>Corrija antes de emitir:</b><ul class="nf-lista">' + problemas.map(function (p) { return '<li>' + nf.esc(p) + '</li>'; }).join('') + '</ul></div>' : '') +
      (d.avisos || []).map(function (a) { return '<p class="nf-aviso nf-aviso--info">' + nf.esc('Confira: ' + a) + '</p>'; }).join('');
    $('fa-nfa-emitir').disabled = !!d.bloqueio || problemas.length > 0;
    $('fa-form-nfa').hidden = true;
    $('fa-nfa-resumo').hidden = false;
    $('fa-nfa-resumo-titulo').focus();
  }
  function corrigir() {
    $('fa-nfa-resumo').hidden = true;
    $('fa-form-nfa').hidden = false;
    $('fa-nfa-conferir').focus();
  }
  function emitir() {
    if (!st.corpo || !st.chave) return;
    var botao = $('fa-nfa-emitir');
    nf.ocupado(botao, true, 'Emitindo…');
    nf.app(ROTA, Object.assign({ acao: 'avulsa_emitir', chave: st.chave }, st.corpo)).then(function (r) {
      nf.ocupado(botao, false);
      if (!r.ok) { if (r.status !== 401) { corrigir(); erro(r.mensagem || GENERICO); } return; }
      var n = r.dados || {};
      limpar();
      nf.aviso($('fa-aviso-nfa'), nf.esc((n.ja_existia ? 'Esta nota já tinha ido para a emissão' : 'NF-e na fila de emissão') + ' (série ' + n.serie + ', nº ' + n.numero + '). Acompanhe na lista abaixo.'), 'ok');
      st.tenant = null;
      carregarHistorico();
      if (window.contaNfe && window.contaNfe.atualizar) window.contaNfe.atualizar();
    });
  }
  function limpar() {
    $('fa-form-nfa').reset();
    $('fa-nfa-itens').innerHTML = '';
    adicionarItem();
    st.corpo = null;
    st.chave = null;
    $('fa-nfa-campo-desc-pag').hidden = true;
    $('fa-nfa-resumo').hidden = true;
    $('fa-form-nfa').hidden = false;
    erro('');
  }

  /* ---------- eventos ---------- */
  $('fa-form-nfa').addEventListener('submit', conferir);
  // Qualquer mudança no formulário é outra nota: chave nova (a anterior fica com a nota que talvez já tenha saído).
  $('fa-form-nfa').addEventListener('input', function () { st.chave = null; });
  $('fa-form-nfa').addEventListener('change', function (ev) {
    st.chave = null;
    var div = ev.target.closest && ev.target.closest('.nf-nfa-item');
    if (div && ev.target.getAttribute('data-c') === 'codigo') {
      var p = produtoDoCodigo(ev.target.value);
      if (p) { var q = c(div, 'quantidade').value; preencherItem(div, p); c(div, 'quantidade').value = q; }
    }
    if (div && ev.target.getAttribute('data-c') === 'csosn') atualizarItens();
  });
  $('fa-nfa-itens').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-remover]');
    if (!b) return;
    b.closest('.nf-nfa-item').remove();
    atualizarItens();
  });
  $('fa-nfa-mais-item').addEventListener('click', function () { adicionarItem().querySelector('[data-c="codigo"]').focus(); });
  $('fa-nfa-cliente').addEventListener('change', escolherCliente);
  $('fa-nfa-transportadora').addEventListener('change', escolherTransportadora);
  $('fa-nfa-forma').addEventListener('change', function () { $('fa-nfa-campo-desc-pag').hidden = $('fa-nfa-forma').value !== '99'; });
  $('fa-nfa-municipio').addEventListener('focus', carregarMunicipios);
  $('fa-nfa-emitir').addEventListener('click', emitir);
  $('fa-nfa-corrigir').addEventListener('click', corrigir);
  // A empresa de cima mudou, ou a aba carregou as empresas: histórico da empresa escolhida, formulário limpo.
  $('fa-nfe-empresa').addEventListener('change', function () { limpar(); carregarHistorico(); });
  new MutationObserver(carregarHistorico).observe($('fa-nfe-empresa'), { childList: true });
  window.addEventListener('nofiscal:sessao-vencida', function () { st.tenant = null; limpar(); });
  adicionarItem();
})();
