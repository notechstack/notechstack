/* Medição do checkout da assinatura do Auditor (CONTRATO.md, "Medição do checkout").
   Só com consentimento no_auditor_consent = granted (mesmo padrão do auditor.js).
   Sem consentimento (recusado ou sem escolha): retorna null, 0 push no dataLayer, 0 fbq.
   event_id = 'assin_' + uuid, um novo por evento; o mesmo id vai ao dataLayer e ao fbq (eventID). */
(function () {
  'use strict';

  var CONSENT_KEY = 'no_auditor_consent';
  var VALORES = { mensal: 47, semanal: 97, agencia: 197 }; // reais

  function consentido() {
    try { return localStorage.getItem(CONSENT_KEY) === 'granted'; } catch (e) { return false; }
  }

  function uuid() {
    var c = window.crypto || globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // versão 4
    b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
    var h = [];
    for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' +
      h.slice(8, 10).join('') + '-' + h.slice(10, 16).join('');
  }

  function disparar(tipo, plano) {
    if (typeof plano !== 'string' || !Object.prototype.hasOwnProperty.call(VALORES, plano)) return null;
    if (!consentido()) return null;
    var valor = VALORES[plano];
    var eventId = 'assin_' + uuid();
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: tipo === 'iniciada' ? 'assinatura_iniciada' : 'assinatura_concluida',
      event_id: eventId,
      plano: plano,
      valor: valor,
      moeda: 'BRL'
    });
    if (typeof window.fbq === 'function') {
      if (tipo === 'iniciada') {
        window.fbq('track', 'InitiateCheckout', { value: valor, currency: 'BRL', content_name: plano }, { eventID: eventId });
      } else {
        window.fbq('track', 'Subscribe', { value: valor, currency: 'BRL', predicted_ltv: valor }, { eventID: eventId });
      }
    }
    return eventId;
  }

  window.noAssinaturaMedicao = {
    iniciada: function (plano) { return disparar('iniciada', plano); },
    concluida: function (plano) { return disparar('concluida', plano); }
  };
})();
