// Dublê da Resend (:3003): recebe POST /emails (e POST / para quem usa a URL inteira) e mostra uma caixa de
// entrada em http://localhost:3003, com o código de 6 dígitos em destaque. /api/emails devolve a lista em JSON.
import { servidor, lerJson, json, html, pagina, esc, id } from '../http.mjs';

const textoDe = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
export const codigoDe = (e) => { const m = /(?:^|\D)(\d{6})(?!\d)/.exec(e.text || textoDe(e.html)); return m ? m[1] : null; };

export async function iniciarResend({ porta = 3003 } = {}) {
  const emails = [];
  return servidor(porta, async (req, res, url) => {
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'POST' && (p === '/emails' || p === '/')) {
      const b = (await lerJson(req)) || {};
      if (!/^Bearer\s+\S+/i.test(req.headers.authorization || '')) { json(res, 401, { name: 'missing_api_key', message: 'Missing API key' }); return; }
      const e = { id: id(''), em: new Date().toISOString(), from: b.from, to: [].concat(b.to || []), subject: b.subject, html: b.html, text: b.text, anexos: (b.attachments || []).map((a) => a.filename) };
      e.codigo = codigoDe(e);
      emails.unshift(e);
      json(res, 200, { id: e.id });
      return;
    }
    if (req.method === 'GET' && p === '/api/emails') {
      const para = (url.searchParams.get('to') || '').toLowerCase();
      json(res, 200, emails.filter((e) => !para || e.to.some((t) => String(t).toLowerCase().includes(para))));
      return;
    }
    const ver = /^\/email\/(\w+)$/.exec(p);
    if (req.method === 'GET' && ver) {
      const e = emails.find((x) => x.id === ver[1]);
      if (!e) { html(res, 404, pagina('E-mail', '<p>Não achei este e-mail.</p>')); return; }
      html(res, 200, pagina(e.subject || 'E-mail', `<p><a href="/">← caixa de entrada</a></p><h1>${esc(e.subject)}</h1>
        <p class="cinza">De ${esc(e.from)} para ${esc(e.to.join(', '))} · ${esc(e.em)}</p>${e.codigo ? `<p>Código: <span class="codigo">${esc(e.codigo)}</span></p>` : ''}
        <div class="cartao"><iframe sandbox title="corpo do e-mail" style="width:100%;min-height:480px;border:0" srcdoc="${esc(e.html || `<pre>${esc(e.text || '')}</pre>`)}"></iframe></div>`));
      return;
    }
    if (req.method === 'GET' && p === '/') {
      html(res, 200, pagina('Caixa de entrada', `<h1>Caixa de entrada (Resend dublê)</h1><p class="cinza">Os e-mails que as funções e o app mandariam. A página se atualiza sozinha.</p>
        ${emails.map((e) => `<div class="cartao"><p class="cinza mono">${esc(e.em.slice(11, 19))} · para ${esc(e.to.join(', '))}</p><p><a href="/email/${e.id}"><b>${esc(e.subject)}</b></a></p>
        ${e.codigo ? `<p>Código: <span class="codigo" data-codigo="${esc(e.codigo)}">${esc(e.codigo)}</span></p>` : ''}${e.anexos.length ? `<p class="cinza">Anexos: ${esc(e.anexos.join(', '))}</p>` : ''}</div>`).join('') || '<div class="cartao cinza">Nenhum e-mail ainda.</div>'}`, { atualizar: 3 }));
      return;
    }
    json(res, 404, { message: 'não encontrado' });
  }, 'resend');
}
