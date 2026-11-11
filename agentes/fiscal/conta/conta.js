/* /agentes/fiscal/conta/: Minha conta (critérios 38–41 e 45 da tarefa agente-fiscal-v2). Sem sessão, entra com o
   código no e-mail (fiscal-acesso + /auth/v1/verify); com sessão, mostra o `estado` de fiscal-conta e as ações:
   trocar cartão, trocar plano, cancelar (com a data até a qual emite) e apagar conta e dados (só com APAGAR). */
(function () {
  'use strict';
  var nf = window.noFiscal;
  if (!nf || !document.getElementById('fa-painel')) return;
  var $ = nf.$;
  var GENERICO = 'Não deu para concluir agora. Tente de novo em alguns minutos.';
  var CERT = {
    CERT_SENHA_INVALIDA: 'Senha incorreta',
    CERT_VENCIDO: 'Certificado vencido',
    CERT_CNPJ_DIFERENTE: 'Este certificado é de outro CNPJ',
    VALIDATION_FAILED: 'Este arquivo não é um certificado A1 (.pfx ou .p12) que dê para usar.',
    RATE_LIMITED: 'Muitas tentativas. Tente de novo daqui a uma hora.'
  };
  var st = { estado: null, email: '', codigoNovo: false, seletor: null };

  function telaLogin(mensagem, tipo) {
    $('fa-carregando').hidden = true;
    $('fa-painel').hidden = true;
    $('fa-login').hidden = false;
    $('fa-form-email').hidden = false;
    $('fa-form-codigo').hidden = true;
    nf.aviso($('fa-aviso-login'), mensagem || '', tipo);
  }

  /* ---------- entrar ---------- */
  function pedirCodigo(ev) {
    if (ev) ev.preventDefault();
    var email = nf.texto($('fa-email').value).toLowerCase();
    nf.erroCampo('fa-email', '');
    nf.aviso($('fa-aviso-login'), '');
    if (!nf.emailValido(email)) { nf.erroCampo('fa-email', 'Informe um e-mail válido.'); return; }
    var botao = $('fa-enviar-codigo');
    nf.ocupado(botao, true);
    nf.pedirCodigo(email).then(function (r) {
      if (r.ok) {
        st.email = email; st.codigoNovo = false;
        $('fa-email-mascarado').textContent = nf.mascararEmail(email);
        $('fa-form-email').hidden = true;
        $('fa-form-codigo').hidden = false;
        $('fa-codigo').value = '';
        nf.erroCampo('fa-codigo', '');
        return;
      }
      if (r.status === 429) nf.aviso($('fa-aviso-login'), 'Você pediu códigos demais nesta hora. Tente de novo daqui a pouco.', 'erro');
      else if (r.status === 400) nf.erroCampo('fa-email', 'Informe um e-mail válido.');
      else nf.aviso($('fa-aviso-login'), nf.esc(r.mensagem || GENERICO), 'erro');
    }).then(function () { nf.ocupado(botao, false); });
  }
  function entrar(ev) {
    ev.preventDefault();
    var codigo = nf.digitos($('fa-codigo').value);
    if (st.codigoNovo) { nf.erroCampo('fa-codigo', 'Peça um código novo'); return; }
    if (codigo.length !== 6) { nf.erroCampo('fa-codigo', 'O código tem 6 dígitos.'); return; }
    var botao = $('fa-entrar');
    nf.ocupado(botao, true, 'Conferindo…');
    nf.verificarCodigo(st.email, codigo).then(function (r) {
      if (r.ok) { nf.erroCampo('fa-codigo', ''); return carregar(); }
      var e = nf.erroDoCodigo(r);
      st.codigoNovo = e.novo;
      nf.erroCampo('fa-codigo', e.mensagem);
    }).then(function () { nf.ocupado(botao, false); });
  }

  /* ---------- estado ---------- */
  function carregar() {
    return nf.funcao('fiscal-conta', { acao: 'estado' }).then(function (r) {
      if (r.ok) { st.estado = r.dados; desenhar(); irParaAncora(); return; }
      if (r.codigo === 'CONTA_SEM_EMPRESA') { nf.navegar('/agentes/fiscal/comecar/'); return; }
      if (r.status === 401) { nf.sessao.limpar(); telaLogin(); return; }
      telaLogin(nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }
  /* Links do agente (…/conta/#certificado, …/conta/#assinatura): o painel abre depois do estado, então a rolagem
     até a seção é feita aqui, uma vez. */
  var ancoraFeita = false;
  function irParaAncora() {
    if (ancoraFeita) return;
    ancoraFeita = true;
    var alvo = /^#(certificado|assinatura)$/.test(location.hash) && document.getElementById(location.hash.slice(1));
    if (alvo && typeof alvo.scrollIntoView === 'function') alvo.scrollIntoView({ block: 'start' });
  }
  function emTeste(a) { return !!(a && a.trial_ends_at && new Date(a.trial_ends_at).getTime() > Date.now() && a.status !== 'cancelada'); }
  function statusAssinatura(a) {
    if (!a) return ['Sem assinatura', 'erro'];
    if (a.status === 'cancelada') return ['Cancelada', 'erro'];
    if (a.cancelamento_agendado_para) return ['Cancelamento agendado para ' + nf.diaMes(a.cancelamento_agendado_para), ''];
    if (a.status === 'recusada') return ['Pagamento recusado', 'erro'];
    if (emTeste(a)) return ['Teste até ' + nf.diaMes(a.trial_ends_at), 'ok'];
    if (a.status === 'paga') return ['Ativa', 'ok'];
    return ['Aguardando o pagamento', ''];
  }
  function linhas(pares) {
    return pares.filter(function (p) { return p[1] !== undefined; }).map(function (p) {
      return '<dt>' + nf.esc(p[0]) + '</dt><dd>' + nf.esc(p[1] == null || p[1] === '' ? '—' : p[1]) + '</dd>';
    }).join('');
  }
  var SEMANA = ['', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
  function textoResumo(r) {
    if (!r || !r.frequencia) return 'Não recebe';
    return r.frequencia === 'semanal' ? 'Semanal, toda ' + (SEMANA[r.dia] || r.dia) : 'Mensal, no dia ' + r.dia;
  }
  function desenhar() {
    var e = st.estado || {};
    var emp = e.empresa || {}, a = e.assinatura, c = e.certificado, f = e.fiscal || {};
    var pro = e.plano === 'pro';
    $('fa-carregando').hidden = true;
    $('fa-login').hidden = true;
    $('fa-painel').hidden = false;
    $('fa-retomar').hidden = e.onboarding_etapa === 'concluido';

    $('fa-empresa').innerHTML = linhas([
      ['Razão social', emp.razao_social], ['CNPJ', emp.cnpj ? nf.formatarCnpj(emp.cnpj) : ''],
      ['Município', emp.municipio ? emp.municipio + (emp.uf ? '/' + emp.uf : '') : ''],
      ['Responsável', emp.responsavel], ['E-mail', emp.email], ['WhatsApp', emp.telefone ? nf.mascararTelefone(emp.telefone) : '']
    ]);

    var plano = nf.PLANOS[e.plano] || nf.PLANOS.inicial;
    $('fa-plano-nome').textContent = plano.nome;
    $('fa-plano-notas').textContent = a && a.ciclo === 'anual'
      ? 'Até ' + plano.notas + ' · ' + nf.reais(plano.anual) + '/ano (anual)'
      : 'Até ' + plano.notas + ' · ' + nf.reais(plano.centavos) + '/mês';
    var s = statusAssinatura(a);
    var pill = $('fa-status');
    pill.textContent = s[0];
    pill.className = 'nf-status' + (s[1] ? ' nf-status--' + s[1] : '');
    var ativa = a && a.status !== 'cancelada';
    $('fa-trocar-plano').textContent = pro ? 'Mudar para o Inicial' : 'Mudar para o Pro';
    // No anual a troca é com a equipe (fiscal-conta: TROCA_ANUAL_INDISPONIVEL).
    $('fa-trocar-plano').hidden = !ativa || a.ciclo === 'anual';
    $('fa-periodo-pago').textContent = a && a.ciclo === 'anual' ? 'do ano já pago' : 'do mês já pago';
    $('fa-abrir-cartao').hidden = !ativa;

    $('fa-cert-titular').textContent = c && c.subject ? nf.titular(c.subject) : 'Nenhum certificado enviado';
    $('fa-cert-validade').textContent = c && c.not_after ? nf.dataBR(c.not_after) : '—';

    $('fa-fiscal').innerHTML = linhas([
      ['Código de serviço', f.codigo_servico_nacional ? nf.formatarCodigo(f.codigo_servico_nacional) : ''],
      ['Tributos do Simples', ehMei() ? undefined : f.p_tot_trib_sn != null ? String(f.p_tot_trib_sn).replace('.', ',') + '%' : ''],
      ['Contador', pro ? (f.contador_email || '') : undefined],
      ['Resumo das notas', pro ? textoResumo(f.resumo) : undefined]
    ]);
    $('fa-pro').hidden = !pro;

    $('fa-secao-cancelar').hidden = !ativa || !!(a && a.cancelamento_agendado_para);
    $('fa-confirmar-cancelar').hidden = true;
    desenharEscritorio();
  }

  /* ---------- cartão ---------- */
  var CAMPO_CARTAO = { numero: 'fa-cc-numero', nome: 'fa-cc-nome', validade: 'fa-cc-validade', cvv: 'fa-cc-cvv', cep: 'fa-en-cep', rua: 'fa-en-rua', end_numero: 'fa-en-numero', bairro: 'fa-en-bairro', cidade: 'fa-en-cidade', uf: 'fa-en-uf' };
  function lerCartao() {
    return {
      numero: $('fa-cc-numero').value, nome: $('fa-cc-nome').value, validade: $('fa-cc-validade').value, cvv: $('fa-cc-cvv').value,
      endereco: { cep: $('fa-en-cep').value, rua: $('fa-en-rua').value, numero: $('fa-en-numero').value, complemento: $('fa-en-complemento').value, bairro: $('fa-en-bairro').value, cidade: $('fa-en-cidade').value, uf: $('fa-en-uf').value }
    };
  }
  function abrirCartao() {
    var uf = $('fa-en-uf');
    if (uf.options.length <= 1) nf.UFS.forEach(function (u) { var o = document.createElement('option'); o.value = u; o.textContent = u; uf.appendChild(o); });
    $('fa-form-cartao').hidden = false;
  }
  function trocarCartao(ev) {
    ev.preventDefault();
    Object.keys(CAMPO_CARTAO).forEach(function (k) { nf.erroCampo(CAMPO_CARTAO[k], ''); });
    nf.aviso($('fa-aviso-cartao'), '');
    var c = lerCartao();
    var erros = nf.validarCartao(c);
    Object.keys(erros).forEach(function (k) { nf.erroCampo(CAMPO_CARTAO[k], erros[k]); });
    if (Object.keys(erros).length) return;
    var botao = $('fa-salvar-cartao');
    nf.ocupado(botao, true, 'Salvando…');
    nf.funcao('assinatura-fiscal', undefined, { metodo: 'GET', auth: false }).then(function (cfg) {
      if (!cfg.ok) throw new Error('CONFIG');
      return nf.tokenizarCartao(cfg.dados.public_key, c);
    }).then(function (token) {
      ['fa-cc-numero', 'fa-cc-nome', 'fa-cc-validade', 'fa-cc-cvv'].forEach(function (id) { $(id).value = ''; });
      return nf.funcao('fiscal-conta', { acao: 'trocar_cartao', card_token: token, endereco: nf.enderecoDoCartao(c.endereco) }).then(function (r) {
        if (r.ok) { $('fa-form-cartao').hidden = true; nf.aviso($('fa-aviso-plano'), 'Cartão atualizado', 'ok'); return carregar(); }
        if (r.status === 401) return;
        nf.aviso($('fa-aviso-cartao'), r.status === 402 ? 'Cartão recusado. Tente outro cartão' : nf.esc(r.mensagem || GENERICO), 'erro');
      });
    }, function () {
      nf.aviso($('fa-aviso-cartao'), 'Confira os dados do cartão.', 'erro');
    }).then(function () { nf.ocupado(botao, false); });
  }

  /* ---------- plano ---------- */
  function trocarPlano() {
    var novo = st.estado && st.estado.plano === 'pro' ? 'inicial' : 'pro';
    var botao = $('fa-trocar-plano');
    nf.ocupado(botao, true);
    nf.funcao('fiscal-conta', { acao: 'trocar_plano', plano: novo }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) {
        if (r.dados && r.dados.plano) st.estado = r.dados.tenant_id ? r.dados : Object.assign({}, st.estado, { plano: r.dados.plano });
        else st.estado.plano = novo;
        desenhar();
        nf.aviso($('fa-aviso-plano'), 'Plano alterado para o ' + nf.PLANOS[st.estado.plano].nome + '.', 'ok');
        return;
      }
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-plano'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  /* ---------- certificado ---------- */
  function enviarCertificado(ev) {
    ev.preventDefault();
    nf.erroCampo('fa-pfx', ''); nf.erroCampo('fa-pfx-senha', ''); nf.aviso($('fa-aviso-cert'), '');
    var arquivo = $('fa-pfx').files && $('fa-pfx').files[0];
    var senha = $('fa-pfx-senha').value;
    if (!arquivo) { nf.erroCampo('fa-pfx', 'Escolha o arquivo do certificado.'); return; }
    if (!senha) { nf.erroCampo('fa-pfx-senha', 'Informe a senha do certificado.'); return; }
    var form = new FormData();
    form.append('tenant_id', st.estado.tenant_id);
    form.append('pfx', arquivo, arquivo.name || 'certificado.pfx');
    form.append('senha', senha);
    var botao = $('fa-enviar-a1');
    nf.ocupado(botao, true, 'Enviando…');
    nf.app('/v1/onboarding/certificate', form).then(function (r) {
      nf.ocupado(botao, false);
      $('fa-pfx-senha').value = '';
      if (r.ok) {
        st.estado.certificado = { subject: r.dados.subject, not_after: r.dados.not_after };
        desenhar();
        nf.aviso($('fa-aviso-cert'), nf.esc('Certificado de ' + nf.titular(r.dados.subject) + ' válido até ' + nf.dataBR(r.dados.not_after)), 'ok');
        return;
      }
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-cert'), nf.esc(CERT[r.codigo] || r.mensagem || GENERICO), 'erro');
    });
  }

  /* ---------- procuração eletrônica ao escritório (migrações 20261111180000 e 20261111220000) ----------
     Só no plano Escritório: a empresa cliente dá procuração ao escritório, que assina as notas dela com o A1 do
     escritório. A nó não assina por ninguém. Montado no painel de cada empresa (Minhas empresas); fala com
     /v1/onboarding/procuracao. */
  var PROC_INDISPONIVEL = {
    ESCRITORIO_SEM_CERTIFICADO: 'Para receber procurações, o escritório precisa ter o próprio certificado A1 cadastrado. Envie na linha do escritório, em Minhas empresas.',
    PROCURADOR_CERT_VENCIDO: 'O certificado A1 do escritório venceu. Envie o novo na linha do escritório para as procurações voltarem a valer.',
    PROCURACAO_SO_NO_ESCRITORIO: 'A procuração vale só para as empresas clientes do escritório. Esta empresa emite com o próprio certificado A1.'
  };
  function hojeIso() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function htmlProcuracao(px) {
    return '<p class="nf-aviso" id="' + px + '-indisponivel" role="status" hidden></p>' +
      '<div id="' + px + '-passos">' +
      '<p class="nf-texto">Com a procuração, o escritório assina as notas desta empresa com o certificado A1 do escritório, sem precisar do A1 dela.</p>' +
      '<p class="nf-aviso nf-aviso--info nf-proc-ja-tem"><b>A empresa já deu procuração ao escritório com o serviço NFS-e?</b> Toque direto em “Já fiz a procuração”: conferimos na Receita na hora. Procuração antiga do e-CAC sem o serviço NFS-e não vale para emitir.</p>' +
      '<p class="nf-texto">Se ainda não deu, o responsável pela empresa faz no Portal de Serviços da Receita Federal, com a conta gov.br (nível prata ou ouro):</p>' +
      '<ol class="nf-proc-passos">' +
      '<li>Entre em <a href="https://servicos.receitafederal.gov.br/" target="_blank" rel="noopener">servicos.receitafederal.gov.br</a> e escolha o perfil da empresa.</li>' +
      '<li>Abra <b>Procurações</b> e toque em <b>Nova Autorização</b>.</li>' +
      '<li>Em procurador, informe o CNPJ do escritório, <b class="nf-proc-doc" id="' + px + '-doc">…</b><span id="' + px + '-nome-wrap" hidden> (<span id="' + px + '-nome"></span>)</span>.</li>' +
      '<li>Escolha a vigência (pelo menos 1 ano) e marque o serviço <b>NFS-e</b>.</li>' +
      '<li>Confirme e assine a autorização.</li></ol>' +
      '<form id="' + px + '-form" class="nf-form" novalidate>' +
      '<div class="nf-campo"><label for="' + px + '-validade">Válida até (opcional)</label><input id="' + px + '-validade" type="date">' +
      '<small class="nf-erro" id="' + px + '-validade-erro" hidden></small></div>' +
      '<p class="nf-aviso" id="' + px + '-aviso" role="status" hidden></p>' +
      '<div class="nf-acoes"><button type="submit" class="fi-btn fi-btn--borda" id="' + px + '-feito">Já fiz a procuração</button>' +
      '<button type="button" class="fi-btn fi-btn--borda" id="' + px + '-conferir" hidden>Conferir de novo</button></div>' +
      '</form></div>';
  }
  /* Um bloco de procuração. `tenantId()` diz de qual empresa; `aoMudar(dados)` redesenha o resto da página. */
  function montarProcuracao(px, tenantId, aoMudar) {
    $(px + '-bloco').innerHTML = htmlProcuracao(px);
    var dados = null;
    function status(proc) {
      var aviso = $(px + '-aviso');
      if (proc.valida_ate && !$(px + '-validade').value) $(px + '-validade').value = String(proc.valida_ate).slice(0, 10);
      $(px + '-conferir').hidden = proc.status === 'confirmada';
      if (proc.status === 'confirmada') { nf.aviso(aviso, 'Procuração conferida na Receita: as notas desta empresa saem assinadas pelo escritório.', 'ok'); return; }
      if (proc.status === 'invalida' || proc.ultimo_erro === 'E2245' || proc.ultimo_erro === 'E2243' || proc.ultimo_erro === 'E0718') {
        nf.aviso(aviso, 'A Receita ainda não mostra a procuração. Confira o procurador e o serviço NFS-e; conferimos de novo sozinhos e as notas saem assim que ela aparecer.', 'info');
        return;
      }
      nf.aviso(aviso, 'Procuração registrada. A conferência na Receita não respondeu agora; tentamos de novo sozinhos a cada 2 minutos.', 'info');
    }
    function desenhar(d) {
      dados = d;
      var jaTem = d.modo === 'procuracao' && !!d.procuracao;
      var indisponivel = !d.disponivel && !jaTem;
      nf.aviso($(px + '-indisponivel'), indisponivel ? nf.esc(PROC_INDISPONIVEL[d.motivo] || 'O cadastro por procuração está indisponível agora.') : '', 'info');
      $(px + '-passos').hidden = indisponivel;
      if (d.procurador) {
        $(px + '-doc').textContent = nf.formatarDocumento(nf.digitos(d.procurador.documento));
        $(px + '-nome').textContent = d.procurador.nome || '';
        $(px + '-nome-wrap').hidden = !d.procurador.nome;
      }
      if (jaTem) status(d.procuracao);
      if (aoMudar) aoMudar(d);
    }
    function chamar(corpo, botao, rotulo) {
      if (botao) nf.ocupado(botao, true, rotulo);
      corpo.tenant_id = tenantId();
      return nf.app('/v1/onboarding/procuracao', corpo).then(function (r) {
        if (botao) nf.ocupado(botao, false);
        if (r.ok && r.dados) { desenhar(r.dados); return r; }
        if (r.status === 401) return r;
        if (r.codigo === 'VALIDADE_PASSADA') nf.erroCampo(px + '-validade', 'Esta data já passou.');
        else if (corpo.acao !== 'consultar') nf.aviso($(px + '-aviso'), nf.esc(r.mensagem || GENERICO), 'erro');
        return r;
      });
    }
    $(px + '-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      nf.erroCampo(px + '-validade', '');
      nf.aviso($(px + '-aviso'), '');
      var validade = $(px + '-validade').value || null;
      if (validade && validade < hojeIso()) { nf.erroCampo(px + '-validade', 'Esta data já passou.'); return; }
      chamar({ acao: 'declarar', valida_ate: validade }, $(px + '-feito'), 'Conferindo na Receita…');
    });
    $(px + '-conferir').addEventListener('click', function () { chamar({ acao: 'conferir' }, $(px + '-conferir'), 'Conferindo…'); });
    return {
      carregar: function () {
        if (!tenantId()) return Promise.resolve(null);
        nf.aviso($(px + '-aviso'), '');
        $(px + '-validade').value = '';
        return chamar({ acao: 'consultar' });
      },
      dados: function () { return dados; }
    };
  }

  /* ---------- dados fiscais ---------- */
  /** MEI não informa o percentual do Simples na nota (a Sefin recusa, regra E0710). */
  function ehMei() { return !!(st.estado && st.estado.empresa && st.estado.empresa.regime === 'mei'); }
  function abrirFiscal() {
    var e = st.estado || {}, f = e.fiscal || {};
    $('fa-form-fiscal').hidden = false;
    $('fa-campo-percentual').hidden = ehMei();
    var dia = $('fa-resumo-dia-mes');
    if (dia.options.length === 0) for (var i = 1; i <= 28; i++) { var o = document.createElement('option'); o.value = String(i); o.textContent = String(i); dia.appendChild(o); }
    $('fa-percentual').value = f.p_tot_trib_sn != null ? String(f.p_tot_trib_sn).replace('.', ',') : '';
    $('fa-contador').value = f.contador_email || '';
    var freq = f.resumo && f.resumo.frequencia ? f.resumo.frequencia : '';
    var radios = document.getElementsByName('fa-resumo');
    for (var j = 0; j < radios.length; j++) radios[j].checked = radios[j].value === freq;
    if (freq) $(freq === 'semanal' ? 'fa-resumo-dia-semana' : 'fa-resumo-dia-mes').value = String(f.resumo.dia);
    if (!st.seletor) st.seletor = nf.seletorCodigo($('fa-seletor'), { cnae: (e.empresa || {}).cnae, atual: f.codigo_servico_nacional });
  }
  var CAMPO_FISCAL = { codigo_servico_nacional: 'fa-codigo-servico', p_tot_trib_sn: 'fa-percentual', contador_email: 'fa-contador' };
  function salvarFiscal(ev) {
    ev.preventDefault();
    Object.keys(CAMPO_FISCAL).forEach(function (k) { nf.erroCampo(CAMPO_FISCAL[k], ''); });
    nf.aviso($('fa-aviso-fiscal'), '');
    var codigo = st.seletor ? st.seletor.valor() : '';
    var mei = ehMei();
    var pct = mei ? null : nf.percentual($('fa-percentual').value);
    var falhou = false;
    if (!/^\d{6}$/.test(codigo)) { nf.erroCampo('fa-codigo-servico', 'Escolha o código de serviço.'); falhou = true; }
    if (!mei && pct === null) { nf.erroCampo('fa-percentual', 'Use um número de 0 a 100, com até 2 casas.'); falhou = true; }
    var corpo = { acao: 'configurar', codigo_servico_nacional: codigo };
    if (!mei) corpo.p_tot_trib_sn = pct;
    if (st.estado.plano === 'pro') {
      var contador = nf.texto($('fa-contador').value);
      if (contador && !nf.emailValido(contador)) { nf.erroCampo('fa-contador', 'Informe um e-mail válido ou deixe em branco.'); falhou = true; }
      corpo.contador_email = contador || null;
      var radios = document.getElementsByName('fa-resumo'), resumo = null;
      for (var i = 0; i < radios.length; i++) if (radios[i].checked && radios[i].value) {
        resumo = { frequencia: radios[i].value, dia: Number($(radios[i].value === 'semanal' ? 'fa-resumo-dia-semana' : 'fa-resumo-dia-mes').value) };
      }
      corpo.resumo = resumo;
    }
    if (falhou) return;
    var botao = $('fa-salvar-fiscal');
    nf.ocupado(botao, true, 'Salvando…');
    nf.funcao('fiscal-conta', corpo).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) {
        if (r.dados && r.dados.tenant_id) st.estado = r.dados;
        else st.estado.fiscal = { codigo_servico_nacional: codigo, p_tot_trib_sn: pct, contador_email: corpo.contador_email || null, resumo: corpo.resumo || null };
        $('fa-form-fiscal').hidden = true;
        desenhar();
        nf.aviso($('fa-aviso'), 'Dados fiscais salvos.', 'ok');
        return;
      }
      if (r.status === 401) return;
      if (r.codigo === 'DADOS_FISCAIS_INVALIDOS' && CAMPO_FISCAL[r.dados.campo]) { nf.erroCampo(CAMPO_FISCAL[r.dados.campo], r.mensagem || 'Confira este campo.'); return; }
      nf.aviso($('fa-aviso-fiscal'), nf.esc(r.codigo === 'PLANO_SEM_RESUMO' ? 'O resumo das notas é do plano Pro.' : (r.mensagem || GENERICO)), 'erro');
    });
  }

  /* ---------- cancelar ---------- */
  function perguntarCancelamento() {
    var a = (st.estado && st.estado.assinatura) || {};
    $('fa-cancelar-pergunta').textContent = emTeste(a)
      ? 'Cancelar o teste? A assinatura termina agora e nada é cobrado.'
      : 'Cancelar a assinatura? Você emite até ' + nf.dataBR(a.periodo_fim || a.cancelamento_agendado_para);
    $('fa-confirmar-cancelar').hidden = false;
    $('fa-cancelar').hidden = true;
  }
  function cancelar() {
    var botao = $('fa-cancelar-sim');
    nf.ocupado(botao, true, 'Cancelando…');
    nf.funcao('fiscal-conta', { acao: 'cancelar' }).then(function (r) {
      nf.ocupado(botao, false);
      $('fa-confirmar-cancelar').hidden = true;
      $('fa-cancelar').hidden = false;
      if (r.ok) {
        var msg = r.dados.cancelada_agora ? 'Assinatura cancelada. Nada foi cobrado.'
          : 'Cancelamento agendado. Você emite até ' + nf.dataBR(r.dados.cancelamento_agendado_para) + '.';
        return carregar().then(function () { nf.aviso($('fa-aviso'), msg, 'ok'); });
      }
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-cancelar'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  /* ---------- apagar ---------- */
  function apagar() {
    if ($('fa-apagar-texto').value !== 'APAGAR') return;
    var botao = $('fa-apagar-sim');
    nf.ocupado(botao, true, 'Apagando…');
    nf.funcao('fiscal-conta', { acao: 'apagar_conta', confirmacao: 'APAGAR' }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) {
        nf.sessao.limpar();
        nf.cadastro.limpar();
        st.estado = null;
        telaLogin('Conta apagada. A assinatura foi cancelada e o certificado, os modelos e os números saíram do sistema.', 'ok');
        return;
      }
      botao.disabled = $('fa-apagar-texto').value !== 'APAGAR';
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-apagar'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  /* ---------- conta Escritório: abas, Minhas empresas e Relatórios ----------
     Só quando `estado.escritorio` existe (fiscal-conta, plano escritorio_5|20|50). Meus dados reaproveita as
     seções de cima (escritório, plano e assinatura, cartão, cancelamento); o certificado e os dados fiscais de cada
     empresa, inclusive a do escritório, ficam numa linha de Minhas empresas. Contas Inicial/Pro não passam daqui. */
  var ABAS = ['dados', 'empresas', 'relatorios'];
  var MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  var SITUACAO = {
    pronta: ['Pronta', 'ok'],
    falta_certificado: ['Falta certificado A1', ''],
    falta_dados_fiscais: ['Faltam dados fiscais', ''],
    certificado_vencido: ['Certificado vencido', 'erro'],
    procuracao_pendente: ['Procuração pendente', ''],
    desativada: ['Desativada', 'off']
  };
  var SITUACAO_NOTA = {
    issued: ['Emitida', 'ok'], rejected: ['Recusada', 'erro'], queued: ['Na fila', ''], signing: ['Na fila', ''], sent: ['Na fila', ''],
    cancel_requested: ['Cancelamento pedido', ''], cancelled: ['Cancelada', 'off'], skipped: ['Não emitida', 'off']
  };
  var BOTAO_FAIXA = ' <button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-ir-faixa>Trocar faixa</button>';
  var ec = { aba: null, acao: null, seletor: null, relCarregado: false, relPedido: 0, faixa: null };
  var moldeSeletor = $('fa-emp-seletor').cloneNode(true);

  function escritorio() { return st.estado && st.estado.escritorio ? st.estado.escritorio : null; }
  function pill(s) { return '<span class="nf-status' + (s[1] ? ' nf-status--' + s[1] : '') + '">' + nf.esc(s[0]) + '</span>'; }
  function situacaoEmpresa(emp) {
    if (emp.situacao === 'certificado_vencendo') {
      var fim = emp.certificado && emp.certificado.not_after ? new Date(emp.certificado.not_after).getTime() : NaN;
      if (isNaN(fim)) return ['Certificado vence em breve', ''];
      var n = Math.max(0, Math.ceil((fim - Date.now()) / 86400000));
      return [n === 0 ? 'Certificado vence hoje' : 'Certificado vence em ' + n + (n === 1 ? ' dia' : ' dias'), ''];
    }
    return SITUACAO[emp.situacao] || [emp.situacao || '—', ''];
  }
  function nomeEmpresa(emp) { return emp.razao_social || nf.formatarCnpj(emp.cnpj); }
  function empresaPorId(id) {
    var x = escritorio();
    if (!x) return null;
    for (var i = 0; i < x.empresas.length; i++) if (x.empresas[i].tenant_id === id) return x.empresas[i];
    return null;
  }

  /* ---------- abas ---------- */
  function abaDoHash() {
    var h = location.hash.replace(/^#/, '');
    if (h === 'assinatura') return 'dados';
    if (h === 'certificado') return 'empresas';
    return ABAS.indexOf(h) >= 0 ? h : null;
  }
  function mostrarAba(aba, opcoes) {
    opcoes = opcoes || {};
    ec.aba = aba;
    ABAS.forEach(function (a) {
      var tab = $('fa-aba-' + a), ativa = a === aba;
      tab.setAttribute('aria-selected', ativa ? 'true' : 'false');
      tab.tabIndex = ativa ? 0 : -1;
      $('fa-painel-' + a).hidden = !ativa;
    });
    // A aba fica no endereço (sem pular a página): o recarregar abre nela.
    if (opcoes.hash !== false && location.hash !== '#' + aba) {
      try { history.replaceState(null, '', '#' + aba); } catch (e) { /* sem history */ }
    }
    if (opcoes.foco) $('fa-aba-' + aba).focus();
    if (aba === 'relatorios' && !ec.relCarregado) carregarRelatorio();
  }

  function proximaCobranca(a) {
    if (!a || a.status === 'cancelada') return 'Sem cobrança';
    if (a.cortesia) return 'Cortesia, sem cobrança';
    if (a.cancelamento_agendado_para) return 'Sem cobrança (cancelamento agendado)';
    if (emTeste(a)) return nf.dataBR(a.trial_ends_at) + ' (fim do teste)';
    return a.periodo_fim ? nf.dataBR(a.periodo_fim) : '—';
  }

  function desenharEscritorio() {
    var x = escritorio();
    ['dados', 'empresas', 'relatorios'].forEach(function (a) {
      var p = $('fa-painel-' + a);
      if (x) { p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', 'fa-aba-' + a); }
      else { p.removeAttribute('role'); p.removeAttribute('aria-labelledby'); }
    });
    $('fa-abas').hidden = !x;
    $('certificado').hidden = !!x;
    $('fa-secao-fiscal').hidden = !!x;
    $('fa-secao-apagar').hidden = !!x;
    $('fa-plano-uso').hidden = !x;
    $('fa-abrir-faixas').hidden = true;
    if (!x) {
      $('fa-painel-dados').hidden = false;
      $('fa-painel-empresas').hidden = true;
      $('fa-painel-relatorios').hidden = true;
      $('fa-faixas').hidden = true;
      return;
    }
    var e = st.estado, a = e.assinatura, emp = e.empresa || {};
    var faixa = nf.FAIXAS[x.plano] || { nome: 'Até ' + x.max_empresas + ' empresas', centavos: null };
    // A configuração que falta ao escritório é só pagamento e ativação; A1 e dados fiscais são por empresa.
    $('fa-retomar').hidden = !(e.onboarding_etapa === 'pagamento' || e.onboarding_etapa === 'ativacao');

    $('fa-empresa-passo').textContent = 'Escritório';
    $('fa-empresa-titulo').textContent = 'Escritório';
    $('fa-empresa').innerHTML = linhas([
      ['Razão social', emp.razao_social], ['CNPJ', emp.cnpj ? nf.formatarCnpj(emp.cnpj) : ''],
      ['Responsável', emp.responsavel], ['E-mail', emp.email], ['WhatsApp', emp.telefone ? nf.mascararTelefone(emp.telefone) : '']
    ]);
    $('fa-plano-nome').textContent = 'Escritório';
    $('fa-plano-notas-rotulo').textContent = 'Faixa';
    $('fa-plano-notas').textContent = faixa.nome + (faixa.centavos ? ' · ' + nf.reais(faixa.centavos) + '/mês' : '');
    var excedente = Number(x.notas_mes) - Number(x.notas_limite);
    $('fa-plano-uso').innerHTML = linhas([
      ['Empresas ativas', x.empresas_ativas + ' de ' + x.max_empresas],
      ['Notas do mês', x.notas_mes + ' de ' + x.notas_limite + (excedente > 0 ? ' (' + excedente + ' acima da franquia)' : '')],
      ['Próxima cobrança', proximaCobranca(a)]
    ]);
    var ativa = a && a.status !== 'cancelada';
    $('fa-trocar-plano').hidden = true;
    $('fa-abrir-faixas').hidden = !ativa || !!a.cancelamento_agendado_para || a.ciclo === 'anual';
    if ($('fa-abrir-faixas').hidden) $('fa-faixas').hidden = true;
    desenharFaixas(x);
    desenharEmpresas(x);
    preencherFiltros(x);
    mostrarAba(ec.aba || abaDoHash() || 'dados', { hash: false });
  }

  /* ---------- trocar faixa ---------- */
  function desenharFaixas(x) {
    $('fa-faixas-lista').innerHTML = Object.keys(nf.FAIXAS).map(function (c) {
      var f = nf.FAIXAS[c], atual = c === x.plano, pequena = Number(x.empresas_ativas) > f.empresas;
      return '<button type="button" class="nf-faixa' + (atual ? ' nf-faixa--atual' : '') + '" data-faixa="' + c + '"' +
        (atual ? ' disabled aria-current="true"' : '') + '><b>' + nf.esc(f.nome) + '</b><span>' + nf.esc(nf.reais(f.centavos)) +
        '/mês · ' + f.notas + ' notas por mês</span>' +
        (atual ? '<small>Faixa atual</small>' : pequena ? '<small>Você tem ' + x.empresas_ativas + ' empresas ativas</small>' : '') + '</button>';
    }).join('');
    $('fa-confirmar-faixa').hidden = true;
  }
  function abrirFaixas() {
    var aberto = $('fa-faixas').hidden;
    $('fa-faixas').hidden = !aberto;
    $('fa-abrir-faixas').setAttribute('aria-expanded', aberto ? 'true' : 'false');
    $('fa-confirmar-faixa').hidden = true;
  }
  function irParaFaixas() {
    mostrarAba('dados');
    if (!$('fa-abrir-faixas').hidden) {
      $('fa-faixas').hidden = false;
      $('fa-abrir-faixas').setAttribute('aria-expanded', 'true');
    }
    var alvo = $('assinatura');
    if (alvo && typeof alvo.scrollIntoView === 'function') alvo.scrollIntoView({ block: 'start' });
    var primeiro = $('fa-faixas-lista').querySelector('button:not([disabled])');
    if (primeiro && !$('fa-faixas').hidden) primeiro.focus();
  }
  function perguntarFaixa(codigo) {
    var f = nf.FAIXAS[codigo];
    if (!f) return;
    ec.faixa = codigo;
    $('fa-faixa-pergunta').textContent = 'Trocar para a faixa ' + f.nome + ', ' + nf.reais(f.centavos) + '/mês? O valor novo vale a partir da próxima cobrança.';
    $('fa-confirmar-faixa').hidden = false;
    $('fa-faixa-sim').focus();
  }
  function trocarFaixa() {
    var codigo = ec.faixa;
    if (!codigo) return;
    var botao = $('fa-faixa-sim');
    nf.ocupado(botao, true, 'Trocando…');
    nf.aviso($('fa-aviso-plano'), '');
    nf.funcao('fiscal-conta', { acao: 'trocar_plano', plano: codigo }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok && r.dados && r.dados.tenant_id) {
        st.estado = r.dados;
        $('fa-faixas').hidden = true;
        $('fa-abrir-faixas').setAttribute('aria-expanded', 'false');
        desenhar();
        nf.aviso($('fa-aviso-plano'), nf.esc('Faixa alterada para ' + nf.FAIXAS[codigo].nome + '.'), 'ok');
        return;
      }
      if (r.ok) return carregar();
      if (r.status === 401) return;
      $('fa-confirmar-faixa').hidden = true;
      nf.aviso($('fa-aviso-plano'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  /* ---------- Minhas empresas ---------- */
  function botaoLinha(acao, emp, rotulo) {
    return '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-acao="' + acao + '" data-tenant="' + nf.esc(emp.tenant_id) +
      '" aria-label="' + nf.esc(rotulo + ': ' + nomeEmpresa(emp)) + '">' + nf.esc(rotulo) + '</button>';
  }
  function linhaEmpresa(emp) {
    var ativa = emp.ativa !== false, acoes = [];
    if (ativa) {
      var porProcuracao = emp.modo_autenticacao === 'procuracao';
      acoes.push(botaoLinha('cert', emp, emp.certificado && !porProcuracao ? 'Trocar A1' : 'Enviar A1'));
      // A empresa do escritório é a procuradora das outras: ela assina com o A1 dela.
      if (!emp.principal) acoes.push(botaoLinha('proc', emp, 'Procuração'));
      acoes.push(botaoLinha('fiscal', emp, 'Dados fiscais'));
    }
    if (!emp.principal) acoes.push(botaoLinha(ativa ? 'desativar' : 'reativar', emp, ativa ? 'Desativar' : 'Reativar'));
    return '<tr' + (ativa ? '' : ' class="nf-linha-off"') + '><th scope="row">' + nf.esc(nomeEmpresa(emp)) +
      (emp.principal ? ' <span class="nf-selo">Escritório</span>' : '') + '</th>' +
      '<td class="nf-nowrap">' + nf.esc(nf.formatarCnpj(emp.cnpj)) + '</td>' +
      '<td>' + pill(situacaoEmpresa(emp)) + '</td>' +
      '<td class="nf-num">' + nf.esc(String(emp.notas_mes || 0)) + '</td>' +
      '<td><div class="nf-acoes-linha">' + acoes.join('') + '</div></td></tr>';
  }
  function desenharEmpresas(x) {
    var f = nf.FAIXAS[x.plano];
    $('fa-empresas-resumo').textContent = x.empresas_ativas + ' de ' + x.max_empresas + ' empresas ativas' +
      (f ? ' na faixa ' + f.nome : '') + '. Cada empresa emite com o próprio certificado A1 ou por procuração ao escritório, com os próprios dados fiscais.';
    var a = st.estado.assinatura, motivo = '';
    if (!a) motivo = 'Sem assinatura ativa: nenhuma empresa emite.';
    else if (a.status === 'recusada') motivo = 'Pagamento recusado: nenhuma empresa emite até o cartão ser trocado em Meus dados.';
    else if (a.status === 'cancelada') motivo = 'Assinatura cancelada: nenhuma empresa emite.';
    nf.aviso($('fa-aviso-emissao'), nf.esc(motivo), 'erro');
    $('fa-empresas-linhas').innerHTML = x.empresas.map(linhaEmpresa).join('');
    // A linha da ação aberta pode ter mudado (ex.: desativada): o painel fecha se a empresa sumiu ou desativou.
    if (ec.acao) {
      var atual = empresaPorId(ec.acao.tenantId);
      if (!atual || atual.ativa === false) fecharAcao(); else ec.acao.empresa = atual;
    }
  }
  function fecharAcao() {
    ec.acao = null;
    $('fa-empresa-acao').hidden = true;
  }
  function abrirAcao(tipo, id, botao) {
    var emp = empresaPorId(id);
    if (!emp) return;
    if (tipo === 'reativar') { ativarEmpresa(emp, true, botao); return; }
    ec.acao = { tipo: tipo, tenantId: id, empresa: emp };
    $('fa-empresa-acao').hidden = false;
    $('fa-form-emp-cert').hidden = tipo !== 'cert';
    $('fa-emp-proc').hidden = tipo !== 'proc';
    $('fa-form-emp-fiscal').hidden = tipo !== 'fiscal';
    $('fa-confirmar-desativar').hidden = tipo !== 'desativar';
    $('fa-empresa-acao-titulo').textContent = { cert: 'Certificado A1 de ', proc: 'Procuração de ', fiscal: 'Dados fiscais de ', desativar: 'Desativar ' }[tipo] + nomeEmpresa(emp);
    if (tipo === 'proc') procEmpresa.carregar();
    ['fa-aviso-emp-cert', 'fa-aviso-emp-fiscal'].forEach(function (i) { nf.aviso($(i), ''); });
    ['fa-emp-pfx', 'fa-emp-pfx-senha', 'fa-emp-codigo-servico', 'fa-emp-percentual'].forEach(function (i) { nf.erroCampo(i, ''); });
    if (tipo === 'cert') { $('fa-emp-pfx').value = ''; $('fa-emp-pfx-senha').value = ''; }
    if (tipo === 'fiscal') prepararFiscalEmpresa(emp);
    if (tipo === 'desativar') {
      $('fa-desativar-pergunta').textContent = 'Desativar ' + nomeEmpresa(emp) + '? Ela para de emitir e deixa de contar no limite do plano. As notas e o certificado continuam guardados, e dá para reativar depois.';
    }
    var titulo = $('fa-empresa-acao-titulo');
    if (typeof titulo.scrollIntoView === 'function') titulo.scrollIntoView({ block: 'nearest' });
    titulo.focus();
  }

  // Procuração da empresa ao escritório: o mesmo bloco, com o tenant_id da linha; a tabela recarrega quando muda.
  var procEmpresa = montarProcuracao('fa-emp-proc', function () { return ec.acao && ec.acao.tenantId; }, function (d) {
    var emp = ec.acao && ec.acao.empresa;
    if (emp && d.procuracao && (emp.modo_autenticacao !== d.modo || !emp.procuracao || emp.procuracao.status !== d.procuracao.status)) carregar();
  });

  /* A1 da empresa: o mesmo envio de /v1/onboarding/certificate, com o tenant_id da linha. */
  function enviarCertEmpresa(ev) {
    ev.preventDefault();
    var ac = ec.acao;
    if (!ac) return;
    nf.erroCampo('fa-emp-pfx', ''); nf.erroCampo('fa-emp-pfx-senha', ''); nf.aviso($('fa-aviso-emp-cert'), '');
    var arquivo = $('fa-emp-pfx').files && $('fa-emp-pfx').files[0];
    var senha = $('fa-emp-pfx-senha').value;
    if (!arquivo) { nf.erroCampo('fa-emp-pfx', 'Escolha o arquivo do certificado.'); return; }
    if (!senha) { nf.erroCampo('fa-emp-pfx-senha', 'Informe a senha do certificado.'); return; }
    var form = new FormData();
    form.append('tenant_id', ac.tenantId);
    form.append('pfx', arquivo, arquivo.name || 'certificado.pfx');
    form.append('senha', senha);
    var botao = $('fa-emp-enviar-a1');
    nf.ocupado(botao, true, 'Enviando…');
    nf.app('/v1/onboarding/certificate', form).then(function (r) {
      nf.ocupado(botao, false);
      $('fa-emp-pfx-senha').value = '';
      if (r.ok) {
        var msg = 'Certificado de ' + nf.titular(r.dados.subject) + ' válido até ' + nf.dataBR(r.dados.not_after);
        fecharAcao();
        return carregar().then(function () { nf.aviso($('fa-aviso-empresas'), nf.esc(msg), 'ok'); });
      }
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-emp-cert'), nf.esc(CERT[r.codigo] || r.mensagem || GENERICO), 'erro');
    });
  }

  /* Dados fiscais da empresa: o mesmo seletor de código da página (um novo a cada empresa) e o % do Simples. */
  function prepararFiscalEmpresa(emp) {
    var velho = $('fa-emp-seletor'), novo = moldeSeletor.cloneNode(true);
    velho.parentNode.replaceChild(novo, velho);
    var cnae = emp.cnae || (emp.principal ? (st.estado.empresa || {}).cnae : null);
    ec.seletor = nf.seletorCodigo(novo, { cnae: cnae, atual: emp.codigo_servico_nacional });
    var mei = emp.regime === 'mei';
    $('fa-emp-campo-percentual').hidden = mei;
    $('fa-emp-percentual').value = !mei && emp.p_tot_trib_sn != null ? String(emp.p_tot_trib_sn).replace('.', ',') : '';
  }
  var CAMPO_EMP_FISCAL = { codigo_servico_nacional: 'fa-emp-codigo-servico', p_tot_trib_sn: 'fa-emp-percentual' };
  function salvarFiscalEmpresa(ev) {
    ev.preventDefault();
    var ac = ec.acao;
    if (!ac) return;
    Object.keys(CAMPO_EMP_FISCAL).forEach(function (k) { nf.erroCampo(CAMPO_EMP_FISCAL[k], ''); });
    nf.aviso($('fa-aviso-emp-fiscal'), '');
    var codigo = ec.seletor ? ec.seletor.valor() : '';
    var mei = ac.empresa.regime === 'mei';
    var pct = mei ? null : nf.percentual($('fa-emp-percentual').value);
    var falhou = false;
    if (!/^\d{6}$/.test(codigo)) { nf.erroCampo('fa-emp-codigo-servico', 'Escolha o código de serviço.'); falhou = true; }
    if (!mei && pct === null) { nf.erroCampo('fa-emp-percentual', 'Use um número de 0 a 100, com até 2 casas.'); falhou = true; }
    if (falhou) return;
    var corpo = { acao: 'empresa_configurar', tenant_id: ac.tenantId, codigo_servico_nacional: codigo };
    if (!mei) corpo.p_tot_trib_sn = pct;
    var botao = $('fa-emp-salvar-fiscal');
    var nome = nomeEmpresa(ac.empresa);
    nf.ocupado(botao, true, 'Salvando…');
    nf.funcao('fiscal-conta', corpo).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) {
        fecharAcao();
        var depois = function () { nf.aviso($('fa-aviso-empresas'), nf.esc('Dados fiscais de ' + nome + ' salvos.'), 'ok'); };
        if (r.dados && r.dados.tenant_id) { st.estado = r.dados; desenhar(); depois(); return; }
        return carregar().then(depois);
      }
      if (r.status === 401) return;
      if (r.codigo === 'DADOS_FISCAIS_INVALIDOS' && CAMPO_EMP_FISCAL[r.dados.campo]) { nf.erroCampo(CAMPO_EMP_FISCAL[r.dados.campo], r.mensagem || 'Confira este campo.'); return; }
      nf.aviso($('fa-aviso-emp-fiscal'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  function ativarEmpresa(emp, ativa, botao) {
    var nome = nomeEmpresa(emp);
    nf.ocupado(botao, true, ativa ? 'Reativando…' : 'Desativando…');
    nf.aviso($('fa-aviso-empresas'), '');
    nf.funcao('fiscal-conta', { acao: 'empresa_ativar', tenant_id: emp.tenant_id, ativa: ativa }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) {
        fecharAcao();
        var depois = function () { nf.aviso($('fa-aviso-empresas'), nf.esc((ativa ? 'Empresa reativada: ' : 'Empresa desativada: ') + nome + '.'), 'ok'); };
        if (r.dados && r.dados.tenant_id) { st.estado = r.dados; desenhar(); depois(); return; }
        return carregar().then(depois);
      }
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-empresas'), nf.esc(r.mensagem || GENERICO) + (r.codigo === 'EMPRESAS_ACIMA_DO_LIMITE' ? BOTAO_FAIXA : ''), 'erro');
    });
  }

  function abrirAdicionar() {
    var abrir = $('fa-form-adicionar').hidden;
    $('fa-form-adicionar').hidden = !abrir;
    $('fa-abrir-adicionar').setAttribute('aria-expanded', abrir ? 'true' : 'false');
    nf.erroCampo('fa-add-cnpj', '');
    nf.aviso($('fa-aviso-adicionar'), '');
    if (abrir) $('fa-add-cnpj').focus();
  }
  function adicionarEmpresa(ev) {
    ev.preventDefault();
    var cnpj = nf.digitos($('fa-add-cnpj').value);
    nf.erroCampo('fa-add-cnpj', '');
    nf.aviso($('fa-aviso-adicionar'), '');
    if (!nf.cnpjValido(cnpj)) { nf.erroCampo('fa-add-cnpj', 'CNPJ inválido. Confira os 14 números.'); return; }
    var botao = $('fa-adicionar');
    nf.ocupado(botao, true, 'Consultando a Receita…');
    nf.funcao('fiscal-conta', { acao: 'empresa_adicionar', cnpj: cnpj }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) {
        var reativada = !!(r.dados.adicionada && r.dados.adicionada.reativada);
        $('fa-add-cnpj').value = '';
        $('fa-form-adicionar').hidden = true;
        $('fa-abrir-adicionar').setAttribute('aria-expanded', 'false');
        var nova = r.dados.adicionada && r.dados.adicionada.tenant_id;
        var depois = function () {
          var escolha = nova
            ? ' <span class="nf-acoes-linha"><button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-acao="cert" data-tenant="' + nf.esc(nova) +
              '">Enviar o A1 da empresa</button><button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-acao="proc" data-tenant="' + nf.esc(nova) +
              '">Usar procuração ao escritório</button></span>'
            : '';
          nf.aviso($('fa-aviso-empresas'), (reativada ? 'Empresa reativada.' : 'Empresa adicionada.') +
            ' Agora escolha como ela vai assinar as notas: com o certificado A1 dela ou com procuração ao escritório. Depois, os dados fiscais.' + escolha, 'ok');
        };
        if (r.dados.tenant_id) { st.estado = r.dados; desenhar(); depois(); return; }
        return carregar().then(depois);
      }
      if (r.status === 401) return;
      if (r.codigo === 'EMPRESAS_ACIMA_DO_LIMITE') {
        var x = escritorio();
        var msg = r.mensagem || ('Seu plano permite até ' + (x ? x.max_empresas : '') + ' empresas.');
        nf.aviso($('fa-aviso-adicionar'), nf.esc(msg) + BOTAO_FAIXA, 'erro');
        return;
      }
      if (r.dados && r.dados.campo === 'cnpj') { nf.erroCampo('fa-add-cnpj', r.mensagem || 'Confira o CNPJ.'); return; }
      nf.aviso($('fa-aviso-adicionar'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  /* ---------- Relatórios ---------- */
  function mesAtual() {
    var p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' })
      .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '-' + p.month;
  }
  function nomeMes(mes) {
    var m = /^(\d{4})-(\d{2})$/.exec(mes || '');
    return m ? MESES[Number(m[2]) - 1] + ' de ' + m[1] : mes;
  }
  function preencherFiltros(x) {
    var sel = $('fa-rel-mes');
    if (!sel.options.length) {
      var p = mesAtual().split('-'), ano = Number(p[0]), mes = Number(p[1]);
      for (var i = 0; i < 24; i++) {
        var v = ano + '-' + (mes < 10 ? '0' : '') + mes;
        var o = document.createElement('option');
        o.value = v; o.textContent = nomeMes(v);
        sel.appendChild(o);
        mes -= 1;
        if (mes === 0) { mes = 12; ano -= 1; }
      }
    }
    var emp = $('fa-rel-empresa'), antes = emp.value;
    emp.innerHTML = '<option value="">Todas as empresas</option>' + x.empresas.map(function (e) {
      return '<option value="' + nf.esc(e.tenant_id) + '">' + nf.esc(nomeEmpresa(e)) + '</option>';
    }).join('');
    emp.value = empresaPorId(antes) ? antes : '';
  }
  function valorTexto(v) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return '—';
    return n.toFixed(2).replace('.', ',').replace(/^\d+/, function (i) { return i.replace(/\B(?=(\d{3})+$)/g, '.'); });
  }
  function linhaEntrega(e) {
    var ok = e.status === 'enviado';
    var destino = e.canal === 'whatsapp' ? nf.formatarTelefone(e.destino) : e.destino;
    return '<li class="nf-entrega nf-entrega--' + (ok ? 'ok' : 'falhou') + '"><span aria-hidden="true">' + (ok ? '✓' : '✗') + '</span> ' +
      nf.esc(destino) + ' <small>' + (e.canal === 'whatsapp' ? 'WhatsApp' : 'e-mail') + ' · ' + (ok ? 'enviado' : 'falhou') + '</small></li>';
  }
  function linhaNota(n) {
    var emp = n.empresa || {}, tom = n.tomador || {};
    var entregas = n.entregas && n.entregas.length ? '<ul class="nf-entregas">' + n.entregas.map(linhaEntrega).join('') + '</ul>' : '—';
    var pdf = n.tem_pdf
      ? '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-pdf="' + nf.esc(n.invoice_id) + '" aria-label="' +
        nf.esc('Baixar o PDF da nota' + (n.numero ? ' ' + n.numero : '') + (tom.nome ? ' de ' + tom.nome : '')) + '">PDF</button>'
      : '—';
    return '<tr><td class="nf-nowrap">' + nf.esc(nf.dataBR(n.emitida_em || n.criada_em)) + '</td>' +
      '<td>' + nf.esc(emp.razao_social || '') + (emp.cnpj ? '<small class="nf-sub">' + nf.esc(nf.formatarCnpj(emp.cnpj)) + '</small>' : '') + '</td>' +
      '<td>' + nf.esc(tom.nome || '—') + (tom.documento ? '<small class="nf-sub">' + nf.esc(nf.formatarDocumento(tom.documento)) + '</small>' : '') + '</td>' +
      '<td class="nf-desc">' + nf.esc(n.descricao || '—') + '</td>' +
      '<td class="nf-nowrap">' + nf.esc(n.codigo_tributacao ? nf.formatarCodigo(n.codigo_tributacao) : '—') + '</td>' +
      '<td class="nf-num nf-nowrap">' + nf.esc(valorTexto(n.valor)) + '</td>' +
      '<td>' + pill(SITUACAO_NOTA[n.situacao] || [n.situacao || '—', '']) + (n.motivo ? '<small class="nf-sub">' + nf.esc(n.motivo) + '</small>' : '') + '</td>' +
      '<td>' + entregas + '</td><td>' + pdf + '</td></tr>';
  }
  function desenharRelatorio(d, mes) {
    var t = d.totais || {};
    $('fa-rel-emitidas').textContent = String(t.emitidas || 0);
    $('fa-rel-valor').textContent = nf.reais(Math.round(Number(t.valor_emitido || 0) * 100));
    $('fa-rel-recusadas').textContent = String(t.recusadas || 0);
    $('fa-rel-fila').textContent = String(t.na_fila || 0);
    var notas = Array.isArray(d.notas) ? d.notas : [];
    $('fa-rel-vazio').textContent = 'Nenhuma nota em ' + nomeMes(mes);
    $('fa-rel-vazio').hidden = notas.length > 0;
    $('fa-rel-rolagem').hidden = notas.length === 0;
    $('fa-notas-linhas').innerHTML = notas.map(linhaNota).join('');
  }
  function carregarRelatorio() {
    ec.relCarregado = true;
    var mes = $('fa-rel-mes').value || mesAtual(), tenant = $('fa-rel-empresa').value;
    var corpo = { acao: 'relatorio', mes: mes };
    if (tenant) corpo.tenant_id = tenant;
    var pedido = ++ec.relPedido;
    nf.aviso($('fa-aviso-rel'), '');
    $('fa-rel-rolagem').setAttribute('aria-busy', 'true');
    return nf.funcao('fiscal-conta', corpo).then(function (r) {
      if (pedido !== ec.relPedido) return; // chegou depois de outro filtro
      $('fa-rel-rolagem').removeAttribute('aria-busy');
      if (r.ok) { desenharRelatorio(r.dados, mes); return; }
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-rel'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }
  function baixarPdf(botao) {
    var id = botao.getAttribute('data-pdf');
    nf.ocupado(botao, true, '…');
    nf.aviso($('fa-aviso-rel'), '');
    nf.appArquivo('/v1/fiscal/nota-pdf', { invoice_id: id }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok && r.blob) { nf.baixarArquivo(r.blob, r.nome || 'nfse-' + id + '.pdf'); return; }
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-rel'), r.status === 404 ? 'O PDF desta nota não está disponível.' : nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  $('fa-abas').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[role=tab]');
    if (b) mostrarAba(b.getAttribute('data-aba'));
  });
  $('fa-abas').addEventListener('keydown', function (ev) {
    var i = ABAS.indexOf(ec.aba), n = null;
    if (ev.key === 'ArrowRight') n = ABAS[(i + 1) % ABAS.length];
    else if (ev.key === 'ArrowLeft') n = ABAS[(i + ABAS.length - 1) % ABAS.length];
    else if (ev.key === 'Home') n = ABAS[0];
    else if (ev.key === 'End') n = ABAS[ABAS.length - 1];
    if (n) { ev.preventDefault(); mostrarAba(n, { foco: true }); }
  });
  window.addEventListener('hashchange', function () {
    var a = abaDoHash();
    if (a && escritorio() && a !== ec.aba) mostrarAba(a, { hash: false });
  });
  $('fa-abrir-faixas').addEventListener('click', abrirFaixas);
  $('fa-faixas-lista').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-faixa]');
    if (b && !b.disabled) perguntarFaixa(b.getAttribute('data-faixa'));
  });
  $('fa-faixa-nao').addEventListener('click', function () { $('fa-confirmar-faixa').hidden = true; ec.faixa = null; });
  $('fa-faixa-sim').addEventListener('click', trocarFaixa);
  $('fa-painel').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-ir-faixa]');
    if (b) irParaFaixas();
  });
  $('fa-abrir-adicionar').addEventListener('click', abrirAdicionar);
  $('fa-adicionar-cancelar').addEventListener('click', abrirAdicionar);
  $('fa-form-adicionar').addEventListener('submit', adicionarEmpresa);
  $('fa-empresas-linhas').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-acao]');
    if (b) abrirAcao(b.getAttribute('data-acao'), b.getAttribute('data-tenant'), b);
  });
  // Botões da escolha que aparecem no aviso logo depois de adicionar uma empresa.
  $('fa-aviso-empresas').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-acao]');
    if (b) abrirAcao(b.getAttribute('data-acao'), b.getAttribute('data-tenant'), b);
  });
  $('fa-empresa-acao').addEventListener('click', function (ev) {
    if (ev.target.closest && ev.target.closest('[data-fechar-acao]')) fecharAcao();
  });
  $('fa-form-emp-cert').addEventListener('submit', enviarCertEmpresa);
  $('fa-form-emp-fiscal').addEventListener('submit', salvarFiscalEmpresa);
  $('fa-desativar-sim').addEventListener('click', function () { if (ec.acao) ativarEmpresa(ec.acao.empresa, false, $('fa-desativar-sim')); });
  $('fa-rel-mes').addEventListener('change', carregarRelatorio);
  $('fa-rel-empresa').addEventListener('change', carregarRelatorio);
  $('fa-notas-linhas').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-pdf]');
    if (b) baixarPdf(b);
  });

  /* ---------- ligações ---------- */
  $('fa-form-email').addEventListener('submit', pedirCodigo);
  $('fa-form-codigo').addEventListener('submit', entrar);
  $('fa-reenviar').addEventListener('click', function () { $('fa-email').value = st.email; pedirCodigo(); });
  $('fa-trocar-email').addEventListener('click', function () { telaLogin(); });
  $('fa-abrir-cartao').addEventListener('click', abrirCartao);
  $('fa-form-cartao').addEventListener('submit', trocarCartao);
  $('fa-trocar-plano').addEventListener('click', trocarPlano);
  $('fa-form-cert').addEventListener('submit', enviarCertificado);
  $('fa-abrir-fiscal').addEventListener('click', abrirFiscal);
  $('fa-form-fiscal').addEventListener('submit', salvarFiscal);
  $('fa-cancelar').addEventListener('click', perguntarCancelamento);
  $('fa-cancelar-nao').addEventListener('click', function () { $('fa-confirmar-cancelar').hidden = true; $('fa-cancelar').hidden = false; });
  $('fa-cancelar-sim').addEventListener('click', cancelar);
  $('fa-apagar').addEventListener('click', function () { $('fa-confirmar-apagar').hidden = false; $('fa-apagar').hidden = true; $('fa-apagar-texto').value = ''; $('fa-apagar-sim').disabled = true; });
  $('fa-apagar-nao').addEventListener('click', function () { $('fa-confirmar-apagar').hidden = true; $('fa-apagar').hidden = false; });
  $('fa-apagar-texto').addEventListener('input', function () { $('fa-apagar-sim').disabled = $('fa-apagar-texto').value !== 'APAGAR'; });
  $('fa-apagar-sim').addEventListener('click', apagar);
  $('fa-sair').addEventListener('click', function () { nf.sessao.limpar(); st.estado = null; telaLogin(); });
  window.addEventListener('nofiscal:sessao-vencida', function () { telaLogin('Sua sessão venceu. Entre de novo com o código no e-mail.', 'info'); });

  if (nf.sessao.ler()) carregar(); else telaLogin();
})();
