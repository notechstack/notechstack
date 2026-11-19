// Webhook sandbox da conta (19/11/2026): a própria chave `nfk_test_…` cadastra a URL (`PUT /v1/sandbox/webhook`),
// separada da URL de produção do painel, e recebe o segredo `whsec_test_…` uma vez só. O segredo fica no Supabase
// Vault (`nofiscal.set_sandbox_webhook_secret`), como o de produção.
import type { Queryable } from '../db.js'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import { gerarSegredoWebhookSandbox } from '../parceiro/chave.js'
import { urlDeWebhook } from '../parceiro/painel-integracao.js'

type Ctx = { db: Queryable; donoId: string; agora: Date }

export async function webhookSandbox(ctx: Ctx): Promise<Response> {
  const { rows } = await ctx.db.query<{ url: string | null; tem: boolean }>(
    'select webhook_url as url, webhook_secret_vault_id is not null as tem from nofiscal.fiscal_sandbox_contas where dono_tenant_id = $1',
    [ctx.donoId],
  )
  return json(200, { ambiente: 'sandbox', webhook: { url: rows[0]?.url ?? null, tem_segredo: Boolean(rows[0]?.tem) } })
}

/**
 * `{ "url": "https://…" }` grava a URL; `{ "url": null }` tira. Sem segredo ainda (ou com `novo_segredo: true`), gera um
 * e devolve só nesta resposta.
 */
export async function salvarWebhookSandbox(ctx: Ctx, corpo: unknown): Promise<Response> {
  const b = (typeof corpo === 'object' && corpo !== null && !Array.isArray(corpo) ? corpo : {}) as Record<string, unknown>
  const extra = Object.keys(b).find((k) => k !== 'url' && k !== 'novo_segredo')
  if (extra) return errorResponse('UNKNOWN_FIELD', `campo não aceito: ${extra}`)
  if (b.url === null) {
    await ctx.db.query('update nofiscal.fiscal_sandbox_contas set webhook_url = null, updated_at = $2 where dono_tenant_id = $1', [ctx.donoId, ctx.agora])
    return json(200, { ambiente: 'sandbox', webhook: { url: null }, segredo: null })
  }
  const url = urlDeWebhook(b.url)
  if (!url) return errorResponse('VALIDATION_FAILED', 'Informe uma URL https pública (sem localhost nem IP interno).', { campo: 'url' })
  const { rows } = await ctx.db.query<{ tem: boolean }>(
    'select webhook_secret_vault_id is not null as tem from nofiscal.fiscal_sandbox_contas where dono_tenant_id = $1',
    [ctx.donoId],
  )
  await ctx.db.query('update nofiscal.fiscal_sandbox_contas set webhook_url = $2, updated_at = $3 where dono_tenant_id = $1', [ctx.donoId, url, ctx.agora])
  let segredo: string | null = null
  if (!rows[0]?.tem || b.novo_segredo === true) {
    segredo = gerarSegredoWebhookSandbox()
    await ctx.db.query('select nofiscal.set_sandbox_webhook_secret($1, $2)', [ctx.donoId, segredo])
  }
  logEvent('nofiscal.sandbox_webhook_salvo', { tenant_id: ctx.donoId, segredo_novo: Boolean(segredo) })
  return json(200, { ambiente: 'sandbox', webhook: { url, tem_segredo: true }, segredo })
}
