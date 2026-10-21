// Capturas das páginas do lote E (desktop 1280 e celular 390), num Chromium de verdade, com a Surface no mesmo
// dublê dos testes (pagina-falsa.mjs). Não é teste: gera as imagens para revisão visual.
//   node tests/agente-fiscal-site/capturas.mjs [pasta]   (padrão: <projetos>/.checks/fiscal-v2-capturas)
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { repo, superficie, sessaoValida, estado, ORIGEM, CONFIG, ACEITE } from './pagina-falsa.mjs';

const pasta = resolve(process.argv[2] || resolve(repo, '..', '..', '..', '..', '.checks', 'fiscal-v2-capturas'));
mkdirSync(pasta, { recursive: true });
const { iniciarSite } = await import(pathToFileURL(resolve(repo, 'tools/fiscal-demo/site.mjs')).href);
const porta = 3900 + Math.floor(Math.random() * 90);
const configJs = `window.NOFISCAL_CONFIG = ${JSON.stringify(CONFIG)};`;
const site = await iniciarSite({ porta, apiUrl: 'http://127.0.0.1:9', supabaseUrl: 'http://127.0.0.1:9', configJs, metaUrl: 'http://localhost:3004', urls: {} });
const base = `http://localhost:${porta}`;

async function comDuble(page, rede) {
  // As funções e o Pagar.me são de outra origem: o navegador pede CORS (como as funções reais respondem).
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const responder = async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: cors }); return; }
    let url = req.url();
    if (url.startsWith(base)) url = ORIGEM + url.slice(base.length);
    let body = req.postDataBuffer() || undefined;
    const tipo = req.headers()['content-type'] || '';
    if (body && tipo.startsWith('multipart/')) body = await new Request(url, { method: 'POST', headers: { 'content-type': tipo }, body }).formData();
    else if (body) body = body.toString('utf8');
    try {
      const r = await rede.fetch(url, { method: req.method(), headers: req.headers(), body });
      await route.fulfill({ status: r.status, headers: cors, contentType: 'application/json', body: await r.text() });
    } catch { await route.fulfill({ status: 404, headers: cors, body: '' }); }
  };
  await page.route('https://projeto.supabase.test/**', responder);
  await page.route('https://api.pagar.me/**', responder);
  await page.route(`${base}/agentes/fiscal/api/**`, responder);
  await page.route(`${base}/agentes/fiscal/dados/**`, responder);
}

