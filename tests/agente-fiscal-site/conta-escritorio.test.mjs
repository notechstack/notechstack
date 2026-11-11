// /agentes/fiscal/conta/ no plano Escritório (.design/agente-fiscal-escritorio.md, "Painel do escritório"): as três
// abas (#dados, #empresas, #relatorios), as ações por empresa, a troca de faixa, o relatório do mês e o PDF da nota.
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
    escritorio: { escritorio_tenant_id: TENANT, plano: 'escritorio_5', max_empresas: 5, empresas_ativas: 4, notas_limite: 500, notas_mes: 37, empresas: empresas(), ...esc },
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
  const abas = [...p.$('fa-abas').querySelectorAll('[role=tab]')];
  assert.deepEqual(abas.map((a) => p.texto(a)), ['Meus dados', 'Minhas empresas', 'Relatórios']);
  assert.equal(p.$('fa-aba-dados').getAttribute('aria-selected'), 'true');
  assert.equal(p.$('fa-painel-dados').getAttribute('role'), 'tabpanel');
  assert.ok(p.visivel('fa-painel-dados'));
  assert.equal(p.visivel('fa-painel-empresas'), false);

  const t = p.textoVisivel();
  for (const s of ['Escritório', 'CONTABIL SANDRA LTDA', '11.222.333/0001-81', 'Sandra Teste', 'sandra@exemplo.com', 'Até 5 empresas · R$ 297/mês', '4 de 5', '37 de 500', '05/12/2026']) {
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

  // Trocar faixa: as três faixas, a atual marcada; confirma antes de chamar.
  await p.clicar('fa-abrir-faixas');
  const faixas = [...p.$('fa-faixas-lista').querySelectorAll('button')];
  assert.deepEqual(faixas.map((b) => b.querySelector('b').textContent), ['Até 5 empresas', 'Até 20 empresas', 'Até 50 empresas']);
  assert.ok(p.texto(faixas[1]).includes('R$ 797/mês') && p.texto(faixas[2]).includes('R$ 1.497/mês'));
  assert.equal(faixas[0].disabled, true);
  await p.clicar(faixas[1]);
  assert.equal(p.rede.de('fiscal-conta:trocar_plano').length, 0, 'só pergunta');
  assert.match(p.texto('fa-faixa-pergunta'), /^Trocar para a faixa Até 20 empresas, R\$ 797\/mês\?/);
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
  assert.ok(p.texto(cinco).includes('Você tem 6 empresas ativas'));
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
  assert.ok(p.texto('fa-empresas-resumo').startsWith('4 de 5 empresas ativas'));

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
  await p.enviar('fa-form-emp-fiscal');
  assert.deepEqual(p.rede.de('fiscal-conta:empresa_configurar')[0].corpo, { acao: 'empresa_configurar', tenant_id: EMP_MEI, codigo_servico_nacional: '040101' });
  assert.equal(p.texto('fa-aviso-empresas'), 'Dados fiscais de JOANA MEI salvos.');

  // Simples: com o % (já preenchido) e o código atual escolhido.
  await p.clicar(botaoDe(p, EMP_PRONTA, 'fiscal'));
  assert.ok(p.visivel('fa-emp-campo-percentual'));
  assert.equal(p.$('fa-emp-percentual').value, '6,5');
  await p.esvaziar(40);
  await p.preencher('fa-emp-percentual', '7');
  await p.enviar('fa-form-emp-fiscal');
  assert.deepEqual(p.rede.de('fiscal-conta:empresa_configurar')[1].corpo, { acao: 'empresa_configurar', tenant_id: EMP_PRONTA, codigo_servico_nacional: '170201', p_tot_trib_sn: 7 });

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
