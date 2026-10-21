// Checkout do auditor no app (plan, passo 6). Funções puras + tokenização do cartão no navegador:
// número, validade e CVV vão só ao Pagar.me (chave pública); o servidor recebe o token. Mesma regra do
// agentes/auditor/assinatura.js do site.

export type CodigoPlano = 'mensal' | 'semanal' | 'agencia'

// Tem de ser idêntico a TEXTO_ACEITE_ASSINATURA (assinatura-auditor/core.ts): o servidor recusa outro texto.
// Um teste garante a igualdade.
export const TEXTO_ACEITE =
  'Li e aceito os Termos de Uso e a Política de Privacidade. Sei que o relatório do Auditor chega no WhatsApp ' +
  'que informei acima, enviado pelo número da nó (+55 11 93928-9413).'

export const PLANOS: { codigo: CodigoPlano; nome: string; preco: string; ritmo: string; itens: string[]; recomendado?: boolean }[] = [
  { codigo: 'mensal', nome: 'Mensal', preco: 'R$ 47', ritmo: '1 relatório por mês', itens: ['1 site + contas Meta e Google', 'Nota de 0 a 10 com o placar ok · atenção · problema', 'O que corrigir, uma linha por ponto'] },
  { codigo: 'semanal', nome: 'Semanal', preco: 'R$ 97', ritmo: 'Toda segunda', recomendado: true, itens: ['Tudo do Mensal + o que mudou na semana', 'Onde o clique se perde, do anúncio ao site'] },
  { codigo: 'agencia', nome: 'Agência', preco: 'R$ 197', ritmo: 'Personalizado', itens: ['Até 5 negócios, 1 site + contas cada', 'Semanal ou mensal, por negócio', 'Link de cada relatório pronto para repassar'] },
]

export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']

export type DadosCheckout = {
  plano: CodigoPlano
  nome: string
  email: string
  telefone: string
  documento: string
  numero_cartao: string
  nome_cartao: string
  validade: string
  cvv: string
  termos_aceite: boolean
  endereco: { cep: string; rua: string; numero: string; complemento: string; bairro: string; cidade: string; uf: string }
}

const digitos = (v: string) => v.replace(/\D/g, '')
const limpo = (v: string) => v.trim().replace(/\s+/g, ' ')

export function validar(d: DadosCheckout): string[] {
  const erros: string[] = []
  if (limpo(d.nome).length < 2) erros.push('Informe seu nome completo.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) erros.push('Informe um e-mail válido.')
  const tel = digitos(d.telefone)
  if (tel.length < 10 || tel.length > 11) erros.push('Informe o WhatsApp com DDD (10 ou 11 dígitos).')
  const doc = digitos(d.documento)
  if (doc.length !== 11 && doc.length !== 14) erros.push('Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).')
  const num = digitos(d.numero_cartao)
  if (num.length < 13 || num.length > 19) erros.push('Confira o número do cartão.')
  if (limpo(d.nome_cartao).length < 2) erros.push('Informe o nome impresso no cartão.')
  if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(d.validade.trim())) erros.push('Informe a validade no formato MM/AA.')
  const cvv = digitos(d.cvv)
  if (cvv.length < 3 || cvv.length > 4) erros.push('Informe o CVV (3 ou 4 dígitos).')
  const e = d.endereco
  if (digitos(e.cep).length !== 8 || limpo(e.rua).length < 2 || !limpo(e.numero) || limpo(e.bairro).length < 2
    || limpo(e.cidade).length < 2 || !UFS.includes(e.uf.trim().toUpperCase())) {
    erros.push('Confira o endereço de cobrança do cartão (CEP com 8 dígitos, rua, número, bairro, cidade e UF).')
  }
  if (!d.termos_aceite) erros.push('Para assinar, aceite os Termos e a Política de Privacidade.')
  return erros
}

// Corpo do POST para assinatura-auditor: exatamente estas chaves, nunca dados do cartão.
export function montarPedido(d: DadosCheckout, cardToken: string) {
  const e = d.endereco
  return {
    plano: d.plano,
    nome: limpo(d.nome),
    email: d.email.trim(),
    documento: digitos(d.documento),
    telefone: digitos(d.telefone),
    card_token: cardToken,
    termos_aceite: true,
    aceite_texto: TEXTO_ACEITE,
    endereco: {
      cep: digitos(e.cep), rua: limpo(e.rua), numero: limpo(e.numero), complemento: limpo(e.complemento),
      bairro: limpo(e.bairro), cidade: limpo(e.cidade), uf: e.uf.trim().toUpperCase(),
    },
  }
}

export async function tokenizarCartao(d: DadosCheckout, publicKey: string, f: typeof fetch = fetch): Promise<string> {
  const [mes, ano] = d.validade.trim().split('/')
  try {
    const r = await f(`https://api.pagar.me/core/v5/tokens?appId=${encodeURIComponent(publicKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'card', card: {
        number: digitos(d.numero_cartao), holder_name: limpo(d.nome_cartao),
        exp_month: Number.parseInt(mes, 10), exp_year: Number.parseInt(`20${ano}`, 10), cvv: digitos(d.cvv),
      } }),
    })
    const j = await r.json().catch(() => null) as { id?: string } | null
    if (!r.ok || !j?.id) throw new Error('CARTAO')
    return j.id
  } catch {
    throw new Error('CARTAO')
  }
}

export function mensagemResultado(resp: { ok?: boolean; status?: string; error_code?: string; mensagem?: string } | null): { ok: boolean; texto: string } {
  if (resp?.ok) {
    return resp.status === 'paga'
      ? { ok: true, texto: 'Assinatura confirmada. Seus relatórios seguem o ritmo do plano escolhido.' }
      : { ok: true, texto: 'Recebemos sua assinatura. A confirmação do pagamento chega em instantes.' }
  }
  return { ok: false, texto: resp?.mensagem ?? 'Não deu para concluir agora. Tente de novo em alguns minutos.' }
}
