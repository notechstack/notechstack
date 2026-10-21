// Dublê do Pagar.me v5 (:3002) para a demonstração: tokenização de cartão (/core/v5/tokens?appId=), assinaturas
// (criar, ler, cancelar, trocar cartão e qualquer ajuste em /subscriptions/:id/...). O cartão 4000 0000 0000 0010
// é recusado na criação da assinatura (status "failed", como o Pagar.me devolve). Nada sai da máquina.
import { servidor, lerJson, json, html, pagina, esc, id } from '../http.mjs';

export const CARTAO_RECUSADO = '4000000000000010';

export async function iniciarPagarme({ porta = 3002 } = {}) {
  const tokens = new Map();
  const assinaturas = new Map();
  const log = [];
  const registrar = (metodo, caminho, status, nota) => { log.unshift({ em: new Date().toISOString(), metodo, caminho, status, nota }); log.length = Math.min(log.length, 200); };
  const autorizado = (req) => /^Basic\s+/i.test(req.headers.authorization || '') &&
    Buffer.from(String(req.headers.authorization).replace(/^Basic\s+/i, ''), 'base64').toString().startsWith('sk_test_');

  return servidor(porta, async (req, res, url) => {
    const p = url.pathname.replace(/\/+$/, '');
    if (req.method === 'GET' && (p === '' || p === '/')) {
      html(res, 200, pagina('Pagar.me', `<h1>Pagar.me (dublê)</h1><p class="cinza">Cartão aprovado: qualquer número válido, por exemplo <code>4111 1111 1111 1111</code>. Recusado: <code>4000 0000 0000 0010</code>.</p>
        <div class="cartao"><h2>Assinaturas</h2><table><tr><th>id</th><th>status</th><th>plano</th><th>cartão</th></tr>${[...assinaturas.values()].map((s) => `<tr><td class="mono">${esc(s.id)}</td><td>${esc(s.status)}</td><td class="mono">${esc(s.plan.id)}</td><td class="mono">•••• ${esc(s.card.last_four_digits)}</td></tr>`).join('') || '<tr><td colspan="4" class="cinza">nenhuma ainda</td></tr>'}</table></div>
        <div class="cartao"><h2>Chamadas</h2><table>${log.map((l) => `<tr><td class="mono">${esc(l.em.slice(11, 19))}</td><td class="mono">${esc(l.metodo)} ${esc(l.caminho)}</td><td>${esc(l.status)}</td><td class="cinza">${esc(l.nota || '')}</td></tr>`).join('')}</table></div>`, { atualizar: 5 }));
      return;
    }
    if (p === '/core/v5/tokens' && req.method === 'POST') {
      const appId = url.searchParams.get('appId') || '';
      const b = await lerJson(req);
      const c = (b && b.card) || {};
      const numero = String(c.number || '').replace(/\D/g, '');
      if (!appId.startsWith('pk_') || numero.length < 13) { registrar('POST', p, 422, 'cartão ou appId inválido'); json(res, 422, { message: 'The request is invalid.', errors: { 'card.number': ['inválido'] } }); return; }
      const t = { id: id('token_'), type: 'card', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
        card: { first_six_digits: numero.slice(0, 6), last_four_digits: numero.slice(-4), holder_name: c.holder_name, exp_month: c.exp_month, exp_year: c.exp_year, brand: numero.startsWith('4') ? 'Visa' : 'Mastercard' }, _recusado: numero === CARTAO_RECUSADO };
      tokens.set(t.id, t);
      registrar('POST', p, 200, `token •••• ${t.card.last_four_digits}`);
      const { _recusado, ...publico } = t;
      json(res, 200, publico);
      return;
    }
    if (!p.startsWith('/core/v5/')) { json(res, 404, { message: 'não encontrado' }); return; }
    if (!autorizado(req)) { registrar(req.method, p, 401, 'sem sk_test_'); json(res, 401, { message: 'Authorization has been denied for this request.' }); return; }

    if (p === '/core/v5/subscriptions' && req.method === 'POST') {
      const b = (await lerJson(req)) || {};
      const t = tokens.get(b.card_token);
      if (!t) { registrar('POST', p, 422, 'card_token desconhecido'); json(res, 422, { message: 'The request is invalid.', errors: { card_token: ['inválido'] } }); return; }
      const agora = new Date();
      const fim = new Date(agora.getTime() + 30 * 86400000);
      const s = {
        id: id('sub_'), code: id(''), status: t._recusado ? 'failed' : 'active', start_at: agora.toISOString(), interval: 'month', interval_count: 1,
        billing_type: 'prepaid', payment_method: 'credit_card', plan: { id: b.plan_id }, customer: { id: id('cus_'), name: b.customer && b.customer.name, email: b.customer && b.customer.email },
        card: t.card, current_cycle: { id: id('cycle_'), start_at: agora.toISOString(), end_at: fim.toISOString(), billing_at: agora.toISOString() },
        next_billing_at: fim.toISOString(), created_at: agora.toISOString(), updated_at: agora.toISOString(), metadata: b.metadata || {}, items: [{ id: id('si_'), status: 'active', pricing_scheme: {} }]
      };
      assinaturas.set(s.id, s);
      registrar('POST', p, 200, `${s.status} · ${b.plan_id}`);
      json(res, 200, s);
      return;
    }
    const m = /^\/core\/v5\/subscriptions\/(sub_[\w]+)(\/.*)?$/.exec(p);
    if (m) {
      const s = assinaturas.get(m[1]);
      if (!s) { registrar(req.method, p, 404, ''); json(res, 404, { message: 'Subscription not found' }); return; }
      const resto = m[2] || '';
      const b = req.method === 'GET' || req.method === 'DELETE' ? {} : ((await lerJson(req)) || {});
      if (req.method === 'DELETE' && !resto) {
        s.status = 'canceled'; s.canceled_at = new Date().toISOString();
      } else if (resto === '/card' && b.card_token) {
        const t = tokens.get(b.card_token);
        if (!t) { registrar(req.method, p, 422, 'card_token desconhecido'); json(res, 422, { message: 'The request is invalid.' }); return; }
        if (t._recusado) { registrar(req.method, p, 412, 'cartão recusado'); json(res, 412, { message: 'Card declined' }); return; }
        s.card = t.card;
      } else if (req.method !== 'GET') {
        s.ajustes = (s.ajustes || []).concat([{ em: new Date().toISOString(), metodo: req.method, caminho: resto, corpo: b }]);
        if (b.plan_id) s.plan = { id: b.plan_id };
      }
      s.updated_at = new Date().toISOString();
      registrar(req.method, p, 200, s.status);
      json(res, 200, s);
      return;
    }
    if (/^\/core\/v5\/plans\/[\w]+$/.test(p) && req.method === 'GET') { json(res, 200, { id: p.split('/').pop(), status: 'active' }); return; }
    registrar(req.method, p, 404, 'rota sem dublê');
    json(res, 404, { message: 'rota sem dublê na demonstração' });
  }, 'pagarme');
}
