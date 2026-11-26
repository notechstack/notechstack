// Nota de locação pelo WhatsApp ("nota de aluguel do imóvel da rua X pra Fulano, 2.500 reais"). A IA lê o que a
// pessoa escreveu do imóvel ou do bem (`Parsed.locacao`); aqui isso vira o `servico.locacao` do payload (locacao.ts),
// e o que faltar vira uma pergunta guiada. Como na obra, cada mensagem soma ao rascunho do pedido.
//
// Imóvel: cidade (padrão: a da empresa, que aparece no resumo para a pessoa conferir), CEP, rua, número, bairro e
// complemento opcionais, inscrição imobiliária opcional, residencial ou não (decide a NBS). Bem móvel: o que é, o NCM
// (8 dígitos, está na nota de compra do bem) e a quantidade (padrão 1).
import {
  ehLocacaoDeImovel,
  lerLocacao,
  LOCACAO_IMOVEL,
  LOCACAO_MOVEL,
  type CampoDoImovel,
  type Locacao,
} from '../locacao.js'
import { resolverMunicipio } from '../local-prestacao.js'

/** O que a IA leu da locação, como escrito. `tipo` decide o código: imóvel 99.03.01, bem móvel 99.04.01. */
export type LocacaoEscrita = Partial<
  Record<
    | 'cidade' | 'cep' | 'logradouro' | 'numero' | 'complemento' | 'bairro' | 'inscricao_imobiliaria' | 'residencial' | 'copropriedade'
    | 'valor_total' | 'vencimento' | 'bem' | 'ncm' | 'quantidade',
    string
  >
> & { tipo?: 'imovel' | 'movel' }

const LIMITES: Record<Exclude<keyof LocacaoEscrita, 'tipo'>, number> = {
  cidade: 80, cep: 12, logradouro: 255, numero: 60, complemento: 156, bairro: 60, inscricao_imobiliaria: 30, residencial: 20,
  copropriedade: 10, valor_total: 20, vencimento: 12, bem: 150, ncm: 12, quantidade: 6,
}

/** Só os campos conhecidos, cada um texto curto; nada escrito = `null`. */
export function locacaoEscrita(bruto: unknown): LocacaoEscrita | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null
  const o = bruto as Record<string, unknown>
  const lida: LocacaoEscrita = {}
  if (o.tipo === 'imovel' || o.tipo === 'movel') lida.tipo = o.tipo
  for (const [campo, max] of Object.entries(LIMITES) as [Exclude<keyof LocacaoEscrita, 'tipo'>, number][]) {
    const v = o[campo]
    const texto = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
    if (texto && texto.length <= max) lida[campo] = texto
  }
  return Object.keys(lida).length ? lida : null
}

/** Código da nota pelo tipo da locação escrita; `null` = o pedido não é de locação. */
export const codigoDaLocacao = (l: LocacaoEscrita | null | undefined): string | null =>
  l?.tipo === 'imovel' ? LOCACAO_IMOVEL : l?.tipo === 'movel' ? LOCACAO_MOVEL : null

/** Soma o que a mensagem trouxe ao rascunho (o novo vale sobre o antigo). */
export function juntarLocacao(rascunho: LocacaoEscrita | null | undefined, nova: LocacaoEscrita | null | undefined): LocacaoEscrita | null {
  const preenchidos = Object.fromEntries(Object.entries(nova ?? {}).filter(([, v]) => typeof v === 'string' && v !== '')) as LocacaoEscrita
  const junto: LocacaoEscrita = { ...(rascunho ?? {}), ...preenchidos }
  return Object.keys(junto).length ? junto : null
}

export type LocacaoDoRascunho =
  | { ok: true; locacao: Locacao; cidadePadrao: boolean }
  | { ok: false; faltando: string[]; erro: string | null }

const NOMES: Record<CampoDoImovel, string> = {
  municipio: 'a cidade do imóvel',
  cep: 'o CEP',
  logradouro: 'a rua',
  numero: 'o número',
  residencial: 'se é residencial ou comercial',
}

/**
 * O rascunho vira `servico.locacao`. A cidade do imóvel, sem ser escrita, é a da empresa (`sede`); homônima sem UF ou
 * desconhecida volta como erro, para a pessoa repetir com a UF.
 */
