// Registro dos textos de WhatsApp que saíram como bloco corrido nos dublês dos testes (mais de `MAX_SEM_QUEBRA`
// caracteres sem nenhuma quebra de linha). O `afterEach` de `setup-formato.ts` falha o teste que deixar algum aqui.
import { ehBlocoCorrido } from '../_lib/agente/formato.js'

export const blocosCorridos: string[] = []

export function conferirFormato(texto: string | null | undefined): void {
  if (texto && ehBlocoCorrido(texto)) blocosCorridos.push(texto)
}
