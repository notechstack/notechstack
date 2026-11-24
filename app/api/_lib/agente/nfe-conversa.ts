// NF-e avulsa pelo WhatsApp (Lucca, 23/11/2026). Conversa guiada e determinística, sem IA: produto é difícil de pedir
// por texto, então o agente pergunta passo a passo e reaproveita o que a empresa já emitiu (historicoNfe): clientes,
// produtos (com NCM, CFOP, CSOSN e preço da última nota) e transportadoras. Nada fiscal é inventado: produto novo vem
// com todos os campos escritos pela pessoa, e o CFOP que não serve para a UF do cliente é perguntado, nunca trocado.
// O pedido mora em `fiscal_requests` (kind 'emitir_nfe', etapa 'nfe', passo em `conversa.nfe`; migração
// 20261124090000) e só vira nota no *confirmar*, pela mesma conferência e fila do painel e da planilha (criarNfe,
// origem 'whatsapp'). Quando a Sefaz responde, `avisarNfeDoWhatsApp` manda o DANFE (ou o motivo) a quem pediu.
//
// Começa com "nfe", "emitir nfe", "nova nfe", "nota de produto". "nfe 123" e "nfe Maria" continuam sendo a consulta
// do DANFE (ver-nota.ts).
import type { Queryable } from '../db.js'
import { logEvent } from '../log.js'
import { resolverMunicipio } from '../local-prestacao.js'
import { renderDanfe, formatarChave } from '../nfe/danfe.js'
import { MUNICIPIOS_IBGE } from '../nfe/municipios-ibge.js'
import {
  avisosNfe,
  calcularTotais,
  informacoesComplementaresDaNota,
  kg,
  MODALIDADES_FRETE,
  resumoCreditoSn,
  soDigitos,
  type Csosn,
  type Item,
  type ModalidadeFrete,
  type Transportador,
  type Volume,
} from '../nfe/nfe-builder.js'
import { FORMAS, lerNumero, modalidade as lerModalidade, ratearFrete } from '../nfe/campos.js'
import { bloqueioNfe, conferirPedido, criarNfe, empresaNfe, historicoNfe, motivoDoBloqueio, type HistoricoNfe, type PedidoNfe } from '../nfe/servico.js'
import type { EnviaWhatsApp } from './canais.js'
import { ehConfirmarEmissao, ehDesistir, responder, semAcento, VALIDADE_DO_PEDIDO_MS, type Contexto } from './conversa.js'
import { documentoNoTexto, formatarDocumento, formatarReais } from './documentos.js'
import { empresasDaResposta, empresasParaEscolher, perguntaDoEmitente, type EmpresaDaConta } from './emitente.js'
import { blocos, campo, mensagem, topicos } from './formato.js'
import { planoDeEscritorio } from './planos.js'

const QUEBRA = '\n'
export const MAX_CLIENTES_NA_LISTA = 8
export const MAX_PRODUTOS_NA_LISTA = 10

type Passo =
  | 'empresa'
  | 'destinatario'
  | 'nome'
  | 'endereco'
  | 'ie'
  | 'itens'
  | 'produto_novo'
  | 'cfop'
  | 'pagamento'
  | 'transporte'
  | 'modalidade'
  | 'info'
  | 'confirmar'
  | 'corrigir'

type Destinatario = PedidoNfe['destinatario']

export type EstadoNfe = {
  passo: Passo
  /** Ids (empresas) ou índices (clientes) da última lista numerada mostrada. */
  opcoes?: string[]
  empresa?: { id: string; razao_social: string; cnpj: string; uf: string | null }
  destinatario?: Destinatario
  /** Cliente novo, em montagem (documento, nome e endereço ainda incompletos). */
  rascunho?: { documento: string; nome?: string; endereco?: Destinatario['endereco'] }
  itens: Item[]
  /** Item à espera do CFOP certo para a UF do cliente. */
  cfop_pendente?: number
  forma?: string
  descricao_pagamento?: string | null
  frete?: number | null
  modalidade?: ModalidadeFrete
  transportador?: Transportador
  volumes?: Volume[]
  info?: string | null
  info_perguntada?: boolean
  nfe_id?: string
}

type PedidoAberto = { id: string; tenant_id: string; status: string; expires_at: Date; conversa: { nfe?: EstadoNfe } }

// ---------- textos ----------

export const TEXTOS_NFE = {
  semPlano: 'A NF-e pelo WhatsApp é do plano Escritório com NF-e. Para incluir, fale com a nó por aqui mesmo.',
  descartada: 'Ok, deixei essa NF-e de lado. Quando quiser outra, é só mandar *nfe*.',
  pagamento: 'Qual a forma de pagamento? *pix*, *boleto*, *dinheiro*, *credito*, *debito*, *transferencia*, *sem pagamento* ou *outros: descrição*.',
  transporte: mensagem({
    titulo: 'Transporte',
    blocos: [
      [
        'Tem frete, transportadora ou volumes? Responda *não*, ou mande o que tiver, separado por ponto e vírgula. Exemplos:',
        'frete 25,00; por conta do emitente; transportadora 11.444.777/0001-61; 10 caixas; peso 60,4',
      ],
      'Também vale: *fob*, *cif*, *terceiros*, *sem frete*, *marca X*, *numeração 1 a 10*, *peso liquido 60*, *peso bruto 61*.',
    ],
  }),
  modalidade: 'Por conta de quem é o frete? *emitente* (CIF), *destinatario* (FOB), *terceiros*, *proprio remetente* ou *proprio destinatario*.',
  info: 'Quer informações complementares na nota (por exemplo, a frase do Simples ou o crédito de ICMS)? Mande o texto, ou *não*.',
  endereco: blocos(
    'Mande o endereço do cliente numa mensagem, separado por vírgula: rua, número, bairro, CEP, cidade/UF.',
    'Exemplo: Rua das Flores, 100, Centro, 12900-000, Bragança Paulista/SP',
  ),
  ie: 'O cliente tem inscrição estadual? Mande o número, *isento*, ou *não* (não contribuinte).',
  produtoNovo: mensagem({
    titulo: 'Produto novo',
    blocos: [
      ['Mande o produto novo numa mensagem, separado por ponto e vírgula, nesta ordem:', 'código; descrição; NCM; CFOP; CSOSN; unidade; quantidade; preço unitário'],
      ['No CSOSN 101, ponha no fim a alíquota do crédito. Exemplo:', 'EMB-50; Caixa 50x40x30; 4819.10.00; 5101; 101; UN; 200; 3,10; 2,56'],
    ],
  }),
  corrigir: 'O que muda? *cliente*, *produtos*, *pagamento*, *transporte* ou *informações*.',
  pergunta: 'Posso emitir? Responda *confirmar* para emitir, *corrigir* para mudar algo ou *descartar*.',
}

