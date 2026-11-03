/* Meta Conversions API — envio server-side de eventos.

   POR QUE EXISTE: o pixel do navegador perde entre 15% e 30% dos eventos para
   bloqueador de anúncio e ITP. O que sai daqui não passa pelo navegador da
   pessoa, então nada disso derruba.

   DEDUP: cada evento carrega `event_id`. O pixel manda o MESMO id no
   `eventID`, e a Meta descarta a duplicata sozinha, ficando com a versão mais
   rica das duas. O id é o `lead_sid` da sessão (com prefixo por tipo de
   evento, menos no Lead, que usa o sid puro).

   SELF-CONTAINED DE PROPÓSITO: nada de importar de `../_shared`. Já quebrou
   deploy antes nesta mesma organização — o custo de repetir trinta linhas de
   CORS é menor que o de uma function que não sobe.

   Deploy: precisa de --no-verify-jwt. O browser chama sem Authorization; com
   verify_jwt ligado toda chamada volta 401 antes de entrar aqui.

   POLÍTICA DA META: em PageView e ViewContent, `custom_data` leva SÓ `value` e
   `currency`. Sem content_name / content_category / content_ids / contents.
   Quatro das dezenove folhas da árvore do CRT são saúde, e categoria de saúde
   em evento Meta é violação de política, com risco de conta restrita.
   EXCEÇÃO FECHADA (03/11/2026, funil do nó.fiscal): AddToCart e Lead aceitam
   também content_name, content_ids, content_type e content_category, mas só
   com valores do próprio nó.fiscal (nome "nó.fiscal …", ids "nofiscal-…",
   categoria "nofiscal", tipo "product"). Qualquer outro valor é descartado,
   então não há caminho para categoria de saúde entrar por aqui. */

const PIXEL_ID = '1753619075655271';          // portfólio 990413650211777
const GRAPH    = 'https://graph.facebook.com/v21.0';

/* LISTA FECHADA: a função é pública (sem JWT), então só passam os eventos de
   navegação que ela existe para cobrir. O Lead dos formulários e o Purchase
   saem do servidor (send-lead-email, pagarme-webhook-no, assinatura-fiscal*)
   e DiagnosticoEntregue sai do diagnostico-auditor; nenhum deles entra aqui.
   AddToCart (plano escolhido) e Lead (Escritório e Agência pelo WhatsApp) do
   nó.fiscal entram desde 03/11/2026, com as travas de EVENTOS_NOFISCAL. */
const EVENTOS_PERMITIDOS = new Set(['PageView', 'ViewContent', 'AddToCart', 'Lead']);

/* Travas dos eventos do nó.fiscal, que valem para otimização de campanha e
   por isso não podem ser fáceis de forjar: Origin do site de produção (o
   navegador sempre manda Origin num POST JSON entre origens; a página só
   chama esta função nos hosts de shared/marketing-host.js), event_id no
   formato do site (o mesmo do Pixel, para a Meta deduplicar) e custom_data só
   com valores do nó.fiscal. PageView e ViewContent seguem como antes. */
const EVENTOS_NOFISCAL = new Set(['AddToCart', 'Lead']);
const HOSTS_DO_SITE = new Set(['www.notechstack.com.br', 'notechstack.com.br']);
const EVENT_ID_NOFISCAL = /^nofiscal-[A-Za-z0-9_-]{6,100}$/;
const CONTENT_ID_NOFISCAL = /^nofiscal-[a-z0-9-]{1,40}$/;
const VALOR_MAXIMO = 100000;

function origemDoSite(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && HOSTS_DO_SITE.has(u.hostname) && !u.port;
  } catch {
    return false;
  }
}

/* Só origem + caminho de uma página do site; qualquer outra coisa some. */
function paginaDoSite(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && HOSTS_DO_SITE.has(u.hostname) ? `${u.origin}${u.pathname}` : undefined;
  } catch {
    return undefined;
  }
}

/* custom_data permitido. Aceita os campos no topo do corpo (formato de
   sempre: value, currency) e dentro de `custom_data` (que vence). */
