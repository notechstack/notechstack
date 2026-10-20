// DANFSe no layout da NT SE/CGNFS-e 008 v1.02 (referência §6; forma literal no Landing do
// checklist, lote 2b - DANFSe): página única A4 retrato, conteúdo só do XML da NFS-e, borda de
// 1 pt, divisórias de 0,5 pt, cinza 5% no cabeçalho, nos títulos de bloco e nos campos
// "Emitente da NFS-e" e "Valor líquido da NFS-e + IBS/CBS", QR Code de 1,52 cm em X 17,48 cm e
// Y 1,67 cm, "NFS-e SEM VALIDADE JURÍDICA" em produção restrita e marca d'água "CANCELADA".
// Fontes: Helvetica (métrica da Arial), porque a Arial não pode ser embutida.
import { cmyk, degrees, PDFDocument, PDFFont, PDFName, PDFPage, PDFString, StandardFonts } from 'pdf-lib'
import QRCode from 'qrcode'
import { parseNfseXml, type NfseData, type Pessoa } from './nfse-xml.js'

export const CM = 72 / 2.54
export const A4 = { width: 595.28, height: 841.89 } as const
export const QR_BOX = { x: 17.48 * CM, y: 1.67 * CM, size: 1.52 * CM } as const
const MARGIN = 0.2 * CM
const LEFT = MARGIN
const RIGHT = A4.width - MARGIN
const WIDTH = RIGHT - LEFT
const HEADER_BOTTOM = 1.3 * CM
const TITLE_H = 10
const ROW_H = 19
const LINE_H = 8.5
/** A coluna do QR Code começa aqui; os campos da identificação ficam à esquerda. */
const QR_COLUMN_X = 15.5 * CM

const BLACK = cmyk(0, 0, 0, 1)
const SHADE = cmyk(0, 0, 0, 0.05)
const RED = cmyk(0, 1, 1, 0)
const WATERMARK = cmyk(0, 0, 0, 0.35)

export const QR_TEXT =
  'A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e'

export const consultaPublicaUrl = (chave: string) => `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`

export type DanfseOptions = {
  /** Nota cancelada: marca d'água "CANCELADA" (NT 008 §2.5). */
  cancelada?: boolean
}

// ---------- formatação ----------

const dash = (value: string | null | undefined) => (value && value.trim() ? value : '-')

