/* ══════════════════════════════════════════════════════════════════════
   Escritório nó · móveis, plantas e a sala "nó tech stack"
   Cada construtor devolve um grupo com a base em y = 0. O que precisa se
   mexer ou ser lido depois (telas, logo, placa, luzes) leva userData.vivo
   e fica fora da assadura.
   ══════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import {
  COR, MARCA, FONTE, mat, malha, caixa, cilindro, esfera, geoCaixa, geoCilindro, geoPlaca, formaArredondada,
  M, juntar, matVC, semente, texturaMadeira, texturaTeclado, texturaTela, texturaSombra, texturaRack, texturaLivros
} from './cena-materia.js';

const PI = Math.PI;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/* texturas compartilhadas, criadas na primeira vez */
let TX = null;
export function texturas(){
  if (!TX) TX = { madeira: texturaMadeira(), teclado: texturaTeclado(), sombra: texturaSombra(), rack: texturaRack(), livros: texturaLivros() };
  return TX;
}
const madeira = (cor = COR.madeira) => mat(cor, { map: texturas().madeira, roughness: .55, envMapIntensity: .6 });
const ceramica = cor => mat(cor, { roughness: .38, envMapIntensity: .8 });
const tecido = cor => mat(cor, { roughness: .95, envMapIntensity: .35 });
const metalPreto = () => mat(COR.tinta, { roughness: .42, metalness: .25, envMapIntensity: .7 });

/* sombra de contato: mancha macia no chão, junta numa malha só na assadura */
const matSombras = new Map();
export function sombraContato(w, d, forca = .2, y = .006){
  const f = Math.round(forca * 100) / 100;
  if (!matSombras.has(f)) matSombras.set(f, new THREE.MeshBasicMaterial({ color: 0x3A2A1A, alphaMap: texturas().sombra, transparent: true, opacity: f, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), matSombras.get(f));
  m.rotation.x = -PI / 2; m.position.y = y; m.renderOrder = 1;
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

/* ── plantas: folha afilada dobrada na nervura, vasos de cerâmica torneados ── */
const geoFolhas = new Map();
function geoFolha(comp, larg, curva, ponta = .8){
  const k = [comp, larg, curva, ponta].join('|');
  if (geoFolhas.has(k)) return geoFolhas.get(k);
  const g = new THREE.PlaneGeometry(1, 1, 2, 9), p = g.attributes.position;
  for (let i = 0; i < p.count; i++){
    const u = p.getX(i), v = p.getY(i) + .5;
    const w = Math.pow(Math.sin(PI * Math.pow(v, ponta)), .85);
    p.setXYZ(i, u * larg * w, v * comp, curva * comp * v * v + Math.abs(u) * larg * .35 * w);
  }
  g.computeVertexNormals();
  geoFolhas.set(k, g);
  return g;
}
function vaso(r, h, cor, forma = 0){
  const pts = forma === 1
    ? [V(0, 0), V(r * .62, 0), V(r * .7, .02), V(r * .98, h * .55), V(r, h * .92), V(r * 1.04, h), V(r * .94, h)]
    : forma === 2
      ? [V(0, 0), V(r * .8, 0), V(r * .86, .015), V(r * .9, h * .8), V(r * .96, h), V(r * .88, h)]
      : [V(0, 0), V(r * .7, 0), V(r * .78, .02), V(r, h * .35), V(r * .97, h * .9), V(r * .9, h), V(r * .84, h)];
  const g = new THREE.Group();
  g.add(malha(new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p.x, p.y)), 28), ceramica(cor)));
  const terra = cilindro(r * .86, r * .86, .01, COR.terra, 20, { roughness: 1 }); terra.position.y = h * .9; g.add(terra);
  return g;
}
const VASOS = { branco: COR.ceramica, terracota: COR.terracota, salvia: COR.salvia, areia: COR.areia, creme: 0xEDE4D6 };
const VERDES = [COR.folha, COR.folhaClara, COR.folhaEscura];
export function planta(tipo = 'zz', escala = 1, s = 1, corVaso = 'branco'){
  const r = semente(s * 97 + 13), g = new THREE.Group();
  const folhaMat = i => mat(VERDES[i % 3], { side: THREE.DoubleSide, roughness: .62, envMapIntensity: .45 });
  let rv = .17, hv = .26, forma = 0;
  if (tipo === 'espada'){ rv = .15; hv = .3; forma = 2; }
  if (tipo === 'suculenta'){ rv = .085; hv = .09; forma = 1; }
  if (tipo === 'arbusto'){ rv = .2; hv = .3; forma = 0; }
  g.add(vaso(rv, hv, VASOS[corVaso] || corVaso, forma));
  const topo = hv * .9;
  const folha = (geo, i, x, y, z, rx, ry, rz) => { const m = malha(geo, folhaMat(i)); m.position.set(x, y, z); m.rotation.set(rx, ry, rz, 'YXZ'); g.add(m); };
  if (tipo === 'espada'){
    for (let i = 0; i < 9; i++){
      const a = i * 2.4 + r(), d = .02 + r() * .06;
      folha(geoFolha(.55 + r() * .35, .075 + r() * .03, .04 + r() * .05, .95), i, Math.cos(a) * d, topo, Math.sin(a) * d, -.08 - r() * .18, a, 0);
    }
  } else if (tipo === 'suculenta'){
    for (let i = 0; i < 11; i++){
      const a = i * 2.4, cam = i < 6 ? 0 : 1;
      folha(geoFolha(.085 - cam * .025, .045, .5, .7), i, 0, topo, 0, -(.9 - cam * .45) + r() * .1, a, 0);
    }
  } else if (tipo === 'arbusto'){
    const fol = new THREE.SphereGeometry(1, 12, 9);
    for (let i = 0; i < 13; i++){
      const a = i * 2.4 + r(), d = .04 + r() * .14, y = topo + .12 + r() * .34;
      const m = malha(fol, mat(VERDES[i % 3], { roughness: .7, envMapIntensity: .4 }));
      m.position.set(Math.cos(a) * d, y, Math.sin(a) * d); m.scale.setScalar(.1 + r() * .07); g.add(m);
    }
    const caule = cilindro(.012, .016, .3, 0x6B5340, 6); caule.position.y = topo; g.add(caule);
  } else {
    /* zz / costela-de-adão miúda: talos arqueados com folhas largas, como na referência */
    const n = tipo === 'costela' ? 7 : 12;
    for (let i = 0; i < n; i++){
      const a = i * 2.4 + r() * .4, inc = .25 + (i / n) * .75 + r() * .15;
      const geo = tipo === 'costela' ? geoFolha(.32 + r() * .1, .26, .25, .7) : geoFolha(.36 + r() * .2, .15 + r() * .04, .26 + r() * .12, .62);
      folha(geo, i, Math.cos(a) * .02, topo, Math.sin(a) * .02, -inc, a, 0);
    }
  }
  g.scale.setScalar(escala);
  return g;
}

