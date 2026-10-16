import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = new URL("../../supabase/migrations/20261016200000_auditor_assinaturas.sql", import.meta.url);
const ROLLBACK = new URL("../../supabase/rollback/20261016200000_auditor_assinaturas.down.sql", import.meta.url);

const db = new PGlite();

async function aplicar(eventId, tipo, subId, status) {
  const { rows } = await db.query(
    "select public.aplicar_evento_assinatura_auditor($1, $2, $3, $4, $5::jsonb) as r",
    [eventId, tipo, subId, status, JSON.stringify({ id: eventId, type: tipo })],
  );
  return rows[0].r;
}

async function statusDe(subId) {
  const { rows } = await db.query(
    "select status from public.auditor_assinaturas where pagarme_subscription_id = $1", [subId]);
  return rows[0]?.status;
}

test.before(async () => {
  // Papeis que o Supabase ja tem; o PGlite nao.
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
  `);
  await db.exec(await readFile(MIGRATION, "utf8"));
  await db.query(
    `insert into public.auditor_assinaturas
       (plano, nome, email, pagarme_subscription_id, relatorio_aceite, relatorio_aceite_em, relatorio_aceite_texto)
     values ('semanal', 'Teste', 'teste@exemplo.com', 'sub_teste', true, now(), 'Quero receber o relatorio')`,
  );
});

test.after(async () => { await db.close(); });

test("(a) invoice.paid -> paga", async () => {
  const r = await aplicar("hook_a", "invoice.paid", "sub_teste", "paga");
  assert.deepEqual(r, { applied: true, duplicado: false, status: "paga", encontrada: true });
  assert.equal(await statusDe("sub_teste"), "paga");
});

test("(b) mesmo gateway_event_id -> duplicado, 1 linha so, assinatura intocada", async () => {
  const antes = await db.query("select updated_at, ultimo_evento_tipo from public.auditor_assinaturas where pagarme_subscription_id = 'sub_teste'");
  const r = await aplicar("hook_a", "charge.payment_failed", "sub_teste", "recusada");
  assert.deepEqual(r, { applied: false, duplicado: true });
  const { rows } = await db.query("select count(*)::int as n from public.auditor_assinatura_eventos where gateway_event_id = 'hook_a'");
  assert.equal(rows[0].n, 1);
  assert.equal(await statusDe("sub_teste"), "paga");
  const depois = await db.query("select updated_at, ultimo_evento_tipo from public.auditor_assinaturas where pagarme_subscription_id = 'sub_teste'");
  assert.deepEqual(depois.rows, antes.rows);
});

test("(c) charge.payment_failed -> recusada", async () => {
  const r = await aplicar("hook_c", "charge.payment_failed", "sub_teste", "recusada");
  assert.equal(r.applied, true);
  assert.equal(await statusDe("sub_teste"), "recusada");
});

test("(d) subscription.canceled -> cancelada", async () => {
  const r = await aplicar("hook_d", "subscription.canceled", "sub_teste", "cancelada");
  assert.equal(r.applied, true);
  assert.equal(await statusDe("sub_teste"), "cancelada");
});

test("tipo sem status grava o evento e nao muda a assinatura", async () => {
  const r = await aplicar("hook_x", "subscription.created", "sub_teste", null);
  assert.equal(r.applied, false);
  assert.equal(r.duplicado, false);
  assert.equal(await statusDe("sub_teste"), "cancelada");
  const { rows } = await db.query("select tipo, status_aplicado from public.auditor_assinatura_eventos where gateway_event_id = 'hook_x'");
  assert.deepEqual(rows, [{ tipo: "subscription.created", status_aplicado: null }]);
});

test("assinatura desconhecida -> applied true, encontrada false", async () => {
  const r = await aplicar("hook_y", "invoice.paid", "sub_nao_existe", "paga");
  assert.deepEqual(r, { applied: true, duplicado: false, status: "paga", encontrada: false });
});

test("(e) relatorio_aceite true sem data e recusado pelo check (e o inverso tambem)", async () => {
  await assert.rejects(
    db.query(`insert into public.auditor_assinaturas (plano, nome, email, relatorio_aceite)
              values ('mensal', 'X', 'x@exemplo.com', true)`),
    /auditor_assinaturas_aceite_coerente/,
  );
  await assert.rejects(
    db.query(`insert into public.auditor_assinaturas (plano, nome, email, relatorio_aceite, relatorio_aceite_em)
              values ('mensal', 'X', 'x@exemplo.com', false, now())`),
    /auditor_assinaturas_aceite_coerente/,
  );
});

test("(f) view so lista quem tem aceite e status paga", async () => {
  await db.query(
    `insert into public.auditor_assinaturas (plano, nome, email, pagarme_subscription_id, status, relatorio_aceite, relatorio_aceite_em)
     values ('mensal',  'Paga com aceite', 'p1@exemplo.com', 'sub_v1', 'paga',     true,  now()),
            ('agencia', 'Paga sem aceite', 'p2@exemplo.com', 'sub_v2', 'paga',     false, null),
            ('semanal', 'Pendente aceite', 'p3@exemplo.com', 'sub_v3', 'pendente', true,  now()),
            ('mensal',  'Recusada aceite', 'p4@exemplo.com', 'sub_v4', 'recusada', true,  now())`,
  );
  const { rows } = await db.query("select pagarme_subscription_id from public.auditor_lista_envio_relatorio order by 1");
  // sub_teste esta cancelada (teste d), entao fica fora
  assert.deepEqual(rows.map((x) => x.pagarme_subscription_id), ["sub_v1"]);
});

test("permissoes: RLS ligado, sem policy, execute so para service_role", async () => {
  const rls = await db.query(
    `select relname, relrowsecurity from pg_class
      where relname in ('auditor_assinaturas','auditor_assinatura_eventos') order by relname`);
  assert.deepEqual(rls.rows.map((x) => x.relrowsecurity), [true, true]);
  const pol = await db.query(
    `select count(*)::int as n from pg_policies
      where tablename in ('auditor_assinaturas','auditor_assinatura_eventos')`);
  assert.equal(pol.rows[0].n, 0);
  const fn = "public.aplicar_evento_assinatura_auditor(text, text, text, text, jsonb)";
  const ex = await db.query(
    `select has_function_privilege('anon', '${fn}', 'execute') as anon,
            has_function_privilege('authenticated', '${fn}', 'execute') as auth,
            has_function_privilege('service_role', '${fn}', 'execute') as service`);
  assert.deepEqual(ex.rows[0], { anon: false, auth: false, service: true });
  const tb = await db.query(
    `select has_table_privilege('anon', 'public.auditor_assinaturas', 'select') as a1,
            has_table_privilege('authenticated', 'public.auditor_assinatura_eventos', 'select') as a2,
            has_table_privilege('anon', 'public.auditor_lista_envio_relatorio', 'select') as a3`);
  assert.deepEqual(tb.rows[0], { a1: false, a2: false, a3: false });
});

async function registrar(subId, status, aceite, texto) {
  const { rows } = await db.query(
    `select public.registrar_assinatura_auditor($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::boolean, $8::text) as r`,
    ["semanal", "Pessoa Teste", "pessoa@exemplo.com", "cus_1", subId, status, aceite, texto],
  );
  return rows[0].r;
}

async function linha(subId) {
  const { rows } = await db.query(
    `select status, relatorio_aceite, relatorio_aceite_em is not null as tem_data, relatorio_aceite_texto,
            pagarme_customer_id, ultimo_evento_tipo
       from public.auditor_assinaturas where pagarme_subscription_id = $1`, [subId]);
  return rows[0];
}

test("registrar: aceite true grava data e texto", async () => {
  const r = await registrar("sub_r1", "pendente", true, "Quero receber o relatorio");
  assert.equal(r.status, "pendente");
  assert.equal(r.reconciliada, false);
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await linha("sub_r1"), {
    status: "pendente", relatorio_aceite: true, tem_data: true,
    relatorio_aceite_texto: "Quero receber o relatorio", pagarme_customer_id: "cus_1", ultimo_evento_tipo: null,
  });
});

test("registrar: aceite false grava data e texto nulos (mesmo se vier texto)", async () => {
  const r = await registrar("sub_r2", "recusada", false, "texto que nao deve ficar");
  assert.equal(r.status, "recusada");
  const l = await linha("sub_r2");
  assert.equal(l.relatorio_aceite, false);
  assert.equal(l.tem_data, false);
  assert.equal(l.relatorio_aceite_texto, null);
});

test("registrar: invoice.paid chegou antes -> linha nasce paga, reconciliada true", async () => {
  const ev = await aplicar("hook_r3", "invoice.paid", "sub_r3", "paga");
  assert.equal(ev.encontrada, false);
  await aplicar("hook_r3b", "subscription.created", "sub_r3", null); // sem status: nao conta
  const r = await registrar("sub_r3", "pendente", true, "Quero");
  assert.equal(r.status, "paga");
  assert.equal(r.reconciliada, true);
  const l = await linha("sub_r3");
  assert.equal(l.status, "paga");
  assert.equal(l.ultimo_evento_tipo, "invoice.paid");
});

test("registrar: recusa status fora de pendente/recusada e subscription nula", async () => {
  await assert.rejects(registrar("sub_r4", "paga", false, null), /status invalido/);
  await assert.rejects(registrar(null, "pendente", false, null), /subscription_id obrigatorio/);
});

test("registrar: execute so para service_role", async () => {
  const fn = "public.registrar_assinatura_auditor(text, text, text, text, text, text, boolean, text)";
  const ex = await db.query(
    `select has_function_privilege('anon', '${fn}', 'execute') as anon,
            has_function_privilege('authenticated', '${fn}', 'execute') as auth,
            has_function_privilege('service_role', '${fn}', 'execute') as service`);
  assert.deepEqual(ex.rows[0], { anon: false, auth: false, service: true });
});

test("rollback .down.sql remove tudo e a migration reaplica limpa", async () => {
  await db.exec(await readFile(ROLLBACK, "utf8"));
  const { rows } = await db.query(
    `select count(*)::int as n from pg_class
      where relname in ('auditor_assinaturas','auditor_assinatura_eventos','auditor_lista_envio_relatorio')`);
  assert.equal(rows[0].n, 0);
  await db.exec(await readFile(MIGRATION, "utf8"));
  await db.exec(await readFile(ROLLBACK, "utf8"));
});

test("rollback tambem remove registrar_assinatura_auditor", async () => {
  const { rows } = await db.query(
    `select count(*)::int as n from pg_proc
      where proname in ('registrar_assinatura_auditor','aplicar_evento_assinatura_auditor')`);
  assert.equal(rows[0].n, 0);
});
