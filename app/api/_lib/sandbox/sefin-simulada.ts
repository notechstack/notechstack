// NFS-e simulada: o que a Sefin Nacional devolveria para uma DPS, no formato do exemplo real da open-nfse
// (`specs/samples`). Nasceu no dublê dos testes (`_tests/sefin-fake.ts`) e virou código de produção para o sandbox da
// API do parceiro (19/11/2026), que monta a DPS de verdade (`buildDps`) e precisa de uma chave e de um XML plausíveis
// sem falar com a Sefin. Sempre ambiente de produção restrita (`ambGer` 2, `tpAmb` 2 na DPS): o DANFSe sai com a
// tarja "NFS-e SEM VALIDADE JURÍDICA".
import { randomInt } from 'node:crypto'

export const NFSE_NS = 'http://www.sped.fazenda.gov.br/nfse'

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? ''

const escapar = (texto: string) => texto.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Chave de acesso de 50 dígitos no formato da Sefin: município emissor (7), ambiente gerador, tipo de inscrição,
 * CNPJ (14), número da NFS-e (13), ano e mês (AAMM), código numérico (9) e DV. O DV aqui é sempre 0 (simulado).
 */
export function chaveSimulada(dpsXml: string, nNFSe: number, ambGer = '2'): string {
  const cnpj = tag(dpsXml, 'CNPJ')
  const mun = tag(dpsXml, 'cLocEmi')
  const aamm = tag(dpsXml, 'dCompet').slice(2, 7).replace('-', '')
  const aleatorio = String(randomInt(0, 1_000_000_000)).padStart(9, '0')
  return `${mun}${ambGer}2${cnpj}${String(nNFSe).padStart(13, '0')}${aamm}${aleatorio}0`
}

export type EmitenteSimulado = {
  nome: string
  /** Nome do município emissor (`xLocEmi`, `xLocPrestacao`, `xLocIncid`). */
  municipio: string
  /** IBGE do município de incidência (`cLocIncid`). */
  codigoMunicipio: string
  uf: string
}

/** O emitente do exemplo da open-nfse, usado pelos testes que não dizem outro. */
export const EMITENTE_DE_EXEMPLO: EmitenteSimulado = { nome: 'PRIMECARE SERVICOS MEDICOS LTDA', municipio: 'São Paulo', codigoMunicipio: '3550308', uf: 'SP' }

/** NFS-e com a DPS (assinada ou não) dentro, como a Sefin devolve. */
export function nfseSimulada(input: {
  dpsXml: string
  chave: string
  nNFSe: number
  dhProc?: string
  emitente?: EmitenteSimulado
}): string {
  const dps = input.dpsXml.replace(/^<\?xml[^>]*\?>/, '')
  const valor = tag(dps, 'vServ')
  const e = input.emitente ?? EMITENTE_DE_EXEMPLO
  const mun = escapar(e.municipio)
  return (
    `<NFSe xmlns="${NFSE_NS}" versao="1.01"><infNFSe Id="NFS${input.chave}">` +
    `<xLocEmi>${mun}</xLocEmi><xLocPrestacao>${mun}</xLocPrestacao><nNFSe>${input.nNFSe}</nNFSe>` +
    `<cLocIncid>${e.codigoMunicipio}</cLocIncid><xLocIncid>${mun}</xLocIncid>` +
    `<xTribNac>Medicina.</xTribNac><verAplic>SefinNacional_1.6.0</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis>` +
    `<procEmi>1</procEmi><cStat>100</cStat><dhProc>${input.dhProc ?? '2026-11-03T10:15:00-03:00'}</dhProc><nDFSe>987654</nDFSe>` +
    `<emit><CNPJ>${tag(dps, 'CNPJ')}</CNPJ><xNome>${escapar(e.nome)}</xNome>` +
    `<enderNac><xLgr>AVENIDA PAULISTA</xLgr><nro>1000</nro><xBairro>BELA VISTA</xBairro><cMun>${e.codigoMunicipio}</cMun><UF>${e.uf}</UF><CEP>01310100</CEP></enderNac>` +
    // Contato do exemplo só no exemplo: no sandbox, a NFS-e não inventa telefone nem e-mail da empresa.
    (input.emitente ? '' : `<fone>11999990000</fone><email>financeiro@primecare.test</email>`) +
    `</emit>` +
    `<valores><vLiq>${valor}</vLiq></valores>${dps}</infNFSe></NFSe>`
  )
}

/** Evento de cancelamento (e101101) registrado, como a Sefin devolve. */
export function eventoCancelamentoSimulado(chave: string, pedidoXml = ''): string {
  return `<evento xmlns="${NFSE_NS}" versao="1.01"><infEvento Id="EVT${chave}101101001"><nSeqEvento>1</nSeqEvento>${pedidoXml}</infEvento></evento>`
}
