// Dublê da BrasilAPI (:3006): GET /api/cnpj/v1/:cnpj com os campos que a consulta usa (razão social, município,
// UF, código IBGE e CNAE). Qualquer CNPJ com dígitos válidos existe, em São Paulo/SP (IBGE 3550308), CNAE 8630503.
// Começando com 00000000: não encontrado (404). Começando com 99: município fictício fora do padrão nacional.
// Os CNPJs de exemplo das telas (Prontia, Clínica Aurora) têm razão social própria; os outros, EMPRESA DEMO.
import { servidor, json } from '../http.mjs';

export function cnpjValido(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const pesos = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (let t = 12; t < 14; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += Number(d[i]) * pesos[i + 13 - t];
    const r = s % 11 < 2 ? 0 : 11 - (s % 11);
    if (r !== Number(d[t])) return false;
  }
  return true;
}

/* CNPJ válido a partir de 12 dígitos (raiz + filial). */
export function completarCnpj(doze) {
  const d = String(doze).replace(/\D/g, '').slice(0, 12).split('').map(Number);
  const pesos = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  for (let t = 12; t < 14; t++) {
    let s = 0;
    for (let i = 0; i < t; i++) s += d[i] * pesos[i + 13 - t];
    d.push(s % 11 < 2 ? 0 : 11 - (s % 11));
  }
  return d.join('');
}

export async function iniciarBrasilApi({ porta = 3006 } = {}) {
  return servidor(porta, async (req, res, url) => {
    const m = /^\/api\/cnpj\/v1\/(\d{14})\/?$/.exec(url.pathname);
    if (req.method !== 'GET' || !m) { json(res, 404, { message: 'rota sem dublê', type: 'not_found' }); return; }
    const cnpj = m[1];
    if (!cnpjValido(cnpj)) { json(res, 400, { message: `CNPJ ${cnpj} inválido.`, type: 'bad_request', name: 'BadRequestError' }); return; }
    if (cnpj.startsWith('00000000')) { json(res, 404, { message: `CNPJ ${cnpj} não encontrado.`, type: 'not_found', name: 'NotFoundError' }); return; }
    const fora = cnpj.startsWith('99');
    const conhecidos = { '11444777000161': 'PRONTIA SAUDE LTDA', '11222333000181': 'CLINICA AURORA LTDA' };
    json(res, 200, {
      cnpj, razao_social: conhecidos[cnpj] || `EMPRESA DEMO ${cnpj.slice(8, 12)} LTDA`, nome_fantasia: 'DEMO',
      municipio: fora ? 'CIDADE FORA DO PADRAO' : 'SAO PAULO', uf: fora ? 'MG' : 'SP',
      codigo_municipio_ibge: fora ? 3199999 : 3550308, codigo_municipio: fora ? 9999 : 7107,
      cnae_fiscal: 8630503, cnae_fiscal_descricao: 'Atividade médica ambulatorial restrita a consultas',
      descricao_situacao_cadastral: 'ATIVA', situacao_cadastral: 2, opcao_pelo_simples: true, porte: 'MICRO EMPRESA',
      cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', bairro: 'BELA VISTA'
    });
  }, 'brasilapi');
}
