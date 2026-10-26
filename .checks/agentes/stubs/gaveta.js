// STUB da gaveta (frente C) só para a bancada da frente A. Não vai para produção.
// Cumpre o contrato de montarGaveta: abrir/fechar/aoMudar, ×, Esc, toque fora,
// foco preso e foco de volta ao botão de origem. Sem mockup de WhatsApp.
window.__stubGavetaCarregada = performance.now();

const TITULOS = {
  fiscal: 'nó.fiscal — sua NFS-e pelo WhatsApp',
  auditor: 'Auditor — seu relatório semanal no WhatsApp',
};
const CTAS = {
  fiscal: ['Simular uma emissão', '/agentes/fiscal/#simulador'],
  auditor: ['Diagnosticar grátis', '/agentes/auditor/'],
};

export function montarGaveta(raiz, { estatico = false } = {}) {
  window.__stubGaveta = { estatico };
  const ouvintes = new Set();
  let origem = null;
  let agenteAberto = null;

  raiz.innerHTML = `
    <div class="stub-gaveta-fundo" hidden></div>
    <section class="stub-gaveta" role="dialog" aria-modal="true" aria-labelledby="stub-gaveta-titulo" hidden>
      <button type="button" class="stub-gaveta-fechar" aria-label="Fechar">×</button>
      <span class="stub-gaveta-selo">DEMONSTRAÇÃO</span>
      <h2 id="stub-gaveta-titulo"></h2>
      <p class="stub-gaveta-texto">bancada · stub da gaveta (frente C)${estatico ? ' · estática' : ''}</p>
      <a class="stub-gaveta-cta" href="#"></a>
    </section>`;
  const fundo = raiz.querySelector('.stub-gaveta-fundo');
  const folha = raiz.querySelector('.stub-gaveta');
  const fechar = raiz.querySelector('.stub-gaveta-fechar');
  const tituloEl = raiz.querySelector('#stub-gaveta-titulo');
  const cta = raiz.querySelector('.stub-gaveta-cta');
  const avisar = () => ouvintes.forEach((fn) => fn({ aberta: Boolean(agenteAberto), agente: agenteAberto }));

  function abrir(agente, botao) {
    origem = botao || origem;
    agenteAberto = agente;
    tituloEl.textContent = TITULOS[agente] || agente;
    [cta.textContent, cta.href] = CTAS[agente] || ['', '#'];
    fundo.hidden = false;
    folha.hidden = false;
    fechar.focus();
    avisar();
  }
  function fecharGaveta() {
    if (!agenteAberto) return;
    agenteAberto = null;
    fundo.hidden = true;
    folha.hidden = true;
    avisar();
    origem?.focus();
  }

  fechar.addEventListener('click', fecharGaveta);
  fundo.addEventListener('click', fecharGaveta);
  document.addEventListener('keydown', (ev) => {
    if (!agenteAberto) return;
    if (ev.key === 'Escape') { ev.preventDefault(); fecharGaveta(); return; }
    if (ev.key !== 'Tab') return;
    const focaveis = [...folha.querySelectorAll('button, a[href]')];
    const primeiro = focaveis[0];
    const ultimo = focaveis[focaveis.length - 1];
    if (ev.shiftKey && document.activeElement === primeiro) { ev.preventDefault(); ultimo.focus(); }
    else if (!ev.shiftKey && document.activeElement === ultimo) { ev.preventDefault(); primeiro.focus(); }
    else if (!folha.contains(document.activeElement)) { ev.preventDefault(); primeiro.focus(); }
  });

  return { abrir, fechar: fecharGaveta, aoMudar(fn) { ouvintes.add(fn); } };
}
