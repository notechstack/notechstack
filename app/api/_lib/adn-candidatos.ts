// Notas do ADN → candidatos (critério 19): um por documento de tomador, com os dados da nota mais
// recente (`dhEmi` da DPS; sem ele, `dhProc`). Tudo passa pelo contrato do candidato.
import { candidatoValidado, type Candidato } from './ia/candidato.js'
import type { NfseData } from './nfse-xml.js'

const instante = (nota: NfseData) => {
  const t = Date.parse(nota.dps.dhEmi ?? nota.dhProc ?? '')
  return Number.isNaN(t) ? 0 : t
}

export function candidatosDoAdn(notas: NfseData[]): Candidato[] {
  const ultima = new Map<string, NfseData>()
  for (const nota of notas) {
    const documento = nota.dps.tomador?.CNPJ ?? nota.dps.tomador?.CPF
    if (!documento) continue
    const atual = ultima.get(documento)
    if (!atual || instante(nota) >= instante(atual)) ultima.set(documento, nota)
  }
  return [...ultima.values()]
    .sort((a, b) => instante(b) - instante(a))
    .map((nota) => {
      const tomador = nota.dps.tomador
      const end = tomador?.endereco
      return candidatoValidado(
        {
          tomador_documento: tomador?.CNPJ ?? tomador?.CPF,
          tomador_nome: tomador?.xNome,
          tomador_email: tomador?.email,
          tomador_endereco: end
            ? {
                logradouro: end.xLgr,
                numero: end.nro,
                complemento: end.xCpl,
                bairro: end.xBairro,
                codigo_municipio: end.cMun,
                uf: end.UF,
                cep: end.CEP,
              }
            : null,
          codigo_servico_nacional: nota.dps.cTribNac,
          descricao: nota.dps.xDescServ,
          valor_padrao: nota.dps.vServ,
        },
        'importacao_adn',
      )
    })
}
