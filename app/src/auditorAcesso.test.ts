import { describe, expect, it, vi } from 'vitest'
import { handle, type AcessoDeps, type Preparo } from '../../supabase/functions/auditor-acesso/core.ts'

function deps(preparo: Preparo, extra: Partial<AcessoDeps> = {}) {
  const d = {
    env: (k: string) => ({ DIAG_IP_SALT: 'sal', APP_URL: 'https://app.notechstack.com.br' } as Record<string, string>)[k],
    preparar: vi.fn(async () => preparo),
    criarUsuario: vi.fn(async () => 'novo-id'),
    atualizarUsuario: vi.fn(async () => {}),
    gerarLink: vi.fn(async () => 'https://sdeowbqmwkwseyktyemn.supabase.co/auth/v1/verify?token=x'),
    enviar: vi.fn(async () => 'em_1'),
    now: () => new Date('2026-10-21T04:00:00Z'),
    ...extra,
  }
  return d
}

function pedido(corpo: unknown, origem = 'https://app.notechstack.com.br') {
  return new Request('https://x/functions/v1/auditor-acesso', {
    method: 'POST',
    headers: { origin: origem, 'x-forwarded-for': '200.1.2.3, 10.0.0.1', 'content-type': 'application/json' },
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  })
}

const VALIDO = { email: ' Pessoa@Loja.com.br ', aceite: true, aceite_versao: 'termos-2026-10-21', site: 'loja.com.br/?utm_source=x' }

describe('auditor-acesso (C6)', () => {
  it('e-mail novo: 202, cria usuário AUDITOR_CLIENT com o aceite e envia 1 link', async () => {
    const d = deps({ permitido: true, user_id: null, papel: null })
    const r = await handle(pedido(VALIDO), d)
    expect(r.status).toBe(202)
    expect(await r.json()).toEqual({ ok: true })
    expect(r.headers.get('access-control-allow-origin')).toBe('https://app.notechstack.com.br')
    expect(d.criarUsuario).toHaveBeenCalledWith('pessoa@loja.com.br', { role: 'AUDITOR_CLIENT' },
      { auditor_aceite_versao: 'termos-2026-10-21', auditor_aceite_em: '2026-10-21T04:00:00.000Z' })
    expect(d.gerarLink).toHaveBeenCalledWith('pessoa@loja.com.br', 'https://app.notechstack.com.br/auditor/entrar?site=https%3A%2F%2Floja.com.br%2F')
    expect(d.enviar).toHaveBeenCalledTimes(1)
    expect((vi.mocked(d.enviar).mock.calls[0] as unknown as [string, { texto: string }])[1].texto).toContain('/auth/v1/verify?token=x')
  })

  it('só hashes vão ao banco: e-mail e IP nunca em texto na chave', async () => {
    const d = deps({ permitido: true, user_id: null, papel: null })
    await handle(pedido(VALIDO), d)
    const [, chaveEmail, chaveIp] = vi.mocked(d.preparar).mock.calls[0] as unknown as [string, string, string]
    expect(chaveEmail).toMatch(/^[0-9a-f]{64}$/)
    expect(chaveIp).toMatch(/^[0-9a-f]{64}$/)
    expect(chaveEmail).not.toBe(chaveIp)
  })

  it('e-mail de NO_ADMIN ou MARKETING_AGENT: mesmo 202, nada enviado nem alterado', async () => {
    for (const papel of ['NO_ADMIN', 'MARKETING_AGENT']) {
      const d = deps({ permitido: true, user_id: 'u1', papel })
      const r = await handle(pedido(VALIDO), d)
      expect(r.status).toBe(202)
      expect(d.enviar).not.toHaveBeenCalled()
      expect(d.criarUsuario).not.toHaveBeenCalled()
      expect(d.atualizarUsuario).not.toHaveBeenCalled()
    }
  })

  it('usuário existente sem papel ganha AUDITOR_CLIENT; com outro papel mantém', async () => {
    const semPapel = deps({ permitido: true, user_id: 'u1', papel: null })
    await handle(pedido(VALIDO), semPapel)
    expect(semPapel.atualizarUsuario).toHaveBeenCalledWith('u1', expect.objectContaining({ app_metadata: { role: 'AUDITOR_CLIENT' } }))
    const cliente = deps({ permitido: true, user_id: 'u2', papel: 'CLIENT' })
    await handle(pedido(VALIDO), cliente)
    expect(cliente.atualizarUsuario).toHaveBeenCalledWith('u2', { user_metadata: expect.any(Object) })
    expect(cliente.enviar).toHaveBeenCalledTimes(1)
  })

  it('limite estourado: 429 sem enviar (U5)', async () => {
    const d = deps({ permitido: false, user_id: null, papel: null })
    const r = await handle(pedido(VALIDO), d)
    expect(r.status).toBe(429)
    expect(d.enviar).not.toHaveBeenCalled()
  })

  it('validação: e-mail, aceite e site', async () => {
    const d = deps({ permitido: true, user_id: null, papel: null })
    expect((await handle(pedido({ ...VALIDO, email: 'x' }), d)).status).toBe(400)
    expect((await handle(pedido({ ...VALIDO, aceite: false }), d)).status).toBe(400)
    expect((await handle(pedido({ ...VALIDO, aceite_versao: undefined }), d)).status).toBe(400)
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

  it('CORS só para o app e localhost; preflight 204', async () => {
    const d = deps({ permitido: true, user_id: null, papel: null })
    const fora = await handle(pedido(VALIDO, 'https://malicioso.example'), d)
    expect(fora.headers.get('access-control-allow-origin')).toBeNull()
    const pre = await handle(new Request('https://x', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }), d)
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })
})
