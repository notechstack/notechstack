// Leitura do XML da NFS-e devolvido pela Sefin (`xml_nfse`) para o DANFSe. A NT 008 §2.1 manda
// imprimir só o que consta do XML da NFS-e emitida, então tudo aqui sai dele, por nome local
// de elemento (o XML traz o namespace nacional e a DPS embutida, com o mesmo namespace).
import { DOMParser } from '@xmldom/xmldom'

export type Endereco = {
  xLgr: string | null
  nro: string | null
  xCpl: string | null
  xBairro: string | null
  cMun: string | null
  UF: string | null
  CEP: string | null
}

export type Pessoa = {
  CNPJ: string | null
  CPF: string | null
  IM: string | null
  xNome: string | null
  fone: string | null
  email: string | null
  endereco: Endereco | null
}

export type NfseData = {
  chaveAcesso: string
  nNFSe: string | null
  dhProc: string | null
  xLocEmi: string | null
  xLocPrestacao: string | null
  xLocIncid: string | null
  xTribNac: string | null
  xTribMun: string | null
  xNBS: string | null
  ambGer: string | null
  cStat: string | null
  emitente: Pessoa
  valoresNfse: { vBC: string | null; pAliqAplic: string | null; vISSQN: string | null; vTotalRet: string | null; vLiq: string | null }
  dps: {
    tpAmb: string | null
    dhEmi: string | null
    serie: string | null
    nDPS: string | null
    dCompet: string | null
    tpEmit: string | null
    prestador: Pessoa & { opSimpNac: string | null; regApTribSN: string | null; regEspTrib: string | null }
    tomador: Pessoa | null
    cTribNac: string | null
    cTribMun: string | null
    cNBS: string | null
    xDescServ: string | null
    vServ: string | null
    vDescIncond: string | null
    vDescCond: string | null
    tribISSQN: string | null
    tpRetISSQN: string | null
    /** `trib/tribFed` (opcional): retenções federais e PIS/COFINS próprios. */
    tribFed: TribFed | null
    pTotTribSN: string | null
    pTotTrib: { fed: string | null; est: string | null; mun: string | null } | null
    vTotTrib: { fed: string | null; est: string | null; mun: string | null } | null
    xInfComp: string | null
    /** `IBSCBS` da DPS (NT 009): classificação e, na locação, o imóvel ou os bens móveis. */
    ibscbs: IbsCbsDps | null
  }
  /** `infNFSe/IBSCBS`: o que a Sefin calculou de IBS e CBS (só quando a DPS levou o grupo). */
  ibscbsNfse: { xLocalidadeIncid: string | null; vBC: string | null; vIBSTot: string | null; vCBS: string | null; vTotNF: string | null } | null
}

export type ImovelDps = {
  cMun: string | null
  pCopropriedade: string | null
  vTotOper: string | null
  dVencOrig: string | null
  unidades: { inscImobFisc: string | null; cCIB: string | null; endereco: Endereco | null }[]
}

export type IbsCbsDps = {
  cIndOp: string | null
  CST: string | null
  cClassTrib: string | null
  imovel: ImovelDps | null
  bensMoveis: { cNCMBemMovel: string | null; xNCMBemMovel: string | null; qtdNCMBemMovel: string | null }[]
}

export type TribFed = {
  vRetCP: string | null
  vRetIRRF: string | null
  vRetCSLL: string | null
  piscofins: {
    CST: string | null
    vBCPisCofins: string | null
    pAliqPis: string | null
    pAliqCofins: string | null
    vPis: string | null
    vCofins: string | null
    tpRetPisCofins: string | null
  } | null
}

export class NfseXmlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NfseXmlError'
  }
}

type El = Element

function children(parent: El | null, name: string): El[] {
  if (!parent) return []
  return Array.from(parent.childNodes).filter((n): n is El => n.nodeType === 1 && (n as El).localName === name)
}

function child(parent: El | null, ...path: string[]): El | null {
  let current: El | null = parent
  for (const name of path) {
    current = children(current, name)[0] ?? null
    if (!current) return null
  }
  return current
}

function text(parent: El | null, ...path: string[]): string | null {
  const node = child(parent, ...path)
  const value = node?.textContent?.trim()
  return value ? value : null
}

