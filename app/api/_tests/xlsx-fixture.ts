// .xlsx mínimo para os testes do lote por planilha (e para gerar agentes/fiscal/dados/modelo-lote.xlsx):
// um zip com o workbook, as abas e as strings compartilhadas, montado com o fflate. Célula de fórmula leva a
// fórmula e o valor guardado (`<f>` + `<v>`), como o Excel grava.
import { strToU8, zipSync } from 'fflate'

export type CelulaXlsx = string | number | null | { formula: string; valor: number | string }

const coluna = (i: number) => {
  let nome = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) nome = String.fromCharCode(65 + ((n - 1) % 26)) + nome
  return nome
}
const xml = (texto: string) => texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `dimensao` e `celulaSolta`: para o teste da célula distante (ZZ30000, XFD1048576). */
export type Aba = { nome: string; linhas: CelulaXlsx[][]; dimensao?: string; celulaSolta?: { ref: string; valor: string } }

function aba({ linhas, dimensao, celulaSolta }: Aba, strings: string[]): string {
  const indice = (s: string) => {
    const i = strings.indexOf(s)
    if (i >= 0) return i
    strings.push(s)
    return strings.length - 1
  }
  const corpo = linhas
    .map((linha, r) => {
      const celulas = linha
        .map((c, i) => {
          const ref = `${coluna(i)}${r + 1}`
          if (c === null || c === '') return ''
          if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`
          if (typeof c === 'string') return `<c r="${ref}" t="s"><v>${indice(c)}</v></c>`
          return typeof c.valor === 'number'
            ? `<c r="${ref}"><f>${xml(c.formula)}</f><v>${c.valor}</v></c>`
            : `<c r="${ref}" t="str"><f>${xml(c.formula)}</f><v>${xml(c.valor)}</v></c>`
        })
        .join('')
      return `<row r="${r + 1}">${celulas}</row>`
    })
    .join('')
  const solta = celulaSolta
    ? `<row r="${/\d+$/.exec(celulaSolta.ref)?.[0]}"><c r="${celulaSolta.ref}" t="inlineStr"><is><t>${xml(celulaSolta.valor)}</t></is></c></row>`
    : ''
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `${dimensao ? `<dimension ref="${dimensao}"/>` : ''}<sheetData>${corpo}${solta}</sheetData></worksheet>`
  )
}

/** Cada aba é uma grade de células; a primeira é a que o lote lê. */
export function montarXlsx(abas: Aba[]): Uint8Array {
  const strings: string[] = []
  const folhas = abas.map((a) => aba(a, strings))
  const arquivos: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        folhas
          .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
          .join('') +
        `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        abas.map((a, i) => `<sheet name="${xml(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        `</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        folhas
          .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
          .join('') +
        `<Relationship Id="rId${folhas.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ),
  }
  folhas.forEach((folha, i) => {
    arquivos[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(folha)
  })
  arquivos['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
      strings.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join('') +
      `</sst>`,
  )
  // Data fixa: o mesmo conteúdo dá o mesmo arquivo (e o mesmo SHA-256).
  return zipSync(arquivos, { mtime: new Date('2026-11-05T12:00:00Z') })
}
