/* Meta Pixel retido até o aceite de cookies (Lucca, 03/11/2026). Carregar SÍNCRONO no <head>, depois do
   marketing-host.js e ANTES do snippet do GTM, numa página que define window.noTelemetriaConsentKey (a chave do
   localStorage onde o aviso de cookies grava 'granted' ou 'denied').

   Por que funciona: a tag base do Pixel no GTM (GTM-NK87FH8W) é o snippet oficial, que só cria o fbq e baixa o
   fbevents.js quando ainda não existe window.fbq. Este arquivo cria antes a mesma fila do snippet oficial (sem
   baixar nada), então o init e o PageView do GTM ficam presos nela. Sem 'granted' salvo, 'revoke' vai na frente da
   fila. O fbevents.js só é baixado com a medição permitida: na hora, se já estava salva, ou quando o aviso chama
   fbq('consent','grant'); e só no domínio de produção (marketing-host.js). Ao carregar, o fbevents.js processa a fila
   na ordem (revoke, init, PageView, grant), e o 'grant' libera o que ficou retido.
   Sem chave de consentimento na página, não faz nada: o GTM segue com o snippet dele. */
(function (w, d) {
  var chave = w.noTelemetriaConsentKey;
  if (!chave || w.fbq) return;
  var permitido = false, baixou = false;
  try { permitido = w.localStorage.getItem(chave) === 'granted'; } catch (e) { permitido = false; }
  function producao() {
    return typeof w.noMarketingHostAllowed === 'function' && w.noMarketingHostAllowed(w.location.hostname);
  }
  function baixar() {
    if (baixou || !producao()) return;
    baixou = true;
    var s = d.createElement('script');
    var f = d.getElementsByTagName('script')[0];
    s.async = true;
    s.src = 'https://connect.facebook.net/en_US/fbevents.js';
    if (f && f.parentNode) f.parentNode.insertBefore(s, f);
    else (d.head || d.documentElement).appendChild(s);
  }
  // Mesma forma da fila do snippet oficial (callMethod/queue/push/loaded/version), mais o gatilho do 'grant'.
  var n = w.fbq = function () {
    if (arguments[0] === 'consent' && arguments[1] === 'grant') baixar();
    if (n.callMethod) n.callMethod.apply(n, arguments); else n.queue.push(arguments);
  };
  if (!w._fbq) w._fbq = n;
  n.push = n;
  n.loaded = true;
  n.version = '2.0';
  n.queue = [];
  if (permitido) baixar();
  else n('consent', 'revoke');
})(window, document);
