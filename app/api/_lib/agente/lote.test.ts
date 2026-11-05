// Lote por planilha da conta Escritório, a parte pura: leitura de .csv e .xlsx, cabeçalhos, valores, cada código de
// problema, resumo, CSV de retorno e .zip (.design/agente-fiscal-escritorio.md, Planilha v1 e Códigos de problema).
// Os caminhos com banco (gravar, confirmar, entregar, fechar) estão em lote-escritorio.test.ts.
import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { montarXlsx } from '../../_tests/xlsx-fixture.js'
import {
  alcanceDaPrimeiraAba,
  decodificarTexto,
  interpretarGrade,
  lerCsvTexto,
  lerDocumento,
  lerDocumentoDaCelula,
  lerPlanilha,
  lerValor,
  MAX_COLUNAS_DA_ABA,
  MAX_LINHAS_DA_ABA,
  MODELO_DA_PLANILHA,
  motivoDoProblema,
  PlanilhaGrandeDemais,
  PlanilhaIlegivel,
  separadorDoCsv,
  textoDasColunas,
  textoDoResumoDoLote,
  tipoDaPlanilha,
  validarLinhas,
  type Celula,
  type ContextoDoLote,
  type Empresa,
} from './lote.js'
import { avisoDoRetorno, contagemDoRetorno, retornoCsv, textoDoRetorno, zipDasNotas, type ItemDoRetorno } from './lote-retorno.js'
import { LIMITE_DA_MIDIA, MidiaGrandeDemais, whatsappCloud } from './whatsapp-cloud.js'

const ESCRITORIO: Empresa = { id: 'e1', cnpj: '12345678000195', razao_social: 'Escritório Toledo', active: true, codigo_servico_nacional: '171901' }
const CLIENTE: Empresa = { id: 'e2', cnpj: '11222333000181', razao_social: 'Padaria Cliente', active: true, codigo_servico_nacional: '010701' }
const CPF = '52998224725'
const CNPJ_TOMADOR = '11444777000161'

function contexto(parcial: Partial<ContextoDoLote> = {}): ContextoDoLote {
  return {
    empresas: [ESCRITORIO, CLIENTE],
    bloqueios: new Map([
      ['e1', null],
      ['e2', null],
    ]),
    modelos: new Map(),
    jaEmitidas: new Set(),
    ...parcial,
  }
}

const utf8 = (texto: string) => new TextEncoder().encode(texto)

