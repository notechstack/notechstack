/* ══════════════════════════════════════════════════════════════════════
   Escritório nó · as duas pessoas que trabalham nas mesas
   Figura estilizada de cabeça grande, mas com acabamento de personagem:
   cabelo com volume e mechas, orelhas, olhos com brilho, sobrancelhas,
   nariz, boca, camisa branca de gola com botões e dobras, cinto, calça,
   tênis, crachá no cordão e mãos com dedos. O tronco base é uma cápsula e
   a cabeça base é uma esfera (critério 7); o resto entra como peça filha.
   Os braços são resolvidos por IK de dois ossos: as mãos vão de verdade
   ao teclado, ao mouse e à xícara.
   Sistema local: a pessoa senta na origem, de frente para +z; a esquerda
   dela é +x.
   ══════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { COR, mat, matVC, malha, juntar, M, geoCaixa, geoCilindro, clamp01, lerp, rampa, janela } from './cena-materia.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const PI = Math.PI;

/* medidas */
const R_CORPO = .215, L_CORPO = .22;          // cápsula do tronco
const C_CORPO = R_CORPO + L_CORPO / 2;        // centro da cápsula acima do pivô do tronco
const ESC_CORPO = [1.12, 1, .84];             // ombros largos, peito raso
const R_CAB = .285;                           // cabeça
const C_CAB = V(0, .305, .012);                // centro da cabeça no grupo do pescoço
const L1 = .27, L2 = .29;                     // braço e antebraço
const OMBRO = V(.188, .5, -.005);             // ombro no grupo do tronco (lado esquerdo)
const PIVO_TRONCO = V(0, .5, -.05);
const PIVO_PESCOCO = V(0, .625, .0);

const CAMISA = 0xF7F5F0, CAMISA_SOMBRA = 0xE9E4DA, BOTAO = 0xD9D2C4;
const misturar = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);

/* ponto na superfície da cabeça: θ gira em y a partir da frente, φ sobe */
function naCabeca(th, ph, fora = 0){
  const r = R_CAB + fora;
  return V(C_CAB.x + r * Math.sin(th) * Math.cos(ph), C_CAB.y + r * Math.sin(ph), C_CAB.z + r * Math.cos(th) * Math.cos(ph));
}
const esferaGeo = (seg = 14) => new THREE.SphereGeometry(1, seg, Math.max(6, Math.round(seg * .7)));
function capsulaGeo(r, len, seg = 12){ return new THREE.CapsuleGeometry(r, len, 4, seg); }

