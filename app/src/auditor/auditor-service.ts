import { supabase } from '../lib/supabase'

// Contrato do auditor no app (spec 2026-10-21):
// - leituras pela RLS, com o JWT do próprio cliente (relatórios, conexões, contas escolhidas);
// - escritas simples pelas RPCs auditor_eu_* (presas a auth.uid());
// - OAuth, desconexão e exclusão de conta pela marketing-hub (/cliente/*), que fala com Meta, Google e Pagar.me.

export const ACEITE_VERSAO = 'termos-2026-10-21'

export type Plano = 'gratis' | 'mensal' | 'semanal' | 'agencia'
export type Negocio = {
  client_id: string
  nome: string
  site_url: string | null
  frequencia: 'semanal' | 'mensal' | null
  retrospectiva_gerada_em: string | null
  suporte_ate: string | null
}
export type Conta = {
  conta_id: string
  plano: Plano
  encerrada_em: string | null
  excluir_apos: string | null
  limite_negocios: number
  negocios: Negocio[]
}

export type Provedor = 'meta' | 'google'
export type EstadoConexao = 'conectado' | 'expirado' | 'revogado' | 'erro' | 'desconectado'
export type Conexao = { provedor: Provedor; estado: EstadoConexao; expira_em: string | null; conectado_em: string; verificado_em: string | null; ultimo_erro: string | null }
export type Ativo = { tipo: 'meta_ads' | 'google_ads' | 'ga4' | 'gsc'; external_id: string; nome: string | null; moeda: string | null; detalhe: string | null }

export type EstadoFonte = 'ok' | 'expirado' | 'revogado' | 'erro' | 'sem_conexao' | 'nao_escolhido' | 'nao_disponivel'
export type Achado = { id: string; tipo: string; severidade: 'alta' | 'media' | 'baixa' | 'info'; fonte: string; titulo: string; numeros: Record<string, string>; evidencia: string; acao: string }
export type ResumoRelatorio = { id: string; tipo: 'retrospectiva' | 'semanal' | 'mensal'; periodo_de: string; periodo_ate: string; estado: 'pronto' | 'enviado' | 'parcial'; gerado_em: string | null; enviado_em: string | null }
export type Relatorio = ResumoRelatorio & {
  client_id: string
  fontes: Record<string, EstadoFonte>
  achados: Achado[] | null
  narrativa: { origem: 'ia' | 'modelo'; resumo: string; prioridades: { achado_id: string; titulo: string; o_que_fazer: string }[] } | null
}

export class ErroAuditor extends Error {
  readonly codigo: string
  constructor(codigo: string, mensagem: string) {
    super(mensagem)
    this.codigo = codigo
  }
}

const MENSAGENS: Record<string, string> = {
  plano_sem_multiplos_negocios: 'Só o plano Agência permite mais de um negócio.',
  limite_de_negocios: 'O plano Agência permite até 5 negócios.',
  site_invalido: 'Informe o endereço completo do site, começando com https://.',
  so_no_plano_agencia: 'A frequência por negócio é do plano Agência.',
  so_o_dono_concede: 'Só o dono da conta pode liberar o acesso da equipe.',
  muitos_pedidos: 'Muitos pedidos de link em pouco tempo. Tente de novo em uma hora.',
  email_invalido: 'Confira o e-mail digitado.',
  aceite_obrigatorio: 'Para continuar, aceite os Termos e a Política de Privacidade.',
  conta_sistema: 'Esta conta não pode ser usada no auditor.',
}

function erroDe(codigoBruto: string | undefined, padrao: string): ErroAuditor {
  const codigo = codigoBruto && /^[a-z_]{1,40}$/.test(codigoBruto) ? codigoBruto : 'falha'
  return new ErroAuditor(codigo, MENSAGENS[codigo] ?? padrao)
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw erroDe(error.message, 'Não foi possível concluir agora. Tente de novo.')
  return data as T
}

async function hub<T>(metodo: 'GET' | 'POST' | 'DELETE', caminho: string, corpo?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`marketing-hub${caminho}`, { method: metodo, ...(corpo ? { body: corpo } : {}) })
  if (!error) return data as T
  const contexto = (error as { context?: Response }).context
  const json = contexto && typeof contexto.json === 'function' ? await contexto.clone().json().catch(() => ({})) as Record<string, unknown> : {}
  throw erroDe(String(json.motivo ?? json.error_code ?? '').toLowerCase(), String(json.mensagem ?? 'Não foi possível falar com o auditor agora.'))
}

