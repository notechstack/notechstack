"""Extrai os dois anexos oficiais e a lista de emissores, sem dependências.

Uso: python tests/agente-fiscal-v2-dados/extrair-dados.py [--gravar]
Sem --gravar, apenas confere as fontes e informa divergências. Não usa credenciais.
"""
import datetime
import hashlib
import gzip
import io
import json
from pathlib import Path
import re
import sys
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

BASE = 'https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/'
FONTES = {
    'municipios': 'https://www.gov.br/nfse/pt-br/municipios/monitoramento-adesoes/municipios-aderentes-20260928.xlsx',
    'ibge': BASE + 'anexo_a-municipio_ibge-paises_iso2-v1-00-snnfse-20251210.xlsx',
    'servicos': BASE + 'anexo_b-nbs2-lista_servico_nacional-snnfse-v1-01-20260122.xlsx',
    'ufs': 'https://servicodados.ibge.gov.br/api/v1/localidades/estados',
}
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
ROOT = Path(__file__).resolve().parents[2]
# Grafias da lista de adesão -> grafias do Anexo A. Correspondências revisadas;
# fontes históricas e códigos estão registrados no relatório de pesquisas (seção a).
ALIASES = {
    ('GO', 'BOMJESUS'): 'Bom Jesus de Goiás',
    ('BA', 'LAGEDODOTABOCAL'): 'Lajedo do Tabocal',
    ('RN', 'ASSU'): 'Açu',
    ('RN', 'BOASAUDE'): 'Januário Cicco',
    ('TO', 'SAOVALERIODANATIVIDADE'): 'São Valério',
    ('MG', 'BARAODOMONTEALTO'): 'Barão de Monte Alto',
    ('MG', 'DONAEUZEBIA'): 'Dona Eusébia',
    ('SP', 'SAOLUIZDOPARAITINGA'): 'São Luís do Paraitinga',
    ('PR', 'MUNHOZDEMELLO'): 'Munhoz de Melo',
    ('SE', 'GRACCHOCARDOSO'): 'Gracho Cardoso',
}


def planilha(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read()
    print(url, 'sha256=' + hashlib.sha256(data).hexdigest())
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        strings = [''.join(n.itertext()) for n in ET.fromstring(
            archive.read('xl/sharedStrings.xml')).findall('m:si', NS)]
        rows = []
        for row in ET.fromstring(archive.read('xl/worksheets/sheet1.xml')).findall('m:sheetData/m:row', NS):
            values = {}
            for cell in row.findall('m:c', NS):
                value = cell.find('m:v', NS)
                if value is not None:
                    text = strings[int(value.text)] if cell.get('t') == 's' else value.text
                    values[re.sub(r'\d', '', cell.get('r'))] = text
            rows.append(values)
        return rows


def nome(text):
    # Somente normalização ortográfica, nunca aproximação ou escolha por similaridade.
    return re.sub(r'[^A-Z0-9]', '', unicodedata.normalize('NFKD', text.upper()).encode('ascii', 'ignore').decode())


def main():
    hoje = datetime.date.today()
    aderentes = planilha(FONTES['municipios'])
    ibge = planilha(FONTES['ibge'])
    servicos = planilha(FONTES['servicos'])
    assert aderentes[0]['G'] == 'AderenteEmissorNacional'
    assert ibge[0]['D'] == 'CÓDIGO COMPLETO'
    assert servicos[0]['A'] == 'CÓDIGO DE TRIBUTAÇÃO NACIONAL'
    indice = {}
    with urllib.request.urlopen(FONTES['ufs'], timeout=30) as response:
        raw = response.read()
        if raw[:2] == b'\x1f\x8b':
            raw = gzip.decompress(raw)
        ufs = {str(uf['id']): uf['sigla'] for uf in json.loads(raw)}
    for row in ibge[1:]:
        if not re.fullmatch(r'\d{7}', row.get('D', '')):
            continue
        # O Anexo A deixa várias siglas vazias; resolver pelo prefixo oficial do IBGE.
        uf = ufs[row['D'][:2]]
        assert not row.get('B') or row['B'] == uf, row
        assert uf and row.get('C'), row
        key = (uf, nome(row['C']))
        assert key not in indice, ('município ambíguo', key)
        indice[key] = row['D']
    selecionados, pendentes, futuros, sem_vigencia = [], [], [], []
    for row in aderentes[1:]:
        if row.get('G') != 'Sim' or row.get('E') != 'Conveniado Ativo':
            continue
        vigencia = row.get('N', '').strip()
        if not vigencia:
            # A adesão e o convênio ativo são explícitos mesmo com esta célula vazia.
            sem_vigencia.append((row.get('B'), row.get('C')))
        elif datetime.datetime.strptime(vigencia, '%d/%m/%Y').date() > hoje:
            futuros.append((row['B'], row['C'], vigencia))
            continue
        key = (row['B'], nome(row['C']))
        if key in ALIASES:
            key = (key[0], nome(ALIASES[key]))
        if key not in indice:
            pendentes.append(('sem IBGE', *key))
        else:
            selecionados.append(indice[key])
    itens = []
    for row in servicos[1:]:
        codigo = row.get('A', '')
        if not codigo:
            continue  # Cabeçalhos de item/subitem não são cTribNac.
        assert re.fullmatch(r'\d{5,6}', codigo), row
        assert row.get('E', '').strip(), row
        itens.append({'codigo': codigo.zfill(6), 'descricao': row['E'].strip()})
    assert len({i['codigo'] for i in itens}) == len(itens)
    assert len(set(selecionados)) == len(selecionados)
    print(json.dumps({'municipios': len(selecionados), 'servicos': len(itens),
                      'pendentes': pendentes, 'vigencia_futura': futuros,
                      'ativos_sem_data_vigencia': sem_vigencia}, ensure_ascii=False, indent=2))
    if '--gravar' not in sys.argv:
        return
    assert not pendentes, 'Não publicar lista parcial: resolver nomes/vigências antes de gravar.'
    outputs = {
        'supabase/functions/_shared/fiscal/municipios-padrao-nacional.json': {
            'fonte': FONTES['municipios'], 'consultado_em': hoje.isoformat(),
            'codigos_ibge': sorted(selecionados)},
        'agentes/fiscal/dados/codigos-servico.json': {
            'fonte': FONTES['servicos'], 'consultado_em': hoje.isoformat(),
            'itens': sorted(itens, key=lambda i: i['codigo'])},
    }
    for path, value in outputs.items():
        destination = ROOT / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
