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

COLUNAS = ['cnpj_prestador', 'cpf_cnpj_tomador', 'nome_tomador', 'email_tomador', 'valor', 'descricao']
LARGURAS = [24, 24, 34, 36, 14, 46]
EXEMPLOS = [
    ['12.345.678/0001-95', '11.222.333/0001-81', 'Padaria Exemplo Ltda', 'financeiro@padaria-exemplo.com.br', 1500, 'Honorários contábeis - novembro/2026'],
    ['12.345.678/0001-95', '529.982.247-25', 'Maria Exemplo da Silva', 'maria@exemplo.com.br', 350, None],
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
        c.number_format = '#,##0.00' if i == 5 else '@'  # documento, nome, e-mail e descrição como texto: o zero à esquerda fica
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
    ['valor', 'sim', 'Valor da nota em reais, com até 2 casas. Pode ser número (1500) ou texto (1.500,00).', '1.500,00'],
    ['descricao', 'não', 'O texto que vai na descrição do serviço da nota. Em branco, vale a descrição já guardada para esse cliente ou "Prestação de serviços".', 'Honorários contábeis - novembro/2026'],
]
for k, linha in enumerate(tabela):
    linha_tabela(6 + k, linha)
    guia.row_dimensions[6 + k].height = 34
guia.cell(row=12, column=1, value='* cnpj_prestador pode ficar em branco só quando a conta tem uma única empresa ativa.').font = Font(name='Calibri', italic=True, color=CINZA)

titulo(14, 'Regras')
regras = [
    'Uma linha por nota. Para emitir uma nota só, a planilha tem uma linha só.',
    'Não mude o nome das colunas e não crie colunas novas: a planilha inteira é recusada.',
    'Apague as duas linhas de exemplo antes de mandar.',
    'Até 1.000 notas por planilha. Salve em .xlsx ou .csv.',
    'CPF e CNPJ ficam como texto, para o zero à esquerda não sumir (as colunas deste modelo já estão assim).',
    'Linha com problema fica de fora e o motivo vem no resumo; as outras seguem.',
    'Depois de mandar, você recebe o resumo. Nada é emitido antes de você responder confirmar. O resumo vale por 24 horas.',
    'No fim, o retorno de cada linha e os PDFs vão para o e-mail da conta e ficam em Minha conta → Relatórios.',
]
for k, r in enumerate(regras):
    c = guia.cell(row=15 + k, column=1, value=f'{k + 1}. {r}')
    c.font = Font(name='Calibri', size=11)
guia.sheet_view.showGridLines = False

wb.properties.creator = 'nó.fiscal'
wb.properties.title = 'Modelo de emissão por planilha'
wb.properties.created = wb.properties.modified = datetime.datetime(2026, 11, 16, 12, 0, 0)
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