const tamanhos = [['desktop', { width: 1280, height: 900 }], ['390', { width: 390, height: 844 }]];
const navegador = await chromium.launch();
const fotos = [];
try {
  for (const [nome, viewport] of tamanhos) {
    const foto = async (page, arquivo) => { const f = join(pasta, `${arquivo}-${nome}.png`); await page.screenshot({ path: f, fullPage: true }); fotos.push(f); };

    // LP: seção de planos e FAQ.
    const lp = await (await navegador.newContext({ viewport })).newPage();
    await lp.goto(`${base}/agentes/fiscal/`);
    await lp.locator('#planos').screenshot({ path: join(pasta, `lp-planos-${nome}.png`) });
    fotos.push(join(pasta, `lp-planos-${nome}.png`));

    // /comecar/ do zero, etapa por etapa.
    const ctx = await navegador.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    page.on('response', (r) => { if (r.status() >= 400) console.error('resposta', r.status(), r.request().method(), r.url()); });
    page.on('console', (m) => { if (m.type() === 'error') console.error('console', m.text()); });
    page.on('requestfailed', (r) => console.error('falhou', r.method(), r.url(), r.failure() && r.failure().errorText));
    await comDuble(page, superficie({ 'fiscal-conta:estado': () => ({ status: 200, corpo: estado({ onboarding_etapa: 'dados_fiscais' }) }) }));
    await page.goto(`${base}/agentes/fiscal/comecar/?plano=pro`);
    await page.locator('#fc-etapa-1').waitFor();
    await foto(page, 'comecar-1-vazia');
    await page.fill('#fc-cnpj', '11.222.333/0001-81');
    await page.waitForFunction(() => document.getElementById('fc-empresa').value.length > 0);
    await page.fill('#fc-responsavel', 'Lucca Teste');
    await page.fill('#fc-cpf', '529.982.247-26');
    await page.fill('#fc-email', 'lucca@exemplo.com');
    await page.fill('#fc-telefone', '(11) 98765-4321');
    await page.click('#fc-continuar-1');
    await foto(page, 'comecar-1-cpf-invalido');
    await page.fill('#fc-cpf', '529.982.247-25');
    await page.click('#fc-continuar-1');
    await page.locator('#fc-etapa-2').waitFor();
    await page.fill('#fc-codigo', '000000');
    await page.click('#fc-confirmar-codigo');
    await page.locator('#fc-codigo-erro').waitFor();
    await foto(page, 'comecar-2-codigo');
    await page.fill('#fc-codigo', '123456');
    await page.click('#fc-confirmar-codigo');
    await page.locator('#fc-etapa-3').waitFor();
    await page.waitForFunction(() => !document.getElementById('fc-pagar').disabled);
    await page.fill('#fc-cc-numero', '4111 1111 1111 1111');
    await page.fill('#fc-cc-nome', 'LUCCA TESTE');
    await page.fill('#fc-cc-validade', '12/30');
    await page.fill('#fc-cc-cvv', '123');
    await page.fill('#fc-en-cep', '01310-100');
    await page.fill('#fc-en-rua', 'Avenida Paulista');
    await page.fill('#fc-en-numero', '1000');
    await page.fill('#fc-en-bairro', 'Bela Vista');
    await page.fill('#fc-en-cidade', 'São Paulo');
    await page.selectOption('#fc-en-uf', 'SP');
    await page.check('#fc-aceite');
    await foto(page, 'comecar-3-pagamento');
    await page.click('#fc-pagar');
    await page.locator('#fc-etapa-4').waitFor();
    await page.setInputFiles('#fc-pfx', { name: 'empresa.pfx', mimeType: 'application/x-pkcs12', buffer: Buffer.from([48, 130, 1, 2]) });
    await page.fill('#fc-pfx-senha', 'segredo');
    await page.click('#fc-enviar-a1');
    await page.locator('#fc-continuar-4').waitFor();
    await foto(page, 'comecar-4-certificado');
    await page.click('#fc-continuar-4');
    await page.locator('#fc-etapa-5 .nf-sugestoes input').first().waitFor();
    await page.locator('#fc-etapa-5 .nf-sugestoes input').first().check();
    await page.fill('#fc-percentual', '6,5');
    await foto(page, 'comecar-5-dados-fiscais');
    await page.click('#fc-salvar-fiscal');
    await page.locator('#fc-clientes .nf-cliente').first().waitFor();
    await foto(page, 'comecar-6-clientes');
    await page.click('#fc-salvar-clientes');
    await page.locator('#fc-whatsapp').waitFor();
    await foto(page, 'comecar-7-whatsapp');

    // /conta/: sem sessão e com sessão.
    const c1 = await (await navegador.newContext({ viewport })).newPage();
    await comDuble(c1, superficie());
    await c1.goto(`${base}/agentes/fiscal/conta/`);
    await c1.locator('#fa-login').waitFor();
    await foto(c1, 'conta-login');
    const c2ctx = await navegador.newContext({ viewport });
    await c2ctx.addInitScript((s) => localStorage.setItem('nofiscal.sessao', s), JSON.stringify(sessaoValida()));
    const c2 = await c2ctx.newPage();
    await comDuble(c2, superficie({ 'fiscal-conta:estado': () => ({ status: 200, corpo: estado({ onboarding_etapa: 'ativacao', certificado: { subject: 'CN=CLINICA AURORA LTDA:11222333000181, C=BR', not_after: '2027-03-31T15:00:00.000Z' }, fiscal: { codigo_servico_nacional: '040101', p_tot_trib_sn: 6.5, contador_email: 'contador@escritorio.com.br', resumo: { frequencia: 'mensal', dia: 5 } } }) }) }));
    await c2.goto(`${base}/agentes/fiscal/conta/`);
    await c2.locator('#fa-painel').waitFor();
    await c2.click('#fa-cancelar');
    await foto(c2, 'conta-painel');
    await c2.click('#fa-apagar');
    await c2.locator('#fa-apagar-texto').scrollIntoViewIfNeeded();
    await c2.screenshot({ path: join(pasta, `conta-apagar-${nome}.png`) });
    fotos.push(join(pasta, `conta-apagar-${nome}.png`));
  }
} finally {
  await navegador.close();
  await new Promise((r) => site.close(r));
}
console.log(fotos.join('\n'));
void ACEITE;
