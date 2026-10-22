// Cria os 4 planos do Agente Fiscal no Pagar.me (produção). Quem roda: preparar-producao-fiscal.ps1.
// Corpo de cada plano: corpoDoPlano em supabase/functions/assinatura-fiscal/core.ts (Node 24 lê o .ts).
// Chave: PAGARME_SECRET_KEY no ambiente desta janela; exige sk_ e recusa sk_test_ (CHAVE_NAO_PRODUCAO).
// Imprime uma linha NOME_DA_VARIAVEL=plan_... por plano (id de plano não é segredo). Nunca imprime a chave.
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { PLANOS_PAGARME, corpoDoPlano } from '../../supabase/functions/assinatura-fiscal/core.ts';

const API_PADRAO = 'https://api.pagar.me/core/v5';

export async function criarPlanosFiscal({ fetch, env }) {
  env = env || {};
  const secret = String(env.PAGARME_SECRET_KEY || '');
  if (!secret.startsWith('sk_') || secret.startsWith('sk_test_')) throw new Error('CHAVE_NAO_PRODUCAO');
  const apiUrl = String(env.PAGARME_ASSINATURA_API_URL || API_PADRAO).replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(secret + ':').toString('base64')}`;
  const criados = [];
  for (const codigo of Object.keys(PLANOS_PAGARME)) {
    const res = await fetch(`${apiUrl}/plans`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(corpoDoPlano(codigo))
    });
    if (!res.ok) throw new Error(`PAGARME_FALHOU: HTTP ${res.status} ao criar o plano ${codigo}`);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const id = data && typeof data.id === 'string' ? data.id : '';
    if (!id.startsWith('plan_')) throw new Error(`PAGARME_FALHOU: HTTP ${res.status} sem id plan_ no plano ${codigo}`);
    criados.push({ codigo, env: PLANOS_PAGARME[codigo].env, id });
  }
  return criados;
}

const rodadoDireto = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (rodadoDireto) {
  criarPlanosFiscal({ fetch: globalThis.fetch, env: process.env })
    .then((lista) => { for (const p of lista) console.log(`${p.env}=${p.id}`); })
    .catch((e) => { console.error(e && e.message ? e.message : 'erro'); process.exitCode = 1; });
}