function endereco(parent: El | null): Endereco | null {
  // NFS-e: emit/enderNac; DPS: prest|toma/end/{endNac{cMun,CEP}, xLgr, nro, xCpl, xBairro}.
  const enderNac = child(parent, 'enderNac')
  if (enderNac) {
    return {
      xLgr: text(enderNac, 'xLgr'),
      nro: text(enderNac, 'nro'),
      xCpl: text(enderNac, 'xCpl'),
      xBairro: text(enderNac, 'xBairro'),
      cMun: text(enderNac, 'cMun'),
      UF: text(enderNac, 'UF'),
      CEP: text(enderNac, 'CEP'),
    }
  }
  const end = child(parent, 'end')
  if (!end) return null
  return {
    xLgr: text(end, 'xLgr'),
    nro: text(end, 'nro'),
    xCpl: text(end, 'xCpl'),
    xBairro: text(end, 'xBairro'),
    cMun: text(end, 'endNac', 'cMun'),
    UF: null,
    CEP: text(end, 'endNac', 'CEP'),
  }
}

function pessoa(node: El | null): Pessoa {
  return {
    CNPJ: text(node, 'CNPJ'),
    CPF: text(node, 'CPF'),
    IM: text(node, 'IM'),
    xNome: text(node, 'xNome'),
    fone: text(node, 'fone'),
    email: text(node, 'email'),
    endereco: endereco(node),
  }
}

function tribFed(node: El | null): TribFed | null {
  if (!node) return null
  const pc = child(node, 'piscofins')
  return {
    vRetCP: text(node, 'vRetCP'),
    vRetIRRF: text(node, 'vRetIRRF'),
    vRetCSLL: text(node, 'vRetCSLL'),
    piscofins: pc
      ? {
          CST: text(pc, 'CST'),
          vBCPisCofins: text(pc, 'vBCPisCofins'),
          pAliqPis: text(pc, 'pAliqPis'),
          pAliqCofins: text(pc, 'pAliqCofins'),
          vPis: text(pc, 'vPis'),
          vCofins: text(pc, 'vCofins'),
          tpRetPisCofins: text(pc, 'tpRetPisCofins'),
        }
      : null,
  }
}

function ibscbsDps(node: El | null): IbsCbsDps | null {
  if (!node) return null
  const trib = child(node, 'valores', 'trib')
  const imovel = child(node, 'imovel')
  return {
    cIndOp: text(node, 'cIndOp'),
    // NT 009: CST/cClassTrib direto em trib; NT 004: dentro de trib/gIBSCBS.
    CST: text(trib, 'CST') ?? text(trib, 'gIBSCBS', 'CST'),
    cClassTrib: text(trib, 'cClassTrib') ?? text(trib, 'gIBSCBS', 'cClassTrib'),
    imovel: imovel
      ? {
          cMun: text(imovel, 'cMun'),
          pCopropriedade: text(imovel, 'gLocacao', 'pCopropriedade'),
          vTotOper: text(imovel, 'gLocacao', 'vTotOper'),
          dVencOrig: text(imovel, 'gLocacao', 'dVencOrig'),
          unidades: children(imovel, 'gUnidImob').map((u) => {
            const end = child(u, 'end')
            return {
              inscImobFisc: text(u, 'inscImobFisc'),
              cCIB: text(u, 'cCIB'),
              endereco: end
                ? { xLgr: text(end, 'xLgr'), nro: text(end, 'nro'), xCpl: text(end, 'xCpl'), xBairro: text(end, 'xBairro'), cMun: null, UF: null, CEP: text(end, 'CEP') }
                : null,
            }
          }),
        }
      : null,
    bensMoveis: children(node, 'bensMoveis').map((b) => ({
      cNCMBemMovel: text(b, 'cNCMBemMovel'),
      xNCMBemMovel: text(b, 'xNCMBemMovel'),
      qtdNCMBemMovel: text(b, 'qtdNCMBemMovel'),
    })),
  }
}

