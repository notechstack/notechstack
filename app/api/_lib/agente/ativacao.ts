// Ativação do WhatsApp do dono pelo código que ele mesmo manda (critérios 25 a 28; Landing v2,
// lote C - rota de ativação e ativação pelo WhatsApp). O código nasce na página (etapa 7) e
// chega ao agente na mensagem de ativação (código no fim; também `ATIVAR <código>`) vinda do número cadastrado; a resposta ao modelo de
// reserva (28) também ativa. Ativar = número verificado na conta e no `fiscal_phones` do dono,
// código consumido e as boas-vindas começando.
import { randomUUID } from 'node:crypto'
import type { Db, Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { codigoAleatorio, CODIGO_MAX_ERROS, hashDoCodigo, iguais } from './cadastro.js'
import type { EnviaWhatsApp } from './canais.js'
import type { CatalogoDeServicos } from './catalogo-servicos.js'
import type { MensagemRecebida } from './conversa.js'
import type { Links } from './links.js'
import { perguntaDeConferencia } from './boas-vindas.js'

export const ATIVACAO_VALIDADE_MS = 24 * 3600_000
export const PROPOSITO_ATIVACAO = 'whatsapp_activation'
const ATIVAR = /^ATIVAR\s+(\d{6})$/i
// Mensagem legível (Lucca, 22/10/2026): "Quero ativar o nó.fiscal da <empresa> no plano <plano>. Código de ativação:
// 123456". O código continua sendo a chave; empresa e plano são só para a pessoa (e quem lê a conversa) entender.
const CODIGO_NA_FRASE = /c[oó]digo\s+de\s+ativa[cç][aã]o\s*:?\s*(\d{6})\b/i
const NOMES_DOS_PLANOS: Record<string, string> = { inicial: 'Inicial', pro: 'Pro' }

/** Texto que vai pronto no link do WhatsApp. */
export function mensagemDeAtivacao(razaoSocial: string, plano: string, codigo: string): string {
  const empresa = razaoSocial.replace(/\s+/g, ' ').trim()
  return `Quero ativar o nó.fiscal da ${empresa} no plano ${NOMES_DOS_PLANOS[plano] ?? 'Inicial'}. Código de ativação: ${codigo}`
}

/** O código de 6 dígitos de uma mensagem de ativação (a nova, a antiga `ATIVAR 123456`), ou null. */
export function codigoDaMensagem(texto: string): string | null {
  const t = texto.trim()
  return (ATIVAR.exec(t) ?? CODIGO_NA_FRASE.exec(t))?.[1] ?? null
}

/** Etapas do site em que ainda não se gera o código (Landing, lote C - rota de ativação). */
export const ETAPAS_ANTES_DA_ATIVACAO = ['pagamento', 'certificado', 'dados_fiscais'] as const
const ETAPAS_QUE_ABREM_AS_BOAS_VINDAS = ['clientes', 'ativacao']

export const chaveDaReserva = (tenantId: string) => `boas-vindas:${tenantId}`

// ---------------------------------------------------------------------------------------
// Rota: gerar o código.

export type ResultadoDoCodigo =
  | { ok: true; codigo: string; mensagem: string; whatsappUrl: string; expiraEm: Date }
  | { ok: false; erro: 'FORBIDDEN' | 'JA_ATIVADO' | 'ONBOARDING_INCOMPLETO' | 'SEM_NUMERO_DO_AGENTE' }

export async function gerarCodigoDeAtivacao(
  deps: { db: Db; numeroDoAgente: string | undefined; now?: () => Date; gerarCodigo?: () => string },
  entrada: { userId: string; tenantId: string },
): Promise<ResultadoDoCodigo> {
  const agora = (deps.now ?? (() => new Date()))()
  const { rows } = await deps.db.query<{ phone_verified_at: Date | null; onboarding_etapa: string; razao_social: string; plan: string }>(
    `select a.phone_verified_at, t.onboarding_etapa, t.razao_social, t.plan
       from nofiscal.fiscal_accounts a
       join nofiscal.fiscal_tenants t on t.client_id = a.client_id
      where a.user_id = $1 and t.id = $2 and a.email_verified_at is not null`,
    [entrada.userId, entrada.tenantId],
  )
  const dono = rows[0]
  if (!dono) return { ok: false, erro: 'FORBIDDEN' }
  if (dono.phone_verified_at) return { ok: false, erro: 'JA_ATIVADO' }
  if ((ETAPAS_ANTES_DA_ATIVACAO as readonly string[]).includes(dono.onboarding_etapa)) {
    return { ok: false, erro: 'ONBOARDING_INCOMPLETO' }
  }
  const numero = (deps.numeroDoAgente ?? '').replace(/\D/g, '')
  if (!numero) return { ok: false, erro: 'SEM_NUMERO_DO_AGENTE' }

  const codigo = (deps.gerarCodigo ?? codigoAleatorio)()
  const id = randomUUID()
  const expiraEm = new Date(agora.getTime() + ATIVACAO_VALIDADE_MS)
  await deps.db.transaction(async (tx) => {
    // Um código novo invalida os anteriores, como na v1.
    await tx.query(
      `update nofiscal.fiscal_verification_codes set expires_at = least(expires_at, $3)
        where purpose = $1 and user_id = $2 and consumed_at is null`,
      [PROPOSITO_ATIVACAO, entrada.userId, agora],
    )
    await tx.query(
      `insert into nofiscal.fiscal_verification_codes (id, purpose, user_id, code_hash, expires_at, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, PROPOSITO_ATIVACAO, entrada.userId, hashDoCodigo(id, codigo), expiraEm, agora],
    )
    await tx.query(
      `update nofiscal.fiscal_tenants set onboarding_etapa = 'ativacao', updated_at = $2
        where id = $1 and onboarding_etapa = 'clientes'`,
      [entrada.tenantId, agora],
    )
  })
  const mensagem = mensagemDeAtivacao(dono.razao_social, dono.plan, codigo)
  return { ok: true, codigo, mensagem, whatsappUrl: `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`, expiraEm }
}

// ---------------------------------------------------------------------------------------
// Webhook: `ATIVAR <código>` e resposta ao modelo de reserva.

export type AtivacaoDeps = {
  db: Db
  /** Já com retentativa. */
  whatsapp: EnviaWhatsApp
  links: Links
  agora: Date
  catalogo?: CatalogoDeServicos
}

/** `+5511987654321` → `+55 11 *****-4321`. */
export function mascararTelefone(e164: string): string {
  const digitos = e164.replace(/\D/g, '')
  if (digitos.startsWith('55') && digitos.length >= 12) return `+55 ${digitos.slice(2, 4)} *****-${digitos.slice(-4)}`
  return `+${'*'.repeat(Math.max(0, digitos.length - 4))}${digitos.slice(-4)}`
}

const textoInvalido = (links: Links) => `Código de ativação inválido. Gere outro em ${links.conta}`
const textoOutroNumero = (telefone: string) => `A ativação precisa sair do WhatsApp cadastrado: ${mascararTelefone(telefone)}`
const textoFaltaSite = (links: Links) =>
  `Número ativado. Falta terminar a configuração em ${links.conta}. Depois, é só me mandar uma mensagem aqui.`

type Pendente = { id: string; code_hash: string; user_id: string; phone_e164: string; tenant_id: string }

/**
 * Trata a mensagem se ela for de ativação. Devolve `true` quando respondeu (e a conversa para
 * aqui), `false` quando a mensagem não é de ativação.
 */
export async function tratarAtivacao(deps: AtivacaoDeps, msg: MensagemRecebida): Promise<boolean> {
  const texto = msg.tipo === 'text' ? (msg.texto ?? '').trim() : ''
  const codigo = codigoDaMensagem(texto)
  if (codigo) {
    await ativarPeloCodigo(deps, msg.de, codigo)
    return true
  }
  // Critério 28: resposta ao modelo de reserva, de qualquer tipo, vinda do número cadastrado.
  const { rows } = await deps.db.query<{ user_id: string; tenant_id: string }>(
    `select a.user_id, t.id as tenant_id
       from nofiscal.fiscal_accounts a
       join nofiscal.fiscal_tenants t on t.client_id = a.client_id
      where a.phone_e164 = $1 and a.phone_verified_at is null
        and exists (select 1 from nofiscal.fiscal_agent_once o where o.chave = 'boas-vindas:' || t.id::text)
      limit 1`,
    [msg.de],
  )
  const reserva = rows[0]
  if (!reserva) return false
  await ativar(deps, { userId: reserva.user_id, tenantId: reserva.tenant_id, telefone: msg.de, codigoId: null })
  logEvent('agente.ativado', { tenant_id: reserva.tenant_id, por: 'reserva' })
  return true
}

async function ativarPeloCodigo(deps: AtivacaoDeps, remetente: string, codigo: string): Promise<void> {
  const { rows: pendentes } = await deps.db.query<Pendente>(
    `select c.id, c.code_hash, c.user_id, a.phone_e164, t.id as tenant_id
       from nofiscal.fiscal_verification_codes c
       join nofiscal.fiscal_accounts a on a.user_id = c.user_id
       join nofiscal.fiscal_tenants t on t.client_id = a.client_id
      where c.purpose = $1 and c.consumed_at is null and c.expires_at > $2 and c.attempts < $3`,
    [PROPOSITO_ATIVACAO, deps.agora, CODIGO_MAX_ERROS],
  )
  const achado = pendentes.find((p) => iguais(hashDoCodigo(p.id, codigo), p.code_hash))

  if (achado && achado.phone_e164 !== remetente) {
    logEvent('agente.ativacao_de_outro_numero', { tenant_id: achado.tenant_id })
    await deps.whatsapp.enviarTexto(remetente, textoOutroNumero(achado.phone_e164))
    return
  }
  if (achado && (await ativar(deps, { userId: achado.user_id, tenantId: achado.tenant_id, telefone: remetente, codigoId: achado.id }))) {
    logEvent('agente.ativado', { tenant_id: achado.tenant_id, por: 'codigo' })
    return
  }

  // Erro conta uma tentativa no código pendente de quem mandou, se o número for de uma conta.
  await deps.db.query(
    `update nofiscal.fiscal_verification_codes set attempts = least(attempts + 1, $3)
      where id = (select c.id from nofiscal.fiscal_verification_codes c
                    join nofiscal.fiscal_accounts a on a.user_id = c.user_id
                   where a.phone_e164 = $1 and c.purpose = $2 and c.consumed_at is null and c.expires_at > $4
                   order by c.created_at desc limit 1)`,
    [remetente, PROPOSITO_ATIVACAO, CODIGO_MAX_ERROS, deps.agora],
  )
  await deps.whatsapp.enviarTexto(remetente, textoInvalido(deps.links))
}

/** Grava a ativação numa transação e responde. `false` quando o código já tinha sido consumido. */
async function ativar(
  deps: AtivacaoDeps,
  alvo: { userId: string; tenantId: string; telefone: string; codigoId: string | null },
): Promise<boolean> {
  const etapa = await deps.db.transaction(async (tx) => {
    if (alvo.codigoId) {
      // Unresolved 14: dois ATIVAR simultâneos, só um consome.
      const consumido = await tx.query(
        'update nofiscal.fiscal_verification_codes set consumed_at = $2 where id = $1 and consumed_at is null',
        [alvo.codigoId, deps.agora],
      )
      if (consumido.rowCount !== 1) return null
    }
    await tx.query(
      `update nofiscal.fiscal_verification_codes set consumed_at = $3
        where purpose = $1 and user_id = $2 and consumed_at is null`,
      [PROPOSITO_ATIVACAO, alvo.userId, deps.agora],
    )
    await tx.query(
      `update nofiscal.fiscal_accounts set phone_verified_at = coalesce(phone_verified_at, $2), updated_at = now()
        where user_id = $1`,
      [alvo.userId, deps.agora],
    )
    await tx.query(
      `update nofiscal.fiscal_phones set verified_at = coalesce(verified_at, $3)
        where tenant_id = $1 and phone_e164 = $2 and role = 'owner'`,
      [alvo.tenantId, alvo.telefone, deps.agora],
    )
    return abrirBoasVindas(tx, alvo.tenantId, deps.agora)
  })
  if (etapa === null) return false
  if (etapa === 'boas_vindas_conferir') {
    await deps.whatsapp.enviarTexto(alvo.telefone, await perguntaDeConferencia(deps.db, alvo.tenantId, deps.catalogo))
  } else {
    await deps.whatsapp.enviarTexto(alvo.telefone, textoFaltaSite(deps.links))
  }
  return true
}

/** Passa a `boas_vindas_conferir` quem já terminou o site; devolve a etapa em que o tenant fica. */
export async function abrirBoasVindas(db: Queryable, tenantId: string, agora: Date): Promise<string> {
  const { rows } = await db.query<{ onboarding_etapa: string }>(
    `update nofiscal.fiscal_tenants
        set onboarding_etapa = case when onboarding_etapa = any($3::text[]) then 'boas_vindas_conferir' else onboarding_etapa end,
            agente_conversa = case when onboarding_etapa = any($3::text[]) then agente_conversa - 'boas_vindas' else agente_conversa end,
            updated_at = $2
      where id = $1
      returning onboarding_etapa`,
    [tenantId, agora, ETAPAS_QUE_ABREM_AS_BOAS_VINDAS],
  )
  return rows[0]?.onboarding_etapa ?? 'pagamento'
}
