import { useCallback, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/auth-context'
import { useDados } from '../marketing/useDados'
import { botaoPrimario, botaoSecundario, campo, Carregando } from '../marketing/ui'
import { auditor } from './auditor-service'
import { mensagemResultado, montarPedido, PLANOS, TEXTO_ACEITE, TEXTO_COPIA_WHATSAPP, tokenizarCartao, UFS, validar, type CodigoPlano, type DadosCheckout } from './checkout'

// Planos e checkout no app (plan, passo 6): a assinatura nasce ligada à conta logada.
// O cartão é tokenizado no navegador; o servidor só recebe o token.

function vazio(plano: CodigoPlano, email: string): DadosCheckout {
  return {
    plano, nome: '', email, telefone: '', documento: '', numero_cartao: '', nome_cartao: '', validade: '', cvv: '', termos_aceite: false, copia_whatsapp: false,
    endereco: { cep: '', rua: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '' },
  }
}

function Campo({ id, rotulo, valor, onMudar, tipo = 'text', autoComplete, className = '' }: {
  id: string; rotulo: string; valor: string; onMudar: (v: string) => void; tipo?: string; autoComplete?: string; className?: string
}) {
  return (
    <label className={`block text-sm ${className}`} htmlFor={id}>
      {rotulo}
      <input id={id} type={tipo} autoComplete={autoComplete} className={`${campo} mt-1`} value={valor} onChange={(e) => onMudar(e.target.value)} />
    </label>
  )
}

export function PlanosPage() {
  const { session } = useAuth()
  const [params] = useSearchParams()
  const planoPedido = PLANOS.find((p) => p.codigo === params.get('plano'))?.codigo ?? null
  const carregar = useCallback(async () => {
    const [config, conta] = await Promise.all([auditor.assinaturaConfig(), auditor.eu()])
    return { config, conta }
  }, [])
  const r = useDados(carregar)
  // Vindo do site (?plano=semanal), o formulário daquele plano já abre quando a venda estiver aberta.
  const [dados, setDados] = useState<DadosCheckout | null>(null)
  const [preAberto, setPreAberto] = useState(false)
  const [estado, setEstado] = useState<{ enviando: boolean; concluida: boolean; texto: string; erro: boolean }>({ enviando: false, concluida: false, texto: '', erro: false })

  if (r.carregando && !r.dados) return <Carregando />
  if (r.erro || !r.dados) {
    return (
      <div role="alert" className="text-sm">
        <p>Não foi possível carregar os planos agora.</p>
        <button type="button" className={`${botaoSecundario} mt-3`} onClick={r.recarregar}>Tentar novamente</button>
      </div>
    )
  }
  const { config, conta } = r.dados
  const jaAssinante = conta && conta.plano !== 'gratis' && !conta.encerrada_em
  const disponivel = (c: CodigoPlano) => config.venda_aberta && Boolean(config.public_key) && config.planos.some((p) => p.codigo === c && p.disponivel)

  if (planoPedido && !preAberto && !dados && disponivel(planoPedido) && !jaAssinante) {
    setPreAberto(true)
    setDados(vazio(planoPedido, session?.user.email ?? ''))
  }

  const mudar = (patch: Partial<DadosCheckout>) => setDados((d) => (d ? { ...d, ...patch } : d))
  const mudarEndereco = (patch: Partial<DadosCheckout['endereco']>) => setDados((d) => (d ? { ...d, endereco: { ...d.endereco, ...patch } } : d))

  async function assinar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault()
    if (!dados || estado.enviando || estado.concluida) return
    const erros = validar(dados)
    if (erros.length) { setEstado({ ...estado, texto: erros.join(' '), erro: true }); return }
    setEstado({ enviando: true, concluida: false, texto: 'Processando o pagamento…', erro: false })
    try {
      const token = await tokenizarCartao(dados, config.public_key)
      const pedido = montarPedido(dados, token)
      setDados({ ...dados, numero_cartao: '', nome_cartao: '', validade: '', cvv: '' })
      const resp = await auditor.assinar(pedido)
      const m = mensagemResultado(resp)
      // Assinatura feita: o botão não volta, para um segundo clique não criar outra cobrança.
      setEstado({ enviando: false, concluida: m.ok, texto: m.texto, erro: !m.ok })
    } catch (e) {
      setEstado({ enviando: false, concluida: false, texto: e instanceof Error && e.message === 'CARTAO' ? 'Confira os dados do cartão.' : 'Não deu para concluir agora. Tente de novo em alguns minutos.', erro: true })
    }
  }

  return (
    <>
      <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">Planos<span className="text-ambar">.</span></h1>
      {jaAssinante ? <p role="status" className="rounded-xl bg-verde/10 p-3 text-sm">Sua conta já tem uma assinatura ativa.</p> : null}
      {!config.venda_aberta ? <p role="status" className="rounded-xl bg-osso p-3 text-sm">A assinatura abre em breve. Você já pode conectar suas contas e ver a retrospectiva grátis.</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        {PLANOS.map((p) => (
          <section key={p.codigo} className={`rounded-2xl border bg-white p-5 shadow-card ${p.recomendado ? 'border-tinta' : 'border-borda'}`} aria-label={`Plano ${p.nome}`}>
            {p.recomendado ? <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-cinza">Recomendado</span> : null}
            <h2 className="text-xl font-bold">{p.nome}</h2>
            <p className="text-2xl font-extrabold">{p.preco}<small className="text-sm font-normal text-cinza">/mês</small></p>
            <p className="mt-1 text-sm font-semibold">{p.ritmo}</p>
            <ul className="mt-3 list-disc space-y-1 pl-4 text-sm">{p.itens.map((i) => <li key={i}>{i}</li>)}</ul>
            <button type="button" className={`${botaoPrimario} mt-4 w-full`} disabled={!disponivel(p.codigo) || Boolean(jaAssinante) || estado.concluida}
              onClick={() => setDados(vazio(p.codigo, session?.user.email ?? ''))}>
              {disponivel(p.codigo) ? `Assinar ${p.nome}` : 'Assinatura em breve'}
            </button>
          </section>
        ))}
      </div>
      <p className="text-xs text-cinza">Cobrança mensal no cartão de crédito. Cancele quando quiser.</p>

      {dados ? (
        <form onSubmit={(e) => void assinar(e)} className="space-y-3 rounded-2xl border border-borda bg-white p-5 shadow-card" noValidate aria-label="Dados da assinatura">
          <h2 className="text-lg font-bold">Assinar o plano {PLANOS.find((p) => p.codigo === dados.plano)?.nome}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Campo id="ck-nome" rotulo="Nome completo" valor={dados.nome} onMudar={(v) => mudar({ nome: v })} autoComplete="name" />
            <Campo id="ck-email" rotulo="E-mail de cobrança" tipo="email" valor={dados.email} onMudar={(v) => mudar({ email: v })} autoComplete="email" />
            <Campo id="ck-tel" rotulo="Celular com DDD" valor={dados.telefone} onMudar={(v) => mudar({ telefone: v })} autoComplete="tel" />
            <Campo id="ck-doc" rotulo="CPF ou CNPJ" valor={dados.documento} onMudar={(v) => mudar({ documento: v })} />
          </div>
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="text-sm font-semibold">Cartão</legend>
            <Campo id="ck-cc" rotulo="Número do cartão" valor={dados.numero_cartao} onMudar={(v) => mudar({ numero_cartao: v })} autoComplete="cc-number" />
            <Campo id="ck-cc-nome" rotulo="Nome impresso" valor={dados.nome_cartao} onMudar={(v) => mudar({ nome_cartao: v })} autoComplete="cc-name" />
            <Campo id="ck-cc-val" rotulo="Validade (MM/AA)" valor={dados.validade} onMudar={(v) => mudar({ validade: v })} autoComplete="cc-exp" />
            <Campo id="ck-cc-cvv" rotulo="CVV" valor={dados.cvv} onMudar={(v) => mudar({ cvv: v })} autoComplete="cc-csc" />
          </fieldset>
          <fieldset className="grid gap-3 sm:grid-cols-3">
            <legend className="text-sm font-semibold">Endereço de cobrança do cartão</legend>
            <Campo id="ck-cep" rotulo="CEP" valor={dados.endereco.cep} onMudar={(v) => mudarEndereco({ cep: v })} autoComplete="postal-code" />
            <Campo id="ck-rua" rotulo="Rua" valor={dados.endereco.rua} onMudar={(v) => mudarEndereco({ rua: v })} className="sm:col-span-2" />
            <Campo id="ck-num" rotulo="Número" valor={dados.endereco.numero} onMudar={(v) => mudarEndereco({ numero: v })} />
            <Campo id="ck-comp" rotulo="Complemento" valor={dados.endereco.complemento} onMudar={(v) => mudarEndereco({ complemento: v })} />
            <Campo id="ck-bairro" rotulo="Bairro" valor={dados.endereco.bairro} onMudar={(v) => mudarEndereco({ bairro: v })} />
            <Campo id="ck-cidade" rotulo="Cidade" valor={dados.endereco.cidade} onMudar={(v) => mudarEndereco({ cidade: v })} className="sm:col-span-2" />
            <label className="block text-sm" htmlFor="ck-uf">UF
              <select id="ck-uf" className={`${campo} mt-1`} value={dados.endereco.uf} onChange={(e) => mudarEndereco({ uf: e.target.value })}>
                <option value="">—</option>{UFS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </label>
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={dados.termos_aceite} onChange={(e) => mudar({ termos_aceite: e.target.checked })} />
            <span>{TEXTO_ACEITE}</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={dados.copia_whatsapp} onChange={(e) => mudar({ copia_whatsapp: e.target.checked })} />
            <span>{TEXTO_COPIA_WHATSAPP} <span className="text-cinza">(opcional; dá para desligar depois em Conta)</span></span>
          </label>
          {estado.texto ? <p role={estado.erro ? 'alert' : 'status'} className={`text-sm ${estado.erro ? 'text-vermelho' : ''}`}>{estado.texto}</p> : null}
          <div className="flex gap-2">
            <button type="submit" className={botaoPrimario} disabled={estado.enviando || estado.concluida}>{estado.enviando ? 'Processando…' : 'Assinar'}</button>
            {!estado.concluida ? <button type="button" className={botaoSecundario} onClick={() => setDados(null)}>Cancelar</button> : <Link className={botaoSecundario} to="/auditor">Ir para meus negócios</Link>}
          </div>
        </form>
      ) : null}
    </>
  )
}
