// Validação da DPS contra os XSD oficiais da NFS-e Nacional (libxml2 em WebAssembly, sem rede).
// Pacotes copiados de gov.br/nfse em 17/11/2026:
// - producao-v1.01-20260209: nfse-esquemas_xsd-v1-01-20260209.zip (Documentação Atual; leiaute de produção).
// - producao-restrita-20261020: esquemas_prod_restrita_20261020.zip (NT 009, release 1; produção a partir de 01/12/2026).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateXML } from 'xmllint-wasm'

export type PacoteXsd = 'producao-v1.01-20260209' | 'producao-restrita-20261020'

const ARQUIVOS = ['tiposComplexos_v1.01.xsd', 'tiposSimples_v1.01.xsd', 'xmldsig-core-schema.xsd']

function ler(pacote: PacoteXsd, arquivo: string): string {
  const texto = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'xsd', pacote, arquivo), 'utf8')
  // O XSD de produção escreve a série como `^0{0,4}\d{1,5}$`. Em XML Schema `^` e `$` são literais
  // (o libxml2 recusa "1"); o validador da Sefin os trata como âncoras, e a série "1" é aceita em
  // produção. O pacote da produção restrita usa `[0-9]{1,4}|[0-8][0-9]{4}`. O arquivo em disco fica como baixado.
  return texto.replace('<xs:pattern value="^0{0,4}\\d{1,5}$"/>', '<xs:pattern value="0{0,4}\\d{1,5}"/>')
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
