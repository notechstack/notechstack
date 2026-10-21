-- Agente fiscal v2, lote A (.checks/agente-fiscal-v2.md, Landing "fiscal-acesso: forma",
-- "fiscal-cadastro: forma" e "Checkout no fluxo novo"): limite do código por e-mail, criação da
-- empresa self-service e marca de pagamento. Edge functions → banco só por funções public.fiscal_*
-- security definer, search_path = '', EXECUTE só para service_role.

-- Emitentes do agente fiscal têm origem própria em clients (não se misturam aos projetos da agência).
alter table public.clients drop constraint clients_origem_check,
  add constraint clients_origem_check check (origem in ('projeto', 'auditor', 'interno', 'fiscal'));

-- ------------------------------------------------------------ Limite do fiscal-acesso

create table public.fiscal_acesso_tentativas (
  id bigint generated always as identity primary key,
  chave_email text not null check (chave_email ~ '^[0-9a-f]{64}$'),
  chave_ip text not null check (chave_ip ~ '^[0-9a-f]{64}$'),
  em timestamptz not null default now()
);
create index fiscal_acesso_tentativas_email on public.fiscal_acesso_tentativas (chave_email, em);
create index fiscal_acesso_tentativas_ip on public.fiscal_acesso_tentativas (chave_ip, em);
alter table public.fiscal_acesso_tentativas enable row level security;
revoke all on public.fiscal_acesso_tentativas from public, anon, authenticated;

-- 3 por e-mail, 20 por IP e 300 no total por hora. Só hashes; o pedido conta antes do envio.
create function public.fiscal_acesso_preparar(p_email text, p_chave_email text, p_chave_ip text)
returns table (permitido boolean, user_id uuid, papel text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(trim(p_email));
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('fiscal_acesso:' || p_chave_email));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('fiscal_acesso_ip:' || p_chave_ip));
  delete from public.fiscal_acesso_tentativas where em < now() - interval '1 day';
  if (select count(*) from public.fiscal_acesso_tentativas t where t.chave_email = p_chave_email and t.em > now() - interval '1 hour') >= 3
     or (select count(*) from public.fiscal_acesso_tentativas t where t.chave_ip = p_chave_ip and t.em > now() - interval '1 hour') >= 20
     or (select count(*) from public.fiscal_acesso_tentativas t where t.em > now() - interval '1 hour') >= 300 then
    return query select false, null::uuid, null::text;
    return;
  end if;
  insert into public.fiscal_acesso_tentativas (chave_email, chave_ip) values (p_chave_email, p_chave_ip);
  return query
    select true, u.id, u.raw_app_meta_data ->> 'role'
      from (select 1) x
      left join auth.users u on lower(u.email) = v_email;
end;
$$;

-- ------------------------------------------------------------ Criação da empresa

-- Cria cliente, vínculo, conta, tenant, série DPS e número do dono numa transação.
-- Devolve {status, tenant_id?, etapa?}; status: criado | existente | cnpj_ja_cadastrado |
-- telefone_de_outra_empresa | conta_ja_tem_empresa | sem_email_confirmado.
create function public.fiscal_cadastro_criar(
  p_user_id uuid,
  p_cnpj text,
  p_razao_social text,
  p_codigo_municipio_ibge text,
  p_cnae text,
  p_telefone text,
  p_plano text,
  p_responsavel text,
  p_api_key_hash text,
  p_ambiente text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_tenant record;
  v_client_id uuid;
  v_tenant_id uuid;
begin
  if p_user_id is null or p_cnpj !~ '^[0-9]{14}$' or p_telefone !~ '^\+[1-9][0-9]{7,14}$'
     or p_plano not in ('inicial', 'pro') or p_codigo_municipio_ibge !~ '^[0-9]{7}$'
     or (p_cnae is not null and p_cnae !~ '^[0-9]{7}$')
     or length(btrim(coalesce(p_razao_social, ''))) not between 1 and 150
     or length(btrim(coalesce(p_responsavel, ''))) not between 2 and 120
     or p_api_key_hash !~ '^[0-9a-f]{64}$' or p_ambiente not in ('producao_restrita', 'producao') then
    raise exception 'fiscal_cadastro_criar: parametro invalido' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('fiscal_cadastro_cnpj:' || p_cnpj, 0));
  perform pg_advisory_xact_lock(hashtextextended('fiscal_cadastro_tel:' || p_telefone, 0));
  perform pg_advisory_xact_lock(hashtextextended('fiscal_cadastro_user:' || p_user_id::text, 0));

  select lower(u.email) into v_email
    from auth.users u
   where u.id = p_user_id and u.email_confirmed_at is not null and u.email is not null;
  if v_email is null then
    return jsonb_build_object('status', 'sem_email_confirmado');
  end if;

  -- Já é dono de uma empresa: a mesma (retentativa) ou outra.
  select t.id, t.cnpj, t.onboarding_etapa into v_tenant
    from nofiscal.fiscal_accounts a
    join nofiscal.fiscal_tenants t on t.client_id = a.client_id
   where a.user_id = p_user_id;
  if found then
    if v_tenant.cnpj = p_cnpj then
      return jsonb_build_object('status', 'existente', 'tenant_id', v_tenant.id, 'etapa', v_tenant.onboarding_etapa);
    end if;
    return jsonb_build_object('status', 'conta_ja_tem_empresa');
  end if;

  if exists (select 1 from nofiscal.fiscal_tenants t where t.cnpj = p_cnpj) then
    return jsonb_build_object('status', 'cnpj_ja_cadastrado');
  end if;
  if exists (select 1 from nofiscal.fiscal_phones f where f.phone_e164 = p_telefone) then
    return jsonb_build_object('status', 'telefone_de_outra_empresa');
  end if;

  insert into public.clients (name, slug, email, origem)
  values (btrim(p_razao_social), 'fiscal-' || replace(gen_random_uuid()::text, '-', ''), v_email, 'fiscal')
  returning id into v_client_id;

  insert into public.memberships (user_id, client_id, role) values (p_user_id, v_client_id, 'CLIENT');

  update auth.users
     set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
                              || jsonb_build_object('responsavel', btrim(p_responsavel)),
         updated_at = now()
   where id = p_user_id;

  -- Conta que sobrou de um cadastro anterior sem empresa (v1) é reaproveitada.
  insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, phone_verified_at, client_id)
  values (p_user_id, v_email, p_telefone, now(), null, v_client_id)
  on conflict (user_id) do update
     set email = excluded.email, phone_e164 = excluded.phone_e164, email_verified_at = now(),
         phone_verified_at = null, client_id = excluded.client_id, updated_at = now();

  insert into nofiscal.fiscal_tenants
    (cnpj, razao_social, codigo_municipio_ibge, cnae, api_key_hash, plan, monthly_note_limit,
     ambiente, client_id, onboarding_etapa)
  values
    (p_cnpj, btrim(p_razao_social), p_codigo_municipio_ibge, p_cnae, p_api_key_hash, p_plano,
     case p_plano when 'pro' then 100 else 20 end, p_ambiente, v_client_id, 'pagamento')
  returning id into v_tenant_id;

  -- Unresolved 3 da tarefa: sem resposta da pesquisa, série "1" e próximo número 1.
  insert into nofiscal.fiscal_dps_series (tenant_id, serie, next_number) values (v_tenant_id, '1', 1);

  insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role, verified_at)
  values (v_tenant_id, p_telefone, 'owner', null);

  return jsonb_build_object('status', 'criado', 'tenant_id', v_tenant_id, 'etapa', 'pagamento');
