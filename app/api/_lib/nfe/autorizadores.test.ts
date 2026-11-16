import { describe, expect, it } from 'vitest'
import {
  AUTORIZADOR_DA_UF,
  CODIGO_UF,
  CONTINGENCIA_DA_UF,
  destino,
  destinoCadastro,
  ServicoIndisponivel,
  UFS,
  URLS,
  type AmbienteNfe,
  type Autorizador,
  type ServicoNfe,
} from './autorizadores.js'

// Captura literal da "Relação de Serviços Web" do Portal Nacional da NF-e em 16/11/2026 (sem "?wsdl").
const SERVICO: Record<string, ServicoNfe> = {
  NfeStatusServico: 'status',
  NFeAutorizacao: 'autorizacao',
  NFeRetAutorizacao: 'retAutorizacao',
  NfeConsultaProtocolo: 'consultaProtocolo',
  NfeInutilizacao: 'inutilizacao',
  RecepcaoEvento: 'evento',
}

const PRODUCAO = `
AM NfeInutilizacao https://nfe.sefaz.am.gov.br/services2/services/NfeInutilizacao4
AM NfeConsultaProtocolo https://nfe.sefaz.am.gov.br/services2/services/NfeConsulta4
AM NfeStatusServico https://nfe.sefaz.am.gov.br/services2/services/NfeStatusServico4
AM RecepcaoEvento https://nfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4
AM NFeAutorizacao https://nfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4
AM NFeRetAutorizacao https://nfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4
BA NfeInutilizacao https://nfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx
BA NfeConsultaProtocolo https://nfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx
BA NfeStatusServico https://nfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx
BA RecepcaoEvento https://nfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx
BA NFeAutorizacao https://nfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx
BA NFeRetAutorizacao https://nfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx
GO NfeInutilizacao https://nfe.sefaz.go.gov.br/nfe/services/NFeInutilizacao4
GO NfeConsultaProtocolo https://nfe.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4
GO NfeStatusServico https://nfe.sefaz.go.gov.br/nfe/services/NFeStatusServico4
GO RecepcaoEvento https://nfe.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4
GO NFeAutorizacao https://nfe.sefaz.go.gov.br/nfe/services/NFeAutorizacao4
GO NFeRetAutorizacao https://nfe.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4
MG NfeInutilizacao https://nfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4
MG NfeConsultaProtocolo https://nfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4
MG NfeStatusServico https://nfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4
MG RecepcaoEvento https://nfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4
MG NFeAutorizacao https://nfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4
MG NFeRetAutorizacao https://nfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4
MS NfeInutilizacao https://nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4
MS NfeConsultaProtocolo https://nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4
MS NfeStatusServico https://nfe.sefaz.ms.gov.br/ws/NFeStatusServico4
MS RecepcaoEvento https://nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4
MS NFeAutorizacao https://nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4
MS NFeRetAutorizacao https://nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4
MT NfeInutilizacao https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4
MT NfeConsultaProtocolo https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4
MT NfeStatusServico https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4
MT RecepcaoEvento https://nfe.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4
MT NFeAutorizacao https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4
MT NFeRetAutorizacao https://nfe.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4
PE NfeInutilizacao https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeInutilizacao4
PE NfeConsultaProtocolo https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4
PE NfeStatusServico https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4
PE RecepcaoEvento https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4
PE NFeAutorizacao https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4
PE NFeRetAutorizacao https://nfe.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4
PR NfeInutilizacao https://nfe.sefa.pr.gov.br/nfe/NFeInutilizacao4
PR NfeConsultaProtocolo https://nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4
PR NfeStatusServico https://nfe.sefa.pr.gov.br/nfe/NFeStatusServico4
PR RecepcaoEvento https://nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4
PR NFeAutorizacao https://nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4
PR NFeRetAutorizacao https://nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4
RS NfeInutilizacao https://nfe.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx
RS NfeConsultaProtocolo https://nfe.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx
RS NfeStatusServico https://nfe.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx
RS RecepcaoEvento https://nfe.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx
RS NFeAutorizacao https://nfe.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx
RS NFeRetAutorizacao https://nfe.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx
SP NfeInutilizacao https://nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx
SP NfeConsultaProtocolo https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx
SP NfeStatusServico https://nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx
SP RecepcaoEvento https://nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx
SP NFeAutorizacao https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx
SP NFeRetAutorizacao https://nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx
SVAN NfeInutilizacao https://www.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx
SVAN NfeConsultaProtocolo https://www.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx
SVAN NfeStatusServico https://www.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx
SVAN RecepcaoEvento https://www.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx
SVAN NFeAutorizacao https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx
SVAN NFeRetAutorizacao https://www.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx
SVRS NfeInutilizacao https://nfe.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx
SVRS NfeConsultaProtocolo https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx
SVRS NfeStatusServico https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx
SVRS RecepcaoEvento https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx
SVRS NFeAutorizacao https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx
SVRS NFeRetAutorizacao https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx
SVC-AN NfeInutilizacao https://www.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx
SVC-AN NfeConsultaProtocolo https://www.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx
SVC-AN NfeStatusServico https://www.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx
SVC-AN RecepcaoEvento https://www.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx
SVC-AN NFeAutorizacao https://www.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx
SVC-AN NFeRetAutorizacao https://www.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx
SVC-RS NfeConsultaProtocolo https://nfe.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx
SVC-RS NfeStatusServico https://nfe.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx
SVC-RS RecepcaoEvento https://nfe.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx
SVC-RS NFeAutorizacao https://nfe.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx
SVC-RS NFeRetAutorizacao https://nfe.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx
`

