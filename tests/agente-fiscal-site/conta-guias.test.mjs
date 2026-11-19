// Aba Guias de /agentes/fiscal/conta/ (módulo Guias, critérios 4 a 8): só aparece quando a API diz que o módulo está
// ligado, com a navegação por teclado das outras abas; o PDF vai do navegador direto ao Storage (nunca no corpo da
// API); a conferência mostra verde/amarela/vermelha e nada é disparado sem o clique em Disparar. Página falsa com a
// Surface dublada (pagina-falsa.mjs) e o Storage respondendo aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { abrir, superficie, sessaoValida, estado, esvaziar, TENANT } from './pagina-falsa.mjs';

const raiz = new URL('../../agentes/fiscal/conta/', import.meta.url);
const js = readFileSync(new URL('guias.js', raiz), 'utf8');
const html = readFileSync(new URL('index.html', raiz), 'utf8');
const STORAGE = 'https://projeto.supabase.co/storage/v1/object/upload/sign/fiscal-guias/';
const LOTE = '5a5a5a5a-0000-4000-8000-000000000001';
const G = (n) => `6b6b6b6b-0000-4000-8000-00000000000${n}`;
const r = (status, corpo) => () => ({ status, corpo });

function estadoEscritorio() {
  return estado({
    onboarding_etapa: 'concluido', plano: 'escritorio_5',
    empresa: { cnpj: '11222333000181', razao_social: 'CONTABIL SANDRA LTDA', municipio: null, uf: null, cnae: '6920601', regime: 'simples', responsavel: 'Sandra', email: 'sandra@exemplo.com', telefone: '+5511987654321' },
    assinatura: { status: 'paga', com_teste: false, trial_ends_at: null, periodo_fim: '2026-12-05T15:00:00.000Z', cancelamento_agendado_para: null, cortesia: false, ciclo: 'mensal' },
    escritorio: { escritorio_tenant_id: TENANT, plano: 'escritorio_5', max_empresas: 5, empresas_ativas: 1, notas_limite: 500, notas_mes: 0, empresas: [
      { tenant_id: TENANT, cnpj: '11222333000181', razao_social: 'CONTABIL SANDRA LTDA', regime: 'simples', principal: true, ativa: true, codigo_servico_nacional: '170201', p_tot_trib_sn: 6, certificado: null, notas_mes: 0, situacao: 'pronta' }
    ] }
  });
}

const ESTADO_LIGADO = {
  ligado: true, escritorio: 'CONTABIL SANDRA LTDA', uso: { enviadas: 410, limite: 500, percentual: 82, aviso: '80' },
  regras: { lembrete_dias: [-1, 0], hora_envio: 9, email_alerta: null, assinatura: 'Contabilidade Sandra', whatsapp_escritorio: null }, upload: true, max_arquivos: 500
};

function guia(n, cor, extra = {}) {
  return {
    id: G(n), lote_id: LOTE, arquivo: `guia-${n}.pdf`, tipo: 'das', tipo_rotulo: 'DAS do Simples Nacional', documento: '11444777000161', competencia: '2026-11',
    valor_centavos: 123456, vencimento: '2026-12-20', linha_digitavel: '8'.repeat(48), status: 'conferir', cor, motivo: cor === 'verde' ? null : 'faltou: valor',
    valor_codigo_barras: 123456, contato: cor === 'vermelho' ? null : { id: 'c1', nome: 'Padaria Boa', whatsapps: ['+5511900000001'], emails: [] }, envios: [], origem: {}, ...extra
  };
}

