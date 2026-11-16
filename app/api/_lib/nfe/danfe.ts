// DANFE retrato (A4) a partir do XML autorizado (`nfeProc`), no leiaute do Anexo II do Manual de Orientação do
// Contribuinte: canhoto, identificação do emitente, quadro DANFE (entrada/saída, número, série, folha), código de
// barras Code 128C da chave, natureza e protocolo, destinatário, cálculo do imposto, transportador, produtos e dados
// adicionais. Itens que não cabem continuam nas folhas seguintes (cabeçalho repetido). "SEM VALOR FISCAL" em
// homologação; marca "CANCELADA" quando pedido. Fonte Helvetica (pdf-lib embute só as 14 padrão sem arquivo).
import { DOMParser } from '@xmldom/xmldom'
import { cmyk, degrees, PDFDocument, type PDFFont, type PDFPage, StandardFonts } from 'pdf-lib'
import { modulosCode128C } from './code128.js'

const CM = 72 / 2.54
const A4 = { width: 595.28, height: 841.89 }
const M = 0.5 * CM
const L = M
const R = A4.width - M
const W = R - L
const BLACK = cmyk(0, 0, 0, 1)
const SHADE = cmyk(0, 0, 0, 0.06)
const MARCA = cmyk(0, 0, 0, 0.18)

// ---------- leitura do XML ----------

type Doc = Document
type El = Element
const NS = 'http://www.portalfiscal.inf.br/nfe'

function filho(node: Doc | El | null, nome: string): El | null {
  if (!node) return null
  return (node.getElementsByTagNameNS(NS, nome)[0] as El | undefined) ?? (node.getElementsByTagName(nome)[0] as El | undefined) ?? null
}
function filhos(node: Doc | El | null, nome: string): El[] {
  if (!node) return []
  const lista = node.getElementsByTagNameNS(NS, nome)
  return Array.from({ length: lista.length }, (_, i) => lista[i] as El)
}
const t = (node: Doc | El | null, nome: string) => (filho(node, nome)?.textContent ?? '').trim()

export type DanfeDados = ReturnType<typeof lerNfeProc>

export function lerNfeProc(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Doc
  const inf = filho(doc, 'infNFe')
  if (!inf) throw new Error('XML sem infNFe')
  const ide = filho(inf, 'ide')
  const emit = filho(inf, 'emit')
  const dest = filho(inf, 'dest')
  const tot = filho(inf, 'ICMSTot')
  const prot = filho(doc, 'infProt')
  const end = (e: El | null) => ({
    logradouro: [t(e, 'xLgr'), t(e, 'nro'), t(e, 'xCpl')].filter(Boolean).join(', '),
    bairro: t(e, 'xBairro'),
    municipio: t(e, 'xMun'),
    uf: t(e, 'UF'),
    cep: t(e, 'CEP'),
    fone: t(e, 'fone'),
  })
  return {
    chave: (inf.getAttribute('Id') ?? '').replace(/^NFe/, ''),
    ambiente: t(ide, 'tpAmb'),
    natureza: t(ide, 'natOp'),
    numero: t(ide, 'nNF'),
    serie: t(ide, 'serie'),
    tipo: t(ide, 'tpNF'),
    emissao: t(ide, 'dhEmi'),
    saida: t(ide, 'dhSaiEnt'),
    emitente: {
      nome: t(emit, 'xNome'),
      fantasia: t(emit, 'xFant'),
      cnpj: t(emit, 'CNPJ') || t(emit, 'CPF'),
      ie: t(emit, 'IE'),
      iest: t(emit, 'IEST'),
      crt: t(emit, 'CRT'),
      endereco: end(filho(emit, 'enderEmit')),
    },
    destinatario: {
      nome: t(dest, 'xNome'),
      documento: t(dest, 'CNPJ') || t(dest, 'CPF') || t(dest, 'idEstrangeiro'),
      ie: t(dest, 'IE'),
      endereco: end(filho(dest, 'enderDest')),
    },
    totais: {
      vBC: t(tot, 'vBC'), vICMS: t(tot, 'vICMS'), vBCST: t(tot, 'vBCST'), vST: t(tot, 'vST'), vProd: t(tot, 'vProd'),
      vFrete: t(tot, 'vFrete'), vSeg: t(tot, 'vSeg'), vDesc: t(tot, 'vDesc'), vOutro: t(tot, 'vOutro'), vIPI: t(tot, 'vIPI'),
      vNF: t(tot, 'vNF'), vTotTrib: t(tot, 'vTotTrib'),
    },
    modFrete: t(filho(inf, 'transp'), 'modFrete'),
    itens: filhos(inf, 'det').map((det) => {
      const prod = filho(det, 'prod')
      const icms = filho(det, 'ICMS')?.firstChild as El | null
      return {
        codigo: t(prod, 'cProd'),
        descricao: t(prod, 'xProd'),
        infAdProd: t(det, 'infAdProd'),
        ncm: t(prod, 'NCM'),
        cst: icms ? `${t(icms, 'orig')}${t(icms, 'CSOSN') || t(icms, 'CST')}` : '',
        cfop: t(prod, 'CFOP'),
        unidade: t(prod, 'uCom'),
        quantidade: t(prod, 'qCom'),
        unitario: t(prod, 'vUnCom'),
        total: t(prod, 'vProd'),
        vBC: icms ? t(icms, 'vBC') : '',
        vICMS: icms ? t(icms, 'vICMS') : '',
        pICMS: icms ? t(icms, 'pICMS') : '',
        vIPI: t(filho(det, 'IPI'), 'vIPI'),
        pIPI: t(filho(det, 'IPI'), 'pIPI'),
      }
    }),
    infCpl: t(filho(inf, 'infAdic'), 'infCpl'),
    infAdFisco: t(filho(inf, 'infAdic'), 'infAdFisco'),
    protocolo: t(prot, 'nProt'),
    recebidaEm: t(prot, 'dhRecbto'),
  }
}

