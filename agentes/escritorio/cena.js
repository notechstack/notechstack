/* ══════════════════════════════════════════════════════════════════════
   Escritório nó · cena 3D de /agentes/ (Rodada 5)
   Carrega agentes/escritorio/escritorio.glb, exportado da cena aprovada no
   Blender (.tasks/blender/exportar_glb.py):
   - o escritório estático vem com a luz assada no Cycles (dois atlas) e é
     desenhado com MeshBasicMaterial, igual à prévia e leve no celular;
   - as duas pessoas e os cabos têm luz em tempo real (céu + sol quente);
   - os enquadramentos vêm das câmeras ortográficas do GLB: o fecho só
     arrasta a câmera da Tela 1 até a sala (R11), e o foco usa a câmera da
     Tela 2 da mesa;
   - etiquetas, "nó." do balcão, contorno âmbar e pulsos dos cabos são
     feitos aqui.
   Só as duas pessoas, móveis, plantas e objetos de trabalho: nada além disso.
   Contrato: .tasks/agentes-escritorio-frentes.md (montarEscritorio).
   ══════════════════════════════════════════════════════════════════════ */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const GLB = '/agentes/escritorio/escritorio.glb';
const TAMANHO_GLB = 2.3e6;            // estimativa do progresso quando o servidor não manda o tamanho
const LOGO_BALCAO = '/brand/logo/svg/no-tinta-ponto-azul.svg';
const FONTE = "'Sora', system-ui, sans-serif";
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const suave = t => t * t * (3 - 2 * t);

/* cores de marca lidas dos tokens da página (brand/tokens/tokens.css);
   o valor entre parênteses é só o fallback quando o CSS não carregou */
function token(id, padrao){
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(id).trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  } catch (e) {}
  return padrao;
}
const MARCA = {
  azul: token('--no-azul', '#3D63DB'), verde: token('--no-verde', '#30A46C'),
  ambar: token('--no-ambar', '#EDA33B'), tinta: token('--no-tinta', '#141414')
};
const MESAS = ['fiscal', 'auditor', 'vaga'];
const AGENTES = ['fiscal', 'auditor'];

/* ── etiqueta: chip branco com contorno na cor do agente (R9, R10), círculo cheio
      de 16 px (R4) e texto em Sora; medidas em px CSS para 375 de largura ── */
