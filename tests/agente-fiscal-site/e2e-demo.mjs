// Ponta a ponta na demonstração local (C54 e C55 de .checks/agente-fiscal-v2.md), com Playwright.
//   node tests/agente-fiscal-site/e2e-demo.mjs --etapas     as 7 etapas de /comecar/ até o botão do WhatsApp,
//                                                          lendo o código na caixa de entrada do dublê (:3003)
//   node tests/agente-fiscal-site/e2e-demo.mjs --whatsapp   o mesmo e depois a conversa no dublê da Meta (:3004):
//                                                          ATIVAR assinado → boas-vindas (critérios 29–33) → "Pronto!"
// Se o site não estiver em :3000, sobe `npm run fiscal:demo` e o derruba no fim. Sai 0 só com tudo certo.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const aqui = dirname(fileURLToPath(import.meta.url));
const repo = resolve(aqui, '..', '..');
const forge = createRequire(import.meta.url)('node-forge');
const SITE = 'http://localhost:3000';
const RESEND = 'http://localhost:3003';
const META = 'http://localhost:3004';
// --celular: as mesmas telas em 390 px (capturas com sufixo -390).
const celular = process.argv.includes('--celular');
const sufixo = celular ? '-390' : '';
const modo = process.argv.includes('--whatsapp') ? 'whatsapp' : process.argv.includes('--etapas') ? 'etapas' : null;
const capturas = process.env.E2E_CAPTURAS || resolve(repo, '..', '..', '..', '..', '.checks', 'fiscal-v2-capturas', 'e2e');

if (!modo) { console.error('use --etapas ou --whatsapp'); process.exit(2); }

