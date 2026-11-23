// /agentes/fiscal/conta/ no plano Escritório (.design/agente-fiscal-escritorio.md, "Painel do escritório"): as quatro
// abas (#dados, #empresas, #emitir, #relatorios), as ações por empresa, a troca de faixa, o relatório do mês e o PDF da nota.
// Mesma página falsa de conta.test.mjs; a rota do PDF (binária) é respondida aqui, antes do dublê da Surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abrir, superficie, sessaoValida, estado, emDias, ORIGEM, TENANT, procuracaoInfo, procuracaoGravada } from './pagina-falsa.mjs';

const EMP_PRONTA = '1a2b3c4d-0000-4000-8000-000000000002';
const EMP_VENCENDO = '1a2b3c4d-0000-4000-8000-000000000003';
const EMP_OFF = '1a2b3c4d-0000-4000-8000-000000000004';
const EMP_MEI = '1a2b3c4d-0000-4000-8000-000000000005';
const NOTA = '9f8e7d6c-0000-4000-8000-00000000000a';
const r = (status, corpo) => () => ({ status, corpo });

function empresas() {
  return [
    { tenant_id: TENANT, cnpj: '11222333000181', razao_social: 'CONTABIL SANDRA LTDA', regime: 'simples', principal: true, ativa: true, codigo_servico_nacional: null, p_tot_trib_sn: null, certificado: null, notas_mes: 0, situacao: 'falta_certificado' },
    { tenant_id: EMP_PRONTA, cnpj: '11444777000161', razao_social: 'PADARIA BOA LTDA', regime: 'simples', principal: false, ativa: true, codigo_servico_nacional: '170201', p_tot_trib_sn: 6.5, certificado: { subject: 'CN=PADARIA BOA LTDA:11444777000161', not_after: emDias(200) }, notas_mes: 30, situacao: 'pronta' },
    { tenant_id: EMP_VENCENDO, cnpj: '04252011000110', razao_social: 'OFICINA RAPIDA LTDA', regime: 'simples', principal: false, ativa: true, codigo_servico_nacional: '170201', p_tot_trib_sn: 4, certificado: { subject: 'CN=OFICINA', not_after: emDias(11.5) }, notas_mes: 7, situacao: 'certificado_vencendo' },
    { tenant_id: EMP_OFF, cnpj: '60701190000104', razao_social: 'LOJA FECHADA LTDA', regime: 'simples', principal: false, ativa: false, codigo_servico_nacional: null, p_tot_trib_sn: null, certificado: null, notas_mes: 0, situacao: 'desativada' },
    { tenant_id: EMP_MEI, cnpj: '33000167000101', razao_social: 'JOANA MEI', regime: 'mei', principal: false, ativa: true, codigo_servico_nacional: null, p_tot_trib_sn: null, certificado: null, notas_mes: 0, situacao: 'falta_dados_fiscais' }
  ];
}

function estadoEscritorio(extra = {}, esc = {}) {
  return estado({
    onboarding_etapa: 'concluido', plano: 'escritorio_5',
    empresa: { cnpj: '11222333000181', razao_social: 'CONTABIL SANDRA LTDA', municipio: null, uf: null, cnae: '6920601', regime: 'simples', responsavel: 'Sandra Teste', email: 'sandra@exemplo.com', telefone: '+5511987654321' },
    assinatura: { status: 'paga', com_teste: false, trial_ends_at: null, periodo_fim: '2026-12-05T15:00:00.000Z', cancelamento_agendado_para: null, cortesia: false, ciclo: 'mensal' },
    escritorio: { escritorio_tenant_id: TENANT, plano: 'escritorio_5', max_empresas: 100000, empresas_ativas: 4, notas_limite: 500, notas_mes: 37, empresas: empresas(), ...esc },
    ...extra
  });
}

const NOTAS = [
  {
    invoice_id: NOTA, criada_em: '2026-11-04T13:00:00.000Z', emitida_em: '2026-11-04T13:01:00.000Z', situacao: 'issued', numero: 1467,
    empresa: { tenant_id: EMP_PRONTA, cnpj: '11444777000161', razao_social: 'PADARIA BOA LTDA' },
    tomador: { nome: 'Tomador Um', documento: '11444777000161', email: 'fin@tomador.test' },
    descricao: 'Honorários contábeis', codigo_tributacao: '170201', valor: '1500.50', motivo: null, tem_pdf: true,
    entregas: [
      { canal: 'email', papel: 'tomador', destino: 'fin@tomador.test', status: 'enviado', em: '2026-11-04T13:02:00.000Z' },
      { canal: 'whatsapp', papel: 'escritorio', destino: '+5511999990000', status: 'falhou', em: '2026-11-04T13:02:00.000Z' }
    ]
  },
  {
    invoice_id: '9f8e7d6c-0000-4000-8000-00000000000b', criada_em: '2026-11-03T10:00:00.000Z', emitida_em: null, situacao: 'rejected', numero: null,
    empresa: { tenant_id: EMP_VENCENDO, cnpj: '04252011000110', razao_social: 'OFICINA RAPIDA LTDA' },
    tomador: { nome: 'Tomador Dois', documento: '52998224725', email: null },
    descricao: 'Revisão', codigo_tributacao: '170201', valor: '80.00', motivo: 'E0712 código inválido', tem_pdf: false, entregas: []
  }
];

/** Dublê da Surface + a rota binária do PDF. */
function rede(respostas = {}) {
  const base = superficie({ 'fiscal-conta:estado': r(200, estadoEscritorio()), ...respostas });
  const pdfs = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url), ORIGEM);
    if (u.pathname === '/agentes/fiscal/api/v1/fiscal/nota-pdf/') {
      pdfs.push({ url: u.href, headers: init.headers || {} });
      return new Response(new Uint8Array([37, 80, 68, 70, 45]), {
        status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="nfse-1467.pdf"' }
      });
    }
    return base.fetch(url, init);
  };
  return { ...base, fetch, pdfs };
}

async function painel(respostas, caminho = '/agentes/fiscal/conta/') {
  const p = await abrir(caminho, { rede: rede(respostas), local: { 'nofiscal.sessao': sessaoValida() } });
  return p;
}

const linhaDe = (p, tenant) => p.$('fa-empresas-linhas').querySelector(`button[data-tenant="${tenant}"]`).closest('tr');
const botaoDe = (p, tenant, acao) => p.$('fa-empresas-linhas').querySelector(`button[data-tenant="${tenant}"][data-acao="${acao}"]`);
function mesAtual() {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return `${p.year}-${p.month}`;
}

