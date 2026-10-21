// Boas-vindas no WhatsApp (critérios 29 a 34; Landing v2, lote C - boas-vindas: regras e textos).
// Três perguntas guiadas por `fiscal_tenants.onboarding_etapa`: conferir o cadastro, o cliente
// mais frequente e uma nota de ensaio. O estado entre as mensagens fica em
// `fiscal_tenants.agente_conversa.boas_vindas`. O ensaio usa o intérprete da v1 e nunca cria
// pedido nem nota: nenhum caminho daqui chama `createOrGetInvoice` nem grava em `fiscal_requests`.
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { abrirBoasVindas, ETAPAS_ANTES_DA_ATIVACAO } from './ativacao.js'
import type { CatalogoDeServicos } from './catalogo-servicos.js'
import {
  DESCRICAO_PADRAO,
  ehConfirmar,
  ehNao,
  ehSim,
  limpa,
  resolverModelo,
  responder,
  textoDoResumo,
  TEXTOS,
  type Contexto,
  type Modelo,
} from './conversa.js'
import { documentoNoTexto, emailNoTexto, formatarDocumento, tipoDoDocumento } from './documentos.js'
import { validarParsed, type Parsed } from './interprete.js'

export const TEXTOS_BOAS_VINDAS = {
  antesDeEmitir: 'Antes de emitir, vamos terminar a configuração',
  paraQuem: 'Para quem você mais emite?',
  ensaio: 'Me diga uma nota que você emitiria, como se fosse de verdade',
  exemplo: 'EXEMPLO — não será emitida',
  soExemplo: 'Isso foi só um exemplo. Para emitir de verdade, mande o pedido de novo',
  descartado: 'Ok, descartei o exemplo.',
  estaCerto: 'Está certo?',
} as const

export const textoPronto = (cliente: string) =>
  `Pronto! Agora, para emitir uma nova nota, é só mandar uma mensagem aqui com o cliente e o valor, por exemplo: nota pra ${cliente}, 150 reais`

type Passo = 'nome' | 'conferir_modelo' | 'dados' | 'salvar'

type Estado = {
  passo?: Passo
  nome?: string
  modelo_id?: string
  documento?: string
  email?: string
  frequente?: string
  frequente_documento?: string
  frequente_email?: string | null
  resumo_enviado?: boolean
}

type Tenant = {
  onboarding_etapa: string
  razao_social: string
  codigo_servico_nacional: string | null
  boas_vindas: Estado | null
}

async function lerTenant(db: Queryable, tenantId: string): Promise<Tenant> {
  const { rows } = await db.query<Tenant>(
    `select onboarding_etapa, razao_social, codigo_servico_nacional, agente_conversa->'boas_vindas' as boas_vindas
       from nofiscal.fiscal_tenants where id = $1`,
    [tenantId],
  )
  if (!rows[0]) throw new Error('tenant do número não encontrado')
  return rows[0]
}

async function gravar(db: Queryable, tenantId: string, etapa: string, estado: Estado | null, agora: Date): Promise<void> {
  await db.query(
    `update nofiscal.fiscal_tenants
        set onboarding_etapa = $2,
            agente_conversa = case when $3::jsonb is null then agente_conversa - 'boas_vindas'
                                   else jsonb_set(agente_conversa, '{boas_vindas}', $3::jsonb) end,
            updated_at = $4
      where id = $1`,
    [tenantId, etapa, estado === null ? null : JSON.stringify(estado), agora],
  )
}

/** Critério 29: a pergunta de conferência, montada com os dados atuais do tenant. */
export async function perguntaDeConferencia(db: Queryable, tenantId: string, catalogo?: CatalogoDeServicos): Promise<string> {
  const { rows } = await db.query<{ razao_social: string; codigo: string | null; importados: string }>(
    `select t.razao_social, t.codigo_servico_nacional as codigo,
            (select count(*) from nofiscal.fiscal_models m
              where m.tenant_id = t.id and m.origem in ('importacao_adn', 'importacao_pdf')) as importados
       from nofiscal.fiscal_tenants t where t.id = $1`,
    [tenantId],
  )
  const t = rows[0]
  const n = Number(t?.importados ?? 0)
  const descricao = t?.codigo && catalogo ? await catalogo.descricao(t.codigo).catch(() => null) : null
  const servico = t?.codigo ? `serviço ${t.codigo}${descricao ? ` (${descricao})` : ''}` : 'serviço ainda não escolhido'
  return `Sua empresa: ${t?.razao_social ?? ''}, ${servico}, ${n} ${n === 1 ? 'cliente importado' : 'clientes importados'}. Está tudo certo?`
}

