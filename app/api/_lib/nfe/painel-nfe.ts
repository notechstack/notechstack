// /api/v1/fiscal/nfe: a aba "NF-e" do painel "Minha conta" (conta Escritório). Mesma sessão e mesma posse da aba
// Emitir (painel-emissao.ts): login com e-mail confirmado, conta-mãe pelo `donoDoUsuario`, e toda empresa pedida tem de
// ser do dono.
//
// POST JSON (`acao`): `contexto` (empresas com dados de NF-e, bloqueio e franquia), `dados_salvar` (IE, endereço,
// série e próximo número), `listar`, `cancelar`, `corrigir` (CC-e) e `inutilizar`.
// POST multipart (`acao` = `planilha_ler` ou `planilha_emitir`, campo `arquivo`): ler confere e devolve o resumo; emitir
// põe na fila as notas sem problema. A chave de cada nota é `planilha:<cnpj>:<nota>:<sha256 do conteúdo da nota>`: a
// mesma nota (mesmo número na coluna `nota`, mesmo conteúdo) nunca sai duas vezes, mesmo que o arquivo mude. Uma nota do
// mês com o mesmo número na coluna `nota` e conteúdo diferente é recusada (planilha corrigida e mandada de novo).
// GET `?baixar=danfe|xml&nfe_id=<uuid>`: DANFE (gerado a cada pedido) ou o XML autorizado (`nfeProc`).
import { createHash } from 'node:crypto'
import type { Db } from '../db.js'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import { empresasDoDono, notasDoMes, tipoDaPlanilha } from '../agente/lote.js'
import { limitesDoMes, partesLocais } from '../agente/tempo.js'
import { planoDeEscritorio } from '../agente/planos.js'
import { donoDoUsuario, MAX_BYTES_DO_PAINEL } from '../painel-emissao.js'
import type { SessionVerifier } from '../session.js'
import type { Uf } from './autorizadores.js'
import { conferenciaDaEmpresa, conferirEmpresaNfe } from './conferencia.js'
import { renderDanfe } from './danfe.js'
import { MODALIDADES_FRETE, temTransportador, volumesDaNota, type ResponsavelTecnico } from './nfe-builder.js'
import type { SefazClient } from './sefaz-client.js'
import { lerPlanilhaNfe } from './planilha.js'
import {
  conferirPedido,
  criarNfe,
  DadosNfeInvalidos,
  empresaNfe,
  bloqueioNfe,
  pedirCancelamento,
  pedirCartaCorrecao,
  pedirInutilizacao,
  salvarDadosNfe,
  type PedidoNfe,
} from './servico.js'

export type PainelNfeDeps = {
  db: Db
  sessions: SessionVerifier
  now?: () => Date
  /** Sefaz para a conferência da empresa (consulta de cadastro e nota de teste); sem ela, `conferir` responde 503. */
  sefaz?: SefazClient
  responsavelTecnico?: ResponsavelTecnico | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const texto = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '')