export function parseNfseXml(xml: string): NfseData {
  const errors: string[] = []
  const doc = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: (message: string) => errors.push(message),
      fatalError: (message: string) => errors.push(message),
    },
  }).parseFromString(xml, 'text/xml')
  const root = doc.documentElement as El | null
  if (errors.length || !root || root.localName !== 'NFSe') throw new NfseXmlError('XML da NFS-e ilegível')
  const inf = child(root, 'infNFSe')
  const id = inf?.getAttribute('Id') ?? ''
  const chaveAcesso = id.replace(/^NFS/, '')
  if (!inf || !/^\d{50}$/.test(chaveAcesso)) throw new NfseXmlError('infNFSe sem Id com a chave de acesso')

  const infDps = child(inf, 'DPS', 'infDPS')
  const prest = child(infDps, 'prest')
  const toma = child(infDps, 'toma')
  const valoresDps = child(infDps, 'valores')
  const totTrib = child(valoresDps, 'trib', 'totTrib')
  const triple = (node: El | null, prefix: 'p' | 'v') =>
    node
      ? { fed: text(node, `${prefix}TotTribFed`), est: text(node, `${prefix}TotTribEst`), mun: text(node, `${prefix}TotTribMun`) }
      : null

  return {
    chaveAcesso,
    nNFSe: text(inf, 'nNFSe'),
    dhProc: text(inf, 'dhProc'),
    xLocEmi: text(inf, 'xLocEmi'),
    xLocPrestacao: text(inf, 'xLocPrestacao'),
    xLocIncid: text(inf, 'xLocIncid'),
    xTribNac: text(inf, 'xTribNac'),
    xTribMun: text(inf, 'xTribMun'),
    xNBS: text(inf, 'xNBS'),
    ambGer: text(inf, 'ambGer'),
    cStat: text(inf, 'cStat'),
    emitente: pessoa(child(inf, 'emit')),
    valoresNfse: {
      vBC: text(inf, 'valores', 'vBC'),
      pAliqAplic: text(inf, 'valores', 'pAliqAplic'),
      vISSQN: text(inf, 'valores', 'vISSQN'),
      vTotalRet: text(inf, 'valores', 'vTotalRet'),
      vLiq: text(inf, 'valores', 'vLiq'),
    },
    dps: {
      tpAmb: text(infDps, 'tpAmb'),
      dhEmi: text(infDps, 'dhEmi'),
      serie: text(infDps, 'serie'),
      nDPS: text(infDps, 'nDPS'),
      dCompet: text(infDps, 'dCompet'),
      tpEmit: text(infDps, 'tpEmit'),
      prestador: {
        ...pessoa(prest),
        opSimpNac: text(prest, 'regTrib', 'opSimpNac'),
        regApTribSN: text(prest, 'regTrib', 'regApTribSN'),
        regEspTrib: text(prest, 'regTrib', 'regEspTrib'),
      },
      tomador: toma ? pessoa(toma) : null,
      cTribNac: text(infDps, 'serv', 'cServ', 'cTribNac'),
      cTribMun: text(infDps, 'serv', 'cServ', 'cTribMun'),
      cNBS: text(infDps, 'serv', 'cServ', 'cNBS'),
      xDescServ: child(infDps, 'serv', 'cServ', 'xDescServ')?.textContent ?? null,
      vServ: text(valoresDps, 'vServPrest', 'vServ'),
      vDescIncond: text(valoresDps, 'vDescCondIncond', 'vDescIncond'),
      vDescCond: text(valoresDps, 'vDescCondIncond', 'vDescCond'),
      tribISSQN: text(valoresDps, 'trib', 'tribMun', 'tribISSQN'),
      tpRetISSQN: text(valoresDps, 'trib', 'tribMun', 'tpRetISSQN'),
      tribFed: tribFed(child(valoresDps, 'trib', 'tribFed')),
      pTotTribSN: text(totTrib, 'pTotTribSN'),
      pTotTrib: triple(child(totTrib, 'pTotTrib'), 'p'),
      vTotTrib: triple(child(totTrib, 'vTotTrib'), 'v'),
      // Leiaute 1.01: serv/infoCompl/xInfComp (o caminho infAdic não existe no XSD; fica só por compatibilidade).
      xInfComp: text(infDps, 'serv', 'infoCompl', 'xInfComp') ?? text(infDps, 'infAdic', 'xInfComp'),
      ibscbs: ibscbsDps(child(infDps, 'IBSCBS')),
    },
    ibscbsNfse: child(inf, 'IBSCBS')
      ? {
          xLocalidadeIncid: text(inf, 'IBSCBS', 'xLocalidadeIncid'),
          vBC: text(inf, 'IBSCBS', 'valores', 'vBC'),
          vIBSTot: text(inf, 'IBSCBS', 'totCIBS', 'gIBS', 'vIBSTot'),
          vCBS: text(inf, 'IBSCBS', 'totCIBS', 'gCBS', 'vCBS'),
          vTotNF: text(inf, 'IBSCBS', 'totCIBS', 'vTotNF'),
        }
      : null,
  }
}