/* ── cabelo ── */
function deforma(geo, fn, corFn){
  const p = geo.attributes.position, v = V(), cores = corFn ? new Float32Array(p.count * 3) : null, c = new THREE.Color();
  for (let i = 0; i < p.count; i++){
    v.fromBufferAttribute(p, i);
    const r = v.length(), n = v.clone().divideScalar(r);
    v.multiplyScalar((r + fn(n)) / r);
    p.setXYZ(i, v.x, v.y, v.z);
    if (cores){ corFn(n, c); cores[i * 3] = c.r; cores[i * 3 + 1] = c.g; cores[i * 3 + 2] = c.b; }
  }
  if (cores) geo.setAttribute('color', new THREE.Float32BufferAttribute(cores, 3));
  geo.computeVertexNormals();
  return geo;
}
function cabeloLiso(cor){
  const cl = misturar(cor, 0x7A5A44, .22), ce = misturar(cor, 0x000000, .25);
  /* calota com mechas: sulcos que saem do redemoinho e volume no alto */
  const calota = deforma(new THREE.SphereGeometry(R_CAB * 1.06, 56, 22, 0, PI * 2, 0, PI * .57), n => {
    const a = Math.atan2(n.x, n.z), p = Math.acos(n.y);
    return .012 * (1 - Math.abs(Math.sin(a * 9 + p * 2.6))) + .022 * Math.max(0, n.y) + .006 * Math.sin(a * 23);
  });
  const pecas = [[calota, cor, M(C_CAB.x, C_CAB.y + .006, C_CAB.z - .004, -.74, 0, 0)]];
  /* franja: mechas achatadas, sobrepostas e penteadas para o lado, coladas na testa */
  for (let i = 0; i < 9; i++){
    const th = -.78 + i * .19, ph = .6 + .08 * Math.cos(th * 1.6), comp = .075 + .02 * Math.cos(th * 2);
    const p = naCabeca(th, ph, .012);
    pecas.push([esferaGeo(12), i % 3 === 1 ? cl : cor, M(p.x, p.y - comp * .3, p.z, -.25 - ph * .5, th, .62, .055, comp, .022, 'YXZ')]);
  }
  /* costeletas */
  [-1, 1].forEach(s => { const p = naCabeca(s * 1.36, .02, .006); pecas.push([esferaGeo(10), cor, M(p.x, p.y, p.z, 0, s * 1.36, 0, .032, .075, .04, 'YXZ')]); });
  return juntar(pecas);
}
function cabeloCrespo(cor){
  /* calota baixa de cachos miúdos: relevo de bolinhas, mais escuro nos sulcos */
  const base = new THREE.Color(cor), claro = misturar(cor, 0x5A4A40, .35);
  const cacho = n => { const a = 40; return Math.sin(n.x * a) * Math.sin(n.y * a + 1.3) * Math.sin(n.z * a + .7); };
  const calota = deforma(new THREE.SphereGeometry(R_CAB * 1.03, 120, 48, 0, PI * 2, 0, PI * .53), n => {
    return .03 + .019 * cacho(n) + .034 * Math.max(0, n.y) ** 1.5;
  }, (n, c) => c.copy(base).lerp(claro, Math.max(0, cacho(n)) * .8));
  const pecas = [[calota, null, M(C_CAB.x, C_CAB.y + .006, C_CAB.z - .01, -.6, 0, 0)]];
  [-1, 1].forEach(s => { const p = naCabeca(s * 1.3, .1, .008); pecas.push([esferaGeo(8), cor, M(p.x, p.y, p.z, 0, s * 1.3, 0, .028, .06, .04, 'YXZ')]); });
  return juntar(pecas);
}

/* ── rosto: orelhas, nariz, boca, sobrancelhas e bochechas (os olhos ficam à parte, piscam) ── */
function rosto(pele, corCabelo){
  const peleEscura = misturar(pele, 0x5A2E1E, .14), bochecha = misturar(pele, 0xE07F72, .2), labio = misturar(pele, 0x5C2420, .7);
  const pecas = [];
  [-1, 1].forEach(s => {
    const x = s * (R_CAB - .006), y = C_CAB.y - .05, z = C_CAB.z - .015;
    pecas.push([esferaGeo(12), pele, M(x, y, z, 0, 0, s * -.15, .046, .074, .056)]);
    pecas.push([esferaGeo(10), peleEscura, M(x + s * .02, y, z + .008, 0, 0, s * -.15, .018, .04, .03)]);
    const sb = naCabeca(s * .37, .24, .004);
    pecas.push([capsulaGeo(.0125, .05, 8), corCabelo, M(sb.x, sb.y, sb.z, 0, s * .37, PI / 2 - s * .1, 1, 1, .6, 'YXZ')]);
    const bc = naCabeca(s * .62, -.17, -.024);
    pecas.push([esferaGeo(12), bochecha, M(bc.x, bc.y, bc.z, 0, s * .62, 0, .052, .032, .03, 'YXZ')]);
  });
  const n = naCabeca(0, -.07, -.008);
  pecas.push([esferaGeo(12), peleEscura, M(n.x, n.y, n.z, 0, 0, 0, .03, .024, .026)]);
  const b = naCabeca(0, -.31, -.003);
  pecas.push([new THREE.TorusGeometry(.036, .0085, 6, 18, PI), labio, M(b.x, b.y + .02, b.z, .3, 0, PI)]);
  return juntar(pecas);
}
/* olhos: íris escura e um ponto de brilho; a origem fica na altura dos olhos para piscar */
function olhos(){
  const pecas = [];
  [-1, 1].forEach(s => {
    const p = naCabeca(s * .36, .0, -.004);
    p.y -= C_CAB.y;
    pecas.push([esferaGeo(14), 0x1A1412, M(p.x, p.y, p.z, 0, s * .36, 0, .03, .041, .018, 'YXZ')]);
    pecas.push([esferaGeo(8), 0xFFFFFF, M(p.x - .009, p.y + .014, p.z + .016, 0, 0, 0, .0095)]);
    pecas.push([esferaGeo(6), 0xFFFFFF, M(p.x + .008, p.y - .012, p.z + .016, 0, 0, 0, .0045)]);
  });
  return juntar(pecas);
}

