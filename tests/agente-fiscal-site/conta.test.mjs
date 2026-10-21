// /agentes/fiscal/conta/ (lote E de .checks/agente-fiscal-v2.md): C38u, C39u–C41u e C45u.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrir, superficie, sessaoValida, estado, preencherCartao, emDias, CODIGO_CERTO, TENANT } from './pagina-falsa.mjs';

const r = (status, corpo) => () => ({ status, corpo });
const comSessao = (respostas = {}) => {
  const rede = superficie(respostas);
  return abrir('/agentes/fiscal/conta/', { rede, local: { 'nofiscal.sessao': sessaoValida() } });
};

test('minha conta', async () => {
  // Sem sessão: pede o e-mail e depois o código (o mesmo fiscal-acesso).
  const p = await abrir('/agentes/fiscal/conta/');
  assert.ok(p.visivel('fa-login'));
  assert.equal(p.visivel('fa-painel'), false);
  assert.ok(p.visivel('fa-email'));
  assert.equal(p.visivel('fa-codigo'), false);
  assert.deepEqual(p.rede.chamadas, [], 'sem sessão, nada é chamado');
  await p.preencher('fa-email', 'lucca@exemplo.com');
  await p.enviar('fa-form-email');
  assert.deepEqual(p.rede.de('fiscal-acesso')[0].corpo, { email: 'lucca@exemplo.com' });
  assert.ok(p.visivel('fa-codigo'));
  await p.preencher('fa-codigo', '999999');
  await p.enviar('fa-form-codigo');
  assert.equal(p.texto('fa-codigo-erro'), 'Código incorreto');
  await p.preencher('fa-codigo', CODIGO_CERTO);
  await p.enviar('fa-form-codigo');
  assert.equal(p.rede.de('fiscal-conta:estado')[0].headers.authorization, 'Bearer at-1');

  // Com sessão: as seções e "Retomar configuração" quando a etapa não é concluido.
  assert.ok(p.visivel('fa-painel'));
  assert.equal(p.visivel('fa-login'), false);
  const t = p.textoVisivel();
  for (const s of ['Empresa', 'CLINICA AURORA LTDA', '11.222.333/0001-81', 'São Paulo/SP', 'Plano Pro', 'Certificado digital', 'Dados fiscais', 'Contador', 'Resumo das notas']) {
    assert.ok(t.includes(s), `"${s}" na página`);
  }
  assert.match(p.texto('fa-status'), /^Teste até \d{2}\/\d{2}$/);
  assert.ok(p.visivel('fa-retomar'));
  const retomar = p.$('fa-retomar').querySelector('a');
  assert.equal(p.texto(retomar), 'Retomar configuração');
  assert.equal(retomar.getAttribute('href'), '/agentes/fiscal/comecar/');

  const pronta = await comSessao({
    'fiscal-conta:estado': r(200, estado({
      onboarding_etapa: 'concluido', plano: 'inicial',
      assinatura: { status: 'paga', com_teste: true, trial_ends_at: emDias(-3), periodo_fim: emDias(25), cancelamento_agendado_para: null },
      certificado: { subject: 'CN=CLINICA AURORA LTDA:11222333000181, C=BR', not_after: '2027-03-31T15:00:00.000Z' },
      fiscal: { codigo_servico_nacional: '040101', p_tot_trib_sn: 6.5, contador_email: null, resumo: null }
    }))
  });
  assert.equal(pronta.visivel('fa-retomar'), false, 'concluído: sem "Retomar configuração"');
  assert.equal(pronta.texto('fa-status'), 'Ativa');
  assert.equal(pronta.texto('fa-cert-titular'), 'CLINICA AURORA LTDA');
  assert.equal(pronta.texto('fa-cert-validade'), '31/03/2027');
  const tp = pronta.textoVisivel();
  assert.ok(tp.includes('04.01.01') && tp.includes('6,5%'), 'dados fiscais');
  assert.ok(!/Contador|Resumo das notas/.test(pronta.texto('fa-fiscal')), 'no Inicial, sem contador e resumo');

  const estados = [
    [{ status: 'recusada', trial_ends_at: null, cancelamento_agendado_para: null }, 'Pagamento recusado'],
    [{ status: 'cancelada', trial_ends_at: null, cancelamento_agendado_para: null }, 'Cancelada'],
    [{ status: 'paga', trial_ends_at: null, cancelamento_agendado_para: '2026-11-15T15:00:00.000Z' }, 'Cancelamento agendado para 15/11']
  ];
  for (const [a, txt] of estados) {
    const q = await comSessao({ 'fiscal-conta:estado': r(200, estado({ assinatura: { com_teste: false, periodo_fim: emDias(10), ...a } })) });
    assert.equal(q.texto('fa-status'), txt);
  }

  // Sem empresa: leva ao cadastro (Unresolved 12).
  const sem = await comSessao({ 'fiscal-conta:estado': r(403, { ok: false, error_code: 'CONTA_SEM_EMPRESA', mensagem: 'x' }) });
  assert.deepEqual(sem.navegou, ['/agentes/fiscal/comecar/']);
});