// ---------- entrada ----------

/** "nfe", "emitir nfe", "nova nf-e", "nota de produto": começa a conversa. "nfe 123" (consulta) não. */
export function ehPedidoDeNfe(texto: string): boolean {
  const t = semAcento(texto).replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim()
  return /^((quero |preciso )?(emitir|emite|emita|fazer|faz|tirar|gerar|nova|uma|outra) (uma )?)?(nfe|nf-e|nota de produto|nota fiscal de produto|nota fiscal eletronica)$/.test(t)
}

async function pedidoAberto(ctx: Contexto): Promise<PedidoAberto | null> {
  const { rows } = await ctx.deps.db.query<PedidoAberto & { kind: string; etapa: string | null }>(
    `select id, tenant_id, kind, status, etapa, expires_at, conversa from nofiscal.fiscal_requests
      where phone_id = $1 order by created_at desc, id desc limit 1`,
    [ctx.phoneId],
  )
  const p = rows[0]
  if (!p || p.kind !== 'emitir_nfe' || p.status !== 'awaiting_confirmation' || p.etapa !== 'nfe') return null
  return p
}

async function salvar(ctx: Contexto, id: string, estado: EstadoNfe, tenantId?: string): Promise<void> {
  await ctx.deps.db.query(
    `update nofiscal.fiscal_requests set conversa = $2::jsonb, tenant_id = coalesce($4, tenant_id), updated_at = $3 where id = $1`,
    [id, JSON.stringify({ nfe: estado }), ctx.agora, tenantId ?? null],
  )
}

async function encerrar(ctx: Contexto, id: string, status: 'expired' | 'rejected_by_user' | 'confirmed', estado?: EstadoNfe): Promise<void> {
  await ctx.deps.db.query(
    `update nofiscal.fiscal_requests set status = $2, etapa = null, updated_at = $3, conversa = coalesce($4::jsonb, conversa) where id = $1`,
    [id, status, ctx.agora, estado ? JSON.stringify({ nfe: estado }) : null],
  )
}

/**
 * Trata a mensagem se ela começa uma NF-e ou responde a uma NF-e aberta. `false` deixa a mensagem para o resto da
 * conversa (NFS-e, comandos…). Um pedido novo de NFS-e no meio da NF-e deixa a NF-e de lado.
 */
export async function tratarNfeConversa(ctx: Contexto, texto: string, pareceNovoPedido: (t: string) => boolean): Promise<boolean> {
  const aberto = await pedidoAberto(ctx)
  if (aberto) {
    ctx.pedidoId = aberto.id
    if (aberto.expires_at.getTime() <= ctx.agora.getTime()) {
      await encerrar(ctx, aberto.id, 'expired')
      if (!ehPedidoDeNfe(texto)) return false
    } else if (ehPedidoDeNfe(texto)) {
      await encerrar(ctx, aberto.id, 'rejected_by_user')
    } else if (ehDesistir(texto)) {
      await encerrar(ctx, aberto.id, 'rejected_by_user')
      await responder(ctx, TEXTOS_NFE.descartada)
      return true
    } else if (PASSOS_SEM_TEXTO_LIVRE.has(aberto.conversa.nfe?.passo ?? 'empresa') && pareceNovoPedido(texto) && !/^(nfe|nf-e)\b/.test(semAcento(texto))) {
      await encerrar(ctx, aberto.id, 'rejected_by_user')
      ctx.pedidoId = null
      return false
    } else {
      const estado = aberto.conversa.nfe ?? { passo: 'empresa', itens: [] }
      await responderPasso(ctx, aberto.id, estado, texto)
      return true
    }
  }
  if (!ehPedidoDeNfe(texto)) return false
  await comecar(ctx)
  return true
}

/** Passos em que a resposta não é texto livre: lá, "nota pra X, 350" é um pedido de NFS-e e a NF-e fica de lado. */
const PASSOS_SEM_TEXTO_LIVRE = new Set<Passo>(['empresa', 'destinatario', 'pagamento', 'confirmar', 'corrigir'])

async function contaEmiteNfe(db: Queryable, tenantId: string): Promise<boolean> {
  const { rows } = await db.query<{ plan: string; tipos: string[] | null }>(
    'select t.plan, nofiscal.tipos_nota_da_conta(t.id) as tipos from nofiscal.fiscal_tenants t where t.id = $1',
    [tenantId],
  )
  return planoDeEscritorio(rows[0]?.plan) && (rows[0]?.tipos ?? []).includes('nfe')
}

async function comecar(ctx: Contexto): Promise<void> {
  if (!(await contaEmiteNfe(ctx.deps.db, ctx.tenantId))) {
    await responder(ctx, TEXTOS_NFE.semPlano)
    return
  }
  const { rows } = await ctx.deps.db.query<{ id: string }>(
    `insert into nofiscal.fiscal_requests
       (tenant_id, phone_id, kind, status, parsed, expires_at, etapa, conversa, created_at, updated_at)
     values ($1, $2, 'emitir_nfe', 'awaiting_confirmation', '{}'::jsonb, $3, 'nfe', $4::jsonb, clock_timestamp(), $5)
     returning id`,
    [ctx.tenantId, ctx.phoneId, new Date(ctx.agora.getTime() + VALIDADE_DO_PEDIDO_MS), JSON.stringify({ nfe: { passo: 'empresa', itens: [] } }), ctx.agora],
  )
  ctx.pedidoId = rows[0].id
  logEvent('agente.nfe_conversa_iniciada', { tenant_id: ctx.tenantId })
  const empresas = await empresasParaEscolher(ctx.deps.db, ctx.tenantId)
  const estado: EstadoNfe = { passo: 'empresa', itens: [] }
  if (!empresas.length) {
    const { rows: t } = await ctx.deps.db.query<{ id: string; razao_social: string; cnpj: string }>('select id, razao_social, cnpj from nofiscal.fiscal_tenants where id = $1', [ctx.tenantId])
    await escolherEmpresa(ctx, rows[0].id, estado, { ...t[0], principal: true })
    return
  }
  const pergunta = perguntaDoEmitente(empresas)
  estado.opcoes = pergunta.opcoes
  await salvar(ctx, rows[0].id, estado)
  await responder(ctx, pergunta.texto.replace('sai a nota', 'sai a NF-e'))
}

