// Hash do teste grátis. Check C11 de .checks/agente-fiscal-whatsapp.md (parte do app).
// Os valores esperados saem de sha256(sal + valor normalizado) calculado aqui, à parte.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashDoTeste, hashesDoTeste, normalizarParaTeste } from './teste-gratis.js'

const sha256 = (texto: string) => createHash('sha256').update(texto, 'utf8').digest('hex')

describe('teste grátis', () => {
  it('hash com sal e normalização', () => {
    const sal = 'sal-fixo-do-teste'

    // Vetores fixos (o lote C reproduz a mesma função em Deno e confere com estes).
    expect(hashDoTeste('cnpj', '11.444.777/0001-61', sal)).toBe('530a029d1184a46f6d940b425b0a084abcdbf89933ede0a3cbfd1bb3cb6e8972')
    expect(hashDoTeste('email', ' Fulano@Example.TEST ', sal)).toBe(
      'a07d8e63cfa0d2a68cf387d491113bfc2f1a6d6d38b9ab244a7adf60ce9f98de',
    )
    expect(hashDoTeste('phone', '(11) 98765-4321', sal)).toBe('6887e753951ddbddedc444de4bee15141c233920e5c8ab5a454a89844a3680a0')
    expect(hashDoTeste('cpf', '123.456.789-09', sal)).toBe('e05ce7666df6ecd848285a0e2a4d69dd3905dca0ce47c84f8da265b7445bfc1c')

    // sha256(sal + valor normalizado), sem separador.
    expect(hashDoTeste('cnpj', '11444777000161', sal)).toBe(sha256(`${sal}11444777000161`))

    // Normalização: o mesmo valor escrito de jeitos diferentes dá o mesmo hash.
    expect(normalizarParaTeste('cpf', '123.456.789-09')).toBe('12345678909')
    expect(normalizarParaTeste('cnpj', '11.444.777/0001-61')).toBe('11444777000161')
    expect(normalizarParaTeste('email', ' Fulano@Example.TEST ')).toBe('fulano@example.test')
    for (const telefone of ['(11) 98765-4321', '11987654321', '+55 11 98765-4321', '55 11 98765 4321']) {
      expect(normalizarParaTeste('phone', telefone)).toBe('+5511987654321')
      expect(hashDoTeste('phone', telefone, sal)).toBe(sha256(`${sal}+5511987654321`))
    }

    // O sal muda o hash; o valor em claro não aparece nele.
    expect(hashDoTeste('cnpj', '11444777000161', 'outro-sal')).not.toBe(hashDoTeste('cnpj', '11444777000161', sal))
    expect(hashDoTeste('cnpj', '11444777000161', sal)).toMatch(/^[0-9a-f]{64}$/)

    // Sem sal, recusa (falha fechada).
    expect(() => hashDoTeste('cnpj', '11444777000161', '')).toThrow()
    expect(() => hashDoTeste('cnpj', '11444777000161', undefined)).toThrow()

    // Valor inválido não vira hash.
    expect(() => normalizarParaTeste('cpf', '1234')).toThrow()
    expect(() => normalizarParaTeste('cnpj', '123')).toThrow()
    expect(() => normalizarParaTeste('email', 'sem-arroba')).toThrow()
    expect(() => normalizarParaTeste('phone', '123')).toThrow()

    // O conjunto que vai para public.fiscal_reivindicar_teste.
    expect(
      hashesDoTeste({ cnpj: '11.444.777/0001-61', email: 'fulano@example.test', phone: '(11) 98765-4321' }, sal),
    ).toEqual({
      cnpj: '530a029d1184a46f6d940b425b0a084abcdbf89933ede0a3cbfd1bb3cb6e8972',
      email: 'a07d8e63cfa0d2a68cf387d491113bfc2f1a6d6d38b9ab244a7adf60ce9f98de',
      phone: '6887e753951ddbddedc444de4bee15141c233920e5c8ab5a454a89844a3680a0',
    })
    expect(
      hashesDoTeste({ cpf: '123.456.789-09', cnpj: '11444777000161', email: 'fulano@example.test', phone: '11987654321' }, sal),
    ).toMatchObject({ cpf: 'e05ce7666df6ecd848285a0e2a4d69dd3905dca0ce47c84f8da265b7445bfc1c' })
  })
})