function digits(value: string | null, mask: (d: string) => string, size: number): string {
  if (!value) return '-'
  return /^\d+$/.test(value) && value.length === size ? mask(value) : value
}
const fmtCnpj = (v: string | null) => digits(v, (d) => `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`, 14)
const fmtCpf = (v: string | null) => digits(v, (d) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`, 11)
const fmtCep = (v: string | null) => digits(v, (d) => `${d.slice(0, 5)}-${d.slice(5)}`, 8)
const fmtDoc = (p: Pessoa | null) => (p?.CNPJ ? fmtCnpj(p.CNPJ) : p?.CPF ? fmtCpf(p.CPF) : '-')

function fmtDate(value: string | null): string {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null
  return m ? `${m[3]}/${m[2]}/${m[1]}` : dash(value)
}
function fmtDateTime(value: string | null): string {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})/.exec(value) : null
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : dash(value)
}
function fmtMoney(value: string | null): string {
  if (!value || !/^-?\d+(\.\d+)?$/.test(value)) return dash(value)
  const [int, dec = ''] = Number(value).toFixed(2).split('.')
  return `R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`
}
const fmtPercent = (value: string | null) => (value && /^\d+(\.\d+)?$/.test(value) ? `${Number(value).toFixed(2).replace('.', ',')}%` : dash(value))

const OP_SIMP_NAC: Record<string, string> = {
  '1': 'Não optante',
  '2': 'Optante - Microempreendedor Individual (MEI)',
  '3': 'Optante - Microempresa ou Empresa de Pequeno Porte (ME/EPP)',
}
const REG_AP_TRIB_SN: Record<string, string> = {
  '1': 'Regime de apuração dos tributos federais e municipal pelo SN',
  '2': 'Tributos federais pelo SN e ISSQN pela NFS-e conforme a legislação municipal',
  '3': 'Tributos federais e municipal pela NFS-e conforme as respectivas legislações',
}
const TRIB_ISSQN: Record<string, string> = {
  '1': 'Operação tributável',
  '2': 'Imunidade',
  '3': 'Exportação de serviço',
  '4': 'Não incidência',
}
const TP_RET_ISSQN: Record<string, string> = { '1': 'Não retido', '2': 'Retido pelo tomador', '3': 'Retido pelo intermediário' }
const TP_EMIT: Record<string, string> = { '1': 'Prestador do serviço', '2': 'Tomador do serviço', '3': 'Intermediário do serviço' }
const AMB_GER: Record<string, string> = { '1': 'Prefeitura', '2': 'Sefin Nacional' }
const label = (map: Record<string, string>, code: string | null) => (code ? (map[code] ?? code) : '-')

function fmtEndereco(p: Pessoa | null): { endereco: string; municipio: string; ibgeCep: string } {
  const e = p?.endereco
  if (!e) return { endereco: '-', municipio: '-', ibgeCep: '-' }
  const linha = [e.xLgr, e.nro, e.xCpl, e.xBairro].filter(Boolean).join(', ')
  return {
    endereco: dash(linha),
    municipio: e.UF ? `${dash(e.cMun)} / ${e.UF}` : dash(e.cMun),
    ibgeCep: `${dash(e.cMun)} / ${fmtCep(e.CEP)}`,
  }
}

// ---------- desenho ----------

type Fonts = { regular: PDFFont; bold: PDFFont }

class Painter {
  readonly background: (() => void)[] = []
  readonly foreground: (() => void)[] = []
  private readonly encodable = new Map<string, boolean>()
  constructor(
    readonly page: PDFPage,
    readonly fonts: Fonts,
  ) {}

  /** Só caracteres da codificação WinAnsi das fontes padrão; o resto vira "?". */
  safe(text: string, font: PDFFont): string {
    let out = ''
    for (const ch of text.replace(/[\t\r\n]+/g, ' ').normalize('NFC')) {
      let ok = this.encodable.get(ch)
      if (ok === undefined) {
        try {
          font.encodeText(ch)
          ok = true
        } catch {
          ok = false
        }
        this.encodable.set(ch, ok)
      }
      out += ok ? ch : '?'
    }
    return out
  }

  fit(text: string, font: PDFFont, size: number, width: number): string {
    let out = this.safe(text, font)
    if (font.widthOfTextAtSize(out, size) <= width) return out
    while (out.length > 0 && font.widthOfTextAtSize(`${out}...`, size) > width) out = out.slice(0, -1)
    return `${out}...`
  }

  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = []
    for (const paragraph of text.split('\n')) {
      let line = ''
      for (const word of this.safe(paragraph, font).split(' ')) {
        const candidate = line ? `${line} ${word}` : word
        if (font.widthOfTextAtSize(candidate, size) <= width || !line) line = candidate
        else {
          lines.push(line)
          line = word
        }
      }
      lines.push(line)
    }
    return lines
  }

  text(value: string, x: number, top: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof cmyk>; width?: number; center?: boolean } = {}) {
    const font = opts.bold ? this.fonts.bold : this.fonts.regular
    const content = opts.width ? this.fit(value, font, size, opts.width) : this.safe(value, font)
    const dx = opts.center && opts.width ? (opts.width - font.widthOfTextAtSize(content, size)) / 2 : 0
    this.foreground.push(() =>
      this.page.drawText(content, { x: x + dx, y: A4.height - top, size, font, color: opts.color ?? BLACK }),
    )
  }

  shade(x: number, top: number, width: number, height: number) {
    this.background.push(() => this.page.drawRectangle({ x, y: A4.height - top - height, width, height, color: SHADE }))
  }

  hline(top: number, x1 = LEFT, x2 = RIGHT) {
    this.foreground.push(() =>
      this.page.drawLine({ start: { x: x1, y: A4.height - top }, end: { x: x2, y: A4.height - top }, thickness: 0.5, color: BLACK }),
    )
  }

  vline(x: number, top: number, bottom: number) {
    this.foreground.push(() =>
      this.page.drawLine({ start: { x, y: A4.height - top }, end: { x, y: A4.height - bottom }, thickness: 0.5, color: BLACK }),
    )
  }
}

type Field = { label: string; value: string; span?: number; shaded?: boolean }

/** Linha de campos: título 6 pt negrito, conteúdo 7 pt (NT 008 §2.4). */
function row(p: Painter, top: number, fields: Field[], opts: { left?: number; right?: number; labelSize?: number; upper?: boolean } = {}) {
  const left = opts.left ?? LEFT
  const right = opts.right ?? RIGHT
  const total = fields.reduce((sum, f) => sum + (f.span ?? 1), 0)
  let x = left
  fields.forEach((field, index) => {
    const width = ((right - left) * (field.span ?? 1)) / total
    if (field.shaded) p.shade(x, top, width, ROW_H)
    if (index > 0) p.vline(x, top, top + ROW_H)
    const title = opts.upper ? field.label.toUpperCase() : field.label
    p.text(title, x + 2, top + 7.5, opts.labelSize ?? 6, { bold: true, width: width - 4 })
    p.text(field.value, x + 2, top + 16, 7, { width: width - 4 })
    x += width
  })
  p.hline(top + ROW_H, left, right)
  return top + ROW_H
}

/** Título de bloco: 7 pt, negrito, maiúsculas, fundo cinza 5%. */
function blockTitle(p: Painter, top: number, title: string, right = RIGHT) {
  p.shade(LEFT, top, right - LEFT, TITLE_H)
  p.text(title.toUpperCase(), LEFT + 2, top + 7.5, 7, { bold: true })
  p.hline(top + TITLE_H, LEFT, right)
  return top + TITLE_H
}

/** Bloco sem dados reduzido a uma linha de texto (NT 008 §2.3). */
function noticeLine(p: Painter, top: number, text: string) {
  p.text(text, LEFT + 2, top + 8, 7, { bold: true })
  p.hline(top + 11)
  return top + 11
}

function pessoaRows(p: Painter, top: number, pessoa: Pessoa | null, extra: Field[] = []) {
  const end = fmtEndereco(pessoa)
  let y = row(p, top, [
    { label: 'CNPJ / CPF / NIF', value: fmtDoc(pessoa) },
    { label: 'Inscrição municipal', value: dash(pessoa?.IM) },
    { label: 'Telefone', value: dash(pessoa?.fone) },
  ])
  y = row(p, y, [
    { label: 'Nome / Nome empresarial', value: dash(pessoa?.xNome), span: 2 },
    { label: 'E-mail', value: dash(pessoa?.email) },
  ])
  y = row(p, y, [
    { label: 'Endereço', value: end.endereco, span: 2 },
    { label: 'Município / Código IBGE / CEP', value: end.ibgeCep },
  ])
  if (extra.length) y = row(p, y, extra)
  return y
}

function drawQr(p: Painter, doc: PDFDocument, chave: string) {
  const url = consultaPublicaUrl(chave)
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' })
  const n = qr.modules.size
  const cell = QR_BOX.size / n
  const top = QR_BOX.y
  p.foreground.push(() => {
    for (let r = 0; r < n; r++) {
      let c = 0
      while (c < n) {
        if (!qr.modules.get(r, c)) {
          c++
          continue
        }
        const start = c
        while (c < n && qr.modules.get(r, c)) c++
        p.page.drawRectangle({
          x: QR_BOX.x + start * cell,
          y: A4.height - top - (r + 1) * cell,
          width: (c - start) * cell,
          height: cell,
          color: BLACK,
        })
      }
    }
  })
  // Link para a consulta pública sobre o próprio QR Code.
  const rect = [QR_BOX.x, A4.height - top - QR_BOX.size, QR_BOX.x + QR_BOX.size, A4.height - top]
  const annot = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rect,
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    }),
  )
  p.page.node.addAnnot(annot)
  // Texto de 3 linhas, 6 pt, abaixo do QR Code (NT 008 §2.4.3).
  const lines = p.wrap(QR_TEXT, p.fonts.regular, 6, RIGHT - QR_COLUMN_X - 4)
  lines.forEach((line, i) => p.text(line, QR_COLUMN_X + 2, top + QR_BOX.size + 7 + i * 7, 6, { width: RIGHT - QR_COLUMN_X - 4, center: true }))
}

export async function renderDanfse(xmlNfse: string, options: DanfseOptions = {}): Promise<Uint8Array> {
  const nfse: NfseData = parseNfseXml(xmlNfse)
  const doc = await PDFDocument.create()
  doc.setTitle(`DANFSe ${nfse.chaveAcesso}`)
  doc.setSubject('Documento Auxiliar da NFS-e')
  doc.setProducer('Nó Fiscal')
  doc.setCreator('Nó Fiscal')
  const page = doc.addPage([A4.width, A4.height])
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) }
  const p = new Painter(page, fonts)
  const d = nfse.dps
  const restrita = d.tpAmb === '2'

  // Cabeçalho (NT 008 §2.4.3).
  p.shade(LEFT, MARGIN, WIDTH, HEADER_BOTTOM - MARGIN)
  p.text('NFS-e', LEFT + 6, MARGIN + 21, 18, { bold: true })
  const centerX = LEFT + WIDTH * 0.3
  const centerW = WIDTH * 0.4
  p.text('DANFSe v2.0', centerX, MARGIN + 9, 9, { bold: true, width: centerW, center: true })
  p.text('Documento Auxiliar da NFS-e', centerX, MARGIN + 18.5, 9, { bold: true, width: centerW, center: true })
  if (restrita) p.text('NFS-e SEM VALIDADE JURÍDICA', centerX, MARGIN + 28, 9, { bold: true, color: RED, width: centerW, center: true })
  const rightX = LEFT + WIDTH * 0.7
  const rightW = WIDTH * 0.3 - 4
  p.text(dash(nfse.xLocEmi), rightX, MARGIN + 11, 8, { width: rightW })
  p.text(`Ambiente gerador: ${label(AMB_GER, nfse.ambGer)}`, rightX, MARGIN + 19, 6, { width: rightW })
  p.text(`Tipo de ambiente: ${d.tpAmb === '1' ? 'Produção' : restrita ? 'Produção restrita' : dash(d.tpAmb)}`, rightX, MARGIN + 26, 6, {
    width: rightW,
  })
  p.hline(HEADER_BOTTOM)

  // Identificação da NFS-e, com o QR Code à direita.
  let y = blockTitle(p, HEADER_BOTTOM, 'Chave de acesso da NFS-e e identificação')
  const ident = { left: LEFT, right: QR_COLUMN_X, labelSize: 7, upper: true }
  const identTop = y
  y = row(p, y, [{ label: 'Chave de acesso da NFS-e', value: nfse.chaveAcesso }], ident)
  y = row(
    p,
    y,
    [
      { label: 'Número da NFS-e', value: dash(nfse.nNFSe) },
      { label: 'Competência da NFS-e', value: fmtDate(d.dCompet) },
      { label: 'Data e hora da emissão da NFS-e', value: fmtDateTime(nfse.dhProc) },
    ],
    ident,
  )
  y = row(
    p,
    y,
    [
      { label: 'Número da DPS', value: dash(d.nDPS) },
      { label: 'Série da DPS', value: dash(d.serie) },
      { label: 'Data e hora da emissão da DPS', value: fmtDateTime(d.dhEmi) },
    ],
    ident,
  )
  y = row(
    p,
    y,
    [
      { label: 'Emitente da NFS-e', value: label(TP_EMIT, d.tpEmit), shaded: true },
      { label: 'Situação da NFS-e', value: options.cancelada ? 'Cancelada' : 'Gerada' },
      { label: 'Finalidade', value: 'NFS-e regular' },
    ],
    ident,
  )
  p.vline(QR_COLUMN_X, identTop, y)
  drawQr(p, doc, nfse.chaveAcesso)
  y = Math.max(y, QR_BOX.y + QR_BOX.size + 7 * 3 + 4)
  p.hline(y)

  // Prestador: o emitente da NFS-e (nome e endereço vêm do cadastro, no grupo emit).
  y = blockTitle(p, y, 'Prestador / Fornecedor')
  const prestador: Pessoa = { ...nfse.emitente, IM: nfse.emitente.IM ?? d.prestador.IM }
  y = pessoaRows(p, y, prestador, [
    { label: 'Simples Nacional na data de competência', value: label(OP_SIMP_NAC, d.prestador.opSimpNac) },
    { label: 'Regime de apuração tributária pelo SN', value: label(REG_AP_TRIB_SN, d.prestador.regApTribSN) },
  ])

  y = blockTitle(p, y, 'Tomador / Adquirente')
  y = d.tomador ? pessoaRows(p, y, d.tomador) : noticeLine(p, y, 'TOMADOR/ADQUIRENTE DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e')

  y = blockTitle(p, y, 'Destinatário da operação')
  y = noticeLine(p, y, 'O DESTINATÁRIO É O PRÓPRIO TOMADOR/ADQUIRENTE DA OPERAÇÃO')

  y = blockTitle(p, y, 'Intermediário da operação')
  y = noticeLine(p, y, 'INTERMEDIÁRIO DA OPERAÇÃO NÃO IDENTIFICADO NA NFS-e')

  // Serviço prestado.
  y = blockTitle(p, y, 'Serviço prestado')
  y = row(p, y, [
    { label: 'Código de tributação nacional', value: `${dash(d.cTribNac)}${nfse.xTribNac ? ` - ${nfse.xTribNac}` : ''}`, span: 2 },
    { label: 'Código de tributação municipal', value: d.cTribMun ? `${d.cTribMun}${nfse.xTribMun ? ` - ${nfse.xTribMun}` : ''}` : '-' },
  ])
  y = row(p, y, [
    { label: 'Local da prestação', value: dash(nfse.xLocPrestacao) },
    { label: 'País da prestação', value: '-' },
    { label: 'Código NBS', value: d.cNBS ? `${d.cNBS}${nfse.xNBS ? ` - ${nfse.xNBS}` : ''}` : '-' },
  ])
  p.text('Descrição do serviço', LEFT + 2, y + 7.5, 6, { bold: true })
  const descricao = p.wrap(d.xDescServ ?? '-', fonts.regular, 7, WIDTH - 4).slice(0, 12)
  descricao.forEach((line, i) => p.text(line, LEFT + 2, y + 16 + i * LINE_H, 7))
  y += 10 + descricao.length * LINE_H + 2
  p.hline(y)

  // Tributação municipal (ISSQN).
  y = blockTitle(p, y, 'Tributação municipal (ISSQN)')
  y = row(p, y, [
    { label: 'Tributação do ISSQN', value: label(TRIB_ISSQN, d.tribISSQN) },
    { label: 'Município de incidência do ISSQN', value: dash(nfse.xLocIncid) },
    { label: 'Regime especial de tributação', value: d.prestador.regEspTrib === '0' ? 'Nenhum' : dash(d.prestador.regEspTrib) },
  ])
  y = row(p, y, [
    { label: 'Retenção do ISSQN', value: label(TP_RET_ISSQN, d.tpRetISSQN) },
    { label: 'Base de cálculo do ISSQN', value: fmtMoney(nfse.valoresNfse.vBC) },
    { label: 'Alíquota aplicada', value: fmtPercent(nfse.valoresNfse.pAliqAplic) },
    { label: 'ISSQN apurado', value: fmtMoney(nfse.valoresNfse.vISSQN) },
  ])

  y = blockTitle(p, y, 'Tributação federal (exceto CBS)')
  y = row(p, y, [
    { label: 'IRRF', value: '-' },
    { label: 'Contribuição previdenciária', value: '-' },
    { label: 'CSLL', value: '-' },
    { label: 'PIS', value: '-' },
    { label: 'COFINS', value: '-' },
  ])

  y = blockTitle(p, y, 'Tributação IBS / CBS')
  y = noticeLine(p, y, 'IBS/CBS NÃO INFORMADOS NA NFS-e')

  // Valor total.
  y = blockTitle(p, y, 'Valor total da NFS-e')
  y = row(p, y, [
    { label: 'Valor do serviço', value: fmtMoney(d.vServ) },
    { label: 'Desconto condicionado', value: fmtMoney(d.vDescCond) },
    { label: 'Desconto incondicionado', value: fmtMoney(d.vDescIncond) },
    { label: 'Total das retenções', value: fmtMoney(nfse.valoresNfse.vTotalRet) },
  ])
  y = row(p, y, [
    { label: 'Valor líquido da NFS-e', value: fmtMoney(nfse.valoresNfse.vLiq) },
    { label: 'Total IBS/CBS', value: '-' },
    { label: 'Valor líquido da NFS-e + IBS/CBS', value: fmtMoney(nfse.valoresNfse.vLiq), shaded: true, span: 2 },
  ])

  // Informações complementares, com os totais aproximados da Lei 12.741/2012.
  y = blockTitle(p, y, 'Informações complementares')
  const totais = d.pTotTribSN
    ? `Totais aproximados dos tributos (Lei 12.741/2012): ${fmtPercent(d.pTotTribSN)} do valor do serviço (Simples Nacional).`
    : d.pTotTrib
      ? `Totais aproximados dos tributos (Lei 12.741/2012): federais ${fmtPercent(d.pTotTrib.fed)}, estaduais ${fmtPercent(d.pTotTrib.est)}, municipais ${fmtPercent(d.pTotTrib.mun)}.`
      : d.vTotTrib
        ? `Totais aproximados dos tributos (Lei 12.741/2012): federais ${fmtMoney(d.vTotTrib.fed)}, estaduais ${fmtMoney(d.vTotTrib.est)}, municipais ${fmtMoney(d.vTotTrib.mun)}.`
        : 'Totais aproximados dos tributos (Lei 12.741/2012): não informados na NFS-e.'
  const complementares = p.wrap([d.xInfComp, totais].filter(Boolean).join('\n'), fonts.regular, 7, WIDTH - 4).slice(0, 8)
  complementares.forEach((line, i) => p.text(line, LEFT + 2, y + 8 + i * LINE_H, 7))
  y += complementares.length * LINE_H + 4
  p.hline(y)

  // Borda da página: 1 pt.
  p.foreground.push(() =>
    page.drawRectangle({ x: LEFT, y: MARGIN, width: WIDTH, height: A4.height - 2 * MARGIN, borderColor: BLACK, borderWidth: 1 }),
  )

  for (const draw of p.background) draw()
  if (options.cancelada) {
    // Marca d'água na diagonal, Helvetica negrito 60 pt, cinza K35 (NT 008 §2.5), atrás do conteúdo.
    const size = 60
    const textWidth = fonts.bold.widthOfTextAtSize('CANCELADA', size)
    const angle = 45
    const rad = (angle * Math.PI) / 180
    page.drawText('CANCELADA', {
      x: A4.width / 2 - (Math.cos(rad) * textWidth) / 2 + (Math.sin(rad) * size) / 3,
      y: A4.height / 2 - (Math.sin(rad) * textWidth) / 2 - (Math.cos(rad) * size) / 3,
      size,
      font: fonts.bold,
      color: WATERMARK,
      rotate: degrees(angle),
    })
  }
  for (const draw of p.foreground) draw()

  page.node.set(PDFName.of('Tabs'), PDFName.of('S'))
  return doc.save({ useObjectStreams: false })
}
