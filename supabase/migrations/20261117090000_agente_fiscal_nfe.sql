-- NF-e modelo 55 (nota de produto) no nó.fiscal (.design/agente-fiscal-nfe.md). Aditiva: nada da NFS-e muda.
--
-- * Dados da empresa para NF-e: inscrição estadual e endereço (o leiaute exige os dois no emitente), série e próximo
--   número (quem já emitia NF-e em outro sistema continua a numeração dele).
-- * `fiscal_nfe`: uma linha por nota, com a fila do worker (queued → sending → processing → authorized | denied |
--   rejected; cancel_requested → cancelled). O XML assinado fica gravado na primeira tentativa e não muda: um
--   reenvio depois de timeout é a mesma nota (mesma chave), conferida antes pela consulta por chave.
-- * `fiscal_nfe_eventos`: cancelamento, carta de correção e inutilização, com o protocolo e o XML de cada um.
-- * Franquia: a NF-e soma com a NFS-e na mesma franquia da conta-mãe (`nofiscal.notas_do_mes`).
-- * Assinatura: sempre o A1 da própria empresa. Procuração não vale para NF-e (a Sefaz exige a mesma raiz de CNPJ no
--   certificado e no emitente), então `nfe_emission_block` olha só o certificado da empresa.

alter table nofiscal.fiscal_tenants
  add column inscricao_estadual text check (inscricao_estadual ~ '^[0-9]{2,14}$'),
  add column endereco jsonb check (
    endereco is null or (
      jsonb_typeof(endereco) = 'object'
      and coalesce(length(trim(endereco ->> 'logradouro')), 0) between 1 and 60
      and coalesce(length(trim(endereco ->> 'numero')), 0) between 1 and 60
      and coalesce(length(trim(endereco ->> 'bairro')), 0) between 1 and 60
      and coalesce(endereco ->> 'cep', '') ~ '^[0-9]{8}$'
      and coalesce(endereco ->> 'uf', '') ~ '^[A-Z]{2}$'
    )
  );

create table nofiscal.fiscal_nfe_series (
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  serie integer not null check (serie between 0 and 999),
  next_number bigint not null check (next_number between 1 and 999999999),
  primary key (tenant_id, serie)
);

create table nofiscal.fiscal_nfe (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  external_id text not null check (length(external_id) between 1 and 100),
  origem text not null check (origem in ('painel', 'planilha', 'api')),
  status text not null default 'queued' check (status in (
    'queued', 'sending', 'processing', 'authorized', 'denied', 'rejected', 'cancel_requested', 'cancelled', 'voided'
  )),
  ambiente text not null check (ambiente in ('homologacao', 'producao')),
  -- Destinatário, itens, pagamento e frete (NfeInput sem emitente, série, número e data); o emitente sai da empresa.
  payload jsonb not null,
  serie integer not null,
  numero bigint not null check (numero between 1 and 999999999),
  valor_total numeric(15, 2) not null check (valor_total >= 0),
  destinatario_documento text not null check (destinatario_documento ~ '^([0-9]{11}|[0-9]{14})$'),
  destinatario_nome text not null,
  chave text unique check (chave ~ '^[0-9]{44}$'),
  emitida_em timestamptz,
  xml_assinado text,
  recibo text,
  protocolo text,
  xml_proc text,
  last_error_code text,
  last_error text,
  attempts smallint not null default 0 check (attempts between 0 and 20),
  next_attempt_at timestamptz,
  authorized_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id),
  unique (tenant_id, serie, numero),
  check ((chave is null) = (xml_assinado is null))
);
create index fiscal_nfe_pendentes_idx on nofiscal.fiscal_nfe (status, next_attempt_at)
  where status in ('queued', 'sending', 'processing', 'cancel_requested');
create index fiscal_nfe_tenant_idx on nofiscal.fiscal_nfe (tenant_id, created_at desc);

