// POST /api/v1/fiscal/emissao: a aba "Emitir" do painel "Minha conta" (conta Escritório), sem passar pelo WhatsApp.
// Mesmo motor do agente: a nota avulsa nasce por `createOrGetInvoice` depois de `nofiscal.emission_block` (como o
// "confirmar" de conversa.ts), e a planilha passa por `lerLoteDaPlanilha` e `confirmarItensDoLote` (lote.ts), com a
// mesma validação por linha, o mesmo aviso de franquia e a mesma recusa de nota igual no mês. Daí para a frente é o
// worker de sempre: a nota assina com o A1 da empresa ou, por procuração, com o A1 do escritório (a nó nunca
// assina), aparece em Relatórios (`fiscal_relatorio` lê toda nota das empresas do dono) e sai por e-mail como a do
// WhatsApp (entregas.ts decide pelos destinatários da nota, não pela origem).
//
// Sessão Supabase do site (Authorization: Bearer). A conta é a do login (`fiscal_accounts` com e-mail confirmado);
// toda empresa pedida tem de ser do dono (`nofiscal.empresas_do_dono`), e todo lote, da conta-mãe. Ações (JSON,
// `acao`): `contexto`, `modelos`, `avulsa_conferir`, `avulsa_emitir`, `lote_confirmar`, `lote_descartar`. A planilha
// (`lote_ler`) chega em multipart/form-data com o campo `arquivo`.
import type { Db, Queryable } from './db.js'
import { errorResponse, json } from './http.js'
import { createOrGetInvoice } from './invoices.js'
import { logEvent } from './log.js'
import type { CatalogoDeServicos } from './agente/catalogo-servicos.js'
import { DESCRICAO_PADRAO } from './agente/conversa.js'
import { cnpjValido, cpfValido, formatarReais, tipoDoDocumento } from './agente/documentos.js'
import {
  centavosDe,
  chaveDoPayload,
  confirmarItensDoLote,
  empresasDoDono,
  expirarLotes,
  lerLoteDaPlanilha,
  lerValor,
  motivoDoProblema,
  notasDoMes,
  notasIguaisDoMes,
  reaisDeCentavos,
  tipoDaPlanilha,
  type Empresa,
  type LoteLido,
} from './agente/lote.js'
import { normalizarEmail } from './agente/normalizacao.js'
import { payloadDaNota } from './agente/notas.js'
import { planoDeEscritorio } from './agente/planos.js'
import type { InvoicePayload } from './validation.js'
import type { SessionVerifier } from './session.js'

export type PainelEmissaoDeps = {
  /** Conexão como `nofiscal_service`, a mesma do agente. */
  db: Db
  sessions: SessionVerifier
  /** Nome do código de serviço no resumo; sem ele, só o código. */
  catalogo?: CatalogoDeServicos
  now?: () => Date
}

/**
 * Corpo de uma função da Vercel: até 4,5 MB. A planilha do painel para em 4 MB, com folga para o multipart (a do
 * WhatsApp vai até 5 MB, o limite da mídia da Meta; 1.000 linhas em .csv são ~100 KB).
 */
export const MAX_BYTES_DO_PAINEL = 4 * 1024 * 1024

export const TEXTOS_DO_PAINEL = {
  soEscritorio: 'A emissão pelo painel é do plano Escritório. No seu plano, peça as notas pelo WhatsApp.',
  semEmpresa: 'Não achamos uma empresa nesta conta.',
  empresaDesconhecida: 'Esta empresa não é da sua conta.',
  formato: 'Envie a planilha em .xlsx ou .csv (planilhas com macro, .xls antigo e .ods não).',
  grandeDemais: 'A planilha passou de 4 MB. Divida em duas e envie uma de cada vez.',
  semArquivo: 'Escolha a planilha (.xlsx ou .csv).',
  repetida: 'Esta planilha já foi lida e está esperando confirmação (aqui ou no WhatsApp). Descarte a anterior para ler de novo.',
  loteDesconhecido: 'Não achamos essa planilha na sua conta.',
  loteFechado: 'Esta planilha não está mais esperando confirmação.',
  loteVencido: 'Esta planilha expirou (24 horas sem confirmar) e nenhuma nota foi emitida. Envie de novo.',
} as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Dono = { id: string; plan: string; limite: number }