const log = (m) => console.log(`[e2e] ${m}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function completar(base) {
  const d = base.split('').map(Number);
  for (const [n, pesos] of [[12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]], [13, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]]) {
    const s = pesos.reduce((acc, p, i) => acc + p * d[i], 0);
    d[n] = s % 11 < 2 ? 0 : 11 - (s % 11);
  }
  return d.join('');
}
function cpf() {
  const d = Array.from({ length: 9 }, () => randomInt(10));
  for (let t = 9; t < 11; t++) { let s = 0; for (let i = 0; i < t; i++) s += d[i] * (t + 1 - i); d[t] = ((s * 10) % 11) % 10; }
  return d.join('');
}
function a1(cnpj, senha) {
  const chaves = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = chaves.publicKey;
  cert.serialNumber = '01' + Date.now().toString(16);
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: `EMPRESA E2E:${cnpj}` }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(chaves.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(chaves.privateKey, [cert], senha, { algorithm: '3des' })).getBytes(), 'binary');
}

async function noAr(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.status < 500; } catch { return false; } }

let demo = null;
async function garantirDemo() {
  if (await noAr(SITE + '/__demo/')) { log('usando a demonstração que já está no ar'); return; }
  log('subindo npm run fiscal:demo …');
  demo = spawn('npm', ['run', 'fiscal:demo'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let saida = '';
  const pronto = new Promise((ok, falha) => {
    const ler = (b) => { saida += b; if (/\[demo\] pronto/.test(saida)) ok(); };
    demo.stdout.on('data', ler); demo.stderr.on('data', ler);
    demo.on('exit', (c) => falha(new Error(`a demonstração saiu (código ${c}):\n${saida.slice(-2000)}`)));
  });
  await Promise.race([pronto, dormir(240000).then(() => { throw new Error('a demonstração não ficou pronta em 4 min'); })]);
}
function derrubarDemo() {
  if (!demo || demo.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(demo.pid), '/T', '/F'], { stdio: 'ignore' });
  else demo.kill('SIGINT');
}

async function codigoDoEmail(email, depoisDe) {
  for (let i = 0; i < 60; i++) {
    const lista = await (await fetch(`${RESEND}/api/emails?to=${encodeURIComponent(email)}`)).json();
    const e = lista.find((x) => x.em >= depoisDe && x.codigo);
    if (e) { if (e.subject !== 'Seu código nó.fiscal') throw new Error(`assunto inesperado: ${e.subject}`); return e.codigo; }
    await dormir(1000);
  }
  throw new Error('o código não chegou na caixa de entrada do dublê');
}

async function etapaVisivel(page, n, timeout = 30000) {
  await page.locator(`#fc-etapa-${n}`).waitFor({ state: 'visible', timeout });
  log(`etapa ${n}: ${await page.locator(`#fc-etapa-${n} .nf-passo`).innerText()}`);
  await page.screenshot({ path: join(capturas, `etapa-${n}${sufixo}.png`), fullPage: true });
}

async function etapas(page, dados) {
  await page.goto(`${SITE}/agentes/fiscal/comecar/?plano=pro`);
  await etapaVisivel(page, 1);
  const plano = await page.locator('#fc-plano').innerText();
  if (plano !== 'Plano Pro · R$ 129/mês · 7 dias grátis') throw new Error(`plano exibido: ${plano}`);
  await page.fill('#fc-cnpj', dados.cnpj);
  await page.waitForFunction(() => document.getElementById('fc-empresa').value.length > 0, null, { timeout: 20000 });
  await page.fill('#fc-responsavel', 'Pessoa E2E');
  await page.fill('#fc-cpf', dados.cpf);
  await page.fill('#fc-email', dados.email);
  await page.fill('#fc-telefone', dados.telefone);
  const pedido = new Date().toISOString();
  await page.click('#fc-continuar-1');
  await etapaVisivel(page, 2);
  const codigo = await codigoDoEmail(dados.email, pedido);
  log(`código lido em ${RESEND}: ${codigo}`);
  await page.fill('#fc-codigo', codigo);
  await page.click('#fc-confirmar-codigo');
  await etapaVisivel(page, 3);
  await page.waitForFunction(() => !document.getElementById('fc-pagar').disabled, null, { timeout: 20000 });
  for (const [id, v] of [['fc-cc-numero', '4111 1111 1111 1111'], ['fc-cc-nome', 'PESSOA E2E'], ['fc-cc-validade', '12/30'], ['fc-cc-cvv', '123'], ['fc-en-cep', '01310-100'], ['fc-en-rua', 'Avenida Paulista'], ['fc-en-numero', '1000'], ['fc-en-bairro', 'Bela Vista'], ['fc-en-cidade', 'São Paulo']]) await page.fill('#' + id, v);
  await page.selectOption('#fc-en-uf', 'SP');
  await page.check('#fc-aceite');
  await page.click('#fc-pagar');
  await etapaVisivel(page, 4);
  const pasta = mkdtempSync(join(tmpdir(), 'nofiscal-e2e-'));
  const pfx = join(pasta, 'a1-e2e.pfx');
  writeFileSync(pfx, a1(dados.cnpj, 'senha-e2e'));
  await page.setInputFiles('#fc-pfx', pfx);
  await page.fill('#fc-pfx-senha', 'senha-e2e');
  await page.click('#fc-enviar-a1');
  await page.locator('#fc-aviso-4').filter({ hasText: 'Certificado de EMPRESA E2E válido até' }).waitFor({ timeout: 30000 });
  await page.click('#fc-continuar-4');
  await etapaVisivel(page, 5);
  const sugestao = page.locator('#fc-seletor .nf-sugestoes input[type=radio]').first();
  if (await sugestao.count()) await sugestao.check();
  else {
    await page.fill('#fc-busca-codigo', 'medicina');
    await page.locator('#fc-seletor .nf-resultados input[type=radio]').first().check();
  }
  await page.fill('#fc-percentual', '6');
  await page.click('#fc-salvar-fiscal');
  await etapaVisivel(page, 6);
  await page.locator('#fc-buscando').waitFor({ state: 'hidden', timeout: 60000 });
  if (await page.locator('#fc-pdfs').isVisible()) {
    const nota = join(pasta, 'nota-prontia.pdf');
    writeFileSync(nota, '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    await page.setInputFiles('#fc-pdf', nota);
    await page.locator('#fc-clientes .nf-cliente').first().waitFor({ timeout: 30000 }).catch(() => {});
  }
  if (await page.locator('#fc-salvar-clientes').isVisible()) {
    // Como uma pessoa faria: o nome do modelo fica o nome curto pelo qual ela chama o cliente.
    await page.locator('#fc-clientes .nf-cliente [data-campo="nome"]').first().fill('Prontia Saúde');
    await page.click('#fc-salvar-clientes');
    if (await page.locator('#fc-continuar-6').isVisible().catch(() => false)) await page.click('#fc-continuar-6');
  } else {
    await page.click('#fc-pular');
  }
  await etapaVisivel(page, 7);
  const botao = page.locator('#fc-whatsapp');
  await botao.waitFor({ state: 'visible', timeout: 30000 });
  const href = await botao.getAttribute('href');
  if (!/^http:\/\/localhost:3004\/conversa\?numero=\d+&text=ATIVAR%20\d{6}$/.test(href)) throw new Error(`botão do WhatsApp aponta para ${href}`);
  log(`"Concluir no WhatsApp" → ${href}`);
  await page.screenshot({ path: join(capturas, `etapa-7${sufixo}.png`), fullPage: true });
  return botao;
}

async function whatsapp(context, botao, dados) {
  const [conversa] = await Promise.all([context.waitForEvent('page'), botao.click()]);
  await conversa.waitForLoadState();
  await conversa.fill('#de', dados.telefone);
  const texto = await conversa.inputValue('#texto');
  if (!/^ATIVAR \d{6}$/.test(texto)) throw new Error(`texto pronto no dublê: ${texto}`);
  const agente = conversa.locator('#conversa [data-de="agente"]');
  let vistos = 0;
  async function esperar(re, timeout = 30000) {
    const fim = Date.now() + timeout;
    while (Date.now() < fim) {
      const todas = await agente.allInnerTexts();
      const nova = todas.slice(vistos).find((t) => re.test(t));
      if (nova) { vistos = todas.length; log(`agente: ${nova.replace(/\s+/g, ' ').slice(0, 140)}`); return nova; }
      await dormir(700);
    }
    throw new Error(`o agente não respondeu ${re}; última: ${(await agente.allInnerTexts()).slice(-1)[0] || '(nada)'}`);
  }
  async function dizer(t) { await conversa.fill('#texto', t); await conversa.click('#enviar'); log(`dono: ${t}`); }

  await conversa.click('#enviar');
  log(`dono: ${texto}`);
  await esperar(/Sua empresa: [\s\S]*Está tudo certo\?/);
  await conversa.screenshot({ path: join(capturas, `whatsapp-1-conferir${sufixo}.png`), fullPage: true });
  await dizer('sim');
  await esperar(/Para quem você mais emite\?/);
  await dizer('Prontia Saúde');
  const cliente = await esperar(/Está certo\?|CPF|CNPJ/);
  if (/Está certo\?/.test(cliente)) await dizer('sim');
  else { await dizer('11444777000161'); await esperar(/e-mail/i); await dizer('financeiro@prontia.com.br'); await esperar(/modelo|salv/i); await dizer('sim'); }
  await esperar(/Me diga uma nota que você emitiria/);
  await dizer('nota pra Prontia Saúde, 150 reais');
  await esperar(/EXEMPLO — não será emitida/);
  await conversa.screenshot({ path: join(capturas, `whatsapp-2-ensaio${sufixo}.png`), fullPage: true });
  // "confirmar" no ensaio não emite (critério 32) e fecha as boas-vindas (critério 33).
  await dizer('confirmar');
  const pronto = await esperar(/Pronto! Agora, para emitir uma nova nota/);
  if (!/Isso foi só um exemplo/.test((await agente.allInnerTexts()).join(' '))) throw new Error('sem "Isso foi só um exemplo"');
  await conversa.screenshot({ path: join(capturas, `whatsapp-3-pronto${sufixo}.png`), fullPage: true });
  if (!/Pronto!/.test(pronto)) throw new Error('sem "Pronto!"');
}

async function principal() {
  mkdirSync(capturas, { recursive: true });
  await garantirDemo();
  const navegador = await chromium.launch();
  try {
    const context = await navegador.newContext({ viewport: celular ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => log(`erro na página: ${e.message}`));
    const raiz = '1' + String(randomInt(10 ** 9)).padStart(9, '0');
    const dados = { cnpj: completar((raiz + '0001').slice(0, 12)), cpf: cpf(), email: `e2e+${Date.now()}@exemplo.com`, telefone: '+55119' + String(randomInt(10 ** 8)).padStart(8, '0') };
    log(`CNPJ ${dados.cnpj} · e-mail ${dados.email} · WhatsApp ${dados.telefone}`);
    const botao = await etapas(page, dados);
    if (modo === 'whatsapp') await whatsapp(context, botao, dados);
    // Minha conta com a sessão que o cadastro deixou no navegador.
    await page.goto(`${SITE}/agentes/fiscal/conta/`);
    await page.locator('#fa-painel').waitFor({ state: 'visible', timeout: 30000 });
    const status = await page.locator('#fa-status').innerText();
    if (!/^Teste até \d{2}\/\d{2}$/.test(status)) throw new Error(`status na conta: ${status}`);
    log(`Minha conta: ${(await page.locator('#fa-plano-titulo').innerText()).replace(/\s+/g, ' ')} · ${status}`);
    await page.screenshot({ path: join(capturas, `conta${sufixo}.png`), fullPage: true });
    log(`ok (${modo})`);
  } finally {
    await navegador.close();
    derrubarDemo();
  }
}

principal().then(() => process.exit(0), (e) => { console.error(`[e2e] FALHOU: ${e.message}`); derrubarDemo(); process.exit(1); });
