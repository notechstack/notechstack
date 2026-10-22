// /agentes/fiscal/comecar/ (lote E de .checks/agente-fiscal-v2.md): C1, C2u, C3u, C4, C7u, C8u, C10u–C13u, C15,
// C16u, C17u, C19u, C20u, C24 e C25u. A página roda de verdade no jsdom; a rede é o dublê da Surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abrir, superficie, sessaoValida, estado, preencherEtapa1, ateEtapa3, preencherCartao, abrirNaEtapa,
  TENANT, CNPJ, CPF, CODIGO_CERTO, ACEITE, CARTAO, CANDIDATOS
} from './pagina-falsa.mjs';

const r = (status, corpo) => () => ({ status, corpo });
// Objetos do jsdom vêm de outro realm: compara pelo conteúdo.
const js = (x) => JSON.parse(JSON.stringify(x));
const funcoes = (p) => p.rede.chamadas.filter((c) => c.rota && !c.rota.startsWith('dados:'));

test('etapa 1 e plano', async () => {
  const pro = await abrir('/agentes/fiscal/comecar/?plano=pro');
  assert.equal(pro.etapa(), 1);
  assert.equal(pro.passo(), '1 de 7 · Sua empresa');
  const rotulos = pro.rotulos('fc-etapa-1');
  for (const campo of ['Nome da empresa', 'CNPJ', 'Responsável', 'E-mail', 'WhatsApp']) {
    assert.ok(rotulos.includes(campo), `campo "${campo}" (rótulos: ${rotulos.join(' | ')})`);
  }
  // Lucca, 22/10/2026: o cadastro não pede CPF (não há consulta oficial gratuita e ele só servia ao teste de 7 dias).
  assert.ok(!rotulos.some((r) => /CPF/.test(r)), rotulos.join(' | '));
  assert.equal(pro.texto('fc-plano'), 'Plano Pro · R$ 129/mês · 7 dias grátis');
  assert.ok(pro.visivel('fc-plano'));
  assert.deepEqual(funcoes(pro), [], 'abrir sem sessão não chama nada');

  for (const rota of ['/agentes/fiscal/comecar/', '/agentes/fiscal/comecar/?plano=empresarial', '/agentes/fiscal/comecar/?plano=inicial']) {
    const p = await abrir(rota);
    assert.equal(p.texto('fc-plano'), 'Plano Inicial · R$ 49/mês · 7 dias grátis', rota);
  }
});

test('cnpj preenche a empresa', async () => {
  const p = await abrir('/agentes/fiscal/comecar/?plano=pro');
  await p.preencher('fc-cnpj', '11.222.333/0001-81');
  const consulta = p.rede.de('fiscal-cadastro:consultar_cnpj');
  assert.equal(consulta.length, 1);
  assert.deepEqual(consulta[0].corpo, { acao: 'consultar_cnpj', cnpj: CNPJ });
  assert.equal(p.$('fc-empresa').value, 'CLINICA AURORA LTDA');

  // 503 e CNPJ inativo: sem a Receita confirmar o CNPJ ativo, a página não segue (Lucca, 22/10/2026).
  for (const [status, corpo] of [
    [503, { ok: false, error_code: 'CONSULTA_INDISPONIVEL', mensagem: 'fora do ar' }],
    [422, { ok: false, error_code: 'CNPJ_INATIVO', mensagem: 'Este CNPJ está com situação baixada na Receita Federal.' }],
  ]) {
    const rede = superficie({ 'fiscal-cadastro:consultar_cnpj': r(status, corpo) });
    const q = await abrir('/agentes/fiscal/comecar/', { rede });
    await preencherEtapa1(q, { empresa: 'Minha Empresa Digitada' });
    await q.enviar('fc-form-1');
    assert.equal(rede.de('fiscal-acesso').length, 0, `${corpo.error_code}: não pede código`);
    assert.equal(q.etapa(), 1);
    assert.ok(q.visivel('fc-cnpj-erro'), corpo.error_code);
  }
});

test('município bloqueia', async () => {
  const rede = superficie({ 'fiscal-cadastro:consultar_cnpj': (c) => ({ status: 200, corpo: { ok: true, cnpj: c.cnpj, razao_social: 'EMPRESA FORA LTDA', municipio: 'Cidade Fora', uf: 'MG', codigo_municipio_ibge: '3100000', cnae: '8630503', padrao_nacional: false } }) });
  const p = await abrir('/agentes/fiscal/comecar/', { rede });
  await preencherEtapa1(p);
  assert.match(p.textoVisivel(), /Seu município ainda não emite pelo padrão nacional/);
  await p.enviar('fc-form-1');
  assert.equal(rede.de('fiscal-acesso').length, 0, 'não pede código');
  assert.equal(rede.de('fiscal-cadastro:criar').length, 0);
  assert.equal(p.etapa(), 1);
  assert.match(p.texto('fc-aviso-1'), /Seu município ainda não emite pelo padrão nacional/);
});

test('mei passa fora da lista e fora do simples bloqueia (Lucca, 22/10/2026)', async () => {
  const mei = superficie({ 'fiscal-cadastro:consultar_cnpj': (c) => ({ status: 200, corpo: { ok: true, cnpj: c.cnpj, razao_social: 'MARIA SOUZA 12345678900', municipio: 'SAO BERNARDO DO CAMPO', uf: 'SP', codigo_municipio_ibge: '3548708', cnae: '7319003', regime: 'mei', padrao_nacional: true } }) });
  const p = await abrir('/agentes/fiscal/comecar/', { rede: mei });
  await preencherEtapa1(p);
  assert.equal(p.texto('fc-cnpj-dica'), 'SAO BERNARDO DO CAMPO/SP · CNAE 7319003 · MEI');
  assert.doesNotMatch(p.textoVisivel(), /Seu município ainda não emite/);
  await p.enviar('fc-form-1');
  assert.equal(mei.de('fiscal-acesso').length, 1, 'MEI segue para o código');

  const msg = 'O nó.fiscal atende MEI e empresas do Simples Nacional. Na Receita Federal, este CNPJ não está no Simples';
  const fora = superficie({ 'fiscal-cadastro:consultar_cnpj': r(422, { ok: false, error_code: 'CNPJ_FORA_DO_SIMPLES', mensagem: msg }) });
  const q = await abrir('/agentes/fiscal/comecar/', { rede: fora });
  await preencherEtapa1(q, { empresa: 'Empresa do Lucro Presumido' });
  assert.equal(q.texto('fc-cnpj-erro'), msg);
  await q.enviar('fc-form-1');
  assert.equal(fora.de('fiscal-acesso').length, 0, 'não pede código');
  assert.equal(q.etapa(), 1);
  assert.equal(q.texto('fc-cnpj-erro'), msg);
});

