/* ══════════════════════════════════════════════════════════════════════
   Escritório nó · cena 3D isométrica de /agentes/
   three.js puro, geometria feita aqui (sem GLB), seguindo as Telas 1 e 3
   da referência: piso creme, paredes osso, carvalho claro e cerâmica branca;
   três mesas em coluna (nó.fiscal, Auditor, mesa vaga), a escada à
   esquerda, a recepção com o "nó." plano no balcão e o estar embaixo; no
   recuo do fecho, a sala envidraçada "nó tech stack" à direita, ligada às
   mesas por três linhas azuis que correm pelo chão.
   Só as duas pessoas, móveis, plantas e objetos de trabalho: nada além disso.
   Módulos: cena-materia.js (matéria e assadura), cena-moveis.js (móveis e
   sala), cena-pessoas.js (as duas pessoas e o movimento delas).
   Contrato: .tasks/agentes-escritorio-frentes.md (montarEscritorio).
   ══════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MARCA, COR, clamp01, clamp, suave, lerp, mat, malha, geoCaixa, texturaPiso, assar, limparCache } from './cena-materia.js';
import {
  MESA, mesa, recepcao, escada, estante, prateleira, janela, sofa, poltrona, banco, mesinha, tapete, planta,
  salaTechStack, chip, luminaria, caneca, papeis, pilhaLivros, caixaPreta, mouse, sombraContato
} from './cena-moveis.js';
import { criarPessoa } from './cena-pessoas.js';

const LOGO_BALCAO = '/brand/logo/svg/no-tinta-ponto-azul.svg';

/* ── câmera ortográfica: quase de frente, como na referência (as bordas das
      mesas sobem um pouco para a direita; a coluna de mesas desce em diagonal) ── */
const ELEV = 35 * Math.PI / 180, AZ = -18 * Math.PI / 180;
const DIR_CAM = new THREE.Vector3(Math.sin(AZ) * Math.cos(ELEV), Math.sin(ELEV), Math.cos(AZ) * Math.cos(ELEV)).normalize();
const DIR_DIREITA = new THREE.Vector3(Math.cos(AZ), 0, -Math.sin(AZ));
const DIR_CIMA = new THREE.Vector3().crossVectors(DIR_CAM, DIR_DIREITA).normalize();
/* ponto do mundo na altura y que cai em (sx, sy) do plano da tela (unidades de mundo) */
function naTela(sx, sy, y = 0){
  const r = DIR_DIREITA, u = DIR_CIMA, b = sy - u.y * y;
  const det = r.x * u.z - r.z * u.x;
  return new THREE.Vector3((sx * u.z - r.z * b) / det, y, (r.x * b - u.x * sx) / det);
}
const tela = p => [p.dot(DIR_DIREITA), p.dot(DIR_CIMA)];

/* enquadramentos em coordenadas de tela: centro e largura de mundo visível.
   A Tela 1 foi composta para o canvas da página (375:520) e só ganha altura
   em canvas mais altos (375×812); o fecho guarda a proporção da Tela 3. */
