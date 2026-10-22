// Canais de saída do agente. O envio real (Meta Cloud API, Resend) entra atrás destas
// interfaces; os testes usam um dublê (`api/_tests/agente-fixtures.ts`) e nunca chamam fora.
import { logEvent } from '../log.js'

export type AnexoEmail = { nome: string; tipo: string; conteudo: Uint8Array }

export type MensagemEmail = {
  para: string
  assunto: string
  texto: string
  anexos?: AnexoEmail[]
  /** Chave de idempotência do provedor (Resend `Idempotency-Key`), para reenvio sem duplicar. */
  idempotencia?: string
}

export interface EnviaEmail {
  enviar(mensagem: MensagemEmail): Promise<void>
}

export interface EnviaWhatsApp {
  /** `para` em E.164 (`+5511…`). */
  enviarTexto(para: string, texto: string): Promise<void>
  /** Documento (o PDF da nota) com a legenda na mesma mensagem. */
  enviarDocumento(para: string, anexo: AnexoEmail, legenda: string): Promise<void>
  /** Modelo aprovado na Meta, o único envio aceito fora da janela de 24 h (Landing v2, lote C). */
  enviarModelo(para: string, nome: string, parametros: string[]): Promise<void>
}

export const TENTATIVAS_DE_ENVIO = 3

async function tentar(canal: 'whatsapp' | 'email', envio: () => Promise<void>): Promise<boolean> {
  for (let tentativa = 1; tentativa <= TENTATIVAS_DE_ENVIO; tentativa++) {
    try {
      await envio()
      return true
    } catch (error) {
      logEvent('agente.envio_tentativa_falhou', {
        canal,
        tentativa,
        error_name: error instanceof Error ? error.name : 'unknown',
      })
    }
  }
  logEvent('agente.envio_falhou', { canal, tentativas: TENTATIVAS_DE_ENVIO })
  return false
}

/**
 * Envio com até 3 tentativas e registro da falha (Unresolved 14, padrão). Nunca lança: o que
 * a conversa já gravou não pode ser desfeito por uma falha de envio, senão a Meta reentrega
 * a mensagem e o pedido nasce de novo (Landing, lote B - entregas).
 */
export function whatsappComRetentativa(whatsapp: EnviaWhatsApp): EnviaWhatsApp {
  return {
    async enviarTexto(para, texto) {
      await tentar('whatsapp', () => whatsapp.enviarTexto(para, texto))
    },
    async enviarDocumento(para, anexo, legenda) {
      await tentar('whatsapp', () => whatsapp.enviarDocumento(para, anexo, legenda))
    },
    async enviarModelo(para, nome, parametros) {
      await tentar('whatsapp', () => whatsapp.enviarModelo(para, nome, parametros))
    },
  }
}

export function emailComRetentativa(email: EnviaEmail): EnviaEmail {
  return {
    async enviar(mensagem) {
      await tentar('email', () => email.enviar(mensagem))
    },
  }
}
