// Número próprio do agente (Lucca, 29/10/2026): o nó.fiscal ganha um número só do robô, separado do número
// oficial da Nó, que fica com o atendimento. O webhook só conversa com mensagens para o número do agente, e o
// ambiente diz à conversa quando mandar quem pede uma pessoa para o número oficial. Nada aqui abre o banco.
import { describe, expect, it } from 'vitest'
import { numeroProprioFromEnv } from './ambiente.js'
import { NUMERO_OFICIAL_DA_NO, TEXTOS, WHATSAPP_COMERCIAL } from './conversa.js'
import { mensagensDaNotificacao } from './webhook.js'

const DO_AGENTE = '1112223334445'
const DO_ATENDIMENTO = '9998887776665'

function notificacao(para: string, de = '5511988887777') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '4527211857516279',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5511900000000', phone_number_id: para },
              messages: [{ from: de, id: `wamid.${para}`, timestamp: '1793217000', type: 'text', text: { body: 'oi' } }],
            },
          },
        ],
      },
    ],
  }
}

describe('mensagensDaNotificacao com o número do agente', () => {
  it('entrega a mensagem para o número do agente', () => {
    const mensagens = mensagensDaNotificacao(notificacao(DO_AGENTE), DO_AGENTE)
    expect(mensagens).toHaveLength(1)
    expect(mensagens[0]).toMatchObject({ id: `wamid.${DO_AGENTE}`, de: '+5511988887777', texto: 'oi' })
  })

  it('ignora a mensagem para outro número da mesma conta', () => {
    expect(mensagensDaNotificacao(notificacao(DO_ATENDIMENTO), DO_AGENTE)).toEqual([])
  })

  it('sem o número configurado, entrega como antes', () => {
    expect(mensagensDaNotificacao(notificacao(DO_ATENDIMENTO))).toHaveLength(1)
  })

  it('separa as mudanças de uma mesma notificação por número', () => {
    const corpo = notificacao(DO_AGENTE)
    corpo.entry[0].changes.push(notificacao(DO_ATENDIMENTO).entry[0].changes[0])
    expect(mensagensDaNotificacao(corpo, DO_AGENTE).map((m) => m.id)).toEqual([`wamid.${DO_AGENTE}`])
  })
})

describe('numeroProprioFromEnv', () => {
  it('sem WHATSAPP_NUMERO_AGENTE, o agente divide o número oficial', () => {
    expect(numeroProprioFromEnv({})).toBe(false)
  })

  it('com o número oficial da Nó, em qualquer formato, continua dividido', () => {
    expect(numeroProprioFromEnv({ WHATSAPP_NUMERO_AGENTE: NUMERO_OFICIAL_DA_NO })).toBe(false)
    expect(numeroProprioFromEnv({ WHATSAPP_NUMERO_AGENTE: '+55 11 93928-9413' })).toBe(false)
  })

  it('com outro número, o agente tem número próprio', () => {
    expect(numeroProprioFromEnv({ WHATSAPP_NUMERO_AGENTE: '+55 11 90000-0000' })).toBe(true)
  })
})

describe('texto de atendimento no número próprio', () => {
  it('manda a pessoa para o número oficial, sem prometer resposta por aqui', () => {
    expect(TEXTOS.chamouAEquipeNoOutroNumero).toContain(WHATSAPP_COMERCIAL)
    expect(TEXTOS.chamouAEquipeNoOutroNumero).not.toContain('te responde por aqui')
  })
})