/** A conta-mãe de quem está logado (a mesma regra de `public.fiscal_relatorio`). */
export async function donoDoUsuario(db: Queryable, userId: string): Promise<Dono | null> {
  const { rows } = await db.query<Dono>(
    `select d.id, d.plan, d.monthly_note_limit as limite
       from nofiscal.fiscal_accounts a
       join nofiscal.fiscal_tenants t on t.client_id = a.client_id
       join nofiscal.fiscal_tenants d on d.id = coalesce(t.escritorio_tenant_id, t.id)
      where a.user_id = $1 and a.email_verified_at is not null
      order by d.id
      limit 1`,
    [userId],
  )
  return rows[0] ?? null
}

async function bloqueioDe(db: Queryable, tenantId: string): Promise<string | null> {
  const { rows } = await db.query<{ bloqueio: string | null }>('select nofiscal.emission_block($1) as bloqueio', [tenantId])
  return rows[0]?.bloqueio ?? null
}

const visao = (e: Empresa) => ({ tenant_id: e.id, razao_social: e.razao_social, cnpj: e.cnpj })

// ---------------------------------------------------------------------------------------
// Nota avulsa: leitura do formulário (pura).

export type PedidoDoPainel = {
  tenantId: string
  documento: string
  nome: string
  email: string | null
  valor: string
  codigo: string
  descricao: string
}

export type CampoDoPainel = 'tenant_id' | 'documento' | 'nome' | 'email' | 'valor' | 'codigo' | 'descricao'

export type LeituraDoPedido = { ok: true; pedido: PedidoDoPainel } | { ok: false; campo: CampoDoPainel; mensagem: string }

const texto = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '')

/**
 * O formulário da nota avulsa. Documento com dígito verificador (CPF ou CNPJ), nome até 150, e-mail opcional, valor
 * como na planilha ("1.234,56", "1234.56"), código de 6 dígitos (vazio = o da empresa) e descrição até 2.000 (vazia =
 * a padrão do agente).
 */
export function lerPedido(corpo: Record<string, unknown>, empresa: Pick<Empresa, 'codigo_servico_nacional'> | null): LeituraDoPedido {
  const falha = (campo: CampoDoPainel, mensagem: string): LeituraDoPedido => ({ ok: false, campo, mensagem })
  const tenantId = texto(corpo.tenant_id)
  if (!UUID.test(tenantId) || !empresa) return falha('tenant_id', 'Escolha a empresa que emite a nota.')

  const documento = texto(corpo.documento).replace(/\D/g, '')
  if (!(documento.length === 11 ? cpfValido(documento) : documento.length === 14 ? cnpjValido(documento) : false)) {
    return falha('documento', 'CPF ou CNPJ inválido. Confira os números.')
  }
  const nome = texto(corpo.nome)
  if (!nome) return falha('nome', 'Informe o nome do cliente.')
  if (nome.length > 150) return falha('nome', 'O nome passa de 150 caracteres.')
  const emailEscrito = texto(corpo.email)
  const email = emailEscrito ? normalizarEmail(emailEscrito) : null
  if (emailEscrito && !email) return falha('email', 'E-mail inválido. Confira ou deixe em branco.')
  const valor = lerValor(typeof corpo.valor === 'number' ? corpo.valor : texto(corpo.valor), { pontoEhMilhar: true })
  if (!valor) return falha('valor', 'Valor inválido. Escreva, por exemplo, 1.234,56.')
  const codigo = texto(corpo.codigo).replace(/\D/g, '') || empresa.codigo_servico_nacional || ''
  if (!/^\d{6}$/.test(codigo)) return falha('codigo', 'Escolha o código de serviço (6 dígitos da lista nacional).')
  const descricao = typeof corpo.descricao === 'string' ? corpo.descricao.trim() : ''
  if (descricao.length > 2000) return falha('descricao', 'A descrição passa de 2.000 caracteres.')

  return { ok: true, pedido: { tenantId, documento, nome, email, valor, codigo, descricao: descricao || DESCRICAO_PADRAO } }
}

const payloadDoPedido = (p: PedidoDoPainel) =>
  payloadDaNota({ documento: p.documento, nome: p.nome, email: p.email }, { codigo: p.codigo, descricao: p.descricao }, p.valor)

// ---------------------------------------------------------------------------------------
// Entrada.

type Contexto = { deps: PainelEmissaoDeps; db: Db; agora: Date; dono: Dono; empresas: Empresa[] }