/* ── tronco: gola, botões, bolso, dobras, cinto, pescoço, cordão ── */
function detalhesCamisa(pele, corCordao){
  const pecas = [];
  const [ex, , ez] = ESC_CORPO;
  pecas.push([geoCilindro(.066, .072, .13, 18), pele, M(0, .55, 0)]);
  /* gola: colarinho aberto na frente, pontas deitadas sobre o peito e o V da pele */
  pecas.push([new THREE.TorusGeometry(.083, .021, 8, 22, PI * 1.42), CAMISA, M(0, .612, .004, PI / 2 - .14, 3.81, 0, 1, 1.08, 1, 'YXZ')]);
  pecas.push([new THREE.CylinderGeometry(.044, 0, .1, 3), pele, M(0, .585, .118, -.62, 0, 0, 1, 1, .28)]);
  [-1, 1].forEach(s => {
    const f = new THREE.Shape(); f.moveTo(0, 0); f.lineTo(s * .085, -.012); f.lineTo(s * .028, -.105); f.closePath();
    const g = new THREE.ExtrudeGeometry(f, { depth: .012, bevelEnabled: true, bevelThickness: .004, bevelSize: .004, bevelSegments: 1 });
    pecas.push([g, CAMISA, M(s * .016, .642, .085, -.78, s * .22, 0)]);
  });
  /* carcela com botões */
  const zf = R_CORPO * ez;
  pecas.push([geoCaixa(.03, .3, .012, .004, 1), CAMISA_SOMBRA, M(0, .16, zf - .003)]);
  [.22, .32, .42].forEach(y => pecas.push([esferaGeo(8), BOTAO, M(0, y, zf + .006, 0, 0, 0, .009, .009, .005)]));
  /* bolso no peito esquerdo */
  pecas.push([geoCaixa(.075, .08, .008, .003, 1), CAMISA_SOMBRA, M(.105, .37, zf - .014, 0, .38, 0)]);
  /* dobras da camisa presa no cinto */
  [[-1, .1], [1, .13], [-1, .19]].forEach(([s, y], i) => pecas.push([capsulaGeo(.006, .07, 6), CAMISA_SOMBRA,
    M(s * (.1 + i * .015), y + .03, zf - .02 - i * .006, 0, s * .5, s * (1.0 + i * .2))]));
  /* cinto e fivela */
  pecas.push([geoCilindro(.168, .16, .046, 28), 0x4A3426, M(0, .045, 0, 0, 0, 0, ex, 1, ez)]);
  pecas.push([geoCaixa(.05, .036, .012, .006, 1), 0xB8AE9C, M(0, .05, .16 * ez + .004)]);
  /* cordão do crachá, do pescoço ao peito */
  [-1, 1].forEach(s => {
    const curva = new THREE.CatmullRomCurve3([V(s * .07, .6, -.035), V(s * .088, .565, .06), V(s * .058, .47, .155), V(s * .02, .4, .182), V(s * .004, .37, .19)]);
    pecas.push([new THREE.TubeGeometry(curva, 18, .0075, 5), corCordao, null]);
  });
  return juntar(pecas);
}

/* ── pernas, calça e tênis (sentado) ── */
function pernas(corCalca, corSapato){
  const pecas = [];
  pecas.push([geoCaixa(.38, .16, .32, .075, 2), corCalca, M(0, .43, -.04)]);
  [-1, 1].forEach(s => {
    pecas.push([capsulaGeo(.083, .3, 12), corCalca, M(s * .098, .53, .15, PI / 2, 0, 0)]);
    pecas.push([capsulaGeo(.072, .3, 12), corCalca, M(s * .1, .3, .36, -.06, 0, 0)]);
    pecas.push([geoCaixa(.115, .085, .23, .04, 2), corSapato, M(s * .1, .02, .43)]);
    pecas.push([geoCaixa(.125, .024, .24, .01, 1), 0xEFEAE1, M(s * .1, 0, .432)]);
  });
  return juntar(pecas);
}

