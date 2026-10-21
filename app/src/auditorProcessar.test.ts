import { describe, expect, it, vi } from 'vitest'
import {
  ErroFonte, periodos, processarFila, processarRelatorio,
  type Coletores, type ProcessarDeps, type ProcessarStore, type RelatorioFila,
} from '../../supabase/functions/_shared/auditor/processar.ts'
import { criarRotasAuditor, type AuditorStore } from '../../supabase/functions/marketing-hub/auditor.ts'
import type { MetricasPagas } from '../../supabase/functions/_shared/marketing/normalize.ts'

const CLIENTE = 'c0000000-0000-4000-8000-000000000001'
const REL: RelatorioFila = { id: 'r1', client_id: CLIENTE, tipo: 'semanal', periodo_de: '2026-10-12', periodo_ate: '2026-10-18', tentativas: 1 }

function m(p: Partial<MetricasPagas>): MetricasPagas {
  return { gasto_centavos: 0, impressoes: 0, alcance: null, cliques: 0, cliques_link: null, conversoes: 0, lpv: null, ...p }
}

function store(extra: Partial<ProcessarStore> = {}) {
  const atualizacoes: Record<string, unknown>[] = []
  const snapshots: unknown[] = []
  const s = {
    claim: vi.fn(async () => [REL]),
    negocio: vi.fn(async () => ({ client_id: CLIENTE, nome: 'Loja', site_url: 'https://loja.com.br/', dono_email: 'dono@loja.com.br' })),
    ativos: vi.fn(async () => [{ tipo: 'meta_ads' as const, external_id: 'act_1', login_customer_id: null }, { tipo: 'ga4' as const, external_id: '123', login_customer_id: null }]),
    conexoes: vi.fn(async () => [{ provedor: 'meta' as const, estado: 'conectado' }, { provedor: 'google' as const, estado: 'conectado' }]),
    snapshot: vi.fn(async (l: unknown) => { snapshots.push(l) }),
    atualizar: vi.fn(async (_id: string, patch: Record<string, unknown>) => { atualizacoes.push(patch) }),
    falha: vi.fn(async (_id: string, _e: string, t: boolean) => (t ? 'agendado' : 'falhou')),
    avisosPendentes: vi.fn(async () => []),
    avisoEnviado: vi.fn(async () => {}),
    evento: vi.fn(async () => {}),
    ...extra,
  }
  return { s, atualizacoes, snapshots }
}

function coletores(extra: Partial<Coletores> = {}): Coletores {
  return {
    meta_ads: vi.fn(async (_c, _a, p) => ({ total: m({ gasto_centavos: p.de === '2026-10-12' ? 12000 : 10000, conversoes: 10, cliques: 300 }), campanhas: [] })),
    google_ads: vi.fn(async () => ({ total: m({}), campanhas: [] })),
    ga4: vi.fn(async () => ({ sessoes: 500, eventos_chave: 12, por_canal: [{ canal: 'Paid Social', sessoes: 200, eventos_chave: 4 }] })),
    gsc: vi.fn(async () => ({ cliques: 10, impressoes: 100 })),
    ...extra,
  }
}

function deps(s: ProcessarStore, c: Coletores, extra: Partial<ProcessarDeps> = {}): ProcessarDeps {
  return {
    store: s, coletar: c,
    site: vi.fn(async () => ({ url: 'https://loja.com.br/', checagens: [] })),
    gerar: null,
    enviar: vi.fn(async () => 'em_1'),
    appUrl: 'https://app.notechstack.com.br',
    log: vi.fn(),
    ...extra,
  }
}