describe('arquivo da planilha', () => {
  it('reconhece .xlsx e .csv pela extensão ou pelo mime, e separa os formatos que não lê', () => {
    expect(tipoDaPlanilha({ nome: 'Notas Novembro.XLSX', mime: null })).toBe('xlsx')
    expect(tipoDaPlanilha({ nome: 'notas.csv', mime: 'application/vnd.ms-excel' })).toBe('csv')
    expect(tipoDaPlanilha({ nome: null, mime: 'text/csv' })).toBe('csv')
    expect(tipoDaPlanilha({ nome: null, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toBe('xlsx')
    expect(tipoDaPlanilha({ nome: 'notas.xlsm', mime: null })).toBe('outra')
    expect(tipoDaPlanilha({ nome: 'notas.xls', mime: null })).toBe('outra')
    expect(tipoDaPlanilha({ nome: 'contrato.pdf', mime: 'application/pdf' })).toBeNull()
  })

  it('csv em UTF-8 com BOM, separador ;, aspas e quebra de linha dentro de aspas', async () => {
    const texto = '\uFEFFcpf_cnpj_tomador;nome_tomador;valor;descricao\r\n529.982.247-25;"Maria; Silva";"1.234,56";"linha 1\nlinha 2"\r\n'
    const grade = await lerPlanilha(utf8(texto), 'csv')
    expect(grade).toEqual([
      ['cpf_cnpj_tomador', 'nome_tomador', 'valor', 'descricao'],
      ['529.982.247-25', 'Maria; Silva', '1.234,56', 'linha 1\nlinha 2'],
    ])
  })

  it('csv sem BOM com separador vírgula e aspas dobradas', () => {
    expect(lerCsvTexto('nome_tomador,valor\n"Ana ""Aninha""",10.50\n')).toEqual([
      ['nome_tomador', 'valor'],
      ['Ana "Aninha"', '10.50'],
    ])
  })

  it('csv que não é UTF-8 é lido como Windows-1252 (o do Excel em português)', () => {
    const latin = Uint8Array.from([0x44, 0x65, 0x73, 0x63, 0x72, 0x69, 0xe7, 0xe3, 0x6f]) // "Descrição"
    expect(decodificarTexto(latin)).toBe('Descrição')
    expect(decodificarTexto(utf8('\uFEFFDescrição'))).toBe('Descrição')
  })

  it('xlsx: só a primeira aba, fórmula pelo valor guardado e números como números', async () => {
    const xlsx = montarXlsx([
      {
        nome: 'Notas',
        linhas: [
          ['CPF/CNPJ Tomador', 'Nome Tomador', 'Valor'],
          [52998224725, 'Maria', { formula: 'SUM(100,23.45)', valor: 123.45 }],
          ['11.444.777/0001-61', { formula: 'CONCATENATE("Padaria"," Boa")', valor: 'Padaria Boa' }, '1.500,00'],
        ],
      },
      { nome: 'Outra', linhas: [['nada'], ['daqui']] },
    ])
    const grade = await lerPlanilha(xlsx, 'xlsx')
    expect(grade).toEqual([
      ['CPF/CNPJ Tomador', 'Nome Tomador', 'Valor'],
      [52998224725, 'Maria', 123.45],
      ['11.444.777/0001-61', 'Padaria Boa', '1.500,00'],
    ])
  })

  it('o modelo publicado (.xlsx e .csv) lê sem problema de coluna', async () => {
    for (const [arquivo, tipo] of [
      ['../../../../agentes/fiscal/dados/modelo-lote.xlsx', 'xlsx'],
      ['../../../../agentes/fiscal/dados/modelo-lote.csv', 'csv'],
    ] as const) {
      const grade = await lerPlanilha(new Uint8Array(readFileSync(new URL(arquivo, import.meta.url))), tipo)
      const planilha = interpretarGrade(grade, { prestadorObrigatorio: true })
      expect(planilha.ok).toBe(true)
      if (!planilha.ok) continue
      expect(planilha.linhas).toHaveLength(2)
      const itens = validarLinhas(planilha.linhas, contexto())
      expect(itens.map((i) => i.problema)).toEqual([null, null])
      expect(itens.map((i) => i.valor)).toEqual(['1500.00', '350.00'])
    }
  })

  it('xlsx pequeno com célula distante é recusado antes do leitor (sem estourar a memória)', async () => {
    const linhas = [
      ['cpf_cnpj_tomador', 'nome_tomador', 'valor'],
      [CPF, 'Maria', 10],
    ]
    for (const [aba, alcance] of [
      [{ nome: 'Notas', linhas, celulaSolta: { ref: 'XFD1048576', valor: 'x' } }, { linhas: 1048576, colunas: 16384 }],
      [{ nome: 'Notas', linhas, celulaSolta: { ref: 'ZZ30000', valor: 'x' } }, { linhas: 30000, colunas: 702 }],
      [{ nome: 'Notas', linhas, dimensao: 'A1:C5000' }, { linhas: 5000, colunas: 3 }],
      [{ nome: 'Notas', linhas, celulaSolta: { ref: 'AY3', valor: 'x' } }, { linhas: 3, colunas: 51 }],
    ] as const) {
      const xlsx = montarXlsx([aba])
      expect(xlsx.byteLength).toBeLessThan(5000)
      expect(alcanceDaPrimeiraAba(xlsx)).toEqual(alcance)
      await expect(lerPlanilha(xlsx, 'xlsx')).rejects.toBeInstanceOf(PlanilhaGrandeDemais)
    }
    // Só a primeira aba conta: a segunda pode ir longe; e até 1.021 linhas e 50 colunas passa.
    const ok = montarXlsx([
      { nome: 'Notas', linhas, celulaSolta: { ref: `AX${MAX_LINHAS_DA_ABA}`, valor: '' } },
      { nome: 'Rascunho', linhas: [['x']], celulaSolta: { ref: 'XFD1048576', valor: 'longe' } },
    ])
    expect(alcanceDaPrimeiraAba(ok)).toEqual({ linhas: MAX_LINHAS_DA_ABA, colunas: MAX_COLUNAS_DA_ABA })
  })

  it('arquivo que não é xlsx de verdade é recusado', async () => {
    await expect(lerPlanilha(utf8('não sou um zip'), 'xlsx')).rejects.toBeInstanceOf(PlanilhaIlegivel)
  })
})

describe('baixarMidia (Cloud API, com fetch de dublê)', () => {
  const corpo = utf8('cpf_cnpj_tomador;nome_tomador;valor\n')
  function fetchDouble(tamanho = corpo.byteLength, conteudo = corpo) {
    const chamadas: { url: string; auth: string | null }[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      chamadas.push({ url, auth: new Headers(init?.headers).get('authorization') })
      if (url.endsWith('/v26.0/MIDIA-1')) {
        return Response.json({ url: 'https://lookaside.test/whatsapp?mid=1', mime_type: 'text/csv', file_size: tamanho, id: 'MIDIA-1' })
      }
      return new Response(conteudo, { status: 200 })
    }) as unknown as typeof globalThis.fetch
    return { fetch, chamadas }
  }

  it('GET /{media-id} → url, depois GET url, os dois com o token', async () => {
    const f = fetchDouble()
    const cliente = whatsappCloud({ token: 'tok', phoneNumberId: '123', graphUrl: 'https://graph.test', fetch: f.fetch })
    const midia = await cliente.baixarMidia('MIDIA-1')
    expect(new TextDecoder().decode(midia.conteudo)).toBe('cpf_cnpj_tomador;nome_tomador;valor\n')
    expect(midia.mime).toBe('text/csv')
    expect(f.chamadas).toEqual([
      { url: 'https://graph.test/v26.0/MIDIA-1', auth: 'Bearer tok' },
      { url: 'https://lookaside.test/whatsapp?mid=1', auth: 'Bearer tok' },
    ])
  })

  it('acima de 5 MB não baixa (pelo tamanho declarado ou pelo que chega)', async () => {
    const declarado = fetchDouble(6 * 1024 * 1024)
    await expect(
      whatsappCloud({ token: 't', phoneNumberId: '1', graphUrl: 'https://graph.test', fetch: declarado.fetch }).baixarMidia('MIDIA-1'),
    ).rejects.toBeInstanceOf(MidiaGrandeDemais)
    expect(declarado.chamadas).toHaveLength(1)
    const mentiroso = fetchDouble(10, new Uint8Array(LIMITE_DA_MIDIA + 1))
    await expect(
      whatsappCloud({ token: 't', phoneNumberId: '1', graphUrl: 'https://graph.test', fetch: mentiroso.fetch }).baixarMidia('MIDIA-1'),
    ).rejects.toBeInstanceOf(MidiaGrandeDemais)
  })
})

describe('cabeçalho', () => {
  it('sem diferença de caixa, acento, espaço, _ ou -', () => {
    const grade: Celula[][] = [
      [' CNPJ Prestador ', 'CPF-CNPJ_Tomador', 'NOME TOMADOR', 'E-mail Tomador', 'Valor', 'Descrição'],
      ['12345678000195', CPF, 'Maria', '', '10', ''],
    ]
    const planilha = interpretarGrade(grade, { prestadorObrigatorio: true })
    expect(planilha.ok).toBe(true)
    if (planilha.ok) {
      expect(planilha.colunas).toEqual(['cnpj_prestador', 'cpf_cnpj_tomador', 'nome_tomador', 'email_tomador', 'valor', 'descricao'])
      expect(planilha.linhas[0].linha).toBe(2)
    }
  })

  it('coluna desconhecida ou obrigatória faltando: explica as colunas e manda o modelo', () => {
    const grade: Celula[][] = [
      ['cliente', 'valor', 'descricao'],
      ['Maria', '10', 'x'],
    ]
    const planilha = interpretarGrade(grade, { prestadorObrigatorio: true })
    expect(planilha).toEqual({
      ok: false,
      erro: 'COLUNAS',
      desconhecidas: ['cliente'],
      faltando: ['cpf_cnpj_tomador', 'nome_tomador', 'cnpj_prestador'],
      repetidas: [],
    })
    if (!planilha.ok && planilha.erro === 'COLUNAS') {
      const texto = textoDasColunas(planilha)
      expect(texto).toContain('cliente')
      expect(texto).toContain('cpf_cnpj_tomador, nome_tomador, cnpj_prestador')
      expect(texto).toContain(MODELO_DA_PLANILHA)
      expect(texto).toContain('nada foi gravado')
    }
  })

  it('cnpj_prestador é opcional com uma empresa ativa; linhas vazias e coluna vazia sem título não contam', () => {
    const grade: Celula[][] = [[], ['cpf_cnpj_tomador', 'nome_tomador', 'valor', null], [CPF, 'Maria', '10', null], [null, '', null], [CPF, 'João', '20', '']]
    const planilha = interpretarGrade(grade, { prestadorObrigatorio: false })
    expect(planilha.ok && planilha.linhas.map((l) => l.linha)).toEqual([3, 5])
  })

  it('mais de 1.000 linhas é recusado inteiro', () => {
    const grade: Celula[][] = [['cpf_cnpj_tomador', 'nome_tomador', 'valor'], ...Array.from({ length: 1001 }, () => [CPF, 'Maria', '10'])]
    expect(interpretarGrade(grade, { prestadorObrigatorio: false })).toEqual({ ok: false, erro: 'LINHAS_DEMAIS' })
  })
})

describe('valores das células', () => {
  it('valor: "1.234,56", "1234.56", número, "R$", milhar; o resto é inválido', () => {
    expect(lerValor('1.234,56')).toBe('1234.56')
    expect(lerValor('1234,5')).toBe('1234.50')
    expect(lerValor('1234.56')).toBe('1234.56')
    expect(lerValor('R$ 2.500,00')).toBe('2500.00')
    // "1.500" e "150.000" (um ponto e 3 casas, sem vírgula) são ambíguos; só valem como milhar se a coluna usa vírgula.
    expect(lerValor('1.500')).toBeNull()
    expect(lerValor('150.000')).toBeNull()
    expect(lerValor('150.000', { pontoEhMilhar: true })).toBe('150000.00')
    expect(lerValor('1.234.567')).toBe('1234567.00')
    expect(lerValor('1,234.56')).toBe('1234.56')
    expect(lerValor(59.3)).toBe('59.30')
    expect(lerValor(0.1 + 0.2)).toBe('0.30')
    expect(lerValor(150)).toBe('150.00')
    for (const invalido of ['0', '0,00', '-10', '10,555', 'dez reais', '', '1.2.3,4', 12.345]) expect(lerValor(invalido)).toBeNull()
    expect(lerValor(null)).toBeNull()
  })

  it('documento: com ou sem pontuação, com dígito verificador; número sem os zeros à esquerda é completado', () => {
    expect(lerDocumento('529.982.247-25')).toBe(CPF)
    expect(lerDocumento('11.444.777/0001-61')).toBe(CNPJ_TOMADOR)
    expect(lerDocumento(52998224725)).toBe(CPF)
    // CPF que começa com zero, digitado como número no Excel.
    expect(lerDocumento(Number('01234567890'))).toBe('01234567890')
    expect(lerDocumento('529.982.247-26')).toBeNull()
    expect(lerDocumento('111.111.111-11')).toBeNull()
    expect(lerDocumento('abc')).toBeNull()
  })

  it('célula numérica que pode ser CPF e CNPJ (perdeu os zeros) é DOCUMENTO_AMBIGUO; CNPJ sem zeros é completado', () => {
    // 001.234.567-97 é CPF válido, e 00.000.123/4567-97 também é CNPJ válido.
    expect(lerDocumentoDaCelula(123456797)).toEqual({ erro: 'DOCUMENTO_AMBIGUO' })
    expect(lerDocumentoDaCelula('123456797')).toEqual({ erro: 'DOCUMENTO_AMBIGUO' })
    // Formatado como texto, não há ambiguidade.
    expect(lerDocumentoDaCelula('001.234.567-97')).toEqual({ documento: '00123456797' })
    expect(lerDocumentoDaCelula(1234567000195)).toEqual({ documento: '01234567000195' })
    expect(lerDocumentoDaCelula(52998224725)).toEqual({ documento: CPF })
    expect(lerDocumentoDaCelula(123)).toEqual({ erro: 'DOCUMENTO_INVALIDO' })
  })
})

describe('linha com colunas a mais', () => {
  it('CSV com vírgula e "1234,56" sem aspas: a linha fica de fora com COLUNAS_A_MAIS, e não vira R$ 1.234,00', async () => {
    const csv = `cpf_cnpj_tomador,nome_tomador,valor\n${CPF},Maria,1234,56\n${CPF},Ana,"99,90"\n`
    const conteudo = utf8(csv)
    const planilha = interpretarGrade(await lerPlanilha(conteudo, 'csv'), {
      prestadorObrigatorio: false,
      contarCampos: separadorDoCsv(csv) === ',',
    })
    expect(planilha.ok && planilha.linhas.map((l) => [l.linha, Boolean(l.colunasAMais)])).toEqual([
      [2, true],
      [3, false],
    ])
    if (!planilha.ok) return
    const itens = validarLinhas(planilha.linhas, contexto({ empresas: [ESCRITORIO] }))
    expect(itens.map((i) => i.problema)).toEqual(['COLUNAS_A_MAIS', null])
    expect(itens[1].valor).toBe('99.90')
    expect(motivoDoProblema('COLUNAS_A_MAIS')).toBe('a linha tem mais colunas que o cabeçalho: confira se o valor usa vírgula sem aspas')
  })

  it('com a descrição depois do valor, o campo a mais aparece mesmo vazio', async () => {
    const csv = `cpf_cnpj_tomador,nome_tomador,valor,descricao\n${CPF},Maria,1234,56,\n`
    const planilha = interpretarGrade(await lerPlanilha(utf8(csv), 'csv'), { prestadorObrigatorio: false, contarCampos: true })
    expect(planilha.ok && planilha.linhas[0].colunasAMais).toBe(true)
  })

  it('xlsx (e CSV com ;): só conta célula preenchida além do cabeçalho', () => {
    const grade: Celula[][] = [
      ['cpf_cnpj_tomador', 'nome_tomador', 'valor'],
      [CPF, 'Maria', 10, null, ''],
      [CPF, 'Ana', 20, null, 'sobra'],
    ]
    const planilha = interpretarGrade(grade, { prestadorObrigatorio: false })
    expect(planilha.ok && planilha.linhas.map((l) => Boolean(l.colunasAMais))).toEqual([false, true])
  })

  it('"150.000" é inválido numa coluna sem vírgula decimal, e milhar quando outra linha usa vírgula', () => {
    const linhas = (valores: string[]) => valores.map((valor, i) => ({ linha: i + 2, celulas: { cpf_cnpj_tomador: CPF, nome_tomador: `P${i}`, valor } }))
    const sem = validarLinhas(linhas(['150.000', '20.00']), contexto({ empresas: [ESCRITORIO] }))
    expect(sem.map((i) => i.problema)).toEqual(['VALOR_INVALIDO', null])
    const com = validarLinhas(linhas(['150.000', '1.234,56']), contexto({ empresas: [ESCRITORIO] }))
    expect(com.map((i) => [i.problema, i.valor])).toEqual([
      [null, '150000.00'],
      [null, '1234.56'],
    ])
  })
})

describe('códigos de problema por linha', () => {
  const linha = (n: number, celulas: Record<string, Celula>) => ({ linha: n, celulas })

  it('cada código, na ordem; o resto segue pronto', () => {
    const ctx = contexto({
      bloqueios: new Map([
        ['e1', null],
        ['e2', 'CERT_MISSING'],
      ]),
      jaEmitidas: new Set([`e1:${CNPJ_TOMADOR}:99000`]),
    })
    const itens = validarLinhas(
      [
        linha(2, { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '100,00' }),
        linha(3, { cnpj_prestador: '99999999000191', cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '100' }),
        linha(4, { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: '123', nome_tomador: 'Maria', valor: '100' }),
        linha(5, { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: CPF, nome_tomador: '  ', valor: '100' }),
        linha(6, { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: 'cem' }),
        linha(7, { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '100', email_tomador: 'maria@' }),
        linha(8, { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '100.00' }),
        linha(9, { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: CNPJ_TOMADOR, nome_tomador: 'Padaria', valor: '990,00' }),
        linha(10, { cnpj_prestador: '11.222.333/0001-81', cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '50' }),
        linha(11, { cnpj_prestador: '', cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '50' }),
        linha(12, { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '50', descricao: 'x'.repeat(2001) }),
      ],
      ctx,
    )
    expect(itens.map((i) => [i.linha, i.problema])).toEqual([
      [2, null],
      [3, 'PRESTADOR_DESCONHECIDO'],
      [4, 'DOCUMENTO_INVALIDO'],
      [5, 'NOME_FALTANDO'],
      [6, 'VALOR_INVALIDO'],
      [7, 'EMAIL_INVALIDO'],
      [8, 'LINHA_REPETIDA'],
      [9, 'JA_EMITIDA_NO_MES'],
      [10, 'CERT_MISSING'],
      [11, 'PRESTADOR_DESCONHECIDO'],
      [12, 'DESCRICAO_LONGA'],
    ])
    expect(itens[6].igualA).toBe(2)
    // Linha pronta: o payload do motor, com o código da empresa e a descrição padrão.
    expect(itens[0].payload).toEqual({
      tomador: { cpf: CPF, nome: 'Maria' },
      servico: { codigo_servico_nacional: '171901', descricao: 'Prestação de serviços' },
      valor: '100.00',
    })
    expect(itens[0].tenantId).toBe('e1')
    // Linha que não chegou a ser lida guarda o que veio na planilha.
    expect(itens[2].payload).toEqual({ lido: { cnpj_prestador: '12345678000195', cpf_cnpj_tomador: '123', nome_tomador: 'Maria', valor: '100' } })
  })

  it('sem cnpj_prestador, a única empresa ativa emite; modelo do tomador dá código, descrição e e-mail', () => {
    const ctx = contexto({
      empresas: [ESCRITORIO, { ...CLIENTE, active: false }],
      modelos: new Map([[`e1:${CPF}`, { codigo: '171902', descricao: 'Honorários mensais', email: 'maria@cliente.test' }]]),
    })
    const [comModelo, descricaoDaPlanilha] = validarLinhas(
      [
        linha(2, { cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '300' }),
        linha(3, { cpf_cnpj_tomador: CNPJ_TOMADOR, nome_tomador: 'Padaria', valor: '300', descricao: 'Consultoria de novembro', email_tomador: 'FIN@Padaria.test' }),
      ],
      ctx,
    )
    expect(comModelo.payload).toEqual({
      tomador: { cpf: CPF, nome: 'Maria', email: 'maria@cliente.test' },
      servico: { codigo_servico_nacional: '171902', descricao: 'Honorários mensais' },
      valor: '300.00',
    })
    expect(descricaoDaPlanilha.payload).toEqual({
      tomador: { cnpj: CNPJ_TOMADOR, nome: 'Padaria', email: 'fin@padaria.test' },
      servico: { codigo_servico_nacional: '171901', descricao: 'Consultoria de novembro' },
      valor: '300.00',
    })
  })

  it('resumo: prontas e total, empresas, até 15 problemas com motivo, franquia e o confirmar', () => {
    const linhas = [
      ...Array.from({ length: 3 }, (_, i) => linha(i + 2, { cnpj_prestador: ESCRITORIO.cnpj, cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: `${i + 1}00` })),
      linha(5, { cnpj_prestador: CLIENTE.cnpj, cpf_cnpj_tomador: CNPJ_TOMADOR, nome_tomador: 'Padaria', valor: '1.000,50' }),
      ...Array.from({ length: 17 }, (_, i) => linha(i + 6, { cnpj_prestador: ESCRITORIO.cnpj, cpf_cnpj_tomador: '1', nome_tomador: 'X', valor: '1' })),
    ]
    const itens = validarLinhas(linhas, contexto())
    const texto = textoDoResumoDoLote({ arquivo: 'novembro.xlsx', itens, empresas: [ESCRITORIO, CLIENTE], franquia: { limite: 500, noMes: 498 } })
    expect(texto).toContain('Li a planilha novembro.xlsx: 21 linhas.')
    expect(texto).toContain('Prontas para emitir: 4, total R$ 1.600,50.')
    expect(texto).toContain('Empresas: Escritório Toledo (3 notas), Padaria Cliente (1 nota).')
    expect(texto).toContain('Com problema (ficam de fora): 17 linhas.')
    expect(texto).toContain('- Linha 6: CPF ou CNPJ do tomador inválido')
    expect(texto.match(/^- Linha /gm)).toHaveLength(15)
    expect(texto).toContain('- e mais 2 linhas com problema.')
    expect(texto).toContain('o mês chega a 502 notas, 2 acima das 500 do seu plano. As notas saem normalmente.')
    expect(texto.split('\n').at(-1)).toBe('Responda *confirmar* para emitir as 4 notas prontas, ou *cancelar* para descartar. Vale por 24 horas.')
  })

  it('bloqueio da empresa nomeia a empresa no resumo', () => {
    const itens = validarLinhas(
      [linha(2, { cnpj_prestador: CLIENTE.cnpj, cpf_cnpj_tomador: CPF, nome_tomador: 'Maria', valor: '10' })],
      contexto({ bloqueios: new Map([['e2', 'CERT_EXPIRED']]) }),
    )
    const texto = textoDoResumoDoLote({ arquivo: null, itens, empresas: [ESCRITORIO, CLIENTE], franquia: null })
    expect(texto).toContain('- Linha 2: o certificado A1 de Padaria Cliente venceu')
    expect(texto).toContain('Nenhuma linha está pronta para emitir.')
    expect(texto).not.toContain('*confirmar*')
  })
})

describe('retorno do lote', () => {
  const base = { tenant_id: 'e1', razao_social: 'Escritório Toledo', cnpj: ESCRITORIO.cnpj, dps_numero: null, xml_nfse: null, chave_acesso: null, last_error_code: null, last_error: null }
  const nota = (valor: string, nome = 'Maria', documento = CPF) => ({
    tomador: { [documento.length === 11 ? 'cpf' : 'cnpj']: documento, nome },
    servico: { codigo_servico_nacional: '171901', descricao: 'x' },
    valor,
  })
  const itens: ItemDoRetorno[] = [
    { ...base, linha: 2, problema: null, payload: nota('1500.00'), invoice_id: 'i1', status: 'issued', dps_numero: '7', xml_nfse: '<NFSe/>', chave_acesso: 'CHAVE1' },
    { ...base, linha: 3, problema: null, payload: nota('20.00', '=HYPERLINK("x")', CNPJ_TOMADOR), invoice_id: 'i2', status: 'rejected', last_error_code: 'E0310', last_error: 'CPF; não encontrado' },
    { ...base, linha: 4, problema: 'DOCUMENTO_INVALIDO', payload: { lido: { cpf_cnpj_tomador: '123', nome_tomador: 'João', valor: '10' } }, invoice_id: null, status: null },
    { ...base, linha: 5, problema: 'LINHA_REPETIDA', payload: nota('1500.00'), invoice_id: null, status: null },
    { ...base, linha: 6, problema: 'PRESTADOR_DESCONHECIDO', tenant_id: null, razao_social: null, cnpj: null, payload: { lido: { cnpj_prestador: '', nome_tomador: 'Ana', valor: '5' } }, invoice_id: null, status: null },
  ]

  it('CSV: UTF-8 com BOM, separador ;, uma linha por linha da planilha, com situação e motivo', () => {
    const csv = retornoCsv(itens)
    expect(csv.startsWith('\uFEFFlinha;prestador;tomador;valor;situação;número;chave;motivo\r\n')).toBe(true)
    const linhas = csv.slice(1).trim().split('\r\n')
    expect(linhas).toHaveLength(6)
    expect(linhas[1]).toBe('2;Escritório Toledo (12.345.678/0001-95);Maria (529.982.247-25);1.500,00;emitida;7;CHAVE1;')
    // Texto que o Excel leria como fórmula vai neutralizado; ; e aspas vão entre aspas.
    expect(linhas[2]).toBe(
      '3;Escritório Toledo (12.345.678/0001-95);"\'=HYPERLINK(""x"") (11.444.777/0001-61)";20,00;recusada pela Sefin;;;"E0310: CPF; não encontrado"',
    )
    expect(linhas[3]).toBe('4;Escritório Toledo (12.345.678/0001-95);João 123;10,00;não emitida;;;CPF ou CNPJ do tomador inválido')
    expect(linhas[4]).toContain('igual à linha 2 (mesmo prestador, tomador e valor)')
    expect(linhas[5]).toBe('6;;Ana;5,00;não emitida;;;falta o CNPJ do prestador (a conta tem mais de uma empresa ativa)')
    expect(contagemDoRetorno(itens)).toEqual({ emitidas: 1, recusadas: 1, naFila: 0, naoEmitidas: 3, valorEmitido: '1500.00' })
  })

  it('texto do retorno: com o .zip anexo cita o arquivo; sem ele, manda para Minha conta → Relatórios', () => {
    const lote = { created_at: new Date('2026-11-05T15:00:00Z'), arquivo_nome: 'novembro.xlsx' }
    const c = contagemDoRetorno(itens)
    const relatorios = 'https://www.notechstack.com.br/agentes/fiscal/conta/#relatorios'
    const comZip = textoDoRetorno(lote, c, { csv: 'retorno-2026-11-05.csv', zip: 'notas-2026-11-05.zip' }, relatorios)
    expect(comZip).toContain('Planilha de 05/11/2026 (novembro.xlsx) concluída: 1 nota emitida, 1 recusada pela Sefin e 3 linhas não emitidas.')
    expect(comZip).toContain('os PDFs e XMLs em notas-2026-11-05.zip')
    const semZip = textoDoRetorno(lote, c, { csv: 'retorno-2026-11-05.csv', zip: null }, relatorios)
    expect(semZip).not.toContain('.zip')
    expect(semZip).toContain(`Os PDFs ficam em Minha conta → Relatórios: ${relatorios}`)
    // Lote fechado por prazo, com nota parada na fila.
    const naFila = contagemDoRetorno([...itens, { ...itens[0], linha: 7, status: 'queued', invoice_id: 'i9' }])
    expect(textoDoRetorno(lote, naFila, { csv: 'r.csv', zip: null }, relatorios)).toContain('1 ainda na fila')
    expect(retornoCsv([{ ...itens[0], status: 'queued', dps_numero: null, chave_acesso: null }])).toContain(';na fila;;;')
  })

  it('aviso do retorno no WhatsApp: só texto, para onde o retorno foi e o comando *nota*', () => {
    const lote = { created_at: new Date('2026-11-05T15:00:00Z') }
    const relatorios = 'https://site.test/agentes/fiscal/conta/#relatorios'
    const c = contagemDoRetorno([...itens, { ...itens[0], linha: 7, status: 'queued', invoice_id: 'i9' }])
    expect(avisoDoRetorno(lote, c, { email: 'sandra@escritorio.test', pdfsNoEmail: true }, relatorios)).toBe(
      [
        'Planilha de 05/11/2026: 1 nota emitida (R$ 1.500,00), 1 recusada, 1 ainda na fila e 3 linhas não emitidas.',
        `O retorno (CSV) e os PDFs foram para sandra@escritorio.test. Tudo também em Minha conta → Relatórios: ${relatorios}`,
        'Para ver uma nota aqui, escreva *nota* e o número ou o nome do cliente (ex.: nota 123, nota Maria Silva).',
      ].join('\n'),
    )
    // .zip acima do limite do e-mail: o aviso manda os PDFs para Relatórios.
    expect(avisoDoRetorno(lote, c, { email: 'sandra@escritorio.test', pdfsNoEmail: false }, relatorios)).toContain(
      `O retorno (CSV) foi para sandra@escritorio.test; os PDFs estão em Minha conta → Relatórios: ${relatorios}`,
    )
  })

  it('.zip: PDF e XML de cada nota emitida, numa pasta por CNPJ do prestador', async () => {
    const zip = await zipDasNotas(itens, async () => utf8('%PDF-1.7 teste'))
    expect(zip).not.toBeNull()
    const arquivos = unzipSync(zip as Uint8Array)
    expect(Object.keys(arquivos).sort()).toEqual([`${ESCRITORIO.cnpj}/nfse-7.pdf`, `${ESCRITORIO.cnpj}/nfse-7.xml`])
    expect(strFromU8(arquivos[`${ESCRITORIO.cnpj}/nfse-7.xml`])).toBe('<NFSe/>')
    expect(await zipDasNotas(itens.slice(1))).toBeNull()
  })
})
