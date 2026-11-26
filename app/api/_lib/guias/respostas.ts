// Respostas dos clientes às guias pelo WhatsApp (critério 17). Só entra aqui o número que está em guia_contatos de
// uma conta com o módulo ligado e que não emite pela nó (fiscal_phones segue o caminho de sempre, critério 18):
// - "paguei", botão "Já paguei" ou um comprovante (imagem/PDF) → a guia vira `paga_informada`;
// - "2ª via", "manda de novo" ou botão "Mandar de novo" → reenvia o PDF, dentro da janela de 24 h que a mensagem abriu;
// - "SAIR" → opt-out do WhatsApp daquele contato (o e-mail continua);
// - botão "Recebi" → só registra; botão "Falar com o escritório" → manda o WhatsApp do escritório e avisa por e-mail;
// - qualquer outra coisa → e-mail de alerta ao escritório e registro na guia (e uma confirmação por dia ao cliente).
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import type { EnviaEmail, EnviaWhatsApp } from '../agente/canais.js'
import type { MensagemRecebida } from '../agente/conversa.js'
import { diaLocal } from '../agente/tempo.js'
import { marcarUmaVez } from '../agente/uma-vez.js'
import { blocos } from '../agente/formato.js'
import { formatarLinha } from './codigos.js'
import { normalizar, type TipoDeGuia } from './leitura.js'
import { dataBr, lerPayload, reaisSemSimbolo, ROTULO_DO_TIPO, type AcaoDoBotao } from './modelos.js'
import { comTentativas, concluirEnvio, reivindicar } from './envio.js'
import type { ArmazemDeGuias } from './storage.js'

export type RespostasDeps = {
  db: Queryable
  /** Cliente da Cloud API já no endereço que a Meta mandou; as falhas de envio não derrubam o tratamento. */
  whatsapp: EnviaWhatsApp
  email: EnviaEmail | null
  storage: ArmazemDeGuias | null
  now?: () => Date
}

type Contato = {
  id: string; conta: string; nome: string; escritorio: string; email_alerta: string | null; whatsapp_escritorio: string | null
}

type GuiaAberta = {
  id: string; contato_id: string; conta: string; tipo: TipoDeGuia; valor_centavos: string; vencimento: string; linha_digitavel: string | null
  pdf_path: string; pdf_nome: string; status: string
}

export type Intencao = AcaoDoBotao | 'sair' | 'outra'

