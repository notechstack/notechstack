// Ver uma nota pelo WhatsApp (Lucca, 05/11/2026): "nota 123" (ou "pdf 123") manda o PDF da nota nº 123; "nota Maria"
// procura, nos últimos 2 meses, as notas para um cliente com esse nome. Vale para qualquer conta; a conta-mãe de um
// escritório vê as notas de todas as empresas dela (`nofiscal.empresas_do_dono`), as outras só as próprias. Lido por
// código, sem a IA, antes do intérprete. O número é o que a pessoa lê (`numeroDaNota`: nNFSe do XML, senão o da DPS).
// Para não roubar pedidos ("nota pra Studio Lima, 350 reais", "nota 350 reais pra Ana"), o comando só vale quando a
// mensagem é exatamente "nota <número>" (com o CNPJ ou o nome da empresa depois, no escritório) ou "nota <nome>" sem
// algarismo e sem preposição na frente.
import { renderDanfse } from '../danfse-renderer.js'
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { saiuComRetentativa } from './canais.js'
import { responder, semAcento, type Contexto } from './conversa.js'
import { formatarDocumento, formatarReais } from './documentos.js'
import { registrarEntrega } from './entregas.js'
import { planoDeEscritorio } from './planos.js'
import { dataBr, limitesDoMes, partesLocais } from './tempo.js'

export const MAX_NA_LISTA = 10

/** Palavras que, logo depois de "nota", indicam um pedido de emissão e não uma busca. */
const NAO_E_NOME = new Set(['pra', 'para', 'pro', 'p/', 'de', 'do', 'da', 'dos', 'das', 'a', 'ao', 'as', 'aos', 'em', 'no', 'na', 'nos', 'nas', 'fiscal', 'nova', 'e', 'com'])

export type PedidoDeNota = { tipo: 'numero'; numero: string; empresa: string | null } | { tipo: 'nome'; nome: string }

/** "nota 123", "pdf nº 123", "nota 123 12.345.678/0001-95", "nota Maria Silva" → o que buscar; o resto → null. */
export function lerPedidoDeNota(texto: string): PedidoDeNota | null {
  // "nota"/"pdf" sem diferença de caixa ou acento ("Nóta 12"); o resto vem como foi escrito.
  const m = /^(\S+)\s+(.+)$/.exec(texto.replace(/\s+/g, ' ').trim())
  if (!m || !/^(nota|pdf)$/.test(semAcento(m[1]))) return null
  const arg = m[2].replace(/[.!?]+$/, '').trim()
  if (!arg) return null
  const numero = /^(?:n[º°o]?\.?\s*|n[uú]mero\s+)?(\d{1,15})(?:\s+(.+))?$/i.exec(arg)
  if (numero) return { tipo: 'numero', numero: String(BigInt(numero[1])), empresa: numero[2]?.trim() || null }
  if (/\d/.test(arg)) return null
  const palavras = semAcento(arg).split(' ')
  if (palavras.length > 6 || NAO_E_NOME.has(palavras[0]) || semAcento(arg).replace(/[^a-z]/g, '').length < 2) return null
  return { tipo: 'nome', nome: arg }
}

type NotaAchada = {
  id: string
  tenant_id: string
  numero: string
  status: string
  issued_at: Date
  nome: string | null
  valor: string | null
  razao_social: string
  cnpj: string
  do_escritorio: boolean
}

// O mesmo número que `numeroDaNota` mostra: o nNFSe do XML (com ou sem prefixo de namespace), senão o da DPS.
const NUMERO_SQL = `coalesce(substring(i.xml_nfse from '<(?:[A-Za-z0-9_]+:)?nNFSe>([0-9]+)</'), i.dps_numero::text)`
const COLUNAS = `i.id, i.tenant_id, ${NUMERO_SQL} as numero, i.status, i.issued_at,
                 i.payload->'tomador'->>'nome' as nome, i.payload->>'valor' as valor,
                 t.razao_social, t.cnpj, t.escritorio_tenant_id is not null as do_escritorio`

type Escopo = { tenantIds: string[]; escritorio: boolean; empresas: { id: string; cnpj: string; razao_social: string }[] }

