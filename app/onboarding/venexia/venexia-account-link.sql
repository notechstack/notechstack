-- Liga a conta venexia@maisis.com.br ao cliente Venexia. Aplicado em produção em 06/11/2026.
-- Substitui app/scripts/create-client-user.mjs neste onboarding (nenhum checkout tem as dependências
-- instaladas e a service_role não passa pelo agente). Regras do script, mais checagens extras
-- (UUID esperado, membro de agência, vínculo com outro cliente):
--   * reaproveita a conta existente e não toca na senha;
--   * só define app_metadata.role=CLIENT se o papel estiver vazio; aborta se houver outro papel;
--   * aborta se a conta for membro de agência (AGENCY_ADMIN);
--   * cria memberships(user_id, client_id, role=CLIENT) se ausente.
-- Rodar só depois de venexia-production.sql. Idempotente.
begin;
do $link$
declare uid uuid; cid uuid; r text; n int;
begin
  select count(*) into n from auth.users where lower(email) = 'venexia@maisis.com.br';
  if n <> 1 then raise exception 'Expected exactly one auth user, found %', n; end if;
  select id, raw_app_meta_data ->> 'role' into uid, r from auth.users where lower(email) = 'venexia@maisis.com.br';
  if uid <> '73d0e50a-aad3-40f1-a65d-f8c9c095ca95'::uuid then raise exception 'Unexpected user id %', uid; end if;
  if r is not null and r <> 'CLIENT' then raise exception 'User already has role %; nothing changed', r; end if;
  if exists (select 1 from public.agency_members where user_id = uid) then raise exception 'User is an agency member; nothing changed'; end if;
  if exists (select 1 from public.memberships m join public.clients c on c.id = m.client_id where m.user_id = uid and c.slug <> 'venexia') then raise exception 'User already linked to another client'; end if;
  select id into cid from public.clients where slug = 'venexia' and name = 'Venexia';
  if cid is null then raise exception 'Client venexia not found; run venexia-production.sql first'; end if;
  if r is null then
    update auth.users
       set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'CLIENT'),
           updated_at = now()
     where id = uid;
  end if;
  insert into public.memberships (user_id, client_id, role) values (uid, cid, 'CLIENT')
  on conflict (user_id, client_id) do nothing;
end $link$;
commit;
select u.id as user_id, u.email, u.raw_app_meta_data ->> 'role' as app_role, m.client_id, m.role as membership_role,
       (select count(*) from public.memberships where user_id = u.id) as memberships_total
  from auth.users u join public.memberships m on m.user_id = u.id
 where lower(u.email) = 'venexia@maisis.com.br';
