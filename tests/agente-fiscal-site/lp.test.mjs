// LP adaptada e layout das páginas novas (lote E de .checks/agente-fiscal-v2.md): C51, C52 e C53.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { repo, ler, abrir } from './pagina-falsa.mjs';

const lp = () => new JSDOM(ler('agentes/fiscal/index.html')).window.document;
const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();

test('lp leva ao cadastro', () => {
  const d = lp();
  const cartoes = [...d.querySelectorAll('#planos .fi-planos > li')];
  const acoes = (c) => [...c.querySelectorAll('a, button')].map((a) => ({ rotulo: txt(a), href: a.getAttribute('href'), tag: a.tagName }));
  for (const [plano, nome] of [['inicial', 'Inicial'], ['pro', 'Pro']]) {
    const c = cartoes.find((x) => x.dataset.plano === plano);
    assert.ok(c, `cartão ${nome}`);
    const a = acoes(c);
    // Lucca, 22/10/2026: o teste de 7 dias deu lugar às 5 primeiras emissões grátis.
    assert.deepEqual(a, [{ rotulo: 'Começar com 5 notas grátis', href: `/agentes/fiscal/comecar/?plano=${plano}`, tag: 'A' }], nome);
  }
  // Escritório (mais de 100 notas no próprio negócio) e Agência (vários CNPJs) vão ao WhatsApp comercial.
  for (const [plano, nome, texto] of [
    ['escritorio', 'Escritório', 'Olá! Quero o plano Escritório do nó.fiscal: emito mais de 100 notas por mês.'],
    ['agencia', 'Agência', 'Olá! Sou de uma agência e quero integrar o nó.fiscal ao sistema dos meus clientes.']
  ]) {
    const c = cartoes.find((x) => x.dataset.plano === plano);
    assert.ok(c, `cartão ${nome}`);
    assert.match(txt(c.querySelector('h3')), new RegExp('^' + nome));
    const [link] = acoes(c);
    assert.equal(link.rotulo, 'Falar com a Nó');
    const u = new URL(link.href);
    assert.equal(u.origin + u.pathname, 'https://wa.me/5511939289413');
    assert.equal(u.searchParams.get('text'), texto);
  }

  const html = ler('agentes/fiscal/index.html');
  assert.doesNotMatch(html, /Assinatura\s+em\s+breve/i, 'o HTML não tem "Assinatura em breve"');
  assert.doesNotMatch(txt(d.body), /Assinatura em breve/i);
  assert.doesNotMatch(ler('agentes/fiscal/fiscal.js'), /Assinatura\s+em\s+breve/i);
});

test('o simulador leva ao cadastro do site', async () => {
  assert.doesNotMatch(ler('agentes/fiscal/fiscal.js'), /app\.notechstack\.com\.br/);
  assert.match(ler('agentes/fiscal/fiscal.js'), /'\/agentes\/fiscal\/comecar\/'/);
});

test('faq do certificado', () => {
  const d = lp();
  const faq = new Map([...d.querySelectorAll('#faq details')].map((x) => [txt(x.querySelector('summary')), txt(x.querySelector('p'))]));
  const a1 = faq.get('Como fica o meu certificado digital A1?');
  assert.ok(a1, 'pergunta do A1 no FAQ');
  assert.match(a1, /página de cadastro/);
  assert.match(a1, /logo depois do pagamento/);
  assert.match(a1, /nunca pelo WhatsApp/);
  const ld = JSON.parse(d.querySelector('script[type="application/ld+json"]').textContent);
  const q = ld.mainEntity.find((x) => x.name === 'Como fica o meu certificado digital A1?');
  assert.equal(q.acceptedAnswer.text, a1, 'JSON-LD igual ao FAQ');
  // Nenhum texto da LP manda o A1 por link avulso ou pelo WhatsApp.
  assert.doesNotMatch(txt(d.body), /link seguro que mandei/);
});

test('layout das páginas novas', async () => {
  const script = ler('shared/sync-site-layout.mjs');
  for (const [rota, arquivo] of [['/agentes/fiscal/comecar/', 'agentes/fiscal/comecar/index.html'], ['/agentes/fiscal/conta/', 'agentes/fiscal/conta/index.html']]) {
    assert.match(script, new RegExp(`['"]${rota.replace(/\//g, '\\/')}['"]\\s*:\\s*['"]${arquivo.replace(/\//g, '\\/').replace(/\./g, '\\.')}['"]`), `${rota} em pages`);
    const html = ler(arquivo);
    assert.match(html, /<!-- site-nav:start -->\s*<nav class="no-card-nav"[\s\S]*?<!-- site-nav:end -->/, `${arquivo}: navbar`);
    assert.match(html, /<!-- site-footer:start -->\s*<footer class="no-site-footer">[\s\S]*?<!-- site-footer:end -->/, `${arquivo}: rodapé`);
  }
  const r = spawnSync(process.execPath, ['shared/sync-site-layout.mjs', '--check'], { cwd: repo, encoding: 'utf8' });
  const saida = (r.stdout + r.stderr).split(/\r?\n/).filter(Boolean);
  assert.ok(r.status === 0 || r.status === 1, `status ${r.status}: ${saida.join(' | ')}`);
  for (const l of saida) assert.match(l, /^Layout out of sync: /);
  for (const f of ['agentes/fiscal/index.html', 'agentes/fiscal/comecar/index.html', 'agentes/fiscal/conta/index.html']) {
    assert.ok(!saida.includes('Layout out of sync: ' + f), saida.join('\n'));
  }
  // Mesmo layout da LP: tokens, Sora/JetBrains Mono (fonts.css), fiscal.css e o CSS compartilhado.
  for (const arquivo of ['agentes/fiscal/comecar/index.html', 'agentes/fiscal/conta/index.html']) {
    const html = ler(arquivo);
    for (const css of ['/brand/fonts/fonts.css', '/brand/tokens/tokens.css', '/shared/site-layout.css', '/agentes/fiscal/fiscal.css', '/agentes/fiscal/paginas.css']) {
      assert.ok(html.includes(`href="${css}`), `${arquivo}: ${css}`);
    }
    assert.match(html, /<body class="fi-body/);
  }
  const p = await abrir('/agentes/fiscal/comecar/');
  assert.ok(p.document.querySelectorAll('.fi-btn').length >= 5, 'botões fi-btn');
});