/* ── objetos de mesa ── */
export function monitor({ larg = .64, alt = .4, variante = 0 } = {}){
  /* a tela olha para -z (para quem senta); vemos as costas pretas */
  const g = new THREE.Group(), m = metalPreto();
  g.add(malha(geoCaixa(.26, .018, .19, .008, 2), m));
  const haste = malha(geoCaixa(.05, .27, .028, .012, 2), m); haste.position.set(0, .01, .045); haste.rotation.x = -.08; g.add(haste);
  const corpo = malha(geoCaixa(larg, alt, .032, .014, 2), m); corpo.position.set(0, .2, 0); g.add(corpo);
  const costas = malha(geoCaixa(larg * .5, alt * .55, .04, .02, 2), m); costas.position.set(0, .2 + alt * .2, .02); g.add(costas);
  const tex = texturaTela(variante);
  const tela = new THREE.Mesh(new THREE.PlaneGeometry(larg - .035, alt - .035),
    new THREE.MeshStandardMaterial({ map: tex, emissive: 0xFFFFFF, emissiveMap: tex, emissiveIntensity: .75, roughness: .3, envMapIntensity: .4 }));
  tela.rotation.y = PI; tela.position.set(0, .2 + alt / 2, -.0175); tela.userData.vivo = true;
  g.add(tela);
  g.userData.tela = tela;
  return g;
}
export function teclado(){
  const g = new THREE.Group();
  g.add(malha(geoCaixa(.42, .02, .14, .008, 2), mat(COR.grafite, { roughness: .6 })));
  const tampa = new THREE.Mesh(new THREE.PlaneGeometry(.4, .125), mat(0xFFFFFF, { map: texturas().teclado, roughness: .6 }));
  tampa.rotation.x = -PI / 2; tampa.position.y = .0205; tampa.receiveShadow = true; g.add(tampa);
  return g;
}
export function mouse(){
  const m = malha(new THREE.SphereGeometry(1, 16, 10, 0, PI * 2, 0, PI / 2), mat(COR.branco, { roughness: .35 }));
  m.scale.set(.033, .022, .05);
  const g = new THREE.Group(); g.add(m);
  const pad = malha(geoCaixa(.2, .004, .17, .004, 1), mat(COR.grafite, { roughness: .9 })); pad.position.y = -.004; g.add(pad);
  return g;
}
export function caneca(cor = COR.branco, liquido = 0x4A2C1C){
  const g = new THREE.Group();
  g.add(malha(new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(.044, 0), new THREE.Vector2(.05, .01), new THREE.Vector2(.052, .1), new THREE.Vector2(.047, .1), new THREE.Vector2(.045, .02)], 20), ceramica(cor)));
  const cafe = cilindro(.045, .045, .005, liquido, 16, { roughness: .2 }); cafe.position.y = .085; g.add(cafe);
  const alca = malha(new THREE.TorusGeometry(.028, .009, 8, 14, PI * 1.3), ceramica(cor));
  alca.position.set(.052, .052, 0); alca.rotation.z = -PI * .65; g.add(alca);
  return g;
}
export function luminaria(){
  const g = new THREE.Group(), m = metalPreto();
  g.add(malha(geoCilindro(.085, .095, .025, 24), m));
  const b1 = malha(geoCilindro(.011, .011, .36, 8), m); b1.position.y = .02; b1.rotation.z = .28; g.add(b1);
  const j = esfera(.022, COR.tinta, 10); j.position.set(-.098, .36, 0); g.add(j);
  const b2 = malha(geoCilindro(.011, .011, .3, 8), m); b2.position.set(-.098, .36, 0); b2.rotation.z = -1.25; g.add(b2);
  const cabeca = new THREE.Group(); cabeca.position.set(.19, .45, 0); cabeca.rotation.z = -2.35; g.add(cabeca);
  const cupula = malha(new THREE.SphereGeometry(.1, 20, 10, 0, PI * 2, 0, PI * .5), mat(COR.tinta, { side: THREE.DoubleSide, roughness: .4, metalness: .2 }));
  cupula.scale.set(1, 1.15, 1); cabeca.add(cupula);
  const lamp = esfera(.04, 0xFFF2D6, 12, { emissive: 0xFFE2B0, emissiveIntensity: 1.2 }); lamp.position.y = .02; lamp.castShadow = false; cabeca.add(lamp);
  return g;
}
export function papeis(n = 3, s = 1){
  const g = new THREE.Group(), r = semente(s * 31);
  for (let i = 0; i < n; i++){
    const p = malha(geoCaixa(.21, .004, .29, .002, 1), mat(i % 2 ? 0xFFFFFF : 0xF6F3EC, { roughness: .9 }));
    p.position.set((r() - .5) * .03, i * .004, (r() - .5) * .03); p.rotation.y = (r() - .5) * .35; g.add(p);
  }
  return g;
}
export function pilhaLivros(cores, s = 1){
  const g = new THREE.Group(), r = semente(s * 17);
  let y = 0;
  cores.forEach((cor, i) => {
    const h = .035 + r() * .02, w = .3 - r() * .06, d = .22 - r() * .03;
    const l = malha(geoCaixa(w, h, d, .008, 1), mat(cor, { roughness: .75 }));
    l.position.set((r() - .5) * .03, y, (r() - .5) * .02); l.rotation.y = (r() - .5) * .3; g.add(l);
    const miolo = malha(geoCaixa(w - .012, h - .01, d - .006, .002, 1), mat(0xFBF8F0, { roughness: .9 }));
    miolo.position.set(l.position.x + .008, y + .005, l.position.z); miolo.rotation.y = l.rotation.y; g.add(miolo);
    y += h;
  });
  return g;
}
export function caixaPreta(){
  const g = new THREE.Group();
  g.add(caixa(.26, .1, .17, .02, COR.tinta, { roughness: .45 }));
  const led = esfera(.008, MARCA.verde, 6, { emissive: MARCA.verde, emissiveIntensity: 1 }); led.position.set(.1, .06, .086); g.add(led);
  return g;
}