test('abas e Meus dados do escritório', async () => {
  const p = await painel();
  assert.ok(p.visivel('fa-abas'));
  assert.equal(p.$('fa-abas').getAttribute('role'), 'tablist');
  // A aba Guias só aparece com o módulo ligado (conta-guias.test.mjs); sem ele, as abas de sempre.
  const abas = [...p.$('fa-abas').querySelectorAll('[role=tab]')].filter((a) => !a.hidden);
  assert.deepEqual(abas.map((a) => p.texto(a)), ['Meus dados', 'Minhas empresas', 'Emitir', 'Relatórios', 'NF-e', 'API']);
  assert.equal(p.visivel('fa-aba-guias'), false);
  assert.equal(p.$('fa-aba-dados').getAttribute('aria-selected'), 'true');
  assert.equal(p.$('fa-painel-dados').getAttribute('role'), 'tabpanel');
  assert.ok(p.visivel('fa-painel-dados'));
  assert.equal(p.visivel('fa-painel-empresas'), false);

  const t = p.textoVisivel();
  for (const s of ['Escritório', 'CONTABIL SANDRA LTDA', '11.222.333/0001-81', 'Sandra Teste', 'sandra@exemplo.com', '500 documentos · R$ 297/mês', '37 de 500', '05/12/2026']) {
    assert.ok(t.includes(s), `"${s}" em Meus dados`);
  }
  assert.equal(p.texto('fa-status'), 'Ativa');
  // Certificado, dados fiscais e apagar não ficam em Meus dados do escritório; o botão Inicial/Pro some.
  assert.equal(p.visivel('certificado'), false);
  assert.equal(p.visivel('fa-secao-fiscal'), false);
  assert.equal(p.visivel('fa-secao-apagar'), false);
  assert.equal(p.visivel('fa-trocar-plano'), false);
  assert.ok(p.visivel('fa-abrir-cartao'));
  assert.ok(p.visivel('fa-secao-cancelar'));
  assert.equal(p.visivel('fa-retomar'), false);

  // Trocar faixa: as cinco faixas por volume, a atual marcada; confirma antes de chamar.
  await p.clicar('fa-abrir-faixas');
  const faixas = [...p.$('fa-faixas-lista').querySelectorAll('button')];
  assert.deepEqual(faixas.map((b) => b.querySelector('b').textContent), ['500 documentos', '1.000 documentos', '2.000 documentos', '5.000 documentos', '10.000 documentos']);
  assert.ok(p.texto(faixas[1]).includes('R$ 497/mês') && p.texto(faixas[2]).includes('R$ 797/mês') && p.texto(faixas[4]).includes('R$ 2.497/mês'));
  assert.ok(p.texto(faixas[2]).includes('empresas ilimitadas'));
  assert.equal(faixas[0].disabled, true);
  await p.clicar(faixas[2]);
  assert.equal(p.rede.de('fiscal-conta:trocar_plano').length, 0, 'só pergunta');
  assert.match(p.texto('fa-faixa-pergunta'), /^Trocar para a faixa 2\.000 documentos, R\$ 797\/mês\?/);
  await p.clicar('fa-faixa-sim');
  assert.deepEqual(p.rede.de('fiscal-conta:trocar_plano')[0].corpo, { acao: 'trocar_plano', plano: 'escritorio_20' });
});

test('troca de faixa recusada e aba pelo endereço', async () => {
  const p = await painel({
    'fiscal-conta:trocar_plano': r(409, { ok: false, error_code: 'EMPRESAS_ACIMA_DO_LIMITE', mensagem: 'Você tem 6 empresas ativas, e esta faixa permite até 5. Desative empresas antes de trocar.' }),
    'fiscal-conta:estado': r(200, estadoEscritorio({}, { plano: 'escritorio_20', max_empresas: 20, empresas_ativas: 6 }))
  }, '/agentes/fiscal/conta/#empresas');
  // Recarregar com #empresas abre a aba.
  assert.equal(p.$('fa-aba-empresas').getAttribute('aria-selected'), 'true');
  assert.ok(p.visivel('fa-painel-empresas'));
  assert.equal(p.visivel('fa-painel-dados'), false);
  await p.clicar('fa-aba-dados');
  assert.equal(p.window.location.hash, '#dados');
  await p.clicar('fa-abrir-faixas');
  const cinco = p.$('fa-faixas-lista').querySelector('[data-faixa="escritorio_5"]');
  // A faixa não limita empresas (23/11/2026): o botão não avisa; a recusa que sobra vem do servidor (pacote da conta).
  assert.equal(p.texto(cinco).includes('Você tem 6 empresas ativas'), false);
  await p.clicar(cinco);
  await p.clicar('fa-faixa-sim');
  assert.equal(p.texto('fa-aviso-plano'), 'Você tem 6 empresas ativas, e esta faixa permite até 5. Desative empresas antes de trocar.');
  // Teclado: seta para a direita leva à aba seguinte.
  p.$('fa-aba-dados').dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await p.esvaziar();
  assert.equal(p.$('fa-aba-empresas').getAttribute('aria-selected'), 'true');
  assert.equal(p.window.document.activeElement, p.$('fa-aba-empresas'));
});

test('Minhas empresas: situações e ações por linha', async () => {
  const p = await painel({
    'fiscal-conta:empresa_configurar': (c) => ({ status: 200, corpo: estadoEscritorio() }),
    'fiscal-conta:empresa_ativar': (c) => ({ status: 200, corpo: estadoEscritorio() })
  });
  await p.clicar('fa-aba-empresas');
  assert.equal(p.window.location.hash, '#empresas');
  const linhas = [...p.$('fa-empresas-linhas').querySelectorAll('tr')];
  assert.equal(linhas.length, 5);
  const situacoes = linhas.map((l) => p.texto(l.querySelector('.nf-status')));
  assert.deepEqual(situacoes, ['Falta certificado A1', 'Pronta', 'Certificado vence em 12 dias', 'Desativada', 'Faltam dados fiscais']);
  assert.ok(p.texto(linhas[0]).includes('Escritório'), 'a empresa do escritório tem o selo');
  assert.equal(botaoDe(p, TENANT, 'desativar'), null, 'a empresa principal não se desativa');
  assert.equal(p.texto(botaoDe(p, EMP_PRONTA, 'cert')), 'Trocar A1');
  assert.equal(p.texto(botaoDe(p, TENANT, 'cert')), 'Enviar A1');
  assert.equal(botaoDe(p, EMP_OFF, 'cert'), null, 'desativada: só Reativar');
  assert.ok(botaoDe(p, EMP_OFF, 'reativar'));
  assert.ok(p.texto('fa-empresas-resumo').startsWith('4 empresas ativas, sem limite de empresas no seu plano.'));

  // Enviar o A1 de uma empresa: o mesmo endpoint, com o tenant_id da linha.
  await p.clicar(botaoDe(p, EMP_PRONTA, 'cert'));
  assert.ok(p.visivel('fa-form-emp-cert'));
  assert.equal(p.texto('fa-empresa-acao-titulo'), 'Certificado A1 de PADARIA BOA LTDA');
  await p.enviar('fa-form-emp-cert');
  assert.equal(p.texto('fa-emp-pfx-erro'), 'Escolha o arquivo do certificado.');
  await p.arquivos('fa-emp-pfx', [['padaria.pfx', new Uint8Array([1, 2]), 'application/x-pkcs12']]);
  await p.preencher('fa-emp-pfx-senha', 'segredo');
  await p.enviar('fa-form-emp-cert');
  const [cert] = p.rede.de('app:certificate');
  assert.equal(cert.corpo.tenant_id, EMP_PRONTA);
  assert.equal(cert.headers.authorization, 'Bearer at-0');
  assert.equal(p.visivel('fa-empresa-acao'), false);
  assert.equal(p.texto('fa-aviso-empresas'), 'Certificado de CLINICA AURORA LTDA válido até 31/03/2027');
  assert.ok(p.rede.de('fiscal-conta:estado').length >= 2, 'recarrega as situações');

  // A1 recusado: o mesmo texto do formulário de certificado.
  const q = await painel({ 'app:certificate': r(422, { error: { code: 'CERT_CNPJ_DIFERENTE', message: 'x' } }) }, '/agentes/fiscal/conta/#empresas');
  await q.clicar(botaoDe(q, EMP_VENCENDO, 'cert'));
  await q.arquivos('fa-emp-pfx', [['outro.pfx', new Uint8Array([1]), 'application/x-pkcs12']]);
  await q.preencher('fa-emp-pfx-senha', 'x');
  await q.enviar('fa-form-emp-cert');
  assert.equal(q.texto('fa-aviso-emp-cert'), 'Este certificado é de outro CNPJ');

  // Dados fiscais de uma empresa MEI: sem o % do Simples; o código vem da busca na lista nacional.
  await p.clicar(botaoDe(p, EMP_MEI, 'fiscal'));
  assert.ok(p.visivel('fa-form-emp-fiscal'));
  assert.equal(p.visivel('fa-emp-campo-percentual'), false);
  await p.esvaziar(40);
  await p.preencher('fa-emp-busca-codigo', 'Medicina');
  const opcao = p.$('fa-emp-seletor').querySelector('.nf-resultados input[value="040101"]');
  assert.ok(opcao, 'a busca mostra o código');
  opcao.checked = true;
  opcao.dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.preencher('fa-emp-nbs', '1.1502.10.00');
  await p.enviar('fa-form-emp-fiscal');
  assert.deepEqual(p.rede.de('fiscal-conta:empresa_configurar')[0].corpo, { acao: 'empresa_configurar', tenant_id: EMP_MEI, codigo_servico_nacional: '040101', nbs_padrao: '115021000' });
  assert.equal(p.texto('fa-aviso-empresas'), 'Dados fiscais de JOANA MEI salvos.');

  // Simples: com o % (já preenchido) e o código atual escolhido.
  await p.clicar(botaoDe(p, EMP_PRONTA, 'fiscal'));
  assert.ok(p.visivel('fa-emp-campo-percentual'));
  assert.equal(p.$('fa-emp-percentual').value, '6,5');
  await p.esvaziar(40);
  await p.preencher('fa-emp-percentual', '7');
  await p.enviar('fa-form-emp-fiscal');
  assert.deepEqual(p.rede.de('fiscal-conta:empresa_configurar')[1].corpo, { acao: 'empresa_configurar', tenant_id: EMP_PRONTA, codigo_servico_nacional: '170201', nbs_padrao: null, p_tot_trib_sn: 7 });

  // Desativar pergunta antes; reativar vai direto.
  await p.clicar(botaoDe(p, EMP_PRONTA, 'desativar'));
  assert.ok(p.visivel('fa-confirmar-desativar'));
  assert.match(p.texto('fa-desativar-pergunta'), /^Desativar PADARIA BOA LTDA\? Ela para de emitir/);
  assert.equal(p.rede.de('fiscal-conta:empresa_ativar').length, 0);
  await p.clicar('fa-desativar-sim');
  assert.deepEqual(p.rede.de('fiscal-conta:empresa_ativar')[0].corpo, { acao: 'empresa_ativar', tenant_id: EMP_PRONTA, ativa: false });
  assert.equal(p.texto('fa-aviso-empresas'), 'Empresa desativada: PADARIA BOA LTDA.');
  await p.clicar(botaoDe(p, EMP_OFF, 'reativar'));
  assert.deepEqual(p.rede.de('fiscal-conta:empresa_ativar')[1].corpo, { acao: 'empresa_ativar', tenant_id: EMP_OFF, ativa: true });
});

