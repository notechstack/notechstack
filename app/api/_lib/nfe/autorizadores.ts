// Autorizadores da NF-e modelo 55 (layout 4.00) para as 27 UFs.
// Fonte: "Relação de Serviços Web" do Portal Nacional da NF-e, capturada em 16/11/2026:
//   produção:    https://www.nfe.fazenda.gov.br/portal/webServices.aspx
//   homologação: https://hom.nfe.fazenda.gov.br/portal/webServices.aspx
// Conferida contra storage/wsnfe_4.00_mod55.xml e autorizadores.json do NFePHP (sped-nfe), mesma data.
// Quando o portal mudar uma URL, atualize aqui e no teste (autorizadores.test.ts), que fixa a captura.

export type Uf =
  | 'AC' | 'AL' | 'AM' | 'AP' | 'BA' | 'CE' | 'DF' | 'ES' | 'GO' | 'MA' | 'MG' | 'MS' | 'MT' | 'PA'
  | 'PB' | 'PE' | 'PI' | 'PR' | 'RJ' | 'RN' | 'RO' | 'RR' | 'RS' | 'SC' | 'SE' | 'SP' | 'TO'

export type Autorizador =
  | 'AM' | 'BA' | 'GO' | 'MG' | 'MS' | 'MT' | 'PE' | 'PR' | 'RS' | 'SP' | 'SVAN' | 'SVRS' | 'SVC-AN' | 'SVC-RS'

export type AmbienteNfe = 'homologacao' | 'producao'
/** tpAmb do leiaute: 1 produção, 2 homologação. */
export const TP_AMB: Readonly<Record<AmbienteNfe, '1' | '2'>> = { producao: '1', homologacao: '2' }

export type ServicoNfe = 'status' | 'autorizacao' | 'retAutorizacao' | 'consultaProtocolo' | 'inutilizacao' | 'evento'

/** Código IBGE da UF (cUF), usado na chave de acesso e nos pedidos. */
export const CODIGO_UF: Readonly<Record<Uf, string>> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17',
  MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35',
  PR: '41', SC: '42', RS: '43',
  MS: '50', MT: '51', GO: '52', DF: '53',
}

export const UFS = Object.keys(CODIGO_UF) as Uf[]

export const ufDoCodigo = (cUF: string): Uf | undefined => UFS.find((uf) => CODIGO_UF[uf] === cUF)

/** Quem autoriza a NF-e de cada UF ("UF que utilizam a SVAN / SVRS" no portal). */
export const AUTORIZADOR_DA_UF: Readonly<Record<Uf, Autorizador>> = {
  AM: 'AM', BA: 'BA', GO: 'GO', MG: 'MG', MS: 'MS', MT: 'MT', PE: 'PE', PR: 'PR', RS: 'RS', SP: 'SP',
  MA: 'SVAN',
  AC: 'SVRS', AL: 'SVRS', AP: 'SVRS', CE: 'SVRS', DF: 'SVRS', ES: 'SVRS', PA: 'SVRS', PB: 'SVRS',
  PI: 'SVRS', RJ: 'SVRS', RN: 'SVRS', RO: 'SVRS', RR: 'SVRS', SC: 'SVRS', SE: 'SVRS', TO: 'SVRS',
}

/** Sefaz Virtual de Contingência de cada UF (tpEmis 6 = SVC-AN, 7 = SVC-RS). */
export const CONTINGENCIA_DA_UF: Readonly<Record<Uf, 'SVC-AN' | 'SVC-RS'>> = {
  AC: 'SVC-AN', AL: 'SVC-AN', AP: 'SVC-AN', CE: 'SVC-AN', DF: 'SVC-AN', ES: 'SVC-AN', MG: 'SVC-AN',
  PA: 'SVC-AN', PB: 'SVC-AN', PI: 'SVC-AN', RJ: 'SVC-AN', RN: 'SVC-AN', RO: 'SVC-AN', RR: 'SVC-AN',
  RS: 'SVC-AN', SC: 'SVC-AN', SE: 'SVC-AN', SP: 'SVC-AN', TO: 'SVC-AN',
  AM: 'SVC-RS', BA: 'SVC-RS', GO: 'SVC-RS', MA: 'SVC-RS', MS: 'SVC-RS', MT: 'SVC-RS', PE: 'SVC-RS', PR: 'SVC-RS',
}

type Urls = Partial<Record<ServicoNfe, string>>

