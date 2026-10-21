import { useCallback, useState } from 'react'
import { useDados } from '../marketing/useDados'
import { botaoPrimario, botaoSecundario, campo } from '../marketing/ui'
import { auditor, ErroAuditor } from './auditor-service'

// Cópia do relatório pelo WhatsApp, enviada à mão pela equipe da nó (Lucca, 21/10).
// Cliente: liga/desliga na tela Conta. Equipe (NO_ADMIN aal2): lê só o texto final, com cada leitura registrada.

export function CopiaWhatsappConta() {
  const conta = useDados(useCallback(() => auditor.eu(), []))
  const [numero, setNumero] = useState('')
  const [estado, setEstado] = useState<{ ocupado: boolean; erro: string }>({ ocupado: false, erro: '' })
  if (!conta.dados) return null
  const ligada = conta.dados.copia_whatsapp

  async function alternar(ativo: boolean) {
    setEstado({ ocupado: true, erro: '' })
    try {
      await auditor.copiaLigar(ativo, ativo ? numero : null)
      setNumero('')
      conta.recarregar()
      setEstado({ ocupado: false, erro: '' })
    } catch (e) {
      setEstado({ ocupado: false, erro: e instanceof ErroAuditor ? e.message : 'Não foi possível salvar.' })
    }
  }

  return (
    <section className="rounded-2xl border border-borda bg-white p-5 shadow-card" aria-label="Cópia pelo WhatsApp">
      <h2 className="text-lg font-bold">Cópia pelo WhatsApp</h2>
      {ligada ? (
        <>
          <p className="mt-2 text-sm">
            A equipe da nó manda uma cópia de cada relatório para o celular terminado em <strong>{conta.dados.copia_whatsapp_numero?.slice(-4)}</strong>.
            Para isso, ela lê o mesmo texto do e-mail (o resumo, com os totais do período, e as prioridades); não vê o painel, os dados por campanha nem as suas contas.
          </p>
          <button type="button" className={`${botaoSecundario} mt-3`} disabled={estado.ocupado} onClick={() => void alternar(false)}>Parar a cópia pelo WhatsApp</button>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-cinza">Opcional. O relatório já chega no seu e-mail e no painel.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-sm" htmlFor="copia-numero">Celular com DDD
              <input id="copia-numero" className={`${campo} mt-1`} value={numero} onChange={(e) => setNumero(e.target.value)} autoComplete="tel" />
            </label>
            <button type="button" className={botaoPrimario} disabled={estado.ocupado} onClick={() => void alternar(true)}>Quero a cópia pelo WhatsApp</button>
          </div>
        </>
      )}
      {estado.erro ? <p role="alert" className="mt-2 text-sm text-vermelho">{estado.erro}</p> : null}
    </section>
  )
}

export function CopiaWhatsappEquipe({ relatorioId }: { relatorioId: string }) {
  const [copia, setCopia] = useState<{ numero: string; texto: string } | null>(null)
  const [erro, setErro] = useState('')
  const [copiado, setCopiado] = useState(false)

  async function abrir() {
    setErro('')
    try {
      const c = await auditor.copiaWhatsapp(relatorioId)
      setCopia({ numero: c.numero, texto: c.texto })
    } catch (e) {
      setErro(e instanceof ErroAuditor ? e.message : 'Não foi possível abrir a cópia.')
    }
  }

  if (!copia) {
    return (
      <>
        <button type="button" className="text-sm underline" onClick={() => void abrir()}>Cópia para WhatsApp</button>
        {erro ? <p role="alert" className="text-xs text-vermelho">{erro}</p> : null}
      </>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-cinza">Leitura registrada. Enviar para {copia.numero}.</p>
      <textarea readOnly className="h-40 w-72 rounded-lg border border-borda p-2 text-xs" value={copia.texto} aria-label="Texto da cópia" />
      <div className="flex gap-2">
        <button type="button" className={botaoSecundario} onClick={() => { void navigator.clipboard?.writeText(copia.texto); setCopiado(true) }}>{copiado ? 'Copiado' : 'Copiar texto'}</button>
        <a className={botaoSecundario} href={`https://wa.me/55${copia.numero}?text=${encodeURIComponent(copia.texto)}`} target="_blank" rel="noreferrer">Abrir no WhatsApp</a>
      </div>
    </div>
  )
}
