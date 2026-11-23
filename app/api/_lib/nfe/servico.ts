// Serviço da NF-e sobre o banco (migração 20261117090000_agente_fiscal_nfe.sql): cria a nota com número da série
// (fila), roda a fila no worker (assina com o A1 da própria empresa, transmite à Sefaz da UF e grava o resultado) e
// registra cancelamento, carta de correção e inutilização.
//
// Estados: queued → sending → (processing) → authorized | denied | rejected; authorized → cancel_requested →
// cancelled; rejected → voided (número inutilizado).
// Retentativa: o XML é montado e assinado uma vez e gravado antes do primeiro envio (mesma chave para sempre). Da 2ª
// rodada em diante, a nota é consultada pela chave antes de ir de novo; "duplicidade" (204/539) também vira consulta.
// Esperas de 1, 5, 15, 60 e 240 min; depois disso fica na fila com consulta a cada 4 h (nunca vira rejeitada sem a
// Sefaz dizer). Bloqueio (sem A1, IE, endereço, assinatura) deixa a nota em `queued` com o código e revê em 5 min.
import type { Db, Queryable } from '../db.js'
import { logEvent } from '../log.js'
import type { Certificado } from '../sefin.js'
import { CODIGO_UF, type AmbienteNfe, type Uf } from './autorizadores.js'
import {
  calcularTotais,
  montarNfe,
  limpo,
  NfeInvalidaError,
  SERIE_MAXIMA,
  soDigitos,
  validarNfe,
  type Emitente,
  type Item,
  type NfeInput,
  type ResponsavelTecnico,
  type Transportador,
} from './nfe-builder.js'
import { pedidoCancelamento, pedidoCartaCorrecao, pedidoInutilizacao, PedidoInvalidoError } from './pedidos.js'
import { abrirCertificado, type Credencial, type ResultadoAutorizacao, type SefazClient } from './sefaz-client.js'

export const BACKOFF_MINUTOS = [1, 5, 15, 60, 240] as const
export const LEASE_MINUTOS = 5
export const LOTE_PADRAO = 20

/** O que quem pede a nota informa; o emitente, a série, o número e a data vêm do banco e do worker. */
export type PedidoNfe = Omit<
  NfeInput,
  'ambiente' | 'emitente' | 'serie' | 'numero' | 'emissao' | 'codigoNumerico' | 'responsavelTecnico' | 'versaoAplicativo'
>

export type EmpresaNfe = {
  id: string
  cnpj: string
  razao_social: string
  inscricao_estadual: string | null
  regime: string
  codigo_municipio_ibge: string
  ambiente: string
  /** Modo da NFS-e (`certificado_proprio` ou `procuracao`); a NF-e sempre usa o A1 da própria empresa. */
  modo_autenticacao?: string | null
  endereco: { logradouro: string; numero: string; complemento?: string | null; bairro: string; cep: string; uf: Uf; fone?: string | null } | null
}

export const ambienteDaEmpresa = (e: Pick<EmpresaNfe, 'ambiente'>): AmbienteNfe => (e.ambiente === 'producao' ? 'producao' : 'homologacao')

export function emitenteDaEmpresa(e: EmpresaNfe): Emitente {
  if (!e.endereco || !e.inscricao_estadual) throw new NfeInvalidaError(['empresa sem inscrição estadual ou endereço para NF-e'])
  return {
    cnpj: e.cnpj,
    razaoSocial: e.razao_social,
    inscricaoEstadual: e.inscricao_estadual,
    crt: e.regime === 'mei' ? '4' : '1',
    endereco: { ...e.endereco, codigoMunicipio: e.codigo_municipio_ibge },
  }
}

const SELECT_EMPRESA = `select t.id, t.cnpj, t.razao_social, t.inscricao_estadual, t.regime, t.codigo_municipio_ibge, t.ambiente, t.endereco, t.modo_autenticacao
                          from nofiscal.fiscal_tenants t`

export async function empresaNfe(db: Queryable, tenantId: string): Promise<EmpresaNfe | null> {
  const { rows } = await db.query<EmpresaNfe>(`${SELECT_EMPRESA} where t.id = $1`, [tenantId])
  return rows[0] ?? null
}

export async function bloqueioNfe(db: Queryable, tenantId: string): Promise<string | null> {
  const { rows } = await db.query<{ b: string | null }>('select nofiscal.nfe_emission_block($1) as b', [tenantId])
  return rows[0]?.b ?? null
}

// --- dados da empresa para NF-e ----------------------------------------------------------------------------

export type DadosNfeDaEmpresa = {
  inscricaoEstadual: string
  endereco: NonNullable<EmpresaNfe['endereco']>
  serie: number
  /** Próximo número da série; só vale na primeira configuração ou para avançar (nunca volta). */
  proximoNumero: number
}

export class DadosNfeInvalidos extends Error {
  readonly code = 'NFE_DADOS_INVALIDOS'
  constructor(readonly problemas: string[]) {
    super(problemas.join('; '))
    this.name = 'DadosNfeInvalidos'
  }
}

