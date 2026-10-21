import { describe, expect, it, vi } from 'vitest'
import { handle, ipDaBorda, type AcessoDeps, type Preparo } from '../../supabase/functions/auditor-acesso/core.ts'

function deps(preparo: Preparo, extra: Partial<AcessoDeps> = {}, appUrl = 'https://app.notechstack.com.br') {
  return {
    env: (k: string) => ({ DIAG_IP_SALT: 'sal', APP_URL: appUrl } as Record<string, string>)[k],
    preparar: vi.fn(async () => preparo),
    criarUsuario: vi.fn(async () => 'novo-id'),
    gerarLink: vi.fn(async () => 'https://sdeowbqmwkwseyktyemn.supabase.co/auth/v1/verify?token=x'),
    enviar: vi.fn(async () => 'em_1'),
    now: () => new Date('2026-10-21T04:00:00Z'),
    ...extra,
  }
}

function pedido(corpo: unknown, origem = 'https://app.notechstack.com.br', headers: Record<string, string> = {}) {
  return new Request('https://x/functions/v1/auditor-acesso', {
    method: 'POST',
    headers: { origin: origem, 'x-forwarded-for': '200.1.2.3, 10.0.0.1', 'content-type': 'application/json', ...headers },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  })
}

const VALIDO = { email: ' Pessoa@Loja.com.br ', site: 'loja.com.br/?utm_source=x' }

