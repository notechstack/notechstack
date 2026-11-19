// Cria o plano "nó.fiscal Guias" no Pagar.me (produção): mensal, R$ 197,00, sem teste, fatura NOFISCALGUIAS.
// Quem roda: preparar-plano-guias.ps1 (Lucca). Corpo: corpoDoPlanoGuias em supabase/functions/assinatura-fiscal-guias/core.ts
// (Node 24 lê o .ts). Chave: PAGARME_SECRET_KEY no ambiente desta janela; exige sk_ e recusa sk_test_ (CHAVE_NAO_PRODUCAO).
// Imprime PAGARME_PLANO_FISCAL_GUIAS_ID=plan_... (id de plano não é segredo). Nunca imprime a chave.
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { PLANO_GUIAS, corpoDoPlanoGuias } from '../../supabase/functions/assinatura-fiscal-guias/core.ts';

const API_PADRAO = 'https://api.pagar.me/core/v5';

export async function criarPlanoGuias({ fetch, env }) {
  env = env || {};
  const secret = String(env.PAGARME_SECRET_KEY || '');
  if (!secret.startsWith('sk_') || secret.startsWith('sk_test_')) throw new Error('CHAVE_NAO_PRODUCAO');
  const apiUrl = String(env.PAGARME_ASSINATURA_API_URL || API_PADRAO).replace(/\/+$/, '');
  const res = await fetch(`${apiUrl}/plans`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(secret + ':').toString('base64')}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(corpoDoPlanoGuias())
  });
  if (!res.ok) throw new Error(`PAGARME_FALHOU: HTTP ${res.status} ao criar o plano guias`);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  const id = data && typeof data.id === 'string' ? data.id : '';
  if (!id.startsWith('plan_')) throw new Error(`PAGARME_FALHOU: HTTP ${res.status} sem id plan_`);
  return { env: PLANO_GUIAS.env, id };
}

const rodadoDireto = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (rodadoDireto) {
  criarPlanoGuias({ fetch: globalThis.fetch, env: process.env })
    .then((p) => console.log(`${p.env}=${p.id}`))
    .catch((e) => { console.error(e && e.message ? e.message : 'erro'); process.exitCode = 1; });
}