/** Conta-mãe de escritório: todas as empresas do dono; as demais contas: só o próprio tenant. */
async function escopoDoTelefone(db: Queryable, tenantId: string): Promise<Escopo> {
  const { rows } = await db.query<{ dono: string; plan: string }>(
    `select d.id as dono, d.plan from nofiscal.fiscal_tenants t
       join nofiscal.fiscal_tenants d on d.id = coalesce(t.escritorio_tenant_id, t.id)
      where t.id = $1`,
    [tenantId],
  )
  if (!rows[0] || !planoDeEscritorio(rows[0].plan)) return { tenantIds: [tenantId], escritorio: false, empresas: [] }
  const { rows: empresas } = await db.query<{ id: string; cnpj: string; razao_social: string }>(
    `select t.id, t.cnpj, t.razao_social from nofiscal.fiscal_tenants t
      where t.id in (select nofiscal.empresas_do_dono($1)) order by t.razao_social`,
    [rows[0].dono],
  )
  return { tenantIds: empresas.map((e) => e.id), escritorio: true, empresas }
}

const STATUS_VISIVEIS = `('issued', 'cancel_requested', 'cancelled')`

const linhaDaNota = (n: NotaAchada, escritorio: boolean) =>
  [
    `Nota ${n.numero}`,
    n.nome ?? 'tomador',
    n.valor ? formatarReais(n.valor) : '-',
    ...(escritorio ? [n.razao_social] : []),
    ...(n.status === 'cancelled' ? ['cancelada'] : []),
  ].join(' · ')

const linhaDaLista = (n: NotaAchada, escritorio: boolean) =>
  [`nº ${n.numero}`, dataBr(n.issued_at), n.nome ?? 'tomador', n.valor ? formatarReais(n.valor) : '-', ...(escritorio ? [n.razao_social] : [])].join(' · ')