test('etapa 1 incompleta não chama nada', async () => {
  const q = await abrir('/agentes/fiscal/comecar/');
  await q.preencher('fc-responsavel', 'Lucca Teste');
  await q.enviar('fc-form-1');
  assert.ok(q.visivel('fc-cnpj-erro'));
  assert.deepEqual(q.rede.chamadas, []);
  assert.equal(q.etapa(), 1);
});

test('código incorreto', async () => {
  const p = await abrir('/agentes/fiscal/comecar/?plano=pro');
  await preencherEtapa1(p);
  await p.enviar('fc-form-1');
  assert.equal(p.etapa(), 2);
  assert.equal(p.passo(), '2 de 7 · Código');
  assert.equal(p.texto('fc-email-mascarado'), 'lu•••@exemplo.com');
  assert.deepEqual(p.rede.de('fiscal-acesso')[0].corpo, { email: 'lucca@exemplo.com' });

  for (let i = 1; i <= 4; i++) {
    await p.preencher('fc-codigo', '000000');
    await p.enviar('fc-form-2');
    assert.equal(p.texto('fc-codigo-erro'), 'Código incorreto', `tentativa ${i}`);
  }
  await p.preencher('fc-codigo', '000000');
  await p.enviar('fc-form-2');
  assert.equal(p.texto('fc-codigo-erro'), 'Peça um código novo', '5ª tentativa errada');
  assert.equal(p.rede.de('fiscal-cadastro:criar').length, 0, 'nada criado');
  const verificacoes = p.rede.de('fiscal-acesso:verificar');
  assert.equal(verificacoes.length, 5);
  assert.deepEqual(verificacoes[0].corpo, { acao: 'verificar', email: 'lucca@exemplo.com', codigo: '000000' });
  assert.equal(verificacoes[0].headers.authorization, undefined, 'sem sessão');
  // Esgotado: a página não manda mais nada até a pessoa pedir outro código.
  await p.preencher('fc-codigo', CODIGO_CERTO);
  await p.enviar('fc-form-2');
  assert.equal(p.rede.de('fiscal-acesso:verificar').length, 5);
  assert.equal(p.texto('fc-codigo-erro'), 'Peça um código novo');
  // "Pedir um código novo": outro envio, e o código certo passa.
  await p.clicar('fc-reenviar');
  assert.equal(p.rede.de('fiscal-acesso').length, 2);
  await p.preencher('fc-codigo', CODIGO_CERTO);
  await p.enviar('fc-form-2');
  assert.equal(p.etapa(), 3, 'código novo certo cria a empresa e abre o pagamento');

  // Código vencido no servidor → "Peça um código novo".
  const rede = superficie({ 'fiscal-acesso:verificar': r(422, { ok: false, motivo: 'codigo_vencido', error_code: 'CODIGO_VENCIDO', mensagem: 'Peça um código novo' }) });
  const q = await abrir('/agentes/fiscal/comecar/', { rede });
  await preencherEtapa1(q);
  await q.enviar('fc-form-1');
  await q.preencher('fc-codigo', CODIGO_CERTO);
  await q.enviar('fc-form-2');
  assert.equal(q.texto('fc-codigo-erro'), 'Peça um código novo');
  assert.equal(rede.de('fiscal-cadastro:criar').length, 0);

  // Conferência fora do ar (503): não é "código incorreto".
  const fora = superficie({ 'fiscal-acesso:verificar': r(503, { ok: false, motivo: 'indisponivel', error_code: 'INDISPONIVEL', mensagem: 'x' }) });
  const f = await abrir('/agentes/fiscal/comecar/', { rede: fora });
  await preencherEtapa1(f);
  await f.enviar('fc-form-1');
  await f.preencher('fc-codigo', CODIGO_CERTO);
  await f.enviar('fc-form-2');
  assert.match(f.texto('fc-codigo-erro'), /fora do ar/);
  assert.equal(f.etapa(), 2);
});

test('conflitos aparecem', async () => {
  const cnpj = superficie({ 'fiscal-cadastro:criar': r(409, { ok: false, error_code: 'CNPJ_JA_CADASTRADO', mensagem: 'já existe' }) });
  const p = await abrir('/agentes/fiscal/comecar/', { rede: cnpj });
  await ateEtapa3(p);
  assert.equal(p.etapa(), 1);
  assert.equal(p.texto('fc-aviso-1'), 'Este CNPJ já tem conta. Entre pela sua conta');
  const link = p.$('fc-aviso-1').querySelector('a');
  assert.ok(link, 'link para a conta');
  assert.equal(link.getAttribute('href'), '/agentes/fiscal/conta/');
  assert.equal(link.textContent, 'Entre pela sua conta');

  const tel = superficie({ 'fiscal-cadastro:criar': r(409, { ok: false, error_code: 'TELEFONE_DE_OUTRA_EMPRESA', mensagem: 'outro' }) });
  const q = await abrir('/agentes/fiscal/comecar/', { rede: tel });
  await ateEtapa3(q);
  assert.equal(q.etapa(), 1);
  assert.equal(q.texto('fc-aviso-1'), 'Este WhatsApp já está ligado a outra empresa');
  assert.equal(q.texto('fc-telefone-erro'), 'Este WhatsApp já está ligado a outra empresa');
});

