/* Recebe os leads das LPs e faz três coisas: grava em `leads`, notifica por
   e-mail via Resend e manda o `Lead` para o Meta CAPI.

   ORDEM IMPORTA: grava PRIMEIRO, notifica depois. Uma versão antiga fazia o
   contrário, então um erro de rede no fetch da Resend caía no catch e o lead
   nunca chegava ao banco — perdia-se o contato por causa do e-mail.

   E O ERRO PRECISA APARECER: outra versão fazia `await res.json()` e só
   logava, sem olhar `res.ok`. Qualquer recusa da Resend (chave inválida,
   domínio não verificado, remetente errado) virava sucesso silencioso: a
   função devolvia 200 com {success:true} e o formulário dizia "enviado".
   O resultado do envio volta no corpo da resposta (`emailSent` / `emailError`)
   e vai para console.error, para o erro ser visível no log.

   ══ v2 · 14/08/2026 — bloco C do PLANO-rastreio.md ══

   1. ACABOU O CONTRATO DE OITO CAMPOS. Esta function desestruturava oito
      chaves fixas e descartava o resto em silêncio — foi assim que o `path`
      que a lp-v4 mandava desde sempre nunca chegou ao banco nem ao e-mail, e
      por isso a lp-v5 empacotava site e descrição dentro do `aiAnalysis`.
      Agora cada coisa tem coluna própria. O empacotamento continua sendo
      aceito: as LPs antigas (Roteador, lp-v3, lp-v4) mandam como sempre
      mandaram e nada quebra.

   2. O LEAD SAI TAMBÉM PELO SERVIDOR. O pixel do navegador perde de 15% a 30%
      dos eventos para bloqueador. Aqui o evento não passa pelo navegador — e
      é MELHOR que o do navegador, porque a esta altura a gente tem e-mail e
      telefone da pessoa: com `em` e `ph` hasheados, a correspondência sobe de
      fraca para boa, que é o que faz a Meta conseguir otimizar. O `event_id`
      é o `sid` da sessão, o mesmo que a tag do pixel manda no `eventID`: a
      Meta descarta a duplicata e fica com a versão mais rica.

   3. O LEAD APONTA PARA O PERCURSO. Com `sid` no payload, a RPC `marcar_lead`
      liga a linha do lead à sessão que o produziu — é o que faz o painel
      mostrar a jornada e o contato como uma coisa só.

   SELF-CONTAINED de propósito: nada de `../_shared`. Já quebrou deploy nesta
   organização, e o custo de repetir o CORS e as ~40 linhas do CAPI é menor que
   o de uma function que não sobe. */

const PIXEL_ID = '1753619075655271';          // portfólio 990413650211777
const GRAPH    = 'https://graph.facebook.com/v21.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const txt = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : ''
  return s ? s : null
}

/* ── Meta CAPI ───────────────────────────────────────────────────────────── */

