import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const raiz = new URL('../../', import.meta.url)
const ler = async (caminho) => JSON.parse(await readFile(new URL(caminho, raiz), 'utf8'))
const relatorio = 'C:/Users/lucca/projetos/.design/agente-fiscal-v2-pesquisas.md'

function metadados(dados, campo, aceitaSemFonte = false) {
  assert.deepEqual(Object.keys(dados).sort(), ['fonte', 'consultado_em', campo].sort())
  assert.match(dados.consultado_em, /^\d{4}-\d{2}-\d{2}$/)
  const data = new Date(`${dados.consultado_em}T00:00:00Z`)
  assert.ok(Number.isFinite(data.getTime()))
  assert.equal(data.toISOString().slice(0, 10), dados.consultado_em)
  assert.ok(data.getTime() <= Date.now(), 'data de consulta não pode estar no futuro')
  if (aceitaSemFonte && dados.fonte === null) return
  const fonte = new URL(dados.fonte)
  assert.equal(fonte.protocol, 'https:')
  assert.ok(fonte.hostname === 'gov.br' || fonte.hostname.endsWith('.gov.br'), 'fonte oficial')
}

function listaCodigos(codigos, tamanho) {
  assert.ok(Array.isArray(codigos))
  for (const codigo of codigos) {
    assert.equal(typeof codigo, 'string', 'preservar zeros à esquerda')
    assert.match(codigo, new RegExp(`^\\d{${tamanho}}$`))
  }
  assert.equal(new Set(codigos).size, codigos.length, 'sem duplicatas')
}

test('municípios', async () => {
  const dados = await ler('supabase/functions/_shared/fiscal/municipios-padrao-nacional.json')
  metadados(dados, 'codigos_ibge', true)
  listaCodigos(dados.codigos_ibge, 7)
  if (dados.fonte === null) {
    assert.deepEqual(dados.codigos_ibge, [])
    return
  }
  assert.ok(dados.codigos_ibge.length > 0, 'fonte utilizável deve produzir dados')
  assert.deepEqual(dados.codigos_ibge, [...dados.codigos_ibge].sort())
  if (dados.fonte.endsWith('/municipios-aderentes-20260928.xlsx')) {
    // Censo da coluna G=Sim e E=Conveniado Ativo na planilha oficial de 28/09.
    assert.equal(dados.codigos_ibge.length, 2875, 'não publicar extração parcial')
    assert.ok(!dados.codigos_ibge.includes('5300108'), 'Brasília: conveniada, mas G=Não')
    for (const codigo of ['5203500', '2919058', '2400208', '2405306', '1720499',
      '3105509', '3122900', '3550001', '4116307', '2802601']) {
      assert.ok(dados.codigos_ibge.includes(codigo), `preservar município com grafia divergente: ${codigo}`)
    }
  }
})

test('códigos de serviço', async () => {
  const dados = await ler('agentes/fiscal/dados/codigos-servico.json')
  metadados(dados, 'itens')
  assert.ok(Array.isArray(dados.itens) && dados.itens.length > 0)
  listaCodigos(dados.itens.map((item) => item.codigo), 6)
  for (const item of dados.itens) {
    assert.deepEqual(Object.keys(item).sort(), ['codigo', 'descricao'])
    assert.equal(typeof item.descricao, 'string')
    assert.ok(item.descricao.trim().length > 0)
    assert.ok(!item.descricao.includes('\uFFFD'), 'descrição UTF-8 íntegra')
  }
  if (dados.fonte.endsWith('/anexo_b-nbs2-lista_servico_nacional-snnfse-v1-01-20260122.xlsx')) {
    assert.equal(dados.itens.length, 338, 'todas as linhas com cTribNac do Anexo B')
    assert.equal(dados.itens.find((item) => item.codigo === '040101')?.descricao, 'Medicina.')
    assert.equal(dados.itens.find((item) => item.codigo === '010101')?.descricao, 'Análise e desenvolvimento de sistemas.')
    assert.ok(!dados.itens.some((item) => item.codigo.endsWith('00')), 'não incluir cabeçalhos de item/subitem')
  }
})

test('cnae aponta para códigos existentes', async () => {
  const dados = await ler('agentes/fiscal/dados/cnae-servico.json')
  const servicos = await ler('agentes/fiscal/dados/codigos-servico.json')
  metadados(dados, 'cnae', true)
  assert.ok(dados.cnae !== null && typeof dados.cnae === 'object' && !Array.isArray(dados.cnae))
  if (dados.fonte === null) assert.deepEqual(dados.cnae, {}, 'sem inferências disfarçadas de fonte oficial')
  else assert.ok(Object.keys(dados.cnae).length > 0)
  const existentes = new Set(servicos.itens.map((item) => item.codigo))
  for (const [cnae, codigos] of Object.entries(dados.cnae)) {
    assert.match(cnae, /^\d{7}$/)
    listaCodigos(codigos, 6)
    assert.ok(codigos.length > 0)
    for (const codigo of codigos) assert.ok(existentes.has(codigo), `${cnae} aponta para ${codigo} inexistente`)
  }
})

test('pesquisas respondem as 5 perguntas', async () => {
  // P4 exige a cópia externa; não substituir silenciosamente pela versão do repositório.
  const texto = await readFile(relatorio, 'utf8')
  const secoes = [...texto.matchAll(/^## \(([a-e])\) ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
  assert.deepEqual(secoes.map((secao) => secao[1]), ['a', 'b', 'c', 'd', 'e'])
  const assuntos = [
    [/DPS/, /49999/, /numera/i],
    [/ADN/, /contribuintes/, /mTLS/, /NSU/, /[Gg][Zz]ip/, /limite/i],
    [/Pagar\.me/, /subscriptions/, /cartão/, /itens/, /cancel/i, /appId/, /tokens/],
    [/GoTrue/, /\/auth\/v1\/verify/, /email_otp/, /magiclink/, /email/, /refresh_token/],
    [/BrasilAPI/, /\/api\/cnpj\/v1/, /razao_social/, /municipio/, /codigo_municipio_ibge/, /cnae_fiscal/, /limite/i],
  ]
  for (const [indice, secao] of secoes.entries()) {
    const conteudo = secao[2] + '\n' + secao[3]
    assert.match(conteudo, /https:\/\/[^\s)>]+/, `fonte na seção ${secao[1]}`)
    assert.match(conteudo, /^> .+/m, `trecho citado na seção ${secao[1]}`)
    for (const assunto of assuntos[indice]) assert.match(conteudo, assunto)
  }
  const copiaVersionada = await readFile(new URL('./pesquisas.md', import.meta.url), 'utf8')
  assert.equal(texto.replaceAll('\r\n', '\n'), copiaVersionada.replaceAll('\r\n', '\n'),
    'relatório externo deve corresponder ao entregue no commit')
})