/* ── cadeira de escritório: base de cinco pés com rodízios, coluna, assento e encosto ── */
export function cadeira(cor = 0xE5DACA){
  const g = new THREE.Group(), preto = mat(COR.grafite, { roughness: .45, metalness: .2 });
  for (let i = 0; i < 5; i++){
    const a = i * PI * 2 / 5 + .3;
    const pe = malha(geoCaixa(.05, .035, .3, .015, 1), preto); pe.position.set(Math.sin(a) * .13, .055, Math.cos(a) * .13); pe.rotation.y = a; g.add(pe);
    const roda = malha(new THREE.SphereGeometry(.032, 10, 8), mat(COR.tinta, { roughness: .5 })); roda.scale.set(.8, 1, 1);
    roda.position.set(Math.sin(a) * .27, .032, Math.cos(a) * .27); g.add(roda);
  }
  const coluna = malha(geoCilindro(.03, .03, .32, 12), mat(COR.metal, { roughness: .3, metalness: .7 })); coluna.position.y = .06; g.add(coluna);
  const sob = malha(geoCaixa(.3, .04, .3, .015, 1), preto); sob.position.y = .36; g.add(sob);
  const assento = malha(geoCaixa(.54, .09, .52, .045, 3), tecido(cor)); assento.position.y = .39; g.add(assento);
  const haste = malha(geoCaixa(.06, .34, .04, .015, 1), preto); haste.position.set(0, .4, -.27); haste.rotation.x = -.1; g.add(haste);
  const encosto = malha(geoCaixa(.52, .5, .09, .045, 3), tecido(cor)); encosto.position.set(0, .55, -.29); encosto.rotation.x = -.12; g.add(encosto);
  [-1, 1].forEach(s => {
    const b = malha(geoCaixa(.035, .2, .035, .012, 1), preto); b.position.set(s * .27, .43, -.04); g.add(b);
    const apoio = malha(geoCaixa(.06, .03, .24, .014, 1), preto); apoio.position.set(s * .27, .62, -.02); g.add(apoio);
  });
  return g;
}

/* ── mesa de trabalho: tampo de carvalho com cantos redondos, gaveteiro branco e pés finos ──
   Quem senta fica em z < 0, de frente para +z; o monitor olha para quem senta. */
