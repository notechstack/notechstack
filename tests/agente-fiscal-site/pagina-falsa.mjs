// Página falsa das páginas do site do nó.fiscal (/agentes/fiscal/comecar/ e /conta/), no molde de
// tests/agente-fiscal-lp/pagina-falsa.mjs: o HTML de verdade, os scripts de verdade (nofiscal.js e o da página) e
// toda a rede num dublê. Aqui o DOM é o jsdom (as páginas têm formulários, arquivos e eventos que um DOM mínimo
// não cobre). O dublê responde pela forma da Surface da tarefa agente-fiscal-v2 e grava cada chamada; uma URL
// fora da Surface derruba o teste, para o dublê nunca responder "nada" por omissão.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ler = (rel) => readFileSync(resolve(repo, rel), 'utf8');

export const ORIGEM = 'https://www.notechstack.com.br';
export const CONFIG = {
  supabaseUrl: 'https://projeto.supabase.test',
  anonKey: 'anon-de-teste',
  funcoesUrl: 'https://projeto.supabase.test/functions/v1',
  apiBase: '/agentes/fiscal/api',
  whatsappAgente: ''
};
export const TENANT = '0b6f4e1c-7a55-4f0e-9c4a-2a1d3e5f7a90';
export const CNPJ = '11222333000181';
export const CPF = '52998224725';
export const CODIGO_CERTO = '123456';
export const ACEITE = 'Li e aceito os Termos de Uso e a Política de Privacidade do Agente Fiscal da nó, inclusive a guarda do meu certificado digital A1 para emitir as notas que eu confirmar no WhatsApp.';
export const CARTAO = { numero: '4111 1111 1111 1111', nome: 'LUCCA TESTE', validade: '12/30', cvv: '123' };

// Mesmo formato dos arquivos do lote P (Landing: "Arquivos de dados das pesquisas"); dados de exemplo.
export const CODIGOS = {
  fonte: 'exemplo de teste', consultado_em: '2026-10-24',
  itens: [
    { codigo: '040101', descricao: 'Medicina e biomedicina' },
    { codigo: '040102', descricao: 'Análises clínicas, patologia, eletricidade médica, radioterapia' },
    { codigo: '040601', descricao: 'Enfermagem, inclusive serviços auxiliares' },
    { codigo: '010101', descricao: 'Análise e desenvolvimento de sistemas' },
    // Oito itens a mais para a busca resumida (no máximo 6 opções e o total do resto).
    { codigo: '990001', descricao: 'Serviços de teste 1' },
    { codigo: '990002', descricao: 'Serviços de teste 2' },
    { codigo: '990003', descricao: 'Serviços de teste 3' },
    { codigo: '990004', descricao: 'Serviços de teste 4' },
    { codigo: '990005', descricao: 'Serviços de teste 5' },
    { codigo: '990006', descricao: 'Serviços de teste 6' },
    { codigo: '990007', descricao: 'Serviços de teste 7' },
    { codigo: '990008', descricao: 'Serviços de teste 8' }
  ]
};
export const CNAE = { fonte: 'exemplo de teste', consultado_em: '2026-10-24', cnae: { '8630503': ['040101', '040102'] } };

export function emDias(n) { return new Date(Date.now() + n * 86400000).toISOString(); }

export function estado(extra = {}) {
  return {
    ok: true, tenant_id: TENANT, onboarding_etapa: 'certificado', plano: 'pro',
    empresa: { cnpj: CNPJ, razao_social: 'CLINICA AURORA LTDA', municipio: 'São Paulo', uf: 'SP', cnae: '8630503', responsavel: 'Lucca Teste', email: 'lucca@exemplo.com', telefone: '+5511987654321' },
    assinatura: { status: 'pendente', com_teste: true, trial_ends_at: emDias(5), periodo_fim: emDias(5), cancelamento_agendado_para: null },
    certificado: null,
    fiscal: { codigo_servico_nacional: null, p_tot_trib_sn: null, contador_email: null, resumo: null },
    ...extra
  };
}

export const CANDIDATOS = [
  { nome: 'Prontia Saúde', tomador_documento: '11444777000161', tomador_nome: 'Prontia Saúde Ltda', tomador_email: 'financeiro@prontia.com.br', tomador_endereco: null, codigo_servico_nacional: '040101', descricao: 'Consulta médica', valor_padrao: '150.00', origem: 'importacao_adn' },
  { nome: 'Clínica Aurora', tomador_documento: '52998224725', tomador_nome: 'Clínica Aurora', tomador_email: null, tomador_endereco: null, codigo_servico_nacional: '040101', descricao: 'Plantão', valor_padrao: '1250.00', origem: 'importacao_adn' }
];