/** "nota pra Prontia, 150 reais" e parecidos: um pedido, não o nome de um cliente. */
export function pareceUmPedido(texto: string): boolean {
  const t = limpa(texto)
  if (/^(nota|nf|emit)/.test(t)) return true
  return /\d/.test(t) && (/\b(reais|real)\b/.test(t) || /r\$/.test(t) || /\d,\d{1,2}\b/.test(t))
}

function cartaoDoModelo(m: Modelo): string {
  return [
    `Achei o modelo ${m.nome}:`,
    `Tomador: ${m.tomador_nome}`,
    `${tipoDoDocumento(m.tomador_documento).toUpperCase()}: ${formatarDocumento(m.tomador_documento)}`,
    `Serviço: ${m.codigo_servico_nacional}`,
    `Descrição: ${m.descricao}`,
    `E-mail: ${m.tomador_email ?? '-'}`,
    TEXTOS_BOAS_VINDAS.estaCerto,
  ].join('\n')
}

const pedirDados = (nome: string) => `Ainda não tenho ${nome} cadastrado. Me mande o CPF ou CNPJ e o e-mail de ${nome}.`
const perguntaDeSalvar = (nome: string) => `Salvar ${nome} como modelo? Responda sim ou não.`

async function lerModelo(db: Queryable, tenantId: string, id: string | undefined): Promise<Modelo | null> {
  if (!id) return null
  const { rows } = await db.query<Modelo>(
    `select id, nome, tomador_documento, tomador_nome, tomador_email, codigo_servico_nacional, descricao, valor_padrao::text
       from nofiscal.fiscal_models where tenant_id = $1 and id = $2`,
    [tenantId, id],
  )
  return rows[0] ?? null
}

/** A pergunta que está esperando resposta, para repetir (critério 34). */
async function perguntaPendente(ctx: Contexto, etapa: string, estado: Estado): Promise<string> {
  if (etapa === 'boas_vindas_conferir') return perguntaDeConferencia(ctx.deps.db, ctx.tenantId, ctx.deps.catalogo)
  if (etapa === 'boas_vindas_ensaio') return `${TEXTOS_BOAS_VINDAS.ensaio}.`
  switch (estado.passo ?? 'nome') {
    case 'conferir_modelo': {
      const modelo = await lerModelo(ctx.deps.db, ctx.tenantId, estado.modelo_id)
      return modelo ? cartaoDoModelo(modelo) : TEXTOS_BOAS_VINDAS.paraQuem
    }
    case 'dados':
      return pedirDados(estado.nome ?? 'o cliente')
    case 'salvar':
      return perguntaDeSalvar(estado.nome ?? 'o cliente')
    default:
      return TEXTOS_BOAS_VINDAS.paraQuem
  }
}

async function antesDeEmitir(ctx: Contexto, etapa: string, estado: Estado): Promise<void> {
  await responder(ctx, `${TEXTOS_BOAS_VINDAS.antesDeEmitir}.\n${await perguntaPendente(ctx, etapa, estado)}`)
}

/** Mensagem de um tenant com `onboarding_etapa` diferente de `concluido`. */
export async function conversarNasBoasVindas(ctx: Contexto, texto: string): Promise<void> {
  const { db } = ctx.deps
  const tenant = await lerTenant(db, ctx.tenantId)
  const etapa = tenant.onboarding_etapa
  const estado: Estado = tenant.boas_vindas ?? {}

  if ((ETAPAS_ANTES_DA_ATIVACAO as readonly string[]).includes(etapa)) {
    await responder(ctx, `${TEXTOS_BOAS_VINDAS.antesDeEmitir}. Continue em ${ctx.links.conta}`)
    return
  }
  if (etapa === 'clientes' || etapa === 'ativacao') {
    // O número foi ativado pela reserva antes de a pessoa terminar o site.
    await abrirBoasVindas(db, ctx.tenantId, ctx.agora)
    await responder(ctx, await perguntaDeConferencia(db, ctx.tenantId, ctx.deps.catalogo))
    return
  }
  if (etapa === 'boas_vindas_conferir') return conferir(ctx, texto)
  if (etapa === 'boas_vindas_cliente') return clienteFrequente(ctx, texto, estado)
  if (etapa === 'boas_vindas_ensaio') return ensaio(ctx, texto, estado)
  throw new Error(`etapa de onboarding desconhecida: ${etapa}`)
}

// ---------------------------------------------------------------------------------------
// 1. Conferir o cadastro (critério 29).

async function conferir(ctx: Contexto, texto: string): Promise<void> {
  if (ehSim(texto)) {
    await gravar(ctx.deps.db, ctx.tenantId, 'boas_vindas_cliente', { passo: 'nome' }, ctx.agora)
    await responder(ctx, TEXTOS_BOAS_VINDAS.paraQuem)
    return
  }
  if (ehNao(texto)) {
    await responder(ctx, `Corrija o que precisar em ${ctx.links.conta}. Quando terminar, me diga "pronto".`)
    return
  }
  if (limpa(texto) === 'pronto') {
    await responder(ctx, await perguntaDeConferencia(ctx.deps.db, ctx.tenantId, ctx.deps.catalogo))
    return
  }
  await antesDeEmitir(ctx, 'boas_vindas_conferir', {})
}

