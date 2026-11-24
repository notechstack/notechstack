// Negrito (*assim*) e itálico (_assim_) do WhatsApp na Central de Conversas (Lucca, 24/11/2026). Só lê o texto e o
// divide em trechos; quem desenha é o React (<strong>, <em>), sem HTML montado a partir do texto. O texto guardado
// não muda.
//
// A regra é a do WhatsApp: a marca abre no começo da linha ou depois de algo que não é letra nem número, fecha antes
// do fim, de um espaço ou de pontuação, e não encosta em espaço por dentro. Assim `codigo_servico` e `2 * 3` ficam como
// estão. Não atravessa quebra de linha.

export type Trecho = { texto: string; negrito: boolean; italico: boolean }

const MARCA = /(^|[^\p{L}\p{N}*_])([*_])(?=[^\s*_])([^\n]*?[^\s])\2(?=$|[^\p{L}\p{N}*_])/u

function ler(texto: string, negrito: boolean, italico: boolean, saida: Trecho[]): void {
  let resto = texto
  while (resto) {
    const m = MARCA.exec(resto)
    if (!m) {
      saida.push({ texto: resto, negrito, italico })
      return
    }
    const inicio = m.index + m[1].length
    if (inicio > 0) saida.push({ texto: resto.slice(0, inicio), negrito, italico })
    const ehNegrito = m[2] === '*'
    ler(m[3], negrito || ehNegrito, italico || !ehNegrito, saida)
    resto = resto.slice(inicio + m[2].length * 2 + m[3].length)
  }
}

/** O texto em trechos com o estilo de cada um; trechos vizinhos de mesmo estilo saem juntos. */
export function trechosDoWhatsApp(texto: string): Trecho[] {
  const brutos: Trecho[] = []
  ler(texto, false, false, brutos)
  const trechos: Trecho[] = []
  for (const t of brutos) {
    const ultimo = trechos[trechos.length - 1]
    if (ultimo && ultimo.negrito === t.negrito && ultimo.italico === t.italico) ultimo.texto += t.texto
    else trechos.push({ ...t })
  }
  return trechos
}
