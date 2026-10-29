import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { botaoPrimario, botaoSecundario, campo, Carregando, Selo, Vazio } from '../marketing/ui'
import { central, ErroCentral, type Autor, type ConversaAberta, type ConversaResumo, type Etiqueta, type Evento, type Mensagem } from './central-service'

// /no/fiscal/conversas (NO_ADMIN, aal2): as conversas do número do robô do nó.fiscal ao vivo (consulta a
// cada 3 segundos). Assumir deixa o robô quieto naquele número até devolver, ou 2 horas depois da última
// mensagem da equipe. Fora da janela de 24 horas da Meta só sai modelo aprovado: a caixa de resposta trava.

const INTERVALO_MS = 3000
const FUSO = 'America/Sao_Paulo'
const TAMANHO_DA_RESPOSTA = 4096

type Tom = 'neutro' | 'ok' | 'alerta' | 'erro'

const ETIQUETAS: Record<Etiqueta, { texto: string; tom: Tom }> = {
  pediu_atendente: { texto: 'pediu atendente', tom: 'erro' },
  erro_de_envio: { texto: 'erro de envio', tom: 'erro' },
  com_a_equipe: { texto: 'com a equipe', tom: 'ok' },
  aguardando_confirmacao: { texto: 'aguardando confirmação', tom: 'alerta' },
  perguntando_descricao: { texto: 'perguntando descrição', tom: 'alerta' },
  pedindo_dados: { texto: 'pedindo dados do tomador', tom: 'alerta' },
  escolhendo_nota: { texto: 'escolhendo nota', tom: 'alerta' },
  salvar_modelo: { texto: 'salvar modelo?', tom: 'neutro' },
  sem_conta: { texto: 'sem conta', tom: 'neutro' },
}

const EVENTOS: Record<string, string> = {
  pediu_atendente: 'pediu atendente',
  ia_falhou: 'a IA falhou',
  ia_nao_entendeu: 'a IA não entendeu',
  sefin_recusou: 'a Sefin recusou',
  equipe_assumiu: 'a equipe assumiu',
  equipe_devolveu: 'devolvida ao robô',
}

const AUTORES: Record<Autor, string> = { cliente: 'cliente', robo: 'robô', equipe: 'equipe' }
const STATUS: Record<string, string> = { enviada: 'enviada', entregue: 'entregue', lida: 'lida', falhou: 'não saiu' }
const TIPOS: Record<string, string> = {
  image: 'imagem', audio: 'áudio', video: 'vídeo', sticker: 'figurinha', location: 'localização',
  contacts: 'contato', button: 'resposta de botão', interactive: 'resposta de botão', reaction: 'reação',
}
const PAPEIS: Record<string, string> = { owner: 'dono', authorized: 'autorizado' }

const formatoHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit' })
const formatoDia = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit' })

function hora(iso: string): string {
  const instante = new Date(iso)
  const dia = formatoDia.format(instante)
  return dia === formatoDia.format(new Date()) ? formatoHora.format(instante) : `${dia} ${formatoHora.format(instante)}`
}

function telefoneLegivel(e164: string): string {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164)
  return m ? `+55 ${m[1]} ${m[2]}-${m[3]}` : e164
}

function falta(fim: string, agora: string): string {
  const minutos = Math.max(0, Math.round((new Date(fim).getTime() - new Date(agora).getTime()) / 60_000))
  const horas = Math.floor(minutos / 60)
  return horas ? `${horas} h ${minutos % 60} min` : `${minutos} min`
}

function conteudo(m: Pick<Mensagem, 'tipo' | 'texto' | 'arquivo'>): string {
  if (m.tipo === 'text') return m.texto ?? ''
  if (m.tipo === 'document') return `Arquivo: ${m.arquivo ?? 'sem nome'}${m.texto ? `\n${m.texto}` : ''}`
  if (m.tipo === 'template') return `Modelo: ${m.texto ?? ''}`
  if (m.tipo === 'desconhecido') return '(mensagem enviada fora do app)'
  return `(${TIPOS[m.tipo] ?? m.tipo}; o conteúdo não é guardado)`
}

type Linha =
  | { tipo: 'mensagem'; chave: string; em: string; mensagem: Mensagem }
  | { tipo: 'evento'; chave: string; em: string; evento: Evento }

const mensagemDoErro = (erro: unknown) => (erro instanceof ErroCentral ? erro.message : 'Não foi possível falar com a central.')

