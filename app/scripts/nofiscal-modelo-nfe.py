# Gera o modelo da planilha de NF-e publicado em /agentes/fiscal/dados/ (modelo-nfe.xlsx e modelo-nfe.csv) a partir
# das mesmas linhas. Rodar da raiz do repositório:  python app/scripts/nofiscal-modelo-nfe.py [cópia.xlsx]
# Os dados são fictícios (CNPJ/CPF com dígito verificador válido). O teste painel-nfe.test.ts lê os dois arquivos com o
# leitor de produção e confere as notas.
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

DADOS = Path(__file__).resolve().parents[2] / 'agentes' / 'fiscal' / 'dados'

# (coluna, obrigatória, o que é, exemplo/valores aceitos)
COLUNAS = [
    ('cnpj_emitente', True, 'CNPJ da empresa que emite a nota (tem de ser uma empresa da sua conta).', '12.345.678/0001-95'),
    ('nota', True, 'Número que agrupa as linhas de uma mesma NF-e (um item por linha). Não é o número da NF-e: esse é da série da empresa.', '1'),
    ('cpf_cnpj_destinatario', True, 'CPF ou CNPJ do cliente.', '11.222.333/0001-81'),
    ('nome_destinatario', True, 'Nome ou razão social do cliente.', ''),
    ('ie_destinatario', False, 'Inscrição estadual do cliente. Vazio = não contribuinte; "ISENTO" = contribuinte isento.', '110.042.490.114'),
    ('email_destinatario', False, 'E-mail do cliente.', ''),
    ('cep', True, 'CEP do cliente.', '13015-000'),
    ('logradouro', True, 'Rua, avenida...', ''),
    ('numero', True, 'Número do endereço (ou S/N).', ''),
    ('complemento', False, 'Complemento do endereço.', ''),
    ('bairro', True, 'Bairro.', ''),
    ('municipio_ibge', True, 'Código IBGE do município do cliente (7 dígitos).', '3509502 (Campinas)'),
    ('uf', True, 'UF do cliente.', 'SP'),
    ('codigo_produto', True, 'Código do produto no seu cadastro.', ''),
    ('descricao_produto', True, 'Descrição do produto.', ''),
    ('ncm', True, 'NCM com 8 dígitos.', '4819.10.00'),
    ('cfop', True, 'CFOP: 5xxx dentro do estado, 6xxx para outro estado.', '5101, 5102, 6102'),
    ('unidade', True, 'Unidade comercial (até 6 letras).', 'UN, CX, KG, PCT'),
    ('quantidade', True, 'Quantidade (até 4 casas).', '500'),
    ('valor_unitario', True, 'Valor unitário em reais.', '2,45'),
    ('csosn', True, 'CSOSN do Simples: 101, 102, 103, 300, 400 ou 500.', '101'),
    ('aliquota_credito_sn', False, 'Só no CSOSN 101: alíquota do crédito de ICMS do Simples (%). O valor do crédito é calculado item a item, e a frase do crédito entra sozinha nas informações complementares.', '2,56'),
    ('desconto', False, 'Desconto do item em reais.', '61,25'),
    ('frete', False, 'Valor do frete cobrado na nota (rateado entre os itens).', '25,00'),
    ('forma_pagamento', False, 'pix, boleto, dinheiro, credito, debito, transferencia, sem pagamento, outros (ou o código). Vazio = pix na venda; "sem pagamento" quando nenhum item é de venda (remessa, bonificação, devolução...).', 'boleto'),
    ('informacoes', False, 'Informações complementares da nota (vão no quadro "Dados adicionais" do DANFE). Com CSOSN 101, NÃO escreva a frase do crédito de ICMS: o sistema a escreve sozinho, com o valor calculado. Use esta coluna só para o resto.', 'VENDA A VISTA - EM DINHEIRO'),
    ('modalidade_frete', False, '0 = emitente (CIF); 1 = destinatário (FOB); 2 = terceiros; 3 = transporte próprio do remetente; 4 = transporte próprio do destinatário; 9 = sem frete. Obrigatória quando há transportador. Vazio = 0 com frete, 9 sem frete.', '0'),
    ('transportador_cpf_cnpj', False, 'CPF ou CNPJ da transportadora.', '11.444.777/0001-61'),
    ('transportador_nome', False, 'Razão social da transportadora.', ''),
    ('transportador_ie', False, 'Inscrição estadual da transportadora (ou ISENTO).', ''),
    ('transportador_endereco', False, 'Endereço da transportadora, numa linha.', ''),
    ('transportador_municipio', False, 'Município da transportadora (nome).', 'Atibaia'),
    ('transportador_uf', False, 'UF da transportadora.', 'SP'),
    ('volumes_quantidade', False, 'Quantidade de volumes (número inteiro).', '10'),
    ('volumes_especie', False, 'Espécie dos volumes.', 'CAIXA, PALETE, FARDO'),
    ('volumes_marca', False, 'Marca dos volumes.', ''),
    ('volumes_numeracao', False, 'Numeração dos volumes.', '1 a 10'),
    ('peso_liquido', False, 'Peso líquido total em kg (até 3 casas).', '60,4'),
    ('peso_bruto', False, 'Peso bruto total em kg (até 3 casas). Se ficar menor que o líquido, o painel avisa.', '60,4'),
    ('natureza_operacao', False, 'Natureza da operação, como vai na nota (até 60 caracteres). Vazio = pelo CFOP: 5101/5102/6102/6108 Venda de mercadoria; 5949/6949 Simples remessa; 5910/6910 Remessa em bonificação, doação ou brinde; 5911/6911 Remessa de amostra grátis; 5915/6915 Remessa para conserto; 5923/6923 Remessa por conta e ordem de terceiros; 5202/6202 Devolução de compra; 5152/6152 Transferência de mercadoria.', 'Simples remessa'),
]
NATUREZA_INSTRUCAO = ('Natureza da operação: é da nota (uma por NF-e). Sem a coluna natureza_operacao, sai do CFOP dos itens; se os itens '
                      'tiverem CFOPs de naturezas diferentes, vale a venda (ou a do primeiro item) e o resumo avisa: preencha a coluna '
                      'quando não for isso. CFOP fora da tabela sai como "Venda de mercadoria", com aviso. A nota 4 do exemplo é uma '
                      'remessa para outro estado (CFOP 6949, CSOSN 400): sai como "Simples remessa" e "sem pagamento".')