// ---------- passos ----------

async function responderPasso(ctx: Contexto, id: string, estado: EstadoNfe, texto: string): Promise<void> {
  switch (estado.passo) {
    case 'empresa': {
      const empresas = await empresasParaEscolher(ctx.deps.db, ctx.tenantId)
      const achadas = empresasDaResposta(empresas, estado.opcoes ?? [], texto)
      if (achadas.length !== 1) {
        const pergunta = perguntaDoEmitente(empresas, achadas.length > 1 ? { candidatas: achadas } : { naoAchei: texto.trim() })
        await salvar(ctx, id, { ...estado, opcoes: pergunta.opcoes })
        await responder(ctx, pergunta.texto.replace('sai a nota', 'sai a NF-e'))
        return
      }
      await escolherEmpresa(ctx, id, estado, achadas[0])
      return
    }
    case 'destinatario':
      return escolherDestinatario(ctx, id, estado, texto)
    case 'nome': {
      const nome = texto.trim()
      if (nome.length < 2) return void (await responder(ctx, 'Qual o nome do cliente?'))
      const r = { ...estado.rascunho!, nome: nome.slice(0, 60) }
      await salvar(ctx, id, { ...estado, rascunho: r, passo: 'endereco' })
      await responder(ctx, TEXTOS_NFE.endereco)
      return
    }
    case 'endereco': {
      const lido = lerEndereco(texto)
      if ('erro' in lido) return void (await responder(ctx, blocos(lido.erro, TEXTOS_NFE.endereco)))
      const r = { ...estado.rascunho!, endereco: lido.endereco }
      if (r.documento.length === 11) return fecharDestinatario(ctx, id, estado, { documento: r.documento, nome: r.nome!, indicadorIE: '9', endereco: lido.endereco })
      await salvar(ctx, id, { ...estado, rascunho: r, passo: 'ie' })
      await responder(ctx, TEXTOS_NFE.ie)
      return
    }
    case 'ie': {
      const t = semAcento(texto).replace(/[.!?]+$/, '').trim()
      const r = estado.rascunho!
      const base = { documento: r.documento, nome: r.nome!, endereco: r.endereco! }
      if (/^(isento|isenta)$/.test(t)) return fecharDestinatario(ctx, id, estado, { ...base, indicadorIE: '2' })
      if (/^(nao|n|nao tem|nao contribuinte|sem ie|sem)$/.test(t)) return fecharDestinatario(ctx, id, estado, { ...base, indicadorIE: '9' })
      const ie = soDigitos(texto)
      if (!/^\d{2,14}$/.test(ie)) return void (await responder(ctx, `Não entendi a inscrição estadual. ${TEXTOS_NFE.ie}`))
      return fecharDestinatario(ctx, id, estado, { ...base, indicadorIE: '1', inscricaoEstadual: ie })
    }
    case 'itens':
      return receberItens(ctx, id, estado, texto)
    case 'produto_novo':
      return receberProdutoNovo(ctx, id, estado, texto)
    case 'cfop': {
      const cfop = soDigitos(texto)
      const i = estado.cfop_pendente ?? 0
      const esperado = primeiroDigitoDoCfop(estado)
      if (!/^\d{4}$/.test(cfop) || cfop[0] !== esperado) {
        await responder(ctx, `Mande o CFOP com 4 dígitos, começando com ${esperado} (${esperado === '6' ? 'outro estado' : 'dentro do estado'}).`)
        return
      }
      const itens = estado.itens.map((item, k) => (k === i ? { ...item, cfop } : item))
      return depoisDosItens(ctx, id, { ...estado, itens, cfop_pendente: undefined })
    }
    case 'pagamento': {
      const lido = lerPagamento(texto)
      if (!lido) return void (await responder(ctx, `Não entendi a forma de pagamento. ${TEXTOS_NFE.pagamento}`))
      // Na correção (a nota já passou por todos os passos), volta direto ao resumo.
      if (estado.info_perguntada) return mostrarResumo(ctx, id, { ...estado, forma: lido.forma, descricao_pagamento: lido.descricao })
      await salvar(ctx, id, { ...estado, forma: lido.forma, descricao_pagamento: lido.descricao, passo: 'transporte' })
      await responder(ctx, TEXTOS_NFE.transporte)
      return
    }
    case 'transporte':
      return receberTransporte(ctx, id, estado, texto)
    case 'modalidade': {
      const m = lerModalidade(texto)
      if (!m) return void (await responder(ctx, TEXTOS_NFE.modalidade))
      return irParaInfo(ctx, id, { ...estado, modalidade: m })
    }
    case 'info': {
      const t = semAcento(texto).replace(/[.!?]+$/, '').trim()
      const info = /^(nao|n|sem|nenhuma|nada|pular)$/.test(t) ? null : texto.trim().slice(0, 2000)
      return mostrarResumo(ctx, id, { ...estado, info, info_perguntada: true })
    }
    case 'confirmar': {
      if (ehConfirmarEmissao(texto)) return emitir(ctx, id, estado)
      if (/^(corrigir|corrige|mudar|alterar|errado)$/.test(semAcento(texto).replace(/[.!?]+$/, '').trim())) {
        await salvar(ctx, id, { ...estado, passo: 'corrigir' })
        await responder(ctx, TEXTOS_NFE.corrigir)
        return
      }
      await responder(ctx, TEXTOS_NFE.pergunta)
      return
    }
    case 'corrigir':
      return corrigir(ctx, id, estado, texto)
  }
}

