// Gera conexao-equestre-production.sql a partir de conexao-equestre.json.
// Uso: node app/onboarding/conexao-equestre/build-sql.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(readFileSync(path.join(here, 'conexao-equestre.json'), 'utf8'))
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const payload = lit(JSON.stringify({ roadmap: spec.roadmap, tasks: spec.tasks }))
const { client, project } = spec

const sql = `-- Cadastro idempotente: Conexão Equestre → projeto "${project.name}" → vínculo Maisis.
-- Gerado por build-sql.mjs a partir de conexao-equestre.json. Não cria usuários Auth nem memberships.
begin;
select pg_advisory_xact_lock(hashtext('onboard:${client.slug}'));
do $onboard$
declare cid uuid; pid uuid; aid uuid; tid uuid; payload jsonb := ${payload}::jsonb; task jsonb; details jsonb := '{}'::jsonb;
begin
  select id into aid from public.agencies where slug=${lit(project.agency_slug)};
  if aid is null then raise exception 'Agency % not found', ${lit(project.agency_slug)}; end if;
  if not exists(select 1 from public.agencies where id=aid and name='Maisis Publicidade' and active) then raise exception 'Agency identity/status mismatch'; end if;
  select id into cid from public.clients where slug=${lit(client.slug)};
  if cid is null then
    if exists(select 1 from public.clients where name ilike '%conex%' or name ilike '%equestre%') then raise exception 'Review existing similar client'; end if;
    insert into public.clients(name,slug) values(${lit(client.name)},${lit(client.slug)}) returning id into cid;
  elsif not exists(select 1 from public.clients where id=cid and name=${lit(client.name)}) then raise exception 'Client identity mismatch'; end if;
  if (select count(*) from public.projects where client_id=cid and name=${lit(project.name)})>1 then raise exception 'Duplicate project'; end if;
  select id into pid from public.projects where client_id=cid and name=${lit(project.name)};
  if pid is null then
    insert into public.projects(client_id,name,niche,lead_status,project_status,modules)
    values(cid,${lit(project.name)},${lit(project.niche)},${lit(project.lead_status)},${lit(project.project_status)},${lit(JSON.stringify(project.modules))}::jsonb) returning id into pid;
  else
    update public.projects set niche=${lit(project.niche)},project_status=${lit(project.project_status)},modules=modules || ${lit(JSON.stringify(project.modules))}::jsonb where id=pid;
  end if;
  if exists(select 1 from public.agency_projects where project_id=pid and agency_id<>aid) then raise exception 'Project already assigned to another agency'; end if;
  insert into public.agency_projects(agency_id,project_id) values(aid,pid) on conflict(project_id) do nothing;
  for task in select value from jsonb_array_elements(payload->'tasks') loop
    tid := null;
    select k.id into tid from public.kanban_items k where k.project_id=pid and k.title=task->>'title';
    if tid is null then
      insert into public.kanban_items(project_id,title,phase,status,position)
      values(pid,task->>'title',task->>'phase',(task->>'status')::public.kanban_status,(task->>'position')::integer) returning id into tid;
    else
      update public.kanban_items set phase=task->>'phase',status=(task->>'status')::public.kanban_status,position=(task->>'position')::integer where id=tid;
    end if;
    details := details || jsonb_build_object(tid::text,jsonb_build_object('source_id',task->>'source_id','note',task->>'note','week',task->'week'));
  end loop;
  insert into public.roadmaps(project_id,stack,costs,next_steps,"references",tiers,prototype_url,published_at)
  values(pid,payload->'roadmap'->'stack',payload->'roadmap'->'costs',(payload->'roadmap'->'next_steps') || jsonb_build_object('task_details',details),payload->'roadmap'->'references','{}',payload->'roadmap'->>'prototype_url',now())
  on conflict(project_id) do update set stack=excluded.stack,costs=excluded.costs,next_steps=excluded.next_steps,"references"=excluded."references",prototype_url=excluded.prototype_url,published_at=coalesce(roadmaps.published_at,excluded.published_at);
end $onboard$;
commit;
select c.id client_id,p.id project_id,a.id agency_id,c.name,p.lead_status,p.project_status,p.modules,r.prototype_url,
(select count(*) from public.kanban_items where project_id=p.id) tasks,
(select count(*) from public.kanban_items where project_id=p.id and status='concluido') completed,
(select count(*) from public.memberships where client_id=c.id) client_memberships
from public.clients c join public.projects p on p.client_id=c.id join public.agency_projects ap on ap.project_id=p.id join public.agencies a on a.id=ap.agency_id join public.roadmaps r on r.project_id=p.id where c.slug=${lit(client.slug)};
`
writeFileSync(path.join(here, 'conexao-equestre-production.sql'), sql)
console.log('ok', sql.length, 'bytes')
