-- =============================================================================
-- Espaço Saúde Mental · configuração do Editor da V2 (editor_version_configs)
-- TASK-mvbfaammemy · projeto 4fbc3859-a32f-4a71-b799-b005f32f65f8
-- V1 publicada: eb2ab04c-059e-4d70-8707-f9e7dc15384b
--
-- Quem roda: Lucca, à mão, no SQL Editor do Supabase de produção. A tabela tem
-- RLS sem policy: só service_role/postgres gravam.
--
-- Quando (ordem em .checks/espaco-saude-mental-editor.md):
--   1. V2 publicada no admin. version_id é FK para project_versions: a linha só
--      pode ser gravada depois que a V2 existe.
--   2. Cópia app/public/prototipos/espaco-saudemental/index.html no ar com
--      data-version-id = id da V2. O no-editor-preview.js e o EditorModule
--      descartam mensagens cujo baseVersionId difere do data-version-id.
--   3. Este arquivo. publish_project_version já cria a V2 como atual
--      (is_current), e get_client_editor_config só devolve a versão atual que tem
--      linha nesta tabela: entre publicar e rodar isto, o Editor da cliente fica
--      vazio.
--
-- Tabela (criada em 20260915237000; 20261002141941 acrescentou o "*" e a função
-- editor_allowed_controls; nenhuma migration altera colunas):
--   version_id          uuid         PK, FK project_versions(id) on delete cascade
--   allowed_components  jsonb        not null default '[]', check: precisa ser array
--   bridge_enabled      boolean      not null default false
--   created_at          timestamptz  not null default now()
-- Não há trigger nesta tabela nem coluna de URL/build. A URL do preview é o
-- build_reference da própria V2 em project_versions: definido ao publicar e
-- imutável depois (trigger project_versions_protect_history). Para manter o
-- preview da V1, a V2 precisa ser publicada com o mesmo build_reference; a
-- guarda aborta se for diferente (mesmo_build_da_v1 na conferência).
--
-- Guardas (seção 2), qualquer uma aborta tudo: placeholder não trocado ou uuid
-- inválido; id da V1; versão inexistente ou de outro projeto; versão que não é
-- a V2 (macro V2, label V2 e status publicada, como publish_project_version
-- grava; esquema citado na seção 2, migration 20260915223119); versão que não
-- é a atual; V2 que já tem linha nesta tabela; V1 sem linha nesta tabela, sem
-- macro V1 ou não anterior à V2; build_reference diferente do da V1; allowlist
-- mal formada; banco sem editor_allowed_controls.
--
-- Formato: o data-components da cópia é um mapa {id: [controles]}, mas a coluna
-- guarda um array [{id, label?, screen?, controls}]; gravar o mapa direto falha
-- no check (23514). O script converte: cada id do mapa vira um item com os
-- controles do mapa e herda label/screen (e a ordem) do item de mesmo id da V1.
-- "*" é o modo automático (ids auto:...), lido por editor_allowed_controls.
-- created_at não é copiado da V1: fica now().
--
-- Como rodar:
--   1. Selecione só a consulta da seção 1 e rode a seleção. A V2 é a versão
--      nova (label = V2, macro = V2, status = publicada, is_current = true,
--      tem_config = false); confira nela mesmo_build_da_v1 = true e
--      build_https = true. Copie o version_id.
--   2. Troque o placeholder da seção 0 (única ocorrência no arquivo).
--   3. Rode o arquivo inteiro, uma vez. Se qualquer guarda falhar, nada é
--      gravado. O resultado exibido é a conferência da seção 5.
--
-- Nova execução não sobrescreve: se a V2 já tem linha nesta tabela
-- (tem_config = true na seção 1), a seção 2 aborta e a linha fica como está.
-- Para regravar (por exemplo, allowlist corrigida), rode o "Desfazer" abaixo e
-- depois o arquivo inteiro.
--
-- Desfazer (a seção 2 só deixa gravar se a V2 não tinha linha, então a linha
-- apagada é a que este arquivo gravou; o Editor da cliente volta a ficar vazio):
--   delete from public.editor_version_configs where version_id = '<id da V2>';
-- =============================================================================

begin;

-- 0. PARÂMETROS (set_config(..., true) vale só dentro desta transação) --------

-- >>>>>>>>>>>>>>>> SUBSTITUA pelo id da V2 (project_versions.id) <<<<<<<<<<<<<<<<
select set_config('esm_v2.version_id', '00000000-0000-0000-0000-000000000000', true);