async function escolherEmpresa(ctx: Contexto, id: string, estado: EstadoNfe, e: EmpresaDaConta | { id: string; razao_social: string; cnpj: string }): Promise<void> {
  const bloqueio = await bloqueioNfe(ctx.deps.db, e.id)
  if (bloqueio) {
    await encerrar(ctx, id, 'rejected_by_user')
    await responder(ctx, `${e.razao_social} ainda não emite NF-e: ${motivoDoBloqueio(bloqueio)}. Ajuste em Minha conta → NF-e: ${ctx.links.conta}#nfe`)
    return
  }
  const dados = await empresaNfe(ctx.deps.db, e.id)
  const novo: EstadoNfe = { ...estado, opcoes: undefined, empresa: { id: e.id, razao_social: e.razao_social, cnpj: e.cnpj, uf: dados?.endereco?.uf ?? null }, passo: 'destinatario' }
  const hist = await historicoNfe(ctx.deps.db, e.id)
  const clientes = hist.destinatarios.slice(0, MAX_CLIENTES_NA_LISTA)
  novo.opcoes = clientes.map((d) => d.documento)
  await salvar(ctx, id, novo, e.id)
  await responder(
    ctx,
    blocos(
      [
        `NF-e pela ${e.razao_social}. Para quem é? Mande o CPF ou CNPJ do cliente${clientes.length ? ', ou o número de um cliente recente:' : '.'}`,
        ...clientes.map((d, i) => `${i + 1}. ${d.nome} · ${formatarDocumento(soDigitos(d.documento))}`),
      ],
      'Para desistir, *descartar*.',
    ),
  )
}

async function historico(ctx: Contexto, estado: EstadoNfe): Promise<HistoricoNfe> {
  return historicoNfe(ctx.deps.db, estado.empresa!.id)
}

async function escolherDestinatario(ctx: Contexto, id: string, estado: EstadoNfe, texto: string): Promise<void> {
  const hist = await historico(ctx, estado)
  const numero = /^(\d{1,2})$/.exec(texto.trim().replace(/[.!?]+$/, ''))
  if (numero && estado.opcoes?.length) {
    const doc = estado.opcoes[Number(numero[1]) - 1]
    const d = doc ? hist.destinatarios.find((x) => soDigitos(x.documento) === soDigitos(doc)) : null
    if (!d) return void (await responder(ctx, `Não tenho o cliente ${numero[1]} na lista. Mande o número da lista ou o CPF/CNPJ.`))
    return fecharDestinatario(ctx, id, estado, d)
  }
  const doc = documentoNoTexto(texto)
  if (!doc) return void (await responder(ctx, 'Não achei um CPF ou CNPJ válido. Mande o documento do cliente, ou o número dele na lista.'))
  const conhecido = hist.destinatarios.find((x) => soDigitos(x.documento) === doc)
  if (conhecido) return fecharDestinatario(ctx, id, estado, conhecido)
  // Cliente novo com CNPJ: nome e endereço da Receita; com CPF (ou sem a Receita), a pessoa escreve.
  if (doc.length === 14 && ctx.deps.consultaCnpj) {
    const [nome, end] = await Promise.all([
      ctx.deps.consultaCnpj.razaoSocial(doc).catch(() => null),
      ctx.deps.consultaCnpj.endereco ? ctx.deps.consultaCnpj.endereco(doc).catch(() => null) : Promise.resolve(null),
    ])
    const uf = end ? ufDoIbge(end.cMun) : null
    if (nome && end && uf) {
      const endereco = { logradouro: end.logradouro, numero: end.numero || 'S/N', complemento: end.complemento ?? null, bairro: end.bairro, codigoMunicipio: end.cMun, uf: uf as Destinatario['endereco']['uf'], cep: end.cep }
      await salvar(ctx, id, { ...estado, rascunho: { documento: doc, nome: nome.slice(0, 60), endereco }, passo: 'ie', opcoes: undefined })
      await responder(ctx, blocos(`Achei na Receita: ${nome}, ${endereco.logradouro}, ${endereco.numero}, ${endereco.bairro}, ${MUNICIPIOS_IBGE[end.cMun]}/${uf}.`, TEXTOS_NFE.ie))
      return
    }
  }
  await salvar(ctx, id, { ...estado, rascunho: { documento: doc }, passo: 'nome', opcoes: undefined })
  await responder(ctx, 'Cliente novo. Qual o nome (ou razão social)?')
}

const ufDoIbge = (cMun: string): string | null => {
  const m = resolverMunicipio(cMun)
  return m.ok ? m.municipio.uf : null
}

/** "Rua das Flores, 100, Centro, 12900-000, Bragança Paulista/SP" → endereço; o bairro pode ter vírgula. */
export function lerEndereco(texto: string): { endereco: Destinatario['endereco'] } | { erro: string } {
  const partes = texto.split(',').map((p) => p.trim()).filter(Boolean)
  if (partes.length < 5) return { erro: 'Faltou parte do endereço.' }
  const cidade = partes[partes.length - 1]
  const cep = soDigitos(partes[partes.length - 2])
  if (cep.length !== 8) return { erro: `O CEP "${partes[partes.length - 2]}" precisa de 8 dígitos.` }
  const m = resolverMunicipio(cidade)
  if (!m.ok) {
    return { erro: m.motivo === 'ambiguo' ? `${m.nome} existe em mais de um estado (${m.opcoes.map((o) => o.uf).join(', ')}): escreva cidade/UF.` : `Não achei a cidade "${cidade}". Escreva cidade/UF.` }
  }
  return {
    endereco: {
      logradouro: partes[0].slice(0, 60),
      numero: partes[1].slice(0, 60) || 'S/N',
      complemento: null,
      bairro: partes.slice(2, -2).join(', ').slice(0, 60),
      codigoMunicipio: m.municipio.ibge,
      uf: m.municipio.uf as Destinatario['endereco']['uf'],
      cep,
    },
  }
}

async function fecharDestinatario(ctx: Contexto, id: string, estado: EstadoNfe, d: Destinatario): Promise<void> {
  const novo: EstadoNfe = { ...estado, destinatario: d, rascunho: undefined, opcoes: undefined }
  // Na correção do cliente, os produtos já estão: segue para o CFOP (a UF pode ter mudado) e o resumo.
  if (novo.itens.length) return depoisDosItens(ctx, id, novo)
  await salvar(ctx, id, { ...novo, passo: 'itens' })
  await responder(ctx, await textoDosProdutos(ctx, novo))
}

async function textoDosProdutos(ctx: Contexto, estado: EstadoNfe): Promise<string> {
  const produtos = (await historico(ctx, estado)).produtos.slice(0, MAX_PRODUTOS_NA_LISTA)
  return blocos(
    `Cliente: ${estado.destinatario!.nome}. Agora os produtos.`,
    ...(produtos.length
      ? [
          'Mande um produto por linha: o número da lista (ou o código) e a quantidade. Preço diferente ou desconto: *1 500 preco 2,40 desconto 61,25*.',
          produtos.map((p, i) => `${i + 1}. ${p.codigo} · ${p.descricao} · ${formatarReais(p.valorUnitario)}/${p.unidade} · NCM ${p.ncm} · CFOP ${p.cfop} · CSOSN ${p.csosn}`),
          'Produto que nunca saiu por esta empresa: mande *novo*.',
        ]
      : ['Esta empresa ainda não emitiu NF-e, então não tenho produtos salvos. Mande *novo* para escrever o primeiro.']),
  )
}

