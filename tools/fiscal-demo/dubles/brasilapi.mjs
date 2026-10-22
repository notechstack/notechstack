// BrasilAPI da demonstração (:3006): GET /api/cnpj/v1/:cnpj com os campos que a consulta usa (razão social, município,
// UF, código IBGE, CNAE e situação cadastral).
// - CNPJ começando com 777 é de teste, inventado aqui (nunca existe na Receita):
//     7770… → não encontrado (404) · 7778… → situação BAIXADA · 7779… → município fora do padrão nacional
//     qualquer outro 777… → EMPRESA DEMO, ativa, em São Paulo/SP (IBGE 3550308), CNAE 8630503.
// - Qualquer outro CNPJ vai à BrasilAPI de verdade (dados abertos da Receita): CNPJ inventado dá 404 e a demo
//   bloqueia, como em produção (pedido de Lucca, 22/10/2026). Sem internet, 503.
import { servidor, json } from '../http.mjs';

const BRASILAPI = 'https://brasilapi.com.br';
// A BrasilAPI responde 403 ao user-agent 'node' do fetch do Node.
const USER_AGENT = 'no-fiscal-demo/1.0 (+https://www.notechstack.com.br)';

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

export const ehCnpjDeTeste = (cnpj) => String(cnpj).startsWith('777');

function cnpjDeTeste(cnpj) {
  if (cnpj.startsWith('7770')) return [404, { message: `CNPJ ${cnpj} não encontrado.`, type: 'not_found', name: 'NotFoundError' }];
  const fora = cnpj.startsWith('7779');
  return [200, {
    cnpj, razao_social: `EMPRESA DEMO ${cnpj.slice(3, 8)} LTDA`, nome_fantasia: 'DEMO',
    municipio: fora ? 'CIDADE FORA DO PADRAO' : 'SAO PAULO', uf: fora ? 'MG' : 'SP',
    codigo_municipio_ibge: fora ? 3199999 : 3550308, codigo_municipio: fora ? 9999 : 7107,
    cnae_fiscal: 8630503, cnae_fiscal_descricao: 'Atividade médica ambulatorial restrita a consultas',
    descricao_situacao_cadastral: cnpj.startsWith('7778') ? 'BAIXADA' : 'ATIVA', situacao_cadastral: cnpj.startsWith('7778') ? 8 : 2,
    opcao_pelo_simples: true, porte: 'MICRO EMPRESA',
    cep: '01310100', logradouro: 'AVENIDA PAULISTA', numero: '1000', bairro: 'BELA VISTA'
  }];
}

export async function iniciarBrasilApi({ porta = 3006, fetch: buscar = fetch } = {}) {
  return servidor(porta, async (req, res, url) => {
    const m = /^\/api\/cnpj\/v1\/(\d{14})\/?$/.exec(url.pathname);
    if (req.method !== 'GET' || !m) { json(res, 404, { message: 'rota sem dublê', type: 'not_found' }); return; }
    const cnpj = m[1];
    if (!cnpjValido(cnpj)) { json(res, 400, { message: `CNPJ ${cnpj} inválido.`, type: 'bad_request', name: 'BadRequestError' }); return; }
    if (ehCnpjDeTeste(cnpj)) { const [status, corpo] = cnpjDeTeste(cnpj); json(res, status, corpo); return; }
    try {
      const r = await buscar(`${BRASILAPI}/api/cnpj/v1/${cnpj}`, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(8000) });
      const corpo = await r.json().catch(() => ({}));
      json(res, r.status, corpo);
    } catch {
      json(res, 503, { message: 'BrasilAPI fora do alcance', type: 'service_unavailable' });
    }
  }, 'brasilapi');
}
