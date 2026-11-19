// Texto de um PDF (módulo Guias, critério 9): as guias da Receita e os boletos saem com texto selecionável. Usa o
// pdfjs-dist (build legacy, que roda no Node da Vercel) com o worker no mesmo processo, sem fonte do sistema, sem
// eval e sem rede. PDF que não abre ou sem texto (imagem escaneada) devolve '' e a leitura cai na IA de reserva.
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let carregado: Promise<PdfJs> | null = null

function pdfjs(): Promise<PdfJs> {
  carregado ??= (async () => {
    // O worker importado aqui fica em globalThis.pdfjsWorker: o pdfjs usa o do processo e o empacotador da Vercel
    // enxerga o arquivo (sem import dinâmico por caminho).
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
    return import('pdfjs-dist/legacy/build/pdf.mjs')
  })()
  return carregado
}

/** Até 10 páginas (uma guia tem 1 ou 2): o resto é ignorado. */
export const MAX_PAGINAS = 10

export async function textoDoPdf(pdf: Uint8Array): Promise<string> {
  const lib = await pdfjs()
  let doc: Awaited<ReturnType<PdfJs['getDocument']>['promise']> | null = null
  try {
    doc = await lib.getDocument({
      data: new Uint8Array(pdf),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise
    const linhas: string[] = []
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGINAS); n++) {
      const pagina = await doc.getPage(n)
      const conteudo = await pagina.getTextContent()
      let linha = ''
      for (const item of conteudo.items) {
        if (!('str' in item)) continue
        linha += item.str
        if (item.hasEOL) {
          linhas.push(linha)
          linha = ''
        } else linha += ' '
      }
      if (linha.trim()) linhas.push(linha)
    }
    return linhas
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  } finally {
    await doc?.destroy().catch(() => undefined)
  }
}