describe('processamento do relatório', () => {
  it('períodos: semana atual e a anterior de mesmo tamanho', () => {
    expect(periodos('2026-10-12', '2026-10-18')).toEqual({
      atual: { de: '2026-10-12', ate: '2026-10-18', dias: 7 }, anterior: { de: '2026-10-05', ate: '2026-10-11', dias: 7 },
    })
  })

  it('caminho feliz: coleta, grava snapshots, gera e envia; Google Ads sem conta escolhida fica "nao_escolhido"', async () => {
    const { s, atualizacoes, snapshots } = store()
    const d = deps(s, coletores())
    expect(await processarRelatorio(REL, d)).toBe('enviado')
    const final = atualizacoes.find((p) => p.achados)!
    expect(final.fontes).toMatchObject({ meta_ads: 'ok', ga4: 'ok', google_ads: 'nao_escolhido', gsc: 'nao_escolhido', site: 'ok' })
    expect(final.versao_regras).toBe('r1')
    expect(atualizacoes.at(-1)).toMatchObject({ estado: 'enviado', email_id: 'em_1' })
    // meta e ga4 (atual + anterior) + site
    expect(snapshots).toHaveLength(5)
    expect(d.enviar).toHaveBeenCalledWith('dono@loja.com.br', expect.objectContaining({ assunto: expect.stringContaining('Relatório semanal') }))
    expect(s.evento).toHaveBeenCalledWith(CLIENTE, 'relatorio_enviado', expect.any(Object))
  })

  it('C11: token Meta recusado → fonte expirada, relatório parcial e e-mail com reconexão', async () => {
    const { s, atualizacoes } = store()
    const d = deps(s, coletores({ meta_ads: vi.fn(async () => { throw new ErroFonte('expirado') }) }))
    expect(await processarRelatorio(REL, d)).toBe('parcial')
    expect(atualizacoes.find((p) => p.achados)?.fontes).toMatchObject({ meta_ads: 'expirado' })
    const email = vi.mocked(d.enviar).mock.calls[0][1]
    expect(email.texto).toContain('Reconecte o Facebook')
    expect(atualizacoes.at(-1)).toMatchObject({ estado: 'parcial' })
  })

  it('C13: falha passageira numa fonte volta para a fila; na 3ª tentativa segue parcial', async () => {
    const quebra = coletores({ ga4: vi.fn(async () => { throw new Error('ETIMEDOUT') }) })
    const a = store()
    expect(await processarRelatorio(REL, deps(a.s, quebra))).toBe('agendado')
    expect(a.s.falha).toHaveBeenCalledWith('r1', 'fonte_indisponivel', true)
    const b = store()
    expect(await processarRelatorio({ ...REL, tentativas: 3 }, deps(b.s, quebra))).toBe('parcial')
    expect(b.atualizacoes.find((p) => p.achados)?.fontes).toMatchObject({ ga4: 'erro' })
  })

  it('Resend recusa (4xx) não fica tentando para sempre', async () => {
    const { s } = store()
    const d = deps(s, coletores(), { enviar: vi.fn(async () => { throw new Error('resend_recusou') }) })
    expect(await processarRelatorio(REL, d)).toBe('falhou')
    expect(s.falha).toHaveBeenCalledWith('r1', 'email_falhou', false)
  })

  it('sem conexão nenhuma: só o site, relatório parcial', async () => {
    const { s, atualizacoes } = store({ ativos: vi.fn(async () => []), conexoes: vi.fn(async () => []) })
    expect(await processarRelatorio(REL, deps(s, coletores()))).toBe('parcial')
    expect(atualizacoes.find((p) => p.achados)?.fontes).toMatchObject({ meta_ads: 'sem_conexao', ga4: 'sem_conexao', site: 'ok' })
  })

  it('fila: erro inesperado num relatório não derruba os outros; avisos saem e são marcados', async () => {
    const { s } = store({
      claim: vi.fn(async () => [REL, { ...REL, id: 'r2' }]),
      negocio: vi.fn().mockRejectedValueOnce(new Error('db')).mockResolvedValue({ client_id: CLIENTE, nome: 'Loja', site_url: null, dono_email: 'dono@loja.com.br' }),
      avisosPendentes: vi.fn(async () => [{ id: 'a1', client_id: CLIENTE, tipo: 'expira_7d' as const, referencia: 'meta:2026-10-28' }]),
    })
    const d = deps(s, coletores())
    const r = await processarFila(d)
    expect(r.relatorios).toEqual({ agendado: 1, enviado: 1 })
    expect(r.avisos).toBe(1)
    expect(s.avisoEnviado).toHaveBeenCalledWith('a1')
    expect(vi.mocked(d.enviar).mock.calls.at(-1)?.[1].assunto).toBe('A conexão com o Facebook expira em 7 dias')
  })
})

