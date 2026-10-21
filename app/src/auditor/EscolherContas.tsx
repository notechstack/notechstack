import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { botaoPrimario, botaoSecundario } from '../marketing/ui'
import { auditor, ErroAuditor, NOME_FONTE, type Ativo, type ContaDisponivel, type Provedor } from './auditor-service'

// Tela t02 do protótipo ("Escolha o que o agente lê"): uma conta por tipo, só entre as que o token
// do próprio cliente lista agora (a Frente 1 confere de novo no servidor).

const TIPOS: Record<Provedor, Ativo['tipo'][]> = { meta: ['meta_ads'], google: ['google_ads', 'ga4', 'gsc'] }

const chave = (c: ContaDisponivel) => `${c.external_id}|${c.login_customer_id ?? ''}`

export function EscolherContas({ clientId, provedor, escolhidos, onSalvo }: {
  clientId: string; provedor: Provedor; escolhidos: Ativo[]; onSalvo: () => void
}) {
  const [aberto, setAberto] = useState(false)
  const [lista, setLista] = useState<Partial<Record<Ativo['tipo'], ContaDisponivel[] | null>> | null>(null)
  const [escolha, setEscolha] = useState<Partial<Record<Ativo['tipo'], string>>>({})
  const [estado, setEstado] = useState<{ ocupado: boolean; erro: string }>({ ocupado: false, erro: '' })

  async function abrir() {
    setAberto(true)
    setEstado({ ocupado: true, erro: '' })
    try {
      const r = await auditor.contasDisponiveis(clientId, provedor)
      setLista(r)
      const inicial: Partial<Record<Ativo['tipo'], string>> = {}
      for (const t of TIPOS[provedor]) {
        const atual = escolhidos.find((a) => a.tipo === t)
        const opcoes = r[t] ?? []
        const igual = atual ? opcoes.find((o) => o.external_id === atual.external_id) : null
        if (igual) inicial[t] = chave(igual)
        else if (opcoes.length === 1) inicial[t] = chave(opcoes[0])
      }
      setEscolha(inicial)
      setEstado({ ocupado: false, erro: '' })
    } catch (e) {
      setEstado({ ocupado: false, erro: e instanceof ErroAuditor ? e.message : 'Não foi possível listar as contas.' })
    }
  }

  async function salvar() {
    if (!lista) return
    const corpo: Record<string, unknown> = {}
    for (const t of TIPOS[provedor]) {
      const c = (lista[t] ?? []).find((o) => chave(o) === escolha[t])
      if (!c) continue
      corpo[t] = t === 'google_ads' ? { customer_id: c.external_id, login_customer_id: c.login_customer_id } : c.external_id
    }
    if (!Object.keys(corpo).length) {
      setEstado({ ocupado: false, erro: 'Escolha pelo menos uma conta.' })
      return
    }
    setEstado({ ocupado: true, erro: '' })
    try {
      await auditor.salvarAtivos(clientId, corpo)
      setAberto(false)
      onSalvo()
    } catch (e) {
      setEstado({ ocupado: false, erro: e instanceof ErroAuditor ? e.message : 'Não foi possível salvar a escolha.' })
    }
  }

  if (!aberto) {
    return <button type="button" className={`${botaoSecundario} mt-3`} onClick={() => void abrir()}>{escolhidos.length ? 'Trocar contas' : 'Escolher contas'}</button>
  }
  return (
    <div className="mt-4 rounded-xl border border-borda p-4">
      <p className="text-sm font-semibold">Escolha o que o agente lê</p>
      {estado.ocupado && !lista ? <p role="status" className="mt-2 text-sm">Buscando suas contas…</p> : null}
      {lista ? TIPOS[provedor].map((t) => {
        const opcoes = lista[t]
        return (
          <fieldset key={t} className="mt-3">
            <legend className="text-xs font-semibold uppercase tracking-[0.1em] text-cinza">{NOME_FONTE[t]}</legend>
            {opcoes === null || opcoes === undefined ? <p className="text-sm text-cinza">Sem permissão para listar (escopo não concedido).</p>
              : opcoes.length === 0 ? <p className="text-sm text-cinza">Nenhuma conta encontrada neste login.</p>
                : (
                  <div className="mt-1 space-y-1">
                    {opcoes.map((o) => (
                      <label key={chave(o)} className="flex items-center gap-2 text-sm">
                        <input type="radio" name={`${clientId}-${t}`} checked={escolha[t] === chave(o)} onChange={() => setEscolha((x) => ({ ...x, [t]: chave(o) }))} />
                        <span>{o.nome ?? o.external_id}{o.detalhe ? <span className="text-cinza"> · {o.detalhe}</span> : null}</span>
                      </label>
                    ))}
                    <label className="flex items-center gap-2 text-sm text-cinza">
                      <input type="radio" name={`${clientId}-${t}`} checked={!escolha[t]} onChange={() => setEscolha((x) => ({ ...x, [t]: undefined }))} />
                      Não ler
                    </label>
                  </div>
                )}
          </fieldset>
        )
      }) : null}
      {estado.erro ? <p role="alert" className="mt-3 text-sm text-vermelho">{estado.erro}</p> : null}
      <div className="mt-4 flex gap-2">
        <button type="button" className={botaoPrimario} disabled={estado.ocupado || !lista} onClick={() => void salvar()}>Salvar escolha</button>
        <button type="button" className={botaoSecundario} onClick={() => setAberto(false)}>Cancelar</button>
      </div>
      <p className="mt-2 text-xs text-cinza">Só leitura · o auditor nunca altera nada nas suas contas.</p>
    </div>
  )
}

const MOTIVOS: Record<string, string> = {
  access_denied: 'Você não autorizou o acesso. Nada foi conectado.',
  escopo_insuficiente: 'Faltou marcar uma permissão na tela da plataforma. Conecte de novo e aceite a leitura.',
  navegador_diferente: 'A conexão começou em outro navegador. Tente de novo por aqui.',
  state_expirado: 'A conexão demorou demais. Tente de novo.',
  state_reusado: 'Este link de conexão já foi usado. Tente de novo.',
  state_invalido: 'Não conseguimos confirmar a conexão. Tente de novo.',
  troca_falhou: 'A plataforma não confirmou a conexão. Tente de novo em instantes.',
  nao_configurado: 'Esta conexão ainda não está disponível.',
}

// Volta do OAuth (Frente 1): ?conexao=meta|google&resultado=ok|erro&motivo=…
export function VoltaOauth() {
  const [params] = useSearchParams()
  const resultado = params.get('resultado')
  if (!resultado) return null
  const plataforma = params.get('conexao') === 'google' ? 'Google' : 'Facebook'
  if (resultado === 'ok') {
    return <p role="status" className="rounded-xl bg-verde/10 p-3 text-sm">{plataforma} conectado. Agora escolha quais contas o auditor lê.</p>
  }
  const motivo = params.get('motivo') ?? ''
  return <p role="alert" className="rounded-xl bg-vermelho-tint p-3 text-sm">{MOTIVOS[motivo] ?? 'A conexão não foi concluída. Tente de novo.'}</p>
}
