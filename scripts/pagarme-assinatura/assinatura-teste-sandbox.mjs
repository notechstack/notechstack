// Assinaturas de teste no Pagar.me SANDBOX (só pk_test_), uma por plano, passando pela função local.
// Quem roda: Lucca, numa TASK futura. Uso:
//   node scripts/pagarme-assinatura/assinatura-teste-sandbox.mjs [--funcao-url=http://127.0.0.1:54321/functions/v1/assinatura-auditor]
// Cartão de teste aprovado (sucesso em qualquer operação): 4000000000000010
//   Fonte: https://docs.pagar.me/docs/simulador-de-cartão-de-crédito (conferida em 16/10/2026)
// O cartão é tokenizado direto no Pagar.me; o body enviado à função NUNCA leva dado de cartão, só card_token.
import { pathToFileURL } from 'node:url';
import { PLANOS } from './planos.mjs';

const API_PADRAO = 'https://api.pagar.me/core/v5';
export const FUNCAO_URL_PADRAO = 'http://127.0.0.1:54321/functions/v1/assinatura-auditor';
const CARTAO_TESTE_APROVADO = '4000000000000010';
// Igual a TEXTO_ACEITE_ASSINATURA de supabase/functions/assinatura-auditor/core.ts (scripts.test.mjs confere).
export const TEXTO_ACEITE = 'Li e aceito os Termos de Uso e a Política de Privacidade. Sei que o relatório do Auditor chega no meu e-mail e no meu painel do auditor.';
// Endereço de cobrança fictício de teste (o token da v5 não leva endereço; a função manda este ao Pagar.me).
export const ENDERECO_TESTE = { cep: '01001000', rua: 'Praça da Sé', numero: '100', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP' };

export async function assinaturasDeTeste({ fetch, env, funcaoUrl = FUNCAO_URL_PADRAO }) {
  const pk = String((env && env.PAGARME_ASSINATURA_PUBLIC_KEY) || '');
  if (!pk.startsWith('pk_test_')) throw new Error('CHAVE_NAO_SANDBOX');
  const apiUrl = String(env.PAGARME_ASSINATURA_API_URL || API_PADRAO).replace(/\/+$/, '');
  const destino = funcaoUrl || FUNCAO_URL_PADRAO;
  const resultados = [];
  for (const p of PLANOS) {
    const tk = await fetch(`${apiUrl}/tokens?appId=${pk}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        type: 'card',
        card: { number: CARTAO_TESTE_APROVADO, holder_name: 'TESTE SANDBOX', exp_month: 12, exp_year: 2030, cvv: '123' }
      })
    });
    if (!tk.ok) throw new Error(`TOKENIZACAO_FALHOU: HTTP ${tk.status} no plano ${p.codigo}`);
    let tkData = null;
    try { tkData = await tk.json(); } catch { tkData = null; }
    const cardToken = tkData && typeof tkData.id === 'string' ? tkData.id : '';
    if (!cardToken) throw new Error(`TOKENIZACAO_FALHOU: HTTP ${tk.status} sem id de token no plano ${p.codigo}`);

    const corpo = {
      plano: p.codigo,
      nome: 'Teste Sandbox',
      email: `teste+${p.codigo}@notechstack.com.br`,
      documento: '11144477735', // CPF de teste com dígitos verificadores válidos
      telefone: '11999999999',
      card_token: cardToken,
      termos_aceite: true,
      aceite_texto: TEXTO_ACEITE,
      endereco: { ...ENDERECO_TESTE }
    };
    const res = await fetch(destino, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    });
    const txt = await res.text();
    let resposta = null;
    try { resposta = txt ? JSON.parse(txt) : null; } catch { resposta = txt; }
    resultados.push({ codigo: p.codigo, http: res.status, resposta });
  }
  return resultados;
}

const rodadoDireto = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (rodadoDireto) {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--funcao-url='));
  const funcaoUrl = arg ? arg.slice('--funcao-url='.length) : FUNCAO_URL_PADRAO;
  assinaturasDeTeste({ fetch: globalThis.fetch, env: process.env, funcaoUrl })
    .then((lista) => {
      for (const r of lista) console.log(`${r.codigo}: HTTP ${r.http} ${JSON.stringify(r.resposta)}`);
      // Achado F-07: venda fechada (403) ou qualquer recusa nao pode terminar como sucesso.
      if (lista.some((r) => r.http !== 200 || !r.resposta || r.resposta.ok !== true)) {
        console.error('ALGUMA_ASSINATURA_FALHOU: confira AUDITOR_VENDA_ABERTA=sim e as variaveis do sandbox');
        process.exitCode = 1;
      }
    })
    .catch((e) => { console.error(e && e.message ? e.message : 'erro'); process.exitCode = 1; });
}