NOMES = [c[0] for c in COLUNAS]

# Sem a frase do crédito do CSOSN 101: o builder a escreve com o valor calculado (fix de 24/11/2026, NF-e 4081).
CPL = ('Documento emitido por ME ou EPP optante pelo Simples Nacional. Não gera direito a crédito fiscal de IPI. '
       'VENDA A PRAZO - BOLETO')

LINHAS = [
    # Nota 1: Simples com CSOSN 101 (crédito), desconto, informações complementares, transportadora e volumes.
    dict(cnpj_emitente='12.345.678/0001-95', nota='1', cpf_cnpj_destinatario='11.222.333/0001-81',
         nome_destinatario='Comercio de Embalagens Exemplo Ltda', ie_destinatario='110.042.490.114',
         email_destinatario='compras@exemplo.com.br', cep='13015-000', logradouro='Rua Barao de Jaguara', numero='900',
         bairro='Centro', municipio_ibge='3509502', uf='SP', codigo_produto='EMB-4030',
         descricao_produto='Caixa de papelao ondulado 40x30x20 cm', ncm='4819.10.00', cfop='5101', unidade='UN',
         quantidade='500', valor_unitario='2,45', csosn='101', aliquota_credito_sn='2,56', desconto='61,25',
         forma_pagamento='boleto', informacoes=CPL, modalidade_frete='0',
         transportador_cpf_cnpj='11.444.777/0001-61', transportador_nome='Transportadora Exemplo Ltda',
         transportador_ie='190.123.456.110', transportador_endereco='Rua das Cargas, 50 - Distrito Industrial',
         transportador_municipio='Atibaia', transportador_uf='SP', volumes_quantidade='10', volumes_especie='CAIXA',
         volumes_marca='EXEMPLO', volumes_numeracao='1 a 10', peso_liquido='60,4', peso_bruto='60,4'),
    # Nota 2: dois itens; os campos da nota só na primeira linha (podem repetir, desde que iguais).
    dict(cnpj_emitente='12.345.678/0001-95', nota='2', cpf_cnpj_destinatario='11.222.333/0001-81',
         nome_destinatario='Padaria Exemplo Ltda', email_destinatario='financeiro@padaria-exemplo.com.br',
         cep='01310-100', logradouro='Av. Paulista', numero='1000', complemento='Sala 1', bairro='Bela Vista',
         municipio_ibge='3550308', uf='SP', codigo_produto='P001', descricao_produto='Farinha de trigo 5kg',
         ncm='1101.00.10', cfop='5102', unidade='UN', quantidade='3', valor_unitario='19,90', csosn='102',
         forma_pagamento='pix', informacoes='Documento emitido por ME ou EPP optante pelo Simples Nacional.'),
    dict(cnpj_emitente='12.345.678/0001-95', nota='2', codigo_produto='P002', descricao_produto='Fermento biologico 500g',
         ncm='2102.10.00', cfop='5102', unidade='PCT', quantidade='2,5', valor_unitario='12,345', csosn='102',
         desconto='1,00'),
    # Nota 3: para outro estado (CFOP 6102), com frete e boleto.
    dict(cnpj_emitente='12.345.678/0001-95', nota='3', cpf_cnpj_destinatario='529.982.247-25',
         nome_destinatario='Maria Exemplo da Silva', email_destinatario='maria@exemplo.com.br', cep='30130-000',
         logradouro='Rua da Bahia', numero='500', bairro='Centro', municipio_ibge='3106200', uf='MG',
         codigo_produto='P001', descricao_produto='Farinha de trigo 5kg', ncm='1101.00.10', cfop='6102', unidade='UN',
         quantidade='10', valor_unitario='19,90', csosn='102', frete='25,00', forma_pagamento='boleto'),
    # Nota 4: remessa sem venda para outro estado (CFOP 6949, CSOSN 400), entregue por conta e ordem de terceiro. Sem
    # forma_pagamento: sai "sem pagamento" (tPag 90).
    dict(cnpj_emitente='12.345.678/0001-95', nota='4', cpf_cnpj_destinatario='529.982.247-25',
         nome_destinatario='Maria Exemplo da Silva', cep='20040-020', logradouro='Rua Primeiro de Marco', numero='10',
         bairro='Centro', municipio_ibge='3304557', uf='RJ', codigo_produto='BR-01', descricao_produto='Garrafa personalizada 750 ml',
         ncm='9617.00.10', cfop='6949', unidade='UN', quantidade='9', valor_unitario='40,29', csosn='400',
         natureza_operacao='Simples remessa', modalidade_frete='0',
         informacoes='Entregue por conta e ordem de Loja Exemplo Ltda, conforme NF 2183, onde foram destacados os impostos.'),
]