const r = (status, corpo) => ({ status, corpo });
export const PADRAO = {
  // Pedido do código: zera as tentativas do e-mail (como o registro novo em fiscal_acesso_codigos).
  'fiscal-acesso': (c, _ch, mem) => { mem.tentativas[c.email] = 0; return r(202, { ok: true }); },
  'fiscal-cadastro:consultar_cnpj': (c) => r(200, { ok: true, cnpj: c.cnpj, razao_social: 'CLINICA AURORA LTDA', municipio: 'São Paulo', uf: 'SP', codigo_municipio_ibge: '3550308', cnae: '8630503', padrao_nacional: true }),
  'fiscal-cadastro:criar': () => r(201, { ok: true, tenant_id: TENANT, etapa: 'pagamento', novo: true }),
  // fiscal-acesso {acao:'verificar'} (Landing do lote A): conta as tentativas; a 5ª errada esgota o código.
  'fiscal-acesso:verificar': (c, _ch, mem) => {
    const erro = (status, codigo, extra = {}) => r(status, { ok: false, motivo: codigo.toLowerCase(), error_code: codigo, mensagem: 'x', ...extra });
    if (!/^\d{6}$/.test(String(c.codigo || ''))) return erro(400, 'CODIGO_INVALIDO');
    const n = mem.tentativas[c.email];
    if (n === undefined) return erro(422, 'CODIGO_VENCIDO');
    if (n >= 5) return erro(422, 'CODIGO_ESGOTADO');
    if (c.codigo === CODIGO_CERTO) {
      delete mem.tentativas[c.email];
      return r(200, { ok: true, access_token: 'at-1', refresh_token: 'rt-1', expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    mem.tentativas[c.email] = n + 1;
    return n + 1 >= 5 ? erro(422, 'CODIGO_ESGOTADO') : erro(422, 'CODIGO_INCORRETO', { tentativas_restantes: 5 - (n + 1) });
  },
  'auth:refresh': () => r(200, { access_token: 'at-2', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'rt-2' }),
  'GET assinatura-fiscal': () => r(200, { ok: true, venda_aberta: true, public_key: 'pk_test_abc', aceite_texto: ACEITE, planos: { inicial: { valor_centavos: 4900 }, pro: { valor_centavos: 12900 } } }),
  'pagarme:tokens': () => r(200, { id: 'token_abc123', type: 'card' }),
  'POST assinatura-fiscal': () => r(200, { ok: true, status: 'pendente', assinatura_id: 'a-1', com_teste: true, trial_ends_at: emDias(7), medicao: { evento: 'StartTrial', event_id: 'nofiscal-trial-a-1', transaction_id: 'a-1', valor: 129, moeda: 'BRL' } }),
  'fiscal-conta:estado': () => r(200, estado()),
  'fiscal-conta:configurar': () => r(200, estado({ onboarding_etapa: 'clientes' })),
  'fiscal-conta:trocar_cartao': () => r(200, { ok: true }),
  'fiscal-conta:trocar_plano': (c) => r(200, estado({ plano: c.plano })),
  'fiscal-conta:cancelar': () => r(200, { ok: true, cancelamento_agendado_para: emDias(20) }),
  'fiscal-conta:apagar_conta': () => r(200, { ok: true }),
  'app:certificate': () => r(201, { subject: 'CN=CLINICA AURORA LTDA:11222333000181, C=BR, O=ICP-Brasil', not_after: '2027-03-31T15:00:00.000Z' }),
  'app:clientes:buscar_adn': () => r(200, { candidatos: CANDIDATOS }),
  'app:clientes:ler_pdf': () => r(200, { candidato: { ...CANDIDATOS[0], nome: 'Lido do PDF', tomador_documento: '04252011000110', origem: 'importacao_pdf' } }),
  'app:clientes:salvar': (c) => r(201, { salvos: c.modelos.length, ignorados: [] }),
  'app:ativacao': () => r(201, { codigo: '482913', mensagem: 'Quero ativar o nó.fiscal da CLINICA AURORA LTDA no plano Pro. Código de ativação: 482913', whatsapp_url: 'https://wa.me/5511900000000?text=' + encodeURIComponent('Quero ativar o nó.fiscal da CLINICA AURORA LTDA no plano Pro. Código de ativação: 482913'), expira_em: emDias(1) }),
  'dados:codigos-servico.json': () => r(200, CODIGOS),
  'dados:cnae-servico.json': () => r(200, CNAE)
};

async function lerCorpo(init) {
  const b = init && init.body;
  if (b == null) return undefined;
  if (typeof b === 'string') { try { return JSON.parse(b); } catch { return b; } }
  if (typeof b.get === 'function' && typeof b.entries === 'function') {
    const o = {};
    for (const [k, v] of b.entries()) o[k] = v;
    return o;
  }
  return b;
}

function rota(url, metodo, corpo) {
  const u = new URL(url, ORIGEM);
  const caminho = u.pathname;
  if (u.origin === new URL(CONFIG.supabaseUrl).origin) {
    if (caminho === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') return 'auth:refresh';
    const f = /^\/functions\/v1\/([\w-]+)$/.exec(caminho);
    if (f) {
      if (f[1] === 'assinatura-fiscal') return metodo + ' assinatura-fiscal';
      if (f[1] === 'fiscal-acesso') return corpo && corpo.acao === 'verificar' ? 'fiscal-acesso:verificar' : 'fiscal-acesso';
      return f[1] + ':' + (corpo && corpo.acao);
    }
  }
  if (u.origin === 'https://api.pagar.me' && caminho === '/core/v5/tokens') return 'pagarme:tokens';
  if (u.origin === ORIGEM) {
    if (caminho === '/agentes/fiscal/api/v1/onboarding/certificate/') return 'app:certificate';
    if (caminho === '/agentes/fiscal/api/v1/onboarding/ativacao/') return 'app:ativacao';
    if (caminho === '/agentes/fiscal/api/v1/onboarding/clientes/') return 'app:clientes:' + (corpo && corpo.acao);
    const d = /^\/agentes\/fiscal\/dados\/([\w-]+\.json)$/.exec(caminho);
    if (d) return 'dados:' + d[1];
  }
  return null;
}

// Dublê da rede: `respostas` sobrescreve rotas de PADRAO (função (corpo, chamada, memória) → {status, corpo}).
export function superficie(respostas = {}) {
  const tabela = { ...PADRAO, ...respostas };
  const chamadas = [];
  const desconhecidas = [];
  const memoria = { tentativas: {} };
  async function fetch(url, init = {}) {
    const metodo = (init.method || 'GET').toUpperCase();
    const corpo = await lerCorpo(init);
    const chave = rota(String(url), metodo, corpo);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    // URL como o navegador resolve (relativa à página).
    const chamada = { rota: chave, url: new URL(String(url), ORIGEM).href, metodo, headers, corpo, bruto: init.body };
    chamadas.push(chamada);
    if (!chave || !tabela[chave]) {
      desconhecidas.push(`${metodo} ${url}`);
      throw new Error(`fora da Surface: ${metodo} ${url}`);
    }
    const resp = await tabela[chave](corpo || {}, chamada, memoria);
    return new Response(resp.corpo === undefined ? null : JSON.stringify(resp.corpo), { status: resp.status, headers: { 'content-type': 'application/json' } });
  }
  return {
    fetch, chamadas, desconhecidas,
    de: (chave) => chamadas.filter((c) => c.rota === chave),
    rotas: () => chamadas.map((c) => c.rota)
  };
}

export function sessaoValida() {
  return { access_token: 'at-0', refresh_token: 'rt-0', expires_at: Math.floor(Date.now() / 1000) + 3600 };
}

export async function esvaziar(vezes = 25) {
  for (let i = 0; i < vezes; i++) await new Promise((r) => setImmediate(r));
}

// Abre /agentes/fiscal/<pagina>/ como o navegador abriria. `local` e `aba` preenchem localStorage e sessionStorage.
export async function abrir(caminho, { rede = superficie(), local = {}, aba = {}, config = CONFIG } = {}) {
  const u = new URL(caminho, ORIGEM);
  const arquivo = u.pathname.replace(/^\//, '') + (u.pathname.endsWith('/') ? 'index.html' : '');
  const html = ler(arquivo);
  const erros = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/Not implemented: (window\.scrollTo|HTMLFormElement\.prototype\.requestSubmit)/.test(e.message)) erros.push(e.message); });
  const dom = new JSDOM(html, { url: u.href, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  for (const [k, v] of Object.entries(local)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  for (const [k, v] of Object.entries(aba)) w.sessionStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  w.fetch = rede.fetch;
  w.scrollTo = () => {};
  const navegou = [];
  // Scripts locais da página, na ordem do HTML; o config.js de produção dá lugar ao de teste.
  const fontes = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)].map((m) => m[1].split('?')[0]);
  for (const src of fontes) {
    if (src === '/shared/card-nav.js') continue;
    if (src === '/agentes/fiscal/config.js') { w.NOFISCAL_CONFIG = { ...config }; continue; }
    w.eval(ler(src.replace(/^\//, '')));
    if (src === '/agentes/fiscal/nofiscal.js') w.noFiscal.navegar = (url) => navegou.push(url);
  }
  await esvaziar();
  const d = w.document;
  const $ = (id) => d.getElementById(id);
  const oculto = (el) => { for (let x = el; x; x = x.parentElement) if (x.hidden) return true; return false; };
  const textoDe = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
  const p = {
    dom, window: w, document: d, rede, navegou, erros, $,
    visivel: (id) => { const el = typeof id === 'string' ? $(id) : id; return !!el && !oculto(el); },
    texto: (id) => textoDe(typeof id === 'string' ? $(id) : id),
    // Texto visível da página inteira (sem o que está oculto).
    textoVisivel() {
      const partes = [];
      const andar = (el) => {
        if (el.nodeType === 3) { partes.push(el.textContent); return; }
        if (el.nodeType !== 1 || el.hidden || /^(SCRIPT|STYLE|TEMPLATE)$/.test(el.tagName)) return;
        for (const c of el.childNodes) andar(c);
        partes.push(' ');
      };
      andar(d.body);
      return partes.join('').replace(/\s+/g, ' ').trim();
    },
    etapa() {
      const s = [...d.querySelectorAll('section[data-etapa]')].filter((x) => !x.hidden);
      return s.length === 1 ? Number(s[0].dataset.etapa) : s.map((x) => Number(x.dataset.etapa));
    },
    passo() { const s = [...d.querySelectorAll('section[data-etapa]')].find((x) => !x.hidden); return s ? textoDe(s.querySelector('.nf-passo')) : null; },
    rotulos(secaoId) { return [...$(secaoId).querySelectorAll('label')].filter((l) => !oculto(l)).map((l) => textoDe(l)); },
    async preencher(id, valor) {
      const el = $(id);
      if (!el) throw new Error('sem elemento #' + id);
      el.value = valor;
      el.dispatchEvent(new w.Event('input', { bubbles: true }));
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
      await esvaziar();
    },
    async marcar(id, valor = true) { const el = $(id); el.checked = valor; el.dispatchEvent(new w.Event('change', { bubbles: true })); await esvaziar(); },
    async arquivos(id, lista) {
      const el = $(id);
      const files = lista.map(([nome, conteudo, tipo]) => new w.File([conteudo], nome, { type: tipo || 'application/octet-stream' }));
      Object.defineProperty(el, 'files', { configurable: true, get: () => files });
      el.dispatchEvent(new w.Event('change', { bubbles: true }));
      await esvaziar(60);
    },
    async enviar(formId) { $(formId).dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await esvaziar(60); },
    async clicar(id) { const el = typeof id === 'string' ? $(id) : id; if (!el) throw new Error('sem elemento ' + id); el.click(); await esvaziar(60); },
    esvaziar
  };
  return p;
}

// Etapa 1 preenchida com dados válidos (o CNPJ dispara a consulta).
export async function preencherEtapa1(p, dados = {}) {
  const d = { cnpj: '11.222.333/0001-81', empresa: '', responsavel: 'Lucca Teste', email: 'lucca@exemplo.com', telefone: '(11) 98765-4321', ...dados };
  await p.preencher('fc-cnpj', d.cnpj);
  if (d.empresa) await p.preencher('fc-empresa', d.empresa);
  await p.preencher('fc-responsavel', d.responsavel);
  await p.preencher('fc-email', d.email);
  await p.preencher('fc-telefone', d.telefone);
}

// Do zero até a etapa 3 pelo caminho da página: etapa 1, código certo e criação.
export async function ateEtapa3(p, dados) {
  await preencherEtapa1(p, dados);
  await p.enviar('fc-form-1');
  await p.preencher('fc-codigo', CODIGO_CERTO);
  await p.enviar('fc-form-2');
}

export async function preencherCartao(p, prefixo = 'fc', cartao = CARTAO) {
  await p.preencher(prefixo + '-cc-numero', cartao.numero);
  await p.preencher(prefixo + '-cc-nome', cartao.nome);
  await p.preencher(prefixo + '-cc-validade', cartao.validade);
  await p.preencher(prefixo + '-cc-cvv', cartao.cvv);
  await p.preencher(prefixo + '-en-cep', '01310-100');
  await p.preencher(prefixo + '-en-rua', 'Avenida Paulista');
  await p.preencher(prefixo + '-en-numero', '1000');
  await p.preencher(prefixo + '-en-bairro', 'Bela Vista');
  await p.preencher(prefixo + '-en-cidade', 'São Paulo');
  await p.preencher(prefixo + '-en-uf', 'SP');
}

// Abre /comecar/ já com sessão, numa etapa do servidor (retomada).
export async function abrirNaEtapa(onboarding_etapa, { estadoExtra = {}, respostas = {}, aba = {} } = {}) {
  const rede = superficie({ 'fiscal-conta:estado': () => ({ status: 200, corpo: estado({ onboarding_etapa, ...estadoExtra }) }), ...respostas });
  const p = await abrir('/agentes/fiscal/comecar/', { rede, local: { 'nofiscal.sessao': sessaoValida() }, aba });
  return p;
}
