// Cadastro do agente fiscal (critérios 1, 4, 5 e 6), gravado pelo `nofiscal_service`
// (Landing, lote A - quem grava o cadastro). Formas literais no Landing:
// - conta ativa = e-mail e WhatsApp confirmados (`fiscal_accounts.*_verified_at`);
// - código de 6 dígitos, válido por 10 minutos (Unresolved 17), guardado só como
//   sha256(id + ':' + código); um código novo invalida os anteriores; o 5º erro mata o código;
// - "dono" = conta ativa com `fiscal_accounts.client_id` = `fiscal_tenants.client_id`;
// - um número pertence a um único tenant (`fiscal_phones.phone_e164` UNIQUE, revogados inclusive).
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Queryable } from '../db.js'
import type { EnviaEmail, EnviaWhatsApp } from './canais.js'
import { comNonoDigito, normalizarEmail, normalizarTelefone } from './normalizacao.js'

export const CODIGO_VALIDADE_MINUTOS = 10
export const CODIGO_MAX_ERROS = 5
export const MENSAGEM_NUMERO_DE_OUTRA_EMPRESA = 'Este WhatsApp já está ligado a outra empresa'

export type CadastroDeps = {
  db: Queryable
  email: EnviaEmail
  whatsapp: EnviaWhatsApp
  now?: () => Date
  /** Gera o código de 6 dígitos; padrão: `crypto.randomInt`. */
  gerarCodigo?: () => string
}

type Proposito = 'account_email' | 'account_phone' | 'phone_authorization'
type Dono = { userId: string } | { phoneId: string }

export type MotivoCodigo = 'SEM_CODIGO' | 'CODIGO_VENCIDO' | 'CODIGO_INVALIDO'

const agoraDe = (deps: CadastroDeps) => (deps.now ?? (() => new Date()))()
export const codigoAleatorio = () => String(randomInt(0, 1_000_000)).padStart(6, '0')
export const hashDoCodigo = (id: string, codigo: string) => createHash('sha256').update(`${id}:${codigo}`, 'utf8').digest('hex')

