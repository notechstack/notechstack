// Chave da API e segredo do webhook do parceiro (conta-mãe), gerados no servidor e mostrados uma vez só no painel.
// O banco guarda só o sha256 da chave (`api_key_hash`) e o prefixo para a tela; o segredo do webhook vai ao Supabase
// Vault (painel-integracao.ts). Nenhum dos dois é logado.
import { randomBytes } from 'node:crypto'
import { hashApiKey } from '../auth.js'

export type ChaveGerada = { chave: string; hash: string; prefixo: string }

/** `nfk_` + 43 caracteres base64url (32 bytes). O prefixo (`nfk_` + 6) identifica a chave na tela. */
export function gerarChave(bytes: () => Buffer = () => randomBytes(32)): ChaveGerada {
  const chave = `nfk_${bytes().toString('base64url')}`
  return { chave, hash: hashApiKey(chave), prefixo: chave.slice(0, 10) }
}

/** `whsec_` + 43 caracteres base64url. É a chave do HMAC-SHA256 do webhook. */
export function gerarSegredoWebhook(bytes: () => Buffer = () => randomBytes(32)): string {
  return `whsec_${bytes().toString('base64url')}`
}
