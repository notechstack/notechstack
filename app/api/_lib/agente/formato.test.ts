// Formato das mensagens do agente (Lucca, 24/11/2026). O helper, e todos os textos fixos e montados do agente: nenhum
// sai como bloco corrido (mais de ~280 caracteres sem quebra de linha). As conversas inteiras são conferidas pelo
// dublê dos canais (api/_tests/setup-formato.ts).
import { describe, expect, it } from 'vitest'
import { TEXTOS_BOAS_VINDAS } from './boas-vindas.js'
import { TEXTOS_COMANDOS } from './comandos.js'
import {
  codigoDoPedido,
  perguntaDaUf,
  TEXTO_LOCAL_CORRIGIR,
  TEXTO_RETENCAO_NAO_ENTENDIDA,
  TEXTO_SEM_RETENCAO_POSSIVEL,
  textoDaObraQueFalta,
  textoDoBloqueio,
  textoDoResumo,
  TEXTOS,
} from './conversa.js'
import { perguntaDoEmitente } from './emitente.js'
import { listaDeOpcoes } from './escolher-nota.js'
import { blocos, campo, comRotulo, ehBlocoCorrido, MAX_SEM_QUEBRA, mensagem, negrito, topicos } from './formato.js'
import type { CatalogoDeServicos } from './catalogo-servicos.js'
import { textoDasColunas, textoDoResumoDoLote, TEXTOS_DO_LOTE, type ItemDoLote } from './lote.js'
import { avisoDoRetorno } from './lote-retorno.js'
import { TEXTOS_DO_MODELO } from './modelo-emissao.js'
import { TEXTOS_NFE } from './nfe-conversa.js'
import { LINHA_DA_PLANILHA, TEXTO_VER_NOTA } from './planos.js'

const LINKS = {
  site: 'https://www.notechstack.com.br/agentes/fiscal/',
  certificado: 'https://www.notechstack.com.br/agentes/fiscal/conta/#certificado',
  assinatura: 'https://www.notechstack.com.br/agentes/fiscal/conta/#assinatura',
  conta: 'https://www.notechstack.com.br/agentes/fiscal/conta/',
}

describe('helper de formato', () => {
  it('negrito, campo, rótulo e tópicos', () => {
    expect(negrito('Resumo da nota')).toBe('*Resumo da nota*')
    expect(campo('Tomador', 'Studio Lima')).toBe('*Tomador:* Studio Lima')
    expect(comRotulo('Valor líquido: R$ 343,00')).toBe('*Valor líquido:* R$ 343,00')
    expect(comRotulo('*Tomador:* Studio Lima')).toBe('*Tomador:* Studio Lima')
    expect(comRotulo('sem rótulo')).toBe('sem rótulo')
    expect(topicos(['um', 'dois'])).toBe('• um\n• dois')
  })

  it('blocos separados por linha em branco; vazios somem; lista fica junta', () => {
    expect(blocos('Um.', null, ['linha 1', false, 'linha 2'], '', 'Dois.')).toBe('Um.\n\nlinha 1\nlinha 2\n\nDois.')
  })

  it('mensagem: título só com mais de um bloco, a ação sozinha no fim', () => {
    expect(mensagem({ titulo: 'Resumo', blocos: ['Corpo.'], acao: 'Responda *confirmar*.' })).toBe('*Resumo*\n\nCorpo.\n\nResponda *confirmar*.')
    expect(mensagem({ titulo: 'Resumo', blocos: ['Frase curta.'] })).toBe('Frase curta.')
  })

  it('bloco corrido: passa do limite sem nenhuma quebra', () => {
    expect(ehBlocoCorrido('a'.repeat(MAX_SEM_QUEBRA))).toBe(false)
    expect(ehBlocoCorrido('a'.repeat(MAX_SEM_QUEBRA + 1))).toBe(true)
    expect(ehBlocoCorrido(`${'a'.repeat(200)}\n\n${'b'.repeat(200)}`)).toBe(false)
  })
})

/** Cada texto fixo de um objeto de textos, com o caminho para a mensagem de erro. */
const textosDe = (nome: string, objeto: Record<string, unknown>) =>
  Object.entries(objeto).filter((par): par is [string, string] => typeof par[1] === 'string').map(([chave, texto]) => [`${nome}.${chave}`, texto] as const)

