// Sandbox da API do parceiro (19/11/2026): a chave `nfk_test_…` passa pela mesma validação da produção
// (`parseNewInvoice`, retenção, `buildDps` para pegar erro de leiaute) e grava em `nofiscal.fiscal_sandbox_invoices`,
// que o motor nunca lê. Nada aqui fala com a Sefin, abre certificado, aloca número em `fiscal_dps_series` ou grava em
// `fiscal_invoices`: a nota não consome franquia, não aparece no painel nem nos relatórios.
//
// O status avança por simulação, alguns segundos depois do pedido (`ATRASO_MS`), em duas vias: a rodada agendada pela
// própria função depois de responder (`waitUntil` da Vercel) e a rodada preguiçosa que toda chamada sandbox faz antes
// de responder. Chave de acesso e XML saem do simulador (`sefin-simulada.ts`), em produção restrita (tpAmb 2): o
// DANFSe vem com a tarja "NFS-e SEM VALIDADE JURÍDICA".
//
// Valores mágicos (documentados no README da API, seção Sandbox):
//   valor 1.11 → a Sefin recusa a nota (E0718, assinatura sem o certificado do emitente / procuração não achada);
//   valor 2.22 → a Sefin fica fora do ar por ~1 min (SEFIN_UNAVAILABLE na fila) e depois a nota sai;
//   valor 3.33 → a nota sai, mas o cancelamento é recusado.
import type { Db, Queryable } from '../db.js'
import { buildDps, DpsInvalidError, formatDhSaoPaulo, opcoesDpsDoAmbiente } from '../dps-builder.js'
import { logEvent } from '../log.js'
import { municipio } from '../local-prestacao.js'
import type { SefinTenant } from '../sefin.js'
import { corpoDoEvento, postar, type FetchLike } from '../parceiro/webhook.js'
import { chaveSimulada, nfseSimulada } from './sefin-simulada.js'

/** Quanto a "Sefin" simulada leva para responder. */
export const ATRASO_MS = 3_000
/** Quanto a "Sefin" fica fora do ar no roteiro `sefin_fora`. */
export const SEFIN_FORA_MS = 60_000
/** Série da DPS no sandbox: a última da faixa de aplicativo próprio (E0010), longe da série real das empresas. */
export const SERIE_SANDBOX = '49999'

export type Roteiro = 'emitir' | 'recusar' | 'sefin_fora' | 'cancelamento_recusado' | 'dps_invalida' | 'tributos'

export const VALORES_MAGICOS: Readonly<Record<string, Roteiro>> = {
  '1.11': 'recusar',
  '2.22': 'sefin_fora',
  '3.33': 'cancelamento_recusado',
}

export const RECUSA_SIMULADA = {
  codigo: 'E0718',
  mensagem: 'A assinatura deve ser feita com o certificado digital do emitente (simulado no sandbox).',
} as const
export const CANCELAMENTO_RECUSADO_SIMULADO = {
  codigo: 'SANDBOX_CANCELAMENTO_RECUSADO',
  mensagem: 'A Sefin recusou o cancelamento (simulado no sandbox: valor 3.33).',
} as const

export type VisaoSandbox = {
  id: string
  external_id: string
  status: string
  cnpj_prestador: string
  numero: string | null
  numero_dps: string | null
  chave_acesso: string | null
  valor: string | null
  tomador_documento: string | null
  last_error_code: string | null
  last_error: string | null
  origem: 'api'
  ambiente: 'sandbox'
  criada_em: string
  emitida_em: string | null
  cancelada_em: string | null
}

type Linha = {
  id: string
  dono_tenant_id: string
  tenant_id: string
  external_id: string
  status: string
  roteiro: Roteiro
  cnpj: string
  dps_numero: string
  xml_dps: string | null
  chave_acesso: string | null
  xml_nfse: string | null
  payload: { valor?: unknown; tomador?: { cpf?: string; cnpj?: string } } | null
  last_error_code: string | null
  last_error: string | null
  erro_previsto: string | null
  created_at: Date
  issued_at: Date | null
  cancelled_at: Date | null
}

