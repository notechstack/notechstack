// Aba "API" do painel "Minha conta" (conta Escritório): chave da API do parceiro, webhook de retorno e a opção de
// desligar os e-mails de nota da nó (white label). Servida pela mesma função da aba Emitir (painel-emissao.ts), com a
// mesma sessão e a mesma conta-mãe. Chave e segredo são gerados aqui e voltam uma vez só na resposta; o banco guarda
// o sha256 da chave e o segredo vai ao Supabase Vault.
import { isIP } from 'node:net'
import type { Queryable } from '../db.js'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import { gerarChave, gerarSegredoWebhook } from './chave.js'
import { reenviarEntrega, testarWebhook, type FetchLike } from './webhook.js'

export const BASE_DA_API = 'https://app.notechstack.com.br/api'
export const DOCS_DA_API = 'https://www.notechstack.com.br/agentes/fiscal/dados/api/README.md'

export type IntegracaoCtx = { db: Queryable; donoId: string; agora: Date; fetch: FetchLike }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Faixas privadas, de loopback e de link-local (inclui o 169.254.169.254 dos metadados de nuvem). */
function ipInterno(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  const v = isIP(h)
  if (v === 4) {
    const [a, b] = h.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (v === 6) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:')
  return false
}

/** URL do webhook: https, porta padrão ou alta, sem usuário/senha, sem host interno. `null` se não serve. */
export function urlDeWebhook(valor: unknown): string | null {
  if (typeof valor !== 'string' || valor.length > 500) return null
  let u: URL
  try {
    u = new URL(valor.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  const host = u.hostname.toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || ipInterno(host)) return null
  if (!host.includes('.') && !isIP(host.replace(/^\[|\]$/g, ''))) return null
  u.hash = ''
  return u.toString()
}

export async function estadoDaIntegracao(ctx: IntegracaoCtx): Promise<Response> {
  const { rows } = await ctx.db.query<{
    prefixo: string | null
    gerada_em: Date | null
    webhook_url: string | null
    tem_segredo: boolean
    emails_da_no: boolean
    white_label: boolean
  }>(
    `select api_key_prefixo as prefixo, api_key_gerada_em as gerada_em, webhook_url,
            webhook_secret_vault_id is not null as tem_segredo, emails_da_no, white_label
       from nofiscal.fiscal_tenants where id = $1`,
    [ctx.donoId],
  )
  const t = rows[0]
  const entregas = await ctx.db.query<{
    id: string
    evento: string
    documento_id: string
    status: string
    tentativas: number
    ultimo_http: number | null
    ultimo_erro: string | null
    created_at: Date
    entregue_em: Date | null
    proxima_em: Date
  }>(
    `select id, evento, documento_id, status, tentativas, ultimo_http, ultimo_erro, created_at, entregue_em, proxima_em
       from nofiscal.fiscal_webhook_entregas where dono_tenant_id = $1
      order by created_at desc limit 20`,
    [ctx.donoId],
  )
  return json(200, {
    base_url: BASE_DA_API,
    docs_url: DOCS_DA_API,
    chave: t?.prefixo ? { prefixo: t.prefixo, gerada_em: t.gerada_em?.toISOString() ?? null } : null,
    webhook: { url: t?.webhook_url ?? null, tem_segredo: Boolean(t?.tem_segredo) },
    // Conta parceira: e-mail e WhatsApp de nota da nó desligados sempre (a caixa da tela fica travada).
    white_label: Boolean(t?.white_label),
    emails_da_no: t?.white_label ? false : (t?.emails_da_no ?? true),
    entregas: entregas.rows.map((e) => ({
      ...e,
      created_at: e.created_at.toISOString(),
      entregue_em: e.entregue_em?.toISOString() ?? null,
      proxima_em: e.status === 'pendente' ? e.proxima_em.toISOString() : null,
    })),
  })
}

/** Gera (ou troca) a chave da conta. A anterior para de funcionar na hora. A chave volta só nesta resposta. */
export async function gerarChaveDaConta(ctx: IntegracaoCtx): Promise<Response> {
  const nova = gerarChave()
  await ctx.db.query(
    'update nofiscal.fiscal_tenants set api_key_hash = $2, api_key_prefixo = $3, api_key_gerada_em = $4, updated_at = $4 where id = $1',
    [ctx.donoId, nova.hash, nova.prefixo, ctx.agora],
  )
  logEvent('nofiscal.api_chave_gerada', { tenant_id: ctx.donoId, prefixo: nova.prefixo })
  return json(200, { chave: nova.chave, prefixo: nova.prefixo, gerada_em: ctx.agora.toISOString() })
}

/**
 * Grava a URL do webhook. Sem segredo ainda (ou com `novo_segredo: true`), gera um e devolve só nesta resposta; com
 * segredo, mantém o atual (o sistema do parceiro não precisa trocar nada ao mudar a URL).
 */
export async function salvarWebhook(ctx: IntegracaoCtx, b: Record<string, unknown>): Promise<Response> {
  const url = urlDeWebhook(b.url)
  if (!url) return errorResponse('VALIDATION_FAILED', 'Informe uma URL https pública (sem localhost nem IP interno).', { campo: 'webhook_url' })
  const { rows } = await ctx.db.query<{ tem: boolean }>('select webhook_secret_vault_id is not null as tem from nofiscal.fiscal_tenants where id = $1', [ctx.donoId])
  await ctx.db.query('update nofiscal.fiscal_tenants set webhook_url = $2, updated_at = $3 where id = $1', [ctx.donoId, url, ctx.agora])
  let segredo: string | null = null
  if (!rows[0]?.tem || b.novo_segredo === true) {
    segredo = gerarSegredoWebhook()
    await ctx.db.query('select nofiscal.set_webhook_secret($1, $2)', [ctx.donoId, segredo])
  }
  logEvent('nofiscal.api_webhook_salvo', { tenant_id: ctx.donoId, segredo_novo: Boolean(segredo) })
  return json(200, { webhook: { url, tem_segredo: true }, segredo })
}

/** Tira a URL: os eventos deixam de ser gravados; os pendentes desistem na próxima rodada. O segredo fica no Vault. */
export async function removerWebhook(ctx: IntegracaoCtx): Promise<Response> {
  await ctx.db.query('update nofiscal.fiscal_tenants set webhook_url = null, updated_at = $2 where id = $1', [ctx.donoId, ctx.agora])
  logEvent('nofiscal.api_webhook_removido', { tenant_id: ctx.donoId })
  return json(200, { webhook: { url: null } })
}

export async function testarWebhookDaConta(ctx: IntegracaoCtx): Promise<Response> {
  const r = await testarWebhook(ctx.db, ctx.fetch, ctx.donoId, ctx.agora)
  return json(200, r.ok ? { ok: true, http: r.http } : { ok: false, http: r.http, erro: r.erro })
}

export async function reenviarDaConta(ctx: IntegracaoCtx, b: Record<string, unknown>): Promise<Response> {
  const id = typeof b.entrega_id === 'string' ? b.entrega_id : ''
  if (!UUID.test(id) || !(await reenviarEntrega(ctx.db, ctx.donoId, id, ctx.agora))) return errorResponse('NOT_FOUND', 'Entrega não encontrada.')
  return json(200, { reenviando: true })
}

/** White label: `ativo = false` desliga os e-mails de nota emitida/cancelada que a nó manda (o parceiro entrega). */
export async function emailsDaNo(ctx: IntegracaoCtx, b: Record<string, unknown>): Promise<Response> {
  if (typeof b.ativo !== 'boolean') return errorResponse('VALIDATION_FAILED', 'ativo deve ser true ou false', { campo: 'ativo' })
  await ctx.db.query('update nofiscal.fiscal_tenants set emails_da_no = $2, updated_at = $3 where id = $1', [ctx.donoId, b.ativo, ctx.agora])
  logEvent('nofiscal.api_emails_da_no', { tenant_id: ctx.donoId, ativo: b.ativo })
  return json(200, { emails_da_no: b.ativo })
}