test('criar manda os dados da etapa 1 com a sessão', async () => {
  const p = await abrir('/agentes/fiscal/comecar/?plano=pro');
  await ateEtapa3(p);
  const verificar = p.rede.de('fiscal-acesso:verificar')[0];
  assert.deepEqual(verificar.corpo, { acao: 'verificar', email: 'lucca@exemplo.com', codigo: CODIGO_CERTO });
  assert.equal(verificar.url, 'https://projeto.supabase.test/functions/v1/fiscal-acesso');
  assert.equal(p.rede.chamadas.filter((c) => c.url.includes('/auth/v1/verify')).length, 0, 'a página não fala com o /auth/v1/verify');
  const criar = p.rede.de('fiscal-cadastro:criar')[0];
  assert.deepEqual(criar.corpo, { acao: 'criar', cnpj: CNPJ, razao_social: 'CLINICA AURORA LTDA', responsavel: 'Lucca Teste', telefone: '+5511987654321', plano: 'pro' });
  assert.equal(criar.headers.authorization, 'Bearer at-1');
  assert.equal(p.etapa(), 3);
  const s = JSON.parse(p.window.localStorage.getItem('nofiscal.sessao'));
  assert.deepEqual(Object.keys(s).sort(), ['access_token', 'expires_at', 'refresh_token']);
});

test('venda fechada', async () => {
  const p = await abrirNaEtapa('pagamento', {
    respostas: { 'GET assinatura-fiscal': r(200, { ok: true, venda_aberta: false, public_key: 'pk_test_abc', aceite_texto: ACEITE, planos: { inicial: { valor_centavos: 4900 }, pro: { valor_centavos: 12900 } } }) }
  });
  assert.equal(p.etapa(), 3);
  assert.equal(p.passo(), '3 de 7 · Pagamento');
  const botao = p.$('fc-pagar');
  assert.equal(botao.disabled, true);
  assert.equal(p.texto(botao), 'Vendas abrem em breve');
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  assert.equal(p.rede.de('pagarme:tokens').length, 0);
  assert.equal(p.rede.de('POST assinatura-fiscal').length, 0);
});

