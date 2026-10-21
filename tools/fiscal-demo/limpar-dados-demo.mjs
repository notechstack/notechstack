// Limpa do Supabase LOCAL (127.0.0.1:54322) o que as corridas da demonstração criaram: contas cujo e-mail casa com o
// padrão (padrão: e2e+…@exemplo.com, do e2e-demo.mjs), as empresas delas e tudo o que pende delas (A1 no Vault,
// modelos, telefones, assinaturas, códigos), mais as reivindicações de teste grátis e as tentativas de acesso
// gravadas desde a primeira dessas contas. Sem --apagar, só mostra o que apagaria.
//   node tools/fiscal-demo/limpar-dados-demo.mjs [--apagar] [--padrao "demo+%@exemplo.com"]
// Só o banco local: o endereço é fixo e não lê variável de ambiente.
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pg = createRequire(resolve(raiz, 'app', 'package.json'))('pg');
const BANCO = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const apagar = process.argv.includes('--apagar');
const i = process.argv.indexOf('--padrao');
const padrao = i > 0 ? process.argv[i + 1] : 'e2e+%@exemplo.com';

const c = new pg.Client({ connectionString: BANCO });
await c.connect();
try {
  await c.query('begin');
  await c.query(`create temp table demo_usuarios on commit drop as select id, created_at from auth.users where email like $1`, [padrao]);
  await c.query(`create temp table demo_clientes on commit drop as
    select distinct m.client_id as id from public.memberships m join demo_usuarios u on u.id = m.user_id`);
  await c.query(`create temp table demo_tenants on commit drop as
    select t.id from nofiscal.fiscal_tenants t join demo_clientes d on d.id = t.client_id`);
  const { rows: [j] } = await c.query('select min(created_at) as desde from demo_usuarios');
  const desde = j.desde;

  const passos = [
    ['segredos do A1 no Vault', `delete from vault.secrets where id in (select vault_secret_id from nofiscal.fiscal_certificates where tenant_id in (select id from demo_tenants))`],
    ['certificados', `delete from nofiscal.fiscal_certificates where tenant_id in (select id from demo_tenants)`],
    ['tentativas do A1', `delete from nofiscal.fiscal_certificate_attempts where tenant_id in (select id from demo_tenants)`],
    ['pedidos', `delete from nofiscal.fiscal_requests where tenant_id in (select id from demo_tenants)`],
    ['modelos', `delete from nofiscal.fiscal_models where tenant_id in (select id from demo_tenants)`],
    ['eventos de notas', `delete from nofiscal.fiscal_invoice_events where invoice_id in (select id from nofiscal.fiscal_invoices where tenant_id in (select id from demo_tenants))`],
    ['notas', `delete from nofiscal.fiscal_invoices where tenant_id in (select id from demo_tenants)`],
    ['assinaturas', `delete from nofiscal.fiscal_subscriptions where tenant_id in (select id from demo_tenants)`],
    ['séries da DPS', `delete from nofiscal.fiscal_dps_series where tenant_id in (select id from demo_tenants)`],
    ['códigos de verificação', `delete from nofiscal.fiscal_verification_codes where user_id in (select id from demo_usuarios)`],
    ['telefones', `delete from nofiscal.fiscal_phones where tenant_id in (select id from demo_tenants)`],
    ['empresas (tenants)', `delete from nofiscal.fiscal_tenants where id in (select id from demo_tenants)`],
    ['contas do fiscal', `delete from nofiscal.fiscal_accounts where user_id in (select id from demo_usuarios)`],
    ['memberships', `delete from public.memberships where user_id in (select id from demo_usuarios)`],
    ['clientes', `delete from public.clients where id in (select id from demo_clientes)`],
    ['usuários do Auth', `delete from auth.users where id in (select id from demo_usuarios)`],
    ['reivindicações de teste grátis (desde a 1ª conta da demo)', `delete from nofiscal.fiscal_trial_claims where $1::timestamptz is not null and created_at >= $1`, [desde]],
    ['tentativas de acesso (desde a 1ª conta da demo)', `delete from public.fiscal_acesso_tentativas where $1::timestamptz is not null and em >= $1`, [desde]],
    ['códigos de acesso (desde a 1ª conta da demo)', `delete from public.fiscal_acesso_codigos where $1::timestamptz is not null and enviado_em >= $1`, [desde]]
  ];
  console.log(`[limpar] padrão de e-mail ${padrao} · desde ${desde ? new Date(desde).toISOString() : '(nenhuma conta)'}`);
  for (const [nome, sql, valores] of passos) {
    const r = await c.query(sql, valores || []);
    console.log(`[limpar] ${apagar ? 'apagados' : 'apagaria'} ${String(r.rowCount).padStart(4)} · ${nome}`);
  }
  await c.query(apagar ? 'commit' : 'rollback');
  console.log(apagar ? '[limpar] feito.' : '[limpar] nada foi apagado (simulação). Use --apagar para valer.');
} catch (e) {
  await c.query('rollback').catch(() => {});
  console.error('[limpar] falhou, nada foi apagado:', e.message);
  process.exitCode = 1;
} finally {
  await c.end();
}
