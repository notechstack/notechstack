import { supabase } from '../lib/supabase'

// Central de conversas do nó.fiscal: fala com a rota /api/v1/fiscal/central (NO_ADMIN com aal2), que
// guarda e lê as mensagens no schema `nofiscal`. O telefone vai sempre no corpo, nunca na URL.

export type Etiqueta =
  | 'pediu_atendente' | 'erro_de_envio' | 'com_a_equipe' | 'aguardando_confirmacao' | 'perguntando_descricao'
  | 'pedindo_dados' | 'escolhendo_nota' | 'salvar_modelo' | 'sem_conta'

export type Autor = 'cliente' | 'robo' | 'equipe'

export type ConversaResumo = {
  telefone: string
  empresa: string | null
  ultima: { direcao: 'entrada' | 'saida'; autor: Autor; tipo: string; texto: string | null; arquivo: string | null; status: string | null; em: string }
  etiquetas: Etiqueta[]
}

export type Mensagem = {
  id: string
  direcao: 'entrada' | 'saida'
  autor: Autor
  tipo: string
  texto: string | null
  arquivo: string | null
  status: 'enviada' | 'entregue' | 'lida' | 'falhou' | null
  erro: string | null
  em: string
}

export type Evento = { id: string; tipo: string; detalhe: string | null; em: string }

export type ConversaAberta = {
  telefone: string
  empresa: string | null
  papel: 'owner' | 'authorized' | null
  plano: string | null
  janela: { aberta: boolean; fecha_em: string | null }
  assumida_ate: string | null
  mensagens: Mensagem[]
  eventos: Evento[]
}

export type Leitura = { agora: string; conversas: ConversaResumo[]; conversa: ConversaAberta | null }

export class ErroCentral extends Error {
  constructor(message: string, readonly codigo: string | null) {
    super(message)
    this.name = 'ErroCentral'
  }
}

async function chamar<T>(metodo: 'GET' | 'POST', corpo?: Record<string, unknown>): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new ErroCentral('Sua sessão acabou. Entre de novo.', 'UNAUTHORIZED')
  const resposta = await fetch('/api/v1/fiscal/central', {
    method: metodo,
    headers: { authorization: `Bearer ${token}`, ...(corpo ? { 'content-type': 'application/json' } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  })
  const json = (await resposta.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
  if (!resposta.ok) throw new ErroCentral(json?.error?.message ?? 'Não foi possível falar com a central.', json?.error?.code ?? null)
  return json as T
}

export const central = {
  ler: (telefone: string | null) => (telefone ? chamar<Leitura>('POST', { acao: 'ler', telefone }) : chamar<Leitura>('GET')),
  assumir: (telefone: string) => chamar<{ assumida_ate: string; aviso: boolean | null }>('POST', { acao: 'assumir', telefone }),
  devolver: (telefone: string) => chamar<{ assumida_ate: null; aviso: boolean | null }>('POST', { acao: 'devolver', telefone }),
  responder: (telefone: string, texto: string) => chamar<{ assumida_ate: string }>('POST', { acao: 'responder', telefone, texto }),
}