/** Manda o PDF (DANFSe) da nota com a linha de resumo na legenda, e registra a entrega. */
async function mandarNota(ctx: Contexto, nota: NotaAchada, escritorio: boolean): Promise<void> {
  const { rows } = await ctx.deps.db.query<{ xml_nfse: string | null }>('select xml_nfse from nofiscal.fiscal_invoices where id = $1', [nota.id])
  const legenda = linhaDaNota(nota, escritorio)
  let pdf: Uint8Array | null = null
  if (rows[0]?.xml_nfse) {
    try {
      pdf = await renderDanfse(rows[0].xml_nfse)
    } catch (error) {
      logEvent('agente.pdf_falhou', { invoice_id: nota.id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
  }
  if (!pdf) {
    await responder(ctx, `${legenda}\nNão consegui gerar o PDF agora. Ele também fica em Minha conta → Relatórios: ${ctx.links.conta}#relatorios`)
    return
  }
  const whatsapp = ctx.whatsappBruto ?? ctx.whatsapp
  const anexo = { nome: `nfse-${nota.numero}.pdf`, tipo: 'application/pdf', conteudo: pdf }
  const enviado = await saiuComRetentativa('whatsapp', () => whatsapp.enviarDocumento(ctx.para, anexo, legenda))
  ctx.enviadas++
  await registrarEntrega(ctx.deps.db, {
    invoiceId: nota.id,
    canal: 'whatsapp',
    papel: nota.do_escritorio ? 'escritorio' : 'dono',
    destino: ctx.para,
    enviado,
  })
  logEvent('agente.nota_vista', { tenant_id: nota.tenant_id, invoice_id: nota.id, enviado })
}

/** Empresa do escritório pelo CNPJ (só dígitos, 14) ou por parte do nome. */
function empresasQueBatem(escopo: Escopo, filtro: string) {
  const digitos = filtro.replace(/\D/g, '')
  if (digitos.length === 14) return escopo.empresas.filter((e) => e.cnpj === digitos)
  const nome = semAcento(filtro)
  return nome.length >= 2 ? escopo.empresas.filter((e) => semAcento(e.razao_social).includes(nome)) : []
}

async function porNumero(ctx: Contexto, escopo: Escopo, pedido: { numero: string; empresa: string | null }): Promise<boolean> {
  let tenantIds = escopo.tenantIds
  if (pedido.empresa) {
    // "nota 350 reais": não é a busca, é um pedido. Só o escritório filtra por empresa.
    const empresas = escopo.escritorio ? empresasQueBatem(escopo, pedido.empresa) : []
    if (!empresas.length) return false
    tenantIds = empresas.map((e) => e.id)
  }
  const { rows } = await ctx.deps.db.query<NotaAchada>(
    `select ${COLUNAS}
       from nofiscal.fiscal_invoices i join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where i.tenant_id = any($1::uuid[]) and i.status in ${STATUS_VISIVEIS} and i.issued_at is not null
        and ltrim(${NUMERO_SQL}, '0') = ltrim($2, '0')
      order by i.issued_at desc
      limit 50`,
    [tenantIds, pedido.numero],
  )
  // Sem nota com esse número, a mensagem segue para os pedidos: "nota 350" sozinho é pedido de R$ 350,
  // e o pedido sempre pergunta o que falta e só emite com "confirmar".
  if (!rows.length) return false
  const empresas = new Set(rows.map((r) => r.tenant_id))
  if (empresas.size === 1) {
    // Na mesma empresa, o número é único por série; com mais de uma série, vale a mais recente.
    await mandarNota(ctx, rows[0], escopo.escritorio)
    return true
  }
  const exemplo = rows[0]
  await responder(
    ctx,
    [
      `Achei a nota nº ${pedido.numero} em mais de uma empresa:`,
      ...rows.slice(0, MAX_NA_LISTA).map((r) => `- ${r.razao_social} (CNPJ ${formatarDocumento(r.cnpj)}) · ${r.nome ?? 'tomador'} · ${r.valor ? formatarReais(r.valor) : '-'} · ${dataBr(r.issued_at)}`),
      `Me mande o número com o CNPJ ou o nome da empresa, por exemplo: nota ${pedido.numero} ${formatarDocumento(exemplo.cnpj)}`,
    ].join('\n'),
  )
  return true
}

async function porNome(ctx: Contexto, escopo: Escopo, nome: string): Promise<boolean> {
  // Modelo com valor padrão ("nota Prontia"): é um pedido de emissão, como antes.
  const { rows: modelos } = await ctx.deps.db.query(
    `select 1 from nofiscal.fiscal_models
      where tenant_id = $1 and valor_padrao is not null and (lower(nome) = lower($2) or lower(tomador_nome) = lower($2))`,
    [ctx.tenantId, nome],
  )
  if (modelos.length) return false

  const local = partesLocais(ctx.agora)
  const anterior = local.mes === 1 ? { ano: local.ano - 1, mes: 12 } : { ano: local.ano, mes: local.mes - 1 }
  const { inicio } = limitesDoMes(anterior.ano, anterior.mes)
  const { rows } = await ctx.deps.db.query<NotaAchada>(
    `select ${COLUNAS}
       from nofiscal.fiscal_invoices i join nofiscal.fiscal_tenants t on t.id = i.tenant_id
      where i.tenant_id = any($1::uuid[]) and i.status in ${STATUS_VISIVEIS} and i.issued_at >= $2
      order by i.issued_at desc
      limit 2000`,
    [escopo.tenantIds, inicio],
  )
  const procurado = semAcento(nome)
  const achadas = rows.filter((r) => semAcento(r.nome ?? '').includes(procurado))
  // Sem nota para esse nome, é pedido de emissão ("nota Prontia" sem valor padrão): segue para os pedidos.
  if (!achadas.length) return false
  if (achadas.length === 1) {
    await mandarNota(ctx, achadas[0], escopo.escritorio)
    return true
  }
  if (achadas.length > MAX_NA_LISTA) {
    await responder(
      ctx,
      `Achei ${achadas.length} notas para ${nome} nos últimos 2 meses. Escreva mais do nome do cliente, ou mande *nota* e o número da nota.`,
    )
    return true
  }
  await responder(
    ctx,
    [`Achei ${achadas.length} notas para ${nome} nos últimos 2 meses:`, ...achadas.map((n) => `- ${linhaDaLista(n, escopo.escritorio)}`), 'Me mande *nota* e o número para receber o PDF, por exemplo: nota ' + achadas[0].numero].join('\n'),
  )
  return true
}

/** `true` quando a mensagem era o comando *nota* e foi respondida; `false` segue para a conversa de pedidos. */
export async function tratarVerNota(ctx: Contexto, texto: string): Promise<boolean> {
  const pedido = lerPedidoDeNota(texto)
  if (!pedido) return false
  const escopo = await escopoDoTelefone(ctx.deps.db, ctx.tenantId)
  return pedido.tipo === 'numero' ? porNumero(ctx, escopo, pedido) : porNome(ctx, escopo, pedido.nome)
}