describe('rotas do auditor na marketing-hub', () => {
  const json = (_req: Request, status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status })
  const erro = (_req: Request, status: number, code: string, mensagem: string) => new Response(JSON.stringify({ error_code: code, mensagem }), { status })

  function rotas(extra: Partial<AuditorStore> = {}, cancelar = vi.fn(async () => true)) {
    const { s } = store({ claim: vi.fn(async () => []) })
    const auditorStore: AuditorStore = {
      ...s,
      cronSecretOk: vi.fn(async (x: string) => x === 'segredo'),
      contaDoDono: vi.fn(async () => ({ conta_id: 'k1', negocios: [CLIENTE], assinatura: { subscription_id: 'sub_1', status: 'paga' } })),
      apagarConta: vi.fn(async () => ({ codigo: 'abc', usuario_apagado: true })),
      operacao: vi.fn(async () => [{ client_id: CLIENTE, plano: 'semanal', conexoes: {}, ultimo_relatorio: null }]),
      suporteVigente: vi.fn(async () => false),
      ...extra,
    }
    const tokenLer = vi.fn(async () => null)
    const r = criarRotasAuditor({
      store: auditorStore,
      clienteStore: { tokenLer, conexaoMarcar: vi.fn() } as never,
      autenticar: vi.fn(async (jwt: string) => ({
        dono: { userId: 'u1', role: 'AUDITOR_CLIENT', aal: 'aal1', banido: false },
        admin: { userId: 'a1', role: 'NO_ADMIN', aal: 'aal2', banido: false },
        admin1: { userId: 'a1', role: 'NO_ADMIN', aal: 'aal1', banido: false },
        dot: { userId: 'd1', role: 'MARKETING_AGENT', aal: 'aal1', banido: false },
      } as Record<string, never>)[jwt] ?? null),
      google: { clientId: null, clientSecret: null, developerToken: null },
      site: vi.fn(async () => null),
      gerar: null,
      enviar: vi.fn(async () => 'x'),
      cancelarAssinatura: cancelar,
      appUrl: 'https://app.notechstack.com.br',
      agora: () => new Date('2026-10-21T12:00:00Z'),
      log: vi.fn(),
    })
    return { r, auditorStore, cancelar }
  }
  const pedido = (metodo: string, jwt?: string, corpo?: unknown, cron?: string) => new Request('https://x/marketing-hub/', {
    method: metodo,
    headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(cron ? { 'x-cron-secret': cron } : {}), 'content-type': 'application/json' },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  })

  it('não é rota do auditor → null (o handler segue igual)', async () => {
    const { r } = rotas()
    expect(await r(pedido('GET'), ['overview'], json, erro)).toBeNull()
    expect(await r(pedido('GET'), ['cliente', CLIENTE, 'conexoes'], json, erro)).toBeNull()
  })

  it('processar exige o segredo do cron', async () => {
    const { r } = rotas()
    expect((await r(pedido('POST'), ['internal', 'auditor', 'processar'], json, erro))!.status).toBe(401)
    const ok = await r(pedido('POST', undefined, undefined, 'segredo'), ['internal', 'auditor', 'processar'], json, erro)
    expect(ok!.status).toBe(200)
    expect(await ok!.json()).toEqual({ relatorios: {}, avisos: 0 })
  })

  it('C16: exclusão cancela no Pagar.me antes de apagar; se o cancelamento falha, nada é apagado', async () => {
    const a = rotas()
    const res = await a.r(pedido('POST', 'dono', { confirmar: true }), ['cliente', 'excluir-conta'], json, erro)
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ ok: true, codigo: 'abc' })
    expect(a.cancelar).toHaveBeenCalledWith('sub_1')
    expect(a.auditorStore.apagarConta).toHaveBeenCalledWith('k1')

    const b = rotas({}, vi.fn(async () => false))
    expect((await b.r(pedido('POST', 'dono', { confirmar: true }), ['cliente', 'excluir-conta'], json, erro))!.status).toBe(502)
    expect(b.auditorStore.apagarConta).not.toHaveBeenCalled()

    const c = rotas()
    expect((await c.r(pedido('POST', 'dono', {}), ['cliente', 'excluir-conta'], json, erro))!.status).toBe(422)
    expect((await c.r(pedido('POST', undefined, { confirmar: true }), ['cliente', 'excluir-conta'], json, erro))!.status).toBe(401)
  })

  it('C15: operação só para NO_ADMIN com aal2; o dot e o cliente recebem 403', async () => {
    const { r } = rotas()
    expect((await r(pedido('GET', 'admin'), ['auditor', 'operacao'], json, erro))!.status).toBe(200)
    expect((await r(pedido('GET', 'admin1'), ['auditor', 'operacao'], json, erro))!.status).toBe(403)
    expect((await r(pedido('GET', 'dot'), ['auditor', 'operacao'], json, erro))!.status).toBe(403)
    expect((await r(pedido('GET', 'dono'), ['auditor', 'operacao'], json, erro))!.status).toBe(403)
  })
})
