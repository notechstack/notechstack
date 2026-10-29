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

/** O que a Cloud API devolve de um envio aceito; os dublês e as camadas de cima podem não devolver nada. */
export type Enviada = { wamid: string | null }

export interface EnviaWhatsApp {
  /** `para` em E.164 (`+5511…`). */
  enviarTexto(para: string, texto: string): Promise<Enviada | void>
  /** Documento (o PDF da nota) com a legenda na mesma mensagem. */
  enviarDocumento(para: string, anexo: AnexoEmail, legenda: string): Promise<Enviada | void>
  /** Modelo aprovado na Meta, o único envio aceito fora da janela de 24 h (Landing v2, lote C). */
  enviarModelo(para: string, nome: string, parametros: string[]): Promise<Enviada | void>
}

export const TENTATIVAS_DE_ENVIO = 3

async function tentar(canal: 'whatsapp' | 'email', envio: () => Promise<unknown>): Promise<boolean> {
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

/** Texto com as mesmas tentativas, dizendo se saiu: quem marca "uma vez" antes de enviar desfaz a marca quando não saiu. */
export function textoComRetentativa(whatsapp: EnviaWhatsApp, para: string, texto: string): Promise<boolean> {
  return tentar('whatsapp', () => whatsapp.enviarTexto(para, texto))
}

/** E-mail com as mesmas tentativas, dizendo se saiu: quem marca "avisado" só marca o que saiu. */
export function emailSaiu(email: EnviaEmail, mensagem: MensagemEmail): Promise<boolean> {
  return tentar('email', () => email.enviar(mensagem))
}

export function emailComRetentativa(email: EnviaEmail): EnviaEmail {
  return {
    async enviar(mensagem) {
      await tentar('email', () => email.enviar(mensagem))
    },
  }
}