export const auditor = {
  async pedirLink(email: string, site: string | null): Promise<void> {
    const { error } = await supabase.functions.invoke('auditor-acesso', {
      body: { email, aceite: true, aceite_versao: ACEITE_VERSAO, ...(site ? { site } : {}) },
    })
    if (!error) return
    const contexto = (error as { context?: Response }).context
    const json = contexto && typeof contexto.json === 'function' ? await contexto.clone().json().catch(() => ({})) as { motivo?: string } : {}
    throw erroDe(json.motivo, 'Não foi possível enviar o link agora. Tente de novo em instantes.')
  },
  eu: () => rpc<Conta | null>('auditor_eu'),
  iniciar: (site: string | null) => rpc<Conta>('auditor_eu_iniciar', { p_site_url: site }),
  suporte: (clientId: string, conceder: boolean) => rpc<void>('auditor_eu_suporte', { p_client_id: clientId, p_conceder: conceder }),
  retrospectiva: (clientId: string) => rpc<string | null>('auditor_eu_retrospectiva', { p_client_id: clientId }),
  novoNegocio: (site: string, nome: string | null) => rpc<string>('auditor_eu_negocio_criar', { p_site_url: site, p_nome: nome }),
  frequencia: (clientId: string, frequencia: 'semanal' | 'mensal') => rpc<void>('auditor_eu_frequencia', { p_client_id: clientId, p_frequencia: frequencia }),

  async conexoes(clientId: string): Promise<{ conexoes: Conexao[]; ativos: Ativo[] }> {
    const [c, a] = await Promise.all([
      supabase.from('marketing_cliente_conexoes').select('provedor, estado, expira_em, conectado_em, verificado_em, ultimo_erro')
        .eq('client_id', clientId).neq('estado', 'desconectado'),
      supabase.from('marketing_cliente_ativos').select('tipo, external_id, nome, moeda, detalhe').eq('client_id', clientId),
    ])
    if (c.error || a.error) throw erroDe(undefined, 'Não foi possível carregar as conexões.')
    return { conexoes: (c.data ?? []) as Conexao[], ativos: (a.data ?? []) as Ativo[] }
  },
  async relatorios(clientId: string): Promise<ResumoRelatorio[]> {
    const { data, error } = await supabase.from('auditor_relatorios')
      .select('id, tipo, periodo_de, periodo_ate, estado, gerado_em, enviado_em')
      .eq('client_id', clientId).order('periodo_ate', { ascending: false }).limit(60)
    if (error) throw erroDe(undefined, 'Não foi possível carregar os relatórios.')
    return (data ?? []) as ResumoRelatorio[]
  },
  async relatorio(id: string): Promise<Relatorio | null> {
    const { data, error } = await supabase.from('auditor_relatorios')
      .select('id, client_id, tipo, periodo_de, periodo_ate, estado, fontes, achados, narrativa, gerado_em, enviado_em')
      .eq('id', id).maybeSingle()
    if (error) throw erroDe(undefined, 'Não foi possível carregar o relatório.')
    return data as Relatorio | null
  },

  conectar: (clientId: string, provedor: Provedor) => hub<{ url: string }>('POST', `/cliente/${encodeURIComponent(clientId)}/${provedor}/conectar`),
  desconectar: (clientId: string, provedor: Provedor) => hub<unknown>('DELETE', `/cliente/${encodeURIComponent(clientId)}/${provedor}`),
  excluirConta: () => hub<{ ok: true; codigo: string }>('POST', '/cliente/excluir-conta', { confirmar: true }),
}

export const NOME_PLANO: Record<Plano, string> = { gratis: 'Grátis', mensal: 'Mensal', semanal: 'Semanal', agencia: 'Agência' }
export const NOME_FONTE: Record<string, string> = {
  meta_ads: 'Meta Ads', google_ads: 'Google Ads', ga4: 'Google Analytics', gsc: 'Search Console', site: 'Site',
}
