// NFS-e de locação: 99.03.01 (locação de bem imóvel) e 99.04.01 (locação de bem móvel). Pesquisa de 26/11/2026,
// fontes em side-session-notes/…/locacao-99-03-99-04-fontes.md:
// - Ato Conjunto RFB/CGIBS nº 4/2026: NFS-e obrigatória na locação de bens móveis e na locação, cessão onerosa e
//   arrendamento de imóveis (01/12/2026 regime normal; 01/01/2027 Simples). A NT 005/007/009 criou os códigos.
// - Só a Sefin Nacional autoriza (NT 007, 3.a), para qualquer CNPJ, mesmo em município sem emissor nacional: a trava
//   do Presumido (E0039, cidades de emissor pleno) não vale aqui.
// - ISS: não incide (E0532: tribISSQN 4; E0580: sem retenção; E0602: sem pAliq).
// - O grupo IBSCBS é obrigatório: `gLocacao` em 99.03 (E0937) e `bensMoveis` em 99.04.01 (E0963) só existem nele.
//   Por isso a locação só sai no leiaute da NT 009 (release 1 ou 2), nunca no v1.01 da NT 004.
// - Imóvel: `imovel/cMun` (E0929), `gLocacao` (pCopropriedade, vTotOper, dVencOrig?) e, com cIndOp 020101, o
//   `gUnidImob` (E0938) com `inscImobFisc?` e o CIB ou o endereço (CEP, rua, número, complemento?, bairro?).
//   E0433: vServ = pCopropriedade × vTotOper. NBS 1.1002.10.00 (residencial) ou 1.1002.20.00 (não residencial);
//   cIndOp 020101 (E0902: 02XXXX); cClassTrib 200027 (Anexo VIII v1.02.00).
// - Bem móvel: `bensMoveis` 1–1000 (NCM de 8 dígitos que exista, E0973; descrição; quantidade 1–999, E0974);
//   NBS da família 1.1101/1.1102; cIndOp 010101; cClassTrib 000001 (Anexo VIII).
// - Produção aceita esses códigos a partir de 07/12/2026 (cronograma da CGNFS-e de 25/11/2026); antes, só a produção
//   restrita, por API. Até a Sefin aceitar em produção, tudo fica atrás de `NOFISCAL_LOCACAO=1` (desligada).
//
// No payload: `servico.locacao` = `{ imovel: {...} }` (99.03.01) ou `{ bens: [...] }` (99.04.01).
import { municipioExiste, rotuloMunicipio } from './local-prestacao.js'
import { lerCep, textoLatin1 } from './obra.js'
import { nbsExiste } from './rtc/resolver.js'
import { el, leaf } from './xml.js'

export const LOCACAO_IMOVEL = '990301'
export const LOCACAO_MOVEL = '990401'
export const CODIGOS_DE_LOCACAO = new Set([LOCACAO_IMOVEL, LOCACAO_MOVEL])

export const ehLocacao = (codigo: string | null | undefined): boolean => !!codigo && CODIGOS_DE_LOCACAO.has(codigo)
export const ehLocacaoDeImovel = (codigo: string | null | undefined) => codigo === LOCACAO_IMOVEL
export const ehLocacaoDeMovel = (codigo: string | null | undefined) => codigo === LOCACAO_MOVEL

/** A nota de locação está ligada neste ambiente? Só com `NOFISCAL_LOCACAO=1`. */
export const locacaoLigada = (env: Record<string, string | undefined> = process.env): boolean => env.NOFISCAL_LOCACAO === '1'

/** O que a pessoa lê enquanto a flag estiver desligada (WhatsApp, painel, planilha e API). */
export const MENSAGEM_LOCACAO_DESLIGADA =
  'A nota de locação (aluguel de imóvel ou de bem móvel) entra no sistema assim que a Receita liberar esses códigos no ambiente nacional. Por enquanto, ainda não dá para emitir.'
export const MOTIVO_LOCACAO_DESLIGADA = 'LOCACAO_INDISPONIVEL'

