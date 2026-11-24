# Gera agentes/fiscal/dados/modelo-emissao.xlsx: o "modelo de emissão" que o Lucca e o agente mandam a quem pergunta
# qual planilha funciona. Mesmas colunas e os mesmos dois exemplos de modelo-lote.csv/.xlsx; a diferença é a
# apresentação (colunas de documento como texto, valor como número, larguras) e a aba "Como preencher".
# O agente lê só a primeira aba (lote.ts, lerXlsx): a segunda nunca vira nota.
# Gera também app/api/_lib/agente/modelo-emissao-arquivo.ts (o mesmo arquivo em base64): é a cópia que o agente manda
# no WhatsApp, porque a função da Vercel (raiz `app`) não enxerga `agentes/`. lote.test.ts confere que as duas batem.
# Uso: python -X utf8 scripts/nofiscal-modelo-emissao/gerar.py   (na raiz do repo; precisa de openpyxl)
import base64
import datetime
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

RAIZ = Path(__file__).resolve().parents[2]
SAIDA = RAIZ / 'agentes' / 'fiscal' / 'dados' / 'modelo-emissao.xlsx'
MODULO = RAIZ / 'app' / 'api' / '_lib' / 'agente' / 'modelo-emissao-arquivo.ts'

TINTA = '141414'
OSSO = 'FAFAF7'
AMBAR = 'EDA33B'
CINZA = '6B6B66'
LINHAS_FORMATADAS = 200  # linhas já prontas para digitar (o limite do agente é 1.000 notas por planilha)

# iss_retido e inss_retido (16/11/2026) são opcionais: em branco, vale a retenção cadastrada na empresa.
# codigo_servico (17/11/2026) também: em branco, vale o código do cliente salvo ou o padrão da empresa.
# municipio_prestacao (18/11/2026) também: em branco, vale a cidade da empresa.
# obra_* (19/11/2026): obrigatórias só nos códigos de construção civil (E0370).
# tomador_* (24/11/2026, Robson, Bragantina): endereço de quem recebe a nota. Em branco, a nota de CNPJ sai com o endereço
# da Receita; a de CPF, sem endereço. Preenchido, vale o da planilha.
COLUNAS = [
    'cnpj_prestador', 'cpf_cnpj_tomador', 'nome_tomador', 'email_tomador',
    'tomador_cep', 'tomador_logradouro', 'tomador_numero', 'tomador_complemento', 'tomador_bairro', 'tomador_municipio_ibge',
    'valor', 'descricao', 'iss_retido', 'inss_retido', 'codigo_servico', 'municipio_prestacao',
    'obra_cep', 'obra_logradouro', 'obra_numero', 'obra_complemento', 'obra_bairro', 'obra_cno',
]
LARGURAS = [24, 24, 34, 36, 14, 30, 14, 20, 22, 26, 14, 46, 14, 14, 16, 24, 14, 30, 14, 20, 22, 18]
COLUNA_VALOR = COLUNAS.index('valor') + 1
EXEMPLOS = [
    # CNPJ sem as colunas tomador_*: o endereço vem da Receita.
    ['12.345.678/0001-95', '11.222.333/0001-81', 'Padaria Exemplo Ltda', 'financeiro@padaria-exemplo.com.br',
     None, None, None, None, None, None,
     1500, 'Honorários contábeis - novembro/2026', None, None, '17.19.01', 'Campinas/SP'],
    # CPF com endereço: sai na nota.
    ['12.345.678/0001-95', '529.982.247-25', 'Maria Exemplo da Silva', 'maria@exemplo.com.br',
     '12900-000', 'Rua das Flores', '120', 'Apto 12', 'Centro', 'Bragança Paulista/SP',
     350, None],
]

fino = Side(style='thin', color='D9D9D4')
borda = Border(left=fino, right=fino, top=fino, bottom=fino)

wb = Workbook()
ws = wb.active
ws.title = 'Notas'
ws.sheet_properties.tabColor = AMBAR
for i, (nome, larg) in enumerate(zip(COLUNAS, LARGURAS), start=1):
    c = ws.cell(row=1, column=i, value=nome)
    c.font = Font(name='Calibri', bold=True, color='FFFFFF', size=11)
    c.fill = PatternFill('solid', fgColor=TINTA)
    c.alignment = Alignment(vertical='center')
    c.border = borda
    ws.column_dimensions[c.column_letter].width = larg
ws.row_dimensions[1].height = 22
for r in range(2, 2 + LINHAS_FORMATADAS):
    for i in range(1, len(COLUNAS) + 1):
        c = ws.cell(row=r, column=i)
        c.border = borda
        c.font = Font(name='Calibri', size=11)
        c.number_format = '#,##0.00' if i == COLUNA_VALOR else '@'  # documento, nome, e-mail e descrição como texto: o zero à esquerda fica
