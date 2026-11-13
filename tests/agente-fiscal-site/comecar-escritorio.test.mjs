// Modo escritório de /agentes/fiscal/comecar/ (?tipo=escritorio): etapa 1 do escritório, faixas, cupom de fundador
// com 30 dias de teste, retomada pela conta e pela aba, e o Pro sem mudança.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abrir, superficie, sessaoValida, estado, preencherEtapa1, preencherCartao, CODIGO_CERTO, ACEITE, TENANT
} from './pagina-falsa.mjs';

const CHECKOUT = {
  ok: true, venda_aberta: true, anual_disponivel: true, escritorio_disponivel: true, public_key: 'pk_test_abc', aceite_texto: ACEITE,
  planos: {
    inicial: { valor_centavos: 4900, anual_centavos: 47040 }, pro: { valor_centavos: 12900, anual_centavos: 123840 },
    escritorio_5: { valor_centavos: 29700, empresas: 5, notas: 500 },
    escritorio_20: { valor_centavos: 79700, empresas: 20, notas: 2000 },
    escritorio_50: { valor_centavos: 149700, empresas: 50, notas: 5000 }
  }
};
const FUNDADOR5 = {
  codigo: 'FUNDADOR5', descricao: 'Fundador: 1º mês grátis e R$ 247/mês no 1º ano', tipo: 'valor', valor: 5000, cortesia: false,
  ciclos: 12, valor_centavos: 29700, valor_centavos_com_desconto: 24700, dias_de_teste: 30
};

test('escritório: etapa 1, faixa, cupom de fundador e checkout mensal', async () => {
  const rede = superficie({
    'GET assinatura-fiscal': () => ({ status: 200, corpo: CHECKOUT }),
    // O dublê da página manda todo POST de assinatura-fiscal para a mesma rota; a prévia vem com acao.
    'POST assinatura-fiscal': (c) => (c.acao === 'validar_cupom'
      ? (c.plano === 'escritorio_5'
        ? { status: 200, corpo: { ok: true, cupom: FUNDADOR5 } }
        : { status: 422, corpo: { ok: false, error_code: 'CUPOM_PLANO', mensagem: 'Este cupom não vale para o plano escolhido.' } })
      : { status: 200, corpo: { ok: true, status: 'pendente', assinatura_id: 'a-1', com_teste: true, dias_de_teste: 30, medicao: { evento: 'StartTrial', event_id: 'nofiscal-trial-a-1', transaction_id: 'a-1', valor: 247, moeda: 'BRL' } } }),
    'fiscal-conta:estado': () => ({ status: 200, corpo: estado({ plano: 'escritorio_20', onboarding_etapa: 'pagamento' }) })
  });
  // Até 13/11/2026 o `ciclo=anual` da URL era ignorado no Escritório; agora vale (anual com 25%, 30% e 45% OFF), então
  // este teste do mensal abre sem ele.
  const p = await abrir('/agentes/fiscal/comecar/?tipo=escritorio&plano=escritorio_20', { rede });
  assert.equal(p.etapa(), 1);
  assert.equal(p.texto('fc-plano'), 'Plano Escritório até 20 empresas · R$ 797/mês · 7 dias grátis');
  assert.equal(p.texto('fc-titulo-1'), 'Dados do escritório');
  assert.equal(p.passo(), '1 de 7 · Seu escritório');
  const rotulos = p.rotulos('fc-etapa-1');
  for (const r of ['CNPJ do escritório', 'Nome do escritório', 'Responsável', 'E-mail', 'WhatsApp de quem vai mandar as planilhas']) assert.ok(rotulos.includes(r), r);
  assert.equal(p.window.sessionStorage.getItem('nofiscal.tipo'), 'escritorio');
  assert.equal(p.window.localStorage.getItem('nofiscal.ciclo'), null, 'ciclo da URL ignorado no escritório');

  await preencherEtapa1(p);
  p.document.querySelector('input[name="fc-a1"][value="sim"]').checked = true;
  await p.enviar('fc-form-1');
  assert.equal(p.etapa(), 2, p.textoVisivel().slice(0, 400));
  await p.preencher('fc-codigo', CODIGO_CERTO);
  await p.enviar('fc-form-2');
  const [criar] = rede.de('fiscal-cadastro:criar');
  assert.equal(criar.corpo.tipo, 'escritorio');
  assert.equal(criar.corpo.plano, 'escritorio_20');
  assert.equal(p.etapa(), 3);
  assert.ok(p.visivel('fc-faixas'));
  assert.ok(!p.visivel('fc-texto-anual'));
  assert.equal(p.document.querySelector('input[name="fc-faixa"]:checked').value, 'escritorio_20');
  assert.equal(p.texto('fc-plano-pagamento'), 'Plano Escritório até 20 empresas · R$ 797/mês · 7 dias grátis');

  // Cupom de fundador na faixa errada: recusado; trocando para a faixa de 5, vale.
  await p.clicar('fc-cupom-abrir');
  await p.preencher('fc-cupom-codigo', 'fundador5');
  await p.clicar('fc-cupom-aplicar');
  assert.match(p.texto('fc-cupom-codigo-erro'), /não vale para o plano/);
  const cinco = p.document.querySelector('input[name="fc-faixa"][value="escritorio_5"]');
  cinco.checked = true;
  cinco.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.esvaziar(60);
  // A troca reaplica o cupom digitado só quando já havia um aplicado; aqui aplica de novo.
  await p.clicar('fc-cupom-aplicar');
  assert.equal(p.texto('fc-cupom-resumo'), 'Cupom FUNDADOR5 aplicado: 1º mês grátis, depois R$ 247/mês no 1º ano.');
  assert.equal(p.texto('fc-plano-pagamento'), 'Plano Escritório até 5 empresas · 1º mês grátis, depois R$ 247/mês no 1º ano com o cupom FUNDADOR5');
  assert.equal(p.texto('fc-pagar'), 'Começar 30 dias grátis');
  assert.match(p.texto('fc-texto-cobranca'), /depois dos 30 dias/);
  const validacoes = rede.de('POST assinatura-fiscal').filter((v) => v.corpo.acao === 'validar_cupom');
  assert.deepEqual(validacoes.map((v) => [v.corpo.plano, v.corpo.ciclo]), [['escritorio_20', 'mensal'], ['escritorio_5', 'mensal']]);

  // Trocar de faixa com o cupom aplicado reaplica (e o servidor recusa na outra faixa).
  const cinquenta = p.document.querySelector('input[name="fc-faixa"][value="escritorio_50"]');
  cinquenta.checked = true;
  cinquenta.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.esvaziar(60);
  assert.equal(rede.de('POST assinatura-fiscal').filter((v) => v.corpo.acao === 'validar_cupom').at(-1).corpo.plano, 'escritorio_50');
  assert.match(p.texto('fc-cupom-codigo-erro'), /não vale para o plano/);
  assert.equal(p.texto('fc-pagar'), 'Começar 7 dias grátis');
  cinco.checked = true;
  cinco.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.esvaziar(60);
  await p.clicar('fc-cupom-aplicar');
  assert.equal(p.texto('fc-pagar'), 'Começar 30 dias grátis');

  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  const [pedido] = rede.de('POST assinatura-fiscal').filter((v) => v.corpo.acao === undefined);
  assert.equal(pedido.corpo.plano, 'escritorio_5');
  assert.equal(pedido.corpo.ciclo, 'mensal');
  assert.equal(pedido.corpo.cupom, 'FUNDADOR5');
  assert.equal(p.etapa(), 4);
});

