/* ══════════════════════════════════════════════════════════════════════
   Escritório nó · cena 3D isométrica de /agentes/
   three.js puro, geometria feita aqui (sem GLB): blocos arredondados em
   osso, bege e madeira clara, como a matéria da home (cenas3d.js).
   Três mesas em coluna (nó.fiscal, Auditor, mesa vaga), a recepção com o
   "nó." plano no balcão e, à direita, a sala envidraçada "nó tech stack".
   Só as duas pessoas, móveis, plantas e objetos de escritório: nada além disso.
   Contrato: .tasks/agentes-escritorio-frentes.md (montarEscritorio).
   ══════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const LOGO_BALCAO = '/brand/logo/svg/no-tinta-ponto-azul.svg';
const R2 = Math.SQRT1_2;
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const suave = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/* cores de marca lidas dos tokens da página (brand/tokens/tokens.css);
   o valor entre parênteses é só o fallback quando o CSS não carregou */
function token(nome, padrao){
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  } catch (e) {}
  return padrao;
}
const MARCA = {
  azul: token('--no-azul', '#3D63DB'), verde: token('--no-verde', '#30A46C'),
  ambar: token('--no-ambar', '#EDA33B'), tinta: token('--no-tinta', '#141414')
};
/* matéria da cena: bege/osso quente, madeira clara, tinta nos monitores */
const COR = {
  piso: 0xE6DCCB, parede: 0xF3EDE3, madeira: 0xDBBB8E, madeiraEscura: 0xC9A579,
  branco: 0xF9F6F0, osso: 0xEFE8DC, tinta: 0x1E1C1A, grafite: 0x4A4744, tela: 0x121722,
  folha: 0x3C9D66, folhaEscura: 0x2E7F52, vaso: 0xD9C4A7, vasoEscuro: 0xB89B7B,
  sofa: 0xEEE6D9, pele1: 0xF2CBA9, pele2: 0x8A5A3E, cabelo1: 0x2A1E19, cabelo2: 0x1A1412,
  vidro: 0xD9E6F7, metal: 0xE8E4DC
};
const FONTE = "'Sora', system-ui, sans-serif";

/* ── matéria: material por cor, geometria arredondada com a base em y=0 ── */
const materiais = new Map();
function mat(cor, opts){
  const k = cor + JSON.stringify(opts || {});
  if (!materiais.has(k)) materiais.set(k, new THREE.MeshStandardMaterial(Object.assign({ color: cor, roughness: .86, metalness: 0 }, opts || {})));
  return materiais.get(k);
}
function sombra(m){ m.castShadow = true; m.receiveShadow = true; return m; }
function bloco(w, h, d, r, cor, opts){
  const g = new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2, h / 2, d / 2));
  g.translate(0, h / 2, 0);
  return sombra(new THREE.Mesh(g, mat(cor, opts)));
}
function cilindro(rTopo, rBase, h, cor, seg = 24){
  const g = new THREE.CylinderGeometry(rTopo, rBase, h, seg);
  g.translate(0, h / 2, 0);
  return sombra(new THREE.Mesh(g, mat(cor)));
}
function esfera(r, cor, seg = 18){
  return sombra(new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(8, seg - 4)), mat(cor)));
}
/* coordenadas de composição: u desce na tela (x+z), v vai para a direita (x-z) */
function emUV(obj, u, v, y = 0){ obj.position.set((u + v) * R2, y, (u - v) * R2); return obj; }

/* ── etiqueta: chip branco arredondado, ponto colorido e texto em Sora ── */
function chip({ texto, cor, mesa, tam = 30, peso = 600, alturaMundo = .5, ancora = [0, .5] }){
  const dpr = 3, pad = 22, ponto = 9, alt = 56, entre = 34;
  const linhas = texto.split('\n');
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d');
  const fonte = peso + ' ' + tam + "px " + FONTE;
  c.font = fonte;
  const larg = Math.max(...linhas.map(l => c.measureText(l).width));
  const recuo = cor ? ponto * 2 + 12 : 0;
  const w = pad + recuo + larg + pad, h = alt + (linhas.length - 1) * entre;
  cv.width = Math.ceil(w * dpr); cv.height = Math.ceil(h * dpr);
  c.scale(dpr, dpr);
  const r = linhas.length > 1 ? 18 : h / 2;
  c.beginPath(); c.roundRect(0, 0, w, h, r);
  c.fillStyle = '#FFFFFF'; c.fill();
  c.lineWidth = 1.5; c.strokeStyle = 'rgba(20,20,20,.08)'; c.stroke();
  const px = { x: Math.round((pad + ponto) * dpr), y: Math.round(h / 2 * dpr) };
  if (cor){ c.fillStyle = cor; c.beginPath(); c.arc(pad + ponto, h / 2, ponto, 0, Math.PI * 2); c.fill(); }
  c.font = fonte; c.fillStyle = MARCA.tinta; c.textBaseline = 'middle';
  linhas.forEach((l, i) => c.fillText(l, pad + recuo, h / 2 + (i - (linhas.length - 1) / 2) * entre));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  sp.renderOrder = 20;
  const k = alturaMundo / alt;
  sp.scale.set(w * k, h * k, 1);
  sp.center.set(ancora[0], ancora[1]);
  sp.userData = { mesa, texto: linhas.join(' '), ponto: cor ? px : null };
  return sp;
}
/* placa da sala: "nó" + ponto azul + "tech stack", num chip branco */
function placaTechStack(){
  const dpr = 3, pad = 20, h = 52;
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d');
  const f1 = "800 30px " + FONTE, f2 = "600 24px " + FONTE;
  c.font = f1; const w1 = c.measureText('nó').width;
  c.font = f2; const w2 = c.measureText('tech stack').width;
  const pontoW = 8, gap = 6, w = pad + w1 + 2 + pontoW + gap + w2 + pad;
  cv.width = Math.ceil(w * dpr); cv.height = Math.ceil(h * dpr);
  c.scale(dpr, dpr);
  c.beginPath(); c.roundRect(0, 0, w, h, 12); c.fillStyle = '#FFFFFF'; c.fill();
  c.lineWidth = 1.5; c.strokeStyle = 'rgba(20,20,20,.08)'; c.stroke();
  c.textBaseline = 'alphabetic'; c.fillStyle = MARCA.tinta;
  const base = h / 2 + 11;
  c.font = f1; c.fillText('nó', pad, base);
  c.fillStyle = MARCA.azul; c.fillRect(pad + w1 + 2, base - pontoW, pontoW, pontoW);
  c.fillStyle = MARCA.tinta; c.font = f2; c.fillText('tech stack', pad + w1 + 2 + pontoW + gap, base);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  sp.renderOrder = 20;
  const k = .5 / h; sp.scale.set(w * k, h * k, 1);
  sp.userData.texto = 'nó tech stack';
  return sp;
}

