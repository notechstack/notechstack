// Lucca, 03/11/2026: Meta na LP do nó.fiscal. (1) O Pixel não dispara nada antes do aceite (shared/pixel-consentimento.js
// segura a fila do fbq antes do GTM); (2) o AddToCart sai também pela CAPI (meta-capi) com o mesmo event_id e a
// navegação espera o envio; (3) Escritório e Agência geram Lead (dataLayer nofiscal_lead, Pixel e CAPI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { abrirPagina, esvaziar, ler } from './pagina-falsa.mjs';

const PIXEL_STUB = ler('shared/pixel-consentimento.js');
const FN_CAPI = 'https://sdeowbqmwkwseyktyemn.supabase.co/functions/v1/meta-capi';
// A tag base do Pixel no GTM-NK87FH8W (tag 12 do gtm.js no ar em 03/11/2026), sem o eventID do PageView.
const TAG_BASE_GTM = `!function(b,e,f,g,a,c,d){b.fbq||(a=b.fbq=function(){a.callMethod?a.callMethod.apply(a,arguments):a.queue.push(arguments)},b._fbq||(b._fbq=a),a.push=a,a.loaded=!0,a.version="2.0",a.queue=[],c=e.createElement(f),c.async=!0,c.src=g,d=e.getElementsByTagName(f)[0],d.parentNode.insertBefore(c,d))}(window,document,"script","https://connect.facebook.net/en_US/fbevents.js");fbq.disablePushState=!0;fbq("init","1753619075655271");fbq("track","PageView",{},{eventID:"pv-1"});`;

