// Página do link rastreável /g/<token> (critério 16): o botão "Ver e copiar o código" do WhatsApp e o link do e-mail
// caem aqui. Mostra a linha digitável com botão de copiar e o PDF (por URL assinada de 2 minutos); abrir marca a guia
// como "baixada". O token tem 192 bits (HMAC do id com GUIAS_LINK_SEGREDO), só o sha256 dele fica no banco, e o link
// expira 60 dias depois do envio. A prévia de link do WhatsApp e robôs não marcam "baixada".
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { formatarLinha } from './codigos.js'
import { competenciaBr, dataBr, reaisSemSimbolo, ROTULO_DO_TIPO } from './modelos.js'
import type { TipoDeGuia } from './leitura.js'
import { hashDoToken } from './servico.js'
import type { ArmazemDeGuias } from './storage.js'

export type LinkDeps = { db: Queryable; storage: ArmazemDeGuias | null; now?: () => Date }

const TOKEN = /^[A-Za-z0-9_-]{32}$/
const ROBO = /whatsapp|facebookexternalhit|facebot|bot\b|crawler|spider|preview|slurp|curl\/|wget/i

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

const CABECALHOS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

function pagina(titulo: string, corpo: string, status = 200): Response {
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title><style>
:root{--tinta:#141414;--osso:#FAFAF7;--cinza:#5F636A;--borda:#E4E2DB;--ambar:#EDA33B}
*{box-sizing:border-box}body{margin:0;background:var(--osso);color:var(--tinta);font:400 16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 16px 48px}h1{font-size:22px;line-height:1.25;margin:0 0 6px}p{margin:0 0 12px}
.selo{display:inline-block;font:600 12px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--cinza);margin-bottom:12px}
.cartao{background:#fff;border:1px solid var(--borda);border-radius:16px;padding:16px;margin:16px 0}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0}dt{color:var(--cinza)}dd{margin:0;font-weight:600}
.linha{font:600 15px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;background:#FCF3E0;border-radius:10px;padding:10px 12px;margin:8px 0 12px}
.acoes{display:flex;flex-wrap:wrap;gap:10px}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:12px 20px;border-radius:999px;border:2px solid var(--tinta);background:var(--tinta);color:var(--osso);font:600 15px/1 system-ui,sans-serif;text-decoration:none;cursor:pointer}
.btn--borda{background:transparent;color:var(--tinta)}.btn:focus-visible{outline:3px solid var(--ambar);outline-offset:2px}.cinza{color:var(--cinza);font-size:14px}
</style></head><body><main>${corpo}</main></body></html>`
  return new Response(html, { status, headers: CABECALHOS })
}

const naoEncontrado = () =>
  pagina('Link indisponível', `<p class="selo">nó.fiscal · guias</p><h1>Este link não está mais disponível</h1><p>Ele pode ter expirado (vale 60 dias). Peça a guia de novo ao seu escritório de contabilidade.</p>`, 404)

type GuiaDoLink = {
  id: string; tipo: TipoDeGuia | null; competencia: string | null; valor_centavos: string | null; vencimento: string | null; linha_digitavel: string | null
  pdf_path: string; pdf_nome: string; empresa: string | null; escritorio: string
}

export async function handleLinkDaGuia(request: Request, deps: LinkDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const url = new URL(request.url)
  const token = url.searchParams.get('token') ?? url.pathname.split('/').pop() ?? ''
  if (!TOKEN.test(token)) return naoEncontrado()
  try {
    const agora = (deps.now ?? (() => new Date()))()
    const { rows } = await deps.db.query<GuiaDoLink>(
      `select g.id, g.tipo, to_char(g.competencia, 'YYYY-MM-DD') as competencia, g.valor_centavos::text, to_char(g.vencimento, 'YYYY-MM-DD') as vencimento,
              g.linha_digitavel, g.pdf_path, g.pdf_nome, c.nome as empresa, coalesce(r.assinatura, t.razao_social) as escritorio
         from nofiscal.guias g
         join nofiscal.fiscal_tenants t on t.id = g.escritorio_tenant_id
         left join nofiscal.guia_contatos c on c.id = g.contato_id
         left join nofiscal.guia_regras r on r.escritorio_tenant_id = g.escritorio_tenant_id
        where g.link_token_hash = $1 and g.link_expira_em > $2 and g.status <> 'cancelada'`,
      [hashDoToken(token), agora],
    )
    const g = rows[0]
    if (!g) return naoEncontrado()
    const robo = ROBO.test(request.headers.get('user-agent') ?? '')
    if (!robo && request.method === 'GET') {
      await deps.db.query(
        `update nofiscal.guias set baixada_em = coalesce(baixada_em, $2),
                status = case when nofiscal.guia_status_ordem(status) < nofiscal.guia_status_ordem('baixada') and status not in ('falhou', 'cancelada')
                              then 'baixada' else status end,
                updated_at = now()
          where id = $1`,
        [g.id, agora],
      )
    }
    if (url.searchParams.get('pdf') === '1') {
      if (!deps.storage) return naoEncontrado()
      const destino = await deps.storage.urlDeDownload(g.pdf_path, 120, g.pdf_nome)
      return new Response(null, { status: 302, headers: { location: destino, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
    }
    const tipo = g.tipo ? ROTULO_DO_TIPO[g.tipo] : 'de pagamento'
    const linha = g.linha_digitavel ? formatarLinha(g.linha_digitavel) : null
    return pagina(
      `Guia ${tipo}`,
      `<p class="selo">${esc(g.escritorio)}</p>
<h1>Guia ${esc(tipo)}${g.empresa ? ` de ${esc(g.empresa)}` : ''}</h1>
<div class="cartao"><dl>
${g.valor_centavos ? `<dt>Valor</dt><dd>R$ ${esc(reaisSemSimbolo(Number(g.valor_centavos)))}</dd>` : ''}
${g.vencimento ? `<dt>Vencimento</dt><dd>${esc(dataBr(g.vencimento))}</dd>` : ''}
${g.competencia ? `<dt>Competência</dt><dd>${esc(competenciaBr(g.competencia))}</dd>` : ''}
</dl></div>
${linha ? `<p><b>Linha digitável</b></p><p class="linha" id="linha">${esc(linha)}</p>` : ''}
<div class="acoes">
${linha ? `<button type="button" class="btn" id="copiar" data-codigo="${esc(g.linha_digitavel)}">Copiar código</button>` : ''}
<a class="btn btn--borda" href="?pdf=1" rel="noopener">Baixar o PDF</a>
</div>
<p class="cinza" id="aviso" role="status" aria-live="polite"></p>
<p class="cinza">Cole o código no app do seu banco, em "Pagar boleto" ou "Pagar conta/tributo". Dúvidas? Fale com ${esc(g.escritorio)}.</p>
<script>
(function(){var b=document.getElementById('copiar');if(!b)return;b.addEventListener('click',function(){var c=b.getAttribute('data-codigo');
function ok(){document.getElementById('aviso').textContent='Código copiado. Cole no app do banco.';}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(c).then(ok,function(){selecionar();});}else selecionar();
function selecionar(){var r=document.createRange();r.selectNodeContents(document.getElementById('linha'));var s=getSelection();s.removeAllRanges();s.addRange(r);document.getElementById('aviso').textContent='Selecionei o código: copie com o menu do celular.';}});})();
</script>`,
    )
  } catch (error) {
    logEvent('guias.link_erro', { error_name: error instanceof Error ? error.name : 'unknown' })
    return pagina('Tente de novo', `<h1>Não deu para abrir agora</h1><p>Tente de novo em alguns minutos.</p>`, 503)
  }
}
