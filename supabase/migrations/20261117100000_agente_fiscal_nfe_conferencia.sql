-- Conferência da empresa para NF-e (Lucca, 17/11/2026, pela sessão "dúvidas"): a empresa só fica pronta para NF-e
-- depois de uma conferência automática e gratuita, sempre com o A1 da própria empresa (nunca o da nó nem o do
-- escritório):
--   1. o certificado é da empresa (mesma raiz de CNPJ; rejeição 213 da Sefaz);
--   2. consulta de cadastro da Sefaz da UF, onde existe (15 UFs): IE habilitada, do CNPJ, e credenciamento NF-e;
--   3. nota de teste em homologação (série 889, numeração própria; a série de produção vai de 0 a 889): autorizada = pronta; 203 = falta credenciamento;
--      230/231 = problema na IE.
-- A conferência vale para o certificado, a IE e a UF com que foi feita; trocar qualquer um pede outra.
--
-- A1 para NF-e de empresa que emite NFS-e por procuração: `onboarding_set_certificate_nfe` grava o A1 sem mudar o
-- modo da NFS-e (a procuração continua valendo para a NFS-e) e aceita o A1 da matriz para a filial (mesma raiz),
-- que a Sefaz aceita na NF-e. Na empresa que assina a NFS-e com o próprio A1, o A1 continua tendo de ser do CNPJ
-- inteiro (o mesmo certificado serve às duas notas).

create table nofiscal.fiscal_nfe_conferencias (
  tenant_id uuid primary key references nofiscal.fiscal_tenants(id) on delete restrict,
  status text not null default 'pendente' check (status in ('pendente', 'aprovada', 'reprovada', 'erro')),
  etapa text check (etapa in ('certificado', 'cadastro', 'nota_teste')),
  codigo text,
  motivo text,
  -- Consulta de cadastro: `null` = a UF não tem o serviço ou a Sefaz não respondeu.
  cadastro_cred_nfe text check (cadastro_cred_nfe in ('0', '1', '2', '3', '4')),
  cadastro_habilitada boolean,
  -- Nota de teste em homologação.
  teste_chave text check (teste_chave ~ '^[0-9]{44}$'),
  teste_protocolo text,
  teste_proximo_numero bigint not null default 1 check (teste_proximo_numero between 1 and 999999999),
  -- Com o que a conferência foi feita.
  ie text,
  uf text,
  cert_uploaded_at timestamptz,
  conferida_em timestamptz,
  updated_at timestamptz not null default now()
);
alter table nofiscal.fiscal_nfe_conferencias enable row level security;
revoke all on nofiscal.fiscal_nfe_conferencias from public, anon, authenticated, service_role;
grant select, insert, update on nofiscal.fiscal_nfe_conferencias to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_nfe_conferencias for all to nofiscal_service using (true) with check (true);