export function locacaoDoRascunho(
  r: LocacaoEscrita | null | undefined,
  codigo: string,
  valor: string,
  sede: string | null,
): LocacaoDoRascunho {
  const e = r ?? {}
  if (ehLocacaoDeImovel(codigo)) {
    let municipio = sede
    if (e.cidade) {
      const m = resolverMunicipio(e.cidade)
      if (!m.ok) {
        const erro =
          m.motivo === 'ambiguo'
            ? `Há mais de uma cidade chamada ${m.nome} (${m.opcoes.map((o) => o.uf).join(', ')}). Me diga a cidade do imóvel com a UF, por exemplo: ${m.nome}/${m.opcoes[0].uf}.`
            : `Não achei a cidade "${e.cidade}". Me diga a cidade do imóvel com a UF, por exemplo: Campinas/SP.`
        return { ok: false, faltando: [], erro }
      }
      municipio = m.municipio.ibge
    }
    const lida = lerLocacao(
      {
        imovel: {
          municipio_ibge: municipio,
          cep: e.cep,
          logradouro: e.logradouro,
          numero: e.numero,
          complemento: e.complemento,
          bairro: e.bairro,
          inscricao_imobiliaria: e.inscricao_imobiliaria,
          residencial: e.residencial,
          copropriedade: e.copropriedade,
          valor_total: e.valor_total,
          vencimento: e.vencimento,
        },
      },
      codigo,
      valor,
    )
    if (!lida.ok) {
      const faltando = (lida.faltando as CampoDoImovel[]).map((c) => NOMES[c] ?? c)
      return { ok: false, faltando, erro: faltando.length ? null : `Não deu para usar os dados do imóvel: ${lida.erro}.` }
    }
    return { ok: true, locacao: lida.locacao as Locacao, cidadePadrao: !e.cidade }
  }
  const faltando = [!e.bem && 'o que é o bem (ex.: carro, betoneira, notebook)', !e.ncm && 'o NCM do bem (8 dígitos, está na nota de compra)'].filter(
    Boolean,
  ) as string[]
  if (faltando.length) return { ok: false, faltando, erro: null }
  const lida = lerLocacao({ bens: [{ ncm: e.ncm, descricao: e.bem, quantidade: e.quantidade ?? 1 }] }, codigo, valor)
  if (!lida.ok) return { ok: false, faltando: [], erro: `Não deu para usar os dados do bem: ${lida.erro}.` }
  return { ok: true, locacao: lida.locacao as Locacao, cidadePadrao: false }
}

const lista = (itens: string[]) => (itens.length > 1 ? `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}` : itens[0])

/** Pergunta guiada pelo que falta. O pedido fica em correção: a resposta completa a nota, sem *corrigir*. */
export function textoDaLocacaoQueFalta(codigo: string, faltando: string[], erro: string | null, cidadeDaEmpresa: string | null): string {
  if (erro) return `${erro} Ou responda *descartar*.`
  const imovel = ehLocacaoDeImovel(codigo)
  const tudo = !faltando.length || (imovel ? faltando.length >= 4 : faltando.length >= 2)
  if (!tudo) return `Para a nota de locação, faltou ${lista(faltando)}. Me mande o que falta, e eu monto a nota. Ou responda *descartar*.`
  if (imovel) {
    const cidade = cidadeDaEmpresa ? `, e a cidade, se não for ${cidadeDaEmpresa}` : ', e a cidade'
    return [
      'Nota de locação de imóvel: a Receita exige os dados do imóvel na nota. Nada foi emitido ainda.',
      `Me mande o endereço do imóvel (rua, número, bairro, CEP${cidade}) e se ele é residencial ou comercial. Por exemplo: Rua das Flores, 120, apto 32, Centro, CEP 13015-100, Campinas/SP, residencial.`,
      'Se tiver a inscrição imobiliária (do IPTU), pode mandar junto. Para desistir, responda *descartar*.',
    ].join('\n')
  }
  return [
    'Nota de locação de bem móvel: a Receita exige o bem na nota. Nada foi emitido ainda.',
    'Me diga o que é o bem, o NCM dele (8 dígitos, está na nota de compra) e a quantidade. Por exemplo: 2 carros, NCM 8703.23.10.',
    'Para desistir, responda *descartar*.',
  ].join('\n')
}
