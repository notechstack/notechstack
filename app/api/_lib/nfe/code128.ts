// Código de barras Code 128 subconjunto C (pares de dígitos), o que o DANFE usa para a chave de acesso de 44 dígitos
// (Manual de Orientação do Contribuinte, Anexo II). Devolve as larguras alternadas barra/espaço em módulos.

/** Padrões 0–105 (barra, espaço, barra, espaço, barra, espaço); cada um soma 11 módulos. */
export const PADROES = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
] as const
export const START_C = 105
/** Parada: 7 elementos, 13 módulos. */
export const STOP = '2331112'

/** Valores do símbolo (início C, pares, verificador) para uma sequência par de dígitos. */
export function simbolosCode128C(digitos: string): number[] {
  if (!/^(\d\d)+$/.test(digitos)) throw new Error('Code 128C precisa de uma quantidade par de dígitos')
  const pares = digitos.match(/\d\d/g)!.map(Number)
  const soma = pares.reduce((s, v, i) => s + v * (i + 1), START_C)
  return [START_C, ...pares, soma % 103]
}

/** Larguras em módulos, começando por barra. */
export function modulosCode128C(digitos: string): number[] {
  const padroes = simbolosCode128C(digitos).map((v) => PADROES[v] as string)
  return [...padroes, STOP].join('').split('').map(Number)
}