const HOMOLOGACAO = `
AM NfeInutilizacao https://homnfe.sefaz.am.gov.br/services2/services/NfeInutilizacao4
AM NfeConsultaProtocolo https://homnfe.sefaz.am.gov.br/services2/services/NfeConsulta4
AM NfeStatusServico https://homnfe.sefaz.am.gov.br/services2/services/NfeStatusServico4
AM RecepcaoEvento https://homnfe.sefaz.am.gov.br/services2/services/RecepcaoEvento4
AM NFeAutorizacao https://homnfe.sefaz.am.gov.br/services2/services/NfeAutorizacao4
AM NFeRetAutorizacao https://homnfe.sefaz.am.gov.br/services2/services/NfeRetAutorizacao4
BA NfeInutilizacao https://hnfe.sefaz.ba.gov.br/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx
BA NfeConsultaProtocolo https://hnfe.sefaz.ba.gov.br/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx
BA NfeStatusServico https://hnfe.sefaz.ba.gov.br/webservices/NFeStatusServico4/NFeStatusServico4.asmx
BA RecepcaoEvento https://hnfe.sefaz.ba.gov.br/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx
BA NFeAutorizacao https://hnfe.sefaz.ba.gov.br/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx
BA NFeRetAutorizacao https://hnfe.sefaz.ba.gov.br/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx
GO NfeInutilizacao https://homolog.sefaz.go.gov.br/nfe/services/NFeInutilizacao4
GO NfeConsultaProtocolo https://homolog.sefaz.go.gov.br/nfe/services/NFeConsultaProtocolo4
GO NfeStatusServico https://homolog.sefaz.go.gov.br/nfe/services/NFeStatusServico4
GO RecepcaoEvento https://homolog.sefaz.go.gov.br/nfe/services/NFeRecepcaoEvento4
GO NFeAutorizacao https://homolog.sefaz.go.gov.br/nfe/services/NFeAutorizacao4
GO NFeRetAutorizacao https://homolog.sefaz.go.gov.br/nfe/services/NFeRetAutorizacao4
MG NfeInutilizacao https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeInutilizacao4
MG NfeConsultaProtocolo https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4
MG NfeStatusServico https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeStatusServico4
MG RecepcaoEvento https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRecepcaoEvento4
MG NFeAutorizacao https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4
MG NFeRetAutorizacao https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeRetAutorizacao4
MS NfeInutilizacao https://hom.nfe.sefaz.ms.gov.br/ws/NFeInutilizacao4
MS NfeConsultaProtocolo https://hom.nfe.sefaz.ms.gov.br/ws/NFeConsultaProtocolo4
MS NfeStatusServico https://hom.nfe.sefaz.ms.gov.br/ws/NFeStatusServico4
MS RecepcaoEvento https://hom.nfe.sefaz.ms.gov.br/ws/NFeRecepcaoEvento4
MS NFeAutorizacao https://hom.nfe.sefaz.ms.gov.br/ws/NFeAutorizacao4
MS NFeRetAutorizacao https://hom.nfe.sefaz.ms.gov.br/ws/NFeRetAutorizacao4
MT NfeInutilizacao https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeInutilizacao4
MT NfeConsultaProtocolo https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeConsulta4
MT NfeStatusServico https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeStatusServico4
MT RecepcaoEvento https://homologacao.sefaz.mt.gov.br/nfews/v2/services/RecepcaoEvento4
MT NFeAutorizacao https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeAutorizacao4
MT NFeRetAutorizacao https://homologacao.sefaz.mt.gov.br/nfews/v2/services/NfeRetAutorizacao4
PE NfeInutilizacao https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeInutilizacao4
PE NfeConsultaProtocolo https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeConsultaProtocolo4
PE NfeStatusServico https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeStatusServico4
PE RecepcaoEvento https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRecepcaoEvento4
PE NFeAutorizacao https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeAutorizacao4
PE NFeRetAutorizacao https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/NFeRetAutorizacao4
PR NfeInutilizacao https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeInutilizacao4
PR NfeConsultaProtocolo https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeConsultaProtocolo4
PR NfeStatusServico https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeStatusServico4
PR RecepcaoEvento https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRecepcaoEvento4
PR NFeAutorizacao https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeAutorizacao4
PR NFeRetAutorizacao https://homologacao.nfe.sefa.pr.gov.br/nfe/NFeRetAutorizacao4
RS NfeInutilizacao https://nfe-homologacao.sefazrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx
RS NfeConsultaProtocolo https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx
RS NfeStatusServico https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx
RS RecepcaoEvento https://nfe-homologacao.sefazrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx
RS NFeAutorizacao https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx
RS NFeRetAutorizacao https://nfe-homologacao.sefazrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx
SP NfeInutilizacao https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx
SP NfeConsultaProtocolo https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx
SP NfeStatusServico https://homologacao.nfe.fazenda.sp.gov.br/ws/nfestatusservico4.asmx
SP RecepcaoEvento https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx
SP NFeAutorizacao https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx
SP NFeRetAutorizacao https://homologacao.nfe.fazenda.sp.gov.br/ws/nferetautorizacao4.asmx
SVAN NfeInutilizacao https://hom.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx
SVAN NfeConsultaProtocolo https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx
SVAN NfeStatusServico https://hom.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx
SVAN RecepcaoEvento https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx
SVAN NFeAutorizacao https://hom.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx
SVAN NFeRetAutorizacao https://hom.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx
SVRS NfeInutilizacao https://nfe-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx
SVRS NfeConsultaProtocolo https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx
SVRS NfeStatusServico https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx
SVRS RecepcaoEvento https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx
SVRS NFeAutorizacao https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx
SVRS NFeRetAutorizacao https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx
SVC-AN NfeInutilizacao https://hom.sefazvirtual.fazenda.gov.br/NFeInutilizacao4/NFeInutilizacao4.asmx
SVC-AN NfeConsultaProtocolo https://hom.sefazvirtual.fazenda.gov.br/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx
SVC-AN NfeStatusServico https://hom.sefazvirtual.fazenda.gov.br/NFeStatusServico4/NFeStatusServico4.asmx
SVC-AN RecepcaoEvento https://hom.sefazvirtual.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx
SVC-AN NFeAutorizacao https://hom.sefazvirtual.fazenda.gov.br/NFeAutorizacao4/NFeAutorizacao4.asmx
SVC-AN NFeRetAutorizacao https://hom.sefazvirtual.fazenda.gov.br/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx
SVC-RS NfeConsultaProtocolo https://nfe-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx
SVC-RS NfeStatusServico https://nfe-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx
SVC-RS RecepcaoEvento https://nfe-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx
SVC-RS NFeAutorizacao https://nfe-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx
SVC-RS NFeRetAutorizacao https://nfe-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx
`

