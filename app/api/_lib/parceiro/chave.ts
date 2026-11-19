// Chave da API e segredo do webhook do parceiro (conta-mãe), gerados no servidor e mostrados uma vez só no painel.
// O banco guarda só o sha256 da chave (`api_key_hash`) e o prefixo para a tela; o segredo do webhook vai ao Supabase
// Vault (painel-integracao.ts). Nenhum dos dois é logado.
//
// Sandbox (19/11/2026): chave `nfk_test_…`, guardada na tabela de contas do sandbox (sandbox/). O prefixo decide em que
// tabela a chave é procurada (auth.ts); por isso a chave de produção nunca começa com `nfk_test_`.
import { randomBytes } from 'node:crypto'
import { ehChaveSandbox, hashApiKey, PREFIXO_SANDBOX } from '../auth.js'

export type ChaveGerada = { chave: string; hash: string; prefixo: string }

/** `nfk_` + 43 caracteres base64url (32 bytes). O prefixo (`nfk_` + 6) identifica a chave na tela. */
export function gerarChave(bytes: () => Buffer = () => randomBytes(32)): ChaveGerada {
  for (;;) {
    const chave = `nfk_${bytes().toString('base64url')}`
    // Uma em ~10⁹: o sorteio começou com "test_" e a chave seria lida como sandbox.
    if (ehChaveSandbox(chave)) continue
    return { chave, hash: hashApiKey(chave), prefixo: chave.slice(0, 10) }
  }
}

/** `nfk_test_` + 43 caracteres base64url. O prefixo (`nfk_test_` + 6) identifica a chave. */
export function gerarChaveSandbox(bytes: () => Buffer = () => randomBytes(32)): ChaveGerada {
  const chave = `${PREFIXO_SANDBOX}${bytes().toString('base64url')}`
  return { chave, hash: hashApiKey(chave), prefixo: chave.slice(0, PREFIXO_SANDBOX.length + 6) }
}

/** `whsec_` + 43 caracteres base64url. É a chave do HMAC-SHA256 do webhook. */
export function gerarSegredoWebhook(bytes: () => Buffer = () => randomBytes(32)): string {
  return `whsec_${bytes().toString('base64url')}`
}

/** Segredo do webhook sandbox: `whsec_test_` + 43 caracteres base64url. */
export function gerarSegredoWebhookSandbox(bytes: () => Buffer = () => randomBytes(32)): string {
  return `whsec_test_${bytes().toString('base64url')}`
}