const TELA1 = { centro: [0, .2], largura: 5.6, alturaMin: 7.75 };
const FECHO = { centro: [3.1, .45], largura: 10.5, proporcao: 440 / 375 };

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
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
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
  /* luz: ambiente de estúdio (reflexos suaves) + céu quente + sol baixo com sombra macia */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const ambiente = pmrem.fromScene(new RoomEnvironment(), .04).texture;
  scene.environment = ambiente; scene.environmentIntensity = .45;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xFFF7EC, 0xCDBEA8, .7));
  const sol = new THREE.DirectionalLight(0xFFF0DE, 2.9);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048); sol.shadow.bias = -.0004; sol.shadow.normalBias = .025;
  scene.add(sol); scene.add(sol.target);
  const preenche = new THREE.DirectionalLight(0xF2F4FF, .5); preenche.position.set(6, 7, 12); scene.add(preenche);

  const raiz = new THREE.Group(); scene.add(raiz);
  const P = (sx, sy, y = 0) => naTela(sx, sy, y);
  const poe = (obj, p, ry = 0) => { obj.position.set(p.x, obj.position.y, p.z); obj.rotation.y = ry; raiz.add(obj); return obj; };

  /* ── mesas, compostas pela Tela 1 (o centro de cada mesa no quadro) ── */
  const infos = {
    fiscal: mesa('fiscal', { variante: 0 }),
    auditor: mesa('auditor', { variante: 1 }),
    vaga: mesa('vaga', { variante: 2, ocupada: false })
  };
  const mesas = { fiscal: infos.fiscal.grupo, auditor: infos.auditor.grupo, vaga: infos.vaga.grupo };
  poe(mesas.fiscal, P(.05, 1.95, MESA.alt));
  poe(mesas.auditor, P(.6, .33, MESA.alt));
  poe(mesas.vaga, P(1.15, -1.28, MESA.alt));
  const zParede = mesas.fiscal.position.z - 2.15;

  /* objetos de cada mesa */
  const naMesa = (id, obj, x, z, ry = 0, y = MESA.alt) => { obj.position.set(x, y, z); obj.rotation.y = ry; mesas[id].add(obj); return obj; };
  naMesa('fiscal', luminaria(), .95, .22, -.4);
  naMesa('fiscal', pilhaLivros([0xF4EFE6, 0xE9E1D3, 0xF6F2EA], 1), -.95, -.18, .2);
  naMesa('fiscal', planta('suculenta', 1.15, 1, 'branco'), .6, .3);
  naMesa('fiscal', papeis(3, 1), .35, -.22, .3);
  naMesa('auditor', caixaPreta(), -1.0, .1, .25);
  naMesa('auditor', caneca(0xF3EFE8, 0x3A2416), .7, -.15);
  naMesa('auditor', planta('suculenta', 1.05, 2, 'creme'), .55, .32);
  naMesa('auditor', papeis(2, 2), .25, -.25, -.2);
  naMesa('vaga', planta('suculenta', 1.15, 3, 'branco'), .75, .28);
  naMesa('vaga', papeis(2, 4), -.15, -.28, .25);
  naMesa('vaga', caneca(0xE9E1D3), .35, .05);

  /* ── as duas pessoas: tronco em cápsula, cabeça em esfera, crachá na cor do agente ── */
  const personagens = {
    fiscal: criarPessoa({ agente: 'fiscal', pele: 0xF0C7A4, cabelo: 0x2E2019, estilo: 'liso', calca: 0x3D4350, sapato: 0x3A2E26, cracha: MARCA.verde, fase: 0, ritmo: 1 }),
    auditor: criarPessoa({ agente: 'auditor', pele: 0x7A4B33, cabelo: 0x16110E, estilo: 'crespo', calca: 0x2F3A4C, sapato: 0x1E1B19, cracha: MARCA.azul, fase: 11.3, ritmo: .93 })
  };
  personagens.auditor.userData.ladoOlhar = -1;
  for (const id of ['fiscal', 'auditor']){
    const p = personagens[id], A = MESA.assento, info = infos[id];
    p.position.copy(A); mesas[id].add(p);
    const ms = mouse(), cn = caneca(id === 'fiscal' ? 0xFFFFFF : 0xEDE6DA);
    ms.position.copy(info.mouseLocal).sub(A); cn.position.copy(info.canecaLocal).sub(A);
    p.add(ms, cn);
    p.userData.ambiente({ teclado: info.teclado, mouse: ms, mouseBase: ms.position.clone(), caneca: cn, canecaBase: cn.position.clone() });
  }

  /* ── etiquetas das mesas ── */
  const chips = {
    fiscal: chip({ texto: 'nó.fiscal', cor: MARCA.verde, mesa: 'fiscal', alturaMundo: .44 }),
    auditor: chip({ texto: 'Auditor', cor: MARCA.azul, mesa: 'auditor', alturaMundo: .44 }),
    vaga: chip({ texto: 'um problema\nseu aqui?', cor: MARCA.ambar, mesa: 'vaga', tam: 26, alturaMundo: .44, ancora: [.5, .5] })
  };
  chips.fiscal.position.set(-.05, 1.95, -.55); mesas.fiscal.add(chips.fiscal);
  chips.auditor.position.set(.05, 1.85, -.45); mesas.auditor.add(chips.auditor);
  chips.vaga.position.set(.55, 1.55, -.4); mesas.vaga.add(chips.vaga);

  /* ── chão, parede do fundo, rodapé, janela, estante e prateleira ── */
  const texPiso = texturaPiso();
  const piso = malha(geoCaixa(34, .3, 30, .05, 1), mat(COR.piso, { map: texPiso, roughness: .95, envMapIntensity: .3 }), false);
  piso.position.set(2, -.3, zParede + 15 - .2); raiz.add(piso);
  const XP0 = -9, XP1 = 15;
  const parede = malha(geoCaixa(XP1 - XP0, 2.7, .26, .04, 2), mat(COR.parede, { roughness: .85 }));
  parede.position.set((XP0 + XP1) / 2, 0, zParede - .13); parede.castShadow = false; raiz.add(parede);
  const rodape = malha(geoCaixa(XP1 - XP0, .1, .04, .01, 1), mat(COR.rodape, { roughness: .6 }), false);
  rodape.position.set((XP0 + XP1) / 2, 0, zParede + .02); raiz.add(rodape);
  const xf = mesas.fiscal.position.x;
  const jan = janela(1.7, 1.25); jan.position.set(xf + 2.55, .95, zParede); raiz.add(jan);
  const est = estante(1.5, 1.0, .4); est.position.set(xf - .55, 0, zParede + .22); raiz.add(est);
  const prat = prateleira(1.25); prat.position.set(xf - .55, 1.62, zParede + .13); raiz.add(prat);
  const lumParede = planta('espada', 1.25, 12, 'terracota'); lumParede.position.set(xf + 1.25, 0, zParede + .35); raiz.add(lumParede);

  /* ── escada e patamar à esquerda ── */
  const esc = escada(7, 1.15, .34, .17);
  esc.position.set(xf - 3.05, 0, zParede + 1.2 + 7 * .34 + .05); raiz.add(esc);
  const plPatamar = planta('zz', 1.1, 14, 'branco'); plPatamar.position.set(xf - 3.0, 7 * .17, zParede + .55); raiz.add(plPatamar);

  /* ── recepção, banco, estar e plantas ── */
  const rec = recepcao(); poe(rec, P(-1.4, -2.35, .5), AZ * .6);
  const ban = banco(1.35); poe(ban, P(1.7, -2.8), AZ * .3);
  const tapBanco = tapete(1.9, 1.3, 0x8F8B85); poe(tapBanco, P(2.0, -3.05), AZ * .3);
  const banq = mesinha(.22, .38); poe(banq, P(2.35, -3.35));
  const plBanq = planta('suculenta', 1.1, 6, 'branco'); plBanq.position.set(0, .42, 0); banq.add(plBanq);

  const plantas = [
    ['zz', 1.5, P(-2.6, -.95), 'branco'], ['espada', 1.2, P(-.4, -.85), 'branco'], ['zz', 1.35, P(-.05, -2.25), 'creme'],
    ['zz', 1.45, P(2.05, -.2), 'branco'], ['espada', 1.3, P(2.6, -1.85), 'terracota'], ['arbusto', 1.2, P(-2.55, 2.3), 'salvia'],
    ['costela', 1.3, P(2.25, 2.45), 'branco'], ['zz', 1.3, P(-2.65, -3.6), 'branco'], ['espada', 1.25, P(.9, -4.1), 'creme'],
    ['arbusto', 1.25, P(4.1, -2.3), 'terracota'], ['zz', 1.3, P(8.6, -1.6), 'branco'], ['espada', 1.3, P(8.4, -4.3), 'salvia'],
    ['zz', 1.25, P(3.6, -5.4), 'branco'], ['costela', 1.2, P(-1.5, -4.9), 'creme']
  ];
  plantas.forEach(([tipo, esc2, p, vaso], i) => {
    const pl = planta(tipo, esc2, 20 + i, vaso); pl.position.set(p.x, 0, p.z); raiz.add(pl);
    const so = sombraContato(.75 * esc2, .75 * esc2, .2); so.position.set(p.x, .006, p.z); raiz.add(so);
  });

  /* ── sala "nó tech stack" e estar do fecho ── */
  /* encostada na parede do fundo, com o canto de trás logo fora da borda direita da Tela 1 */
  const SW = 4.4, SD = 3.3;
  const sala = salaTechStack({ W: SW, D: SD, H: 2.5 });
  const zSala = zParede + .3 + SD / 2;
  const xSala = (3.05 - DIR_DIREITA.z * (zSala - SD / 2)) / DIR_DIREITA.x + SW / 2;
  sala.position.set(xSala, 0, zSala); raiz.add(sala);
  const tapEstar = tapete(3.2, 2.4, COR.tapete); poe(tapEstar, P(6.4, -3.75));
  const sof = sofa(2.2); poe(sof, P(6.65, -3.3, .2));
  const polt = poltrona(); poe(polt, P(5.05, -3.95), .9);
  const mes2 = mesinha(.3, .4); poe(mes2, P(6.75, -4.35));
  const pl2 = planta('suculenta', 1.2, 30, 'branco'); pl2.position.set(0, .44, 0); mes2.add(pl2);

  /* ── as três linhas azuis: saem da borda de cada mesa, descem ao chão,
        correm com curvas suaves e chegam juntas ao hub da sala ── */
  raiz.updateMatrixWorld(true);
  const hubP = sala.userData.hub.getWorldPosition(new THREE.Vector3());
  const matLinha = new THREE.MeshStandardMaterial({ color: MARCA.azul, emissive: MARCA.azul, emissiveIntensity: .28, roughness: .32, envMapIntensity: .8 });
  const matPulso = new THREE.MeshBasicMaterial({ color: 0xBFD0FF, toneMapped: false });
  const L = (id, x, y, z) => mesas[id].localToWorld(new THREE.Vector3(x, y, z));
  const meia = MESA.larg / 2, Y = .03;
  /* cada linha sai do tampo pela ponta direita da mesa, desce ao chão e corre até o hub
     em curvas suaves desenhadas no plano da tela (como na Tela 3), depois projetadas no chão */
  const ondas = { fiscal: [-.32, .14], auditor: [.22, -.12], vaga: [-.28, .1] };
  const hubTela = tela(hubP.clone().setY(0));
  const linhas = ['fiscal', 'auditor', 'vaga'].map(id => {
    const s0 = L(id, meia - .3, MESA.alt + .012, .22), s1 = L(id, meia + .02, MESA.alt - .03, .22), d = L(id, meia + .3, Y, .32);
    const dT = tela(d.clone().setY(0)), ex = hubTela[0] - dT[0], ey = hubTela[1] - dT[1], n = Math.hypot(ex, ey);
    const px = -ey / n, py = ex / n, [A, B] = ondas[id];
    const pts = [s0, s1, d];
    for (const t of [.22, .45, .68, .86]){
      const o = A * Math.sin(Math.PI * t) + B * Math.sin(2 * Math.PI * t);
      pts.push(P(dT[0] + ex * t + px * o, dT[1] + ey * t + py * o, Y));
    }
    pts.push(hubP.clone().setY(.06));
    const curva = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const geo = new THREE.TubeGeometry(curva, 220, .034, 8, false);
    const m = new THREE.Mesh(geo, matLinha); m.castShadow = true; m.frustumCulled = false; m.userData.vivo = true; raiz.add(m);
    geo.setDrawRange(0, 0);
    const pulso = new THREE.Mesh(new THREE.SphereGeometry(.06, 12, 10), matPulso); pulso.visible = false; pulso.userData.vivo = true; raiz.add(pulso);
    const pino = new THREE.Mesh(new THREE.CylinderGeometry(.06, .06, .02, 16), matLinha); pino.position.copy(pts[0]); pino.visible = false; pino.userData.vivo = true; raiz.add(pino);
    return { curva, geo, total: geo.index.count, mesh: m, pulso, pino };
  });
  progresso(.45);

  /* ── sol e sombra cobrindo a Tela 1 e o fecho ── */
  const centroSombra = P(2.6, -.8);
  sol.target.position.copy(centroSombra);
  sol.position.copy(centroSombra).add(new THREE.Vector3(-9, 9.5, 2.2));
  Object.assign(sol.shadow.camera, { left: -11.5, right: 11.5, top: 11.5, bottom: -11.5, near: 1, far: 40 });
  sol.shadow.camera.updateProjectionMatrix();

  /* ── assadura: o que não se mexe vira um punhado de malhas ── */
  assar(raiz);
  progresso(.55);

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
  const upCam = DIR_CIMA.clone(), direitaCam = DIR_DIREITA.clone();
  const estado = { foco: null, alvoY: .2, tFecho: 0 };
  let aspecto = 1;
  /* A Tela 1 guarda a largura de mundo e cresce em altura em canvas mais altos (375×812);
     em canvas mais largos, a altura mínima segura a coluna inteira no quadro. */
  const alturaTela1 = () => Math.max(TELA1.alturaMin, TELA1.largura / aspecto);
  const alturaFecho = () => Math.max(FECHO.largura * FECHO.proporcao, FECHO.largura / aspecto);
  /* A Tela 3 é uma janela 375:440. Num canvas alto (bancada e pôster, 375×812) ela fica no meio,
     onde o recorte do pôster na página olha; no canvas da página (375:520), cujo topo fica sob a
     navbar no fecho, ela desce para a parte de baixo do canvas. */
  const deslocaFecho = () => {
    const hJ = FECHO.largura * FECHO.proporcao, hC = alturaFecho();
    const f = aspecto >= .6 ? 1 - hJ / (2 * hC) + .01 : .47;
    return (f - .5) * hC;
  };
  const alvoTela1 = P(TELA1.centro[0], TELA1.centro[1]), alvoFecho = P(FECHO.centro[0], FECHO.centro[1]);
  const desejado = { alvo: alvoTela1.clone(), altura: TELA1.alturaMin };
  const atual = { alvo: alvoTela1.clone(), altura: TELA1.alturaMin };
  const tmp = new THREE.Vector3();
  function calculaDesejado(){
    const q = suave(clamp01(estado.tFecho));
    if (estado.foco && mesas[estado.foco]){
      /* aproximação da Tela 2: a mesa ocupa quase toda a largura */
      const altura = clamp(3.5 / aspecto, 4.2, 8.0);
      /* a marca da mesa é o mesmo ponto que inspecionar() projeta em mesa-<id> */
      mesas[estado.foco].userData.marca.getWorldPosition(desejado.alvo);
      /* um tico para a direita, para a etiqueta da mesa caber no quadro */
      desejado.alvo.addScaledVector(direitaCam, .25);
      /* o centro da mesa fica a alvoY × altura do canvas, a partir do topo */
      const ndcY = 1 - 2 * clamp01(estado.alvoY);
      tmp.copy(upCam).multiplyScalar(ndcY * altura / 2);
      desejado.alvo.sub(tmp);
      desejado.altura = altura;
    } else {
      desejado.alvo.lerpVectors(alvoTela1, tmp.copy(alvoFecho).addScaledVector(upCam, deslocaFecho()), q);
      desejado.altura = lerp(alturaTela1(), alturaFecho(), q);
    }
  }
  function aplicaCamera(){
    camera.position.copy(atual.alvo).addScaledVector(DIR_CAM, 60);
    camera.up.set(0, 1, 0);
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
  const telas = [infos.fiscal.tela, infos.auditor.tela, infos.vaga.tela, rec.userData.tela, sala.userData.tela];
  const led = sala.userData.led, corLed = new THREE.Color(), apagado = new THREE.Color(0x202020);
  function anima(t){
    personagens.fiscal.userData.animar(t, amp);
    personagens.auditor.userData.animar(t, amp);
    telas.forEach((tl, i) => {
      const pisca = .62 + .12 * Math.sin(t * 1.9 + i * 1.3) + (Math.sin(t * 6.3 + i) > .93 ? .1 : 0);
      tl.material.emissiveIntensity = REDUZ ? .7 : pisca;
      if (!REDUZ && tl.material.map) tl.material.map.offset.y = (Math.floor(t * 1.6 + i) % 6) * .012;
    });
    if (!REDUZ){
      for (let i = 0; i < led.count; i++){
        const c = led.userData.cores[(i + Math.floor(i / 3)) % 3 === 0 ? 2 : i % 2];
        led.setColorAt(i, Math.sin(t * (2 + (i % 7) * .45) + i * 1.7) > -.5 ? c : apagado);
      }
      led.instanceColor.needsUpdate = true;
    }
    /* linhas azuis: aparecem conforme o fecho cresce */
    const q = suave(clamp01(estado.tFecho));
    linhas.forEach((l, i) => {
      const qi = suave(clamp01((q - i * .12) / .76));
      l.geo.setDrawRange(0, Math.floor(l.total * qi / 3) * 3);
      l.mesh.visible = qi > 0;
      l.pino.visible = qi > 0;
      l.pulso.visible = qi >= 1 && !REDUZ;
      if (l.pulso.visible) l.curva.getPointAt((t * .2 + i * .33) % 1, l.pulso.position);
    });
    sala.userData.hub.scale.setScalar(q >= 1 ? 1 + .08 * amp * Math.sin(t * 3) : 1);
    sala.userData.entra.visible = q >= .97;
    /* no recuo do fecho as etiquetas saem, como na Tela 3 da referência */
    const op = 1 - suave(clamp01((q - .1) / .35));
    for (const sp of Object.values(chips)) sp.material.opacity = op;
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
  redimensiona();
  calculaDesejado(); atual.alvo.copy(desejado.alvo); atual.altura = desejado.altura;
  aplicaCamera();
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
      placaSala: sala.userData.placa.userData.texto,
      /* aditivo: custo do último quadro, para acompanhar o desempenho no celular */
      desenho: { chamadas: renderer.info.render.calls, triangulos: renderer.info.render.triangles }
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
      ms.forEach(m => { for (const k of ['map', 'alphaMap', 'emissiveMap']) if (m[k]) m[k].dispose(); m.dispose(); });
    });
    ambiente.dispose();
    limparCache();
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
