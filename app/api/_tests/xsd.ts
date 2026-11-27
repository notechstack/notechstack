// Validação da DPS contra os XSD oficiais da NFS-e Nacional (libxml2 em WebAssembly, sem rede).
// Pacotes copiados de gov.br/nfse em 17/11/2026:
// - producao-v1.01-20260209: nfse-esquemas_xsd-v1-01-20260209.zip (Documentação Atual; leiaute de produção).
// - producao-restrita-20261020: esquemas_prod_restrita_20261020.zip (NT 009, release 1).
// - producao-restrita-20261124: esquemas-xsd-producao-restrita-20261124.zip (NT 009, release 2: indDest em infDPS),
//   baixado em 26/11/2026. Releases 1 e 2 vão à produção em 07/12/2026 (cronograma da CGNFS-e de 25/11/2026).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateXML } from 'xmllint-wasm'

export type PacoteXsd = 'producao-v1.01-20260209' | 'producao-restrita-20261020' | 'producao-restrita-20261124'

const ARQUIVOS = ['tiposComplexos_v1.01.xsd', 'tiposSimples_v1.01.xsd', 'xmldsig-core-schema.xsd']

function ler(pacote: PacoteXsd, arquivo: string): string {
  const texto = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'xsd', pacote, arquivo), 'utf8')
  // O XSD de produção escreve a série como `^0{0,4}\d{1,5}$`. Em XML Schema `^` e `$` são literais
  // (o libxml2 recusa "1"); o validador da Sefin os trata como âncoras, e a série "1" é aceita em
  // produção. O pacote da produção restrita usa `[0-9]{1,4}|[0-8][0-9]{4}`. O arquivo em disco fica como baixado.
  return texto.replace('<xs:pattern value="^0{0,4}\\d{1,5}$"/>', '<xs:pattern value="0{0,4}\\d{1,5}"/>')
}

/**
 * O pacote do leiaute em que a DPS foi montada: sem `finNFSe`, produção (v1.01); com `indDest` logo depois de `toma`
 * (ou de `prest`, na nota sem tomador),
 * o release 2 da NT 009; senão, o release 1.
 */
export function pacoteDaDps(xml: string): PacoteXsd {
  if (!xml.includes('<finNFSe>')) return 'producao-v1.01-20260209'
  return /<\/(toma|prest)><indDest>/.test(xml) ? 'producao-restrita-20261124' : 'producao-restrita-20261020'
}

/** Lista de erros do xmllint (vazia = válido). */
export async function errosXsd(xml: string, pacote: PacoteXsd): Promise<string[]> {
  const resultado = await validateXML({
    xml: [{ fileName: 'dps.xml', contents: xml }],
    schema: [{ fileName: 'DPS_v1.01.xsd', contents: ler(pacote, 'DPS_v1.01.xsd') }],
    preload: ARQUIVOS.map((fileName) => ({ fileName, contents: ler(pacote, fileName) })),
  })
  return resultado.errors.map((e) => e.message)
}

// NF-e modelo 55: Pacote de Liberação 010h v1.03 (Portal Nacional da NF-e, pl010h.zip), pasta NFe, como baixado.
const PASTA_NFE = 'nfe-pl010h-v1.03'
const ARQUIVOS_NFE = ['leiauteNFe_v4.00.xsd', 'tiposBasico_v4.00.xsd', 'DFeTiposBasicos_v1.00.xsd', 'xmldsig-core-schema_v1.01.xsd']

/** Erros do xmllint para uma <NFe> assinada contra o nfe_v4.00.xsd (vazia = válida). */
export async function errosXsdNfe(xml: string): Promise<string[]> {
  const lerNfe = (arquivo: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'xsd', PASTA_NFE, arquivo), 'utf8')
  const resultado = await validateXML({
    xml: [{ fileName: 'nfe.xml', contents: xml }],
    schema: [{ fileName: 'nfe_v4.00.xsd', contents: lerNfe('nfe_v4.00.xsd') }],
    preload: ARQUIVOS_NFE.map((fileName) => ({ fileName, contents: lerNfe(fileName) })),
  })
  return resultado.errors.map((e) => e.message)
}
