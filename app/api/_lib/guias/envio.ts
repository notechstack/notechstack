// Passo do worker do módulo Guias (critérios 12 a 15), a cada minuto em app/api/internal/nfse-worker.ts:
// 1. lê os PDFs que o painel ainda não leu; 2. dispara o que está agendado (agendada_para ≤ agora); 3. manda os
// lembretes (véspera e dia do vencimento, a partir das 9 h de Brasília, só se a guia não está paga/informada, no
// máximo 2 por guia). Teto diário de contatos únicos no WhatsApp (`GUIAS_TETO_DIARIO`, padrão 200), somado entre
// escritórios, em 24 h corridas. Idempotente: cada mensagem tem uma chave única em guia_envios (guia, canal, destino,
// motivo, dia), reivindicada antes do envio; a retentativa encontra a chave e não manda de novo.
import type { Db } from '../db.js'
import { logEvent } from '../log.js'
import { TENTATIVAS_DE_ENVIO, type AnexoEmail, type EnviaEmail, type Enviada, type EnviaWhatsApp } from '../agente/canais.js'
import { diaLocal, partesLocais } from '../agente/tempo.js'
import { formatarLinha } from './codigos.js'
import type { LerGuiaDeps, TipoDeGuia } from './leitura.js'
import {
  competenciaBr,
  dataBr,
  mensagemDeEnvio,
  mensagemDeLembrete,
  reaisSemSimbolo,
  ROTULO_DO_TIPO,
  type DadosDaMensagem,
} from './modelos.js'
import { hashDoToken, lerPendentes, tokenDaGuia, urlDoLink, VALIDADE_DO_LINK_DIAS } from './servico.js'
import type { ArmazemDeGuias } from './storage.js'

export type CanalWhatsAppGuias = EnviaWhatsApp & { subirMidia(anexo: AnexoEmail): Promise<string> }

export const TETO_DIARIO_PADRAO = 200
export const MAX_LEMBRETES = 2

export type GuiasWorkerDeps = {
  db: Db
  storage: ArmazemDeGuias
  whatsapp: CanalWhatsAppGuias | null
  email: EnviaEmail | null
  leitor: LerGuiaDeps
  /** `GUIAS_LINK_SEGREDO`: assina o token do link /g/<token>. */
  segredo: string
  /** `GUIAS_LINK_BASE_URL`: onde mora /g/ (padrão https://app.notechstack.com.br). */
  linkBase: string
  /** Contatos únicos no WhatsApp em 24 h, somados entre escritórios. */
  teto: number
  now?: () => Date
}

export type ResumoGuias = { lidas: number; disparadas: number; falharam: number; adiadas_pelo_teto: number; lembretes: number }

export async function rodadaDeGuias(deps: GuiasWorkerDeps): Promise<ResumoGuias> {
  const now = deps.now ?? (() => new Date())
  let lidas = 0
  try {
    lidas = await lerPendentes({ executar: (t) => t(deps.db), storage: deps.storage, leitor: deps.leitor, now }, { limite: 20 })
  } catch (error) {
    logEvent('guias.leitura_rodada_falhou', { error_name: error instanceof Error ? error.name : 'unknown' })
  }
  const teto = await contatosDoDia(deps.db, now())
  const disparo = await dispararAgendadas(deps, now, teto)
  const lembretes = await enviarLembretes(deps, now, teto)
  return { lidas, ...disparo, lembretes }
}

type Teto = { usados: Set<string> }

async function contatosDoDia(db: Db, agora: Date): Promise<Teto> {
  const { rows } = await db.query<{ destino: string }>(
    `select distinct destino from nofiscal.guia_envios
      where canal = 'whatsapp' and status <> 'falhou' and created_at > $1::timestamptz - interval '24 hours'`,
    [agora],
  )
  return { usados: new Set(rows.map((r) => r.destino)) }
}

/** Cabe no teto? Contato já falado nas últimas 24 h não conta de novo. */
function cabe(teto: Teto, limite: number, destinos: string[]): boolean {
  const novos = destinos.filter((d) => !teto.usados.has(d))
  return teto.usados.size + novos.length <= limite
}

type Envio = { guiaId: string; conta: string; canal: 'whatsapp' | 'email'; destino: string; motivo: 'envio' | 'lembrete' | 'segunda_via'; modelo: string | null; chave: string }

