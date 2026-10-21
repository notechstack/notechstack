-- Desfaz 20261021120000_marketing_cliente_conexoes.sql (migration A do auditor).
-- Apaga os tokens dos clientes do Vault. Só rode depois de desfazer a migration B (Frente 3).
-- Vínculos AUDITOR em memberships são removidos para o check antigo (só CLIENT) voltar.
delete from vault.secrets where name like 'marketing_cliente:%';

drop trigger if exists marketing_cliente_conexoes_apagar_segredo on public.marketing_cliente_conexoes;
drop function if exists public.marketing_cliente_conexoes_apagar_segredo();
drop function if exists public.marketing_oauth_nonce_consumir(text);
drop function if exists public.marketing_oauth_nonce_registrar(text, timestamptz);
drop function if exists public.marketing_cliente_ativos_salvar(uuid, text, jsonb, uuid);
drop function if exists public.marketing_meta_desautorizar(text);
drop function if exists public.marketing_cliente_conexao_encerrar(uuid, text, text, uuid, text);
drop function if exists public.marketing_cliente_conexao_marcar(uuid, text, text, text);
drop function if exists public.marketing_cliente_token_ler(uuid, text);
drop function if exists public.marketing_cliente_conexao_salvar(uuid, text, text, text[], timestamptz, text, uuid);
drop function if exists public.marketing_cliente_tipos(text);
drop function if exists public.marketing_cliente_evento(uuid, uuid, text, text, jsonb);

drop table if exists public.marketing_oauth_nonces;
drop table if exists public.marketing_cliente_eventos;
drop table if exists public.marketing_cliente_ativos;
drop table if exists public.marketing_cliente_conexoes;
drop function if exists public.auditor_pode_ler(uuid);

delete from public.memberships where role = 'AUDITOR';
alter table public.memberships drop constraint memberships_role_check,
  add constraint memberships_role_check check (role = 'CLIENT');
alter table public.clients drop column if exists origem;
