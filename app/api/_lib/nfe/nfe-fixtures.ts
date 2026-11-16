// Notas de exemplo dos testes da NF-e: emitente em Bragança Paulista/SP (Simples Nacional), destinatário em SP e em
// outras UFs. Documentos fictícios com dígito verificador válido.
import type { Db } from '../db.js'
import type { HttpRequest, HttpResponse } from '../sefin-client.js'
import { conferirEmpresaNfe } from './conferencia.js'
import type { NfeInput } from './nfe-builder.js'
import { criarSefazClient } from './sefaz-client.js'

export const EMITENTE_SP: NfeInput['emitente'] = {
  cnpj: '12.345.678/0001-95',
  razaoSocial: 'Comercio Exemplo Braganca Ltda',
  nomeFantasia: 'Exemplo',
  inscricaoEstadual: '222.333.444.555',
  crt: '1',
  endereco: {
    logradouro: 'Rua Coronel Teofilo Leme',
    numero: '100',
    bairro: 'Centro',
    codigoMunicipio: '3507605',
    uf: 'SP',
    cep: '12900-000',
    fone: '(11) 4033-0000',
  },
}

export function notaExemplo(over: Partial<NfeInput> = {}): NfeInput {
  return {
    ambiente: 'homologacao',
    emitente: EMITENTE_SP,
    destinatario: {
      documento: '11.222.333/0001-81',
      nome: 'Padaria Exemplo Ltda',
      indicadorIE: '9',
      email: 'financeiro@padaria-exemplo.com.br',
      endereco: {
        logradouro: 'Av. Paulista',
        numero: '1000',
        complemento: 'Sala 1',
        bairro: 'Bela Vista',
        codigoMunicipio: '3550308',
        uf: 'SP',
        cep: '01310-100',
      },
    },
    itens: [
      { codigo: 'P001', descricao: 'Farinha de trigo 5kg', ncm: '1101.00.10', cfop: '5102', unidade: 'UN', quantidade: 3, valorUnitario: 19.9, csosn: '102' },
      { codigo: 'P002', descricao: 'Fermento biologico 500g', ncm: '2102.10.00', cfop: '5102', unidade: 'PCT', quantidade: 2.5, valorUnitario: 12.345, csosn: '101', aliquotaCreditoSN: 1.25, desconto: 1 },
    ],
    serie: 1,
    numero: 42,
    emissao: new Date('2026-11-16T15:30:00Z'),
    pagamentos: [{ forma: '17', valor: 100 }],
    informacoesComplementares: 'Documento emitido por ME ou EPP optante pelo Simples Nacional.',
    responsavelTecnico: { cnpj: '11.222.333/0001-81', contato: 'Suporte no.fiscal', email: 'suporte@exemplo.com.br', fone: '11999990000' },
    codigoNumerico: '12345678',
    ...over,
  }
}

const NS = 'http://www.portalfiscal.inf.br/nfe'

/** Sefaz dublê da conferência: cadastro com a IE pedida, habilitada e credenciada; nota de teste autorizada. */
export function sefazQueAprova(ie: string) {
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const body = req.body ?? ''
    if (body.includes('<ConsCad')) {
      const cnpj = /<CNPJ>(\d{14})<\/CNPJ>/.exec(body)?.[1] ?? ''
      return { status: 200, body: `<r><retConsCad xmlns="${NS}"><infCons><cStat>111</cStat><xMotivo>ok</xMotivo><infCad><IE>${ie}</IE><CNPJ>${cnpj}</CNPJ><cSit>1</cSit><indCredNFe>1</indCredNFe></infCad></infCons></retConsCad></r>` }
    }
    const chave = /Id="NFe(\d{44})"/.exec(body)?.[1] ?? ''
    return { status: 200, body: `<r><retEnviNFe xmlns="${NS}"><cStat>104</cStat><xMotivo>ok</xMotivo><protNFe><infProt><chNFe>${chave}</chNFe><nProt>135260000000001</nProt><cStat>100</cStat><xMotivo>Autorizado</xMotivo></infProt></protNFe></retEnviNFe></r>` }
  }
  return criarSefazClient({ transport })
}

/** Passa a empresa na conferência de NF-e (testes que só precisam dela pronta). */
export async function aprovarConferencia(db: Db, tenantId: string, ie: string): Promise<void> {
  const r = await conferirEmpresaNfe({ db, sefaz: sefazQueAprova(ie), now: () => new Date(), esperarMs: 1 }, tenantId)
  if (r.status !== 'aprovada') throw new Error(`conferência não aprovada: ${r.codigo} ${r.motivo}`)
}