export async function handlePainelEmissao(request: Request, deps: PainelEmissaoDeps): Promise<Response> {
  try {
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use POST')
    const userId = await deps.sessions.userIdFrom(request)
    if (!userId) return errorResponse('UNAUTHORIZED', 'faça login para emitir')
    const dono = await donoDoUsuario(deps.db, userId)
    if (!dono) return errorResponse('CONTA_SEM_EMPRESA', TEXTOS_DO_PAINEL.semEmpresa)
    if (!planoDeEscritorio(dono.plan)) return errorResponse('SO_ESCRITORIO', TEXTOS_DO_PAINEL.soEscritorio)
    const ctx: Contexto = { deps, db: deps.db, agora: (deps.now ?? (() => new Date()))(), dono, empresas: await empresasDoDono(deps.db, dono.id) }

    if ((request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')) return await loteLer(ctx, request)

    let corpo: unknown
    try {
      corpo = await request.json()
    } catch {
      return errorResponse('INVALID_JSON', 'corpo JSON inválido')
    }
    if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return errorResponse('INVALID_JSON', 'corpo JSON inválido')
    const b = corpo as Record<string, unknown>
    switch (b.acao) {
      case 'contexto':
        return await contexto(ctx)
      case 'modelos':
        return await modelos(ctx, b)
      case 'avulsa_conferir':
        return await avulsa(ctx, b, false)
      case 'avulsa_emitir':
        return await avulsa(ctx, b, true)
      case 'lote_confirmar':
        return await loteConfirmar(ctx, b)
      case 'lote_descartar':
        return await loteDescartar(ctx, b)
      default:
        return errorResponse('VALIDATION_FAILED', 'ação desconhecida')
    }
  } catch (error) {
    // Só o nome do erro: a mensagem de um driver pode ecoar dados da nota.
    logEvent('nofiscal.painel_emissao_error', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}

// ---------------------------------------------------------------------------------------
// Ações.

/** Empresas ativas com o bloqueio de cada uma (o mesmo `emission_block` do agente) e a franquia do mês. */
async function contexto(ctx: Contexto): Promise<Response> {
  const empresas = []
  for (const e of ctx.empresas) {
    if (!e.active) continue
    const bloqueio = await bloqueioDe(ctx.db, e.id)
    empresas.push({
      ...visao(e),
      principal: e.id === ctx.dono.id,
      codigo_servico_nacional: e.codigo_servico_nacional,
      bloqueio: bloqueio ? { codigo: bloqueio, motivo: motivoDoProblema(bloqueio, { empresa: e.razao_social }) } : null,
    })
  }
  return json(200, { empresas, franquia: { limite: ctx.dono.limite, no_mes: await notasDoMes(ctx.db, ctx.dono.id, ctx.agora) } })
}

/** Modelos de cliente salvos da empresa (os mesmos que o agente usa no WhatsApp). */
async function modelos(ctx: Contexto, b: Record<string, unknown>): Promise<Response> {
  const empresa = ctx.empresas.find((e) => e.id === b.tenant_id)
  if (!empresa) return errorResponse('NOT_FOUND', TEXTOS_DO_PAINEL.empresaDesconhecida)
  const { rows } = await ctx.db.query<{
    id: string
    nome: string
    documento: string
    nome_tomador: string
    email: string | null
    codigo: string
    descricao: string
    valor_padrao: string | null
  }>(
    `select id, nome, tomador_documento as documento, tomador_nome as nome_tomador, tomador_email as email,
            codigo_servico_nacional as codigo, descricao, valor_padrao::text as valor_padrao
       from nofiscal.fiscal_models where tenant_id = $1
      order by lower(nome)`,
    [empresa.id],
  )
  return json(200, { modelos: rows })
}

/** Conferir devolve o resumo; emitir confere de novo, barra pelo bloqueio e cria a nota (idempotente pela `chave`). */
async function avulsa(ctx: Contexto, b: Record<string, unknown>, emitir: boolean): Promise<Response> {
  const empresa = ctx.empresas.find((e) => e.id === b.tenant_id) ?? null
  if (empresa && !empresa.active) return errorResponse('VALIDATION_FAILED', `${empresa.razao_social} está desativada.`, { campo: 'tenant_id' })
  const lido = lerPedido(b, empresa)
  if (!lido.ok) return errorResponse('VALIDATION_FAILED', lido.mensagem, { campo: lido.campo })
  const pedido = lido.pedido
  const emp = empresa as Empresa

  const chave = texto(b.chave)
  if (emitir && !UUID.test(chave)) return errorResponse('VALIDATION_FAILED', 'chave da emissão inválida', { campo: 'chave' })

  const bloqueio = await bloqueioDe(ctx.db, emp.id)
  const motivo = bloqueio ? motivoDoProblema(bloqueio, { empresa: emp.razao_social }) : null
  if (emitir && bloqueio) {
    logEvent('nofiscal.painel_avulsa_bloqueada', { tenant_id: emp.id, bloqueio })
    return errorResponse('EMISSAO_BLOQUEADA', `Não dá para emitir: ${motivo}.`, { bloqueio })
  }

  const payload = payloadDoPedido(pedido)
  if (emitir) {
    const nota = await ctx.db.transaction((tx) =>
      createOrGetInvoice(tx, emp.id, { external_id: `painel:${chave}`, payload: payload as unknown as InvoicePayload }),
    )
    logEvent('nofiscal.painel_avulsa_emitida', { tenant_id: emp.id, invoice_id: nota.id, status: nota.status })
    return json(200, { invoice_id: nota.id, status: nota.status })
  }

  const avisos: string[] = []
  const chaveDaNota = chaveDoPayload(emp.id, payload)
  if (chaveDaNota && (await notasIguaisDoMes(ctx.db, [emp.id], ctx.agora)).has(chaveDaNota)) {
    avisos.push('Já há uma nota igual neste mês (mesma empresa, cliente e valor). Confira antes de emitir de novo.')
  }
  const noMes = await notasDoMes(ctx.db, ctx.dono.id, ctx.agora)
  if (noMes + 1 > ctx.dono.limite) {
    avisos.push(
      `Franquia: com esta nota, o mês chega a ${(noMes + 1).toLocaleString('pt-BR')} notas, acima das ${ctx.dono.limite.toLocaleString('pt-BR')} do seu plano. A nota sai normalmente.`,
    )
  }
  if (!pedido.email) avisos.push('Sem e-mail, o cliente não recebe a nota por e-mail. Ela fica em Relatórios.')

  const nomeDoServico = ctx.deps.catalogo ? await ctx.deps.catalogo.descricao(pedido.codigo).catch(() => null) : null
  return json(200, {
    resumo: {
      empresa: visao(emp),
      tomador: { documento: pedido.documento, tipo: tipoDoDocumento(pedido.documento), nome: pedido.nome, email: pedido.email },
      servico: { codigo: pedido.codigo, nome: nomeDoServico, descricao: pedido.descricao },
      valor: pedido.valor,
      valor_texto: formatarReais(pedido.valor),
    },
    bloqueio: bloqueio ? { codigo: bloqueio, motivo } : null,
    avisos,
  })
}

/** Planilha do painel: a mesma leitura e validação do WhatsApp (`lerLoteDaPlanilha`), sem telefone. */
async function loteLer(ctx: Contexto, request: Request): Promise<Response> {
  const tamanho = Number(request.headers.get('content-length') ?? 0)
  if (tamanho > MAX_BYTES_DO_PAINEL + 64 * 1024) return errorResponse('PLANILHA_RECUSADA', TEXTOS_DO_PAINEL.grandeDemais, { motivo: 'grande_demais' })
  let arquivo: FormDataEntryValue | null
  try {
    arquivo = (await request.formData()).get('arquivo')
  } catch {
    return errorResponse('PLANILHA_RECUSADA', TEXTOS_DO_PAINEL.semArquivo, { motivo: 'sem_arquivo' })
  }
  if (!arquivo || typeof arquivo === 'string') return errorResponse('PLANILHA_RECUSADA', TEXTOS_DO_PAINEL.semArquivo, { motivo: 'sem_arquivo' })
  const tipo = tipoDaPlanilha({ nome: arquivo.name || null, mime: arquivo.type || null })
  if (tipo !== 'xlsx' && tipo !== 'csv') return errorResponse('PLANILHA_RECUSADA', TEXTOS_DO_PAINEL.formato, { motivo: 'formato' })
  if (arquivo.size > MAX_BYTES_DO_PAINEL) return errorResponse('PLANILHA_RECUSADA', TEXTOS_DO_PAINEL.grandeDemais, { motivo: 'grande_demais' })

  const lido = await lerLoteDaPlanilha(ctx.db, {
    donoId: ctx.dono.id,
    limite: ctx.dono.limite,
    phoneId: null,
    arquivo: arquivo.name || null,
    conteudo: new Uint8Array(await arquivo.arrayBuffer()),
    tipo,
    agora: ctx.agora,
  })
  if (!lido.ok) {
    // A resposta do WhatsApp para a planilha repetida manda responder *cancelar*; no painel, o botão descarta.
    const mensagem = lido.motivo === 'repetida' ? TEXTOS_DO_PAINEL.repetida : lido.texto
    return errorResponse('PLANILHA_RECUSADA', mensagem, { motivo: lido.motivo, ...(lido.loteId ? { lote_id: lido.loteId } : {}) })
  }
  return json(200, resumoDoLote(lido))
}

/** O resumo estruturado do lote para a tela: totais, notas por empresa, todos os problemas e a franquia. */
export function resumoDoLote(lido: LoteLido) {
  const nomeDe = new Map(lido.empresas.map((e) => [e.id, e.razao_social]))
  const prontas = lido.itens.filter((i) => !i.problema)
  const porEmpresa = new Map<string, { notas: number; centavos: bigint }>()
  for (const i of prontas) {
    const atual = porEmpresa.get(i.tenantId as string) ?? { notas: 0, centavos: 0n }
    atual.notas++
    atual.centavos += centavosDe(i.valor as string)
    porEmpresa.set(i.tenantId as string, atual)
  }
  const total = prontas.reduce((soma, i) => soma + centavosDe(i.valor as string), 0n)
  const acima = Math.max(0, lido.franquia.noMes + prontas.length - lido.franquia.limite)
  return {
    lote_id: lido.loteId,
    status: lido.status,
    arquivo: lido.arquivo,
    expira_em: lido.expiraEm.toISOString(),
    linhas: lido.itens.length,
    prontas: prontas.length,
    total: reaisDeCentavos(total),
    por_empresa: [...porEmpresa].map(([id, p]) => ({ tenant_id: id, razao_social: nomeDe.get(id) ?? id, notas: p.notas, total: reaisDeCentavos(p.centavos) })),
    problemas: lido.itens
      .filter((i) => i.problema)
      .map((i) => {
        const semPrestador = !String((i.payload.lido as Record<string, string> | undefined)?.cnpj_prestador ?? '').trim()
        return {
          linha: i.linha,
          codigo: i.problema as string,
          motivo: motivoDoProblema(i.problema as string, { empresa: i.tenantId ? nomeDe.get(i.tenantId) : null, igualA: i.igualA, semPrestador }),
        }
      }),
    franquia: { limite: lido.franquia.limite, no_mes: lido.franquia.noMes, acima },
    resumo_texto: lido.resumo,
  }
}

type LoteDaConta = { id: string; status: string; expires_at: Date }

async function loteDaConta(ctx: Contexto, b: Record<string, unknown>): Promise<LoteDaConta | null> {
  const id = texto(b.lote_id)
  if (!UUID.test(id)) return null
  const { rows } = await ctx.db.query<LoteDaConta>(
    'select id, status, expires_at from nofiscal.fiscal_lotes where id = $1 and escritorio_tenant_id = $2',
    [id, ctx.dono.id],
  )
  return rows[0] ?? null
}

async function loteConfirmar(ctx: Contexto, b: Record<string, unknown>): Promise<Response> {
  const lote = await loteDaConta(ctx, b)
  if (!lote) return errorResponse('NOT_FOUND', TEXTOS_DO_PAINEL.loteDesconhecido)
  const resultado = await confirmarItensDoLote(ctx.db, lote.id, ctx.agora)
  if (!resultado) {
    // Outra confirmação chegou antes (no WhatsApp ou em outra aba) ou o lote venceu.
    await expirarLotes(ctx.db, ctx.agora, { tenantIds: [ctx.dono.id] })
    const vencido = lote.status === 'expirado' || (lote.status === 'aguardando_confirmacao' && lote.expires_at.getTime() <= ctx.agora.getTime())
    return errorResponse('LOTE_FECHADO', vencido ? TEXTOS_DO_PAINEL.loteVencido : TEXTOS_DO_PAINEL.loteFechado)
  }
  logEvent('nofiscal.painel_lote_confirmado', { tenant_id: ctx.dono.id, lote_id: lote.id, notas: resultado.emitindo, barradas: resultado.barradas.length })
  return json(200, {
    emitindo: resultado.emitindo,
    barradas: resultado.barradas.map((x) => ({ linha: x.linha, codigo: x.problema, motivo: motivoDoProblema(x.problema, { empresa: x.empresa }) })),
  })
}

async function loteDescartar(ctx: Contexto, b: Record<string, unknown>): Promise<Response> {
  const lote = await loteDaConta(ctx, b)
  if (!lote) return errorResponse('NOT_FOUND', TEXTOS_DO_PAINEL.loteDesconhecido)
  const { rowCount } = await ctx.db.query(
    `update nofiscal.fiscal_lotes set status = 'descartado', updated_at = $2 where id = $1 and status = 'aguardando_confirmacao'`,
    [lote.id, ctx.agora],
  )
  if (rowCount !== 1) return errorResponse('LOTE_FECHADO', TEXTOS_DO_PAINEL.loteFechado)
  logEvent('nofiscal.painel_lote_descartado', { tenant_id: ctx.dono.id, lote_id: lote.id })
  return json(200, { descartado: true })
}
