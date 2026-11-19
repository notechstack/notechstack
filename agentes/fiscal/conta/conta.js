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
  /* NBS padrão: 9 dígitos, mostrada como 1.1502.10.00. A lista nacional (NBS 2.0) quem confere é a fiscal-conta. */
  function formatarNbs(n) { var d = String(n || '').replace(/\D/g, ''); return d.length === 9 ? d.slice(0, 1) + '.' + d.slice(1, 5) + '.' + d.slice(5, 7) + '.' + d.slice(7) : d; }
  /** '' quando em branco, os 9 dígitos quando no formato, null quando fora dele. */
  function lerNbs(texto) { var t = String(texto || '').replace(/[.\s]/g, ''); return t === '' ? '' : /^\d{9}$/.test(t) ? t : null; }
  var MSG_NBS = 'A NBS tem 9 números (ex.: 1.1502.10.00). Deixe em branco se não usar.';
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
      ['NBS padrão', f.nbs_padrao ? formatarNbs(f.nbs_padrao) : 'Não definida'],
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
    $('fa-nbs').value = f.nbs_padrao ? formatarNbs(f.nbs_padrao) : '';
    $('fa-contador').value = f.contador_email || '';
    var freq = f.resumo && f.resumo.frequencia ? f.resumo.frequencia : '';
    var radios = document.getElementsByName('fa-resumo');
    for (var j = 0; j < radios.length; j++) radios[j].checked = radios[j].value === freq;
    if (freq) $(freq === 'semanal' ? 'fa-resumo-dia-semana' : 'fa-resumo-dia-mes').value = String(f.resumo.dia);
    if (!st.seletor) st.seletor = nf.seletorCodigo($('fa-seletor'), { cnae: (e.empresa || {}).cnae, atual: f.codigo_servico_nacional });
  }
  var CAMPO_FISCAL = { codigo_servico_nacional: 'fa-codigo-servico', p_tot_trib_sn: 'fa-percentual', nbs_padrao: 'fa-nbs', contador_email: 'fa-contador' };
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
    var nbs = lerNbs($('fa-nbs').value);
    if (nbs === null) { nf.erroCampo('fa-nbs', MSG_NBS); falhou = true; }
    var corpo = { acao: 'configurar', codigo_servico_nacional: codigo, nbs_padrao: nbs || null };
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
        else st.estado.fiscal = { codigo_servico_nacional: codigo, p_tot_trib_sn: pct, nbs_padrao: nbs || null, contador_email: corpo.contador_email || null, resumo: corpo.resumo || null };
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
  // 'guias' só aparece com o módulo Guias ligado (guias.js mostra o botão quando a API diz que está ligado).
  var ABAS = ['dados', 'empresas', 'emitir', 'relatorios', 'nfe', 'api', 'guias'];
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
    // Empresa cliente resolve com o A1 dela ou com procuração ao escritório; a do escritório só com o A1.
    if (emp.situacao === 'falta_certificado' && !emp.principal) return ['Falta A1 ou procuração', ''];
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
    return ABAS.indexOf(h) >= 0 && abaDisponivel(h) ? h : null;
  }
  function abaDisponivel(a) { var b = $('fa-aba-' + a); return !!b && !b.hidden; }
  function mostrarAba(aba, opcoes) {
    opcoes = opcoes || {};
    if (!abaDisponivel(aba)) aba = 'dados';
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
    if (aba === 'emitir' && !em.carregado) carregarEmissao();
    // A aba NF-e mora em nfe.js (carregado depois deste arquivo).
    if (aba === 'nfe' && window.contaNfe) window.contaNfe.abrir();
    // A aba API mora em integracao.js.
    if (aba === 'api' && window.contaApi) window.contaApi.abrir();
    // A aba Guias mora em guias.js (só com o módulo ligado).
    if (aba === 'guias' && window.contaGuias) window.contaGuias.abrir();
  }
  window.contaAbas = { mostrar: mostrarAba, atual: function () { return ec.aba; } };

  function proximaCobranca(a) {
    if (!a || a.status === 'cancelada') return 'Sem cobrança';
    if (a.cortesia) return 'Cortesia, sem cobrança';
    if (a.cancelamento_agendado_para) return 'Sem cobrança (cancelamento agendado)';
    if (emTeste(a)) return nf.dataBR(a.trial_ends_at) + ' (fim do teste)';
    return a.periodo_fim ? nf.dataBR(a.periodo_fim) : '—';
  }

  function desenharEscritorio() {
    var x = escritorio();
    // Empresas, bloqueios e franquia da aba Emitir vêm de novo na próxima vez que ela abrir.
    em.carregado = false;
    // O mesmo para a aba NF-e (nfe.js).
    if (window.contaNfe) window.contaNfe.desatualizar();
    if (window.contaApi) window.contaApi.desatualizar();
    ABAS.forEach(function (a) {
      var p = $('fa-painel-' + a);
      if (x) { p.setAttribute('role', 'tabpanel'); p.setAttribute('aria-labelledby', 'fa-aba-' + a); }
      else { p.removeAttribute('role'); p.removeAttribute('aria-labelledby'); }
    });
    $('fa-abas').hidden = !x;
    // O módulo Guias pergunta à API se está ligado e só então mostra a aba.
    if (window.contaGuias) window.contaGuias.verificar(!!x);
    $('certificado').hidden = !!x;
    $('fa-secao-fiscal').hidden = !!x;
    $('fa-secao-apagar').hidden = !!x;
    $('fa-plano-uso').hidden = !x;
    $('fa-abrir-faixas').hidden = true;
    if (!x) {
      $('fa-painel-dados').hidden = false;
      $('fa-painel-empresas').hidden = true;
      $('fa-painel-emitir').hidden = true;
      $('fa-painel-relatorios').hidden = true;
      $('fa-painel-nfe').hidden = true;
      $('fa-painel-guias').hidden = true;
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
      var f = nf.FAIXAS[c], atual = c === x.plano, pequena = Number(x.empresas_ativas) > (Number(x.max_empresas_override) || f.empresas);
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

  /* ---------- Retenção de ISS e INSS (16/11/2026) ----------
     As mesmas caixas em Adicionar empresa, em Dados fiscais (o padrão da empresa, gravado por /v1/fiscal/emissao
     `empresa_retencao`) e na aba Emitir (só para a nota). Marcar abre o campo; MEI não tem retenção e não vê as caixas.
     O servidor confere de novo (retencao.ts): aqui é só para o erro aparecer no campo. */
  function numeroBR(t) {
    t = String(t == null ? '' : t).replace(/%\s*$/, '').replace(/\s/g, '').replace(',', '.');
    return /^\d{1,3}(\.\d{1,2})?$/.test(t) ? Number(t) : null;
  }
  function comVirgula(v) { return String(Number(v)).replace('.', ','); }
  function formRetencao(pre, opcoes) {
    opcoes = opcoes || {};
    var iss = $(pre + '-retem-iss'), inss = $(pre + '-retem-inss');
    function sync() {
      $(pre + '-campo-iss').hidden = !iss.checked;
      $(pre + '-campo-inss').hidden = !inss.checked;
      iss.setAttribute('aria-expanded', iss.checked ? 'true' : 'false');
      inss.setAttribute('aria-expanded', inss.checked ? 'true' : 'false');
    }
    function mudou(caixa, campo) {
      sync();
      if (caixa.checked) $(campo).focus(); else nf.erroCampo(campo, '');
      if (opcoes.aoMudar) opcoes.aoMudar();
    }
    iss.addEventListener('change', function () { mudou(iss, pre + '-aliquota-iss'); });
    inss.addEventListener('change', function () { mudou(inss, pre + '-inss'); });
    if (opcoes.aoMudar) {
      $(pre + '-aliquota-iss').addEventListener('input', opcoes.aoMudar);
      $(pre + '-inss').addEventListener('input', opcoes.aoMudar);
    }
    var inicial = null;
    var api = {
      /* `padrao` = { retem_iss, aliquota_iss, retem_inss, inss_percentual } (ou null); `mei` esconde tudo. */
      preencher: function (padrao, mei) {
        padrao = padrao || {};
        $(pre + '-retencao').hidden = !!mei;
        iss.checked = !mei && !!padrao.retem_iss;
        inss.checked = !mei && !!padrao.retem_inss;
        $(pre + '-aliquota-iss').value = padrao.aliquota_iss ? comVirgula(padrao.aliquota_iss) : '';
        $(pre + '-inss').value = padrao.inss_percentual ? comVirgula(padrao.inss_percentual) + (opcoes.inssLivre ? '%' : '') : '';
        sync();
        api.limpar();
        inicial = JSON.stringify(api.ler());
      },
      /* As caixas ou os campos mudaram desde o último `preencher`. */
      mudou: function () { return JSON.stringify(api.ler()) !== inicial; },
      limpar: function () { nf.erroCampo(pre + '-aliquota-iss', ''); nf.erroCampo(pre + '-inss', ''); },
      visivel: function () { return !$(pre + '-retencao').hidden; },
      marcada: function () { return api.visivel() && (iss.checked || inss.checked); },
      ler: function () {
        return { retem_iss: api.visivel() && iss.checked, aliquota_iss: $(pre + '-aliquota-iss').value, retem_inss: api.visivel() && inss.checked, inss: $(pre + '-inss').value };
      },
      /* Devolve o id do primeiro campo com erro, ou null. */
      validar: function () {
        api.limpar();
        if (!api.visivel()) return null;
        var falhou = null;
        if (iss.checked) {
          var a = numeroBR($(pre + '-aliquota-iss').value);
          if (a === null || a < 2 || a > 5) { nf.erroCampo(pre + '-aliquota-iss', 'Informe a alíquota do ISS retido, de 2% a 5% (por exemplo 2,5).'); falhou = pre + '-aliquota-iss'; }
        }
        if (inss.checked) {
          var t = nf.texto($(pre + '-inss').value);
          var ok = opcoes.inssLivre ? !!t : (function (n) { return n !== null && n > 0 && n < 100; })(numeroBR(t));
          if (!ok) {
            nf.erroCampo(pre + '-inss', opcoes.inssLivre ? 'Informe o INSS retido: o percentual (11%) ou o valor (165,00).' : 'Informe o percentual do INSS retido, por exemplo 11.');
            if (!falhou) falhou = pre + '-inss';
          }
        }
        return falhou;
      }
    };
    return api;
  }
  /* Corpo de `empresa_retencao` a partir das caixas de uma empresa. */
  function corpoRetencaoEmpresa(tenantId, r) {
    return {
      acao: 'empresa_retencao', tenant_id: tenantId,
      retem_iss: r.retem_iss, aliquota_iss: r.retem_iss ? r.aliquota_iss : null,
      retem_inss: r.retem_inss, inss_percentual: r.retem_inss ? r.inss : null
    };
  }
  var retAdd = formRetencao('fa-add');
  var retEmp = formRetencao('fa-emp');

  /* ---------- Minhas empresas ---------- */
  function botaoLinha(acao, emp, rotulo) {
    return '<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-acao="' + acao + '" data-tenant="' + nf.esc(emp.tenant_id) +
      '" aria-label="' + nf.esc(rotulo + ': ' + nomeEmpresa(emp)) + '">' + nf.esc(rotulo) + '</button>';
  }
  /* Situação da NF-e na linha da empresa (`nfe.bloqueio` de fiscal_escritorio_estado = nfe_emission_block). */
  var SITUACAO_NFE = {
    NFE_SEM_IE: 'falta IE', NFE_SEM_ENDERECO: 'falta endereço', NFE_SEM_SERIE: 'falta numeração',
    NFE_CERT_MISSING: 'falta A1 próprio para NF-e', CERT_EXPIRED: 'A1 vencido', CERT_DE_OUTRO_CNPJ: 'A1 de outro CNPJ',
    NFE_NAO_CONFERIDA: 'falta conferir na Sefaz', NFE_CONFERIR_DE_NOVO: 'conferir de novo na Sefaz',
    NFE_NAO_CREDENCIADA: 'falta credenciamento NF-e', NFE_IE_NAO_E_DO_CNPJ: 'IE não é do CNPJ', NFE_IE_NAO_HABILITADA: 'IE não habilitada',
    NFE_IE_INVALIDA: 'IE recusada pela Sefaz', SEFAZ_INDISPONIVEL: 'Sefaz não respondeu; confira de novo',
    NFE_REGIME_NAO_SUPORTADO: 'regime ainda não suportado'
  };
  var BLOQUEIOS_DA_CONTA = ['NO_SUBSCRIPTION', 'SUBSCRIPTION_CANCELLED', 'PAYMENT_NOT_APPROVED', 'TENANT_INACTIVE'];
  function situacaoNfe(emp) {
    if (!emp.nfe || emp.ativa === false) return '';
    var b = emp.nfe.bloqueio;
    // Bloqueio da conta inteira (assinatura) já aparece no aviso de cima.
    if (b && BLOQUEIOS_DA_CONTA.indexOf(b) >= 0) return '';
    var texto = b ? 'NF-e: ' + (SITUACAO_NFE[b] || 'não emite (' + b + ')') : 'NF-e: pronta';
    return '<small class="nf-dica nf-situacao-nfe' + (b ? '' : ' nf-situacao-nfe--ok') + '">' + nf.esc(texto) + '</small>';
  }
  function linhaEmpresa(emp) {
    var ativa = emp.ativa !== false, acoes = [];
    var porProcuracao = emp.modo_autenticacao === 'procuracao';
    if (ativa) {
      acoes.push(botaoLinha('cert', emp, emp.certificado && !porProcuracao ? 'Trocar A1' : 'Enviar A1'));
      // A empresa do escritório é a procuradora das outras: ela assina com o A1 dela.
      if (!emp.principal) acoes.push(botaoLinha('proc', emp, 'Procuração'));
      acoes.push(botaoLinha('fiscal', emp, 'Dados fiscais'));
      acoes.push('<button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-ir-aba="nfe" data-nfe-empresa="' + nf.esc(emp.tenant_id) + '">NF-e</button>');
    }
    if (!emp.principal) acoes.push(botaoLinha(ativa ? 'desativar' : 'reativar', emp, ativa ? 'Desativar' : 'Reativar'));
    return '<tr' + (ativa ? '' : ' class="nf-linha-off"') + '><th scope="row">' + nf.esc(nomeEmpresa(emp)) +
      (emp.principal ? ' <span class="nf-selo">Escritório</span>' : '') + '</th>' +
      '<td class="nf-nowrap">' + nf.esc(nf.formatarCnpj(emp.cnpj)) + '</td>' +
      '<td>' + pill(situacaoEmpresa(emp)) + (porProcuracao ? '<small class="nf-dica nf-por-procuracao">por procuração ao escritório</small>' : '') + situacaoNfe(emp) + '</td>' +
      '<td class="nf-num">' + nf.esc(String(emp.notas_mes || 0)) + '</td>' +
      '<td><div class="nf-acoes-linha">' + acoes.join('') + '</div></td></tr>';
  }
  function desenharEmpresas(x) {
    var f = nf.FAIXAS[x.plano];
    $('fa-empresas-resumo').textContent = x.empresas_ativas + ' de ' + x.max_empresas + ' empresas ativas' +
      (x.max_empresas_override ? ' no seu pacote' : f ? ' na faixa ' + f.nome : '') + '. Cada empresa emite com o próprio certificado A1 ou por procuração ao escritório, com os próprios dados fiscais.';
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
    ['fa-emp-pfx', 'fa-emp-pfx-senha', 'fa-emp-codigo-servico', 'fa-emp-percentual', 'fa-emp-nbs'].forEach(function (i) { nf.erroCampo(i, ''); });
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
    $('fa-emp-nbs').value = emp.nbs_padrao ? formatarNbs(emp.nbs_padrao) : '';
    // O padrão de retenção vem da API do painel (a mesma da aba Emitir); até chegar, as caixas ficam desmarcadas.
    retEmp.preencher(null, mei);
    if (mei) return;
    var id = emp.tenant_id;
    nf.app(EMISSAO, { acao: 'contexto' }).then(function (r) {
      if (!r.ok || !ec.acao || ec.acao.tenantId !== id) return;
      (r.dados.empresas || []).forEach(function (e) { if (e.tenant_id === id) retEmp.preencher(e.retencao, e.regime === 'mei'); });
    });
  }
  var CAMPO_EMP_FISCAL = { codigo_servico_nacional: 'fa-emp-codigo-servico', p_tot_trib_sn: 'fa-emp-percentual', nbs_padrao: 'fa-emp-nbs' };
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
    var nbs = lerNbs($('fa-emp-nbs').value);
    if (nbs === null) { nf.erroCampo('fa-emp-nbs', MSG_NBS); falhou = true; }
    var erroRet = retEmp.validar();
    if (falhou || erroRet) { if (erroRet && !falhou) $(erroRet).focus(); return; }
    var corpo = { acao: 'empresa_configurar', tenant_id: ac.tenantId, codigo_servico_nacional: codigo, nbs_padrao: nbs || null };
    if (!mei) corpo.p_tot_trib_sn = pct;
    var botao = $('fa-emp-salvar-fiscal');
    var nome = nomeEmpresa(ac.empresa);
    nf.ocupado(botao, true, 'Salvando…');
    // Primeiro a retenção (API do painel), depois o código e o percentual (fiscal-conta).
    var retencao = mei || !retEmp.mudou() ? Promise.resolve({ ok: true }) : nf.app(EMISSAO, corpoRetencaoEmpresa(ac.tenantId, retEmp.ler()));
    retencao.then(function (rr) {
      if (!rr.ok) {
        nf.ocupado(botao, false);
        if (rr.status === 401) return;
        var campoRet = rr.dados && { aliquota_iss: 'fa-emp-aliquota-iss', inss_percentual: 'fa-emp-inss' }[rr.dados.campo];
        if (campoRet) { nf.erroCampo(campoRet, rr.mensagem || 'Confira este campo.'); return; }
        nf.aviso($('fa-aviso-emp-fiscal'), nf.esc(rr.mensagem || GENERICO), 'erro');
        return null;
      }
      em.carregado = false; // a aba Emitir relê o padrão da empresa
      return nf.funcao('fiscal-conta', corpo);
    }).then(function (r) {
      if (!r) return;
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
    if (abrir) { retAdd.preencher(null, false); $('fa-add-cnpj').focus(); }
  }
  function adicionarEmpresa(ev) {
    ev.preventDefault();
    var cnpj = nf.digitos($('fa-add-cnpj').value);
    nf.erroCampo('fa-add-cnpj', '');
    nf.aviso($('fa-aviso-adicionar'), '');
    if (!nf.cnpjValido(cnpj)) { nf.erroCampo('fa-add-cnpj', 'CNPJ inválido. Confira os 14 números.'); return; }
    var erroRet = retAdd.validar();
    if (erroRet) { $(erroRet).focus(); return; }
    var retencao = retAdd.marcada() ? retAdd.ler() : null;
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
        var avisoRetencao = '';
        var depois = function () {
          var escolha = nova
            ? ' <span class="nf-acoes-linha"><button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-acao="cert" data-tenant="' + nf.esc(nova) +
              '">Enviar o A1 da empresa</button><button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-acao="proc" data-tenant="' + nf.esc(nova) +
              '">Usar procuração ao escritório</button></span>'
            : '';
          nf.aviso($('fa-aviso-empresas'), (reativada ? 'Empresa reativada.' : 'Empresa adicionada.') + avisoRetencao +
            ' Agora escolha como ela vai assinar as notas: com o certificado A1 dela ou com procuração ao escritório. Depois, os dados fiscais.' + escolha, 'ok');
        };
        // As caixas de retenção marcadas viram o padrão da empresa nova (API do painel).
        var salvarRetencao = retencao && nova
          ? nf.app(EMISSAO, corpoRetencaoEmpresa(nova, retencao)).then(function (rr) {
            em.carregado = false;
            avisoRetencao = rr.ok ? ' Retenção salva.' : ' A retenção não foi salva: ' + nf.esc(rr.mensagem || GENERICO) + ' Ajuste em Dados fiscais.';
          })
          : Promise.resolve();
        return salvarRetencao.then(function () {
          if (r.dados.tenant_id) { st.estado = r.dados; desenhar(); depois(); return; }
          return carregar().then(depois);
        });
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

  /* ---------- Emitir: nota avulsa e lote por planilha (/v1/fiscal/emissao) ----------
     O mesmo motor do WhatsApp: o servidor confere (emission_block, franquia, nota igual no mês) e só emite no segundo
     clique. Cada resumo conferido ganha uma chave nova, que torna o "Emitir nota" idempotente (clique duplo, rede
     caindo no meio). A planilha é a mesma do WhatsApp, com a mesma leitura e o mesmo "confirmar". */
  var EMISSAO = '/v1/fiscal/emissao';
  var em = { carregado: false, empresas: [], modelos: {}, pedidoModelos: 0, seletor: null, pedido: null, chave: null, lote: null };
  var moldeSeletorAvulsa = $('fa-av-seletor').cloneNode(true);
  var CAMPO_AVULSA = { tenant_id: 'fa-av-empresa', documento: 'fa-av-documento', nome: 'fa-av-nome', email: 'fa-av-email', valor: 'fa-av-valor', codigo: 'fa-av-codigo', descricao: 'fa-av-descricao', informacoes_complementares: 'fa-av-info', municipio_prestacao: 'fa-av-local', obra: 'fa-av-obra', aliquota_iss: 'fa-av-aliquota-iss', inss: 'fa-av-inss', retencao: 'fa-av-retem-iss' };
  var retAv = formRetencao('fa-av', { inssLivre: true, aoMudar: function () { if (!$('fa-av-resumo').hidden) fecharResumoAvulsa(); } });
  var BOTAO_RELATORIOS = ' <button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-ir-aba="relatorios">Ver em Relatórios</button>';

  function novaChave() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  /* Construção civil (E0370, obra.ts): nestes códigos a Sefin exige o endereço da obra ou o CNO. */
  var CODIGOS_COM_OBRA = ['070201', '070202', '070401', '070501', '070502', '070601', '070602', '070701', '070801', '071701', '071901', '141403', '141404'];
  var CAMPOS_DA_OBRA = ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cno'];
  function codigoDaAvulsa() {
    var c = em.seletor ? em.seletor.valor() : '';
    if (c) return String(c).replace(/\D/g, '');
    var emp = empresaDaEmissao($('fa-av-empresa').value);
    return emp && emp.codigo_servico_nacional ? String(emp.codigo_servico_nacional) : '';
  }
  function atualizarObraAvulsa(forcar) {
    var mostrar = forcar === true || CODIGOS_COM_OBRA.indexOf(codigoDaAvulsa()) >= 0;
    $('fa-av-obra').hidden = !mostrar;
  }
  function comQuebras(t) { return nf.esc(t || '').replace(/\n/g, '<br>'); }
  function centavosDoTexto(v) { return Math.round(Number(v || 0) * 100); }
  function empresaDaEmissao(id) {
    for (var i = 0; i < em.empresas.length; i++) if (em.empresas[i].tenant_id === id) return em.empresas[i];
    return null;
  }

  function carregarEmissao() {
    em.carregado = true;
    return nf.app(EMISSAO, { acao: 'contexto' }).then(function (r) {
      if (r.ok) { em.empresas = r.dados.empresas || []; desenharEmpresasDaEmissao(); return; }
      em.carregado = false;
      if (r.status === 401) return;
      nf.aviso($('fa-aviso-emitir'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }
  function desenharEmpresasDaEmissao() {
    var sel = $('fa-av-empresa'), antes = sel.value;
    sel.innerHTML = em.empresas.map(function (e) {
      return '<option value="' + nf.esc(e.tenant_id) + '">' + nf.esc(e.razao_social + (e.principal ? ' (escritório)' : '') + ' · ' + nf.formatarCnpj(e.cnpj)) + '</option>';
    }).join('');
    if (antes && empresaDaEmissao(antes)) sel.value = antes;
    // A mesma empresa continua escolhida: o que já foi digitado fica; só o aviso de bloqueio é refeito.
    if (sel.value && sel.value === antes) desenharBloqueioDaEmissao(); else trocarEmpresaDaEmissao();
  }
  function desenharBloqueioDaEmissao() {
    var emp = empresaDaEmissao($('fa-av-empresa').value);
    nf.aviso($('fa-av-bloqueio'), emp && emp.bloqueio
      ? nf.esc('Esta empresa não emite agora: ' + emp.bloqueio.motivo + '.') + ' <button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-ir-aba="empresas">Resolver em Minhas empresas</button>'
      : '', 'erro');
  }
  function trocarEmpresaDaEmissao() {
    var emp = empresaDaEmissao($('fa-av-empresa').value);
    fecharResumoAvulsa();
    desenharBloqueioDaEmissao();
    retAv.preencher(emp && emp.retencao, !emp || emp.regime === 'mei');
    prepararSeletorAvulsa(emp ? emp.codigo_servico_nacional : '', emp && emp.tenant_id);
    carregarModelos(emp);
  }
  /* Um seletor de código novo a cada empresa ou modelo, com as sugestões pelo CNAE da empresa. */
  function prepararSeletorAvulsa(codigo, tenantId) {
    var velho = $('fa-av-seletor'), novo = moldeSeletorAvulsa.cloneNode(true);
    velho.parentNode.replaceChild(novo, velho);
    var emp = empresaPorId(tenantId) || {};
    var cnae = emp.cnae || (emp.principal ? (st.estado.empresa || {}).cnae : null);
    em.seletor = nf.seletorCodigo(novo, { cnae: cnae, atual: codigo || '' });
    atualizarObraAvulsa();
  }
  function carregarModelos(emp) {
    var sel = $('fa-av-modelo');
    sel.innerHTML = '<option value="">Cliente novo</option>';
    if (!emp) return;
    var pedido = ++em.pedidoModelos;
    var lista = em.modelos[emp.tenant_id]
      ? Promise.resolve(em.modelos[emp.tenant_id])
      : nf.app(EMISSAO, { acao: 'modelos', tenant_id: emp.tenant_id }).then(function (r) {
        if (!r.ok) return [];
        em.modelos[emp.tenant_id] = r.dados.modelos || [];
        return em.modelos[emp.tenant_id];
      });
    lista.then(function (modelos) {
      if (pedido !== em.pedidoModelos) return; // trocou de empresa no meio
      sel.innerHTML = '<option value="">Cliente novo</option>' + modelos.map(function (m, i) {
        return '<option value="' + i + '">' + nf.esc(m.nome + ' · ' + nf.formatarDocumento(m.documento)) + '</option>';
      }).join('');
    });
  }
  function escolherModelo() {
    var emp = empresaDaEmissao($('fa-av-empresa').value);
    var m = emp && $('fa-av-modelo').value !== '' ? (em.modelos[emp.tenant_id] || [])[Number($('fa-av-modelo').value)] : null;
    fecharResumoAvulsa();
    $('fa-av-documento').value = m ? nf.formatarDocumento(m.documento) : '';
    $('fa-av-nome').value = m ? m.nome_tomador : '';
    $('fa-av-email').value = m ? (m.email || '') : '';
    $('fa-av-valor').value = m && m.valor_padrao ? valorTexto(m.valor_padrao) : '';
    $('fa-av-descricao').value = m ? (m.descricao || '') : '';
    $('fa-av-info').value = '';
    $('fa-av-local').value = '';
    CAMPOS_DA_OBRA.forEach(function (k) { $('fa-av-obra-' + k).value = ''; });
    contarInfoAvulsa();
    prepararSeletorAvulsa(m ? m.codigo : (emp ? emp.codigo_servico_nacional : ''), emp && emp.tenant_id);
  }

  /* Local da prestação (cLocPrestacao): a lista do IBGE ("Campinas/SP") só é baixada quando o campo ganha foco. */
  var municipiosCarregados = false;
  function carregarMunicipios() {
    if (municipiosCarregados) return;
    municipiosCarregados = true;
    fetch('/agentes/fiscal/dados/municipios.json', { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !Array.isArray(d.municipios)) { municipiosCarregados = false; return; }
        var lista = $('fa-av-local-lista'), frag = document.createDocumentFragment();
        d.municipios.forEach(function (m) { var o = document.createElement('option'); o.value = m; frag.appendChild(o); });
        lista.appendChild(frag);
      })
      .catch(function () { municipiosCarregados = false; });
  }

  /* Informações complementares: até 2.000 caracteres (xInfComp do leiaute nacional). */
  function contarInfoAvulsa() {
    var n = $('fa-av-info').value.length;
    $('fa-av-info-contador').textContent = n.toLocaleString('pt-BR') + '/2.000';
  }
  function lerAvulsa() {
    var corpo = {
      tenant_id: $('fa-av-empresa').value, documento: $('fa-av-documento').value, nome: $('fa-av-nome').value,
      email: $('fa-av-email').value, valor: $('fa-av-valor').value, codigo: em.seletor ? em.seletor.valor() : '',
      descricao: $('fa-av-descricao').value, informacoes_complementares: $('fa-av-info').value,
      municipio_prestacao: $('fa-av-local').value
    };
    if (!$('fa-av-obra').hidden) CAMPOS_DA_OBRA.forEach(function (k) { corpo['obra_' + k] = $('fa-av-obra-' + k).value; });
    // As caixas valem para esta nota (vêm marcadas com o padrão da empresa). MEI: sem caixas, sem retenção.
    if (retAv.visivel()) {
      var r = retAv.ler();
      corpo.retem_iss = r.retem_iss; corpo.retem_inss = r.retem_inss;
      if (r.retem_iss) corpo.aliquota_iss = r.aliquota_iss;
      if (r.retem_inss) corpo.inss = r.inss;
    }
    return corpo;
  }
  function limparErrosAvulsa() {
    Object.keys(CAMPO_AVULSA).forEach(function (k) { nf.erroCampo(CAMPO_AVULSA[k], ''); });
    nf.aviso($('fa-aviso-emitir'), '');
  }
  function conferirAvulsa(ev) {
    ev.preventDefault();
    limparErrosAvulsa();
    atualizarObraAvulsa();
    var corpo = lerAvulsa(), falhou = null;
    function erro(campo, msg) { nf.erroCampo(CAMPO_AVULSA[campo], msg); if (!falhou) falhou = campo; }
    if (!corpo.tenant_id) erro('tenant_id', 'Escolha a empresa que emite a nota.');
    if (!nf.documentoValido(corpo.documento)) erro('documento', 'CPF ou CNPJ inválido. Confira os números.');
    if (!nf.texto(corpo.nome)) erro('nome', 'Informe o nome do cliente.');
    if (nf.texto(corpo.email) && !nf.emailValido(nf.texto(corpo.email))) erro('email', 'E-mail inválido. Confira ou deixe em branco.');
    if (!nf.texto(corpo.valor)) erro('valor', 'Informe o valor.');
    var erroRet = retAv.validar();
    if (falhou || erroRet) { var f = $(falhou ? CAMPO_AVULSA[falhou] : erroRet); if (f) f.focus(); return; }
    corpo.acao = 'avulsa_conferir';
    var botao = $('fa-av-conferir');
    nf.ocupado(botao, true, 'Conferindo…');
    nf.app(EMISSAO, corpo).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) { em.pedido = corpo; em.chave = novaChave(); desenharResumoAvulsa(r.dados); return; }
      if (r.status === 401) return;
      if (r.dados && r.dados.campo === 'obra') { atualizarObraAvulsa(true); erro('obra', r.mensagem || 'Confira os dados da obra.'); $('fa-av-obra-cep').focus(); return; }
      if (r.dados && CAMPO_AVULSA[r.dados.campo]) { erro(r.dados.campo, r.mensagem || 'Confira este campo.'); var c = $(CAMPO_AVULSA[r.dados.campo]); if (c) c.focus(); return; }
      nf.aviso($('fa-aviso-emitir'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }
  function desenharResumoAvulsa(d) {
    var s = d.resumo || {}, t = s.tomador || {}, sv = s.servico || {}, emp = s.empresa || {};
    $('fa-av-resumo-dados').innerHTML = linhas([
      ['Empresa', (emp.razao_social || '') + ' · ' + nf.formatarCnpj(emp.cnpj || '')],
      ['Cliente', t.nome],
      [t.tipo === 'cnpj' ? 'CNPJ' : 'CPF', nf.formatarDocumento(t.documento || '')],
      ['E-mail', t.email || 'Sem e-mail'],
      ['Serviço', nf.formatarCodigo(sv.codigo || '') + (sv.nome ? ' ' + sv.nome : '')],
      ['Descrição na nota', sv.descricao]
    ].concat(s.local_prestacao ? [['Local da prestação', s.local_prestacao.nome + (s.local_prestacao.iss_no_local ? ' (o ISS deste serviço é devido nessa cidade)' : '')]] : [])
      .concat(s.obra ? [['Obra', s.obra]] : [])
      .concat([['Valor', s.valor_texto]])
      .concat(linhasRetencaoDoResumo(s)).concat(s.informacoes_complementares ? [['Informações complementares', s.informacoes_complementares]] : []));
    var avisos = (d.bloqueio ? ['<p class="nf-aviso nf-aviso--erro" role="status">' + nf.esc('Não dá para emitir: ' + d.bloqueio.motivo + '.') + '</p>'] : [])
      .concat((d.avisos || []).map(function (a) { return '<p class="nf-aviso nf-aviso--info">' + nf.esc(a) + '</p>'; }));
    $('fa-av-avisos').innerHTML = avisos.join('');
    $('fa-av-emitir').disabled = !!d.bloqueio;
    $('fa-form-avulsa').hidden = true;
    $('fa-av-resumo').hidden = false;
    $('fa-av-resumo-titulo').focus();
  }
  /* Retenção no resumo: ISS (alíquota e valor), INSS, valor líquido e o endereço do cliente que vai na nota. */
  function linhasRetencaoDoResumo(s) {
    var r = s.retencao;
    if (!r) return [];
    var out = [];
    if (r.iss) out.push(['ISS retido pelo tomador', comVirgula(r.iss.aliquota) + '% (R$ ' + valorTexto(r.iss.valor) + ')']);
    if (r.inss) out.push(['INSS retido', 'R$ ' + valorTexto(r.inss.valor)]);
    out.push(['Valor líquido', 'R$ ' + valorTexto(r.liquido)]);
    var e = s.endereco_tomador;
    if (e) out.push(['Endereço do cliente (Receita)', e.logradouro + ', ' + e.numero + (e.complemento ? ' ' + e.complemento : '') + ' · ' + e.bairro + ' · CEP ' + e.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2')]);
    return out;
  }
  function fecharResumoAvulsa() {
    $('fa-av-resumo').hidden = true;
    $('fa-form-avulsa').hidden = false;
    em.pedido = null; em.chave = null;
  }
  function emitirAvulsa() {
    if (!em.pedido || !em.chave) return;
    var pedido = em.pedido, corpo = {};
    Object.keys(pedido).forEach(function (k) { corpo[k] = pedido[k]; });
    corpo.acao = 'avulsa_emitir';
    corpo.chave = em.chave;
    var botao = $('fa-av-emitir');
    nf.ocupado(botao, true, 'Emitindo…');
    nf.app(EMISSAO, corpo).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) {
        fecharResumoAvulsa();
        $('fa-av-modelo').value = '';
        escolherModelo();
        var empAtual = empresaDaEmissao($('fa-av-empresa').value);
        retAv.preencher(empAtual && empAtual.retencao, !empAtual || empAtual.regime === 'mei');
        ec.relCarregado = false; // Relatórios busca de novo na próxima visita
        nf.aviso($('fa-aviso-emitir'), nf.esc('Nota de ' + nf.texto(pedido.nome) + ' na fila da Sefin. Em instantes ela é autorizada, e o cliente com e-mail recebe a nota.') + BOTAO_RELATORIOS, 'ok');
        var aviso = $('fa-aviso-emitir');
        if (typeof aviso.scrollIntoView === 'function') aviso.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (r.status === 401) return;
      if (r.codigo === 'EMISSAO_BLOQUEADA') {
        $('fa-av-emitir').disabled = true;
        $('fa-av-avisos').innerHTML = '<p class="nf-aviso nf-aviso--erro" role="status">' + nf.esc(r.mensagem) + '</p>';
        return;
      }
      $('fa-av-avisos').innerHTML = '<p class="nf-aviso nf-aviso--erro" role="status">' + nf.esc(r.mensagem || GENERICO) + '</p>';
    });
  }

  /* Lote por planilha: ler → resumo com os problemas por linha → confirmar ou descartar. */
  function lerLote(ev) {
    ev.preventDefault();
    nf.erroCampo('fa-lote-arquivo', '');
    nf.aviso($('fa-aviso-lote'), '');
    var arquivo = $('fa-lote-arquivo').files && $('fa-lote-arquivo').files[0];
    if (!arquivo) { nf.erroCampo('fa-lote-arquivo', 'Escolha a planilha (.xlsx ou .csv).'); return; }
    if (!/\.(xlsx|csv)$/i.test(arquivo.name || '')) { nf.erroCampo('fa-lote-arquivo', 'Envie a planilha em .xlsx ou .csv.'); return; }
    if (arquivo.size > 4 * 1024 * 1024) { nf.erroCampo('fa-lote-arquivo', 'A planilha passou de 4 MB. Divida em duas e envie uma de cada vez.'); return; }
    var form = new FormData();
    form.append('arquivo', arquivo, arquivo.name);
    var botao = $('fa-lote-ler');
    nf.ocupado(botao, true, 'Lendo a planilha…');
    $('fa-lote-resumo').hidden = true;
    em.lote = null;
    nf.app(EMISSAO, form).then(function (r) {
      nf.ocupado(botao, false);
      if (r.ok) { em.lote = r.dados; desenharLote(r.dados); return; }
      if (r.status === 401) return;
      var extra = r.dados && r.dados.motivo === 'repetida' && r.dados.lote_id
        ? ' <button type="button" class="fi-btn fi-btn--borda nf-btn-mini" data-descartar-lote="' + nf.esc(r.dados.lote_id) + '">Descartar a anterior</button>'
        : '';
      nf.aviso($('fa-aviso-lote'), comQuebras(r.mensagem || GENERICO) + extra, 'erro');
    });
  }
  function plural(n, um, varios) { return n.toLocaleString('pt-BR') + ' ' + (n === 1 ? um : varios); }
  function desenharLote(d) {
    $('fa-lote-resumo-titulo').textContent = 'Planilha' + (d.arquivo ? ' ' + d.arquivo : '') + ': ' + plural(d.linhas, 'linha', 'linhas');
    $('fa-lote-linhas').textContent = String(d.linhas);
    $('fa-lote-prontas').textContent = String(d.prontas);
    $('fa-lote-total').textContent = nf.reais(centavosDoTexto(d.total));
    $('fa-lote-problemas-n').textContent = String((d.problemas || []).length);
    $('fa-lote-empresas').innerHTML = (d.por_empresa || []).map(function (p) {
      return '<li>' + nf.esc(p.razao_social + ': ' + plural(p.notas, 'nota', 'notas') + ', ' + nf.reais(centavosDoTexto(p.total))) + '</li>';
    }).join('');
    var f = d.franquia || {};
    nf.aviso($('fa-lote-franquia'), f.acima > 0
      ? nf.esc('Franquia: com estas notas, o mês chega a ' + plural(f.no_mes + d.prontas, 'nota', 'notas') + ', ' + f.acima.toLocaleString('pt-BR') + ' acima das ' + f.limite.toLocaleString('pt-BR') + ' do seu plano. As notas saem normalmente.')
      : '', 'info');
    var problemas = d.problemas || [];
    $('fa-lote-rolagem').hidden = problemas.length === 0;
    $('fa-lote-problemas').innerHTML = problemas.map(function (p) {
      return '<tr><td class="nf-num">' + nf.esc(String(p.linha)) + '</td><td>' + nf.esc(p.motivo) + '</td></tr>';
    }).join('');
    var aguardando = d.status === 'aguardando_confirmacao';
    $('fa-lote-acoes').hidden = !aguardando;
    $('fa-lote-confirmar').textContent = aguardando ? (d.prontas === 1 ? 'Emitir a nota pronta' : 'Emitir as ' + d.prontas.toLocaleString('pt-BR') + ' notas prontas') : '';
    $('fa-lote-validade').textContent = aguardando
      ? 'As linhas com problema ficam de fora. Esta leitura vale até ' + nf.dataBR(d.expira_em) + ' às ' + nf.horaBR(d.expira_em) + '.'
      : 'Nenhuma linha está pronta para emitir. Corrija a planilha e envie de novo.';
    $('fa-lote-resumo').hidden = false;
    $('fa-lote-resumo-titulo').focus();
  }
  function confirmarLote() {
    var lote = em.lote;
    if (!lote) return;
    var botao = $('fa-lote-confirmar');
    nf.ocupado(botao, true, 'Confirmando…');
    nf.app(EMISSAO, { acao: 'lote_confirmar', lote_id: lote.lote_id }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.status === 401) return;
      $('fa-lote-resumo').hidden = true;
      em.lote = null;
      if (!r.ok) { nf.aviso($('fa-aviso-lote'), nf.esc(r.mensagem || GENERICO), 'erro'); return; }
      $('fa-lote-arquivo').value = '';
      ec.relCarregado = false;
      var d = r.dados, barradas = d.barradas || [];
      var partes = [];
      if (d.emitindo) partes.push('Confirmado: ' + plural(d.emitindo, 'nota', 'notas') + ' na fila da Sefin.');
      if (barradas.length) partes.push(plural(barradas.length, 'linha ficou', 'linhas ficaram') + ' de fora desde a leitura: ' + barradas.map(function (b) { return 'linha ' + b.linha + ' (' + b.motivo + ')'; }).join('; ') + '.');
      partes.push(d.emitindo
        ? 'Cada cliente com e-mail recebe a nota. Quando todas fecharem, o retorno de cada linha vai para o e-mail da conta.'
        : 'Nenhuma nota foi emitida. Corrija e envie a planilha de novo.');
      nf.aviso($('fa-aviso-lote'), nf.esc(partes.join(' ')) + (d.emitindo ? BOTAO_RELATORIOS : ''), d.emitindo ? 'ok' : 'erro');
    });
  }
  function descartarLote(id, botao, depois) {
    nf.ocupado(botao, true, 'Descartando…');
    nf.app(EMISSAO, { acao: 'lote_descartar', lote_id: id }).then(function (r) {
      nf.ocupado(botao, false);
      if (r.status === 401) return;
      if (r.ok) { depois(); return; }
      nf.aviso($('fa-aviso-lote'), nf.esc(r.mensagem || GENERICO), 'erro');
    });
  }

  $('fa-av-empresa').addEventListener('change', trocarEmpresaDaEmissao);
  $('fa-av-modelo').addEventListener('change', escolherModelo);
  $('fa-form-avulsa').addEventListener('submit', conferirAvulsa);
  $('fa-av-info').addEventListener('input', contarInfoAvulsa);
  $('fa-av-local').addEventListener('focus', carregarMunicipios);
  // O seletor de código é recriado a cada empresa ou modelo: a escuta fica no formulário.
  ['click', 'change', 'input'].forEach(function (tipo) {
    $('fa-form-avulsa').addEventListener(tipo, function (ev) { if (!ev.target.closest || !ev.target.closest('#fa-av-obra')) atualizarObraAvulsa(); });
  });
  $('fa-av-local').addEventListener('input', function () { if (!$('fa-av-resumo').hidden) fecharResumoAvulsa(); });
  $('fa-av-emitir').addEventListener('click', emitirAvulsa);
  $('fa-av-corrigir').addEventListener('click', function () { fecharResumoAvulsa(); $('fa-av-documento').focus(); });
  $('fa-form-lote').addEventListener('submit', lerLote);
  $('fa-lote-confirmar').addEventListener('click', confirmarLote);
  $('fa-lote-descartar').addEventListener('click', function () {
    if (!em.lote) return;
    descartarLote(em.lote.lote_id, $('fa-lote-descartar'), function () {
      $('fa-lote-resumo').hidden = true;
      em.lote = null;
      nf.aviso($('fa-aviso-lote'), 'Planilha descartada. Nenhuma nota foi emitida.', 'ok');
    });
  });
  $('fa-aviso-lote').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('button[data-descartar-lote]');
    if (!b) return;
    descartarLote(b.getAttribute('data-descartar-lote'), b, function () {
      nf.aviso($('fa-aviso-lote'), 'A planilha anterior foi descartada. Toque em “Ler a planilha” de novo.', 'ok');
    });
  });

  $('fa-abas').addEventListener('click', function (ev) {
    var b = ev.target.closest && ev.target.closest('[role=tab]');
    if (b) mostrarAba(b.getAttribute('data-aba'));
  });
  $('fa-abas').addEventListener('keydown', function (ev) {
    var vis = ABAS.filter(abaDisponivel), i = vis.indexOf(ec.aba), n = null;
    if (ev.key === 'ArrowRight') n = vis[(i + 1) % vis.length];
    else if (ev.key === 'ArrowLeft') n = vis[(i + vis.length - 1) % vis.length];
    else if (ev.key === 'Home') n = vis[0];
    else if (ev.key === 'End') n = vis[vis.length - 1];
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
    var aba = ev.target.closest && ev.target.closest('[data-ir-aba]');
    if (aba && escritorio()) mostrarAba(aba.getAttribute('data-ir-aba'), { foco: true });
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
