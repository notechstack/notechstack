// Peças do módulo Guias usadas pelo painel, pelo worker e pelo webhook: posse por transação, token do link,
// contatos (validação e CSV) e a leitura das guias pendentes (download do Storage → lerGuia → banco).
import { createHash, createHmac } from 'node:crypto'
import type { Db, Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { cnpjValido, cpfValido } from '../agente/documentos.js'
import { comNonoDigito, normalizarEmail, normalizarTelefone } from '../agente/normalizacao.js'
import { lerGuia, type LeituraGuia, type LerGuiaDeps } from './leitura.js'
import type { ArmazemDeGuias } from './storage.js'

/** Link /g/<token>: vale 60 dias depois do envio. */
export const VALIDADE_DO_LINK_DIAS = 60

/**
 * Roda `trabalho` numa transação com o filtro de posse do usuário (políticas de 20261119180000): as tabelas do módulo
 * só mostram e aceitam linhas das contas que nofiscal.usuario_pode_tenant libera a ele.
 */
export function comPosse<T>(db: Db, userId: string, trabalho: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('nofiscal.guias_usuario', $1, true)`, [userId])
    return trabalho(tx)
  })
}

/** Token imprevisível e estável da guia (HMAC com o segredo do link): o mesmo no WhatsApp, no e-mail e na 2ª via. */
export function tokenDaGuia(segredo: string, guiaId: string): string {
  return createHmac('sha256', segredo).update(`guia-link:${guiaId}`).digest('base64url').slice(0, 32)
}

export const hashDoToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')

export function urlDoLink(base: string, token: string): string {
  return `${base.replace(/\/+$/, '')}/g/${token}`
}

// ------------------------------------------------------------------ Contatos

export type ContatoEntrada = {
  id?: string
  documento: string
  nome: string
  whatsapps: string[]
  emails: string[]
  aceite_em?: string | null
  aceite_origem?: string | null
}

export type ContatoValidado = { ok: true; contato: ContatoEntrada } | { ok: false; motivo: string }

const lista = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[|;\n]/) : [])
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)

/** Documento (CNPJ/CPF com DV), nome, WhatsApps em E.164 (com o 9) e e-mails; pelo menos um canal. */
export function validarContato(bruto: Record<string, unknown>): ContatoValidado {
  const documento = String(bruto.documento ?? '').replace(/\D/g, '')
  if (!(documento.length === 14 ? cnpjValido(documento) : documento.length === 11 && cpfValido(documento))) {
    return { ok: false, motivo: 'CNPJ ou CPF inválido' }
  }
  const nome = String(bruto.nome ?? '').replace(/\s+/g, ' ').trim()
  if (!nome || nome.length > 200) return { ok: false, motivo: 'nome vazio ou com mais de 200 caracteres' }
  const whatsapps: string[] = []
  for (const w of lista(bruto.whatsapps ?? bruto.whatsapp)) {
    const e164 = normalizarTelefone(w)
    if (!e164) return { ok: false, motivo: `WhatsApp inválido: ${w}` }
    const com9 = comNonoDigito(e164)
    if (!whatsapps.includes(com9)) whatsapps.push(com9)
  }
  const emails: string[] = []
  for (const e of lista(bruto.emails ?? bruto.email)) {
    const email = normalizarEmail(e)
    if (!email) return { ok: false, motivo: `e-mail inválido: ${e}` }
    if (!emails.includes(email)) emails.push(email)
  }
  if (!whatsapps.length && !emails.length) return { ok: false, motivo: 'informe um WhatsApp ou um e-mail' }
  if (whatsapps.length > 5 || emails.length > 5) return { ok: false, motivo: 'no máximo 5 WhatsApps e 5 e-mails' }
  const contato: ContatoEntrada = { documento, nome, whatsapps, emails }
  if (typeof bruto.id === 'string') contato.id = bruto.id
  return { ok: true, contato }
}

/** Uma linha de CSV com aspas ("a, b"), separador `,` ou `;`. */
function camposDaLinha(linha: string, sep: string): string[] {
  const campos: string[] = []
  let atual = ''
  let aspas = false
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]
    if (aspas) {
      if (c === '"' && linha[i + 1] === '"') {
        atual += '"'
        i++
      } else if (c === '"') aspas = false
      else atual += c
    } else if (c === '"') aspas = true
    else if (c === sep) {
      campos.push(atual)
      atual = ''
    } else atual += c
  }
  campos.push(atual)
  return campos.map((x) => x.trim())
}

export const MAX_LINHAS_DO_CSV = 5000

export type LinhaDoCsv = { linha: number; contato?: ContatoEntrada; erro?: string }

/**
 * CSV `documento,nome,whatsapp,email` (cabeçalho opcional, em qualquer ordem quando presente; vários WhatsApps ou
 * e-mails na mesma célula separados por `|`). Cada linha volta validada ou com o motivo do erro.
 */
export function lerCsvDeContatos(csv: string): { linhas: LinhaDoCsv[]; erroGeral?: string } {
  const texto = csv.replace(/^﻿/, '')
  const brutas = texto.split(/\r?\n/)
  const primeira = brutas.find((l) => l.trim()) ?? ''
  const sep = (primeira.match(/;/g)?.length ?? 0) > (primeira.match(/,/g)?.length ?? 0) ? ';' : ','
  let ordem = ['documento', 'nome', 'whatsapp', 'email']
  let inicio = 0
  const cab = camposDaLinha(primeira, sep).map((c) => c.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))
  if (cab.some((c) => ['documento', 'cnpj', 'cpf', 'nome', 'whatsapp', 'email', 'e-mail'].includes(c))) {
    ordem = cab.map((c) => (c === 'cnpj' || c === 'cpf' || c === 'cnpj/cpf' ? 'documento' : c === 'e-mail' ? 'email' : c))
    if (!ordem.includes('documento') || !ordem.includes('nome')) return { linhas: [], erroGeral: 'o cabeçalho precisa de documento e nome' }
    inicio = brutas.indexOf(primeira) + 1
  }
  const linhas: LinhaDoCsv[] = []
  for (let i = inicio; i < brutas.length; i++) {
    if (!brutas[i].trim()) continue
    if (linhas.length >= MAX_LINHAS_DO_CSV) return { linhas, erroGeral: `o arquivo passa de ${MAX_LINHAS_DO_CSV} linhas` }
    const campos = camposDaLinha(brutas[i], sep)
    const registro: Record<string, unknown> = {}
    ordem.forEach((nome, j) => (registro[nome] = campos[j] ?? ''))
    const v = validarContato(registro)
    linhas.push(v.ok ? { linha: i + 1, contato: v.contato } : { linha: i + 1, erro: v.motivo })
  }
  return { linhas }
}

// ------------------------------------------------------------------ Leitura das guias pendentes

export type LeituraPendentesDeps = {
  /** Cada passo no banco (painel: com a posse do usuário; worker: direto). */
  executar: <T>(trabalho: (q: Queryable) => Promise<T>) => Promise<T>
  storage: ArmazemDeGuias
  leitor: LerGuiaDeps
  now?: () => Date
}

type Pendente = { id: string; escritorio_tenant_id: string; pdf_path: string; lote_id: string; cnpj_conta: string }

/** Lê até `limite` guias em 'lendo' (de um lote, ou de todos); devolve quantas leu. Duas leituras nunca pegam a mesma. */
export async function lerPendentes(deps: LeituraPendentesDeps, filtro: { loteId?: string; limite: number }): Promise<number> {
  const pendentes = await deps.executar((q) =>
    q.query<Pendente>(
      `update nofiscal.guias g set leitura_iniciada_em = now()
         from nofiscal.fiscal_tenants t
        where t.id = g.escritorio_tenant_id
          and g.id in (select x.id from nofiscal.guias x
                        where x.status = 'lendo' and ($1::uuid is null or x.lote_id = $1)
                          and (x.leitura_iniciada_em is null or x.leitura_iniciada_em < now() - interval '5 minutes')
                        order by x.created_at limit $2 for update skip locked)
        returning g.id, g.escritorio_tenant_id, g.pdf_path, g.lote_id, t.cnpj as cnpj_conta`,
      [filtro.loteId ?? null, filtro.limite],
    ),
  )
  const lotes = new Set<string>()
  for (const p of pendentes.rows) {
    let leitura: LeituraGuia | null = null
    let erro: string | null = null
    try {
      const pdf = await deps.storage.baixar(p.pdf_path)
      leitura = await lerGuia(pdf, deps.leitor, { excluir: [p.cnpj_conta], hoje: deps.now?.() })
    } catch (error) {
      erro = 'PDF_INDISPONIVEL'
      logEvent('guias.leitura_falhou', { guia_id: p.id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
    await deps.executar((q) => gravarLeitura(q, p.id, leitura, erro))
    lotes.add(p.lote_id)
  }
  for (const lote of lotes) await deps.executar((q) => atualizarLote(q, lote))
  return pendentes.rows.length
}

async function gravarLeitura(q: Queryable, guiaId: string, leitura: LeituraGuia | null, erro: string | null): Promise<void> {
  const c = leitura?.campos
  const registro = leitura
    ? { origem: leitura.origem, faltando: leitura.faltando, valor_divergente: leitura.valor_divergente, valor_codigo_barras: leitura.valor_codigo_barras, com_texto: leitura.com_texto, ia: leitura.ia, ...(leitura.ia_erro ? { ia_erro: leitura.ia_erro } : {}) }
    : { erro, faltando: ['tipo', 'documento', 'competencia', 'valor_centavos', 'vencimento', 'linha_digitavel'] }
  await q.query(
    `update nofiscal.guias g
        set tipo = $2, documento = $3, competencia = $4::date, valor_centavos = $5, vencimento = $6::date, linha_digitavel = $7,
            leitura = $8::jsonb, status = 'conferir', leitura_iniciada_em = null, updated_at = now(),
            contato_id = (select c.id from nofiscal.guia_contatos c
                           where c.escritorio_tenant_id = g.escritorio_tenant_id and c.documento = $3 and c.ativo)
      where g.id = $1 and g.status = 'lendo'`,
    [guiaId, c?.tipo ?? null, c?.documento ?? null, c?.competencia ?? null, c?.valor_centavos ?? null, c?.vencimento ?? null, c?.linha_digitavel ?? null, JSON.stringify(registro)],
  )
}

/** Contadores do lote (lidos, com problema) e o status: 'conferir' quando nada mais está subindo ou sendo lido. */
export async function atualizarLote(q: Queryable, loteId: string): Promise<void> {
  await q.query(
    `update nofiscal.guia_lotes l
        set lidos = (select count(*) from nofiscal.guias g where g.lote_id = l.id and g.status not in ('enviando', 'lendo')),
            com_problema = (select count(*) from nofiscal.guias g where g.lote_id = l.id and g.status = 'conferir'
                             and nofiscal.guia_cor(g.id) <> 'verde'),
            status = case
              when l.status in ('disparado', 'cancelado') then l.status
              when exists (select 1 from nofiscal.guias g where g.lote_id = l.id and g.status in ('enviando', 'lendo')) then
                case when exists (select 1 from nofiscal.guias g where g.lote_id = l.id and g.status = 'lendo') then 'lendo' else l.status end
              else 'conferir' end
      where l.id = $1`,
    [loteId],
  )
}
