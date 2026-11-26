// Famílias de plano vistas pelo agente, as mesmas de `nofiscal.plano_completo` e `nofiscal.plano_de_escritorio`
// (migration 20261105180000_agente_fiscal_escritorio.sql): o Escritório tem tudo o que o Pro tem (contador,
// resumo, cópia ao tomador) e, além disso, várias empresas e o lote por planilha.
// Faixas por volume (23/11/2026): 500, 1.000, 2.000, 5.000 e 10.000 documentos por mês, empresas ilimitadas.
export const PLANOS_DE_ESCRITORIO = ['escritorio_5', 'escritorio_1000', 'escritorio_20', 'escritorio_50', 'escritorio_10000'] as const

export const planoDeEscritorio = (plano: string | null | undefined): boolean =>
  (PLANOS_DE_ESCRITORIO as readonly string[]).includes(plano ?? '')

/**
 * Modelo de emissão por planilha, publicado com o site: .xlsx com a aba Notas (Planilha v1) e a aba Como preencher
 * (16/11/2026). O agente também manda o arquivo no WhatsApp (modelo-emissao.ts). Os `modelo-lote.csv` e `.xlsx`
 * continuam no ar para os links antigos.
 */
export const MODELO_DA_PLANILHA = 'https://www.notechstack.com.br/agentes/fiscal/dados/modelo-emissao.xlsx'

/** Comando *nota* (ver-nota.ts), citado na ajuda, nas boas-vindas do Escritório e no aviso do retorno do lote. */
export const TEXTO_VER_NOTA = 'Para ver uma nota aqui, escreva *nota* e o número ou o nome do cliente (ex.: nota 123, nota Maria Silva).'

/** Linha a mais nas boas-vindas do Escritório (ativação e "Pronto!"). */
export const LINHA_DA_PLANILHA = `Pra emitir as notas do mês de uma vez, mande a planilha aqui (modelo: ${MODELO_DA_PLANILHA}). ${TEXTO_VER_NOTA}`

/** Nome do plano para a pessoa ler. */
export const nomeDoPlano = (plano: string | null | undefined): string =>
  planoDeEscritorio(plano) ? 'Escritório' : plano === 'pro' ? 'Pro' : 'Inicial'

/** Pro ou Escritório: contador, resumo periódico e cópia da nota ao tomador. */
export const planoCompleto = (plano: string | null | undefined): boolean => plano === 'pro' || planoDeEscritorio(plano)