describe('auditor-acesso (C6 + revisão)', () => {
  it('e-mail novo: 202, cria usuário AUDITOR_CLIENT (sem aceite nos metadados) e envia 1 link', async () => {
    const d = deps({ permitido: true, user_id: null, papel: null })
    const r = await handle(pedido(VALIDO), d)
    expect(r.status).toBe(202)
    expect(await r.json()).toEqual({ ok: true })
    expect(d.criarUsuario).toHaveBeenCalledWith('pessoa@loja.com.br', { role: 'AUDITOR_CLIENT' }, {})
    expect(d.gerarLink).toHaveBeenCalledWith('pessoa@loja.com.br', 'https://app.notechstack.com.br/auditor/entrar?site=https%3A%2F%2Floja.com.br%2F')
    expect(d.enviar).toHaveBeenCalledTimes(1)
  })

  it('I1: conta que já existe não é alterada (nem papel, nem metadados); só recebe o link', async () => {
    for (const papel of [null, 'CLIENT', 'AUDITOR_CLIENT']) {
      const d = deps({ permitido: true, user_id: 'u1', papel })
      const r = await handle(pedido(VALIDO), d)
      expect(r.status).toBe(202)
      expect(d.criarUsuario).not.toHaveBeenCalled()
      expect(Object.keys(d)).not.toContain('atualizarUsuario')
      expect(d.enviar).toHaveBeenCalledTimes(1)
    }
  })

  it('B1: o destino de volta vai no link só se for caminho do auditor', async () => {
    const d = deps({ permitido: true, user_id: null, papel: null })
    await handle(pedido({ ...VALIDO, volta: '/auditor/c1/relatorios/r1?x=1' }), d)
    expect(vi.mocked(d.gerarLink).mock.calls[0][1]).toContain('volta=%2Fauditor%2Fc1%2Frelatorios%2Fr1%3Fx%3D1')
    for (const ruim of ['https://malicioso.example', '//malicioso.example', '/no/marketing', '/auditor//x']) {
      const e = deps({ permitido: true, user_id: null, papel: null })
      await handle(pedido({ ...VALIDO, volta: ruim }), e)
      expect(vi.mocked(e.gerarLink).mock.calls[0][1]).not.toContain('volta=')
    }
  })

  it('B4: o IP é o da borda; forjar o primeiro x-forwarded-for não troca a chave', async () => {
    expect(ipDaBorda(new Headers({ 'x-forwarded-for': '1.1.1.1, 200.1.2.3' }))).toBe('200.1.2.3')
    expect(ipDaBorda(new Headers({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' }))).toBe('9.9.9.9')
    expect(ipDaBorda(new Headers({ 'cf-connecting-ip': '8.8.8.8', 'x-real-ip': '9.9.9.9' }))).toBe('8.8.8.8')
    const a = deps({ permitido: true, user_id: null, papel: null })
    const b = deps({ permitido: true, user_id: null, papel: null })
    await handle(pedido(VALIDO, undefined, { 'x-forwarded-for': '1.1.1.1, 200.1.2.3' }), a)
    await handle(pedido(VALIDO, undefined, { 'x-forwarded-for': '7.7.7.7, 200.1.2.3' }), b)
    expect(vi.mocked(a.preparar).mock.calls[0][2]).toBe(vi.mocked(b.preparar).mock.calls[0][2])
  })

  it('só hashes vão ao banco: e-mail e IP nunca em texto na chave', async () => {
    const d = deps({ permitido: true, user_id: null, papel: null })
    await handle(pedido(VALIDO), d)
    const [, chaveEmail, chaveIp] = vi.mocked(d.preparar).mock.calls[0]
    expect(chaveEmail).toMatch(/^[0-9a-f]{64}$/)
    expect(chaveIp).toMatch(/^[0-9a-f]{64}$/)
  })

  it('e-mail de NO_ADMIN ou MARKETING_AGENT: mesmo 202, nada enviado nem criado', async () => {
    for (const papel of ['NO_ADMIN', 'MARKETING_AGENT']) {
      const d = deps({ permitido: true, user_id: 'u1', papel })
      expect((await handle(pedido(VALIDO), d)).status).toBe(202)
      expect(d.enviar).not.toHaveBeenCalled()
      expect(d.criarUsuario).not.toHaveBeenCalled()
    }
  })

  it('limite estourado: 429 sem enviar', async () => {
    const d = deps({ permitido: false, user_id: null, papel: null })
    expect((await handle(pedido(VALIDO), d)).status).toBe(429)
    expect(d.enviar).not.toHaveBeenCalled()
  })

  it('validação: e-mail e site', async () => {
    const d = deps({ permitido: true, user_id: null, papel: null })
    expect((await handle(pedido({ ...VALIDO, email: 'x' }), d)).status).toBe(400)
    expect((await handle(pedido({ ...VALIDO, site: 'http://localhost:3000' }), d)).status).toBe(400)
    expect((await handle(pedido('{'), d)).status).toBe(400)
    expect(d.preparar).not.toHaveBeenCalled()
  })

  it('sem DIAG_IP_SALT recusa (503); falha do Auth vira 502 sem detalhe', async () => {
    const semSal = deps({ permitido: true, user_id: null, papel: null }, { env: () => undefined })
    expect((await handle(pedido(VALIDO), semSal)).status).toBe(503)
    const quebra = deps({ permitido: true, user_id: null, papel: null }, { gerarLink: vi.fn(async () => { throw new Error('auth_link') }) })
    const r = await handle(pedido(VALIDO), quebra)
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ ok: false, motivo: 'indisponivel' })
  })

  it('CORS: app e Vercel sempre; localhost só quando o próprio app roda em localhost (M8)', async () => {
    const prod = deps({ permitido: true, user_id: null, papel: null })
    expect((await handle(pedido(VALIDO, 'https://malicioso.example'), prod)).headers.get('access-control-allow-origin')).toBeNull()
    expect((await handle(new Request('https://x', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }), prod)).headers.get('access-control-allow-origin')).toBeNull()
    expect((await handle(new Request('https://x', { method: 'OPTIONS', headers: { origin: 'https://notechstack-app.vercel.app' } }), prod)).headers.get('access-control-allow-origin')).toBe('https://notechstack-app.vercel.app')
    const dev = deps({ permitido: true, user_id: null, papel: null }, {}, 'http://localhost:5173')
    const pre = await handle(new Request('https://x', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }), dev)
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('CORS: o preflight libera todos os cabeçalhos que o supabase-js manda no functions.invoke', async () => {
    const prod = deps({ permitido: true, user_id: null, papel: null })
    const pre = await handle(new Request('https://x', { method: 'OPTIONS', headers: { origin: 'https://app.notechstack.com.br' } }), prod)
    const liberados = (pre.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim().toLowerCase())
    for (const h of ['authorization', 'x-client-info', 'apikey', 'content-type']) expect(liberados).toContain(h)
  })
})