export const NBS_IMOVEL_RESIDENCIAL = '110021000'
export const NBS_IMOVEL_NAO_RESIDENCIAL = '110022000'
/** Anexo VIII v1.02.00: locação, cessão onerosa e arrendamento de imóveis (CST 200). */
export const CLASS_TRIB_IMOVEL = '200027'
/** Anexo VIII v1.02.00: locação em zona reabilitada (art. 262 da LC 214/2025), quando informada. */
export const CLASS_TRIB_IMOVEL_ZONA_REABILITADA = '200026'
export const CIND_OP_IMOVEL = '020101'
export const CLASS_TRIB_MOVEL = '000001'
/** 010101: retirada no estabelecimento do fornecedor; 010102: fora dele; 010103: entrega no endereço do destinatário. */
export const CIND_OP_MOVEL_PADRAO = '010101'
export const CIND_OP_MOVEL = new Set(['010101', '010102', '010103', '010106'])

/** NBS de locação de bem móvel: arrendamento mercantil operacional ou locação (1.1101.* e 1.1102.*). */
export const nbsDeLocacaoMovel = (nbs: string) => /^1110[12]\d{4}$/.test(nbs) && nbsExiste(nbs)

export type ImovelLocado = {
  /** `imovel/cMun`: IBGE do município do imóvel. */
  municipio_ibge: string
  cep: string | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  /** `inscImobFisc` (1–30): inscrição imobiliária ou do IPTU. */
  inscricao_imobiliaria: string | null
  /** `cCIB` (8): Cadastro Imobiliário Brasileiro; vai no lugar do endereço. */
  cib: string | null
  /** Escolhe a NBS: 1.1002.10.00 (residencial) ou 1.1002.20.00. */
  residencial: boolean
  /** `pCopropriedade` (0,01–100, 2 casas): a parte do locador. Um só dono = 100.00. */
  copropriedade: string
  /** `vTotOper`: o aluguel inteiro, sem aplicar a copropriedade. */
  valor_total: string
  /** `dVencOrig` (AAAA-MM-DD): vencimento original do aluguel. Opcional, recomendado. */
  vencimento: string | null
}

export type BemLocado = { ncm: string; descricao: string; quantidade: number }

export type Locacao = { imovel: ImovelLocado } | { bens: BemLocado[] }

export type CampoDoImovel = 'municipio' | 'cep' | 'logradouro' | 'numero' | 'residencial'
const ROTULOS_DO_IMOVEL: Record<CampoDoImovel, string> = {
  municipio: 'cidade do imóvel',
  cep: 'CEP',
  logradouro: 'rua',
  numero: 'número',
  residencial: 'se é residencial ou comercial',
}

export type LocacaoLida =
  | { ok: true; locacao: Locacao | null }
  | { ok: false; erro: string; faltando: CampoDoImovel[] | ['bens'] }

const vazio = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

function textoAte(bruto: unknown, max: number): string | null {
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null
  const texto = textoLatin1(String(bruto))
  return texto.length >= 1 && texto.length <= max ? texto : null
}

const centavos = (v: string) => {
  const [i, f = '0'] = v.split('.')
  return BigInt(i) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2))
}
const reais = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`

/** "2.500,00", "2500", "2500.5" → "2500.00"; `null` se não for valor positivo. */
export function lerValor(bruto: unknown): string | null {
  if (typeof bruto === 'number') bruto = bruto.toFixed(2)
  if (typeof bruto !== 'string') return null
  let s = bruto.trim().replace(/^R\$\s*/i, '')
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(s)) return null
  const [i, f = ''] = s.split('.')
  const v = `${BigInt(i)}.${f.padEnd(2, '0')}`
  return centavos(v) > 0n ? v : null
}

/** Percentual de copropriedade: "50", "50%", "33,33" → "50.00"; maior que 0 e até 100 (E0940). */
export function lerCopropriedade(bruto: unknown): string | null {
  if (bruto === undefined || bruto === null || bruto === '') return '100.00'
  const s = String(bruto).trim().replace('%', '').replace(',', '.')
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null
  const n = Number(s)
  if (!(n > 0 && n <= 100)) return null
  return n.toFixed(2)
}

/** vServ = pCopropriedade × vTotOper, com arredondamento half even em centavos (E0433). */
export function parteDoLocador(valorTotal: string, copropriedade: string): string {
  const num = centavos(valorTotal) * centavos(copropriedade) // centavos × centésimos de ponto percentual
  const q = num / 10000n
  const r = num % 10000n
  const arred = r > 5000n || (r === 5000n && q % 2n === 1n) ? q + 1n : q
  return reais(arred)
}

function lerData(bruto: unknown): string | null | false {
  if (vazio(bruto)) return null
  if (typeof bruto !== 'string') return false
  const s = bruto.trim()
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s)
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : s
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(iso)) return false
  const d = new Date(`${iso}T12:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : false
}

