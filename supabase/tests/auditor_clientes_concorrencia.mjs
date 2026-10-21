// Concorrência real (duas sessões psql ao mesmo tempo) das RPCs do auditor (plan.md C7 e C10).
// Pré-requisito: `supabase start` com a migration 20261021130000 aplicada.
// Uso: node supabase/tests/auditor_clientes_concorrencia.mjs
// Container do banco: AUDITOR_DB_CONTAINER (padrão: o do project_id do config.toml).

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const DB = process.env.AUDITOR_DB_CONTAINER ?? 'supabase_db_sdeowbqmwkwseyktyemn'

function psql(sql) {
  return execFileSync('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8' }).trim()
}

function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['exec', '-i', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'])
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))))
    p.stdin.end(sql)
  })
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms))
const passes = []
function ok(cond, rotulo, detalhe) {
  if (!cond) throw new Error(`FALHOU: ${rotulo}${detalhe ? ` — ${JSON.stringify(detalhe)}` : ''}`)
  passes.push(rotulo)
  console.log(`PASS ${rotulo}`)
}

const user = randomUUID()
const email = `concorrencia-${user.slice(0, 8)}@example.test`

try {
  psql(`insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        values ('${user}', 'authenticated', 'authenticated', '${email}', '{"role":"AUDITOR_CLIENT"}', '{}', now(), now());
        insert into public.auditor_aceites (user_id, versao) values ('${user}', 'termos-teste');`)

  // C7: dois primeiros acessos simultâneos criam exatamente uma conta, um negócio e um vínculo.
  const acesso = `begin; select criada from public.auditor_primeiro_acesso('${user}', '${email}', 'https://concorrencia.example'); select pg_sleep(1); commit;`
  const [a, b] = await Promise.all([psqlAsync(acesso), espera(200).then(() => psqlAsync(acesso))])
  const criadas = [a, b].map((s) => s.split('\n')[0])
  ok(criadas.filter((c) => c === 't').length === 1, 'C7 só uma das sessões cria a conta', criadas)
  ok(psql(`select count(*) from public.auditor_contas where dono_user_id = '${user}'`) === '1', 'C7 uma conta')
  ok(psql(`select count(*) from public.memberships where user_id = '${user}' and role = 'AUDITOR'`) === '1', 'C7 um vínculo AUDITOR')
  ok(psql(`select count(*) from public.auditor_clientes ac join public.auditor_contas c on c.id = ac.conta_id where c.dono_user_id = '${user}'`) === '1',
    'C7 um negócio')

  // C10: quatro relatórios vencidos, dois claims simultâneos de até 3 → 3 + 1, sem repetição.
  const cliente = psql(`select client_id from public.memberships where user_id = '${user}'`)
  psql(`insert into public.auditor_relatorios (client_id, tipo, periodo_de, periodo_ate, executar_em)
        select '${cliente}', 'semanal', d, d + 6, now() - interval '1 minute'
          from generate_series(date '2026-01-05', date '2026-01-26', interval '7 days') as g(d0), lateral (select g.d0::date as d) x;`)
  const claim = `begin; select string_agg(id::text, ',') from public.auditor_claim_relatorios(3); select pg_sleep(1.5); commit;`
  const [c1, c2] = await Promise.all([psqlAsync(claim), espera(300).then(() => psqlAsync(claim))])
  const ids1 = (c1.split('\n')[0] || '').split(',').filter(Boolean)
  const ids2 = (c2.split('\n')[0] || '').split(',').filter(Boolean)
  ok(ids1.length + ids2.length === 4, 'C10 os quatro foram pegos', { ids1: ids1.length, ids2: ids2.length })
  ok([ids1.length, ids2.length].sort().join('+') === '1+3', 'C10 divisão 3 + 1', { ids1: ids1.length, ids2: ids2.length })
  ok(new Set([...ids1, ...ids2]).size === 4, 'C10 nenhum relatório repetido')
} finally {
  psql(`select public.auditor_apagar_conta(id, 'admin') from public.auditor_contas where dono_user_id = '${user}';
        delete from auth.users where id = '${user}';`)
}

console.log(`\n${passes.length} verificações passaram.`)