/** Uma linha de item: "<n|código> <quantidade> [preco X] [desconto Y]". */
export function lerLinhaDeItem(
  linha: string,
  produtos: HistoricoNfe['produtos'],
): { item: Item } | { erro: string } {
  const t = linha.trim().replace(/^[-•*]\s*/, '')
  const m = /^(\S+)\s+(?:x\s*)?([\d.,]+)(.*)$/i.exec(t)
  if (!m) return { erro: `"${t}": mande o número (ou código) e a quantidade.` }
  const ref = m[1]
  const porNumero = /^\d{1,2}$/.test(ref) && Number(ref) >= 1 && Number(ref) <= Math.min(produtos.length, MAX_PRODUTOS_NA_LISTA) ? produtos[Number(ref) - 1] : null
  const p = porNumero ?? produtos.find((x) => x.codigo.trim().toUpperCase() === ref.toUpperCase())
  if (!p) return { erro: `Não achei o produto "${ref}" entre os que esta empresa já emitiu. Para produto novo, mande *novo*.` }
  const quantidade = lerNumero(m[2], 4)
  if (!(quantidade && quantidade > 0)) return { erro: `${p.codigo}: quantidade "${m[2]}" inválida.` }
  const resto = semAcento(m[3])
  const preco = /prec[oa]\s*(?:r\$)?\s*([\d.,]+)/.exec(resto)
  const desconto = /desc(?:onto)?\s*(?:r\$)?\s*([\d.,]+)/.exec(resto)
  const valorUnitario = preco ? lerNumero(preco[1], 10) : p.valorUnitario
  const valorDesconto = desconto ? lerNumero(desconto[1], 2) : null
  if (!(valorUnitario && valorUnitario > 0)) return { erro: `${p.codigo}: preço inválido.` }
  if (desconto && valorDesconto === null) return { erro: `${p.codigo}: desconto inválido.` }
  return { item: { ...p, quantidade, valorUnitario, desconto: valorDesconto || null } }
}

async function receberItens(ctx: Contexto, id: string, estado: EstadoNfe, texto: string): Promise<void> {
  const t = semAcento(texto).replace(/[.!?]+$/, '').trim()
  if (/^(novo|produto novo|novo produto)$/.test(t)) {
    await salvar(ctx, id, { ...estado, passo: 'produto_novo' })
    await responder(ctx, TEXTOS_NFE.produtoNovo)
    return
  }
  if (/^(pronto|so isso|e isso|fim|acabou|terminei|ok)$/.test(t)) {
    if (!estado.itens.length) return void (await responder(ctx, blocos('Ainda não anotei nenhum produto.', await textoDosProdutos(ctx, estado))))
    return depoisDosItens(ctx, id, estado)
  }
  const produtos = (await historico(ctx, estado)).produtos
  const novos: Item[] = []
  for (const linha of texto.split(/\n+/).map((l) => l.trim()).filter(Boolean)) {
    const lido = lerLinhaDeItem(linha, produtos)
    if ('erro' in lido) return void (await responder(ctx, lido.erro))
    novos.push(lido.item)
  }
  const itens = [...estado.itens, ...novos]
  await salvar(ctx, id, { ...estado, itens })
  await responder(ctx, blocos(['Anotei:', topicos(itens.map(linhaDoItem))], 'Mais algum? Mande outro produto, *novo*, ou *pronto*.'))
}

const linhaDoItem = (i: Item) =>
  `${i.codigo} · ${i.descricao} · ${String(i.quantidade).replace('.', ',')} ${i.unidade} × ${formatarReais(i.valorUnitario)}${i.desconto ? ` (desconto ${formatarReais(i.desconto)})` : ''}`

const CSOSNS = ['101', '102', '103', '300', '400', '500']

/** "código; descrição; NCM; CFOP; CSOSN; unidade; quantidade; preço[; alíquota do crédito]". */
export function lerProdutoNovo(texto: string): { item: Item } | { erro: string } {
  const p = texto.split(';').map((x) => x.trim())
  if (p.length < 8) return { erro: 'Faltou campo: são 8 (9 no CSOSN 101), separados por ponto e vírgula.' }
  const [codigo, descricao, ncmT, cfopT, csosnT, unidade, qtdT, precoT, creditoT] = p
  const ncm = soDigitos(ncmT)
  const cfop = soDigitos(cfopT)
  const csosn = soDigitos(csosnT)
  const quantidade = lerNumero(qtdT, 4)
  const valorUnitario = lerNumero(precoT, 10)
  const credito = creditoT ? lerNumero(creditoT, 4) : null
  if (!codigo || codigo.length > 60) return { erro: 'Código do produto vazio.' }
  if (!descricao) return { erro: 'Descrição vazia.' }
  if (!/^\d{8}$/.test(ncm)) return { erro: `NCM "${ncmT}" precisa de 8 dígitos.` }
  if (!/^[56]\d{3}$/.test(cfop)) return { erro: `CFOP "${cfopT}" precisa de 4 dígitos, começando com 5 ou 6.` }
  if (!CSOSNS.includes(csosn)) return { erro: `CSOSN "${csosnT}" não é um destes: ${CSOSNS.join(', ')}.` }
  if (!unidade || unidade.length > 6) return { erro: 'Unidade de 1 a 6 letras (UN, CX, KG…).' }
  if (!(quantidade && quantidade > 0)) return { erro: `Quantidade "${qtdT}" inválida.` }
  if (!(valorUnitario && valorUnitario > 0)) return { erro: `Preço "${precoT}" inválido.` }
  if (csosn === '101' && !(credito && credito > 0)) return { erro: 'No CSOSN 101, ponha no fim a alíquota do crédito do Simples (ex.: 2,56).' }
  return {
    item: { codigo, descricao, ncm, cfop, csosn: csosn as Csosn, unidade: unidade.toUpperCase(), quantidade, valorUnitario, origem: '0', aliquotaCreditoSN: csosn === '101' ? credito : null },
  }
}

