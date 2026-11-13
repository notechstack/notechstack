/* Medição do funil do nó.fiscal, da LP até a assinatura (Lucca, 22/10/2026). Um evento por passo, com o mesmo
   nome no dataLayer (o GTM leva ao GA4 e ao Google Ads; tags em tracking/gtm-nofiscal-funil.json) e, com a medição
   permitida, no Meta Pixel com eventID:

     LP carregada ............ nofiscal_view_content       ViewContent
     plano escolhido ......... nofiscal_plano_escolhido    AddToCart + CAPI   (GA4 add_to_cart)
     Escritório / Agência .... nofiscal_lead               Lead + CAPI        (GA4 generate_lead; WhatsApp comercial)
     cadastro aberto ......... nofiscal_cadastro_inicio    -
     já tem A1? (etapa 1) .... nofiscal_a1                 -                  (também no painel: form_nofiscal_a1)
     conta criada ............ nofiscal_cadastro           CompleteRegistration (GA4 sign_up)
     pagamento aberto ........ nofiscal_checkout           InitiateCheckout   (GA4 begin_checkout)
     cartão enviado .......... nofiscal_pagamento_info     AddPaymentInfo     (GA4 add_payment_info)
     assinatura cobrada ...... nofiscal_compra             Purchase           (GA4 purchase, Ads Compra)
     assinatura em teste ..... nofiscal_teste_iniciado     StartTrial
     cortesia (cupom 100%) ... nofiscal_cortesia           -
     cartão recusado ......... nofiscal_pagamento_recusado -
     WhatsApp de ativação .... nofiscal_ativacao_whatsapp  -

   A compra usa o evento que o checkout devolve (assinatura-fiscal/medicao.ts): o mesmo event_id sai da Meta CAPI
   no servidor, e a Meta deduplica. AddToCart e Lead também saem do servidor, pela função meta-capi, com o mesmo
   event_id do Pixel (Lucca, 03/11/2026): o clique navega logo em seguida e o Pixel sozinho se perdia. Os dois levam
   content_name e, no AddToCart, content_ids/content_type do nó.fiscal (é o produto da Nó, nada de categoria de
   saúde). O dataLayer recebe sempre (o modo de consentimento do Google decide o que o GA4 e o Ads guardam); o fbq e
   a CAPI só saem com a medição permitida em 'no_fiscal_consent', e a CAPI só no domínio de produção. */
