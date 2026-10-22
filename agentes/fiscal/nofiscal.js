/* nó.fiscal no site: o que /comecar/ e /conta/ compartilham (Landing do lote E em .checks/agente-fiscal-v2.md).
   - sessão do Supabase Auth guardada pela página, sem supabase-js: localStorage 'nofiscal.sessao'
     {access_token, refresh_token, expires_at}, código conferido em POST /auth/v1/verify {type:'email'} e renovação
     por POST /auth/v1/token?grant_type=refresh_token;
   - chamadas às edge functions (erro {ok:false, error_code, mensagem}) e às rotas do app em apiBase
     (erro {error:{code, message}}), com a mesma forma de resposta para as páginas;
   - validações (CPF, CNPJ, e-mail, WhatsApp), formatos e a tokenização do cartão direto no Pagar.me;
   - o seletor de código de serviço nacional (lista e sugestões por CNAE em /agentes/fiscal/dados/).
   Nada aqui manda número, validade ou CVV do cartão para a Nó: só o token do Pagar.me. */
(function () {
  'use strict';
  var CFG = window.NOFISCAL_CONFIG || {};
  var SUPABASE = String(CFG.supabaseUrl || '').replace(/\/+$/, '');
  var FUNCOES = String(CFG.funcoesUrl || (SUPABASE + '/functions/v1')).replace(/\/+$/, '');
  var API = String(CFG.apiBase || '/agentes/fiscal/api').replace(/\/+$/, '');
  var PAGARME = String(CFG.pagarmeApiUrl || 'https://api.pagar.me/core/v5').replace(/\/+$/, '');
  var CHAVE_SESSAO = 'nofiscal.sessao';
  var CHAVE_CADASTRO = 'nofiscal.cadastro';
  var FUSO = 'America/Sao_Paulo';
  var UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
    'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
  var PLANOS = {
    inicial: { nome: 'Inicial', centavos: 4900, notas: 20 },
    pro: { nome: 'Pro', centavos: 12900, notas: 100 }
  };

  /* ---------- funções puras ---------- */
  function digitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  function texto(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function semAcento(v) { return String(v || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); }

  function cpfValido(v) {
    var d = digitos(v);
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    for (var t = 9; t < 11; t++) {
      var s = 0;
      for (var i = 0; i < t; i++) s += Number(d[i]) * (t + 1 - i);
      if (((s * 10) % 11) % 10 !== Number(d[t])) return false;
    }
    return true;
  }
  function cnpjValido(v) {
    var d = digitos(v);
    if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
    var pesos = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    for (var t = 12; t < 14; t++) {
      var s = 0;
      for (var i = 0; i < t; i++) s += Number(d[i]) * pesos[i + 13 - t];
      var r = s % 11 < 2 ? 0 : 11 - (s % 11);
      if (r !== Number(d[t])) return false;
    }
    return true;
  }
  function documentoValido(v) { var d = digitos(v); return d.length === 11 ? cpfValido(d) : cnpjValido(d); }
  function emailValido(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(texto(v)); }
  /* WhatsApp brasileiro: DDD + número (10 ou 11 dígitos), com ou sem o 55 na frente → E.164. */
  function telefoneE164(v) {
    var d = digitos(v);
    if ((d.length === 12 || d.length === 13) && d.slice(0, 2) === '55') d = d.slice(2);
    if (d.length !== 10 && d.length !== 11) return null;
    if (d[0] === '0') return null;
    return '+55' + d;
  }
  function formatarCnpj(v) {
    var d = digitos(v);
    return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d;
  }
  function formatarDocumento(v) {
    var d = digitos(v);
    if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    return formatarCnpj(d);
  }
  function mascararEmail(v) {
    var e = texto(v), i = e.indexOf('@');
    if (i < 1) return e;
    return e.slice(0, Math.min(2, i)) + '•••' + e.slice(i);
  }
  function mascararTelefone(v) {
    var d = digitos(v);
    if (d.slice(0, 2) === '55' && d.length >= 12) d = d.slice(2);
    if (d.length < 10) return v || '';
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, 3) + '••••-' + d.slice(-4);
  }
  /* +5511977776655 → (11) 97777-6655: o número inteiro, para a própria pessoa conferir. */
  function formatarTelefone(v) {
    var d = digitos(v);
    if (d.slice(0, 2) === '55' && d.length >= 12) d = d.slice(2);
    if (d.length < 10) return v || '';
    return '(' + d.slice(0, 2) + ') ' + d.slice(2, d.length - 4) + '-' + d.slice(-4);
  }
  function partesData(iso) {
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return null;
    var p = {};
    new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(dt).forEach(function (x) { p[x.type] = x.value; });
    return p;
  }
  function dataBR(iso) { var p = partesData(iso); return p ? p.day + '/' + p.month + '/' + p.year : ''; }
  function diaMes(iso) { var p = partesData(iso); return p ? p.day + '/' + p.month : ''; }
  function horaBR(iso) { var p = partesData(iso); return p ? p.hour + ':' + p.minute : ''; }
  function reais(centavos) {
    var n = Number(centavos) / 100;
    return 'R$ ' + (n % 1 === 0 ? String(n) : n.toFixed(2).replace('.', ','));
  }
  function rotuloPlano(codigo, centavos) {
    var p = PLANOS[codigo] || PLANOS.inicial;
    return 'Plano ' + p.nome + ' · ' + reais(centavos == null ? p.centavos : centavos) + '/mês · 7 dias grátis';
  }
  function planoDaUrl(search) {
    var p = new URLSearchParams(search || '').get('plano');
    return p === 'pro' ? 'pro' : 'inicial';
  }
  /* Titular legível do subject que a rota do A1 devolve ("CN=NOME:CNPJ, C=BR, ..."). */
  function titular(subject) {
    var s = String(subject || '');
    var m = /(?:^|,\s*)CN=([^,]+)/.exec(s);
    return texto((m ? m[1] : s).replace(/:\d{11,14}\s*$/, ''));
  }
  /* Percentual de tributos do Simples: 0 a 100, até 2 casas, com vírgula ou ponto. */
  function percentual(v) {
    var t = texto(v).replace(',', '.');
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
    var n = Number(t);
    return n >= 0 && n <= 100 ? n : null;
  }
  function validarCartao(d) {
    d = d || {};
    var erros = {};
    var num = digitos(d.numero);
    if (num.length < 13 || num.length > 19) erros.numero = 'Confira o número do cartão.';
    if (texto(d.nome).length < 2) erros.nome = 'Informe o nome impresso no cartão.';
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(texto(d.validade))) erros.validade = 'Use o formato MM/AA.';
    var cvv = digitos(d.cvv);
    if (cvv.length < 3 || cvv.length > 4) erros.cvv = 'O CVV tem 3 ou 4 dígitos.';
    var e = d.endereco || {};
    if (digitos(e.cep).length !== 8) erros.cep = 'O CEP tem 8 dígitos.';
    if (texto(e.rua).length < 2) erros.rua = 'Informe a rua.';
    if (texto(e.numero).length < 1) erros.end_numero = 'Informe o número.';
    if (texto(e.bairro).length < 2) erros.bairro = 'Informe o bairro.';
    if (texto(e.cidade).length < 2) erros.cidade = 'Informe a cidade.';
    if (UFS.indexOf(texto(e.uf).toUpperCase()) < 0) erros.uf = 'Escolha a UF.';
    return erros;
  }
  function enderecoDoCartao(e) {
    e = e || {};
    return {
      cep: digitos(e.cep), rua: texto(e.rua), numero: texto(e.numero), complemento: texto(e.complemento),
      bairro: texto(e.bairro), cidade: texto(e.cidade), uf: texto(e.uf).toUpperCase()
    };
  }

  /* ---------- armazenamento ---------- */
  function lerJson(area, chave) {
    try { var v = area.getItem(chave); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function gravarJson(area, chave, valor) {
    try { if (valor == null) area.removeItem(chave); else area.setItem(chave, JSON.stringify(valor)); } catch (e) { /* navegador sem armazenamento */ }
  }
  var local = (function () { try { return window.localStorage; } catch (e) { return null; } })();
  var aba = (function () { try { return window.sessionStorage; } catch (e) { return null; } })();

  var sessao = {
    ler: function () {
      var s = local && lerJson(local, CHAVE_SESSAO);
      return s && s.access_token && s.refresh_token ? s : null;
    },
    /* Resposta do GoTrue (verify ou refresh) → só as três chaves do Decided. */
    gravar: function (r) {
      if (!r || !r.access_token || !r.refresh_token) return null;
      var exp = Number(r.expires_at) || Math.floor(Date.now() / 1000) + (Number(r.expires_in) || 3600);
      var s = { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: exp };
      if (local) gravarJson(local, CHAVE_SESSAO, s);
      return s;
    },
    limpar: function () { if (local) gravarJson(local, CHAVE_SESSAO, null); },
    renovar: function () {
      var s = sessao.ler();
      if (!s) return Promise.resolve(null);
      return fetch(SUPABASE + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.anonKey || '' },
        body: JSON.stringify({ refresh_token: s.refresh_token })
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (!r.ok) { sessao.limpar(); return null; }
          return sessao.gravar(j);
        });
      }, function () { return null; });
    },
    /* Token válido por mais 60 s, renovando se preciso; null sem sessão. */
    token: function () {
      var s = sessao.ler();
      if (!s) return Promise.resolve(null);
      if (Number(s.expires_at) - 60 > Date.now() / 1000) return Promise.resolve(s.access_token);
      return sessao.renovar().then(function (n) { return n ? n.access_token : null; });
    }
  };

  var cadastro = {
    ler: function () { return (aba && lerJson(aba, CHAVE_CADASTRO)) || {}; },
    gravar: function (d) { if (aba) gravarJson(aba, CHAVE_CADASTRO, d); },
    limpar: function () { if (aba) gravarJson(aba, CHAVE_CADASTRO, null); }
  };
  /* Texto avulso guardado só nesta aba (ex.: o cupom digitado). */
  var abaTexto = {
    ler: function (chave) { try { return aba ? aba.getItem(chave) : null; } catch (e) { return null; } },
    gravar: function (chave, valor) { try { if (aba) aba.setItem(chave, String(valor)); } catch (e) { /* sem armazenamento */ } },
    apagar: function (chave) { try { if (aba) aba.removeItem(chave); } catch (e) { /* sem armazenamento */ } }
  };
  function nomePlano(codigo) { return (PLANOS[codigo] || PLANOS.inicial).nome; }

  /* ---------- chamadas ---------- */
  function resposta(status, dados) {
    dados = dados && typeof dados === 'object' ? dados : {};
    var erro = dados.error && typeof dados.error === 'object' ? dados.error : null;
    var ok = status >= 200 && status < 300 && dados.ok !== false;
    return {
      status: status, ok: ok, dados: dados,
      codigo: ok ? null : (dados.error_code || (erro && erro.code) || dados.motivo || 'ERRO'),
      mensagem: ok ? '' : (dados.mensagem || (erro && erro.message) || '')
    };
  }
  var SEM_REDE = { status: 0, ok: false, dados: {}, codigo: 'REDE', mensagem: 'Sem conexão agora. Confira a internet e tente de novo.' };

  /* Uma chamada com a sessão; um 401 tenta renovar uma vez. Sem sessão válida no fim, avisa a página
     (evento 'nofiscal:sessao-vencida') para ela voltar à etapa do código. */
  function chamar(url, opcoes) {
    opcoes = opcoes || {};
    var corpo = opcoes.corpo;
    var form = typeof FormData !== 'undefined' && corpo instanceof FormData;
    function enviar(token) {
      var headers = {};
      if (!form && corpo !== undefined) headers['Content-Type'] = 'application/json';
      if (opcoes.apikey) headers.apikey = CFG.anonKey || '';
      if (token) headers.Authorization = 'Bearer ' + token;
      return fetch(url, {
        method: opcoes.metodo || (corpo === undefined ? 'GET' : 'POST'), headers: headers,
        body: corpo === undefined ? undefined : (form ? corpo : JSON.stringify(corpo))
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) { return resposta(r.status, j); });
      }, function () { return SEM_REDE; });
    }
    if (!opcoes.auth) return enviar(null);
    return sessao.token().then(function (t) {
      if (!t) return avisarVencida(resposta(401, { ok: false, error_code: 'SEM_SESSAO' }));
      return enviar(t).then(function (r) {
        if (r.status !== 401) return r;
        return sessao.renovar().then(function (n) {
          if (!n) return avisarVencida(r);
          return enviar(n.access_token).then(function (r2) { return r2.status === 401 ? avisarVencida(r2) : r2; });
        });
      });
    });
  }
  function avisarVencida(r) {
    try { window.dispatchEvent(new CustomEvent('nofiscal:sessao-vencida')); } catch (e) { /* sem CustomEvent */ }
    return r;
  }
  function funcao(nome, corpo, opcoes) {
    opcoes = opcoes || {};
    return chamar(FUNCOES + '/' + nome, { corpo: corpo, metodo: opcoes.metodo, auth: opcoes.auth !== false, apikey: true });
  }
  /* Com barra final: o site tem trailingSlash: true, e sem ela cada chamada levaria um 308 antes do rewrite. */
  function app(caminho, corpo, opcoes) {
    opcoes = opcoes || {};
    var url = API + caminho + (/\/$/.test(caminho) ? '' : '/');
    return chamar(url, { corpo: corpo, metodo: opcoes.metodo, auth: true });
  }

  function pedirCodigo(email) { return funcao('fiscal-acesso', { email: texto(email) }, { auth: false }); }

  /* Confere o código em fiscal-acesso {acao:'verificar'} (que conta as tentativas e só então abre a sessão no
     GoTrue) e guarda a sessão. Resposta de chamar(): codigo = CODIGO_INCORRETO | CODIGO_ESGOTADO | CODIGO_VENCIDO… */
  function verificarCodigo(email, codigo) {
    return funcao('fiscal-acesso', { acao: 'verificar', email: texto(email), codigo: digitos(codigo) }, { auth: false }).then(function (r) {
      if (r.ok && !sessao.gravar(r.dados)) return { status: r.status, ok: false, dados: r.dados, codigo: 'INDISPONIVEL', mensagem: '' };
      return r;
    });
  }
  /* Falha de verificarCodigo() → texto do campo; `novo`: este código acabou, só um código novo resolve. */
  function erroDoCodigo(r) {
    if (r.codigo === 'CODIGO_INCORRETO') return { mensagem: 'Código incorreto', novo: false };
    if (r.codigo === 'CODIGO_ESGOTADO' || r.codigo === 'CODIGO_VENCIDO') return { mensagem: 'Peça um código novo', novo: true };
    if (r.status === 400) return { mensagem: 'O código tem 6 dígitos.', novo: false };
    return { mensagem: 'A conferência do código está fora do ar agora. Tente de novo em alguns minutos.', novo: false };
  }

  /* Cartão direto no Pagar.me (/tokens?appId=<public_key>); devolve só o id do token. */
  function tokenizarCartao(publicKey, c) {
    var partes = texto(c.validade).split('/');
    var corpo = { type: 'card', card: {
      number: digitos(c.numero), holder_name: texto(c.nome),
      exp_month: parseInt(partes[0], 10), exp_year: parseInt('20' + partes[1], 10), cvv: digitos(c.cvv)
    } };
    return fetch(PAGARME + '/tokens?appId=' + encodeURIComponent(publicKey || ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok || !j || typeof j.id !== 'string') throw new Error('CARTAO');
        return j.id;
      });
    }, function () { throw new Error('CARTAO'); });
  }

  /* ---------- dados das pesquisas (podem faltar: a página continua só com a busca por texto) ---------- */
  var dadosCache = {};
  function lerDados(nome) {
    if (!dadosCache[nome]) {
      dadosCache[nome] = fetch('/agentes/fiscal/dados/' + nome, { method: 'GET' })
        .then(function (r) { return r.ok ? r.json() : null; }, function () { return null; })
        .catch(function () { return null; });
    }
    return dadosCache[nome];
  }
  function codigosServico() {
    return lerDados('codigos-servico.json').then(function (d) {
      return d && Array.isArray(d.itens) ? d.itens.filter(function (i) { return i && /^\d{6}$/.test(String(i.codigo)); }) : [];
    });
  }
  function sugestoesCnae(cnae) {
    var c = digitos(cnae);
    return lerDados('cnae-servico.json').then(function (d) {
      var mapa = d && d.cnae && typeof d.cnae === 'object' ? d.cnae : {};
      return Array.isArray(mapa[c]) ? mapa[c].map(String) : [];
    });
  }
  function formatarCodigo(c) { var d = digitos(c); return d.length === 6 ? d.slice(0, 2) + '.' + d.slice(2, 4) + '.' + d.slice(4) : d; }
  function buscarCodigos(lista, termo, limite) {
    var t = semAcento(texto(termo)), td = digitos(termo);
    if (!t) return [];
    var saida = [];
    for (var i = 0; i < lista.length && saida.length < (limite || 20); i++) {
      var it = lista[i];
      if ((td && td.length >= 2 && String(it.codigo).indexOf(td) === 0) || semAcento(it.descricao).indexOf(t) >= 0) saida.push(it);
    }
    return saida;
  }

  /* Seletor do código de serviço: sugestões do CNAE + busca na lista nacional. `raiz` é o contêiner com
     .nf-sugestoes, input.nf-busca e .nf-resultados; devolve {valor()}. */
  /* Busca resumida (Lucca, 22/10/2026): só a partir de 3 letras ou 2 números, no máximo MOSTRADOS opções numa
     caixa com rolagem, e o total quando há mais. Escolher fecha a caixa e mostra o código escolhido. */
  var MOSTRADOS = 6;
  function seletorCodigo(raiz, opcoes) {
    opcoes = opcoes || {};
    var sugestoesEl = raiz.querySelector('.nf-sugestoes');
    var busca = raiz.querySelector('.nf-busca');
    var resultados = raiz.querySelector('.nf-resultados');
    var escolhidoEl = raiz.querySelector('.nf-escolhido');
    var escolhido = opcoes.atual ? digitos(opcoes.atual) : '';
    var nome = 'nf-codigo-' + (raiz.id || 'x');
    var lista = [];
    function opcao(it, marcado) {
      return '<label class="nf-opcao"><input type="radio" name="' + nome + '" value="' + esc(it.codigo) + '"' + (marcado ? ' checked' : '') + '>' +
        '<span><b>' + esc(formatarCodigo(it.codigo)) + '</b> ' + esc(it.descricao || '') + '</span></label>';
    }
    function descricao(c) { for (var i = 0; i < lista.length; i++) if (lista[i].codigo === c) return lista[i].descricao; return ''; }
    function mostrarEscolhido() {
      if (!escolhidoEl) return;
      escolhidoEl.innerHTML = escolhido
        ? 'Escolhido: <b>' + esc(formatarCodigo(escolhido)) + '</b> ' + esc(descricao(escolhido) || '') : '';
      escolhidoEl.hidden = !escolhido;
    }
    raiz.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t || t.name !== nome) return;
      escolhido = t.value;
      mostrarEscolhido();
      // Escolheu na busca: a caixa fecha e o campo limpa.
      if (resultados.contains && resultados.contains(t)) { busca.value = ''; resultados.innerHTML = ''; }
    });
    busca.addEventListener('input', function () {
      var termo = busca.value;
      var t = texto(termo), d = digitos(termo);
      if (!t) { resultados.innerHTML = ''; return; }
      if (lista.length && semAcento(t).replace(/[^a-z]/g, '').length < 3 && d.length < 2) {
        resultados.innerHTML = '<p class="nf-vazio">Digite pelo menos 3 letras ou 2 números do código.</p>';
        return;
      }
      var todos = buscarCodigos(lista, termo, lista.length || 20);
      if (!todos.length && d.length === 6 && !lista.length) todos = [{ codigo: d, descricao: 'código digitado' }];
      if (!todos.length) {
        resultados.innerHTML = '<p class="nf-vazio">' + (lista.length ? 'Nada encontrado na lista nacional.' : 'Digite o código de 6 dígitos.') + '</p>';
        return;
      }
      var resto = todos.length - MOSTRADOS;
      resultados.innerHTML = todos.slice(0, MOSTRADOS).map(function (it) { return opcao(it, it.codigo === escolhido); }).join('') +
        (resto > 0 ? '<p class="nf-mais">Mais ' + resto + (resto === 1 ? ' resultado' : ' resultados') + '. Escreva mais para refinar.</p>' : '');
    });
    var pronto = Promise.all([codigosServico(), sugestoesCnae(opcoes.cnae)]).then(function (r) {
      lista = r[0];
      var sugeridos = r[1].filter(function (c, i, a) { return /^\d{6}$/.test(c) && a.indexOf(c) === i; });
      if (escolhido && sugeridos.indexOf(escolhido) < 0) sugeridos.unshift(escolhido);
      sugestoesEl.innerHTML = sugeridos.length
        ? '<p class="nf-rotulo-lista">Sugeridos para a sua atividade</p>' +
          sugeridos.map(function (c) { return opcao({ codigo: c, descricao: descricao(c) }, c === escolhido); }).join('')
        : '';
      busca.placeholder = lista.length ? 'Ex.: consultoria, 01.07' : 'Código de 6 dígitos';
      mostrarEscolhido();
    });
    return { pronto: pronto, valor: function () { return escolhido; } };
  }

  /* ---------- tela ---------- */
  function $(id) { return document.getElementById(id); }
  /* Botão com indicador durante a chamada (Unresolved 12 da tarefa). */
  /* Carregamento por cima da página (círculo girando + texto). */
  function carregando(ligar, rotulo) {
    var el = document.getElementById('nf-carregando-global');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nf-carregando-global';
      el.className = 'nf-carregando';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span class="nf-roda" aria-hidden="true"></span><p></p>';
      document.body.appendChild(el);
    }
    el.querySelector('p').textContent = rotulo || 'Carregando…';
    el.hidden = !ligar;
  }
  /* Pop-up de aviso (erro): título, texto e um botão; resolve quando fecha. */
  function popup(titulo, mensagem, rotuloBotao) {
    return new Promise(function (resolver) {
      var antes = document.activeElement;
      var fundo = document.createElement('div');
      fundo.className = 'nf-popup-fundo';
      fundo.innerHTML = '<div class="nf-popup" role="alertdialog" aria-modal="true" aria-labelledby="nf-popup-titulo" aria-describedby="nf-popup-texto">' +
        '<span class="nf-popup-icone" aria-hidden="true">!</span><h2 id="nf-popup-titulo"></h2><p id="nf-popup-texto"></p>' +
        '<button type="button" class="fi-btn fi-btn--tinta"></button></div>';
      fundo.querySelector('h2').textContent = titulo;
      fundo.querySelector('p').textContent = mensagem;
      var botao = fundo.querySelector('button');
      botao.textContent = rotuloBotao || 'Entendi';
      function fechar() {
        document.removeEventListener('keydown', tecla);
        if (fundo.parentNode) fundo.parentNode.removeChild(fundo);
        if (antes && typeof antes.focus === 'function') { try { antes.focus(); } catch (e) { /* foco opcional */ } }
        resolver();
      }
      function tecla(ev) { if (ev.key === 'Escape') fechar(); }
      botao.addEventListener('click', fechar);
      document.addEventListener('keydown', tecla);
      document.body.appendChild(fundo);
      try { botao.focus(); } catch (e) { /* foco opcional */ }
    });
  }

  function ocupado(botao, sim, rotulo) {
    if (!botao) return;
    if (sim) {
      botao.dataset.rotulo = botao.textContent;
      botao.textContent = rotulo || 'Aguarde…';
      botao.disabled = true;
      botao.setAttribute('aria-busy', 'true');
    } else {
      if (botao.dataset.rotulo) botao.textContent = botao.dataset.rotulo;
      botao.disabled = false;
      botao.removeAttribute('aria-busy');
    }
  }
  function aviso(el, msg, tipo) {
    if (!el) return;
    el.innerHTML = msg || '';
    el.hidden = !msg;
    el.className = 'nf-aviso' + (tipo ? ' nf-aviso--' + tipo : '');
  }
  function erroCampo(id, msg) {
    var campo = $(id), el = $(id + '-erro');
    if (el) { el.textContent = msg || ''; el.hidden = !msg; }
    if (campo) { if (msg) campo.setAttribute('aria-invalid', 'true'); else campo.removeAttribute('aria-invalid'); }
  }

  window.noFiscal = {
    config: CFG, PLANOS: PLANOS, UFS: UFS,
    digitos: digitos, texto: texto, esc: esc,
    cpfValido: cpfValido, cnpjValido: cnpjValido, documentoValido: documentoValido, emailValido: emailValido,
    telefoneE164: telefoneE164, formatarCnpj: formatarCnpj, formatarDocumento: formatarDocumento,
    mascararEmail: mascararEmail, mascararTelefone: mascararTelefone,
    dataBR: dataBR, diaMes: diaMes, horaBR: horaBR, reais: reais, rotuloPlano: rotuloPlano, planoDaUrl: planoDaUrl,
    titular: titular, percentual: percentual, validarCartao: validarCartao, enderecoDoCartao: enderecoDoCartao,
    formatarCodigo: formatarCodigo, buscarCodigos: buscarCodigos,
    sessao: sessao, cadastro: cadastro, aba: abaTexto, nomePlano: nomePlano,
    funcao: funcao, app: app, pedirCodigo: pedirCodigo, verificarCodigo: verificarCodigo, erroDoCodigo: erroDoCodigo, tokenizarCartao: tokenizarCartao,
    seletorCodigo: seletorCodigo,
    $: $, ocupado: ocupado, aviso: aviso, erroCampo: erroCampo, carregando: carregando, popup: popup,
    formatarTelefone: formatarTelefone,
    navegar: function (url) { location.assign(url); }
  };
})();
