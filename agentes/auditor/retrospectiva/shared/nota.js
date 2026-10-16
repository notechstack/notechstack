/* nó.agentes · nota da capa (#t05) calculada a partir das checagens do protótipo.
   Regra: média simples das checagens verificáveis (ok = 1, atenção = 0,5, problema/falha = 0) × 10,
   arredondada a até 2 casas. "Não verificável" (nv) fica fora da conta; leituras de número não entram. */
(function (raiz) {
  'use strict';

  function calculaNota(estados) {
    var c = { nota: null, ok: 0, atencao: 0, falha: 0, nv: 0, verificaveis: 0 };
    (estados || []).forEach(function (e) {
      if (e === 'ok') c.ok++;
      else if (e === 'atencao') c.atencao++;
      else if (e === 'problema' || e === 'falha') c.falha++;
      else if (e === 'nv') c.nv++;
    });
    c.verificaveis = c.ok + c.atencao + c.falha;
    if (c.verificaveis > 0) {
      /* em meios pontos para evitar ruído de ponto flutuante: (2·ok + atenção) / (2·verificáveis) × 10 */
      c.nota = Math.round((2 * c.ok + c.atencao) * 500 / c.verificaveis) / 100;
    }
    return c;
  }

  var POS = { 'estado--ok': 'ok', 'estado--atencao': 'atencao', 'estado--problema': 'problema' };

  /* estado pós-conexão (#t07) substitui o do site quando existir para a mesma checagem */
  function estadoConectado(id) {
    var cartao = document.querySelector('#t07 [data-checagem="' + id + '"]');
    if (!cartao) return null;
    for (var cls in POS) if (cartao.querySelector('.' + cls)) return POS[cls];
    return null;
  }

  function fmt(n) { return String(n).replace('.', ','); }

  function aplica() {
    var capa = document.getElementById('t05');
    if (!capa) return null;
    var estados = Array.prototype.map.call(
      document.querySelectorAll('#t06 .checagem[data-chk]'),
      function (el) { return estadoConectado(el.getAttribute('data-checagem')) || el.getAttribute('data-chk'); }
    );
    var r = calculaNota(estados);

    var span = capa.querySelector('.nota__num > span');
    var caixa = capa.querySelector('.nota');
    var h1 = capa.querySelector('h1');
    var trilho = capa.querySelector('.nota__trilho i');
    if (r.nota === null) {
      /* nada verificável: sem nota (tira data-nota para o telas-r5.js não animar) */
      if (span) { span.removeAttribute('data-nota'); span.textContent = '–'; }
      if (caixa) caixa.setAttribute('aria-label', 'Sem nota: nenhuma checagem verificável');
      if (h1) h1.textContent = 'Ainda não dá para dar nota.';
      if (trilho) trilho.style.setProperty('--p', '0');
    } else {
      var txt = fmt(r.nota);
      if (span) { span.setAttribute('data-nota', String(r.nota)); span.textContent = txt; }
      if (caixa) caixa.setAttribute('aria-label', 'Nota ' + txt + ' de 10');
      if (h1) h1.textContent = 'Sua implementação tirou ' + txt + '.';
      if (trilho) trilho.style.setProperty('--p', String(Math.round(r.nota * 100) / 10));
    }
    var valores = capa.querySelectorAll('.resumo--3 .valor');
    [r.ok, r.atencao, r.falha].forEach(function (n, k) { if (valores[k]) valores[k].textContent = String(n); });
    return r;
  }

  var api = { calculaNota: calculaNota, aplica: aplica };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (raiz) raiz.NotaNo = api;

  if (typeof document !== 'undefined') {
    /* carregado no fim do body: #t05/#t06 já existem, então aplica já, antes do primeiro mostrar() */
    if (document.readyState !== 'loading' || (document.getElementById('t05') && document.getElementById('t06'))) aplica();
    else document.addEventListener('DOMContentLoaded', aplica);
  }
})(typeof window !== 'undefined' ? window : null);
