import { describe, expect, it, vi } from 'vitest'
import { avaliar, estadoFinal, fmt, type EntradaRegras, type Pago } from '../../supabase/functions/_shared/auditor/regras.ts'
import { narrativaModelo, redigir, validarNarrativa, type GeradorIa } from '../../supabase/functions/_shared/auditor/redacao.ts'
import { emailAviso, emailRelatorio, enviarResend } from '../../supabase/functions/_shared/auditor/email.ts'
import type { MetricasPagas } from '../../supabase/functions/_shared/marketing/normalize.ts'

const PERIODO = { de: '2026-10-12', ate: '2026-10-18' }
const ANTERIOR = { de: '2026-10-05', ate: '2026-10-11' }

function m(p: Partial<MetricasPagas>): MetricasPagas {
  return { gasto_centavos: 0, impressoes: 0, alcance: null, cliques: 0, cliques_link: null, conversoes: 0, lpv: null, ...p }
}

function pago(total: Partial<MetricasPagas>, campanhas: { id: string; nome: string; m: Partial<MetricasPagas> }[] = []): Pago {
  return {
    total: m(total),
    campanhas: campanhas.map((c) => ({
      plataforma: 'meta', id: c.id, nome: c.nome, status: 'ACTIVE', status_efetivo: 'ACTIVE', objetivo: null,
      orcamento_diario_centavos: null, orcamento_total_centavos: null, metricas: m(c.m),
    })),
  }
}

function entrada(p: Partial<EntradaRegras> = {}): EntradaRegras {
  return { periodo: PERIODO, anterior: ANTERIOR, ...p }
}

