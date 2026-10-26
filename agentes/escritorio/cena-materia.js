/* ══════════════════════════════════════════════════════════════════════
   Escritório nó · matéria da cena
   Cores, materiais em cache, geometrias arredondadas, texturas feitas em
   canvas e a "assadura": tudo o que não se mexe é juntado num punhado de
   malhas (uma por família de material, com a cor em vertex color), para a
   cena caber em poucas chamadas de desenho no celular.
   ══════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const suave = t => t * t * (3 - 2 * t);
export const lerp = (a, b, t) => a + (b - a) * t;
/* sobe de 0 a 1 entre a e b */
export const rampa = (t, a, b) => suave(clamp01((t - a) / (b - a)));
/* sobe entre a e b, fica em 1, desce entre c e d */
export const janela = (t, a, b, c, d) => rampa(t, a, b) * (1 - rampa(t, c, d));

/* cores de marca lidas dos tokens da página (brand/tokens/tokens.css);
   o valor entre parênteses é só o fallback quando o CSS não carregou */
function token(id, padrao){
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(id).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  } catch (e) {}
  return padrao;
}
export const MARCA = {
  azul: token('--no-azul', '#3D63DB'), verde: token('--no-verde', '#30A46C'),
  ambar: token('--no-ambar', '#EDA33B'), tinta: token('--no-tinta', '#141414')
};
export const FONTE = "'Sora', system-ui, sans-serif";

/* matéria da cena, tirada da referência: creme e osso quentes, carvalho claro,
   cerâmica branca, verde-oliva nas plantas e tinta nos monitores */
export const COR = {
  piso: 0xDDCFB9, pisoFundo: 0xE4DACB, parede: 0xF5F0E8, rodape: 0xDCD0BE, base: 0xF6F2EB,
  madeira: 0xDAB98A, madeiraEscura: 0xC9A273, branco: 0xF8F5EF, osso: 0xEFE8DD, creme: 0xE8DECF,
  tinta: 0x1C1B1A, grafite: 0x34322F, cinza: 0x8D8A85, metal: 0xB9B6B0, tela: 0x10141D,
  folha: 0x5F8F4E, folhaClara: 0x7FA765, folhaEscura: 0x45703A, terra: 0x4A3628,
  ceramica: 0xF4F0EA, terracota: 0xC88A64, salvia: 0xB9C4AE, areia: 0xDCCDB6,
  tecido: 0xE6DDD0, tecidoEscuro: 0xCFC4B4, tapete: 0x9A9690, tapeteClaro: 0xD8CFC2,
  vidro: 0xDCE7F2, caixilho: 0x181818
};

/* ── materiais em cache ── */
const materiais = new Map();
export function mat(cor, opts){
  const k = cor + '|' + JSON.stringify(opts || {}, (k, v) => (v && v.isTexture) ? v.uuid : v);
  if (!materiais.has(k)){
    const o = Object.assign({ color: cor, roughness: .82, metalness: 0, envMapIntensity: .55 }, opts || {});
    const m = o.fisico ? new THREE.MeshPhysicalMaterial((delete o.fisico, o)) : new THREE.MeshStandardMaterial(o);
    materiais.set(k, m);
  }
  return materiais.get(k);
}
export function limparCache(){ materiais.clear(); }

export function malha(geo, material, projeta = true){
  const m = new THREE.Mesh(geo, material);
  m.castShadow = projeta; m.receiveShadow = true;
  return m;
}
/* bloco arredondado com a base em y = 0 */
export function geoCaixa(w, h, d, r, seg = 3){
  const g = new RoundedBoxGeometry(w, h, d, seg, Math.max(.001, Math.min(r, w / 2 - .001, h / 2 - .001, d / 2 - .001)));
  g.translate(0, h / 2, 0);
  return g;
}
export function caixa(w, h, d, r, cor, opts, seg){ return malha(geoCaixa(w, h, d, r, seg), mat(cor, opts)); }
export function geoCilindro(rt, rb, h, seg = 24, aberto = false){
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, aberto);
  g.translate(0, h / 2, 0);
  return g;
}
export function cilindro(rt, rb, h, cor, seg, opts){ return malha(geoCilindro(rt, rb, h, seg), mat(cor, opts)); }
export function esfera(r, cor, seg = 16, opts){
  return malha(new THREE.SphereGeometry(r, seg, Math.max(6, Math.round(seg * .7))), mat(cor, opts));
}
/* placa de cantos bem redondos (tampo, balcão): retângulo arredondado extrudado, base em y = 0 */
export function formaArredondada(w, d, r){
  r = Math.min(r, w / 2 - .001, d / 2 - .001);
  const s = new THREE.Shape(), x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - r); s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + d); s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}
