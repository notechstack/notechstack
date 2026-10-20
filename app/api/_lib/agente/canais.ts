// Canais de saída do agente. O envio real (Meta Cloud API, Resend) entra atrás destas
// interfaces; os testes usam um dublê (`api/_tests/agente-fixtures.ts`) e nunca chamam fora.
export type AnexoEmail = { nome: string; tipo: string; conteudo: Uint8Array }

export type MensagemEmail = { para: string; assunto: string; texto: string; anexos?: AnexoEmail[] }

export interface EnviaEmail {
  enviar(mensagem: MensagemEmail): Promise<void>
}

export interface EnviaWhatsApp {
  /** `para` em E.164 (`+5511…`). */
  enviarTexto(para: string, texto: string): Promise<void>
}