function lerResidencial(bruto: unknown): boolean | null {
  if (typeof bruto === 'boolean') return bruto
  if (typeof bruto !== 'string') return null
  const s = bruto.trim().toLowerCase()
  if (['sim', 's', 'residencial', 'true', '1', 'casa', 'apartamento', 'moradia'].includes(s)) return true
  if (['nao', 'não', 'n', 'comercial', 'nao residencial', 'não residencial', 'false', '0', 'loja', 'sala', 'galpao', 'galpão'].includes(s)) {
    return false
  }
  return null
}

/**
 * Lê `servico.locacao` do payload (API, painel, planilha, IA) para o código da nota. Fora dos códigos de locação,
 * o campo é ignorado (`locacao: null`). Nos códigos de locação, devolve o que falta.
 * `valor` é o valor da nota (vServ): com copropriedade de 100%, o valor total é o próprio valor.
 */
export function lerLocacao(bruto: unknown, codigo: string, valor: string | null): LocacaoLida {
  if (!ehLocacao(codigo)) return { ok: true, locacao: null }
  const o = typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : null
  if (bruto !== undefined && bruto !== null && !o) return { ok: false, erro: 'deve ser um objeto', faltando: [] as CampoDoImovel[] }
  if (ehLocacaoDeImovel(codigo)) return lerImovel(o?.imovel ?? null, valor)
  return lerBens(o?.bens ?? null)
}

function lerImovel(bruto: unknown, valor: string | null): LocacaoLida {
  const o = typeof bruto === 'object' && bruto !== null && !Array.isArray(bruto) ? (bruto as Record<string, unknown>) : {}
  const falhar = (erro: string): LocacaoLida => ({ ok: false, erro, faltando: [] as CampoDoImovel[] })
  const municipio = !vazio(o.municipio_ibge) && municipioExiste(String(o.municipio_ibge).trim()) ? String(o.municipio_ibge).trim() : null
  if (!vazio(o.municipio_ibge) && !municipio) return falhar('municipio_ibge do imóvel deve ser um código IBGE de 7 dígitos que exista')
  let cib: string | null = null
  if (!vazio(o.cib)) {
    cib = String(o.cib).replace(/[^0-9A-Za-z]/g, '').toUpperCase()
    if (cib.length !== 8) return falhar('cib (Cadastro Imobiliário Brasileiro) deve ter 8 caracteres')
  }
  const cep = lerCep(o.cep)
  if (!vazio(o.cep) && !cep) return falhar('CEP do imóvel deve ter 8 dígitos')
  const logradouro = textoAte(o.logradouro, 255)
  const numero = textoAte(o.numero, 60)
  const complemento = vazio(o.complemento) ? null : textoAte(o.complemento, 156)
  if (!vazio(o.complemento) && !complemento) return falhar('complemento do imóvel passa de 156 caracteres')
  const bairro = vazio(o.bairro) ? null : textoAte(o.bairro, 60)
  if (!vazio(o.bairro) && !bairro) return falhar('bairro do imóvel passa de 60 caracteres')
  const inscricao = vazio(o.inscricao_imobiliaria) ? null : textoAte(o.inscricao_imobiliaria, 30)
  if (!vazio(o.inscricao_imobiliaria) && !inscricao) return falhar('inscrição imobiliária passa de 30 caracteres')
  const residencial = lerResidencial(o.residencial)
  if (!vazio(o.residencial) && residencial === null) return falhar('residencial deve ser sim ou não')

  const faltando: CampoDoImovel[] = []
  if (!municipio) faltando.push('municipio')
  // Com o CIB, o endereço é dispensado (escolha cCIB | end do gUnidImob).
  if (!cib) {
    if (!cep) faltando.push('cep')
    if (!logradouro) faltando.push('logradouro')
    if (!numero) faltando.push('numero')
  }
  if (residencial === null) faltando.push('residencial')
  if (faltando.length) {
    return { ok: false, erro: `imóvel sem ${faltando.map((k) => ROTULOS_DO_IMOVEL[k]).join(', ')}`, faltando }
  }

  const copropriedade = lerCopropriedade(o.copropriedade)
  if (!copropriedade) return falhar('copropriedade deve ser um percentual maior que 0 e até 100')
  const vencimento = lerData(o.vencimento)
  if (vencimento === false) return falhar('vencimento deve ser uma data (AAAA-MM-DD ou DD/MM/AAAA)')
  let valorTotal: string | null = vazio(o.valor_total) ? null : lerValor(o.valor_total)
  if (!vazio(o.valor_total) && !valorTotal) return falhar('valor_total deve ser um valor positivo')
  if (!valorTotal) {
    if (copropriedade !== '100.00') {
      return falhar('com copropriedade abaixo de 100%, informe valor_total (o aluguel inteiro); o valor da nota é a sua parte')
    }
    valorTotal = valor
  }
  if (valor && valorTotal) {
    // E0433: vServ = pCopropriedade × vTotOper (tolerância de R$ 0,01).
    const esperado = centavos(parteDoLocador(valorTotal, copropriedade))
    const diferenca = esperado - centavos(valor)
    if (diferenca > 1n || diferenca < -1n) {
      return falhar(
        `o valor da nota (${valor}) deve ser ${copropriedade}% do valor total do aluguel (${valorTotal}), ou seja, ${parteDoLocador(valorTotal, copropriedade)}`,
      )
    }
  }
  return {
    ok: true,
    locacao: {
      imovel: {
        municipio_ibge: municipio as string,
        cep: cib ? (cep ?? null) : cep,
        logradouro: cib ? (logradouro ?? null) : logradouro,
        numero: cib ? (numero ?? null) : numero,
        complemento,
        bairro,
        inscricao_imobiliaria: inscricao,
        cib,
        residencial: residencial as boolean,
        copropriedade,
        valor_total: valorTotal ?? '0.00',
        vencimento,
      },
    },
  }
}

