// Endereço do tomador em toda NFS-e (Robson, Contabilidade Bragantina, 24/11/2026: "inadmissível" a nota sair só com
// CNPJ e nome). Antes, o endereço só ia com ISS retido (E0237) e 31 das 33 notas de produção saíram sem `toma/end`.
//
// Regra (vale para WhatsApp, planilha, painel e API, inclusive a do parceiro):
//   1. Endereço informado pela pessoa (planilha, painel, API) prevalece sobre o da Receita.
//   2. Tomador com CNPJ e sem endereço informado: consulta pelo CNPJ (consulta-cnpj.ts, com cache em
//      `nofiscal.fiscal_tomador_enderecos`, `enderecoComCache`).
//   3. A consulta falhou: sem ISS retido a nota sai sem endereço (não trava) e fica registrado; com ISS retido a nota
//      continua barrada (ENDERECO_TOMADOR, E0237).
//   4. Tomador com CPF: só o endereço informado. Nada é inventado.
// No payload, `tomador.endereco` é o `EnderecoNacional` (retencao.ts), que o dps-builder grava em `toma/end/endNac`.
import type { Queryable } from './db.js'
import { logEvent } from './log.js'
import { resolverMunicipio, rotuloMunicipio } from './local-prestacao.js'
import { lerCep, textoLatin1 } from './obra.js'
import { enderecoValido, type EnderecoDoTomador, type EnderecoNacional } from './retencao.js'

/** O endereço como a pessoa escreve (planilha `tomador_*`, painel, API `tomador.endereco`). Tudo opcional. */
export type EnderecoEscrito = {
  cep?: unknown
  logradouro?: unknown
  numero?: unknown
  complemento?: unknown
  bairro?: unknown
  /** Código IBGE (7 dígitos) ou "Cidade/UF". */
  municipio?: unknown
}

export const CAMPOS_DO_ENDERECO = ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'municipio'] as const

const ROTULOS = { cep: 'CEP', logradouro: 'rua', bairro: 'bairro', municipio: 'cidade' } as const
const LIMITES = { logradouro: 255, numero: 60, complemento: 156, bairro: 60 } as const

const vazio = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (typeof v === 'number' && !Number.isFinite(v))

function campo(bruto: unknown, max: number): string | null {
  if (typeof bruto !== 'string' && typeof bruto !== 'number') return null
  const t = textoLatin1(String(bruto))
  return t.length >= 1 && t.length <= max ? t : null
}

/** Célula numérica do Excel perde o zero do CEP ("9220140"): 7 dígitos voltam a ter 8. */
function cepEscrito(bruto: unknown): string | null {
  if (typeof bruto === 'number' && Number.isInteger(bruto) && bruto > 0) return lerCep(String(bruto).padStart(8, '0'))
  if (typeof bruto === 'string' && /^\d{7}$/.test(bruto.trim())) return lerCep(bruto.trim().padStart(8, '0'))
  return lerCep(bruto)
}

export type EnderecoLido = { ok: true; endereco: EnderecoNacional | null } | { ok: false; erro: string }

/**
 * Lê o endereço escrito. Tudo vazio = sem endereço. Com algum campo, valem CEP, rua, bairro e cidade (código IBGE ou
 * "Cidade/UF"); número vazio vira "S/N"; complemento é opcional.
 */
export function lerEnderecoEscrito(bruto: EnderecoEscrito | null | undefined): EnderecoLido {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return bruto === undefined || bruto === null ? { ok: true, endereco: null } : { ok: false, erro: 'deve ser um objeto' }
  const e = bruto as Record<string, unknown>
  if (CAMPOS_DO_ENDERECO.every((k) => vazio(e[k]))) return { ok: true, endereco: null }
  let cMun: string | null = null
  if (!vazio(e.municipio)) {
    const r = resolverMunicipio(String(e.municipio))
    if (r.ok) cMun = r.municipio.ibge
    else if (r.motivo === 'ambiguo') return { ok: false, erro: `há ${r.opcoes.length} cidades chamadas ${r.nome}: escreva com a UF (por exemplo ${r.nome}/${r.opcoes[0].uf})` }
  }
  const lido = { cep: cepEscrito(e.cep), logradouro: campo(e.logradouro, LIMITES.logradouro), bairro: campo(e.bairro, LIMITES.bairro), municipio: cMun }
  const faltando = (Object.keys(lido) as (keyof typeof lido)[]).filter((k) => lido[k] === null)
  if (faltando.length) return { ok: false, erro: `endereço do cliente sem ${faltando.map((k) => ROTULOS[k]).join(', ')} (ou com formato inválido)` }
  const numero = vazio(e.numero) ? 'S/N' : campo(e.numero, LIMITES.numero)
  if (!numero) return { ok: false, erro: `número do endereço passa de ${LIMITES.numero} caracteres` }
  const complemento = vazio(e.complemento) ? null : campo(e.complemento, LIMITES.complemento)
  if (!vazio(e.complemento) && !complemento) return { ok: false, erro: `complemento do endereço passa de ${LIMITES.complemento} caracteres` }
  return {
    ok: true,
    endereco: { cMun: cMun as string, cep: lido.cep as string, logradouro: lido.logradouro as string, numero, complemento, bairro: lido.bairro as string },
  }
}