test('gestão da assinatura', async () => {
  // Trocar cartão: tokeniza no Pagar.me e manda só o token.
  const paga = { status: 'paga', com_teste: false, trial_ends_at: null, periodo_fim: '2026-11-15T15:00:00.000Z', cancelamento_agendado_para: null };
  const p = await comSessao({
    'fiscal-conta:estado': r(200, estado({ onboarding_etapa: 'concluido', assinatura: paga })),
    'fiscal-conta:trocar_plano': (c) => ({ status: 200, corpo: estado({ onboarding_etapa: 'concluido', assinatura: paga, plano: c.plano }) })
  });
  await p.clicar('fa-abrir-cartao');
  await preencherCartao(p, 'fa');
  await p.enviar('fa-form-cartao');
  const [tok] = p.rede.de('pagarme:tokens');
  assert.ok(tok && tok.url.startsWith('https://api.pagar.me/core/v5/tokens?appId=pk_test_abc'));
  const [troca] = p.rede.de('fiscal-conta:trocar_cartao');
  assert.equal(troca.corpo.acao, 'trocar_cartao');
  assert.equal(troca.corpo.card_token, 'token_abc123');
  assert.ok(!String(troca.bruto).includes('4111111111111111'), 'sem o número do cartão');
  assert.equal(p.texto('fa-aviso-plano'), 'Cartão atualizado');

  // Trocar plano: Pro → Inicial, e o plano exibido muda.
  assert.equal(p.texto('fa-plano-nome'), 'Pro');
  assert.equal(p.texto('fa-trocar-plano'), 'Mudar para o Inicial');
  await p.clicar('fa-trocar-plano');
  assert.deepEqual(p.rede.de('fiscal-conta:trocar_plano')[0].corpo, { acao: 'trocar_plano', plano: 'inicial' });
  assert.equal(p.texto('fa-plano-nome'), 'Inicial');
  assert.match(p.texto('fa-plano-notas'), /^Até 20 /);

  // Cancelar fora do teste: pergunta com a data antes de chamar.
  await p.clicar('fa-cancelar');
  assert.equal(p.rede.de('fiscal-conta:cancelar').length, 0, 'só pergunta');
  assert.ok(p.visivel('fa-confirmar-cancelar'));
  assert.equal(p.texto('fa-cancelar-pergunta'), 'Cancelar a assinatura? Você emite até 15/11/2026');
  await p.clicar('fa-cancelar-nao');
  assert.equal(p.rede.de('fiscal-conta:cancelar').length, 0);
  await p.clicar('fa-cancelar');
  await p.clicar('fa-cancelar-sim');
  assert.deepEqual(p.rede.de('fiscal-conta:cancelar')[0].corpo, { acao: 'cancelar' });
  assert.match(p.texto('fa-aviso'), /^Cancelamento agendado\. Você emite até \d{2}\/\d{2}\/\d{4}\.$/);

  // No teste, a pergunta diz que termina na hora.
  const q = await comSessao({ 'fiscal-conta:cancelar': r(200, { ok: true, cancelada_agora: true }) });
  await q.clicar('fa-cancelar');
  assert.equal(q.texto('fa-cancelar-pergunta'), 'Cancelar o teste? A assinatura termina agora e nada é cobrado.');
  await q.clicar('fa-cancelar-sim');
  assert.equal(q.texto('fa-aviso'), 'Assinatura cancelada. Nada foi cobrado.');
});

test('apagar pede confirmação', async () => {
  const p = await comSessao();
  await p.clicar('fa-apagar');
  assert.ok(p.visivel('fa-confirmar-apagar'));
  assert.equal(p.$('fa-apagar-sim').disabled, true);
  await p.clicar('fa-apagar-sim');
  await p.preencher('fa-apagar-texto', 'apagar');
  assert.equal(p.$('fa-apagar-sim').disabled, true, 'minúsculo não vale');
  await p.clicar('fa-apagar-sim');
  assert.equal(p.rede.de('fiscal-conta:apagar_conta').length, 0, 'nada antes de APAGAR');
  await p.preencher('fa-apagar-texto', 'APAGAR');
  assert.equal(p.$('fa-apagar-sim').disabled, false);
  await p.clicar('fa-apagar-sim');
  assert.deepEqual(p.rede.de('fiscal-conta:apagar_conta')[0].corpo, { acao: 'apagar_conta', confirmacao: 'APAGAR' });
  assert.equal(p.window.localStorage.getItem('nofiscal.sessao'), null, 'sai da conta');
  assert.ok(p.visivel('fa-login'));
});

test('a conta envia um certificado novo e altera os dados fiscais', async () => {
  const p = await comSessao();
  await p.arquivos('fa-pfx', [['novo.pfx', new Uint8Array([1, 2]), 'application/x-pkcs12']]);
  await p.preencher('fa-pfx-senha', 'nova');
  await p.enviar('fa-form-cert');
  assert.equal(p.rede.de('app:certificate')[0].corpo.tenant_id, TENANT);
  assert.equal(p.texto('fa-aviso-cert'), 'Certificado de CLINICA AURORA LTDA válido até 31/03/2027');
  await p.clicar('fa-abrir-fiscal');
  await p.esvaziar(40);
  const radio = p.$('fa-seletor').querySelector('.nf-sugestoes input[value="040102"]');
  radio.checked = true;
  radio.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.preencher('fa-percentual', '4,5');
  await p.enviar('fa-form-fiscal');
  assert.deepEqual(p.rede.de('fiscal-conta:configurar')[0].corpo, { acao: 'configurar', codigo_servico_nacional: '040102', p_tot_trib_sn: 4.5, contador_email: null, resumo: null });
});