(function () {
  'use strict';
  var CONSENT_KEY = 'no_fiscal_consent';
  var PRECOS = { inicial: 49, pro: 129, escritorio_5: 297, escritorio_20: 797, escritorio_50: 1497 }; // reais por mês (assinatura-fiscal/core.ts, PLANOS_PAGARME)
  var PRECOS_ANUAIS = { inicial: 470.4, pro: 1238.4 }; // reais por ano no anual (20% off, core.ts centavosAnuais)
  var NOMES = { inicial: 'Inicial', pro: 'Pro', escritorio: 'Escritório', escritorio_5: 'Escritório 5', escritorio_20: 'Escritório 20', escritorio_50: 'Escritório 50', agencia: 'Agência', presumido: 'Lucro Presumido (lista de espera)' };
  var FN_CAPI = 'https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/meta-capi'; // a mesma da /agentes/
  var ESPERA_MAX_MS = 300; // quanto um clique que sai da página espera os envios confirmarem

  function consentido() {
    try { return localStorage.getItem(CONSENT_KEY) === 'granted'; } catch (e) { return false; }
  }
  function uuid() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function cookie(nome) {
    var m = String(document.cookie || '').match(new RegExp('(?:^|; )' + nome + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function fbc() {
    var c = cookie('_fbc');
    if (c) return c;
    var id = '';
    try { id = new URLSearchParams(location.search).get('fbclid') || ''; } catch (e) { id = ''; }
    return id ? 'fb.1.' + Date.now() + '.' + id : '';
  }
  /* Uma vez por sessão da aba (checkout aberto, conta criada) ou para sempre neste navegador (a compra). */
  function primeiraVez(chave, sempre) {
    var k = 'nofiscal.medido.' + chave;
    try {
      var s = sempre ? localStorage : sessionStorage;
      if (s.getItem(k)) return false;
      s.setItem(k, '1');
    } catch (e) { /* sem storage: mede assim mesmo */ }
    return true;
  }
  /* O Pixel vem pelo GTM e pode chegar depois do primeiro evento: tenta por até 5 s. */
  function fbqQuandoPronto(args, tentativas) {
    if (typeof window.fbq === 'function') { window.fbq.apply(window, args); return; }
    if ((tentativas || 0) >= 20) return;
    setTimeout(function () { fbqQuandoPronto(args, (tentativas || 0) + 1); }, 250);
  }
  function producao() {
    return typeof window.noMarketingHostAllowed === 'function' && window.noMarketingHostAllowed(location.hostname);
  }
  function nada() {}
  /* Envios em curso por event_id, para o clique que sai da página esperar (aposEnvio). */
  var envios = {};
  function registrar(eventId, promessa) {
    if (!promessa) return;
    envios[eventId] = envios[eventId] ? Promise.all([envios[eventId], promessa]).then(nada) : promessa;
  }
  /* Meta CAPI pela função meta-capi, do mesmo jeito da /agentes/ (escritorio/pagina.js): corpo sem dado pessoal,
     só cookies da Meta e a página sem query. Só com a medição permitida; fora de produção o corpo fica em
     api.capi (para os testes) e nada sai do navegador. keepalive: o envio sobrevive à troca de página. */
  function enviarCapi(eventName, eventId, customData) {
    if (!consentido()) return null;
    var corpo = {
      event_name: eventName,
      event_id: eventId,
      event_source_url: location.origin + location.pathname,
      fbp: cookie('_fbp') || undefined,
      fbc: fbc() || undefined,
      custom_data: customData
    };
    // value/currency também no topo: é onde a meta-capi de hoje os lê (body.value, body.currency).
    if (customData && customData.value != null) { corpo.value = customData.value; corpo.currency = customData.currency; }
    api.capi.push(corpo);
    if (!producao() || typeof fetch !== 'function') return null;
    try {
      return fetch(FN_CAPI, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo), keepalive: true })
        .then(nada, nada); // medição não pode derrubar a página
    } catch (e) { return null; }
  }
  function precoDe(plano, ciclo) {
    var tabela = ciclo === 'anual' ? PRECOS_ANUAIS : PRECOS;
    return Object.prototype.hasOwnProperty.call(tabela, plano) ? tabela[plano] : null;
  }

  /* meta.capi: o evento também vai à CAPI (mesmo event_id). meta.esperar: o evento antecede uma saída da página, e o
     GTM avisa quando terminou as tags dele (eventCallback), para aposEnvio não cortar o GA4/Ads no meio. */
  function disparar(nome, dados, meta) {
    var eventId = (meta && meta.eventId) || 'nofiscal-' + uuid();
    var p = { event: nome, event_id: eventId };
    for (var k in dados) if (Object.prototype.hasOwnProperty.call(dados, k) && dados[k] !== undefined && dados[k] !== null) p[k] = dados[k];
    if (meta && meta.esperar && producao()) {
      registrar(eventId, new Promise(function (ok) { p.eventCallback = function () { ok(); }; p.eventTimeout = ESPERA_MAX_MS; }));
    }
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(p);
    if (meta && meta.evento && consentido()) {
      fbqQuandoPronto([meta.custom ? 'trackCustom' : 'track', meta.evento, meta.dados || {}, { eventID: eventId }]);
      if (meta.capi) registrar(eventId, enviarCapi(meta.evento, eventId, meta.dados || {}));
    }
    return eventId;
  }
  function valorMeta(valor) { return valor == null ? {} : { value: valor, currency: 'BRL' }; }

  var api = {
    consentido: consentido,
    /** Corpos mandados (ou que seriam mandados, fora de produção) à meta-capi nesta página. */
    capi: [],
    /** Promessa que resolve quando os envios do evento confirmarem ou em 300 ms, o que vier antes; null quando não
        há nada a esperar (aí quem chamou segue na hora). Para o clique que sai da página: CAPI e tags do GTM. */
    aposEnvio: function (eventId) {
      var pendente = envios[eventId];
      delete envios[eventId];
      if (!pendente) return null;
      return new Promise(function (ok) {
        var feito = false;
        function seguir() { if (!feito) { feito = true; ok(); } }
        setTimeout(seguir, ESPERA_MAX_MS);
        pendente.then(seguir, seguir);
      });
    },
    /** O que o checkout manda ao servidor para a CAPI; sem consentimento, só o "denied". */
    paraServidor: function () {
      if (!consentido()) return { consent: 'denied' };
      return { consent: 'granted', fbp: cookie('_fbp') || undefined, fbc: fbc() || undefined, page_url: location.href };
    },
    /** `angulo`: a variante do hero que o anúncio de remarketing pediu (?angulo=), para comparar por ângulo. */
    verPagina: function (angulo) {
      return disparar('nofiscal_view_content', { pagina: location.pathname, angulo: angulo || undefined },
        { evento: 'ViewContent', dados: angulo ? { content_category: 'nofiscal', content_name: 'nó.fiscal LP ' + angulo } : {} });
    },
    /** Simulação concluída no simulador da LP (Lucca, 13/11/2026): o público mais quente do remarketing, quem viu a
        nota sair e não assinou. Evento próprio no Pixel (SimulacaoNota), sem CAPI: é sinal de público, não conversão. */
    simulacao: function (simulacoes, limite) {
      return disparar('nofiscal_simulacao', { simulacoes: simulacoes, limite: limite ? true : undefined },
        { evento: 'SimulacaoNota', custom: true, dados: { simulacoes: simulacoes } });
    },
    planoEscolhido: function (plano, origem, ciclo) {
      var anual = ciclo === 'anual';
      var valor = precoDe(plano, ciclo);
      var dados = valorMeta(valor);
      dados.content_name = 'nó.fiscal ' + (NOMES[plano] || plano);
      dados.content_ids = ['nofiscal-' + plano + '-' + (anual ? 'anual' : 'mensal')];
      dados.content_type = 'product';
      return disparar('nofiscal_plano_escolhido',
        { plano: plano, valor: valor, moeda: 'BRL', origem: origem, ciclo: anual ? 'anual' : undefined },
        { evento: 'AddToCart', dados: dados, capi: true, esperar: true });
    },
    /** Escritório e Agência (sob medida) não têm cadastro: o clique no WhatsApp comercial é o Lead. */
    lead: function (plano, canal) {
      return disparar('nofiscal_lead', { plano: plano, canal: canal || 'whatsapp' }, {
        evento: 'Lead', eventId: 'nofiscal-lead-' + uuid(), capi: true, esperar: true,
        dados: { content_name: 'nó.fiscal ' + (NOMES[plano] || plano), content_category: 'nofiscal' }
      });
    },
    cadastroIniciado: function (plano) {
      if (!primeiraVez('cadastro_inicio')) return null;
      return disparar('nofiscal_cadastro_inicio', { plano: plano });
    },
    /** Resposta da etapa 1 (sim | nao | procuracao; até 13/11/2026 também contador | nao_sei) com o regime do CNPJ (mei | simples). Vai também à fila do
        painel de percurso (telemetria.js), que só aceita nomes form_*, e sai do navegador só com a medição permitida. */
    a1: function (resposta, regime, plano) {
      if (!resposta || !primeiraVez('a1.' + resposta)) return null;
      var dados = { a1: resposta, regime: regime || undefined, plano: plano };
      if (typeof window.trackFila === 'function') window.trackFila('form_nofiscal_a1', dados);
      return disparar('nofiscal_a1', dados);
    },
    cadastroConcluido: function (plano) {
      if (!primeiraVez('cadastro')) return null;
      return disparar('nofiscal_cadastro', { plano: plano, metodo: 'email' }, { evento: 'CompleteRegistration', dados: {} });
    },
    checkoutIniciado: function (plano, valor, cupom, ciclo) {
      var anual = ciclo === 'anual';
      if (!primeiraVez('checkout.' + plano + (anual ? '.anual' : '') + '.' + (cupom || ''))) return null;
      return disparar('nofiscal_checkout', { plano: plano, valor: valor, moeda: 'BRL', cupom: cupom || undefined, ciclo: anual ? 'anual' : undefined },
        { evento: 'InitiateCheckout', dados: valorMeta(valor) });
    },
    pagamentoInfo: function (plano, valor) {
      return disparar('nofiscal_pagamento_info', { plano: plano, valor: valor, moeda: 'BRL', metodo: 'cartao' },
        { evento: 'AddPaymentInfo', dados: valorMeta(valor) });
    },
    /** `m` = `medicao` da resposta do checkout: {evento, event_id, transaction_id, valor, moeda}. */
    compra: function (m, plano, cupom) {
      if (!m || !m.event_id || !primeiraVez('compra.' + m.event_id, true)) return null;
      var trial = m.evento === 'StartTrial';
      var dados = valorMeta(m.valor);
      if (trial) dados.predicted_ltv = m.valor;
      return disparar(trial ? 'nofiscal_teste_iniciado' : 'nofiscal_compra',
        { transaction_id: m.transaction_id, valor: m.valor, moeda: m.moeda || 'BRL', plano: plano, cupom: cupom || undefined },
        { evento: m.evento, dados: dados, eventId: m.event_id });
    },
    cortesia: function (plano, cupom) {
      if (!primeiraVez('cortesia')) return null;
      return disparar('nofiscal_cortesia', { plano: plano, cupom: cupom });
    },
    pagamentoRecusado: function (plano) { return disparar('nofiscal_pagamento_recusado', { plano: plano }); },
    ativacaoWhatsapp: function () { return disparar('nofiscal_ativacao_whatsapp', {}); }
  };
  window.noFiscalMedicao = api;

  /* Aviso de cookies das páginas sem o fiscal.js (o cadastro): marcado com data-medicao-consent. A LP mantém o dela
     em fiscal.js, com a mesma chave. Padrão recusado; só a escolha "granted" salva libera a medição. */
  function iniciarAviso() {
    if (typeof document.querySelector !== 'function') return;
    var aviso = document.querySelector('[data-medicao-consent]');
    if (!aviso) return;
    var permitir = aviso.querySelector('[data-consent="granted"]');
    var recusar = aviso.querySelector('[data-consent="denied"]');
    function aplicar(valor, salvar) {
      var granted = valor === 'granted', modo = granted ? 'granted' : 'denied';
      if (salvar) { try { localStorage.setItem(CONSENT_KEY, valor); } catch (e) { /* sem storage */ } }
      window.dataLayer = window.dataLayer || [];
      if (typeof window.gtag !== 'function') window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('consent', 'update', { ad_storage: modo, ad_user_data: modo, ad_personalization: modo, analytics_storage: modo });
      if (typeof window.fbq === 'function') window.fbq('consent', granted ? 'grant' : 'revoke');
      if (granted && typeof window.noTelemetriaLiberar === 'function') window.noTelemetriaLiberar();
    }
    var salvo = null; try { salvo = localStorage.getItem(CONSENT_KEY); } catch (e) { salvo = null; }
    aplicar(salvo === 'granted' ? 'granted' : 'denied', false);
    if (!salvo) aviso.hidden = false;
    function escolher(v) {
      aplicar(v, true);
      window.dataLayer.push({ event: 'consentimento_atualizado', consentimento_medicao: v });
      aviso.hidden = true;
    }
    if (permitir) permitir.addEventListener('click', function () { escolher('granted'); });
    if (recusar) recusar.addEventListener('click', function () { escolher('denied'); });
  }
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') document.addEventListener('DOMContentLoaded', iniciarAviso);
  else iniciarAviso();
})();