export const MESA = { larg: 2.2, prof: 1.0, alt: .72, assento: V(-.42, 0, -.74) };
export function mesa(id, { variante = 0, ocupada = true } = {}){
  const g = new THREE.Group(); g.name = 'mesa-' + id; g.userData.mesa = id;
  const { larg, prof, alt } = MESA, A = MESA.assento;
  const tampo = malha(geoPlaca(larg, prof, .16, .055, .012, 8), madeira()); tampo.position.y = alt - .055; g.add(tampo);
  const branco = mat(COR.branco, { roughness: .6 });
  /* pedestal branco largo sob a metade direita do tampo, como na referência */
  const pw = larg * .55, px = larg / 2 - pw / 2 - .07;
  const ped = malha(geoCaixa(pw, alt - .06, prof - .12, .07, 3), branco); ped.position.set(px, .005, 0); g.add(ped);
  const fresta = malha(geoCaixa(pw - .1, .006, .006, .002, 1), mat(0xE2DBD0)); fresta.position.set(px, alt * .55, -(prof - .12) / 2 - .002); g.add(fresta);
  [[-larg / 2 + .12, -prof / 2 + .12], [-larg / 2 + .12, prof / 2 - .12]].forEach(([x, z]) => {
    const pe = malha(geoCilindro(.022, .018, alt - .05, 10), branco); pe.position.set(x, 0, z); g.add(pe);
  });
  const trave = malha(geoCaixa(.03, .03, prof - .26, .01, 1), branco); trave.position.set(-larg / 2 + .12, .12, 0); g.add(trave);
  g.add(sombraContato(larg + .6, prof + 1.3, .2), sombraContato(.9, .9, .22));
  g.children[g.children.length - 1].position.set(A.x, .007, A.z - .05);

  /* monitor à frente e à esquerda de quem senta, virado para a pessoa (como na referência) */
  const mon = monitor({ variante, larg: .58, alt: .37 }); mon.position.set(A.x + .5, alt, .08); mon.rotation.y = .5; g.add(mon);
  const tec = teclado(); tec.position.set(A.x, alt, -.27); g.add(tec);
  const cad = cadeira(); cad.position.set(A.x, 0, A.z - .07); g.add(cad);
  const info = {
    grupo: g, tela: mon.userData.tela,
    teclado: V(0, alt + .022, -.27 - A.z),
    mouseLocal: V(A.x - .33, alt + .004, -.3), canecaLocal: V(A.x + .44, alt, -.31)
  };
  const marca = new THREE.Object3D(); marca.position.set(0, alt, 0); g.add(marca);
  g.userData.marca = marca; g.userData.tela = mon.userData.tela;
  /* alvo de toque: caixa invisível em volta da mesa, da cadeira e de quem senta */
  /* justa na silhueta: alta e funda demais, a caixa da mesa da frente cobriria a de trás na tela */
  const alvo = new THREE.Mesh(new THREE.BoxGeometry(larg + .1, 1.25, prof + .6), new THREE.MeshBasicMaterial());
  alvo.position.set(0, .625, -.3); alvo.visible = false; alvo.userData.vivo = true; alvo.userData.mesa = id; g.add(alvo);
  if (!ocupada){
    const ms = mouse(); ms.position.copy(info.mouseLocal); g.add(ms);
    cad.rotation.y = .22; cad.position.z -= .08;
  }
  return info;
}

/* ── recepção: balcão branco de cantos bem redondos; o "nó." é um plano com o SVG oficial ── */
export function recepcao(){
  const g = new THREE.Group(); g.name = 'recepcao';
  const W = 2.5, D = 1.0, H = 1.02;
  const corpo = malha(geoPlaca(W, D, .46, H, .03, 14), mat(COR.branco, { roughness: .55 })); g.add(corpo);
  const tampo = malha(geoPlaca(W + .08, D + .08, .5, .05, .015, 14), mat(COR.osso, { roughness: .5 })); tampo.position.y = H; g.add(tampo);
  const rodape = malha(geoPlaca(W - .04, D - .04, .44, .06, .01, 14), mat(COR.rodape, { roughness: .7 })); rodape.position.y = 0; rodape.scale.set(1.004, 1, 1.004); g.add(rodape);
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0 * 964 / 1633),
    new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, color: 0xFFFFFF }));
  logo.name = 'logo-balcao'; logo.position.set(0, .5, D / 2 + .004);
  logo.castShadow = false; logo.receiveShadow = false; logo.visible = false; logo.userData.vivo = true; g.add(logo);
  const mon = monitor({ larg: .56, alt: .36, variante: 1 }); mon.position.set(.35, H + .05, -.12); mon.rotation.y = .25; g.add(mon);
  const pl = planta('suculenta', 1.1, 4, 'branco'); pl.position.set(-.85, H + .05, -.15); g.add(pl);
  const pa = papeis(2, 3); pa.position.set(-.3, H + .05, .12); g.add(pa);
  g.add(sombraContato(W + .9, D + .9, .22));
  const marca = new THREE.Object3D(); marca.position.y = .55; g.add(marca);
  g.userData = { marca, logo, tela: mon.userData.tela };
  return g;
}