for r, linha in enumerate(EXEMPLOS, start=2):
    for i, v in enumerate(linha, start=1):
        if v is not None:
            ws.cell(row=r, column=i, value=v)
ws.freeze_panes = 'A2'

guia = wb.create_sheet('Como preencher')
guia.column_dimensions['A'].width = 22
guia.column_dimensions['B'].width = 16
guia.column_dimensions['C'].width = 78
guia.column_dimensions['D'].width = 38


def titulo(linha, texto):
    c = guia.cell(row=linha, column=1, value=texto)
    c.font = Font(name='Calibri', bold=True, size=14, color=TINTA)


def cabecalho(linha, textos):
    for i, t in enumerate(textos, start=1):
        c = guia.cell(row=linha, column=i, value=t)
        c.font = Font(name='Calibri', bold=True, color='FFFFFF')
        c.fill = PatternFill('solid', fgColor=TINTA)
        c.border = borda


def linha_tabela(linha, textos):
    for i, t in enumerate(textos, start=1):
        c = guia.cell(row=linha, column=i, value=t)
        c.alignment = Alignment(wrap_text=True, vertical='top')
        c.border = borda
        if i == 1:
            c.font = Font(name='Consolas', bold=True)


titulo(1, 'nó.fiscal · modelo de emissão por planilha')
guia.cell(row=2, column=1, value='Preencha a aba "Notas", uma linha por nota, e mande o arquivo no WhatsApp do nó.fiscal ou em Minha conta → Emitir.').font = Font(name='Calibri', color=CINZA)

titulo(4, 'As colunas')
cabecalho(5, ['coluna', 'obrigatória?', 'o que colocar', 'exemplo'])
tabela = [
    ['cnpj_prestador', 'sim*', 'CNPJ da empresa que emite a nota: o escritório ou uma empresa cliente cadastrada em Minhas empresas, com a situação Pronta.', '12.345.678/0001-95'],
    ['cpf_cnpj_tomador', 'sim', 'CPF ou CNPJ de quem recebe a nota (o tomador), com ou sem pontuação.', '529.982.247-25'],
    ['nome_tomador', 'sim', 'Nome ou razão social de quem recebe a nota.', 'Maria Exemplo da Silva'],
    ['email_tomador', 'não', 'E-mail de quem recebe a nota. Com e-mail, o tomador recebe a nota por e-mail.', 'maria@exemplo.com.br'],
    ['tomador_cep', 'não**', 'CEP do endereço de quem recebe a nota (8 dígitos, com ou sem traço).', '12900-000'],
    ['tomador_logradouro', 'não**', 'Rua, avenida etc. do endereço de quem recebe a nota.', 'Rua das Flores'],
    ['tomador_numero', 'não', 'Número do endereço. Em branco, sai S/N.', '120'],
    ['tomador_complemento', 'não', 'Complemento do endereço (sala, apto, bloco).', 'Apto 12'],
    ['tomador_bairro', 'não**', 'Bairro do endereço de quem recebe a nota.', 'Centro'],
    ['tomador_municipio_ibge', 'não**', 'Cidade do endereço: o nome com a UF (Bragança Paulista/SP) ou o código IBGE de 7 dígitos (3507605). Também aceita o nome de coluna tomador_municipio.', 'Bragança Paulista/SP'],
    ['valor', 'sim', 'Valor da nota em reais, com até 2 casas. Pode ser número (1500) ou texto (1.500,00).', '1.500,00'],
    ['descricao', 'não', 'O texto que vai na descrição do serviço da nota. Em branco, vale a descrição já guardada para esse cliente ou "Prestação de serviços".', 'Honorários contábeis - novembro/2026'],
    ['iss_retido', 'não', 'ISS retido pelo tomador: a alíquota (de 2% a 5%), sim (usa a alíquota cadastrada na empresa) ou não. Só para tomador com CNPJ; MEI não tem retenção. Em branco, vale o cadastro da empresa.', '2%'],
    ['inss_retido', 'não', 'INSS retido: o percentual (11%), o valor em reais (165,00), sim (usa o percentual cadastrado na empresa) ou não. MEI não tem retenção. Em branco, vale o cadastro da empresa.', '11%'],
    ['codigo_servico', 'não', 'Código do serviço desta nota na lista nacional (6 dígitos, com ou sem pontos). Use quando a mesma empresa presta serviços diferentes (clínica com psicologia, fisioterapia e nutrição). Em branco, vale o código já usado para esse cliente ou o padrão da empresa.', '04.16.01'],
    ['municipio_prestacao', 'não', 'Cidade onde o serviço foi prestado, quando não é a cidade da empresa: o nome com a UF (Campinas/SP) ou o código IBGE de 7 dígitos (3509502). Em branco, vale a cidade da empresa. Também aceita o nome de coluna ibge_prestacao.', 'Campinas/SP'],
    ['obra_cep, obra_logradouro, obra_numero, obra_complemento, obra_bairro', 'só em obra', 'Endereço da obra. Obrigatório nos códigos de construção civil (07.02, 07.04 a 07.08, 07.17, 07.19, 14.14.03/04): a Sefin exige o endereço ou o CNO. Nos outros códigos, fica em branco.', 'Rua das Palmeiras, 50'],
    ['obra_cno', 'só em obra', 'CNO (ou CEI) da obra, 12 dígitos. Vale no lugar do endereço da obra.', '12.345.67890/12'],
]
for k, linha in enumerate(tabela):
    linha_tabela(6 + k, linha)
    guia.row_dimensions[6 + k].height = 34
