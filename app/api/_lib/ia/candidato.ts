// Candidato a modelo na base de clientes (Surface da tarefa; Landing de .checks/agente-fiscal-v2.md,
// lote D - contrato do candidato). Tudo o que vem do ADN, da IA ou da página passa por aqui: o que
// o código não valida vira `null` no candidato, e o `salvar` ignora com motivo o que não pode virar
// modelo.
import { cnpjValido, cpfValido } from '../agente/documentos.js'
import { valorValido } from '../agente/interprete.js'

export type Origem = 'importacao_adn' | 'importacao_pdf'

export type Endereco = {
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  codigo_municipio: string | null
  uf: string | null
  cep: string | null
}

export type Candidato = {
  nome: string | null
  tomador_documento: string | null
  tomador_nome: string | null
  tomador_email: string | null
  tomador_endereco: Endereco | null
  codigo_servico_nacional: string | null
  descricao: string | null
  valor_padrao: string | null
  origem: Origem
}

export const NOME_MODELO_MAX = 60
const NOME_TOMADOR_MAX = 150
const DESCRICAO_MAX = 2000
// A mesma regra do check de `fiscal_models.tomador_email`.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

type Bruto = Record<string, unknown>

const objeto = (valor: unknown): Bruto | null =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor) ? (valor as Bruto) : null

/** Texto aparado, com espaços colapsados, entre 1 e `max` caracteres; senão `null`. */
export function textoLimpo(valor: unknown, max: number): string | null {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim().replace(/\s+/g, ' ')
  return limpo.length >= 1 && limpo.length <= max ? limpo : null
}

export function documentoValido(valor: unknown): string | null {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null
  const digitos = String(valor).replace(/\D/g, '')
  if (digitos.length === 11 && cpfValido(digitos)) return digitos
  if (digitos.length === 14 && cnpjValido(digitos)) return digitos
  return null
}

export function codigoServicoValido(valor: unknown): string | null {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim()
  return /^\d{6}$/.test(limpo) ? limpo : null
}

export function emailValido(valor: unknown): string | null {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim()
  return limpo.length <= 254 && EMAIL.test(limpo) ? limpo : null
}

/** Descrição do serviço: mantém as quebras de linha, só apara as pontas. */
function descricaoValida(valor: unknown): string | null {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim()
  return limpo.length >= 1 && limpo.length <= DESCRICAO_MAX ? limpo : null
}

export function enderecoValido(valor: unknown): Endereco | null {
  const obj = objeto(valor)
  if (!obj) return null
  const campo = (nome: string, max: number) => textoLimpo(typeof obj[nome] === 'number' ? String(obj[nome]) : obj[nome], max)
  const cep = campo('cep', 9)?.replace(/\D/g, '') ?? null
  const municipio = campo('codigo_municipio', 7)
  const uf = campo('uf', 2)?.toUpperCase() ?? null
  const endereco: Endereco = {
    logradouro: campo('logradouro', 255),
    numero: campo('numero', 60),
    complemento: campo('complemento', 156),
    bairro: campo('bairro', 60),
    codigo_municipio: municipio && /^\d{7}$/.test(municipio) ? municipio : null,
    uf: uf && /^[A-Z]{2}$/.test(uf) ? uf : null,
    cep: cep && /^\d{8}$/.test(cep) ? cep : null,
  }
  return Object.values(endereco).some((v) => v !== null) ? endereco : null
}

/** Nome do modelo: o dado, ou o do tomador, cortado no limite de `fiscal_models.nome`. */
function nomeDoModelo(nome: unknown, tomadorNome: string | null): string | null {
  const dado = textoLimpo(nome, NOME_TOMADOR_MAX) ?? tomadorNome
  return dado ? dado.slice(0, NOME_MODELO_MAX).trim() : null
}

/** Candidato com cada campo validado; o que não passa fica `null`. */
export function candidatoValidado(bruto: unknown, origem: Origem): Candidato {
  const obj = objeto(bruto) ?? {}
  const tomadorNome = textoLimpo(obj.tomador_nome, NOME_TOMADOR_MAX)
  return {
    nome: nomeDoModelo(obj.nome, tomadorNome),
    tomador_documento: documentoValido(obj.tomador_documento),
    tomador_nome: tomadorNome,
    tomador_email: emailValido(obj.tomador_email),
    tomador_endereco: enderecoValido(obj.tomador_endereco),
    codigo_servico_nacional: codigoServicoValido(obj.codigo_servico_nacional),
    descricao: descricaoValida(obj.descricao),
    valor_padrao: valorValido(obj.valor_padrao),
    origem,
  }
}

export type MotivoIgnorado =
  | 'documento_invalido'
  | 'sem_nome'
  | 'codigo_servico_invalido'
  | 'sem_descricao'
  | 'email_invalido'
  | 'origem_invalida'
  | 'nome_repetido'

export type ModeloParaGravar = {
  nome: string
  tomador_documento: string
  tomador_nome: string
  tomador_email: string | null
  tomador_endereco: Endereco | null
  codigo_servico_nacional: string
  descricao: string
  valor_padrao: string | null
  origem: Origem
}

/**
 * Confere um candidato enviado pela página para o `salvar`. Diferente da leitura, aqui o campo
 * obrigatório inválido não vira `null`: o candidato inteiro é ignorado, com o motivo.
 */
export function modeloParaGravar(bruto: unknown): { ok: true; modelo: ModeloParaGravar } | { ok: false; nome: string | null; motivo: MotivoIgnorado } {
  const obj = objeto(bruto) ?? {}
  const origem = obj.origem === 'importacao_adn' || obj.origem === 'importacao_pdf' ? obj.origem : null
  const tomadorNome = textoLimpo(obj.tomador_nome, NOME_TOMADOR_MAX) ?? textoLimpo(obj.nome, NOME_TOMADOR_MAX)
  const nome = nomeDoModelo(obj.nome, tomadorNome)
  const falha = (motivo: MotivoIgnorado) => ({ ok: false as const, nome, motivo })

  const documento = documentoValido(obj.tomador_documento)
  if (!documento) return falha('documento_invalido')
  if (!nome || !tomadorNome) return falha('sem_nome')
  const codigo = codigoServicoValido(obj.codigo_servico_nacional)
  if (!codigo) return falha('codigo_servico_invalido')
  const descricao = descricaoValida(obj.descricao)
  if (!descricao) return falha('sem_descricao')
  const emailInformado = obj.tomador_email !== null && obj.tomador_email !== undefined && obj.tomador_email !== ''
  const email = emailValido(obj.tomador_email)
  if (emailInformado && !email) return falha('email_invalido')
  if (!origem) return falha('origem_invalida')

  return {
    ok: true,
    modelo: {
      nome,
      tomador_documento: documento,
      tomador_nome: tomadorNome,
      tomador_email: email,
      tomador_endereco: enderecoValido(obj.tomador_endereco),
      codigo_servico_nacional: codigo,
      descricao,
      valor_padrao: valorValido(obj.valor_padrao),
      origem,
    },
  }
}