/* ── escada à esquerda: degraus brancos que sobem para o fundo, com mureta ── */
export function escada(n = 7, larg = 1.15, passo = .34, alt = .17){
  const g = new THREE.Group(), branco = mat(COR.base, { roughness: .6 }), lado = mat(COR.parede, { roughness: .7 });
  for (let i = 0; i < n; i++){
    const d = malha(geoCaixa(larg, alt * (i + 1), passo + .02, .03, 2), branco);
    d.position.set(0, 0, -i * passo); g.add(d);
    const borda = malha(geoCaixa(larg - .02, .012, .03, .006, 1), mat(COR.creme, { roughness: .5 }));
    borda.position.set(0, alt * (i + 1) - .004, -i * passo + passo / 2 - .005); g.add(borda);
  }
  const comp = n * passo, topo = n * alt;
  /* mureta do lado de fora, em rampa, e o patamar no alto */
  const forma = new THREE.Shape();
  forma.moveTo(passo / 2, 0); forma.lineTo(passo / 2, .55); forma.lineTo(-comp + passo / 2, topo + .55); forma.lineTo(-comp + passo / 2 - 1.2, topo + .55); forma.lineTo(-comp + passo / 2 - 1.2, 0);
  const mg = new THREE.ExtrudeGeometry(forma, { depth: .12, bevelEnabled: true, bevelSize: .02, bevelThickness: .02, bevelSegments: 2 });
  mg.rotateY(PI / 2); mg.translate(-larg / 2 - .07, 0, 0);
  g.add(malha(mg, lado));
  const pat = malha(geoCaixa(larg + .1, topo, 1.2, .04, 2), branco); pat.position.set(0, 0, -comp + passo / 2 - .6); g.add(pat);
  const corrimao = new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(V(larg / 2 - .05, .95, passo / 2), V(larg / 2 - .05, topo + .95, -comp + passo / 2)), 4, .022, 8), mat(COR.madeira, { map: texturas().madeira, roughness: .5 }));
  corrimao.castShadow = true; g.add(corrimao);
  for (let i = 0; i <= n; i += 2){
    const y0 = alt * Math.max(1, i), z = -i * passo + (i ? passo / 2 : 0);
    const h = .95 + alt * i - y0 + (i ? 0 : 0);
    const p = malha(geoCilindro(.012, .012, Math.max(.3, h), 8), mat(COR.grafite, { roughness: .4, metalness: .3 })); p.position.set(larg / 2 - .05, y0, z); g.add(p);
  }
  return g;
}

/* ── estante baixa com livros e vasos; prateleira de parede ── */
function fileiraLivros(w, h, d, s = 1){
  const t = texturas().livros.clone(); t.needsUpdate = true;
  t.offset.x = (s * .37) % 1; t.repeat.x = w / 1.1; t.wrapS = THREE.RepeatWrapping;
  /* bloco das páginas e, na frente, as lombadas */
  const g = new THREE.Group();
  const frente = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat(0xFFFFFF, { map: t, roughness: .8 })); frente.position.set(0, h / 2, d / 2 + .001); g.add(frente);
  const corpo = malha(geoCaixa(w, h, d, .004, 1), mat(0xE9DFCF, { roughness: .85 })); g.add(corpo);
  return g;
}
export function estante(w = 1.4, h = 1.05, d = .38){
  const g = new THREE.Group(), branco = mat(COR.branco, { roughness: .55 });
  g.add(malha(geoCaixa(w, .05, d, .015, 1), branco));
  [-1, 1].forEach(s => { const l = malha(geoCaixa(.04, h, d, .012, 1), branco); l.position.x = s * (w / 2 - .02); g.add(l); });
  const fundo = malha(geoCaixa(w, h, .02, .005, 1), mat(COR.osso)); fundo.position.z = -d / 2 + .01; g.add(fundo);
  [h * .5, h - .04].forEach(y => { const p = malha(geoCaixa(w, .035, d, .012, 1), branco); p.position.y = y; g.add(p); });
  const l1 = fileiraLivros(w * .55, .3, d * .7, 1); l1.position.set(-w * .2, .05, 0); g.add(l1);
  const l2 = fileiraLivros(w * .35, .26, d * .7, 2); l2.position.set(w * .27, h * .5 + .035, 0); g.add(l2);
  const p1 = planta('zz', .55, 3, 'terracota'); p1.position.set(w * .3, .05, 0); g.add(p1);
  const p2 = planta('suculenta', 1.2, 5, 'branco'); p2.position.set(-w * .3, h * .5 + .035, 0); g.add(p2);
  const p3 = planta('costela', .5, 7, 'creme'); p3.position.set(-w * .25, h, 0); g.add(p3);
  const lv = pilhaLivros([0xEDE3D2, 0x2F3B52, 0xD9B98A], 2); lv.position.set(w * .22, h, 0); lv.scale.setScalar(.8); g.add(lv);
  return g;
}
export function prateleira(w = 1.3){
  const g = new THREE.Group();
  const tabua = malha(geoCaixa(w, .045, .26, .012, 1), madeira()); g.add(tabua);
  [-1, 1].forEach(s => { const m = malha(geoCaixa(.025, .12, .2, .006, 1), mat(COR.grafite)); m.position.set(s * (w / 2 - .12), -.12, -.02); g.add(m); });
  const l = fileiraLivros(w * .45, .24, .18, 3); l.position.set(-w * .22, .045, 0); g.add(l);
  const p = planta('zz', .5, 9, 'branco'); p.position.set(w * .3, .045, 0); g.add(p);
  return g;
}
export function janela(w = 1.6, h = 1.2){
  const g = new THREE.Group(), moldura = mat(COR.branco, { roughness: .45 });
  const vidro = new THREE.Mesh(new THREE.PlaneGeometry(w - .08, h - .08), mat(0xE6EEF6, { roughness: .1, emissive: 0xF4F7FA, emissiveIntensity: .35, envMapIntensity: 1 }));
  vidro.position.set(0, h / 2, .02); vidro.receiveShadow = false; g.add(vidro);
  [[w, .06, 0], [w, .06, h - .06]].forEach(([ww, hh, y]) => { const b = malha(geoCaixa(ww, hh, .08, .015, 1), moldura); b.position.set(0, y, .02); g.add(b); });
  [-1, 0, 1].forEach(s => { const b = malha(geoCaixa(s ? .06 : .035, h, .08, .012, 1), moldura); b.position.set(s * (w / 2 - .03), 0, .02); g.add(b); });
  const peit = malha(geoCaixa(w + .14, .04, .2, .012, 1), moldura); peit.position.set(0, -.02, .08); g.add(peit);
  return g;
}