/** Reivindica a mensagem: só quem insere a chave (ou retoma uma que falhou) envia. */
export async function reivindicar(db: Pick<Db, 'query'>, e: Envio): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into nofiscal.guia_envios (guia_id, escritorio_tenant_id, canal, destino, motivo, modelo, chave)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (chave) do update set status = 'pendente', erro = null, created_at = now()
       where nofiscal.guia_envios.status = 'falhou'
     returning id`,
    [e.guiaId, e.conta, e.canal, e.destino, e.motivo, e.modelo, e.chave],
  )
  return rows[0]?.id ?? null
}

export async function concluirEnvio(db: Pick<Db, 'query'>, id: string, r: { ok: true; idExterno: string | null } | { ok: false; erro: string }) {
  if (r.ok) {
    await db.query(`update nofiscal.guia_envios set status = 'enviada', id_externo = $2, enviado_em = now(), erro = null where id = $1 and status = 'pendente'`, [id, r.idExterno])
  } else {
    await db.query(`update nofiscal.guia_envios set status = 'falhou', erro = $2 where id = $1`, [id, r.erro.slice(0, 500)])
  }
}

/** Até 3 tentativas (como canais.ts), guardando o id que a Meta/Resend devolve ou o último erro. */
export async function comTentativas(envio: () => Promise<Enviada | void>): Promise<{ ok: true; idExterno: string | null } | { ok: false; erro: string }> {
  let ultimo = 'falha'
  for (let i = 1; i <= TENTATIVAS_DE_ENVIO; i++) {
    try {
      const r = await envio()
      return { ok: true, idExterno: r?.wamid ?? null }
    } catch (error) {
      ultimo = error instanceof Error ? `${error.name}: ${error.message}` : 'falha'
    }
  }
  return { ok: false, erro: ultimo }
}

type Agendada = {
  id: string; conta: string; tipo: TipoDeGuia; competencia: string | null; valor_centavos: string; vencimento: string; linha_digitavel: string | null
  pdf_path: string; pdf_nome: string; cor: string; empresa: string; whatsapps: string[]; emails: string[]; sair_whatsapp_em: Date | null
  sair_email_em: Date | null; escritorio: string; responder_para: string | null
}

const SELECT_DA_GUIA = `
  select g.id, g.escritorio_tenant_id as conta, g.tipo, to_char(g.competencia, 'YYYY-MM-DD') as competencia, g.valor_centavos::text,
         to_char(g.vencimento, 'YYYY-MM-DD') as vencimento, g.linha_digitavel, g.pdf_path, g.pdf_nome, nofiscal.guia_cor(g.id) as cor,
         c.nome as empresa, c.whatsapps, c.emails, c.sair_whatsapp_em, c.sair_email_em,
         coalesce(r.assinatura, t.razao_social) as escritorio,
         coalesce(r.email_alerta, (select a.email from nofiscal.fiscal_accounts a where a.client_id = t.client_id order by a.email limit 1)) as responder_para
    from nofiscal.guias g
    join nofiscal.guia_contatos c on c.id = g.contato_id
    join nofiscal.fiscal_tenants t on t.id = g.escritorio_tenant_id
    left join nofiscal.guia_regras r on r.escritorio_tenant_id = g.escritorio_tenant_id`

const canaisDe = (g: Pick<Agendada, 'whatsapps' | 'emails' | 'sair_whatsapp_em' | 'sair_email_em'>) => ({
  whatsapps: g.sair_whatsapp_em ? [] : g.whatsapps,
  emails: g.sair_email_em ? [] : g.emails,
})

async function dispararAgendadas(deps: GuiasWorkerDeps, now: () => Date, teto: Teto) {
  const resumo = { disparadas: 0, falharam: 0, adiadas_pelo_teto: 0 }
  const { rows } = await deps.db.query<Agendada>(
    `${SELECT_DA_GUIA}
      where g.status = 'agendada' and g.agendada_para <= $1 and nofiscal.guias_ligado(g.escritorio_tenant_id)
      order by g.agendada_para, g.created_at limit 50`,
    [now()],
  )
  for (const g of rows) {
    try {
      if (g.cor !== 'verde') {
        // O contato saiu dos dois canais (ou foi desativado) depois do disparo: volta para a conferência.
        await deps.db.query(`update nofiscal.guias set status = 'conferir', updated_at = now() where id = $1 and status = 'agendada'`, [g.id])
        continue
      }
      const canais = canaisDe(g)
      const whatsapps = deps.whatsapp ? canais.whatsapps : []
      const emails = deps.email ? canais.emails : []
      if (!cabe(teto, deps.teto, whatsapps)) {
        resumo.adiadas_pelo_teto++
        continue
      }
      const pdf = await deps.storage.baixar(g.pdf_path)
      const anexo: AnexoEmail = { nome: g.pdf_nome, tipo: 'application/pdf', conteudo: pdf }
      const token = tokenDaGuia(deps.segredo, g.id)
      await deps.db.query(
        `update nofiscal.guias set link_token_hash = $2, link_expira_em = coalesce(link_expira_em, $3::timestamptz + make_interval(days => $4))
          where id = $1`,
        [g.id, hashDoToken(token), now(), VALIDADE_DO_LINK_DIAS],
      )
      const dados: DadosDaMensagem = {
        guiaId: g.id, escritorio: g.escritorio, empresa: g.empresa, tipo: g.tipo, competencia: g.competencia,
        valorCentavos: Number(g.valor_centavos), vencimento: g.vencimento, linha: g.linha_digitavel ? formatarLinha(g.linha_digitavel) : '-', token,
      }
      let mediaId: string | null = null
      for (const numero of whatsapps) {
        const msg = mensagemDeEnvio(dados, { mediaId: '', nome: g.pdf_nome })
        const id = await reivindicar(deps.db, { guiaId: g.id, conta: g.conta, canal: 'whatsapp', destino: numero, motivo: 'envio', modelo: msg.nome, chave: `envio:${g.id}:whatsapp:${numero}` })
        if (!id) continue
        teto.usados.add(numero)
        const whatsapp = deps.whatsapp as CanalWhatsAppGuias
        const r = await comTentativas(async () => {
          mediaId ??= await whatsapp.subirMidia(anexo)
          const pronta = mensagemDeEnvio(dados, { mediaId, nome: g.pdf_nome })
          return whatsapp.enviarModelo(numero, pronta.nome, pronta.parametros, pronta.extras)
        })
        await concluirEnvio(deps.db, id, r)
      }
      for (const email of emails) {
        const id = await reivindicar(deps.db, { guiaId: g.id, conta: g.conta, canal: 'email', destino: email, motivo: 'envio', modelo: null, chave: `envio:${g.id}:email:${email}` })
        if (!id) continue
        const chave = `guia-envio-${g.id}-${email}`
        const r = await comTentativas(async () => {
          await (deps.email as EnviaEmail).enviar({ ...emailDaGuia(dados, urlDoLink(deps.linkBase, token)), para: email, anexos: [anexo], idempotencia: chave, ...(g.responder_para ? { responderPara: g.responder_para } : {}) })
        })
        await concluirEnvio(deps.db, id, r)
      }
      const { rows: fim } = await deps.db.query<{ status: string }>(
        `update nofiscal.guias g
            set status = case when exists (select 1 from nofiscal.guia_envios e where e.guia_id = g.id and e.motivo = 'envio'
                                             and e.status in ('pendente', 'enviada', 'entregue', 'lida')) then 'enviada' else 'falhou' end,
                enviada_em = case when exists (select 1 from nofiscal.guia_envios e where e.guia_id = g.id and e.motivo = 'envio'
                                                 and e.status in ('pendente', 'enviada', 'entregue', 'lida')) then coalesce(g.enviada_em, $2) else g.enviada_em end,
                updated_at = now()
          where g.id = $1 and g.status = 'agendada'
          returning g.status`,
        [g.id, now()],
      )
      if (fim[0]?.status === 'enviada') resumo.disparadas++
      else if (fim[0]?.status === 'falhou') resumo.falharam++
    } catch (error) {
      logEvent('guias.disparo_falhou', { guia_id: g.id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
  }
  if (resumo.adiadas_pelo_teto) logEvent('guias.teto_diario', { adiadas: resumo.adiadas_pelo_teto, teto: deps.teto })
  return resumo
}

export function emailDaGuia(d: DadosDaMensagem, link: string): { assunto: string; texto: string } {
  const tipo = ROTULO_DO_TIPO[d.tipo]
  return {
    assunto: `${d.escritorio}: guia ${tipo} de ${d.empresa}, vence ${dataBr(d.vencimento)}`,
    texto: [
      `Olá! ${d.escritorio} enviou a guia ${tipo} de ${d.empresa}${d.competencia ? `, competência ${competenciaBr(d.competencia)}` : ''}.`,
      '',
      `Valor: R$ ${reaisSemSimbolo(d.valorCentavos)}`,
      `Vencimento: ${dataBr(d.vencimento)}`,
      `Linha digitável: ${d.linha}`,
      '',
      `O PDF está anexo. Para ver e copiar o código: ${link}`,
      '',
      `Dúvidas? Responda este e-mail que a mensagem vai para ${d.escritorio}.`,
      `Para não receber mais, responda SAIR.`,
    ].join('\n'),
  }
}

// ------------------------------------------------------------------ Lembretes

type ParaLembrar = Agendada & { delta: number; lembretes_enviados: number; hora_envio: number }

async function enviarLembretes(deps: GuiasWorkerDeps, now: () => Date, teto: Teto): Promise<number> {
  const agora = now()
  const hoje = diaLocal(agora)
  const hora = partesLocais(agora).hora
  const { rows } = await deps.db.query<ParaLembrar>(
    `${SELECT_DA_GUIA.replace('select g.id,', 'select ($1::date - g.vencimento) as delta, g.lembretes_enviados, coalesce(r.hora_envio, 9) as hora_envio, g.id,')}
      where g.status in ('enviada', 'entregue', 'lida', 'baixada')
        and g.lembretes_enviados < ${MAX_LEMBRETES}
        and g.vencimento between $1::date and $1::date + 3
        and ($1::date - g.vencimento) = any(coalesce(r.lembrete_dias, '{-1,0}'::int[]))
        and $2 >= coalesce(r.hora_envio, 9)
        and nofiscal.guias_ligado(g.escritorio_tenant_id)
      order by g.vencimento limit 200`,
    [hoje, hora],
  )
  let enviados = 0
  for (const g of rows) {
    try {
      const canais = canaisDe(g)
      // WhatsApp primeiro; sem WhatsApp (ou "SAIR" nele), o lembrete vai por e-mail.
      const whatsapps = deps.whatsapp ? canais.whatsapps : []
      const emails = whatsapps.length || !deps.email ? [] : canais.emails
      if (!cabe(teto, deps.teto, whatsapps)) continue
      const quando = g.delta === 0 ? 'hoje' : g.delta === -1 ? 'amanhã' : `em ${-g.delta} dias`
      const dados = { guiaId: g.id, escritorio: g.escritorio, empresa: g.empresa, tipo: g.tipo, competencia: g.competencia, valorCentavos: Number(g.valor_centavos), vencimento: g.vencimento }
      let reivindicou = false
      for (const numero of whatsapps) {
        const msg = mensagemDeLembrete(dados, quando)
        const id = await reivindicar(deps.db, { guiaId: g.id, conta: g.conta, canal: 'whatsapp', destino: numero, motivo: 'lembrete', modelo: msg.nome, chave: `lembrete:${g.id}:${hoje}:whatsapp:${numero}` })
        if (!id) continue
        reivindicou = true
        teto.usados.add(numero)
        const r = await comTentativas(() => (deps.whatsapp as CanalWhatsAppGuias).enviarModelo(numero, msg.nome, msg.parametros, msg.extras))
        await concluirEnvio(deps.db, id, r)
      }
      for (const email of emails) {
        const id = await reivindicar(deps.db, { guiaId: g.id, conta: g.conta, canal: 'email', destino: email, motivo: 'lembrete', modelo: null, chave: `lembrete:${g.id}:${hoje}:email:${email}` })
        if (!id) continue
        reivindicou = true
        const r = await comTentativas(async () => {
          await (deps.email as EnviaEmail).enviar({
            para: email,
            assunto: `Lembrete: guia ${ROTULO_DO_TIPO[g.tipo]} de ${g.empresa} vence ${quando}`,
            texto: `Lembrete de ${g.escritorio}: a guia ${ROTULO_DO_TIPO[g.tipo]} de ${g.empresa} (R$ ${reaisSemSimbolo(Number(g.valor_centavos))}) vence ${quando} (${dataBr(g.vencimento)}).\n\nSe já pagou, responda "paguei". Para não receber mais, responda SAIR.`,
            idempotencia: `guia-lembrete-${g.id}-${hoje}-${email}`,
            ...(g.responder_para ? { responderPara: g.responder_para } : {}),
          })
        })
        await concluirEnvio(deps.db, id, r)
      }
      if (reivindicou) {
        await deps.db.query(`update nofiscal.guias set lembretes_enviados = lembretes_enviados + 1, updated_at = now() where id = $1 and lembretes_enviados < ${MAX_LEMBRETES}`, [g.id])
        enviados++
      }
    } catch (error) {
      logEvent('guias.lembrete_falhou', { guia_id: g.id, error_name: error instanceof Error ? error.name : 'unknown' })
    }
  }
  return enviados
}
