// Local da prestação por nota (`serv/locPrest/cLocPrestacao`). Opcional: sem ele, a DPS leva o município da
// empresa, como sempre. Com ele, o IBGE informado. Os quatro canais (WhatsApp, painel, planilha e API) gravam o
// código em `payload.servico.municipio_prestacao_ibge`; quem lê texto livre ("Campinas/SP", "campinas", "3509502")
// passa por `resolverMunicipio`.
//
// A tabela é a do IBGE (nfe/municipios-ibge.ts, 5.571 municípios). A UF sai dos dois primeiros dígitos do código.
// Serviço prestado no exterior (`cPaisPrestacao`) está fora.
import { MUNICIPIOS_IBGE } from './nfe/municipios-ibge.js'

const UF_POR_CODIGO: Readonly<Record<string, string>> = {
  '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO',
  '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA',
  '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP',
  '41': 'PR', '42': 'SC', '43': 'RS',
  '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF',
}
const UFS = new Set(Object.values(UF_POR_CODIGO))

export type Municipio = { ibge: string; nome: string; uf: string }

/** Código IBGE de 7 dígitos que existe na tabela. */
export const municipioExiste = (ibge: unknown): ibge is string =>
  typeof ibge === 'string' && /^\d{7}$/.test(ibge) && Object.prototype.hasOwnProperty.call(MUNICIPIOS_IBGE, ibge)

export function municipio(ibge: string): Municipio | null {
  if (!municipioExiste(ibge)) return null
  return { ibge, nome: MUNICIPIOS_IBGE[ibge], uf: UF_POR_CODIGO[ibge.slice(0, 2)] ?? '' }
}

/** "Campinas/SP"; o próprio código quando não está na tabela. */
export function rotuloMunicipio(ibge: string): string {
  const m = municipio(ibge)
  return m ? `${m.nome}/${m.uf}` : ibge
}