const SELECT = `select s.id, s.dono_tenant_id, s.tenant_id, s.external_id, s.status, s.roteiro, t.cnpj, s.dps_numero::text as dps_numero,
                       s.xml_dps, s.chave_acesso, s.xml_nfse, s.payload, s.last_error_code, s.last_error, s.erro_previsto,
                       s.created_at, s.issued_at, s.cancelled_at
                  from nofiscal.fiscal_sandbox_invoices s
                  join nofiscal.fiscal_tenants t on t.id = s.tenant_id`

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const COM_NUMERO = ['issued', 'cancel_requested', 'cancelled']

function visao(r: Linha): VisaoSandbox {
  const tomador = r.payload?.tomador
  return {
    id: r.id,
    external_id: r.external_id,
    status: r.status,
    cnpj_prestador: r.cnpj,
    numero: COM_NUMERO.includes(r.status) && r.xml_nfse ? r.dps_numero : null,
    numero_dps: r.dps_numero,
    chave_acesso: r.chave_acesso,
    valor: typeof r.payload?.valor === 'string' ? r.payload.valor : null,
    tomador_documento: tomador?.cpf ?? tomador?.cnpj ?? null,
    last_error_code: r.last_error_code,
    last_error: r.last_error,
    origem: 'api',
    ambiente: 'sandbox',
    criada_em: r.created_at.toISOString(),
    emitida_em: iso(r.issued_at),
    cancelada_em: iso(r.cancelled_at),
  }
}

function semXml(nota: VisaoSandbox & { xml_nfse: string | null }): VisaoSandbox {
  const v: Partial<typeof nota> = { ...nota }
  delete v.xml_nfse
  return v as VisaoSandbox
}

/** Nota sandbox da conta dona da chave; nunca de outra conta. */
export async function notaSandbox(db: Queryable, donoId: string, id: string): Promise<(VisaoSandbox & { xml_nfse: string | null }) | null> {
  const { rows } = await db.query<Linha>(`${SELECT} where s.id = $1 and s.dono_tenant_id = $2`, [id, donoId])
  return rows[0] ? { ...visao(rows[0]), xml_nfse: rows[0].xml_nfse } : null
}

export async function notaSandboxPorExternalId(db: Queryable, donoId: string, tenantId: string, externalId: string): Promise<VisaoSandbox | null> {
  const { rows } = await db.query<Linha>(`${SELECT} where s.dono_tenant_id = $1 and s.tenant_id = $2 and s.external_id = $3`, [
    donoId,
    tenantId,
    externalId,
  ])
  return rows[0] ? visao(rows[0]) : null
}

type EmpresaDaDps = SefinTenant & { razao_social: string }

async function empresaDaDps(db: Queryable, tenantId: string): Promise<EmpresaDaDps> {
  const { rows } = await db.query<EmpresaDaDps>(
    `select id, cnpj, razao_social, inscricao_municipal, codigo_municipio_ibge, regime, ambiente, p_tot_trib_sn::text as p_tot_trib_sn, nbs_padrao
       from nofiscal.fiscal_tenants where id = $1`,
    [tenantId],
  )
  if (!rows[0]) throw new Error('empresa do sandbox não encontrada')
  return rows[0]
}

/** A DPS que o worker montaria para esta nota, sem assinatura, em produção restrita. */
function montarDps(empresa: EmpresaDaDps, numero: number, payload: unknown, agora: Date): { ok: true; id: string; xml: string } | { ok: false; erro: string } {
  try {
    // O leiaute é o do ambiente real da empresa (o que vai valer na produção); o tpAmb é sempre 2.
    const dps = buildDps({
      tenant: { ...empresa, ambiente: 'producao_restrita' },
      serie: SERIE_SANDBOX,
      numero,
      payload,
      now: agora,
      opcoes: opcoesDpsDoAmbiente(empresa),
    })
    return { ok: true, id: dps.id, xml: dps.xml }
  } catch (error) {
    if (error instanceof DpsInvalidError) return { ok: false, erro: error.message }
    throw error
  }
}

export type NovaNotaSandbox = { donoId: string; tenantId: string; externalId: string; payload: unknown; valor: string; agora: Date }

