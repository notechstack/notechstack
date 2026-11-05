// Famílias de plano vistas pelo agente, as mesmas de `nofiscal.plano_completo` e `nofiscal.plano_de_escritorio`
// (migration 20261105180000_agente_fiscal_escritorio.sql): o Escritório tem tudo o que o Pro tem (contador,
// resumo, cópia ao tomador) e, além disso, várias empresas e o lote por planilha.
export const PLANOS_DE_ESCRITORIO = ['escritorio_5', 'escritorio_20', 'escritorio_50'] as const

export const planoDeEscritorio = (plano: string | null | undefined): boolean =>
  (PLANOS_DE_ESCRITORIO as readonly string[]).includes(plano ?? '')

/** Modelo da planilha do lote (Planilha v1), publicado com o site. */
export const MODELO_DA_PLANILHA = 'https://www.notechstack.com.br/agentes/fiscal/dados/modelo-lote.csv'

/** Comando *nota* (ver-nota.ts), citado na ajuda, nas boas-vindas do Escritório e no aviso do retorno do lote. */
export const TEXTO_VER_NOTA = 'Para ver uma nota aqui, escreva *nota* e o número ou o nome do cliente (ex.: nota 123, nota Maria Silva).'

/** Linha a mais nas boas-vindas do Escritório (ativação e "Pronto!"). */
export const LINHA_DA_PLANILHA = `Pra emitir as notas do mês de uma vez, mande a planilha aqui (modelo: ${MODELO_DA_PLANILHA}). ${TEXTO_VER_NOTA}`

/** Nome do plano para a pessoa ler. */
export const nomeDoPlano = (plano: string | null | undefined): string =>
  planoDeEscritorio(plano) ? 'Escritório' : plano === 'pro' ? 'Pro' : 'Inicial'

/** Pro ou Escritório: contador, resumo periódico e cópia da nota ao tomador. */
export const planoCompleto = (plano: string | null | undefined): boolean => plano === 'pro' || planoDeEscritorio(plano)
