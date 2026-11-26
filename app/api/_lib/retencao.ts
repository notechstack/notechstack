// Retenção de ISS e de INSS na nota (Lucca, 16/11/2026; pesquisa em .design/agente-fiscal-retencoes.md).
// O motor não calcula regra tributária: o contador diz se a empresa cliente tem retenção (padrão da empresa, em
// `fiscal_tenants`) e cada pedido pode mudar isso ("sem retenção", "ISS retido 2%", "retém INSS 11%"). Daqui sai o
// grupo `retencao` do payload da nota, que o dps-builder transforma em `tpRetISSQN 2` + `pAliq` e `tribFed/vRetCP`.
//
// Regras do Anexo I v1.01 que este módulo antecipa, para a nota não ir à Sefin só para voltar recusada:
// - MEI não tem retenção: nem ISS (E0583) nem `tribFed`/vRetCP (E0676).
// - ISS retido de ME/EPP do Simples exige `pAliq` (E0621/E0628), até 5% (E0595); a LC 123 (art. 21, §4º) fixa o piso
//   em 2%. Formato `TSDec1V2` ("2.00"–"5.00").
// - ISS retido exige o endereço nacional do tomador (E0237). Decisão do Lucca (16/11/2026): só tomador com CNPJ, com o
//   endereço da Receita (BrasilAPI); tomador CPF quase sempre cai na E0667 e é recusado antes.
// - vRetCP > 0 e menor que o valor do serviço (E0699); vServ ≥ ISS retido + vRetCP (E0428).

import { formatarReais } from './agente/documentos.js'

export type EnderecoNacional = {
  /** Código IBGE do município (7 dígitos). */
  cMun: string
  cep: string
  logradouro: string
  numero: string
  complemento?: string | null
  bairro: string
}

/**
 * O grupo do payload da nota. `iss.aliquota` em "2.00"; `inss.valor`, `irrf.valor` e `csrf.valor` em reais ("38.50").
 * IRRF e CSRF (PIS + COFINS + CSLL retidos, somados) são só do Lucro Presumido e do Real (19/11/2026), e por enquanto só
 * pela API do parceiro: não há padrão por empresa nem campo no WhatsApp, no painel ou na planilha.
 */
export type Retencao = { iss?: { aliquota: string }; inss?: { valor: string }; irrf?: { valor: string }; csrf?: { valor: string } }

/** O padrão da empresa cliente (colunas de `fiscal_tenants`). */
export type RetencaoPadrao = {
  retem_iss: boolean
  aliquota_iss: string | null
  retem_inss: boolean
  inss_percentual: string | null
}

export const SEM_RETENCAO_PADRAO: RetencaoPadrao = { retem_iss: false, aliquota_iss: null, retem_inss: false, inss_percentual: null }

/** O que o pedido diz (WhatsApp, planilha, painel). `null`/ausente = vale o padrão da empresa. */
export type RetencaoDoPedido = {
  iss?: boolean | null
  /** Alíquota escrita no pedido ("2", "2,5%"). */
  aliquotaIss?: string | null
  inss?: boolean | null
  /** Valor ("38,50") ou percentual ("11%") escrito no pedido. */
  inssTexto?: string | null
  /** Presumido/Real: IRRF retido, valor ("15,00") ou percentual ("1,5%"). */
  irrfTexto?: string | null
  /** Presumido/Real: PIS + COFINS + CSLL retidos, somados, valor ou percentual ("4,65%"). */
  csrfTexto?: string | null
}

export const PROBLEMAS_DE_RETENCAO = [
  'RETENCAO_MEI',
  'ISS_RETIDO_CPF',
  'ALIQUOTA_ISS_FALTANDO',
  'ALIQUOTA_ISS_INVALIDA',
  'INSS_FALTANDO',
  'INSS_INVALIDO',
  'RETENCOES_ACIMA_DO_VALOR',
  'ENDERECO_TOMADOR',
  'RETENCAO_FEDERAL_SO_LUCRO',
  'IRRF_INVALIDO',
  'CSRF_INVALIDO',
] as const
export type ProblemaDeRetencao = (typeof PROBLEMAS_DE_RETENCAO)[number]