/* ── estar: sofá, poltrona, banco, mesinha e tapete ── */
export function sofa(w = 2.1){
  const g = new THREE.Group(), t = tecido(COR.tecido), t2 = tecido(0xEDE6DA);
  const pes = mat(COR.madeiraEscura, { roughness: .6 });
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => { const p = malha(geoCilindro(.025, .018, .1, 8), pes); p.position.set(a * (w / 2 - .1), 0, b * .3); g.add(p); });
  const base = malha(geoCaixa(w, .26, .86, .08, 3), t); base.position.y = .09; g.add(base);
  const enc = malha(geoCaixa(w, .44, .22, .1, 3), t); enc.position.set(0, .3, -.33); g.add(enc);
  [-1, 1].forEach(s => { const b = malha(geoCaixa(.2, .32, .86, .09, 3), t); b.position.set(s * (w / 2 - .1), .3, 0); g.add(b); });
  const n = 2, lw = (w - .42) / n;
  for (let i = 0; i < n; i++){
    const a = malha(geoCaixa(lw - .02, .13, .6, .06, 3), t2); a.position.set(-w / 2 + .21 + lw * (i + .5), .34, .07); g.add(a);
    const c = malha(geoCaixa(lw - .06, .36, .14, .07, 3), t2); c.position.set(-w / 2 + .21 + lw * (i + .5), .45, -.2); c.rotation.x = -.15; g.add(c);
  }
  const alm = malha(geoCaixa(.34, .3, .1, .06, 3), tecido(COR.areia)); alm.position.set(-w / 2 + .42, .47, -.1); alm.rotation.set(-.2, .3, .15); g.add(alm);
  g.add(sombraContato(w + .6, 1.4, .22));
  return g;
}
export function poltrona(){
  const g = new THREE.Group(), t = tecido(0xE2D6C3);
  const pes = mat(COR.madeiraEscura, { roughness: .6 });
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => { const p = malha(geoCilindro(.022, .016, .12, 8), pes); p.position.set(a * .3, 0, b * .28); p.rotation.set(b * .12, 0, -a * .12); g.add(p); });
  const base = malha(geoCaixa(.8, .24, .78, .1, 3), t); base.position.y = .11; g.add(base);
  const enc = malha(geoCaixa(.8, .5, .2, .1, 3), t); enc.position.set(0, .28, -.3); enc.rotation.x = -.12; g.add(enc);
  [-1, 1].forEach(s => { const b = malha(geoCaixa(.16, .28, .74, .08, 3), t); b.position.set(s * .33, .3, .02); g.add(b); });
  const as = malha(geoCaixa(.52, .12, .56, .06, 3), tecido(0xEAE0D0)); as.position.set(0, .34, .06); g.add(as);
  g.add(sombraContato(1.3, 1.3, .22));
  return g;
}
export function banco(w = 1.3){
  const g = new THREE.Group();
  const pes = mat(COR.grafite, { roughness: .5 });
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => { const p = malha(geoCilindro(.018, .018, .16, 8), pes); p.position.set(a * (w / 2 - .08), 0, b * .17); g.add(p); });
  const as = malha(geoCaixa(w, .2, .46, .08, 3), tecido(0xCFC7BA)); as.position.y = .15; g.add(as);
  const vinco = malha(geoCaixa(.012, .02, .44, .006, 1), tecido(0xBDB4A6)); vinco.position.set(0, .345, 0); g.add(vinco);
  g.add(sombraContato(w + .5, .9, .2));
  return g;
}
export function mesinha(r = .3, h = .42){
  const g = new THREE.Group(), m = madeira(COR.madeira);
  for (let i = 0; i < 3; i++){
    const a = i * PI * 2 / 3;
    const p = malha(geoCilindro(.018, .014, h, 8), m); p.position.set(Math.sin(a) * r * .55, 0, Math.cos(a) * r * .55);
    p.rotation.set(Math.cos(a) * .12, 0, -Math.sin(a) * .12); g.add(p);
  }
  const tampo = malha(geoCilindro(r, r, .04, 32), m); tampo.position.y = h; g.add(tampo);
  g.add(sombraContato(r * 3, r * 3, .2));
  return g;
}
export function tapete(w, d, cor = COR.tapete){
  const t = malha(geoPlaca(w, d, .12, .018, .006, 6), mat(cor, { roughness: 1, envMapIntensity: .2 }));
  t.castShadow = false;
  return t;
}