/** Grava IE, endereço e série da empresa (painel). A numeração nunca recua: número usado não pode voltar. */
export async function salvarDadosNfe(db: Db, tenantId: string, dados: DadosNfeDaEmpresa): Promise<void> {
  const ie = soDigitos(dados.inscricaoEstadual)
  const end = {
    logradouro: dados.endereco.logradouro.trim(),
    numero: dados.endereco.numero.trim() || 'S/N',
    complemento: dados.endereco.complemento?.trim() || null,
    bairro: dados.endereco.bairro.trim(),
    cep: soDigitos(dados.endereco.cep),
    uf: dados.endereco.uf,
    fone: soDigitos(dados.endereco.fone) || null,
  }
  const problemas: string[] = []
  if (!/^\d{2,14}$/.test(ie)) problemas.push('Inscrição estadual: só números, de 2 a 14 dígitos.')
  if (!end.logradouro || end.logradouro.length > 60) problemas.push('Informe o logradouro (até 60 caracteres).')
  if (!end.bairro || end.bairro.length > 60) problemas.push('Informe o bairro.')
  if (end.cep.length !== 8) problemas.push('CEP com 8 dígitos.')
  if (!Number.isInteger(dados.serie) || dados.serie < 0 || dados.serie > SERIE_MAXIMA) problemas.push(`Série de 0 a ${SERIE_MAXIMA} (889 em diante é reservada ou de outro tipo de emissor).`)
  if (!Number.isInteger(dados.proximoNumero) || dados.proximoNumero < 1 || dados.proximoNumero > 999_999_999) {
    problemas.push('Próximo número de 1 a 999.999.999.')
  }
  await db.transaction(async (tx) => {
    const { rows } = await tx.query<{ codigo_municipio_ibge: string }>(
      'select codigo_municipio_ibge from nofiscal.fiscal_tenants where id = $1 for update',
      [tenantId],
    )
    if (!rows[0]) throw new DadosNfeInvalidos(['Empresa não encontrada.'])
    // UF do endereço tem de bater com o município da empresa (o mesmo cMun da NFS-e).
    const ufDoMunicipio = rows[0].codigo_municipio_ibge.slice(0, 2)
    if (CODIGO_UF[end.uf] !== ufDoMunicipio) problemas.push(`A UF ${end.uf} não é a do município da empresa.`)
    if (problemas.length) throw new DadosNfeInvalidos(problemas)
    await tx.query('update nofiscal.fiscal_tenants set inscricao_estadual = $2, endereco = $3, updated_at = now() where id = $1', [
      tenantId,
      ie,
      JSON.stringify(end),
    ])
    const { rows: serie } = await tx.query<{ next_number: string }>(
      'select next_number from nofiscal.fiscal_nfe_series where tenant_id = $1 and serie = $2 for update',
      [tenantId, dados.serie],
    )
    const usado = await tx.query<{ max: string | null }>('select max(numero) as max from nofiscal.fiscal_nfe where tenant_id = $1 and serie = $2', [
      tenantId,
      dados.serie,
    ])
    const minimo = Math.max(Number(usado.rows[0]?.max ?? 0) + 1, Number(serie[0]?.next_number ?? 1))
    if (serie[0] && dados.proximoNumero < minimo) {
      throw new DadosNfeInvalidos([`O próximo número da série ${dados.serie} já está em ${minimo}; ele não pode voltar.`])
    }
    // A série salva passa a ser a única ativa; as outras guardam o próximo número.
    await tx.query('update nofiscal.fiscal_nfe_series set ativa = false where tenant_id = $1 and serie <> $2 and ativa', [tenantId, dados.serie])
    await tx.query(
      `insert into nofiscal.fiscal_nfe_series (tenant_id, serie, next_number, ativa) values ($1, $2, $3, true)
       on conflict (tenant_id, serie) do update set next_number = excluded.next_number, ativa = true`,
      [tenantId, dados.serie, Math.max(dados.proximoNumero, minimo)],
    )
  })
}

// --- criação ---------------------------------------------------------------------------------------------

export type ResultadoCriacao =
  | { ok: true; nfeId: string; serie: number; numero: number; jaExistia: boolean }
  | { ok: false; codigo: 'BLOQUEADA'; bloqueio: string }
  | { ok: false; codigo: 'INVALIDA'; problemas: string[] }

/** Confere o pedido contra a empresa sem gravar (resumo da planilha e "conferir" do painel). */
export function conferirPedido(empresa: EmpresaNfe, pedido: PedidoNfe, agora: Date): string[] {
  let emitente: Emitente
  try {
    emitente = emitenteDaEmpresa(empresa)
  } catch {
    return ['A empresa ainda não tem inscrição estadual e endereço para NF-e.']
  }
  return validarNfe({ ...pedido, ambiente: ambienteDaEmpresa(empresa), emitente, serie: 1, numero: 1, emissao: agora })
}

