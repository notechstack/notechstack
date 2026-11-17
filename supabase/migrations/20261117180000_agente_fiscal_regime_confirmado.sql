-- nó.fiscal: regime confirmado à mão (Lucca, 17/11/2026).
-- As bases públicas de CNPJ (BrasilAPI, CNPJá, ReceitaWS) podem errar o regime: para a Fácil Contabilidade
-- (16.605.959/0001-90) as três diziam "fora do Simples", e a Consulta Optantes oficial da Receita mostrava
-- "Optante pelo Simples Nacional desde 13/07/2012". A consulta oficial tem captcha e não é automatizável.
-- Esta tabela guarda o regime de um CNPJ confirmado por quem viu o documento oficial; a consulta do cadastro
-- usa este regime quando a base pública nega MEI e Simples. Situação ATIVA e município continuam vindo da
-- consulta pública. A Sefin segue como a prova final: DPS com regime errado é recusada.

create table nofiscal.fiscal_regime_confirmado (
  cnpj text primary key check (cnpj ~ '^[0-9]{14}$'),
  regime text not null check (regime in ('mei', 'simples')),
  fonte text not null check (char_length(fonte) between 3 and 200),
  confirmado_por text not null check (char_length(confirmado_por) between 2 and 120),
  confirmado_em timestamptz not null default now()
);

alter table nofiscal.fiscal_regime_confirmado enable row level security;
revoke all on nofiscal.fiscal_regime_confirmado from public, anon, authenticated;

create function public.fiscal_regime_confirmado(p_cnpj text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select regime from nofiscal.fiscal_regime_confirmado where cnpj = p_cnpj;
$$;

revoke all on function public.fiscal_regime_confirmado(text) from public, anon, authenticated;
grant execute on function public.fiscal_regime_confirmado(text) to service_role;