/** Surface com o módulo ligado (ou não) e o Storage: PUT na URL assinada guarda o arquivo. */
function rede({ ligado = true } = {}) {
  const puts = [];
  const lote = { guias: [] };
  const base = superficie({
    'fiscal-conta:estado': r(200, estadoEscritorio()),
    'app:guias:estado': r(200, ligado ? ESTADO_LIGADO : { ligado: false }),
    'app:guias:lotes_listar': () => ({ status: 200, corpo: { lotes: lote.guias.length ? [{ id: LOTE, total_arquivos: 3, lidos: 3, com_problema: 2, status: 'conferir', criado_em: '2026-11-19T15:00:00.000Z' }] : [] } }),
    'app:guias:lote_criar': r(200, { lote_id: LOTE }),
    'app:guias:lote_arquivos': (c) => r(200, { arquivos: c.arquivos.map((a, i) => ({ guia_id: G(i + 1), nome: a.nome, url: `${STORAGE}${TENANT}/${LOTE}/${i}.pdf?token=t${i}` })) })(),
    'app:guias:lote_confirmar': (c) => r(200, { confirmadas: c.guia_ids.length })(),
    'app:guias:ler': () => {
      lote.guias = [guia(1, 'verde'), guia(2, 'amarelo', { valor_centavos: null }), guia(3, 'vermelho', { documento: '99888777000166' })];
      return { status: 200, corpo: { lidas: 3, pendentes: 0 } };
    },
    'app:guias:lote_ver': () => ({ status: 200, corpo: { lote: { id: LOTE, status: 'conferir', lidos: 3, com_problema: 2 }, guias: lote.guias } }),
    'app:guias:disparar': (c) => r(200, { agendadas: c.guia_ids.length, recusadas: 0, quando: c.quando, uso: ESTADO_LIGADO.uso })(),
    'app:guias:contato_salvar': r(200, { id: 'c9' })
  });
  const fetch = async (url, init = {}) => {
    if (String(url).startsWith(STORAGE)) {
      puts.push({ url: String(url), metodo: init.method, headers: init.headers, corpo: init.body });
      return new Response('{"Key":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return base.fetch(url, init);
  };
  return { ...base, fetch, puts };
}

async function painel(opcoes, caminho = '/agentes/fiscal/conta/') {
  const rd = rede(opcoes);
  const p = await abrir(caminho, { rede: rd, local: { 'nofiscal.sessao': sessaoValida() } });
  await esvaziar(40);
  return { p, rd };
}
const tecla = async (p, el, key) => { el.dispatchEvent(new p.window.KeyboardEvent('keydown', { key, bubbles: true })); await esvaziar(40); };

test('guias.js: nenhuma função repetida e todo id existe em index.html', () => {
  const nomes = [...js.matchAll(/^\s*function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
  assert.deepEqual(nomes.filter((n, i) => nomes.indexOf(n) !== i), []);
  const ids = [...new Set([...js.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]))];
  assert.deepEqual(ids.filter((id) => !html.includes(`id="${id}"`)), []);
  assert.match(html, /data-aba="guias"[^>]*hidden/);
});

test('sem o módulo: a aba Guias não aparece e o teclado anda só pelas abas de sempre', async () => {
  const { p, rd } = await painel({ ligado: false });
  assert.equal(rd.de('app:guias:estado').length, 1, 'perguntou à API');
  assert.equal(p.visivel('fa-aba-guias'), false);
  assert.equal(p.visivel('fa-painel-guias'), false);
  await p.clicar('fa-aba-api');
  await tecla(p, p.$('fa-aba-api'), 'ArrowRight');
  assert.equal(p.$('fa-aba-dados').getAttribute('aria-selected'), 'true', 'da última (API) volta para a primeira');
  await tecla(p, p.$('fa-aba-dados'), 'End');
  assert.equal(p.$('fa-aba-api').getAttribute('aria-selected'), 'true');
  assert.deepEqual(rd.rotas().filter((x) => x && x.startsWith('app:guias:') && x !== 'app:guias:estado'), [], 'nada mais do módulo');
  assert.deepEqual(p.erros, []);
});

test('com o módulo: a aba aparece, entra no teclado como as outras e abre pelo endereço #guias', async () => {
  const { p } = await painel();
  assert.equal(p.visivel('fa-aba-guias'), true);
  assert.equal(p.$('fa-aba-guias').getAttribute('role'), 'tab');
  await p.clicar('fa-aba-api');
  await tecla(p, p.$('fa-aba-api'), 'ArrowRight');
  assert.equal(p.$('fa-aba-guias').getAttribute('aria-selected'), 'true');
  assert.equal(p.window.document.activeElement, p.$('fa-aba-guias'));
  assert.equal(p.visivel('fa-painel-guias'), true);
  assert.equal(p.$('fa-painel-guias').getAttribute('role'), 'tabpanel');
  assert.match(p.texto('fa-guias-uso'), /410 de 500/);
  assert.match(p.texto('fa-aviso-guias'), /80%/);
  await tecla(p, p.$('fa-aba-guias'), 'ArrowRight');
  assert.equal(p.$('fa-aba-dados').getAttribute('aria-selected'), 'true');

  const direto = await painel({}, '/agentes/fiscal/conta/#guias');
  assert.equal(direto.p.$('fa-aba-guias').getAttribute('aria-selected'), 'true');
  assert.equal(direto.p.visivel('fa-painel-guias'), true);
});

test('enviar: o PDF vai direto ao Storage; a conferência mostra as cores; só as verdes são disparadas, e só no clique', async () => {
  const { p, rd } = await painel({}, '/agentes/fiscal/conta/#guias');
  const w = p.window;
  const arquivos = [1, 2, 3].map((n) => new w.File([`%PDF-1.7 guia ${n}`], `guia-${n}.pdf`, { type: 'application/pdf' }));
  Object.defineProperty(p.$('fa-guias-arquivos'), 'files', { value: arquivos, configurable: true });
  p.$('fa-form-guias-upload').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  await esvaziar(200);

  assert.equal(rd.puts.length, 3, 'um PUT por PDF no Storage');
  assert.ok(rd.puts.every((x) => x.metodo === 'PUT' && x.headers['Content-Type'] === 'application/pdf' && arquivos.includes(x.corpo)));
  // A API só viu nome e tamanho: nenhum corpo de chamada ao app leva o arquivo.
  const doApp = rd.chamadas.filter((c) => c.rota && c.rota.startsWith('app:guias:'));
  assert.ok(doApp.every((c) => !(c.bruto instanceof w.Blob) && !(c.bruto instanceof w.FormData)));
  assert.deepEqual(rd.de('app:guias:lote_arquivos')[0].corpo.arquivos, arquivos.map((f) => ({ nome: f.name, tamanho: f.size })));
  assert.deepEqual(rd.de('app:guias:lote_confirmar').map((c) => c.corpo.guia_ids), [[G(1), G(2), G(3)], []]);
  assert.equal(rd.de('app:guias:lote_confirmar')[1].corpo.fim, true);

  const linhas = [...p.$('fa-guias-conf-linhas').querySelectorAll('tr')];
  assert.deepEqual(linhas.map((tr) => tr.querySelector('.nf-status').textContent), ['Verde', 'Amarela', 'Vermelha']);
  const marcas = linhas.map((tr) => tr.querySelector('input[data-guia-marcar]'));
  assert.deepEqual(marcas.map((m) => [m.checked, m.disabled]), [[true, false], [false, true], [false, true]]);
  assert.ok(linhas[2].querySelector('[data-guia-criar]'), 'vermelha oferece Criar contato');
  assert.match(p.texto('fa-guias-conf-resumo'), /1 verdes, 1 amarelas, 1 vermelhas/);
  assert.equal(rd.de('app:guias:disparar').length, 0, 'nada disparado sem o clique');

  await p.clicar('fa-guias-disparar');
  assert.deepEqual(rd.de('app:guias:disparar').map((c) => [c.corpo.guia_ids, c.corpo.quando]), [[[G(1)], null]]);
  assert.match(p.texto('fa-guias-disparo-aviso'), /1 guia na fila/);

  // Agendar: data e hora obrigatórias.
  p.document.querySelector('input[name="fa-guias-quando"][value="agendar"]').click();
  await esvaziar(10);
  assert.equal(p.$('fa-guias-agendar').disabled, false);
  await p.clicar('fa-guias-disparar');
  assert.equal(rd.de('app:guias:disparar').length, 1);
  assert.match(p.texto('fa-guias-disparo-aviso'), /Escolha a data e a hora/);
  p.$('fa-guias-agendar').value = '2026-12-15T09:00';
  await p.clicar('fa-guias-disparar');
  assert.equal(rd.de('app:guias:disparar').length, 2);
  assert.ok(rd.de('app:guias:disparar')[1].corpo.quando);

  // Criar contato na própria conferência.
  p.$('fa-guias-conf-linhas').querySelectorAll('tr')[2].querySelector('[data-guia-criar]').click();
  await esvaziar(10);
  assert.equal(p.visivel('fa-form-guias-contato-rapido'), true);
  assert.equal(p.$('fa-guias-cr-doc').value, '99.888.777/0001-66');
  p.$('fa-guias-cr-nome').value = 'Cliente Novo';
  p.$('fa-guias-cr-email').value = 'novo@cliente.test';
  p.$('fa-guias-cr-aceite').checked = true;
  p.$('fa-form-guias-contato-rapido').dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
  await esvaziar(60);
  assert.deepEqual(rd.de('app:guias:contato_salvar')[0].corpo.contato, { documento: '99.888.777/0001-66', nome: 'Cliente Novo', whatsapps: '', emails: 'novo@cliente.test', aceite_origem: 'Declarado na conferência das guias' });
  assert.deepEqual(p.erros, []);
});
