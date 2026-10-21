-- Agente fiscal v2 (.tasks/agente-fiscal-v2.md, Decided "Colunas novas"): onboarding pelo site,
-- ativação pelo código recebido no WhatsApp, resumo periódico do Pro, cancelamento agendado e
-- modelos importados. Só acrescenta ou afrouxa; nada que a v1 grava deixa de valer.

-- Onde o emitente está entre o pagamento e o "Pronto!" do WhatsApp.
alter table nofiscal.fiscal_tenants
  add column onboarding_etapa text not null default 'pagamento'
    check (onboarding_etapa in (
      'pagamento', 'certificado', 'dados_fiscais', 'clientes', 'ativacao',
      'boas_vindas_conferir', 'boas_vindas_cliente', 'boas_vindas_ensaio', 'concluido')),
  add column resumo_frequencia text check (resumo_frequencia in ('mensal', 'semanal')),
  add column resumo_dia smallint,
  add column pago_em timestamptz,
  add constraint fiscal_tenants_resumo_check check (
    (resumo_frequencia is null and resumo_dia is null)
    or (resumo_frequencia = 'mensal' and resumo_dia between 1 and 28)
    or (resumo_frequencia = 'semanal' and resumo_dia between 1 and 7));

comment on column nofiscal.fiscal_tenants.onboarding_etapa is 'Etapa do onboarding self-service (site e boas-vindas no WhatsApp); concluido libera os pedidos de nota.';
comment on column nofiscal.fiscal_tenants.resumo_dia is 'Mensal: dia do mês (1-28). Semanal: dia da semana ISO (1 = segunda).';
comment on column nofiscal.fiscal_tenants.pago_em is 'Quando o checkout foi aprovado (com ou sem teste); base da reserva de boas-vindas e da lista de abandono.';

-- Tenants por chave de API (Prontia, motor) não passam pelo onboarding.
update nofiscal.fiscal_tenants set onboarding_etapa = 'concluido' where client_id is null;

-- Cancelamento até o fim do período pago.
alter table nofiscal.fiscal_subscriptions
  add column cancelamento_agendado_para timestamptz,
  add column cancelamento_pedido_em timestamptz,
  add column cancelamento_origem text check (cancelamento_origem in ('site', 'whatsapp')),
  add constraint fiscal_subscriptions_cancelamento_check check (
    (cancelamento_agendado_para is null) = (cancelamento_pedido_em is null));

create index fiscal_subscriptions_cancelamento_idx on nofiscal.fiscal_subscriptions (cancelamento_agendado_para)
  where cancelamento_agendado_para is not null and status <> 'cancelada';

-- Modelos também nascem da importação (ADN ou PDF lido por IA).
alter table nofiscal.fiscal_models
  add column origem text not null default 'nota' check (origem in ('nota', 'importacao_adn', 'importacao_pdf')),
  add column tomador_endereco jsonb check (tomador_endereco is null or jsonb_typeof(tomador_endereco) = 'object'),
  alter column created_from_invoice_id drop not null,
  add constraint fiscal_models_origem_nota_check check ((origem = 'nota') = (created_from_invoice_id is not null));

-- Código de ativação recebido pelo WhatsApp (ATIVAR <código>), dono por user_id.
alter table nofiscal.fiscal_verification_codes
  drop constraint fiscal_verification_codes_purpose_check,
  add constraint fiscal_verification_codes_purpose_check
    check (purpose in ('account_email', 'account_phone', 'phone_authorization', 'whatsapp_activation'));

-- O checkout vem antes da ativação no WhatsApp: basta o e-mail confirmado.
create or replace function public.fiscal_assinatura_contexto(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'tenant_id', t.id,
           'cnpj', t.cnpj,
           'razao_social', t.razao_social,
           'email', a.email,
           'phone_e164', a.phone_e164,
           'trial_ends_at', t.trial_ends_at,
           'assinatura', (
             select jsonb_build_object(
                      'id', s.id, 'plano', s.plano, 'status', s.status, 'com_teste', s.com_teste,
                      'pagarme_subscription_id', s.pagarme_subscription_id)
               from nofiscal.fiscal_subscriptions s
              where s.tenant_id = t.id
              order by (s.status <> 'cancelada') desc, s.created_at desc
              limit 1))
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id
     and a.email_verified_at is not null;
$$;

revoke all on function public.fiscal_assinatura_contexto(uuid) from public, anon, authenticated;
grant execute on function public.fiscal_assinatura_contexto(uuid) to service_role;