test('atualizar dados da Receita de empresa já cadastrada', async () => {
  // Caso de 19/11/2026: a empresa mudou de razão social na Receita; o painel não deixava corrigir.
  const renomeada = () => {
    const lista = empresas();
    lista[1] = { ...lista[1], razao_social: 'PADARIA NOVA ERA LTDA' };
    return estadoEscritorio({}, { empresas: lista });
  };
  let resposta = () => ({ status: 200, corpo: { ...renomeada(), atualizada: { tenant_id: EMP_PRONTA, mudou: ['razao_social'], antes: { razao_social: 'PADARIA BOA LTDA' }, depois: { razao_social: 'PADARIA NOVA ERA LTDA', regime: 'simples' } } } });
  const p = await painel({ 'fiscal-conta:empresa_atualizar_receita': (c) => resposta(c) }, '/agentes/fiscal/conta/#empresas');

  // Botão em cada empresa ativa (inclusive a do escritório); a desativada não tem.
  for (const t of [TENANT, EMP_PRONTA, EMP_VENCENDO, EMP_MEI]) assert.equal(p.texto(botaoDe(p, t, 'receita')), 'Atualizar dados da Receita');
  assert.equal(botaoDe(p, EMP_OFF, 'receita'), null);
  assert.equal(botaoDe(p, EMP_PRONTA, 'receita').getAttribute('aria-label'), 'Atualizar dados da Receita: PADARIA BOA LTDA');

  await p.clicar(botaoDe(p, EMP_PRONTA, 'receita'));
  assert.deepEqual(p.rede.de('fiscal-conta:empresa_atualizar_receita')[0].corpo, { acao: 'empresa_atualizar_receita', tenant_id: EMP_PRONTA });
  assert.equal(p.texto(linhaDe(p, EMP_PRONTA).querySelector('th')), 'PADARIA NOVA ERA LTDA', 'a linha mostra o nome novo');
  assert.equal(p.texto('fa-aviso-empresas'), 'Dados atualizados pela Receita Federal: razão social agora é PADARIA NOVA ERA LTDA.');
  assert.equal(p.visivel('fa-empresa-acao'), false, 'não abre painel: é uma ação só');

  // Já igual à Receita.
  resposta = () => ({ status: 200, corpo: { ...renomeada(), atualizada: { tenant_id: EMP_PRONTA, mudou: [], antes: {}, depois: {} } } });
  await p.clicar(botaoDe(p, EMP_PRONTA, 'receita'));
  assert.equal(p.texto('fa-aviso-empresas'), 'Os dados de PADARIA NOVA ERA LTDA já estão iguais aos da Receita Federal.');

  // MEI que virou Simples: avisa do percentual, com atalho para os dados fiscais.
  resposta = () => ({ status: 200, corpo: { ...estadoEscritorio(), atualizada: { tenant_id: EMP_MEI, mudou: ['regime'], antes: { regime: 'mei' }, depois: { razao_social: 'JOANA MEI', regime: 'simples' } } } });
  await p.clicar(botaoDe(p, EMP_MEI, 'receita'));
  assert.equal(p.texto('fa-aviso-empresas'), 'Dados atualizados pela Receita Federal: regime agora é Simples Nacional. Informe o percentual do Simples nos dados fiscais. Dados fiscais');
  await p.clicar(p.$('fa-aviso-empresas').querySelector('button[data-acao="fiscal"]'));
  assert.ok(p.visivel('fa-form-emp-fiscal'));
  assert.equal(p.texto('fa-empresa-acao-titulo'), 'Dados fiscais de JOANA MEI');

  // Saiu do Simples: o mesmo aviso do cadastro, e a linha não muda.
  resposta = () => ({ status: 422, corpo: { ok: false, error_code: 'CNPJ_FORA_DO_SIMPLES', mensagem: 'O nó.fiscal atende MEI e empresas do Simples Nacional. Na Receita Federal, este CNPJ não está no Simples', campo: 'cnpj' } });
  await p.clicar(botaoDe(p, EMP_VENCENDO, 'receita'));
  assert.equal(p.texto('fa-aviso-empresas'), 'Não atualizamos OFICINA RAPIDA LTDA. O nó.fiscal atende MEI e empresas do Simples Nacional. Na Receita Federal, este CNPJ não está no Simples.');
  assert.equal(p.texto(linhaDe(p, EMP_VENCENDO).querySelector('th')), 'OFICINA RAPIDA LTDA');

  // Receita fora do ar: a mensagem da função.
  resposta = () => ({ status: 503, corpo: { ok: false, error_code: 'CONSULTA_INDISPONIVEL', mensagem: 'Não conseguimos confirmar o CNPJ na Receita Federal agora. Tente de novo em alguns minutos.' } });
  await p.clicar(botaoDe(p, EMP_VENCENDO, 'receita'));
  assert.equal(p.texto('fa-aviso-empresas'), 'Não conseguimos confirmar o CNPJ na Receita Federal agora. Tente de novo em alguns minutos.');
});