/** O que o cliente quis dizer (texto livre ou botão). */
export function intencaoDaResposta(msg: Pick<MensagemRecebida, 'tipo' | 'texto' | 'botao'>): { intencao: Intencao; guiaId: string | null } {
  const payload = lerPayload(msg.botao?.payload)
  if (payload) return { intencao: payload.acao, guiaId: payload.guiaId }
  if (msg.tipo === 'image' || msg.tipo === 'document') return { intencao: 'paguei', guiaId: null }
  const t = normalizar(msg.texto ?? msg.botao?.texto ?? '').replace(/[!.?,;]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return { intencao: 'outra', guiaId: null }
  if (/^(sair|parar|pare|stop|descadastrar|cancelar envio)$/.test(t)) return { intencao: 'sair', guiaId: null }
  if (/\b(2a|2ª|segunda) ?via\b|\bmand(a|ar|e) (de novo|novamente|outra vez)\b|\breenvi(a|ar|e)\b/.test(t)) return { intencao: 'segunda_via', guiaId: null }
  if (/\b(ja )?paguei\b|\bja (esta|ta) pag[ao]\b|\bpagamento (feito|realizado|efetuado)\b|\bquitei\b|\bsegue (o )?comprovante\b/.test(t)) {
    return { intencao: 'paguei', guiaId: null }
  }
  if (/^recebi( obrigad[oa])?$/.test(t)) return { intencao: 'recebi', guiaId: null }
  if (/^falar com o escritorio$/.test(t)) return { intencao: 'escritorio', guiaId: null }
  return { intencao: 'outra', guiaId: null }
}

/** Trata a mensagem se o número é de um contato de guias; `false` deixa a conversa seguir como sempre. */
export async function tratarRespostaDeGuia(deps: RespostasDeps, msg: MensagemRecebida): Promise<boolean> {
  const { rows: contatos } = await deps.db.query<Contato>(
    `select c.id, c.escritorio_tenant_id as conta, c.nome, coalesce(r.assinatura, t.razao_social) as escritorio,
            coalesce(r.email_alerta, (select a.email from nofiscal.fiscal_accounts a where a.client_id = t.client_id order by a.email limit 1)) as email_alerta,
            r.whatsapp_escritorio
       from nofiscal.guia_contatos c
       join nofiscal.fiscal_tenants t on t.id = c.escritorio_tenant_id
       left join nofiscal.guia_regras r on r.escritorio_tenant_id = c.escritorio_tenant_id
      where $1 = any(c.whatsapps) and c.ativo and nofiscal.guias_ligado(c.escritorio_tenant_id)
      order by c.updated_at desc`,
    [msg.de],
  )
  if (!contatos.length) return false
  const agora = (deps.now ?? (() => new Date()))()
  // Janela de 24 h da Meta também para os contatos de guias (2ª via em texto livre).
  await deps.db.query(
    `insert into nofiscal.fiscal_agent_once (chave, tenant_id, created_at) values ($1, $2, $3) on conflict (chave) do nothing`,
    [`janela:${msg.de}:${agora.toISOString().slice(0, 13)}`, contatos[0].conta, agora],
  )
  const { intencao, guiaId } = intencaoDaResposta(msg)
  const ids = contatos.map((c) => c.id)
  const guia = await guiaDaResposta(deps.db, ids, guiaId, intencao)
  const contato = contatos.find((c) => c.id === guia?.contato_id) ?? contatos[0]
  const textoRecebido = (msg.texto ?? msg.botao?.texto ?? `[${msg.tipo}]`).slice(0, 1000)
  if (guia) {
    await deps.db.query(`update nofiscal.guias set ultima_resposta = $2, ultima_resposta_em = $3, updated_at = now() where id = $1`, [guia.id, textoRecebido, agora])
  }
  logEvent('guias.resposta', { intencao, guia_id: guia?.id ?? null, message_id: msg.id })
  const de = msg.de
  const assunto = (g: GuiaAberta | null) => (g ? `guia ${ROTULO_DO_TIPO[g.tipo]} de ${contato.nome} (vence ${dataBr(g.vencimento)})` : `cliente ${contato.nome}`)

  switch (intencao) {
    case 'sair': {
      await deps.db.query(`update nofiscal.guia_contatos set sair_whatsapp_em = $2, updated_at = now() where id = any($1::uuid[]) and sair_whatsapp_em is null`, [ids, agora])
      await responder(deps, de, `Pronto: você não vai mais receber guias de ${contato.escritorio} por este WhatsApp. Para voltar, fale com o escritório.`)
      await alertar(deps, contato, `${contato.nome} pediu para sair do WhatsApp`, `${contato.nome} respondeu SAIR no WhatsApp: as próximas guias vão só por e-mail (se houver). Se o cliente quiser voltar, registre o novo aceite em Guias › Clientes › Reativar WhatsApp.`)
      return true
    }
    case 'paguei': {
      if (!guia) {
        await alertar(deps, contato, `${contato.nome} disse que pagou`, `${contato.nome} escreveu no WhatsApp: "${textoRecebido}". Não achei guia em aberto para esse cliente.`)
        await responder(deps, de, `Obrigado! Avisei ${contato.escritorio}.`)
        return true
      }
      const origem = msg.tipo === 'image' || msg.tipo === 'document' ? 'comprovante' : 'whatsapp'
      await deps.db.query(
        `update nofiscal.guias set status = 'paga_informada', pago_em = coalesce(pago_em, $2), pago_origem = coalesce(pago_origem, $3), updated_at = now()
          where id = $1 and nofiscal.guia_status_ordem(status) < nofiscal.guia_status_ordem('paga_informada')`,
        [guia.id, agora, origem],
      )
      await responder(deps, de, `Obrigado! Avisei ${contato.escritorio} que a guia ${ROTULO_DO_TIPO[guia.tipo]} de R$ ${reaisSemSimbolo(Number(guia.valor_centavos))} foi paga.`)
      if (origem === 'comprovante') {
        await alertar(deps, contato, `Comprovante: ${assunto(guia)}`, `${contato.nome} mandou um comprovante (${msg.arquivo?.nome ?? msg.tipo}) pelo WhatsApp para a ${assunto(guia)}. A guia ficou como "paga (informada)".`)
      }
      return true
    }
    case 'segunda_via': {
      if (!guia || !deps.storage) {
        await responder(deps, de, `Não achei uma guia em aberto aqui. Avisei ${contato.escritorio}.`)
        await alertar(deps, contato, `${contato.nome} pediu 2ª via`, `${contato.nome} pediu a 2ª via pelo WhatsApp, mas não achei guia em aberto: "${textoRecebido}".`)
        return true
      }
      // O PDF antes da reivindicação: se o Storage falhar, nada fica 'pendente' e a reentrega da Meta tenta de novo.
      let pdf: Uint8Array
      try {
        pdf = await deps.storage.baixar(guia.pdf_path)
      } catch (error) {
        logEvent('guias.segunda_via_sem_pdf', { guia_id: guia.id, error_name: error instanceof Error ? error.name : 'unknown' })
        await responder(deps, de, `Não consegui mandar o PDF agora. Peça a 2ª via de novo em alguns minutos.`)
        return true
      }
      const id = await reivindicar(deps.db, { guiaId: guia.id, conta: guia.conta, canal: 'whatsapp', destino: de, motivo: 'segunda_via', modelo: null, chave: `segunda_via:${guia.id}:${msg.id}` })
      if (!id) return true
      const legenda = `2ª via: guia ${ROTULO_DO_TIPO[guia.tipo]}, R$ ${reaisSemSimbolo(Number(guia.valor_centavos))}, vence ${dataBr(guia.vencimento)}.${guia.linha_digitavel ? `\nLinha digitável: ${formatarLinha(guia.linha_digitavel)}` : ''}`
      const r = await comTentativas(() => deps.whatsapp.enviarDocumento(de, { nome: guia.pdf_nome, tipo: 'application/pdf', conteudo: pdf }, legenda))
      await concluirEnvio(deps.db, id, r)
      return true
    }
    case 'recebi':
      return true
    case 'escritorio': {
      const wa = contato.whatsapp_escritorio ? `https://wa.me/${contato.whatsapp_escritorio.replace(/\D/g, '')}` : null
      await responder(deps, de, wa ? `Fale com ${contato.escritorio} por aqui: ${wa}` : `Avisei ${contato.escritorio}; eles vão falar com você.`)
      await alertar(deps, contato, `${contato.nome} quer falar com o escritório`, `${contato.nome} tocou em "Falar com o escritório" na ${assunto(guia)}.`)
      return true
    }
    default: {
      await alertar(deps, contato, `Resposta de ${contato.nome}: ${assunto(guia)}`, `${contato.nome} respondeu pelo WhatsApp sobre a ${assunto(guia)}:\n\n"${textoRecebido}"\n\nResponda ao cliente pelo seu canal de sempre.`)
      if (await marcarUmaVez(deps.db, `guias-recebido:${de}:${diaLocal(agora)}`, contato.conta)) {
        await responder(deps, de, blocos(`Recebi sua mensagem e avisei ${contato.escritorio}.`, 'Se já pagou, responda "paguei"; para receber o PDF de novo, "2ª via".'))

      }
      return true
    }
  }
}

/** A guia do botão (se é deste contato) ou a mais recente que já saiu e não está paga (para "paguei" e 2ª via). */
async function guiaDaResposta(db: Queryable, contatos: string[], guiaId: string | null, intencao: Intencao): Promise<GuiaAberta | null> {
  const colunas = `g.id, g.contato_id, g.escritorio_tenant_id as conta, g.tipo, g.valor_centavos::text, to_char(g.vencimento, 'YYYY-MM-DD') as vencimento,
                   g.linha_digitavel, g.pdf_path, g.pdf_nome, g.status`
  if (guiaId) {
    const { rows } = await db.query<GuiaAberta>(`select ${colunas} from nofiscal.guias g where g.id = $1 and g.contato_id = any($2::uuid[])`, [guiaId, contatos])
    if (rows[0]) return rows[0]
  }
  const abertas = intencao === 'segunda_via' ? `('enviada', 'entregue', 'lida', 'baixada', 'paga_informada')` : `('enviada', 'entregue', 'lida', 'baixada')`
  const { rows } = await db.query<GuiaAberta>(
    `select ${colunas} from nofiscal.guias g
      where g.contato_id = any($1::uuid[]) and g.status in ${abertas}
        -- O mesmo número em dois escritórios: vale o escritório da última guia que saiu para ele.
        and g.escritorio_tenant_id = (select x.escritorio_tenant_id from nofiscal.guias x
                                       where x.contato_id = any($1::uuid[]) and x.enviada_em is not null
                                       order by x.enviada_em desc limit 1)
      order by g.vencimento asc, g.enviada_em desc limit 1`,
    [contatos],
  )
  if (rows[0]) return rows[0]
  // Nada em aberto: a guia mais recente que saiu, só para registrar a resposta.
  const { rows: ultima } = await db.query<GuiaAberta>(
    `select ${colunas} from nofiscal.guias g where g.contato_id = any($1::uuid[]) and g.enviada_em is not null order by g.enviada_em desc limit 1`,
    [contatos],
  )
  return intencao === 'outra' || intencao === 'escritorio' || intencao === 'recebi' || intencao === 'sair' ? (ultima[0] ?? null) : null
}

/** Texto ao cliente com as tentativas; falha só vai ao log (a resposta já foi registrada). */
async function responder(deps: RespostasDeps, para: string, texto: string): Promise<void> {
  const r = await comTentativas(() => deps.whatsapp.enviarTexto(para, texto))
  if (!r.ok) logEvent('guias.resposta_nao_enviada', { erro: r.erro.slice(0, 80) })
}

async function alertar(deps: RespostasDeps, contato: Contato, assunto: string, texto: string): Promise<void> {
  if (!deps.email || !contato.email_alerta) {
    logEvent('guias.alerta_sem_email', { conta: contato.conta })
    return
  }
  const r = await comTentativas(async () => {
    await (deps.email as EnviaEmail).enviar({ para: contato.email_alerta as string, assunto: `[nó.fiscal · Guias] ${assunto}`, texto })
  })
  if (!r.ok) logEvent('guias.alerta_falhou', { conta: contato.conta })
}