function cabeca({ salvo = null, host = 'www.notechstack.com.br' } = {}) {
  const criados = [];
  const ctx = {
    noTelemetriaConsentKey: 'no_fiscal_consent',
    noMarketingHostAllowed: (h) => ['www.notechstack.com.br', 'notechstack.com.br'].includes(h),
    location: { hostname: host },
    localStorage: { getItem: (k) => (k === 'no_fiscal_consent' ? salvo : null) },
    document: {
      createElement: (tag) => { const el = { tag, src: '' }; criados.push(el); return el; },
      getElementsByTagName: () => [{ parentNode: { insertBefore() {} } }]
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(PIXEL_STUB, ctx);
  vm.runInContext(TAG_BASE_GTM, ctx);
  const fila = () => (ctx.fbq.queue || []).map((a) => Array.from(a));
  const baixados = () => criados.filter((e) => /fbevents\.js$/.test(e.src)).length;
  return { ctx, fila, baixados };
}

test('Pixel: sem aceite, revoke na frente da fila e o fbevents.js não é baixado', () => {
  const p = cabeca();
  const fila = p.fila();
  assert.deepEqual(fila[0], ['consent', 'revoke'], 'revoke antes de tudo');
  assert.deepEqual(fila[1], ['init', '1753619075655271'], 'o init do GTM entrou na mesma fila');
  assert.equal(fila[2][1], 'PageView');
  assert.equal(p.baixados(), 0, 'nem o GTM nem o stub baixaram o fbevents.js');
  assert.equal(p.ctx.fbq.disablePushState, true, 'a tag base configurou a fila existente');

  // "Permitir": o grant entra na fila depois do PageView e só então o fbevents.js é baixado.
  p.ctx.fbq('consent', 'grant');
  assert.deepEqual(p.fila().at(-1), ['consent', 'grant']);
  assert.equal(p.baixados(), 1);
  p.ctx.fbq('consent', 'grant');
  assert.equal(p.baixados(), 1, 'baixa uma vez só');
});

test('Pixel: com aceite salvo baixa na hora, sem revoke; fora de produção nunca baixa', () => {
  const ok = cabeca({ salvo: 'granted' });
  assert.equal(ok.baixados(), 1);
  assert.ok(!ok.fila().some((a) => a[0] === 'consent' && a[1] === 'revoke'));

  const recusado = cabeca({ salvo: 'denied' });
  assert.deepEqual(recusado.fila()[0], ['consent', 'revoke']);

  const preview = cabeca({ salvo: 'granted', host: 'notechstack-git-x.vercel.app' });
  assert.equal(preview.baixados(), 0);
  preview.ctx.fbq('consent', 'grant');
  assert.equal(preview.baixados(), 0);
});

// --- LP: AddToCart e Lead -------------------------------------------------------------------------------------

function link(attrs, { target = '', href = 'https://www.notechstack.com.br/agentes/fiscal/comecar/?plano=pro' } = {}) {
  return {
    target, href, ouvintes: {},
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    addEventListener(t, f) { (this.ouvintes[t] = this.ouvintes[t] || []).push(f); },
    clicar(ev = {}) {
      const e = { button: 0, prevenido: false, preventDefault() { this.prevenido = true; }, ...ev };
      for (const f of this.ouvintes[ev.tipo || 'click'] || []) f(e);
      return e;
    }
  };
}

function lp({ consentimento = 'granted', producao = true } = {}) {
  const fbq = [];
  const fetches = [];
  const pro = link({ 'data-plano': 'pro' });
  const escritorio = link({ 'data-lead': 'escritorio' }, { target: '_blank', href: 'https://wa.me/5511939289413?text=x' });
  const agencia = link({ 'data-lead': 'agencia' }, { target: '_blank', href: 'https://wa.me/5511939289413?text=y' });
  const armazenamento = new Map(consentimento ? [['no_fiscal_consent', consentimento]] : []);
  const p = abrirPagina({
    armazenamento,
    seletores: { 'a[data-plano]': [pro], 'a[data-lead]': [escritorio, agencia] },
    extras: {
      cookie: '_fbp=fb.1.1761140000000.111',
      fbq: (...a) => fbq.push(a),
      noMarketingHostAllowed: () => producao,
      fetch: (url, init) => { fetches.push({ url, init, corpo: JSON.parse(init.body) }); return Promise.resolve({ ok: true }); }
    }
  });
  return { p, fbq, fetches, pro, escritorio, agencia };
}
// Objetos do vm são de outro realm: compara pelo JSON.
const js = (v) => JSON.parse(JSON.stringify(v));
const doDl = (p, nome) => p.dataLayer().filter((e) => e && e.event === nome);

test('AddToCart: Pixel com content_ids, CAPI com o mesmo event_id e navegação depois do envio', async () => {
  const { p, fbq, fetches, pro } = lp();
  const ev = pro.clicar();
  assert.equal(ev.prevenido, true, 'segura a navegação');
  const dl = doDl(p, 'nofiscal_plano_escolhido').at(-1);
  assert.equal(dl.plano, 'pro');
  assert.equal(typeof dl.eventCallback, 'function', 'o GTM avisa quando terminou');

  const px = fbq.find((a) => a[0] === 'track' && a[1] === 'AddToCart');
  assert.deepEqual(js(px[2]), { value: 129, currency: 'BRL', content_name: 'nó.fiscal Pro', content_ids: ['nofiscal-pro-mensal'], content_type: 'product' });
  assert.equal(px[3].eventID, dl.event_id);

  assert.equal(fetches.length, 1);
  const f = fetches[0];
  assert.equal(f.url, FN_CAPI);
  assert.equal(f.init.keepalive, true);
  assert.equal(f.init.method, 'POST');
  assert.equal(f.corpo.event_name, 'AddToCart');
  assert.equal(f.corpo.event_id, dl.event_id, 'dedup com o Pixel');
  assert.equal(f.corpo.event_source_url, 'https://www.notechstack.com.br/agentes/fiscal/');
  assert.equal(f.corpo.fbp, 'fb.1.1761140000000.111');
  assert.deepEqual(f.corpo.custom_data, { value: 129, currency: 'BRL', content_name: 'nó.fiscal Pro', content_ids: ['nofiscal-pro-mensal'], content_type: 'product' });

  await esvaziar();
  assert.deepEqual(p.reg.navegou, [pro.href], 'navega depois do envio (ou dos 300 ms)');
});

test('AddToCart: Ctrl/Cmd-clique e botão do meio não seguram nada', async () => {
  const { p, fetches, pro } = lp();
  const ctrl = pro.clicar({ ctrlKey: true });
  const cmd = pro.clicar({ metaKey: true });
  const meio = pro.clicar({ tipo: 'auxclick', button: 1 });
  assert.equal(ctrl.prevenido || cmd.prevenido || meio.prevenido, false);
  await esvaziar();
  assert.deepEqual(p.reg.navegou, [], 'a nova aba fica com o navegador');
  assert.equal(fetches.length, 3, 'mas o evento sai nos três');
});

test('AddToCart no anual leva o ciclo no content_ids', () => {
  const { p, fbq } = lp();
  p.ctx.noFiscalMedicao.planoEscolhido('inicial', 'planos', 'anual');
  const px = fbq.filter((a) => a[1] === 'AddToCart').at(-1);
  assert.deepEqual(js(px[2].content_ids), ['nofiscal-inicial-anual']);
  assert.equal(px[2].value, 470.4);
});

test('Escritório e Agência: Lead no dataLayer, no Pixel e na CAPI, sem segurar o WhatsApp', async () => {
  const { p, fbq, fetches, escritorio, agencia } = lp();
  const ev = escritorio.clicar();
  assert.equal(ev.prevenido, false, 'o WhatsApp abre em outra aba na hora');
  agencia.clicar();
  const leads = doDl(p, 'nofiscal_lead');
  assert.equal(leads.length, 2);
  assert.equal(leads[0].plano, 'escritorio');
  assert.equal(leads[0].canal, 'whatsapp');
  assert.match(leads[0].event_id, /^nofiscal-lead-[0-9a-z-]+$/);
  assert.equal(leads[1].plano, 'agencia');

  const px = fbq.filter((a) => a[0] === 'track' && a[1] === 'Lead');
  assert.equal(px.length, 2);
  assert.deepEqual(js(px[0][2]), { content_name: 'nó.fiscal Escritório', content_category: 'nofiscal' });
  assert.equal(px[0][3].eventID, leads[0].event_id);
  assert.equal(px[1][2].content_name, 'nó.fiscal Agência');

  const capi = fetches.filter((f) => f.corpo.event_name === 'Lead');
  assert.equal(capi.length, 2);
  assert.equal(capi[0].corpo.event_id, leads[0].event_id);
  assert.equal(capi[0].init.keepalive, true);
  assert.deepEqual(capi[0].corpo.custom_data, { content_name: 'nó.fiscal Escritório', content_category: 'nofiscal' });
  await esvaziar();
  assert.deepEqual(p.reg.navegou, []);
});

test('sem consentimento: dataLayer sim, Pixel e CAPI não', async () => {
  for (const c of [null, 'denied']) {
    const { p, fbq, fetches, pro, escritorio } = lp({ consentimento: c });
    pro.clicar();
    escritorio.clicar();
    assert.equal(doDl(p, 'nofiscal_plano_escolhido').length, 1);
    assert.equal(doDl(p, 'nofiscal_lead').length, 1);
    assert.equal(fbq.filter((a) => a[0] === 'track').length, 0, 'nada de track no Pixel');
    assert.equal(fetches.length, 0, 'nada na CAPI');
    assert.equal(p.ctx.noFiscalMedicao.capi.length, 0);
    await esvaziar();
    assert.equal(p.reg.navegou.length, 1, 'segue para o cadastro');
  }
});

test('fora de produção: nada sai do navegador e a navegação é a do próprio link', async () => {
  const { p, fetches, pro } = lp({ producao: false });
  const ev = pro.clicar();
  assert.equal(fetches.length, 0);
  assert.equal(p.ctx.noFiscalMedicao.capi.length, 1, 'o corpo fica guardado para conferir');
  assert.equal(ev.prevenido, false, 'sem envio a esperar, o link segue sozinho');
  await esvaziar();
  assert.deepEqual(p.reg.navegou, []);
});