const am = (host: string): Urls => ({
  status: `https://${host}/services2/services/NfeStatusServico4`,
  autorizacao: `https://${host}/services2/services/NfeAutorizacao4`,
  retAutorizacao: `https://${host}/services2/services/NfeRetAutorizacao4`,
  consultaProtocolo: `https://${host}/services2/services/NfeConsulta4`,
  inutilizacao: `https://${host}/services2/services/NfeInutilizacao4`,
  evento: `https://${host}/services2/services/RecepcaoEvento4`,
})
const ba = (host: string): Urls => ({
  status: `https://${host}/webservices/NFeStatusServico4/NFeStatusServico4.asmx`,
  autorizacao: `https://${host}/webservices/NFeAutorizacao4/NFeAutorizacao4.asmx`,
  retAutorizacao: `https://${host}/webservices/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx`,
  consultaProtocolo: `https://${host}/webservices/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx`,
  inutilizacao: `https://${host}/webservices/NFeInutilizacao4/NFeInutilizacao4.asmx`,
  evento: `https://${host}/webservices/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx`,
})
/** GO, MG, MS, PE e PR: `<base>/NFe<Servico>4`. */
const java = (base: string): Urls => ({
  status: `${base}/NFeStatusServico4`,
  autorizacao: `${base}/NFeAutorizacao4`,
  retAutorizacao: `${base}/NFeRetAutorizacao4`,
  consultaProtocolo: `${base}/NFeConsultaProtocolo4`,
  inutilizacao: `${base}/NFeInutilizacao4`,
  evento: `${base}/NFeRecepcaoEvento4`,
})
const mt = (host: string): Urls => ({
  status: `https://${host}/nfews/v2/services/NfeStatusServico4`,
  autorizacao: `https://${host}/nfews/v2/services/NfeAutorizacao4`,
  retAutorizacao: `https://${host}/nfews/v2/services/NfeRetAutorizacao4`,
  consultaProtocolo: `https://${host}/nfews/v2/services/NfeConsulta4`,
  inutilizacao: `https://${host}/nfews/v2/services/NfeInutilizacao4`,
  evento: `https://${host}/nfews/v2/services/RecepcaoEvento4`,
})
/** RS e SVRS (mesmo software). */
const rs = (host: string): Urls => ({
  status: `https://${host}/ws/NfeStatusServico/NfeStatusServico4.asmx`,
  autorizacao: `https://${host}/ws/NfeAutorizacao/NFeAutorizacao4.asmx`,
  retAutorizacao: `https://${host}/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx`,
  consultaProtocolo: `https://${host}/ws/NfeConsulta/NfeConsulta4.asmx`,
  inutilizacao: `https://${host}/ws/nfeinutilizacao/nfeinutilizacao4.asmx`,
  evento: `https://${host}/ws/recepcaoevento/recepcaoevento4.asmx`,
})
const sp = (host: string): Urls => ({
  status: `https://${host}/ws/nfestatusservico4.asmx`,
  autorizacao: `https://${host}/ws/nfeautorizacao4.asmx`,
  retAutorizacao: `https://${host}/ws/nferetautorizacao4.asmx`,
  consultaProtocolo: `https://${host}/ws/nfeconsultaprotocolo4.asmx`,
  inutilizacao: `https://${host}/ws/nfeinutilizacao4.asmx`,
  evento: `https://${host}/ws/nferecepcaoevento4.asmx`,
})
/** SVAN e SVC-AN (Sefaz Virtual do Ambiente Nacional). */
const svan = (host: string): Urls => ({
  status: `https://${host}/NFeStatusServico4/NFeStatusServico4.asmx`,
  autorizacao: `https://${host}/NFeAutorizacao4/NFeAutorizacao4.asmx`,
  retAutorizacao: `https://${host}/NFeRetAutorizacao4/NFeRetAutorizacao4.asmx`,
  consultaProtocolo: `https://${host}/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx`,
  inutilizacao: `https://${host}/NFeInutilizacao4/NFeInutilizacao4.asmx`,
  evento: `https://${host}/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx`,
})
/** SVC-RS não tem inutilização (o portal não lista). */
function semInutilizacao(urls: Urls): Urls {
  const resto = { ...urls }
  delete resto.inutilizacao
  return resto
}