const PX_POR_MUNDO = 520 / 6.72;      // Tela 1 da página: 520 px de altura para 6,72 de mundo
function desenhaChip({ texto, cor, soContorno = false, halo = false }){
  const dpr = 3, alt = 34, circ = 16, borda = 2.5, pad = 11, entre = 8, fonte = '600 14px ' + FONTE, margem = 8;
  const cv = document.createElement('canvas'), c = cv.getContext('2d', { willReadFrequently: true });
  c.font = fonte;
  const larg = pad + circ + entre + Math.ceil(c.measureText(texto).width) + pad + 4;
  const W = larg + margem * 2, H = alt + margem * 2;
  cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(H * dpr);
  c.scale(dpr, dpr); c.translate(margem, margem);
  const r = alt / 2, cx = pad + circ / 2, cy = alt / 2;
  if (halo){
    c.fillStyle = cor; c.globalAlpha = .28;
    c.beginPath(); c.arc(cx, cy, circ / 2 + 6, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
  } else if (soContorno){
    c.lineWidth = borda + 1; c.strokeStyle = cor;
    c.beginPath(); c.roundRect(0, 0, larg, alt, r); c.stroke();
  } else {
    c.save(); c.shadowColor = 'rgba(40,30,20,.18)'; c.shadowBlur = 8; c.shadowOffsetY = 2;
    c.beginPath(); c.roundRect(0, 0, larg, alt, r); c.fillStyle = '#FFFFFF'; c.fill(); c.restore();
    c.lineWidth = borda; c.strokeStyle = cor;
    c.beginPath(); c.roundRect(borda / 2, borda / 2, larg - borda, alt - borda, r - borda / 2); c.stroke();
    c.fillStyle = cor; c.beginPath(); c.arc(cx, cy, circ / 2, 0, Math.PI * 2); c.fill();
    c.font = fonte; c.fillStyle = MARCA.tinta; c.textBaseline = 'middle';
    c.fillText(texto, pad + circ + entre, cy + .5);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  sp.renderOrder = soContorno ? 22 : halo ? 20 : 21;
  sp.scale.set(W / PX_POR_MUNDO, H / PX_POR_MUNDO, 1);
  /* o halo pulsa em volta do círculo: o centro do sprite fica no círculo */
  if (halo) sp.center.set((margem + cx) / W, 1 - (margem + cy) / H);
  sp.userData = { texto, ponto: { x: Math.round((margem + cx) * dpr), y: Math.round((margem + cy) * dpr) } };
  return sp;
}

/* ── cabos: acendem da mesa à sala conforme o arrasto (UV0.u de 0 a 1) e levam
      pulsos de luz correndo até a sala ── */
function preparaCabo(malha, uniformes){
  const g = malha.geometry, uv = g.attributes.uv, n = uv.count, u = new Float32Array(n);
  for (let i = 0; i < n; i++) u[i] = uv.getX(i);
  g.setAttribute('caboU', new THREE.BufferAttribute(u, 1));
  const m = new THREE.MeshStandardMaterial({ color: malha.material.color.clone(), roughness: .28, metalness: 0,
    emissive: malha.material.color.clone(), emissiveIntensity: .35 });
  m.name = 'cabo';
  m.onBeforeCompile = sh => {
    sh.uniforms.uProgresso = uniformes.progresso; sh.uniforms.uTempo = uniformes.tempo;
    sh.vertexShader = 'attribute float caboU;\nvarying float vCaboU;\n' +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vCaboU = caboU;');
    sh.fragmentShader = 'uniform float uProgresso;\nuniform float uTempo;\nvarying float vCaboU;\n' +
      sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (vCaboU > uProgresso) discard;')
        .replace('#include <emissivemap_fragment>', [
          '#include <emissivemap_fragment>',
          '  float fase = fract(vCaboU * 4.0 - uTempo * 0.45);',
          '  float pulso = smoothstep(0.0, 0.025, fase) * (1.0 - smoothstep(0.025, 0.08, fase));',
          '  float ponta = 1.0 - smoothstep(0.0, 0.04, uProgresso - vCaboU);',
          '  totalEmissiveRadiance += vec3(0.62, 0.74, 1.0) * (pulso * 2.4 + ponta * 1.6);'
        ].join('\n'));
  };
  malha.material = m;
}

export async function montarEscritorio(canvas, { aoProgresso } = {}){
  const progresso = p => { try { if (typeof aoProgresso === 'function') aoProgresso(clamp01(p)); } catch (e) {} };
  const REDUZ = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  progresso(0);

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
  /* o atlas assado já vem com o tom da prévia (Khronos PBR Neutral); o resto usa o mesmo tom */
  renderer.toneMapping = THREE.NeutralToneMapping;

  /* GLB e fontes em paralelo: o download vai de 0 a 0,8 no progresso */
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const fontes = Promise.race([
    document.fonts.load("600 14px 'Sora'").catch(() => {}),
    new Promise(r => setTimeout(r, 2500))
  ]);
  let gltf;
  try {
    gltf = await loader.loadAsync(GLB, e => {
      const total = e.lengthComputable && e.total ? e.total : TAMANHO_GLB;
      progresso(.8 * Math.min(.99, e.loaded / total));
    });
  } catch (e) {
    renderer.dispose();
    throw new Error('escritório não carregou: ' + (e && e.message || e));
  }
  progresso(.8);
  await fontes;

  /* ── montagem ── */
  const scene = new THREE.Scene();
  const raiz = gltf.scene; scene.add(raiz);
  raiz.updateMatrixWorld(true);
  const no = nome => { const o = raiz.getObjectByName(nome); if (!o) throw new Error('nó ausente no GLB: ' + nome); return o; };
  const uniformesCabo = { progresso: { value: -1 }, tempo: { value: 0 } };
  const cabos = [], toques = [];
  raiz.traverse(o => {
    const ex = o.userData || {};
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = false;
    if (ex.assado){
      /* luz assada: a cor do atlas vai direto para a tela */
      o.material = new THREE.MeshBasicMaterial({ map: o.material.map, toneMapped: false, side: THREE.DoubleSide });
    } else if (ex.toque){
      o.visible = false;
    } else if (ex.cabo){
      preparaCabo(o, uniformesCabo); cabos.push(o);
    } else if (o.name.startsWith('placa-tech-stack')){
      o.material = new THREE.MeshBasicMaterial({ map: o.material.emissiveMap, transparent: true, toneMapped: false, side: THREE.DoubleSide });
    } else if (o.material && o.material.name === 'vidro'){
      o.material.depthWrite = false; o.renderOrder = 5;
    } else if (o.material && /^cracha-(fiscal|auditor)$/.test(o.material.name)){
      o.material.alphaTest = .5;
    } else if (o.material && o.material.name.startsWith('cabelo-mechas-')){
      /* cabelo: a cor (raiz escura, pontas claras) vem por vértice; o sheen e a anisotropia
         do Blender acinzentam as mechas no three.js */
      o.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .55, metalness: 0 });
    }
  });
  for (const id of MESAS){ const t = no('toque-mesa-' + id); t.userData.mesa = id; t.visible = false; toques.push(t); }
  cabos.sort((a, b) => a.name.localeCompare(b.name));

  /* luz em tempo real para pessoas e cabos, calibrada com o assado: céu quente + sol da esquerda */
  scene.add(new THREE.HemisphereLight(0xFFF1E2, 0x9C8466, 1.25));
  const sol = new THREE.DirectionalLight(0xFFE6C6, 2.4);
  sol.position.set(-9, 9.5, 2.2); scene.add(sol);
  const contraluz = new THREE.DirectionalLight(0xEAF0FF, .35); contraluz.position.set(6, 7, 12); scene.add(contraluz);

  /* "nó." do balcão: plano com a textura do SVG oficial, no marcador do GLB (R14) */
  const marcaLogo = no('marca-logo-balcao');
  const geoLogo = new THREE.PlaneGeometry(1, 1); geoLogo.rotateX(-Math.PI / 2);   // o plano XY do Blender vira XZ no glTF
  const logo = new THREE.Mesh(geoLogo, new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, color: 0xFFFFFF, polygonOffset: true, polygonOffsetFactor: -2 }));
  logo.name = 'logo-balcao'; logo.castShadow = false; logo.receiveShadow = false; logo.visible = false;
  marcaLogo.add(logo);
  try {
    const tex = await Promise.race([
      new Promise((res, rej) => new THREE.TextureLoader().load(LOGO_BALCAO, res, undefined, rej)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), 6000))
    ]);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    logo.material.map = tex; logo.material.needsUpdate = true; logo.visible = true;
  } catch (e) { console.warn('[escritorio] logo do balcão não carregou', e); }
  progresso(.86);

  /* ── etiquetas: chip, halo que pulsa (R4) e, na vaga, contorno âmbar que pisca (R10) ── */
  const DEF = {
    fiscal: { texto: 'nó.fiscal', cor: MARCA.verde },
    auditor: { texto: 'nó.auditor', cor: MARCA.azul },
    vaga: { texto: 'criar uma automação', cor: MARCA.ambar }
  };
  const chips = {}, halos = {}, extras = [];
  for (const id of MESAS){
    const m = no('marca-etiqueta-' + id);
    const sp = desenhaChip(DEF[id]); sp.userData.mesa = id; m.add(sp); chips[id] = sp;
    const h = desenhaChip({ ...DEF[id], halo: true });
    /* o halo usa o centro no círculo; desloca o sprite para o círculo cair no mesmo lugar */
    const W = sp.scale.x, H = sp.scale.y;
    h.position.set(-W / 2 + (h.center.x) * W, (h.center.y - .5) * H, 0);
    h.userData.base = h.scale.clone();
    m.add(h); halos[id] = h; extras.push(h);
  }
  const contornoVaga = desenhaChip({ ...DEF.vaga, soContorno: true }); no('marca-etiqueta-vaga').add(contornoVaga); extras.push(contornoVaga);

  /* ── câmeras do GLB: posição, orientação e ymag ── */
  const cams = {};
  for (const nome of ['camera-tela1', 'camera-tela2-fiscal', 'camera-tela2-auditor', 'camera-fecho']){
    const c = no(nome);
    const cam = c.isCamera ? c : (c.getObjectByProperty('isCamera', true) || c);
    cam.updateMatrixWorld(true);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), esc = new THREE.Vector3();
    cam.matrixWorld.decompose(pos, q, esc);
    cams[nome] = { pos, q, ymag: cam.isOrthographicCamera ? cam.top : 3.36 };
  }
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 200);
  camera.quaternion.copy(cams['camera-tela1'].q);
  const upCam = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  progresso(.9);

  /* ── animação: um clip por pessoa, em laço de 8 s ── */
  const mixer = new THREE.AnimationMixer(raiz);
  for (const ag of AGENTES){
    const clip = gltf.animations.find(a => a.name === 'laco-' + ag);
    if (clip){ const acao = mixer.clipAction(clip); acao.setLoop(THREE.LoopRepeat, Infinity); acao.play(); }
  }
  if (REDUZ) mixer.timeScale = 0;

  const marcas = {
    'mesa-fiscal': no('marca-mesa-fiscal'), 'mesa-auditor': no('marca-mesa-auditor'), 'mesa-vaga': no('marca-mesa-vaga'),
    'recepcao': no('marca-recepcao'), 'personagem-fiscal': no('marca-pessoa-fiscal'), 'personagem-auditor': no('marca-pessoa-auditor'),
    'sala-tech-stack': no('marca-sala')
  };
  const placa = raiz.getObjectByName('placa-tech-stack');
  const piso = no('marca-piso');

  /* ── enquadramentos: Tela 1, Tela 2 (foco) e o arrasto até a sala ── */
  const estado = { foco: null, alvoY: .2, tFecho: 0 };
  const desejado = { pos: cams['camera-tela1'].pos.clone(), ymag: cams['camera-tela1'].ymag };
  const atual = { pos: desejado.pos.clone(), ymag: desejado.ymag };
  let aspecto = 1;
  const v = new THREE.Vector3();
  function calculaDesejado(){
    if (estado.foco && cams['camera-tela2-' + estado.foco]){
      const c2 = cams['camera-tela2-' + estado.foco];
      /* a câmera da Tela 2 desliza no próprio eixo vertical até o centro da mesa
         ficar a alvoY × altura do canvas, a partir do topo */
      marcas['mesa-' + estado.foco].getWorldPosition(v);
      const ndcDesejado = 1 - 2 * clamp01(estado.alvoY);
      const d = v.sub(c2.pos).dot(upCam) - ndcDesejado * c2.ymag;
      desejado.pos.copy(c2.pos).addScaledVector(upCam, d);
      desejado.ymag = c2.ymag;
    } else {
      /* R11: mesmo ângulo e mesmo ymag; a câmera só é arrastada até a sala */
      const q = suave(clamp01(estado.tFecho));
      desejado.pos.lerpVectors(cams['camera-tela1'].pos, cams['camera-fecho'].pos, q);
      desejado.ymag = cams['camera-tela1'].ymag + (cams['camera-fecho'].ymag - cams['camera-tela1'].ymag) * q;
    }
  }
  function aplicaCamera(){
    camera.position.copy(atual.pos);
    const h = atual.ymag, w = h * aspecto;
    camera.left = -w; camera.right = w; camera.top = h; camera.bottom = -h;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  }
  function passoCamera(dt){
    calculaDesejado();
    const k = 1 - Math.exp(-dt * 6);
    atual.pos.lerp(desejado.pos, k);
    atual.ymag += (desejado.ymag - atual.ymag) * k;
    if (atual.pos.distanceTo(desejado.pos) < .002 && Math.abs(desejado.ymag - atual.ymag) < .0005){
      atual.pos.copy(desejado.pos); atual.ymag = desejado.ymag;
    }
    aplicaCamera();
  }

  /* ── laço ── */
  const amp = REDUZ ? 0 : 1;
  let progressoCabo = 0;
  function anima(t, dt){
    mixer.update(Math.min(dt, .1));
    /* os cabos acendem durante o arrasto e chegam inteiros à sala no fim */
    const alvoCabo = estado.foco ? 0 : clamp01((estado.tFecho - .05) / .8);
    progressoCabo += (alvoCabo - progressoCabo) * (dt > 0 ? 1 - Math.exp(-dt * 5) : 1);
    uniformesCabo.progresso.value = progressoCabo < .002 ? -1 : progressoCabo > .995 ? 1.01 : progressoCabo;
    uniformesCabo.tempo.value = REDUZ ? 0 : t;
    /* no fim do arrasto as etiquetas saem (a Tela 3 não tem etiquetas) */
    const op = 1 - suave(clamp01((estado.tFecho - .45) / .4));
    MESAS.forEach((id, i) => {
      chips[id].material.opacity = op;
      const h = halos[id], p = .5 + .5 * Math.sin(t * 2.6 + i);
      h.scale.copy(h.userData.base).multiplyScalar(1 + .22 * p * amp);
      h.material.opacity = (1 - .65 * p * amp) * op;
    });
    contornoVaga.material.opacity = (REDUZ ? 1 : .25 + .75 * (.5 + .5 * Math.sin(t * Math.PI / .7))) * op;
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
  function desenha(agora, dt){
    anima(agora / 1000, dt);
    renderer.render(scene, camera);
    nQuadros++;
  }
  function laco(agora){
    if (!rodando) { raf = 0; return; }
    const dt = Math.min((agora - ultimo) / 1000, .1); ultimo = agora;
    passoCamera(dt);
    desenha(agora, dt);
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

  /* ── toque nas mesas: o raio só testa as caixas toque-mesa-* ── */
  const raycaster = new THREE.Raycaster(), ponteiro = new THREE.Vector2();
  const ouvintes = [];
  function mesaEm(ev){
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ponteiro.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ponteiro, camera);
    const hit = raycaster.intersectObjects(toques, false)[0];
    return hit ? hit.object.userData.mesa : null;
  }
  const aoClicar = ev => { const m = mesaEm(ev); if (m) ouvintes.forEach(fn => { try { fn(m); } catch (e) { console.error(e); } }); };
  canvas.addEventListener('click', aoClicar);
  const fino = typeof matchMedia === 'function' && matchMedia('(pointer:fine)').matches;
  const aoMover = ev => { canvas.style.cursor = mesaEm(ev) ? 'pointer' : ''; };
  if (fino) canvas.addEventListener('pointermove', aoMover);

  /* ── primeiro quadro ── */
  redimensiona();
  calculaDesejado(); atual.pos.copy(desejado.pos); atual.ymag = desejado.ymag;
  aplicaCamera();
  await new Promise(r => setTimeout(r, 0));
  renderer.compile(scene, camera);
  progresso(.96);
  desenha(performance.now(), 0);
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
  function corFaixa(ag){
    let cor = null;
    no('cracha-' + ag).traverse(o => {
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of ms) if (m.name === 'cracha-faixa-' + ag) cor = '#' + m.color.getHexString();
    });
    return cor;
  }
  const caixa = new THREE.Box3();
  function inspecionar(){
    camera.updateMatrixWorld();
    const enquadramento = estado.foco ? estado.foco : (estado.tFecho >= .5 ? 'fecho' : 'tela1');
    const projetados = {};
    for (const [k, o] of Object.entries(marcas)) projetados[k] = projeta(o);
    for (const id of MESAS) projetados['etiqueta-' + id] = projeta(chips[id]);
    const etiquetas = MESAS.map(id => ({ mesa: id, texto: chips[id].userData.texto, cor: corPixel(chips[id].material.map.image, chips[id].userData.ponto) }));
    const mapa = logo.material.map && logo.material.map.image && logo.material.map.image.src
      ? new URL(logo.material.map.image.src, location.href).pathname : null;
    const logoBalcao = {
      geometria: logo.geometry.type, castShadow: logo.castShadow, receiveShadow: logo.receiveShadow,
      contorno: logo.children.some(c => c.isLine || c.isLineSegments) || !!logo.material.wireframe,
      mapa
    };
    const personagens = AGENTES.map(ag => ({ agente: ag, no: no('pessoa-' + ag).name, cracha: corFaixa(ag) }));
    return {
      enquadramento, projetados, etiquetas, logoBalcao, personagens,
      linhas: { cor: '#' + cabos[0].material.color.getHexString(), quantidade: cabos.length },
      placaSala: placa ? placa.userData.texto : null,
      /* aditivos: quadro da câmera, cabos sobre o piso (R12) e custo do último quadro */
      camera: { altura: 2 * atual.ymag, largura: 2 * atual.ymag * aspecto },
      cabos: cabos.map(c => ({ no: c.name, cor: '#' + c.material.color.getHexString(), yMin: caixa.setFromObject(c).min.y })),
      pisoY: piso.getWorldPosition(v3).y,
      cabosAcesos: uniformesCabo.progresso.value,
      desenho: { chamadas: renderer.info.render.calls, triangulos: renderer.info.render.triangles }
    };
  }

  function destruir(){
    destruido = true; liga();
    io.disconnect(); ro.disconnect();
    document.removeEventListener('visibilitychange', aoVisib);
    canvas.removeEventListener('click', aoClicar);
    if (fino) canvas.removeEventListener('pointermove', aoMover);
    mixer.stopAllAction();
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      ms.forEach(m => { for (const k of ['map', 'alphaMap', 'emissiveMap', 'normalMap', 'roughnessMap']) if (m[k]) m[k].dispose(); m.dispose(); });
    });
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
    mostrarEtiquetas(v){ for (const sp of [...Object.values(chips), ...extras]) sp.visible = !!v; },
    destruir,
    inspecionar
  };
}
