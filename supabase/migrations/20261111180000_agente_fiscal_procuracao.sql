-- nó.fiscal: cadastro e emissão por procuração eletrônica (Lucca, 11/11/2026; handoff "nofiscal-handoff-claude-code").
-- No cadastro, a empresa escolhe entre enviar o próprio A1 (`certificado_proprio`, como antes) e dar procuração
-- eletrônica no Portal de Serviços da Receita, serviço NFS-e (`procuracao`). Com procuração, o motor assina e
-- conecta com o A1 do PROCURADOR, que é sempre um tenant com A1 próprio:
--   - empresa de um escritório (escritorio_tenant_id): o próprio escritório (a conta-mãe);
--   - demais: o procurador da plataforma, o tenant cujo CNPJ está em fiscal_config.procurador_plataforma_cnpj
--     (a nó, 60.342.339/0001-06), que precisa ter o A1 dele gravado.
-- Base legal: Guia do Emissor Público Nacional Web v1.3 (31/10/2026), item 11. A aceitação da DPS assinada pelo
-- procurador ainda não foi provada contra a Sefin (bateria app/scripts/nofiscal-procuracao.mjs); a primeira nota
-- autorizada confirma a procuração (fonte 'emissao').
-- Conferência: a pessoa declara ("já fiz") e o app consulta o ADN como procurador, com `cnpjConsulta` do outorgante
-- (Manual dos Contribuintes das APIs do ADN v1.1, 03/11/2026): 200/404 = há procuração (confirmada, fonte 'adn');
-- 400 E2245 = "Não há procuração" (fica declarada com ultimo_erro, e a emissão espera). FAQ NFS-e v1.3 (06/11/2026),
-- item 17.7: com procuração, o procurador conecta e assina a DPS com o próprio certificado; sem ela, E0718.
-- Integra Procurações (SERPRO) fica para depois.

-- ------------------------------------------------------------ Modo de autenticação

alter table nofiscal.fiscal_tenants
  add column modo_autenticacao text not null default 'certificado_proprio'
    check (modo_autenticacao in ('certificado_proprio', 'procuracao'));
comment on column nofiscal.fiscal_tenants.modo_autenticacao is
  'certificado_proprio: o motor usa o A1 do tenant. procuracao: usa o A1 do procurador (fiscal_procuracoes).';

-- ------------------------------------------------------------ Configuração

create table nofiscal.fiscal_config (
  chave text primary key,
  valor text not null,
  updated_at timestamptz not null default now()
);
comment on table nofiscal.fiscal_config is 'Parâmetros do nó.fiscal que não são de um tenant.';
insert into nofiscal.fiscal_config (chave, valor) values ('procurador_plataforma_cnpj', '60342339000106');

-- ------------------------------------------------------------ Procurações

create table nofiscal.fiscal_procuracoes (
  tenant_id uuid primary key references nofiscal.fiscal_tenants (id) on delete cascade,
  procurador_tenant_id uuid not null references nofiscal.fiscal_tenants (id) on delete restrict,
  procurador_documento text not null check (procurador_documento ~ '^[0-9]{11}([0-9]{3})?$'),
  status text not null check (status in ('declarada', 'confirmada', 'invalida', 'revogada')),
  valida_ate date,
  declarada_em timestamptz not null default now(),
  declarada_por uuid,
  conferida_em timestamptz,
  fonte_conferencia text check (fonte_conferencia in ('declaracao', 'emissao', 'integra_procuracoes', 'adn')),
  ultimo_erro text,
  updated_at timestamptz not null default now(),
  check (procurador_tenant_id <> tenant_id)
);
create index fiscal_procuracoes_procurador_idx on nofiscal.fiscal_procuracoes (procurador_tenant_id);
comment on table nofiscal.fiscal_procuracoes is
  'Procuração eletrônica (serviço NFS-e) que a empresa deu ao procurador. declarada: a pessoa disse que cadastrou; '
  'confirmada: uma nota saiu com ela; invalida/revogada: o motor para de emitir.';