export const URLS: Readonly<Record<Autorizador, Readonly<Record<AmbienteNfe, Urls>>>> = {
  AM: { producao: am('nfe.sefaz.am.gov.br'), homologacao: am('homnfe.sefaz.am.gov.br') },
  BA: { producao: ba('nfe.sefaz.ba.gov.br'), homologacao: ba('hnfe.sefaz.ba.gov.br') },
  GO: { producao: java('https://nfe.sefaz.go.gov.br/nfe/services'), homologacao: java('https://homolog.sefaz.go.gov.br/nfe/services') },
  MG: { producao: java('https://nfe.fazenda.mg.gov.br/nfe2/services'), homologacao: java('https://hnfe.fazenda.mg.gov.br/nfe2/services') },
  MS: { producao: java('https://nfe.sefaz.ms.gov.br/ws'), homologacao: java('https://hom.nfe.sefaz.ms.gov.br/ws') },
  MT: { producao: mt('nfe.sefaz.mt.gov.br'), homologacao: mt('homologacao.sefaz.mt.gov.br') },
  PE: {
    producao: java('https://nfe.sefaz.pe.gov.br/nfe-service/services'),
    homologacao: java('https://nfehomolog.sefaz.pe.gov.br/nfe-service/services'),
  },
  PR: { producao: java('https://nfe.sefa.pr.gov.br/nfe'), homologacao: java('https://homologacao.nfe.sefa.pr.gov.br/nfe') },
  RS: { producao: rs('nfe.sefazrs.rs.gov.br'), homologacao: rs('nfe-homologacao.sefazrs.rs.gov.br') },
  SP: { producao: sp('nfe.fazenda.sp.gov.br'), homologacao: sp('homologacao.nfe.fazenda.sp.gov.br') },
  SVAN: { producao: svan('www.sefazvirtual.fazenda.gov.br'), homologacao: svan('hom.sefazvirtual.fazenda.gov.br') },
  SVRS: { producao: rs('nfe.svrs.rs.gov.br'), homologacao: rs('nfe-homologacao.svrs.rs.gov.br') },
  'SVC-AN': { producao: svan('www.sefazvirtual.fazenda.gov.br'), homologacao: svan('hom.sefazvirtual.fazenda.gov.br') },
  'SVC-RS': {
    producao: semInutilizacao(rs('nfe.svrs.rs.gov.br')),
    homologacao: semInutilizacao(rs('nfe-homologacao.svrs.rs.gov.br')),
  },
}

/**
 * Operação do WSDL (namespace do `nfeDadosMsg`) e método (fim do SOAPAction) de cada serviço.
 * Iguais em todos os autorizadores no 4.00.
 */
export const OPERACAO: Readonly<Record<ServicoNfe, { operacao: string; metodo: string }>> = {
  status: { operacao: 'NFeStatusServico4', metodo: 'nfeStatusServicoNF' },
  autorizacao: { operacao: 'NFeAutorizacao4', metodo: 'nfeAutorizacaoLote' },
  retAutorizacao: { operacao: 'NFeRetAutorizacao4', metodo: 'nfeRetAutorizacaoLote' },
  consultaProtocolo: { operacao: 'NFeConsultaProtocolo4', metodo: 'nfeConsultaNF' },
  inutilizacao: { operacao: 'NFeInutilizacao4', metodo: 'nfeInutilizacaoNF' },
  evento: { operacao: 'NFeRecepcaoEvento4', metodo: 'nfeRecepcaoEvento' },
}

export class ServicoIndisponivel extends Error {
  constructor(autorizador: Autorizador, servico: ServicoNfe) {
    super(`${autorizador} não oferece ${servico}`)
    this.name = 'ServicoIndisponivel'
  }
}

export type Destino = { autorizador: Autorizador; url: string; operacao: string; metodo: string }

/** Para onde vai um pedido da UF do emitente; `contingencia` troca o autorizador pela SVC da UF. */
export function destino(uf: Uf, ambiente: AmbienteNfe, servico: ServicoNfe, contingencia = false): Destino {
  const autorizador = contingencia ? CONTINGENCIA_DA_UF[uf] : AUTORIZADOR_DA_UF[uf]
  const url = URLS[autorizador][ambiente][servico]
  if (!url) throw new ServicoIndisponivel(autorizador, servico)
  return { autorizador, url, ...OPERACAO[servico] }
}

// --- Consulta de cadastro (CadConsultaCadastro4, consCad 2.00) ---------------------------------------------
// Só 15 UFs oferecem: as 10 com Sefaz própria (AM, BA, GO, MG, MS, MT, PE, PR, RS, SP) e, pela SVRS, AC, ES, RN, PB e
// SC ("UF que utilizam a SVRS, para serviço de Consulta Cadastro", portal em 16/11/2026). Nas outras 12, não há.
// URLs da mesma captura do portal. O RS usa o servidor de cadastro da SVRS.

export type AutorizadorCadastro = 'AM' | 'BA' | 'GO' | 'MG' | 'MS' | 'MT' | 'PE' | 'PR' | 'SP' | 'SVRS'