exception
  -- Corrida que escapou das travas (outro caminho gravando o mesmo CNPJ ou número).
  when unique_violation then
    if exists (select 1 from nofiscal.fiscal_tenants t where t.cnpj = p_cnpj) then
      return jsonb_build_object('status', 'cnpj_ja_cadastrado');
    end if;
    return jsonb_build_object('status', 'telefone_de_outra_empresa');
end;
$$;

-- ------------------------------------------------------------ Marca de pagamento

-- Depois do registro da assinatura: pago_em (uma vez) e etapa pagamento → certificado.
create function public.fiscal_marcar_pago(p_tenant_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  update nofiscal.fiscal_tenants
     set pago_em = coalesce(pago_em, now()),
         onboarding_etapa = case when onboarding_etapa = 'pagamento' then 'certificado' else onboarding_etapa end,
         updated_at = now()
   where id = p_tenant_id
  returning jsonb_build_object('pago_em', pago_em, 'etapa', onboarding_etapa);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.fiscal_acesso_preparar(text, text, text)',
    'public.fiscal_cadastro_criar(uuid, text, text, text, text, text, text, text, text, text)',
    'public.fiscal_marcar_pago(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

-- ------------------------------------------------------------ Conferência do código (C7s)

-- Um código vivo por e-mail (Landing "fiscal-acesso {acao:'verificar'}"): só hashes; cada envio
-- substitui o anterior e zera as tentativas.
create table public.fiscal_acesso_codigos (
  chave_email text primary key check (chave_email ~ '^[0-9a-f]{64}$'),
  codigo_hash text not null check (codigo_hash ~ '^[0-9a-f]{64}$'),
  enviado_em timestamptz not null default now(),
  tentativas smallint not null default 0 check (tentativas between 0 and 5),
  esgotado_em timestamptz
);
alter table public.fiscal_acesso_codigos enable row level security;
revoke all on public.fiscal_acesso_codigos from public, anon, authenticated;

create function public.fiscal_acesso_registrar_codigo(p_chave_email text, p_codigo_hash text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.fiscal_acesso_codigos where enviado_em < now() - interval '1 day';
  insert into public.fiscal_acesso_codigos (chave_email, codigo_hash, enviado_em, tentativas, esgotado_em)
  values (p_chave_email, p_codigo_hash, now(), 0, null)
  on conflict (chave_email) do update
     set codigo_hash = excluded.codigo_hash, enviado_em = now(), tentativas = 0, esgotado_em = null;
$$;

-- status: correto | incorreto (restantes) | esgotou (esta foi a 5ª errada) | esgotado | vencido.
create function public.fiscal_acesso_conferir(p_chave_email text, p_codigo_hash text, p_validade_s integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.fiscal_acesso_codigos;
begin
  select * into v from public.fiscal_acesso_codigos c where c.chave_email = p_chave_email for update;
  if not found or v.enviado_em < now() - make_interval(secs => p_validade_s) then
    return jsonb_build_object('status', 'vencido');
  end if;
  if v.esgotado_em is not null then
    return jsonb_build_object('status', 'esgotado');
  end if;
  if v.codigo_hash = p_codigo_hash then
    return jsonb_build_object('status', 'correto');
  end if;
  update public.fiscal_acesso_codigos c
     set tentativas = c.tentativas + 1,
         esgotado_em = case when c.tentativas + 1 >= 5 then now() end
   where c.chave_email = p_chave_email
  returning * into v;
  if v.esgotado_em is not null then
    return jsonb_build_object('status', 'esgotou');
  end if;
  return jsonb_build_object('status', 'incorreto', 'restantes', 5 - v.tentativas);
end;
$$;

create function public.fiscal_acesso_consumir(p_chave_email text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.fiscal_acesso_codigos where chave_email = p_chave_email;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.fiscal_acesso_registrar_codigo(text, text)',
    'public.fiscal_acesso_conferir(text, text, integer)',
    'public.fiscal_acesso_consumir(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;