alter table nofiscal.fiscal_config enable row level security;
alter table nofiscal.fiscal_procuracoes enable row level security;
revoke all on nofiscal.fiscal_config, nofiscal.fiscal_procuracoes from public, anon, authenticated, service_role;
grant select on nofiscal.fiscal_config to nofiscal_service;
grant select, update on nofiscal.fiscal_procuracoes to nofiscal_service;
create policy nofiscal_service_read on nofiscal.fiscal_config for select to nofiscal_service using (true);
create policy nofiscal_service_all on nofiscal.fiscal_procuracoes
  for all to nofiscal_service using (true) with check (true);

-- ------------------------------------------------------------ Certificado que o motor usa

-- Uma linha por tenant que pode emitir agora: o A1 próprio ou, com procuração viva, o A1 do procurador.
-- Procuração inválida, revogada ou vencida (valida_ate no passado, em Brasília) some daqui: a nota fica na fila.
create view nofiscal.fiscal_certificados_de_emissao
with (security_invoker = true) as
  select t.id as tenant_id, 'certificado_proprio'::text as modo, c.vault_secret_id, c.subject, c.not_after,
         null::uuid as procurador_tenant_id
    from nofiscal.fiscal_tenants t
    join nofiscal.fiscal_certificates c on c.tenant_id = t.id
   where t.modo_autenticacao = 'certificado_proprio'
  union all
  select t.id, 'procuracao'::text, c.vault_secret_id, c.subject, c.not_after, p.procurador_tenant_id
    from nofiscal.fiscal_tenants t
    join nofiscal.fiscal_procuracoes p on p.tenant_id = t.id
    join nofiscal.fiscal_certificates c on c.tenant_id = p.procurador_tenant_id
   where t.modo_autenticacao = 'procuracao'
     and p.status in ('declarada', 'confirmada')
     and (p.valida_ate is null or p.valida_ate >= (now() at time zone 'America/Sao_Paulo')::date);
comment on view nofiscal.fiscal_certificados_de_emissao is
  'O A1 com que o motor assina e conecta, por tenant: o próprio ou o do procurador.';
revoke all on nofiscal.fiscal_certificados_de_emissao from public, anon, authenticated, service_role;
grant select on nofiscal.fiscal_certificados_de_emissao to nofiscal_service;

create function nofiscal.read_emission_certificate(p_tenant_id uuid)
returns table (pfx_base64 text, password text, not_after timestamptz, modo text)
language sql
stable
security definer
set search_path = ''
as $$
  select (s.decrypted_secret::jsonb) ->> 'pfx_base64',
         (s.decrypted_secret::jsonb) ->> 'password',
         e.not_after,
         e.modo
    from nofiscal.fiscal_certificados_de_emissao e
    join vault.decrypted_secrets s on s.id = e.vault_secret_id
   where e.tenant_id = p_tenant_id;
$$;

-- ------------------------------------------------------------ Quem é o procurador

