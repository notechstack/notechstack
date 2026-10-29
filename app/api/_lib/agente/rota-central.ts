// GET e POST /api/v1/fiscal/central: a central de conversas do nó.fiscal (Lucca, 29/10/2026), só para
// NO_ADMIN com segundo fator, como a tela /no/fiscal/conversas. Banco pelo `nofiscal_service`; o schema
// `nofiscal` continua fechado para quem está logado, e a tela consulta esta rota a cada 3 segundos.
//   GET                          → as conversas mais recentes, com a etiqueta de estado de cada uma;
//   POST {acao: 'ler', telefone} → também a conversa aberta: mensagens, eventos, janela de 24 h e quem está com ela
//                                  (o telefone vai no corpo, não na URL, para não parar nos logs de acesso);
//   POST {acao: 'assumir' | 'devolver' | 'responder', telefone, texto?}.
// Assumir: o robô fica quieto no número por 2 h (cada resposta da equipe renova). Fora da janela de 24 h
// só sai modelo aprovado: a resposta é recusada e o "assumir" e o "devolver" não mandam o aviso.
import type { Queryable } from '../db.js'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import type { AdminVerifier } from '../session.js'
import { textoComRetentativa, type EnviaWhatsApp } from './canais.js'
import { PRAZO_DA_EQUIPE_MS, registrarEvento, whatsappGravado, type AutorDaSaida } from './central.js'
import { EXEMPLO_DE_PEDIDO } from './conversa.js'
import { JANELA_MS } from './janela.js'

export type RotaCentralDeps = {
  db: Queryable
  admins: AdminVerifier
  /** O cliente cru da Cloud API; o envio é gravado como da equipe (ou do robô, no "devolver"). */
  whatsapp: EnviaWhatsApp | null
  now?: () => Date
}

// Textos aprovados por Lucca em 29/10/2026.
export const TEXTO_AO_ASSUMIR = 'Oi! Aqui é o Lucca, da equipe da Nó. A partir de agora eu continuo o seu atendimento por aqui.'
export const TEXTO_AO_DEVOLVER = `Pronto, voltei a te atender automaticamente. Para emitir uma nota, é só mandar o pedido, por exemplo: ${EXEMPLO_DE_PEDIDO}.`

export const LIMITE_DE_CONVERSAS = 100
export const LIMITE_DE_MENSAGENS = 300
/** Limite de texto da Cloud API. */
export const TAMANHO_DA_RESPOSTA = 4096

const E164 = /^\+[1-9][0-9]{7,14}$/

export type Etiqueta =
  | 'pediu_atendente'
  | 'erro_de_envio'
  | 'com_a_equipe'
  | 'aguardando_confirmacao'
  | 'perguntando_descricao'
  | 'pedindo_dados'
  | 'escolhendo_nota'
  | 'salvar_modelo'
  | 'sem_conta'

type LinhaDaLista = {
  telefone: string
  direcao: 'entrada' | 'saida'
  autor: 'cliente' | 'robo' | 'equipe'
  tipo: string
  texto: string | null
  arquivo: string | null
  status: string | null
  em: Date
  empresa: string | null
  assumida_ate: Date | null
  pediu_atendente: boolean
  etapa: string | null
  pedindo_descricao: boolean
  erro_de_envio: boolean | null
}

function etiquetas(l: LinhaDaLista, agora: Date): Etiqueta[] {
  const lista: Etiqueta[] = []
  if (l.pediu_atendente) lista.push('pediu_atendente')
  if (l.erro_de_envio) lista.push('erro_de_envio')
  if (l.assumida_ate && new Date(l.assumida_ate) > agora) lista.push('com_a_equipe')
  if (l.pedindo_descricao) lista.push('perguntando_descricao')
  else if (l.etapa === 'confirmar') lista.push('aguardando_confirmacao')
  else if (l.etapa === 'dados_tomador') lista.push('pedindo_dados')
  else if (l.etapa === 'escolher_nota') lista.push('escolhendo_nota')
  else if (l.etapa === 'salvar_modelo' || l.etapa === 'substituir_modelo') lista.push('salvar_modelo')
  if (!l.empresa) lista.push('sem_conta')
  return lista
}

