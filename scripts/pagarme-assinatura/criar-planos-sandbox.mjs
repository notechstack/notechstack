// Cria os 3 planos do Auditor no Pagar.me. Quem roda: Lucca.
// Padrão (sandbox): só PAGARME_ASSINATURA_SECRET_KEY e só sk_test_ (senão CHAVE_NAO_SANDBOX).
// Uso: node scripts/pagarme-assinatura/criar-planos-sandbox.mjs
// Uso em produção: PAGARME_ASSINATURA_AMBIENTE=producao node scripts/pagarme-assinatura/criar-planos-sandbox.mjs
//   chave = PAGARME_ASSINATURA_SECRET_KEY || PAGARME_SECRET_KEY; exige sk_ e recusa sk_test_ (CHAVE_NAO_PRODUCAO).
// Imprime uma linha NOME_DA_VARIAVEL=plan_... por plano (id de plano não é segredo). Nunca imprime a chave.
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { PLANOS, corpoDoPlano } from './planos.mjs';

const API_PADRAO = 'https://api.pagar.me/core/v5';

export async function criarPlanos({ fetch, env }) {
  env = env || {};
  let secret;
  if (env.PAGARME_ASSINATURA_AMBIENTE === 'producao') {
    secret = String(env.PAGARME_ASSINATURA_SECRET_KEY || env.PAGARME_SECRET_KEY || '');
    if (!secret.startsWith('sk_') || secret.startsWith('sk_test_')) throw new Error('CHAVE_NAO_PRODUCAO');
  } else {
    secret = String(env.PAGARME_ASSINATURA_SECRET_KEY || '');
    if (!secret.startsWith('sk_test_')) throw new Error('CHAVE_NAO_SANDBOX');
  }
  const apiUrl = String(env.PAGARME_ASSINATURA_API_URL || API_PADRAO).replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(secret + ':').toString('base64')}`;
  const criados = [];
  for (const p of PLANOS) {
    const res = await fetch(`${apiUrl}/plans`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corpoDoPlano(p))
    });
    if (!res.ok) throw new Error(`PAGARME_FALHOU: HTTP ${res.status} ao criar o plano ${p.codigo}`);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const id = data && typeof data.id === 'string' ? data.id : '';
    if (!id.startsWith('plan_')) throw new Error(`PAGARME_FALHOU: HTTP ${res.status} sem id plan_ no plano ${p.codigo}`);
    criados.push({ codigo: p.codigo, env: p.env, id });
  }
  return criados;
}

const rodadoDireto = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (rodadoDireto) {
  criarPlanos({ fetch: globalThis.fetch, env: process.env })
    .then((lista) => { for (const p of lista) console.log(`${p.env}=${p.id}`); })
    .catch((e) => { console.error(e && e.message ? e.message : 'erro'); process.exitCode = 1; });
}
