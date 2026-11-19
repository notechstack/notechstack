// /api/v1/fiscal/guias: a aba "Guias" do painel "Minha conta" (conta Escritório com o módulo ligado). Sessão do site
// (Authorization: Bearer), conta-mãe por nofiscal.guias_conta_do_usuario (recusa conta sem o módulo) e cada pedido
// numa transação com a posse do usuário (comPosse). Nenhum PDF passa por aqui: o navegador sobe direto ao Storage
// pela URL assinada que `lote_arquivos` devolve. Nada é enviado sem `disparar`.
//
// POST JSON (`acao`): estado · contatos_listar · contato_salvar · contato_ativar · contatos_importar · lote_criar ·
// lote_arquivos · lote_confirmar · ler · lote_ver · lotes_listar · guia_editar · guia_cancelar · guia_marcar_paga ·
// disparar · acompanhar · regras_salvar. GET `?exportar=csv&mes=AAAA-MM`: o acompanhamento do mês em CSV.
import { randomUUID } from 'node:crypto'
import type { Db, Queryable } from '../db.js'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import type { SessionVerifier } from '../session.js'
import { cnpjValido, cpfValido } from '../agente/documentos.js'
import { normalizarEmail, normalizarTelefone } from '../agente/normalizacao.js'
import { lerLinha } from './codigos.js'
import { TIPOS_DE_GUIA, type LerGuiaDeps } from './leitura.js'
import { ROTULO_DO_TIPO } from './modelos.js'
import { atualizarLote, comPosse, lerCsvDeContatos, lerPendentes, validarContato } from './servico.js'
import { MAX_BYTES_DO_PDF, type ArmazemDeGuias } from './storage.js'

export type PainelGuiasDeps = {
  db: Db
  sessions: SessionVerifier
  storage: ArmazemDeGuias | null
  leitor: LerGuiaDeps
  now?: () => Date
}

export const MAX_ARQUIVOS_DO_LOTE = 500
/** URLs de upload por pedido (o navegador pede em blocos). */
export const MAX_URLS_POR_PEDIDO = 50
/** Guias lidas por pedido `ler` (o painel chama de novo até acabar; o worker lê o que sobrar). */
export const LEITURAS_POR_PEDIDO = 4

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MES = /^\d{4}-(0[1-9]|1[0-2])$/

type Ctx = { deps: PainelGuiasDeps; userId: string; conta: string; agora: Date }
type Corpo = Record<string, unknown>

class Recusa extends Error {
  constructor(readonly resposta: Response) {
    super('recusa')
  }
}
const recusar = (mensagem: string, extra: Record<string, unknown> = {}) => new Recusa(errorResponse('VALIDATION_FAILED', mensagem, extra))