-- Allowlist alvo: cópia literal do data-components da cópia de preview
-- (app/public/prototipos/espaco-saudemental/index.html). Não mexer.
select set_config(
  'esm_v2.allowlist',
  '{"*":["text","size","color","logo"],"marca_topo":["text","color"],"hero_titulo":["text","size","color"],"hero_texto":["text","size","color"],"hero_cta":["text","color"],"valores_titulo":["text","size","color"]}',
  true
);

-- 1. CONFERÊNCIA ANTES (só leitura) -------------------------------------------
-- Versões do projeto e a configuração do Editor de cada uma. mapa_controles está
-- no mesmo formato do data-components, para comparar a olho.
with linhas as (
  select
    v.label,
    v.macro,
    v.status,
    v.is_current,
    v.id,
    v.created_at,
    v.build_reference,
    c.version_id is not null as tem_config,
    c.bridge_enabled,
    c.allowed_components,
    (select jsonb_object_agg(i ->> 'id', coalesce(i -> 'controls', '["text","size","color","logo"]'::jsonb))
       from jsonb_array_elements(c.allowed_components) as i) as mapa_controles
  from public.project_versions as v
  left join public.editor_version_configs as c on c.version_id = v.id
  where v.project_id = '4fbc3859-a32f-4a71-b799-b005f32f65f8'
)
select
  l.label,
  l.macro,
  l.status,
  l.is_current,
  l.id                                   as version_id,
  l.tem_config,
  l.bridge_enabled,
  l.mapa_controles,
  l.mapa_controles = v1.mapa_controles   as mapa_igual_ao_da_v1,
  l.build_reference,
  l.build_reference = v1.build_reference as mesmo_build_da_v1,
  l.build_reference ~ '^https://'        as build_https,
  l.allowed_components
from linhas as l
left join linhas as v1 on v1.id = 'eb2ab04c-059e-4d70-8707-f9e7dc15384b'
order by l.created_at;

-- 2. GUARDA -------------------------------------------------------------------
do $$
declare
  c_projeto constant uuid := '4fbc3859-a32f-4a71-b799-b005f32f65f8';
  c_v1      constant uuid := 'eb2ab04c-059e-4d70-8707-f9e7dc15384b';
  v_bruto   text  := trim(coalesce(current_setting('esm_v2.version_id', true), ''));
  v_alvo    jsonb := current_setting('esm_v2.allowlist', true)::jsonb;
  v_v2      uuid;
  v_versao  public.project_versions%rowtype;
  v_v1      public.project_versions%rowtype;
  v_cfg_em  timestamptz;
