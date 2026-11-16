// Emitente do pedido por mensagem na conta Escritório (Lucca, 16/11/2026; .design/agente-fiscal-emitente-por-mensagem.md).
// O telefone é da conta-mãe, mas a nota pode sair por qualquer empresa ativa dela: "nota pela Oficina Trilho pra
// Clínica Saúde, 450". A IA só lê o nome ou o CNPJ como a pessoa escreveu (`parsed.prestador`); quem acha a empresa é
// este código, sobre as empresas ativas da conta (`empresasDoDono`), com o mesmo critério do comando *nota*: CNPJ de
// 14 dígitos ou parte do nome, sem acento. Na dúvida (nenhuma, várias ou nada escrito), a conversa pergunta.
// Conta que não é Escritório, ou com uma empresa ativa só, não tem escolha: emite pela empresa do telefone, como antes.
import type { Queryable } from '../db.js'
import { formatarDocumento } from './documentos.js'
import { empresasDoDono } from './lote.js'
import { planoDeEscritorio } from './planos.js'

export type EmpresaDaConta = { id: string; cnpj: string; razao_social: string; principal: boolean }

/** Acima disto a pergunta não lista as empresas: pede o nome ou o CNPJ. */
export const MAX_EMPRESAS_NA_PERGUNTA = 10

const semAcento = (texto: string) =>
  texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()

/**
 * As empresas ativas entre as quais o pedido escolhe (a do escritório primeiro, depois por razão social). Vazio
 * quando não há escolha: conta que não é Escritório, ou Escritório com uma empresa ativa só.
 */
export async function empresasParaEscolher(db: Queryable, tenantId: string): Promise<EmpresaDaConta[]> {
  const { rows } = await db.query<{ plan: string }>('select plan from nofiscal.fiscal_tenants where id = $1', [tenantId])
  if (!planoDeEscritorio(rows[0]?.plan)) return []
  const ativas = (await empresasDoDono(db, tenantId)).filter((e) => e.active)
  if (ativas.length < 2) return []
  return ativas.map((e) => ({ id: e.id, cnpj: e.cnpj, razao_social: e.razao_social, principal: e.id === tenantId }))
}

/**
 * Todas as empresas da conta Escritório, ativas ou não (a do escritório primeiro): onde procurar uma nota já emitida,
 * para cancelar. Vazio quando a conta não é Escritório: aí só existe a empresa do telefone.
 */
export async function empresasDaConta(db: Queryable, tenantId: string): Promise<EmpresaDaConta[]> {
  const { rows } = await db.query<{ plan: string }>('select plan from nofiscal.fiscal_tenants where id = $1', [tenantId])
  if (!planoDeEscritorio(rows[0]?.plan)) return []
  return (await empresasDoDono(db, tenantId)).map((e) => ({ id: e.id, cnpj: e.cnpj, razao_social: e.razao_social, principal: e.id === tenantId }))
}

/** "pela Oficina Trilho", "da empresa Studio Lima", "emitente: X" → só o nome. */
const semPrefixo = (texto: string) =>
  texto
    .replace(/^(emitente|prestador|empresa)\s*[:-]?\s*/i, '')
    .replace(/^(pel[ao]s?|d[aeo]s?|em nome d[aeo]|n[ao])\s+/i, '')
    .replace(/^(empresa|cliente)\s+/i, '')
    .trim()

const EH_O_ESCRITORIO = /^(o |a |meu |minha |nosso |nossa |proprio |propria )*(escritorio|conta mae|contabilidade|minha empresa|nossa empresa|propria empresa)$/

/**
 * As empresas que batem com o que a pessoa escreveu: CNPJ (14 dígitos), "escritório" (a empresa do telefone) ou parte
 * do nome sem acento. Um nome igual à razão social inteira vence os que só a contêm.
 */
export function empresasQueBatem(empresas: EmpresaDaConta[], escrito: string): EmpresaDaConta[] {
  const digitos = escrito.replace(/\D/g, '')
  if (digitos.length === 14) return empresas.filter((e) => e.cnpj === digitos)
  const nome = semAcento(semPrefixo(escrito)).replace(/[.,;!?]+$/g, '').replace(/\s+/g, ' ')
  if (nome.length < 2) return []
  if (EH_O_ESCRITORIO.test(nome)) return empresas.filter((e) => e.principal)
  const exatas = empresas.filter((e) => semAcento(e.razao_social) === nome)
  if (exatas.length) return exatas
  return empresas.filter((e) => semAcento(e.razao_social).includes(nome))
}

/**
 * A resposta à pergunta "Por qual empresa sai a nota?": o número da lista mostrada (`opcoes`, na ordem), ou o nome,
 * o CNPJ ou "escritório".
 */
export function empresasDaResposta(empresas: EmpresaDaConta[], opcoes: string[], texto: string): EmpresaDaConta[] {
  const limpo = texto.trim().replace(/[.!?]+$/, '')
  const numero = /^(?:n[º°o]?\.?\s*|numero\s+|opcao\s+)?(\d{1,2})$/i.exec(semAcento(limpo))
  if (numero && opcoes.length) {
    const escolhida = empresas.find((e) => e.id === opcoes[Number(numero[1]) - 1])
    return escolhida ? [escolhida] : []
  }
  return empresasQueBatem(empresas, limpo)
}

const nomeNaLista = (e: EmpresaDaConta) => `${e.razao_social}${e.principal ? ' (escritório)' : ''}`

/**
 * A pergunta e as empresas listadas nela (ids, na ordem dos números). `candidatas` = as que bateram com o que a
 * pessoa escreveu (mais de uma); sem elas, a lista é a conta inteira, até `MAX_EMPRESAS_NA_PERGUNTA`.
 */
export function perguntaDoEmitente(empresas: EmpresaDaConta[], opcoes: { candidatas?: EmpresaDaConta[]; naoAchei?: string } = {}): { texto: string; opcoes: string[] } {
  const lista = opcoes.candidatas?.length ? opcoes.candidatas : empresas
  const cabe = lista.length <= MAX_EMPRESAS_NA_PERGUNTA
  const linhas = [
    opcoes.naoAchei
      ? `Não achei "${opcoes.naoAchei}" entre as empresas ativas de Minhas empresas.`
      : opcoes.candidatas?.length
        ? 'Achei mais de uma empresa com esse nome.'
        : null,
    cabe ? 'Por qual empresa sai a nota? Me mande o número, o nome ou o CNPJ.' : 'Por qual empresa sai a nota? Me mande o nome ou o CNPJ dela.',
    ...(cabe ? lista.map((e, i) => `${i + 1}. ${nomeNaLista(e)}`) : []),
  ].filter(Boolean)
  return { texto: linhas.join('\n'), opcoes: cabe ? lista.map((e) => e.id) : [] }
}

export type EmitenteDoPedido = { id: string; razao_social: string; cnpj: string }

export const linhaDoEmitente = (e: EmitenteDoPedido) => `Emitente: ${e.razao_social} (CNPJ ${formatarDocumento(e.cnpj)})`