async function receberProdutoNovo(ctx: Contexto, id: string, estado: EstadoNfe, texto: string): Promise<void> {
  const lido = lerProdutoNovo(texto)
  if ('erro' in lido) return void (await responder(ctx, blocos(lido.erro, TEXTOS_NFE.produtoNovo)))
  const itens = [...estado.itens, lido.item]
  await salvar(ctx, id, { ...estado, itens, passo: 'itens' })
  await responder(
    ctx,
    blocos(['Anotei (origem nacional; para outra origem, use o painel):', topicos(itens.map(linhaDoItem))], 'Mais algum? Mande outro produto, *novo*, ou *pronto*.'),
  )
}

const primeiroDigitoDoCfop = (estado: EstadoNfe) => (estado.empresa?.uf && estado.destinatario && estado.empresa.uf !== estado.destinatario.endereco.uf ? '6' : '5')

/** Depois dos produtos: o CFOP que não serve para a UF do cliente é perguntado, um por vez; depois o pagamento. */
async function depoisDosItens(ctx: Contexto, id: string, estado: EstadoNfe): Promise<void> {
  const esperado = primeiroDigitoDoCfop(estado)
  const i = estado.itens.findIndex((item) => soDigitos(item.cfop)[0] !== esperado)
  if (i >= 0) {
    const item = estado.itens[i]
    await salvar(ctx, id, { ...estado, passo: 'cfop', cfop_pendente: i })
    await responder(
      ctx,
      `O CFOP do ${item.codigo} é ${item.cfop}, ${esperado === '6' ? 'de dentro do estado; esta nota vai para ' + estado.destinatario!.endereco.uf : 'de outro estado; esta nota é dentro do estado'}. Qual CFOP uso? (começa com ${esperado})`,
    )
    return
  }
  if (estado.forma) return mostrarResumo(ctx, id, estado)
  await salvar(ctx, id, { ...estado, passo: 'pagamento' })
  await responder(ctx, TEXTOS_NFE.pagamento)
}

export function lerPagamento(texto: string): { forma: string; descricao: string | null } | null {
  const outros = /^outros?\s*[:-]\s*(.+)$/i.exec(texto.trim())
  if (outros) return { forma: '99', descricao: outros[1].trim().slice(0, 60) }
  const t = semAcento(texto).replace(/[.!?]+$/, '').replace(/^(no |na |em |via |por )/, '').replace(/cartao (de )?/, '').replace(/\s+/g, '')
  const forma = /^\d{2}$/.test(t) && Object.values(FORMAS).includes(t) ? t : FORMAS[t]
  if (!forma || forma === '99') return null
  return { forma, descricao: null }
}

/** "frete 25; fob; transportadora 1; 10 caixas; peso 60,4" → o que mudar no estado, ou o trecho não entendido. */
export function lerTransporte(
  texto: string,
  transportadores: Transportador[],
): { frete?: number; modalidade?: ModalidadeFrete; transportador?: Transportador | { documento: string }; volume: Volume } | { erro: string } {
  const volume: Volume = {}
  const r: { frete?: number; modalidade?: ModalidadeFrete; transportador?: Transportador | { documento: string }; volume: Volume } = { volume }
  for (const parte of texto.split(/[;\n]+/).map((p) => p.trim()).filter(Boolean)) {
    const s = semAcento(parte)
    let m: RegExpExecArray | null
    if ((m = /^frete\s*(?:de\s*)?(?:r\$)?\s*([\d.,]+)$/.exec(s))) {
      const v = lerNumero(m[1], 2)
      if (v === null) return { erro: `Frete "${m[1]}" inválido.` }
      r.frete = v
    } else if ((m = /^transportadora\s+(.+)$/.exec(s))) {
      const arg = m[1].trim()
      const n = /^\d{1,2}$/.test(arg) ? transportadores[Number(arg) - 1] : null
      const doc = documentoNoTexto(parte)
      const t = n ?? (doc ? transportadores.find((x) => soDigitos(x.documento) === doc) ?? { documento: doc } : null)
      if (!t) return { erro: `Transportadora "${m[1]}": mande o número da lista ou o CNPJ/CPF.` }
      r.transportador = t
    } else if ((m = /^peso\s+(liquido|bruto)\s*(?:de\s*)?([\d.,]+)\s*(?:kg|quilos?)?$/.exec(s))) {
      const v = lerNumero(m[2], 3)
      if (v === null) return { erro: `Peso "${m[2]}" inválido (kg, até 3 casas).` }
      if (m[1] === 'liquido') volume.pesoLiquido = v
      else volume.pesoBruto = v
    } else if ((m = /^peso\s*(?:de\s*)?([\d.,]+)\s*(?:kg|quilos?)?$/.exec(s))) {
      const v = lerNumero(m[1], 3)
      if (v === null) return { erro: `Peso "${m[1]}" inválido (kg, até 3 casas).` }
      volume.pesoLiquido = v
      volume.pesoBruto = v
    } else if ((m = /^marca\s+(.+)$/i.exec(parte))) {
      volume.marca = m[1].trim().slice(0, 60)
    } else if ((m = /^numera(?:ção|cao)\s+(.+)$/i.exec(parte))) {
      volume.numeracao = m[1].trim().slice(0, 60)
    } else if ((m = /^(\d{1,9})\s+([a-zà-ú][a-zà-ú ]{1,58})$/i.exec(parte.trim()))) {
      volume.quantidade = Number(m[1])
      volume.especie = m[2].trim().toUpperCase()
    } else {
      const mod = lerModalidade(parte.replace(/^(frete\s+)?(por conta d[oa]\s+)/i, ''))
      if (!mod) return { erro: `Não entendi "${parte}".` }
      r.modalidade = mod
    }
  }
  return r
}