begin
  -- Placeholder trocado e uuid válido.
  if v_bruto = '' or replace(v_bruto, '-', '') ~ '^0+$' then
    raise exception 'ABORTADO: troque o placeholder da seção 0 pelo id da V2 (project_versions.id).';
  end if;
  begin
    v_v2 := v_bruto::uuid;
  exception
    when invalid_text_representation then
      raise exception 'ABORTADO: "%" não é um uuid.', v_bruto;
  end;

  -- Não é a V1 (engano mais provável ao copiar o id na seção 1).
  if v_v2 = c_v1 then
    raise exception 'ABORTADO: % é o id da V1. Use o id da V2.', v_v2;
  end if;

  -- A versão existe e é deste projeto.
  select * into v_versao from public.project_versions where id = v_v2;
  if not found then
    raise exception 'ABORTADO: a versão % não existe em project_versions (a V2 já foi publicada?).', v_v2;
  end if;
  if v_versao.project_id <> c_projeto then
    raise exception 'ABORTADO: a versão % (%) é do projeto %, não do Espaço Saúde Mental (%).',
      v_v2, v_versao.label, v_versao.project_id, c_projeto;
  end if;

  -- É a V2, e não uma V1.x nem uma V2.N publicada por engano com o mesmo
  -- build_reference. Esquema em supabase/migrations/20260915223119_f2_09_versions_backend.sql:
  --   l.10       macro text not null check (macro in ('V1', 'V2', 'V3'));
  --   l.9, l.18  label só exige texto não vazio, mas é unique (project_id, label):
  --              label 'V2' é uma versão só no projeto;
  --   l.126-157  publish_project_version (chamada por
  --              supabase/functions/project-publish-version/index.ts l.54, que só
  --              aceita macro V1/V2/V3 e label V1|V2|V3 com .N opcional, l.6-7)
  --              grava V1.N com macro V1 e status 'intermediaria', V2.N com macro
  --              V2 e status 'intermediaria', e só a V2 com macro V2, label V2 e
  --              status 'publicada'.
  -- Limite: o formato do label e os valores de status vêm só dessa função (a
  -- tabela não os confere), e o trigger project_versions_protect_history
  -- (l.40-60) não congela macro/label/status. Nenhuma função os altera depois do
  -- insert: o único update em project_versions é is_current = false (l.162-164).
  if v_versao.macro is distinct from 'V2'
     or v_versao.label is distinct from 'V2'
     or v_versao.status is distinct from 'publicada' then
    raise exception 'ABORTADO: a versão % tem macro %, label % e status %; este arquivo é só para a V2 (macro V2, label V2, status publicada).',
      v_v2, v_versao.macro, v_versao.label, v_versao.status;
  end if;

  -- É a versão atual: get_client_editor_config só lê a configuração dela.
  if not v_versao.is_current then
    raise exception 'ABORTADO: a versão % (%) não é a atual do projeto; o Editor só lê a versão atual.',
      v_v2, v_versao.label;
  end if;

  -- A V2 ainda não tem linha nesta tabela: a seção 3 é insert simples e este
  -- arquivo nunca sobrescreve uma configuração existente.
  select c.created_at into v_cfg_em
  from public.editor_version_configs as c
  where c.version_id = v_v2;
  if found then
    raise exception 'ABORTADO: a V2 (%) já tem linha em editor_version_configs (gravada em %); nada foi alterado. Veja a linha na seção 1 (tem_config = true). Para regravar, rode o "Desfazer" do cabeçalho e depois o arquivo inteiro.',
      v_v2, v_cfg_em;
  end if;

  -- A V1 é deste projeto, tem linha (é dela que vêm label/screen dos itens), tem
  -- macro V1 e foi publicada antes da V2. published_at é clock_timestamp() na
  -- publicação (l.170) e imutável depois (project_versions_protect_history, l.47).
  select v.* into v_v1
  from public.project_versions as v
  join public.editor_version_configs as c on c.version_id = v.id
  where v.id = c_v1 and v.project_id = c_projeto;
  if not found then
    raise exception 'ABORTADO: a V1 (%) não está neste projeto com linha em editor_version_configs.', c_v1;
  end if;
  if v_v1.macro is distinct from 'V1' then
    raise exception 'ABORTADO: a versão % (%), usada como V1, tem macro %; esperado V1.',
      c_v1, v_v1.label, v_v1.macro;
  end if;
  if v_versao.published_at <= v_v1.published_at then
    raise exception 'ABORTADO: a V2 (%) foi publicada em %, não depois da V1 (%).',
      v_v2, v_versao.published_at, v_v1.published_at;
  end if;

  -- Mesma cópia de preview da V1. O Editor abre no iframe o build_reference da
  -- versão atual, e ele não muda depois de publicar.
  if v_versao.build_reference is distinct from v_v1.build_reference then
    raise exception 'ABORTADO: build_reference da V2 (%) difere do da V1 (%); o Editor abriria outra página.',
      v_versao.build_reference, v_v1.build_reference;
  end if;

  -- Allowlist alvo no formato {id: [controles]}, só com controles de conteúdo.
  if v_alvo is null or jsonb_typeof(v_alvo) <> 'object' then
    raise exception 'ABORTADO: a allowlist da seção 0 precisa ser um objeto {id: [controles]}.';
  end if;
  if exists (
    select 1
    from jsonb_each(v_alvo) as e
    where case
            when jsonb_typeof(e.value) <> 'array' then true
            else exists (
              select 1
              from jsonb_array_elements_text(e.value) as ctl(valor)
              where ctl.valor not in ('text', 'size', 'color', 'logo')
            )
          end
  ) then
    raise exception 'ABORTADO: na allowlist da seção 0 cada id precisa de um array com text, size, color ou logo.';
  end if;

  -- O banco aceita "*" nos envios (migration 20261002141941_editor_auto_components).
  if to_regprocedure('public.editor_allowed_controls(uuid,text)') is null then
    raise exception 'ABORTADO: falta public.editor_allowed_controls (migration 20261002141941); sem ela o "*" não vale nos envios.';
  end if;
end
$$;

-- 3. GRAVAÇÃO -----------------------------------------------------------------
-- Uma linha por versão (PK version_id). Lê a linha da V1 só para herdar
-- label/screen e a ordem dos itens; ids e controles vêm da allowlist alvo.
-- Insert simples, sem on conflict: nunca sobrescreve. A seção 2 já abortou se a
-- V2 tinha linha; se outra sessão gravar a linha entre a guarda e este insert,
-- a PK falha (23505) e a transação inteira volta.
insert into public.editor_version_configs (version_id, allowed_components, bridge_enabled)
select
  current_setting('esm_v2.version_id')::uuid,
  (
    select jsonb_agg(
             coalesce(origem.item, '{}'::jsonb)
               || jsonb_build_object('id', alvo.id, 'controls', alvo.controles)
             order by origem.posicao nulls last, alvo.id
           )
    from jsonb_each(current_setting('esm_v2.allowlist')::jsonb) as alvo(id, controles)
    left join lateral (
      select e.item, e.posicao
      from jsonb_array_elements(v1.allowed_components) with ordinality as e(item, posicao)
      where e.item ->> 'id' = alvo.id
      order by e.posicao
      limit 1
    ) as origem on true
  ),
  true
