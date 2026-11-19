// Roteador da API pública do nó.fiscal, servido por uma única função (`api/v1/nfse.ts`), para não somar funções na
// Vercel. O `vercel.json` do app reescreve `/api/v1/nfse/:id[/:acao]`, `/api/v1/nfe[/:id[/:acao]]` e
// `/api/v1/empresas[/:cnpj]` para `/api/v1/nfse?recurso=…&id=…&acao=…`; o roteador entende as duas formas.
// O trabalho com a Sefin e a Sefaz não roda aqui: o POST só enfileira e responde 202 (Unresolved 26).
//
// Chave do parceiro (18/11/2026): a chave da conta-mãe emite por qualquer empresa ativa da conta (`cnpj_prestador` /
// `cnpj_emitente`); sem ele, pela própria conta-mãe. Conta do produto (self-service) passa pelo mesmo
// `emission_block` do WhatsApp e do painel antes de pôr a nota na fila (procuração, A1, assinatura, dados fiscais);
// a franquia não barra, só avisa. Documentação: agentes/fiscal/dados/api/.
//
// Sandbox (19/11/2026): a chave `nfk_test_…` (auth.ts) cai em `sandbox()`, no fim deste arquivo. Valida igual
// (`prepararNfse`, o mesmo caminho da produção) e grava só nas tabelas do sandbox (sandbox/notas.ts). Nenhuma rota
// sandbox lê ou grava `fiscal_invoices`, e nenhuma rota de produção lê as tabelas do sandbox.
import { findTenantByApiKey, type AuthenticatedTenant } from './auth.js'
import { requestCancel } from './cancel.js'
import { renderDanfse } from './danfse-renderer.js'
import type { Db } from './db.js'
import { errorResponse, json } from './http.js'
import { createOrGetInvoice } from './invoices.js'
import { logEvent } from './log.js'
import { DESCRICAO_PADRAO } from './agente/conversa.js'
import { tipoDoDocumento } from './agente/documentos.js'
import { empresasDoDono, motivoDoProblema, notasDoMes, type Empresa } from './agente/lote.js'
import { payloadDaNota } from './agente/notas.js'
import { renderDanfe } from './nfe/danfe.js'
import { motivoDoBloqueio } from './nfe/painel-nfe.js'
import { criarNfe, pedirCancelamento } from './nfe/servico.js'
import { alterarEmpresa, consultaReceitaFromEnv, criarEmpresa, empresaPorCnpj, listarEmpresas, type ConsultaReceita } from './parceiro/empresas.js'
import { lerPedidoNfe } from './parceiro/nfe-api.js'
import { visaoNfe, visaoNfePorExternalId, visaoNfse, visaoNfsePorExternalId } from './parceiro/visoes.js'
import type { FetchLike } from './parceiro/webhook.js'
import { agendarNaVercel, type Agendar } from './sandbox/agenda.js'
import { salvarWebhookSandbox, webhookSandbox } from './sandbox/conta.js'
import { ATRASO_MS, cancelarNotaSandbox, criarNotaSandbox, notaSandbox, notaSandboxPorExternalId, rodadaSandbox } from './sandbox/notas.js'
import { motivoDaRetencao, resolverRetencao, SEM_RETENCAO_PADRAO, type EnderecoDoTomador, type EnderecoNacional } from './retencao.js'
import { parseNewInvoice, type InvoicePayload } from './validation.js'
import { exigeObra, MOTIVO_SEM_OBRA, problemaDaObra } from './obra.js'

export type Recurso = 'nfse' | 'nfe' | 'empresas' | 'sandbox'
export type NfseAction = 'cancel' | 'pdf' | 'xml' | 'danfe'

export type NfseRoute =
  | { recurso: Recurso; kind: 'collection' }
  | { recurso: Recurso; kind: 'item'; id: string; action: NfseAction | null }

