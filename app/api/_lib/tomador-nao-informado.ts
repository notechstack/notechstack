// NFS-e com "Tomador/Adquirente não informado" (Robson, Contabilidade Bragantina, 27/11/2026): consumidor que não se
// identifica (clínica, salão, academia). O portal nacional já oferece; a nó passa a oferecer nos quatro canais.
//
// Leiaute (pesquisa de 27/11/2026; fontes em side-session-notes/…/tomador-nao-informado-fontes.md):
// - `infDPS/toma` é 0-1 nos três XSD (produção 20260209, produção restrita 20261020 e 20261124). Sem ele, a DPS sai
//   sem o grupo inteiro; nada de CPF/CNPJ vazio, nome genérico ou o CNPJ da própria empresa (E0202).
// - E0204 (Anexo I, produção e release 2): ISS retido pelo tomador (`tpRetISSQN 2`) exige o tomador com CPF ou CNPJ.
//   Retenções federais (INSS, IRRF, PIS/COFINS/CSLL) são feitas pelo tomador: sem ele, não há quem retenha.
// - E0234/E1321 (produção): 17.05.01 (fornecimento de mão de obra) tem incidência no estabelecimento do tomador e exige
//   o endereço dele. Sem tomador, a nota não sai.
// - E0187 (produção, só com IBSCBS) e E0243 (release 2): cIndOp com local no endereço do destinatário exige o tomador.
//   O dps-builder não manda o grupo IBSCBS (opcional em 2026) sem tomador; a locação, que exige o grupo, exige o tomador.
// - Release 2 (indDest 1-1 em infDPS): sem tomador, `indDest 0` e sem `dest` (E0908; com 1, E0910 exigiria `dest`).
// - DANFSe (NT 008): o quadro do tomador traz "TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e".
//
// No payload do motor, a marca é explícita: `tomador_nao_informado: true` e nenhum `tomador`. Payload sem os dois é
// recusado: ninguém emite sem tomador por esquecimento.

/** O nome que a planilha usa na coluna `nome_tomador` (com `cpf_cnpj_tomador` vazio). */
export const NOME_TOMADOR_NAO_INFORMADO = 'NAO INFORMADO'

/** Como o resumo, o painel e o DANFSe chamam a nota sem tomador. */
export const ROTULO_TOMADOR_NAO_INFORMADO = 'não informado (consumidor não identificado)'

/** Códigos que a Sefin recusa sem tomador: incidência do ISS no estabelecimento do tomador (E0234, E1321). */
export const CODIGOS_QUE_EXIGEM_TOMADOR: readonly string[] = ['170501']

export const MOTIVO_CODIGO_EXIGE_TOMADOR =
  'o serviço 17.05.01 (fornecimento de mão de obra) tem o ISS devido no endereço do tomador, e a Sefin exige o tomador identificado'

export const MOTIVO_RETENCAO_SEM_TOMADOR =
  'nota sem tomador não tem retenção: quem retém ISS, INSS, IRRF ou PIS/COFINS/CSLL é o tomador, e a Sefin exige o CPF ou CNPJ dele (E0204)'

const semAcento = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/**
 * O texto diz que a nota é sem tomador? "consumidor não identificado", "sem tomador", "consumidor final", "cliente não
 * informado", "tomador não informado", "NAO INFORMADO" (planilha). Vale para o nome do tomador e para a mensagem inteira.
 */
export function marcaSemTomador(texto: string | null | undefined): boolean {
  if (!texto) return false
  const t = semAcento(texto).replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return false
  // Só a marca, como na planilha ("NAO INFORMADO", "não identificado", "consumidor").
  if (/^(tomador |cliente |consumidor |adquirente )?(nao informado|nao identificado|sem identificacao)$/.test(t)) return true
  if (/^consumidor( final)?$/.test(t) || /^consumidores diversos$/.test(t) || /^sem tomador$/.test(t)) return true
  return (
    /\bsem (o )?(tomador|adquirente)\b/.test(t) ||
    /\b(tomador|adquirente|cliente|consumidor)(\/adquirente)? (nao informado|nao identificado|sem identificacao|anonimo)\b/.test(t) ||
    /\bconsumidor(es)? (final|finais|diversos)\b/.test(t) ||
    /\bsem (cpf|cnpj|cpf ou cnpj|documento) (do|de) (tomador|cliente|consumidor)\b/.test(t)
  )
}

/** A nota sem tomador pode sair com este código? `null` = pode; senão, o motivo. */
export function problemaDoCodigoSemTomador(codigo: string | null | undefined): string | null {
  return codigo && CODIGOS_QUE_EXIGEM_TOMADOR.includes(codigo) ? MOTIVO_CODIGO_EXIGE_TOMADOR : null
}