create table nofiscal.fiscal_nfe_eventos (
  id uuid primary key default gen_random_uuid(),
  nfe_id uuid references nofiscal.fiscal_nfe(id) on delete restrict,
  tenant_id uuid not null references nofiscal.fiscal_tenants(id) on delete restrict,
  tipo text not null check (tipo in ('cancelamento', 'cce', 'inutilizacao')),
  -- Inutilização: a faixa de números (com ou sem nota rejeitada ligada).
  serie integer check (serie between 0 and 999),
  numero_inicial bigint check (numero_inicial between 1 and 999999999),
  numero_final bigint check (numero_final between 1 and 999999999),
  sequencia smallint not null default 1 check (sequencia between 1 and 20),
  texto text not null check (length(texto) between 15 and 1000),
  status text not null default 'queued' check (status in ('queued', 'registrado', 'rejeitado')),
  protocolo text,
  xml_proc text,
  last_error_code text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (tipo = 'inutilizacao' or nfe_id is not null),
  check ((tipo = 'inutilizacao') = (numero_inicial is not null and numero_final is not null and serie is not null)),
  check (numero_final is null or numero_final >= numero_inicial)
);
create index fiscal_nfe_eventos_nfe_idx on nofiscal.fiscal_nfe_eventos (nfe_id);
create unique index fiscal_nfe_eventos_seq_idx on nofiscal.fiscal_nfe_eventos (nfe_id, tipo, sequencia) where nfe_id is not null;

alter table nofiscal.fiscal_nfe_series enable row level security;
alter table nofiscal.fiscal_nfe enable row level security;
alter table nofiscal.fiscal_nfe_eventos enable row level security;
revoke all on nofiscal.fiscal_nfe_series, nofiscal.fiscal_nfe, nofiscal.fiscal_nfe_eventos from public, anon, authenticated, service_role;
grant select, insert, update on nofiscal.fiscal_nfe_series, nofiscal.fiscal_nfe, nofiscal.fiscal_nfe_eventos to nofiscal_service;
grant update (inscricao_estadual, endereco, updated_at) on nofiscal.fiscal_tenants to nofiscal_service;
create policy nofiscal_service_all on nofiscal.fiscal_nfe_series for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_nfe for all to nofiscal_service using (true) with check (true);
create policy nofiscal_service_all on nofiscal.fiscal_nfe_eventos for all to nofiscal_service using (true) with check (true);

-- Numeração da NF-e: mesma ideia da DPS (UPDATE … RETURNING trava a série até o fim da transação).
create function nofiscal.allocate_nfe_number(p_tenant_id uuid, p_serie integer)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_numero bigint;
begin
  update nofiscal.fiscal_nfe_series
     set next_number = next_number + 1
   where tenant_id = p_tenant_id and serie = p_serie
  returning next_number - 1 into v_numero;
  if v_numero is null then
    raise exception 'NOFISCAL_NFE_SERIE_NOT_FOUND';
  end if;
  if v_numero > 999999999 then
    raise exception 'NOFISCAL_NFE_SERIE_ESGOTADA';
  end if;
  return v_numero;
end;
$$;
grant execute on function nofiscal.allocate_nfe_number(uuid, integer) to nofiscal_service;

-- Por que a empresa não emite NF-e agora (null = pode). Mesma ordem e mesmos códigos de `emission_block` onde a regra
-- é a mesma (empresa, conta-mãe, assinatura); próprios da NF-e: IE, endereço, série e o certificado da empresa.
create function nofiscal.nfe_emission_block(p_tenant_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_tenant record;
  v_dono record;
  v_not_after timestamptz;
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
  if not exists (select 1 from nofiscal.fiscal_nfe_series s where s.tenant_id = p_tenant_id) then
    return 'NFE_SEM_SERIE';
  end if;
  select c.not_after into v_not_after from nofiscal.fiscal_certificates c where c.tenant_id = p_tenant_id;
  if not found then
    return 'NFE_CERT_MISSING';
  end if;
  if v_not_after <= now() then
    return 'CERT_EXPIRED';
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
grant execute on function nofiscal.nfe_emission_block(uuid) to nofiscal_service;

-- NF-e da franquia no mês: autorizadas no mês (Brasília) e as que estão na fila, de todas as empresas da conta-mãe.
-- Soma com as NFS-e (lote.ts `notasDoMes`, entregas.ts `avisarLimite`, `fiscal_escritorio_estado`).
create function nofiscal.nfe_do_mes(p_dono_tenant_id uuid, p_inicio timestamptz, p_fim timestamptz)
returns bigint
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)
    from nofiscal.fiscal_nfe n
   where n.tenant_id in (select nofiscal.empresas_do_dono(p_dono_tenant_id))
     and ((n.authorized_at >= p_inicio and n.authorized_at < p_fim) or n.status in ('queued', 'sending', 'processing'));
$$;
grant execute on function nofiscal.nfe_do_mes(uuid, timestamptz, timestamptz) to nofiscal_service;