async function sha256(v: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/* Código do país tanto no CAPI quanto no link do e-mail. Números nacionais
   têm 10/11 dígitos, inclusive os de DDD 55; com + o DDI já é explícito. */
function normFone(v: string): string {
  const d = (v || '').replace(/\D/g, '')
  if (!d) return ''
  if ((v || '').trim().startsWith('+')) return d
  if (d.length >= 10 && d.length <= 11) return '55' + d
  return d
}

/* Lista de teste: LEAD_TEST_EMAILS, e-mails separados por vírgula. Nenhum
   e-mail fixo aqui. Comparação sem espaços e sem caixa. */
function emailDeTeste(email: string | null): boolean {
  const alvo = (email || '').trim().toLowerCase()
  if (!alvo) return false
  return (Deno.env.get('LEAD_TEST_EMAILS') || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    .includes(alvo)
}

/* Lead de teste só vai ao CAPI com test_event_code (META_TEST_EVENT_CODE):
   aparece em "Eventos de teste" e não conta no pixel. Sem o código, nem
   manda — `teste_sem_codigo`. Com o código, o status ganha prefixo
   `teste_` (teste_ok_1, teste_erro_400…) para não se confundir com lead real. */
async function mandarLeadCapi(o: {
  sid: string | null, email: string | null, fone: string | null,
  fbp: string | null, fbc: string | null, valor: number,
  url: string | null, ip: string, ua: string, teste: boolean,
}): Promise<string> {
  const CODIGO_TESTE = o.teste ? txt(Deno.env.get('META_TEST_EVENT_CODE')) : null
  if (o.teste && !CODIGO_TESTE) return 'teste_sem_codigo'
  const pre = o.teste ? 'teste_' : ''

  const TOKEN = Deno.env.get('META_ACCESS_TOKEN')
  if (!TOKEN) return 'sem_token'

  const user_data: Record<string, unknown> = {}
  if (o.fbp) user_data.fbp = o.fbp
  if (o.fbc) user_data.fbc = o.fbc
  if (o.ip)  user_data.client_ip_address = o.ip
  if (o.ua)  user_data.client_user_agent = o.ua
  if (o.email) user_data.em = [await sha256(o.email.toLowerCase())]
  const fone = normFone(o.fone || '')
  if (fone) user_data.ph = [await sha256(fone)]

  try {
    const res = await fetch(`${GRAPH}/${PIXEL_ID}/events?access_token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          /* mesmo id da tag do pixel → a Meta deduplica sozinha */
          event_id: o.sid || undefined,
          event_source_url: o.url || undefined,
          action_source: 'website',
          user_data,
          /* SÓ value e currency. Sem content_* — quatro das dezenove folhas da
             árvore são saúde, e categoria de saúde em evento Meta é violação
             de política. Cortar de todos custa nada. */
          custom_data: { value: o.valor, currency: 'BRL' },
        }],
        /* raiz do corpo, junto de `data` — é onde a Graph API lê */
        test_event_code: CODIGO_TESTE || undefined,
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('Meta CAPI recusou o Lead:', res.status, JSON.stringify(body))
      return `${pre}erro_${res.status}`
    }
    return `${pre}ok_${body?.events_received ?? 0}`
  } catch (e) {
    console.error('Meta CAPI falhou na rede:', String(e))
    return `${pre}erro_rede`
  }
}

/* ── handler ─────────────────────────────────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  if (req.method === 'GET' && new URL(req.url).searchParams.has('capabilities')) return json({attachments:true})
  try {
    const raw=await req.text()
    if(raw.length>7200000)return json({success:false,error:'Arquivos excedem o limite.'},413)
    const b = JSON.parse(raw)
    const attachments: {filename:string,content:string}[]=[]
    if(b.attachments!==undefined){
      if(!Array.isArray(b.attachments)||b.attachments.length>5)return json({success:false,error:'Até 5 arquivos.'},400)
      let total=0
      for(const file of b.attachments){
        if(typeof file?.filename!=='string'||typeof file?.content!=='string'||!/^.{1,180}\.(pdf|png|jpe?g|webp|txt|csv|docx|xlsx|pptx)$/i.test(file.filename)||/[\\/\r\n]/.test(file.filename)||!file.content.length||file.content.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(file.content))return json({success:false,error:'Arquivo inválido.'},400)
        try{total+=atob(file.content).length}catch{return json({success:false,error:'Arquivo inválido.'},400)}
        if(total>5*1024*1024)return json({success:false,error:'Limite de 5 MB.'},413)
        attachments.push({filename:file.filename,content:file.content})
      }
    }

    /* os oito de sempre — as LPs antigas dependem destes nomes */
    const nome         = txt(b.nome)
    const email        = txt(b.email)
    const whatsapp     = txt(b.whatsapp)
    const contexto     = txt(b.contexto)
    const objetivos    = txt(b.objetivos)
    const investimento = txt(b.investimento)
    const prazo        = txt(b.prazo)
    const aiAnalysis   = txt(b.aiAnalysis)

    /* os novos — ausentes nas LPs antigas, e é por isso que tudo é opcional.
       `caminho` cai de volta em `objetivos`, que era o slot emprestado. */
    const sid       = txt(b.sid)
    const site      = txt(b.site)
    const descricao = txt(b.descricao)
    const folha     = txt(b.folha)
    const nicho     = txt(b.nicho)
    const caminho   = txt(b.caminho) ?? objetivos
    const modo      = txt(b.modo)
    const o         = (b.origem && typeof b.origem === 'object') ? b.origem : b
    const fbp       = txt(b.fbp)
    const fbc       = txt(b.fbc)
    const valor     = typeof b.valor === 'number' ? b.valor : 1
    const pagina    = txt(b.event_source_url) ?? txt(req.headers.get('referer'))

    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    const ua = req.headers.get('user-agent') || ''

    /* Leads do Roteador vão pra caixa própria; demais contextos seguem pra nó. */
    const isRoteador = (contexto || '').toLowerCase().includes('roteador')
    const TO_EMAIL   = isRoteador ? 'roteadortelemed@gmail.com' : 'notechstack@gmail.com'
    const FROM_NAME  = isRoteador ? 'Roteador' : 'nó tech stack'

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://sdeowbqmwkwseyktyemn.supabase.co'
    const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''

    /* ── 1. Persistir o lead ───────────────────────────────────────────── */
    let saved = false
    let saveError: string | null = null
    let leadId: string | null = null

    if (!SUPABASE_KEY) {
      saveError = 'SUPABASE_SERVICE_ROLE_KEY ausente nos secrets da function'
    } else {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            /* representation e não minimal: o id é o que liga o lead à sessão
               e o que volta pro front poder conferir */
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            nome, email, whatsapp, contexto, objetivos, investimento, prazo,
            ai_analysis: aiAnalysis,
            sid, site, descricao, folha, nicho, caminho, modo,
            utm_source:   txt(o.utm_source),
            utm_medium:   txt(o.utm_medium),
            utm_campaign: txt(o.utm_campaign),
            utm_content:  txt(o.utm_content),
            utm_term:     txt(o.utm_term),
            gclid:        txt(o.gclid),
            fbclid:       txt(o.fbclid),
            referrer:     txt(o.referrer),
            fbp, fbc,
          }),
        })
        saved = r.ok
        if (r.ok) {
          const rows = await r.json().catch(() => [])
          leadId = Array.isArray(rows) && rows[0]?.id ? rows[0].id : null
        } else {
          saveError = `Postgrest ${r.status}: ${await r.text()}`
        }
      } catch (e) {
        saveError = String(e)
      }
    }
    if (saveError) console.error('Falha ao gravar lead:', saveError)

    /* ── 1b. Lead da lista de teste já entra classificado ──────────────── */
    /* Mesmo mecanismo do hub: linha aditiva em `lead_classificacao`; a classe
       vigente é a mais recente, então o hub ainda pode reclassificar. */
    const teste = emailDeTeste(email)
    if (teste && leadId && SUPABASE_KEY) {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/lead_classificacao`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({
            lead_id: leadId, classe: 'teste',
            motivo: 'e-mail na LEAD_TEST_EMAILS', papel: 'send-lead-email',
          }),
        })
        if (!r.ok) console.error('Falha ao classificar lead de teste:', r.status, await r.text())
      } catch (e) {
        /* o lead já está gravado; a classe pode ser dada no hub depois */
        console.error('Falha ao classificar lead de teste:', String(e))
      }
    }

    /* ── 2. Costurar com o percurso ────────────────────────────────────── */
    if (sid && SUPABASE_KEY) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/rpc/marcar_lead`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
          },
          body: JSON.stringify({ p_sid: sid, p_lead_id: leadId }),
        })
      } catch (e) {
        /* não é motivo pra falhar o lead: o contato já está gravado, só o
           percurso fica sem a marca de conversão */
        console.error('marcar_lead falhou:', String(e))
      }
    }

    /* ── 3. Meta CAPI ──────────────────────────────────────────────────── */
    /* Página com aviso de cookies (lista de espera do /agentes/auditor/) manda
       `consent`; recusado, nada vai à Meta. Sem o campo (demais LPs), segue
       como sempre. */
    const capiStatus = b.consent === 'denied' ? 'sem_consentimento' : await mandarLeadCapi({
      sid, email, fone: whatsapp, fbp, fbc, valor, url: pagina, ip, ua, teste,
    })
    if (leadId && SUPABASE_KEY && capiStatus !== 'sem_token') {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/leads?id=eq.${leadId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify({ capi_status: capiStatus }),
        })
      } catch { /* auditoria; não vale derrubar o lead por isso */ }
    }

    /* ── 4. Notificar por e-mail ───────────────────────────────────────── */
    const linha = (rot: string, val: string | null) =>
      val ? `<tr><td style="padding:8px 0;font-weight:700;color:#5f6368;width:150px">${rot}</td><td style="padding:8px 0;color:#1a1a1a">${val}</td></tr>` : ''

    const whatsappFone = normFone(whatsapp || '')
    const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#4285F4;padding:24px;border-radius:12px 12px 0 0">
    <h1 style="color:#fff;margin:0;font-size:22px">🚀 Novo Lead — nó tech stack</h1>
  </div>
  <div style="background:#f8f9fa;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e3e6ea">
    <h2 style="color:#1a1a1a;margin-top:0">Dados do Lead</h2>
    <table style="width:100%;border-collapse:collapse">
      ${linha('Nome', nome)}
      <tr><td style="padding:8px 0;font-weight:700;color:#5f6368">E-mail</td><td style="padding:8px 0"><a href="mailto:${email ?? ''}" style="color:#4285F4">${email ?? '—'}</a></td></tr>
      ${linha('WhatsApp', whatsapp)}
      ${linha('Contexto', contexto)}
      ${linha('Caminho na árvore', caminho)}
      ${linha('Site', site)}
      ${linha('Quando quer começar', prazo)}
      ${linha('Investimento', investimento)}
      ${linha('Origem', txt(o.utm_campaign) ?? txt(o.utm_source) ?? txt(o.referrer))}
    </table>
    ${descricao ? `<div style="margin-top:20px;padding:16px;background:#fff;border-radius:8px;border-left:4px solid #EDA33B"><h3 style="margin-top:0;color:#B0731A">O que ele contou</h3><p style="color:#1a1a1a;white-space:pre-wrap;margin:0">${descricao}</p></div>` : ''}
    ${aiAnalysis ? `<div style="margin-top:16px;padding:16px;background:#e8f0fe;border-radius:8px;border-left:4px solid #4285F4"><h3 style="margin-top:0;color:#4285F4">✦ Leitura da nó</h3><p style="color:#1a1a1a;white-space:pre-wrap;margin:0">${aiAnalysis}</p></div>` : ''}
    ${whatsappFone ? `<div style="margin-top:24px;padding:12px;background:#fff;border-radius:8px;text-align:center">
      <a href="https://wa.me/${whatsappFone}" style="background:#25D366;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">💬 Responder no WhatsApp</a>
    </div>` : ''}
    ${sid ? `<p style="color:#9aa0a6;font-size:11px;margin:16px 0 0;font-family:monospace">sid ${sid}</p>` : ''}
  </div>
</div>`

    let emailSent = false
    let emailError: string | null = null
    let emailId: string | null = null
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')

    if (!RESEND_API_KEY) {
      emailError = 'RESEND_API_KEY ausente nos secrets da function'
    } else {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify({
            /* Domínio notechstack.com.br verificado na Resend. */
            from: `${FROM_NAME} <leads@notechstack.com.br>`,
            to: [TO_EMAIL],
            /* Responder no e-mail cai direto no lead, não na nó. */
            reply_to: email || undefined,
            subject: `🚀 Novo lead: ${nome ?? 'sem nome'} — ${contexto || 'sem contexto'}`,
            html: htmlBody,
            attachments: attachments.length ? attachments : undefined,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (res.ok) {
          emailSent = true
          emailId = data?.id ?? null
        } else {
          emailError = `Resend ${res.status}: ${JSON.stringify(data)}`
        }
      } catch (e) {
        emailError = String(e)
      }
    }
    if (emailError) console.error('Falha ao enviar e-mail do lead:', emailError)

    /* 200 mesmo com e-mail falho: o lead já está gravado e o visitante não tem
       o que fazer com esse erro. Quem precisa vê-lo é o log e o front. */
    return json({ success: saved || emailSent, saved, saveError, leadId, emailSent, emailId, emailError, capiStatus, attachmentsSent:emailSent ? attachments.length : 0 })
  } catch (err) {
    console.error(err)
    return json({ success: false, error: String(err) }, 500)
  }
})
