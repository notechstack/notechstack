// Corpo de `POST /v1/nfse`, forma literal no Landing do checklist (lote 2a - corpo).
// Campo desconhecido em qualquer nível é recusado: é assim que nenhuma rota aceita PFX
// ou senha por engano (critério 31) e que um erro de digitação da Prontia aparece logo.
// Tomador: `cpf` (11 dígitos) ou `cnpj` (14 dígitos), exatamente um dos dois (Landing de
// .checks/agente-fiscal-whatsapp.md, lote B2 - tomador pessoa jurídica).

export type TomadorPayload = { cpf: string; nome: string } | { cnpj: string; nome: string }

export type InvoicePayload = {
  tomador: TomadorPayload
  servico: { codigo_servico_nacional: string; descricao: string }
  valor: string
}

export type NewInvoice = { external_id: string; payload: InvoicePayload }

export type ValidationResult =
  | { ok: true; value: NewInvoice }
  | { ok: false; code: 'VALIDATION_FAILED' | 'UNKNOWN_FIELD'; message: string }

type Obj = Record<string, unknown>

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function unknownField(obj: Obj, allowed: string[], prefix: string): string | null {
  const extra = Object.keys(obj).find((key) => !allowed.includes(key))
  return extra === undefined ? null : `${prefix}${extra}`
}

function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null
}

function money(value: unknown): string | null {
  let raw: string
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    raw = String(value)
  } else if (typeof value === 'string') {
    raw = value.trim()
  } else {
    return null
  }
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(raw)
  if (!match) return null
  const normalized = `${BigInt(match[1])}.${(match[2] ?? '').padEnd(2, '0')}`
  return /^0\.00$/.test(normalized) ? null : normalized
}

export function parseNewInvoice(body: unknown): ValidationResult {
  const fail = (message: string): ValidationResult => ({ ok: false, code: 'VALIDATION_FAILED', message })
  if (!isObject(body)) return fail('o corpo deve ser um objeto JSON')

  const extra =
    unknownField(body, ['external_id', 'tomador', 'servico', 'valor'], '') ??
    (isObject(body.tomador) ? unknownField(body.tomador, ['cpf', 'cnpj', 'nome'], 'tomador.') : null) ??
    (isObject(body.servico) ? unknownField(body.servico, ['codigo_servico_nacional', 'descricao'], 'servico.') : null)
  if (extra) return { ok: false, code: 'UNKNOWN_FIELD', message: `campo não aceito: ${extra}` }

  const externalId = text(body.external_id, 1, 100)
  if (!externalId) return fail('external_id deve ter de 1 a 100 caracteres')
  if (!isObject(body.tomador)) return fail('tomador é obrigatório')
  if (!isObject(body.servico)) return fail('servico é obrigatório')

  const temCpf = body.tomador.cpf !== undefined
  const temCnpj = body.tomador.cnpj !== undefined
  if (temCpf === temCnpj) return fail('tomador deve ter cpf ou cnpj, exatamente um dos dois')
  const cpf = typeof body.tomador.cpf === 'string' && /^\d{11}$/.test(body.tomador.cpf) ? body.tomador.cpf : null
  if (temCpf && !cpf) return fail('tomador.cpf deve ter 11 dígitos')
  const cnpj = typeof body.tomador.cnpj === 'string' && /^\d{14}$/.test(body.tomador.cnpj) ? body.tomador.cnpj : null
  if (temCnpj && !cnpj) return fail('tomador.cnpj deve ter 14 dígitos, só números')
  const nome = text(body.tomador.nome, 1, 150)
  if (!nome) return fail('tomador.nome deve ter de 1 a 150 caracteres')
  const codigo = text(body.servico.codigo_servico_nacional, 1, 20)
  if (!codigo) return fail('servico.codigo_servico_nacional deve ter de 1 a 20 caracteres')
  const descricao = text(body.servico.descricao, 1, 2000)
  if (!descricao) return fail('servico.descricao deve ter de 1 a 2000 caracteres')
  const valor = money(body.valor)
  if (!valor) return fail('valor deve ser decimal positivo com até 2 casas')

  return {
    ok: true,
    value: {
      external_id: externalId,
      payload: {
        tomador: cpf ? { cpf, nome } : { cnpj: cnpj as string, nome },
        servico: { codigo_servico_nacional: codigo, descricao },
        valor,
      },
    },
  }
}
