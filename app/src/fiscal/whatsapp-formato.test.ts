import { describe, expect, it } from 'vitest'
import { trechosDoWhatsApp } from './whatsapp-formato'

const t = (texto: string, negrito = false, italico = false) => ({ texto, negrito, italico })

describe('trechosDoWhatsApp', () => {
  it('texto sem marca fica num trecho só', () => {
    expect(trechosDoWhatsApp('Emitindo na Sefin.')).toEqual([t('Emitindo na Sefin.')])
  })

  it('negrito e itálico, sem as marcas', () => {
    expect(trechosDoWhatsApp('*Resumo da nota*\n\n*Tomador:* Studio Lima')).toEqual([
      t('Resumo da nota', true),
      t('\n\n'),
      t('Tomador:', true),
      t(' Studio Lima'),
    ])
    expect(trechosDoWhatsApp('responda _padrão_.')).toEqual([t('responda '), t('padrão', false, true), t('.')])
  })

  it('itálico dentro do negrito', () => {
    expect(trechosDoWhatsApp('*Total _bruto_*')).toEqual([t('Total ', true), t('bruto', true, true)])
  })

  it('não lê marca no meio de palavra, com espaço por dentro ou atravessando a linha', () => {
    for (const texto of ['codigo_servico e obra_cep', '2 * 3 * 4', '* solto *', 'abre *aqui\nfecha* ali', 'a*b*c']) {
      expect(trechosDoWhatsApp(texto)).toEqual([t(texto)])
    }
  })

  it('pontuação depois da marca vale', () => {
    expect(trechosDoWhatsApp('Responda *confirmar*, ou *corrigir*.')).toEqual([
      t('Responda '),
      t('confirmar', true),
      t(', ou '),
      t('corrigir', true),
      t('.'),
    ])
  })
})
