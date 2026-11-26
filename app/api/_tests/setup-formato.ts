// Formato das mensagens do agente (Lucca, 24/11/2026): todo teste de api/ que manda WhatsApp pelo dublê dos canais
// (`canaisDouble`) falha se alguma mensagem saiu como bloco corrido (mais de ~280 caracteres sem nenhuma quebra).
import { afterEach, expect } from 'vitest'
import { blocosCorridos } from './formato-registro.js'

afterEach(() => {
  const corridos = blocosCorridos.splice(0)
  expect(corridos, 'mensagem do agente em bloco corrido: quebre em blocos com o helper de formato.ts').toEqual([])
})