/* ── mobília ── */
function planta(escala = 1, fase = 0){
  const g = new THREE.Group();
  g.add(cilindro(.2, .15, .32, COR.vaso));
  const folhas = new THREE.Group(); folhas.position.y = .32; g.add(folhas);
  const cores = [COR.folha, COR.folhaEscura, COR.folha, COR.folhaEscura, COR.folha];
  for (let i = 0; i < 5; i++){
    const f = esfera(.19, cores[i], 14);
    f.scale.set(.55, 1.35, .55);
    const a = i * Math.PI * 2 / 5 + fase;
    f.position.set(Math.cos(a) * .13, .22, Math.sin(a) * .13);
    f.rotation.set(Math.sin(a) * .55, 0, -Math.cos(a) * .55);
    folhas.add(f);
  }
  const miolo = esfera(.17, COR.folha, 14); miolo.scale.set(.7, 1.3, .7); miolo.position.y = .32; folhas.add(miolo);
  g.scale.setScalar(escala);
  g.userData.folhas = folhas; g.userData.fase = fase;
  return g;
}
function monitor({ larg = .84, alt = .52 } = {}){
  const g = new THREE.Group();
  g.add(cilindro(.16, .19, .025, COR.tinta));
  const haste = bloco(.05, .2, .08, .01, COR.tinta); haste.position.y = .02; g.add(haste);
  const corpo = bloco(.05, alt, larg, .03, COR.tinta); corpo.position.y = .2; g.add(corpo);
  /* a tela olha para -x (para quem senta); o brilho pisca mesmo visto de lado */
  const tela = new THREE.Mesh(new THREE.PlaneGeometry(larg - .08, alt - .08),
    new THREE.MeshStandardMaterial({ color: COR.tela, emissive: MARCA.azul, emissiveIntensity: .3, roughness: .4 }));
  tela.rotation.y = -Math.PI / 2; tela.position.set(-.027, .2 + alt / 2, 0); g.add(tela);
  g.userData.tela = tela;
  return g;
}
function cadeira(){
  const g = new THREE.Group();
  g.add(cilindro(.3, .3, .04, COR.grafite));
  const haste = cilindro(.035, .035, .4, COR.grafite); g.add(haste);
  const assento = bloco(.64, .1, .64, .05, COR.branco); assento.position.y = .4; g.add(assento);
  const encosto = bloco(.09, .58, .6, .045, COR.branco); encosto.position.set(-.3, .48, 0); g.add(encosto);
  return g;
}
function luminaria(){
  const g = new THREE.Group();
  g.add(cilindro(.12, .13, .03, COR.tinta));
  const haste = cilindro(.02, .02, .55, COR.tinta, 10); g.add(haste);
  const braco = bloco(.4, .03, .03, .01, COR.tinta); braco.position.set(-.17, .55, 0); braco.rotation.z = .35; g.add(braco);
  const cabeca = cilindro(.05, .13, .17, COR.tinta, 18); cabeca.position.set(-.36, .42, 0); cabeca.rotation.z = Math.PI + .5; g.add(cabeca);
  return g;
}
function caneca(){
  const g = new THREE.Group();
  g.add(cilindro(.055, .05, .11, COR.branco, 16));
  const alca = new THREE.Mesh(new THREE.TorusGeometry(.035, .012, 8, 16), mat(COR.branco));
  alca.position.set(.06, .06, 0); g.add(alca);
  return g;
}
function livros(cores, deitados = true){
  const g = new THREE.Group();
  let y = 0;
  cores.forEach((cor, i) => {
    const l = deitados ? bloco(.34 - i * .02, .055, .25, .012, cor) : bloco(.05, .3 - (i % 2) * .04, .22, .01, cor);
    if (deitados){ l.position.set((i % 2) * .03, y, 0); l.rotation.y = (i % 2 ? -1 : 1) * .12; y += .055; }
    else l.position.set(i * .06, 0, 0);
    g.add(l);
  });
  return g;
}

/* ── personagem: corpo em cápsula, cabeça redonda, cabelo simples, camisa
      branca e crachá na cor do agente. Olha para +x (para o monitor). ── */