function lerBens(bruto: unknown): LocacaoLida {
  const lista = Array.isArray(bruto) ? bruto : bruto && typeof bruto === 'object' ? [bruto] : []
  if (!lista.length) return { ok: false, erro: 'bem móvel sem NCM, descrição e quantidade', faltando: ['bens'] }
  if (lista.length > 1000) return { ok: false, erro: 'no máximo 1.000 bens por nota', faltando: [] as CampoDoImovel[] }
  const bens: BemLocado[] = []
  for (const [i, item] of lista.entries()) {
    const o = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    const n = lista.length > 1 ? ` (bem ${i + 1})` : ''
    const ncm = typeof o.ncm === 'string' || typeof o.ncm === 'number' ? String(o.ncm).replace(/\D/g, '') : ''
    if (!/^\d{8}$/.test(ncm)) return { ok: false, erro: `NCM do bem deve ter 8 dígitos${n}`, faltando: ['bens'] }
    const descricao = textoAte(o.descricao, 150)
    if (!descricao) return { ok: false, erro: `descrição do bem ausente ou acima de 150 caracteres${n}`, faltando: ['bens'] }
    const q = typeof o.quantidade === 'number' ? o.quantidade : vazio(o.quantidade) ? 1 : Number(String(o.quantidade).trim())
    if (!Number.isInteger(q) || q < 1 || q > 999) return { ok: false, erro: `quantidade do bem deve ser inteira, de 1 a 999${n}`, faltando: ['bens'] }
    bens.push({ ncm, descricao, quantidade: q })
  }
  return { ok: true, locacao: { bens } }
}

/** O que vai no payload (sem campos nulos). */
export function locacaoNoPayload(l: Locacao): Record<string, unknown> {
  if ('bens' in l) return { bens: l.bens.map((b) => ({ ...b })) }
  const sem = Object.fromEntries(Object.entries(l.imovel).filter(([, v]) => v !== null))
  return { imovel: sem }
}

/**
 * NBS da locação de bem móvel pelo NCM do primeiro bem (o Anexo VIII só sugere 1.1101.11.00, carro). A nota pode
 * mandar outra (`servico.nbs`), da família 1.1101/1.1102.
 */
