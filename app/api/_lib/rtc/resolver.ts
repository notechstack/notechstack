// NBS e classificação do IBS/CBS de um serviço (Reforma Tributária do Consumo, NFS-e Nacional).
// O que vem da nota (payload) manda; o que falta sai do Anexo VIII só quando a planilha não deixa
// dúvida. Pesquisa e fontes: relatório da sessão de 17/11/2026 (leiaute de produção 09/02/2026 e
// produção restrita 20/10/2026; Anexo VIII v1.02.00 de 26/10/2026, sem regra de negócio na Sefin).
import { TABELA_RTC } from './servicos-rtc.js'
import type { ServicoRtc } from './tipos.js'

const NBS_VALIDAS = new Set(TABELA_RTC.nbs_validas)

/** NBS existe na lista nacional (Anexo B, aba LISTA.NBS_v2.0)? A Sefin recusa a que não existe (E0316). */
export const nbsExiste = (nbs: string): boolean => NBS_VALIDAS.has(nbs)

export const candidatosRtc = (cTribNac: string): ServicoRtc | null => TABELA_RTC.servicos[cTribNac] ?? null

export type InformadoRtc = {
  nbs: string | null
  cIndOp: string | null
  cClassTrib: string | null
  /** NBS padrão da empresa (`fiscal_tenants.nbs_padrao`): abaixo da nota, acima da tabela. */
  nbsEmpresa?: string | null
}

export type Rtc = {
  /** De onde veio a NBS: da nota, do padrão da empresa ou da tabela (uma NBS só para o código). */
  nbs: { codigo: string; origem: 'nota' | 'empresa' | 'tabela' } | null
  /** Grupo IBSCBS completo, ou o motivo de não dar para montá-lo. */
  ibscbs: { cIndOp: string; cst: string; cClassTrib: string } | { falta: string }
}

const unico = (lista: string[]): string | null => (lista.length === 1 ? lista[0] : null)

/**
 * cClassTrib sugerido: o único da linha, ou `000001` (tributação integral) quando ele está entre as
 * opções. Os demais (reduções, regimes específicos) dependem de condições que o motor não conhece:
 * esses vêm informados na nota.
 */
function classTribPadrao(lista: string[]): string | null {
  return unico(lista) ?? (lista.includes('000001') ? '000001' : null)
}

export function resolverRtc(cTribNac: string, informado: InformadoRtc): Rtc {
  const linha = candidatosRtc(cTribNac)
  const nbsTabela = linha ? unico(linha.nbs) : null
  const nbs = informado.nbs
    ? { codigo: informado.nbs, origem: 'nota' as const }
    : informado.nbsEmpresa
      ? { codigo: informado.nbsEmpresa, origem: 'empresa' as const }
      : nbsTabela
        ? { codigo: nbsTabela, origem: 'tabela' as const }
        : null
  const cIndOp = informado.cIndOp ?? (linha ? unico(linha.cIndOp) : null)
  const cClassTrib = informado.cClassTrib ?? (linha ? classTribPadrao(linha.cClassTrib) : null)
  const faltas = [!nbs && 'NBS', !cIndOp && 'cIndOp', !cClassTrib && 'cClassTrib'].filter(Boolean)
  return {
    nbs,
    ibscbs:
      faltas.length > 0 || !cIndOp || !cClassTrib
        ? { falta: faltas.join(', ') }
        : // O CST são os três primeiros dígitos do cClassTrib (tabela de cClassTrib da RTC).
          { cIndOp, cst: cClassTrib.slice(0, 3), cClassTrib },
  }
}