export function geoPlaca(w, d, r, esp, bisel = .012, curva = 10){
  const b = Math.min(bisel, esp / 2.2);
  const g = new THREE.ExtrudeGeometry(formaArredondada(w - b * 2, d - b * 2, Math.max(.01, r - b)), {
    depth: esp - b * 2, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: curva
  });
  g.rotateX(-Math.PI / 2); g.translate(0, b, 0);
  return g;
}

/* matriz de composição: posição, rotação (XYZ) e escala */
const _o = new THREE.Object3D();
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx, ordem = 'XYZ'){
  _o.position.set(x, y, z); _o.rotation.set(rx, ry, rz, ordem); _o.scale.set(sx, sy, sz);
  _o.updateMatrix();
  return _o.matrix.clone();
}

/* geometria só com posição, normal e uv, sem índice: o formato que a junção exige */
function normaliza(g){
  const n = g.index ? g.toNonIndexed() : g.clone();
  for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) n.deleteAttribute(k);
  if (!n.attributes.normal) n.computeVertexNormals();
  if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
  n.morphAttributes = {};
  n.clearGroups();
  return n;
}
function pinta(g, cor){
  /* cor nula: a geometria já traz a própria cor por vértice */
  if (cor === null && g.attributes.color) return g;
  const c = cor && cor.isColor ? cor : new THREE.Color(cor);
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++){ a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
  return g;
}
/* junta peças de cores diferentes numa geometria só, com a cor em vertex color:
   lista de [geometria, cor, matriz?]; cor nula usa a cor por vértice da própria geometria */
export function juntar(lista){
  const gs = lista.map(([g, cor, m]) => { const n = normaliza(g); if (m) n.applyMatrix4(m); return pinta(n, cor); });
  const r = mergeGeometries(gs, false);
  gs.forEach(g => g.dispose());
  return r;
}
const materiaisVC = new Map();
export function matVC(opts){
  const k = JSON.stringify(opts || {});
  if (!materiaisVC.has(k)) materiaisVC.set(k, new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: .8, metalness: 0, envMapIntensity: .55 }, opts || {})));
  return materiaisVC.get(k);
}

/* ── assadura: junta o que é estático, por família de material ──
   Tudo o que está sob um objeto com userData.vivo fica de fora (pessoas,
   telas, logo, linhas, luzes). A cor de cada material vira vertex color. */
export function assar(raiz){
  raiz.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(raiz.matrixWorld).invert();
  const familias = new Map(), fontes = [];
  (function visita(o){
    if (o !== raiz && o.userData.vivo) return;
    if (o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh){
      const m = o.material;
      if (!Array.isArray(m) && (m.isMeshStandardMaterial || m.isMeshBasicMaterial)){
        const chave = [m.type, m.roughness, m.metalness, m.map ? m.map.uuid : '', m.transparent, m.opacity, m.side,
          m.emissive ? m.emissive.getHexString() + m.emissiveIntensity : '', m.envMapIntensity, m.depthWrite, m.alphaTest,
          m.sheen || 0, o.castShadow, o.receiveShadow, o.renderOrder].join('|');
        if (!familias.has(chave)) familias.set(chave, { modelo: m, cast: o.castShadow, receive: o.receiveShadow, ordem: o.renderOrder, gs: [] });
        const g = normaliza(o.geometry);
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
        if (g.attributes.color) g.deleteAttribute('color');
        familias.get(chave).gs.push(pinta(g, m.color));
        fontes.push(o);
      }
    }
    for (const c of o.children) visita(c);
  })(raiz);
  const usadas = new Set();
  for (const o of fontes) o.parent.remove(o);
  raiz.traverse(o => { if (o.geometry) usadas.add(o.geometry); });
  for (const o of fontes) if (!usadas.has(o.geometry)) o.geometry.dispose();
  let n = 0;
  for (const f of familias.values()){
    const geo = mergeGeometries(f.gs, false);
    f.gs.forEach(g => g.dispose());
    const m = f.modelo.clone();
    m.vertexColors = true; m.color.set(0xFFFFFF);
    const junto = new THREE.Mesh(geo, m);
    junto.castShadow = f.cast; junto.receiveShadow = f.receive; junto.renderOrder = f.ordem;
    junto.matrixAutoUpdate = false; junto.name = 'assado-' + (n++);
    raiz.add(junto);
  }
  return n;
}