test('adicionar empresa e limite da faixa', async () => {
  let resposta = r(409, { ok: false, error_code: 'EMPRESAS_ACIMA_DO_LIMITE', mensagem: 'Seu plano permite até 5 empresas.', limite: 5 });
  const p = await painel({ 'fiscal-conta:empresa_adicionar': (c, ch, m) => resposta(c, ch, m) }, '/agentes/fiscal/conta/#empresas');
  await p.clicar('fa-abrir-adicionar');
  assert.ok(p.visivel('fa-form-adicionar'));
  await p.preencher('fa-add-cnpj', '11.111.111/1111-11');
  await p.enviar('fa-form-adicionar');
  assert.equal(p.texto('fa-add-cnpj-erro'), 'CNPJ inválido. Confira os 14 números.');
  assert.equal(p.rede.de('fiscal-conta:empresa_adicionar').length, 0);

  await p.preencher('fa-add-cnpj', '11.444.777/0001-61');
  await p.enviar('fa-form-adicionar');
  assert.deepEqual(p.rede.de('fiscal-conta:empresa_adicionar')[0].corpo, { acao: 'empresa_adicionar', cnpj: '11444777000161' });
  assert.ok(p.texto('fa-aviso-adicionar').startsWith('Seu plano permite até 5 empresas.'));
  const irFaixa = p.$('fa-aviso-adicionar').querySelector('[data-ir-faixa]');
  assert.equal(p.texto(irFaixa), 'Trocar faixa');
  await p.clicar(irFaixa);
  assert.equal(p.$('fa-aba-dados').getAttribute('aria-selected'), 'true');
  assert.ok(p.visivel('fa-faixas'), 'abre as faixas');

  // Fora do Simples: o texto do servidor vai para o campo.
  resposta = r(422, { ok: false, error_code: 'CNPJ_FORA_DO_SIMPLES', campo: 'cnpj', mensagem: 'O nó.fiscal atende MEI e empresas do Simples Nacional. Na Receita Federal, este CNPJ não está no Simples' });
  await p.clicar('fa-aba-empresas');
  await p.enviar('fa-form-adicionar');
  assert.equal(p.texto('fa-add-cnpj-erro'), 'O nó.fiscal atende MEI e empresas do Simples Nacional. Na Receita Federal, este CNPJ não está no Simples');

  // Adicionada: a tabela vem do estado devolvido.
  const novo = empresas().concat([{ tenant_id: '1a2b3c4d-0000-4000-8000-000000000006', cnpj: '11444777000161', razao_social: 'CLIENTE NOVO LTDA', regime: 'simples', principal: false, ativa: true, certificado: null, notas_mes: 0, situacao: 'falta_certificado' }]);
  resposta = r(200, { ...estadoEscritorio({}, { empresas: novo, empresas_ativas: 5 }), adicionada: { tenant_id: '1a2b3c4d-0000-4000-8000-000000000006', reativada: false } });
  await p.enviar('fa-form-adicionar');
  assert.equal(p.visivel('fa-form-adicionar'), false);
  assert.equal(p.$('fa-empresas-linhas').querySelectorAll('tr').length, 6);
  assert.match(p.texto('fa-aviso-empresas'), /^Empresa adicionada\. Agora escolha como ela vai assinar as notas: com o certificado A1 dela ou com procuração ao escritório\./);
  // A escolha já vem no aviso, com o tenant_id da empresa nova.
  const escolhas = [...p.$('fa-aviso-empresas').querySelectorAll('button[data-acao]')].map((b) => [b.getAttribute('data-acao'), b.getAttribute('data-tenant'), p.texto(b)]);
  assert.deepEqual(escolhas, [
    ['cert', '1a2b3c4d-0000-4000-8000-000000000006', 'Enviar o A1 da empresa'],
    ['proc', '1a2b3c4d-0000-4000-8000-000000000006', 'Usar procuração ao escritório']
  ]);
  await p.clicar(p.$('fa-aviso-empresas').querySelector('button[data-acao="proc"]'));
  assert.ok(p.visivel('fa-emp-proc'), 'abre a procuração da empresa nova');
  assert.equal(p.texto('fa-empresa-acao-titulo'), 'Procuração de CLIENTE NOVO LTDA');
  assert.deepEqual(p.rede.de('app:procuracao:consultar').at(-1).corpo, { tenant_id: '1a2b3c4d-0000-4000-8000-000000000006', acao: 'consultar' });
});

test('procuração da empresa cliente ao escritório', async () => {
  const p = await painel({}, '/agentes/fiscal/conta/#empresas');
  // A empresa do escritório é a procuradora: assina com o A1 dela e não tem a ação.
  assert.equal(botaoDe(p, TENANT, 'proc'), null);
  assert.equal(p.texto(botaoDe(p, EMP_VENCENDO, 'proc')), 'Procuração');
  await p.clicar(botaoDe(p, EMP_VENCENDO, 'proc'));
  assert.ok(p.visivel('fa-emp-proc'));
  assert.equal(p.visivel('fa-form-emp-cert'), false);
  assert.equal(p.texto('fa-empresa-acao-titulo'), 'Procuração de OFICINA RAPIDA LTDA');
  assert.equal(p.texto('fa-emp-proc-doc'), '11.222.333/0001-81', 'o procurador é o CNPJ do escritório');
  assert.match(p.texto('fa-emp-proc'), /o escritório assina as notas desta empresa com o certificado A1 do escritório/);
  assert.match(p.texto('fa-emp-proc'), /Procuração antiga do e-CAC sem o serviço NFS-e não vale/);
  assert.doesNotMatch(p.texto('fa-emp-proc'), /60\.342\.339|NO TECH/i, 'a nó não aparece como procuradora');

  await p.preencher('fa-emp-proc-validade', '2099-12-31');
  await p.enviar('fa-emp-proc-form');
  assert.deepEqual(p.rede.de('app:procuracao:declarar')[0].corpo, { tenant_id: EMP_VENCENDO, acao: 'declarar', valida_ate: '2099-12-31' });
  assert.equal(p.texto('fa-emp-proc-aviso'), 'Procuração conferida na Receita: as notas desta empresa saem assinadas pelo escritório.');
});

test('procuração pendente e escritório sem A1', async () => {
  const pendente = () => ({
    status: 200,
    corpo: { ...procuracaoInfo({ modo: 'procuracao', procuracao: procuracaoGravada({ status: 'declarada', ultimo_erro: 'E2245' }) }), conferencia: 'nao_encontrada' }
  });
  const p = await painel({ 'app:procuracao:declarar': pendente }, '/agentes/fiscal/conta/#empresas');
  await p.clicar(botaoDe(p, EMP_MEI, 'proc'));
  await p.enviar('fa-emp-proc-form');
  assert.match(p.texto('fa-emp-proc-aviso'), /A Receita ainda não mostra a procuração/);
  assert.ok(p.visivel('fa-emp-proc-conferir'), 'oferece conferir de novo');

  const q = await painel({
    'app:procuracao:consultar': () => ({ status: 200, corpo: procuracaoInfo({ disponivel: false, motivo: 'ESCRITORIO_SEM_CERTIFICADO', procurador: null }) })
  }, '/agentes/fiscal/conta/#empresas');
  await q.clicar(botaoDe(q, EMP_MEI, 'proc'));
  assert.match(q.texto('fa-emp-proc-indisponivel'), /o escritório precisa ter o próprio certificado A1/);
  assert.equal(q.visivel('fa-emp-proc-passos'), false);
});