export function nbsDoBemMovel(ncm: string): string {
  const p4 = ncm.slice(0, 4)
  const tabela: [string[], string][] = [
    [['8703'], '111011100'],
    [['8704', '8716'], '111011200'],
    [['8601', '8602', '8603', '8604', '8605', '8606'], '111011300'],
    [['8711', '8705', '8709'], '111011400'],
    [['8901', '8902', '8903', '8904', '8905', '8906'], '111011500'],
    [['8802', '8806'], '111011600'],
    [['8609'], '111011700'],
    [['8432', '8433', '8434', '8436', '8701'], '111012000'],
    [['8426', '8427', '8428', '8429', '8430', '8474'], '111013000'],
    [['8470', '8472', '8443'], '111014000'],
    [['8471'], '111015000'],
    [['8517', '8525', '8529'], '111016000'],
    [['8528', '8518', '8519', '8521', '8527'], '111021000'],
    [['9401', '9403', '9404', '8418', '8450', '8451', '8516', '8509', '8422'], '111023000'],
    [['9503', '9504', '9506', '9508'], '111024000'],
    [['6301', '6302', '6303', '6304'], '111025000'],
    [['6101', '6102', '6103', '6104', '6201', '6202', '6203', '6204', '6403', '6404'], '111026000'],
  ]
  for (const [prefixos, nbs] of tabela) if (prefixos.includes(p4)) return nbs
  // Máquinas e aparelhos (capítulos 84 e 85) sem posição acima: máquinas e equipamentos n.c.; o resto, outras mercadorias.
  return ncm.startsWith('84') || ncm.startsWith('85') || ncm.startsWith('90') ? '111019000' : '111029000'
}

/** NBS da locação: a da nota manda (conferida); senão, pelo tipo do imóvel ou pelo NCM do bem. */
export function nbsDaLocacao(codigo: string, locacao: Locacao, informada: string | null): { nbs: string } | { erro: string } {
  if ('imovel' in locacao) {
    if (informada) {
      if (informada !== NBS_IMOVEL_RESIDENCIAL && informada !== NBS_IMOVEL_NAO_RESIDENCIAL) {
        return { erro: 'na locação de imóvel a NBS é 1.1002.10.00 (residencial) ou 1.1002.20.00 (não residencial)' }
      }
      return { nbs: informada }
    }
    return { nbs: locacao.imovel.residencial ? NBS_IMOVEL_RESIDENCIAL : NBS_IMOVEL_NAO_RESIDENCIAL }
  }
  if (informada) {
    if (!nbsDeLocacaoMovel(informada)) return { erro: 'na locação de bem móvel a NBS é uma da família 1.1101 ou 1.1102 (arrendamento ou locação)' }
    return { nbs: informada }
  }
  void codigo
  return { nbs: nbsDoBemMovel(locacao.bens[0].ncm) }
}

/** Classificação do IBS/CBS da locação: a informada na nota, quando coerente; senão a do Anexo VIII. */
export function rtcDaLocacao(
  locacao: Locacao,
  informado: { cIndOp: string | null; cClassTrib: string | null },
): { cIndOp: string; cClassTrib: string } | { erro: string } {
  if ('imovel' in locacao) {
    if (informado.cIndOp && !/^02\d{4}$/.test(informado.cIndOp)) return { erro: 'na locação de imóvel o cIndOp é 02XXXX (E0902), em geral 020101' }
    return { cIndOp: informado.cIndOp ?? CIND_OP_IMOVEL, cClassTrib: informado.cClassTrib ?? CLASS_TRIB_IMOVEL }
  }
  if (informado.cIndOp && !CIND_OP_MOVEL.has(informado.cIndOp)) {
    return { erro: 'na locação de bem móvel o cIndOp é 010101, 010102, 010103 ou 010106 (bem móvel material)' }
  }
  return { cIndOp: informado.cIndOp ?? CIND_OP_MOVEL_PADRAO, cClassTrib: informado.cClassTrib ?? CLASS_TRIB_MOVEL }
}