function personagem({ agente, pele, cabelo: corCabelo, cracha: corCracha }){
  const g = new THREE.Group(); g.name = 'personagem-' + agente; g.userData.agente = agente;
  const tronco = new THREE.Group(); tronco.position.y = .42; g.add(tronco);
  const corpo = sombra(new THREE.Mesh(new THREE.CapsuleGeometry(.27, .34, 6, 18), mat(COR.branco, { roughness: .95 })));
  corpo.position.y = .38; tronco.add(corpo);
  const cordao = bloco(.02, .22, .03, .005, COR.grafite); cordao.position.set(.27, .4, .06); cordao.rotation.y = -.25; tronco.add(cordao);
  const cracha = sombra(new THREE.Mesh(new THREE.BoxGeometry(.04, .17, .14), mat(corCracha, { roughness: .55 })));
  cracha.position.set(.275, .31, .1); cracha.rotation.y = -.4; tronco.add(cracha);
  const bracos = [-1, 1].map(lado => {
    const b = new THREE.Group(); b.position.set(.1, .62, lado * .29);
    const gb = new THREE.CapsuleGeometry(.075, .28, 4, 12); gb.translate(0, -.19, 0);
    b.add(sombra(new THREE.Mesh(gb, mat(COR.branco, { roughness: .95 }))));
    const mao = esfera(.08, pele, 12); mao.position.y = -.4; b.add(mao);
    b.rotation.z = 1.15; b.rotation.y = lado * .12;
    tronco.add(b); return b;
  });
  const pescoco = new THREE.Group(); pescoco.position.y = .76; tronco.add(pescoco);
  const cabeca = esfera(.3, pele, 26); cabeca.position.y = .26; pescoco.add(cabeca);
  const cab = sombra(new THREE.Mesh(new THREE.SphereGeometry(.318, 24, 12, 0, Math.PI * 2, 0, Math.PI * .56), mat(corCabelo)));
  cab.position.set(-.02, .27, 0); cab.rotation.z = .42; pescoco.add(cab);
  [-1, 1].forEach(lado => {
    const olho = new THREE.Mesh(new THREE.SphereGeometry(.034, 10, 8), mat(COR.tinta, { roughness: .4 }));
    olho.position.set(.265, .27, lado * .105); olho.scale.set(.6, 1, 1); pescoco.add(olho);
  });
  const marca = new THREE.Object3D(); marca.position.y = 1.15; g.add(marca);
  g.userData.partes = { tronco, pescoco, bracos, corpo, cabeca, cracha, marca };
  return g;
}

/* ── mesa: tampo de madeira comprido em z, gaveteiro branco, monitor olhando
      para quem senta (de costas para nós), teclado, e a cadeira atrás ── */
function mesa({ id, ocupante, extras = [] }){
  const g = new THREE.Group(); g.name = 'mesa-' + id; g.userData.mesa = id;
  const tampo = bloco(1.15, .08, 2.3, .035, COR.madeira); tampo.position.y = .7; g.add(tampo);
  const gav = bloco(.95, .66, .74, .05, COR.branco); gav.position.set(0, .04, .64); g.add(gav);
  [-.3, .3].forEach(dx => { const p = cilindro(.045, .045, .66, COR.osso, 10); p.position.set(dx, .04, -1.0); g.add(p); });
  const puxador = bloco(.02, .02, .3, .005, COR.grafite); puxador.position.set(.48, .5, .64); g.add(puxador);
  const mon = monitor(); mon.position.set(.3, .78, 0); g.add(mon);
  const teclado = bloco(.34, .03, .56, .012, COR.grafite); teclado.position.set(-.2, .78, 0); g.add(teclado);
  const mouse = bloco(.1, .035, .07, .02, COR.branco); mouse.position.set(-.22, .78, .42); g.add(mouse);
  const cad = cadeira(); cad.position.set(-1.0, 0, 0); g.add(cad);
  if (ocupante){ ocupante.position.set(-.98, 0, 0); g.add(ocupante); }
  extras.forEach(([obj, x, y, z]) => { obj.position.set(x, y, z); g.add(obj); });
  const marca = new THREE.Object3D(); marca.position.y = .75; g.add(marca);
  g.userData.marca = marca; g.userData.tela = mon.userData.tela;
  return g;
}

/* ── recepção: balcão rodado 45° para a frente olhar a câmera; o "nó." é um
      plano com a textura do SVG oficial, sem extrusão, sombra nem contorno ── */