test('Relatórios: totais, tabela, entregas e PDF', async () => {
  const p = await painel({
    'fiscal-conta:relatorio': (c) => ({
      status: 200,
      corpo: c.mes === mesAtual() && !c.tenant_id
        ? { ok: true, mes: c.mes, tenant_id: null, totais: { emitidas: 1, valor_emitido: 1500.5, recusadas: 1, na_fila: 0, canceladas: 0 }, notas: NOTAS }
        : { ok: true, mes: c.mes, tenant_id: c.tenant_id || null, totais: { emitidas: 0, valor_emitido: 0, recusadas: 0, na_fila: 0, canceladas: 0 }, notas: [] }
    })
  });
  assert.equal(p.rede.de('fiscal-conta:relatorio').length, 0, 'só carrega ao abrir a aba');
  await p.clicar('fa-aba-relatorios');
  assert.equal(p.window.location.hash, '#relatorios');
  assert.deepEqual(p.rede.de('fiscal-conta:relatorio')[0].corpo, { acao: 'relatorio', mes: mesAtual() });
  assert.equal(p.$('fa-rel-mes').value, mesAtual(), 'padrão: mês atual');
  assert.equal(p.$('fa-rel-empresa').options.length, 6, 'todas + as cinco empresas');
  assert.equal(p.texto('fa-rel-emitidas'), '1');
  assert.equal(p.texto('fa-rel-valor'), 'R$ 1.500,50');
  assert.equal(p.texto('fa-rel-recusadas'), '1');
  assert.equal(p.texto('fa-rel-fila'), '0');

  const linhas = [...p.$('fa-notas-linhas').querySelectorAll('tr')];
  assert.equal(linhas.length, 2);
  const celulas = [...linhas[0].querySelectorAll('td')].map((td) => p.texto(td));
  assert.equal(celulas[0], '04/11/2026');
  assert.ok(celulas[1].startsWith('PADARIA BOA LTDA'));
  assert.ok(celulas[2].startsWith('Tomador Um'));
  assert.equal(celulas[3], 'Honorários contábeis');
  assert.equal(celulas[4], '17.02.01');
  assert.equal(celulas[5], '1.500,50');
  assert.equal(celulas[6], 'Emitida');
  assert.ok(celulas[7].includes('✓ fin@tomador.test e-mail · enviado'), celulas[7]);
  assert.ok(celulas[7].includes('✗ (11) 99999-0000 WhatsApp · falhou'), celulas[7]);
  assert.ok(p.texto(linhas[1]).includes('Recusada') && p.texto(linhas[1]).includes('E0712 código inválido'));
  assert.equal(linhas[1].querySelector('[data-pdf]'), null, 'recusada: sem PDF');

  // PDF: GET com a sessão e download com o nome que a rota manda.
  const criados = [];
  const cliques = [];
  p.window.URL.createObjectURL = (b) => { criados.push(b); return 'blob:nota'; };
  p.window.URL.revokeObjectURL = () => {};
  p.window.HTMLAnchorElement.prototype.click = function () { cliques.push({ href: this.href, download: this.download }); };
  await p.clicar(linhas[0].querySelector('[data-pdf]'));
  assert.equal(p.rede.pdfs.length, 1);
  assert.equal(p.rede.pdfs[0].url, `${ORIGEM}/agentes/fiscal/api/v1/fiscal/nota-pdf/?invoice_id=${NOTA}`);
  assert.equal(p.rede.pdfs[0].headers.Authorization, 'Bearer at-0');
  assert.equal(criados.length, 1);
  assert.deepEqual(cliques, [{ href: 'blob:nota', download: 'nfse-1467.pdf' }]);

  // Uma empresa e um mês sem notas.
  p.$('fa-rel-empresa').value = EMP_PRONTA;
  p.$('fa-rel-empresa').dispatchEvent(new p.window.Event('change', { bubbles: true }));
  await p.esvaziar(60);
  assert.deepEqual(p.rede.de('fiscal-conta:relatorio').at(-1).corpo, { acao: 'relatorio', mes: mesAtual(), tenant_id: EMP_PRONTA });
  const nomeDoMes = p.$('fa-rel-mes').selectedOptions[0].textContent;
  assert.equal(p.texto('fa-rel-vazio'), `Nenhuma nota em ${nomeDoMes}`);
  assert.equal(p.visivel('fa-rel-rolagem'), false);
});

test('conta Inicial/Pro continua sem abas', async () => {
  const p = await abrir('/agentes/fiscal/conta/', { rede: superficie(), local: { 'nofiscal.sessao': sessaoValida() } });
  assert.equal(p.visivel('fa-abas'), false);
  assert.ok(p.visivel('certificado'));
  assert.ok(p.visivel('fa-secao-fiscal'));
  assert.ok(p.visivel('fa-secao-apagar'));
  assert.ok(p.visivel('fa-trocar-plano'));
  assert.equal(p.visivel('fa-painel-empresas'), false);
  assert.equal(p.visivel('fa-painel-relatorios'), false);
  assert.equal(p.$('fa-painel-dados').getAttribute('role'), null);
  assert.equal(p.texto('fa-empresa-titulo'), 'Empresa');
  assert.equal(p.rede.de('fiscal-conta:relatorio').length, 0);
});

test('situação mostra quem emite por procuração e o que falta à empresa cliente', async () => {
  const lista = empresas().map((e) =>
    e.tenant_id === EMP_PRONTA ? { ...e, modo_autenticacao: 'procuracao', procuracao: { status: 'confirmada', valida_ate: null } }
      : e.tenant_id === EMP_VENCENDO ? { ...e, certificado: null, situacao: 'falta_certificado' }
      : e);
  const p = await painel({ 'fiscal-conta:estado': r(200, estadoEscritorio({}, { empresas: lista })) }, '/agentes/fiscal/conta/#empresas');
  assert.equal(p.texto(linhaDe(p, TENANT).querySelector('.nf-status')), 'Falta certificado A1', 'o escritório só resolve com o A1 dele');
  assert.equal(p.texto(linhaDe(p, EMP_VENCENDO).querySelector('.nf-status')), 'Falta A1 ou procuração');
  assert.equal(p.texto(linhaDe(p, EMP_PRONTA).querySelector('.nf-por-procuracao')), 'por procuração ao escritório');
  assert.equal(linhaDe(p, EMP_VENCENDO).querySelector('.nf-por-procuracao'), null);
});

test('pacote por notas: limite da conta no resumo e nas faixas', async () => {
  const p = await painel({
    'fiscal-conta:estado': r(200, estadoEscritorio({}, { plano: 'escritorio_20', max_empresas: 200, max_empresas_override: 200, empresas_ativas: 180, notas_limite: 2000 }))
  }, '/agentes/fiscal/conta/#empresas');
  assert.ok(p.texto('fa-empresas-resumo').startsWith('180 de 200 empresas ativas no seu pacote.'));
  // Com pacote, o limite vale em qualquer faixa: nenhuma faixa avisa "Você tem 180 empresas ativas".
  await p.clicar('fa-aba-dados');
  assert.ok(p.texto('fa-plano-uso').includes('180 de 200'));
  await p.clicar('fa-abrir-faixas');
  assert.equal(p.texto(p.$('fa-faixas-lista')).includes('Você tem 180 empresas ativas'), false);
});