/** Grava a nota sandbox (ou devolve a que já existe com o mesmo external_id na empresa). */
export async function criarNotaSandbox(db: Db, nova: NovaNotaSandbox): Promise<{ visao: VisaoSandbox; jaExistia: boolean }> {
  const empresa = await empresaDaDps(db, nova.tenantId)
  return db.transaction(async (tx) => {
    // Numeração própria do sandbox, por empresa: a trava serializa dois POST da mesma empresa.
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`sandbox:${nova.tenantId}`])
    const existente = await notaSandboxPorExternalId(tx, nova.donoId, nova.tenantId, nova.externalId)
    if (existente) return { visao: existente, jaExistia: true }
    const { rows } = await tx.query<{ n: string }>(
      'select coalesce(max(dps_numero), 0) + 1 as n from nofiscal.fiscal_sandbox_invoices where tenant_id = $1',
      [nova.tenantId],
    )
    const numero = Number(rows[0].n)
    const dps = montarDps(empresa, numero, nova.payload, nova.agora)
    let roteiro: Roteiro = VALORES_MAGICOS[nova.valor] ?? 'emitir'
    if (!dps.ok) roteiro = 'dps_invalida'
    // Sem o percentual do Simples, o worker deixa a nota na fila (TRIBUTOS_NOT_CONFIGURED); o sandbox também.
    if (dps.ok && empresa.p_tot_trib_sn === null && empresa.regime !== 'mei') roteiro = 'tributos'
    const inserida = await tx.query<{ id: string }>(
      `insert into nofiscal.fiscal_sandbox_invoices
         (dono_tenant_id, tenant_id, external_id, payload, roteiro, avanca_em, dps_numero, id_dps, xml_dps, erro_previsto,
          last_error_code, last_error)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
       returning id`,
      [
        nova.donoId,
        nova.tenantId,
        nova.externalId,
        JSON.stringify(nova.payload),
        roteiro,
        new Date(nova.agora.getTime() + ATRASO_MS),
        numero,
        dps.ok ? dps.id : null,
        dps.ok ? dps.xml : null,
        dps.ok ? null : dps.erro,
        roteiro === 'tributos' ? 'TRIBUTOS_NOT_CONFIGURED' : null,
        null,
      ],
    )
    logEvent('nofiscal.sandbox_nfse_criada', { tenant_id: nova.tenantId, invoice_id: inserida.rows[0].id, roteiro })
    const nota = await notaSandbox(tx, nova.donoId, inserida.rows[0].id)
    if (!nota) throw new Error('nota sandbox sumiu')
    return { visao: semXml(nota), jaExistia: false }
  })
}

/** Pedido de cancelamento: como o `requestCancel` do motor (na fila vira `skipped`; emitida vira `cancel_requested`). */
export async function cancelarNotaSandbox(db: Queryable, donoId: string, id: string, agora: Date): Promise<VisaoSandbox | null> {
  await db.query(
    `update nofiscal.fiscal_sandbox_invoices
        set status = case status when 'queued' then 'skipped' else 'cancel_requested' end,
            last_error_code = null,
            last_error = case status when 'queued' then 'Cancelada antes da transmissão' else null end,
            avanca_em = $3, updated_at = $4
      where id = $1 and dono_tenant_id = $2 and status in ('queued', 'issued')`,
    [id, donoId, new Date(agora.getTime() + ATRASO_MS), agora],
  )
  const nota = await notaSandbox(db, donoId, id)
  return nota ? semXml(nota) : null
}

// ---------------------------------------------------------------------------------------
// Simulação: a "Sefin" responde.

const EVENTOS = {
  issued: 'nfse.emitida',
  rejected: 'nfse.recusada',
  cancelled: 'nfse.cancelada',
  cancel_refused: 'nfse.cancelamento_recusado',
} as const

async function enfileirarEvento(db: Queryable, donoId: string, id: string, evento: string): Promise<void> {
  const { rows } = await db.query<{ url: string | null }>('select webhook_url as url from nofiscal.fiscal_sandbox_contas where dono_tenant_id = $1', [donoId])
  if (!rows[0]?.url) return
  const nota = await notaSandbox(db, donoId, id)
  if (!nota) return
  const dados = semXml(nota)
  await db.query(
    `insert into nofiscal.fiscal_sandbox_webhook_entregas (dono_tenant_id, documento_id, evento, dados)
     values ($1, $2, $3, $4::jsonb) on conflict (documento_id, evento) do nothing`,
    [donoId, id, evento, JSON.stringify(dados)],
  )
}

