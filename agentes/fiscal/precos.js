/* nó.fiscal: tabela de preços dos planos, a mesma para a LP (fiscal.js) e o cadastro (comecar.js).
   Modelo por volume (Lucca, 23/11/2026): o Escritório vende documentos por mês, com empresas ilimitadas, e o cliente
   marca o que emite. O primeiro tipo de nota (NFS-e ou NF-e) vem no preço do plano; o outro tipo e o Guias são módulos:
   +R$ 197 cada, os dois juntos +R$ 297. Inicial e Pro emitem só NFS-e (a NF-e só existe no painel do Escritório).
   Como o servidor cobra (supabase/functions/assinatura-fiscal/core.ts):
   - o segundo tipo de nota entra no próprio plano da assinatura; no anual, leva o desconto da faixa junto;
   - o Guias é uma segunda assinatura, sempre mensal (assinatura-fiscal-guias): no anual ele fica fora do total do ano e
     aparece à parte, por mês;
   - o cupom de fundador (Black Friday) vale só no preço do plano, no mensal.
   Códigos: os mesmos do servidor. As faixas de 500, 2.000 e 5.000 documentos guardam os códigos de quando a faixa era
   por empresas (escritorio_5/20/50); as de 1.000 e 10.000 nasceram com o volume no código. Os apelidos
   (escritorio_500/2000/5000) só existem para links: sempre viram o código do servidor. */
(function () {
  'use strict';
  var FAIXAS = {
    escritorio_5: { notas: 500, centavos: 29700, off: 25, fundador: 24700, cupom: 'FUNDADOR5' },
    escritorio_1000: { notas: 1000, centavos: 49700, off: 25, fundador: 39700, cupom: 'FUNDADOR1000' },
    escritorio_20: { notas: 2000, centavos: 79700, off: 30, fundador: 64700, cupom: 'FUNDADOR20' },
    escritorio_50: { notas: 5000, centavos: 149700, off: 45, fundador: 119700, cupom: 'FUNDADOR50' },
    escritorio_10000: { notas: 10000, centavos: 249700, off: 45, fundador: 199700, cupom: 'FUNDADOR10000' }
  };
  var ORDEM = ['escritorio_5', 'escritorio_1000', 'escritorio_20', 'escritorio_50', 'escritorio_10000'];
  var APELIDOS = { escritorio_500: 'escritorio_5', escritorio_2000: 'escritorio_20', escritorio_5000: 'escritorio_50' };
  var INDIVIDUAIS = {
    inicial: { nome: 'Inicial', notas: 20, centavos: 4900, off: 20 },
    pro: { nome: 'Pro', notas: 100, centavos: 12900, off: 20 }
  };
  var MODULO = 19700;         // o segundo tipo de nota ou o Guias
  var MODULOS_JUNTOS = 29700; // os dois módulos juntos (R$ 97 a menos, descontados no Guias)
  var NOMES = { nfse: 'NFS-e', nfe: 'NF-e', guias: 'Guias' };

  /** Código do servidor da faixa (aceita os apelidos dos links), ou null fora do Escritório. */
  function faixa(codigo) {
    var c = APELIDOS[codigo] || codigo;
    return Object.prototype.hasOwnProperty.call(FAIXAS, c) ? c : null;
  }
  function ehEscritorio(codigo) { return !!faixa(codigo); }

  /** Normaliza a escolha: pelo menos um tipo de nota; NF-e e Guias só no Escritório. */
  function escolha(codigo, notas, guias) {
    if (!ehEscritorio(codigo)) return { notas: ['nfse'], guias: false };
    var n = ['nfse', 'nfe'].filter(function (t) { return (notas || []).indexOf(t) >= 0; });
    if (!n.length) n = ['nfse'];
    return { notas: n, guias: !!guias };
  }

  /**
   * Preço de um plano com a escolha de módulos.
   * mensal: o que sai por mês no ciclo mensal (plano + módulos − desconto dos dois juntos), sem cupom.
   * total: o que a assinatura principal cobra por ciclo. No mensal é `mensal`; no anual é o ano do plano com o segundo
   *   tipo de nota e o desconto da faixa, SEM o Guias.
   * guiasAParte: no anual, o Guias por mês, cobrado em outra assinatura (0 no mensal ou sem Guias).
   */
  function calcular(codigo, opcoes) {
    opcoes = opcoes || {};
    var esc = faixa(codigo);
    var p = esc ? FAIXAS[esc] : INDIVIDUAIS[codigo] || INDIVIDUAIS.inicial;
    var e = escolha(codigo, opcoes.notas, opcoes.guias);
    var anual = opcoes.ciclo === 'anual';
    var usarFundador = !!(esc && opcoes.fundador && !anual && p.fundador);
    var base = usarFundador ? p.fundador : p.centavos;
    var duasNotas = e.notas.length === 2;
    var juntos = duasNotas && e.guias;
    var guias = e.guias ? MODULO - (juntos ? 2 * MODULO - MODULOS_JUNTOS : 0) : 0; // R$ 197, ou R$ 100 com a NF-e
    var modulos = [];
    if (duasNotas) modulos.push({ tipo: 'nfe', nome: NOMES.nfe, centavos: MODULO });
    if (e.guias) modulos.push({ tipo: 'guias', nome: NOMES.guias, centavos: MODULO });
    var economia = juntos ? 2 * MODULO - MODULOS_JUNTOS : 0;
    var mensal = base + (duasNotas ? MODULO : 0) + guias;
    var planoComNota = p.centavos + (duasNotas ? MODULO : 0);
    var total = anual ? Math.round(planoComNota * 12 * (100 - p.off) / 100) : mensal;
    return {
      faixa: esc, notasMes: p.notas, base: base, cheio: p.centavos, modulos: modulos, economia: economia,
      mensal: mensal, total: total, off: p.off, porMesNoAnual: anual ? Math.round(total / 12) : null,
      planoComNota: planoComNota, guiasAParte: anual ? guias : 0,
      fundador: usarFundador, cupom: usarFundador ? p.cupom : null, incluida: e.notas[0], escolha: e
    };
  }

  function reais(centavos) {
    var n = Number(centavos) / 100;
    var t = n % 1 === 0 ? String(n) : n.toFixed(2).replace('.', ',');
    return 'R$ ' + t.replace(/^\d+/, function (i) { return i.replace(/\B(?=(\d{3})+$)/g, '.'); });
  }
  function milhar(n) { return String(n).replace(/\B(?=(\d{3})+$)/g, '.'); }

  window.noFiscalPrecos = {
    FAIXAS: FAIXAS, ORDEM: ORDEM, APELIDOS: APELIDOS, INDIVIDUAIS: INDIVIDUAIS, NOMES: NOMES,
    MODULO: MODULO, MODULOS_JUNTOS: MODULOS_JUNTOS,
    faixa: faixa, ehEscritorio: ehEscritorio, escolha: escolha, calcular: calcular, reais: reais, milhar: milhar
  };
})();
