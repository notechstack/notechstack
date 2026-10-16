// Politica de acesso ao plano (PROPOSTA da questao 10): paga tem acesso; recusada mantem por 3 dias
// contados da primeira recusa depois do ultimo pagamento, so para quem ja pagou; pendente e cancelada, sem acesso.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const BASE = new URL("../../supabase/migrations/20261016200000_auditor_assinaturas.sql", import.meta.url);
const ACESSO = new URL("../../supabase/migrations/20261016200100_auditor_acesso_tolerancia.sql", import.meta.url);
const ACESSO_DOWN = new URL("../../supabase/rollback/20261016200100_auditor_acesso_tolerancia.down.sql", import.meta.url);

const db = new PGlite();

async function assinatura(subId, status, aceite = true) {
  await db.query(
    `insert into public.auditor_assinaturas
       (plano, nome, email, pagarme_subscription_id, status, relatorio_aceite, relatorio_aceite_em, relatorio_aceite_texto)
     values ('mensal', 'Teste', $1, $2, $3, $4, case when $4 then now() end, case when $4 then 'aceito' end)`,
    [`${subId}@exemplo.com`, subId, status, aceite],
  );
}

// Evento ja recebido ha N dias (recebido_em no passado).
async function evento(id, subId, statusAplicado, diasAtras) {
  await db.query(
    `insert into public.auditor_assinatura_eventos (gateway_event_id, tipo, pagarme_subscription_id, status_aplicado, recebido_em)
     values ($1, 'teste', $2, $3, now() - make_interval(days => $4))`,
    [id, subId, statusAplicado, diasAtras],
  );
}

async function naLista(subId) {
  const { rows } = await db.query(
    "select count(*)::int as n from public.auditor_lista_envio_relatorio where pagarme_subscription_id = $1", [subId]);
  return rows[0].n === 1;
}

test.before(async () => {
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
  `);
  await db.exec(await readFile(BASE, "utf8"));
  await db.exec(await readFile(ACESSO, "utf8"));
});

test.after(async () => { await db.close(); });

test("paga com aceite entra na lista; sem aceite nao entra", async () => {
  await assinatura("sub_paga", "paga");
  await evento("hook_paga_1", "sub_paga", "paga", 10);
  await assinatura("sub_paga_sem_aceite", "paga", false);
  assert.equal(await naLista("sub_paga"), true);
  assert.equal(await naLista("sub_paga_sem_aceite"), false);
});

test("pendente e cancelada nao entram", async () => {
  await assinatura("sub_pendente", "pendente");
  await assinatura("sub_cancelada", "cancelada");
  await evento("hook_canc_paga", "sub_cancelada", "paga", 20);
  await evento("hook_canc", "sub_cancelada", "cancelada", 1);
  assert.equal(await naLista("sub_pendente"), false);
  assert.equal(await naLista("sub_cancelada"), false);
});

test("recusada de quem ja pagou: entra ate 3 dias da recusa, sai depois", async () => {
  await assinatura("sub_rec_1d", "recusada");
  await evento("hook_r1_paga", "sub_rec_1d", "paga", 30);
  await evento("hook_r1_rec", "sub_rec_1d", "recusada", 1);
  await assinatura("sub_rec_4d", "recusada");
  await evento("hook_r4_paga", "sub_rec_4d", "paga", 30);
  await evento("hook_r4_rec", "sub_rec_4d", "recusada", 4);
  assert.equal(await naLista("sub_rec_1d"), true);
  assert.equal(await naLista("sub_rec_4d"), false);
});

test("recusada de quem nunca pagou (primeira cobranca) nao entra", async () => {
  await assinatura("sub_nunca", "recusada");
  await evento("hook_nunca_rec", "sub_nunca", "recusada", 0);
  assert.equal(await naLista("sub_nunca"), false);
});

test("nova tentativa recusada nao estende o prazo: conta da primeira recusa depois do pagamento", async () => {
  await assinatura("sub_retentativa", "recusada");
  await evento("hook_rt_paga", "sub_retentativa", "paga", 40);
  await evento("hook_rt_rec1", "sub_retentativa", "recusada", 4);
  await evento("hook_rt_rec2", "sub_retentativa", "recusada", 1);
  assert.equal(await naLista("sub_retentativa"), false);
});

test("recusa antiga antes de um pagamento novo nao conta", async () => {
  await assinatura("sub_voltou", "recusada");
  await evento("hook_v_rec_velha", "sub_voltou", "recusada", 20);
  await evento("hook_v_paga", "sub_voltou", "paga", 10);
  await evento("hook_v_rec_nova", "sub_voltou", "recusada", 1);
  assert.equal(await naLista("sub_voltou"), true);
});

test("a tolerancia troca num lugar so (parametro da funcao)", async () => {
  const { rows } = await db.query(
    `select public.auditor_assinatura_com_acesso('recusada', now() - interval '4 days', true) as padrao,
            public.auditor_assinatura_com_acesso('recusada', now() - interval '4 days', true, now(), interval '7 days') as sete`);
  assert.equal(rows[0].padrao, false);
  assert.equal(rows[0].sete, true);
});

test("execute da funcao de acesso so para service_role", async () => {
  const { rows } = await db.query(
    `select has_function_privilege('anon', 'public.auditor_assinatura_com_acesso(text, timestamptz, boolean, timestamptz, interval)', 'execute') as anon,
            has_function_privilege('authenticated', 'public.auditor_assinatura_com_acesso(text, timestamptz, boolean, timestamptz, interval)', 'execute') as auth,
            has_function_privilege('service_role', 'public.auditor_assinatura_com_acesso(text, timestamptz, boolean, timestamptz, interval)', 'execute') as srv`);
  assert.deepEqual(rows[0], { anon: false, auth: false, srv: true });
});

test("rollback volta a lista para 'aceitou e paga' e a migration reaplica limpa", async () => {
  await db.exec(await readFile(ACESSO_DOWN, "utf8"));
  const fn = await db.query("select count(*)::int as n from pg_proc where proname = 'auditor_assinatura_com_acesso'");
  assert.equal(fn.rows[0].n, 0);
  assert.equal(await naLista("sub_rec_1d"), false); // sem tolerancia
  assert.equal(await naLista("sub_paga"), true);
  await db.exec(await readFile(ACESSO, "utf8"));
  assert.equal(await naLista("sub_rec_1d"), true);
});