async function emitir(tx: Queryable, r: Linha, agora: Date): Promise<void> {
  const empresa = await empresaDaDps(tx, r.tenant_id)
  const lugar = municipio(empresa.codigo_municipio_ibge)
  const nNFSe = Number(r.dps_numero)
  const chave = chaveSimulada(r.xml_dps ?? '', nNFSe)
  const xml = nfseSimulada({
    dpsXml: r.xml_dps ?? '',
    chave,
    nNFSe,
    dhProc: formatDhSaoPaulo(agora),
    emitente: { nome: empresa.razao_social, municipio: lugar?.nome ?? empresa.codigo_municipio_ibge, codigoMunicipio: empresa.codigo_municipio_ibge, uf: lugar?.uf ?? 'SP' },
  })
  await tx.query(
    `update nofiscal.fiscal_sandbox_invoices
        set status = 'issued', chave_acesso = $2, xml_nfse = $3, issued_at = $4, last_error_code = null, last_error = null, updated_at = $4
      where id = $1`,
    [r.id, chave, xml, agora],
  )
  await enfileirarEvento(tx, r.dono_tenant_id, r.id, EVENTOS.issued)
}

async function recusar(tx: Queryable, r: Linha, agora: Date, codigo: string, mensagem: string): Promise<void> {
  await tx.query(
    `update nofiscal.fiscal_sandbox_invoices set status = 'rejected', last_error_code = $2, last_error = $3, updated_at = $4 where id = $1`,
    [r.id, codigo, mensagem, agora],
  )
  await enfileirarEvento(tx, r.dono_tenant_id, r.id, EVENTOS.rejected)
}

async function avancarUma(tx: Queryable, r: Linha, agora: Date): Promise<void> {
  if (r.status === 'queued') {
    if (r.roteiro === 'recusar') return recusar(tx, r, agora, RECUSA_SIMULADA.codigo, RECUSA_SIMULADA.mensagem)
    if (r.roteiro === 'dps_invalida') return recusar(tx, r, agora, 'DPS_INVALID', r.erro_previsto ?? 'DPS inválida')
    if (r.roteiro === 'sefin_fora' && r.last_error_code !== 'SEFIN_UNAVAILABLE') {
      await tx.query(
        `update nofiscal.fiscal_sandbox_invoices
            set last_error_code = 'SEFIN_UNAVAILABLE', last_error = 'Sefin Nacional fora do ar (simulado no sandbox: valor 2.22)',
                avanca_em = $2, updated_at = $3
          where id = $1`,
        [r.id, new Date(agora.getTime() + SEFIN_FORA_MS), agora],
      )
      return
    }
    return emitir(tx, r, agora)
  }
  // cancel_requested
  if (r.roteiro === 'cancelamento_recusado') {
    // Como no motor: a nota fica em cancel_requested, com o motivo da recusa.
    await tx.query(
      `update nofiscal.fiscal_sandbox_invoices set last_error_code = $2, last_error = $3, updated_at = $4 where id = $1`,
      [r.id, CANCELAMENTO_RECUSADO_SIMULADO.codigo, CANCELAMENTO_RECUSADO_SIMULADO.mensagem, agora],
    )
    return enfileirarEvento(tx, r.dono_tenant_id, r.id, EVENTOS.cancel_refused)
  }
  await tx.query(
    `update nofiscal.fiscal_sandbox_invoices set status = 'cancelled', cancelled_at = $2, updated_at = $2 where id = $1`,
    [r.id, agora],
  )
  await enfileirarEvento(tx, r.dono_tenant_id, r.id, EVENTOS.cancelled)
}

/** Avança as notas sandbox da conta cuja hora chegou. Devolve quantas mudaram e quando é a próxima. */
export async function avancarSandbox(db: Db, donoId: string, agora: Date): Promise<{ avancadas: number; proxima: Date | null }> {
  const avancadas = await db.transaction(async (tx) => {
    const { rows } = await tx.query<Linha>(
      `${SELECT}
        where s.dono_tenant_id = $1 and s.avanca_em <= $2
          and (s.status = 'queued' and s.roteiro <> 'tributos'
               or s.status = 'cancel_requested' and s.last_error_code is null)
        order by s.avanca_em
        limit 50
        for update of s skip locked`,
      [donoId, agora],
    )
    for (const r of rows) await avancarUma(tx, r, agora)
    return rows.length
  })
  const { rows } = await db.query<{ proxima: Date | null }>(
    `select min(avanca_em) as proxima from nofiscal.fiscal_sandbox_invoices
      where dono_tenant_id = $1
        and (status = 'queued' and roteiro <> 'tributos' or status = 'cancel_requested' and last_error_code is null)`,
    [donoId],
  )
  return { avancadas, proxima: rows[0]?.proxima ?? null }
}

