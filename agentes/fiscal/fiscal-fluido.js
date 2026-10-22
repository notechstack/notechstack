/* NoFluido: fundo "líquido" em WebGL para o bloco do simulador (nó.fiscal). Ruído com deformação de domínio
   (fbm) misturando quatro cores da marca, bem lento. Sem WebGL ou com movimento reduzido, desenha um quadro só
   (ou nada: o CSS por trás já tem o degradê âmbar). Uso: window.NoFluido.mount(canvas, { cores: ['#…', …] }). */
(function () {
  'use strict';
  var VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var FS = [
    'precision mediump float;',
    'uniform vec2 r;uniform float t;uniform vec3 c0,c1,c2,c3;',
    'vec2 h(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return -1.+2.*fract(sin(p)*43758.5453123);}',
    'float n(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);',
    ' return mix(mix(dot(h(i),f),dot(h(i+vec2(1.,0.)),f-vec2(1.,0.)),u.x),mix(dot(h(i+vec2(0.,1.)),f-vec2(0.,1.)),dot(h(i+vec2(1.,1.)),f-vec2(1.,1.)),u.x),u.y);}',
    'float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}',
    'void main(){vec2 uv=gl_FragCoord.xy/r;vec2 p=uv*vec2(r.x/r.y,1.)*1.6;',
    ' vec2 q=vec2(fbm(p+t*.06),fbm(p+vec2(5.2,1.3)-t*.05));',
    ' vec2 w=vec2(fbm(p+2.4*q+vec2(1.7,9.2)+t*.08),fbm(p+2.4*q+vec2(8.3,2.8)-t*.07));',
    ' float f=fbm(p+2.2*w);',
    ' vec3 col=mix(c0,c1,clamp(f*1.8+.5,0.,1.));',
    ' col=mix(col,c2,clamp(length(q)*1.1,0.,1.));',
    ' col=mix(col,c3,clamp(w.x*1.6+.2,0.,1.)*.55);',
    ' col=mix(col,c1,smoothstep(.55,.95,f+.4)*.35);',
    ' gl_FragColor=vec4(col,1.);}'
  ].join('\n');
  function hex(c) { var m = /^#?([0-9a-f]{6})$/i.exec((c || '').trim()); var v = m ? parseInt(m[1], 16) : 0xEDA33B; return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255]; }
  function mount(canvas, opt) {
    opt = opt || {};
    var gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' }) || canvas.getContext('experimental-webgl');
    if (!gl) return null;
    function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; }
    var vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return null;
    var pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
    gl.useProgram(pr);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var uR = gl.getUniformLocation(pr, 'r'), uT = gl.getUniformLocation(pr, 't');
    var cores = (opt.cores || ['#EDA33B', '#F3CA91', '#FAFAF7', '#EC9F92']).map(hex);
    ['c0', 'c1', 'c2', 'c3'].forEach(function (k, i) { gl.uniform3fv(gl.getUniformLocation(pr, k), cores[i]); });
    var dpr = Math.min(opt.dpr || 0.6, window.devicePixelRatio || 1);
    var vivo = true, visivel = true, raf = 0, inicio = performance.now(), ultimo = 0;
    var estatico = !!opt.estatico;
    function redimensionar() {
      var w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); gl.uniform2f(uR, w, h); }
    }
    function quadro(agora) {
      raf = 0;
      if (!vivo) return;
      redimensionar();
      gl.uniform1f(uT, (agora - inicio) / 1000 * (opt.velocidade || 1));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (estatico || !visivel) return;
      // ~30 fps bastam para um fundo lento
      raf = requestAnimationFrame(function (t) { if (t - ultimo < 30) { raf = requestAnimationFrame(quadro); return; } ultimo = t; quadro(t); });
    }
    function acordar() { if (vivo && !raf) raf = requestAnimationFrame(quadro); }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { visivel = e.isIntersecting; if (visivel) acordar(); }); }, { threshold: 0 }).observe(canvas);
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) acordar(); });
    window.addEventListener('resize', acordar);
    /* Contexto perdido (GPU reiniciou, aba em segundo plano por muito tempo): o canvas some e o degradê do CSS
       aparece por trás; quando o navegador devolve o contexto, remonta tudo e volta a animar. */
    canvas.addEventListener('webglcontextlost', function (ev) {
      ev.preventDefault(); vivo = false; if (raf) { cancelAnimationFrame(raf); raf = 0; }
      canvas.classList.add('is-perdido');
    });
    canvas.addEventListener('webglcontextrestored', function () {
      canvas.classList.remove('is-perdido');
      mount(canvas, opt);
    });
    acordar();
    return { destroy: function () { vivo = false; if (raf) cancelAnimationFrame(raf); } };
  }
  window.NoFluido = { mount: mount };
})();