describe('regras r1', () => {
  it('formata reais, percentuais e datas em pt-BR sem espaço especial', () => {
    expect(fmt.reais(123456)).toBe('R$ 1.234,56')
    expect(fmt.pct(-0.325)).toBe('33%')
    expect(fmt.data('2026-10-12')).toBe('12/10')
  })

  it('campanha com gasto ≥ R$ 50 e zero conversão vira achado alto', () => {
    const r = avaliar(entrada({
      meta_ads: { estado: 'ok', atual: pago({ gasto_centavos: 9000 }, [
        { id: 'c1', nome: 'Remarketing', m: { gasto_centavos: 6000, cliques: 120 } },
        { id: 'c2', nome: 'Pequena', m: { gasto_centavos: 4999 } },
      ]) },
    }))
    const a = r.achados.filter((x) => x.tipo === 'gasto_sem_conversao')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ id: 'meta_ads:gasto_sem_conversao:c1', severidade: 'alta', numeros: { gasto: 'R$ 60,00', cliques: '120' } })
  })

  it('CPA que sobe 20% ou mais vira achado médio; que cai vira informativo', () => {
    const sobe = avaliar(entrada({
      meta_ads: { estado: 'ok', atual: pago({ gasto_centavos: 12000, conversoes: 10 }), anterior: pago({ gasto_centavos: 10000, conversoes: 10 }) },
    }))
    expect(sobe.achados.find((a) => a.tipo === 'cpa_subiu')).toMatchObject({
      severidade: 'media', numeros: { cpa_atual: 'R$ 12,00', cpa_anterior: 'R$ 10,00', variacao: '20%' },
    })
    const cai = avaliar(entrada({
      google_ads: { estado: 'ok', atual: pago({ gasto_centavos: 7000, conversoes: 10 }), anterior: pago({ gasto_centavos: 10000, conversoes: 10 }) },
    }))
    expect(cai.achados.find((a) => a.tipo === 'cpa_caiu')?.severidade).toBe('info')
    const estavel = avaliar(entrada({
      meta_ads: { estado: 'ok', atual: pago({ gasto_centavos: 11900, conversoes: 10 }), anterior: pago({ gasto_centavos: 10000, conversoes: 10 }) },
    }))
    expect(estavel.achados.some((a) => a.tipo.startsWith('cpa_'))).toBe(false)
  })

  it('frequência acima de 4 com volume mínimo vira achado médio', () => {
    const r = avaliar(entrada({
      meta_ads: { estado: 'ok', atual: pago({}, [
        { id: 'f1', nome: 'Topo', m: { impressoes: 5000, alcance: 1000, conversoes: 3 } },
        { id: 'f2', nome: 'Baixo volume', m: { impressoes: 900, alcance: 100, conversoes: 1 } },
      ]) },
    }))
    const f = r.achados.filter((a) => a.tipo === 'frequencia_alta')
    expect(f.map((a) => a.id)).toEqual(['meta_ads:frequencia_alta:f1'])
    expect(f[0].numeros.frequencia).toBe('5,0')
  })

  it('gasto do Google Ads divergente do GA4 em mais de 10% vira achado', () => {
    const r = avaliar(entrada({
      google_ads: { estado: 'ok', atual: pago({ gasto_centavos: 10000, conversoes: 1 }) },
      ga4: { estado: 'ok', atual: { sessoes: 100, eventos_chave: 2, google_ads_segundo_ga4: { gasto_centavos: 8000, cliques: 1, impressoes: 1 } } },
    }))
    expect(r.achados.find((a) => a.tipo === 'divergencia_google_ads_ga4')?.numeros.diferenca).toBe('20%')
  })

  it('fonte expirada vira achado alto de reconexão e o relatório fica parcial (C11)', () => {
    const r = avaliar(entrada({
      meta_ads: { estado: 'expirado' },
      ga4: { estado: 'ok', atual: { sessoes: 10, eventos_chave: 0 } },
    }))
    expect(r.fontes.meta_ads).toBe('expirado')
    expect(r.achados[0]).toMatchObject({ id: 'fonte:meta_ads:expirado', severidade: 'alta' })
    expect(estadoFinal(r)).toBe('parcial')
  })

  it('sem nenhuma conta conectada o relatório é parcial; com tudo ok é pronto', () => {
    expect(estadoFinal(avaliar(entrada({ site: { estado: 'ok', atual: { url: 'https://x', checagens: [] } } })))).toBe('parcial')
    expect(estadoFinal(avaliar(entrada({ ga4: { estado: 'ok', atual: { sessoes: 1, eventos_chave: 0 } } })))).toBe('pronto')
  })

  it('problemas do site entram; essenciais são altos; não verificáveis ficam de fora', () => {
    const r = avaliar(entrada({
      site: { estado: 'ok', atual: { url: 'https://x', checagens: [
        { id: 'meta_pixel', titulo: 'Pixel', status: 'problema', evidencia: 'Sem pixel', recomendacao: 'Instale' },
        { id: 'consentimento', titulo: 'Cookies', status: 'atencao', evidencia: 'Sem banner', recomendacao: 'Adicione' },
        { id: 'eventos_servidor', titulo: 'Servidor', status: 'nao_verificavel', evidencia: '', recomendacao: '' },
      ] } },
    }))
    expect(r.achados.map((a) => [a.id, a.severidade])).toEqual([['site:meta_pixel', 'alta'], ['site:consentimento', 'baixa']])
  })

  it('é determinístico: mesma entrada, mesmo resultado', () => {
    const e = entrada({ meta_ads: { estado: 'ok', atual: pago({ gasto_centavos: 6000 }, [{ id: 'c', nome: 'X', m: { gasto_centavos: 6000 } }]) } })
    expect(avaliar(e)).toEqual(avaliar(e))
  })
})