-- Bloqueio da NF-e: o de 20261117090000, com a conferência depois do certificado.
create or replace function nofiscal.nfe_emission_block(p_tenant_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tenant record;
  v_dono record;
  v_cert record;
  v_conf record;
  v_status text;
begin
  select t.active, t.escritorio_tenant_id, t.inscricao_estadual, t.endereco, t.regime
    into v_tenant
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id;
  if not found then
    return 'TENANT_NOT_FOUND';
  end if;
  if not v_tenant.active then
    return 'TENANT_INACTIVE';
  end if;
  select t.id, t.active, t.trial_ends_at into v_dono
    from nofiscal.fiscal_tenants t
   where t.id = coalesce(v_tenant.escritorio_tenant_id, p_tenant_id);
  if not v_dono.active then
    return 'TENANT_INACTIVE';
  end if;
  if v_tenant.regime not in ('simples', 'mei') then
    return 'NFE_REGIME_NAO_SUPORTADO';
  end if;
  if v_tenant.inscricao_estadual is null then
    return 'NFE_SEM_IE';
  end if;
  if v_tenant.endereco is null then
    return 'NFE_SEM_ENDERECO';
  end if;
  if not exists (select 1 from nofiscal.fiscal_nfe_series s where s.tenant_id = p_tenant_id and s.ativa) then
    return 'NFE_SEM_SERIE';
  end if;
  select c.not_after, c.uploaded_at into v_cert from nofiscal.fiscal_certificates c where c.tenant_id = p_tenant_id;
  if not found then
    return 'NFE_CERT_MISSING';
  end if;
  if v_cert.not_after <= now() then
    return 'CERT_EXPIRED';
  end if;

  select * into v_conf from nofiscal.fiscal_nfe_conferencias c where c.tenant_id = p_tenant_id;
  if not found or v_conf.status = 'pendente' then
    return 'NFE_NAO_CONFERIDA';
  end if;
  if v_conf.cert_uploaded_at is distinct from v_cert.uploaded_at
     or v_conf.ie is distinct from v_tenant.inscricao_estadual
     or v_conf.uf is distinct from (v_tenant.endereco ->> 'uf') then
    return 'NFE_CONFERIR_DE_NOVO';
  end if;
  if v_conf.status <> 'aprovada' then
    -- O código da reprovação (CERT_DE_OUTRO_CNPJ, NFE_NAO_CREDENCIADA, NFE_IE_…, SEFAZ_INDISPONIVEL…).
    return coalesce(v_conf.codigo, 'NFE_NAO_CONFERIDA');
  end if;

  select s.status into v_status
    from nofiscal.fiscal_subscriptions s
   where s.tenant_id = v_dono.id
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
  if v_status = 'pendente' and v_dono.trial_ends_at > now() then
    return null;
  end if;
  return 'PAYMENT_NOT_APPROVED';
end;
$$;

-- A1 para NF-e (painel, aba NF-e). Mesma posse, mesmo limite de tentativas e mesma trava de `onboarding_set_certificate`;
-- o CNPJ do certificado vem lido pelo servidor (SubjectAltName do e-CNPJ ou fim do CN).
create function nofiscal.onboarding_set_certificate_nfe(
  p_user_id uuid, p_tenant_id uuid, p_pfx_base64 text, p_senha text, p_subject text, p_not_after timestamptz, p_cnpj_do_certificado text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cnpj text;
  v_modo text;
  v_attempts integer;
begin
  select t.cnpj, t.modo_autenticacao into v_cnpj, v_modo
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id
     and nofiscal.usuario_pode_tenant(p_user_id, t.id);
  if not found then
    return 'FORBIDDEN';
  end if;

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
  if coalesce(p_cnpj_do_certificado, '') !~ '^[0-9]{14}$' then
    return 'CERT_CNPJ_DIFERENTE';
  end if;
  -- Por procuração, o A1 só serve à NF-e: basta a raiz (matriz para filial). Com A1 próprio, ele também assina a
  -- NFS-e, então tem de ser do CNPJ inteiro.
  if v_modo = 'procuracao' then
    if substr(p_cnpj_do_certificado, 1, 8) <> substr(v_cnpj, 1, 8) then
      return 'CERT_CNPJ_DIFERENTE';
    end if;
  elsif p_cnpj_do_certificado <> v_cnpj then
    return 'CERT_CNPJ_DIFERENTE';
  end if;

  perform nofiscal.upsert_certificate(p_tenant_id, p_pfx_base64, p_senha, p_subject, p_not_after);
  -- O modo da NFS-e não muda. A conferência da NF-e volta a pendente (o certificado mudou).
  insert into nofiscal.fiscal_nfe_conferencias (tenant_id, status) values (p_tenant_id, 'pendente')
  on conflict (tenant_id) do update set status = 'pendente', etapa = null, codigo = null, motivo = null, updated_at = now();
  return 'OK';
end;
$$;
revoke all on function nofiscal.onboarding_set_certificate_nfe(uuid, uuid, text, text, text, timestamptz, text) from public;
grant execute on function nofiscal.onboarding_set_certificate_nfe(uuid, uuid, text, text, text, timestamptz, text) to nofiscal_onboarding;
