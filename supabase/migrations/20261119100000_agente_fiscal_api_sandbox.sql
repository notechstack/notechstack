-- Sandbox da API do parceiro (19/11/2026): chave `nfk_test_…` que exercita as mesmas rotas de NFS-e sem Sefin, sem
-- certificado e sem risco fiscal. Tudo em tabelas próprias, que o motor (worker, painel, relatórios, franquia,
-- numeração de DPS) não lê:
--
-- 1. `fiscal_sandbox_contas`: uma linha por conta-mãe com chave sandbox (sha256 + prefixo) e o webhook sandbox
--    (URL e segredo no Supabase Vault, separados do webhook de produção).
-- 2. `fiscal_sandbox_invoices`: as notas simuladas. Status e chave de acesso avançam por simulação
--    (app/api/_lib/sandbox/), com a DPS montada pelo mesmo `buildDps` da produção.
-- 3. `fiscal_sandbox_webhook_entregas`: eventos das notas simuladas para o webhook sandbox.
--
-- A chave é gerada fora do banco (scripts/nofiscal-sandbox/gerar-chave.mjs) e chega aqui só como hash, por
-- `public.fiscal_definir_chave_sandbox` (service_role).

-- ------------------------------------------------------------ Contas com sandbox

create table nofiscal.fiscal_sandbox_contas (
  dono_tenant_id uuid primary key references nofiscal.fiscal_tenants (id) on delete cascade,
  api_key_hash text unique check (api_key_hash ~ '^[0-9a-f]{64}$'),
  api_key_prefixo text check (api_key_prefixo ~ '^nfk_test_[A-Za-z0-9_-]{6}$'),
  api_key_gerada_em timestamptz,
  webhook_url text check (webhook_url is null or webhook_url ~ '^https://'),
  webhook_secret_vault_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table nofiscal.fiscal_sandbox_contas is
  'Chave sandbox (nfk_test_, só o sha256) e webhook sandbox de uma conta-mãe. Nada aqui chega à Sefin.';

alter table nofiscal.fiscal_sandbox_contas enable row level security;
revoke all on nofiscal.fiscal_sandbox_contas from public, anon, authenticated, service_role;
grant select on nofiscal.fiscal_sandbox_contas to nofiscal_service;
grant update (webhook_url, updated_at) on nofiscal.fiscal_sandbox_contas to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_sandbox_contas
  for all to nofiscal_service using (true) with check (true);

-- ------------------------------------------------------------ Notas simuladas

create table nofiscal.fiscal_sandbox_invoices (
  id uuid primary key default gen_random_uuid(),
  -- Conta-mãe dona da chave sandbox: GET e cancelamento só enxergam notas dela.
  dono_tenant_id uuid not null references nofiscal.fiscal_tenants (id) on delete cascade,
  -- Empresa da conta que "emitiu" (cnpj_prestador); a idempotência é por empresa, como na produção.
  tenant_id uuid not null references nofiscal.fiscal_tenants (id) on delete cascade,
  external_id text not null check (char_length(external_id) between 1 and 100),
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'issued', 'rejected', 'cancel_requested', 'cancelled', 'skipped')),
  -- O que a simulação fará quando `avanca_em` chegar (valores mágicos documentados no README da API).
  roteiro text not null default 'emitir'
    check (roteiro in ('emitir', 'recusar', 'sefin_fora', 'cancelamento_recusado', 'dps_invalida', 'tributos')),
  avanca_em timestamptz not null default now(),
  dps_numero bigint not null check (dps_numero > 0),
  id_dps text,
  xml_dps text,
  chave_acesso text,
  xml_nfse text,
  last_error_code text,
  last_error text,
  -- Erro de leiaute que o buildDps achou no POST: vira a recusa (DPS_INVALID) quando a simulação avança, como no worker.
  erro_previsto text,
  issued_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id),
  unique (tenant_id, dps_numero)
);
create index fiscal_sandbox_invoices_dono_idx on nofiscal.fiscal_sandbox_invoices (dono_tenant_id, created_at desc);
create index fiscal_sandbox_invoices_avanca_idx on nofiscal.fiscal_sandbox_invoices (dono_tenant_id, avanca_em)
  where status in ('queued', 'cancel_requested');
comment on table nofiscal.fiscal_sandbox_invoices is
  'NFS-e simuladas da chave sandbox. Numeração própria (não usa fiscal_dps_series), fora da franquia e do painel.';

alter table nofiscal.fiscal_sandbox_invoices enable row level security;
revoke all on nofiscal.fiscal_sandbox_invoices from public, anon, authenticated, service_role;
grant select, insert, update on nofiscal.fiscal_sandbox_invoices to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_sandbox_invoices
  for all to nofiscal_service using (true) with check (true);