// ---------- formatação ----------

const num = (v: string, casas: number) => {
  if (!v || !/^-?\d+(\.\d+)?$/.test(v)) return v ? v : ''
  const [i, d = ''] = Number(v).toFixed(casas).split('.')
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${casas ? ',' + d : ''}`
}
const dinheiro = (v: string) => num(v || '0', 2)
const quantidade = (v: string) => num(v, 4)
const unitario = (v: string) => {
  const casas = Math.max(2, Math.min(10, (v.split('.')[1] ?? '').replace(/0+$/, '').length))
  return num(v, casas)
}
export const formatarChave = (c: string) => c.replace(/(\d{4})(?=\d)/g, '$1 ')
const documento = (d: string) =>
  d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
  : d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  : d
const cep = (c: string) => (c.length === 8 ? `${c.slice(0, 5)}-${c.slice(5)}` : c)
const data = (v: string) => (/^(\d{4})-(\d{2})-(\d{2})/.exec(v) ? v.replace(/^(\d{4})-(\d{2})-(\d{2}).*$/, '$3/$2/$1') : '')
const hora = (v: string) => /T(\d{2}:\d{2}:\d{2})/.exec(v)?.[1] ?? ''
const numeroNota = (n: string) => n.padStart(9, '0').replace(/^(\d{3})(\d{3})(\d{3})$/, '$1.$2.$3')
const MOD_FRETE: Record<string, string> = {
  '0': '0 - Por conta do Remetente',
  '1': '1 - Por conta do Destinatário',
  '2': '2 - Por conta de Terceiros',
  '3': '3 - Próprio por conta do Remetente',
  '4': '4 - Próprio por conta do Destinatário',
  '9': '9 - Sem Ocorrência de Transporte',
}

// ---------- desenho ----------

type Fontes = { normal: PDFFont; negrito: PDFFont }

/** Corta o texto para caber na largura (WinAnsi: troca caracteres fora do Latin-1). */
function caber(f: PDFFont, texto: string, tam: number, largura: number): string {
  let s = texto.replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
  if (f.widthOfTextAtSize(s, tam) <= largura) return s
  while (s.length > 1 && f.widthOfTextAtSize(s + '…', tam) > largura) s = s.slice(0, -1)
  return s + '…'
}

function quebrar(f: PDFFont, texto: string, tam: number, largura: number): string[] {
  const linhas: string[] = []
  for (const par of texto.replace(/[^\x20-\x7e\xa0-\xff\n]/g, '?').split('\n')) {
    let atual = ''
    for (const palavra of par.split(/\s+/).filter(Boolean)) {
      const tentativa = atual ? `${atual} ${palavra}` : palavra
      if (f.widthOfTextAtSize(tentativa, tam) <= largura) atual = tentativa
      else {
        if (atual) linhas.push(atual)
        atual = caber(f, palavra, tam, largura)
      }
    }
    if (atual) linhas.push(atual)
  }
  return linhas
}

class Pintor {
  constructor(readonly page: PDFPage, readonly f: Fontes) {}
  /** y em coordenadas de cima para baixo. */
  caixa(x: number, top: number, w: number, h: number, sombra = false) {
    this.page.drawRectangle({ x, y: A4.height - top - h, width: w, height: h, borderColor: BLACK, borderWidth: 0.5, color: sombra ? SHADE : undefined })
  }
  texto(s: string, x: number, top: number, tam = 7, negrito = false, largura?: number) {
    const fonte = negrito ? this.f.negrito : this.f.normal
    const v = largura ? caber(fonte, s, tam, largura) : s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    this.page.drawText(v, { x, y: A4.height - top - tam, size: tam, font: fonte, color: BLACK })
  }
  direita(s: string, xDir: number, top: number, tam = 7, negrito = false) {
    const fonte = negrito ? this.f.negrito : this.f.normal
    this.page.drawText(s, { x: xDir - fonte.widthOfTextAtSize(s, tam), y: A4.height - top - tam, size: tam, font: fonte, color: BLACK })
  }
  centro(s: string, x: number, w: number, top: number, tam = 7, negrito = false) {
    const fonte = negrito ? this.f.negrito : this.f.normal
    const v = caber(fonte, s, tam, w - 2)
    this.page.drawText(v, { x: x + (w - fonte.widthOfTextAtSize(v, tam)) / 2, y: A4.height - top - tam, size: tam, font: fonte, color: BLACK })
  }
  /** Campo com rótulo pequeno em cima e valor embaixo. */
  campo(rotulo: string, valor: string, x: number, top: number, w: number, h = 18, alinhar: 'esq' | 'dir' = 'esq', tam = 7.5) {
    this.caixa(x, top, w, h)
    this.texto(rotulo.toUpperCase(), x + 2, top + 1.5, 5, false, w - 4)
    if (alinhar === 'dir') this.direita(caber(this.f.normal, valor, tam, w - 4), x + w - 2, top + h - tam - 2.5, tam)
    else this.texto(valor, x + 2, top + h - tam - 2.5, tam, false, w - 4)
  }
  titulo(s: string, top: number) {
    this.texto(s.toUpperCase(), L, top, 6, true)
  }
  barras(chave: string, x: number, top: number, w: number, h: number) {
    const modulos = modulosCode128C(chave)
    const total = modulos.reduce((a, b) => a + b, 0) + 20 // zona de silêncio de 10 módulos em cada lado
    const passo = w / total
    let cx = x + 10 * passo
    modulos.forEach((m, i) => {
      if (i % 2 === 0) this.page.drawRectangle({ x: cx, y: A4.height - top - h, width: m * passo, height: h, color: BLACK })
      cx += m * passo
    })
  }
}

export type DanfeOptions = { cancelada?: boolean }

const COLUNAS = [
  { r: 'Código', w: 46 },
  { r: 'Descrição do produto / serviço', w: 150 },
  { r: 'NCM/SH', w: 34 },
  { r: 'O/CSOSN', w: 26 },
  { r: 'CFOP', w: 22 },
  { r: 'Un', w: 20 },
  { r: 'Quant.', w: 38, d: true },
  { r: 'Valor unit.', w: 42, d: true },
  { r: 'Valor total', w: 42, d: true },
  { r: 'BC ICMS', w: 32, d: true },
  { r: 'Valor ICMS', w: 30, d: true },
  { r: 'Valor IPI', w: 26, d: true },
  { r: 'Alíq. ICMS', w: 24, d: true },
  { r: 'Alíq. IPI', w: 0, d: true },
]
COLUNAS[COLUNAS.length - 1].w = W - COLUNAS.slice(0, -1).reduce((s, c) => s + c.w, 0)

/** Linhas de cada item na tabela (a descrição quebra; o infAdProd vem embaixo). */
function linhasDoItem(f: PDFFont, item: DanfeDados['itens'][number]): string[] {
  const texto = item.infAdProd ? `${item.descricao}\n${item.infAdProd}` : item.descricao
  return quebrar(f, texto, 6, COLUNAS[1].w - 3)
}

function cabecalho(p: Pintor, d: DanfeDados, folha: number, folhas: number, comCanhoto: boolean): number {
  let top = M
  if (comCanhoto) {
    p.caixa(L, top, W - 90, 16)
    p.texto(`RECEBEMOS DE ${d.emitente.nome.toUpperCase()} OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA AO LADO.`, L + 2, top + 1.5, 5.5, false, W - 96)
    p.texto(`EMISSÃO: ${data(d.emissao)}   VALOR TOTAL: R$ ${dinheiro(d.totais.vNF)}   DESTINATÁRIO: ${d.destinatario.nome}`, L + 2, top + 8.5, 5.5, false, W - 96)
    p.campo('Data de recebimento', '', L, top + 16, 90, 18)
    p.campo('Identificação e assinatura do recebedor', '', L + 90, top + 16, W - 180, 18)
    p.caixa(R - 90, top, 90, 34)
    p.centro('NF-e', R - 90, 90, top + 3, 9, true)
    p.centro(`Nº ${numeroNota(d.numero)}`, R - 90, 90, top + 14, 8, true)
    p.centro(`SÉRIE ${d.serie.padStart(3, '0')}`, R - 90, 90, top + 23, 8, true)
    top += 34
    p.page.drawLine({ start: { x: L, y: A4.height - top - 4 }, end: { x: R, y: A4.height - top - 4 }, thickness: 0.5, dashArray: [2, 2], color: BLACK })
    top += 8
  }
  // Emitente | DANFE | código de barras
  const hTopo = 80
  const wEmit = 215
  const wDanfe = 95
  const wBarras = W - wEmit - wDanfe
  p.caixa(L, top, wEmit, hTopo)
  p.texto('IDENTIFICAÇÃO DO EMITENTE', L + 2, top + 2, 5)
  const linhasEmit = quebrar(p.f.negrito, d.emitente.nome, 9, wEmit - 8).slice(0, 2)
  linhasEmit.forEach((l, i) => p.centro(l, L, wEmit, top + 10 + i * 11, 9, true))
  const e = d.emitente.endereco
  const infoEmit = [e.logradouro, `${e.bairro} - ${cep(e.cep)}`, `${e.municipio} - ${e.uf}${e.fone ? ` - Fone: ${e.fone}` : ''}`]
  infoEmit.forEach((l, i) => p.centro(l, L, wEmit, top + 36 + i * 9, 7))

  const xd = L + wEmit
  p.caixa(xd, top, wDanfe, hTopo)
  p.centro('DANFE', xd, wDanfe, top + 4, 12, true)
  p.centro('Documento Auxiliar da', xd, wDanfe, top + 18, 6.5)
  p.centro('Nota Fiscal Eletrônica', xd, wDanfe, top + 25, 6.5)
  p.texto('0 - ENTRADA', xd + 8, top + 36, 6.5)
  p.texto('1 - SAÍDA', xd + 8, top + 44, 6.5)
  p.caixa(xd + wDanfe - 24, top + 36, 14, 14)
  p.centro(d.tipo, xd + wDanfe - 24, 14, top + 39, 9, true)
  p.centro(`Nº ${numeroNota(d.numero)}`, xd, wDanfe, top + 55, 8, true)
  p.centro(`SÉRIE ${d.serie.padStart(3, '0')}`, xd, wDanfe, top + 64, 7.5, true)
  p.centro(`FOLHA ${folha}/${folhas}`, xd, wDanfe, top + 72, 6.5)

  const xb = xd + wDanfe
  p.caixa(xb, top, wBarras, hTopo)
  p.barras(d.chave, xb + 4, top + 4, wBarras - 8, 30)
  p.caixa(xb, top + 38, wBarras, 18)
  p.texto('CHAVE DE ACESSO', xb + 2, top + 39.5, 5)
  p.centro(formatarChave(d.chave), xb, wBarras, top + 47, 7.5, true)
  p.centro('Consulta de autenticidade no portal nacional da NF-e', xb, wBarras, top + 60, 6)
  p.centro('www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora', xb, wBarras, top + 68, 6)
  top += hTopo

  p.campo('Natureza da operação', d.natureza, L, top, wEmit + wDanfe)
  p.campo('Protocolo de autorização de uso', d.protocolo ? `${d.protocolo} - ${data(d.recebidaEm)} ${hora(d.recebidaEm)}` : 'SEM PROTOCOLO', xb, top, wBarras)
  top += 18
  const w3 = W / 3
  p.campo('Inscrição estadual', d.emitente.ie, L, top, w3)
  p.campo('Inscrição estadual do subst. trib.', d.emitente.iest, L + w3, top, w3)
  p.campo('CNPJ / CPF', documento(d.emitente.cnpj), L + 2 * w3, top, w3)
  return top + 18 + 3
}

function blocoDestinatario(p: Pintor, d: DanfeDados, top: number): number {
  p.titulo('Destinatário / remetente', top)
  top += 8
  const de = d.destinatario.endereco
  p.campo('Nome / razão social', d.destinatario.nome, L, top, 340)
  p.campo('CNPJ / CPF', documento(d.destinatario.documento), L + 340, top, 120)
  p.campo('Data da emissão', data(d.emissao), L + 460, top, W - 460)
  top += 18
  p.campo('Endereço', de.logradouro, L, top, 270)
  p.campo('Bairro / distrito', de.bairro, L + 270, top, 130)
  p.campo('CEP', cep(de.cep), L + 400, top, 60)
  p.campo('Data da saída/entrada', data(d.saida), L + 460, top, W - 460)
  top += 18
  p.campo('Município', de.municipio, L, top, 230)
  p.campo('Fone / fax', de.fone, L + 230, top, 100)
  p.campo('UF', de.uf, L + 330, top, 30)
  p.campo('Inscrição estadual', d.destinatario.ie, L + 360, top, 100)
  p.campo('Hora da saída/entrada', hora(d.saida), L + 460, top, W - 460)
  return top + 18 + 3
}

function blocoImposto(p: Pintor, d: DanfeDados, top: number): number {
  p.titulo('Cálculo do imposto', top)
  top += 8
  const x = d.totais
  const linha1: [string, string][] = [
    ['Base de cálculo do ICMS', x.vBC], ['Valor do ICMS', x.vICMS], ['Base de cálc. ICMS S.T.', x.vBCST],
    ['Valor do ICMS subst.', x.vST], ['Valor aprox. tributos', x.vTotTrib], ['Valor total dos produtos', x.vProd],
  ]
  const linha2: [string, string][] = [
    ['Valor do frete', x.vFrete], ['Valor do seguro', x.vSeg], ['Desconto', x.vDesc],
    ['Outras despesas', x.vOutro], ['Valor total do IPI', x.vIPI], ['Valor total da nota', x.vNF],
  ]
  const w = W / 6
  linha1.forEach(([r, v], i) => p.campo(r, dinheiro(v), L + i * w, top, w, 18, 'dir'))
  top += 18
  linha2.forEach(([r, v], i) => p.campo(r, dinheiro(v), L + i * w, top, w, 18, 'dir', i === 5 ? 8.5 : 7.5))
  top += 18 + 3
  p.titulo('Transportador / volumes transportados', top)
  top += 8
  p.campo('Modalidade do frete', MOD_FRETE[d.modFrete] ?? d.modFrete, L, top, W)
  return top + 18 + 3
}

function cabecalhoItens(p: Pintor, top: number): number {
  p.titulo('Dados dos produtos / serviços', top)
  top += 8
  let x = L
  for (const c of COLUNAS) {
    p.caixa(x, top, c.w, 14, true)
    quebrar(p.f.normal, c.r.toUpperCase(), 5, c.w - 2).slice(0, 2).forEach((l, i) => p.centro(l, x, c.w, top + 2 + i * 5.5, 5))
    x += c.w
  }
  return top + 14
}

function linhaItem(p: Pintor, item: DanfeDados['itens'][number], linhas: string[], top: number): number {
  const h = Math.max(1, linhas.length) * 7 + 2
  const valores = [
    item.codigo, '', item.ncm, item.cst, item.cfop, item.unidade, quantidade(item.quantidade), unitario(item.unitario),
    dinheiro(item.total), item.vBC ? dinheiro(item.vBC) : '0,00', item.vICMS ? dinheiro(item.vICMS) : '0,00',
    item.vIPI ? dinheiro(item.vIPI) : '0,00', item.pICMS ? num(item.pICMS, 2) : '0,00', item.pIPI ? num(item.pIPI, 2) : '0,00',
  ]
  let x = L
  COLUNAS.forEach((c, i) => {
    p.page.drawLine({ start: { x, y: A4.height - top }, end: { x, y: A4.height - top - h }, thickness: 0.3, color: BLACK })
    if (i === 1) linhas.forEach((l, k) => p.texto(l, x + 1.5, top + 1.5 + k * 7, 6))
    else if (c.d) p.direita(caber(p.f.normal, valores[i], 6, c.w - 3), x + c.w - 1.5, top + 1.5, 6)
    else p.texto(valores[i], x + 1.5, top + 1.5, 6, false, c.w - 3)
    x += c.w
  })
  p.page.drawLine({ start: { x: R, y: A4.height - top }, end: { x: R, y: A4.height - top - h }, thickness: 0.3, color: BLACK })
  p.page.drawLine({ start: { x: L, y: A4.height - top - h }, end: { x: R, y: A4.height - top - h }, thickness: 0.3, color: BLACK })
  return top + h
}

const ALTURA_ADICIONAIS = 70

function blocoAdicionais(p: Pintor, d: DanfeDados, top: number) {
  p.titulo('Dados adicionais', top)
  top += 8
  const wInfo = W * 0.65
  p.caixa(L, top, wInfo, ALTURA_ADICIONAIS - 8)
  p.texto('INFORMAÇÕES COMPLEMENTARES', L + 2, top + 1.5, 5)
  const texto = [d.infAdFisco, d.infCpl].filter(Boolean).join(' ')
  quebrar(p.f.normal, texto, 6, wInfo - 4).slice(0, 8).forEach((l, i) => p.texto(l, L + 2, top + 8 + i * 6.5, 6))
  p.caixa(L + wInfo, top, W - wInfo, ALTURA_ADICIONAIS - 8)
  p.texto('RESERVADO AO FISCO', L + wInfo + 2, top + 1.5, 5)
}

function marcaDagua(page: PDFPage, f: PDFFont, texto: string) {
  const tam = 54
  const largura = f.widthOfTextAtSize(texto, tam)
  page.drawText(texto, { x: A4.width / 2 - (largura / 2) * Math.cos(Math.PI / 5), y: A4.height / 2 - (largura / 2) * Math.sin(Math.PI / 5), size: tam, font: f, color: MARCA, rotate: degrees(36) })
}

export async function renderDanfe(xmlNfeProc: string, options: DanfeOptions = {}): Promise<Uint8Array> {
  const d = lerNfeProc(xmlNfeProc)
  if (!/^\d{44}$/.test(d.chave)) throw new Error('chave de acesso ausente ou inválida no XML')
  const pdf = await PDFDocument.create()
  pdf.setTitle(`DANFE ${d.chave}`)
  pdf.setProducer('no.fiscal')
  const f: Fontes = { normal: await pdf.embedFont(StandardFonts.Helvetica), negrito: await pdf.embedFont(StandardFonts.HelveticaBold) }

  // Paginação: a primeira folha tem canhoto, destinatário, imposto e adicionais; as seguintes só cabeçalho e itens.
  const itens = d.itens.map((item) => ({ item, linhas: linhasDoItem(f.normal, item) }))
  const alturaItem = (n: number) => Math.max(1, n) * 7 + 2
  const folhas: (typeof itens)[] = []
  {
    // Medidas fixas (pontos): cabeçalho com canhoto ~ 188, sem ~ 146; destinatário 65; imposto+transporte 73; título+cabeçalho dos itens 22.
    const disponivelPrimeira = A4.height - M - 188 - 65 - 73 - 22 - ALTURA_ADICIONAIS - M
    const disponivelDemais = A4.height - M - 146 - 22 - M
    let atual: typeof itens = []
    let livre = disponivelPrimeira
    for (const it of itens) {
      const h = alturaItem(it.linhas.length)
      if (h > livre && atual.length) {
        folhas.push(atual)
        atual = []
        livre = disponivelDemais
      }
      atual.push(it)
      livre -= h
    }
    folhas.push(atual)
  }

  folhas.forEach((lista, i) => {
    const page = pdf.addPage([A4.width, A4.height])
    const p = new Pintor(page, f)
    let top = cabecalho(p, d, i + 1, folhas.length, i === 0)
    if (i === 0) {
      top = blocoDestinatario(p, d, top)
      top = blocoImposto(p, d, top)
    }
    top = cabecalhoItens(p, top)
    for (const { item, linhas } of lista) top = linhaItem(p, item, linhas, top)
    if (i === 0) blocoAdicionais(p, d, A4.height - M - ALTURA_ADICIONAIS)
    if (d.ambiente === '2') marcaDagua(page, f.negrito, 'SEM VALOR FISCAL')
    if (options.cancelada) marcaDagua(page, f.negrito, 'CANCELADA')
  })
  return pdf.save()
}

