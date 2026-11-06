-- Validação sem senha do cadastro Venexia: simula, dentro de transações desfeitas (rollback),
-- a sessão do cliente (venexia@maisis.com.br) e a do operador da Maisis, passando pelo RLS real.
-- Não grava nada. Não substitui o login real no app, que continua sendo do Lucca.

-- 1) Sessão CLIENT da Venexia
begin;
select set_config('venexia.pid', (select p.id::text from public.projects p join public.clients c on c.id = p.client_id
                                   where c.slug = 'venexia' and p.name = 'Novo site Venexia'), true);
select set_config('request.jwt.claims', '{"sub":"73d0e50a-aad3-40f1-a65d-f8c9c095ca95","role":"authenticated","email":"venexia@maisis.com.br","app_metadata":{"role":"CLIENT","provider":"email"}}', true);
set local role authenticated;
select jsonb_build_object(
  'projetos_visiveis', (select jsonb_agg(name order by name) from public.projects),
  'roadmaps_visiveis', (select count(*) from public.roadmaps),
  'tarefas_visiveis', (select count(*) from public.kanban_items),
  'shell', (select to_jsonb(s) from public.get_client_project_shell(current_setting('venexia.pid')::uuid) s),
  'marca', public.get_client_project_branding(current_setting('venexia.pid')::uuid),
  'le_prototipo', public.can_read_project(current_setting('venexia.pid')::uuid, 'prototipo'),
  'le_editor', public.can_read_project(current_setting('venexia.pid')::uuid, 'editor'),
  'shell_conexao', (select count(*) from public.get_client_project_shell('6a84f861-ec07-4193-9bc8-3c07bf3326c3')),
  'marca_conexao', public.get_client_project_branding('6a84f861-ec07-4193-9bc8-3c07bf3326c3')
) as sessao_cliente;
rollback;

-- 2) Sessão AGENCY_ADMIN da Maisis
begin;
select set_config('request.jwt.claims', '{"sub":"e2a61c4a-3af1-4716-b374-57f3e2a7d6d0","role":"authenticated","app_metadata":{"role":"AGENCY_ADMIN"}}', true);
set local role authenticated;
select public.get_agency_overview('f4b64fc8-112b-416f-8612-2e02bcf2ee65') as sessao_maisis;
rollback;