export type EnderecoResolvido = {
  endereco: EnderecoNacional | null
  /** De onde veio: o que a pessoa escreveu, a Receita (consulta ou cache), ou nada. */
  origem: 'informado' | 'receita' | null
  /** Tomador com CNPJ cuja consulta não achou o endereço (a nota sai sem, se não houver ISS retido). */
  consultaFalhou: boolean
}

/** Informado > Receita (só CNPJ) > nenhum. Nunca lança: a consulta que falha vira `consultaFalhou`. */
export async function resolverEnderecoDoTomador(d: {
  documento: string
  informado?: EnderecoNacional | null
  consulta?: EnderecoDoTomador | null
}): Promise<EnderecoResolvido> {
  if (d.informado) return { endereco: d.informado, origem: 'informado', consultaFalhou: false }
  if (!/^\d{14}$/.test(d.documento)) return { endereco: null, origem: null, consultaFalhou: false }
  const endereco = d.consulta ? await d.consulta.endereco(d.documento).catch(() => null) : null
  return endereco ? { endereco, origem: 'receita', consultaFalhou: false } : { endereco: null, origem: null, consultaFalhou: true }
}

export const AVISO_SEM_ENDERECO =
  'Não achei o endereço deste CNPJ na Receita agora: a nota sai sem o endereço do cliente. Se quiser o endereço na nota, informe-o.'

/** Registra a nota que vai sair sem endereço por falha da consulta (sem o CNPJ na log). */
export function registrarSemEndereco(canal: 'whatsapp' | 'planilha' | 'painel' | 'api', dados: Record<string, unknown> = {}) {
  logEvent('nofiscal.endereco_tomador_ausente', { canal, ...dados })
}

const mascaraCep = (cep: string) => `${cep.slice(0, 5)}-${cep.slice(5)}`

/** "Rua das Flores, 120, sala 2 - Centro, Bragança Paulista/SP, CEP 12900-000". */
export function rotuloDoEndereco(e: EnderecoNacional): string {
  return `${e.logradouro}, ${e.numero}${e.complemento ? `, ${e.complemento}` : ''} - ${e.bairro}, ${rotuloMunicipio(e.cMun)}, CEP ${mascaraCep(e.cep)}`
}

// ---------------------------------------------------------------------------------------
// Cache por CNPJ (dado público da Receita, igual para todas as contas).

/** Endereço guardado vale 30 dias; depois, consulta de novo. Se a consulta falhar, o guardado (vencido) ainda serve. */
export const VALIDADE_DO_ENDERECO_MS = 30 * 24 * 3600_000

/**
 * Envolve a consulta com a tabela `nofiscal.fiscal_tomador_enderecos`. Erro de banco (tabela ausente, pooler) não
 * trava nada: cai na consulta direta.
 */
export function enderecoComCache(base: EnderecoDoTomador, db: Queryable, agora: () => Date = () => new Date()): EnderecoDoTomador {
  return {
    async endereco(cnpj) {
      let guardado: EnderecoNacional | null = null
      let fresco = false
      try {
        const { rows } = await db.query<{ endereco: unknown; consultado_em: Date | string }>(
          'select endereco, consultado_em from nofiscal.fiscal_tomador_enderecos where cnpj = $1',
          [cnpj],
        )
        if (rows[0]) {
          guardado = enderecoValido(rows[0].endereco)
          fresco = agora().getTime() - new Date(rows[0].consultado_em).getTime() < VALIDADE_DO_ENDERECO_MS
        }
      } catch {
        guardado = null
      }
      if (guardado && fresco) return guardado
      const novo = await base.endereco(cnpj).catch(() => null)
      if (!novo) return guardado
      try {
        await db.query(
          `insert into nofiscal.fiscal_tomador_enderecos (cnpj, endereco, consultado_em) values ($1, $2::jsonb, $3)
           on conflict (cnpj) do update set endereco = excluded.endereco, consultado_em = excluded.consultado_em`,
          [cnpj, JSON.stringify(novo), agora()],
        )
      } catch {
        // Sem cache, a próxima nota consulta de novo.
      }
      return novo
    },
  }
}
