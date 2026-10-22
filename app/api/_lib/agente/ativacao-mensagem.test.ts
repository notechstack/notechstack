import { describe, expect, it } from 'vitest'
import { codigoDaMensagem, mensagemDeAtivacao } from './ativacao.js'

// Mensagem de ativação legível (Lucca, 22/10/2026): empresa e plano para quem lê; o código é a chave.
describe('mensagem de ativação', () => {
  it('leva empresa, plano e código, e o agente lê o código de volta', () => {
    const m = mensagemDeAtivacao('EMPRESA  DEMO 12345 LTDA', 'pro', '116605')
    expect(m).toBe('Quero ativar o nó.fiscal da EMPRESA DEMO 12345 LTDA no plano Pro. Código de ativação: 116605')
    expect(codigoDaMensagem(m)).toBe('116605')
    expect(codigoDaMensagem(mensagemDeAtivacao('EMPRESA 123456 LTDA', 'inicial', '654321'))).toBe('654321')
  })
  it('aceita a forma antiga e variações de digitação', () => {
    expect(codigoDaMensagem('ATIVAR 116605')).toBe('116605')
    expect(codigoDaMensagem('ativar 116605')).toBe('116605')
    expect(codigoDaMensagem('codigo de ativacao 116605')).toBe('116605')
  })
  it('não confunde pedido de nota com ativação', () => {
    expect(codigoDaMensagem('nota pra Studio Lima, 116605 reais')).toBeNull()
    expect(codigoDaMensagem('ATIVAR 12345')).toBeNull()
  })
})