async function listarConversas(db: Queryable, agora: Date) {
  const { rows } = await db.query<LinhaDaLista>(
    `with ultimas as (
       select distinct on (m.phone_e164) m.phone_e164, m.direcao, m.autor, m.tipo, m.texto, m.arquivo, m.status, m.created_at
         from nofiscal.fiscal_messages m
        order by m.phone_e164, m.created_at desc, m.id desc
     )
     select u.phone_e164 as telefone, u.direcao, u.autor, u.tipo, u.texto, u.arquivo, u.status, u.created_at as em,
            t.razao_social as empresa, c.assumida_ate,
            exists (
              select 1 from nofiscal.fiscal_conversation_events e
               where e.phone_e164 = u.phone_e164 and e.tipo = 'pediu_atendente'
                 and e.created_at > coalesce((select max(q.created_at) from nofiscal.fiscal_messages q
                                               where q.phone_e164 = u.phone_e164 and q.autor = 'equipe'), '-infinity')
            ) as pediu_atendente,
            r.etapa, coalesce((r.conversa ->> 'pedindoDescricao')::boolean, false) as pedindo_descricao,
            (select s.status = 'falhou' from nofiscal.fiscal_messages s
              where s.phone_e164 = u.phone_e164 and s.direcao = 'saida'
              order by s.created_at desc, s.id desc limit 1) as erro_de_envio
       from ultimas u
       left join nofiscal.fiscal_phones p on p.phone_e164 = u.phone_e164
       left join nofiscal.fiscal_tenants t on t.id = p.tenant_id
       left join nofiscal.fiscal_conversations c on c.phone_e164 = u.phone_e164
       left join lateral (
         select r.etapa, r.conversa from nofiscal.fiscal_requests r
          where r.phone_id = p.id and r.status = 'awaiting_confirmation' and r.expires_at > $1
          order by r.created_at desc limit 1
       ) r on true
      order by u.created_at desc
      limit ${LIMITE_DE_CONVERSAS}`,
    [agora],
  )
  return rows.map((l) => ({
    telefone: l.telefone,
    empresa: l.empresa,
    ultima: { direcao: l.direcao, autor: l.autor, tipo: l.tipo, texto: l.texto, arquivo: l.arquivo, status: l.status, em: l.em },
    etiquetas: etiquetas(l, agora),
  }))
}

type Estado = { assumida_ate: Date | null; ultima_entrada: Date | null; endereco: string | null }

async function estadoDaConversa(db: Queryable, telefone: string): Promise<Estado | null> {
  const { rows } = await db.query<Estado & { existe: boolean }>(
    `select exists (select 1 from nofiscal.fiscal_messages where phone_e164 = $1) as existe,
            (select c.assumida_ate from nofiscal.fiscal_conversations c where c.phone_e164 = $1) as assumida_ate,
            (select max(m.created_at) from nofiscal.fiscal_messages m where m.phone_e164 = $1 and m.direcao = 'entrada') as ultima_entrada,
            (select m.endereco from nofiscal.fiscal_messages m where m.phone_e164 = $1 and m.direcao = 'entrada'
              order by m.created_at desc limit 1) as endereco`,
    [telefone],
  )
  return rows[0]?.existe ? rows[0] : null
}

const fimDaJanela = (estado: Estado) => (estado.ultima_entrada ? new Date(new Date(estado.ultima_entrada).getTime() + JANELA_MS) : null)