function customData(eventName: string, body: Record<string, unknown>): Record<string, unknown> {
  const aninhado = body.custom_data && typeof body.custom_data === 'object' && !Array.isArray(body.custom_data)
    ? body.custom_data as Record<string, unknown>
    : {};
  const campo = (k: string) => (k in aninhado ? aninhado[k] : body[k]);

  const valor = campo('value');
  const moeda = typeof campo('currency') === 'string' ? String(campo('currency')).trim().toUpperCase() : '';
  const out: Record<string, unknown> = {
    value: typeof valor === 'number' && Number.isFinite(valor) && valor >= 0 && valor <= VALOR_MAXIMO ? valor : 0,
    currency: /^[A-Z]{3}$/.test(moeda) ? moeda : 'BRL',
  };
  if (!EVENTOS_NOFISCAL.has(eventName)) return out;

  const nome = campo('content_name');
  if (typeof nome === 'string') {
    const n = nome.normalize('NFC').trim();
    if (n.length <= 60 && /^nó\.fiscal( [\p{L}\p{N} ]{1,40})?$/u.test(n)) out.content_name = n;
  }
  const ids = campo('content_ids');
  if (Array.isArray(ids) && ids.length >= 1 && ids.length <= 5 &&
      ids.every((i) => typeof i === 'string' && CONTENT_ID_NOFISCAL.test(i))) {
    out.content_ids = ids;
  }
  if (campo('content_type') === 'product') out.content_type = 'product';
  if (campo('content_category') === 'nofiscal') out.content_category = 'nofiscal';
  return out;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/* A Meta exige SHA-256 hex minúsculo, sobre o valor normalizado. Normalizar
   errado é pior que não mandar: hash de "  Fulano@Mail.com " não casa com
   nada e ainda conta como dado enviado. */
async function sha256(v: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const normEmail = (v: string) => v.trim().toLowerCase();

/* Telefone vai só com dígitos e COM código do país. Número brasileiro digitado
   no formulário vem sem o 55; sem ele a correspondência simplesmente não casa. */
function normFone(v: string): string {
  const d = (v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('55')) return d;
  if (d.length >= 10 && d.length <= 11) return '55' + d;
  return d;
}

async function enviarCapi(opts: {
  event_name: string;
  event_id?: string;
  event_source_url?: string;
  fbp?: string;
  fbc?: string;
  custom_data: Record<string, unknown>;
  email?: string;
  phone?: string;
  ip?: string;
  ua?: string;
  test_event_code?: string;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const TOKEN = Deno.env.get('META_ACCESS_TOKEN');
  if (!TOKEN) return { ok: false, status: 500, body: { error: 'meta_access_token_missing' } };

  const user_data: Record<string, unknown> = {};
  if (opts.fbp) user_data.fbp = opts.fbp;
  if (opts.fbc) user_data.fbc = opts.fbc;
  if (opts.ip)  user_data.client_ip_address = opts.ip;
  if (opts.ua)  user_data.client_user_agent = opts.ua;
  if (opts.email) user_data.em = [await sha256(normEmail(opts.email))];
  const fone = normFone(opts.phone || '');
  if (fone) user_data.ph = [await sha256(fone)];

  const payload: Record<string, unknown> = {
    data: [{
      event_name: opts.event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id: opts.event_id || undefined,
      event_source_url: opts.event_source_url || undefined,
      action_source: 'website',
      user_data,
      custom_data: opts.custom_data,
    }],
  };
  /* código de teste do Events Manager: quando presente, o evento aparece na
     aba "Testar eventos" em tempo real em vez de esperar os ~30min do Overview */
  if (opts.test_event_code) payload.test_event_code = opts.test_event_code;

  try {
    const res = await fetch(`${GRAPH}/${PIXEL_ID}/events?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) console.error('Meta CAPI recusou:', res.status, JSON.stringify(body));
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    console.error('Meta CAPI falhou na rede:', String(e));
    return { ok: false, status: 502, body: { error: String(e) } };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};

  /* 400 com esta mensagem exata é o teste de fumaça do plano: quem responde
     isso já passou do verify_jwt e já enxergou o token. */
  const event_name = String(body.event_name || '').trim();
  if (!event_name) return json({ error: 'event_name_required' }, 400);
  /* fora da lista volta antes de qualquer chamada à Meta; o nome vai ao log
     (sem dado pessoal) para os logs da função mostrarem quem ainda tenta. */
  if (!EVENTOS_PERMITIDOS.has(event_name)) {
    console.warn('meta-capi: evento recusado:', event_name.slice(0, 60));
    return json({ error: 'evento_nao_permitido' }, 400);
  }

  const nofiscal = EVENTOS_NOFISCAL.has(event_name);
  const event_id = body.event_id ? String(body.event_id) : undefined;
  if (nofiscal) {
    if (!origemDoSite(req.headers.get('origin'))) {
      console.warn('meta-capi: origem recusada para', event_name);
      return json({ error: 'origem_nao_permitida' }, 403);
    }
    if (!event_id || !EVENT_ID_NOFISCAL.test(event_id)) return json({ error: 'event_id_invalido' }, 400);
    /* action_source "website" exige a página; sem ela a Meta recusa o evento. */
    if (!paginaDoSite(body.event_source_url)) return json({ error: 'event_source_url_invalido' }, 400);
  }

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const ua = req.headers.get('user-agent') || '';

  const r = await enviarCapi({
    event_name,
    event_id,
    event_source_url: nofiscal
      ? paginaDoSite(body.event_source_url)
      : body.event_source_url ? String(body.event_source_url) : undefined,
    fbp:              body.fbp ? String(body.fbp) : undefined,
    fbc:              body.fbc ? String(body.fbc) : undefined,
    custom_data:      customData(event_name, body),
    email:            body.email ? String(body.email) : undefined,
    phone:            body.phone ? String(body.phone) : undefined,
    test_event_code:  body.test_event_code ? String(body.test_event_code) : undefined,
    ip, ua,
  });

  return json(r.body, r.ok ? 200 : r.status);
});
