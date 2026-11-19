// Grupo `obra` da DPS (Robson, Contabilidade Bragantina, 19/11/2026: nota de alvenaria recusada com E0370).
//
// Anexo I v1.01, regra E0370: nos 13 subitens de construção civil abaixo o grupo `serv/obra` é obrigatório. A nó não
// mandava o grupo, e a Sefin recusava a nota. XSD v1.01 e NT 009 (iguais), `TCInfoObra`:
//   obra = inscImobFisc? , ( cObra | cCIB | end )
//   end  = TCEnderObraEvento = CEP , xLgr , nro , xCpl? , xBairro      (endExt fica de fora: obra no exterior)
// A nó envia `cObra` (CNO ou CEI, que a pessoa informa) ou `end`. O município da obra não vai no grupo: é o
// `cLocPrestacao` (local-prestacao.ts), onde o ISS desses códigos é devido (E1317).
//
// No payload: `servico.obra` = `{ cno }` ou `{ cep, logradouro, numero, complemento?, bairro }`.
import { el, leaf } from './xml.js'

/** E0370: grupo `obra` obrigatório. */
export const CODIGOS_COM_OBRA = new Set([
  '070201', '070202', '070401', '070501', '070502', '070601', '070602', '070701', '070801', '071701', '071901',
  '141403', '141404',
])

export const exigeObra = (codigo: string) => CODIGOS_COM_OBRA.has(codigo)

export type EnderecoDaObra = { cep: string; logradouro: string; numero: string; complemento: string | null; bairro: string }
export type Obra = { cno: string } | EnderecoDaObra

/**
 * `TSString` do XSD só aceita caracteres de U+0020 a U+00FF: travessão, aspas curvas e afins viram o equivalente
 * simples; o que sobrar fora da faixa sai. Espaços repetidos viram um.
 */
export function textoLatin1(bruto: string): string {
  return bruto
    .normalize('NFC')
    .replace(/[–—−]/g, '-')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/…/g, '...')
    .replace(/[^ -ÿ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** CNO (ou CEI) com ou sem máscara: 12 dígitos. */
export function lerCno(bruto: unknown): string | null {
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null
  const digitos = String(bruto).replace(/\D/g, '')
  return digitos.length === 12 ? digitos : null
}

export function lerCep(bruto: unknown): string | null {
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null
  const digitos = String(bruto).replace(/\D/g, '')
  return digitos.length === 8 && digitos !== '00000000' ? digitos : null
}

const LIMITES = { logradouro: 255, numero: 60, complemento: 156, bairro: 60 } as const
const ROTULOS = { cep: 'CEP', logradouro: 'rua', numero: 'número', bairro: 'bairro' } as const
export type CampoDaObra = keyof typeof ROTULOS

function campo(bruto: unknown, max: number): string | null {
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null
  const texto = textoLatin1(String(bruto))
  return texto.length >= 1 && texto.length <= max ? texto : null
}

export type ObraLida = { ok: true; obra: Obra | null } | { ok: false; erro: string; faltando: CampoDaObra[] }

/**
 * Lê `servico.obra` (payload, API, painel, planilha, IA). Ausente ou vazio = sem obra. Com CNO válido, vale o CNO;
 * senão, o endereço precisa de CEP, rua, número e bairro (o complemento é opcional). "s/n" vale como número.
 */
export function lerObra(bruto: unknown): ObraLida {
  if (bruto === undefined || bruto === null) return { ok: true, obra: null }
  if (typeof bruto !== 'object' || Array.isArray(bruto)) return { ok: false, erro: 'deve ser um objeto', faltando: [] }
  const o = bruto as Record<string, unknown>
  const vazio = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
  const chaves = ['cno', 'cep', 'logradouro', 'numero', 'complemento', 'bairro'] as const
  if (chaves.every((k) => vazio(o[k]))) return { ok: true, obra: null }
  if (!vazio(o.cno)) {
    const cno = lerCno(o.cno)
    if (cno) return { ok: true, obra: { cno } }
    // CNO errado com endereço completo: vale o endereço; sem endereço, o erro é do CNO.
    if (['cep', 'logradouro', 'numero', 'bairro'].every((k) => vazio(o[k]))) {
      return { ok: false, erro: 'cno deve ter 12 dígitos (CNO ou CEI da obra)', faltando: [] }
    }
  }
  const lido = {
    cep: lerCep(o.cep),
    logradouro: campo(o.logradouro, LIMITES.logradouro),
    numero: campo(o.numero, LIMITES.numero),
    bairro: campo(o.bairro, LIMITES.bairro),
  }
  const faltando = (Object.keys(lido) as CampoDaObra[]).filter((k) => lido[k] === null)
  if (faltando.length) {
    return { ok: false, erro: `endereço da obra sem ${faltando.map((k) => ROTULOS[k]).join(', ')} (ou com formato inválido)`, faltando }
  }
  const complemento = vazio(o.complemento) ? null : campo(o.complemento, LIMITES.complemento)
  if (!vazio(o.complemento) && complemento === null) return { ok: false, erro: `complemento passa de ${LIMITES.complemento} caracteres`, faltando: [] }
  return {
    ok: true,
    obra: { cep: lido.cep as string, logradouro: lido.logradouro as string, numero: lido.numero as string, complemento, bairro: lido.bairro as string },
  }
}

/** O que vai no payload (sem `complemento` nulo). */
export function obraNoPayload(obra: Obra): Record<string, string> {
  if ('cno' in obra) return { cno: obra.cno }
  const { cep, logradouro, numero, complemento, bairro } = obra
  return { cep, logradouro, numero, ...(complemento ? { complemento } : {}), bairro }
}

const mascaraCep = (cep: string) => `${cep.slice(0, 5)}-${cep.slice(5)}`
const mascaraCno = (cno: string) => `${cno.slice(0, 2)}.${cno.slice(2, 5)}.${cno.slice(5, 10)}/${cno.slice(10)}`

/** "Rua das Flores, 120, casa 2 - Centro, CEP 12900-000" ou "CNO 12.345.67890/12". */
export function rotuloDaObra(obra: Obra): string {
  if ('cno' in obra) return `CNO ${mascaraCno(obra.cno)}`
  return `${obra.logradouro}, ${obra.numero}${obra.complemento ? `, ${obra.complemento}` : ''} - ${obra.bairro}, CEP ${mascaraCep(obra.cep)}`
}

/** `serv/obra` da DPS. */
export function grupoObra(obra: Obra): string {
  if ('cno' in obra) return el('obra', leaf('cObra', obra.cno))
  return el(
    'obra',
    el('end', [leaf('CEP', obra.cep), leaf('xLgr', obra.logradouro), leaf('nro', obra.numero), leaf('xCpl', obra.complemento), leaf('xBairro', obra.bairro)]),
  )
}

export const MOTIVO_SEM_OBRA =
  'este código de serviço é de construção civil, e a Sefin exige os dados da obra na nota: o endereço (CEP, rua, número e bairro) ou o CNO'

/** Código de obra sem os dados da obra: a Sefin recusaria (E0370). `null` = pode emitir. */
export function problemaDaObra(d: { codigo: string; obra: Obra | null | undefined }): 'OBRA_SEM_DADOS' | null {
  return exigeObra(d.codigo) && !d.obra ? 'OBRA_SEM_DADOS' : null
}
