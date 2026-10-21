-- Desfaz 20261021120000_marketing_cliente_conexoes.sql. Apaga os tokens dos clientes do Vault.
delete from vault.secrets where name like 'marketing_cliente:%';

drop trigger if exists marketing_cliente_conexoes_apagar_segredo on public.marketing_cliente_conexoes;
drop function if exists public.marketing_cliente_conexoes_apagar_segredo();
drop function if exists public.marketing_oauth_nonce_consumir(text);
drop function if exists public.marketing_oauth_nonce_registrar(text, timestamptz);
drop function if exists public.marketing_cliente_ativos_salvar(uuid, text, jsonb, uuid);
drop function if exists public.marketing_cliente_conexao_revogar(uuid, text, uuid);
drop function if exists public.marketing_cliente_conexao_marcar(uuid, text, text, text);
drop function if exists public.marketing_cliente_token_ler(uuid, text);
drop function if exists public.marketing_cliente_conexao_salvar(uuid, text, text, text[], timestamptz, text, uuid);

drop table if exists public.marketing_oauth_nonces;
drop table if exists public.marketing_cliente_eventos;
drop table if exists public.marketing_cliente_ativos;
drop table if exists public.marketing_cliente_conexoes;
drop function if exists public.marketing_cliente_membro(uuid);
