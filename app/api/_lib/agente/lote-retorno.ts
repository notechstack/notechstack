// Fechamento do lote por planilha (.design/agente-fiscal-escritorio.md, decisões Entrega do lote e Lote; estados
// "Sefin recusa algumas notas" e "Sefin instável"). Rodado pelo worker com as outras tarefas do agente:
// - lote `emitindo` com todas as notas num estado final (ou 24 h depois do "confirmar") → `concluido`; depois, o retorno:
//   e-mail ao e-mail da conta-mãe com `retorno-AAAA-MM-DD.csv` e `notas-AAAA-MM-DD.zip` (PDF e XML de cada nota emitida;
//   acima do limite, o texto aponta para Relatórios). `retorno_enviado_em` só quando o e-mail confirmar, com novas
//   tentativas por até 24 h. Nada de arquivo no WhatsApp (Lucca, 05/11/2026): lá vai só um texto curto, dentro da
//   janela de 24 h, com a contagem, para onde o retorno foi e o comando *nota* (ver-nota.ts);
// - passadas 6 h do "confirmar" sem fechar → um aviso parcial (`aviso_parcial_em`).
// Só quem muda o estado (update condicional) envia: duas rodadas do worker não mandam o retorno duas vezes.
import { zipSync, type Zippable } from 'fflate'
import { renderDanfse } from '../danfse-renderer.js'
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { saiuComRetentativa, type AnexoEmail } from './canais.js'
import { formatarDocumento, formatarReais } from './documentos.js'
import type { EntregasDeps } from './entregas.js'
import { dentroDaJanela } from './janela.js'
import { linksDoSite } from './links.js'
import { centavosDe, lerValor, motivoDoProblema, reaisDeCentavos } from './lote.js'
import { numeroDaNota } from './notas.js'
import { TEXTO_VER_NOTA } from './planos.js'
import { dataBr, diaLocal } from './tempo.js'

export const AVISO_PARCIAL_MS = 6 * 3600_000
/** 24 h depois do "confirmar", o lote fecha mesmo com nota parada na fila (A1 vencido, empresa desativada…). */
export const PRAZO_DO_LOTE_MS = 24 * 3600_000
/** Acima disto (CSV + .zip) o .zip não vai anexo no e-mail, e o texto aponta para Relatórios. */
export const MAX_ANEXOS_EMAIL = 30 * 1024 * 1024

const PENDENTES = new Set(['queued', 'signing', 'sent'])

export type ItemDoRetorno = {
  linha: number
  problema: string | null
  payload: Record<string, unknown>
  tenant_id: string | null
  razao_social: string | null
  cnpj: string | null
  invoice_id: string | null
  status: string | null
  dps_numero: string | null
  xml_nfse: string | null
  chave_acesso: string | null
  last_error_code: string | null
  last_error: string | null
}

type Lido = Partial<Record<'cnpj_prestador' | 'cpf_cnpj_tomador' | 'nome_tomador' | 'valor', string>>
type PayloadDaNota = { tomador?: { cpf?: string; cnpj?: string; nome?: string }; valor?: string; lido?: Lido }

const SITUACAO: Record<string, string> = {
  issued: 'emitida',
  cancel_requested: 'emitida (cancelamento pedido)',
  cancelled: 'cancelada',
  rejected: 'recusada pela Sefin',
  skipped: 'não emitida',
  queued: 'na fila',
  signing: 'na fila',
  sent: 'na fila',
}

const EMITIDAS = new Set(['issued', 'cancel_requested', 'cancelled'])