test('Emitir: nota avulsa conferida antes de emitir e lote por planilha com confirmação', async () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const LOTE_ID = '5e5e5e5e-0000-4000-8000-000000000001';
  const contexto = {
    empresas: [
      { tenant_id: TENANT, razao_social: 'CONTABIL SANDRA LTDA', cnpj: '11222333000181', principal: true, codigo_servico_nacional: '170201', bloqueio: null },
      { tenant_id: EMP_PRONTA, razao_social: 'PADARIA BOA LTDA', cnpj: '11444777000161', principal: false, codigo_servico_nacional: '170201', bloqueio: null },
      { tenant_id: EMP_VENCENDO, razao_social: 'OFICINA RAPIDA LTDA', cnpj: '04252011000110', principal: false, codigo_servico_nacional: '170201', bloqueio: { codigo: 'CERT_EXPIRED', motivo: 'o certificado A1 de OFICINA RAPIDA LTDA venceu' } }
    ],
    franquia: { limite: 500, no_mes: 37 }
  };
  const resumo = {
    resumo: {
      empresa: { tenant_id: EMP_PRONTA, razao_social: 'PADARIA BOA LTDA', cnpj: '11444777000161' },
      tomador: { documento: '52998224725', tipo: 'cpf', nome: 'Maria Tomadora', email: 'maria@tomador.test' },
      servico: { codigo: '170201', nome: 'Contabilidade', descricao: 'Honorários de novembro' },
      valor: '350.00', valor_texto: 'R$ 350,00'
    },
    bloqueio: null,
    avisos: ['Já há uma nota igual neste mês (mesma empresa, cliente e valor). Confira antes de emitir de novo.']
  };
  const lote = {
    lote_id: LOTE_ID, status: 'aguardando_confirmacao', arquivo: 'novembro.csv', expira_em: '2026-11-17T15:30:00.000Z',
    linhas: 3, prontas: 2, total: '1150.00',
    por_empresa: [
      { tenant_id: TENANT, razao_social: 'CONTABIL SANDRA LTDA', notas: 1, total: '150.00' },
      { tenant_id: EMP_PRONTA, razao_social: 'PADARIA BOA LTDA', notas: 1, total: '1000.00' }
    ],
    problemas: [{ linha: 4, codigo: 'CERT_EXPIRED', motivo: 'o certificado A1 de OFICINA RAPIDA LTDA venceu' }],
    franquia: { limite: 500, no_mes: 499, acima: 1 },
    resumo_texto: 'Li a planilha novembro.csv: 3 linhas.'
  };
  const p = await painel({
    'app:emissao:contexto': r(200, contexto),
    'app:emissao:modelos': (c) => ({
      status: 200,
      corpo: { modelos: c.tenant_id === EMP_PRONTA ? [{ id: 'm1', nome: 'Prontia', documento: '11444777000161', nome_tomador: 'Prontia Ltda', email: 'fin@prontia.test', codigo: '170201', descricao: 'Consultoria mensal', valor_padrao: '350.00' }] : [] }
    }),
    'app:emissao:avulsa_conferir': r(200, resumo),
    'app:emissao:avulsa_emitir': r(200, { invoice_id: NOTA, status: 'queued' }),
    'app:emissao:lote_ler': r(200, lote),
    'app:emissao:lote_confirmar': r(200, { emitindo: 2, barradas: [] }),
    'fiscal-conta:relatorio': (c) => ({ status: 200, corpo: { ok: true, mes: c.mes, tenant_id: null, totais: { emitidas: 0, valor_emitido: 0, recusadas: 0, na_fila: 2, canceladas: 0 }, notas: [] } })
  });
  assert.equal(p.rede.de('app:emissao:contexto').length, 0, 'só carrega ao abrir a aba');
  await p.clicar('fa-aba-emitir');
  assert.equal(p.window.location.hash, '#emitir');
  assert.ok(p.visivel('fa-painel-emitir'));
  assert.equal(p.rede.de('app:emissao:contexto').length, 1);
  assert.deepEqual([...p.$('fa-av-empresa').options].map((o) => p.texto(o)), [
    'CONTABIL SANDRA LTDA (escritório) · 11.222.333/0001-81', 'PADARIA BOA LTDA · 11.444.777/0001-61', 'OFICINA RAPIDA LTDA · 04.252.011/0001-10'
  ]);

  // Empresa bloqueada: o mesmo motivo do agente, com o caminho para resolver.
  await p.preencher('fa-av-empresa', EMP_VENCENDO);
  assert.ok(p.visivel('fa-av-bloqueio'));
  assert.equal(p.texto('fa-av-bloqueio'), 'Esta empresa não emite agora: o certificado A1 de OFICINA RAPIDA LTDA venceu. Resolver em Minhas empresas');

  // Cliente salvo preenche o formulário; "Cliente novo" limpa.
  await p.preencher('fa-av-empresa', EMP_PRONTA);
  assert.equal(p.visivel('fa-av-bloqueio'), false);
  assert.deepEqual(p.rede.de('app:emissao:modelos').map((c) => c.corpo.tenant_id), [TENANT, EMP_VENCENDO, EMP_PRONTA]);
  assert.deepEqual([...p.$('fa-av-modelo').options].map((o) => p.texto(o)), ['Cliente novo', 'Prontia · 11.444.777/0001-61']);
  await p.preencher('fa-av-modelo', '0');
  assert.deepEqual(['fa-av-documento', 'fa-av-nome', 'fa-av-email', 'fa-av-valor', 'fa-av-descricao'].map((id) => p.$(id).value),
    ['11.444.777/0001-61', 'Prontia Ltda', 'fin@prontia.test', '350,00', 'Consultoria mensal']);
  await p.preencher('fa-av-modelo', '');
  assert.equal(p.$('fa-av-nome').value, '');

  // Conferir: sem documento válido nem chama o servidor.
  await p.preencher('fa-av-documento', '123');
  await p.enviar('fa-form-avulsa');
  assert.equal(p.texto('fa-av-documento-erro'), 'CPF ou CNPJ inválido. Confira os números.');
  assert.equal(p.rede.de('app:emissao:avulsa_conferir').length, 0);

  await p.preencher('fa-av-documento', '529.982.247-25');
  await p.preencher('fa-av-nome', 'Maria Tomadora');
  await p.preencher('fa-av-email', 'maria@tomador.test');
  await p.preencher('fa-av-valor', '350');
  await p.preencher('fa-av-descricao', 'Honorários de novembro');
  await p.enviar('fa-form-avulsa');
  assert.deepEqual(p.rede.de('app:emissao:avulsa_conferir')[0].corpo, {
    tenant_id: EMP_PRONTA, documento: '529.982.247-25', nome: 'Maria Tomadora', email: 'maria@tomador.test', valor: '350',
    codigo: '170201', descricao: 'Honorários de novembro', retem_iss: false, retem_inss: false, acao: 'avulsa_conferir'
  });
  assert.ok(p.visivel('fa-av-resumo'));
  assert.equal(p.visivel('fa-form-avulsa'), false);
  const doResumo = p.texto('fa-av-resumo');
  for (const s of ['PADARIA BOA LTDA · 11.444.777/0001-61', 'Maria Tomadora', '529.982.247-25', 'maria@tomador.test', '17.02.01 Contabilidade', 'Honorários de novembro', 'R$ 350,00', 'Já há uma nota igual neste mês']) {
    assert.ok(doResumo.includes(s), `"${s}" no resumo`);
  }
  assert.equal(p.rede.de('app:emissao:avulsa_emitir').length, 0, 'só emite no segundo clique');

  // Emitir: o mesmo pedido conferido, com uma chave (idempotência no servidor).
  await p.clicar('fa-av-emitir');
  const emitir = p.rede.de('app:emissao:avulsa_emitir');
  assert.equal(emitir.length, 1);
  assert.match(emitir[0].corpo.chave, UUID);
  assert.equal(emitir[0].corpo.tenant_id, EMP_PRONTA);
  assert.equal(emitir[0].corpo.valor, '350');
  assert.ok(p.visivel('fa-form-avulsa'));
  assert.equal(p.$('fa-av-nome').value, '');
  assert.match(p.texto('fa-aviso-emitir'), /^Nota de Maria Tomadora na fila da Sefin\./);

  // Lote: sem arquivo, avisa; com a planilha, mostra o resumo e só emite no "confirmar".
  await p.enviar('fa-form-lote');
  assert.equal(p.texto('fa-lote-arquivo-erro'), 'Escolha a planilha (.xlsx ou .csv).');
  await p.arquivos('fa-lote-arquivo', [['novembro.csv', 'cnpj_prestador;cpf_cnpj_tomador;nome_tomador;valor\n', 'text/csv']]);
  await p.enviar('fa-form-lote');
  const ler = p.rede.de('app:emissao:lote_ler');
  assert.equal(ler.length, 1);
  assert.equal(ler[0].corpo.arquivo.name, 'novembro.csv');
  assert.equal(p.texto('fa-lote-resumo-titulo'), 'Planilha novembro.csv: 3 linhas');
  assert.deepEqual(['fa-lote-linhas', 'fa-lote-prontas', 'fa-lote-total', 'fa-lote-problemas-n'].map((id) => p.texto(id)), ['3', '2', 'R$ 1.150', '1']);
  assert.match(p.texto('fa-lote-empresas'), /PADARIA BOA LTDA: 1 nota, R\$ 1\.000/);
  assert.equal(p.texto('fa-lote-franquia'), 'Franquia: com estas notas, o mês chega a 501 notas, 1 acima das 500 do seu plano. As notas saem normalmente.');
  assert.deepEqual([...p.$('fa-lote-problemas').querySelectorAll('td')].map((td) => p.texto(td)), ['4', 'o certificado A1 de OFICINA RAPIDA LTDA venceu']);
  assert.equal(p.texto('fa-lote-confirmar'), 'Emitir as 2 notas prontas');
  assert.equal(p.rede.de('app:emissao:lote_confirmar').length, 0);
  await p.clicar('fa-lote-confirmar');
  assert.deepEqual(p.rede.de('app:emissao:lote_confirmar')[0].corpo, { acao: 'lote_confirmar', lote_id: LOTE_ID });
  assert.equal(p.visivel('fa-lote-resumo'), false);
  assert.match(p.texto('fa-aviso-lote'), /^Confirmado: 2 notas na fila da Sefin\. Cada cliente com e-mail recebe a nota\./);

  // "Ver em Relatórios" leva à aba, que busca de novo.
  await p.clicar(p.$('fa-aviso-lote').querySelector('[data-ir-aba]'));
  assert.equal(p.window.location.hash, '#relatorios');
  assert.equal(p.rede.de('fiscal-conta:relatorio').length, 1);
  assert.deepEqual(p.erros, []);
});