async function receberTransporte(ctx: Contexto, id: string, estado: EstadoNfe, texto: string): Promise<void> {
  const t = semAcento(texto).replace(/[.!?]+$/, '').trim()
  if (/^(nao|n|sem|nenhum|nada|nao tem)$/.test(t)) {
    return irParaInfo(ctx, id, { ...estado, frete: null, transportador: undefined, volumes: undefined, modalidade: undefined })
  }
  const hist = await historico(ctx, estado)
  const lido = lerTransporte(texto, hist.transportadores)
  if ('erro' in lido) return void (await responder(ctx, blocos(lido.erro, TEXTOS_NFE.transporte)))
  let transportador = lido.transportador as Transportador | undefined
  // Transportadora nova pelo CNPJ: nome, município e UF da Receita (o resto fica em branco no XML, que é opcional).
  if (transportador && !transportador.nome && soDigitos(transportador.documento).length === 14 && ctx.deps.consultaCnpj) {
    const doc = soDigitos(transportador.documento)
    const [nome, end] = await Promise.all([
      ctx.deps.consultaCnpj.razaoSocial(doc).catch(() => null),
      ctx.deps.consultaCnpj.endereco ? ctx.deps.consultaCnpj.endereco(doc).catch(() => null) : Promise.resolve(null),
    ])
    const uf = end ? ufDoIbge(end.cMun) : null
    transportador = {
      documento: doc,
      nome: nome ?? null,
      endereco: end ? `${end.logradouro}, ${end.numero || 'S/N'}${end.bairro ? ' - ' + end.bairro : ''}`.slice(0, 60) : null,
      municipio: end ? MUNICIPIOS_IBGE[end.cMun] ?? null : null,
      uf,
    }
  }
  const volume = Object.keys(lido.volume).length ? lido.volume : undefined
  const novo: EstadoNfe = {
    ...estado,
    frete: lido.frete ?? estado.frete ?? null,
    modalidade: lido.modalidade ?? estado.modalidade,
    transportador: transportador ?? estado.transportador,
    volumes: volume ? [volume] : estado.volumes,
  }
  if (novo.transportador && !novo.modalidade) {
    await salvar(ctx, id, { ...novo, passo: 'modalidade' })
    await responder(ctx, TEXTOS_NFE.modalidade)
    return
  }
  return irParaInfo(ctx, id, novo)
}

async function irParaInfo(ctx: Contexto, id: string, estado: EstadoNfe): Promise<void> {
  if (estado.info_perguntada) return mostrarResumo(ctx, id, estado)
  await salvar(ctx, id, { ...estado, passo: 'info' })
  await responder(ctx, TEXTOS_NFE.info)
}

/** O pedido do motor a partir do estado da conversa (o pagamento é um só, no valor da nota, como no painel). */
export function pedidoDoEstado(estado: EstadoNfe): PedidoNfe {
  const itens = estado.itens.map((i) => ({ ...i, frete: null }))
  if (estado.frete) ratearFrete(itens, estado.frete)
  const total = calcularTotais(itens).nota
  const forma = estado.forma ?? '17'
  return {
    destinatario: estado.destinatario!,
    itens,
    ...(estado.modalidade ? { modalidadeFrete: estado.modalidade } : {}),
    ...(estado.transportador ? { transportador: estado.transportador } : {}),
    ...(estado.volumes?.length ? { volumes: estado.volumes } : {}),
    pagamentos: [{ forma, valor: forma === '90' ? 0 : total / 100, descricao: estado.descricao_pagamento ?? null }],
    informacoesComplementares: estado.info ?? null,
  }
}

const NOME_DA_FORMA: Record<string, string> = { '01': 'dinheiro', '03': 'cartão de crédito', '04': 'cartão de débito', '15': 'boleto', '17': 'PIX', '18': 'transferência', '90': 'sem pagamento', '99': 'outros' }

async function mostrarResumo(ctx: Contexto, id: string, estado: EstadoNfe): Promise<void> {
  const pedido = pedidoDoEstado(estado)
  const dados = await empresaNfe(ctx.deps.db, estado.empresa!.id)
  const problemas = dados ? conferirPedido(dados, pedido, ctx.agora) : ['A empresa ainda não tem os dados de NF-e.']
  const t = calcularTotais(pedido.itens)
  const d = pedido.destinatario
  const vol = pedido.volumes?.[0]
  // Com CSOSN 101, o crédito e o texto como vão à nota (a frase do art. 23 da LC 123/2006 sai calculada).
  const credito = resumoCreditoSn(pedido.itens)
  const info = informacoesComplementaresDaNota(pedido.informacoesComplementares, pedido.itens)
  // Blocos do resumo: quem, os produtos, os valores e o transporte, e o que vai escrito na nota.
  const resumo = [
    `*Resumo da NF-e*${dados?.ambiente !== 'producao' ? ' (homologação, sem valor fiscal)' : ''}`,
    [
      campo('Emitente', `${estado.empresa!.razao_social} (CNPJ ${formatarDocumento(estado.empresa!.cnpj)})`),
      campo('Cliente', `${d.nome} · ${formatarDocumento(soDigitos(d.documento))}${d.inscricaoEstadual ? ` · IE ${d.inscricaoEstadual}` : d.indicadorIE === '2' ? ' · isento' : ''}`),
      `${d.endereco.logradouro}, ${d.endereco.numero}, ${d.endereco.bairro}, ${MUNICIPIOS_IBGE[d.endereco.codigoMunicipio] ?? d.endereco.codigoMunicipio}/${d.endereco.uf}`,
    ],
    [
      '*Produtos:*',
      topicos(pedido.itens.map((i) => `${linhaDoItem(i)} · NCM ${i.ncm} · CFOP ${i.cfop} · CSOSN ${i.csosn}${i.csosn === '101' ? ` (crédito ${String(i.aliquotaCreditoSN).replace('.', ',')}%)` : ''}`)),
    ],
    [
      t.desconto ? campo('Desconto', formatarReais(t.desconto / 100)) : null,
      t.frete ? campo('Frete', formatarReais(t.frete / 100)) : null,
      `*Total: ${formatarReais(t.nota / 100)}* · ${NOME_DA_FORMA[pedido.pagamentos[0].forma] ?? pedido.pagamentos[0].forma}`,
      pedido.modalidadeFrete ? campo('Frete por conta', MODALIDADES_FRETE[pedido.modalidadeFrete]) : null,
      pedido.transportador
        ? campo('Transportadora', `${pedido.transportador.nome ?? ''}${pedido.transportador.documento ? ' · ' + formatarDocumento(soDigitos(pedido.transportador.documento)) : ''}`)
        : null,
      vol
        ? campo(
            'Volumes',
            [vol.quantidade != null ? `${vol.quantidade} ${vol.especie ?? ''}`.trim() : vol.especie, vol.marca && `marca ${vol.marca}`, vol.numeracao && `nº ${vol.numeracao}`, vol.pesoLiquido != null && `líquido ${kg(vol.pesoLiquido)}`, vol.pesoBruto != null && `bruto ${kg(vol.pesoBruto)}`]
              .filter(Boolean)
              .join(' · '),
          )
        : null,
    ],
    [credito ? campo('Crédito de ICMS do Simples', credito) : null, info ? campo('Informações', info) : null],
  ]
  const avisos = avisosNfe(pedido)
  if (problemas.length) {
    await salvar(ctx, id, { ...estado, passo: 'corrigir' })
    await responder(ctx, blocos(...resumo, ['*Não dá para emitir assim:*', topicos(problemas)], TEXTOS_NFE.corrigir))
    return
  }
  await salvar(ctx, id, { ...estado, passo: 'confirmar' })
  await responder(ctx, blocos(...resumo, avisos.map((a) => `Confira: ${a}`), TEXTOS_NFE.pergunta))
}