/* ── texturas feitas em canvas ── */
function tela2d(w, h){ const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function textura(cv, repete){
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repete){ t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}
/* pseudo-aleatório estável, para a cena sair sempre igual (pôsteres e capturas) */
export function semente(s){ return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

/* veio de carvalho claro, quase branco: a cor vem do vertex color */
export function texturaMadeira(){
  const [cv, c] = tela2d(512, 512), r = semente(7);
  c.fillStyle = '#FFFFFF'; c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 90; i++){
    const y = r() * 512, a = .025 + r() * .05, esp = .6 + r() * 2.2;
    c.strokeStyle = `rgba(120,80,40,${a})`; c.lineWidth = esp;
    c.beginPath(); c.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) c.lineTo(x, y + Math.sin(x / 70 + i) * 3 + (r() - .5) * 1.5);
    c.stroke();
  }
  const t = textura(cv, true); t.repeat.set(1.4, 1.4);
  return t;
}
/* carpete bege: granulado fino e manchas largas bem leves */
export function texturaPiso(){
  const [cv, c] = tela2d(256, 256), r = semente(3);
  c.fillStyle = '#FFFFFF'; c.fillRect(0, 0, 256, 256);
  const img = c.getImageData(0, 0, 256, 256), d = img.data;
  for (let i = 0; i < d.length; i += 4){ const v = 244 + r() * 11; d[i] = d[i + 1] = d[i + 2] = v; }
  c.putImageData(img, 0, 0);
  const t = textura(cv, true); t.repeat.set(9, 9);
  return t;
}
/* teclado: teclas claras sobre base grafite, vista de cima */
export function texturaTeclado(){
  const [cv, c] = tela2d(256, 96);
  c.fillStyle = '#2B2A28'; c.fillRect(0, 0, 256, 96);
  c.fillStyle = '#4A4844';
  for (let l = 0; l < 5; l++) for (let k = 0; k < 15; k++){
    const w = l === 4 && k > 4 && k < 10 ? 0 : 14;
    if (w) { c.beginPath(); c.roundRect(6 + k * 16.5, 6 + l * 17.5, w, 14, 3); c.fill(); }
  }
  c.beginPath(); c.roundRect(6 + 5 * 16.5, 6 + 4 * 17.5, 5 * 16.5 - 2, 14, 3); c.fill();
  return textura(cv);
}
/* tela de computador: janela clara com linhas de texto e uma barra azul */
export function texturaTela(variante = 0){
  const [cv, c] = tela2d(256, 160), r = semente(11 + variante * 5);
  c.fillStyle = '#EEF2FA'; c.fillRect(0, 0, 256, 160);
  c.fillStyle = MARCA.azul; c.fillRect(0, 0, 256, 16);
  c.fillStyle = '#FFFFFF'; c.fillRect(10, 26, 70, 124);
  c.fillStyle = '#D9E1F2'; for (let i = 0; i < 6; i++) c.fillRect(16, 34 + i * 18, 56, 8);
  for (let i = 0; i < 9; i++){
    c.fillStyle = i % 4 === 0 ? '#9DB2E9' : '#C9D3E6';
    c.fillRect(92, 28 + i * 13, 60 + r() * 96, 6);
  }
  c.fillStyle = variante % 2 ? MARCA.verde : MARCA.azul; c.fillRect(92, 146, 46, 8);
  return textura(cv);
}
/* mancha macia para a sombra de contato sob os móveis */
export function texturaSombra(){
  const [cv, c] = tela2d(128, 128);
  const g = c.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(.45, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  return t;
}
/* frente do rack: gavetas de servidor com grelhas */
export function texturaRack(){
  const [cv, c] = tela2d(128, 256);
  c.fillStyle = '#161616'; c.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 8; i++){
    const y = 8 + i * 30;
    c.fillStyle = '#222222'; c.fillRect(8, y, 112, 24);
    c.fillStyle = '#2E2E2E'; for (let k = 0; k < 9; k++) c.fillRect(30 + k * 9, y + 6, 5, 12);
    c.fillStyle = '#3A3A3A'; c.fillRect(12, y + 9, 10, 6);
  }
  return textura(cv);
}
/* lombadas de livros para a estante */
export function texturaLivros(){
  const [cv, c] = tela2d(256, 64), r = semente(19);
  const cores = ['#F1ECE2', '#2F3B52', '#D9B98A', '#8FA6C9', '#EDE3D2', '#B85C3C', '#5E7A55', '#1F1F1F', '#E8C98E', '#A7B7D9'];
  let x = 0;
  while (x < 256){
    const w = 9 + r() * 12, h = 40 + r() * 24;
    c.fillStyle = cores[Math.floor(r() * cores.length)];
    c.fillRect(x, 64 - h, w - 1.2, h);
    c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(x + 2, 64 - h + 6, w - 5, 2);
    x += w;
  }
  return textura(cv);
}