const PREFIXO = '/api/v1/'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACOES: Record<Recurso, readonly string[]> = { nfse: ['cancel', 'pdf', 'xml'], nfe: ['cancel', 'danfe', 'xml'], empresas: [], sandbox: [] }

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** Todas as rotas que esta função atende; nenhuma recebe certificado (critério 31). */
export const NFSE_ROUTES = [
  { method: 'POST', path: '/v1/nfse' },
  { method: 'GET', path: '/v1/nfse?external_id=' },
  { method: 'GET', path: '/v1/nfse/:id' },
  { method: 'POST', path: '/v1/nfse/:id/cancel' },
  { method: 'GET', path: '/v1/nfse/:id/pdf' },
  { method: 'GET', path: '/v1/nfse/:id/xml' },
  { method: 'POST', path: '/v1/nfe' },
  { method: 'GET', path: '/v1/nfe?external_id=' },
  { method: 'GET', path: '/v1/nfe/:id' },
  { method: 'POST', path: '/v1/nfe/:id/cancel' },
  { method: 'GET', path: '/v1/nfe/:id/danfe' },
  { method: 'GET', path: '/v1/nfe/:id/xml' },
  { method: 'GET', path: '/v1/empresas' },
  { method: 'POST', path: '/v1/empresas' },
  { method: 'GET', path: '/v1/empresas/:cnpj' },
  { method: 'PATCH', path: '/v1/empresas/:cnpj' },
  { method: 'GET', path: '/v1/sandbox/webhook' },
  { method: 'PUT', path: '/v1/sandbox/webhook' },
] as const

const RECURSOS: readonly string[] = ['nfse', 'nfe', 'empresas', 'sandbox']

export function parseNfseRoute(url: URL): NfseRoute | null {
  const path = url.pathname.replace(/\/+$/, '')
  if (!path.startsWith(PREFIXO)) return null
  const partes = path.slice(PREFIXO.length).split('/')
  const nome = partes[0]
  if (!RECURSOS.includes(nome)) return null

  // Forma reescrita: /api/v1/nfse?recurso=…&id=…&acao=…
  if (partes.length === 1 && nome === 'nfse' && (url.searchParams.has('recurso') || url.searchParams.has('id'))) {
    const recurso = (url.searchParams.get('recurso') ?? 'nfse') as Recurso
    if (!RECURSOS.includes(recurso)) return null
    const id = url.searchParams.get('id')
    if (!id) return { recurso, kind: 'collection' }
    const acao = url.searchParams.get('acao')
    if (acao === null || acao === '') return { recurso, kind: 'item', id, action: null }
    return ACOES[recurso].includes(acao) ? { recurso, kind: 'item', id, action: acao as NfseAction } : null
  }

  const recurso = nome as Recurso
  if (partes.length === 1) return { recurso, kind: 'collection' }
  const id = partes[1] ? decode(partes[1]) : null
  if (!id) return null
  if (partes.length === 2) return { recurso, kind: 'item', id, action: null }
  if (partes.length === 3 && ACOES[recurso].includes(partes[2])) return { recurso, kind: 'item', id, action: partes[2] as NfseAction }
  return null
}

/** Status com NFS-e gerada: `cancel_requested` ainda vale; `cancelled` sai com a marca d'água. */
const PDF_STATUSES: readonly string[] = ['issued', 'cancel_requested', 'cancelled']
const NFE_COM_XML: readonly string[] = ['authorized', 'cancel_requested', 'cancelled', 'denied']

export type NfseDeps = {
  db: Db
  now?: () => Date
  /** Endereço do tomador na Receita (ISS retido, E0237); sem ela, nota com ISS retido não sai. */
  enderecos?: EnderecoDoTomador | null
  /** Consulta de CNPJ do cadastro de empresa (POST /v1/empresas). Padrão: a real, pelo ambiente. */
  receita?: ConsultaReceita
  /** POST do webhook sandbox. Padrão: o `fetch` global. */
  fetch?: FetchLike
  /** Rodada do sandbox depois da resposta. Padrão: `waitUntil` da Vercel (sandbox/agenda.ts). */
  agendar?: Agendar
}