/* ── sala envidraçada "nó tech stack": caixilho preto, vidro claro, racks com LEDs e uma mesa ── */
const LOCKUP = '/brand/lockup/svg/no-tech-stack-tinta-ponto-azul.svg';
function placaLockup(){
  /* chapa branca com o lockup oficial desenhado por cima (sem redesenhar o "nó.") */
  const W = 1400, H = 340, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  c.fillStyle = '#FFFFFF'; c.beginPath(); c.roundRect(0, 0, W, H, 60); c.fill();
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const img = new Image();
  img.onload = () => {
    const lw = W - 220, lh = lw * 964 / 7060;
    c.drawImage(img, (W - lw) / 2, (H - lh) / 2, lw, lh);
    tex.needsUpdate = true;
  };
  img.src = LOCKUP;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 2.5 * H / W), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  m.userData.vivo = true; m.userData.texto = 'nó tech stack';
  return m;
}
export function rack(h = 1.75){
  const g = new THREE.Group();
  g.add(caixa(.58, h, .62, .03, COR.tinta, { roughness: .4, metalness: .2 }));
  const frente = new THREE.Mesh(new THREE.PlaneGeometry(.5, h - .12), mat(0xFFFFFF, { map: texturas().rack, roughness: .5, metalness: .2 }));
  frente.position.set(0, h / 2, .311); g.add(frente);
  const topo = malha(geoCaixa(.6, .03, .64, .01, 1), mat(COR.grafite, { roughness: .5 })); topo.position.y = h; g.add(topo);
  return g;
}
export function salaTechStack({ W = 4.0, D = 3.0, H = 2.35 } = {}){
  const g = new THREE.Group(); g.name = 'sala-tech-stack';
  const piso = malha(geoCaixa(W, .08, D, .03, 2), mat(0xF1EAE0, { roughness: .6 })); piso.castShadow = false; g.add(piso);
  const madeiraSala = malha(geoCaixa(W - .2, .01, D - .2, .005, 1), mat(0xDDBE90, { map: texturas().madeira, roughness: .5, emissive: 0xFFD9A0, emissiveIntensity: .22 })); madeiraSala.position.y = .08; madeiraSala.castShadow = false; g.add(madeiraSala);
  /* paredes cheias no fundo (-z) e à direita (+x), vidro na frente (+z) e à esquerda (-x) */
  const parede = mat(COR.parede, { roughness: .8 });
  const pf = malha(geoCaixa(W, H, .12, .02, 1), parede); pf.position.set(0, .08, -D / 2 + .06); g.add(pf);
  const pd = malha(geoCaixa(.12, H, D, .02, 1), parede); pd.position.set(W / 2 - .06, .08, 0); g.add(pd);
  const preto = mat(COR.caixilho, { roughness: .35, metalness: .3 });
  const vidroMat = mat(COR.vidro, { transparent: true, opacity: .2, roughness: .04, envMapIntensity: 1.4, depthWrite: false, side: THREE.DoubleSide });
  const quadro = (x0, z0, x1, z1, n) => {
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(z1 - z0, x1 - x0);
    const vidro = new THREE.Mesh(new THREE.PlaneGeometry(len, H - .05), vidroMat);
    vidro.position.set((x0 + x1) / 2, .08 + H / 2, (z0 + z1) / 2); vidro.rotation.y = -ang; vidro.renderOrder = 4;
    vidro.castShadow = false; vidro.receiveShadow = false; g.add(vidro);
    for (let i = 0; i <= n; i++){
      const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      const m = malha(geoCaixa(.05, H, .05, .01, 1), preto); m.position.set(x, .08, z); g.add(m);
    }
    [.08, .08 + H - .05].forEach(y => {
      const b = malha(geoCaixa(len, .05, .05, .01, 1), preto); b.position.set((x0 + x1) / 2, y, (z0 + z1) / 2); b.rotation.y = -ang; g.add(b);
    });
  };
  quadro(-W / 2, D / 2, W / 2, D / 2, 4);
  quadro(-W / 2, -D / 2, -W / 2, D / 2, 3);
  /* friso de cima, onde fica a placa */
  const friso = malha(geoCaixa(W + .06, .24, .1, .02, 1), preto); friso.position.set(0, .08 + H, D / 2); g.add(friso);
  const friso2 = malha(geoCaixa(.1, .24, D + .06, .02, 1), preto); friso2.position.set(-W / 2, .08 + H, 0); g.add(friso2);
  /* racks no fundo */
  const racks = [-1.25, -.6].map(x => { const r = rack(); r.position.set(x, .08, -D / 2 + .48); g.add(r); return r; });
  /* LEDs dos racks: uma malha instanciada que pisca */
  const nLed = 2 * 8 * 3, led = new THREE.InstancedMesh(new THREE.BoxGeometry(.022, .014, .006), new THREE.MeshBasicMaterial({ toneMapped: false }), nLed);
  const cores = [new THREE.Color(MARCA.verde), new THREE.Color(MARCA.azul), new THREE.Color(MARCA.ambar)];
  let k = 0;
  racks.forEach(r => { for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++){
    led.setMatrixAt(k, M(r.position.x + .16 + j * .03, .08 + 1.75 - .06 - (8 + i * 30 + 12) / 256 * 1.63 - .03, r.position.z + .316));
    led.setColorAt(k, cores[(i + j) % 3 === 0 ? 2 : (i + j) % 2]); k++;
  }});
  led.userData.vivo = true; led.userData.cores = cores; g.add(led);
  /* mesa de trabalho dentro, com monitor aceso, luminária e cadeira */
  const mesaS = malha(geoPlaca(1.4, .7, .1, .05, .01, 6), madeira()); mesaS.position.set(.9, .78, .1); g.add(mesaS);
  [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([a, b]) => { const p = malha(geoCilindro(.018, .018, .7, 8), mat(COR.branco)); p.position.set(.9 + a * .62, .08, .1 + b * .28); g.add(p); });
  const mon = monitor({ larg: .52, alt: .34, variante: 2 }); mon.position.set(.9, .83, .3); mon.rotation.y = PI; g.add(mon);
  const lum = luminaria(); lum.position.set(1.42, .83, .3); lum.rotation.y = PI * .9; lum.scale.setScalar(.85); g.add(lum);
  const cad = cadeira(0x2E2C2A); cad.position.set(.8, .08, -.45); cad.rotation.y = PI + .3; g.add(cad);
  const pl = planta('espada', 1.0, 4, 'branco'); pl.position.set(W / 2 - .4, .08, D / 2 - .45); g.add(pl);
  const pl2 = planta('zz', .8, 8, 'terracota'); pl2.position.set(-W / 2 + .35, .08, D / 2 - .4); g.add(pl2);
  /* hub azul onde as linhas chegam, na base do vidro da frente */
  /* hub azul onde as linhas chegam: rente ao vidro da esquerda, perto do canto da frente */
  const hub = new THREE.Mesh(geoCaixa(.24, .12, .3, .05, 2), new THREE.MeshStandardMaterial({ color: MARCA.azul, emissive: MARCA.azul, emissiveIntensity: .35, roughness: .35 }));
  hub.position.set(-W / 2 - .22, 0, D / 2 - .6); hub.userData.vivo = true; g.add(hub);
  const entra = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(-W / 2 - .1, .06, D / 2 - .6), V(-W / 2 + .3, .06, D / 2 - .7), V(-W / 2 + .9, .06, -D / 2 + .9)]), 24, .03, 8), hub.material);
  entra.userData.vivo = true; entra.visible = false; g.add(entra);
  const placa = placaLockup(); placa.position.set(.35, .08 + H - .05, D / 2 + .09); g.add(placa);
  /* luz quente acesa lá dentro, como na Tela 3 */
  const quente = new THREE.PointLight(0xFFC98A, 5, 4.2, 1.6); quente.position.set(.2, 1.9, -.2); g.add(quente);
  g.add(sombraContato(W + 1.2, D + 1.2, .18));
  const marca = new THREE.Object3D(); marca.position.set(0, 1.1, 0); g.add(marca);
  g.userData = { marca, placa, hub, entra, led, tela: mon.userData.tela };
  return g;
}