/** `IBSCBS/imovel` ou a lista `IBSCBS/bensMoveis`, na ordem do XSD (iguais nos releases 1 e 2 da NT 009). */
export function gruposDaLocacao(locacao: Locacao): string {
  if ('bens' in locacao) {
    return locacao.bens
      .map((b) =>
        el('bensMoveis', [leaf('cNCMBemMovel', b.ncm), leaf('xNCMBemMovel', b.descricao), leaf('qtdNCMBemMovel', String(b.quantidade))]),
      )
      .join('')
  }
  const i = locacao.imovel
  const unidade = el('gUnidImob', [
    leaf('inscImobFisc', i.inscricao_imobiliaria),
    i.cib
      ? leaf('cCIB', i.cib)
      : el('end', [leaf('CEP', i.cep), leaf('xLgr', i.logradouro), leaf('nro', i.numero), leaf('xCpl', i.complemento), leaf('xBairro', i.bairro)]),
  ])
  return el('imovel', [
    leaf('cMun', i.municipio_ibge),
    el('gLocacao', [leaf('pCopropriedade', i.copropriedade), leaf('vTotOper', i.valor_total), leaf('dVencOrig', i.vencimento)]),
    unidade,
  ])
}

const mascaraCep = (cep: string) => `${cep.slice(0, 5)}-${cep.slice(5)}`
const brl = (v: string) => {
  const [i, f] = v.split('.')
  return `R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${f}`
}

/** Linhas do resumo antes de emitir (WhatsApp e painel): deixa claro que é locação. */
export function linhasDaLocacao(l: Locacao): string[] {
  if ('bens' in l) {
    return [
      'Tipo: locação de bem móvel (99.04.01), sem ISS',
      ...l.bens.map((b) => `Bem: ${b.quantidade} × ${b.descricao} (NCM ${b.ncm.slice(0, 4)}.${b.ncm.slice(4, 6)}.${b.ncm.slice(6)})`),
    ]
  }
  const i = l.imovel
  const endereco = i.cib
    ? `CIB ${i.cib}`
    : `${i.logradouro}, ${i.numero}${i.complemento ? `, ${i.complemento}` : ''}${i.bairro ? ` - ${i.bairro}` : ''}, CEP ${mascaraCep(i.cep as string)}`
  return [
    `Tipo: locação de imóvel ${i.residencial ? 'residencial' : 'não residencial'} (99.03.01), sem ISS`,
    `Imóvel: ${endereco}, ${rotuloMunicipio(i.municipio_ibge)}`,
    ...(i.inscricao_imobiliaria ? [`Inscrição imobiliária: ${i.inscricao_imobiliaria}`] : []),
    ...(i.copropriedade !== '100.00' ? [`Sua parte: ${i.copropriedade.replace('.', ',')}% de ${brl(i.valor_total)}`] : []),
    ...(i.vencimento ? [`Vencimento do aluguel: ${i.vencimento.split('-').reverse().join('/')}`] : []),
  ]
}

/** Avisos ao conferir (não bloqueiam): locação de imóvel próprio é atividade impeditiva do Simples (LC 123, art. 17, XV). */
export function avisosDaLocacao(codigo: string, regime: string | null | undefined): string[] {
  if (codigo === LOCACAO_IMOVEL && (regime === 'simples' || regime === 'mei')) {
    return ['Locação de imóvel próprio é atividade impeditiva do Simples Nacional (LC 123, art. 17, XV). Confirme com o contador antes de emitir.']
  }
  return []
}

export type ProblemaDaLocacao = 'LOCACAO_INDISPONIVEL' | 'LOCACAO_SEM_DADOS' | null

/** Locação com a flag desligada, ou sem os dados que a Sefin exige. `null` = pode emitir. */
export function problemaDaLocacao(
  d: { codigo: string; locacao: Locacao | null | undefined },
  env: Record<string, string | undefined> = process.env,
): ProblemaDaLocacao {
  if (!ehLocacao(d.codigo)) return null
  if (!locacaoLigada(env)) return 'LOCACAO_INDISPONIVEL'
  return d.locacao ? null : 'LOCACAO_SEM_DADOS'
}

export const MOTIVO_LOCACAO_SEM_DADOS_IMOVEL =
  'nota de locação de imóvel exige os dados do imóvel: cidade, CEP, rua e número (ou o CIB), e se é residencial ou comercial'
export const MOTIVO_LOCACAO_SEM_DADOS_MOVEL = 'nota de locação de bem móvel exige o bem: NCM (8 dígitos), descrição e quantidade'
export const motivoSemDados = (codigo: string) => (codigo === LOCACAO_IMOVEL ? MOTIVO_LOCACAO_SEM_DADOS_IMOVEL : MOTIVO_LOCACAO_SEM_DADOS_MOVEL)
