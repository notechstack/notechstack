/* /agentes/ · Escritório nó — gaveta com o mockup de WhatsApp de cada mesa.
   Módulo ES sem dependência. Contrato: .tasks/agentes-escritorio-frentes.md.

   montarGaveta(raiz, { estatico }) -> { abrir(agente, origem), fechar(), aoMudar(fn) }
   - agente: 'fiscal' | 'auditor'
   - estatico: true mostra a conversa inteira de uma vez, sem "digitando…" nem animação.
   - aoMudar(fn): fn({ aberta, agente }) em toda abertura, troca e fechamento.

   O mockup é um celular (moldura, barra de status, cabeçalho verde, fundo com rabiscos, balões,
   barra de entrada) desenhado só com HTML/CSS e SVG inline, sem imagem do WhatsApp. */

const ANIMACAO_MS = 320;
const RECOMECO_MS = 4000; // critério 14: 4 s depois da mensagem 5, volta à mensagem 1
const ANEXO_NUMERO = '000143'; // numeroBase (142) + 1, como em agentes/fiscal/fiscal.js

const LOGO = {
  fiscal: '/brand/logo/svg/no-tinta-ponto-verde.svg',
  auditor: '/brand/logo/svg/no-tinta-ponto-azul.svg',
};

// Ícones do mockup (traçados do Material Icons, Apache 2.0), todos em currentColor.
const ICONE = {
  voltar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
  telefone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>',
  emoji: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"/></svg>',
  clipe: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>',
  microfone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>',
  baixar: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path fill="currentColor" d="M11 6h2v7.2l2.6-2.6 1.4 1.4-5 5-5-5 1.4-1.4 2.6 2.6z"/></svg>',
  responder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
  cadeado: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM9 8V6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9z"/></svg>',
  sinal: '<svg viewBox="0 0 20 12" aria-hidden="true"><g fill="currentColor"><rect x="0" y="8" width="3.5" height="4" rx=".8"/><rect x="5.3" y="5.5" width="3.5" height="6.5" rx=".8"/><rect x="10.6" y="3" width="3.5" height="9" rx=".8"/><rect x="15.9" y="0" width="3.5" height="12" rx=".8"/></g></svg>',
  wifi: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>',
  bateria: '<svg viewBox="0 0 28 13" aria-hidden="true"><rect x=".6" y=".6" width="23" height="11.8" rx="3" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.2"/><rect x="2.4" y="2.4" width="19" height="8.2" rx="1.8" fill="currentColor"/><path fill="currentColor" fill-opacity=".5" d="M25.3 4.2v4.6c.9-.3 1.5-1.2 1.5-2.3s-.6-2-1.5-2.3z"/></svg>',
  pdf: '<svg viewBox="0 0 32 40" aria-hidden="true"><path fill="currentColor" d="M4 0h17l11 11v25a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z"/><path fill="white" fill-opacity=".45" d="M21 0v8a3 3 0 0 0 3 3h8z"/><text x="16" y="29" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9.5" font-weight="700" fill="white">PDF</text></svg>',
  xml: '<svg viewBox="0 0 32 40" aria-hidden="true"><path fill="currentColor" d="M4 0h17l11 11v25a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z"/><path fill="white" fill-opacity=".45" d="M21 0v8a3 3 0 0 0 3 3h8z"/><text x="16" y="29" text-anchor="middle" font-family="system-ui,sans-serif" font-size="9.5" font-weight="700" fill="white">XML</text></svg>',
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

// Mensagem de documento do WhatsApp: ícone do tipo, nome, "páginas · tipo · tamanho" e o botão de baixar.
function documento(tipo, nome, detalhe) {
  return '<span class="gv-anexo gv-anexo--' + tipo + '"><i aria-hidden="true">' + ICONE[tipo] + '</i>' +
    '<span class="gv-anexo-texto"><span class="gv-anexo-nome">' + esc(nome) + '</span><small>' + esc(detalhe) + '</small></span>' +
    '<i class="gv-anexo-baixar" aria-hidden="true">' + ICONE.baixar + '</i></span>';
}

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
          whatsappParaHtml('Entendi assim:\n\n*Tomador:* Studio Lima\n*Valor:* R$ 350,00\n*Serviço:* Modelo padrão · 04.01.01\n\nConfirmo a emissão?') +
          // botões de resposta do WhatsApp Business, presos ao balão
          '<div class="gv-botoes"><span class="gv-btn">' + ICONE.responder + 'Confirmar emissão</span><span class="gv-btn">' + ICONE.responder + 'Corrigir</span></div>',
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
          documento('pdf', 'danfse-' + ANEXO_NUMERO + '.pdf', '1 página · PDF · 42 kB') +
          documento('xml', 'nfse-' + ANEXO_NUMERO + '.xml', 'XML · 5 kB') +
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

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export function montarGaveta(raiz, { estatico = false } = {}) {
  if (!raiz) throw new Error('montarGaveta: raiz obrigatória');
  raiz.classList.add('gv');
  raiz.classList.toggle('gv--estatico', !!estatico);
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
    // ── o celular ──
    '<div class="gv-cel">' +
    '<div class="gv-wa" aria-label="Mockup de conversa no WhatsApp">' +
    '<div class="gv-status" aria-hidden="true"><span class="gv-status-hora">9:41</span><span class="gv-ilha"></span>' +
    '<span class="gv-status-icones">' + ICONE.sinal + ICONE.wifi + ICONE.bateria + '</span></div>' +
    '<div class="gv-wa-cab">' +
    '<span class="gv-wa-voltar" aria-hidden="true">' + ICONE.voltar + '</span>' +
    '<span class="gv-avatar"><img alt="" width="24" height="14"></span>' +
    '<span class="gv-wa-quem"><b class="gv-wa-nome"></b><small class="gv-wa-sub"></small></span>' +
    '<span class="gv-wa-acoes" aria-hidden="true">' + ICONE.video + ICONE.telefone + ICONE.menu + '</span>' +
    '</div>' +
    '<div class="gv-wa-fundo"><div class="gv-wa-padrao" aria-hidden="true"></div>' +
    '<div class="gv-wa-rolagem">' +
    '<span class="gv-wa-data">Hoje</span>' +
    '<span class="gv-wa-aviso">' + ICONE.cadeado + 'As mensagens são protegidas com a criptografia de ponta a ponta.</span>' +
    '<div class="gv-wa-conversa" aria-live="polite"></div>' +
    '</div></div>' +
    '<div class="gv-wa-entrada" aria-hidden="true">' +
    '<span class="gv-wa-campo">' + ICONE.emoji + '<span class="gv-wa-placeholder">Mensagem</span>' + ICONE.clipe + ICONE.camera + '</span>' +
    '<span class="gv-wa-mic">' + ICONE.microfone + '</span>' +
    '</div>' +
    '<div class="gv-wa-home" aria-hidden="true"><i></i></div>' +
    '</div>' +
    '</div>' +
    '<p class="gv-nota" hidden></p>' +
    '</div>' +
    '<div class="gv-rodape"><a class="gv-cta"></a></div>';

  raiz.append(fundo, painel);

  const q = (s) => painel.querySelector(s);
  const btnFechar = q('.gv-fechar');
  const titulo = q('.gv-titulo');
  const corpo = q('.gv-corpo');
  const rolagem = q('.gv-wa-rolagem');
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

  // A conversa rola dentro do celular; a última mensagem fica sempre visível.
  function rolarParaOFim() {
    rolagem.scrollTo({ top: rolagem.scrollHeight, behavior: estatico || reduzido() ? 'auto' : 'smooth' });
  }

  // Primeiro balão de uma sequência do mesmo lado: ganha a "pontinha" e um respiro maior.
  function inicioDeSequencia(lado) {
    const ultimo = conversa.lastElementChild;
    return !ultimo || !ultimo.classList.contains('gv-msg--' + lado);
  }

  function balao(m) {
    const b = el('div', 'gv-msg gv-msg--' + m.lado);
    if (inicioDeSequencia(m.lado)) b.classList.add('gv-msg--cauda');
    const miolo = el('div', 'gv-msg-miolo', m.html(m));
    // os botões de resposta ficam fora do miolo, abaixo da hora, como no WhatsApp Business
    const botoes = miolo.querySelector('.gv-botoes');
    if (botoes) botoes.remove();
    // a hora fica no canto inferior direito; se o miolo termina em texto, a última linha deixa espaço para ela
    const ultimo = miolo.lastElementChild;
    if (ultimo && (ultimo.tagName === 'P' || ultimo.classList.contains('gv-linha'))) ultimo.append(el('span', 'gv-espaco'));
    else miolo.classList.add('gv-msg-miolo--folga');
    miolo.append(el('span', 'gv-meta', '<span class="gv-hora">' + m.hora + '</span>' + (m.lado === 'pessoa' ? '<span class="gv-ticks" aria-label="lida">✓✓</span>' : '')));
    b.append(miolo);
    if (botoes) b.append(botoes);
    return b;
  }

  function mostrarDigitando(lado) {
    const d = el('div', 'gv-digitando gv-digitando--' + lado, '<i aria-hidden="true"></i><i aria-hidden="true"></i><i aria-hidden="true"></i><span class="gv-sr">digitando…</span>');
    if (inicioDeSequencia(lado)) d.classList.add('gv-digitando--cauda');
    conversa.append(d);
    rolarParaOFim();
    return d;
  }

  // O status do cabeçalho acompanha o agente: "digitando…" enquanto ele escreve.
  function statusCabecalho(agente, digitando) {
    sub.textContent = digitando ? 'digitando…' : MESAS[agente].subtitulo;
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
      if (m.lado === 'agente') statusCabecalho(agente, true);
      agendar(() => {
        if (!viva()) return;
        d.remove();
        if (m.lado === 'agente') statusCabecalho(agente, false);
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
    rolarParaOFim();
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
    rolagem.scrollTop = 0;
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