export function CentralConversasPage() {
  const [aberta, setAberta] = useState<string | null>(null)
  const [leitura, setLeitura] = useState<Awaited<ReturnType<typeof central.ler>> | null>(null)
  const [erro, setErro] = useState<string | null>(null)
  const [versao, setVersao] = useState(0)
  const recarregar = useCallback(() => setVersao((v) => v + 1), [])

  useEffect(() => {
    let vivo = true
    let lendo = false
    const ler = async () => {
      if (lendo) return
      lendo = true
      try {
        const dados = await central.ler(aberta)
        if (vivo) {
          setLeitura(dados)
          setErro(null)
        }
      } catch (e) {
        if (vivo) setErro(mensagemDoErro(e))
      } finally {
        lendo = false
      }
    }
    void ler()
    const relogio = window.setInterval(() => {
      if (!document.hidden) void ler()
    }, INTERVALO_MS)
    return () => {
      vivo = false
      window.clearInterval(relogio)
    }
  }, [aberta, versao])

  const conversa = leitura?.conversa && leitura.conversa.telefone === aberta ? leitura.conversa : null
  return (
    <main className="mx-auto max-w-7xl space-y-4 p-6">
      <div>
        <h1 className="text-3xl font-extrabold uppercase tracking-[-0.03em]">nó.fiscal · conversas<span className="text-ambar">.</span></h1>
        <p className="mt-1 text-sm text-cinza">
          O número do robô ao vivo, atualizado a cada 3 segundos. Para responder, assuma a conversa: o robô fica quieto naquele
          número até você devolver, ou 2 horas depois da sua última mensagem. As notas confirmadas continuam chegando ao cliente.
        </p>
      </div>
      {erro ? <p role="alert" className="rounded-xl border-l-4 border-vermelho bg-vermelho-tint px-4 py-3 text-sm">{erro}</p> : null}
      {!leitura ? (erro ? null : <Carregando />) : (
        <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <Lista conversas={leitura.conversas} aberta={aberta} onAbrir={setAberta} />
          {!aberta ? <Vazio texto="Escolha uma conversa." /> : conversa ? (
            <Conversa key={conversa.telefone} conversa={conversa} agora={leitura.agora} onMudou={recarregar} />
          ) : <Carregando />}
        </div>
      )}
    </main>
  )
}