/**
 * Põe a nota na fila com o próximo número da série. Idempotente por `externalId` (a mesma linha de planilha, o mesmo
 * clique): devolve a nota que já existe.
 */
export async function criarNfe(
  db: Db,
  p: { tenantId: string; externalId: string; origem: 'painel' | 'planilha' | 'api'; pedido: PedidoNfe; agora: Date },
): Promise<ResultadoCriacao> {
  return db.transaction(async (tx) => {
    const existente = await tx.query<{ id: string; serie: number; numero: string }>(
      'select id, serie, numero from nofiscal.fiscal_nfe where tenant_id = $1 and external_id = $2',
      [p.tenantId, p.externalId],
    )
    if (existente.rows[0]) {
      const e = existente.rows[0]
      return { ok: true, nfeId: e.id, serie: e.serie, numero: Number(e.numero), jaExistia: true }
    }
    const bloqueio = await bloqueioNfe(tx, p.tenantId)
    if (bloqueio) return { ok: false, codigo: 'BLOQUEADA', bloqueio }
    const empresa = await empresaNfe(tx, p.tenantId)
    if (!empresa) return { ok: false, codigo: 'BLOQUEADA', bloqueio: 'TENANT_NOT_FOUND' }
    const problemas = conferirPedido(empresa, p.pedido, p.agora)
    if (problemas.length) return { ok: false, codigo: 'INVALIDA', problemas }

    const { rows: series } = await tx.query<{ serie: number }>(
      'select serie from nofiscal.fiscal_nfe_series where tenant_id = $1 and ativa',
      [p.tenantId],
    )
    const serie = series[0].serie
    const { rows: num } = await tx.query<{ numero: string }>('select nofiscal.allocate_nfe_number($1, $2) as numero', [p.tenantId, serie])
    const numero = Number(num[0].numero)
    const total = calcularTotais(p.pedido.itens).nota
    const { rows } = await tx.query<{ id: string }>(
      `insert into nofiscal.fiscal_nfe
         (tenant_id, external_id, origem, ambiente, payload, serie, numero, valor_total, destinatario_documento, destinatario_nome)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        p.tenantId,
        p.externalId,
        p.origem,
        ambienteDaEmpresa(empresa),
        JSON.stringify(p.pedido),
        serie,
        numero,
        (total / 100).toFixed(2),
        soDigitos(p.pedido.destinatario.documento),
        p.pedido.destinatario.nome.trim().slice(0, 150),
      ],
    )
    logEvent('nofiscal.nfe_criada', { nfe_id: rows[0].id, tenant_id: p.tenantId, serie, numero, origem: p.origem })
    return { ok: true, nfeId: rows[0].id, serie, numero, jaExistia: false }
  })
}

// --- worker ----------------------------------------------------------------------------------------------

export type WorkerNfeDeps = {
  db: Db
  sefaz: SefazClient
  now: () => Date
  responsavelTecnico?: ResponsavelTecnico | null
  /** Chamado quando a nota chega a um estado final (aviso ao WhatsApp/e-mail; opcional). */
  onFinal?: (nfeId: string, status: 'authorized' | 'denied' | 'rejected' | 'cancelled') => Promise<void>
  limite?: number
  tenantId?: string
  /**
   * Tempo da rodada (padrão 90 s, pelo relógio real): a Sefaz lenta não pode estourar a função do worker e cortar o
   * resto dele. O que não coube volta para a fila na hora (sem esperar o lease).
   */
  prazoMs?: number
  relogio?: () => number
}

export type ResumoNfe = { pegas: number; autorizadas: number; rejeitadas: number; denegadas: number; aguardando: number; bloqueadas: number; eventos: number; adiadas: number }

export const PRAZO_DA_RODADA_MS = 90_000

type Linha = {
  id: string
  tenant_id: string
  status: string
  ambiente: AmbienteNfe
  payload: PedidoNfe
  serie: number
  numero: string
  chave: string | null
  xml_assinado: string | null
  recibo: string | null
  attempts: number
}

const minutos = (agora: Date, m: number) => new Date(agora.getTime() + m * 60_000)

async function lerCertificado(db: Queryable, tenantId: string): Promise<Certificado | null> {
  const { rows } = await db.query<{ pfx_base64: string | null; password: string | null }>(
    'select pfx_base64, password from nofiscal.read_certificate($1)',
    [tenantId],
  )
  const r = rows[0]
  return r?.pfx_base64 && r.password !== null ? { pfxBase64: r.pfx_base64, password: r.password ?? '' } : null
}

const erro = (s: string) => s.slice(0, 500)

export async function processarNfes(deps: WorkerNfeDeps): Promise<ResumoNfe> {
  const agora = deps.now()
  const resumo: ResumoNfe = { pegas: 0, autorizadas: 0, rejeitadas: 0, denegadas: 0, aguardando: 0, bloqueadas: 0, eventos: 0, adiadas: 0 }
  const relogio = deps.relogio ?? (() => Date.now())
  const fimDoPrazo = relogio() + (deps.prazoMs ?? PRAZO_DA_RODADA_MS)
  // A trava: quem pega a nota empurra `next_attempt_at` para frente; outro worker não a vê até lá.
  const { rows } = await deps.db.query<Linha>(
    `with alvo as (
       select n.id from nofiscal.fiscal_nfe n
        where n.status in ('queued', 'sending', 'processing')
          and (n.next_attempt_at is null or n.next_attempt_at <= $1)
          and ($3::uuid is null or n.tenant_id = $3)
        order by n.created_at
        limit $2
        for update skip locked)
     update nofiscal.fiscal_nfe n
        set next_attempt_at = $4, updated_at = $1
       from alvo where n.id = alvo.id
     returning n.id, n.tenant_id, n.status, n.ambiente, n.payload, n.serie, n.numero, n.chave, n.xml_assinado, n.recibo, n.attempts`,
    [agora, deps.limite ?? LOTE_PADRAO, deps.tenantId ?? null, minutos(agora, LEASE_MINUTOS)],
  )
  for (const nota of rows) {
    if (relogio() >= fimDoPrazo) {
      await deps.db.query('update nofiscal.fiscal_nfe set next_attempt_at = $2 where id = $1', [nota.id, agora])
      resumo.adiadas++
      continue
    }
    resumo.pegas++
    try {
      const fim = await processarUma(deps, nota, agora)
      if (fim === 'authorized') resumo.autorizadas++
      else if (fim === 'rejected') resumo.rejeitadas++
      else if (fim === 'denied') resumo.denegadas++
      else if (fim === 'bloqueada') resumo.bloqueadas++
      else resumo.aguardando++
    } catch (error) {
      resumo.aguardando++
      logEvent('nofiscal.nfe_falha_interna', { nfe_id: nota.id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
  }
  if (relogio() < fimDoPrazo) resumo.eventos = await processarEventos(deps, () => relogio() >= fimDoPrazo)
  return resumo
}

type Fim = 'authorized' | 'denied' | 'rejected' | 'aguardando' | 'bloqueada'

async function processarUma(deps: WorkerNfeDeps, nota: Linha, agora: Date): Promise<Fim> {
  const db = deps.db
  const bloquear = async (codigo: string): Promise<Fim> => {
    await db.query(
      `update nofiscal.fiscal_nfe set last_error_code = $2, last_error = 'emissão bloqueada', next_attempt_at = $3, updated_at = $4 where id = $1`,
      [nota.id, codigo, minutos(agora, 5), agora],
    )
    return 'bloqueada'
  }
  // O bloqueio vale para o que ainda não foi à Sefaz. Nota com XML gravado pode já estar autorizada: primeiro consulta
  // pela chave com o A1 da empresa (mesmo com assinatura em atraso ou conferência a refazer); só se a Sefaz não tiver a
  // nota (217) é que o bloqueio volta a valer antes de transmitir.
  const jaTinhaXml = Boolean(nota.xml_assinado)
  if (!jaTinhaXml) {
    const bloqueio = await bloqueioNfe(db, nota.tenant_id)
    if (bloqueio) return bloquear(bloqueio)
  }
  const empresa = (await empresaNfe(db, nota.tenant_id))!
  const uf = empresa.endereco!.uf
  const certificado = await lerCertificado(db, nota.tenant_id)
  const cred = certificado ? abrirCertificado(certificado, empresa.cnpj) : { erro: 'NFE_CERT_MISSING' }
  if ('erro' in cred) {
    const codigo = cred.erro.split(':')[0]
    // A1 de outro CNPJ ou ilegível não se resolve sozinho: a nota espera o A1 certo (troca do certificado).
    await db.query(
      `update nofiscal.fiscal_nfe set last_error_code = $2, last_error = $3, next_attempt_at = $4, updated_at = $5 where id = $1`,
      [nota.id, codigo, erro(cred.erro), minutos(agora, 60), agora],
    )
    logEvent('nofiscal.nfe_certificado', { nfe_id: nota.id, codigo })
    return 'bloqueada'
  }

  let xml = nota.xml_assinado
  let chave = nota.chave
  if (!xml) {
    try {
      const montada = montarNfe({
        ...nota.payload,
        ambiente: nota.ambiente,
        emitente: emitenteDaEmpresa(empresa),
        serie: nota.serie,
        numero: Number(nota.numero),
        emissao: agora,
        responsavelTecnico: deps.responsavelTecnico ?? null,
      })
      xml = deps.sefaz.assinarNfe(montada.xml, cred)
      chave = montada.chave
    } catch (error) {
      if (error instanceof NfeInvalidaError) return rejeitar(deps, nota.id, 'NFE_INVALIDA', error.problemas.join('; '), agora)
      throw error
    }
    // Gravado antes de transmitir: daqui em diante a nota é esta chave.
    await db.query(
      `update nofiscal.fiscal_nfe set status = 'sending', chave = $2, xml_assinado = $3, emitida_em = $4, updated_at = $4 where id = $1`,
      [nota.id, chave, xml, agora],
    )
  }

  let r: ResultadoAutorizacao | { kind: 'nao_encontrada' }
  if (nota.status === 'processing' && nota.recibo) {
    r = await deps.sefaz.consultarRecibo(uf, nota.ambiente, nota.recibo, xml, cred)
  } else if (jaTinhaXml) {
    r = await deps.sefaz.consultarChave(uf, nota.ambiente, chave!, xml, cred)
    if (r.kind === 'nao_encontrada') {
      const bloqueio = await bloqueioNfe(db, nota.tenant_id)
      if (bloqueio) return bloquear(bloqueio)
      r = await deps.sefaz.autorizar(uf, nota.ambiente, xml, cred)
    }
  } else {
    r = await deps.sefaz.autorizar(uf, nota.ambiente, xml, cred)
  }
  // 204 (duplicidade desta mesma chave) e 205 (já denegada): um envio anterior que voltou sem resposta. Vale o que a
  // consulta disser. O 539 (mesmo número com outra chave) não é nosso envio: rejeição definitiva, sem consulta.
  if (r.kind === 'rejeitada' && (r.cStat === '204' || r.cStat === '205')) {
    r = await deps.sefaz.consultarChave(uf, nota.ambiente, chave!, xml, cred)
  }
  return gravarResultado(deps, nota, r, agora)
}

async function gravarResultado(
  deps: WorkerNfeDeps,
  nota: Linha,
  r: ResultadoAutorizacao | { kind: 'nao_encontrada' },
  agora: Date,
): Promise<Fim> {
  const db = deps.db
  switch (r.kind) {
    case 'autorizada':
      await db.query(
        `update nofiscal.fiscal_nfe set status = 'authorized', protocolo = $2, xml_proc = $3, authorized_at = $4,
                last_error_code = null, last_error = null, next_attempt_at = null, updated_at = $4 where id = $1`,
        [nota.id, r.protocolo, r.xmlProc, agora],
      )
      logEvent('nofiscal.nfe_autorizada', { nfe_id: nota.id, cstat: r.cStat })
      await deps.onFinal?.(nota.id, 'authorized')
      return 'authorized'
    case 'denegada':
      await db.query(
        `update nofiscal.fiscal_nfe set status = 'denied', protocolo = $2, xml_proc = $3, last_error_code = $4, last_error = $5,
                next_attempt_at = null, updated_at = $6 where id = $1`,
        [nota.id, r.protocolo, r.xmlProc, r.cStat, erro(r.motivo), agora],
      )
      await deps.onFinal?.(nota.id, 'denied')
      return 'denied'
    case 'rejeitada':
      return rejeitar(deps, nota.id, r.cStat, r.motivo, agora)
    case 'em_processamento':
      await db.query(
        `update nofiscal.fiscal_nfe set status = 'processing', recibo = $2, next_attempt_at = $3, updated_at = $4 where id = $1`,
        [nota.id, r.recibo, new Date(agora.getTime() + 15_000), agora],
      )
      return 'aguardando'
    case 'nao_encontrada':
    case 'indisponivel': {
      const tentativas = Math.min(nota.attempts + 1, 20)
      const espera = BACKOFF_MINUTOS[Math.min(tentativas, BACKOFF_MINUTOS.length) - 1]
      await db.query(
        `update nofiscal.fiscal_nfe set status = 'sending', attempts = $2, next_attempt_at = $3, last_error_code = 'SEFAZ_INDISPONIVEL',
                last_error = $4, updated_at = $5 where id = $1`,
        [nota.id, tentativas, minutos(agora, espera), erro(r.kind === 'indisponivel' ? r.motivo : 'sem resposta da Sefaz'), agora],
      )
      logEvent('nofiscal.nfe_retentativa', { nfe_id: nota.id, attempts: tentativas })
      return 'aguardando'
    }
  }
}

async function rejeitar(deps: WorkerNfeDeps, nfeId: string, codigo: string, motivo: string, agora: Date): Promise<Fim> {
  await deps.db.query(
    `update nofiscal.fiscal_nfe set status = 'rejected', last_error_code = $2, last_error = $3, next_attempt_at = null, updated_at = $4
      where id = $1`,
    [nfeId, codigo, erro(motivo), agora],
  )
  logEvent('nofiscal.nfe_rejeitada', { nfe_id: nfeId, codigo })
  await deps.onFinal?.(nfeId, 'rejected')
  return 'rejected'
}

// --- eventos ---------------------------------------------------------------------------------------------

export type ResultadoPedidoEvento = { ok: true; eventoId: string } | { ok: false; mensagem: string }

const UMA_NOTA = `select n.id, n.tenant_id, n.status, n.ambiente, n.chave, n.protocolo, n.serie, n.numero, n.authorized_at
                    from nofiscal.fiscal_nfe n where n.id = $1`

type NotaDoEvento = { id: string; tenant_id: string; status: string; ambiente: AmbienteNfe; chave: string | null; protocolo: string | null; serie: number; numero: string; authorized_at: Date | null }

export async function pedirCancelamento(db: Db, nfeId: string, justificativa: string): Promise<ResultadoPedidoEvento> {
  return db.transaction(async (tx) => {
    const n = (await tx.query<NotaDoEvento>(`${UMA_NOTA} for update`, [nfeId])).rows[0]
    if (!n) return { ok: false, mensagem: 'Nota não encontrada.' }
    if (n.status !== 'authorized') return { ok: false, mensagem: 'Só nota autorizada pode ser cancelada.' }
    const texto = limpo(justificativa)
    if (texto.length < 15 || texto.length > 255) return { ok: false, mensagem: 'A justificativa precisa ter de 15 a 255 caracteres.' }
    const { rows } = await tx.query<{ id: string }>(
      `insert into nofiscal.fiscal_nfe_eventos (nfe_id, tenant_id, tipo, sequencia, texto) values ($1, $2, 'cancelamento', 1, $3)
       on conflict (nfe_id, tipo, sequencia) where nfe_id is not null do update set status = 'queued', texto = excluded.texto, updated_at = now()
       returning id`,
      [nfeId, n.tenant_id, texto],
    )
    await tx.query(`update nofiscal.fiscal_nfe set status = 'cancel_requested', updated_at = now() where id = $1`, [nfeId])
    return { ok: true, eventoId: rows[0].id }
  })
}

export async function pedirCartaCorrecao(db: Db, nfeId: string, correcao: string): Promise<ResultadoPedidoEvento> {
  return db.transaction(async (tx) => {
    const n = (await tx.query<NotaDoEvento>(`${UMA_NOTA} for update`, [nfeId])).rows[0]
    if (!n) return { ok: false, mensagem: 'Nota não encontrada.' }
    if (n.status !== 'authorized') return { ok: false, mensagem: 'Carta de correção só para nota autorizada.' }
    const texto = limpo(correcao)
    if (texto.length < 15 || texto.length > 1000) return { ok: false, mensagem: 'A correção precisa ter de 15 a 1.000 caracteres.' }
    const { rows: seq } = await tx.query<{ s: number | null }>(
      `select max(sequencia) as s from nofiscal.fiscal_nfe_eventos where nfe_id = $1 and tipo = 'cce'`,
      [nfeId],
    )
    const sequencia = (seq[0]?.s ?? 0) + 1
    if (sequencia > 20) return { ok: false, mensagem: 'A nota já tem 20 cartas de correção, o máximo.' }
    const { rows } = await tx.query<{ id: string }>(
      `insert into nofiscal.fiscal_nfe_eventos (nfe_id, tenant_id, tipo, sequencia, texto) values ($1, $2, 'cce', $3, $4) returning id`,
      [nfeId, n.tenant_id, sequencia, texto],
    )
    return { ok: true, eventoId: rows[0].id }
  })
}

/** Inutiliza o número de uma nota rejeitada (a numeração não pode ficar com buraco). */
export async function pedirInutilizacao(db: Db, nfeId: string, justificativa: string): Promise<ResultadoPedidoEvento> {
  return db.transaction(async (tx) => {
    const n = (await tx.query<NotaDoEvento>(`${UMA_NOTA} for update`, [nfeId])).rows[0]
    if (!n) return { ok: false, mensagem: 'Nota não encontrada.' }
    if (n.status !== 'rejected') return { ok: false, mensagem: 'Só o número de nota rejeitada pode ser inutilizado.' }
    const texto = limpo(justificativa)
    if (texto.length < 15 || texto.length > 255) return { ok: false, mensagem: 'A justificativa precisa ter de 15 a 255 caracteres.' }
    const { rows } = await tx.query<{ id: string }>(
      `insert into nofiscal.fiscal_nfe_eventos (nfe_id, tenant_id, tipo, sequencia, texto, serie, numero_inicial, numero_final)
       values ($1, $2, 'inutilizacao', 1, $3, $4, $5, $5)
       on conflict (nfe_id, tipo, sequencia) where nfe_id is not null do update set status = 'queued', texto = excluded.texto, updated_at = now()
       returning id`,
      [nfeId, n.tenant_id, texto, n.serie, n.numero],
    )
    return { ok: true, eventoId: rows[0].id }
  })
}

type LinhaEvento = {
  id: string
  nfe_id: string | null
  tenant_id: string
  tipo: 'cancelamento' | 'cce' | 'inutilizacao'
  sequencia: number
  texto: string
  serie: number | null
  numero_inicial: string | null
  numero_final: string | null
}

async function processarEventos(deps: WorkerNfeDeps, esgotado: () => boolean): Promise<number> {
  const agora = deps.now()
  const { rows } = await deps.db.query<LinhaEvento>(
    `with alvo as (
       select e.id from nofiscal.fiscal_nfe_eventos e
        where e.status = 'queued' and e.updated_at <= $1 and ($3::uuid is null or e.tenant_id = $3)
        order by e.created_at limit $2 for update skip locked)
     update nofiscal.fiscal_nfe_eventos e set updated_at = $4 from alvo where e.id = alvo.id
     returning e.id, e.nfe_id, e.tenant_id, e.tipo, e.sequencia, e.texto, e.serie, e.numero_inicial, e.numero_final`,
    [agora, deps.limite ?? LOTE_PADRAO, deps.tenantId ?? null, minutos(agora, LEASE_MINUTOS)],
  )
  let feitos = 0
  for (const ev of rows) {
    // O mesmo prazo da rodada: o evento que não coube volta para a fila na hora.
    if (esgotado()) {
      await deps.db.query('update nofiscal.fiscal_nfe_eventos set updated_at = $2 where id = $1', [ev.id, agora])
      continue
    }
    try {
      await processarEvento(deps, ev, agora)
      feitos++
    } catch (error) {
      logEvent('nofiscal.nfe_evento_falha', { evento_id: ev.id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
  }
  return feitos
}

async function processarEvento(deps: WorkerNfeDeps, ev: LinhaEvento, agora: Date): Promise<void> {
  const db = deps.db
  const empresa = (await empresaNfe(db, ev.tenant_id))!
  const uf = empresa.endereco?.uf
  const certificado = await lerCertificado(db, ev.tenant_id)
  const cred: Credencial | { erro: string } = certificado ? abrirCertificado(certificado, empresa.cnpj) : { erro: 'NFE_CERT_MISSING' }
  const falhar = async (codigo: string, motivo: string, definitivo: boolean) => {
    await db.query(
      `update nofiscal.fiscal_nfe_eventos set status = $2, last_error_code = $3, last_error = $4, updated_at = $5 where id = $1`,
      [ev.id, definitivo ? 'rejeitado' : 'queued', codigo, erro(motivo), definitivo ? agora : minutos(agora, 5)],
    )
    if (definitivo && ev.tipo === 'cancelamento' && ev.nfe_id) {
      await db.query(`update nofiscal.fiscal_nfe set status = 'authorized', last_error_code = $2, last_error = $3, updated_at = $4 where id = $1`, [
        ev.nfe_id,
        codigo,
        erro(`cancelamento recusado: ${motivo}`),
        agora,
      ])
    }
  }
  if (!uf || 'erro' in cred) return falhar('NFE_CERT_MISSING', 'erro' in cred ? cred.erro : 'empresa sem endereço', false)
  const nota = ev.nfe_id ? (await db.query<NotaDoEvento>(UMA_NOTA, [ev.nfe_id])).rows[0] : null
  const ambiente = nota?.ambiente ?? ambienteDaEmpresa(empresa)

  try {
    if (ev.tipo === 'inutilizacao') {
      const pedido = pedidoInutilizacao({
        ambiente,
        uf,
        cnpj: empresa.cnpj,
        ano: Number(new Intl.DateTimeFormat('en', { timeZone: 'America/Sao_Paulo', year: 'numeric' }).format(agora)),
        serie: ev.serie!,
        inicio: Number(ev.numero_inicial),
        fim: Number(ev.numero_final),
        justificativa: ev.texto,
      })
      const r = await deps.sefaz.inutilizar(uf, ambiente, pedido, cred)
      if (r.kind === 'indisponivel') return falhar('SEFAZ_INDISPONIVEL', r.motivo, false)
      if (r.kind === 'rejeitada') return falhar(r.cStat, r.motivo, true)
      // 256/563: um envio anterior já inutilizou a faixa (a resposta se perdeu). Fica registrado, sem o procInutNFe.
      const homologada = r.kind === 'homologada' ? r : { protocolo: null, xmlProc: null }
      await db.query(
        `update nofiscal.fiscal_nfe_eventos set status = 'registrado', protocolo = $2, xml_proc = $3, last_error_code = $5, last_error = null, updated_at = $4 where id = $1`,
        [ev.id, homologada.protocolo, homologada.xmlProc, agora, r.kind === 'ja_inutilizada' ? r.cStat : null],
      )
      if (ev.nfe_id) await db.query(`update nofiscal.fiscal_nfe set status = 'voided', updated_at = $2 where id = $1`, [ev.nfe_id, agora])
      return
    }
    if (!nota?.chave || !nota.protocolo) return falhar('NFE_SEM_PROTOCOLO', 'nota sem chave ou protocolo', true)
    const base = { ambiente, uf, cnpj: empresa.cnpj, chave: nota.chave, quando: agora }
    const pedido =
      ev.tipo === 'cancelamento'
        ? pedidoCancelamento({ ...base, protocolo: nota.protocolo, justificativa: ev.texto })
        : pedidoCartaCorrecao({ ...base, sequencia: ev.sequencia, correcao: ev.texto })
    let r = await deps.sefaz.evento(uf, ambiente, pedido, cred)
    if (r.kind === 'indisponivel') return falhar('SEFAZ_INDISPONIVEL', r.motivo, false)
    if (r.kind === 'duplicado') {
      // 573: o mesmo evento já está na Sefaz (um envio anterior que voltou sem resposta). O protocolo e o procEventoNFe
      // vêm da consulta pela chave; enquanto ela não responde, o evento fica na fila (nunca vira recusa).
      const tipo = ev.tipo === 'cancelamento' ? '110111' : '110110'
      const s = await deps.sefaz.consultarEventos(uf, ambiente, nota.chave, cred)
      const achado = s.kind === 'ok' ? s.eventos.find((e) => e.tpEvento === tipo && e.sequencia === (ev.tipo === 'cancelamento' ? 1 : ev.sequencia)) : null
      if (!achado) return falhar('SEFAZ_INDISPONIVEL', `evento duplicado (573) ainda não encontrado na consulta`, false)
      r = { kind: 'registrado', protocolo: achado.protocolo, cStat: '573', motivo: 'já registrado', xmlProc: achado.xmlProc }
    }
    if (r.kind === 'rejeitado') return falhar(r.cStat, r.motivo, true)
    await db.query(
      `update nofiscal.fiscal_nfe_eventos set status = 'registrado', protocolo = $2, xml_proc = $3, last_error_code = null, last_error = null, updated_at = $4 where id = $1`,
      [ev.id, r.protocolo, r.xmlProc, agora],
    )
    if (ev.tipo === 'cancelamento') {
      await db.query(
        `update nofiscal.fiscal_nfe set status = 'cancelled', cancelled_at = $2, last_error_code = null, last_error = null, updated_at = $2 where id = $1`,
        [nota.id, agora],
      )
      await deps.onFinal?.(nota.id, 'cancelled')
    }
  } catch (error) {
    if (error instanceof PedidoInvalidoError) return falhar('PEDIDO_INVALIDO', error.message, true)
    throw error
  }
}

/** Responsável técnico do leiaute (infRespTec), configurado no ambiente da Vercel. */
export function responsavelTecnicoFromEnv(env: NodeJS.ProcessEnv = process.env): ResponsavelTecnico | null {
  const cnpj = env.NFE_RESP_TEC_CNPJ
  if (!cnpj || !env.NFE_RESP_TEC_EMAIL || !env.NFE_RESP_TEC_FONE) return null
  return { cnpj, contato: env.NFE_RESP_TEC_CONTATO ?? 'Suporte', email: env.NFE_RESP_TEC_EMAIL, fone: env.NFE_RESP_TEC_FONE }
}

// --- histórico da empresa (emissão avulsa) -----------------------------------------------------------------

export type HistoricoNfe = {
  /** Destinatários das últimas notas, o mais recente primeiro, um por CPF/CNPJ. */
  destinatarios: PedidoNfe['destinatario'][]
  /** Produtos das últimas notas, o mais recente primeiro, um por código (o item como saiu, sem quantidade/desconto). */
  produtos: Omit<Item, 'quantidade' | 'desconto' | 'frete' | 'seguro' | 'outros'>[]
  /** Transportadores já usados, um por CPF/CNPJ (ou nome, sem documento). */
  transportadores: Transportador[]
}

/**
 * O que a empresa já emitiu (NF-e não rejeitada, das últimas 300): base do formulário avulso do painel e da conversa no
 * WhatsApp, para não pedir de novo NCM, CFOP e CSOSN de produto que já saiu, nem endereço de cliente conhecido.
 */
export async function historicoNfe(db: Queryable, tenantId: string): Promise<HistoricoNfe> {
  const { rows } = await db.query<{ payload: PedidoNfe | string }>(
    `select payload from nofiscal.fiscal_nfe
      where tenant_id = $1 and status not in ('rejected', 'denied', 'voided')
      order by created_at desc limit 300`,
    [tenantId],
  )
  const destinatarios = new Map<string, HistoricoNfe['destinatarios'][number]>()
  const produtos = new Map<string, HistoricoNfe['produtos'][number]>()
  const transportadores = new Map<string, Transportador>()
  for (const r of rows) {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as PedidoNfe
    const doc = soDigitos(p.destinatario?.documento)
    if (doc && !destinatarios.has(doc)) destinatarios.set(doc, p.destinatario)
    for (const item of p.itens ?? []) {
      const k = item.codigo?.trim().toUpperCase()
      if (!k || produtos.has(k)) continue
      produtos.set(k, {
        codigo: item.codigo, descricao: item.descricao, ncm: item.ncm, cest: item.cest ?? null, cfop: item.cfop, unidade: item.unidade,
        valorUnitario: item.valorUnitario, origem: item.origem, csosn: item.csosn, aliquotaCreditoSN: item.aliquotaCreditoSN ?? null,
        cstPisCofins: item.cstPisCofins, gtin: item.gtin ?? null, informacoes: item.informacoes ?? null,
      })
    }
    const t = p.transportador
    const kt = t ? soDigitos(t.documento) || (t.nome ?? '').trim().toUpperCase() : ''
    if (t && kt && !transportadores.has(kt)) transportadores.set(kt, t)
  }
  return { destinatarios: [...destinatarios.values()], produtos: [...produtos.values()], transportadores: [...transportadores.values()] }
}