test('escritório: retomada pelo plano da conta, pela aba, e Inicial/Pro sem mudança', async () => {
  const conta = superficie({ 'fiscal-conta:estado': () => ({ status: 200, corpo: estado({ plano: 'escritorio_50', onboarding_etapa: 'ativacao' }) }) });
  const r = await abrir('/agentes/fiscal/comecar/', { rede: conta, local: { 'nofiscal.sessao': sessaoValida() } });
  assert.equal(r.etapa(), 7);
  assert.equal(r.texto('fc-plano'), 'Plano Escritório até 50 empresas · R$ 1.497/mês · 7 dias grátis');
  assert.ok(r.visivel('fc-escritorio-depois'));
  const minhaConta = [...r.document.querySelectorAll('#fc-etapa-7 a')].find((a) => a.textContent.trim() === 'Minha conta');
  assert.equal(minhaConta.getAttribute('href'), '/agentes/fiscal/conta/#empresas', 'escritório abre direto em Minhas empresas');
  assert.equal(r.window.sessionStorage.getItem('nofiscal.tipo'), 'escritorio');

  const aba = await abrir('/agentes/fiscal/comecar/', { aba: { 'nofiscal.tipo': 'escritorio', 'nofiscal.faixa': 'escritorio_20' } });
  assert.equal(aba.texto('fc-titulo-1'), 'Dados do escritório');
  assert.equal(aba.texto('fc-plano'), 'Plano Escritório até 20 empresas · R$ 797/mês · 7 dias grátis');

  const pro = await abrir('/agentes/fiscal/comecar/?plano=pro', { aba: { 'nofiscal.tipo': 'escritorio' } });
  assert.equal(pro.texto('fc-titulo-1'), 'Os dados da sua empresa');
  assert.equal(pro.passo(), '1 de 7 · Sua empresa');
  assert.equal(pro.texto('fc-plano'), 'Plano Pro · R$ 129/mês · 7 dias grátis');
  assert.ok(!pro.visivel('fc-faixas'));
  assert.equal(pro.window.sessionStorage.getItem('nofiscal.tipo'), null);

  // Conta Pro aberta numa aba que tinha o modo escritório: o plano da conta desliga o modo.
  const contaPro = superficie({ 'fiscal-conta:estado': () => ({ status: 200, corpo: estado({ plano: 'pro', onboarding_etapa: 'pagamento' }) }) });
  const volta = await abrir('/agentes/fiscal/comecar/', { rede: contaPro, local: { 'nofiscal.sessao': sessaoValida() }, aba: { 'nofiscal.tipo': 'escritorio' } });
  assert.equal(volta.texto('fc-plano'), 'Plano Pro · R$ 129/mês · 7 dias grátis');
  assert.ok(!volta.visivel('fc-faixas'));
  assert.equal(volta.texto('fc-titulo-1'), 'Os dados da sua empresa');
});

test('escritório indisponível no servidor: avisa e não deixa pagar', async () => {
  const rede = superficie({
    'GET assinatura-fiscal': () => ({ status: 200, corpo: { ...CHECKOUT, escritorio_disponivel: false } }),
    'fiscal-conta:estado': () => ({ status: 200, corpo: estado({ plano: 'escritorio_5', onboarding_etapa: 'pagamento' }) })
  });
  const p = await abrir('/agentes/fiscal/comecar/', { rede, local: { 'nofiscal.sessao': sessaoValida() } });
  assert.equal(p.etapa(), 3);
  assert.match(p.texto('fc-aviso-3'), /Escritório ainda não está disponível/);
  assert.equal(p.$('fc-pagar').disabled, true);
});
