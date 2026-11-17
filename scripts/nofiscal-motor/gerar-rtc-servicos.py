"""Gera app/api/_lib/rtc/servicos-rtc.ts: de-para cTribNac -> NBS, cIndOp e cClassTrib (IBS/CBS).

Fontes oficiais (gov.br/nfse), baixadas à mão e passadas por argumento:
  1. Anexo VIII v1.02.00 (26/10/2026), correlação Item LC 116 x NBS x cIndOp x cClassTrib:
     https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc  (anexo_viii-tabela-correlacao-v01-02-00-20261026.xlsx)
     A própria página avisa que não há regra de negócio da Sefin baseada nele: serve de sugestão, não de trava.
  2. Anexo B v1.01 (22/01/2026), aba LISTA.NBS_v2.0: lista nacional de NBS (E0316 recusa NBS fora dela).
  3. agentes/fiscal/dados/codigos-servico.json: os 338 cTribNac publicados no site.

O Anexo VIII é por subitem da LC 116 ("01.01"); o cTribNac tem 6 dígitos = item + subitem + desdobro,
então "010101" e "010102" herdam a linha "01.01". Células mescladas são expandidas antes da leitura.

Uso: python -I scripts/nofiscal-motor/gerar-rtc-servicos.py <anexo_viii.xlsx> <anexo_b.xlsx>
"""
import json
import os
import sys

import openpyxl

RAIZ = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SAIDA = os.path.join(RAIZ, 'app', 'api', '_lib', 'rtc', 'servicos-rtc.ts')
CODIGOS = os.path.join(RAIZ, 'agentes', 'fiscal', 'dados', 'codigos-servico.json')


def so_digitos(valor):
    return ''.join(c for c in str(valor) if c.isdigit())


def grade_expandida(ws, colunas):
    grade = [[c.value for c in linha] for linha in ws.iter_rows(min_row=1, max_col=colunas)]
    for faixa in ws.merged_cells.ranges:
        valor = ws.cell(faixa.min_row, faixa.min_col).value
        for r in range(faixa.min_row, faixa.max_row + 1):
            for c in range(faixa.min_col, min(faixa.max_col, colunas) + 1):
                grade[r - 1][c - 1] = valor
    return grade


def ler_anexo_viii(caminho):
    ws = openpyxl.load_workbook(caminho)['tabela geral']
    grade = grade_expandida(ws, 10)
    cab = [str(c or '').strip().upper() for c in grade[0]]
    assert cab[0].startswith('ITEM LC 116') and cab[2] == 'NBS' and cab[6] == 'INDOP' and cab[8] == 'CCLASSTRIB', cab
    itens = {}
    atual = None
    for linha in grade[1:]:
        if linha[0]:
            atual = str(linha[0]).strip()
        if not atual:
            continue
        d = itens.setdefault(atual, {'nbs': [], 'cIndOp': [], 'cClassTrib': []})
        for chave, col in (('nbs', 2), ('cIndOp', 6), ('cClassTrib', 8)):
            if linha[col] is None:
                continue
            valor = so_digitos(linha[col])
            if valor and valor not in d[chave]:
                d[chave].append(valor)
    return itens


def ler_nbs(caminho):
    ws = openpyxl.load_workbook(caminho, read_only=True)['LISTA.NBS_v2.0']
    codigos = set()
    for i, linha in enumerate(ws.iter_rows(values_only=True)):
        if i == 0 or linha[0] is None:
            continue
        digitos = so_digitos(linha[0])
        if len(digitos) == 9:  # só o nível folha (1.0101.11.00) cabe no TSCodNBS [0-9]{9}
            codigos.add(digitos)
    return codigos


def main(anexo_viii, anexo_b):
    itens = ler_anexo_viii(anexo_viii)
    nbs_validas = ler_nbs(anexo_b)
    with open(CODIGOS, encoding='utf-8') as f:
        codigos = [i['codigo'] for i in json.load(f)['itens']]
    servicos = {}
    for codigo in codigos:
        subitem = f'{codigo[0:2]}.{codigo[2:4]}'
        linha = itens.get(subitem)
        if not linha:
            continue
        nbs = [n for n in linha['nbs'] if n in nbs_validas]
        servicos[codigo] = {'nbs': nbs, 'cIndOp': linha['cIndOp'], 'cClassTrib': linha['cClassTrib']}
    saida = {
        'fontes': {
            'anexo_viii': 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/rtc (anexo_viii-tabela-correlacao-v01-02-00-20261026.xlsx)',
            'anexo_b': 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_b-nbs2-lista_servico_nacional-snnfse-v1-01-20260122.xlsx',
            'consultado_em': '2026-11-17',
            'observacao': 'Anexo VIII sem regra de negócio na Sefin: sugestão. NBS fora do Anexo B foram descartadas.',
        },
        'nbs_validas': sorted(nbs_validas),
        'servicos': servicos,
    }
    os.makedirs(os.path.dirname(SAIDA), exist_ok=True)
    with open(SAIDA, 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Gerado por scripts/nofiscal-motor/gerar-rtc-servicos.py; não editar à mão.\n')
        f.write("import type { TabelaRtc } from './tipos.js'\n\n")
        f.write('export const TABELA_RTC: TabelaRtc = ')
        json.dump(saida, f, ensure_ascii=False, separators=(', ', ': '))
        f.write('\n')
    unica = sum(1 for s in servicos.values() if len(s['nbs']) == 1)
    print(f'{len(servicos)} de {len(codigos)} cTribNac com linha no Anexo VIII; {unica} com uma NBS só; {len(nbs_validas)} NBS válidas')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