def xlsx(destino: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = 'NF-e'
    ws.append(NOMES)
    for linha in LINHAS:
        ws.append([linha.get(n, '') for n in NOMES])
    # Tudo como texto: CNPJ, CEP, NCM e código IBGE não perdem zeros nem viram notação científica.
    for row in ws.iter_rows(min_row=1, max_row=len(LINHAS) + 200, max_col=len(NOMES)):
        for cell in row:
            cell.number_format = '@'
    obrig = PatternFill('solid', fgColor='FFE4A8')
    opc = PatternFill('solid', fgColor='E3EEF9')
    for i, (nome, obrigatoria, _, _) in enumerate(COLUNAS, start=1):
        c = ws.cell(row=1, column=i)
        c.font = Font(bold=True)
        c.fill = obrig if obrigatoria else opc
        largura = max(len(nome), *(len(str(l.get(nome, ''))) for l in LINHAS))
        ws.column_dimensions[get_column_letter(i)].width = min(max(largura + 2, 10), 48)
    ws.freeze_panes = 'C2'

    inst = wb.create_sheet('Instruções')
    inst.append(['Coluna', 'Obrigatória?', 'O que é', 'Exemplo / valores aceitos'])
    for nome, obrigatoria, oque, ex in COLUNAS:
        inst.append([nome, 'sim' if obrigatoria else 'não', oque, ex])
    inst.append([])
    for texto in [
        'Uma linha por item. As linhas com o mesmo cnpj_emitente e o mesmo número na coluna "nota" viram uma NF-e.',
        'Destinatário, frete, pagamento, natureza da operação, informações, transportador e volumes são da nota: basta preencher numa linha dela; se repetir em outra linha, tem de ser igual.',
        'Colunas em laranja são obrigatórias; em azul, opcionais. Pode apagar as colunas opcionais que não usa.',
        'Só a primeira aba é lida. Apague as notas de exemplo antes de enviar.',
        'CSOSN 101: a frase "Permite o aproveitamento do crédito de ICMS no valor de R$ ..., correspondente à alíquota de ...%, nos termos do art. 23 da LC 123/2006." vai sozinha no início das informações complementares, com a soma dos créditos dos itens. Se a frase já estiver na coluna informacoes, o valor e a alíquota são trocados pelos calculados. O resumo mostra o crédito antes de emitir.',
        NATUREZA_INSTRUCAO,
    ]:
        inst.append([texto])
    for c in inst[1]:
        c.font = Font(bold=True)
    for col, w in zip('ABCD', (26, 13, 90, 30)):
        inst.column_dimensions[col].width = w
    for row in inst.iter_rows(min_row=2):
        for c in row:
            c.alignment = Alignment(wrap_text=True, vertical='top')
    wb.save(destino)


def csv(destino: Path) -> None:
    def campo(v: str) -> str:
        return '"' + v.replace('"', '""') + '"' if any(ch in v for ch in ';"\n') else v
    texto = '\r\n'.join([';'.join(NOMES)] + [';'.join(campo(l.get(n, '')) for n in NOMES) for l in LINHAS]) + '\r\n'
    destino.write_bytes('﻿'.encode('utf-8') + texto.encode('utf-8'))


if __name__ == '__main__':
    xlsx(DADOS / 'modelo-nfe.xlsx')
    csv(DADOS / 'modelo-nfe.csv')
    for extra in sys.argv[1:]:
        xlsx(Path(extra))
    print('ok')
