-- Agente fiscal v2, lote C (WhatsApp): ativação, boas-vindas, comandos, resumo configurável e
-- operação. Formas literais no Landing de .checks/agente-fiscal-v2.md, linhas "(lote C)". Só
-- acrescenta: nada que a v1 ou a migração-base gravam deixa de valer.

-- Estado das boas-vindas e do comando pendente, gravado só pelo código do agente.
alter table nofiscal.fiscal_tenants
  add column agente_conversa jsonb not null default '{}'::jsonb
    check (jsonb_typeof(agente_conversa) = 'object');

comment on column nofiscal.fiscal_tenants.agente_conversa is
  'Estado da conversa do agente fora dos pedidos: boas-vindas e comando pendente (Landing, lote C).';

-- Contrato B → C (configuração pelo WhatsApp) mais o estado acima. O resto do tenant segue negado.
grant select (agente_conversa) on nofiscal.fiscal_tenants to nofiscal_service;
grant update (resumo_frequencia, resumo_dia, onboarding_etapa, agente_conversa, updated_at)
  on nofiscal.fiscal_tenants to nofiscal_service;

-- O cliente frequente salvo nas boas-vindas não nasce de nota nem de importação.
alter table nofiscal.fiscal_models
  drop constraint fiscal_models_origem_check,
  add constraint fiscal_models_origem_check
    check (origem in ('nota', 'importacao_adn', 'importacao_pdf', 'boas_vindas'));

-- Lista diária de abandono: o responsável vive em auth.users (forma do lote A), que o motor não lê.
create function nofiscal.lista_de_abandono(p_pago_ate timestamptz)
returns table (
  tenant_id uuid,
  razao_social text,
  responsavel text,
  telefone text,
  plano text,
  etapa text,
  trial_ends_at timestamptz,
  pago_em timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id,
         t.razao_social,
         coalesce(nullif(trim(u.raw_user_meta_data->>'responsavel'), ''), a.email),
         a.phone_e164,
         t.plan,
         t.onboarding_etapa,
         t.trial_ends_at,
         t.pago_em
    from nofiscal.fiscal_tenants t
    left join nofiscal.fiscal_accounts a on a.client_id = t.client_id
    left join auth.users u on u.id = a.user_id
   where t.client_id is not null
     and t.pago_em is not null
     and t.pago_em <= p_pago_ate
     and t.onboarding_etapa <> 'concluido'
   order by t.pago_em, t.id;
$$;

revoke all on function nofiscal.lista_de_abandono(timestamptz) from public, anon, authenticated, service_role;
grant execute on function nofiscal.lista_de_abandono(timestamptz) to nofiscal_service;

-- Agendador do worker: a cada minuto, com a URL e o segredo do Vault; sem os dois, nada.
create function nofiscal.invocar_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'nofiscal_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'NOFISCAL_CRON_SECRET';
  if coalesce(v_url, '') = '' or coalesce(v_secret, '') = '' then
    return null;
  end if;

  return net.http_post(
    url := rtrim(v_url, '/') || '/api/internal/nfse-worker',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    timeout_milliseconds := 55000
  );
end;
$$;

revoke all on function nofiscal.invocar_worker() from public, anon, authenticated, service_role;

create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'nofiscal-worker') then
    perform cron.unschedule('nofiscal-worker');
  end if;
end;
$$;

select cron.schedule(
  'nofiscal-worker',
  '* * * * *',
  $$select nofiscal.invocar_worker()$$
);
