// Leitura do PDF nos testes: o pdf-lib grava o texto das fontes padrão em strings hexadecimais
// (`<...> Tj`) dentro de content streams comprimidos com Flate. Aqui eles são descomprimidos e
// decodificados (WinAnsi ≈ latin1 para as letras do português).
import { inflateSync } from 'node:zlib'

export function pdfStreams(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf)
  const out: string[] = []
  let from = 0
  for (;;) {
    const start = raw.indexOf('stream', from, 'latin1')
    if (start < 0) break
    let dataStart = start + 'stream'.length
    if (raw[dataStart] === 0x0d) dataStart++
    if (raw[dataStart] === 0x0a) dataStart++
    const end = raw.indexOf('endstream', dataStart, 'latin1')
    if (end < 0) break
    const chunk = raw.subarray(dataStart, end)
    try {
      out.push(inflateSync(chunk).toString('latin1'))
    } catch {
      out.push(chunk.toString('latin1'))
    }
    from = end + 'endstream'.length
  }
  return out
}

/** Todos os textos desenhados, um por operação `Tj`, na ordem em que aparecem. */
export function pdfTexts(pdf: Uint8Array): string[] {
  const texts: string[] = []
  for (const stream of pdfStreams(pdf)) {
    for (const match of stream.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
      texts.push(Buffer.from(match[1], 'hex').toString('latin1'))
    }
  }
  return texts
}
