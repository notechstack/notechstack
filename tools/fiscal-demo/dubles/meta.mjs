// Dublê da Meta / WhatsApp Cloud API (:3004). Recebe o que o agente manda (POST /<versão>/<phone-id>/messages e
// /media) e mostra a conversa em http://localhost:3004/conversa, onde dá para responder como o dono. A resposta vai
// ao webhook local no formato `entry[].changes[].value.messages[]`, assinada com X-Hub-Signature-256 (HMAC-SHA256
// do corpo com o segredo local gerado pela demo). O botão "Concluir no WhatsApp" do site cai aqui com o texto pronto.
import { createHmac } from 'node:crypto';
import { servidor, lerCorpo, lerJson, json, html, pagina, esc, id } from '../http.mjs';

const digitos = (v) => String(v || '').replace(/\D/g, '');

export function assinar(corpo, segredo) {
  return 'sha256=' + createHmac('sha256', segredo).update(corpo).digest('hex');
}

export function notificacao({ de, texto, phoneNumberId, numeroAgente }) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'demo-waba',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: numeroAgente, phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Dono (demo)' }, wa_id: digitos(de) }],
          messages: [{ from: digitos(de), id: id('wamid.demo'), timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }]
        }
      }]
    }]
  };
}

function textoDaMensagem(b) {
  if (b.type === 'text') return (b.text && b.text.body) || '';
  if (b.type === 'template') {
    const t = b.template || {};
    const params = (t.components || []).flatMap((c) => (c.parameters || []).map((x) => x.text)).filter(Boolean);
    return `[modelo ${t.name || '?'}] ${params.join(' · ')}`;
  }
  if (b.type === 'document') return `[documento ${(b.document && b.document.filename) || ''}] ${(b.document && b.document.caption) || ''}`;
  if (b.type === 'interactive') return `[botões] ${JSON.stringify(b.interactive)}`;
  return `[${b.type}]`;
}

/* donoPadrao(): WhatsApp do dono mais recente no banco local (para pré-preencher "Enviar como"). */
export async function iniciarMeta({ porta = 3004, webhookUrl, segredo, phoneNumberId, numeroAgente, donoPadrao = async () => '' } = {}) {
  const conversas = new Map();   // número do dono (dígitos) → [{de:'agente'|'dono', texto, em}]
  const midias = new Map();
  const falar = (numero, de, texto, extra = {}) => {
    const n = digitos(numero);
    if (!conversas.has(n)) conversas.set(n, []);
    conversas.get(n).push({ de, texto, em: new Date().toISOString(), ...extra });
  };

  async function enviarComoDono(de, texto) {
    const corpo = Buffer.from(JSON.stringify(notificacao({ de, texto, phoneNumberId, numeroAgente })));
    falar(de, 'dono', texto);
    let status = 0;
    try {
      const r = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': assinar(corpo, segredo) }, body: corpo });
      status = r.status;
    } catch (e) { status = 0; }
    if (status !== 200) falar(de, 'sistema', `O webhook local respondeu ${status || 'sem conexão'}.`);
    return status;
  }

  return servidor(porta, async (req, res, url) => {
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const envio = /^\/v[\d.]+\/([^/]+)\/(messages|media)$/.exec(p);
    if (req.method === 'POST' && envio) {
      if (!/^Bearer\s+\S+/i.test(req.headers.authorization || '')) { json(res, 401, { error: { message: 'Invalid OAuth access token', code: 190 } }); return; }
      if (envio[2] === 'media') {
        await lerCorpo(req);
        const m = id('media_');
        midias.set(m, true);
        json(res, 200, { id: m });
        return;
      }
      const b = (await lerJson(req)) || {};
      falar(b.to, 'agente', textoDaMensagem(b), { tipo: b.type });
      json(res, 200, { messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: digitos(b.to) }], messages: [{ id: id('wamid.') }] });
      return;
    }
    if (req.method === 'GET' && p === '/api/conversa') {
      json(res, 200, conversas.get(digitos(url.searchParams.get('numero'))) || []);
      return;
    }
    if (req.method === 'POST' && p === '/api/enviar') {
      const b = (await lerJson(req)) || {};
      if (!digitos(b.de) || !String(b.texto || '').trim()) { json(res, 422, { message: 'informe de e texto' }); return; }
      const status = await enviarComoDono(b.de, String(b.texto).trim());
      json(res, 200, { webhook_status: status });
      return;
    }
    if (req.method === 'GET' && (p === '/conversa' || p === '/')) {
      const dono = digitos(url.searchParams.get('de')) || digitos(await donoPadrao().catch(() => ''));
      const texto = url.searchParams.get('text') || '';
      html(res, 200, pagina('WhatsApp', `<h1>WhatsApp (Meta dublê)</h1>
<p class="cinza">Você é o dono, no número cadastrado. O que você manda aqui vai ao webhook local assinado, e as respostas do agente aparecem abaixo. Agente: <span class="mono">+${esc(digitos(url.searchParams.get('numero')) || numeroAgente)}</span>.</p>
<div class="cartao"><label>Enviar como <input id="de" class="mono" value="${esc(dono ? '+' + dono : '')}" placeholder="+5511987654321"></label></div>
<div class="cartao" id="conversa" style="display:grid;gap:10px;min-height:120px"></div>
<form id="f" class="cartao" style="display:flex;gap:10px"><input id="texto" style="flex:1" value="${esc(texto)}" placeholder="Mensagem" autocomplete="off"><button id="enviar" type="submit">Enviar</button></form>
<p class="cinza">Outras conversas: ${[...conversas.keys()].map((n) => `<a class="mono" href="/conversa?de=${n}">+${esc(n)}</a>`).join(' · ') || 'nenhuma'}</p>
<script>
const $=(i)=>document.getElementById(i);
async function atualizar(){const de=$('de').value;if(!de)return;const r=await fetch('/api/conversa?numero='+encodeURIComponent(de));const l=await r.json();
$('conversa').innerHTML=l.map(m=>'<div data-de="'+m.de+'" style="max-width:78%;padding:10px 14px;border-radius:16px;white-space:pre-wrap;'+(m.de==='dono'?'justify-self:end;background:#E5F4EC':m.de==='sistema'?'justify-self:center;background:#FBEAE5':'justify-self:start;background:#F3F2ED')+'">'+m.texto.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</div>').join('')||'<p class="cinza">Sem mensagens ainda.</p>';}
$('f').addEventListener('submit',async(e)=>{e.preventDefault();const t=$('texto').value.trim();if(!t)return;$('enviar').disabled=true;
await fetch('/api/enviar',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({de:$('de').value,texto:t})});$('texto').value='';$('enviar').disabled=false;atualizar();});
$('de').addEventListener('change',atualizar);atualizar();setInterval(atualizar,1500);
</script>`));
      return;
    }
    json(res, 404, { error: { message: 'rota sem dublê na demonstração' } });
  }, 'meta');
}