/* ── etiqueta: chip branco arredondado, ponto colorido e texto em Sora ── */
export function chip({ texto, cor, mesa, tam = 30, peso = 600, alturaMundo = .5, ancora = [0, .5] }){
  const dpr = 3, pad = 22, ponto = 9, alt = 56, entre = 34;
  const linhas = texto.split('\n');
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d');
  const fonte = peso + ' ' + tam + "px " + FONTE;
  c.font = fonte;
  const larg = Math.max(...linhas.map(l => c.measureText(l).width));
  const recuo = cor ? ponto * 2 + 12 : 0;
  const w = pad + recuo + larg + pad, h = alt + (linhas.length - 1) * entre;
  const sombra = 10;
  cv.width = Math.ceil((w + sombra * 2) * dpr); cv.height = Math.ceil((h + sombra * 2) * dpr);
  c.scale(dpr, dpr); c.translate(sombra, sombra);
  const r = linhas.length > 1 ? 18 : h / 2;
  c.save(); c.shadowColor = 'rgba(40,30,20,.12)'; c.shadowBlur = 9; c.shadowOffsetY = 3;
  c.beginPath(); c.roundRect(0, 0, w, h, r); c.fillStyle = '#FFFFFF'; c.fill(); c.restore();
  c.lineWidth = 1.5; c.strokeStyle = 'rgba(20,20,20,.06)'; c.beginPath(); c.roundRect(0, 0, w, h, r); c.stroke();
  const px = { x: Math.round((sombra + pad + ponto) * dpr), y: Math.round((sombra + h / 2) * dpr) };
  if (cor){ c.fillStyle = cor; c.beginPath(); c.arc(pad + ponto, h / 2, ponto, 0, Math.PI * 2); c.fill(); }
  c.font = fonte; c.fillStyle = MARCA.tinta; c.textBaseline = 'middle';
  linhas.forEach((l, i) => c.fillText(l, pad + recuo, h / 2 + (i - (linhas.length - 1) / 2) * entre));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  sp.renderOrder = 20;
  const k = alturaMundo / alt;
  sp.scale.set((w + sombra * 2) * k, (h + sombra * 2) * k, 1);
  /* a âncora vale para o chip, não para a margem da sombra */
  const ax = (sombra + ancora[0] * w) / (w + sombra * 2), ay = (sombra + ancora[1] * h) / (h + sombra * 2);
  sp.center.set(ax, ay);
  sp.userData = { mesa, texto: linhas.join(' '), ponto: cor ? px : null };
  return sp;
}