NOTA = 6 + len(tabela)
guia.cell(row=NOTA, column=1, value='* cnpj_prestador pode ficar em branco só quando a conta tem uma única empresa ativa.').font = Font(name='Calibri', italic=True, color=CINZA)
guia.cell(row=NOTA + 1, column=1, value='** Endereço do tomador: deixe todas as colunas tomador_* em branco, ou preencha ao menos CEP, rua, bairro e cidade. Tomador com CNPJ e colunas em branco: vai o endereço da Receita.').font = Font(name='Calibri', italic=True, color=CINZA)

REGRAS = NOTA + 3
titulo(REGRAS, 'Regras')
regras = [
    'Uma linha por nota. Para emitir uma nota só, a planilha tem uma linha só.',
    'Não mude o nome das colunas e não crie colunas novas: a planilha inteira é recusada.',
    'Apague as duas linhas de exemplo antes de mandar.',
    'Até 1.000 notas por planilha. Salve em .xlsx ou .csv.',
    'CPF e CNPJ ficam como texto, para o zero à esquerda não sumir (as colunas deste modelo já estão assim).',
    'Linha com problema fica de fora e o motivo vem no resumo; as outras seguem.',
    'Retenção: o contador informa a alíquota e o percentual; o nó.fiscal não calcula regra tributária, só confere o que a Sefin recusa.',
    'Endereço do tomador: toda nota de tomador com CNPJ sai com o endereço da Receita; se você preencher as colunas tomador_*, vale o da planilha. Tomador com CPF só sai com endereço se você preencher. Se a Receita não responder na hora, a nota sai sem o endereço e o resumo avisa (com ISS retido, a linha fica de fora, porque a Sefin exige o endereço).',
    'Local da prestação: em obras, eventos e outros serviços da LC 116 (art. 3º), o ISS é devido na cidade da prestação; quem decide é a Sefin, pelo código de serviço. Serviços de eventos (item 12) com outra cidade ficam de fora, porque exigem dados do evento que o nó.fiscal ainda não envia.',
    'Código de serviço fora da lista nacional (https://www.notechstack.com.br/agentes/fiscal/dados/codigos-servico.json) deixa a linha de fora.',
    'Depois de mandar, você recebe o resumo. Nada é emitido antes de você responder confirmar. O resumo vale por 24 horas.',
    'No fim, o retorno de cada linha e os PDFs vão para o e-mail da conta e ficam em Minha conta → Relatórios.',
]
for k, r in enumerate(regras):
    c = guia.cell(row=REGRAS + 1 + k, column=1, value=f'{k + 1}. {r}')
    c.font = Font(name='Calibri', size=11)
guia.sheet_view.showGridLines = False

wb.properties.creator = 'nó.fiscal'
wb.properties.title = 'Modelo de emissão por planilha'
wb.properties.created = wb.properties.modified = datetime.datetime(2026, 11, 24, 12, 0, 0)
SAIDA.parent.mkdir(parents=True, exist_ok=True)
wb.save(SAIDA)
print(SAIDA, SAIDA.stat().st_size, 'bytes')

b64 = base64.b64encode(SAIDA.read_bytes()).decode('ascii')
linhas = [b64[i:i + 120] for i in range(0, len(b64), 120)]
NL = chr(10)
texto = NL.join([
    '// GERADO por scripts/nofiscal-modelo-emissao/gerar.py: não edite à mão.',
    '// agentes/fiscal/dados/modelo-emissao.xlsx em base64, para o agente mandar o arquivo no WhatsApp.',
    'export const MODELO_EMISSAO_BASE64 =',
    (' +' + NL).join(f"  '{l}'" for l in linhas),
    '',
])
MODULO.write_bytes(texto.encode('utf-8'))
print(MODULO, len(b64), 'caracteres')
