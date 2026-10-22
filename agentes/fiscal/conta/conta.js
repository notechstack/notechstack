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
    $('fa-plano-notas').textContent = 'Até ' + plano.notas + ' · ' + nf.reais(plano.centavos) + '/mês';
    var s = statusAssinatura(a);
    var pill = $('fa-status');
    pill.textContent = s[0];
    pill.className = 'nf-status' + (s[1] ? ' nf-status--' + s[1] : '');
    var ativa = a && a.status !== 'cancelada';
    $('fa-trocar-plano').textContent = pro ? 'Mudar para o Inicial' : 'Mudar para o Pro';
    $('fa-trocar-plano').hidden = !ativa;
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
