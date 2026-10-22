// Datas do agente no horário de São Paulo (Unresolved 13: avisos a partir das 09:00).
export const FUSO = 'America/Sao_Paulo'
export const HORA_DOS_AVISOS = 9

type Partes = { ano: number; mes: number; dia: number; hora: number }

export function partesLocais(instante: Date): Partes {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: FUSO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instante)
      .map((p) => [p.type, p.value]),
  )
  return { ano: Number(partes.year), mes: Number(partes.month), dia: Number(partes.day), hora: Number(partes.hour) }
}

const dois = (n: number) => String(n).padStart(2, '0')

/** `aaaa-mm-dd` local. */
export function diaLocal(instante: Date): string {
  const p = partesLocais(instante)
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}`
}

/** `aaaa-mm` local. */
export function mesLocal(instante: Date): string {
  const p = partesLocais(instante)
  return `${p.ano}-${dois(p.mes)}`
}

/** `dd/mm/aaaa` local. */
export function dataBr(instante: Date): string {
  const p = partesLocais(instante)
  return `${dois(p.dia)}/${dois(p.mes)}/${p.ano}`
}

export const horaDosAvisos = (instante: Date) => partesLocais(instante).hora >= HORA_DOS_AVISOS

/** Início (inclusivo) e fim (exclusivo) de um mês local, como instantes. São Paulo não tem horário de verão desde 2019. */
export function limitesDoMes(ano: number, mes: number): { inicio: Date; fim: Date } {
  const proximo = mes === 12 ? { ano: ano + 1, mes: 1 } : { ano, mes: mes + 1 }
  return {
    inicio: new Date(`${ano}-${dois(mes)}-01T00:00:00-03:00`),
    fim: new Date(`${proximo.ano}-${dois(proximo.mes)}-01T00:00:00-03:00`),
  }
}

export const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const
