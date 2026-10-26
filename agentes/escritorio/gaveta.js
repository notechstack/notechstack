/* /agentes/ · Escritório nó — gaveta com o mockup de WhatsApp de cada mesa.
   Módulo ES sem dependência. Contrato: .tasks/agentes-escritorio-frentes.md.

   montarGaveta(raiz, { estatico }) -> { abrir(agente, origem), fechar(), aoMudar(fn) }
   - agente: 'fiscal' | 'auditor'
   - estatico: true mostra a conversa inteira de uma vez, sem "digitando…" nem animação.
   - aoMudar(fn): fn({ aberta, agente }) em toda abertura, troca e fechamento. */

const ANIMACAO_MS = 320;
const RECOMECO_MS = 4000; // critério 14: 4 s depois da mensagem 5, volta à mensagem 1
const ANEXO_NUMERO = '000143'; // numeroBase (142) + 1, como em agentes/fiscal/fiscal.js

const LOGO = {
  fiscal: '/brand/logo/svg/no-tinta-ponto-verde.svg',
  auditor: '/brand/logo/svg/no-tinta-ponto-azul.svg',
};

const MESAS = {
  fiscal: {
    titulo: 'nó.fiscal — sua NFS-e pelo WhatsApp',
    nome: 'nó.fiscal',
    subtitulo: 'online',
    cta: { rotulo: 'Simular uma emissão', href: '/agentes/fiscal/#simulador' },
    nota: null,
    laco: true,
    // Ordem e textos do critério 13, copiados de agentes/fiscal/fiscal.js (linhas 248–311).
    mensagens: [
      { lado: 'pessoa', hora: '10:12', digitando: 250, pausa: 500, html: () => '<p>nota pra Studio Lima, 350 reais</p>' },
      {
        lado: 'agente', hora: '10:12', digitando: 1100, pausa: 900,
        html: () =>
          '<p>Entendi assim:</p>' +
          '<ul class="gv-resumo">' +
          '<li><span>Tomador</span><b>Studio Lima</b></li>' +
          '<li><span>Valor</span><b>R$ 350,00</b></li>' +
          '<li><span>Serviço</span><b>Modelo padrão · 04.01.01</b></li>' +
          '</ul>' +
          '<p>Confirmo a emissão?</p>' +
          '<div class="gv-botoes"><span class="gv-btn gv-btn--cheio">Confirmar emissão</span><span class="gv-btn">Corrigir</span></div>',
      },
      { lado: 'pessoa', hora: '10:13', digitando: 250, pausa: 400, html: () => '<p>Confirmar emissão</p>' },
      {
        lado: 'agente', hora: '10:13', digitando: 800, pausa: 300,
        passos: ['Montando a DPS 1.01', 'Assinando com o certificado A1', 'Transmitindo à Sefin Nacional', 'NFS-e autorizada'],
        ritmo: [600, 600, 900, 600],
        html: (m) => '<p>Emitindo…</p><ol class="gv-passos">' + m.passos.map((p) => '<li><i aria-hidden="true"></i>' + p + '</li>').join('') + '</ol>',
      },
      {
        lado: 'agente', hora: '10:14', digitando: 800, pausa: 0,
        html: () =>
          '<p>Pronto! NFS-e autorizada.</p>' +
          '<div class="gv-anexos">' +
          '<span class="gv-anexo"><i aria-hidden="true">PDF</i>danfse-' + ANEXO_NUMERO + '.pdf</span>' +
          '<span class="gv-anexo"><i aria-hidden="true">XML</i>nfse-' + ANEXO_NUMERO + '.xml</span>' +
          '</div>' +
          '<span class="gv-carimbo">simulação</span>',
      },
    ],
  },
  auditor: {
    titulo: 'Auditor — seu relatório semanal no WhatsApp',
    nome: 'nó.',
    subtitulo: 'equipe nó',
    cta: { rotulo: 'Diagnosticar grátis', href: '/agentes/auditor/' },
    nota: 'Cópia opcional do relatório, enviada pela equipe da nó. O relatório chega no e-mail e no painel.',
    laco: false,
    // Formato de textoCopia (supabase/functions/marketing-hub/auditor.ts). Negócio, período e
    // números só da demonstração pública agentes/auditor/retrospectiva/index.html (Unresolved 3).
    mensagens: [
      {
        lado: 'agente', hora: '08:05', digitando: 1400, pausa: 0,
        texto: [
          '*Relatório semanal · Loja Exemplo* (05/10 a 11/10)',
          '',
          'Seus anúncios na Meta trouxeram 6.140 cliques, mas a página leva 7,2 s para abrir e 55% dos cliques pagos não viraram visita. O Reels do Instagram segue com o clique mais barato: 38% dos cliques no link.',
          '',
          '*Prioridades*',
          '1. Tempo de resposta: revise imagens e scripts pesados que atrasam a página.',
          '2. Tag repetida: deixe a tag do GA4 em um lugar só, de preferência no GTM.',
          '3. Eventos pelo servidor: ative o envio de eventos pelo servidor.',
          '',
          'Relatório completo: https://app.notechstack.com.br/auditor/loja-exemplo/relatorios/semana-atual',
        ].join('\n'),
        html: (m) => whatsappParaHtml(m.texto),
      },
    ],
  },
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Texto no formato do WhatsApp: *negrito* vira <b>, URL vira link visual (sem href: o mockup não navega).
function whatsappParaHtml(texto) {
  return texto.split('\n').map((linha) => {
    if (!linha) return '<span class="gv-quebra"></span>';
    let h = esc(linha).replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
    h = h.replace(/https?:\/\/\S+/g, (u) => '<span class="gv-link">' + u + '</span>');
    return '<span class="gv-linha">' + h + '</span>';
  }).join('');
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export function montarGaveta(raiz, { estatico = false } = {}) {
  if (!raiz) throw new Error('montarGaveta: raiz obrigatória');
  raiz.classList.add('gv');
  raiz.innerHTML = '';

  const fundo = el('div', 'gv-fundo');
  fundo.hidden = true;
  const painel = el('div', 'gv-painel');
  painel.hidden = true;
  painel.setAttribute('role', 'dialog');
  painel.setAttribute('aria-modal', 'true');
  painel.setAttribute('aria-labelledby', 'gv-titulo');
  painel.tabIndex = -1;

  painel.innerHTML =
    '<div class="gv-alca" aria-hidden="true"></div>' +
    '<button type="button" class="gv-fechar" aria-label="Fechar"><span aria-hidden="true">×</span></button>' +
    '<div class="gv-cabeca"><span class="gv-selo">DEMONSTRAÇÃO</span><h2 class="gv-titulo" id="gv-titulo"></h2></div>' +
    '<div class="gv-corpo">' +
    '<div class="gv-wa" aria-label="Mockup de conversa no WhatsApp">' +
    '<div class="gv-wa-cab"><span class="gv-avatar"><img alt="" width="24" height="14"></span>' +
    '<span class="gv-wa-quem"><b class="gv-wa-nome"></b><small class="gv-wa-sub"></small></span></div>' +
    '<div class="gv-wa-conversa" aria-live="polite"></div>' +
    '</div>' +
    '<p class="gv-nota" hidden></p>' +
    '</div>' +
    '<div class="gv-rodape"><a class="gv-cta"></a></div>';

  raiz.append(fundo, painel);

  const q = (s) => painel.querySelector(s);
  const btnFechar = q('.gv-fechar');
  const titulo = q('.gv-titulo');
  const corpo = q('.gv-corpo');
  const avatar = q('.gv-avatar img');
  const nome = q('.gv-wa-nome');
  const sub = q('.gv-wa-sub');
  const conversa = q('.gv-wa-conversa');
  const nota = q('.gv-nota');
  const cta = q('.gv-cta');

  const ouvintes = [];
  let aberta = false;
  let agenteAtual = null;
  let origemAtual = null;
  let temporizadores = [];
  let fechamento = null; // temporizador da animação de saída
  let ultimoFoco = null;
  let sessaoAtual = null; // identifica a encenação em curso; troca ou fechamento invalida a anterior
  let ultimaAbertura = 0; // instante do último abrir(): um toque que acabou de abrir outra mesa não conta como "toque fora"

  const reduzido = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function avisar() {
    const estado = { aberta, agente: agenteAtual };
    ouvintes.forEach((fn) => { try { fn(estado); } catch (e) { console.error(e); } });
  }

  function agendar(fn, ms) {
    const id = setTimeout(() => { temporizadores = temporizadores.filter((t) => t !== id); fn(); }, ms);
    temporizadores.push(id);
    return id;
  }
  function cancelarTemporizadores() {
    temporizadores.forEach(clearTimeout);
    temporizadores = [];
  }

  function rolarParaOFim() {
    corpo.scrollTo({ top: corpo.scrollHeight, behavior: estatico || reduzido() ? 'auto' : 'smooth' });
  }

  function balao(m) {
    const b = el('div', 'gv-msg gv-msg--' + m.lado, m.html(m));
    b.append(el('span', 'gv-meta', '<span class="gv-hora">' + m.hora + '</span>' + (m.lado === 'pessoa' ? '<span class="gv-ticks" aria-label="lida">✓✓</span>' : '')));
    return b;
  }

  function mostrarDigitando(lado) {
    const d = el('div', 'gv-digitando gv-digitando--' + lado, '<i aria-hidden="true"></i><i aria-hidden="true"></i><i aria-hidden="true"></i><span>digitando…</span>');
    conversa.append(d);
    rolarParaOFim();
    return d;
  }

  // Encena a conversa mensagem a mensagem; cada chamada checa se ainda é a mesma sessão.
  function encenar(agente) {
    const mesa = MESAS[agente];
    const sessao = {};
    sessaoAtual = sessao;
    const viva = () => sessaoAtual === sessao && aberta && agenteAtual === agente;

    const passo = (i) => {
      if (!viva()) return;
      if (i >= mesa.mensagens.length) {
        if (mesa.laco) agendar(() => { if (!viva()) return; conversa.innerHTML = ''; passo(0); }, RECOMECO_MS);
        return;
      }
      const m = mesa.mensagens[i];
      const d = mostrarDigitando(m.lado);
      agendar(() => {
        if (!viva()) return;
        d.remove();
        const b = balao(m);
        conversa.append(b);
        rolarParaOFim();
        let atraso = m.pausa;
        if (m.passos) {
          const itens = b.querySelectorAll('.gv-passos li');
          let acumulado = 0;
          m.ritmo.forEach((ms, k) => {
            acumulado += ms;
            agendar(() => { if (!viva()) return; itens[k].classList.remove('is-ativo'); itens[k].classList.add('is-feito'); if (itens[k + 1]) itens[k + 1].classList.add('is-ativo'); rolarParaOFim(); }, acumulado);
          });
          itens[0].classList.add('is-ativo');
          atraso += acumulado;
        }
        agendar(() => passo(i + 1), atraso);
      }, m.digitando);
    };
    passo(0);
  }

  function renderizarEstatico(agente) {
    const mesa = MESAS[agente];
    mesa.mensagens.forEach((m) => {
      const b = balao(m);
      b.querySelectorAll('.gv-passos li').forEach((li) => li.classList.add('is-feito'));
      conversa.append(b);
    });
  }

  function preencher(agente) {
    const mesa = MESAS[agente];
    painel.dataset.agente = agente;
    // "NFS-e" não quebra no hífen (o texto continua idêntico ao do critério 12)
    titulo.innerHTML = esc(mesa.titulo).replace(/NFS-e/g, '<span class="gv-nq">NFS-e</span>');
    avatar.src = LOGO[agente];
    nome.textContent = mesa.nome;
    sub.textContent = mesa.subtitulo;
    conversa.innerHTML = '';
    nota.hidden = !mesa.nota;
    nota.textContent = mesa.nota || '';
    cta.textContent = mesa.cta.rotulo;
    cta.href = mesa.cta.href;
    corpo.scrollTop = 0;
    if (estatico) renderizarEstatico(agente); else encenar(agente);
  }

  function focaveis() {
    return Array.from(painel.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')).filter((e) => !e.hidden && e.offsetParent !== null);
  }

  function aoTeclar(ev) {
    if (!aberta) return;
    if (ev.key === 'Escape') { ev.preventDefault(); fechar(); return; }
    if (ev.key !== 'Tab') return;
    const lista = focaveis();
    if (!lista.length) { ev.preventDefault(); painel.focus(); return; }
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    const ativo = document.activeElement;
    const dentro = painel.contains(ativo);
    if (ev.shiftKey) {
      if (!dentro || ativo === primeiro || ativo === painel) { ev.preventDefault(); ultimo.focus(); }
    } else if (!dentro || ativo === ultimo) { ev.preventDefault(); primeiro.focus(); }
  }

  // Se o foco escapar da gaveta (toque no canvas, por exemplo), traz de volta.
  function aoFocar(ev) {
    if (!aberta || painel.contains(ev.target)) return;
    const lista = focaveis();
    (lista[0] || painel).focus();
  }

  // Toque fora da gaveta fecha (critério 20). O fundo não captura ponteiro: assim o toque numa
  // outra mesa (botão ou canvas) chega até ela e vira troca de gaveta (critério 21), não fechamento.
  function aoTocarFora(ev) {
    if (!aberta) return;
    const alvo = ev.target;
    if (!(alvo instanceof Node) || !alvo.isConnected || painel.contains(alvo)) return;
    if (performance.now() - ultimaAbertura < 100) return; // o mesmo toque acabou de abrir outra mesa
    fechar();
  }

  function abrir(agente, origem) {
    if (!MESAS[agente]) throw new Error('montarGaveta: agente desconhecido: ' + agente);
    cancelarTemporizadores();
    sessaoAtual = null;
    if (fechamento) { clearTimeout(fechamento); fechamento = null; }

    const jaAberta = aberta;
    aberta = true;
    agenteAtual = agente;
    ultimaAbertura = performance.now();
    if (origem) origemAtual = origem;
    if (!jaAberta) ultimoFoco = origem || document.activeElement;

    fundo.hidden = false;
    painel.hidden = false;
    document.documentElement.classList.add('gv-aberta');
    if (!jaAberta) {
      document.addEventListener('keydown', aoTeclar, true);
      document.addEventListener('focusin', aoFocar, true);
      // na fase de borbulha, depois dos handlers das mesas: um toque que abriu outra mesa não fecha
      setTimeout(() => { if (aberta) document.addEventListener('click', aoTocarFora); }, 0);
      // reflow para a transição de entrada partir do estado fechado
      void painel.offsetHeight;
    }
    painel.classList.add('is-aberta');
    fundo.classList.add('is-aberta');

    preencher(agente);
    btnFechar.focus({ preventScroll: true });
    avisar();
  }

  function fechar() {
    if (!aberta) return;
    cancelarTemporizadores();
    sessaoAtual = null;
    aberta = false;
    agenteAtual = null;
    painel.classList.remove('is-aberta');
    fundo.classList.remove('is-aberta');
    document.documentElement.classList.remove('gv-aberta');
    document.removeEventListener('keydown', aoTeclar, true);
    document.removeEventListener('focusin', aoFocar, true);
    document.removeEventListener('click', aoTocarFora);

    const alvo = origemAtual || ultimoFoco;
    origemAtual = null;
    ultimoFoco = null;
    if (alvo && typeof alvo.focus === 'function' && alvo.isConnected) alvo.focus({ preventScroll: true });

    const esconder = () => { fechamento = null; painel.hidden = true; fundo.hidden = true; conversa.innerHTML = ''; };
    if (reduzido()) esconder(); else fechamento = setTimeout(esconder, ANIMACAO_MS);
    avisar();
  }

  btnFechar.addEventListener('click', fechar);

  return {
    abrir,
    fechar,
    aoMudar(fn) { if (typeof fn === 'function') ouvintes.push(fn); },
  };
}