/* ── braço: manga, punho dobrado, antebraço e mão com dedos ── */
function antebraco(pele){
  return juntar([
    [capsulaGeo(.054, .13, 12), CAMISA, M(0, -.065, 0)],
    [new THREE.TorusGeometry(.056, .02, 8, 16), CAMISA_SOMBRA, M(0, -.15, 0, PI / 2, 0, 0)],
    [capsulaGeo(.04, L2 - .16, 10), pele, M(0, -.16 - (L2 - .16) / 2, 0)]
  ]);
}
function mao(pele, s){
  const pecas = [[esferaGeo(14), pele, M(0, -.004, .045, 0, 0, 0, .052, .028, .06)]];
  [[-.03, .03], [-.01, .036], [.01, .034], [.029, .027]].forEach(([x, l]) =>
    pecas.push([capsulaGeo(.0125, l, 6), pele, M(x * s, -.016, .1 + l / 2 - .015, PI / 2 + .5, 0, 0)]));
  pecas.push([capsulaGeo(.014, .03, 6), pele, M(-s * .046, -.006, .055, PI / 2 + .15, -s * .75, 0, 1, 1, 1, 'YXZ')]);
  return juntar(pecas);
}

/* IK de dois ossos: dado o ombro S, o alvo T e a direção do cotovelo, devolve cotovelo e punho */
const _d = V(), _p = V();
function ik(S, T, polo, E, W){
  _d.subVectors(T, S);
  const dist = Math.min(Math.max(_d.length(), Math.abs(L1 - L2) + .01), L1 + L2 - .004);
  _d.normalize();
  const cosA = clamp01((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist) * .5 + .5) * 2 - 1;
  const a = Math.acos(cosA);
  _p.copy(polo).addScaledVector(_d, -polo.dot(_d)).normalize();
  E.copy(S).addScaledVector(_d, L1 * Math.cos(a)).addScaledVector(_p, L1 * Math.sin(a));
  W.copy(S).addScaledVector(_d, dist);
}
const BAIXO = V(0, -1, 0);
function aponta(obj, de, para){
  _d.subVectors(para, de).normalize();
  obj.position.copy(de);
  obj.quaternion.setFromUnitVectors(BAIXO, _d);
}

/* ══ criarPessoa ══
   ambiente: { teclado, mouse, caneca } em coordenadas da pessoa (a mesa monta) */