/** O que o painel mostra para cada código de bloqueio da NF-e. */
export const MOTIVO_DO_BLOQUEIO: Record<string, string> = {
  TENANT_INACTIVE: 'a empresa está desativada',
  NFE_REGIME_NAO_SUPORTADO: 'por enquanto a NF-e é só para Simples Nacional e MEI',
  NFE_SEM_IE: 'falta a inscrição estadual',
  NFE_SEM_ENDERECO: 'falta o endereço da empresa',
  NFE_SEM_SERIE: 'falta a série e o próximo número da NF-e',
  NFE_CERT_MISSING: 'falta o certificado A1 da própria empresa (a NF-e não aceita procuração)',
  NFE_NAO_CONFERIDA: 'falta a conferência da empresa na Sefaz (clique em Conferir na Sefaz)',
  NFE_CONFERIR_DE_NOVO: 'o certificado, a IE ou a UF mudaram desde a última conferência; confira de novo na Sefaz',
  NFE_NAO_CREDENCIADA: 'a empresa não está credenciada para emitir NF-e na Sefaz do estado',
  NFE_IE_NAO_E_DO_CNPJ: 'a Sefaz não encontra a inscrição estadual neste CNPJ',
  NFE_IE_NAO_HABILITADA: 'a inscrição estadual não está habilitada na Sefaz',
  NFE_IE_INVALIDA: 'a Sefaz recusou a inscrição estadual',
  SEFAZ_INDISPONIVEL: 'a Sefaz não respondeu na última conferência; tente de novo',
  CERT_SEM_CNPJ: 'o certificado não é um e-CNPJ A1',
  CERT_EXPIRED: 'o certificado A1 venceu',
  NO_SUBSCRIPTION: 'a conta não tem assinatura',
  SUBSCRIPTION_CANCELLED: 'a assinatura foi cancelada',
  PAYMENT_NOT_APPROVED: 'o pagamento da assinatura não foi aprovado',
  CERT_DE_OUTRO_CNPJ: 'o certificado A1 é de outro CNPJ; a NF-e precisa do A1 da própria empresa',
}
export const motivoDoBloqueio = (codigo: string) => MOTIVO_DO_BLOQUEIO[codigo] ?? codigo

type Ctx = { deps: PainelNfeDeps; db: Db; dono: { id: string; plan: string; limite: number }; empresas: { id: string; cnpj: string; razao_social: string; active: boolean }[]; agora: Date }

/** A conta-mãe tem a NF-e entre os tipos de nota (nofiscal.tipos_nota_da_conta, migração 20261123210000). */
async function contaEmiteNfe(db: Db, donoId: string): Promise<boolean> {
  const { rows } = await db.query<{ tipos: string[] | null }>('select nofiscal.tipos_nota_da_conta($1) as tipos', [donoId])
  return (rows[0]?.tipos ?? []).includes('nfe')
}