async function corrigir(ctx: Contexto, id: string, estado: EstadoNfe, texto: string): Promise<void> {
  const t = semAcento(texto).replace(/[.!?]+$/, '').trim()
  if (/^(cliente|destinatario)/.test(t)) {
    const hist = await historico(ctx, estado)
    const clientes = hist.destinatarios.slice(0, MAX_CLIENTES_NA_LISTA)
    await salvar(ctx, id, { ...estado, passo: 'destinatario', opcoes: clientes.map((d) => d.documento) })
    await responder(ctx, blocos(['Mande o CPF/CNPJ do cliente, ou o número:', ...clientes.map((d, i) => `${i + 1}. ${d.nome} · ${formatarDocumento(soDigitos(d.documento))}`)]))
    return
  }
  if (/^(produto|itens|item)/.test(t)) {
    await salvar(ctx, id, { ...estado, itens: [], passo: 'itens' })
    await responder(ctx, blocos('Apaguei os produtos desta nota.', await textoDosProdutos(ctx, estado)))
    return
  }
  if (/^(pagamento|forma)/.test(t)) {
    await salvar(ctx, id, { ...estado, forma: undefined, passo: 'pagamento' })
    await responder(ctx, TEXTOS_NFE.pagamento)
    return
  }
  if (/^(transporte|frete|transportadora|volume|peso)/.test(t)) {
    await salvar(ctx, id, { ...estado, frete: null, transportador: undefined, volumes: undefined, modalidade: undefined, passo: 'transporte' })
    await responder(ctx, TEXTOS_NFE.transporte)
    return
  }
  if (/^(informac|info|observac)/.test(t)) {
    await salvar(ctx, id, { ...estado, info_perguntada: false, passo: 'info' })
    await responder(ctx, TEXTOS_NFE.info)
    return
  }
  if (ehConfirmarEmissao(texto)) return mostrarResumo(ctx, id, estado)
  await responder(ctx, TEXTOS_NFE.corrigir)
}

async function emitir(ctx: Contexto, id: string, estado: EstadoNfe): Promise<void> {
  const pedido = pedidoDoEstado(estado)
  const r = await criarNfe(ctx.deps.db, { tenantId: estado.empresa!.id, externalId: `whatsapp:${id}`, origem: 'whatsapp', pedido, agora: ctx.agora })
  if (!r.ok) {
    const motivo = r.codigo === 'BLOQUEADA' ? `${estado.empresa!.razao_social} não emite NF-e agora: ${motivoDoBloqueio(r.bloqueio)}.` : r.problemas.join(' ')
    await salvar(ctx, id, { ...estado, passo: 'corrigir' })
    await responder(ctx, blocos(`Não deu para emitir: ${motivo}`, TEXTOS_NFE.corrigir))

    return
  }
  await encerrar(ctx, id, 'confirmed', { ...estado, nfe_id: r.nfeId })
  logEvent('agente.nfe_pedida', { tenant_id: estado.empresa!.id, nfe_id: r.nfeId, ja_existia: r.jaExistia })
  await responder(ctx, `NF-e nº ${r.numero} (série ${r.serie}) enviada à Sefaz. Quando for autorizada, mando o DANFE aqui.`)
}

// ---------- retorno da Sefaz ----------

/**
 * A NF-e pedida pelo WhatsApp chegou a um estado final: autorizada, o DANFE vai a quem pediu; rejeitada ou denegada,
 * o motivo. Outras origens não têm conversa: nada a fazer. Chamado pelo worker (onFinal da fila da NF-e).
 */
export async function avisarNfeDoWhatsApp(
  db: Queryable,
  whatsapp: EnviaWhatsApp,
  nfeId: string,
  status: 'authorized' | 'denied' | 'rejected' | 'cancelled',
): Promise<boolean> {
  if (status === 'cancelled') return false
  const { rows } = await db.query<{ phone_e164: string; numero: string; serie: number; chave: string | null; xml_proc: string | null; destinatario_nome: string; valor_total: string; last_error: string | null; last_error_code: string | null }>(
    `select p.phone_e164, n.numero, n.serie, n.chave, n.xml_proc, n.destinatario_nome, n.valor_total, n.last_error, n.last_error_code
       from nofiscal.fiscal_nfe n
       join nofiscal.fiscal_requests r on r.id::text = substr(n.external_id, 10) and r.kind = 'emitir_nfe'
       join nofiscal.fiscal_phones p on p.id = r.phone_id
      where n.id = $1 and n.origem = 'whatsapp' and n.external_id like 'whatsapp:%'`,
    [nfeId],
  )
  const n = rows[0]
  if (!n) return false
  try {
    if (status === 'authorized' && n.xml_proc) {
      const pdf = await renderDanfe(n.xml_proc)
      const legenda = `NF-e ${n.numero} autorizada · ${n.destinatario_nome} · ${formatarReais(n.valor_total)}${n.chave ? `${QUEBRA}Chave: ${formatarChave(n.chave)}` : ''}`
      await whatsapp.enviarDocumento(n.phone_e164, { nome: `danfe-${n.numero}.pdf`, tipo: 'application/pdf', conteudo: pdf }, legenda)
    } else {
      const motivo = n.last_error ? `${n.last_error_code ? n.last_error_code + ' ' : ''}${n.last_error}` : 'sem motivo informado'
      await whatsapp.enviarTexto(
        n.phone_e164,
        blocos(
          `A Sefaz ${status === 'denied' ? 'denegou' : 'rejeitou'} a NF-e ${n.numero} (série ${n.serie}) para ${n.destinatario_nome}: ${motivo}.`,
          'Corrija e mande *nfe* de novo; o número pode ser inutilizado em Minha conta → NF-e.',
        ),

      )
    }
    logEvent('agente.nfe_avisada', { nfe_id: nfeId, status })
    return true
  } catch (error) {
    logEvent('agente.nfe_aviso_falhou', { nfe_id: nfeId, status, error_name: error instanceof Error ? error.name : 'unknown' })
    return false
  }
}