export function iguais(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

function filtroDoDono(dono: Dono): { coluna: 'user_id' | 'phone_id'; valor: string } {
  return 'userId' in dono ? { coluna: 'user_id', valor: dono.userId } : { coluna: 'phone_id', valor: dono.phoneId }
}

/** Gera e grava um código novo (invalida os anteriores do mesmo propósito) e o devolve. */
async function emitirCodigo(deps: CadastroDeps, proposito: Proposito, dono: Dono): Promise<string> {
  const agora = agoraDe(deps)
  const codigo = (deps.gerarCodigo ?? codigoAleatorio)()
  const id = randomUUID()
  const { coluna, valor } = filtroDoDono(dono)
  await deps.db.query(
    `update nofiscal.fiscal_verification_codes
        set expires_at = least(expires_at, $3)
      where purpose = $1 and ${coluna} = $2 and consumed_at is null`,
    [proposito, valor, agora],
  )
  await deps.db.query(
    `insert into nofiscal.fiscal_verification_codes (id, purpose, ${coluna}, code_hash, expires_at, created_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, proposito, valor, hashDoCodigo(id, codigo), new Date(agora.getTime() + CODIGO_VALIDADE_MINUTOS * 60_000), agora],
  )
  return codigo
}

/** Confere o código mais recente do propósito; acerto o consome, erro conta uma tentativa. */
async function conferirCodigo(
  deps: CadastroDeps,
  proposito: Proposito,
  dono: Dono,
  codigo: string,
): Promise<{ ok: true } | { ok: false; motivo: MotivoCodigo }> {
  const agora = agoraDe(deps)
  const { coluna, valor } = filtroDoDono(dono)
  const { rows } = await deps.db.query<{ id: string; code_hash: string; expires_at: Date; attempts: number }>(
    `select id, code_hash, expires_at, attempts
       from nofiscal.fiscal_verification_codes
      where purpose = $1 and ${coluna} = $2 and consumed_at is null
      order by created_at desc
      limit 1`,
    [proposito, valor],
  )
  const atual = rows[0]
  if (!atual) return { ok: false, motivo: 'SEM_CODIGO' }
  if (atual.expires_at.getTime() <= agora.getTime()) return { ok: false, motivo: 'CODIGO_VENCIDO' }
  if (atual.attempts >= CODIGO_MAX_ERROS) return { ok: false, motivo: 'CODIGO_INVALIDO' }
  if (!/^\d{6}$/.test(codigo.trim()) || !iguais(hashDoCodigo(atual.id, codigo.trim()), atual.code_hash)) {
    await deps.db.query(
      'update nofiscal.fiscal_verification_codes set attempts = least(attempts + 1, $2) where id = $1',
      [atual.id, CODIGO_MAX_ERROS],
    )
    return { ok: false, motivo: 'CODIGO_INVALIDO' }
  }
  // Consumo condicional: duas confirmações simultâneas, só uma vence.
  const consumido = await deps.db.query(
    'update nofiscal.fiscal_verification_codes set consumed_at = $2 where id = $1 and consumed_at is null',
    [atual.id, agora],
  )
  return consumido.rowCount === 1 ? { ok: true } : { ok: false, motivo: 'SEM_CODIGO' }
}

const textoDoCodigo = (codigo: string) =>
  `Seu código da Nó é ${codigo}. Ele vale por ${CODIGO_VALIDADE_MINUTOS} minutos. Não compartilhe com ninguém.`

async function enviarCodigoDaConta(deps: CadastroDeps, canal: 'email' | 'whatsapp', userId: string, para: string) {
  const codigo = await emitirCodigo(deps, canal === 'email' ? 'account_email' : 'account_phone', { userId })
  if (canal === 'email') await deps.email.enviar({ para, assunto: 'Seu código da Nó', texto: textoDoCodigo(codigo) })
  else await deps.whatsapp.enviarTexto(para, textoDoCodigo(codigo))
}

// ---------------------------------------------------------------------------------------
// Conta

export type ResultadoCriarConta =
  | { ok: true }
  | { ok: false; erro: 'EMAIL_INVALIDO' | 'TELEFONE_INVALIDO' | 'CONTA_JA_ATIVA' }

/** Cria (ou recomeça, se ainda inativa) a conta e manda os dois códigos. */
export async function criarConta(
  deps: CadastroDeps,
  entrada: { userId: string; email: string; telefone: string },
): Promise<ResultadoCriarConta> {
  const email = normalizarEmail(entrada.email)
  if (!email) return { ok: false, erro: 'EMAIL_INVALIDO' }
  const telefone = normalizarTelefone(entrada.telefone)
  if (!telefone) return { ok: false, erro: 'TELEFONE_INVALIDO' }

  const { rowCount } = await deps.db.query(
    `insert into nofiscal.fiscal_accounts (user_id, email, phone_e164)
     values ($1, $2, $3)
     on conflict (user_id) do update
        set email = excluded.email, phone_e164 = excluded.phone_e164,
            email_verified_at = null, phone_verified_at = null, updated_at = now()
      where nofiscal.fiscal_accounts.email_verified_at is null
         or nofiscal.fiscal_accounts.phone_verified_at is null`,
    [entrada.userId, email, telefone],
  )
  if (rowCount === 0) return { ok: false, erro: 'CONTA_JA_ATIVA' }

  await enviarCodigoDaConta(deps, 'email', entrada.userId, email)
  await enviarCodigoDaConta(deps, 'whatsapp', entrada.userId, telefone)
  return { ok: true }
}

export async function reenviarCodigoDaConta(
  deps: CadastroDeps,
  entrada: { userId: string; canal: 'email' | 'whatsapp' },
): Promise<{ ok: boolean }> {
  const { rows } = await deps.db.query<{ email: string; phone_e164: string }>(
    'select email, phone_e164 from nofiscal.fiscal_accounts where user_id = $1',
    [entrada.userId],
  )
  const conta = rows[0]
  if (!conta) return { ok: false }
  await enviarCodigoDaConta(deps, entrada.canal, entrada.userId, entrada.canal === 'email' ? conta.email : conta.phone_e164)
  return { ok: true }
}

export async function contaAtiva(db: Queryable, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ ativa: boolean }>(
    `select email_verified_at is not null and phone_verified_at is not null as ativa
       from nofiscal.fiscal_accounts where user_id = $1`,
    [userId],
  )
  return rows[0]?.ativa ?? false
}

export async function confirmarCodigoDaConta(
  deps: CadastroDeps,
  entrada: { userId: string; canal: 'email' | 'whatsapp'; codigo: string },
): Promise<{ ok: boolean; motivo?: MotivoCodigo; contaAtiva: boolean }> {
  const proposito = entrada.canal === 'email' ? 'account_email' : 'account_phone'
  const conferido = await conferirCodigo(deps, proposito, { userId: entrada.userId }, entrada.codigo)
  if (conferido.ok) {
    const coluna = entrada.canal === 'email' ? 'email_verified_at' : 'phone_verified_at'
    await deps.db.query(
      `update nofiscal.fiscal_accounts set ${coluna} = coalesce(${coluna}, $2), updated_at = now() where user_id = $1`,
      [entrada.userId, agoraDe(deps)],
    )
  }
  const ativa = await contaAtiva(deps.db, entrada.userId)
  return conferido.ok ? { ok: true, contaAtiva: ativa } : { ok: false, motivo: conferido.motivo, contaAtiva: ativa }
}

// ---------------------------------------------------------------------------------------
// Dono do tenant

async function eDono(db: Queryable, userId: string, tenantId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1
       from nofiscal.fiscal_accounts a
       join nofiscal.fiscal_tenants t on t.client_id = a.client_id
      where a.user_id = $1 and t.id = $2
        and a.email_verified_at is not null and a.phone_verified_at is not null`,
    [userId, tenantId],
  )
  return rows.length === 1
}

// ---------------------------------------------------------------------------------------
// Números autorizados

export type ResultadoAutorizar =
  | { ok: true; phoneId: string }
  | { ok: false; erro: 'FORBIDDEN' | 'TELEFONE_INVALIDO' | 'JA_AUTORIZADO' }
  | { ok: false; erro: 'NUMERO_DE_OUTRA_EMPRESA'; mensagem: typeof MENSAGEM_NUMERO_DE_OUTRA_EMPRESA }

/** O dono autoriza um número; ele só emite depois de confirmar o código recebido no WhatsApp. */
export async function autorizarNumero(
  deps: CadastroDeps,
  entrada: { userId: string; tenantId: string; telefone: string },
): Promise<ResultadoAutorizar> {
  if (!(await eDono(deps.db, entrada.userId, entrada.tenantId))) return { ok: false, erro: 'FORBIDDEN' }
  const telefone = normalizarTelefone(entrada.telefone)
  if (!telefone) return { ok: false, erro: 'TELEFONE_INVALIDO' }

  const inserido = await deps.db.query<{ id: string }>(
    `insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role) values ($1, $2, 'authorized')
     on conflict (phone_e164) do nothing
     returning id`,
    [entrada.tenantId, telefone],
  )
  let phoneId = inserido.rows[0]?.id
  if (!phoneId) {
    const { rows } = await deps.db.query<{
      id: string
      tenant_id: string
      role: string
      verified_at: Date | null
      revoked_at: Date | null
    }>('select id, tenant_id, role, verified_at, revoked_at from nofiscal.fiscal_phones where phone_e164 = $1', [telefone])
    const existente = rows[0]
    if (existente.tenant_id !== entrada.tenantId) {
      return { ok: false, erro: 'NUMERO_DE_OUTRA_EMPRESA', mensagem: MENSAGEM_NUMERO_DE_OUTRA_EMPRESA }
    }
    if (existente.role === 'owner' || (existente.verified_at && !existente.revoked_at)) {
      return { ok: false, erro: 'JA_AUTORIZADO' }
    }
    // Revogado ou ainda sem confirmação: reabre e pede um código novo.
    await deps.db.query('update nofiscal.fiscal_phones set verified_at = null, revoked_at = null where id = $1', [existente.id])
    phoneId = existente.id
  }

  const codigo = await emitirCodigo(deps, 'phone_authorization', { phoneId })
  await deps.whatsapp.enviarTexto(
    telefone,
    `Você foi autorizado a emitir notas fiscais pela Nó. Para confirmar, responda com o código ${codigo}. Ele vale por ${CODIGO_VALIDADE_MINUTOS} minutos.`,
  )
  return { ok: true, phoneId }
}

/** O número autorizado confirma o código (pelo WhatsApp ou pelo site). */
export async function confirmarNumero(
  deps: CadastroDeps,
  entrada: { telefone: string; codigo: string },
): Promise<{ ok: true } | { ok: false; motivo: MotivoCodigo | 'NUMERO_DESCONHECIDO' }> {
  const telefone = normalizarTelefone(entrada.telefone)
  if (!telefone) return { ok: false, motivo: 'NUMERO_DESCONHECIDO' }
  const { rows } = await deps.db.query<{ id: string }>(
    `select id from nofiscal.fiscal_phones where phone_e164 = $1 and revoked_at is null and role = 'authorized'`,
    [telefone],
  )
  const phone = rows[0]
  if (!phone) return { ok: false, motivo: 'NUMERO_DESCONHECIDO' }
  const conferido = await conferirCodigo(deps, 'phone_authorization', { phoneId: phone.id }, entrada.codigo)
  if (!conferido.ok) return conferido
  await deps.db.query(
    'update nofiscal.fiscal_phones set verified_at = $2 where id = $1 and revoked_at is null',
    [phone.id, agoraDe(deps)],
  )
  return { ok: true }
}

export async function revogarNumero(
  deps: CadastroDeps,
  entrada: { userId: string; tenantId: string; telefone: string },
): Promise<{ ok: true } | { ok: false; erro: 'FORBIDDEN' | 'NAO_ENCONTRADO' | 'NUMERO_DO_DONO' }> {
  if (!(await eDono(deps.db, entrada.userId, entrada.tenantId))) return { ok: false, erro: 'FORBIDDEN' }
  const telefone = normalizarTelefone(entrada.telefone)
  if (!telefone) return { ok: false, erro: 'NAO_ENCONTRADO' }
  const { rows } = await deps.db.query<{ id: string; role: string }>(
    'select id, role from nofiscal.fiscal_phones where phone_e164 = $1 and tenant_id = $2',
    [telefone, entrada.tenantId],
  )
  const phone = rows[0]
  if (!phone) return { ok: false, erro: 'NAO_ENCONTRADO' }
  if (phone.role === 'owner') return { ok: false, erro: 'NUMERO_DO_DONO' }
  const agora = agoraDe(deps)
  await deps.db.query('update nofiscal.fiscal_phones set revoked_at = coalesce(revoked_at, $2) where id = $1', [
    phone.id,
    agora,
  ])
  // Código pendente do número revogado deixa de valer.
  await deps.db.query(
    `update nofiscal.fiscal_verification_codes set expires_at = least(expires_at, $2)
      where phone_id = $1 and consumed_at is null`,
    [phone.id, agora],
  )
  return { ok: true }
}

/** Número que pode emitir agora: verificado e não revogado (`nofiscal.emitting_phone`). */
export async function numeroPodeEmitir(db: Queryable, telefone: string): Promise<{ phoneId: string; tenantId: string } | null> {
  const normalizado = normalizarTelefone(telefone)
  const e164 = normalizado ? comNonoDigito(normalizado) : null
  if (!e164) return null
  const { rows } = await db.query<{ phone_id: string; tenant_id: string }>(
    'select phone_id, tenant_id from nofiscal.emitting_phone($1)',
    [e164],
  )
  return rows[0] ? { phoneId: rows[0].phone_id, tenantId: rows[0].tenant_id } : null
}

// ---------------------------------------------------------------------------------------
// Contador

export async function definirContador(
  deps: CadastroDeps,
  entrada: { userId: string; tenantId: string; email: string | null },
): Promise<{ ok: true } | { ok: false; erro: 'FORBIDDEN' | 'EMAIL_INVALIDO' }> {
  if (!(await eDono(deps.db, entrada.userId, entrada.tenantId))) return { ok: false, erro: 'FORBIDDEN' }
  let email: string | null = null
  if (entrada.email !== null && entrada.email.trim() !== '') {
    email = normalizarEmail(entrada.email)
    if (!email) return { ok: false, erro: 'EMAIL_INVALIDO' }
  }
  await deps.db.query('update nofiscal.fiscal_tenants set contador_email = $2, updated_at = now() where id = $1', [
    entrada.tenantId,
    email,
  ])
  return { ok: true }
}
