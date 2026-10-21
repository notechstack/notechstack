/* nó.agentes · Auditor · tela final "Receber no celular" (#t13), no lugar dos planos (Lucca, 21/10).
   Monta os links do WhatsApp da nó com mensagem pronta. Se houver diagnóstico real na sessão
   (sessionStorage["no_auditor_diagnostico"], contrato v1), a mensagem leva o endereço do site auditado.
   ES5, sem dependência. Os cliques entram no dataLayer, se existir. */
(function () {
  'use strict';
  var NUMERO = '5511939289413';
  var CHAVE = 'no_auditor_diagnostico';

  function siteDoDiagnostico() {
    try {
      var d = JSON.parse(window.sessionStorage.getItem(CHAVE) || 'null');
      var url = d && d.v === 1 && d.report && (d.report.url_final || d.report.url);
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
      var u = new URL(url);
      return u.hostname.replace(/^www\./, '');
    } catch (e) { return null; }
  }

  function link(texto) {
    return 'https://wa.me/' + NUMERO + '?text=' + encodeURIComponent(texto);
  }

  function montar(doc) {
    var site = siteDoDiagnostico();
    var receber = doc.getElementById('zap-receber');
    if (receber) {
      receber.href = link('Olá! Fiz a retrospectiva do Auditor' + (site ? ' do site ' + site : '') +
        ' e quero receber os relatórios no meu celular.');
    }
    doc.addEventListener('click', function (e) {
      /* só mede; não interfere na navegação das telas */
      var alvo = e.target && e.target.closest && e.target.closest('[data-zap]');
      if (!alvo) return;
      if (window.dataLayer && window.dataLayer.push) {
        window.dataLayer.push({ event: 'auditor_cta_whatsapp', cta: alvo.getAttribute('data-zap'), tem_site: !!site });
      }
    }, true);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { montar(document); });
    else montar(document);
  }
})();