export async function handleNfseRequest(request: Request, deps: NfseDeps): Promise<Response> {
  try {
    return await route(request, deps)
  } catch (error) {
    logEvent('nofiscal.api_error', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}

type Ctx = { deps: NfseDeps; db: Db; agora: Date; tenant: AuthenticatedTenant; url: URL }

async function lerJson(request: Request): Promise<{ ok: true; corpo: unknown } | { ok: false; resposta: Response }> {
  try {
    return { ok: true, corpo: JSON.parse(await request.text()) }
  } catch {
    return { ok: false, resposta: errorResponse('INVALID_JSON', 'corpo não é JSON válido') }
  }
}

async function route(request: Request, deps: NfseDeps): Promise<Response> {
  const url = new URL(request.url)
  const target = parseNfseRoute(url)
  if (!target) return errorResponse('NOT_FOUND', 'rota não encontrada')

  const tenant = await findTenantByApiKey(deps.db, request.headers.get('x-api-key'))
  if (!tenant) return errorResponse('UNAUTHORIZED', 'x-api-key ausente ou inválida')
  // Tenant inativo: 403 (Unresolved 11 da tarefa, valor de "Until answered").
  if (!tenant.active) return errorResponse('TENANT_INACTIVE', 'tenant inativo')
  const ctx: Ctx = { deps, db: deps.db, agora: (deps.now ?? (() => new Date()))(), tenant, url }

  if (tenant.sandbox) return sandbox(ctx, request, target)
  if (target.recurso === 'sandbox') return errorResponse('SO_SANDBOX', 'as rotas /v1/sandbox/ são da chave sandbox (nfk_test_)')
  if (target.recurso === 'empresas') return empresas(ctx, request, target)
  if (target.recurso === 'nfe') return nfe(ctx, request, target)
  return nfse(ctx, request, target)
}

// ---------------------------------------------------------------------------------------
// Empresa que emite.

type Prestador = { ok: true; empresa: Empresa } | { ok: false; resposta: Response }

/** A empresa da conta que emite: a do CNPJ pedido (ativa) ou, sem CNPJ, a própria conta-mãe. */
async function prestador(ctx: Ctx, cnpj: string | null, campo: string): Promise<Prestador> {
  const empresas = await empresasDoDono(ctx.db, ctx.tenant.id)
  const empresa = cnpj ? empresas.find((e) => e.cnpj === cnpj) : empresas.find((e) => e.id === ctx.tenant.id)
  if (!empresa) {
    return { ok: false, resposta: errorResponse('EMPRESA_NAO_ENCONTRADA', `${campo} não é de nenhuma empresa desta conta`, { campo }) }
  }
  if (!empresa.active) return { ok: false, resposta: errorResponse('EMPRESA_INATIVA', `${empresa.razao_social} está desativada nesta conta`, { campo }) }
  return { ok: true, empresa }
}

async function avisoDeFranquia(ctx: Ctx): Promise<string[]> {
  if (!ctx.tenant.selfService) return []
  const { rows } = await ctx.db.query<{ limite: number }>('select monthly_note_limit as limite from nofiscal.fiscal_tenants where id = $1', [ctx.tenant.id])
  const limite = rows[0]?.limite
  if (!limite) return []
  const noMes = await notasDoMes(ctx.db, ctx.tenant.id, ctx.agora)
  return noMes > limite
    ? [`Franquia: o mês está em ${noMes.toLocaleString('pt-BR')} notas, acima das ${limite.toLocaleString('pt-BR')} do plano. As notas continuam saindo.`]
    : []
}

// ---------------------------------------------------------------------------------------
// NFS-e.

async function nfse(ctx: Ctx, request: Request, target: NfseRoute): Promise<Response> {
  if (target.kind === 'collection') {
    if (request.method === 'GET') {
      const externalId = ctx.url.searchParams.get('external_id')
      if (!externalId) return errorResponse('VALIDATION_FAILED', 'informe external_id (e cnpj_prestador, se não for a conta-mãe)')
      const p = await prestador(ctx, ctx.url.searchParams.get('cnpj_prestador'), 'cnpj_prestador')
      if (!p.ok) return p.resposta
      const visao = await visaoNfsePorExternalId(ctx.db, p.empresa.id, externalId)
      return visao ? json(200, visao) : errorResponse('NOT_FOUND', 'nota não encontrada')
    }
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    const lido = await lerJson(request)
    if (!lido.ok) return lido.resposta
    return criarNfse(ctx, lido.corpo)
  }

  const visao = UUID.test(target.id) ? await visaoNfse(ctx.db, target.id, ctx.tenant.id) : null
  if (!visao) return errorResponse('NOT_FOUND', 'nota não encontrada')

  if (target.action === null) {
    if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
    return json(200, visao)
  }
  if (target.action === 'cancel') {
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    // Só registra o pedido; o evento e101101 sai pelo worker (Landing, lote 2b - cancelamento).
    const { rows } = await ctx.db.query<{ tenant_id: string }>('select tenant_id from nofiscal.fiscal_invoices where id = $1', [visao.id])
    const result = await requestCancel(ctx.db, rows[0].tenant_id, visao.id, ctx.agora)
    if (!result) return errorResponse('NOT_FOUND', 'nota não encontrada')
    return json(202, { ...(await visaoNfse(ctx.db, visao.id, ctx.tenant.id)), id: result.id, status: result.status })
  }
  if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
  // Nota ainda não emitida: 409 (Unresolved 23 da tarefa, valor de "Until answered").
  if (!PDF_STATUSES.includes(visao.status)) return errorResponse('NOT_ISSUED', 'a nota ainda não foi emitida')
  const { rows } = await ctx.db.query<{ xml_nfse: string | null }>('select xml_nfse from nofiscal.fiscal_invoices where id = $1', [visao.id])
  const xml = rows[0]?.xml_nfse
  if (!xml) return errorResponse('NOT_ISSUED', 'a nota ainda não foi emitida')
  if (target.action === 'xml') {
    return new Response(xml, {
      status: 200,
      headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="nfse-${visao.chave_acesso ?? visao.id}.xml"`, 'cache-control': 'no-store' },
    })
  }
  // DANFSe gerado a cada pedido a partir de xml_nfse (Landing, lote 2b - DANFSe).
  const pdf = await renderDanfse(xml, { cancelada: visao.status === 'cancelled' })
  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="danfse-${visao.chave_acesso ?? visao.id}.pdf"`,
      'cache-control': 'no-store',
    },
  })
}

const CAMPO_DA_RETENCAO: Record<string, string> = {
  ALIQUOTA_ISS_FALTANDO: 'retencao.aliquota_iss',
  ALIQUOTA_ISS_INVALIDA: 'retencao.aliquota_iss',
  INSS_FALTANDO: 'retencao.inss',
  INSS_INVALIDO: 'retencao.inss',
  RETENCOES_ACIMA_DO_VALOR: 'retencao',
  ISS_RETIDO_CPF: 'tomador',
  RETENCAO_MEI: 'retencao',
  ENDERECO_TOMADOR: 'tomador.cnpj',
  RETENCAO_FEDERAL_SO_LUCRO: 'retencao',
  IRRF_INVALIDO: 'retencao.irrf',
  CSRF_INVALIDO: 'retencao.csrf',
}

type Preparada =
  | { ok: true; empresa: Empresa; externalId: string; valor: string; payload: InvoicePayload; avisos: string[] }
  | { ok: false; resposta: Response }
  | { ok: 'existente'; visao: object }

/** Bloqueios que o sandbox também respeita: dados da empresa, não A1, procuração nem assinatura. */
const BLOQUEIOS_DE_CADASTRO: readonly string[] = ['TENANT_NOT_FOUND', 'TENANT_INACTIVE', 'FISCAL_CONFIG_MISSING']

/**
 * O caminho comum do POST /v1/nfse, produção e sandbox: corpo, empresa da conta, idempotência, bloqueio, código de
 * serviço, retenção e o payload que o worker lê. No sandbox, o bloqueio de A1, procuração ou assinatura vira aviso.
 */
async function prepararNfse(
  ctx: Ctx,
  corpo: unknown,
  existente: (empresaId: string, externalId: string) => Promise<object | null>,
): Promise<Preparada> {
  const parsed = parseNewInvoice(corpo)
  if (!parsed.ok) return { ok: false, resposta: errorResponse(parsed.code, parsed.message) }
  const pedido = parsed.value
  const p = await prestador(ctx, pedido.cnpj_prestador, 'cnpj_prestador')
  if (!p.ok) return p
  const empresa = p.empresa

  // Repetição do mesmo external_id: devolve a nota que já existe, sem conferir de novo (idempotência).
  const ja = await existente(empresa.id, pedido.external_id)
  if (ja) return { ok: 'existente', visao: ja }

  const avisos: string[] = []
  if (ctx.tenant.selfService || ctx.tenant.sandbox) {
    const { rows } = await ctx.db.query<{ b: string | null }>('select nofiscal.emission_block($1) as b', [empresa.id])
    const bloqueio = rows[0]?.b ?? null
    if (bloqueio && (!ctx.tenant.sandbox || BLOQUEIOS_DE_CADASTRO.includes(bloqueio))) {
      logEvent('nofiscal.api_nfse_bloqueada', { tenant_id: empresa.id, bloqueio, sandbox: Boolean(ctx.tenant.sandbox) })
      return {
        ok: false,
        resposta: errorResponse('EMISSAO_BLOQUEADA', `Não dá para emitir: ${motivoDoProblema(bloqueio, { empresa: empresa.razao_social })}.`, { bloqueio }),
      }
    }
    if (bloqueio) avisos.push(`Sandbox: em produção esta nota seria barrada agora (${bloqueio}): ${motivoDoProblema(bloqueio, { empresa: empresa.razao_social })}.`)
  }

  const codigo = pedido.servico.codigo ?? empresa.codigo_servico_nacional
  if (!codigo) {
    return {
      ok: false,
      resposta: errorResponse('VALIDATION_FAILED', 'servico.codigo_servico_nacional é obrigatório (a empresa não tem código padrão)', {
        campo: 'servico.codigo_servico_nacional',
      }),
    }
  }

  const resolvida = resolverRetencao({
    padrao: empresa.retencao ?? SEM_RETENCAO_PADRAO,
    pedido: pedido.retencao,
    valor: pedido.valor,
    regime: empresa.regime ?? null,
    tomadorTipo: tipoDoDocumento(pedido.tomador.documento),
  })
  if (!resolvida.ok) {
    return {
      ok: false,
      resposta: errorResponse('VALIDATION_FAILED', motivoDaRetencao(resolvida.problema), {
        campo: CAMPO_DA_RETENCAO[resolvida.problema] ?? 'retencao',
        motivo: resolvida.problema,
      }),
    }
  }
  let endereco: EnderecoNacional | null = null
  if (resolvida.retencao?.iss) {
    endereco = ctx.deps.enderecos ? await ctx.deps.enderecos.endereco(pedido.tomador.documento).catch(() => null) : null
    if (!endereco) {
      return { ok: false, resposta: errorResponse('VALIDATION_FAILED', motivoDaRetencao('ENDERECO_TOMADOR'), { campo: 'tomador.cnpj', motivo: 'ENDERECO_TOMADOR' }) }
    }
  }

  // E0370: código de construção civil sem o CNO ou o endereço da obra; a Sefin recusaria.
  if (problemaDaObra({ codigo, obra: pedido.servico.obra })) {
    return {
      ok: false,
      resposta: errorResponse('VALIDATION_FAILED', `servico.obra é obrigatório: ${MOTIVO_SEM_OBRA}`, { campo: 'servico.obra', motivo: 'OBRA_SEM_DADOS' }),
    }
  }

  const { nbs, c_ind_op, c_class_trib, municipio_prestacao_ibge } = pedido.servico
  const rtc = Object.fromEntries(Object.entries({ nbs, c_ind_op, c_class_trib, municipio_prestacao_ibge }).filter(([, v]) => v !== undefined))
  const base = payloadDaNota(
    pedido.tomador,
    {
      codigo,
      descricao: pedido.servico.descricao ?? DESCRICAO_PADRAO,
      municipio_prestacao_ibge: municipio_prestacao_ibge ?? null,
      obra: exigeObra(codigo) ? (pedido.servico.obra ?? null) : null,
    },
    pedido.valor,
    { retencao: resolvida.retencao, endereco, informacoes_complementares: pedido.informacoes_complementares ?? null },
  )
  // NBS e IBS/CBS (dps-builder.ts) não passam por payloadDaNota, que é do agente; entram aqui.
  const payload = { ...base, servico: { ...base.servico, ...rtc } } as unknown as InvoicePayload
  return { ok: true, empresa, externalId: pedido.external_id, valor: pedido.valor, payload, avisos }
}

async function criarNfse(ctx: Ctx, corpo: unknown): Promise<Response> {
  const pronta = await prepararNfse(ctx, corpo, (empresaId, externalId) => visaoNfsePorExternalId(ctx.db, empresaId, externalId))
  if (pronta.ok === false) return pronta.resposta
  if (pronta.ok === 'existente') return json(202, { ...pronta.visao, avisos: [] })
  const { empresa, externalId, payload } = pronta
  const nota = await ctx.db.transaction((tx) => createOrGetInvoice(tx, empresa.id, { external_id: externalId, payload, origem: 'api' }))
  logEvent('nofiscal.api_nfse_criada', { tenant_id: empresa.id, invoice_id: nota.id, status: nota.status })
  const visao = await visaoNfse(ctx.db, nota.id)
  return json(202, { ...visao, avisos: await avisoDeFranquia(ctx) })
}

// ---------------------------------------------------------------------------------------
// NF-e (modelo 55), motor do PR #114.

async function nfe(ctx: Ctx, request: Request, target: NfseRoute): Promise<Response> {
  if (!ctx.tenant.selfService) return errorResponse('SO_ESCRITORIO', 'a NF-e pela API é das contas do nó.fiscal')
  if (target.kind === 'collection') {
    if (request.method === 'GET') {
      const externalId = ctx.url.searchParams.get('external_id')
      if (!externalId) return errorResponse('VALIDATION_FAILED', 'informe external_id (e cnpj_emitente, se não for a conta-mãe)')
      const p = await prestador(ctx, ctx.url.searchParams.get('cnpj_emitente'), 'cnpj_emitente')
      if (!p.ok) return p.resposta
      const visao = await visaoNfePorExternalId(ctx.db, p.empresa.id, externalId)
      return visao ? json(200, visao) : errorResponse('NOT_FOUND', 'nota não encontrada')
    }
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    const lido = await lerJson(request)
    if (!lido.ok) return lido.resposta
    const pedido = lerPedidoNfe(lido.corpo)
    if (!pedido.ok) return errorResponse(pedido.codigo, pedido.mensagem)
    const p = await prestador(ctx, pedido.valor.cnpj_emitente, 'cnpj_emitente')
    if (!p.ok) return p.resposta
    const r = await criarNfe(ctx.db, { tenantId: p.empresa.id, externalId: pedido.valor.external_id, origem: 'api', pedido: pedido.valor.pedido, agora: ctx.agora })
    if (!r.ok && r.codigo === 'BLOQUEADA') {
      return errorResponse('EMISSAO_BLOQUEADA', `Não dá para emitir NF-e: ${motivoDoBloqueio(r.bloqueio)}.`, { bloqueio: r.bloqueio })
    }
    if (!r.ok) return errorResponse('VALIDATION_FAILED', r.problemas.join(' '), { problemas: r.problemas })
    logEvent('nofiscal.api_nfe_criada', { tenant_id: p.empresa.id, nfe_id: r.nfeId, ja_existia: r.jaExistia })
    return json(202, { ...(await visaoNfe(ctx.db, r.nfeId)), avisos: r.jaExistia ? [] : await avisoDeFranquia(ctx) })
  }

  const visao = UUID.test(target.id) ? await visaoNfe(ctx.db, target.id, ctx.tenant.id) : null
  if (!visao) return errorResponse('NOT_FOUND', 'nota não encontrada')
  if (target.action === null) {
    if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
    return json(200, visao)
  }
  if (target.action === 'cancel') {
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    const lido = await lerJson(request)
    if (!lido.ok) return lido.resposta
    const corpo = lido.corpo as { justificativa?: unknown } | null
    const justificativa = typeof corpo?.justificativa === 'string' ? corpo.justificativa : ''
    const r = await pedirCancelamento(ctx.db, visao.id, justificativa)
    if (!r.ok) return errorResponse('NFE_NAO_CANCELAVEL', r.mensagem)
    return json(202, await visaoNfe(ctx.db, visao.id))
  }
  if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
  const { rows } = await ctx.db.query<{ xml_proc: string | null }>('select xml_proc from nofiscal.fiscal_nfe where id = $1', [visao.id])
  const xml = rows[0]?.xml_proc
  if (!xml || !NFE_COM_XML.includes(visao.status)) return errorResponse('NOT_ISSUED', 'a nota ainda não foi autorizada')
  if (target.action === 'xml') {
    return new Response(xml, {
      status: 200,
      headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="nfe-${visao.chave}.xml"`, 'cache-control': 'no-store' },
    })
  }
  const pdf = await renderDanfe(xml, { cancelada: visao.status === 'cancelled' })
  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="danfe-${visao.chave}.pdf"`, 'cache-control': 'no-store' },
  })
}

// ---------------------------------------------------------------------------------------
// Empresas.

async function empresas(ctx: Ctx, request: Request, target: NfseRoute): Promise<Response> {
  if (!ctx.tenant.selfService) return errorResponse('SO_ESCRITORIO', 'empresas pela API são do plano Escritório')
  const ectx = { db: ctx.db, donoId: ctx.tenant.id, agora: ctx.agora, receita: ctx.deps.receita ?? consultaReceitaFromEnv(ctx.db) }
  if (target.kind === 'collection') {
    if (request.method === 'GET') return json(200, { empresas: await listarEmpresas(ctx.db, ctx.tenant.id) })
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou POST')
    if (!ctx.tenant.escritorio) return errorResponse('SO_ESCRITORIO', 'cadastrar empresas é do plano Escritório')
    const lido = await lerJson(request)
    if (!lido.ok) return lido.resposta
    return criarEmpresa(ectx, lido.corpo)
  }
  if (target.action !== null) return errorResponse('NOT_FOUND', 'rota não encontrada')
  const cnpj = target.id.replace(/\D/g, '')
  if (request.method === 'GET') {
    const empresa = /^\d{14}$/.test(cnpj) ? await empresaPorCnpj(ctx.db, ctx.tenant.id, cnpj) : null
    return empresa ? json(200, { empresa }) : errorResponse('EMPRESA_NAO_ENCONTRADA', 'empresa não encontrada nesta conta')
  }
  if (request.method !== 'PATCH') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou PATCH')
  const lido = await lerJson(request)
  if (!lido.ok) return lido.resposta
  return alterarEmpresa(ectx, cnpj, lido.corpo)
}

// ---------------------------------------------------------------------------------------
// Sandbox (chave nfk_test_). Só as tabelas do sandbox; a franquia não conta, o painel não vê.

async function sandbox(ctx: Ctx, request: Request, target: NfseRoute): Promise<Response> {
  const donoId = ctx.tenant.id
  const fetch: FetchLike = ctx.deps.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const agendar = ctx.deps.agendar ?? agendarNaVercel
  const relogio = ctx.deps.now ?? (() => new Date())
  // Rodada preguiçosa: o que já devia ter avançado avança antes de responder.
  await rodadaSandbox(ctx.db, fetch, donoId, ctx.agora)
  const depois = () => {
    const rodar = async (): Promise<void> => {
      const { proxima } = await rodadaSandbox(ctx.db, fetch, donoId, relogio())
      // Sefin "fora do ar" (valor 2.22): mais uma rodada quando ela "voltar", se couber na vida da função.
      const espera = proxima ? proxima.getTime() - relogio().getTime() : null
      if (espera !== null && espera < 90_000) agendar(rodar, Math.max(espera, 0) + 200)
    }
    agendar(rodar, ATRASO_MS + 200)
  }

  if (target.recurso === 'nfe') return errorResponse('SANDBOX_SEM_NFE', 'a NF-e ainda não tem sandbox')
  if (target.recurso === 'sandbox') {
    if (target.kind !== 'item' || target.id !== 'webhook' || target.action !== null) return errorResponse('NOT_FOUND', 'rota não encontrada')
    if (request.method === 'GET') return webhookSandbox({ db: ctx.db, donoId, agora: ctx.agora })
    if (request.method !== 'PUT') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou PUT')
    const lido = await lerJson(request)
    if (!lido.ok) return lido.resposta
    return salvarWebhookSandbox({ db: ctx.db, donoId, agora: ctx.agora }, lido.corpo)
  }
  if (target.recurso === 'empresas') {
    // Ler as empresas da conta, sim; cadastrar ou declarar procuração com chave de teste, não (muda a conta real).
    if (request.method !== 'GET') {
      return errorResponse('SANDBOX_SOMENTE_LEITURA', 'no sandbox, empresas só se consultam; cadastre pelo painel ou com a chave de produção')
    }
    return empresas(ctx, request, target)
  }

  if (target.kind === 'collection') {
    if (request.method === 'GET') {
      const externalId = ctx.url.searchParams.get('external_id')
      if (!externalId) return errorResponse('VALIDATION_FAILED', 'informe external_id (e cnpj_prestador, se não for a conta-mãe)')
      const p = await prestador(ctx, ctx.url.searchParams.get('cnpj_prestador'), 'cnpj_prestador')
      if (!p.ok) return p.resposta
      const visao = await notaSandboxPorExternalId(ctx.db, donoId, p.empresa.id, externalId)
      return visao ? json(200, visao) : errorResponse('NOT_FOUND', 'nota não encontrada')
    }
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    const lido = await lerJson(request)
    if (!lido.ok) return lido.resposta
    const pronta = await prepararNfse(ctx, lido.corpo, (empresaId, externalId) => notaSandboxPorExternalId(ctx.db, donoId, empresaId, externalId))
    if (pronta.ok === false) return pronta.resposta
    if (pronta.ok === 'existente') return json(202, { ...pronta.visao, avisos: [] })
    const { visao } = await criarNotaSandbox(ctx.db, {
      donoId,
      tenantId: pronta.empresa.id,
      externalId: pronta.externalId,
      payload: pronta.payload,
      valor: pronta.valor,
      agora: ctx.agora,
    })
    depois()
    return json(202, { ...visao, avisos: pronta.avisos })
  }

  const nota = UUID.test(target.id) ? await notaSandbox(ctx.db, donoId, target.id) : null
  if (!nota) return errorResponse('NOT_FOUND', 'nota não encontrada')
  const { xml_nfse: xml, ...visao } = nota
  if (target.action === null) {
    if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
    return json(200, visao)
  }
  if (target.action === 'cancel') {
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    const r = await cancelarNotaSandbox(ctx.db, donoId, visao.id, ctx.agora)
    if (!r) return errorResponse('NOT_FOUND', 'nota não encontrada')
    if (r.status === 'cancel_requested') depois()
    return json(202, r)
  }
  if (request.method !== 'GET') return errorResponse('METHOD_NOT_ALLOWED', 'use GET')
  if (!PDF_STATUSES.includes(visao.status) || !xml) return errorResponse('NOT_ISSUED', 'a nota ainda não foi emitida')
  const nome = `${target.action === 'xml' ? 'nfse' : 'danfse'}-sandbox-${visao.chave_acesso ?? visao.id}`
  if (target.action === 'xml') {
    return new Response(xml, {
      status: 200,
      headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="${nome}.xml"`, 'cache-control': 'no-store' },
    })
  }
  // tpAmb 2 na DPS: o DANFSe sai com a tarja "NFS-e SEM VALIDADE JURÍDICA".
  const pdf = await renderDanfse(xml, { cancelada: visao.status === 'cancelled' })
  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${nome}.pdf"`, 'cache-control': 'no-store' },
  })
}