// ---------------------------------------------------------------------------------------
// 2. Cliente mais frequente (critério 30).

const paraOEnsaio = async (ctx: Contexto, estado: Estado, prefixo?: string) => {
  await gravar(ctx.deps.db, ctx.tenantId, 'boas_vindas_ensaio', estado, ctx.agora)
  await responder(ctx, `${prefixo ? `${prefixo}\n` : ''}${TEXTOS_BOAS_VINDAS.ensaio}.`)
}

async function clienteFrequente(ctx: Contexto, texto: string, estado: Estado): Promise<void> {
  const { db } = ctx.deps
  const passo = estado.passo ?? 'nome'

  if (passo === 'conferir_modelo') {
    const modelo = await lerModelo(db, ctx.tenantId, estado.modelo_id)
    if (modelo && ehSim(texto)) {
      await paraOEnsaio(ctx, { frequente: modelo.nome })
      return
    }
    if (!modelo || ehNao(texto)) {
      await gravar(db, ctx.tenantId, 'boas_vindas_cliente', { passo: 'nome' }, ctx.agora)
      await responder(ctx, 'Então me diga o nome do cliente para quem você mais emite.')
      return
    }
    await antesDeEmitir(ctx, 'boas_vindas_cliente', estado)
    return
  }

  if (passo === 'dados') {
    const documento = documentoNoTexto(texto) ?? estado.documento
    const email = emailNoTexto(texto) ?? estado.email
    if (!documentoNoTexto(texto) && !emailNoTexto(texto)) {
      if (pareceUmPedido(texto) || texto.replace(/\D/g, '').length < 11) {
        await antesDeEmitir(ctx, 'boas_vindas_cliente', estado)
      } else {
        await responder(ctx, 'Esse CPF ou CNPJ não é válido. Confira os números e me mande de novo, com o e-mail.')
      }
      return
    }
    const nome = estado.nome ?? 'o cliente'
    const novo: Estado = { ...estado, documento, email }
    if (!documento || !email) {
      await gravar(db, ctx.tenantId, 'boas_vindas_cliente', novo, ctx.agora)
      await responder(ctx, !documento ? `Falta o CPF ou CNPJ de ${nome}.` : `Falta o e-mail de ${nome}.`)
      return
    }
    await gravar(db, ctx.tenantId, 'boas_vindas_cliente', { ...novo, passo: 'salvar' }, ctx.agora)
    await responder(ctx, perguntaDeSalvar(nome))
    return
  }

  if (passo === 'salvar') {
    const nome = estado.nome as string
    if (ehSim(texto)) {
      const salvo = await salvarModelo(ctx, estado)
      await paraOEnsaio(
        ctx,
        { frequente: nome, frequente_documento: estado.documento, frequente_email: estado.email ?? null },
        salvo ? `Modelo ${nome} salvo.` : `Já existe um modelo com o nome ${nome}; mantive o que estava.`,
      )
      return
    }
    if (ehNao(texto)) {
      await paraOEnsaio(ctx, { frequente: nome, frequente_documento: estado.documento, frequente_email: estado.email ?? null }, 'Ok, não salvei.')
      return
    }
    await antesDeEmitir(ctx, 'boas_vindas_cliente', estado)
    return
  }

  // Passo "nome".
  if (pareceUmPedido(texto)) {
    await antesDeEmitir(ctx, 'boas_vindas_cliente', estado)
    return
  }
  const nome = texto.replace(/\s+/g, ' ').trim().slice(0, 60)
  const parsed: Parsed = { tomador: nome, modelo: nome, documento: null, valor: null, intencao: 'outro' }
  const modelo = await resolverModelo(db, ctx.tenantId, parsed)
  if (modelo && 'ambiguos' in modelo) {
    await responder(ctx, `Achei mais de um modelo: ${modelo.ambiguos.join(', ')}. Qual deles?`)
    return
  }
  if (modelo) {
    await gravar(db, ctx.tenantId, 'boas_vindas_cliente', { passo: 'conferir_modelo', modelo_id: modelo.id }, ctx.agora)
    await responder(ctx, cartaoDoModelo(modelo))
    return
  }
  await gravar(db, ctx.tenantId, 'boas_vindas_cliente', { passo: 'dados', nome }, ctx.agora)
  await responder(ctx, pedirDados(nome))
}