test('cartão só no pagar.me', async () => {
  const p = await abrir('/agentes/fiscal/comecar/?plano=pro');
  await ateEtapa3(p);
  assert.equal(p.etapa(), 3);
  assert.equal(p.texto('fc-pagar'), 'Começar 7 dias grátis');
  assert.equal(p.texto('fc-aceite-texto'), ACEITE);
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');

  const [tok] = p.rede.de('pagarme:tokens');
  assert.ok(tok, 'tokenização no Pagar.me');
  assert.equal(tok.url, 'https://api.pagar.me/core/v5/tokens?appId=pk_test_abc');
  assert.equal(tok.corpo.card.number, '4111111111111111');

  const [pag] = p.rede.de('POST assinatura-fiscal');
  assert.ok(pag, 'POST assinatura-fiscal');
  assert.deepEqual(Object.keys(pag.corpo).sort(), ['aceite_texto', 'card_token', 'endereco', 'medicao', 'plano', 'termos_aceite']);
  // Sem escolha no aviso de cookies: nada de fbp/fbc/página para a CAPI.
  assert.deepEqual(pag.corpo.medicao, { consent: 'denied' });
  assert.equal(pag.corpo.card_token, 'token_abc123');
  assert.equal(pag.corpo.plano, 'pro');
  assert.equal(pag.corpo.termos_aceite, true);
  assert.equal(pag.corpo.aceite_texto, ACEITE);
  assert.deepEqual(pag.corpo.endereco, { cep: '01310100', rua: 'Avenida Paulista', numero: '1000', complemento: '', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP' });
  const bruto = String(pag.bruto);
  for (const proibido of ['4111111111111111', '4111 1111', CARTAO.validade, '"cvv"', '"number"', 'exp_month', 'holder_name']) {
    assert.ok(!bruto.includes(proibido), `o corpo não leva ${proibido}`);
  }
  assert.ok(!bruto.includes('"123"'), 'sem o CVV');
  assert.equal(pag.headers.authorization, 'Bearer at-1');
  assert.equal(p.etapa(), 4);
  assert.equal(p.passo(), '4 de 7 · Certificado');
  assert.equal(p.$('fc-cc-numero').value, '', 'o número do cartão sai da tela');
});

// Lucca, 22/10/2026: eventos de compra do funil, do cadastro à assinatura (agentes/fiscal/medicao.js).
test('funil de compra: dataLayer e Pixel com o mesmo event_id do checkout', async () => {
  const COMPRA = { evento: 'Purchase', event_id: 'nofiscal-purchase-a-9', transaction_id: 'a-9', valor: 129, moeda: 'BRL' };
  const rede = superficie({ 'POST assinatura-fiscal': r(200, { ok: true, status: 'pendente', assinatura_id: 'a-9', com_teste: false, medicao: COMPRA }) });
  const p = await abrir('/agentes/fiscal/comecar/?plano=pro&fbclid=IwAR0abc_DEF-123', { rede, local: { no_fiscal_consent: 'granted' } });
  const fbq = [];
  p.window.fbq = (...args) => fbq.push(args);
  p.window.document.cookie = '_fbp=fb.1.1761140000000.1234567890';
  assert.ok(!p.visivel('fi-cookies'), 'com escolha salva, o aviso não abre');

  await ateEtapa3(p);
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  await p.esvaziar(60);

  const funil = p.window.dataLayer.filter((e) => e && typeof e.event === 'string' && e.event.startsWith('nofiscal_'));
  assert.deepEqual(js(funil.map((e) => e.event)), ['nofiscal_cadastro_inicio', 'nofiscal_cadastro', 'nofiscal_checkout', 'nofiscal_pagamento_info', 'nofiscal_compra']);
  const porNome = Object.fromEntries(funil.map((e) => [e.event, e]));
  assert.deepEqual(
    { plano: porNome.nofiscal_checkout.plano, valor: porNome.nofiscal_checkout.valor, moeda: porNome.nofiscal_checkout.moeda },
    { plano: 'pro', valor: 129, moeda: 'BRL' },
  );
  assert.equal(porNome.nofiscal_compra.transaction_id, 'a-9');
  assert.equal(porNome.nofiscal_compra.valor, 129);
  assert.equal(porNome.nofiscal_compra.event_id, COMPRA.event_id, 'mesmo id da CAPI no servidor');

  const meta = fbq.filter((a) => a[0] === 'track').map((a) => a[1]);
  assert.deepEqual(js(meta), ['CompleteRegistration', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase']);
  const compra = fbq.find((a) => a[1] === 'Purchase');
  assert.deepEqual(js(compra[2]), { value: 129, currency: 'BRL' });
  assert.deepEqual(js(compra[3]), { eventID: COMPRA.event_id });
  // O dataLayer e o Pixel de cada passo dividem o event_id.
  const checkout = fbq.find((a) => a[1] === 'InitiateCheckout');
  assert.equal(checkout[3].eventID, porNome.nofiscal_checkout.event_id);

  // O servidor recebe o consentimento e os cookies da Meta para a CAPI.
  const [pag] = rede.de('POST assinatura-fiscal');
  assert.equal(pag.corpo.medicao.consent, 'granted');
  assert.equal(pag.corpo.medicao.fbp, 'fb.1.1761140000000.1234567890');
  assert.match(pag.corpo.medicao.fbc, /^fb\.1\.\d{13}\.IwAR0abc_DEF-123$/);
  assert.match(pag.corpo.medicao.page_url, /\/agentes\/fiscal\/comecar\//);

  // Recarregar a página não conta a compra de novo.
  assert.equal(p.window.noFiscalMedicao.compra(COMPRA, 'pro'), null);
});

test('funil sem consentimento: dataLayer sim, Pixel não; recusa medida', async () => {
  const p = await abrir('/agentes/fiscal/comecar/?plano=inicial', {
    rede: superficie({ 'POST assinatura-fiscal': r(402, { ok: false, error_code: 'PAGAMENTO_RECUSADO', mensagem: 'x' }) })
  });
  const fbq = [];
  p.window.fbq = (...args) => fbq.push(args);
  assert.ok(p.visivel('fi-cookies'), 'sem escolha, o aviso de cookies abre');
  await ateEtapa3(p);
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  const eventos = p.window.dataLayer.filter((e) => e && typeof e.event === 'string').map((e) => e.event);
  assert.ok(eventos.includes('nofiscal_checkout'));
  assert.ok(eventos.includes('nofiscal_pagamento_recusado'));
  assert.ok(!eventos.includes('nofiscal_compra'));
  assert.equal(fbq.filter((a) => a[0] === 'track').length, 0, 'sem consentimento, nada no Pixel');

  // "Permitir" no aviso grava a escolha e atualiza o modo de consentimento do Google.
  await p.clicar('fi-consent-grant');
  assert.equal(p.window.localStorage.getItem('no_fiscal_consent'), 'granted');
  assert.ok(!p.visivel('fi-cookies'));
  const update = p.window.dataLayer.filter((e) => e && e[0] === 'consent' && e[1] === 'update').at(-1);
  assert.equal(update[2].ad_storage, 'granted');
});

test('aviso de reteste', async () => {
  const aviso = 'Este CNPJ, e-mail ou telefone já usou o teste grátis';
  const rede = superficie({ 'POST assinatura-fiscal': r(200, { ok: true, status: 'pendente', com_teste: false, trial_ends_at: null, aviso }) });
  const p = await abrir('/agentes/fiscal/comecar/', { rede });
  await ateEtapa3(p);
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  assert.equal(p.etapa(), 3, 'mostra o aviso antes de seguir');
  assert.equal(p.texto('fc-aviso-3'), aviso);
  assert.ok(p.visivel('fc-aviso-3'));
  assert.ok(p.visivel('fc-seguir-sem-teste'));
  await p.clicar('fc-seguir-sem-teste');
  assert.equal(p.etapa(), 4);
});

test('cartão recusado', async () => {
  const rede = superficie({ 'POST assinatura-fiscal': r(402, { ok: false, error_code: 'PAGAMENTO_RECUSADO', mensagem: 'O pagamento não foi aprovado pelo cartão.' }) });
  const p = await abrir('/agentes/fiscal/comecar/', { rede });
  await ateEtapa3(p);
  await preencherCartao(p);
  await p.marcar('fc-aceite');
  await p.enviar('fc-form-3');
  assert.equal(p.texto('fc-aviso-3'), 'Cartão recusado. Tente outro cartão');
  assert.equal(p.etapa(), 3);
  assert.equal(p.$('fc-pagar').disabled, false, 'pode tentar outro cartão');
});

test('certificado na etapa 4', async () => {
  const p = await abrirNaEtapa('certificado');
  assert.equal(p.etapa(), 4);
  // Lucca, 22/10/2026: explicação recolhida de o que é o A1 e como conseguir, fechada por padrão.
  const explica = p.$('fc-a1-explica');
  assert.equal(explica.tagName, 'DETAILS');
  assert.equal(explica.open, false);
  assert.match(p.texto(explica), /Pergunte ao seu contador/);
  assert.match(p.texto(explica), /A3.*não serve/);
  await p.arquivos('fc-pfx', [['empresa.pfx', new Uint8Array([48, 130, 1, 2]), 'application/x-pkcs12']]);
  await p.preencher('fc-pfx-senha', 'segredo');
  await p.enviar('fc-form-4');
  const [env] = p.rede.de('app:certificate');
  assert.ok(env, 'envio do A1');
  assert.equal(env.url, 'https://www.notechstack.com.br/agentes/fiscal/api/v1/onboarding/certificate/');
  assert.equal(env.headers.authorization, 'Bearer at-0');
  assert.equal(env.corpo.tenant_id, TENANT);
  assert.equal(env.corpo.senha, 'segredo');
  assert.equal(env.corpo.pfx.name, 'empresa.pfx');
  // Lucca, 22/10/2026: carregamento por cima da página e, aprovado, avança sozinho para os dados fiscais.
  const carregando = p.window.document.getElementById('nf-carregando-global');
  assert.ok(carregando && !carregando.hidden, 'círculo de carregamento enquanto confere');
  await depoisDoCarregamento(p);
  assert.ok(carregando.hidden, 'o carregamento some');
  assert.equal(p.etapa(), 5, 'aprovado avança direto');
  assert.equal(p.texto('fc-cert-ok'), 'Certificado de CLINICA AURORA LTDA aceito, válido até 31/03/2027.');
  assert.equal(p.$('fc-pfx-senha').value, '', 'a senha sai da tela');

  for (const [codigo, msg] of [['CERT_SENHA_INVALIDA', 'Senha incorreta'], ['CERT_VENCIDO', 'Certificado vencido'], ['CERT_CNPJ_DIFERENTE', 'Este certificado é de outro CNPJ']]) {
    const q = await abrirNaEtapa('certificado', { respostas: { 'app:certificate': r(422, { error: { code: codigo, message: 'x' } }) } });
    await q.arquivos('fc-pfx', [['empresa.pfx', new Uint8Array([1, 2, 3]), 'application/x-pkcs12']]);
    await q.preencher('fc-pfx-senha', 'errada');
    await q.enviar('fc-form-4');
    await depoisDoCarregamento(q);
    assert.equal(q.texto('fc-aviso-4'), msg, codigo);
    assert.equal(q.etapa(), 4, codigo);
    // Recusado: pop-up com o motivo, que fecha no botão.
    const doc = q.window.document;
    const popup = doc.querySelector('.nf-popup');
    assert.ok(popup, `${codigo}: pop-up`);
    assert.equal(popup.getAttribute('role'), 'alertdialog');
    assert.equal(popup.querySelector('h2').textContent, 'Não deu para usar este certificado');
    assert.equal(popup.querySelector('p').textContent, msg);
    popup.querySelector('button').click();
    await q.esvaziar(10);
    assert.equal(doc.querySelector('.nf-popup'), null, `${codigo}: o pop-up fecha`);
  }
});

// O carregamento fica no mínimo 700 ms na tela (comecar.js, CARREGAMENTO_MINIMO_MS).
async function depoisDoCarregamento(p) {
  await new Promise((ok) => setTimeout(ok, 800));
  await p.esvaziar(60);
}

test('sugestões de código', async () => {
  const p = await abrirNaEtapa('dados_fiscais', { estadoExtra: { plano: 'inicial' } });
  assert.equal(p.etapa(), 5);
  assert.equal(p.passo(), '5 de 7 · Dados fiscais');
  await p.esvaziar(40);
  const sugeridos = [...p.$('fc-seletor').querySelectorAll('.nf-sugestoes input[type=radio]')].map((i) => i.value);
  assert.deepEqual(sugeridos, ['040101', '040102'], 'sugestões do CNAE 8630503');
  assert.match(p.texto(p.$('fc-seletor').querySelector('.nf-sugestoes')), /04\.01\.01 Medicina e biomedicina/);
  const arquivos = p.rede.chamadas.filter((c) => c.rota && c.rota.startsWith('dados:')).map((c) => c.url);
  assert.ok(arquivos.includes('https://www.notechstack.com.br/agentes/fiscal/dados/cnae-servico.json'));
  assert.ok(arquivos.includes('https://www.notechstack.com.br/agentes/fiscal/dados/codigos-servico.json'));

  await p.preencher('fc-busca-codigo', 'enfermagem');
  const achados = [...p.$('fc-seletor').querySelectorAll('.nf-resultados input[type=radio]')].map((i) => i.value);
  assert.deepEqual(achados, ['040601'], 'busca por texto na lista nacional');
  await p.preencher('fc-busca-codigo', 'analises clinicas');
  assert.deepEqual([...p.$('fc-seletor').querySelectorAll('.nf-resultados input')].map((i) => i.value), ['040102'], 'sem diferenciar acento');
  // Busca resumida (Lucca, 22/10/2026): nada com 1 letra, no máximo 6 opções e o total do resto.
  await p.preencher('fc-busca-codigo', 'a');
  assert.equal(p.$('fc-seletor').querySelectorAll('.nf-resultados input').length, 0);
  assert.match(p.texto(p.$('fc-seletor').querySelector('.nf-resultados')), /pelo menos 3 letras ou 2 números/);
  await p.preencher('fc-busca-codigo', 'servi');
  assert.equal(p.$('fc-seletor').querySelectorAll('.nf-resultados input').length, 6, 'no máximo 6 opções');
  assert.match(p.texto(p.$('fc-seletor').querySelector('.nf-resultados')), /Mais \d+ resultados\. Escreva mais para refinar\./);

  await p.preencher('fc-busca-codigo', 'enfermagem');
  const radio = p.$('fc-seletor').querySelector('.nf-resultados input[value="040601"]');
  radio.checked = true;
  radio.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.esvaziar(10);
  assert.equal(p.$('fc-seletor').querySelectorAll('.nf-resultados input').length, 0, 'escolher fecha a caixa');
  assert.match(p.texto(p.$('fc-seletor').querySelector('.nf-escolhido')), /^Escolhido: 04\.06\.01/);
  await p.preencher('fc-percentual', '6,5');
  await p.enviar('fc-form-5');
  const [conf] = p.rede.de('fiscal-conta:configurar');
  assert.ok(conf, 'configurar');
  assert.deepEqual(conf.corpo, { acao: 'configurar', codigo_servico_nacional: '040601', p_tot_trib_sn: 6.5 });
  assert.equal(p.etapa(), 6);
});

test('sem os arquivos de dados, a etapa 5 aceita o código digitado', async () => {
  const sem = { 'dados:codigos-servico.json': r(404, null), 'dados:cnae-servico.json': r(404, null) };
  const p = await abrirNaEtapa('dados_fiscais', { estadoExtra: { plano: 'inicial' }, respostas: sem });
  await p.esvaziar(40);
  assert.equal(p.$('fc-seletor').querySelectorAll('.nf-sugestoes input').length, 0);
  await p.preencher('fc-busca-codigo', '040101');
  const radio = p.$('fc-seletor').querySelector('.nf-resultados input[value="040101"]');
  assert.ok(radio, 'o código digitado vira opção');
  radio.checked = true;
  radio.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.preencher('fc-percentual', '100');
  await p.enviar('fc-form-5');
  assert.equal(p.rede.de('fiscal-conta:configurar')[0].corpo.codigo_servico_nacional, '040101');
});

test('mei: etapa 5 sem percentual do Simples', async () => {
  const p = await abrirNaEtapa('dados_fiscais', { estadoExtra: { plano: 'inicial', empresa: { ...estado().empresa, regime: 'mei' } } });
  await p.esvaziar(40);
  assert.ok(!p.visivel('fc-percentual'), 'campo do percentual escondido');
  const radio = p.$('fc-seletor').querySelector('.nf-sugestoes input[value="040101"]');
  radio.checked = true;
  radio.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.enviar('fc-form-5');
  assert.deepEqual(js(p.rede.de('fiscal-conta:configurar')[0].corpo), { acao: 'configurar', codigo_servico_nacional: '040101' });
  assert.equal(p.etapa(), 6);
});

test('dados fiscais inválidos ficam na página e o 422 aponta o campo', async () => {
  const p = await abrirNaEtapa('dados_fiscais', { estadoExtra: { plano: 'inicial' } });
  await p.esvaziar(40);
  await p.preencher('fc-percentual', '100,01');
  await p.enviar('fc-form-5');
  assert.equal(p.rede.de('fiscal-conta:configurar').length, 0);
  assert.equal(p.texto('fc-codigo-servico-erro'), 'Escolha o código de serviço.');
  assert.equal(p.texto('fc-percentual-erro'), 'Use um número de 0 a 100, com até 2 casas.');

  const q = await abrirNaEtapa('dados_fiscais', { estadoExtra: { plano: 'inicial' }, respostas: { 'fiscal-conta:configurar': r(422, { ok: false, error_code: 'DADOS_FISCAIS_INVALIDOS', campo: 'codigo_servico_nacional', mensagem: 'Código fora da lista nacional.' }) } });
  await q.esvaziar(40);
  const radio = q.$('fc-seletor').querySelector('.nf-sugestoes input[value="040101"]');
  radio.checked = true;
  radio.dispatchEvent(new q.window.Event('change', { bubbles: true }));
  await q.preencher('fc-percentual', '6');
  await q.enviar('fc-form-5');
  assert.equal(q.texto('fc-codigo-servico-erro'), 'Código fora da lista nacional.');
  assert.equal(q.etapa(), 5);
});

test('campos do pro', async () => {
  const pro = await abrirNaEtapa('dados_fiscais', { estadoExtra: { plano: 'pro' } });
  await pro.esvaziar(40);
  assert.ok(pro.visivel('fc-pro'));
  const rotulos = pro.rotulos('fc-etapa-5');
  assert.ok(rotulos.includes('E-mail do contador (opcional)'), rotulos.join(' | '));
  assert.ok(pro.visivel('fc-resumo'));
  assert.equal(pro.texto(pro.$('fc-resumo').querySelector('legend')), 'Resumo das notas');
  assert.deepEqual([...pro.$('fc-resumo-dia-mes').options].map((o) => o.value), Array.from({ length: 28 }, (_, i) => String(i + 1)), 'Mensal: dia 1 a 28');
  assert.deepEqual([...pro.$('fc-resumo-dia-semana').options].map((o) => [o.value, o.textContent]),
    [['1', 'segunda'], ['2', 'terça'], ['3', 'quarta'], ['4', 'quinta'], ['5', 'sexta'], ['6', 'sábado'], ['7', 'domingo']], 'Semanal: dia da semana ISO');
  const radio = pro.$('fc-seletor').querySelector('.nf-sugestoes input[value="040101"]');
  radio.checked = true;
  radio.dispatchEvent(new pro.window.Event('change', { bubbles: true }));
  await pro.preencher('fc-percentual', '6');
  await pro.preencher('fc-contador', 'contador@escritorio.com.br');
  const semanal = pro.$('fc-resumo').querySelector('input[value="semanal"]');
  semanal.checked = true;
  await pro.preencher('fc-resumo-dia-semana', '1');
  await pro.enviar('fc-form-5');
  assert.deepEqual(pro.rede.de('fiscal-conta:configurar')[0].corpo, {
    acao: 'configurar', codigo_servico_nacional: '040101', p_tot_trib_sn: 6, contador_email: 'contador@escritorio.com.br', resumo: { frequencia: 'semanal', dia: 1 }
  });

  const ini = await abrirNaEtapa('dados_fiscais', { estadoExtra: { plano: 'inicial' } });
  await ini.esvaziar(40);
  assert.equal(ini.visivel('fc-pro'), false);
  assert.ok(!ini.rotulos('fc-etapa-5').includes('E-mail do contador (opcional)'));
  assert.doesNotMatch(ini.textoVisivel(), /Resumo das notas/);
  const r2 = ini.$('fc-seletor').querySelector('.nf-sugestoes input[value="040101"]');
  r2.checked = true;
  r2.dispatchEvent(new ini.window.Event('change', { bubbles: true }));
  await ini.preencher('fc-percentual', '6');
  await ini.enviar('fc-form-5');
  const corpo = ini.rede.de('fiscal-conta:configurar')[0].corpo;
  assert.ok(!('resumo' in corpo) && !('contador_email' in corpo), JSON.stringify(corpo));
});

test('cartões de clientes', async () => {
  const p = await abrirNaEtapa('clientes');
  assert.equal(p.etapa(), 6);
  assert.equal(p.passo(), '6 de 7 · Seus clientes');
  assert.deepEqual(p.rede.de('app:clientes:buscar_adn')[0].corpo, { tenant_id: TENANT, acao: 'buscar_adn' });
  const cartoes = [...p.$('fc-clientes').querySelectorAll('.nf-cliente')];
  assert.equal(cartoes.length, 2, 'um cartão por tomador');
  const campo = (c, k) => c.querySelector(`[data-campo="${k}"]`);
  const [a, b] = cartoes;
  assert.equal(campo(a, 'nome').value, 'Prontia Saúde');
  assert.equal(campo(a, 'tomador_nome').value, 'Prontia Saúde Ltda');
  assert.equal(campo(a, 'tomador_documento').value, '11.444.777/0001-61');
  assert.equal(campo(a, 'tomador_email').value, 'financeiro@prontia.com.br');
  assert.equal(campo(a, 'codigo_servico_nacional').value, '040101');
  assert.equal(campo(a, 'descricao').value, 'Consulta médica');
  assert.equal(campo(a, 'valor_padrao').value, '150,00');
  assert.equal(campo(b, 'tomador_documento').value, '529.982.247-25');
  for (const c of cartoes) {
    const salvar = campo(c, 'salvar');
    assert.equal(salvar.checked, true, '"Salvar como modelo" marcado');
    assert.match(salvar.parentElement.textContent, /Salvar como modelo/);
    for (const k of ['nome', 'tomador_nome', 'tomador_documento', 'tomador_email', 'codigo_servico_nacional', 'descricao', 'valor_padrao']) {
      assert.equal(campo(c, k).readOnly || campo(c, k).disabled, false, `${k} editável`);
    }
  }
  assert.ok(p.visivel('fc-salvar-clientes'));
  assert.equal(p.rede.de('app:clientes:salvar').length, 0, 'nada é salvo antes de "Salvar clientes"');

  // Editar um e desmarcar o outro: só o marcado vai, com a edição.
  campo(a, 'descricao').value = 'Consulta médica de retorno';
  campo(b, 'salvar').checked = false;
  await p.clicar('fc-salvar-clientes');
  const [salvar] = p.rede.de('app:clientes:salvar');
  assert.equal(salvar.corpo.tenant_id, TENANT);
  assert.equal(salvar.corpo.modelos.length, 1);
  assert.deepEqual(salvar.corpo.modelos[0], { ...CANDIDATOS[0], descricao: 'Consulta médica de retorno' });
  assert.equal(p.etapa(), 7);
});

test('ignorados no salvar aparecem com o motivo', async () => {
  const p = await abrirNaEtapa('clientes', { respostas: { 'app:clientes:salvar': r(201, { salvos: 1, ignorados: [{ nome: 'Clínica Aurora', motivo: 'documento inválido' }] }) } });
  await p.clicar('fc-salvar-clientes');
  assert.equal(p.etapa(), 6);
  assert.equal(p.texto('fc-aviso-6'), '1 cliente salvo. Ficaram de fora: Clínica Aurora (documento inválido).');
  await p.clicar('fc-continuar-6');
  assert.equal(p.etapa(), 7);
});

test('oferece pdf', async () => {
  const p = await abrirNaEtapa('clientes', { respostas: { 'app:clientes:buscar_adn': r(503, { error: { code: 'ADN_INDISPONIVEL', message: 'fora' } }) } });
  assert.ok(p.visivel('fc-pdfs'));
  assert.equal(p.texto(p.$('fc-pdfs').querySelector('label.nf-arquivo')), 'Enviar PDFs das notas');
  assert.equal(p.$('fc-clientes').querySelectorAll('.nf-cliente').length, 0);

  const vazio = await abrirNaEtapa('clientes', { respostas: { 'app:clientes:buscar_adn': r(200, { candidatos: [] }) } });
  assert.ok(vazio.visivel('fc-pdfs'), 'sem notas no ADN também oferece os PDFs');

  // Cada PDF vai numa requisição ler_pdf; o lido vira cartão; o ilegível vira aviso.
  const leituras = [];
  const q = await abrirNaEtapa('clientes', {
    respostas: {
      'app:clientes:buscar_adn': r(503, { error: { code: 'ADN_INDISPONIVEL', message: 'fora' } }),
      'app:clientes:ler_pdf': (c) => {
        leituras.push(c);
        return c.arquivo.name === 'foto.pdf'
          ? { status: 422, corpo: { error: { code: 'PDF_ILEGIVEL', message: 'não é DANFSe' } } }
          : { status: 200, corpo: { candidato: { ...CANDIDATOS[0], origem: 'importacao_pdf' } } };
      }
    }
  });
  await q.arquivos('fc-pdf', [['nota-1.pdf', '%PDF-1.4', 'application/pdf'], ['foto.pdf', '%PDF-1.4', 'application/pdf']]);
  assert.equal(leituras.length, 2);
  for (const c of leituras) { assert.equal(c.acao, 'ler_pdf'); assert.equal(c.tenant_id, TENANT); }
  assert.equal(q.$('fc-clientes').querySelectorAll('.nf-cliente').length, 1);
  assert.match(q.texto('fc-aviso-pdf'), /foto\.pdf: não conseguimos ler este PDF como nota \(DANFSe\)\./);

  const lim = await abrirNaEtapa('clientes', { respostas: { 'app:clientes:buscar_adn': r(200, { candidatos: [] }), 'app:clientes:ler_pdf': r(429, { error: { code: 'LIMITE_PDFS', message: 'limite' } }) } });
  await lim.arquivos('fc-pdf', [['a.pdf', '%PDF', 'application/pdf'], ['b.pdf', '%PDF', 'application/pdf']]);
  assert.equal(lim.rede.de('app:clientes:ler_pdf').length, 1, 'para no limite');
  assert.match(lim.texto('fc-aviso-pdf'), /limite de 30 PDFs/);
});

test('pular clientes', async () => {
  const p = await abrirNaEtapa('clientes');
  await p.clicar('fc-pular');
  assert.equal(p.etapa(), 7);
  assert.equal(p.rede.de('app:clientes:salvar').length, 0);
});

test('concluir no whatsapp', async () => {
  const p = await abrirNaEtapa('ativacao');
  assert.equal(p.etapa(), 7);
  assert.equal(p.passo(), '7 de 7 · Concluir no WhatsApp');
  assert.deepEqual(p.rede.de('app:ativacao')[0].corpo, { tenant_id: TENANT });
  const botao = p.$('fc-whatsapp');
  assert.ok(p.visivel(botao));
  assert.equal(p.texto(botao), 'Concluir no WhatsApp');
  const mensagem = 'Quero ativar o nó.fiscal da CLINICA AURORA LTDA no plano Pro. Código de ativação: 482913';
  assert.equal(botao.getAttribute('href'), 'https://wa.me/5511900000000?text=' + encodeURIComponent(mensagem));
  // Lucca, 22/10/2026: o número cadastrado inteiro e a mensagem legível, com empresa, plano e código.
  assert.ok(p.visivel('fc-ativacao'));
  assert.equal(p.texto('fc-ativar-numero'), '(11) 98765-4321');
  assert.equal(p.texto('fc-ativar-mensagem'), mensagem);
});

// Lucca, 22/10/2026: clicar na trilha reabre uma etapa já alcançada. Depois do pagamento, da 4 em diante;
// empresa, código e pagamento ficam travados (mudam em Minha conta).
test('trilha volta às etapas já alcançadas', async () => {
  const trilha = (p) => [...p.$('fc-trilha').querySelectorAll('li')].map((li) => ({
    classe: li.className.trim(), aberta: !li.querySelector('button').disabled
  }));
  const certificado = { subject: 'CN=CLINICA AURORA LTDA:11222333000181', not_after: '2027-03-31T23:59:59.000Z' };
  const p = await abrirNaEtapa('ativacao', { estadoExtra: { certificado, fiscal: { codigo_servico_nacional: '040101', p_tot_trib_sn: 6, contador_email: null, resumo: null } } });
  assert.equal(p.etapa(), 7);
  assert.deepEqual(trilha(p).map((x) => x.aberta), [false, false, false, true, true, true, false]);
  assert.match(p.$('fc-trilha').querySelector('[data-etapa="2"] button').title, /Minha conta/);

  await p.clicar(p.$('fc-trilha').querySelector('[data-etapa="5"] button'));
  assert.equal(p.etapa(), 5);
  assert.equal(p.$('fc-percentual').value, '6', 'os dados fiscais voltam preenchidos');
  assert.deepEqual(trilha(p).map((x) => x.classe), ['is-feita', 'is-feita', 'is-feita', 'is-feita is-aberta', 'is-atual', 'is-feita is-aberta', 'is-aberta']);
  // Etapa travada não reage ao clique.
  await p.clicar(p.$('fc-trilha').querySelector('[data-etapa="3"] button'));
  assert.equal(p.etapa(), 5);

  // De volta ao certificado: segue com "Continuar" e dá para trocar o arquivo.
  await p.clicar(p.$('fc-trilha').querySelector('[data-etapa="4"] button'));
  assert.equal(p.etapa(), 4);
  assert.ok(p.visivel('fc-continuar-4'));
  assert.equal(p.texto('fc-enviar-a1'), 'Enviar outro certificado');
  assert.ok(p.visivel('fc-enviar-a1'));

  await p.clicar(p.$('fc-trilha').querySelector('[data-etapa="7"] button'));
  assert.equal(p.etapa(), 7);
  assert.equal(p.rede.de('app:ativacao').length, 1, 'voltar à 7 não pede outro código');

  // Antes de a conta existir, a etapa do código deixa voltar à 1 para corrigir os dados.
  const q = await abrir('/agentes/fiscal/comecar/');
  await preencherEtapa1(q);
  await q.enviar('fc-form-1');
  assert.equal(q.etapa(), 2);
  assert.deepEqual(trilha(q).map((x) => x.aberta), [true, false, false, false, false, false, false]);
  await q.clicar(q.$('fc-trilha').querySelector('[data-etapa="1"] button'));
  assert.equal(q.etapa(), 1);
  assert.equal(q.$('fc-email').value, 'lucca@exemplo.com');
});

test('retomada abre na etapa do servidor', async () => {
  const casos = [['pagamento', 3], ['certificado', 4], ['dados_fiscais', 5], ['clientes', 6], ['ativacao', 7], ['boas_vindas_cliente', 7]];
  for (const [etapa, n] of casos) {
    const p = await abrirNaEtapa(etapa);
    assert.equal(p.etapa(), n, etapa);
    assert.deepEqual(p.rede.de('fiscal-conta:estado')[0].corpo, { acao: 'estado' });
  }
  const semEmpresa = await abrirNaEtapa('pagamento', { respostas: { 'fiscal-conta:estado': r(403, { ok: false, error_code: 'CONTA_SEM_EMPRESA', mensagem: 'x' }) } });
  assert.equal(semEmpresa.etapa(), 1);
});

test('sessão vencida no meio volta ao código com o que foi digitado', async () => {
  let vezes = 0;
  const rede = superficie({
    'auth:refresh': r(400, { error: 'invalid_grant' }),
    'fiscal-cadastro:criar': () => (vezes++ === 0 ? { status: 401, corpo: { ok: false, error_code: 'SEM_SESSAO' } } : { status: 201, corpo: { ok: true, tenant_id: TENANT, etapa: 'pagamento' } })
  });
  const p = await abrir('/agentes/fiscal/comecar/', { rede });
  await ateEtapa3(p);
  assert.equal(p.etapa(), 2, 'volta à etapa do código');
  assert.equal(rede.de('fiscal-acesso').length, 2, 'manda um código novo');
  assert.equal(p.window.localStorage.getItem('nofiscal.sessao'), null);
  await p.preencher('fc-codigo', CODIGO_CERTO);
  await p.enviar('fc-form-2');
  assert.equal(p.etapa(), 3);
  assert.equal(rede.de('fiscal-cadastro:criar')[1].corpo.cnpj, CNPJ, 'o que foi digitado continua');
});