function recepcao(){
  const g = new THREE.Group(); g.name = 'recepcao'; g.rotation.y = Math.PI / 4;
  const corpo = bloco(2.1, 1.0, .9, .14, COR.branco); g.add(corpo);
  const tampo = bloco(2.2, .06, 1.0, .03, COR.madeira); tampo.position.y = 1.0; g.add(tampo);
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1 * 964 / 1633),
    new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, color: 0xFFFFFF }));
  logo.name = 'logo-balcao'; logo.position.set(0, .5, .456);
  logo.castShadow = false; logo.receiveShadow = false; logo.visible = false; g.add(logo);
  const mon = monitor({ larg: .62, alt: .4 }); mon.position.set(.5, 1.06, -.05); mon.rotation.y = -Math.PI / 4 + .35; g.add(mon);
  const pasta = bloco(.3, .03, .22, .01, COR.osso); pasta.position.set(-.5, 1.06, .1); pasta.rotation.y = .3; g.add(pasta);
  const marca = new THREE.Object3D(); marca.position.y = .6; g.add(marca);
  g.userData.marca = marca; g.userData.logo = logo; g.userData.tela = mon.userData.tela;
  return g;
}
function sofa(){
  const g = new THREE.Group();
  const base = bloco(.9, .42, 1.9, .12, COR.sofa); g.add(base);
  const enc = bloco(.24, .5, 1.9, .08, COR.sofa); enc.position.set(-.33, .4, 0); g.add(enc);
  [-1, 1].forEach(l => { const b = bloco(.9, .24, .2, .07, COR.sofa); b.position.set(0, .42, l * .85); g.add(b); });
  const almofada = bloco(.36, .3, .36, .09, COR.osso); almofada.position.set(-.1, .42, -.35); almofada.rotation.y = .25; g.add(almofada);
  return g;
}
function mesinha(){
  const g = new THREE.Group();
  g.add(cilindro(.03, .03, .34, COR.grafite, 10));
  const tampo = cilindro(.4, .4, .05, COR.madeiraEscura, 28); tampo.position.y = .34; g.add(tampo);
  const base = cilindro(.18, .2, .025, COR.grafite, 20); g.add(base);
  return g;
}

/* ── sala envidraçada "nó tech stack" ── */
function salaTechStack(){
  const g = new THREE.Group(); g.name = 'sala-tech-stack';
  const W = 2.4, D = 2.2, H = 2.0;
  const piso = bloco(W, .08, D, .04, COR.osso); g.add(piso);
  const vidro = new THREE.Mesh(new THREE.BoxGeometry(W - .02, H, D - .02),
    new THREE.MeshStandardMaterial({ color: COR.vidro, transparent: true, opacity: .3, roughness: .12, depthWrite: false, side: THREE.DoubleSide }));
  vidro.position.y = .08 + H / 2; vidro.renderOrder = 5; g.add(vidro);
  const pilar = (x, z) => { const p = bloco(.08, H, .08, .02, COR.metal); p.position.set(x, .08, z); g.add(p); };
  [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]].forEach(([x, z]) => pilar(x, z));
  const topoX = bloco(W + .08, .08, .08, .02, COR.metal), topoX2 = topoX.clone();
  topoX.position.set(0, H + .04, -D / 2); topoX2.position.set(0, H + .04, D / 2); g.add(topoX, topoX2);
  const topoZ = bloco(.08, .08, D + .08, .02, COR.metal), topoZ2 = topoZ.clone();
  topoZ.position.set(-W / 2, H + .04, 0); topoZ2.position.set(W / 2, H + .04, 0); g.add(topoZ, topoZ2);
  /* rack de servidores com luzes, uma mesa pequena e um monitor */
  const rack = bloco(.55, 1.4, .45, .04, COR.tinta); rack.position.set(-.7, .08, -.6); g.add(rack);
  const luzes = [];
  for (let i = 0; i < 5; i++){
    const l = new THREE.Mesh(new THREE.BoxGeometry(.03, .05, .05),
      new THREE.MeshBasicMaterial({ color: i % 2 ? MARCA.verde : MARCA.azul, toneMapped: false }));
    l.position.set(-.415, .4 + i * .2, -.6 + (i % 2 ? .1 : -.1)); g.add(l); luzes.push(l);
  }
  const mesaS = bloco(.65, .06, 1.0, .03, COR.madeira); mesaS.position.set(.6, .7, .25); g.add(mesaS);
  const pe = bloco(.55, .64, .1, .02, COR.branco); pe.position.set(.6, .08, -.2); g.add(pe);
  const mon = monitor({ larg: .56, alt: .38 }); mon.position.set(.72, .76, .25); mon.rotation.y = Math.PI; g.add(mon);
  const pl = planta(.5, 2); pl.position.set(-.8, .08, .75); g.add(pl);
  /* ponto azul onde as linhas chegam */
  const no = new THREE.Mesh(new THREE.SphereGeometry(.14, 18, 14), new THREE.MeshBasicMaterial({ color: MARCA.azul, toneMapped: false }));
  no.position.set(-.1, 1.0, .85); g.add(no);
  const placa = placaTechStack(); placa.position.set(0, H + .55, 0); g.add(placa);
  const marca = new THREE.Object3D(); marca.position.y = 1.0; g.add(marca);
  g.userData = { marca, placa, no, luzes, tela: mon.userData.tela, planta: pl };
  return g;
}

/* ── câmera isométrica: direção fixa, alvo e altura do quadro animados ── */
const ELEV = 35 * Math.PI / 180, AZ = Math.PI / 4;
const DIR_CAM = new THREE.Vector3(Math.cos(ELEV) * Math.sin(AZ), Math.sin(ELEV), Math.cos(ELEV) * Math.cos(AZ)).normalize();

