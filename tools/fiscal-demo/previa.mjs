// node tools/fiscal-demo/previa.mjs: prévia só do front (LP, cadastro e etapa do pagamento), sem Docker e sem Supabase.
// Sobe o site (:3010) com o mesmo servidor da demo e, no lugar das edge functions e do Pagar.me, um servidor de mentira
// (:3011) que responde o mínimo para o cadastro andar até o pagamento: CNPJ sempre aprovado, código de e-mail fixo,
// cupons de fundador e cartão sempre aceito. Nada é gravado nem sai da máquina. Serve para revisar preço e layout; o
// que valida regra de negócio é a demo completa (npm run fiscal:demo).
import { createServer } from 'node:http';
import { iniciarSite } from './site.mjs';

const PORTA_SITE = Number(process.env.PREVIA_PORTA || 3010);
const PORTA_FALSA = PORTA_SITE + 1;
const CODIGO = '123456';
const site = `http://localhost:${PORTA_SITE}`;
const falsa = `http://localhost:${PORTA_FALSA}`;

// Cupons de fundador que existem hoje (scripts/pagarme-assinatura/cupons-fundador-escritorio.sql), nas faixas de volume.
const CUPONS = {
  FUNDADOR5: { plano: 'escritorio_5', cheio: 29700, com: 24700 },
  FUNDADOR1000: { plano: 'escritorio_1000', cheio: 49700, com: 39700 },     // novo: ainda não existe no banco
  FUNDADOR10000: { plano: 'escritorio_10000', cheio: 249700, com: 199700 }, // novo: ainda não existe no banco
  FUNDADOR20: { plano: 'escritorio_20', cheio: 79700, com: 64700 },
  FUNDADOR50: { plano: 'escritorio_50', cheio: 149700, com: 119700 }
};

const conta = { criada: false, plano: 'inicial', etapa: 'pagamento' };

async function corpoJson(req) {
  const p = [];
  for await (const c of req) p.push(c);
  try { return JSON.parse(Buffer.concat(p).toString('utf8') || '{}'); } catch { return {}; }
}

function responder(res, status, dados) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(dados));
}

const sessao = () => ({ ok: true, access_token: 'previa-acesso', refresh_token: 'previa-renovacao', expires_in: 86400 });

const rotas = {
  'fiscal-cadastro': (c) => {
    if (c.acao === 'consultar_cnpj') {
      return [200, { ok: true, razao_social: 'EMPRESA DE PRÉVIA LTDA', municipio: 'São Paulo', uf: 'SP', cnae: '6920601', regime: 'simples', padrao_nacional: true }];
    }
    if (c.acao === 'criar') {
      Object.assign(conta, { criada: true, plano: c.plano || 'inicial', etapa: 'pagamento' });
      return [200, { ok: true, tenant_id: 'previa-tenant', etapa: 'pagamento', novo: true }];
    }
    return [400, { ok: false, error_code: 'ACAO_INVALIDA' }];
  },
  'fiscal-acesso': (c) => {
    if (c.acao !== 'verificar') return [200, { ok: true }];
    if (String(c.codigo) !== CODIGO) return [401, { ok: false, error_code: 'CODIGO_INCORRETO' }];
    return [200, sessao()];
  },
  'fiscal-conta': () => conta.criada
    ? [200, { ok: true, tenant_id: 'previa-tenant', plano: conta.plano, onboarding_etapa: conta.etapa }]
    : [404, { ok: false, error_code: 'CONTA_SEM_EMPRESA' }],
  'assinatura-fiscal': (c, metodo) => {
    if (metodo === 'GET') {
      return [200, {
        ok: true, venda_aberta: true, public_key: 'pk_previa', planos: {},
        anual_disponivel: true, escritorio_disponivel: true, escritorio_anual_disponivel: true,
        aceite_texto: 'Li e aceito os Termos de Uso e a Política de Privacidade do nó.fiscal. (Texto da prévia local.)'
      }];
    }
    if (c.acao === 'validar_cupom') {
      const cupom = CUPONS[String(c.codigo || '').toUpperCase()];
      if (!cupom) return [422, { ok: false, error_code: 'CUPOM_INVALIDO', mensagem: 'Cupom não encontrado. Confira o código.' }];
      if (cupom.plano !== c.plano) return [422, { ok: false, error_code: 'CUPOM_PLANO', mensagem: 'Este cupom não vale para a faixa escolhida.' }];
      return [200, { ok: true, cupom: { codigo: String(c.codigo).toUpperCase(), cortesia: false, valor_centavos: cupom.cheio, valor_centavos_com_desconto: cupom.com, ciclos: 12, dias_de_teste: 30 } }];
    }
    console.log('[prévia] assinatura pedida:', JSON.stringify({ plano: c.plano, notas: c.notas, guias: !!c.guias, ciclo: c.ciclo, cupom: c.cupom || null }));
    conta.etapa = 'certificado';
    return [200, { ok: true, com_teste: true, status: 'teste', medicao: null }];
  }
};

createServer(async (req, res) => {
  const url = new URL(req.url, falsa);
  if (req.method === 'OPTIONS') { responder(res, 204, {}); return; }
  if (url.pathname === '/core/v5/tokens') { responder(res, 200, { id: 'token_previa', type: 'card' }); return; }
  if (url.pathname.startsWith('/auth/v1/')) { responder(res, 200, sessao()); return; }
  const nome = url.pathname.replace(/^\/functions\/v1\//, '').replace(/\/+$/, '');
  const rota = rotas[nome];
  if (!rota) { responder(res, 404, { ok: false, error_code: 'PREVIA_SEM_ROTA', mensagem: 'A prévia só cobre o cadastro até o pagamento.' }); return; }
  const [status, dados] = rota(req.method === 'GET' ? {} : await corpoJson(req), req.method);
  responder(res, status, dados);
}).listen(PORTA_FALSA, '127.0.0.1');

const configJs = `/* config.js da prévia local (tools/fiscal-demo/previa.mjs), servido no lugar do de produção. */\nwindow.NOFISCAL_CONFIG = ${JSON.stringify({
  supabaseUrl: site, anonKey: 'previa', funcoesUrl: `${site}/functions/v1`, apiBase: '/agentes/fiscal/api', whatsappAgente: '5511900000000',
  pagarmeApiUrl: `${falsa}/core/v5`, codigoFixoDemo: CODIGO
})};\n`;

await iniciarSite({ porta: PORTA_SITE, apiUrl: falsa, supabaseUrl: falsa, configJs, metaUrl: falsa, urls: { resend: falsa, pagarme: falsa, meta: falsa, ia: falsa } });
console.log(`[prévia] LP: ${site}/agentes/fiscal/  ·  cadastro: ${site}/agentes/fiscal/comecar/  ·  código do e-mail: ${CODIGO}`);
