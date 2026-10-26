// STUB da cena (frente B) só para a bancada da frente A. Não vai para produção.
// Cumpre o contrato de montarEscritorio com um desenho 2D simples: mesas, recepção,
// dois personagens abstratos (círculos) que se mexem, linhas e sala no fecho.
// Depende do three pelo importmap, como a cena real, para C23–C25 valerem.
import 'three';

const MESAS = {
  'mesa-fiscal': { x: 0.6, y: 0.24 },
  'mesa-auditor': { x: 0.52, y: 0.48 },
  'mesa-vaga': { x: 0.64, y: 0.71 },
  recepcao: { x: 0.34, y: 0.9 },
  'personagem-fiscal': { x: 0.53, y: 0.21 },
  'personagem-auditor': { x: 0.45, y: 0.45 },
  'sala-tech-stack': { x: 0.86, y: 0.3 },
};
const ROTULOS = { 'mesa-fiscal': 'fiscal', 'mesa-auditor': 'auditor', 'mesa-vaga': 'vaga' };
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
const cor = (nome) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim() || 'gray';

export async function montarEscritorio(canvas, { aoProgresso } = {}) {
  const atraso = window.__stubCenaAtraso ?? 900;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('sem contexto');
  for (let i = 1; i <= 5; i += 1) {
    await espera(atraso / 5);
    aoProgresso?.(i / 5);
  }

  let quadros = 0;
  let foco = null;
  let alvoY = 0.2;
  let t = 0;
  let pausadoPelaPagina = false;
  let naTela = true;
  let raf = 0;
  let destruida = false;
  const cam = { cx: 0.5, cy: 0.5, z: 1 };
  const ouvintesToque = new Set();

  function alvoCamera() {
    if (foco) {
      const m = MESAS[`mesa-${foco}`];
      const z = 1.9;
      return { cx: m.x, cy: m.y - (alvoY - 0.5) / z, z };
    }
    return { cx: 0.5 + 0.12 * t, cy: 0.5 - 0.05 * t, z: 1 - 0.3 * t };
  }
  const projetar = (p) => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    return { x: ((p.x - cam.cx) * cam.z + 0.5) * w, y: ((p.y - cam.cy) * cam.z + 0.5) * h };
  };

  function desenhar(agora) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    const alvo = alvoCamera();
    for (const k of ['cx', 'cy', 'z']) cam[k] += (alvo[k] - cam[k]) * 0.18;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cor('--no-ambar-tint');
    ctx.fillRect(0, 0, w, h);
    const s = cam.z * w / 375;
    if (t > 0.5 && !foco) {
      const sala = projetar(MESAS['sala-tech-stack']);
      ctx.strokeStyle = cor('--no-azul');
      ctx.lineWidth = 3;
      for (const k of ['mesa-fiscal', 'mesa-auditor', 'mesa-vaga']) {
        const p = projetar(MESAS[k]);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(sala.x, sala.y); ctx.stroke();
      }
      ctx.fillStyle = cor('--no-azul-tint');
      ctx.fillRect(sala.x - 60 * s, sala.y - 45 * s, 120 * s, 90 * s);
      ctx.fillStyle = cor('--no-tinta');
      ctx.font = `600 ${12 * s}px Sora, sans-serif`;
      ctx.fillText('nó tech stack', sala.x - 42 * s, sala.y);
    }
    for (const [k, c] of [['mesa-fiscal', '--no-verde'], ['mesa-auditor', '--no-azul'], ['mesa-vaga', '--no-ambar'], ['recepcao', '--no-borda']]) {
      const p = projetar(MESAS[k]);
      ctx.fillStyle = cor('--no-osso');
      ctx.fillRect(p.x - 70 * s, p.y - 22 * s, 140 * s, 44 * s);
      ctx.fillStyle = cor(c);
      ctx.fillRect(p.x - 70 * s, p.y + 18 * s, 140 * s, 4 * s);
    }
    for (const [k, c] of [['personagem-fiscal', '--no-verde'], ['personagem-auditor', '--no-azul']]) {
      const p = projetar(MESAS[k]);
      const dy = Math.sin(agora / 300 + (k.length)) * 4 * s;
      ctx.fillStyle = cor('--no-tinta');
      ctx.beginPath(); ctx.arc(p.x, p.y - 26 * s + dy, 9 * s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = cor(c);
      ctx.fillRect(p.x - 8 * s, p.y - 16 * s + dy, 16 * s, 18 * s);
    }
    ctx.fillStyle = cor('--no-cinza');
    ctx.font = '500 11px "JetBrains Mono", monospace';
    ctx.fillText('bancada · stub da cena (frente B)', 12, h - 12);
    quadros += 1;
  }

  const rodando = () => !destruida && !pausadoPelaPagina && naTela && !document.hidden;
  function laco(agora) {
    raf = 0;
    if (!rodando()) return;
    desenhar(agora);
    raf = requestAnimationFrame(laco);
  }
  const ligar = () => { if (!raf && rodando()) raf = requestAnimationFrame(laco); };

  const io = new IntersectionObserver(([e]) => { naTela = e.isIntersecting; ligar(); });
  io.observe(canvas);
  const aoVisibilidade = () => ligar();
  document.addEventListener('visibilitychange', aoVisibilidade);
  const aoClicar = (ev) => {
    const caixa = canvas.getBoundingClientRect();
    const x = ev.clientX - caixa.left;
    const y = ev.clientY - caixa.top;
    for (const [k, mesa] of Object.entries(ROTULOS)) {
      const p = projetar(MESAS[k]);
      if (Math.abs(p.x - x) < 70 * cam.z && Math.abs(p.y - y) < 30 * cam.z) {
        ouvintesToque.forEach((fn) => fn(mesa));
        return;
      }
    }
  };
  canvas.addEventListener('click', aoClicar);

  desenhar(performance.now()); // primeiro quadro antes de resolver
  ligar();
  window.__stubCena = { resolvidoEm: performance.now(), destruido: false, chamadasFecho: 0 };

  return {
    focar(mesa, opcoes = {}) {
      foco = mesa || null;
      if (opcoes.alvoY != null) alvoY = opcoes.alvoY;
    },
    fecho(valor) {
      t = Math.min(1, Math.max(0, valor));
      window.__stubCena.chamadasFecho += 1;
    },
    aoTocarMesa(fn) { ouvintesToque.add(fn); },
    pausar() { pausadoPelaPagina = true; },
    retomar() { pausadoPelaPagina = false; ligar(); },
    quadros: () => quadros,
    inspecionar() {
      const projetados = {};
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      for (const [k, p] of Object.entries(MESAS)) {
        const q = projetar(p);
        projetados[k] = { x: q.x, y: q.y, visivel: q.x >= 0 && q.x <= w && q.y >= 0 && q.y <= h };
      }
      return {
        enquadramento: foco || (t >= 0.5 ? 'fecho' : 'tela1'),
        projetados,
        etiquetas: [],
        logoBalcao: null,
        personagens: [],
        linhas: { cor: '#3d63db', quantidade: t >= 0.5 ? 3 : 0 },
        placaSala: 'nó tech stack',
      };
    },
    destruir() {
      destruida = true;
      if (raf) cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', aoVisibilidade);
      canvas.removeEventListener('click', aoClicar);
      window.__stubCena.destruido = true;
    },
  };
}