export const ALIQUOTA_ISS_MIN = 2
export const ALIQUOTA_ISS_MAX = 5

const centavos = (valor: string): bigint => {
  const [inteiro, frac = '0'] = valor.split('.')
  return BigInt(inteiro) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2))
}
const reais = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`

/** Número com até 2 casas, vírgula ou ponto decimal, sem milhar: "2", "2,5", "11.00". */
function decimalCurto(texto: string): string | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(texto)
  return m ? `${Number(m[1])}.${(m[2] ?? '').padEnd(2, '0')}` : null
}

const limpo = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.replace(/\s/g, '') : ''

/** Alíquota do ISS retido entre 2% e 5%, no formato do leiaute ("2.50"); `null` se não for isso. */
export function lerAliquotaIss(v: unknown): string | null {
  const d = decimalCurto(limpo(v).replace(/%$/, ''))
  if (!d) return null
  const n = Number(d)
  return n >= ALIQUOTA_ISS_MIN && n <= ALIQUOTA_ISS_MAX ? d : null
}

/** Percentual do INSS retido, maior que 0 e menor que 100 ("11.00"); `null` se não for isso. */
export function lerPercentualInss(v: unknown): string | null {
  const d = decimalCurto(limpo(v).replace(/%$/, ''))
  if (!d) return null
  const n = Number(d)
  return n > 0 && n < 100 ? d : null
}

/** Valor em reais: "38,50", "1.234,56", "R$ 38.50", 38.5. `null` se não for positivo com até 2 casas. */
export function lerValorEmReais(v: unknown): string | null {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null
    const c = Math.round(v * 100)
    return Math.abs(v * 100 - c) > 1e-6 ? null : reais(BigInt(c))
  }
  const t = limpo(v).replace(/^R\$/i, '')
  let m = /^(\d{1,3}(?:\.\d{3})+|\d{1,12}),(\d{1,2})$/.exec(t)
  const inteiro = m ? m[1].replace(/\./g, '') : null
  if (m && inteiro) return positivo(`${BigInt(inteiro)}.${m[2].padEnd(2, '0')}`)
  m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(t)
  return m ? positivo(`${BigInt(m[1])}.${(m[2] ?? '').padEnd(2, '0')}`) : null
}
const positivo = (v: string) => (v === '0.00' ? null : v)

/** INSS retido pelo percentual: valor × percentual / 100, arredondado ao centavo (meio para cima). */
export function inssDoPercentual(valor: string, percentual: string): string {
  return reais((centavos(valor) * centavos(percentual) + 5000n) / 10000n)
}

/** O ISS que o tomador retém: valor × alíquota / 100, arredondado ao centavo (estimativa: quem apura é a Sefin). */
export function issRetido(valor: string, aliquota: string): string {
  return reais((centavos(valor) * centavos(aliquota) + 5000n) / 10000n)
}

/** Valor da nota menos o ISS retido e o INSS retido (o `vLiq` da Sefin, sem descontos). */
export function valorLiquido(valor: string, r: Retencao): string {
  let c = centavos(valor)
  if (r.iss) c -= centavos(issRetido(valor, r.iss.aliquota))
  if (r.inss) c -= centavos(r.inss.valor)
  if (r.irrf) c -= centavos(r.irrf.valor)
  if (r.csrf) c -= centavos(r.csrf.valor)
  return reais(c)
}

const SIM = /^(s|sim|x|1|true|verdadeiro|retido|retem|retém)$/i
const NAO = /^(n|nao|não|0|false|falso|-)$/i

/** Célula de sim/não da planilha. `undefined` = vazia (vale o padrão); `null` = não entendi. */
export function lerSimNao(v: unknown): boolean | null | undefined {
  if (typeof v === 'boolean') return v
  const t = limpo(v)
  if (!t) return undefined
  if (SIM.test(t)) return true
  if (NAO.test(t)) return false
  return null
}

/**
 * A retenção desta nota: o pedido manda, e o que ele não diz vem do padrão da empresa. `regime` e `tomadorTipo` barram
 * o que a Sefin recusaria (MEI; ISS retido de tomador CPF). O endereço do tomador é conferido depois (precisa da Receita).
 */
export function resolverRetencao(dados: {
  padrao: RetencaoPadrao
  pedido?: RetencaoDoPedido
  valor: string
  regime: string | null
  tomadorTipo: 'cpf' | 'cnpj'
}): { ok: true; retencao: Retencao | null } | { ok: false; problema: ProblemaDeRetencao } {
  const p = dados.pedido ?? {}
  const falha = (problema: ProblemaDeRetencao) => ({ ok: false as const, problema })
  // Pessoa física não retém ISS nem INSS: o padrão da empresa vale só para tomador com CNPJ. Com CPF, só o que o
  // pedido disser (Bragantina, 26/11/2026: Leslei Specie, ISS retido no cadastro, travava toda nota de cliente CPF).
  const padrao = dados.tomadorTipo === 'cnpj' ? dados.padrao : SEM_RETENCAO_PADRAO

  const aliquotaEscrita = p.aliquotaIss ? lerAliquotaIss(p.aliquotaIss) : null
  if (p.aliquotaIss && !aliquotaEscrita) return falha('ALIQUOTA_ISS_INVALIDA')
  const temIss = p.iss ?? (aliquotaEscrita ? true : padrao.retem_iss)

  const inssEscrito = p.inssTexto ? lerInssEscrito(p.inssTexto, dados.valor) : null
  if (p.inssTexto && !inssEscrito) return falha('INSS_INVALIDO')
  const temInss = p.inss ?? (inssEscrito ? true : padrao.retem_inss)

  const irrf = p.irrfTexto ? lerInssEscrito(p.irrfTexto, dados.valor) : null
  if (p.irrfTexto && (!irrf || centavos(irrf) >= centavos(dados.valor))) return falha('IRRF_INVALIDO')
  const csrf = p.csrfTexto ? lerInssEscrito(p.csrfTexto, dados.valor) : null
  if (p.csrfTexto && (!csrf || centavos(csrf) >= centavos(dados.valor))) return falha('CSRF_INVALIDO')
  if ((irrf || csrf) && dados.regime === 'mei') return falha('RETENCAO_MEI')
  if ((irrf || csrf) && dados.regime !== 'presumido' && dados.regime !== 'real') return falha('RETENCAO_FEDERAL_SO_LUCRO')

  if (!temIss && !temInss && !irrf && !csrf) return { ok: true, retencao: null }
  if (dados.regime === 'mei') return falha('RETENCAO_MEI')

  const retencao: Retencao = {}
  if (temIss) {
    if (dados.tomadorTipo !== 'cnpj') return falha('ISS_RETIDO_CPF')
    const aliquota = aliquotaEscrita ?? (padrao.aliquota_iss ? lerAliquotaIss(padrao.aliquota_iss) : null)
    if (!aliquota) return falha('ALIQUOTA_ISS_FALTANDO')
    retencao.iss = { aliquota }
  }
  if (temInss) {
    const valor = inssEscrito ?? (dados.padrao.inss_percentual ? inssDoPercentual(dados.valor, dados.padrao.inss_percentual) : null)
    if (!valor) return falha('INSS_FALTANDO')
    if (valor === '0.00' || centavos(valor) >= centavos(dados.valor)) return falha('INSS_INVALIDO')
    retencao.inss = { valor }
  }
  if (irrf) retencao.irrf = { valor: irrf }
  if (csrf) retencao.csrf = { valor: csrf }
  if (centavos(valorLiquido(dados.valor, retencao)) < 0n) return falha('RETENCOES_ACIMA_DO_VALOR')
  return { ok: true, retencao }
}

/** "11%" → INSS pelo percentual; "38,50" → o valor. */
function lerInssEscrito(texto: string, valor: string): string | null {
  const t = limpo(texto)
  if (t.endsWith('%')) {
    const pct = lerPercentualInss(t)
    return pct ? inssDoPercentual(valor, pct) : null
  }
  return lerValorEmReais(t)
}

/** O motivo que a pessoa lê (resumo do WhatsApp, linha da planilha, painel). */
export function motivoDaRetencao(problema: string): string {
  switch (problema) {
    case 'RETENCAO_MEI':
      return 'MEI não tem retenção de ISS nem de INSS na nota (a Sefin recusa)'
    case 'ISS_RETIDO_CPF':
      return 'ISS retido só para cliente com CNPJ (a Sefin recusa a retenção de pessoa física)'
    case 'ALIQUOTA_ISS_FALTANDO':
      return 'com ISS retido, falta a alíquota do ISS (de 2% a 5%)'
    case 'ALIQUOTA_ISS_INVALIDA':
      return 'alíquota do ISS retido inválida (de 2% a 5%, por exemplo 2,5%)'
    case 'INSS_FALTANDO':
      return 'com INSS retido, falta o valor ou o percentual do INSS (por exemplo 11%)'
    case 'INSS_INVALIDO':
      return 'INSS retido inválido: escreva o valor (38,50) ou o percentual (11%), menor que o valor da nota'
    case 'RETENCOES_ACIMA_DO_VALOR':
      return 'as retenções passam do valor da nota'
    case 'RETENCAO_FEDERAL_SO_LUCRO':
      return 'IRRF e PIS/COFINS/CSLL retidos na nota são só do Lucro Presumido e do Real (o Simples recolhe pelo DAS)'
    case 'IRRF_INVALIDO':
      return 'IRRF retido inválido: escreva o valor (15,00) ou o percentual (1,5%), menor que o valor da nota'
    case 'CSRF_INVALIDO':
      return 'PIS/COFINS/CSLL retidos inválidos: escreva o valor somado (46,50) ou o percentual (4,65%), menor que o valor da nota'
    case 'ENDERECO_TOMADOR':
      return 'com ISS retido, a nota leva o endereço do cliente, e não achei o endereço deste CNPJ na Receita'
    default:
      return problema
  }
}

const brl = formatarReais
/** "2.50" → "2,5%"; "11.00" → "11%". */
const pct = (v: string) => `${v.replace(/\.?0+$/, '').replace('.', ',')}%`

/** As linhas da retenção no resumo antes do *confirmar* (vazio sem retenção). */
export function linhasDaRetencao(valor: string, r: Retencao | null | undefined): string[] {
  if (!r || (!r.iss && !r.inss && !r.irrf && !r.csrf)) return []
  return [
    ...(r.iss ? [`ISS retido pelo tomador: ${pct(r.iss.aliquota)} (${brl(issRetido(valor, r.iss.aliquota))})`] : []),
    ...(r.inss ? [`INSS retido: ${brl(r.inss.valor)}`] : []),
    ...(r.irrf ? [`IRRF retido: ${brl(r.irrf.valor)}`] : []),
    ...(r.csrf ? [`PIS/COFINS/CSLL retidos: ${brl(r.csrf.valor)}`] : []),
    `Valor líquido: ${brl(valorLiquido(valor, r))}`,
  ]
}

/** A visão da retenção para o painel (JSON). */
export function visaoDaRetencao(valor: string, r: Retencao | null | undefined) {
  if (!r || (!r.iss && !r.inss && !r.irrf && !r.csrf)) return null
  return {
    iss: r.iss ? { aliquota: r.iss.aliquota, valor: issRetido(valor, r.iss.aliquota) } : null,
    inss: r.inss ? { valor: r.inss.valor } : null,
    ...(r.irrf ? { irrf: { valor: r.irrf.valor } } : {}),
    ...(r.csrf ? { csrf: { valor: r.csrf.valor } } : {}),
    liquido: valorLiquido(valor, r),
    linhas: linhasDaRetencao(valor, r),
  }
}

// ---------------------------------------------------------------------------------------
// Endereço do tomador (só com ISS retido).

const corta = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '')

/** O endereço da resposta de `GET /api/cnpj/v1/{cnpj}` da BrasilAPI, no formato do `endNac`; `null` se faltar algo. */
export function enderecoDaReceita(corpo: unknown): EnderecoNacional | null {
  const c = (typeof corpo === 'object' && corpo !== null ? corpo : {}) as Record<string, unknown>
  const cMun = String(c.codigo_municipio_ibge ?? '').replace(/\D/g, '')
  const cep = String(c.cep ?? '').replace(/\D/g, '').padStart(8, '0')
  const tipo = corta(c.descricao_tipo_de_logradouro, 30)
  const rua = corta(c.logradouro, 255)
  const logradouro = (tipo && rua && !rua.toUpperCase().startsWith(tipo.toUpperCase()) ? `${tipo} ${rua}` : rua).slice(0, 255)
  const numero = corta(c.numero, 60) || 'S/N'
  const bairro = corta(c.bairro, 60)
  const complemento = corta(c.complemento, 156) || null
  if (!/^\d{7}$/.test(cMun) || !/^\d{8}$/.test(cep) || cep === '00000000' || !logradouro || !bairro) return null
  return { cMun, cep, logradouro, numero, complemento, bairro }
}

/** Confere o endereço gravado no payload (o dps-builder chama de novo antes de assinar). */
export function enderecoValido(v: unknown): EnderecoNacional | null {
  if (typeof v !== 'object' || v === null) return null
  const e = v as Record<string, unknown>
  const texto = (x: unknown, max: number) => (typeof x === 'string' && x.trim().length >= 1 && x.trim().length <= max ? x.trim() : null)
  const cMun = typeof e.cMun === 'string' && /^\d{7}$/.test(e.cMun) ? e.cMun : null
  const cep = typeof e.cep === 'string' && /^\d{8}$/.test(e.cep) ? e.cep : null
  const logradouro = texto(e.logradouro, 255)
  const numero = texto(e.numero, 60)
  const bairro = texto(e.bairro, 60)
  const complemento = e.complemento === undefined || e.complemento === null ? null : texto(e.complemento, 156)
  if (!cMun || !cep || !logradouro || !numero || !bairro) return null
  if (e.complemento !== undefined && e.complemento !== null && complemento === null) return null
  return { cMun, cep, logradouro, numero, complemento, bairro }
}

/** Busca o endereço do tomador na Receita; implementado em agente/consulta-cnpj.ts, dublê nos testes. */
export interface EnderecoDoTomador {
  endereco(cnpj: string): Promise<EnderecoNacional | null>
}

/** Lê o padrão da empresa de uma linha de `fiscal_tenants` (numeric chega como texto). */
export function padraoDaLinha(l: {
  retem_iss?: boolean | null
  aliquota_iss?: string | number | null
  retem_inss?: boolean | null
  inss_percentual?: string | number | null
}): RetencaoPadrao {
  const num = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(v).toFixed(2))
  return {
    retem_iss: l.retem_iss === true,
    aliquota_iss: num(l.aliquota_iss),
    retem_inss: l.retem_inss === true,
    inss_percentual: num(l.inss_percentual),
  }
}

export const COLUNAS_DA_RETENCAO = 'retem_iss, aliquota_iss::text as aliquota_iss, retem_inss, inss_percentual::text as inss_percentual'