describe('redação (C12)', () => {
  const r = avaliar(entrada({
    meta_ads: { estado: 'ok', atual: pago({ gasto_centavos: 12000, conversoes: 10 }, [{ id: 'c1', nome: 'Remarketing', m: { gasto_centavos: 6000, cliques: 120 } }]),
      anterior: pago({ gasto_centavos: 10000, conversoes: 10 }) },
  }))

  function gerador(json: unknown): GeradorIa {
    return vi.fn(async () => ({ json, uso: { modelo: 'claude-opus-5-5', tokens_entrada: 100, tokens_saida: 50 } }))
  }

  it('aceita a narrativa da IA quando ela só cita achados e números existentes', async () => {
    const json = {
      resumo: 'No período 12/10 a 18/10 o investimento no Meta foi de R$ 120,00. O custo por conversão subiu 20%.',
      prioridades: [{ achado_id: 'meta_ads:gasto_sem_conversao:c1', titulo: 'Pare de gastar sem retorno', o_que_fazer: 'Revise a campanha que gastou R$ 60,00 sem conversão.' }],
    }
    expect(validarNarrativa(json, r)).toBeNull()
    const { narrativa, uso } = await redigir(r, gerador(json))
    expect(narrativa.origem).toBe('ia')
    expect(uso?.modelo).toBe('claude-opus-5-5')
  })

  it('número que não está nos achados faz cair no texto de modelo, e o relatório sai mesmo assim', async () => {
    const json = { resumo: 'Você vendeu 4.321 unidades.', prioridades: [] }
    expect(validarNarrativa(json, r)).toBe('numero_fora_dos_achados')
    const { narrativa } = await redigir(r, gerador(json))
    expect(narrativa).toMatchObject({ origem: 'modelo', motivo_modelo: 'numero_fora_dos_achados' })
    expect(narrativa.prioridades[0].achado_id).toBe('meta_ads:gasto_sem_conversao:c1')
  })

  it('achado inexistente, recusa ou erro da IA também caem no texto de modelo', async () => {
    expect(validarNarrativa({ resumo: 'ok', prioridades: [{ achado_id: 'inventado', titulo: 't', o_que_fazer: 'f' }] }, r)).toBe('achado_inexistente')
    const recusa: GeradorIa = async () => { throw new Error('recusa_ia') }
    expect((await redigir(r, recusa)).narrativa).toMatchObject({ origem: 'modelo', motivo_modelo: 'recusa_ia' })
    const quebra: GeradorIa = async () => { throw new Error('Connection reset by peer: segredo') }
    expect((await redigir(r, quebra)).narrativa.motivo_modelo).toBe('falha_ia')
  })

  it('sem chave da IA (gerador nulo) sai o texto de modelo', async () => {
    const { narrativa, uso } = await redigir(r, null)
    expect(narrativa).toMatchObject({ origem: 'modelo', motivo_modelo: 'sem_ia' })
    expect(uso).toBeNull()
    expect(narrativa.resumo).toContain('R$ 120,00')
  })

  it('texto de modelo sem dados diz que só há o site', () => {
    const vazio = avaliar(entrada({}))
    expect(narrativaModelo(vazio).resumo).toContain('só a verificação do site')
  })
})

describe('e-mails', () => {
  it('relatório leva resumo, prioridades, botão e pedido de reconexão quando falta fonte', () => {
    const r = avaliar(entrada({ meta_ads: { estado: 'expirado' }, ga4: { estado: 'ok', atual: { sessoes: 10, eventos_chave: 1 } } }))
    const e = emailRelatorio({
      tipo: 'semanal', negocio: 'Loja <A>', resultado: r, narrativa: narrativaModelo(r),
      urlRelatorio: 'https://app.notechstack.com.br/auditor/x/relatorios/1', urlConexoes: 'https://app.notechstack.com.br/auditor/x/conexoes',
    })
    expect(e.assunto).toBe('Relatório semanal · Loja <A> · 12/10 a 18/10')
    expect(e.html).toContain('Loja &lt;A&gt;')
    expect(e.html).toContain('Reconecte o Facebook')
    expect(e.texto).toContain('Ver relatório completo: https://app.notechstack.com.br/auditor/x/relatorios/1')
  })

  it('aviso de expiração cita a plataforma', () => {
    expect(emailAviso({ tipo: 'expira_1d', negocio: 'Loja', provedor: 'meta', urlConexoes: 'u' }).assunto).toBe('A conexão com o Facebook expira amanhã')
  })

  it('Resend: id em caso de sucesso; 5xx é transitório; 4xx é recusa', async () => {
    const email = { assunto: 'a', texto: 't', html: 'h' }
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }))
    expect(await enviarResend({ apiKey: 'k', para: 'x@example.test', email, fetch: ok as unknown as typeof fetch })).toBe('em_1')
    const corpo = JSON.parse((ok.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(corpo.from).toBe('nó.agentes <relatorios@notechstack.com.br>')
    const cai = async () => new Response('{}', { status: 503 })
    await expect(enviarResend({ apiKey: 'k', para: 'x', email, fetch: cai as unknown as typeof fetch })).rejects.toThrow('resend_transitorio')
    const recusa = async () => new Response('{}', { status: 422 })
    await expect(enviarResend({ apiKey: 'k', para: 'x', email, fetch: recusa as unknown as typeof fetch })).rejects.toThrow('resend_recusou')
  })
})