async function abrirConversa(db: Queryable, telefone: string, agora: Date) {
  const estado = await estadoDaConversa(db, telefone)
  if (!estado) return null
  const [cabecalho, mensagens, eventos] = await Promise.all([
    db.query<{ empresa: string | null; papel: string | null; plano: string | null }>(
      `select t.razao_social as empresa, p.role as papel, t.plan as plano
         from nofiscal.fiscal_phones p join nofiscal.fiscal_tenants t on t.id = p.tenant_id
        where p.phone_e164 = $1`,
      [telefone],
    ),
    db.query(
      `select * from (
         select id, direcao, autor, tipo, texto, arquivo, status, erro, created_at as em
           from nofiscal.fiscal_messages where phone_e164 = $1
          order by created_at desc, id desc limit ${LIMITE_DE_MENSAGENS}
       ) m order by em, id`,
      [telefone],
    ),
    db.query(
      `select id, tipo, detalhe, created_at as em from nofiscal.fiscal_conversation_events
        where phone_e164 = $1 order by created_at desc limit ${LIMITE_DE_MENSAGENS}`,
      [telefone],
    ),
  ])
  const fim = fimDaJanela(estado)
  const assumida = estado.assumida_ate && new Date(estado.assumida_ate) > agora ? estado.assumida_ate : null
  return {
    telefone,
    empresa: cabecalho.rows[0]?.empresa ?? null,
    papel: cabecalho.rows[0]?.papel ?? null,
    plano: cabecalho.rows[0]?.plano ?? null,
    janela: { aberta: Boolean(fim && fim > agora), fecha_em: fim },
    assumida_ate: assumida,
    mensagens: mensagens.rows,
    eventos: eventos.rows.reverse(),
  }
}

const recusa = (status: number, code: string, message: string) => json(status, { error: { code, message } })

type Pedido = { acao?: unknown; telefone?: unknown; texto?: unknown }

async function assumirAte(db: Queryable, telefone: string, ate: Date, adminId: string, agora: Date): Promise<void> {
  await db.query(
    `insert into nofiscal.fiscal_conversations (phone_e164, assumida_ate, assumida_por, updated_at) values ($1, $2, $3, $4)
     on conflict (phone_e164) do update
       set assumida_ate = excluded.assumida_ate, assumida_por = excluded.assumida_por, updated_at = excluded.updated_at`,
    [telefone, ate, adminId, agora],
  )
}

async function enviar(deps: RotaCentralDeps, estado: Estado, telefone: string, texto: string, autor: AutorDaSaida, adminId: string) {
  if (!deps.whatsapp) return false
  const whatsapp = whatsappGravado(deps.whatsapp, deps.db, autor, autor === 'equipe' ? adminId : null)
  return textoComRetentativa(whatsapp, estado.endereco ?? telefone, texto)
}