// ---------------------------------------------------------------------------------------
// Webhook sandbox: mesmo corpo e mesma assinatura do de produção, com `"ambiente": "sandbox"` e o header
// `x-nofiscal-ambiente: sandbox`, para a URL e com o segredo do sandbox.

/** Espera antes de cada reenvio, em minutos: 3 tentativas. */
export const ESPERAS_SANDBOX_MINUTOS = [1, 5] as const
const MAX_TENTATIVAS_SANDBOX = ESPERAS_SANDBOX_MINUTOS.length + 1

export async function entregarWebhooksSandbox(db: Queryable, fetch: FetchLike, donoId: string, agora: Date): Promise<number> {
  const { rows } = await db.query<{ id: string; evento: string; dados: Record<string, unknown>; tentativas: number }>(
    `update nofiscal.fiscal_sandbox_webhook_entregas e
        set proxima_em = $2::timestamptz + interval '2 minutes', updated_at = $2
      where e.id in (select x.id from nofiscal.fiscal_sandbox_webhook_entregas x
                      where x.dono_tenant_id = $1 and x.status = 'pendente' and x.proxima_em <= greatest($2::timestamptz, now())
                      order by x.proxima_em limit 20 for update skip locked)
      returning e.id, e.evento, e.dados, e.tentativas`,
    [donoId, agora],
  )
  if (rows.length === 0) return 0
  const destino = await db.query<{ url: string | null; segredo: string | null }>(
    'select webhook_url as url, nofiscal.read_sandbox_webhook_secret(dono_tenant_id) as segredo from nofiscal.fiscal_sandbox_contas where dono_tenant_id = $1',
    [donoId],
  )
  const { url, segredo } = destino.rows[0] ?? { url: null, segredo: null }
  let entregues = 0
  for (const e of rows) {
    const tentativa = e.tentativas + 1
    if (!url || !segredo) {
      await db.query(`update nofiscal.fiscal_sandbox_webhook_entregas set status = 'desistiu', ultimo_erro = $2, updated_at = $3 where id = $1`, [
        e.id,
        url ? 'sandbox sem segredo do webhook' : 'sandbox sem URL de webhook',
        agora,
      ])
      continue
    }
    const corpo = corpoDoEvento({ id: e.id, evento: e.evento, recurso: 'nfse', dados: e.dados }, agora)
    const r = await postar(fetch, url, segredo, corpo, {
      'x-nofiscal-evento': e.evento,
      'x-nofiscal-entrega': e.id,
      'x-nofiscal-tentativa': String(tentativa),
      'x-nofiscal-ambiente': 'sandbox',
    })
    if (r.ok) {
      entregues++
      await db.query(
        `update nofiscal.fiscal_sandbox_webhook_entregas
            set status = 'entregue', tentativas = $2, ultimo_http = $3, ultimo_erro = null, entregue_em = $4, updated_at = $4
          where id = $1`,
        [e.id, tentativa, r.http, agora],
      )
      continue
    }
    const desiste = tentativa >= MAX_TENTATIVAS_SANDBOX
    const espera = ESPERAS_SANDBOX_MINUTOS[Math.min(tentativa, ESPERAS_SANDBOX_MINUTOS.length) - 1]
    await db.query(
      `update nofiscal.fiscal_sandbox_webhook_entregas
          set status = $2, tentativas = $3, ultimo_http = $4, ultimo_erro = $5, proxima_em = $6::timestamptz + make_interval(mins => $7), updated_at = $6
        where id = $1`,
      [e.id, desiste ? 'desistiu' : 'pendente', tentativa, r.http, r.erro, agora, espera],
    )
  }
  return entregues
}

/** Uma rodada do sandbox da conta: avança as notas e entrega os webhooks pendentes. */
export async function rodadaSandbox(db: Db, fetch: FetchLike, donoId: string, agora: Date): Promise<{ proxima: Date | null }> {
  const { proxima } = await avancarSandbox(db, donoId, agora)
  await entregarWebhooksSandbox(db, fetch, donoId, agora)
  return { proxima }
}
