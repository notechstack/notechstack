-- Agente fiscal (lote A): conta, números, modelos, pedidos, teste grátis, papel do cadastro do
-- A1 e o estado da assinatura que o motor enxerga. Formas literais no Landing de
-- .checks/agente-fiscal-whatsapp.md. Só acrescenta: nada do motor muda de forma.
-- Como no motor, a migração não cria senha: o login de nofiscal_onboarding é ligado à mão.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nofiscal_onboarding') then
    create role nofiscal_onboarding nologin noinherit;
  end if;
end;
$$;
grant usage on schema nofiscal to nofiscal_onboarding;

-- ---------------------------------------------------------------------------------------
-- Tenant ligado à conta da Nó (Decided "Tenant ligado à conta da Nó") e configuração fiscal.
alter table nofiscal.fiscal_tenants
  add column client_id uuid unique references public.clients(id) on delete restrict,
  add column contador_email text
    check (length(contador_email) <= 254 and contador_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  add column cnae text check (cnae ~ '^[0-9]{7}$'),
  add column codigo_servico_nacional text check (codigo_servico_nacional ~ '^[0-9]{6}$'),
  add column trial_ends_at timestamptz;

comment on column nofiscal.fiscal_tenants.client_id is 'Conta da Nó (public.clients) do emitente self-service; nulo nos tenants por chave de API.';
comment on column nofiscal.fiscal_tenants.contador_email is 'E-mail do contador que recebe as cópias no Pro.';
comment on column nofiscal.fiscal_tenants.trial_ends_at is 'Fim do teste de 7 dias; gravado pelo registro da assinatura.';

-- ---------------------------------------------------------------------------------------
-- Conta do agente: confirmação de e-mail e WhatsApp, e quem é o dono do tenant.
create table nofiscal.fiscal_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (length(email) <= 254 and email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  -- Dono: memberships.role só admite 'CLIENT', então o dono do tenant é marcado aqui.
  client_id uuid unique references public.clients(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Números autorizados (Decided "Número pertence a um tenant"): UNIQUE literal, revogados inclusive.
create table nofiscal.fiscal_phones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  role text not null default 'authorized' check (role in ('owner', 'authorized')),
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint fiscal_phones_owner_not_revoked check (not (role = 'owner' and revoked_at is not null))
);
create index fiscal_phones_tenant_idx on nofiscal.fiscal_phones (tenant_id);
create unique index fiscal_phones_one_owner_idx on nofiscal.fiscal_phones (tenant_id) where role = 'owner';

-- Códigos de confirmação: 6 dígitos, 10 minutos (Unresolved 17). Só o hash é gravado.
create table nofiscal.fiscal_verification_codes (
  id uuid primary key default gen_random_uuid(),
  purpose text not null check (purpose in ('account_email', 'account_phone', 'phone_authorization')),
  user_id uuid references nofiscal.fiscal_accounts(user_id) on delete cascade,
  phone_id uuid references nofiscal.fiscal_phones(id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  attempts smallint not null default 0 check (attempts between 0 and 5),
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint fiscal_verification_codes_owner check (
    case when purpose = 'phone_authorization'
         then phone_id is not null and user_id is null
         else user_id is not null and phone_id is null
    end)
);
create index fiscal_verification_codes_user_idx on nofiscal.fiscal_verification_codes (user_id, purpose);
create index fiscal_verification_codes_phone_idx on nofiscal.fiscal_verification_codes (phone_id);

-- Modelos (Decided "Modelo único por tenant"): nascem de uma nota emitida.
create table nofiscal.fiscal_models (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  nome text not null check (length(trim(nome)) between 1 and 60),
  tomador_documento text not null check (tomador_documento ~ '^([0-9]{11}|[0-9]{14})$'),
  tomador_nome text not null check (length(trim(tomador_nome)) between 1 and 150),
  tomador_email text
    check (length(tomador_email) <= 254 and tomador_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  tomador_whatsapp text check (tomador_whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  codigo_servico_nacional text not null check (codigo_servico_nacional ~ '^[0-9]{6}$'),
  descricao text not null check (length(trim(descricao)) between 1 and 2000),
  valor_padrao numeric(15, 2) check (valor_padrao > 0),
  created_from_invoice_id uuid not null references nofiscal.fiscal_invoices(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index fiscal_models_tenant_nome_idx on nofiscal.fiscal_models (tenant_id, lower(nome));

-- Pedidos vindos do WhatsApp (estados da seção States da tarefa).
create table nofiscal.fiscal_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  phone_id uuid not null references nofiscal.fiscal_phones(id) on delete restrict,
  kind text not null check (kind in ('emitir', 'cancelar')),
  status text not null default 'awaiting_confirmation'
    check (status in ('awaiting_confirmation', 'confirmed', 'expired', 'rejected_by_user')),
  -- Só a IA preenche (Decided "IA sem poder de emitir"): tomador, documento, valor, modelo, intencao.
  parsed jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  invoice_id uuid references nofiscal.fiscal_invoices(id) on delete restrict,
  confirmed_at timestamptz,
  message_count integer not null default 0 check (message_count >= 0),
  ai_input_tokens integer not null default 0 check (ai_input_tokens >= 0),
  ai_output_tokens integer not null default 0 check (ai_output_tokens >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index fiscal_requests_phone_idx on nofiscal.fiscal_requests (phone_id, created_at desc);
create index fiscal_requests_tenant_idx on nofiscal.fiscal_requests (tenant_id, created_at desc);
create index fiscal_requests_awaiting_idx on nofiscal.fiscal_requests (expires_at)
  where status = 'awaiting_confirmation';

-- Bloqueio de novo teste (Decided "Bloqueio de novo teste"): só o hash, nunca o valor.
create table nofiscal.fiscal_trial_claims (
  kind text not null check (kind in ('cpf', 'cnpj', 'email', 'phone')),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint fiscal_trial_claims_kind_hash_key unique (kind, hash)
);

-- Assinatura no molde de auditor_assinaturas (ordem dos avisos, aceite dos Termos).
create table nofiscal.fiscal_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  plano text not null check (plano in ('inicial', 'pro')),
  com_teste boolean not null,
  pagarme_customer_id text,
  pagarme_subscription_id text not null unique,
  status text not null default 'pendente' check (status in ('pendente', 'paga', 'recusada', 'cancelada')),
  aceite_em timestamptz not null,
  aceite_texto text not null check (char_length(aceite_texto) between 1 and 500),
  ultimo_evento_tipo text,
  ultimo_evento_em timestamptz,
  ultimo_evento_gateway_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index fiscal_subscriptions_current_idx on nofiscal.fiscal_subscriptions (tenant_id)
  where status <> 'cancelada';

create table nofiscal.fiscal_subscription_events (
  gateway_event_id text primary key,
  tipo text not null,
  pagarme_subscription_id text,
  status_aplicado text check (status_aplicado in ('paga', 'recusada', 'cancelada')),
  payload jsonb,
  evento_em timestamptz,
  recebido_em timestamptz not null default now()
);
create index fiscal_subscription_events_sub_idx
  on nofiscal.fiscal_subscription_events (pagarme_subscription_id, recebido_em);

-- Tentativas da rota do certificado: 5 por hora por tenant (Unresolved 17).
create table nofiscal.fiscal_certificate_attempts (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index fiscal_certificate_attempts_tenant_idx
  on nofiscal.fiscal_certificate_attempts (tenant_id, attempted_at);

-- ---------------------------------------------------------------------------------------
-- Acesso. RLS em todas, como no motor; o grant decide o que cada papel faz.
alter table nofiscal.fiscal_accounts enable row level security;
alter table nofiscal.fiscal_phones enable row level security;
alter table nofiscal.fiscal_verification_codes enable row level security;
alter table nofiscal.fiscal_models enable row level security;
alter table nofiscal.fiscal_requests enable row level security;
alter table nofiscal.fiscal_trial_claims enable row level security;
alter table nofiscal.fiscal_subscriptions enable row level security;
alter table nofiscal.fiscal_subscription_events enable row level security;
alter table nofiscal.fiscal_certificate_attempts enable row level security;

revoke all on all tables in schema nofiscal from public, anon, authenticated, service_role;

grant select, insert, update on nofiscal.fiscal_accounts, nofiscal.fiscal_verification_codes,
  nofiscal.fiscal_phones, nofiscal.fiscal_requests to nofiscal_service;
grant select, insert, update, delete on nofiscal.fiscal_models to nofiscal_service;
grant select on nofiscal.fiscal_subscriptions to nofiscal_service;
-- No tenant, o motor só grava o e-mail do contador; `active` e a configuração seguem negados.
grant update (contador_email, updated_at) on nofiscal.fiscal_tenants to nofiscal_service;

create policy nofiscal_service_all on nofiscal.fiscal_accounts
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_verification_codes
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_phones
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_models
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_requests
  for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_read on nofiscal.fiscal_subscriptions
  for select to nofiscal_service using (true);
create policy nofiscal_service_update_contador on nofiscal.fiscal_tenants
  for update to nofiscal_service using (true) with check (true);

-- ---------------------------------------------------------------------------------------
-- Estado visto pelo motor (nofiscal_service).

-- Número que emite: verificado e não revogado (critério 4).
create function nofiscal.emitting_phone(p_phone_e164 text)
returns table (phone_id uuid, tenant_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select p.id, p.tenant_id
    from nofiscal.fiscal_phones p
   where p.phone_e164 = p_phone_e164
     and p.verified_at is not null
     and p.revoked_at is null;
$$;

-- Emissão real liberada? null = sim; senão o primeiro motivo, na ordem abaixo.
create function nofiscal.emission_block(p_tenant_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tenant record;
  v_not_after timestamptz;
  v_status text;
begin
  select t.active, t.codigo_servico_nacional, t.p_tot_trib_sn, t.trial_ends_at
    into v_tenant
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id;
  if not found then
    return 'TENANT_NOT_FOUND';
  end if;
  if not v_tenant.active then
    return 'TENANT_INACTIVE';
  end if;
  if v_tenant.codigo_servico_nacional is null or v_tenant.p_tot_trib_sn is null then
    return 'FISCAL_CONFIG_MISSING';
  end if;

  select c.not_after into v_not_after from nofiscal.fiscal_certificates c where c.tenant_id = p_tenant_id;
  if not found then
    return 'CERT_MISSING';
  end if;
  if v_not_after <= now() then
    return 'CERT_EXPIRED';
  end if;

  select s.status into v_status
    from nofiscal.fiscal_subscriptions s
   where s.tenant_id = p_tenant_id
   order by (s.status <> 'cancelada') desc, s.created_at desc
   limit 1;
  if not found then
    return 'NO_SUBSCRIPTION';
  end if;
  if v_status = 'paga' then
    return null;
  end if;
  if v_status = 'cancelada' then
    return 'SUBSCRIPTION_CANCELLED';
  end if;
  if v_status = 'pendente' and v_tenant.trial_ends_at > now() then
    return null;
  end if;
  return 'PAYMENT_NOT_APPROVED';
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Papel do cadastro (Decided "Papel do cadastro"). Devolvem um código em vez de levantar
-- erro, para a tentativa registrada sobreviver ao 422 (Landing, rota do certificado).

create function nofiscal.onboarding_set_certificate(
  p_user_id uuid, p_tenant_id uuid, p_pfx_base64 text, p_senha text, p_subject text, p_not_after timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cnpj text;
  v_attempts integer;
begin
  select t.cnpj into v_cnpj
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id
     and t.client_id is not null
     and exists (
       select 1 from public.memberships m
        where m.client_id = t.client_id and m.user_id = p_user_id);
  if not found then
    return 'FORBIDDEN';
  end if;

  -- Uma tentativa por vez por tenant: duas simultâneas não passam juntas do limite.
  perform pg_advisory_xact_lock(hashtextextended('nofiscal_onboarding_certificate:' || p_tenant_id::text, 0));
  select count(*) into v_attempts
    from nofiscal.fiscal_certificate_attempts a
   where a.tenant_id = p_tenant_id
     and a.attempted_at > now() - interval '1 hour';
  if v_attempts >= 5 then
    return 'RATE_LIMITED';
  end if;
  insert into nofiscal.fiscal_certificate_attempts (tenant_id, user_id) values (p_tenant_id, p_user_id);

  if coalesce(p_pfx_base64, '') = '' or p_senha is null or coalesce(p_subject, '') = '' or p_not_after is null then
    return 'INVALID';
  end if;
  if p_not_after <= now() then
    return 'CERT_VENCIDO';
  end if;
  -- e-CNPJ ICP-Brasil: o CN é "NOME:CNPJ". O CNPJ do tenant tem de aparecer inteiro.
  if p_subject !~ ('(^|[^0-9])' || v_cnpj || '([^0-9]|$)') then
    return 'CERT_CNPJ_DIFERENTE';
  end if;

  perform nofiscal.upsert_certificate(p_tenant_id, p_pfx_base64, p_senha, p_subject, p_not_after);
  return 'OK';
end;
$$;

create function nofiscal.onboarding_delete_certificate(p_user_id uuid, p_tenant_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
begin
  if not exists (
    select 1
      from nofiscal.fiscal_tenants t
      join public.memberships m on m.client_id = t.client_id
     where t.id = p_tenant_id and m.user_id = p_user_id
  ) then
    return 'FORBIDDEN';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('nofiscal_onboarding_certificate:' || p_tenant_id::text, 0));
  delete from nofiscal.fiscal_certificates c
   where c.tenant_id = p_tenant_id
  returning c.vault_secret_id into v_secret_id;
  if v_secret_id is not null then
    delete from vault.secrets s where s.id = v_secret_id;
  end if;
  return 'OK';
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Edge functions (service_role) → nofiscal. Só estas quatro funções atravessam.

-- Contexto do checkout: tenant do dono (conta ativa), dados para o Pagar.me e assinatura atual.
create function public.fiscal_assinatura_contexto(p_user_id uuid)
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
     and a.email_verified_at is not null
     and a.phone_verified_at is not null;
$$;

-- Reivindica o teste: true grava todos os hashes; false (algum já usado) não grava nada.
create function public.fiscal_reivindicar_teste(p_tenant_id uuid, p_hashes jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from nofiscal.fiscal_tenants t where t.id = p_tenant_id) then
    raise exception 'NOFISCAL_TENANT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_hashes is null or jsonb_typeof(p_hashes) <> 'object'
     or not (p_hashes ?& array['cnpj', 'email', 'phone'])
     or exists (select 1 from jsonb_object_keys(p_hashes) k where k not in ('cpf', 'cnpj', 'email', 'phone'))
     or exists (select 1 from jsonb_each(p_hashes) h where jsonb_typeof(h.value) <> 'string') then
    raise exception 'NOFISCAL_TRIAL_HASHES_INVALID' using errcode = '22023';
  end if;

  -- Duas reivindicações com o mesmo valor ao mesmo tempo: só uma ganha o teste.
  perform pg_advisory_xact_lock(hashtextextended('nofiscal_trial_claims', 0));
  if exists (
    select 1
      from jsonb_each_text(p_hashes) h
      join nofiscal.fiscal_trial_claims c on c.kind = h.key and c.hash = h.value
  ) then
    return false;
  end if;
  insert into nofiscal.fiscal_trial_claims (kind, hash)
  select h.key, h.value from jsonb_each_text(p_hashes) h;
  return true;
end;
$$;

-- Registra a assinatura criada no checkout (pendente ou recusada; "paga" só vem do aviso).
-- Grava trial_ends_at, plano e limite no tenant e reconcilia avisos que chegaram antes.
create function public.fiscal_registrar_assinatura(
  p_tenant_id uuid,
  p_plano text,
  p_com_teste boolean,
  p_trial_ends_at timestamptz,
  p_customer_id text,
  p_subscription_id text,
  p_status text,
  p_aceite_texto text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_status text;
  v_evento record;
  v_gateway_em timestamptz;
  v_reconciliada boolean := false;
begin
  if p_subscription_id is null or p_tenant_id is null or p_com_teste is null then
    raise exception 'fiscal_registrar_assinatura: parametro obrigatorio ausente' using errcode = '22023';
  end if;
  if p_plano is null or p_plano not in ('inicial', 'pro') then
    raise exception 'fiscal_registrar_assinatura: plano invalido' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('pendente', 'recusada') then
    raise exception 'fiscal_registrar_assinatura: status invalido' using errcode = '22023';
  end if;
  if p_aceite_texto is null or btrim(p_aceite_texto) = '' then
    raise exception 'fiscal_registrar_assinatura: aceite obrigatorio' using errcode = '22023';
  end if;
  if p_com_teste and p_trial_ends_at is null then
    raise exception 'fiscal_registrar_assinatura: fim do teste obrigatorio' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('fiscal_assinatura:' || p_subscription_id, 0));

  insert into nofiscal.fiscal_subscriptions
    (tenant_id, plano, com_teste, pagarme_customer_id, pagarme_subscription_id, status, aceite_em, aceite_texto)
  values
    (p_tenant_id, p_plano, p_com_teste, p_customer_id, p_subscription_id, p_status, now(), p_aceite_texto)
  returning id, status into v_id, v_status;

  update nofiscal.fiscal_tenants
     set plan = p_plano,
         monthly_note_limit = case p_plano when 'pro' then 100 else 20 end,
         trial_ends_at = case when p_com_teste then p_trial_ends_at else trial_ends_at end,
         updated_at = now()
   where id = p_tenant_id;

  select e.tipo, e.status_aplicado, e.recebido_em
    into v_evento
    from nofiscal.fiscal_subscription_events e
   where e.pagarme_subscription_id = p_subscription_id
     and e.status_aplicado is not null
   order by (e.status_aplicado = 'cancelada') desc,
            coalesce(e.evento_em, e.recebido_em) desc,
            e.recebido_em desc
   limit 1;

  if found then
    select max(coalesce(e.evento_em, e.recebido_em))
      into v_gateway_em
      from nofiscal.fiscal_subscription_events e
     where e.pagarme_subscription_id = p_subscription_id
       and e.status_aplicado is not null;

    update nofiscal.fiscal_subscriptions
       set status = v_evento.status_aplicado,
           ultimo_evento_tipo = v_evento.tipo,
           ultimo_evento_em = v_evento.recebido_em,
           ultimo_evento_gateway_em = v_gateway_em,
           updated_at = now()
     where id = v_id
    returning status into v_status;
    v_reconciliada := true;
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status, 'reconciliada', v_reconciliada);
end;
$$;

-- Aplica um aviso do Pagar.me, com a ordem e a idempotência de aplicar_evento_assinatura_auditor.
create function public.fiscal_aplicar_evento_assinatura(
  p_gateway_event_id text,
  p_tipo text,
  p_subscription_id text,
  p_status text,
  p_payload jsonb,
  p_evento_em timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_novos int;
  v_evento_em timestamptz := coalesce(p_evento_em, now());
  v_atual record;
begin
  if p_gateway_event_id is null or p_tipo is null then
    raise exception 'fiscal_aplicar_evento_assinatura: parametro obrigatorio ausente' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('paga', 'recusada', 'cancelada') then
    raise exception 'fiscal_aplicar_evento_assinatura: status invalido' using errcode = '22023';
  end if;
  if p_subscription_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('fiscal_assinatura:' || p_subscription_id, 0));
  end if;

  insert into nofiscal.fiscal_subscription_events
    (gateway_event_id, tipo, pagarme_subscription_id, status_aplicado, payload, evento_em)
  values (p_gateway_event_id, p_tipo, p_subscription_id, p_status, p_payload, p_evento_em)
  on conflict do nothing;
  get diagnostics v_novos = row_count;

  if v_novos = 0 then
    return jsonb_build_object('applied', false, 'duplicado', true);
  end if;
  if p_status is null then
    return jsonb_build_object('applied', false, 'duplicado', false, 'status', null);
  end if;

  select s.id, s.status, s.ultimo_evento_gateway_em
    into v_atual
    from nofiscal.fiscal_subscriptions s
   where s.pagarme_subscription_id = p_subscription_id
   for update;

  if not found then
    return jsonb_build_object('applied', true, 'duplicado', false, 'status', p_status, 'encontrada', false);
  end if;
  if v_atual.status = 'cancelada' then
    return jsonb_build_object('applied', false, 'duplicado', false, 'ignorado', 'cancelada_final');
  end if;
  if p_status <> 'cancelada'
     and v_atual.ultimo_evento_gateway_em is not null
     and v_evento_em < v_atual.ultimo_evento_gateway_em then
    return jsonb_build_object('applied', false, 'duplicado', false, 'ignorado', 'fora_de_ordem');
  end if;

  update nofiscal.fiscal_subscriptions
     set status = p_status,
         ultimo_evento_tipo = p_tipo,
         ultimo_evento_em = now(),
         ultimo_evento_gateway_em = greatest(ultimo_evento_gateway_em, v_evento_em),
         updated_at = now()
   where id = v_atual.id;

  return jsonb_build_object('applied', true, 'duplicado', false, 'status', p_status, 'encontrada', true);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- EXECUTE: funções novas nascem com EXECUTE para PUBLIC; tira de todos e devolve a quem usa.
revoke all on function nofiscal.emitting_phone(text) from public, anon, authenticated, service_role;
revoke all on function nofiscal.emission_block(uuid) from public, anon, authenticated, service_role;
revoke all on function nofiscal.onboarding_set_certificate(uuid, uuid, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function nofiscal.onboarding_delete_certificate(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.fiscal_assinatura_contexto(uuid) from public, anon, authenticated;
revoke all on function public.fiscal_reivindicar_teste(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.fiscal_registrar_assinatura(uuid, text, boolean, timestamptz, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.fiscal_aplicar_evento_assinatura(text, text, text, text, jsonb, timestamptz)
  from public, anon, authenticated;

grant execute on function nofiscal.emitting_phone(text) to nofiscal_service;
grant execute on function nofiscal.emission_block(uuid) to nofiscal_service;
grant execute on function nofiscal.onboarding_set_certificate(uuid, uuid, text, text, text, timestamptz)
  to nofiscal_onboarding;
grant execute on function nofiscal.onboarding_delete_certificate(uuid, uuid) to nofiscal_onboarding;
grant execute on function public.fiscal_assinatura_contexto(uuid) to service_role;
grant execute on function public.fiscal_reivindicar_teste(uuid, jsonb) to service_role;
grant execute on function public.fiscal_registrar_assinatura(uuid, text, boolean, timestamptz, text, text, text, text)
  to service_role;
grant execute on function public.fiscal_aplicar_evento_assinatura(text, text, text, text, jsonb, timestamptz)
  to service_role;