async function salvarModelo(ctx: Contexto, estado: Estado): Promise<boolean> {
  const { db } = ctx.deps
  const documento = estado.documento as string
  let tomadorNome = estado.nome as string
  if (tipoDoDocumento(documento) === 'cnpj' && ctx.deps.consultaCnpj) {
    const razao = await ctx.deps.consultaCnpj.razaoSocial(documento).catch(() => null)
    if (razao) tomadorNome = razao.trim().slice(0, 150)
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into nofiscal.fiscal_models
       (tenant_id, nome, tomador_documento, tomador_nome, tomador_email, codigo_servico_nacional, descricao, origem, created_at, updated_at)
     select t.id, $2, $3, $4, $5, t.codigo_servico_nacional, $6, 'boas_vindas', $7, $7
       from nofiscal.fiscal_tenants t where t.id = $1 and t.codigo_servico_nacional is not null
     on conflict (tenant_id, (lower(nome))) do nothing
     returning id`,
    [ctx.tenantId, estado.nome, documento, tomadorNome, estado.email ?? null, DESCRICAO_PADRAO, ctx.agora],
  )
  return rows.length === 1
}

// ---------------------------------------------------------------------------------------
// 3. Ensaio (critérios 31 a 33).

async function concluir(ctx: Contexto, estado: Estado, antes: string): Promise<void> {
  await gravar(ctx.deps.db, ctx.tenantId, 'concluido', null, ctx.agora)
  await responder(ctx, antes)
  await responder(ctx, textoPronto(estado.frequente ?? 'seu cliente'))
  logEvent('agente.onboarding_concluido', { tenant_id: ctx.tenantId })
}

async function ensaio(ctx: Contexto, texto: string, estado: Estado): Promise<void> {
  if (ehConfirmar(texto)) {
    if (estado.resumo_enviado) {
      await concluir(ctx, estado, TEXTOS_BOAS_VINDAS.soExemplo)
      return
    }
    await responder(ctx, `${TEXTOS_BOAS_VINDAS.soExemplo}.\n${TEXTOS_BOAS_VINDAS.ensaio}.`)
    return
  }
  if (estado.resumo_enviado && ehNao(texto)) {
    await concluir(ctx, estado, TEXTOS_BOAS_VINDAS.descartado)
    return
  }

  let parsed: Parsed
  try {
    const resultado = await ctx.deps.interprete.interpretar(texto)
    parsed = validarParsed(resultado.parsed)
    logEvent('agente.ensaio', { tokens_entrada: resultado.tokens?.entrada ?? 0, tokens_saida: resultado.tokens?.saida ?? 0 })
  } catch (error) {
    logEvent('agente.interprete_falhou', { error_name: error instanceof Error ? error.name : 'unknown' })
    await responder(ctx, TEXTOS.naoEntendi)
    return
  }
  if (parsed.intencao !== 'emitir' || !parsed.valor || !(parsed.tomador || parsed.modelo || parsed.documento)) {
    const falta = !parsed.valor && !(parsed.tomador || parsed.modelo) ? TEXTOS.faltaTudo : !parsed.valor ? TEXTOS.faltaValor : TEXTOS.faltaTomador
    await responder(ctx, `${TEXTOS_BOAS_VINDAS.ensaio}. ${falta}`)
    return
  }

  const resumo = await resumoDoEnsaio(ctx, parsed, estado)
  await gravar(ctx.deps.db, ctx.tenantId, 'boas_vindas_ensaio', { ...estado, resumo_enviado: true }, ctx.agora)
  await responder(ctx, `${TEXTOS_BOAS_VINDAS.exemplo}\n${resumo}`)
}

async function resumoDoEnsaio(ctx: Contexto, parsed: Parsed, estado: Estado): Promise<string> {
  const valor = parsed.valor as string
  const modelo = await resolverModelo(ctx.deps.db, ctx.tenantId, parsed)
  if (modelo && !('ambiguos' in modelo)) {
    return textoDoResumo(
      { documento: modelo.tomador_documento, nome: modelo.tomador_nome, email: modelo.tomador_email },
      { codigo: modelo.codigo_servico_nacional, descricao: modelo.descricao },
      valor,
    )
  }
  const { rows } = await ctx.deps.db.query<{ codigo: string | null }>(
    'select codigo_servico_nacional as codigo from nofiscal.fiscal_tenants where id = $1',
    [ctx.tenantId],
  )
  const servico = { codigo: rows[0]?.codigo ?? '-', descricao: DESCRICAO_PADRAO }
  const nome = parsed.tomador ?? parsed.modelo ?? 'o tomador'
  const ehOFrequente = estado.frequente && nome.toLowerCase().startsWith(estado.frequente.toLowerCase())
  const documento = parsed.documento ?? (ehOFrequente ? estado.frequente_documento : undefined)
  if (documento) return textoDoResumo({ documento, nome, email: null }, servico, valor)
  return textoDoResumo({ documento: '', nome, email: null }, servico, valor).replace(
    /^CPF: .*$/m,
    'CPF/CNPJ: eu pediria antes de emitir',
  )
}