function captura(texto: string): Record<string, Partial<Record<ServicoNfe, string>>> {
  const out: Record<string, Partial<Record<ServicoNfe, string>>> = {}
  for (const linha of texto.trim().split('\n')) {
    const [aut, serv, url] = linha.split(' ')
    ;(out[aut] ??= {})[SERVICO[serv]] = url
  }
  return out
}

describe('autorizadores da NF-e', () => {
  for (const [ambiente, texto] of [['producao', PRODUCAO], ['homologacao', HOMOLOGACAO]] as [AmbienteNfe, string][]) {
    it(`URLs de ${ambiente} iguais à captura do portal`, () => {
      const esperado = captura(texto)
      const atual = Object.fromEntries(
        (Object.keys(URLS) as Autorizador[]).map((aut) => [aut, URLS[aut][ambiente]]),
      )
      expect(atual).toEqual(esperado)
    })
  }

  it('cobre as 27 UFs, cada uma com autorizador e contingência', () => {
    expect(UFS).toHaveLength(27)
    expect(new Set(Object.values(CODIGO_UF)).size).toBe(27)
    for (const uf of UFS) {
      for (const ambiente of ['producao', 'homologacao'] as AmbienteNfe[]) {
        for (const servico of ['status', 'autorizacao', 'retAutorizacao', 'consultaProtocolo', 'inutilizacao', 'evento'] as ServicoNfe[]) {
          expect(destino(uf, ambiente, servico).url).toMatch(/^https:\/\//)
        }
      }
      expect(CONTINGENCIA_DA_UF[uf]).toMatch(/^SVC-(AN|RS)$/)
    }
  })

  it('SP vai para a Sefaz-SP; MA para a SVAN; RJ para a SVRS; contingência de SP é SVC-AN', () => {
    expect(destino('SP', 'homologacao', 'autorizacao')).toEqual({
      autorizador: 'SP',
      url: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
      operacao: 'NFeAutorizacao4',
      metodo: 'nfeAutorizacaoLote',
    })
    expect(AUTORIZADOR_DA_UF.MA).toBe('SVAN')
    expect(AUTORIZADOR_DA_UF.RJ).toBe('SVRS')
    expect(destino('SP', 'producao', 'autorizacao', true).autorizador).toBe('SVC-AN')
    expect(destino('PR', 'producao', 'autorizacao', true).autorizador).toBe('SVC-RS')
  })

  it('SVC-RS não inutiliza', () => {
    expect(() => destino('PR', 'producao', 'inutilizacao', true)).toThrow(ServicoIndisponivel)
  })
})

describe('consulta de cadastro', () => {
  // Captura literal do portal em 16/11/2026 (linhas NfeConsultaCadastro), produção e homologação.
  const PROD: Record<string, string> = {
    AM: 'https://nfe.sefaz.am.gov.br/services2/services/CadConsultaCadastro4',
    BA: 'https://nfe.sefaz.ba.gov.br/webservices/CadConsultaCadastro4/CadConsultaCadastro4.asmx',
    GO: 'https://nfe.sefaz.go.gov.br/nfe/services/CadConsultaCadastro4',
    MG: 'https://nfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4',
    MS: 'https://nfe.sefaz.ms.gov.br/ws/CadConsultaCadastro4',
    MT: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/CadConsultaCadastro4',
    PE: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/CadConsultaCadastro4',
    PR: 'https://nfe.sefa.pr.gov.br/nfe/CadConsultaCadastro4',
    RS: 'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
    SP: 'https://nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx',
    SVRS: 'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
  }
  const HOM: Record<string, string> = {
    AM: 'https://homnfe.sefaz.am.gov.br/services2/services/CadConsultaCadastro4',
    BA: 'https://hnfe.sefaz.ba.gov.br/webservices/CadConsultaCadastro4/CadConsultaCadastro4.asmx',
    GO: 'https://homolog.sefaz.go.gov.br/nfe/services/CadConsultaCadastro4',
    MG: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4',
    MS: 'https://hom.nfe.sefaz.ms.gov.br/ws/CadConsultaCadastro4',
    MT: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/CadConsultaCadastro4',
    PE: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/CadConsultaCadastro4',
    PR: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/CadConsultaCadastro4',
    RS: 'https://cad-homologacao.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
    SP: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx',
    SVRS: 'https://cad-homologacao.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx',
  }

  it('15 UFs com o serviço, nas URLs da captura; as outras 12 sem', () => {
    const com = UFS.filter((uf) => destinoCadastro(uf, 'producao'))
    expect([...com].sort()).toEqual(['AC', 'AM', 'BA', 'ES', 'GO', 'MG', 'MS', 'MT', 'PB', 'PE', 'PR', 'RN', 'RS', 'SC', 'SP'])
    for (const uf of com) {
      const chave = ['AC', 'ES', 'RN', 'PB', 'SC'].includes(uf) ? 'SVRS' : uf
      expect(destinoCadastro(uf, 'producao')?.url).toBe(PROD[chave])
      expect(destinoCadastro(uf, 'homologacao')?.url).toBe(HOM[chave])
    }
    expect(destinoCadastro('RJ', 'producao')).toBeNull()
    expect(destinoCadastro('MA', 'producao')).toBeNull()
  })
})
