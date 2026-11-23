/* nó.fiscal: tabela de preços dos planos, a mesma para a LP (fiscal.js) e o cadastro (comecar.js).
   Modelo por volume (Lucca, 23/11/2026): o plano vende documentos por mês, com empresas ilimitadas no Escritório, e o
   cliente marca o que emite. O primeiro tipo de nota (NFS-e ou NF-e) vem no preço do plano; o outro tipo e o Guias são
   módulos do Escritório: +R$ 197 cada, os dois juntos +R$ 297. Inicial e Pro emitem só NFS-e: a NF-e hoje só
   existe no painel do Escritório (o cálculo aceita o segundo tipo por +R$ 49, mas as páginas não o oferecem).
   O anual aplica o desconto da faixa sobre o total, módulos incluídos. O cupom de fundador (Black Friday) vale só no
   preço do plano, no mensal. ESTADO: prévia de localhost; assinatura-fiscal/core.ts ainda tem as faixas antigas
   (escritorio_5/20/50), que aqui viram apelidos de 500, 2.000 e 5.000. */
(function () {
  'use strict';
  var FAIXAS = {
    escritorio_500: { notas: 500, centavos: 29700, off: 25, fundador: 24700, cupom: 'FUNDADOR5' },
    escritorio_1000: { notas: 1000, centavos: 49700, off: 25, fundador: 39700, cupom: 'FUNDADOR1000' },
    escritorio_2000: { notas: 2000, centavos: 79700, off: 30, fundador: 64700, cupom: 'FUNDADOR20' },
    escritorio_5000: { notas: 5000, centavos: 149700, off: 45, fundador: 119700, cupom: 'FUNDADOR50' },
    escritorio_10000: { notas: 10000, centavos: 249700, off: 45, fundador: 199700, cupom: 'FUNDADOR10000' }
  };
  var ORDEM = ['escritorio_500', 'escritorio_1000', 'escritorio_2000', 'escritorio_5000', 'escritorio_10000'];
  /* Códigos das faixas por empresa (aposentadas): links antigos e contas que já assinaram caem na faixa de volume. */
  var APELIDOS = { escritorio_5: 'escritorio_500', escritorio_20: 'escritorio_2000', escritorio_50: 'escritorio_5000' };
  var INDIVIDUAIS = {
    inicial: { nome: 'Inicial', notas: 20, centavos: 4900, off: 20 },
    pro: { nome: 'Pro', notas: 100, centavos: 12900, off: 20 }
  };
  var MODULO = 19700;        // Escritório: o segundo tipo de nota ou o Guias
  var MODULOS_JUNTOS = 29700; // Escritório: os dois módulos juntos (economia de R$ 97)
  var SEGUNDA_NOTA_INDIVIDUAL = 4900;
  var NOMES = { nfse: 'NFS-e', nfe: 'NF-e', guias: 'Guias' };

  function faixa(codigo) { return FAIXAS[APELIDOS[codigo] || codigo] ? (APELIDOS[codigo] || codigo) : null; }
  function ehEscritorio(codigo) { return !!faixa(codigo); }

  /** Normaliza a escolha: pelo menos um tipo de nota; Guias só no Escritório. */
  function escolha(codigo, notas, guias) {
    var n = (notas || []).filter(function (t) { return t === 'nfse' || t === 'nfe'; });
    if (!n.length) n = ['nfse'];
    if (n.length === 2 && n[0] === 'nfe') n = ['nfse', 'nfe'];
    return { notas: n, guias: !!guias && ehEscritorio(codigo) };
  }

  /**
   * Preço de um plano com a escolha de módulos.
   * @returns {{ base, modulos: [{tipo, nome, centavos}], economia, mensal, total, off, porMesNoAnual, fundador }}
   *   mensal = soma do mês sem desconto do anual; total = o que cobra por ciclo (mês, ou o ano inteiro no anual).
   */
  function calcular(codigo, opcoes) {
    opcoes = opcoes || {};
    var esc = faixa(codigo);
    var p = esc ? FAIXAS[esc] : INDIVIDUAIS[codigo] || INDIVIDUAIS.inicial;
    var e = escolha(codigo, opcoes.notas, opcoes.guias);
    var anual = opcoes.ciclo === 'anual';
    var usarFundador = !!(esc && opcoes.fundador && !anual && p.fundador);
    var base = usarFundador ? p.fundador : p.centavos;
    var modulos = [];
    if (e.notas.length === 2) modulos.push({ tipo: 'nfe', nome: NOMES.nfe, centavos: esc ? MODULO : SEGUNDA_NOTA_INDIVIDUAL });
    if (e.guias) modulos.push({ tipo: 'guias', nome: NOMES.guias, centavos: MODULO });
    var somaModulos = modulos.reduce(function (s, m) { return s + m.centavos; }, 0);
    var economia = 0;
    if (esc && modulos.length === 2) { economia = somaModulos - MODULOS_JUNTOS; somaModulos = MODULOS_JUNTOS; }
    var mensal = base + somaModulos;
    var total = anual ? Math.round(mensal * 12 * (100 - p.off) / 100) : mensal;
    return {
      faixa: esc, notasMes: p.notas, base: base, cheio: p.centavos, modulos: modulos, economia: economia,
      mensal: mensal, total: total, off: p.off, porMesNoAnual: anual ? Math.round(total / 12) : null,
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
    MODULO: MODULO, MODULOS_JUNTOS: MODULOS_JUNTOS, SEGUNDA_NOTA_INDIVIDUAL: SEGUNDA_NOTA_INDIVIDUAL,
    faixa: faixa, ehEscritorio: ehEscritorio, escolha: escolha, calcular: calcular, reais: reais, milhar: milhar
  };
})();
