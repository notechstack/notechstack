/* /agentes/fiscal/comecar/: cadastro, código no e-mail, pagamento e onboarding em 7 etapas (critérios 1–25 da
   tarefa agente-fiscal-v2). Fala só com as edge functions e as rotas do app pela forma da Surface; a sessão e as
   chamadas ficam em /agentes/fiscal/nofiscal.js. Quem volta com sessão abre na etapa de `onboarding_etapa`. */
(function () {
  'use strict';
  var nf = window.noFiscal;
  if (!nf || !document.getElementById('fc-etapa-1')) return;
  var $ = nf.$;

  var ETAPA_DO_SERVIDOR = {
    pagamento: 3, certificado: 4, dados_fiscais: 5, clientes: 6, ativacao: 7,
    boas_vindas_conferir: 7, boas_vindas_cliente: 7, boas_vindas_ensaio: 7, concluido: 7
  };
  var MSG = {
    cpf: 'CPF inválido',
    cnpj: 'CNPJ inválido',
    municipio: 'Seu município ainda não emite pelo padrão nacional',
    codigoIncorreto: 'Código incorreto',
    codigoNovo: 'Peça um código novo',
    cnpjComConta: 'Este CNPJ já tem conta. <a href="/agentes/fiscal/conta/">Entre pela sua conta</a>',
    telefoneOutra: 'Este WhatsApp já está ligado a outra empresa',
    vendaFechada: 'Vendas abrem em breve',
    recusado: 'Cartão recusado. Tente outro cartão',
    reteste: 'Este CNPJ, e-mail ou telefone já usou o teste grátis',
    generico: 'Não deu para concluir agora. Tente de novo em alguns minutos.'
  };
  var CERT = {
    CERT_SENHA_INVALIDA: 'Senha incorreta',
    CERT_VENCIDO: 'Certificado vencido',
    CERT_CNPJ_DIFERENTE: 'Este certificado é de outro CNPJ',
    VALIDATION_FAILED: 'Este arquivo não é um certificado A1 (.pfx ou .p12) que dê para usar.',
    RATE_LIMITED: 'Muitas tentativas. Tente de novo daqui a uma hora.',
    FORBIDDEN: 'Esta conta não é a dona desta empresa.'
  };
  var CODIGO_VALE_MS = 60 * 60 * 1000;
  var MAX_TENTATIVAS = 5;

  var st = {
    plano: nf.planoDaUrl(location.search),
    etapa: 0,
    tenantId: null,
    estado: null,
    consulta: null,          // última resposta de consultar_cnpj
    consultando: null,       // promessa da consulta em andamento
    cnpjConsultado: '',
    checkout: null,
    tentativas: 0,
    codigoPedidoEm: 0,
    seletor: null,
    clientesCarregados: false,
    ativacaoPedida: false
  };

  /* ---------- etapas ---------- */
  function irPara(n) {
    st.etapa = n;
    $('fc-carregando').hidden = true;
    for (var i = 1; i <= 7; i++) $('fc-etapa-' + i).hidden = i !== n;
    var itens = $('fc-trilha').querySelectorAll('li');
    for (var j = 0; j < itens.length; j++) {
      var e = Number(itens[j].getAttribute('data-etapa'));
      itens[j].className = e < n ? 'is-feita' : e === n ? 'is-atual' : '';
      if (e === n) itens[j].setAttribute('aria-current', 'step'); else itens[j].removeAttribute('aria-current');
    }
    var titulo = $('fc-titulo-' + n);
    if (titulo && typeof titulo.focus === 'function') { titulo.setAttribute('tabindex', '-1'); try { titulo.focus({ preventScroll: true }); } catch (x) { /* foco opcional */ } }
    if (typeof window.scrollTo === 'function') { try { window.scrollTo(0, 0); } catch (x) { /* jsdom */ } }
    var entrar = { 3: abrirPagamento, 4: abrirCertificado, 5: abrirFiscal, 6: abrirClientes, 7: abrirAtivacao }[n];
    if (entrar) entrar();
  }
  function mostrarPlano() {
    var centavos = st.checkout && st.checkout.planos && st.checkout.planos[st.plano] ? st.checkout.planos[st.plano].valor_centavos : null;
    var rotulo = nf.rotuloPlano(st.plano, centavos);
    $('fc-plano').textContent = rotulo;
    $('fc-plano-pagamento').textContent = rotulo;
  }
  function etapaDoEstado(e) {
    var n = ETAPA_DO_SERVIDOR[e.onboarding_etapa] || 3;
    // O servidor pode ainda não ter avançado a etapa depois do A1 ou dos dados fiscais.
    if (n === 4 && e.certificado) n = 5;
    if (n === 5 && e.fiscal && e.fiscal.codigo_servico_nacional) n = 6;
    return n;
  }
  function aplicarEstado(e) {
    st.estado = e;
    st.tenantId = e.tenant_id || st.tenantId;
    if (e.plano === 'pro' || e.plano === 'inicial') st.plano = e.plano;
    mostrarPlano();
  }

  function carregarEstado() {
    return nf.funcao('fiscal-conta', { acao: 'estado' }).then(function (r) {
      if (r.ok) { aplicarEstado(r.dados); return r; }
      return r;
    });
  }

  /* ---------- 1 · Sua empresa ---------- */
  function lerEtapa1() {
    return {
      cnpj: nf.digitos($('fc-cnpj').value),
      empresa: nf.texto($('fc-empresa').value),
      responsavel: nf.texto($('fc-responsavel').value),
      cpf: nf.digitos($('fc-cpf').value),
      email: nf.texto($('fc-email').value).toLowerCase(),
      telefone: $('fc-telefone').value
    };
  }
  function preencherEtapa1(d) {
    if (!d) return;
    if (d.cnpj) $('fc-cnpj').value = nf.formatarCnpj(d.cnpj);
    if (d.empresa) $('fc-empresa').value = d.empresa;
    if (d.responsavel) $('fc-responsavel').value = d.responsavel;
    if (d.cpf) $('fc-cpf').value = d.cpf;
    if (d.email) $('fc-email').value = d.email;
    if (d.telefone) $('fc-telefone').value = d.telefone;
  }
  function limparErros1() {
    ['fc-cnpj', 'fc-empresa', 'fc-responsavel', 'fc-cpf', 'fc-email', 'fc-telefone'].forEach(function (id) { nf.erroCampo(id, ''); });
    nf.aviso($('fc-aviso-1'), '');
  }
  function validarEtapa1(d) {
    var erros = {};
    if (!nf.cnpjValido(d.cnpj)) erros['fc-cnpj'] = MSG.cnpj;
    if (d.empresa.length < 2) erros['fc-empresa'] = 'Informe o nome da empresa.';
    if (d.responsavel.length < 3) erros['fc-responsavel'] = 'Informe o nome do responsável.';
    if (!nf.cpfValido(d.cpf)) erros['fc-cpf'] = MSG.cpf;
    if (!nf.emailValido(d.email)) erros['fc-email'] = 'Informe um e-mail válido.';
    if (!nf.telefoneE164(d.telefone)) erros['fc-telefone'] = 'Informe o WhatsApp com DDD.';
    return erros;
  }
  function municipioBloqueado() { return !!(st.consulta && st.consulta.cnpj === st.cnpjConsultado && st.consulta.padrao_nacional === false); }

  function consultarCnpj() {
    var cnpj = nf.digitos($('fc-cnpj').value);
    if (cnpj.length !== 14) { st.cnpjConsultado = ''; return Promise.resolve(); }
    if (!nf.cnpjValido(cnpj)) { nf.erroCampo('fc-cnpj', MSG.cnpj); return Promise.resolve(); }
    if (cnpj === st.cnpjConsultado && st.consultando) return st.consultando;
    st.cnpjConsultado = cnpj;
    st.consulta = null;
    nf.erroCampo('fc-cnpj', '');
    nf.aviso($('fc-aviso-1'), '');
    $('fc-cnpj-dica').textContent = 'Consultando o CNPJ…';
    st.consultando = nf.funcao('fiscal-cadastro', { acao: 'consultar_cnpj', cnpj: cnpj }, { auth: false }).then(function (r) {
      if (cnpj !== st.cnpjConsultado) return;
      if (r.ok) {
        st.consulta = { cnpj: cnpj, razao_social: r.dados.razao_social, municipio: r.dados.municipio, uf: r.dados.uf, cnae: r.dados.cnae, padrao_nacional: r.dados.padrao_nacional };
        if (r.dados.razao_social) $('fc-empresa').value = r.dados.razao_social;
        $('fc-cnpj-dica').textContent = [r.dados.municipio && (r.dados.municipio + (r.dados.uf ? '/' + r.dados.uf : '')), r.dados.cnae && ('CNAE ' + r.dados.cnae)].filter(Boolean).join(' · ');
        if (r.dados.padrao_nacional === false) nf.aviso($('fc-aviso-1'), MSG.municipio, 'erro');
      } else if (r.codigo === 'CNPJ_INVALIDO') {
        $('fc-cnpj-dica').textContent = '';
        nf.erroCampo('fc-cnpj', MSG.cnpj);
      } else if (r.codigo === 'CNPJ_NAO_ENCONTRADO') {
        $('fc-cnpj-dica').textContent = '';
        nf.erroCampo('fc-cnpj', 'Não encontramos este CNPJ nos dados públicos. Confira os números.');
      } else {
        // Consulta fora do ar (503) ou sem rede: segue com a razão social digitada.
        $('fc-cnpj-dica').textContent = 'Não deu para consultar o CNPJ agora. Confira o nome da empresa e siga.';
      }
    }).then(function () { if (cnpj === st.cnpjConsultado) st.consultando = null; });
    return st.consultando;
  }

  function enviarEtapa1(ev) {
    ev.preventDefault();
    limparErros1();
    var d = lerEtapa1();
    var erros = validarEtapa1(d);
    Object.keys(erros).forEach(function (id) { nf.erroCampo(id, erros[id]); });
    if (Object.keys(erros).length) return;
    var botao = $('fc-continuar-1');
    nf.ocupado(botao, true);
    var consulta = d.cnpj !== st.cnpjConsultado || st.consultando ? consultarCnpj() : Promise.resolve();
    consulta.then(function () {
      if (municipioBloqueado()) { nf.aviso($('fc-aviso-1'), MSG.municipio, 'erro'); return; }
      if ($('fc-cnpj-erro') && !$('fc-cnpj-erro').hidden) return;
      d.empresa = nf.texto($('fc-empresa').value);
      nf.cadastro.gravar(d);
      return nf.sessao.token().then(function (token) {
        if (token) return criar();
        return pedirCodigo(d.email, $('fc-aviso-1'));
      });
    }).then(function () { nf.ocupado(botao, false); });
  }

  function pedirCodigo(email, avisoEl) {
    return nf.pedirCodigo(email).then(function (r) {
      if (r.ok) {
        st.tentativas = 0;
        st.codigoPedidoEm = Date.now();
        $('fc-email-mascarado').textContent = nf.mascararEmail(email);
        $('fc-codigo').value = '';
        nf.erroCampo('fc-codigo', '');
        nf.aviso($('fc-aviso-2'), '');
        if (st.etapa !== 2) irPara(2);
        return true;
      }
      if (r.status === 429) nf.aviso(avisoEl, 'Você pediu códigos demais nesta hora. Tente de novo daqui a pouco.', 'erro');
      else if (r.status === 400) nf.erroCampo('fc-email', 'Informe um e-mail válido.');
      else nf.aviso(avisoEl, r.mensagem || MSG.generico, 'erro');
      return false;
    });
  }

  /* ---------- 2 · Código ---------- */
  function codigoVencido() { return st.tentativas >= MAX_TENTATIVAS || (st.codigoPedidoEm && Date.now() - st.codigoPedidoEm > CODIGO_VALE_MS); }
  function enviarCodigo(ev) {
    ev.preventDefault();
    var d = nf.cadastro.ler();
    var codigo = nf.digitos($('fc-codigo').value);
    nf.aviso($('fc-aviso-2'), '');
    if (codigoVencido()) { nf.erroCampo('fc-codigo', MSG.codigoNovo); return; }
    if (codigo.length !== 6) { nf.erroCampo('fc-codigo', 'O código tem 6 dígitos.'); return; }
    nf.erroCampo('fc-codigo', '');
    var botao = $('fc-confirmar-codigo');
    nf.ocupado(botao, true, 'Conferindo…');
    nf.verificarCodigo(d.email, codigo).then(function (r) {
      if (r.ok) return st.tenantId ? retomar() : criar();
      if (r.status === 429) { st.tentativas = MAX_TENTATIVAS; nf.erroCampo('fc-codigo', MSG.codigoNovo); return; }
      st.tentativas++;
      nf.erroCampo('fc-codigo', codigoVencido() ? MSG.codigoNovo : MSG.codigoIncorreto);
    }).then(function () { nf.ocupado(botao, false); });
  }

  function criar() {
    var d = nf.cadastro.ler();
    return nf.funcao('fiscal-cadastro', {
      acao: 'criar', cnpj: d.cnpj, razao_social: d.empresa, responsavel: d.responsavel,
      telefone: nf.telefoneE164(d.telefone), plano: st.plano
    }).then(function (r) {
      if (r.ok && r.dados.tenant_id) {
        st.tenantId = r.dados.tenant_id;
        irPara(ETAPA_DO_SERVIDOR[r.dados.etapa] || 3);
        return;
      }
      if (r.status === 401) return;           // sessão vencida: o evento já levou à etapa do código
      var aviso = null, campo = null;
      if (r.codigo === 'CNPJ_JA_CADASTRADO') aviso = MSG.cnpjComConta;
      else if (r.codigo === 'TELEFONE_DE_OUTRA_EMPRESA') { aviso = MSG.telefoneOutra; campo = ['fc-telefone', MSG.telefoneOutra]; }
      else if (r.codigo === 'CONTA_JA_TEM_EMPRESA') aviso = 'Este e-mail já tem uma empresa cadastrada. <a href="/agentes/fiscal/conta/">Entre pela sua conta</a>';
      else if (r.codigo === 'MUNICIPIO_FORA_DO_PADRAO') aviso = MSG.municipio;
      else if (r.codigo === 'CNPJ_INVALIDO') campo = ['fc-cnpj', MSG.cnpj];
      else if (r.codigo === 'CNPJ_NAO_ENCONTRADO') campo = ['fc-cnpj', 'Não encontramos este CNPJ nos dados públicos. Confira os números.'];
      else aviso = nf.esc(r.mensagem || MSG.generico);
      if (st.etapa !== 1) irPara(1);
      if (aviso) nf.aviso($('fc-aviso-1'), aviso, 'erro');
      if (campo) nf.erroCampo(campo[0], campo[1]);
    });
  }

  /* Volta à etapa em que a pessoa parou, pelo estado da conta. */
  function retomar() {
    return carregarEstado().then(function (r) {
      if (r.ok) { irPara(etapaDoEstado(r.dados)); return; }
      if (r.codigo === 'CONTA_SEM_EMPRESA') { preencherEtapa1(nf.cadastro.ler()); irPara(1); return; }
      if (r.status === 401) { nf.sessao.limpar(); preencherEtapa1(nf.cadastro.ler()); irPara(1); return; }
      preencherEtapa1(nf.cadastro.ler());
      irPara(1);
      nf.aviso($('fc-aviso-1'), nf.esc(r.mensagem || MSG.generico), 'erro');
    });
  }

  /* Sessão vencida no meio: volta para a etapa do código, mantendo o que já foi digitado (Unresolved 12). */
  window.addEventListener('nofiscal:sessao-vencida', function () {
    var d = nf.cadastro.ler();
    if (!d.email) { nf.navegar('/agentes/fiscal/conta/'); return; }
    pedirCodigo(d.email, $('fc-aviso-1')).then(function (ok) {
      if (ok) nf.aviso($('fc-aviso-2'), 'Sua sessão venceu. Mandamos um código novo para continuar de onde você parou.', 'info');
    });
  });

  /* ---------- 3 · Pagamento ---------- */
  function abrirPagamento() {
    var d = nf.cadastro.ler();
    $('fc-cpf-pagamento-bloco').hidden = nf.cpfValido(d.cpf);
    var uf = $('fc-en-uf');
    if (uf.options.length <= 1) nf.UFS.forEach(function (u) { var o = document.createElement('option'); o.value = u; o.textContent = u; uf.appendChild(o); });
    mostrarPlano();
    var pagar = $('fc-pagar');
    pagar.disabled = true;
    nf.funcao('assinatura-fiscal', undefined, { metodo: 'GET', auth: false }).then(function (r) {
      if (!r.ok) { nf.aviso($('fc-aviso-3'), 'Não deu para abrir o pagamento agora. Recarregue a página em alguns minutos.', 'erro'); return; }
      st.checkout = r.dados;
      mostrarPlano();
      $('fc-aceite-texto').textContent = r.dados.aceite_texto || '';
      if (r.dados.venda_aberta === true) { pagar.disabled = false; pagar.textContent = 'Começar 7 dias grátis'; }
      else { pagar.disabled = true; pagar.textContent = MSG.vendaFechada; }
    });
  }
  function lerCartao() {
    return {
      numero: $('fc-cc-numero').value, nome: $('fc-cc-nome').value, validade: $('fc-cc-validade').value, cvv: $('fc-cc-cvv').value,
      endereco: {
        cep: $('fc-en-cep').value, rua: $('fc-en-rua').value, numero: $('fc-en-numero').value, complemento: $('fc-en-complemento').value,
        bairro: $('fc-en-bairro').value, cidade: $('fc-en-cidade').value, uf: $('fc-en-uf').value
      }
    };
  }
  var CAMPO_CARTAO = { numero: 'fc-cc-numero', nome: 'fc-cc-nome', validade: 'fc-cc-validade', cvv: 'fc-cc-cvv', cep: 'fc-en-cep', rua: 'fc-en-rua', end_numero: 'fc-en-numero', bairro: 'fc-en-bairro', cidade: 'fc-en-cidade', uf: 'fc-en-uf' };
  function limparCartao() { ['fc-cc-numero', 'fc-cc-nome', 'fc-cc-validade', 'fc-cc-cvv'].forEach(function (id) { $(id).value = ''; }); }

  function enviarPagamento(ev) {
    ev.preventDefault();
    if (!st.checkout || st.checkout.venda_aberta !== true) return;
    Object.keys(CAMPO_CARTAO).forEach(function (k) { nf.erroCampo(CAMPO_CARTAO[k], ''); });
    nf.erroCampo('fc-cpf-pagamento', ''); nf.erroCampo('fc-aceite', '');
    nf.aviso($('fc-aviso-3'), '');
    var d = nf.cadastro.ler();
    var cpf = nf.cpfValido(d.cpf) ? d.cpf : nf.digitos($('fc-cpf-pagamento').value);
    var c = lerCartao();
    var erros = nf.validarCartao(c);
    var falhou = Object.keys(erros).length > 0;
    Object.keys(erros).forEach(function (k) { nf.erroCampo(CAMPO_CARTAO[k], erros[k]); });
    if (!nf.cpfValido(cpf)) { nf.erroCampo('fc-cpf-pagamento', MSG.cpf); $('fc-cpf-pagamento-bloco').hidden = false; falhou = true; }
    if (!$('fc-aceite').checked) { nf.erroCampo('fc-aceite', 'Para continuar, aceite os Termos de Uso e a Política de Privacidade.'); falhou = true; }
    if (falhou) return;
    var botao = $('fc-pagar');
    nf.ocupado(botao, true, 'Processando…');
    var concluiu = false;
    nf.tokenizarCartao(st.checkout.public_key, c).then(function (token) {
      limparCartao();
      return nf.funcao('assinatura-fiscal', {
        plano: st.plano, cpf: cpf, card_token: token, endereco: nf.enderecoDoCartao(c.endereco),
        termos_aceite: true, aceite_texto: nf.texto($('fc-aceite-texto').textContent)
      }).then(function (r) {
        if (r.ok) {
          concluiu = true;
          if (r.dados.com_teste === false) {
            nf.aviso($('fc-aviso-3'), nf.esc(r.dados.aviso || MSG.reteste), 'info');
            botao.hidden = true;
            $('fc-seguir-sem-teste').hidden = false;
            return;
          }
          irPara(4);
          return;
        }
        if (r.status === 401) return;
        if (r.status === 402 || r.codigo === 'PAGAMENTO_RECUSADO') { nf.aviso($('fc-aviso-3'), MSG.recusado, 'erro'); return; }
        if (r.status === 409) {
          // Assinatura já registrada (ex.: segundo clique): o estado diz onde a pessoa está.
          return carregarEstado().then(function (e) {
            if (e.ok && etapaDoEstado(e.dados) > 3) { concluiu = true; irPara(etapaDoEstado(e.dados)); }
            else nf.aviso($('fc-aviso-3'), nf.esc(r.mensagem || MSG.generico), 'erro');
          });
        }
        nf.aviso($('fc-aviso-3'), nf.esc(r.mensagem || MSG.generico), 'erro');
      });
    }, function () {
      nf.aviso($('fc-aviso-3'), 'Confira os dados do cartão.', 'erro');
    }).then(function () {
      nf.ocupado(botao, false);
      // Assinatura feita: o botão não volta, para um segundo clique não criar outra cobrança.
      if (concluiu) botao.disabled = true;
    });
  }

  /* ---------- 4 · Certificado ---------- */
  function mostrarCertificado(subject, notAfter) {
    nf.aviso($('fc-aviso-4'), nf.esc('Certificado de ' + nf.titular(subject) + ' válido até ' + nf.dataBR(notAfter)), 'ok');
    $('fc-enviar-a1').hidden = true;
    $('fc-continuar-4').hidden = false;
  }
  function abrirCertificado() {
    var c = st.estado && st.estado.certificado;
    if (c && c.subject) mostrarCertificado(c.subject, c.not_after);
  }
  function enviarCertificado(ev) {
    ev.preventDefault();
    nf.erroCampo('fc-pfx', ''); nf.erroCampo('fc-pfx-senha', ''); nf.aviso($('fc-aviso-4'), '');
    var arquivo = $('fc-pfx').files && $('fc-pfx').files[0];
    var senha = $('fc-pfx-senha').value;
    if (!arquivo) { nf.erroCampo('fc-pfx', 'Escolha o arquivo do certificado.'); return; }
    if (!senha) { nf.erroCampo('fc-pfx-senha', 'Informe a senha do certificado.'); return; }
    var form = new FormData();
    form.append('tenant_id', st.tenantId);
    form.append('pfx', arquivo, arquivo.name || 'certificado.pfx');
    form.append('senha', senha);
    var botao = $('fc-enviar-a1');
    nf.ocupado(botao, true, 'Enviando…');
    nf.app('/v1/onboarding/certificate', form).then(function (r) {
      $('fc-pfx-senha').value = '';
      if (r.ok) {
        st.estado = st.estado || {};
        st.estado.certificado = { subject: r.dados.subject, not_after: r.dados.not_after };
        mostrarCertificado(r.dados.subject, r.dados.not_after);
        return;
      }
      if (r.status === 401) return;
      var msg = CERT[r.codigo] || r.mensagem || MSG.generico;
      if (r.codigo === 'CERT_SENHA_INVALIDA') nf.erroCampo('fc-pfx-senha', msg);
      nf.aviso($('fc-aviso-4'), nf.esc(msg), 'erro');
    }).then(function () { nf.ocupado(botao, false); });
  }

  /* ---------- 5 · Dados fiscais ---------- */
  function abrirFiscal() {
    var pro = st.plano === 'pro';
    $('fc-pro').hidden = !pro;
    var dia = $('fc-resumo-dia-mes');
    if (dia.options.length === 0) for (var i = 1; i <= 28; i++) { var o = document.createElement('option'); o.value = String(i); o.textContent = String(i); dia.appendChild(o); }
    var f = (st.estado && st.estado.fiscal) || {};
    if (f.p_tot_trib_sn != null && !$('fc-percentual').value) $('fc-percentual').value = String(f.p_tot_trib_sn).replace('.', ',');
    if (f.contador_email && !$('fc-contador').value) $('fc-contador').value = f.contador_email;
    if (f.resumo && f.resumo.frequencia) {
      marcarResumo(f.resumo.frequencia);
      $(f.resumo.frequencia === 'semanal' ? 'fc-resumo-dia-semana' : 'fc-resumo-dia-mes').value = String(f.resumo.dia);
    }
    if (!st.seletor) {
      var cnae = (st.estado && st.estado.empresa && st.estado.empresa.cnae) || (st.consulta && st.consulta.cnae) || '';
      st.seletor = nf.seletorCodigo($('fc-seletor'), { cnae: cnae, atual: f.codigo_servico_nacional });
    }
  }
  function marcarResumo(valor) {
    var radios = document.getElementsByName('fc-resumo');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === valor;
  }
  function resumoEscolhido() {
    var radios = document.getElementsByName('fc-resumo');
    for (var i = 0; i < radios.length; i++) {
      if (!radios[i].checked) continue;
      if (radios[i].value === 'mensal') return { frequencia: 'mensal', dia: Number($('fc-resumo-dia-mes').value) };
      if (radios[i].value === 'semanal') return { frequencia: 'semanal', dia: Number($('fc-resumo-dia-semana').value) };
    }
    return null;
  }
  var CAMPO_FISCAL = { codigo_servico_nacional: 'fc-codigo-servico', p_tot_trib_sn: 'fc-percentual', contador_email: 'fc-contador' };
  function enviarFiscal(ev) {
    ev.preventDefault();
    Object.keys(CAMPO_FISCAL).forEach(function (k) { nf.erroCampo(CAMPO_FISCAL[k], ''); });
    nf.aviso($('fc-aviso-5'), '');
    var codigo = st.seletor ? st.seletor.valor() : '';
    var pct = nf.percentual($('fc-percentual').value);
    var falhou = false;
    if (!/^\d{6}$/.test(codigo)) { nf.erroCampo('fc-codigo-servico', 'Escolha o código de serviço.'); falhou = true; }
    if (pct === null) { nf.erroCampo('fc-percentual', 'Use um número de 0 a 100, com até 2 casas.'); falhou = true; }
    var corpo = { acao: 'configurar', codigo_servico_nacional: codigo, p_tot_trib_sn: pct };
    if (st.plano === 'pro') {
      var contador = nf.texto($('fc-contador').value);
      if (contador && !nf.emailValido(contador)) { nf.erroCampo('fc-contador', 'Informe um e-mail válido ou deixe em branco.'); falhou = true; }
      corpo.contador_email = contador || null;
      corpo.resumo = resumoEscolhido();
    }
    if (falhou) return;
    var botao = $('fc-salvar-fiscal');
    nf.ocupado(botao, true, 'Salvando…');
    nf.funcao('fiscal-conta', corpo).then(function (r) {
      if (r.ok) {
        if (r.dados && r.dados.tenant_id) aplicarEstado(r.dados);
        irPara(6);
        return;
      }
      if (r.status === 401) return;
      if (r.codigo === 'DADOS_FISCAIS_INVALIDOS' && CAMPO_FISCAL[r.dados.campo]) { nf.erroCampo(CAMPO_FISCAL[r.dados.campo], r.mensagem || 'Confira este campo.'); return; }
      if (r.codigo === 'PLANO_SEM_RESUMO') { nf.aviso($('fc-aviso-5'), 'O resumo das notas é do plano Pro.', 'erro'); return; }
      nf.aviso($('fc-aviso-5'), nf.esc(r.mensagem || MSG.generico), 'erro');
    }).then(function () { nf.ocupado(botao, false); });
  }

  /* ---------- 6 · Seus clientes ---------- */
  var CAMPOS_CLIENTE = [
    ['nome', 'Nome do modelo'], ['tomador_nome', 'Cliente'], ['tomador_documento', 'CPF ou CNPJ'], ['tomador_email', 'E-mail'],
    ['codigo_servico_nacional', 'Serviço'], ['descricao', 'Descrição'], ['valor_padrao', 'Último valor (R$)']
  ];
  var candidatos = [];
  function valorExibido(k, v) {
    if (v == null) return '';
    if (k === 'tomador_documento') return nf.formatarDocumento(v);
    if (k === 'valor_padrao') { var n = Number(v); return isNaN(n) ? String(v) : n.toFixed(2).replace('.', ','); }
    return String(v);
  }
  function cartaoCliente(c, i) {
    return '<article class="nf-cliente" data-i="' + i + '">' +
      '<label class="nf-salvar-modelo"><input type="checkbox" data-campo="salvar" checked> Salvar como modelo</label>' +
      '<div class="nf-cliente-campos">' + CAMPOS_CLIENTE.map(function (p) {
        var id = 'fc-cli-' + i + '-' + p[0];
        var tag = p[0] === 'descricao' ? 'textarea' : 'input';
        var val = nf.esc(valorExibido(p[0], c[p[0]]));
        return '<div class="nf-campo' + (p[0] === 'descricao' ? ' nf-campo--largo' : '') + '"><label for="' + id + '">' + p[1] + '</label>' +
          (tag === 'textarea' ? '<textarea id="' + id + '" data-campo="' + p[0] + '" rows="2">' + val + '</textarea>' : '<input id="' + id + '" data-campo="' + p[0] + '" value="' + val + '">') + '</div>';
      }).join('') + '</div></article>';
  }
  function desenharClientes() {
    $('fc-clientes').innerHTML = candidatos.map(cartaoCliente).join('');
    $('fc-salvar-clientes').hidden = candidatos.length === 0;
  }
  /* Lê os cartões como estão na tela (a pessoa pode ter editado). */
  function lerClientes() {
    var saida = [];
    var cartoes = $('fc-clientes').querySelectorAll('.nf-cliente');
    for (var i = 0; i < cartoes.length; i++) {
      var el = cartoes[i], base = candidatos[Number(el.getAttribute('data-i'))] || {};
      if (!el.querySelector('[data-campo="salvar"]').checked) continue;
      var m = { tomador_endereco: base.tomador_endereco || null, origem: base.origem || null };
      CAMPOS_CLIENTE.forEach(function (p) { m[p[0]] = nf.texto(el.querySelector('[data-campo="' + p[0] + '"]').value) || null; });
      if (m.tomador_documento) m.tomador_documento = nf.digitos(m.tomador_documento);
      if (m.codigo_servico_nacional) m.codigo_servico_nacional = nf.digitos(m.codigo_servico_nacional);
      if (m.valor_padrao) { var v = Number(String(m.valor_padrao).replace(/\./g, '').replace(',', '.')); m.valor_padrao = isNaN(v) ? m.valor_padrao : v.toFixed(2); }
      saida.push(m);
    }
    return saida;
  }
  function guardarEdicoes() {
    var cartoes = $('fc-clientes').querySelectorAll('.nf-cliente');
    for (var i = 0; i < cartoes.length; i++) {
      var el = cartoes[i], c = candidatos[Number(el.getAttribute('data-i'))];
      if (!c) continue;
      CAMPOS_CLIENTE.forEach(function (p) { c[p[0]] = el.querySelector('[data-campo="' + p[0] + '"]').value; });
      c._salvar = el.querySelector('[data-campo="salvar"]').checked;
    }
  }
  function acrescentar(c) {
    guardarEdicoes();
    var doc = nf.digitos(c.tomador_documento);
    for (var i = 0; doc && i < candidatos.length; i++) if (nf.digitos(candidatos[i].tomador_documento) === doc) { candidatos[i] = c; desenharClientes(); return; }
    candidatos.push(c);
    desenharClientes();
  }
  function oferecerPdfs(textoAviso) {
    $('fc-pdfs').hidden = false;
    $('fc-mais-pdfs').hidden = true;
    if (textoAviso) $('fc-pdfs-texto').textContent = textoAviso;
  }
  function abrirClientes() {
    if (st.clientesCarregados) return;
    st.clientesCarregados = true;
    $('fc-buscando').hidden = false;
    nf.app('/v1/onboarding/clientes', { tenant_id: st.tenantId, acao: 'buscar_adn' }).then(function (r) {
      $('fc-buscando').hidden = true;
      var lista = r.ok && Array.isArray(r.dados.candidatos) ? r.dados.candidatos : [];
      if (lista.length) {
        candidatos = lista.slice();
        desenharClientes();
        $('fc-mais-pdfs').hidden = false;
        return;
      }
      if (r.codigo === 'ADN_INDISPONIVEL') oferecerPdfs('O Ambiente de Dados Nacional não respondeu agora. Envie os PDFs das notas (DANFSe) que você já emitiu, até 30, e a gente lê os dados de cada cliente.');
      else oferecerPdfs();
    });
  }
  function enviarPdfs() {
    var arquivos = Array.prototype.slice.call($('fc-pdf').files || []);
    if (!arquivos.length) return;
    var avisoEl = $('fc-aviso-pdf');
    var problemas = [];
    var lidos = 0;
    function proximo(i) {
      if (i >= arquivos.length) return Promise.resolve();
      nf.aviso(avisoEl, nf.esc('Lendo ' + (i + 1) + ' de ' + arquivos.length + '…'), 'info');
      var form = new FormData();
      form.append('tenant_id', st.tenantId);
      form.append('acao', 'ler_pdf');
      form.append('arquivo', arquivos[i], arquivos[i].name || 'nota.pdf');
      return nf.app('/v1/onboarding/clientes', form).then(function (r) {
        if (r.ok && r.dados.candidato) { lidos++; acrescentar(r.dados.candidato); return proximo(i + 1); }
        if (r.codigo === 'LIMITE_PDFS' || r.status === 429) { problemas.push('Você chegou ao limite de 30 PDFs.'); return; }
        if (r.status === 401) return;
        problemas.push((arquivos[i].name || 'PDF') + ': ' + (r.codigo === 'PDF_ILEGIVEL' ? 'não conseguimos ler este PDF como nota (DANFSe).' : (r.mensagem || 'não deu para ler agora.')));
        return proximo(i + 1);
      });
    }
    proximo(0).then(function () {
      $('fc-pdf').value = '';
      var resumo = lidos ? (lidos === 1 ? '1 nota lida.' : lidos + ' notas lidas.') : '';
      nf.aviso(avisoEl, nf.esc([resumo].concat(problemas).filter(Boolean).join(' ')), problemas.length ? 'erro' : 'ok');
    });
  }
  function salvarClientes() {
    nf.aviso($('fc-aviso-6'), '');
    var modelos = lerClientes();
    if (!modelos.length) { nf.aviso($('fc-aviso-6'), 'Marque ao menos um cliente, ou toque em “Pular por enquanto”.', 'erro'); return; }
    var botao = $('fc-salvar-clientes');
    nf.ocupado(botao, true, 'Salvando…');
    nf.app('/v1/onboarding/clientes', { tenant_id: st.tenantId, acao: 'salvar', modelos: modelos }).then(function (r) {
      if (r.ok) {
        var ignorados = Array.isArray(r.dados.ignorados) ? r.dados.ignorados : [];
        if (!ignorados.length) { irPara(7); return; }
        var salvos = Number(r.dados.salvos) || 0;
        nf.aviso($('fc-aviso-6'), nf.esc((salvos === 1 ? '1 cliente salvo.' : salvos + ' clientes salvos.') + ' Ficaram de fora: ' +
          ignorados.map(function (x) { return (x.nome || 'sem nome') + ' (' + (x.motivo || 'inválido') + ')'; }).join('; ') + '.'), 'info');
        botao.hidden = true;
        $('fc-pular').hidden = true;
        $('fc-continuar-6').hidden = false;
        return;
      }
      if (r.status === 401) return;
      nf.aviso($('fc-aviso-6'), nf.esc(r.mensagem || MSG.generico), 'erro');
    }).then(function () { nf.ocupado(botao, false); });
  }

  /* ---------- 7 · Concluir no WhatsApp ---------- */
  function abrirAtivacao() {
    if (st.estado && st.estado.onboarding_etapa === 'concluido') {
      $('fc-titulo-7').textContent = 'Tudo pronto';
      $('fc-ativar-texto').textContent = 'A configuração está completa. Para emitir, é só mandar uma mensagem ao agente no WhatsApp com o cliente e o valor.';
      return;
    }
    if (st.ativacaoPedida) return;
    st.ativacaoPedida = true;
    var tel = (st.estado && st.estado.empresa && st.estado.empresa.telefone) || nf.telefoneE164(nf.cadastro.ler().telefone);
    nf.app('/v1/onboarding/ativacao', { tenant_id: st.tenantId }).then(function (r) {
      if (r.ok && r.dados.whatsapp_url) {
        var link = $('fc-whatsapp');
        link.href = r.dados.whatsapp_url;
        link.hidden = false;
        $('fc-ativar-texto').textContent = 'Toque no botão: o WhatsApp abre com a mensagem “ATIVAR ' + r.dados.codigo + '” pronta.' +
          (tel ? ' Mande do número ' + nf.mascararTelefone(tel) + ', o que você cadastrou.' : ' Mande do número que você cadastrou.') +
          ' O agente confere o cadastro com você, pergunta para quem você mais emite e faz uma nota de exemplo, sem emitir nada.';
        var v = $('fc-ativar-validade');
        v.textContent = 'O código vale até ' + nf.diaMes(r.dados.expira_em) + ' às ' + nf.horaBR(r.dados.expira_em) + '. Depois disso, gere outro em Minha conta.';
        v.hidden = false;
        return;
      }
      st.ativacaoPedida = false;
      if (r.status === 401) return;
      if (r.codigo === 'JA_ATIVADO') {
        $('fc-ativar-texto').textContent = 'Seu WhatsApp já está ativado. Continue a conversa com o agente por lá.';
        var numero = nf.digitos(nf.config.whatsappAgente);
        if (numero) { var a = $('fc-whatsapp'); a.href = 'https://wa.me/' + numero; a.hidden = false; }
        return;
      }
      nf.aviso($('fc-aviso-7'), nf.esc(r.mensagem || MSG.generico), 'erro');
    });
  }

  /* ---------- ligações ---------- */
  $('fc-form-1').addEventListener('submit', enviarEtapa1);
  $('fc-cnpj').addEventListener('input', function () {
    var d = nf.digitos($('fc-cnpj').value);
    nf.erroCampo('fc-cnpj', '');
    if (d.length === 14 && d !== st.cnpjConsultado) consultarCnpj();
    if (d.length < 14) { st.cnpjConsultado = ''; st.consulta = null; nf.aviso($('fc-aviso-1'), ''); }
  });
  $('fc-cpf').addEventListener('blur', function () {
    var d = nf.digitos($('fc-cpf').value);
    nf.erroCampo('fc-cpf', d.length && !nf.cpfValido(d) ? MSG.cpf : '');
  });
  $('fc-form-2').addEventListener('submit', enviarCodigo);
  $('fc-reenviar').addEventListener('click', function () {
    var d = nf.cadastro.ler();
    if (!d.email) { irPara(1); return; }
    pedirCodigo(d.email, $('fc-aviso-2')).then(function (ok) { if (ok) nf.aviso($('fc-aviso-2'), 'Mandamos um código novo.', 'info'); });
  });
  $('fc-trocar-email').addEventListener('click', function () { preencherEtapa1(nf.cadastro.ler()); irPara(1); });
  $('fc-form-3').addEventListener('submit', enviarPagamento);
  $('fc-seguir-sem-teste').addEventListener('click', function () { irPara(4); });
  $('fc-form-4').addEventListener('submit', enviarCertificado);
  $('fc-continuar-4').addEventListener('click', function () { irPara(5); });
  $('fc-form-5').addEventListener('submit', enviarFiscal);
  $('fc-pdf').addEventListener('change', enviarPdfs);
  $('fc-mais-pdfs').addEventListener('click', function () { oferecerPdfs('Envie os PDFs das notas (DANFSe) de outros clientes, até 30 no total.'); });
  $('fc-salvar-clientes').addEventListener('click', salvarClientes);
  $('fc-pular').addEventListener('click', function () { irPara(7); });
  $('fc-continuar-6').addEventListener('click', function () { irPara(7); });

  /* ---------- início ---------- */
  mostrarPlano();
  preencherEtapa1(nf.cadastro.ler());
  if (nf.sessao.ler()) retomar();
  else irPara(1);
})();