/** Sem acento, minúsculo, apóstrofo e hífen viram espaço, espaços colapsados. */
export function normalizarNome(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`´\-.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

let indice: Map<string, Municipio[]> | null = null
function porNome(): Map<string, Municipio[]> {
  if (indice) return indice
  indice = new Map()
  for (const ibge of Object.keys(MUNICIPIOS_IBGE)) {
    const m = municipio(ibge) as Municipio
    const chave = normalizarNome(m.nome)
    const lista = indice.get(chave)
    if (lista) lista.push(m)
    else indice.set(chave, [m])
  }
  return indice
}

export type MunicipioResolvido =
  | { ok: true; municipio: Municipio }
  /** Nome que existe em mais de uma UF, sem UF no texto: perguntar a UF. */
  | { ok: false; motivo: 'ambiguo'; nome: string; opcoes: Municipio[] }
  | { ok: false; motivo: 'nao_encontrado' | 'uf_errada'; texto: string }

/**
 * Aceita código IBGE ("3509502"), "Campinas/SP", "Campinas - SP", "Campinas, SP", "Campinas (SP)", "Campinas SP" e
 * "Campinas". Nome sem UF que existe em mais de um estado volta `ambiguo`, com as opções.
 */
export function resolverMunicipio(entrada: string): MunicipioResolvido {
  const bruto = entrada.trim()
  if (/^\d{7}$/.test(bruto)) {
    const m = municipio(bruto)
    return m ? { ok: true, municipio: m } : { ok: false, motivo: 'nao_encontrado', texto: bruto }
  }
  const texto = bruto.replace(/[()]/g, ' ').trim()
  // UF no fim, depois de "/", "-", "," ou espaço. Com espaço só vale se o resto for um município daquela UF.
  const comUf = /^(.+?)\s*(?:[/,\-–]\s*|\s+)([A-Za-z]{2})\.?$/.exec(texto)
  if (comUf && UFS.has(comUf[2].toUpperCase())) {
    const uf = comUf[2].toUpperCase()
    const lista = porNome().get(normalizarNome(comUf[1]))
    const doEstado = lista?.find((m) => m.uf === uf)
    if (doEstado) return { ok: true, municipio: doEstado }
    if (lista && /[/,\-–]/.test(texto.slice(comUf[1].length))) return { ok: false, motivo: 'uf_errada', texto: bruto }
  }
  const lista = porNome().get(normalizarNome(texto))
  if (!lista) return { ok: false, motivo: 'nao_encontrado', texto: bruto }
  if (lista.length > 1) return { ok: false, motivo: 'ambiguo', nome: lista[0].nome, opcoes: lista }
  return { ok: true, municipio: lista[0] }
}

/**
 * Código do payload (`servico.municipio_prestacao_ibge`): ausente/nulo/vazio = sem local próprio. O mesmo da sede
 * também vira `null`, para a DPS e o resumo saírem como antes.
 */
export function lerMunicipioPrestacao(
  bruto: unknown,
  sede?: string,
): { ok: true; ibge: string | null } | { ok: false; erro: string } {
  if (bruto === undefined || bruto === null || bruto === '') return { ok: true, ibge: null }
  if (typeof bruto !== 'string' || !/^\d{7}$/.test(bruto)) return { ok: false, erro: 'deve ter 7 dígitos (código IBGE)' }
  if (!municipioExiste(bruto)) return { ok: false, erro: `${bruto} não está na tabela de municípios do IBGE` }
  return { ok: true, ibge: bruto === sede ? null : bruto }
}

// ---------------------------------------------------------------------------------------
// Regras da Sefin (Anexo I v1.01 de 09/02/2026, abas `RN DPS_NFS-e` e `MUN.INCID_INFO.SERV.`; lido em 18/11/2026).
// - E0302: `cLocPrestacao` só precisa existir na tabela do IBGE. Não há regra de município conveniado nem de ligação
//   com `cLocEmi` (E0037/E0038/E0039/E0016 são só do emissor).
// - A Sefin calcula o município de incidência (`cLocIncid`) pelo `cTribNac`: em regra o do prestador (E1318); nos 57
//   subitens abaixo, o da prestação (E1317); no 17.05.01, o do tomador (E1321). Fora desses, o local muda só o texto.
// - Incidência num município fora do sistema nacional não rejeita (E0628/E0631 tratam o caso); num município do
//   sistema que não administra o código, a Sefin recusa (E0312, não vale para MEI). Não dá para conferir antes.
// - Retenção com outro município: as E0031/E0672 só valem quando o tomador emite a DPS; a nó emite como prestador.
// - E0370/E0390: os grupos `obra` (construção civil) e `atvEvento` (item 12) são obrigatórios nesses códigos, e a nó
//   ainda não os envia. Com local informado, esses códigos são barrados aqui, com o motivo, em vez de ir à Sefin.

/** E1317 (aba MUN.INCID_INFO.SERV., coluna LP): ISS devido no município da prestação. */
export const CODIGOS_ISS_NO_LOCAL = new Set([
  '030401', '030402', '030403', '030501', '070201', '070202', '070401', '070501', '070502', '070901', '070902',
  '071001', '071002', '071101', '071102', '071201', '071601', '071701', '071801', '071901', '110101', '110102',
  '110201', '110401', '110402', '120101', '120201', '120301', '120401', '120501', '120601', '120701', '120801',
  '120901', '120902', '120903', '121001', '121101', '121201', '121401', '121501', '121601', '121701', '141401',
  '141402', '141403', '141404', '160101', '160102', '160103', '160104', '160201', '171001', '171002', '200201',
  '200301', '220101',
])
/** E0370: grupo `obra` obrigatório. */
export const CODIGOS_COM_OBRA = new Set([
  '070201', '070202', '070401', '070501', '070502', '070601', '070602', '070701', '070801', '071701', '071901',
  '141403', '141404',
])
/** E0390: grupo `atvEvento` obrigatório (todo o item 12). */
export const CODIGOS_COM_EVENTO = new Set([
  '120101', '120201', '120301', '120401', '120501', '120601', '120701', '120801', '120901', '120902', '120903',
  '121001', '121101', '121201', '121301', '121401', '121501', '121601', '121701',
])

/** O ISS desta nota é devido no local da prestação (e não no município da empresa). */
export const issNoLocalDaPrestacao = (codigo: string) => CODIGOS_ISS_NO_LOCAL.has(codigo)

export const PROBLEMAS_DE_LOCAL = ['LOCAL_EXIGE_OBRA', 'LOCAL_EXIGE_EVENTO'] as const
export type ProblemaDeLocal = (typeof PROBLEMAS_DE_LOCAL)[number]

/** Combinação que a Sefin recusaria (ver acima). `null` = pode emitir. */
export function problemaDoLocal(d: { codigo: string; municipioPrestacao: string | null }): ProblemaDeLocal | null {
  if (!d.municipioPrestacao) return null
  if (CODIGOS_COM_OBRA.has(d.codigo)) return 'LOCAL_EXIGE_OBRA'
  if (CODIGOS_COM_EVENTO.has(d.codigo)) return 'LOCAL_EXIGE_EVENTO'
  return null
}

export function motivoDoLocal(problema: string): string {
  switch (problema) {
    case 'LOCAL_EXIGE_OBRA':
      return 'este código de serviço (construção civil) exige os dados da obra na nota (CNO ou endereço da obra), e o nó.fiscal ainda não envia esses dados'
    case 'LOCAL_EXIGE_EVENTO':
      return 'este código de serviço (eventos, item 12) exige os dados do evento na nota (nome, data e endereço), e o nó.fiscal ainda não envia esses dados'
    default:
      return 'o local da prestação não vale para esta nota'
  }
}

const UF_POR_ESTADO: Readonly<Record<string, string>> = {
  acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE', 'distrito federal': 'DF',
  'espirito santo': 'ES', goias: 'GO', maranhao: 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS',
  'minas gerais': 'MG', para: 'PA', paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI',
  'rio de janeiro': 'RJ', 'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR',
  'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO',
}

/** "PI", "pi.", "Piauí", "no Piauí", "é SC": a UF; `null` se não for uma. */
export function ufDaResposta(texto: string): string | null {
  const t = normalizarNome(texto).replace(/^(?:e|eh|em|no|na|de|do|da|estado de|estado do|estado da)\s+/, '').trim()
  if (/^[a-z]{2}$/.test(t) && UFS.has(t.toUpperCase())) return t.toUpperCase()
  return UF_POR_ESTADO[t] ?? null
}
