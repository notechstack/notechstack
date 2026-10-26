/* Escritório nó · texturas da cena do Blender (passo 1 de 2)
   Rasteriza com o Chromium do Playwright tudo o que tem texto ou marca, a partir dos
   arquivos oficiais (SVG do logo e do lockup, Sora em woff2, tokens):
   logo do balcão, placa da sala, crachás, chips de etiqueta (prévia), telas,
   teclado, lombadas de livros e frente de rack.
   Uso: node .tasks/blender/gerar_texturas.cjs   →   .tasks/blender/texturas/*.png
   Depois: blender -b -P .tasks/blender/construir_escritorio.py */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
let pw;
try { pw = require('../../app/node_modules/@playwright/test'); }
catch { pw = require('C:/Users/lucca/projetos/notechstack/app/node_modules/@playwright/test'); }

const RAIZ = path.resolve(__dirname, '..', '..');
const SAIDA = path.join(__dirname, 'texturas');
fs.mkdirSync(SAIDA, { recursive: true });
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const servidor = http.createServer((req, res) => {
  const rota = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (/\.env|_sensivel|\.git\//.test(rota)) { res.statusCode = 404; return res.end(); }
  if (rota === '/__pagina') { res.setHeader('Content-Type', TIPOS['.html']); return res.end(pagina); }
  const f = path.join(RAIZ, rota);
  res.setHeader('Content-Type', TIPOS[path.extname(f)] || 'application/octet-stream');
  fs.createReadStream(f).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
});

const tokens = fs.readFileSync(path.join(RAIZ, 'brand/tokens/tokens.css'), 'utf8');
const tk = n => tokens.match(new RegExp(n.replace(/-/g, '\\-') + ':\\s*(#[0-9a-fA-F]{6})'))[1];
const C = { azul: tk('--no-azul'), verde: tk('--no-verde'), ambar: tk('--no-ambar'), tinta: tk('--no-tinta'), osso: tk('--no-osso') };

/* cada peça: id do elemento, largura e altura em px de textura, HTML */
/* chip de etiqueta: círculo cheio com halo (R4) e contorno na cor do agente (R9, R10).
   soContorno: só o anel do contorno, num PNG do mesmo tamanho, para piscar por cima (R10). */
const BORDA = 8;   // px de textura: ≈ 2,4 px em 375 de largura na Tela 1
const chip = (id, cor, texto, larg, contorno, soContorno) => `
  <div id="${id}" class="peca" style="width:${larg}px;height:140px;display:flex;align-items:center;justify-content:center">
    <div style="display:flex;align-items:center;gap:20px;border-radius:999px;padding:20px 38px 20px 22px;
      ${soContorno ? 'background:transparent' : 'background:#fff;box-shadow:0 8px 22px rgba(60,40,20,.18)'};
      border:${BORDA}px solid ${contorno || 'transparent'}">
      <span style="position:relative;width:60px;height:60px;flex:none;${soContorno ? 'visibility:hidden' : ''}">
        <span style="position:absolute;inset:-12px;border-radius:50%;background:${cor};opacity:.22"></span>
        <span style="position:absolute;inset:0;border-radius:50%;background:${cor}"></span>
      </span>
      <span style="font:600 46px/1.15 Sora;color:${C.tinta};letter-spacing:-.01em;white-space:nowrap;${soContorno ? 'visibility:hidden' : ''}">${texto}</span>
    </div>
  </div>`;
const cracha = (id, cor, logo) => `
  <div id="${id}" class="peca" style="width:300px;height:420px;background:#fff;border-radius:26px;overflow:hidden;position:relative">
    <div style="height:112px;background:${cor};position:relative">
      <div style="position:absolute;left:50%;top:24px;width:70px;height:16px;margin-left:-35px;border-radius:9px;background:rgba(255,255,255,.85)"></div>
    </div>
    <img src="/brand/logo/svg/${logo}" style="display:block;width:200px;margin:56px auto 0">
    <div style="width:170px;height:16px;border-radius:8px;background:#E7E2D9;margin:44px auto 0"></div>
    <div style="width:110px;height:16px;border-radius:8px;background:#EFEBE4;margin:18px auto 0"></div>
  </div>`;
const tela = (id, k) => {
  const linhas = Array.from({ length: 9 }, (_, i) => `<div style="height:12px;margin:0 0 14px;border-radius:6px;width:${[78, 62, 90, 55, 84, 70, 46, 88, 64][(i + k * 3) % 9]}%;background:${i % 4 === 0 ? '#9DB2E9' : '#CBD5E8'}"></div>`).join('');
  return `<div id="${id}" class="peca" style="width:512px;height:320px;background:#EEF2FA;display:flex;flex-direction:column">
    <div style="height:30px;background:${C.azul}"></div>
    <div style="flex:1;display:flex;gap:22px;padding:22px">
      <div style="width:130px;background:#fff;border-radius:10px;padding:14px">${'<div style="height:14px;border-radius:7px;background:#DCE3F2;margin-bottom:16px"></div>'.repeat(6)}</div>
      <div style="flex:1">${linhas}<div style="width:90px;height:16px;border-radius:8px;background:${k % 2 ? C.verde : C.azul}"></div></div>
    </div></div>`;
};
const teclado = `<div id="teclado" class="peca" style="width:512px;height:180px;background:#2B2A28;padding:10px;display:grid;grid-template-columns:repeat(15,1fr);gap:6px">
  ${Array.from({ length: 75 }, (_, i) => `<div style="background:#4A4844;border-radius:5px;${i === 64 ? 'grid-column:span 5' : ''}"></div>`).filter((_, i) => !(i > 64 && i < 69)).join('')}</div>`;
const livros = (() => {
  const cores = ['#F1ECE2', '#2F3B52', '#D9B98A', '#8FA6C9', '#EDE3D2', '#B85C3C', '#5E7A55', '#1F1F1F', '#E8C98E', '#A7B7D9'];
  let s = 7, x = 0, h = '';
  const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  while (x < 1024){
    const w = 36 + r() * 46, alt = 160 + r() * 96;
    h += `<div style="position:absolute;left:${x}px;bottom:0;width:${w - 4}px;height:${alt}px;background:${cores[Math.floor(r() * cores.length)]}"><div style="margin:22px 8px 0;height:7px;background:rgba(255,255,255,.4)"></div></div>`;
    x += w;
  }
  return `<div id="livros" class="peca" style="position:relative;width:1024px;height:256px;background:#E9DFCF">${h}</div>`;
})();
const rack = `<div id="rack" class="peca" style="width:256px;height:512px;background:#161616;padding:14px;display:flex;flex-direction:column;gap:10px">
  ${Array.from({ length: 9 }, () => `<div style="flex:1;background:#222;border-radius:4px;display:flex;align-items:center;gap:9px;padding:0 12px">
    <div style="width:22px;height:12px;background:#3A3A3A"></div>${'<div style="width:9px;height:26px;background:#2E2E2E"></div>'.repeat(9)}</div>`).join('')}</div>`;

const pagina = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/brand/fonts/fonts.css">
<style>html,body{margin:0;background:transparent} .peca{margin:20px;box-sizing:border-box} body{display:flex;flex-wrap:wrap;align-items:flex-start}</style></head><body>
  <div id="logo" class="peca" style="width:1633px;height:964px;background:url(/brand/logo/svg/no-tinta-ponto-azul.svg) center/contain no-repeat"></div>
  <div id="placa" class="peca" style="width:1400px;height:340px;background:#fff;border-radius:60px;display:flex;align-items:center;justify-content:center">
    <img src="/brand/lockup/svg/no-tech-stack-tinta-ponto-azul.svg" style="width:1180px"></div>
  ${cracha('cracha-fiscal', C.verde, 'no-tinta-ponto-verde.svg')}
  ${cracha('cracha-auditor', C.azul, 'no-tinta-ponto-azul.svg')}
  ${chip('chip-fiscal', C.verde, 'nó.fiscal', 460, C.verde)}
  ${chip('chip-auditor', C.azul, 'nó.auditor', 480, C.azul)}
  ${chip('chip-vaga', C.ambar, 'criar uma automação', 660, null)}
  ${chip('chip-vaga-contorno', C.ambar, 'criar uma automação', 660, C.ambar, true)}
  ${tela('tela-0', 0)}${tela('tela-1', 1)}${tela('tela-2', 2)}
  ${teclado}${livros}${rack}
</body></html>`;

(async () => {
  await new Promise(r => servidor.listen(0, '127.0.0.1', r));
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 2400, height: 1200 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${servidor.address().port}/__pagina`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
    for (const id of ['logo', 'placa', 'cracha-fiscal', 'cracha-auditor', 'chip-fiscal', 'chip-auditor', 'chip-vaga', 'chip-vaga-contorno', 'tela-0', 'tela-1', 'tela-2', 'teclado', 'livros', 'rack']){
      await page.locator('#' + id).screenshot({ path: path.join(SAIDA, id + '.png'), omitBackground: true });
      console.log('ok', id);
    }
    fs.writeFileSync(path.join(SAIDA, 'cores.json'), JSON.stringify(C, null, 2));
  } finally { await browser.close(); servidor.close(); }
})().catch(e => { console.error('FAIL', e); servidor.close(); process.exitCode = 1; });