-- Painel "Minha conta": as notas do mês de cada empresa e da conta somam a NF-e autorizada, e cada empresa traz os
-- dados de NF-e (IE, endereço, série, próximo número e o bloqueio). Cópia da versão de 20261116180000 com essas linhas.
create or replace function public.fiscal_escritorio_estado(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dono uuid;
  v_plan text;
  v_override integer;
  v_inicio timestamptz;
  v_fim timestamptz;
  v_empresas jsonb;
  v_ativas integer;
  v_notas integer;
begin
  v_dono := nofiscal.escritorio_do_usuario(p_user_id);
  if v_dono is null then
    return null;
  end if;
  select t.plan, t.max_empresas_override into v_plan, v_override from nofiscal.fiscal_tenants t where t.id = v_dono;
  v_inicio := (date_trunc('month', now() at time zone 'America/Sao_Paulo')) at time zone 'America/Sao_Paulo';
  v_fim := ((date_trunc('month', now() at time zone 'America/Sao_Paulo')) + interval '1 month') at time zone 'America/Sao_Paulo';

  select coalesce(jsonb_agg(e order by (e ->> 'principal')::boolean desc, e ->> 'razao_social'), '[]'::jsonb)
    into v_empresas
    from (
      select jsonb_build_object(
        'tenant_id', t.id,
        'cnpj', t.cnpj,
        'razao_social', t.razao_social,
        'codigo_municipio_ibge', t.codigo_municipio_ibge,
        'regime', t.regime,
        'cnae', t.cnae,
        'principal', t.id = v_dono,
        'ativa', t.active,
        'codigo_servico_nacional', t.codigo_servico_nacional,
        'p_tot_trib_sn', t.p_tot_trib_sn,
        'modo_autenticacao', t.modo_autenticacao,
        'procuracao', case when p.tenant_id is null then null
                           else jsonb_build_object('status', p.status, 'valida_ate', p.valida_ate) end,
        'certificado', case when ce.tenant_id is null then null
                            else jsonb_build_object('subject', ce.subject, 'not_after', ce.not_after) end,
        'notas_mes', (select count(*) from nofiscal.fiscal_invoices i
                       where i.tenant_id = t.id and i.issued_at >= v_inicio and i.issued_at < v_fim)
                   + (select count(*) from nofiscal.fiscal_nfe n
                       where n.tenant_id = t.id and n.authorized_at >= v_inicio and n.authorized_at < v_fim),
        'nfe', jsonb_build_object(
          'inscricao_estadual', t.inscricao_estadual,
          'endereco', t.endereco,
          'serie', (select s.serie from nofiscal.fiscal_nfe_series s where s.tenant_id = t.id order by s.serie limit 1),
          'proximo_numero', (select s.next_number from nofiscal.fiscal_nfe_series s where s.tenant_id = t.id order by s.serie limit 1),
          'bloqueio', nofiscal.nfe_emission_block(t.id)),
        'situacao', case
          when not t.active then 'desativada'
          when t.modo_autenticacao = 'procuracao' and ce.tenant_id is null then 'procuracao_pendente'
          when ce.tenant_id is null then 'falta_certificado'
          when ce.not_after <= now() then 'certificado_vencido'
          when t.codigo_servico_nacional is null or (t.p_tot_trib_sn is null and t.regime <> 'mei') then 'falta_dados_fiscais'
          when ce.not_after <= now() + interval '30 days' then 'certificado_vencendo'
          else 'pronta'
        end) as e
        from nofiscal.fiscal_tenants t
        left join nofiscal.fiscal_certificados_de_emissao ce on ce.tenant_id = t.id
        left join nofiscal.fiscal_procuracoes p on p.tenant_id = t.id
       where t.id = v_dono or t.escritorio_tenant_id = v_dono
    ) x;

  select count(*) into v_ativas from nofiscal.fiscal_tenants t
   where (t.id = v_dono or t.escritorio_tenant_id = v_dono) and t.active;
  select count(*) into v_notas from nofiscal.fiscal_invoices i
   where i.tenant_id in (select nofiscal.empresas_do_dono(v_dono))
     and i.issued_at >= v_inicio and i.issued_at < v_fim;
  v_notas := v_notas + (select count(*) from nofiscal.fiscal_nfe n
     where n.tenant_id in (select nofiscal.empresas_do_dono(v_dono))
       and n.authorized_at >= v_inicio and n.authorized_at < v_fim);

  return jsonb_build_object(
    'escritorio_tenant_id', v_dono,
    'plano', v_plan,
    'max_empresas', nofiscal.max_empresas_da_conta(v_dono),
    'max_empresas_override', v_override,
    'empresas_ativas', v_ativas,
    'notas_limite', nofiscal.limite_do_plano(v_plan),
    'notas_mes', v_notas,
    'empresas', v_empresas);
end;
$$;