export const CADASTRO_DA_UF: Readonly<Partial<Record<Uf, AutorizadorCadastro>>> = {
  AM: 'AM', BA: 'BA', GO: 'GO', MG: 'MG', MS: 'MS', MT: 'MT', PE: 'PE', PR: 'PR', SP: 'SP',
  RS: 'SVRS', AC: 'SVRS', ES: 'SVRS', RN: 'SVRS', PB: 'SVRS', SC: 'SVRS',
}

export const URLS_CADASTRO: Readonly<Record<AutorizadorCadastro, Readonly<Record<AmbienteNfe, string>>>> = {
  AM: { producao: 'https://nfe.sefaz.am.gov.br/services2/services/CadConsultaCadastro4', homologacao: 'https://homnfe.sefaz.am.gov.br/services2/services/CadConsultaCadastro4' },
  BA: { producao: 'https://nfe.sefaz.ba.gov.br/webservices/CadConsultaCadastro4/CadConsultaCadastro4.asmx', homologacao: 'https://hnfe.sefaz.ba.gov.br/webservices/CadConsultaCadastro4/CadConsultaCadastro4.asmx' },
  GO: { producao: 'https://nfe.sefaz.go.gov.br/nfe/services/CadConsultaCadastro4', homologacao: 'https://homolog.sefaz.go.gov.br/nfe/services/CadConsultaCadastro4' },
  MG: { producao: 'https://nfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4', homologacao: 'https://hnfe.fazenda.mg.gov.br/nfe2/services/CadConsultaCadastro4' },
  MS: { producao: 'https://nfe.sefaz.ms.gov.br/ws/CadConsultaCadastro4', homologacao: 'https://hom.nfe.sefaz.ms.gov.br/ws/CadConsultaCadastro4' },
  MT: { producao: 'https://nfe.sefaz.mt.gov.br/nfews/v2/services/CadConsultaCadastro4', homologacao: 'https://homologacao.sefaz.mt.gov.br/nfews/v2/services/CadConsultaCadastro4' },
  PE: { producao: 'https://nfe.sefaz.pe.gov.br/nfe-service/services/CadConsultaCadastro4', homologacao: 'https://nfehomolog.sefaz.pe.gov.br/nfe-service/services/CadConsultaCadastro4' },
  PR: { producao: 'https://nfe.sefa.pr.gov.br/nfe/CadConsultaCadastro4', homologacao: 'https://homologacao.nfe.sefa.pr.gov.br/nfe/CadConsultaCadastro4' },
  SP: { producao: 'https://nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx', homologacao: 'https://homologacao.nfe.fazenda.sp.gov.br/ws/cadconsultacadastro4.asmx' },
  SVRS: { producao: 'https://cad.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx', homologacao: 'https://cad-homologacao.svrs.rs.gov.br/ws/cadconsultacadastro/cadconsultacadastro4.asmx' },
}

/**
 * O nome do método no SOAPAction não é igual em todo autorizador (o NFePHP registra `consultaCadastro` em BA, GO, MS,
 * MT e SP, e `consultaCadastro4` em MG, PE, PR e SVRS). O cliente tenta o primeiro e, se a resposta vier sem cStat,
 * tenta o outro. A confirmar no primeiro uso real de cada UF.
 */
export const METODOS_CADASTRO: Readonly<Record<AutorizadorCadastro, readonly [string, string]>> = {
  AM: ['consultaCadastro', 'consultaCadastro4'],
  BA: ['consultaCadastro', 'consultaCadastro4'],
  GO: ['consultaCadastro', 'consultaCadastro4'],
  MS: ['consultaCadastro', 'consultaCadastro4'],
  MT: ['consultaCadastro', 'consultaCadastro4'],
  SP: ['consultaCadastro', 'consultaCadastro4'],
  MG: ['consultaCadastro4', 'consultaCadastro'],
  PE: ['consultaCadastro4', 'consultaCadastro'],
  PR: ['consultaCadastro4', 'consultaCadastro'],
  SVRS: ['consultaCadastro4', 'consultaCadastro'],
}

export type DestinoCadastro = { autorizador: AutorizadorCadastro; url: string; operacao: 'CadConsultaCadastro4'; metodos: readonly [string, string] }

/** Para onde vai a consulta de cadastro da UF; `null` nas 12 UFs sem o serviço. */
export function destinoCadastro(uf: Uf, ambiente: AmbienteNfe): DestinoCadastro | null {
  const autorizador = CADASTRO_DA_UF[uf]
  if (!autorizador) return null
  return { autorizador, url: URLS_CADASTRO[autorizador][ambiente], operacao: 'CadConsultaCadastro4', metodos: METODOS_CADASTRO[autorizador] }
}