async function agir(deps: RotaCentralDeps, adminId: string, pedido: Pedido, agora: Date): Promise<Response> {
  const telefone = typeof pedido.telefone === 'string' ? pedido.telefone.trim() : ''
  if (!E164.test(telefone)) return errorResponse('VALIDATION_FAILED', 'telefone inválido')
  if (pedido.acao === 'ler') {
    const [conversas, conversa] = await Promise.all([listarConversas(deps.db, agora), abrirConversa(deps.db, telefone, agora)])
    return json(200, { agora, conversas, conversa })
  }
  const estado = await estadoDaConversa(deps.db, telefone)
  if (!estado) return errorResponse('NOT_FOUND', 'conversa não encontrada')
  const fim = fimDaJanela(estado)
  const janelaAberta = Boolean(fim && fim > agora)
  const prazo = new Date(agora.getTime() + PRAZO_DA_EQUIPE_MS)
  // Do estado já lido: um erro aqui vira 500, e não uma conversa assumida que parece livre.
  const jaAssumida = Boolean(estado.assumida_ate && new Date(estado.assumida_ate) > agora)

  switch (pedido.acao) {
    case 'assumir': {
      await assumirAte(deps.db, telefone, prazo, adminId, agora)
      if (jaAssumida) return json(200, { assumida_ate: prazo, aviso: null })
      await registrarEvento(deps.db, telefone, 'equipe_assumiu', { userId: adminId })
      logEvent('central.assumiu')
      const aviso = janelaAberta ? await enviar(deps, estado, telefone, TEXTO_AO_ASSUMIR, 'equipe', adminId) : null
      return json(200, { assumida_ate: prazo, aviso })
    }
    case 'devolver': {
      await deps.db.query('update nofiscal.fiscal_conversations set assumida_ate = null, updated_at = $2 where phone_e164 = $1', [
        telefone,
        agora,
      ])
      if (!jaAssumida) return json(200, { assumida_ate: null, aviso: null })
      await registrarEvento(deps.db, telefone, 'equipe_devolveu', { userId: adminId })
      logEvent('central.devolveu')
      const aviso = janelaAberta ? await enviar(deps, estado, telefone, TEXTO_AO_DEVOLVER, 'robo', adminId) : null
      return json(200, { assumida_ate: null, aviso })
    }
    case 'responder': {
      const texto = typeof pedido.texto === 'string' ? pedido.texto.trim() : ''
      if (!texto || texto.length > TAMANHO_DA_RESPOSTA) return errorResponse('VALIDATION_FAILED', `escreva de 1 a ${TAMANHO_DA_RESPOSTA} caracteres`)
      if (!janelaAberta) return recusa(409, 'JANELA_FECHADA', 'fora da janela de 24 horas só sai modelo aprovado')
      if (!deps.whatsapp) return recusa(503, 'WHATSAPP_NAO_CONFIGURADO', 'WhatsApp não configurado')
      // Responder também assume (sem o aviso): o robô não responde por cima da equipe. Se a resposta não
      // sai, o prazo volta ao que era: o cliente não fica 2 h sem robô e sem equipe.
      await assumirAte(deps.db, telefone, prazo, adminId, agora)
      const saiu = await enviar(deps, estado, telefone, texto, 'equipe', adminId)
      logEvent('central.respondeu', { saiu })
      if (!saiu) {
        // Só se ninguém mexeu na conversa durante as tentativas (outra resposta, assumir ou devolver).
        await deps.db.query(
          `update nofiscal.fiscal_conversations set assumida_ate = $2, updated_at = $3
            where phone_e164 = $1 and assumida_ate = $4 and assumida_por = $5`,
          [telefone, jaAssumida ? estado.assumida_ate : null, agora, prazo, adminId],
        )
        return recusa(502, 'ENVIO_FALHOU', 'a Meta não aceitou o envio; veja o erro na conversa')
      }
      if (!jaAssumida) await registrarEvento(deps.db, telefone, 'equipe_assumiu', { userId: adminId })
      return json(200, { assumida_ate: prazo })
    }
    default:
      return errorResponse('VALIDATION_FAILED', 'acao deve ser ler, assumir, devolver ou responder')
  }
}

export async function handleCentral(request: Request, deps: RotaCentralDeps): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'POST') return errorResponse('METHOD_NOT_ALLOWED', 'use GET ou POST')
  try {
    const adminId = await deps.admins.adminIdFrom(request)
    if (!adminId) return errorResponse('UNAUTHORIZED', 'só administrador da Nó com segundo fator')
    const agora = (deps.now ?? (() => new Date()))()

    if (request.method === 'GET') return json(200, { agora, conversas: await listarConversas(deps.db, agora), conversa: null })

    let pedido: Pedido
    try {
      pedido = ((await request.json()) ?? {}) as Pedido
    } catch {
      return errorResponse('INVALID_JSON', 'corpo não é JSON')
    }
    return await agir(deps, adminId, pedido, agora)
  } catch (error) {
    logEvent('central.erro', { error_name: error instanceof Error ? error.name : 'unknown' })
    return errorResponse('INTERNAL', 'erro interno')
  }
}