function Lista({ conversas, aberta, onAbrir }: { conversas: ConversaResumo[]; aberta: string | null; onAbrir: (telefone: string) => void }) {
  if (!conversas.length) return <Vazio texto="Nenhuma conversa guardada ainda. As mensagens aparecem aqui assim que chegam ao número do robô." />
  return (
    <nav aria-label="Conversas" className="max-h-[75vh] overflow-y-auto rounded-2xl border border-borda bg-white">
      <ul>
        {conversas.map((c) => {
          const atual = c.telefone === aberta
          const quem = c.ultima.autor === 'cliente' ? '' : `${c.ultima.autor === 'robo' ? 'Robô' : 'Equipe'}: `
          return (
            <li key={c.telefone}>
              <button
                type="button"
                onClick={() => onAbrir(c.telefone)}
                aria-current={atual ? 'true' : undefined}
                className={`block w-full border-b border-borda px-4 py-3 text-left transition hover:bg-osso focus-visible:outline focus-visible:outline-2 focus-visible:outline-ambar ${atual ? 'bg-azul-tint' : ''}`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <strong className="truncate text-sm">{c.empresa ?? telefoneLegivel(c.telefone)}</strong>
                  <span className="shrink-0 font-mono text-[0.625rem] text-cinza">{hora(c.ultima.em)}</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-cinza">{quem}{conteudo(c.ultima).replace(/\s+/g, ' ')}</span>
                {c.etiquetas.length ? (
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {c.etiquetas.map((e) => <Selo key={e} texto={ETIQUETAS[e].texto} tom={ETIQUETAS[e].tom} />)}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

function Conversa({ conversa, agora, onMudou }: { conversa: ConversaAberta; agora: string; onMudou: () => void }) {
  const [texto, setTexto] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [aviso, setAviso] = useState<{ texto: string; tom: 'ok' | 'erro' } | null>(null)
  const rolagem = useRef<HTMLDivElement>(null)
  const total = conversa.mensagens.length + conversa.eventos.length

  useEffect(() => {
    const caixa = rolagem.current
    if (caixa) caixa.scrollTop = caixa.scrollHeight
  }, [total])

  const linhas: Linha[] = [
    ...conversa.mensagens.map((m) => ({ tipo: 'mensagem' as const, chave: `m${m.id}`, em: m.em, mensagem: m })),
    ...conversa.eventos.map((e) => ({ tipo: 'evento' as const, chave: `e${e.id}`, em: e.em, evento: e })),
  ].sort((a, b) => a.em.localeCompare(b.em))

  async function agir(acao: () => Promise<{ aviso?: boolean | null }>, feito: string) {
    setOcupado(true)
    setAviso(null)
    try {
      const resultado = await acao()
      if (resultado.aviso === false) setAviso({ texto: `${feito}, mas a mensagem ao cliente não saiu. Veja o erro na conversa.`, tom: 'erro' })
      else if (resultado.aviso === null && !conversa.janela.aberta) setAviso({ texto: `${feito}. Fora da janela, o cliente não foi avisado.`, tom: 'ok' })
      onMudou()
    } catch (e) {
      setAviso({ texto: mensagemDoErro(e), tom: 'erro' })
    } finally {
      setOcupado(false)
    }
  }

  async function responder(evento?: FormEvent) {
    evento?.preventDefault()
    const mensagem = texto.trim()
    if (!mensagem || ocupado) return
    setOcupado(true)
    setAviso(null)
    try {
      await central.responder(conversa.telefone, mensagem)
      setTexto('')
    } catch (e) {
      setAviso({ texto: mensagemDoErro(e), tom: 'erro' })
    } finally {
      setOcupado(false)
      onMudou()
    }
  }

  const detalhes = [telefoneLegivel(conversa.telefone), conversa.papel ? PAPEIS[conversa.papel] : null, conversa.plano].filter(Boolean)
  return (
    <section aria-label="Conversa aberta" className="flex max-h-[75vh] min-h-[28rem] flex-col rounded-2xl border border-borda bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-borda p-4">
        <div>
          <h2 className="text-lg font-bold">{conversa.empresa ?? 'Sem conta'}</h2>
          <p className="font-mono text-xs text-cinza">{detalhes.join(' · ')}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {conversa.janela.aberta && conversa.janela.fecha_em
              ? <Selo texto={`janela aberta · fecha em ${falta(conversa.janela.fecha_em, agora)}`} tom="ok" />
              : <Selo texto="janela fechada · só modelo aprovado" tom="alerta" />}
            {conversa.assumida_ate ? <Selo texto={`com a equipe · robô quieto até ${hora(conversa.assumida_ate)}`} tom="alerta" /> : null}
          </div>
        </div>
        {conversa.assumida_ate ? (
          <button type="button" className={botaoSecundario} disabled={ocupado} onClick={() => void agir(() => central.devolver(conversa.telefone), 'Devolvida ao robô')}>
            Devolver ao robô
          </button>
        ) : (
          <button type="button" className={botaoPrimario} disabled={ocupado} onClick={() => void agir(() => central.assumir(conversa.telefone), 'Assumida')}>
            Assumir
          </button>
        )}
      </header>

      <div ref={rolagem} className="flex-1 space-y-2.5 overflow-y-auto bg-osso/60 p-4" aria-live="polite">
        {linhas.map((l) =>
          l.tipo === 'mensagem' ? <Bolha key={l.chave} m={l.mensagem} /> : (
            <p key={l.chave} className="text-center font-mono text-[0.625rem] uppercase tracking-[0.08em] text-cinza">
              {hora(l.em)} · {EVENTOS[l.evento.tipo] ?? l.evento.tipo}{l.evento.detalhe ? ` · ${l.evento.detalhe}` : ''}
            </p>
          ),
        )}
      </div>

      <form onSubmit={(e) => void responder(e)} className="border-t border-borda p-4">
        <label htmlFor="resposta-da-equipe" className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-cinza">
          Responder como equipe da Nó
        </label>
        {!conversa.janela.aberta ? (
          <p className="mt-1 text-xs text-cinza">Fora da janela de 24 horas o WhatsApp só aceita modelo aprovado. A caixa volta quando o cliente escrever.</p>
        ) : null}
        <div className="mt-2 flex items-end gap-2">
          <textarea
            id="resposta-da-equipe"
            rows={2}
            maxLength={TAMANHO_DA_RESPOSTA}
            className={`${campo} resize-y`}
            value={texto}
            disabled={!conversa.janela.aberta || ocupado}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void responder()
            }}
          />
          <button type="submit" className={botaoPrimario} disabled={!conversa.janela.aberta || ocupado || !texto.trim()}>
            Enviar
          </button>
        </div>
        <p className="mt-1 text-xs text-cinza">Responder também assume a conversa. Ctrl+Enter envia.</p>
        {aviso ? (
          <p role={aviso.tom === 'erro' ? 'alert' : 'status'} className={`mt-2 text-sm ${aviso.tom === 'erro' ? 'text-vermelho' : 'text-cinza'}`}>{aviso.texto}</p>
        ) : null}
      </form>
    </section>
  )
}

function Bolha({ m }: { m: Mensagem }) {
  const nossa = m.direcao === 'saida'
  const cor = m.autor === 'cliente' ? 'border border-borda bg-white' : m.autor === 'equipe' ? 'bg-azul-tint' : 'bg-white/70 border border-dashed border-borda'
  return (
    <div className={`flex ${nossa ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-sm ${cor} ${m.status === 'falhou' ? 'ring-1 ring-vermelho' : ''}`}>
        <p className="mb-0.5 font-mono text-[0.625rem] uppercase tracking-[0.08em] text-cinza">{AUTORES[m.autor]}</p>
        <p className="whitespace-pre-wrap break-words">{conteudo(m)}</p>
        <p className="mt-1 text-right font-mono text-[0.625rem] text-cinza">
          {hora(m.em)}{nossa && m.status ? ` · ${STATUS[m.status]}` : ''}
        </p>
        {m.status === 'falhou' && m.erro ? <p className="mt-1 text-xs text-vermelho">{m.erro}</p> : null}
      </div>
    </div>
  )
}