-- O procurador que esta empresa deve indicar na procuração, e se ele está pronto para assinar.
-- motivo: null (pronto) | PROCURADOR_NAO_CONFIGURADO | PROCURADOR_SEM_CERTIFICADO | PROCURADOR_CERT_VENCIDO
--         | PROCURADOR_E_A_PROPRIA_EMPRESA | ESCRITORIO_SEM_CERTIFICADO
create function nofiscal.procurador_do_tenant(p_tenant_id uuid)
returns table (procurador_tenant_id uuid, documento text, nome text, tipo text, cert_not_after timestamptz, motivo text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_t record;
  v_p record;
  v_cnpj text;
begin
  select t.id, t.escritorio_tenant_id into v_t from nofiscal.fiscal_tenants t where t.id = p_tenant_id;
  if not found then
    return;
  end if;

  if v_t.escritorio_tenant_id is not null then
    select m.id, m.cnpj, m.razao_social, m.modo_autenticacao, c.not_after
      into v_p
      from nofiscal.fiscal_tenants m
      left join nofiscal.fiscal_certificates c on c.tenant_id = m.id
     where m.id = v_t.escritorio_tenant_id;
    return query select v_p.id, v_p.cnpj, v_p.razao_social, 'escritorio'::text, v_p.not_after,
      case
        when v_p.not_after is null or v_p.modo_autenticacao <> 'certificado_proprio' then 'ESCRITORIO_SEM_CERTIFICADO'
        when v_p.not_after <= now() then 'PROCURADOR_CERT_VENCIDO'
      end;
    return;
  end if;

  select f.valor into v_cnpj from nofiscal.fiscal_config f where f.chave = 'procurador_plataforma_cnpj';
  if v_cnpj is null then
    return query select null::uuid, null::text, null::text, 'plataforma'::text, null::timestamptz, 'PROCURADOR_NAO_CONFIGURADO'::text;
    return;
  end if;
  select m.id, m.cnpj, m.razao_social, m.modo_autenticacao, c.not_after
    into v_p
    from nofiscal.fiscal_tenants m
    left join nofiscal.fiscal_certificates c on c.tenant_id = m.id
   where m.cnpj = v_cnpj
   order by (c.tenant_id is not null) desc, m.created_at
   limit 1;
  if not found then
    return query select null::uuid, v_cnpj, null::text, 'plataforma'::text, null::timestamptz, 'PROCURADOR_NAO_CONFIGURADO'::text;
    return;
  end if;
  return query select v_p.id, v_p.cnpj, v_p.razao_social, 'plataforma'::text, v_p.not_after,
    case
      when v_p.id = p_tenant_id then 'PROCURADOR_E_A_PROPRIA_EMPRESA'
      when v_p.not_after is null then 'PROCURADOR_SEM_CERTIFICADO'
      when v_p.not_after <= now() then 'PROCURADOR_CERT_VENCIDO'
    end;
end;
$$;

-- ------------------------------------------------------------ Cadastro (rota /api/v1/onboarding/procuracao)

-- Leitura para a página: modo atual, procurador a indicar e a procuração gravada.
create function nofiscal.onboarding_procuracao_info(p_user_id uuid, p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_modo text;
  v_cnpj text;
  v_proc record;
  v_pr record;
begin
  select t.modo_autenticacao, t.cnpj into v_modo, v_cnpj
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id
     and nofiscal.usuario_pode_tenant(p_user_id, t.id);
  if not found then
    return jsonb_build_object('erro', 'FORBIDDEN');
  end if;
  select * into v_pr from nofiscal.procurador_do_tenant(p_tenant_id);
  select p.status, p.valida_ate, p.declarada_em, p.conferida_em, p.fonte_conferencia, p.procurador_documento, p.ultimo_erro
    into v_proc
    from nofiscal.fiscal_procuracoes p where p.tenant_id = p_tenant_id;
  return jsonb_build_object(
    'modo', v_modo,
    'cnpj', v_cnpj,
    'procurador', case when v_pr.documento is null then null else jsonb_build_object(
      'documento', v_pr.documento, 'nome', v_pr.nome, 'tipo', v_pr.tipo) end,
    'disponivel', v_pr.procurador_tenant_id is not null and v_pr.motivo is null,
    'motivo', v_pr.motivo,
    'procuracao', case when v_proc.status is null then null else jsonb_build_object(
      'status', v_proc.status,
      'valida_ate', v_proc.valida_ate,
      'declarada_em', v_proc.declarada_em,
      'conferida_em', v_proc.conferida_em,
      'fonte_conferencia', v_proc.fonte_conferencia,
      'procurador_documento', v_proc.procurador_documento,
      'ultimo_erro', v_proc.ultimo_erro) end);
end;
$$;

-- "Já fiz a procuração": grava a declaração, passa a empresa ao modo procuração e leva o onboarding de
-- `certificado` para `dados_fiscais` (como o envio do A1). O A1 próprio, se houver, fica guardado: enviar um A1
-- depois (onboarding_set_certificate) volta ao modo certificado_proprio.
-- Resultado: OK | FORBIDDEN | RATE_LIMITED | VALIDADE_PASSADA | <motivo de procurador_do_tenant>
create function nofiscal.onboarding_set_procuracao(p_user_id uuid, p_tenant_id uuid, p_valida_ate date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pr record;
  v_attempts integer;
begin
  if not exists (select 1 from nofiscal.fiscal_tenants t
                  where t.id = p_tenant_id and nofiscal.usuario_pode_tenant(p_user_id, t.id)) then
    return 'FORBIDDEN';
  end if;

  -- Mesmo limite do envio do A1 (5 por hora por empresa), na mesma tabela de tentativas.
  perform pg_advisory_xact_lock(hashtextextended('nofiscal_onboarding_certificate:' || p_tenant_id::text, 0));
  select count(*) into v_attempts
    from nofiscal.fiscal_certificate_attempts a
   where a.tenant_id = p_tenant_id
     and a.attempted_at > now() - interval '1 hour';
  if v_attempts >= 5 then
    return 'RATE_LIMITED';
  end if;
  insert into nofiscal.fiscal_certificate_attempts (tenant_id, user_id) values (p_tenant_id, p_user_id);

  if p_valida_ate is not null and p_valida_ate < (now() at time zone 'America/Sao_Paulo')::date then
    return 'VALIDADE_PASSADA';
  end if;
  select * into v_pr from nofiscal.procurador_do_tenant(p_tenant_id);
  if v_pr.procurador_tenant_id is null or v_pr.motivo is not null then
    return coalesce(v_pr.motivo, 'PROCURADOR_NAO_CONFIGURADO');
  end if;

  insert into nofiscal.fiscal_procuracoes as p
    (tenant_id, procurador_tenant_id, procurador_documento, status, valida_ate, declarada_em, declarada_por,
     conferida_em, fonte_conferencia, ultimo_erro, updated_at)
  values
    (p_tenant_id, v_pr.procurador_tenant_id, v_pr.documento, 'declarada', p_valida_ate, now(), p_user_id,
     null, 'declaracao', null, now())
  on conflict (tenant_id) do update
     set procurador_tenant_id = excluded.procurador_tenant_id,
         procurador_documento = excluded.procurador_documento,
         status = 'declarada',
         valida_ate = excluded.valida_ate,
         declarada_em = excluded.declarada_em,
         declarada_por = excluded.declarada_por,
         conferida_em = null,
         fonte_conferencia = 'declaracao',
         ultimo_erro = null,
         updated_at = now();

  update nofiscal.fiscal_tenants
     set modo_autenticacao = 'procuracao',
         onboarding_etapa = case when onboarding_etapa = 'certificado' then 'dados_fiscais' else onboarding_etapa end,
         updated_at = now()
   where id = p_tenant_id;
  return 'OK';
end;
$$;

-- Corpo de 20261105180000 (escritório) + o A1 enviado põe a empresa de volta no modo certificado_proprio.
create or replace function nofiscal.onboarding_set_certificate(
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
     and nofiscal.usuario_pode_tenant(p_user_id, t.id);
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
  -- v2: com o A1 gravado, o onboarding passa aos dados fiscais (só a partir de `certificado`).
  -- Procuração (20261111180000): o A1 próprio volta a ser o que assina.
  update nofiscal.fiscal_tenants
     set onboarding_etapa = case when onboarding_etapa = 'certificado' then 'dados_fiscais' else onboarding_etapa end,
         modo_autenticacao = 'certificado_proprio',
         updated_at = now()
   where id = p_tenant_id;
  return 'OK';
end;
$$;

-- ------------------------------------------------------------ Pré-checagem da emissão

-- Corpo de 20261105180000 com o certificado trocado pela procuração quando o modo é `procuracao`:
-- PROCURACAO_MISSING | PROCURACAO_INVALIDA | PROCURACAO_NAO_ENCONTRADA | PROCURACAO_VENCIDA | PROCURADOR_CERT_INVALIDO.
create or replace function nofiscal.emission_block(p_tenant_id uuid)
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
  v_proc record;
begin
  select t.active, t.codigo_servico_nacional, t.p_tot_trib_sn, t.regime, t.escritorio_tenant_id, t.modo_autenticacao
    into v_tenant
    from nofiscal.fiscal_tenants t
   where t.id = p_tenant_id;
  if not found then
    return 'TENANT_NOT_FOUND';
  end if;
  if not v_tenant.active then
    return 'TENANT_INACTIVE';
  end if;

  -- Assinatura e teste vêm da conta-mãe (ela própria, fora de escritório).
  select t.id, t.active, t.trial_ends_at into v_dono
    from nofiscal.fiscal_tenants t
   where t.id = coalesce(v_tenant.escritorio_tenant_id, p_tenant_id);
  if not v_dono.active then
    return 'TENANT_INACTIVE';
  end if;

  if v_tenant.codigo_servico_nacional is null
     or (v_tenant.p_tot_trib_sn is null and v_tenant.regime <> 'mei') then
    return 'FISCAL_CONFIG_MISSING';
  end if;

  if v_tenant.modo_autenticacao = 'procuracao' then
    select p.status, p.valida_ate, p.procurador_tenant_id, p.ultimo_erro into v_proc
      from nofiscal.fiscal_procuracoes p where p.tenant_id = p_tenant_id;
    if not found then
      return 'PROCURACAO_MISSING';
    end if;
    if v_proc.status not in ('declarada', 'confirmada') then
      return 'PROCURACAO_INVALIDA';
    end if;
    -- A última conferência no ADN respondeu E2245 ("Não há procuração da inscrição ... para ..."): a Sefin
    -- recusaria com E0718. O worker confere de novo a cada 2 minutos e limpa o erro quando a procuração aparece.
    if v_proc.status = 'declarada' and v_proc.ultimo_erro = 'E2245' then
      return 'PROCURACAO_NAO_ENCONTRADA';
    end if;
    if v_proc.valida_ate is not null and v_proc.valida_ate < (now() at time zone 'America/Sao_Paulo')::date then
      return 'PROCURACAO_VENCIDA';
    end if;
    select c.not_after into v_not_after from nofiscal.fiscal_certificates c where c.tenant_id = v_proc.procurador_tenant_id;
    if not found or v_not_after <= now() then
      return 'PROCURADOR_CERT_INVALIDO';
    end if;
  else
    select c.not_after into v_not_after from nofiscal.fiscal_certificates c where c.tenant_id = p_tenant_id;
    if not found then
      return 'CERT_MISSING';
    end if;
    if v_not_after <= now() then
      return 'CERT_EXPIRED';
    end if;
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

-- ------------------------------------------------------------ Painel do escritório

-- Corpo de 20261105180000 com o certificado efetivo (próprio ou do procurador) e o modo de cada empresa.
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
  select t.plan into v_plan from nofiscal.fiscal_tenants t where t.id = v_dono;
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
                       where i.tenant_id = t.id and i.issued_at >= v_inicio and i.issued_at < v_fim),
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

  return jsonb_build_object(
    'escritorio_tenant_id', v_dono,
    'plano', v_plan,
    'max_empresas', nofiscal.max_empresas_do_plano(v_plan),
    'empresas_ativas', v_ativas,
    'notas_limite', nofiscal.limite_do_plano(v_plan),
    'notas_mes', v_notas,
    'empresas', v_empresas);
end;
$$;

-- ------------------------------------------------------------ Acesso

revoke all on function nofiscal.read_emission_certificate(uuid), nofiscal.procurador_do_tenant(uuid),
  nofiscal.onboarding_procuracao_info(uuid, uuid), nofiscal.onboarding_set_procuracao(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function nofiscal.read_emission_certificate(uuid) to nofiscal_service;
grant execute on function nofiscal.procurador_do_tenant(uuid) to nofiscal_service;
grant execute on function nofiscal.onboarding_procuracao_info(uuid, uuid), nofiscal.onboarding_set_procuracao(uuid, uuid, date)
  to nofiscal_onboarding;
