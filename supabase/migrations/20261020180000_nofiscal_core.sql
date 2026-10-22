-- Nó Fiscal: estado do motor de NFS-e Nacional, num schema privado fora da Data API.
-- O motor (Vercel, app/api) entra só como nofiscal_service. A migração não cria senha:
-- o login desse papel é ligado à mão, fora de qualquer arquivo.
create extension if not exists supabase_vault with schema vault;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nofiscal_service') then
    create role nofiscal_service nologin noinherit;
  end if;
end;
$$;

create schema if not exists nofiscal;
revoke all on schema nofiscal from public, anon, authenticated, service_role;
grant usage on schema nofiscal to nofiscal_service;

create table nofiscal.fiscal_tenants (
  id uuid primary key default gen_random_uuid(),
  cnpj text not null unique check (cnpj ~ '^[0-9]{14}$'),
  razao_social text not null check (length(trim(razao_social)) between 1 and 150),
  inscricao_municipal text,
  codigo_municipio_ibge text not null check (codigo_municipio_ibge ~ '^[0-9]{7}$'),
  regime text not null default 'simples' check (regime = 'simples'),
  ambiente text not null default 'producao_restrita' check (ambiente in ('producao_restrita', 'producao')),
  webhook_url text check (webhook_url ~ '^https://'),
  webhook_secret_vault_id uuid,
  api_key_hash text not null unique check (api_key_hash ~ '^[0-9a-f]{64}$'),
  plan text not null check (plan in ('inicial', 'pro', 'custom')),
  monthly_note_limit integer not null check (monthly_note_limit > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Um A1 por tenant. PFX e senha ficam no Supabase Vault; aqui só a referência.
create table nofiscal.fiscal_certificates (
  tenant_id uuid primary key references nofiscal.fiscal_tenants(id) on delete restrict,
  vault_secret_id uuid not null unique,
  subject text not null,
  not_after timestamptz not null,
  uploaded_at timestamptz not null default now()
);

-- A série nasce no cadastro, com o próximo número informado; nunca no primeiro uso.
create table nofiscal.fiscal_dps_series (
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  serie text not null check (length(trim(serie)) > 0),
  next_number bigint not null check (next_number > 0),
  primary key (tenant_id, serie)
);

create table nofiscal.fiscal_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  external_id text not null check (length(external_id) between 1 and 100),
  status text not null default 'queued' check (status in (
    'queued', 'signing', 'sent', 'issued', 'rejected', 'cancel_requested', 'cancelled', 'skipped'
  )),
  payload jsonb not null,
  dps_serie text,
  dps_numero bigint check (dps_numero > 0),
  id_dps text unique,
  chave_acesso text unique,
  xml_dps text,
  xml_nfse text,
  pdf_path text,
  last_error_code text,
  last_error text,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz,
  issued_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id),
  unique (tenant_id, dps_serie, dps_numero),
  check ((dps_serie is null) = (dps_numero is null))
);
create index fiscal_invoices_pending_idx on nofiscal.fiscal_invoices (status, next_attempt_at)
  where status in ('queued', 'signing', 'sent', 'cancel_requested');

create table nofiscal.fiscal_invoice_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references nofiscal.fiscal_invoices(id) on delete restrict,
  tipo text not null check (tipo = 'e101101'),
  status text not null default 'sent' check (status in ('sent', 'accepted', 'refused')),
  xml text,
  last_error_code text,
  created_at timestamptz not null default now()
);
create index fiscal_invoice_events_invoice_idx on nofiscal.fiscal_invoice_events (invoice_id);

-- RLS além do grant: papéis com pg_read_all_data ignoram grants de tabela, não RLS.
alter table nofiscal.fiscal_tenants enable row level security;
alter table nofiscal.fiscal_certificates enable row level security;
alter table nofiscal.fiscal_dps_series enable row level security;
alter table nofiscal.fiscal_invoices enable row level security;
alter table nofiscal.fiscal_invoice_events enable row level security;

revoke all on all tables in schema nofiscal from public, anon, authenticated, service_role;
grant select on nofiscal.fiscal_tenants, nofiscal.fiscal_certificates to nofiscal_service;
grant select, update on nofiscal.fiscal_dps_series to nofiscal_service;
grant select, insert, update on nofiscal.fiscal_invoices, nofiscal.fiscal_invoice_events to nofiscal_service;