test('Emitir: planilha repetida oferece descartar a anterior, e bloqueio no emitir trava o botão', async () => {
  const ANTERIOR = '5e5e5e5e-0000-4000-8000-000000000002';
  const p = await painel({
    'app:emissao:contexto': r(200, { empresas: [{ tenant_id: TENANT, razao_social: 'CONTABIL SANDRA LTDA', cnpj: '11222333000181', principal: true, codigo_servico_nacional: '170201', bloqueio: null }], franquia: { limite: 500, no_mes: 0 } }),
    'app:emissao:modelos': r(200, { modelos: [] }),
    'app:emissao:lote_ler': r(422, { motivo: 'repetida', lote_id: ANTERIOR, error: { code: 'PLANILHA_RECUSADA', message: 'Esta planilha já foi lida e está esperando confirmação (aqui ou no WhatsApp). Descarte a anterior para ler de novo.' } }),
    'app:emissao:lote_descartar': r(200, { descartado: true }),
    'app:emissao:avulsa_conferir': r(200, { resumo: { empresa: { tenant_id: TENANT, razao_social: 'CONTABIL SANDRA LTDA', cnpj: '11222333000181' }, tomador: { documento: '52998224725', tipo: 'cpf', nome: 'Zé', email: null }, servico: { codigo: '170201', nome: null, descricao: 'Prestação de serviços' }, valor: '10.00', valor_texto: 'R$ 10,00' }, bloqueio: null, avisos: [] }),
    'app:emissao:avulsa_emitir': r(409, { bloqueio: 'PAYMENT_NOT_APPROVED', error: { code: 'EMISSAO_BLOQUEADA', message: 'Não dá para emitir: a assinatura da conta não está ativa.' } })
  }, '/agentes/fiscal/conta/#emitir');
  assert.ok(p.visivel('fa-painel-emitir'), 'abre na aba do endereço');

  await p.arquivos('fa-lote-arquivo', [['novembro.xlsx', 'PK', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]);
  await p.enviar('fa-form-lote');
  assert.match(p.texto('fa-aviso-lote'), /^Esta planilha já foi lida e está esperando confirmação/);
  await p.clicar(p.$('fa-aviso-lote').querySelector('[data-descartar-lote]'));
  assert.deepEqual(p.rede.de('app:emissao:lote_descartar')[0].corpo, { acao: 'lote_descartar', lote_id: ANTERIOR });
  assert.match(p.texto('fa-aviso-lote'), /^A planilha anterior foi descartada\./);

  await p.preencher('fa-av-documento', '52998224725');
  await p.preencher('fa-av-nome', 'Zé');
  await p.preencher('fa-av-valor', '10');
  await p.enviar('fa-form-avulsa');
  await p.clicar('fa-av-emitir');
  assert.equal(p.$('fa-av-emitir').disabled, true);
  assert.equal(p.texto('fa-av-avisos'), 'Não dá para emitir: a assinatura da conta não está ativa.');
  assert.deepEqual(p.erros, []);
});

test('retenção: as caixas do Adicionar empresa viram o padrão; no Emitir vêm marcadas e aparecem no resumo', async () => {
  const NOVA = '1a2b3c4d-0000-4000-8000-000000000006';
  const novo = empresas().concat([{ tenant_id: NOVA, cnpj: '11444777000161', razao_social: 'CLIENTE NOVO LTDA', regime: 'simples', principal: false, ativa: true, certificado: null, notas_mes: 0, situacao: 'falta_certificado' }]);
  const padrao = { retem_iss: true, aliquota_iss: '2.50', retem_inss: true, inss_percentual: '11.00' };
  const contexto = {
    empresas: [
      { tenant_id: TENANT, razao_social: 'CONTABIL SANDRA LTDA', cnpj: '11222333000181', principal: true, codigo_servico_nacional: '170201', bloqueio: null, regime: 'simples', retencao: { retem_iss: false, aliquota_iss: null, retem_inss: false, inss_percentual: null } },
      { tenant_id: EMP_PRONTA, razao_social: 'PADARIA BOA LTDA', cnpj: '11444777000161', principal: false, codigo_servico_nacional: '170201', bloqueio: null, regime: 'simples', retencao: padrao },
      { tenant_id: EMP_MEI, razao_social: 'JOANA MEI', cnpj: '04252011000110', principal: false, codigo_servico_nacional: '170201', bloqueio: null, regime: 'mei', retencao: { retem_iss: false, aliquota_iss: null, retem_inss: false, inss_percentual: null } }
    ],
    franquia: { limite: 500, no_mes: 3 }
  };
  const resumo = {
    resumo: {
      empresa: { tenant_id: EMP_PRONTA, razao_social: 'PADARIA BOA LTDA', cnpj: '11444777000161' },
      tomador: { documento: '11222333000181', tipo: 'cnpj', nome: 'Clínica Saúde', email: null },
      servico: { codigo: '170201', nome: 'Contabilidade', descricao: 'Manutenção' },
      valor: '1500.00', valor_texto: 'R$ 1.500,00',
      retencao: { iss: { aliquota: '2.50', valor: '37.50' }, inss: { valor: '165.00' }, liquido: '1297.50' },
      endereco_tomador: { cMun: '3550308', cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', complemento: null, bairro: 'BELA VISTA' }
    },
    bloqueio: null,
    avisos: []
  };
  const p = await painel({
    'fiscal-conta:empresa_adicionar': r(200, { ...estadoEscritorio({}, { empresas: novo, empresas_ativas: 5 }), adicionada: { tenant_id: NOVA, reativada: false } }),
    'app:emissao:empresa_retencao': (c) => ({ status: 200, corpo: { tenant_id: c.tenant_id, retencao: {} } }),
    'app:emissao:contexto': r(200, contexto),
    'app:emissao:modelos': r(200, { modelos: [] }),
    'app:emissao:avulsa_conferir': r(200, resumo)
  }, '/agentes/fiscal/conta/#empresas');

  // Adicionar empresa: marcar abre o campo; o campo errado nem chama o servidor.
  await p.clicar('fa-abrir-adicionar');
  assert.equal(p.visivel('fa-add-campo-iss'), false);
  await p.clicar('fa-add-retem-iss');
  assert.ok(p.visivel('fa-add-campo-iss'), 'marcar ISS abre a alíquota');
  await p.clicar('fa-add-retem-inss');
  assert.ok(p.visivel('fa-add-campo-inss'), 'marcar INSS abre o percentual');
  await p.preencher('fa-add-cnpj', '11.444.777/0001-61');
  await p.preencher('fa-add-aliquota-iss', '7');
  await p.enviar('fa-form-adicionar');
  assert.equal(p.texto('fa-add-aliquota-iss-erro'), 'Informe a alíquota do ISS retido, de 2% a 5% (por exemplo 2,5).');
  assert.equal(p.texto('fa-add-inss-erro'), 'Informe o percentual do INSS retido, por exemplo 11.');
  assert.equal(p.rede.de('fiscal-conta:empresa_adicionar').length, 0);

  await p.preencher('fa-add-aliquota-iss', '2,5');
  await p.preencher('fa-add-inss', '11');
  await p.enviar('fa-form-adicionar');
  assert.equal(p.rede.de('fiscal-conta:empresa_adicionar').length, 1);
  assert.deepEqual(p.rede.de('app:emissao:empresa_retencao')[0].corpo, {
    acao: 'empresa_retencao', tenant_id: NOVA, retem_iss: true, aliquota_iss: '2,5', retem_inss: true, inss_percentual: '11'
  });
  assert.match(p.texto('fa-aviso-empresas'), /^Empresa adicionada\. Retenção salva\. Agora escolha/);

  // Emitir: as caixas vêm com o padrão da empresa; MEI não vê as caixas.
  await p.clicar('fa-aba-emitir');
  await p.preencher('fa-av-empresa', EMP_MEI);
  assert.equal(p.visivel('fa-av-retencao'), false, 'MEI não tem retenção');
  await p.preencher('fa-av-empresa', EMP_PRONTA);
  assert.ok(p.visivel('fa-av-retencao'));
  assert.equal(p.$('fa-av-retem-iss').checked, true);
  assert.equal(p.$('fa-av-aliquota-iss').value, '2,5');
  assert.equal(p.$('fa-av-retem-inss').checked, true);
  assert.equal(p.$('fa-av-inss').value, '11%');

  await p.preencher('fa-av-documento', '11.222.333/0001-81');
  await p.preencher('fa-av-nome', 'Clínica Saúde');
  await p.preencher('fa-av-valor', '1500');
  await p.enviar('fa-form-avulsa');
  const corpo = p.rede.de('app:emissao:avulsa_conferir')[0].corpo;
  assert.deepEqual([corpo.retem_iss, corpo.aliquota_iss, corpo.retem_inss, corpo.inss], [true, '2,5', true, '11%']);
  const doResumo = p.texto('fa-av-resumo');
  for (const s of ['ISS retido pelo tomador', '2,5% (R$ 37,50)', 'INSS retido', 'R$ 165,00', 'Valor líquido', 'R$ 1.297,50', 'AVENIDA PAULISTA, 1000 · BELA VISTA · CEP 01310-100']) {
    assert.ok(doResumo.includes(s), `"${s}" no resumo`);
  }
});

test('obra (E0370): o bloco "Dados da obra" aparece só nos códigos de construção civil, vai no pedido e no resumo', async () => {
  const semRetencao = { retem_iss: false, aliquota_iss: null, retem_inss: false, inss_percentual: null };
  const contexto = {
    empresas: [
      { tenant_id: TENANT, razao_social: 'CONTABIL SANDRA LTDA', cnpj: '11222333000181', principal: true, codigo_servico_nacional: '170201', bloqueio: null, regime: 'simples', retencao: semRetencao },
      { tenant_id: EMP_MEI, razao_social: 'ELISIO MEI', cnpj: '04252011000110', principal: false, codigo_servico_nacional: '070201', bloqueio: null, regime: 'mei', retencao: semRetencao }
    ],
    franquia: { limite: 500, no_mes: 3 }
  };
  const resumo = {
    resumo: {
      empresa: { tenant_id: EMP_MEI, razao_social: 'ELISIO MEI', cnpj: '04252011000110' },
      tomador: { documento: '11222333000181', tipo: 'cnpj', nome: 'Sakata Seed', email: null },
      servico: { codigo: '070201', nome: 'Execução de obras', descricao: 'Alvenaria' },
      obra: 'Rua das Flores, 120 - Centro, CEP 12900-000',
      valor: '3800.00', valor_texto: 'R$ 3.800,00', retencao: null, endereco_tomador: null
    },
    bloqueio: null,
    avisos: []
  };
  let primeira = true;
  const p = await painel({
    'app:emissao:contexto': r(200, contexto),
    'app:emissao:modelos': r(200, { modelos: [] }),
    'app:emissao:avulsa_conferir': () => {
      if (primeira) { primeira = false; return { status: 422, corpo: { error: { code: 'VALIDATION_FAILED', message: 'Dados da obra: endereço da obra sem bairro.' }, campo: 'obra' } }; }
      return { status: 200, corpo: resumo };
    }
  }, '/agentes/fiscal/conta/#emitir');

  await p.clicar('fa-aba-emitir');
  await p.preencher('fa-av-empresa', TENANT);
  assert.equal(p.visivel('fa-av-obra'), false, 'código 17.02.01: sem o bloco da obra');
  await p.preencher('fa-av-empresa', EMP_MEI);
  assert.ok(p.visivel('fa-av-obra'), 'código 07.02.01: o bloco da obra aparece');

  await p.preencher('fa-av-documento', '11.222.333/0001-81');
  await p.preencher('fa-av-nome', 'Sakata Seed');
  await p.preencher('fa-av-valor', '3800');
  await p.preencher('fa-av-obra-cep', '12900-000');
  await p.preencher('fa-av-obra-logradouro', 'Rua das Flores');
  await p.preencher('fa-av-obra-numero', '120');
  await p.enviar('fa-form-avulsa');
  assert.equal(p.texto('fa-av-obra-erro'), 'Dados da obra: endereço da obra sem bairro.');

  await p.preencher('fa-av-obra-bairro', 'Centro');
  await p.enviar('fa-form-avulsa');
  const corpo = p.rede.de('app:emissao:avulsa_conferir')[1].corpo;
  assert.deepEqual(
    [corpo.obra_cep, corpo.obra_logradouro, corpo.obra_numero, corpo.obra_bairro, corpo.obra_complemento, corpo.obra_cno],
    ['12900-000', 'Rua das Flores', '120', 'Centro', '', '']
  );
  assert.ok(p.texto('fa-av-resumo').includes('Rua das Flores, 120 - Centro, CEP 12900-000'), 'a obra no resumo');
});