export async function handlePainelNfe(request: Request, deps: PainelNfeDeps): Promise<Response> {
  try {
    const userId = await deps.sessions.userIdFrom(request)
    if (!userId) return errorResponse('UNAUTHORIZED', 'faça login para usar a NF-e')
    const dono = await donoDoUsuario(deps.db, userId)
    if (!dono) return errorResponse('CONTA_SEM_EMPRESA', 'Não achamos uma empresa nesta conta.')
    if (!planoDeEscritorio(dono.plan)) return errorResponse('SO_ESCRITORIO', 'A NF-e pelo painel é do plano Escritório.')
    // Planos por módulo (23/11/2026): a conta só emite NF-e com 'nfe' em fiscal_tenants.tipos_nota (o checkout grava).
    if (!(await contaEmiteNfe(deps.db, dono.id))) return errorResponse('NFE_NAO_CONTRATADA', 'A NF-e não está no seu plano. Para incluir, fale com a nó pelo WhatsApp.')
    const ctx: Ctx = { deps, db: deps.db, dono, empresas: await empresasDoDono(deps.db, dono.id), agora: (deps.now ?? (() => new Date()))() }

    if (request.method === 'GET') return baixar(ctx, new URL(request.url))
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou POST')
    if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) return planilha(ctx, request)

    let corpo: Record<string, unknown>
    try {
      const lido = (await request.json()) as unknown
      if (typeof lido !== 'object' || lido === null || Array.isArray(lido)) throw new Error()
      corpo = lido as Record<string, unknown>
    } catch {
      return errorResponse('INVALID_JSON', 'corpo JSON inválido')
    }
    switch (corpo.acao) {
      case 'contexto':
        return contexto(ctx)
      case 'dados_salvar':
        return dadosSalvar(ctx, corpo)
      case 'conferir':
        return conferir(ctx, corpo)
      case 'listar':
        return listar(ctx, corpo)
      case 'cancelar':
      case 'corrigir':
      case 'inutilizar':
        return evento(ctx, corpo.acao, corpo)
      default:
        return errorResponse('VALIDATION_FAILED', 'ação desconhecida')
    }
  } catch (error) {
    logEvent('nofiscal.painel_nfe_erro', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}

const daConta = (ctx: Ctx, id: string) => ctx.empresas.find((e) => e.id === id) ?? null

async function contexto(ctx: Ctx): Promise<Response> {
  const empresas = []
  for (const e of ctx.empresas) {
    const dados = await empresaNfe(ctx.db, e.id)
    const { rows } = await ctx.db.query<{ serie: number; next_number: string }>(
      'select serie, next_number from nofiscal.fiscal_nfe_series where tenant_id = $1 and ativa',
      [e.id],
    )
    const bloqueio = await bloqueioNfe(ctx.db, e.id)
    const conf = await conferenciaDaEmpresa(ctx.db, e.id)
    const { rows: cert } = await ctx.db.query<{ not_after: Date }>('select not_after from nofiscal.fiscal_certificates where tenant_id = $1', [e.id])
    // Reprovação da conferência: o texto dela diz o que houve e o que fazer.
    const motivo = bloqueio && conf?.codigo === bloqueio && conf.motivo ? conf.motivo : bloqueio ? motivoDoBloqueio(bloqueio) : null
    empresas.push({
      tenant_id: e.id,
      razao_social: e.razao_social,
      cnpj: e.cnpj,
      ambiente: dados?.ambiente === 'producao' ? 'producao' : 'homologacao',
      inscricao_estadual: dados?.inscricao_estadual ?? null,
      endereco: dados?.endereco ?? null,
      serie: rows[0]?.serie ?? null,
      proximo_numero: rows[0] ? Number(rows[0].next_number) : null,
      bloqueio: bloqueio ? { codigo: bloqueio, motivo } : null,
      modo_nfse: dados?.modo_autenticacao ?? null,
      certificado: cert[0] ? { not_after: cert[0].not_after } : null,
      crt: dados?.regime === 'mei' ? '4' : '1',
      conferencia: conf ? { status: conf.status, etapa: conf.etapa, codigo: conf.codigo, motivo: conf.motivo, conferida_em: conf.conferida_em } : null,
    })
  }
  return json(200, { empresas, franquia: { limite: ctx.dono.limite, no_mes: await notasDoMes(ctx.db, ctx.dono.id, ctx.agora) } })
}

async function conferir(ctx: Ctx, b: Record<string, unknown>): Promise<Response> {
  const empresa = daConta(ctx, texto(b.tenant_id))
  if (!empresa) return errorResponse('NOT_FOUND', 'Esta empresa não é da sua conta.')
  if (!ctx.deps.sefaz) return errorResponse('SEFIN_NOT_CONFIGURED', 'conferência indisponível agora')
  await conferirEmpresaNfe({ db: ctx.db, sefaz: ctx.deps.sefaz, now: () => ctx.agora, responsavelTecnico: ctx.deps.responsavelTecnico ?? null }, empresa.id)
  return contexto(ctx)
}

async function dadosSalvar(ctx: Ctx, b: Record<string, unknown>): Promise<Response> {
  const empresa = daConta(ctx, texto(b.tenant_id))
  if (!empresa) return errorResponse('NOT_FOUND', 'Esta empresa não é da sua conta.')
  const end = (typeof b.endereco === 'object' && b.endereco !== null ? b.endereco : {}) as Record<string, unknown>
  try {
    await salvarDadosNfe(ctx.db, empresa.id, {
      inscricaoEstadual: texto(b.inscricao_estadual),
      endereco: {
        logradouro: texto(end.logradouro),
        numero: texto(end.numero),
        complemento: texto(end.complemento) || null,
        bairro: texto(end.bairro),
        cep: texto(end.cep),
        uf: texto(end.uf).toUpperCase() as Uf,
        fone: texto(end.fone) || null,
      },
      serie: Number(texto(b.serie) || '1'),
      proximoNumero: Number(texto(b.proximo_numero) || '1'),
    })
  } catch (error) {
    if (error instanceof DadosNfeInvalidos) return errorResponse('VALIDATION_FAILED', error.problemas.join(' '), { problemas: error.problemas })
    throw error
  }
  logEvent('nofiscal.nfe_dados_salvos', { tenant_id: empresa.id })
  return contexto(ctx)
}

type LinhaDaLista = {
  id: string
  tenant_id: string
  status: string
  ambiente: string
  serie: number
  numero: string
  chave: string | null
  valor_total: string
  destinatario_nome: string
  destinatario_documento: string
  protocolo: string | null
  last_error_code: string | null
  last_error: string | null
  created_at: Date
  authorized_at: Date | null
  cces: string
}

async function listar(ctx: Ctx, b: Record<string, unknown>): Promise<Response> {
  const tenant = texto(b.tenant_id)
  if (tenant && !daConta(ctx, tenant)) return errorResponse('NOT_FOUND', 'Esta empresa não é da sua conta.')
  const ids = tenant ? [tenant] : ctx.empresas.map((e) => e.id)
  const { rows } = await ctx.db.query<LinhaDaLista>(
    `select n.id, n.tenant_id, n.status, n.ambiente, n.serie, n.numero, n.chave, n.valor_total, n.destinatario_nome,
            n.destinatario_documento, n.protocolo, n.last_error_code, n.last_error, n.created_at, n.authorized_at,
            (select count(*) from nofiscal.fiscal_nfe_eventos e where e.nfe_id = n.id and e.tipo = 'cce' and e.status = 'registrado') as cces
       from nofiscal.fiscal_nfe n
      where n.tenant_id = any($1::uuid[])
      order by n.created_at desc
      limit 200`,
    [ids],
  )
  return json(200, {
    notas: rows.map((n) => ({
      nfe_id: n.id,
      tenant_id: n.tenant_id,
      status: n.status,
      homologacao: n.ambiente === 'homologacao',
      serie: n.serie,
      numero: Number(n.numero),
      chave: n.chave,
      valor: n.valor_total,
      destinatario: n.destinatario_nome,
      documento: n.destinatario_documento,
      protocolo: n.protocolo,
      erro: n.last_error_code ? { codigo: n.last_error_code, motivo: n.last_error } : null,
      criada_em: n.created_at,
      autorizada_em: n.authorized_at,
      cartas_de_correcao: Number(n.cces),
    })),
  })
}

async function notaDaConta(ctx: Ctx, id: string): Promise<{ id: string; tenant_id: string; status: string; numero: string; xml_proc: string | null } | null> {
  if (!UUID.test(id)) return null
  const { rows } = await ctx.db.query<{ id: string; tenant_id: string; status: string; numero: string; xml_proc: string | null }>(
    'select id, tenant_id, status, numero, xml_proc from nofiscal.fiscal_nfe where id = $1',
    [id],
  )
  const n = rows[0]
  return n && daConta(ctx, n.tenant_id) ? n : null
}

async function evento(ctx: Ctx, acao: 'cancelar' | 'corrigir' | 'inutilizar', b: Record<string, unknown>): Promise<Response> {
  const nota = await notaDaConta(ctx, texto(b.nfe_id))
  if (!nota) return errorResponse('NOT_FOUND', 'nota não encontrada')
  const t = texto(b.texto)
  const r =
    acao === 'cancelar' ? await pedirCancelamento(ctx.db, nota.id, t)
    : acao === 'corrigir' ? await pedirCartaCorrecao(ctx.db, nota.id, t)
    : await pedirInutilizacao(ctx.db, nota.id, t)
  if (!r.ok) return errorResponse('VALIDATION_FAILED', r.mensagem)
  logEvent('nofiscal.nfe_evento_pedido', { nfe_id: nota.id, acao })
  return json(202, { pedido: true, evento_id: r.eventoId })
}

async function baixar(ctx: Ctx, url: URL): Promise<Response> {
  const nota = await notaDaConta(ctx, url.searchParams.get('nfe_id') ?? '')
  const tipo = url.searchParams.get('baixar')
  if (!nota || !nota.xml_proc || !['authorized', 'cancel_requested', 'cancelled', 'denied'].includes(nota.status)) {
    return errorResponse('NOT_FOUND', 'nota não encontrada')
  }
  if (tipo === 'xml') {
    return new Response(nota.xml_proc, {
      status: 200,
      headers: { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="nfe-${nota.numero}.xml"`, 'cache-control': 'no-store' },
    })
  }
  if (tipo !== 'danfe') return errorResponse('VALIDATION_FAILED', 'baixar=danfe ou baixar=xml')
  const pdf = await renderDanfe(nota.xml_proc, { cancelada: nota.status === 'cancelled' })
  return new Response(Buffer.from(pdf), {
    status: 200,
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="danfe-${nota.numero}.pdf"`, 'cache-control': 'no-store' },
  })
}

/** Uma linha para o resumo da planilha: modalidade, transportador e volumes (null sem nada de transporte). */
export function resumoDoTransporte(pedido: PedidoNfe): string | null {
  const t = temTransportador(pedido.transportador) ? pedido.transportador : null
  const vols = volumesDaNota(pedido)
  if (!t && !vols.length && (pedido.modalidadeFrete ?? '9') === '9') return null
  const partes = [MODALIDADES_FRETE[pedido.modalidadeFrete ?? '9'] ?? '']
  if (t) partes.push(t.nome || t.documento || 'transportador')
  for (const v of vols) {
    const peso = [v.pesoLiquido != null ? `líq. ${v.pesoLiquido} kg` : '', v.pesoBruto != null ? `bruto ${v.pesoBruto} kg` : ''].filter(Boolean).join(', ')
    partes.push([v.quantidade != null ? `${v.quantidade} vol.` : '', v.especie ?? '', peso].filter(Boolean).join(' '))
  }
  return partes.filter(Boolean).join(' · ')
}

async function planilha(ctx: Ctx, request: Request): Promise<Response> {
  const tamanho = Number(request.headers.get('content-length') ?? '0')
  if (tamanho > MAX_BYTES_DO_PAINEL + 64 * 1024) return errorResponse('PLANILHA_RECUSADA', 'A planilha passou de 4 MB. Divida em duas.')
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return errorResponse('PLANILHA_RECUSADA', 'Escolha a planilha (.xlsx ou .csv).')
  }
  const arquivo = form.get('arquivo')
  const acao = form.get('acao')
  if (!arquivo || typeof arquivo === 'string') return errorResponse('PLANILHA_RECUSADA', 'Escolha a planilha (.xlsx ou .csv).')
  const tipo = tipoDaPlanilha({ id: '', nome: arquivo.name, mime: arquivo.type } as never)
  if (tipo !== 'xlsx' && tipo !== 'csv') return errorResponse('PLANILHA_RECUSADA', 'Envie a planilha em .xlsx ou .csv.')
  if (arquivo.size > MAX_BYTES_DO_PAINEL) return errorResponse('PLANILHA_RECUSADA', 'A planilha passou de 4 MB. Divida em duas.')
  const conteudo = new Uint8Array(await arquivo.arrayBuffer())
  const lida = await lerPlanilhaNfe(conteudo, tipo)
  if (!lida.ok) return errorResponse('PLANILHA_RECUSADA', lida.mensagem)

  const porCnpj = new Map(ctx.empresas.map((e) => [e.cnpj, e]))
  const problemas = [...lida.problemas]
  const prontas: { nota: (typeof lida.notas)[number]; tenantId: string; valor: number; chave: string }[] = []
  const local = partesLocais(ctx.agora)
  const { inicio } = limitesDoMes(local.ano, local.mes)
  for (const nota of lida.notas) {
    const empresa = porCnpj.get(nota.cnpjEmitente)
    if (!empresa) {
      problemas.push({ linha: nota.linhas[0], nota: nota.nota, mensagem: `O CNPJ ${nota.cnpjEmitente} não é de uma empresa da conta.` })
      continue
    }
    const bloqueio = await bloqueioNfe(ctx.db, empresa.id)
    if (bloqueio) {
      problemas.push({ linha: nota.linhas[0], nota: nota.nota, mensagem: `${empresa.razao_social} não emite NF-e agora: ${motivoDoBloqueio(bloqueio)}.` })
      continue
    }
    const dados = (await empresaNfe(ctx.db, empresa.id))!
    const erros = conferirPedido(dados, nota.pedido, ctx.agora)
    if (erros.length) {
      for (const m of erros) problemas.push({ linha: nota.linhas[0], nota: nota.nota, mensagem: m })
      continue
    }
    // A chave leva o mês: a venda recorrente do mês seguinte, com o mesmo conteúdo, é outra nota.
    const mes = `${local.ano}${String(local.mes).padStart(2, '0')}`
    const prefixo = `planilha:${nota.cnpjEmitente}:${mes}:${nota.nota}:`
    let chave = prefixo + createHash('sha256').update(JSON.stringify(nota.pedido)).digest('hex').slice(0, 32)
    const { rows: ja } = await ctx.db.query<{ external_id: string; numero: string; status: string }>(
      `select external_id, numero, status from nofiscal.fiscal_nfe
        where tenant_id = $1 and left(external_id, length($2)) = $2 and created_at >= $3 and status in ('queued', 'sending', 'processing', 'authorized', 'cancel_requested')
        order by created_at desc limit 1`,
      [empresa.id, prefixo, inicio],
    )
    if (ja[0]) {
      problemas.push({
        linha: nota.linhas[0],
        nota: nota.nota,
        mensagem: ja[0].external_id === chave
          ? `esta nota já foi para a emissão neste mês (NF-e nº ${ja[0].numero}); não sai de novo.`
          : `a nota ${nota.nota} desta empresa já saiu neste mês (NF-e nº ${ja[0].numero}) com outro conteúdo. Para corrigir a que saiu, use a carta de correção ou cancele; para uma nota nova, use outro número na coluna "nota".`,
      })
      continue
    }
    // A mesma nota que já foi tentada e não valeu (rejeitada, inutilizada, cancelada, denegada): sai de novo, com a chave
    // numerada (a chave é única por empresa para sempre).
    const { rows: antes } = await ctx.db.query<{ n: string }>(
      `select count(*) as n from nofiscal.fiscal_nfe where tenant_id = $1 and (external_id = $2 or left(external_id, length($2) + 1) = $2 || ':')`,
      [empresa.id, chave],
    )
    if (Number(antes[0]?.n ?? 0) > 0) chave = `${chave}:${antes[0].n}`
    prontas.push({ nota, tenantId: empresa.id, valor: nota.pedido.pagamentos[0]?.valor ?? 0, chave })
  }
  const franquia = { limite: ctx.dono.limite, no_mes: await notasDoMes(ctx.db, ctx.dono.id, ctx.agora) }
  const resumo = {
    notas: prontas.map((p) => ({
      nota: p.nota.nota,
      cnpj: p.nota.cnpjEmitente,
      destinatario: p.nota.pedido.destinatario.nome,
      itens: p.nota.pedido.itens.length,
      valor: p.valor.toFixed(2),
      transporte: resumoDoTransporte(p.nota.pedido),
      avisos: p.nota.avisos,
    })),
    problemas,
    franquia,
  }
  if (acao !== 'planilha_emitir') return json(200, resumo)

  let emitidas = 0
  for (const p of prontas) {
    const r = await criarNfe(ctx.db, {
      tenantId: p.tenantId,
      externalId: p.chave,
      origem: 'planilha',
      pedido: p.nota.pedido,
      agora: ctx.agora,
    })
    if (r.ok && !r.jaExistia) emitidas++
    else if (r.ok) problemas.push({ linha: p.nota.linhas[0], nota: p.nota.nota, mensagem: `esta nota já foi para a emissão (NF-e nº ${r.numero}); não sai de novo.` })
    else problemas.push({ linha: p.nota.linhas[0], nota: p.nota.nota, mensagem: r.codigo === 'BLOQUEADA' ? motivoDoBloqueio(r.bloqueio) : r.problemas.join('; ') })
  }
  logEvent('nofiscal.nfe_planilha_emitida', { tenant_id: ctx.dono.id, notas: emitidas, problemas: problemas.length })
  return json(202, { ...resumo, emitindo: emitidas, problemas })
}