export async function montarEscritorio(canvas, { aoProgresso } = {}){
  const progresso = p => { try { if (typeof aoProgresso === 'function') aoProgresso(clamp01(p)); } catch (e) {} };
  const REDUZ = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* renderer: rejeita sem WebGL */
  let renderer;
  try {
    const ctx = canvas.getContext('webgl2', { antialias: true, alpha: true, powerPreference: 'low-power' })
      || canvas.getContext('webgl', { antialias: true, alpha: true, powerPreference: 'low-power' });
    if (!ctx) throw new Error('sem contexto');
    renderer = new THREE.WebGLRenderer({ canvas, context: ctx, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (e) {
    throw new Error('WebGL indisponível: ' + (e && e.message || e));
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  progresso(.08);

  /* as etiquetas são desenhadas uma vez em canvas: esperam a Sora (até 2,5 s) */
  try {
    await Promise.race([
      Promise.all([document.fonts.load("600 30px 'Sora'"), document.fonts.load("800 30px 'Sora'")]),
      new Promise(r => setTimeout(r, 2500))
    ]);
  } catch (e) {}
  progresso(.2);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 200);
  /* intensidades na escala física do three (π = albedo cheio): o piso sai
     perto da própria cor, as sombras ficam leves */
  scene.add(new THREE.HemisphereLight(0xFFFBF3, 0xE3D9CB, 2.0));
  const sol = new THREE.DirectionalLight(0xFFF3E3, 1.4);
  sol.position.set(-7, 14, 4); sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048); sol.shadow.bias = -.0006; sol.shadow.normalBias = .02;
  Object.assign(sol.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 });
  scene.add(sol); scene.add(sol.target);
  const contra = new THREE.DirectionalLight(0xFFF6EA, .5); contra.position.set(10, 5, 3); scene.add(contra);

  /* ── piso e paredes ── */
  const raiz = new THREE.Group(); scene.add(raiz);
  const X0 = -6.4, X1 = 12, Z0 = -8.4, Z1 = 12;
  const piso = bloco(X1 - X0, .3, Z1 - Z0, .14, COR.piso);
  piso.position.set((X0 + X1) / 2, -.3, (Z0 + Z1) / 2); raiz.add(piso);
  const paredeEsq = bloco(.24, 2.2, Z1 - Z0, .05, COR.parede); paredeEsq.position.set(X0 + .12, 0, (Z0 + Z1) / 2); raiz.add(paredeEsq);
  const paredeFundo = bloco(X1 - X0, 2.2, .24, .05, COR.parede); paredeFundo.position.set((X0 + X1) / 2, 0, Z0 + .12); raiz.add(paredeFundo);
  const rodape = bloco(.3, .12, Z1 - Z0, .02, COR.osso); rodape.position.set(X0 + .15, 0, (Z0 + Z1) / 2); raiz.add(rodape);
  const rodape2 = bloco(X1 - X0, .12, .3, .02, COR.osso); rodape2.position.set((X0 + X1) / 2, 0, Z0 + .15); raiz.add(rodape2);

  /* prateleira na parede da esquerda, acima da mesa do fiscal */
  const prateleira = new THREE.Group(); prateleira.position.set(X0 + .4, 1.45, -4.3); raiz.add(prateleira);
  prateleira.add(bloco(.34, .04, 1.6, .01, COR.madeira));
  const lv = livros([COR.osso, 0x9FB4E8, COR.tinta, COR.osso, 0xE8C98E], false); lv.position.set(-.1, .04, -.55); lv.rotation.y = Math.PI / 2; prateleira.add(lv);
  const plPrat = planta(.42, 1); plPrat.position.set(0, .04, .5); prateleira.add(plPrat);
  const quadro = bloco(.04, .7, .9, .01, COR.branco); quadro.position.set(X0 + .26, 1.1, -1.6); raiz.add(quadro);
  const quadroMiolo = bloco(.02, .5, .7, .005, 0xD6DEF3); quadroMiolo.position.set(X0 + .29, 1.2, -1.6); raiz.add(quadroMiolo);

  /* ── personagens e mesas ── */
  const personagens = {
    fiscal: personagem({ agente: 'fiscal', pele: COR.pele1, cabelo: COR.cabelo1, cracha: MARCA.verde }),
    auditor: personagem({ agente: 'auditor', pele: COR.pele2, cabelo: COR.cabelo2, cracha: MARCA.azul })
  };
  const mesas = {
    fiscal: mesa({ id: 'fiscal', ocupante: personagens.fiscal, extras: [[luminaria(), .25, .78, -.9], [planta(.5, 0), .15, .78, .95]] }),
    auditor: mesa({ id: 'auditor', ocupante: personagens.auditor, extras: [[caneca(), -.3, .78, -.75], [planta(.45, 3), .2, .78, -.95]] }),
    vaga: mesa({ id: 'vaga', extras: [[planta(.5, 5), .2, .78, .95], [livros([COR.osso, 0x9FB4E8]), -.2, .78, -.8]] })
  };
  emUV(mesas.fiscal, -5.6, -.1); emUV(mesas.auditor, -2.1, .75); emUV(mesas.vaga, 1.4, 1.6);
  Object.values(mesas).forEach(m => raiz.add(m));
  const chips = {
    fiscal: chip({ texto: 'nó.fiscal', cor: MARCA.verde, mesa: 'fiscal' }),
    auditor: chip({ texto: 'Auditor', cor: MARCA.azul, mesa: 'auditor' }),
    vaga: chip({ texto: 'um problema\nseu aqui?', cor: MARCA.ambar, mesa: 'vaga', tam: 26, ancora: [.5, .5] })
  };
  chips.fiscal.position.set(.1, 1.45, -.4); mesas.fiscal.add(chips.fiscal);
  chips.auditor.position.set(.1, 1.45, -.4); mesas.auditor.add(chips.auditor);
  chips.vaga.position.set(.1, 1.4, -.6); mesas.vaga.add(chips.vaga);

  /* ── recepção, estar e plantas ── */
  const rec = recepcao(); emUV(rec, 4.7, -1.2); raiz.add(rec);
  const sof = sofa(); emUV(sof, 5.1, 2.2); raiz.add(sof);
  const mesinhaG = mesinha(); emUV(mesinhaG, 5.8, 1.1); raiz.add(mesinhaG);
  const plantas = [];
  const poePlanta = (u, v, esc, fase) => { const p = planta(esc, fase); emUV(p, u, v); raiz.add(p); plantas.push(p); return p; };
  poePlanta(-7.4, 1.7, 1.5, 0); poePlanta(-3.6, -2.3, 1.3, 1); poePlanta(.3, 3.9, 1.4, 2);
  poePlanta(3.3, -.3, 1.25, 3); poePlanta(6.5, -2.9, 1.5, 4); poePlanta(6.9, 3.4, 1.3, 5); poePlanta(2.4, 4.7, 1.2, 6);
  const pilhaLivros = livros([COR.osso, COR.tinta, 0xE8C98E]); emUV(pilhaLivros, -3.9, -1.9); pilhaLivros.rotation.y = .4; raiz.add(pilhaLivros);
  const tapete = bloco(2.6, .02, 2.6, .05, COR.osso, { roughness: 1 }); emUV(tapete, 5.4, 1.8, 0); tapete.castShadow = false; raiz.add(tapete);
  plantas.push(mesas.fiscal.children.find(c => c.userData.folhas), mesas.auditor.children.find(c => c.userData.folhas), mesas.vaga.children.find(c => c.userData.folhas), plPrat);

  /* ── sala "nó tech stack" e as três linhas azuis ── */
  const sala = salaTechStack(); emUV(sala, -5.0, 4.8); raiz.add(sala);
  plantas.push(sala.userData.planta);
  const matLinha = new THREE.MeshBasicMaterial({ color: MARCA.azul, toneMapped: false });
  const alvoLinhas = sala.userData.no.getWorldPosition(new THREE.Vector3());
  raiz.updateMatrixWorld(true);
  sala.userData.no.getWorldPosition(alvoLinhas);
  const linhas = ['fiscal', 'auditor', 'vaga'].map((id, i) => {
    const ini = mesas[id].userData.marca.getWorldPosition(new THREE.Vector3()); ini.y = .95;
    const fim = alvoLinhas.clone();
    /* saem da mesa para a direita da tela (+x, -z) e chegam à sala por baixo (+x, +z) */
    const c1 = ini.clone().add(new THREE.Vector3(1.5, .5 + i * .2, -1.5));
    const c2 = fim.clone().add(new THREE.Vector3(1.2 + i * .4, .35, 1.2 + i * .4));
    const curva = new THREE.CubicBezierCurve3(ini, c1, c2, fim);
    const geo = new THREE.TubeGeometry(curva, 72, .055, 8, false);
    const m = new THREE.Mesh(geo, matLinha); m.renderOrder = 6; m.frustumCulled = false; raiz.add(m);
    geo.setDrawRange(0, 0);
    const pulso = new THREE.Mesh(new THREE.SphereGeometry(.1, 12, 10), matLinha); pulso.visible = false; raiz.add(pulso);
    const pino = new THREE.Mesh(new THREE.SphereGeometry(.09, 12, 10), matLinha); pino.position.copy(ini); pino.visible = false; raiz.add(pino);
    return { curva, geo, total: geo.index.count, mesh: m, pulso, pino };
  });
  progresso(.5);

  /* logo do balcão: textura do SVG oficial */
  const logo = rec.userData.logo;
  try {
    const tex = await Promise.race([
      new Promise((res, rej) => new THREE.TextureLoader().load(LOGO_BALCAO, res, undefined, rej)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), 6000))
    ]);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    logo.material.map = tex; logo.material.needsUpdate = true; logo.visible = true;
  } catch (e) { console.warn('[escritorio] logo do balcão não carregou', e); }
  progresso(.7);

  /* ── enquadramentos ── */
  const upCam = new THREE.Vector3(), dirCam = new THREE.Vector3();
  camera.position.copy(DIR_CAM).multiplyScalar(60); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  upCam.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const uv = (u, v, y = 0) => new THREE.Vector3((u + v) * R2, y, (u - v) * R2);
  const QUADROS = {
    tela1: { alvo: uv(-1.1, .15, .9), altura: 13.4 },
    fecho: { alvo: uv(-1.3, 2.3, 1.0), altura: 19.5 }
  };
  const estado = { foco: null, alvoY: .2, tFecho: 0 };
  const desejado = { alvo: QUADROS.tela1.alvo.clone(), altura: QUADROS.tela1.altura };
  const atual = { alvo: QUADROS.tela1.alvo.clone(), altura: QUADROS.tela1.altura };
  let aspecto = 1;
  /* A Tela 1 foi afinada em 375×812. Num canvas mais largo (a hero da página), a largura de
     mundo visível é a mesma e a altura encolhe até o mínimo em que a coluna inteira cabe. */
  const LARGURA_TELA1 = QUADROS.tela1.altura * 375 / 812;
  const alturaTela1 = () => clamp(LARGURA_TELA1 / aspecto, 9.6, QUADROS.tela1.altura);
  const tmp = new THREE.Vector3();
  function calculaDesejado(){
    const q = suave(clamp01(estado.tFecho));
    if (estado.foco && mesas[estado.foco]){
      const altura = 8.0;
      /* a marca da mesa é o mesmo ponto que inspecionar() projeta em mesa-<id> */
      mesas[estado.foco].userData.marca.getWorldPosition(desejado.alvo);
      /* um tico para a direita, para a etiqueta da mesa caber no quadro (Tela 2) */
      desejado.alvo.add(uv(0, .7, 0));
      /* o centro da mesa fica a alvoY × altura do canvas, a partir do topo */
      const ndcY = 1 - 2 * clamp01(estado.alvoY);
      tmp.copy(upCam).multiplyScalar(ndcY * altura / 2);
      desejado.alvo.sub(tmp);
      desejado.altura = altura;
    } else {
      desejado.alvo.lerpVectors(QUADROS.tela1.alvo, QUADROS.fecho.alvo, q);
      desejado.altura = lerp(alturaTela1(), QUADROS.fecho.altura, q);
    }
  }
  function aplicaCamera(){
    camera.position.copy(atual.alvo).addScaledVector(DIR_CAM, 60);
    camera.lookAt(atual.alvo);
    const h = atual.altura, w = h * aspecto;
    camera.left = -w / 2; camera.right = w / 2; camera.top = h / 2; camera.bottom = -h / 2;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  }
  function passoCamera(dt){
    calculaDesejado();
    const k = 1 - Math.exp(-dt * 6);
    atual.alvo.lerp(desejado.alvo, k);
    atual.altura += (desejado.altura - atual.altura) * k;
    if (atual.alvo.distanceTo(desejado.alvo) < .002 && Math.abs(desejado.altura - atual.altura) < .002){
      atual.alvo.copy(desejado.alvo); atual.altura = desejado.altura;
    }
    aplicaCamera();
  }

  /* ── animação: nunca para enquanto há quadro ── */
  const amp = REDUZ ? 0 : 1;
  const telas = [mesas.fiscal.userData.tela, mesas.auditor.userData.tela, mesas.vaga.userData.tela, rec.userData.tela, sala.userData.tela];
  function anima(t){
    ['fiscal', 'auditor'].forEach((id, i) => {
      const p = personagens[id].userData.partes, f = i * 2.1;
      p.tronco.scale.set(1, 1 + .022 * amp * Math.sin(t * 1.7 + f), 1);
      p.tronco.rotation.z = -.07 + .035 * amp * Math.sin(t * .6 + f);
      p.pescoco.rotation.z = .09 * amp * Math.sin(t * .85 + f);
      p.pescoco.rotation.x = .1 * amp * Math.sin(t * 1.25 + f + 1);
      p.pescoco.rotation.y = .12 * amp * Math.sin(t * .45 + f);
      p.bracos.forEach((b, j) => {
        b.rotation.z = 1.15 + .14 * amp * Math.sin(t * (9 + i) + j * Math.PI * .5 + f);
        b.rotation.y = (j ? 1 : -1) * .12 + .05 * amp * Math.sin(t * 3 + j);
      });
    });
    telas.forEach((tela, i) => {
      const pisca = .18 + .22 * (.5 + .5 * Math.sin(t * 2.2 + i * 1.3)) + (Math.sin(t * 7 + i) > .92 ? .18 : 0);
      tela.material.emissiveIntensity = REDUZ ? .3 : pisca;
    });
    plantas.forEach((pl, i) => {
      const f = pl.userData.folhas; if (!f) return;
      f.rotation.z = .05 * amp * Math.sin(t * 1.1 + i * .9);
      f.rotation.x = .04 * amp * Math.sin(t * .8 + i * 1.7);
    });
    sala.userData.luzes.forEach((l, i) => { l.visible = REDUZ || Math.sin(t * (2 + i * .7) + i) > -.6; });
    /* linhas azuis: aparecem conforme o fecho cresce */
    const q = suave(clamp01(estado.tFecho));
    linhas.forEach((l, i) => {
      const qi = suave(clamp01((q - i * .12) / .76));
      l.geo.setDrawRange(0, Math.floor(l.total * qi / 3) * 3);
      l.pino.visible = qi > 0;
      l.pulso.visible = qi >= 1 && !REDUZ;
      if (l.pulso.visible) l.curva.getPointAt((t * .22 + i * .33) % 1, l.pulso.position);
    });
    sala.userData.no.scale.setScalar(q >= 1 ? 1 + .12 * amp * Math.sin(t * 3) : 1);
  }

  /* ── tamanho, laço, pausa ── */
  let ultW = 0, ultH = 0;
  function redimensiona(){
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    if (!w || !h || (w === ultW && h === ultH)) return false;
    ultW = w; ultH = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    aspecto = w / h;
    aplicaCamera();
    return true;
  }
  let nQuadros = 0, rodando = false, raf = 0, visivel = false, pausado = false, destruido = false, ultimo = 0;
  const oculta = () => document.hidden || document.visibilityState === 'hidden';
  function desenha(agora){
    anima(agora / 1000);
    renderer.render(scene, camera);
    nQuadros++;
  }
  function laco(agora){
    if (!rodando) { raf = 0; return; }
    const dt = Math.min((agora - ultimo) / 1000, .1); ultimo = agora;
    passoCamera(dt);
    desenha(agora);
    raf = requestAnimationFrame(laco);
  }
  function liga(){
    const deve = visivel && !oculta() && !pausado && !destruido;
    if (deve && !rodando){ rodando = true; ultimo = performance.now(); raf = requestAnimationFrame(laco); }
    else if (!deve && rodando){ rodando = false; if (raf) cancelAnimationFrame(raf); raf = 0; }
  }
  const io = new IntersectionObserver(es => { visivel = es.some(e => e.isIntersecting); liga(); }, { threshold: 0 });
  io.observe(canvas);
  const aoVisib = () => liga();
  document.addEventListener('visibilitychange', aoVisib);
  const ro = new ResizeObserver(() => { redimensiona(); });
  ro.observe(canvas);

  /* ── toque nas mesas ── */
  const raycaster = new THREE.Raycaster(), ponteiro = new THREE.Vector2();
  const ouvintes = [];
  function mesaEm(ev){
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ponteiro.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ponteiro, camera);
    const hits = raycaster.intersectObjects(Object.values(mesas), true);
    for (const h of hits){
      let o = h.object;
      while (o && !o.userData.mesa) o = o.parent;
      if (o) return o.userData.mesa;
    }
    return null;
  }
  const aoClicar = ev => { const m = mesaEm(ev); if (m) ouvintes.forEach(fn => { try { fn(m); } catch (e) { console.error(e); } }); };
  canvas.addEventListener('click', aoClicar);
  const fino = typeof matchMedia === 'function' && matchMedia('(pointer:fine)').matches;
  const aoMover = ev => { canvas.style.cursor = mesaEm(ev) ? 'pointer' : ''; };
  if (fino) canvas.addEventListener('pointermove', aoMover);

  /* ── primeiro quadro ── */
  calculaDesejado(); atual.alvo.copy(desejado.alvo); atual.altura = desejado.altura;
  redimensiona(); aplicaCamera();
  progresso(.85);
  await new Promise(r => setTimeout(r, 0));
  renderer.compile(scene, camera);
  progresso(.95);
  desenha(performance.now());
  progresso(1);

  /* ── inspeção: tudo lido dos objetos reais ── */
  const v3 = new THREE.Vector3();
  function projeta(obj){
    obj.getWorldPosition(v3).project(camera);
    const w = canvas.clientWidth || ultW, h = canvas.clientHeight || ultH;
    let vis = v3.x >= -1 && v3.x <= 1 && v3.y >= -1 && v3.y <= 1 && v3.z >= -1 && v3.z <= 1;
    for (let o = obj; o; o = o.parent) if (!o.visible) vis = false;
    return { x: Math.round((v3.x + 1) / 2 * w * 10) / 10, y: Math.round((1 - v3.y) / 2 * h * 10) / 10, visivel: vis };
  }
  function corPixel(img, px){
    if (!img || !px) return null;
    const d = img.getContext('2d').getImageData(px.x, px.y, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map(n => n.toString(16).padStart(2, '0')).join('');
  }
  function inspecionar(){
    camera.updateMatrixWorld();
    const enquadramento = estado.foco ? estado.foco : (estado.tFecho >= .5 ? 'fecho' : 'tela1');
    const projetados = {
      'mesa-fiscal': projeta(mesas.fiscal.userData.marca),
      'mesa-auditor': projeta(mesas.auditor.userData.marca),
      'mesa-vaga': projeta(mesas.vaga.userData.marca),
      'recepcao': projeta(rec.userData.marca),
      'personagem-fiscal': projeta(personagens.fiscal.userData.partes.marca),
      'personagem-auditor': projeta(personagens.auditor.userData.partes.marca),
      'sala-tech-stack': projeta(sala.userData.marca),
      'etiqueta-fiscal': projeta(chips.fiscal),
      'etiqueta-auditor': projeta(chips.auditor),
      'etiqueta-vaga': projeta(chips.vaga)
    };
    const etiquetas = ['fiscal', 'auditor', 'vaga'].map(id => {
      const sp = chips[id];
      return { mesa: sp.userData.mesa, texto: sp.userData.texto, cor: corPixel(sp.material.map.image, sp.userData.ponto) };
    });
    const mapa = logo.material.map && logo.material.map.image && logo.material.map.image.src
      ? new URL(logo.material.map.image.src, location.href).pathname : null;
    const logoBalcao = {
      geometria: logo.geometry.type, castShadow: logo.castShadow, receiveShadow: logo.receiveShadow,
      contorno: logo.children.some(c => c.isLine || c.isLineSegments) || !!logo.material.wireframe,
      mapa
    };
    const pers = ['fiscal', 'auditor'].map(id => {
      const p = personagens[id].userData.partes;
      return { agente: personagens[id].userData.agente, corpo: p.corpo.geometry.type, cabeca: p.cabeca.geometry.type, cracha: '#' + p.cracha.material.color.getHexString() };
    });
    return {
      enquadramento, projetados, etiquetas, logoBalcao, personagens: pers,
      linhas: { cor: '#' + linhas[0].mesh.material.color.getHexString(), quantidade: linhas.length },
      placaSala: sala.userData.placa.userData.texto
    };
  }

  function destruir(){
    destruido = true; liga();
    io.disconnect(); ro.disconnect();
    document.removeEventListener('visibilitychange', aoVisib);
    canvas.removeEventListener('click', aoClicar);
    if (fino) canvas.removeEventListener('pointermove', aoMover);
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
    });
    materiais.clear();
    renderer.dispose();
  }

  return {
    focar(mesa, { alvoY = .2 } = {}){
      estado.foco = mesa === 'fiscal' || mesa === 'auditor' ? mesa : null;
      estado.alvoY = alvoY;
    },
    fecho(t){ estado.tFecho = clamp01(Number(t) || 0); },
    aoTocarMesa(fn){ if (typeof fn === 'function') ouvintes.push(fn); },
    pausar(){ pausado = true; liga(); },
    retomar(){ pausado = false; liga(); },
    quadros(){ return nQuadros; },
    /* os pôsteres saem sem os chips: na versão estática as etiquetas são os botões HTML */
    mostrarEtiquetas(v){ for (const sp of Object.values(chips)) sp.visible = !!v; },
    destruir,
    inspecionar
  };
}
