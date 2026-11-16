// Modelo de emissão por planilha (Lucca, 16/11/2026): quem pergunta "qual é o modelo da planilha?" recebe o arquivo
// .xlsx no próprio WhatsApp, e não só o link. Lido por código, sem a IA, antes do intérprete (como o comando *nota*).
// Só na conta Escritório, que é quem emite por planilha; nas outras a mensagem segue para a conversa de pedidos.
// O arquivo é o mesmo publicado no site (agentes/fiscal/dados/modelo-emissao.xlsx), guardado em base64 em
// modelo-emissao-arquivo.ts pelo gerador (scripts/nofiscal-modelo-emissao/gerar.py). Se o envio falhar, vai o link.
import { logEvent } from '../log.js'
import { saiuComRetentativa } from './canais.js'
import { responder, semAcento, type Contexto } from './conversa.js'
import { MODELO_EMISSAO_BASE64 } from './modelo-emissao-arquivo.js'
import { MODELO_DA_PLANILHA, planoDeEscritorio } from './planos.js'

export const NOME_DO_MODELO = 'modelo-emissao-nofiscal.xlsx'
export const MIME_DO_MODELO = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export const TEXTOS_DO_MODELO = {
  legenda:
    'Este é o modelo. Preencha a aba Notas, uma linha por nota (apague os exemplos), e me mande o arquivo aqui. Nada é emitido antes do seu *confirmar*.',
  link: `O modelo da planilha está aqui: ${MODELO_DA_PLANILHA}\nPreencha a aba Notas, uma linha por nota (apague os exemplos), e me mande o arquivo aqui. Nada é emitido antes do seu *confirmar*.`,
} as const

export const modeloDeEmissao = (): Uint8Array => new Uint8Array(Buffer.from(MODELO_EMISSAO_BASE64, 'base64'))

const SOBRE_O_MODELO = /\b(modelo|modelos|exemplo|template|padrao|formato)\b/
const SOBRE_A_PLANILHA = /\b(planilha|planilhas|tabela|excel|xlsx|lote)\b/
/** A mensagem inteira é o pedido do modelo, sem citar planilha ("modelo", "me manda o modelo", "qual o modelo?"). */
const SO_O_MODELO = /^(?:(?:me |nos )?(?:manda|mande|envia|envie|passa|passe|quero|preciso d[oe]|cade|qual(?: e)?|tem)\s+)?(?:o |um |algum )?modelo(?: de emissao| da emissao| pra emitir| para emitir)?$/

/**
 * `true` quando a mensagem pede o modelo da planilha. Para não roubar pedido de nota (o cliente salvo também se chama
 * "modelo"), não vale mensagem com algarismo, com mais de 80 caracteres ou que comece por "nota".
 */
export function ehPedidoDeModelo(texto: string): boolean {
  const limpo = semAcento(texto)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!limpo || limpo.length > 80 || /\d/.test(limpo) || /^nota\b/.test(limpo)) return false
  return SO_O_MODELO.test(limpo) || (SOBRE_O_MODELO.test(limpo) && SOBRE_A_PLANILHA.test(limpo))
}

/** `true` quando a mensagem era o pedido do modelo e foi respondida; `false` segue para a conversa de pedidos. */
export async function tratarPedidoDeModelo(ctx: Contexto, texto: string): Promise<boolean> {
  if (!ehPedidoDeModelo(texto)) return false
  const { rows } = await ctx.deps.db.query<{ plan: string }>('select plan from nofiscal.fiscal_tenants where id = $1', [ctx.tenantId])
  if (!planoDeEscritorio(rows[0]?.plan)) return false
  const whatsapp = ctx.whatsappBruto ?? ctx.whatsapp
  const anexo = { nome: NOME_DO_MODELO, tipo: MIME_DO_MODELO, conteudo: modeloDeEmissao() }
  const enviado = await saiuComRetentativa('whatsapp', () => whatsapp.enviarDocumento(ctx.para, anexo, TEXTOS_DO_MODELO.legenda))
  logEvent('agente.modelo_enviado', { tenant_id: ctx.tenantId, enviado })
  if (enviado) ctx.enviadas++
  else await responder(ctx, TEXTOS_DO_MODELO.link)
  return true
}