create policy nofiscal_service_read on nofiscal.fiscal_tenants
  for select to nofiscal_service using (true);
create policy nofiscal_service_read on nofiscal.fiscal_certificates
  for select to nofiscal_service using (true);
create policy nofiscal_service_all on nofiscal.fiscal_dps_series
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_invoices
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_invoice_events
  for all to nofiscal_service using (true) with check (true);

-- Numeração: o UPDATE trava a linha da série até o fim da transação da emissão,
-- então duas emissões simultâneas recebem números diferentes.
create function nofiscal.allocate_dps_number(p_tenant_id uuid, p_serie text)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_number bigint;
begin
  update nofiscal.fiscal_dps_series
     set next_number = next_number + 1
   where tenant_id = p_tenant_id and serie = p_serie
  returning next_number - 1 into v_number;
  if v_number is null then
    raise exception 'NOFISCAL_SERIE_NOT_FOUND' using errcode = 'P0002';
  end if;
  return v_number;
end;
$$;

-- Leitura do A1: um tenant por chamada, só para o motor.
create function nofiscal.read_certificate(p_tenant_id uuid)
returns table (pfx_base64 text, password text, not_after timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select (s.decrypted_secret::jsonb) ->> 'pfx_base64',
         (s.decrypted_secret::jsonb) ->> 'password',
         c.not_after
    from nofiscal.fiscal_certificates c
    join vault.decrypted_secrets s on s.id = c.vault_secret_id
   where c.tenant_id = p_tenant_id;
$$;

create function nofiscal.read_webhook_secret(p_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret
    from nofiscal.fiscal_tenants t
    join vault.decrypted_secrets s on s.id = t.webhook_secret_vault_id
   where t.id = p_tenant_id;
$$;

-- Escrita do A1 e do segredo do callback: só o dono do schema (script local de Lucca).
create function nofiscal.upsert_certificate(
  p_tenant_id uuid, p_pfx_base64 text, p_password text, p_subject text, p_not_after timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_payload text;
begin
  if coalesce(p_pfx_base64, '') = '' or p_password is null or coalesce(p_subject, '') = '' or p_not_after is null then
    raise exception 'NOFISCAL_CERT_INVALID' using errcode = '22023';
  end if;
  v_payload := jsonb_build_object('pfx_base64', p_pfx_base64, 'password', p_password)::text;

  select vault_secret_id into v_secret_id
    from nofiscal.fiscal_certificates
   where tenant_id = p_tenant_id
   for update;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(v_payload, 'nofiscal_cert_' || p_tenant_id::text, 'A1 do tenant ' || p_tenant_id::text);
    insert into nofiscal.fiscal_certificates (tenant_id, vault_secret_id, subject, not_after)
    values (p_tenant_id, v_secret_id, p_subject, p_not_after);
  else
    perform vault.update_secret(v_secret_id, v_payload);
    update nofiscal.fiscal_certificates
       set subject = p_subject, not_after = p_not_after, uploaded_at = now()
     where tenant_id = p_tenant_id;
  end if;
  return v_secret_id;
end;
$$;

create function nofiscal.set_webhook_secret(p_tenant_id uuid, p_secret text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if coalesce(p_secret, '') = '' then
    raise exception 'NOFISCAL_WEBHOOK_SECRET_INVALID' using errcode = '22023';
  end if;

  select webhook_secret_vault_id into v_secret_id
    from nofiscal.fiscal_tenants
   where id = p_tenant_id
   for update;

  if not found then
    raise exception 'NOFISCAL_TENANT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_secret, 'nofiscal_webhook_' || p_tenant_id::text, 'Segredo do callback do tenant ' || p_tenant_id::text);
    update nofiscal.fiscal_tenants set webhook_secret_vault_id = v_secret_id, updated_at = now() where id = p_tenant_id;
  else
    perform vault.update_secret(v_secret_id, p_secret);
  end if;
  return v_secret_id;
end;
$$;

revoke all on all functions in schema nofiscal from public, anon, authenticated, service_role;
grant execute on function nofiscal.allocate_dps_number(uuid, text) to nofiscal_service;
grant execute on function nofiscal.read_certificate(uuid) to nofiscal_service;
grant execute on function nofiscal.read_webhook_secret(uuid) to nofiscal_service;