export async function handlePainelGuias(request: Request, deps: PainelGuiasDeps): Promise<Response> {
  try {
    const userId = await deps.sessions.userIdFrom(request)
    if (!userId) return errorResponse('UNAUTHORIZED', 'faça login para usar as guias')
    const { rows } = await deps.db.query<{ conta: string | null }>('select nofiscal.guias_conta_do_usuario($1) as conta', [userId])
    const conta = rows[0]?.conta ?? null
    const ctx = conta ? { deps, userId, conta, agora: (deps.now ?? (() => new Date()))() } : null

    if (request.method === 'GET') {
      if (!ctx) return errorResponse('GUIAS_DESLIGADO', 'O módulo Guias não está ligado nesta conta.')
      return exportarCsv(ctx, new URL(request.url))
    }
    if (request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou POST')
    let corpo: Corpo
    try {
      const lido = (await request.json()) as unknown
      if (typeof lido !== 'object' || lido === null || Array.isArray(lido)) throw new Error()
      corpo = lido as Corpo
    } catch {
      return errorResponse('INVALID_JSON', 'corpo JSON inválido')
    }
    // Sem o módulo, a aba não aparece: o estado diz só isso, e todo o resto é recusado.
    if (corpo.acao === 'estado' && !ctx) return json(200, { ligado: false })
    if (!ctx) return errorResponse('GUIAS_DESLIGADO', 'O módulo Guias não está ligado nesta conta.')

    switch (corpo.acao) {
      case 'estado':
        return json(200, await estado(ctx))
      case 'contatos_listar':
        return json(200, await contatosListar(ctx))
      case 'contato_salvar':
        return json(200, await contatoSalvar(ctx, corpo))
      case 'contato_ativar':
        return json(200, await contatoAtivar(ctx, corpo))
      case 'contatos_importar':
        return json(200, await contatosImportar(ctx, corpo))
      case 'lote_criar':
        return json(200, await loteCriar(ctx, corpo))
      case 'lote_arquivos':
        return json(200, await loteArquivos(ctx, corpo))
      case 'lote_confirmar':
        return json(200, await loteConfirmar(ctx, corpo))
      case 'ler':
        return json(200, await ler(ctx, corpo))
      case 'lote_ver':
        return json(200, await loteVer(ctx, uuidDe(corpo.lote_id, 'lote')))
      case 'lotes_listar':
        return json(200, await lotesListar(ctx))
      case 'guia_editar':
        return json(200, await guiaEditar(ctx, corpo))
      case 'guia_cancelar':
        return json(200, await guiaMudar(ctx, corpo, 'cancelada'))
      case 'guia_marcar_paga':
        return json(200, await guiaMudar(ctx, corpo, 'paga'))
      case 'disparar':
        return json(200, await disparar(ctx, corpo))
      case 'acompanhar':
        return json(200, await acompanhar(ctx, corpo))
      case 'regras_salvar':
        return json(200, await regrasSalvar(ctx, corpo))
      default:
        return errorResponse('VALIDATION_FAILED', 'ação desconhecida')
    }
  } catch (error) {
    if (error instanceof Recusa) return error.resposta
    if (error instanceof Error && /GUIAS_DESLIGADO/.test(error.message)) return errorResponse('GUIAS_DESLIGADO', 'O módulo Guias não está ligado nesta conta.')
    if (error instanceof Error && /CONTATO_NAO_ENCONTRADO/.test(error.message)) return errorResponse('VALIDATION_FAILED', 'Contato não encontrado.')
    logEvent('guias.painel_erro', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}

const tx = <T>(ctx: Ctx, trabalho: (q: Queryable) => Promise<T>) => comPosse(ctx.deps.db, ctx.userId, trabalho)

function uuidDe(v: unknown, nome: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw recusar(`${nome} inválido`)
  return v
}

// ------------------------------------------------------------------ Estado e regras

export type Uso = { enviadas: number; limite: number; percentual: number; aviso: null | '80' | '100' }

export function avisoDoUso(enviadas: number, limite: number): Uso {
  const percentual = limite > 0 ? Math.round((enviadas / limite) * 100) : 0
  return { enviadas, limite, percentual, aviso: enviadas >= limite ? '100' : enviadas >= limite * 0.8 ? '80' : null }
}

async function usoDoMes(q: Queryable, conta: string, agora: Date): Promise<Uso> {
  const { rows } = await q.query<{ uso: { enviadas: number; limite: number } }>('select nofiscal.guias_uso_mes($1, $2) as uso', [conta, agora])
  const u = rows[0]?.uso ?? { enviadas: 0, limite: 0 }
  return avisoDoUso(Number(u.enviadas), Number(u.limite))
}

async function estado(ctx: Ctx) {
  return tx(ctx, async (q) => {
    const { rows } = await q.query<{ razao_social: string; lembrete_dias: number[]; hora_envio: number; email_alerta: string | null; assinatura: string; whatsapp_escritorio: string | null }>(
      `select t.razao_social, r.lembrete_dias, r.hora_envio, r.email_alerta, r.assinatura, r.whatsapp_escritorio
         from nofiscal.fiscal_tenants t left join nofiscal.guia_regras r on r.escritorio_tenant_id = t.id
        where t.id = $1`,
      [ctx.conta],
    )
    const r = rows[0]
    return {
      ligado: true,
      escritorio: r?.razao_social ?? '',
      uso: await usoDoMes(q, ctx.conta, ctx.agora),
      regras: {
        lembrete_dias: r?.lembrete_dias ?? [-1, 0],
        hora_envio: r?.hora_envio ?? 9,
        email_alerta: r?.email_alerta ?? null,
        assinatura: r?.assinatura ?? r?.razao_social ?? '',
        whatsapp_escritorio: r?.whatsapp_escritorio ?? null,
      },
      upload: ctx.deps.storage !== null,
      max_arquivos: MAX_ARQUIVOS_DO_LOTE,
    }
  })
}

async function regrasSalvar(ctx: Ctx, corpo: Corpo) {
  const assinatura = String(corpo.assinatura ?? '').replace(/\s+/g, ' ').trim()
  if (!assinatura || assinatura.length > 80) throw recusar('O nome do escritório nas mensagens tem de 1 a 80 caracteres.', { campo: 'assinatura' })
  const emailBruto = String(corpo.email_alerta ?? '').trim()
  const email = emailBruto ? normalizarEmail(emailBruto) : null
  if (emailBruto && !email) throw recusar('E-mail de alerta inválido.', { campo: 'email_alerta' })
  const foneBruto = String(corpo.whatsapp_escritorio ?? '').trim()
  const fone = foneBruto ? normalizarTelefone(foneBruto) : null
  if (foneBruto && !fone) throw recusar('WhatsApp do escritório inválido.', { campo: 'whatsapp_escritorio' })
  await tx(ctx, (q) =>
    q.query(
      `insert into nofiscal.guia_regras (escritorio_tenant_id, assinatura, email_alerta, whatsapp_escritorio)
       values ($1, $2, $3, $4)
       on conflict (escritorio_tenant_id) do update
         set assinatura = excluded.assinatura, email_alerta = excluded.email_alerta,
             whatsapp_escritorio = excluded.whatsapp_escritorio, updated_at = now()`,
      [ctx.conta, assinatura, email, fone],
    ),
  )
  return estado(ctx)
}

// ------------------------------------------------------------------ Contatos

type LinhaContato = {
  id: string; documento: string; nome: string; whatsapps: string[]; emails: string[]; aceite_em: Date | null; aceite_origem: string | null
  sair_whatsapp_em: Date | null; sair_email_em: Date | null; ativo: boolean
}

async function contatosListar(ctx: Ctx) {
  const { rows } = await tx(ctx, (q) =>
    q.query<LinhaContato>(
      `select id, documento, nome, whatsapps, emails, aceite_em, aceite_origem, sair_whatsapp_em, sair_email_em, ativo
         from nofiscal.guia_contatos where escritorio_tenant_id = $1 order by ativo desc, nome`,
      [ctx.conta],
    ),
  )
  return { contatos: rows }
}

function aceiteDe(corpo: Corpo, agora: Date): { aceite_em?: string; aceite_origem?: string } {
  const origem = String(corpo.aceite_origem ?? '').replace(/\s+/g, ' ').trim()
  if (!origem) return {}
  if (origem.length > 200) throw recusar('A origem do aceite tem até 200 caracteres.', { campo: 'aceite_origem' })
  const data = String(corpo.aceite_em ?? '').trim()
  const quando = /^\d{4}-\d{2}-\d{2}$/.test(data) ? new Date(`${data}T12:00:00-03:00`) : agora
  if (Number.isNaN(quando.getTime()) || quando.getTime() > agora.getTime() + 86_400_000) throw recusar('Data do aceite inválida.', { campo: 'aceite_em' })
  return { aceite_em: quando.toISOString(), aceite_origem: origem }
}

async function contatoSalvar(ctx: Ctx, corpo: Corpo) {
  const bruto = (typeof corpo.contato === 'object' && corpo.contato !== null ? corpo.contato : {}) as Corpo
  const v = validarContato(bruto)
  if (!v.ok) throw recusar(v.motivo)
  if (v.contato.id !== undefined) uuidDe(v.contato.id, 'contato')
  const dados = { ...v.contato, ...aceiteDe(bruto, ctx.agora) }
  const id = await tx(ctx, async (q) => {
    const { rows } = await q.query<{ id: string }>('select nofiscal.guias_contato_salvar($1, $2::jsonb) as id', [ctx.userId, JSON.stringify(dados)])
    await recontarLotes(q, ctx.conta)
    return rows[0].id
  })
  return { id }
}

async function contatoAtivar(ctx: Ctx, corpo: Corpo) {
  const id = uuidDe(corpo.id, 'contato')
  if (typeof corpo.ativo !== 'boolean') throw recusar('informe ativo')
  await tx(ctx, (q) => q.query('select nofiscal.guias_contato_salvar($1, $2::jsonb)', [ctx.userId, JSON.stringify({ id, ativo: corpo.ativo })]))
  return { id, ativo: corpo.ativo }
}

async function contatosImportar(ctx: Ctx, corpo: Corpo) {
  if (typeof corpo.csv !== 'string' || !corpo.csv.trim()) throw recusar('Envie o conteúdo do CSV.')
  if (corpo.csv.length > 2_000_000) throw recusar('O CSV passa de 2 MB.')
  const aceite = aceiteDe(corpo, ctx.agora)
  const { linhas, erroGeral } = lerCsvDeContatos(corpo.csv)
  if (erroGeral && !linhas.length) throw recusar(erroGeral)
  const erros = linhas.filter((l) => l.erro).map((l) => ({ linha: l.linha, motivo: l.erro }))
  // O mesmo documento duas vezes no arquivo: vale a última linha, e as anteriores são apontadas.
  const porDocumento = new Map<string, number>()
  for (const l of linhas) if (l.contato) porDocumento.set(l.contato.documento, l.linha)
  const validas = linhas.filter((l) => l.contato && porDocumento.get(l.contato.documento) === l.linha)
  for (const l of linhas) {
    if (l.contato && porDocumento.get(l.contato.documento) !== l.linha) {
      erros.push({ linha: l.linha, motivo: `documento repetido; vale a linha ${porDocumento.get(l.contato.documento)}` })
    }
  }
  const importados = await tx(ctx, async (q) => {
    let n = 0
    for (const l of validas) {
      await q.query('select nofiscal.guias_contato_salvar($1, $2::jsonb)', [ctx.userId, JSON.stringify({ ...l.contato, ...aceite })])
      n++
    }
    await recontarLotes(q, ctx.conta)
    return n
  })
  erros.sort((a, b) => a.linha - b.linha)
  return { importados, erros, ...(erroGeral ? { aviso: erroGeral } : {}) }
}

/** Contato novo ou editado muda a cor das guias em conferência: os contadores dos lotes acompanham. */
async function recontarLotes(q: Queryable, conta: string) {
  const { rows } = await q.query<{ id: string }>(
    `select id from nofiscal.guia_lotes where escritorio_tenant_id = $1 and status in ('lendo', 'conferir')`,
    [conta],
  )
  for (const r of rows) await atualizarLote(q, r.id)
}

// ------------------------------------------------------------------ Lote: upload direto ao Storage e leitura

async function loteCriar(ctx: Ctx, corpo: Corpo) {
  if (!ctx.deps.storage) throw new Recusa(errorResponse('STORAGE_NAO_CONFIGURADO', 'O envio de PDFs não está configurado.'))
  const total = Number(corpo.total)
  if (!Number.isInteger(total) || total < 1 || total > MAX_ARQUIVOS_DO_LOTE) {
    throw recusar(`Um lote tem de 1 a ${MAX_ARQUIVOS_DO_LOTE} PDFs.`)
  }
  const id = await tx(ctx, async (q) => (await q.query<{ id: string }>('select nofiscal.guias_lote_criar($1, $2) as id', [ctx.userId, total])).rows[0].id)
  return { lote_id: id }
}

const nomeDoPdf = (v: unknown) => {
  const nome = String(v ?? '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200)
  return nome || 'guia.pdf'
}

async function loteArquivos(ctx: Ctx, corpo: Corpo) {
  const storage = ctx.deps.storage
  if (!storage) throw new Recusa(errorResponse('STORAGE_NAO_CONFIGURADO', 'O envio de PDFs não está configurado.'))
  const loteId = uuidDe(corpo.lote_id, 'lote')
  const arquivos = Array.isArray(corpo.arquivos) ? (corpo.arquivos as unknown[]) : []
  if (!arquivos.length || arquivos.length > MAX_URLS_POR_PEDIDO) throw recusar(`Envie de 1 a ${MAX_URLS_POR_PEDIDO} arquivos por pedido.`)
  const lidos = arquivos.map((a, i) => {
    const o = (typeof a === 'object' && a !== null ? a : {}) as Corpo
    const nome = nomeDoPdf(o.nome)
    const tamanho = Number(o.tamanho)
    if (!/\.pdf$/i.test(nome)) throw recusar(`O arquivo ${i + 1} (${nome}) não é PDF.`)
    if (!Number.isFinite(tamanho) || tamanho <= 0 || tamanho > MAX_BYTES_DO_PDF) throw recusar(`O arquivo ${nome} passa de 10 MB.`)
    return { nome }
  })
  const criadas = await tx(ctx, async (q) => {
    const { rows } = await q.query<{ total_arquivos: number; ja: number }>(
      `select l.total_arquivos, (select count(*)::int from nofiscal.guias g where g.lote_id = l.id) as ja
         from nofiscal.guia_lotes l where l.id = $1 and l.escritorio_tenant_id = $2 and l.status = 'enviando'`,
      [loteId, ctx.conta],
    )
    if (!rows[0]) throw recusar('Lote não encontrado ou já fechado.')
    if (rows[0].ja + lidos.length > rows[0].total_arquivos) throw recusar('Mais arquivos do que o lote declarou.')
    const saida: { guia_id: string; nome: string; caminho: string }[] = []
    for (const a of lidos) {
      const caminho = `${ctx.conta}/${loteId}/${randomUUID()}.pdf`
      const { rows: g } = await q.query<{ id: string }>(
        `insert into nofiscal.guias (escritorio_tenant_id, lote_id, pdf_path, pdf_nome, status, created_at)
         values ($1, $2, $3, $4, 'enviando', clock_timestamp()) returning id`,
        [ctx.conta, loteId, caminho, a.nome],
      )
      saida.push({ guia_id: g[0].id, nome: a.nome, caminho })
    }
    return saida
  })
  const urls = []
  for (const c of criadas) urls.push({ guia_id: c.guia_id, nome: c.nome, url: await storage.urlDeUpload(c.caminho) })
  return { arquivos: urls }
}

async function loteConfirmar(ctx: Ctx, corpo: Corpo) {
  const loteId = uuidDe(corpo.lote_id, 'lote')
  const ids = (Array.isArray(corpo.guia_ids) ? corpo.guia_ids : []).filter((x): x is string => typeof x === 'string' && UUID.test(x))
  return tx(ctx, async (q) => {
    const { rowCount } = await q.query(
      `update nofiscal.guias set status = 'lendo', updated_at = now()
        where lote_id = $1 and escritorio_tenant_id = $2 and status = 'enviando' and id = any($3::uuid[])`,
      [loteId, ctx.conta, ids],
    )
    // O que não subiu (falha de rede no navegador) sai do lote; o lote só aceita arquivos enquanto está 'enviando'.
    if (corpo.fim === true) {
      await q.query(`delete from nofiscal.guias where lote_id = $1 and escritorio_tenant_id = $2 and status = 'enviando'`, [loteId, ctx.conta])
      await q.query(
        `update nofiscal.guia_lotes set status = 'lendo', total_arquivos = greatest(1, (select count(*) from nofiscal.guias g where g.lote_id = $1))
          where id = $1 and escritorio_tenant_id = $2 and status = 'enviando'`,
        [loteId, ctx.conta],
      )
      await atualizarLote(q, loteId)
    }
    return { confirmadas: rowCount }
  })
}

async function ler(ctx: Ctx, corpo: Corpo) {
  const loteId = uuidDe(corpo.lote_id, 'lote')
  if (!ctx.deps.storage) throw new Recusa(errorResponse('STORAGE_NAO_CONFIGURADO', 'O envio de PDFs não está configurado.'))
  const lidas = await lerPendentes(
    { executar: (t) => tx(ctx, t), storage: ctx.deps.storage, leitor: ctx.deps.leitor, now: ctx.deps.now },
    { loteId, limite: LEITURAS_POR_PEDIDO },
  )
  const { rows } = await tx(ctx, (q) =>
    q.query<{ pendentes: number }>(`select count(*)::int as pendentes from nofiscal.guias where lote_id = $1 and status = 'lendo'`, [loteId]),
  )
  return { lidas, pendentes: rows[0]?.pendentes ?? 0 }
}

type LinhaGuia = {
  id: string; lote_id: string; tipo: string | null; documento: string | null; competencia: string | null; valor_centavos: string | null
  vencimento: string | null; linha_digitavel: string | null; pdf_nome: string; status: string; agendada_para: Date | null
  enviada_em: Date | null; pago_em: Date | null; pago_origem: string | null; baixada_em: Date | null; leitura: Record<string, unknown>
  ultima_resposta: string | null; ultima_resposta_em: Date | null; cor: string | null; contato_id: string | null; contato_nome: string | null
  contato_whatsapps: string[] | null; contato_emails: string[] | null; envios: { canal: string; destino: string; motivo: string; status: string; erro: string | null }[] | null
}

const COLUNAS_DA_GUIA = `
  g.id, g.lote_id, g.tipo, g.documento, to_char(g.competencia, 'YYYY-MM') as competencia, g.valor_centavos::text,
  to_char(g.vencimento, 'YYYY-MM-DD') as vencimento, g.linha_digitavel, g.pdf_nome, g.status, g.agendada_para, g.enviada_em,
  g.pago_em, g.pago_origem, g.baixada_em, g.leitura, g.ultima_resposta, g.ultima_resposta_em,
  case when g.status in ('lendo', 'enviando') then null else nofiscal.guia_cor(g.id) end as cor,
  c.id as contato_id, c.nome as contato_nome, c.whatsapps as contato_whatsapps, c.emails as contato_emails,
  (select jsonb_agg(jsonb_build_object('canal', e.canal, 'destino', e.destino, 'motivo', e.motivo, 'status', e.status, 'erro', e.erro)
                    order by e.created_at)
     from nofiscal.guia_envios e where e.guia_id = g.id) as envios`

function visaoDaGuia(g: LinhaGuia) {
  const leitura = g.leitura ?? {}
  const motivo =
    g.cor === 'vermelho'
      ? g.contato_id ? 'contato sem WhatsApp nem e-mail ativos' : g.documento ? 'CNPJ/CPF sem contato cadastrado' : 'não achei o CNPJ/CPF'
      : g.cor === 'amarelo'
        ? leitura.valor_divergente ? 'o valor do PDF não bate com o do código de barras' : `faltou: ${((leitura.faltando as string[]) ?? []).join(', ') || 'campo'}`
        : null
  return {
    id: g.id,
    lote_id: g.lote_id,
    arquivo: g.pdf_nome,
    tipo: g.tipo,
    tipo_rotulo: g.tipo ? ROTULO_DO_TIPO[g.tipo as keyof typeof ROTULO_DO_TIPO] : null,
    documento: g.documento,
    competencia: g.competencia,
    valor_centavos: g.valor_centavos === null ? null : Number(g.valor_centavos),
    vencimento: g.vencimento,
    linha_digitavel: g.linha_digitavel,
    status: g.status,
    cor: g.cor,
    motivo,
    agendada_para: g.agendada_para,
    enviada_em: g.enviada_em,
    baixada_em: g.baixada_em,
    pago_em: g.pago_em,
    pago_origem: g.pago_origem,
    ultima_resposta: g.ultima_resposta,
    ultima_resposta_em: g.ultima_resposta_em,
    origem: leitura.origem ?? {},
    valor_codigo_barras: leitura.valor_codigo_barras ?? null,
    contato: g.contato_id ? { id: g.contato_id, nome: g.contato_nome, whatsapps: g.contato_whatsapps ?? [], emails: g.contato_emails ?? [] } : null,
    envios: g.envios ?? [],
  }
}

async function loteVer(ctx: Ctx, loteId: string) {
  return tx(ctx, async (q) => {
    const { rows: lote } = await q.query<Record<string, unknown>>(
      `select id, total_arquivos, lidos, com_problema, status, criado_em from nofiscal.guia_lotes where id = $1 and escritorio_tenant_id = $2`,
      [loteId, ctx.conta],
    )
    if (!lote[0]) throw recusar('Lote não encontrado.')
    const { rows } = await q.query<LinhaGuia>(
      `select ${COLUNAS_DA_GUIA} from nofiscal.guias g left join nofiscal.guia_contatos c on c.id = g.contato_id
        where g.lote_id = $1 order by g.created_at`,
      [loteId],
    )
    return { lote: lote[0], guias: rows.map(visaoDaGuia) }
  })
}

async function lotesListar(ctx: Ctx) {
  const { rows } = await tx(ctx, (q) =>
    q.query(
      `select id, total_arquivos, lidos, com_problema, status, criado_em from nofiscal.guia_lotes
        where escritorio_tenant_id = $1 and status <> 'cancelado' order by criado_em desc limit 20`,
      [ctx.conta],
    ),
  )
  return { lotes: rows }
}

// ------------------------------------------------------------------ Conferência

function campoDeData(v: unknown, nome: string): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  const d = m ? new Date(`${s}T00:00:00Z`) : null
  if (!m || !d || Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) throw recusar(`${nome} inválido`, { campo: nome })
  return s
}

async function guiaEditar(ctx: Ctx, corpo: Corpo) {
  const id = uuidDe(corpo.guia_id, 'guia')
  const c = (typeof corpo.campos === 'object' && corpo.campos !== null ? corpo.campos : {}) as Corpo
  const sets: string[] = []
  const valores: unknown[] = [id, ctx.conta]
  const origem: Record<string, string> = {}
  const por = (coluna: string, valor: unknown, cast = '') => {
    valores.push(valor)
    sets.push(`${coluna} = $${valores.length}${cast}`)
    origem[coluna] = 'manual'
  }
  if ('tipo' in c) {
    const t = String(c.tipo ?? '')
    if (t && !(TIPOS_DE_GUIA as readonly string[]).includes(t)) throw recusar('tipo inválido', { campo: 'tipo' })
    por('tipo', t || null)
  }
  if ('documento' in c) {
    const d = String(c.documento ?? '').replace(/\D/g, '')
    if (d && !(d.length === 14 ? cnpjValido(d) : d.length === 11 && cpfValido(d))) throw recusar('CNPJ ou CPF inválido', { campo: 'documento' })
    por('documento', d || null)
  }
  if ('competencia' in c) {
    const s = String(c.competencia ?? '').trim()
    if (s && !MES.test(s)) throw recusar('competência inválida (AAAA-MM)', { campo: 'competencia' })
    por('competencia', s ? `${s}-01` : null, '::date')
  }
  if ('valor' in c) {
    const s = String(c.valor ?? '').trim().replace(/\./g, '').replace(',', '.')
    const n = s ? Math.round(Number(s) * 100) : null
    if (n !== null && (!Number.isFinite(n) || n <= 0 || n > 99999999999)) throw recusar('valor inválido', { campo: 'valor' })
    por('valor_centavos', n)
  }
  if ('vencimento' in c) por('vencimento', campoDeData(c.vencimento, 'vencimento'), '::date')
  if ('linha_digitavel' in c) {
    const s = String(c.linha_digitavel ?? '').replace(/\D/g, '')
    if (s && !lerLinha(s, ctx.agora)) throw recusar('Linha digitável inválida (confira os dígitos).', { campo: 'linha_digitavel' })
    por('linha_digitavel', s || null)
  }
  if (!sets.length) throw recusar('nada para mudar')
  // Valor editado = o escritório conferiu: a divergência com o código de barras sai.
  const tirarDivergencia = 'valor_centavos' in origem
  valores.push(JSON.stringify(origem))
  const iOrigem = valores.length
  await tx(ctx, async (q) => {
    const { rowCount } = await q.query(
      `update nofiscal.guias g set ${sets.join(', ')},
              leitura = jsonb_set(${tirarDivergencia ? `(g.leitura - 'valor_divergente')` : 'g.leitura'}, '{origem}',
                                  coalesce(g.leitura -> 'origem', '{}'::jsonb) || $${iOrigem}::jsonb),
              updated_at = now()
        where g.id = $1 and g.escritorio_tenant_id = $2 and g.status in ('conferir', 'falhou')`,
      valores,
    )
    if (!rowCount) throw recusar('Só dá para editar guia em conferência.')
    await q.query(
      `update nofiscal.guias g
          set contato_id = (select c.id from nofiscal.guia_contatos c
                             where c.escritorio_tenant_id = g.escritorio_tenant_id and c.documento = g.documento and c.ativo)
        where g.id = $1`,
      [id],
    )
    const { rows } = await q.query<{ lote_id: string }>('select lote_id from nofiscal.guias where id = $1', [id])
    await atualizarLote(q, rows[0].lote_id)
  })
  return guiaVer(ctx, id)
}

async function guiaVer(ctx: Ctx, id: string) {
  const { rows } = await tx(ctx, (q) =>
    q.query<LinhaGuia>(
      `select ${COLUNAS_DA_GUIA} from nofiscal.guias g left join nofiscal.guia_contatos c on c.id = g.contato_id where g.id = $1`,
      [id],
    ),
  )
  if (!rows[0]) throw recusar('Guia não encontrada.')
  return { guia: visaoDaGuia(rows[0]) }
}

async function guiaMudar(ctx: Ctx, corpo: Corpo, para: 'cancelada' | 'paga') {
  const id = uuidDe(corpo.guia_id, 'guia')
  const permitidos = para === 'cancelada' ? ['conferir', 'agendada', 'falhou'] : ['enviada', 'entregue', 'lida', 'baixada', 'paga_informada', 'falhou']
  const { rowCount } = await tx(ctx, (q) =>
    q.query(
      `update nofiscal.guias set status = $3, updated_at = now(),
              pago_em = case when $3 = 'paga' then coalesce(pago_em, now()) else pago_em end,
              pago_origem = case when $3 = 'paga' then coalesce(pago_origem, 'escritorio') else pago_origem end
        where id = $1 and escritorio_tenant_id = $2 and status = any($4::text[])`,
      [id, ctx.conta, para, permitidos],
    ),
  )
  if (!rowCount) throw recusar(para === 'cancelada' ? 'Só dá para cancelar guia que ainda não saiu.' : 'Só dá para marcar como paga uma guia enviada.')
  return guiaVer(ctx, id)
}

async function disparar(ctx: Ctx, corpo: Corpo) {
  const ids = (Array.isArray(corpo.guia_ids) ? corpo.guia_ids : []).filter((x): x is string => typeof x === 'string' && UUID.test(x))
  if (!ids.length || ids.length > MAX_ARQUIVOS_DO_LOTE) throw recusar('Escolha as guias para disparar.')
  let quando: Date | null = null
  if (corpo.quando !== null && corpo.quando !== undefined && corpo.quando !== '') {
    quando = new Date(String(corpo.quando))
    if (Number.isNaN(quando.getTime())) throw recusar('Data e hora do agendamento inválidas.', { campo: 'quando' })
    if (quando.getTime() > ctx.agora.getTime() + 60 * 86_400_000) throw recusar('Agende para os próximos 60 dias.', { campo: 'quando' })
  }
  const r = await tx(ctx, async (q) => {
    const { rows } = await q.query<{ r: { agendadas: number; recusadas: number } }>('select nofiscal.guias_disparar($1, $2::uuid[], $3) as r', [ctx.userId, ids, quando])
    return rows[0].r
  })
  logEvent('guias.disparo_pedido', { conta: ctx.conta, agendadas: r.agendadas, recusadas: r.recusadas, agendado: quando !== null })
  return { ...r, quando: quando ? quando.toISOString() : null, uso: await tx(ctx, (q) => usoDoMes(q, ctx.conta, ctx.agora)) }
}

// ------------------------------------------------------------------ Acompanhar e CSV

function limitesDoMes(mes: string): { ini: string; fim: string } {
  const [a, m] = mes.split('-').map(Number)
  const prox = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`
  return { ini: `${mes}-01T00:00:00-03:00`, fim: `${prox}-01T00:00:00-03:00` }
}

async function guiasDoMes(ctx: Ctx, mes: string) {
  const { ini, fim } = limitesDoMes(mes)
  const { rows } = await tx(ctx, (q) =>
    q.query<LinhaGuia>(
      `select ${COLUNAS_DA_GUIA} from nofiscal.guias g left join nofiscal.guia_contatos c on c.id = g.contato_id
        where g.escritorio_tenant_id = $1
          and g.status not in ('enviando', 'lendo', 'conferir')
          and coalesce(g.enviada_em, g.agendada_para, g.updated_at) >= $2::timestamptz
          and coalesce(g.enviada_em, g.agendada_para, g.updated_at) < $3::timestamptz
        order by coalesce(g.enviada_em, g.agendada_para) desc nulls last, g.created_at desc
        limit 5000`,
      [ctx.conta, ini, fim],
    ),
  )
  return rows.map(visaoDaGuia)
}

const mesDe = (v: unknown, agora: Date) => {
  const s = String(v ?? '')
  if (MES.test(s)) return s
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(agora)
  return p.slice(0, 7)
}

async function acompanhar(ctx: Ctx, corpo: Corpo) {
  const mes = mesDe(corpo.mes, ctx.agora)
  const guias = await guiasDoMes(ctx, mes)
  return { mes, guias, uso: await tx(ctx, (q) => usoDoMes(q, ctx.conta, ctx.agora)) }
}

/** Situação de um canal na linha do acompanhamento: a melhor marca dos envios daquele canal. */
export function situacaoDoCanal(envios: { canal: string; status: string }[], canal: string): string {
  const doCanal = envios.filter((e) => e.canal === canal)
  if (!doCanal.length) return ''
  for (const s of ['lida', 'entregue', 'enviada', 'pendente', 'falhou']) if (doCanal.some((e) => e.status === s)) return s
  return doCanal[0].status
}

const celula = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  // Fórmula no Excel nunca: célula que começa com = + - @ ganha um apóstrofo.
  const seguro = /^[=+\-@]/.test(s) ? `'${s}` : s
  return /[",;\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro
}

async function exportarCsv(ctx: Ctx, url: URL): Promise<Response> {
  if (url.searchParams.get('exportar') !== 'csv') return errorResponse('VALIDATION_FAILED', 'use ?exportar=csv&mes=AAAA-MM')
  const mes = mesDe(url.searchParams.get('mes'), ctx.agora)
  const guias = await guiasDoMes(ctx, mes)
  const cab = ['cliente', 'documento', 'tipo', 'competencia', 'valor', 'vencimento', 'status', 'whatsapp', 'email', 'enviada_em', 'baixada_em', 'pago_em', 'pago_origem', 'ultima_resposta', 'arquivo']
  const linhas = guias.map((g) =>
    [
      g.contato?.nome, g.documento, g.tipo_rotulo, g.competencia, g.valor_centavos === null ? '' : (g.valor_centavos / 100).toFixed(2).replace('.', ','),
      g.vencimento, g.status, situacaoDoCanal(g.envios, 'whatsapp'), situacaoDoCanal(g.envios, 'email'),
      g.enviada_em ? new Date(g.enviada_em).toISOString() : '', g.baixada_em ? new Date(g.baixada_em).toISOString() : '',
      g.pago_em ? new Date(g.pago_em).toISOString() : '', g.pago_origem, g.ultima_resposta, g.arquivo,
    ].map(celula).join(';'),
  )
  const corpo = '﻿' + [cab.join(';'), ...linhas].join('\r\n') + '\r\n'
  return new Response(corpo, {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="guias-${mes}.csv"`, 'cache-control': 'no-store' },
  })
}