export function criarPessoa({ agente, pele, cabelo, estilo, calca, sapato, cracha, fase = 0, ritmo = 1 }){
  const g = new THREE.Group(); g.name = 'personagem-' + agente;
  g.userData.agente = agente; g.userData.vivo = true;
  const matCamisa = mat(CAMISA, { fisico: true, roughness: .78, sheen: .7, sheenRoughness: .6, sheenColor: new THREE.Color(0xFFFFFF) });
  const matPele = mat(pele, { roughness: .52, fisico: true, sheen: .25, sheenRoughness: .5, sheenColor: new THREE.Color(0xFFE2D2) });
  const vc = matVC({ roughness: .66 });

  g.add(malha(pernas(calca, sapato), vc));
  const tronco = new THREE.Group(); tronco.position.copy(PIVO_TRONCO); g.add(tronco);
  const corpo = malha(new THREE.CapsuleGeometry(R_CORPO, L_CORPO, 8, 24), matCamisa);
  corpo.position.y = C_CORPO; corpo.scale.set(...ESC_CORPO); tronco.add(corpo);
  tronco.add(malha(detalhesCamisa(pele, cracha), vc));
  /* crachá: pendurado num pivô no fim do cordão, balança sozinho */
  const pivoCracha = new THREE.Group(); pivoCracha.position.set(0, .372, .19); tronco.add(pivoCracha);
  const gCracha = geoCaixa(.09, .125, .013, .012, 2); gCracha.translate(0, -.14, 0);
  const crachaM = malha(gCracha, mat(cracha, { roughness: .42, envMapIntensity: .8 })); pivoCracha.add(crachaM);
  crachaM.add(malha(juntar([
    [geoCaixa(.064, .05, .004, .004, 1), 0xFFFFFF, M(0, -.075, .0075)],
    [geoCaixa(.022, .022, .004, .003, 1), misturar(cracha, 0xFFFFFF, .45), M(-.016, -.1, .0075)],
    [geoCaixa(.026, .006, .004, .002, 1), 0xFFFFFF, M(.014, -.094, .0075)],
    [geoCaixa(.026, .006, .004, .002, 1), 0xFFFFFF, M(.014, -.104, .0075)],
    [geoCaixa(.026, .022, .012, .004, 1), 0xBDB7AC, M(0, -.012, 0)]
  ]), vc, false));

  const pescoco = new THREE.Group(); pescoco.position.copy(PIVO_PESCOCO); tronco.add(pescoco);
  const cabeca = malha(new THREE.SphereGeometry(R_CAB, 40, 30), matPele);
  cabeca.position.copy(C_CAB); cabeca.scale.set(1, .97, .98); pescoco.add(cabeca);
  pescoco.add(malha(rosto(pele, cabelo), vc, false));
  const olhosM = malha(olhos(), matVC({ roughness: .18, envMapIntensity: 1 }), false);
  olhosM.position.y = C_CAB.y; pescoco.add(olhosM);
  pescoco.add(malha(estilo === 'crespo' ? cabeloCrespo(cabelo) : cabeloLiso(cabelo), matVC({ roughness: .6, envMapIntensity: .45 })));

  /* braços: filhos da pessoa, orientados a cada quadro pelo IK */
  const bracos = [1, -1].map(s => {
    const gb = capsulaGeo(.06, L1, 14); gb.translate(0, -L1 / 2, 0);
    const braco = malha(gb, matCamisa), ante = malha(antebraco(pele), vc), maoM = malha(mao(pele, s), vc);
    g.add(braco, ante, maoM);
    return { s, braco, ante, mao: maoM, S: V(), E: V(), W: V(), T: V() };
  });

  /* âncora da inspeção: o meio da cabeça */
  const marca = new THREE.Object3D(); marca.position.set(0, 1.28, .05); g.add(marca);
  g.userData.partes = { tronco, pescoco, corpo, cabeca, cracha: crachaM, marca, bracos, olhos: olhosM, pivoCracha };

  /* ── laço de movimento ── */
  let amb = null;
  g.userData.ambiente = a => { amb = a; };
  const P = 24;                                   // ciclo de gestos, em segundos
  const ombro = V(), polo = V(), alvo = V(), frente = V(), cima = V(), lado = V(), base = new THREE.Matrix4();
  const bocaAlvo = V(.06, 1.31, .27), tmp = V();
  g.userData.animar = (t, amp = 1) => {
    if (!amb) return;
    const tau = ((t * ritmo + fase) % P + P) % P;
    /* janelas dos gestos */
    const olhaLado = janela(tau, 6.6, 7.3, 8.9, 9.6);
    const noMouse = janela(tau, 9.6, 10.3, 13.0, 13.7);
    const pegaXicara = janela(tau, 15.8, 16.6, 19.6, 20.3);
    const bebe = janela(tau, 16.8, 17.6, 18.7, 19.4);
    const ajeita = janela(tau, 21.2, 21.7, 22.5, 23.2);
    const olhaTeclado = janela(tau, 2.6, 3.0, 3.9, 4.4) + janela(tau, 13.9, 14.3, 15.0, 15.4);
    const lento = 1 - .75 * olhaLado;

    /* respiração, balanço e ajeitar-se na cadeira */
    const resp = Math.sin(t * 1.55 + fase);
    tronco.scale.set(1 + .012 * resp * amp, 1 + .018 * resp * amp, 1 + .014 * resp * amp);
    tronco.rotation.x = .1 + amp * (.022 * Math.sin(t * .55 + fase) + .06 * bebe - .04 * olhaLado);
    tronco.rotation.y = amp * (.05 * Math.sin(t * .31 + fase) + .14 * Math.sin((tau - 21.2) * 2.6) * ajeita + .08 * pegaXicara - .05 * noMouse);
    tronco.rotation.z = amp * (.022 * Math.sin(t * .42 + fase * 2) + .03 * ajeita);
    g.position.y = g.userData.y0 + amp * .025 * Math.sin(Math.min(1, ajeita) * PI);

    /* cabeça: olha a tela, o teclado, o lado e a xícara */
    pescoco.rotation.order = 'YXZ';
    pescoco.rotation.y = .22 + amp * (.05 * Math.sin(t * .47 + fase) + .7 * olhaLado * (g.userData.ladoOlhar || 1) + .3 * pegaXicara * (1 - bebe) - .12 * noMouse);
    pescoco.rotation.x = -.04 + amp * (.04 * Math.sin(t * 1.21 + fase) + .16 * olhaTeclado - .24 * bebe - .08 * olhaLado);
    pescoco.rotation.z = amp * (.035 * Math.sin(t * .63 + fase) - .05 * olhaLado);
    /* piscar a cada ~4 s, às vezes duas vezes seguidas */
    const pb = (t + fase * 1.7) % 4.3, pisca = janela(pb, 0, .06, .09, .16) + janela(pb, .3, .36, .39, .46) * (Math.floor((t + fase) / 4.3) % 3 === 0 ? 1 : 0);
    olhosM.scale.y = 1 - .88 * Math.min(1, pisca) * (amp ? 1 : 0);
    pivoCracha.rotation.x = -tronco.rotation.x * .7 + amp * .05 * Math.sin(t * 1.9 + fase);
    pivoCracha.rotation.z = amp * .07 * Math.sin(t * 1.3 + fase);

    tronco.updateMatrix();
    for (const b of bracos){
      const s = b.s;
      ombro.copy(OMBRO).setX(OMBRO.x * s).applyMatrix4(tronco.matrix);
      b.S.copy(ombro);
      /* digitação: mãos alternadas, com rajadas e pausas */
      const w = t * 10.5 * ritmo + (s > 0 ? 0 : PI);
      const rajada = .55 + .45 * Math.sin(t * .9 + fase + s);
      const bate = amp * lento * rajada * Math.max(0, Math.sin(w)) ** 2;
      alvo.copy(amb.teclado).add(tmp.set(s * .1 + amp * .02 * Math.sin(t * 1.7 + s * 2), .05 + .02 * bate, -.085 + amp * .012 * Math.sin(t * 1.1 + s)));
      let pitch = .38 + .3 * bate, rolar = s * .12;
      if (s < 0 && noMouse > 0){
        /* mão direita no mouse, com pequenos traços */
        const tr = tmp.set(amp * .025 * Math.sin(t * 2.3), 0, amp * .018 * Math.sin(t * 3.1 + 1));
        amb.mouse.position.copy(amb.mouseBase).addScaledVector(tr, noMouse);
        alvo.lerp(tmp.copy(amb.mouse.position).add(V(0, .045, -.05)), noMouse);
        pitch = lerp(pitch, .25, noMouse); rolar = lerp(rolar, -.1, noMouse);
      }
      if (s > 0 && pegaXicara > 0){
        /* mão esquerda: vai à xícara, leva à boca e devolve */
        const pega = tmp.copy(amb.canecaBase).add(V(-.06, .05, -.035));
        alvo.lerp(pega, pegaXicara);
        alvo.lerp(bocaAlvo, bebe);
        pitch = lerp(pitch, .1, pegaXicara); rolar = lerp(rolar, 1.15, pegaXicara);
      }
      polo.set(s * .75, -.4, -.5).normalize();
      ik(b.S, alvo, polo, b.E, b.W);
      aponta(b.braco, b.S, b.E);
      aponta(b.ante, b.E, b.W);
      /* mão: aponta para a frente, dedos caídos sobre as teclas */
      frente.subVectors(b.W, b.E).setY(0).normalize().lerp(V(0, 0, 1), .45).normalize();
      frente.applyAxisAngle(lado.crossVectors(V(0, 1, 0), frente).normalize(), pitch);
      cima.set(0, 1, 0).addScaledVector(frente, -frente.y).normalize();
      lado.crossVectors(cima, frente).normalize();
      base.makeBasis(lado, cima, frente);
      b.mao.position.copy(b.W);
      b.mao.quaternion.setFromRotationMatrix(base);
      b.mao.rotateZ(rolar);
      b.T.copy(alvo);
    }
    /* xícara presa na mão enquanto segura */
    if (pegaXicara > .98 || (bebe > 0)){
      const m = bracos[0].mao;
      amb.caneca.position.copy(m.position).add(V(.055, -.055, .035));
      amb.caneca.rotation.set(-.75 * bebe, 0, 0);
    } else {
      amb.caneca.position.copy(amb.canecaBase); amb.caneca.rotation.set(0, 0, 0);
    }
    if (noMouse <= 0) amb.mouse.position.copy(amb.mouseBase);
  };
  g.userData.y0 = 0;
  return g;
}