describe('nenhum texto do agente sai como bloco corrido', () => {
  it('textos fixos', () => {
    const todos = [
      ...textosDe('TEXTOS', TEXTOS),
      ...textosDe('TEXTOS_DO_LOTE', TEXTOS_DO_LOTE),
      ...textosDe('TEXTOS_NFE', TEXTOS_NFE),
      ...textosDe('TEXTOS_BOAS_VINDAS', TEXTOS_BOAS_VINDAS),
      ...textosDe('TEXTOS_COMANDOS', TEXTOS_COMANDOS),
      ...textosDe('TEXTOS_DO_MODELO', TEXTOS_DO_MODELO),
      ['TEXTO_RETENCAO_NAO_ENTENDIDA', TEXTO_RETENCAO_NAO_ENTENDIDA],
      ['TEXTO_SEM_RETENCAO_POSSIVEL', TEXTO_SEM_RETENCAO_POSSIVEL],
      ['TEXTO_LOCAL_CORRIGIR', TEXTO_LOCAL_CORRIGIR],
      ['TEXTO_VER_NOTA', TEXTO_VER_NOTA],
      ['LINHA_DA_PLANILHA', LINHA_DA_PLANILHA],
    ] as const
    expect(todos.length).toBeGreaterThan(40)
    expect(todos.filter(([, texto]) => ehBlocoCorrido(texto)).map(([nome]) => nome)).toEqual([])
  })

  it('bloqueios da emissão', () => {
    const codigos = [
      'PAYMENT_NOT_APPROVED', 'CERT_EXPIRED', 'CERT_MISSING', 'PROCURACAO_NAO_ENCONTRADA', 'PROCURACAO_MISSING', 'PROCURACAO_INVALIDA',
      'PROCURACAO_VENCIDA', 'PROCURADOR_CERT_INVALIDO', 'NO_SUBSCRIPTION', 'SUBSCRIPTION_CANCELLED', 'FISCAL_CONFIG_MISSING', 'OUTRO',
    ]
    expect(codigos.filter((c) => ehBlocoCorrido(textoDoBloqueio(c, LINKS)))).toEqual([])
  })

  it('textos montados, com nomes e valores longos', () => {
    const razao = 'Contabilidade Bragantina Assessoria Contábil e Empresarial Sociedade Simples Limitada'
    const resumo = textoDoResumo(
      { nome: razao, documento: '11444777000161', email: 'financeiro@bragantina.test' },
      { codigo: '171901', descricao: 'Honorários contábeis de novembro/2026 referentes à escrituração fiscal e folha de pagamento' },
      '1500.00',
      'Contabilidade, inclusive serviços técnicos e auxiliares.',
      { id: 'e2', razao_social: razao, cnpj: '11222333000181' },
      { iss: { aliquota: '2.00' } },
      'Banco 341, agência 1234, conta 56789-0. Pix: financeiro@bragantina.test',
      'Bragança Paulista/SP',
    )
    const itens: ItemDoLote[] = [
      { linha: 2, tenantId: 'e1', payload: { valor: '300.00' }, problema: null, valor: '300.00' },
      { linha: 3, tenantId: 'e1', payload: { lido: { cnpj_prestador: '' } }, problema: 'PRESTADOR_DESCONHECIDO' },
      { linha: 4, tenantId: 'e1', payload: { lido: {} }, problema: 'OBRA_INVALIDA' },
    ]
    const empresas = [{ id: 'e1', cnpj: '11222333000181', razao_social: razao, active: true, codigo_servico_nacional: '171901' }]
    const montados = {
      resumo,
      obra: textoDaObraQueFalta(null, 'Bragança Paulista/SP'),
      uf: perguntaDaUf({ nome: 'Bom Jesus', ufs: ['GO', 'PB', 'PI', 'RN', 'RS', 'SC'] }),
      emitente: perguntaDoEmitente(
        Array.from({ length: 8 }, (_, i) => ({ id: `e${i}`, cnpj: '11222333000181', razao_social: `${razao} ${i}`, principal: i === 0 })),
        { naoAchei: 'Oficina Trilho' },
      ).texto,
      lote: textoDoResumoDoLote({ arquivo: 'novembro.xlsx', itens, empresas, franquia: { limite: 500, noMes: 499 } }),
      colunas: textoDasColunas({ desconhecidas: ['cnpj', 'nome'], faltando: ['valor'], repetidas: [] }),
      retorno: avisoDoRetorno(
        { created_at: new Date('2026-11-24T12:00:00Z') },
        { emitidas: 40, recusadas: 2, naFila: 1, naoEmitidas: 3, valorEmitido: '48000.00' },
        { email: 'contato@bragantina.test', pdfsNoEmail: false },
        `${LINKS.conta}#relatorios`,
      ),
      cancelar: listaDeOpcoes(
        'Achei mais de uma nota. Qual delas você quer cancelar?',
        Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, tenantId: 'e1', numero: String(i + 1), nome: razao, valor: '1500.00', emitidaEm: new Date(), empresa: razao })),
      ),
    }
    expect(Object.entries(montados).filter(([, texto]) => ehBlocoCorrido(texto)).map(([nome]) => nome)).toEqual([])
    // O resumo da nota: título em negrito, rótulos em negrito, blocos e a pergunta sozinha no fim.
    expect(resumo.startsWith('*Resumo da nota*\n\n')).toBe(true)
    expect(resumo).toContain(`*Tomador:* ${razao}`)
    expect(resumo).toContain('*ISS retido pelo tomador:* 2% (R$ 30,00)')
    expect(resumo.split('\n\n').at(-1)).toBe('Posso emitir? Responda *confirmar* para emitir ou *corrigir* para mudar algo.')
  })

  it('código de serviço com várias opções', async () => {
    const lista = new Map(Array.from({ length: 8 }, (_, i) => [`0401${String(i).padStart(2, '0')}`, `Medicina e biomedicina, análises clínicas e congêneres, item ${i}`]))
    const catalogo = { itens: async () => lista, descricao: async () => null } as unknown as CatalogoDeServicos
    const r = await codigoDoPedido(catalogo, { codigo_servico: null, servico: 'medicina' }, async () => [])
    const texto = r && 'texto' in r ? r.texto : ''
    expect(texto.startsWith('*Código de serviço*')).toBe(true)
    expect(ehBlocoCorrido(texto)).toBe(false)
  })
})