/** Contagem do retorno: emitidas, recusadas pela Sefin e linhas que não viraram nota (problema na planilha). */
export function contagemDoRetorno(itens: ItemDoRetorno[]) {
  let emitidas = 0
  let recusadas = 0
  let naFila = 0
  let total = 0n
  for (const i of itens) {
    if (i.status && EMITIDAS.has(i.status)) {
      emitidas++
      const valor = typeof (i.payload as PayloadDaNota).valor === 'string' ? lerValor((i.payload as PayloadDaNota).valor as string) : null
      if (valor && i.status !== 'cancelled') total += centavosDe(valor)
    } else if (i.status === 'rejected') recusadas++
    else if (i.status && PENDENTES.has(i.status)) naFila++
  }
  return { emitidas, recusadas, naFila, naoEmitidas: itens.length - emitidas - recusadas - naFila, valorEmitido: reaisDeCentavos(total) }
}

/** Campo do CSV: aspas quando precisa, e texto que o Excel leria como fórmula vai com um apóstrofo na frente. */
function campoCsv(valor: string): string {
  const seguro = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor
  return /[;"\r\n]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro
}

const valorBr = (valor: string | null | undefined) => {
  const v = valor ? lerValor(valor) : null
  return v ? formatarReais(v).replace(/^R\$ /, '') : (valor ?? '')
}

/** Primeira linha igual (LINHA_REPETIDA): mesma empresa, documento e valor, numa linha anterior. */
function primeiraIgual(itens: ItemDoRetorno[], item: ItemDoRetorno): number | null {
  const chave = (i: ItemDoRetorno) => {
    const p = i.payload as PayloadDaNota
    const documento = p.tomador?.cpf ?? p.tomador?.cnpj
    return i.tenant_id && documento && p.valor ? `${i.tenant_id}:${documento}:${p.valor}` : null
  }
  const minha = chave(item)
  return minha ? (itens.find((i) => i.linha < item.linha && chave(i) === minha)?.linha ?? null) : null
}

/** O motivo de uma linha no retorno: problema da planilha (ou bloqueio) ou a recusa da Sefin. */
export function motivoDoItem(itens: ItemDoRetorno[], item: ItemDoRetorno): string {
  if (item.status === 'rejected') return `${item.last_error_code ?? '-'}: ${item.last_error ?? 'sem motivo informado'}`
  if (!item.problema) return ''
  const lido = (item.payload as PayloadDaNota).lido
  return motivoDoProblema(item.problema, {
    empresa: item.razao_social,
    igualA: item.problema === 'LINHA_REPETIDA' ? primeiraIgual(itens, item) : null,
    semPrestador: Boolean(lido) && !lido?.cnpj_prestador,
  })
}

/** `retorno-AAAA-MM-DD.csv`: UTF-8 com BOM, separador `;` (o Excel em português abre direto). */
export function retornoCsv(itens: ItemDoRetorno[]): string {
  const linhas = [['linha', 'prestador', 'tomador', 'valor', 'situação', 'número', 'chave', 'motivo']]
  for (const item of [...itens].sort((a, b) => a.linha - b.linha)) {
    const p = item.payload as PayloadDaNota
    const documento = p.tomador?.cpf ?? p.tomador?.cnpj ?? p.lido?.cpf_cnpj_tomador ?? ''
    const nome = p.tomador?.nome ?? p.lido?.nome_tomador ?? ''
    const prestador = item.cnpj ? `${item.razao_social ?? ''} (${formatarDocumento(item.cnpj)})` : (p.lido?.cnpj_prestador ?? '')
    const tomador = /^\d{11}$|^\d{14}$/.test(documento) ? `${nome} (${formatarDocumento(documento)})` : [nome, documento].filter(Boolean).join(' ')
    linhas.push([
      String(item.linha),
      prestador,
      tomador,
      valorBr(p.valor ?? p.lido?.valor),
      item.status ? (SITUACAO[item.status] ?? item.status) : 'não emitida',
      item.status && EMITIDAS.has(item.status) ? numeroDaNota(item) : '',
      item.chave_acesso ?? '',
      motivoDoItem(itens, item),
    ])
  }
  return `\uFEFF${linhas.map((l) => l.map(campoCsv).join(';')).join('\r\n')}\r\n`
}

/** `notas-AAAA-MM-DD.zip`: PDF (DANFSe) e XML de cada nota emitida, numa pasta por CNPJ do prestador. */
export async function zipDasNotas(
  itens: ItemDoRetorno[],
  renderizar: (xml: string) => Promise<Uint8Array> = renderDanfse,
): Promise<Uint8Array | null> {
  const arquivos: Zippable = {}
  let quantas = 0
  for (const item of itens) {
    if (!item.status || !EMITIDAS.has(item.status) || !item.xml_nfse) continue
    const pasta = item.cnpj ?? 'notas'
    const numero = numeroDaNota(item)
    arquivos[`${pasta}/nfse-${numero}.xml`] = Buffer.from(item.xml_nfse, 'utf8')
    try {
      // PDF já é comprimido: vai sem compressão de novo.
      arquivos[`${pasta}/nfse-${numero}.pdf`] = [await renderizar(item.xml_nfse), { level: 0 }]
    } catch (error) {
      logEvent('agente.pdf_falhou', { invoice_id: item.invoice_id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
    quantas++
  }
  return quantas ? zipSync(arquivos, { level: 6 }) : null
}

type LoteEmitindo = {
  id: string
  escritorio_tenant_id: string
  phone_id: string | null
  arquivo_nome: string | null
  created_at: Date
  confirmed_at: Date | null
  aviso_parcial_em: Date | null
  pendentes: string
}

async function itensDoLote(db: Queryable, loteId: string): Promise<ItemDoRetorno[]> {
  const { rows } = await db.query<ItemDoRetorno>(
    `select li.linha, li.problema, li.payload, li.tenant_id, t.razao_social, t.cnpj,
            i.id as invoice_id, i.status, i.dps_numero::text as dps_numero, i.xml_nfse, i.chave_acesso,
            i.last_error_code, i.last_error
       from nofiscal.fiscal_lote_itens li
       left join nofiscal.fiscal_tenants t on t.id = li.tenant_id
       left join nofiscal.fiscal_invoices i on i.id = li.invoice_id
      where li.lote_id = $1
      order by li.linha`,
    [loteId],
  )
  return rows
}

/** Para onde vai o retorno: o telefone que mandou a planilha (se ainda emite) ou o `owner` da conta-mãe, e o e-mail da conta. */
async function destinoDoLote(db: Queryable, lote: LoteEmitindo): Promise<{ telefone: string | null; email: string | null }> {
  const { rows } = await db.query<{ quem_mandou: string | null; dono: string | null; email: string | null }>(
    `select (select p.phone_e164 from nofiscal.fiscal_phones p
              where p.id = $2 and p.verified_at is not null and p.revoked_at is null) as quem_mandou,
            (select p.phone_e164 from nofiscal.fiscal_phones p where p.tenant_id = $1 and p.role = 'owner') as dono,
            (select a.email from nofiscal.fiscal_accounts a join nofiscal.fiscal_tenants t on t.client_id = a.client_id
              where t.id = $1 limit 1) as email`,
    [lote.escritorio_tenant_id, lote.phone_id],
  )
  return { telefone: rows[0]?.quem_mandou ?? rows[0]?.dono ?? null, email: rows[0]?.email ?? null }
}

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`

/** Texto curto no WhatsApp, só dentro da janela de 24 h; melhor esforço (não decide nada). */
async function avisoNoWhatsApp(deps: EntregasDeps, agora: Date, telefone: string | null, texto: string): Promise<boolean> {
  if (!telefone || !(await dentroDaJanela(deps.db, telefone, agora))) return false
  return saiuComRetentativa('whatsapp', () => deps.whatsapp.enviarTexto(telefone, texto))
}

/** `emitindo` → `concluido`: todas as notas num estado final, ou 24 h depois do "confirmar" (o que ficou na fila vai como "na fila"). */
async function concluirLote(deps: EntregasDeps, lote: LoteEmitindo, agora: Date): Promise<boolean> {
  const { rowCount } = await deps.db.query(
    `update nofiscal.fiscal_lotes set status = 'concluido', concluido_em = $2, updated_at = $2
      where id = $1 and status = 'emitindo'`,
    [lote.id, agora],
  )
  if (rowCount === 1) logEvent('agente.lote_concluido', { tenant_id: lote.escritorio_tenant_id, lote_id: lote.id, pendentes: Number(lote.pendentes) })
  return rowCount === 1
}

const juntar = (partes: string[]) => (partes.length > 1 ? `${partes.slice(0, -1).join(', ')} e ${partes.at(-1)}` : partes[0])

/** Texto do e-mail do retorno. Sem o .zip anexo (acima do limite), os PDFs ficam em Minha conta → Relatórios. */
export function textoDoRetorno(
  lote: { created_at: Date; arquivo_nome: string | null },
  c: ReturnType<typeof contagemDoRetorno>,
  arquivos: { csv: string; zip: string | null },
  relatorios: string,
): string {
  const partes = [
    plural(c.emitidas, 'nota emitida', 'notas emitidas'),
    c.recusadas ? plural(c.recusadas, 'recusada pela Sefin', 'recusadas pela Sefin') : null,
    c.naFila ? plural(c.naFila, 'ainda na fila', 'ainda na fila') : null,
    c.naoEmitidas ? plural(c.naoEmitidas, 'linha não emitida', 'linhas não emitidas') : null,
  ].filter(Boolean) as string[]
  return [
    `Planilha de ${dataBr(lote.created_at)}${lote.arquivo_nome ? ` (${lote.arquivo_nome})` : ''} concluída: ${juntar(partes)}.`,
    c.emitidas ? `Valor emitido: ${formatarReais(c.valorEmitido)}.` : null,
    c.naFila ? 'As notas que ainda estão na fila aparecem em Relatórios quando a Sefin responder.' : null,
    arquivos.zip
      ? `A situação de cada linha está em ${arquivos.csv} e os PDFs e XMLs em ${arquivos.zip}. Tudo também fica em Relatórios: ${relatorios}`
      : c.emitidas
        ? `A situação de cada linha está em ${arquivos.csv}. Os PDFs ficam em Minha conta → Relatórios: ${relatorios}`
        : `A situação de cada linha está em ${arquivos.csv}. Tudo também fica em Relatórios: ${relatorios}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Aviso curto do retorno no WhatsApp (Lucca, 05/11/2026: nada de arquivo no WhatsApp; o CSV e os PDFs vão por
 * e-mail). `email` = para onde o retorno foi; `pdfsNoEmail` = o .zip coube no e-mail.
 */
export function avisoDoRetorno(
  lote: { created_at: Date },
  c: ReturnType<typeof contagemDoRetorno>,
  destino: { email: string; pdfsNoEmail: boolean },
  relatorios: string,
): string {
  const partes = [
    `${plural(c.emitidas, 'nota emitida', 'notas emitidas')}${c.emitidas ? ` (${formatarReais(c.valorEmitido)})` : ''}`,
    c.recusadas ? plural(c.recusadas, 'recusada', 'recusadas') : null,
    c.naFila ? plural(c.naFila, 'ainda na fila', 'ainda na fila') : null,
    c.naoEmitidas ? plural(c.naoEmitidas, 'linha não emitida', 'linhas não emitidas') : null,
  ].filter(Boolean) as string[]
  return [
    `Planilha de ${dataBr(lote.created_at)}: ${juntar(partes)}.`,
    c.emitidas && !destino.pdfsNoEmail
      ? `O retorno (CSV) foi para ${destino.email}; os PDFs estão em Minha conta → Relatórios: ${relatorios}`
      : `O retorno (CSV)${c.emitidas ? ' e os PDFs' : ''} ${c.emitidas ? 'foram' : 'foi'} para ${destino.email}. Tudo também em Minha conta → Relatórios: ${relatorios}`,
    TEXTO_VER_NOTA,
  ].join('\n')
}

/**
 * Envia o retorno de um lote `concluido` ainda sem `retorno_enviado_em`: o e-mail à conta-mãe, com o CSV e o .zip, é o
 * canal do retorno; a marca fica só quando ele confirmar (senão volta a nulo e a próxima rodada tenta de novo). A linha
 * é reclamada antes, num update condicional, para duas rodadas não mandarem em dobro. Com o e-mail entregue, sai o
 * aviso curto no WhatsApp (dentro da janela), sem arquivo e sem decidir a marca.
 */
async function enviarRetorno(deps: EntregasDeps, lote: LoteEmitindo, agora: Date): Promise<boolean> {
  const { rowCount } = await deps.db.query(
    `update nofiscal.fiscal_lotes set retorno_enviado_em = $2, updated_at = $2
      where id = $1 and status = 'concluido' and retorno_enviado_em is null`,
    [lote.id, agora],
  )
  if (rowCount !== 1) return false
  let saiu = false
  try {
    const itens = await itensDoLote(deps.db, lote.id)
    const c = contagemDoRetorno(itens)
    const dia = diaLocal(lote.created_at)
    const relatorios = `${(deps.links ?? linksDoSite()).conta}#relatorios`
    const destino = await destinoDoLote(deps.db, lote)
    if (!destino.email) {
      // Sem e-mail na conta (não deveria acontecer): o aviso no WhatsApp, apontando para Relatórios, é o que dá.
      logEvent('agente.lote_retorno_sem_email', { tenant_id: lote.escritorio_tenant_id, lote_id: lote.id })
      saiu = await avisoNoWhatsApp(deps, agora, destino.telefone, avisoDoRetorno(lote, c, { email: 'o e-mail da conta', pdfsNoEmail: false }, relatorios))
      return saiu
    }
    const csv: AnexoEmail = { nome: `retorno-${dia}.csv`, tipo: 'text/csv', conteudo: Buffer.from(retornoCsv(itens), 'utf8') }
    const zipBytes = await zipDasNotas(itens)
    const zip: AnexoEmail | null = zipBytes ? { nome: `notas-${dia}.zip`, tipo: 'application/zip', conteudo: zipBytes } : null
    const zipVai = Boolean(zip && csv.conteudo.byteLength + zip.conteudo.byteLength <= MAX_ANEXOS_EMAIL)
    const email = destino.email
    saiu = await saiuComRetentativa('email', () =>
      deps.email.enviar({
        para: email,
        assunto: `Retorno da planilha de ${dataBr(lote.created_at)}`,
        texto: textoDoRetorno(lote, c, { csv: csv.nome, zip: zipVai && zip ? zip.nome : null }, relatorios),
        anexos: zipVai && zip ? [csv, zip] : [csv],
        idempotencia: `lote-${lote.id}-retorno`,
      }),
    )
    const aviso = saiu ? await avisoNoWhatsApp(deps, agora, destino.telefone, avisoDoRetorno(lote, c, { email, pdfsNoEmail: zipVai }, relatorios)) : false
    logEvent('agente.lote_retorno', {
      tenant_id: lote.escritorio_tenant_id,
      lote_id: lote.id,
      emitidas: c.emitidas,
      recusadas: c.recusadas,
      enviado: saiu,
      aviso_whatsapp: aviso,
    })
  } finally {
    if (!saiu) {
      await deps.db.query('update nofiscal.fiscal_lotes set retorno_enviado_em = null where id = $1', [lote.id])
    }
  }
  return saiu
}

/** 6 h sem fechar: um aviso, no WhatsApp dentro da janela ou, fora dela (ou se falhar), por e-mail à conta. */
async function avisoParcial(deps: EntregasDeps, lote: LoteEmitindo, agora: Date): Promise<void> {
  const { rowCount } = await deps.db.query(
    `update nofiscal.fiscal_lotes set aviso_parcial_em = $2, updated_at = $2
      where id = $1 and status = 'emitindo' and aviso_parcial_em is null`,
    [lote.id, agora],
  )
  if (rowCount !== 1) return
  const c = contagemDoRetorno(await itensDoLote(deps.db, lote.id))
  const texto =
    `A Sefin está lenta com a planilha de ${dataBr(lote.created_at)}: ${plural(c.emitidas, 'nota já saiu', 'notas já saíram')}, ` +
    `${plural(c.recusadas, 'foi recusada', 'foram recusadas')} e ${plural(c.naFila, 'continua na fila', 'continuam na fila')}. ` +
    'Eu mando o retorno completo quando todas fecharem.'
  const destino = await destinoDoLote(deps.db, lote)
  if (!(await avisoNoWhatsApp(deps, agora, destino.telefone, texto)) && destino.email) {
    const email = destino.email
    await saiuComRetentativa('email', () =>
      deps.email.enviar({ para: email, assunto: `Planilha de ${dataBr(lote.created_at)}: notas ainda na fila`, texto, idempotencia: `lote-${lote.id}-parcial` }),
    )
  }
  logEvent('agente.lote_aviso_parcial', { tenant_id: lote.escritorio_tenant_id, lote_id: lote.id, na_fila: c.naFila })
}


/**
 * Tarefa `lotes_concluidos`, em duas etapas: (1) fecha os lotes `emitindo` sem nota pendente (ou com 24 h do
 * "confirmar") e avisa os atrasados de 6 h; (2) envia o retorno dos lotes concluídos que ainda não o receberam, por
 * até 24 h depois de concluídos. Devolve quantos retornos saíram.
 */
export async function fecharLotes(deps: EntregasDeps, opcoes: { tenantIds?: string[] } = {}): Promise<number> {
  const agora = (deps.now ?? (() => new Date()))()
  const colunas = `l.id, l.escritorio_tenant_id, l.phone_id, l.arquivo_nome, l.created_at, l.confirmed_at, l.aviso_parcial_em,
            (select count(*) from nofiscal.fiscal_lote_itens li
               join nofiscal.fiscal_invoices i on i.id = li.invoice_id
              where li.lote_id = l.id and i.status in ('queued', 'signing', 'sent')) as pendentes`
  const { rows: emitindo } = await deps.db.query<LoteEmitindo>(
    `select ${colunas}
       from nofiscal.fiscal_lotes l
      where l.status = 'emitindo'
        and ($1::uuid[] is null or l.escritorio_tenant_id = any($1::uuid[]))
      order by l.confirmed_at`,
    [opcoes.tenantIds ?? null],
  )
  for (const lote of emitindo) {
    try {
      const desde = lote.confirmed_at ? agora.getTime() - lote.confirmed_at.getTime() : 0
      if (Number(lote.pendentes) === 0 || desde >= PRAZO_DO_LOTE_MS) await concluirLote(deps, lote, agora)
      else if (!lote.aviso_parcial_em && desde >= AVISO_PARCIAL_MS) await avisoParcial(deps, lote, agora)
    } catch (error) {
      // Um lote com problema não segura os outros.
      logEvent('agente.lote_fechamento_falhou', { lote_id: lote.id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
  }

  const { rows: semRetorno } = await deps.db.query<LoteEmitindo>(
    `select ${colunas}
       from nofiscal.fiscal_lotes l
      where l.status = 'concluido' and l.retorno_enviado_em is null
        and l.concluido_em > $2::timestamptz - interval '24 hours'
        and ($1::uuid[] is null or l.escritorio_tenant_id = any($1::uuid[]))
      order by l.concluido_em`,
    [opcoes.tenantIds ?? null, agora],
  )
  let enviados = 0
  for (const lote of semRetorno) {
    try {
      if (await enviarRetorno(deps, lote, agora)) enviados++
    } catch (error) {
      logEvent('agente.lote_retorno_falhou', { lote_id: lote.id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
  }
  return enviados
}