-- ------------------------------------------------------------ Webhook sandbox

create table nofiscal.fiscal_sandbox_webhook_entregas (
  id uuid primary key default gen_random_uuid(),
  dono_tenant_id uuid not null references nofiscal.fiscal_tenants (id) on delete cascade,
  documento_id uuid not null references nofiscal.fiscal_sandbox_invoices (id) on delete cascade,
  evento text not null check (evento ~ '^nfse\.[a-z_]{3,40}$'),
  dados jsonb not null,
  status text not null default 'pendente' check (status in ('pendente', 'entregue', 'desistiu')),
  tentativas smallint not null default 0 check (tentativas between 0 and 20),
  proxima_em timestamptz not null default now(),
  ultimo_http integer,
  ultimo_erro text,
  entregue_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (documento_id, evento)
);
create index fiscal_sandbox_webhook_pendentes_idx on nofiscal.fiscal_sandbox_webhook_entregas (dono_tenant_id, proxima_em)
  where status = 'pendente';
comment on table nofiscal.fiscal_sandbox_webhook_entregas is
  'Eventos das notas sandbox para o webhook sandbox da conta (corpo com "ambiente": "sandbox").';

alter table nofiscal.fiscal_sandbox_webhook_entregas enable row level security;
revoke all on nofiscal.fiscal_sandbox_webhook_entregas from public, anon, authenticated, service_role;
grant select, insert, update on nofiscal.fiscal_sandbox_webhook_entregas to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_sandbox_webhook_entregas
  for all to nofiscal_service using (true) with check (true);

-- ------------------------------------------------------------ Funções

-- Gera (ou troca, ou revoga com p_hash nulo) a chave sandbox de uma conta-mãe. Chamada pelo script da nó com o hash
-- já calculado: a chave nunca passa pelo banco. As notas sandbox ficam, mesmo com a chave revogada.
create function public.fiscal_definir_chave_sandbox(p_dono_tenant_id uuid, p_hash text, p_prefixo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from nofiscal.fiscal_tenants t where t.id = p_dono_tenant_id and t.escritorio_tenant_id is null) then
    return jsonb_build_object('ok', false, 'erro', 'CONTA_NAO_ENCONTRADA');
  end if;
  if (p_hash is null) <> (p_prefixo is null) then
    raise exception 'fiscal_definir_chave_sandbox: hash e prefixo andam juntos' using errcode = '22023';
  end if;
  insert into nofiscal.fiscal_sandbox_contas as c (dono_tenant_id, api_key_hash, api_key_prefixo, api_key_gerada_em)
  values (p_dono_tenant_id, p_hash, p_prefixo, case when p_hash is null then null else now() end)
  on conflict (dono_tenant_id) do update
     set api_key_hash = excluded.api_key_hash,
         api_key_prefixo = excluded.api_key_prefixo,
         api_key_gerada_em = excluded.api_key_gerada_em,
         updated_at = now();
  return jsonb_build_object('ok', true, 'prefixo', p_prefixo);
end;
$$;
revoke all on function public.fiscal_definir_chave_sandbox(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fiscal_definir_chave_sandbox(uuid, text, text) to service_role;

-- Segredo do webhook sandbox (gerado no servidor, devolvido uma vez ao parceiro): no Vault, como o de produção.
create function nofiscal.set_sandbox_webhook_secret(p_dono_tenant_id uuid, p_secret text)
returns void
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
    from nofiscal.fiscal_sandbox_contas
   where dono_tenant_id = p_dono_tenant_id
   for update;
  if not found then
    raise exception 'NOFISCAL_SANDBOX_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_secret, 'nofiscal_sandbox_webhook_' || p_dono_tenant_id::text,
                                       'Segredo do webhook sandbox da conta ' || p_dono_tenant_id::text);
    update nofiscal.fiscal_sandbox_contas
       set webhook_secret_vault_id = v_secret_id, updated_at = now()
     where dono_tenant_id = p_dono_tenant_id;
  else
    perform vault.update_secret(v_secret_id, p_secret);
  end if;
end;
$$;

create function nofiscal.read_sandbox_webhook_secret(p_dono_tenant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret
    from nofiscal.fiscal_sandbox_contas c
    join vault.decrypted_secrets s on s.id = c.webhook_secret_vault_id
   where c.dono_tenant_id = p_dono_tenant_id;
$$;

revoke all on function nofiscal.set_sandbox_webhook_secret(uuid, text), nofiscal.read_sandbox_webhook_secret(uuid)
  from public, anon, authenticated, service_role;
grant execute on function nofiscal.set_sandbox_webhook_secret(uuid, text), nofiscal.read_sandbox_webhook_secret(uuid)
  to nofiscal_service;