from public.editor_version_configs as v1
where v1.version_id = 'eb2ab04c-059e-4d70-8707-f9e7dc15384b';

-- 4. CONFERÊNCIA DENTRO DA TRANSAÇÃO ------------------------------------------
-- Se a linha gravada não bater com o alvo, aborta e nada é gravado.
do $$
declare
  v_v2   uuid  := current_setting('esm_v2.version_id')::uuid;
  v_alvo jsonb := current_setting('esm_v2.allowlist')::jsonb;
  v_cfg  public.editor_version_configs%rowtype;
  v_mapa jsonb;
  v_id   text;
  v_ctl  jsonb;
begin
  select * into v_cfg from public.editor_version_configs where version_id = v_v2;
  if not found or v_cfg.bridge_enabled is not true then
    raise exception 'ABORTADO: a linha da V2 não ficou gravada com bridge_enabled = true.';
  end if;

  -- A linha é desta execução: created_at (default now()) é o início desta
  -- transação.
  if v_cfg.created_at is distinct from now() then
    raise exception 'ABORTADO: a linha da V2 tem created_at %, que não é desta execução (início %).',
      v_cfg.created_at, now();
  end if;

  -- Mesmos ids e controles do data-components, sem item duplicado.
  select jsonb_object_agg(i ->> 'id', i -> 'controls')
    into v_mapa
    from jsonb_array_elements(v_cfg.allowed_components) as i;
  if v_mapa is distinct from v_alvo
     or jsonb_array_length(v_cfg.allowed_components) <> (select count(*) from jsonb_object_keys(v_alvo)) then
    raise exception 'ABORTADO: allowlist gravada % difere do alvo %.', v_mapa, v_alvo;
  end if;

  -- Mesma função que o trigger editor_export_validate usa nos envios com base na
  -- V2. Para "*", testa um id automático.
  for v_id, v_ctl in select e.key, e.value from jsonb_each(v_alvo) as e loop
    if public.editor_allowed_controls(
         v_v2,
         case when v_id = '*' then 'auto:#conferencia/p.1' else v_id end
       ) is distinct from v_ctl then
      raise exception 'ABORTADO: editor_allowed_controls(V2, %) não devolve %.', v_id, v_ctl;
    end if;
  end loop;
end
$$;

commit;

-- 5. CONFERÊNCIA DEPOIS (só leitura, dado já gravado; mesma consulta da seção 1)
-- Esperado na linha da V2: label = V2, macro = V2, status = publicada,
-- is_current = true, tem_config = true,
-- bridge_enabled = true, mapa_controles igual ao data-components,
-- mesmo_build_da_v1 = true e build_https = true.
-- mapa_igual_ao_da_v1 = false na V2 significa que a allowlist da V1 no banco não
-- batia com o data-components; a V2 ficou igual ao data-components (seção 4).
with linhas as (
  select
    v.label,
    v.macro,
    v.status,
    v.is_current,
    v.id,
    v.created_at,
    v.build_reference,
    c.version_id is not null as tem_config,
    c.bridge_enabled,
    c.allowed_components,
    (select jsonb_object_agg(i ->> 'id', coalesce(i -> 'controls', '["text","size","color","logo"]'::jsonb))
       from jsonb_array_elements(c.allowed_components) as i) as mapa_controles
  from public.project_versions as v
  left join public.editor_version_configs as c on c.version_id = v.id
  where v.project_id = '4fbc3859-a32f-4a71-b799-b005f32f65f8'
)
select
  l.label,
  l.macro,
  l.status,
  l.is_current,
  l.id                                   as version_id,
  l.tem_config,
  l.bridge_enabled,
  l.mapa_controles,
  l.mapa_controles = v1.mapa_controles   as mapa_igual_ao_da_v1,
  l.build_reference,
  l.build_reference = v1.build_reference as mesmo_build_da_v1,
  l.build_reference ~ '^https://'        as build_https,
  l.allowed_components
from linhas as l
left join linhas as v1 on v1.id = 'eb2ab04c-059e-4d70-8707-f9e7dc15384b'
order by l.created_at;
