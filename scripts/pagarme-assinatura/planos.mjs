// Planos da assinatura do Auditor no Pagar.me (API v5, POST /plans).
// Fonte conferida em 16/10/2026: https://docs.pagar.me/reference/criar-plano-1
//   - só `name` é obrigatório no corpo; os demais nomes usados aqui batem com a doc;
//   - `items[].quantity` é obrigatório quando `pricing_scheme.scheme_type` = 'unit' (incluído).
// Valores e códigos: CONTRATO.md, seção "Planos (códigos fixos)".

export const PLANOS = [
  { codigo: 'mensal', nome: 'Auditor Mensal', centavos: 4700, env: 'PAGARME_PLANO_MENSAL_ID' },
  { codigo: 'semanal', nome: 'Auditor Semanal', centavos: 9700, env: 'PAGARME_PLANO_SEMANAL_ID' },
  { codigo: 'agencia', nome: 'Auditor Agência', centavos: 19700, env: 'PAGARME_PLANO_AGENCIA_ID' }
];

export function corpoDoPlano(p) {
  return {
    name: p.nome,
    description: `Assinatura ${p.nome} · nó tech stack`,
    interval: 'month',
    interval_count: 1,
    billing_type: 'prepaid',
    payment_methods: ['credit_card'],
    installments: [1],
    currency: 'BRL',
    statement_descriptor: 'NOAUDITOR',
    items: [
      {
        name: p.nome,
        quantity: 1,
        pricing_scheme: { scheme_type: 'unit', price: p.centavos }
      }
    ],
    metadata: { origem: 'auditor', codigo: p.codigo }
  };
}
