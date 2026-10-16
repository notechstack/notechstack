import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = new URL("../../supabase/migrations/20261016200000_auditor_assinaturas.sql", import.meta.url);
const ROLLBACK = new URL("../../supabase/rollback/20261016200000_auditor_assinaturas.down.sql", import.meta.url);

const WHATS = "11987654321";
const TEXTO = "Li e aceito os Termos, inclusive receber o relatorio no WhatsApp";

const db = new PGlite();

async function aplicar(eventId, tipo, subId, status, eventoEm = null) {
  const { rows } = await db.query(
    "select public.aplicar_evento_assinatura_auditor($1, $2, $3, $4, $5::jsonb, $6::timestamptz) as r",
    [eventId, tipo, subId, status, JSON.stringify({ id: eventId, type: tipo }), eventoEm],
  );
  return rows[0].r;
}

async function statusDe(subId) {
  const { rows } = await db.query(
    "select status from public.auditor_assinaturas where pagarme_subscription_id = $1", [subId]);
  return rows[0]?.status;
}

async function naLista(subId) {
  const { rows } = await db.query(
    "select count(*)::int as n from public.auditor_lista_envio_relatorio where pagarme_subscription_id = $1", [subId]);
  return rows[0].n === 1;
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
       (plano, nome, email, whatsapp, pagarme_subscription_id, relatorio_aceite_em, relatorio_aceite_texto)
     values ('semanal', 'Teste', 'teste@exemplo.com', $1, 'sub_teste', now(), $2)`,
    [WHATS, TEXTO],
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

test("p_evento_em e opcional: chamada com 5 argumentos continua valendo", async () => {
  const { rows } = await db.query(
    "select public.aplicar_evento_assinatura_auditor('hook_5args', 'invoice.created', 'sub_teste', null, '{}'::jsonb) as r");
  assert.deepEqual(rows[0].r, { applied: false, duplicado: false, status: null });
});

test("assinatura desconhecida -> applied true, encontrada false", async () => {
  const r = await aplicar("hook_y", "invoice.paid", "sub_nao_existe", "paga");
  assert.deepEqual(r, { applied: true, duplicado: false, status: "paga", encontrada: false });
});

test("(e) aceite obrigatorio e whatsapp: a tabela recusa linha sem aceite, data, texto ou com whatsapp invalido", async () => {
  const base = { aceite: "true", em: "now()", texto: `'${TEXTO}'`, whats: `'${WHATS}'` };
  const inserir = (o) => db.query(
    `insert into public.auditor_assinaturas
       (plano, nome, email, whatsapp, relatorio_aceite, relatorio_aceite_em, relatorio_aceite_texto)
     values ('mensal', 'X', 'x@exemplo.com', ${o.whats}, ${o.aceite}, ${o.em}, ${o.texto})`);
  await assert.rejects(inserir({ ...base, aceite: "false" }), /auditor_assinaturas_aceite_obrigatorio/);
  await assert.rejects(inserir({ ...base, em: "null" }), /relatorio_aceite_em/);
  await assert.rejects(inserir({ ...base, texto: "null" }), /relatorio_aceite_texto/);
  await assert.rejects(inserir({ ...base, texto: "''" }), /auditor_assinaturas_aceite_texto_tamanho/);
  await assert.rejects(inserir({ ...base, texto: "repeat('a', 501)" }), /auditor_assinaturas_aceite_texto_tamanho/);
  await assert.rejects(inserir({ ...base, whats: "null" }), /whatsapp/);
  for (const w of ["'119876543'", "'551198765432'", "'1198765432a'", "'(11) 98765-4321'"]) {
    await assert.rejects(inserir({ ...base, whats: w }), /auditor_assinaturas_whatsapp_formato/, `aceitou ${w}`);
  }
  const { rows } = await db.query("select count(*)::int as n from public.auditor_assinaturas where email = 'x@exemplo.com'");
  assert.equal(rows[0].n, 0);
});

test("(f) lista de envio: so status paga, e traz o whatsapp", async () => {
  await db.query(
    `insert into public.auditor_assinaturas
       (plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto)
     values ('mensal',  'Paga',     'p1@exemplo.com', '11911112222', 'sub_v1', 'paga',     now(), 'aceito'),
            ('semanal', 'Pendente', 'p3@exemplo.com', '1133334444',  'sub_v3', 'pendente', now(), 'aceito'),
            ('mensal',  'Recusada', 'p4@exemplo.com', '11955556666', 'sub_v4', 'recusada', now(), 'aceito')`,
  );
  const { rows } = await db.query(
    "select pagarme_subscription_id, whatsapp from public.auditor_lista_envio_relatorio order by 1");
  // sub_teste esta cancelada (teste d), entao fica fora
  assert.deepEqual(rows, [{ pagarme_subscription_id: "sub_v1", whatsapp: "11911112222" }]);
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
  const fn = "public.aplicar_evento_assinatura_auditor(text, text, text, text, jsonb, timestamptz)";
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
  const n = await db.query("select count(*)::int as n from pg_proc where proname = 'aplicar_evento_assinatura_auditor'");
  assert.equal(n.rows[0].n, 1); // so a versao com p_evento_em
});

async function registrar(subId, status, texto = TEXTO, whatsapp = WHATS) {
  const { rows } = await db.query(
    `select public.registrar_assinatura_auditor($1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::text) as r`,
    ["semanal", "Pessoa Teste", "pessoa@exemplo.com", whatsapp, "cus_1", subId, status, texto],
  );
  return rows[0].r;
}

async function linha(subId) {
  const { rows } = await db.query(
    `select status, whatsapp, relatorio_aceite, relatorio_aceite_em is not null as tem_data, relatorio_aceite_texto,
            pagarme_customer_id, ultimo_evento_tipo
       from public.auditor_assinaturas where pagarme_subscription_id = $1`, [subId]);
  return rows[0];
}

test("registrar: grava aceite true, data, texto do aceite e whatsapp", async () => {
  const r = await registrar("sub_r1", "pendente");
  assert.equal(r.status, "pendente");
  assert.equal(r.reconciliada, false);
  assert.match(r.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await linha("sub_r1"), {
    status: "pendente", whatsapp: WHATS, relatorio_aceite: true, tem_data: true,
    relatorio_aceite_texto: TEXTO, pagarme_customer_id: "cus_1", ultimo_evento_tipo: null,
  });
});

test("registrar: sem texto do aceite falha (nulo, vazio, so espacos) e nao grava linha", async () => {
  for (const t of [null, "", "   "]) {
    await assert.rejects(registrar("sub_r2", "pendente", t), /aceite obrigatorio/, `aceitou ${JSON.stringify(t)}`);
  }
  await assert.rejects(registrar("sub_r2", "pendente", "a".repeat(501)), /auditor_assinaturas_aceite_texto_tamanho/);
  assert.equal(await linha("sub_r2"), undefined);
});

test("registrar: whatsapp invalido ou ausente falha", async () => {
  for (const w of [null, "", "119876543", "551198765432", "+5511987654321", "(11) 98765-4321"]) {
    await assert.rejects(registrar("sub_r2w", "pendente", TEXTO, w), /whatsapp/, `aceitou ${JSON.stringify(w)}`);
  }
  assert.equal(await linha("sub_r2w"), undefined);
  const r = await registrar("sub_r2f", "pendente", TEXTO, "1133334444"); // fixo com DDD: 10 digitos
  assert.equal(r.status, "pendente");
});

test("registrar: invoice.paid chegou antes -> linha nasce paga, reconciliada true", async () => {
  const ev = await aplicar("hook_r3", "invoice.paid", "sub_r3", "paga");
  assert.equal(ev.encontrada, false);
  await aplicar("hook_r3b", "subscription.created", "sub_r3", null); // sem status: nao conta
  const r = await registrar("sub_r3", "pendente");
  assert.equal(r.status, "paga");
  assert.equal(r.reconciliada, true);
  const l = await linha("sub_r3");
  assert.equal(l.status, "paga");
  assert.equal(l.ultimo_evento_tipo, "invoice.paid");
});

test("registrar: reconciliacao usa o evento de created_at mais recente, nao o ultimo recebido", async () => {
  await aplicar("hook_r5_paid", "invoice.paid", "sub_r5", "paga", "2020-02-10T10:00:00Z");
  await aplicar("hook_r5_fail", "invoice.payment_failed", "sub_r5", "recusada", "2020-02-09T10:00:00Z"); // chegou depois, e mais antigo
  const r = await registrar("sub_r5", "pendente");
  assert.equal(r.status, "paga");
  assert.equal(r.reconciliada, true);
  const { rows } = await db.query(
    `select ultimo_evento_tipo, ultimo_evento_gateway_em = '2020-02-10T10:00:00Z'::timestamptz as em_ok
       from public.auditor_assinaturas where pagarme_subscription_id = 'sub_r5'`);
  assert.deepEqual(rows, [{ ultimo_evento_tipo: "invoice.paid", em_ok: true }]);
  // depois de registrada, aviso mais antigo que o ultimo aplicado continua sem efeito
  const r2 = await aplicar("hook_r5_fail2", "charge.payment_failed", "sub_r5", "recusada", "2020-02-09T12:00:00Z");
  assert.equal(r2.ignorado, "fora_de_ordem");
  assert.equal(await statusDe("sub_r5"), "paga");
});

test("registrar: reconciliacao respeita cancelada final", async () => {
  await aplicar("hook_r6_canc", "subscription.canceled", "sub_r6", "cancelada", "2020-03-01T10:00:00Z");
  await aplicar("hook_r6_paid", "charge.paid", "sub_r6", "paga", "2020-03-05T10:00:00Z"); // mais novo, mas cancelada e final
  const r = await registrar("sub_r6", "pendente");
  assert.equal(r.status, "cancelada");
  assert.equal(r.reconciliada, true);
  const r2 = await aplicar("hook_r6_paid2", "invoice.paid", "sub_r6", "paga", "2020-03-09T10:00:00Z");
  assert.deepEqual(r2, { applied: false, duplicado: false, ignorado: "cancelada_final" });
  assert.equal(await statusDe("sub_r6"), "cancelada");
});

test("registrar: recusa status fora de pendente/recusada e subscription nula", async () => {
  await assert.rejects(registrar("sub_r4", "paga"), /status invalido/);
  await assert.rejects(registrar(null, "pendente"), /subscription_id obrigatorio/);
});

test("registrar: execute so para service_role e so existe a assinatura nova", async () => {
  const fn = "public.registrar_assinatura_auditor(text, text, text, text, text, text, text, text)";
  const ex = await db.query(
    `select has_function_privilege('anon', '${fn}', 'execute') as anon,
            has_function_privilege('authenticated', '${fn}', 'execute') as auth,
            has_function_privilege('service_role', '${fn}', 'execute') as service`);
  assert.deepEqual(ex.rows[0], { anon: false, auth: false, service: true });
  const n = await db.query("select count(*)::int as n from pg_proc where proname = 'registrar_assinatura_auditor'");
  assert.equal(n.rows[0].n, 1);
});

// F-01 (Oscar): aviso fora de ordem nao sobrescreve o status. Ordem = created_at do Pagar.me.
test("F-01 (1) cancelada e depois charge.paid com created_at mais antigo: continua cancelada e fora da lista", async () => {
  await registrar("sub_f1", "pendente");
  assert.equal((await aplicar("hook_f1_paid", "invoice.paid", "sub_f1", "paga", "2020-01-01T10:00:00Z")).applied, true);
  assert.equal((await aplicar("hook_f1_canc", "subscription.canceled", "sub_f1", "cancelada", "2020-01-05T10:00:00Z")).applied, true);
  const r = await aplicar("hook_f1_late", "charge.paid", "sub_f1", "paga", "2020-01-03T10:00:00Z");
  assert.deepEqual(r, { applied: false, duplicado: false, ignorado: "cancelada_final" });
  assert.equal(await statusDe("sub_f1"), "cancelada");
  assert.equal(await naLista("sub_f1"), false);
  const { rows } = await db.query(
    `select status_aplicado, evento_em = '2020-01-03T10:00:00Z'::timestamptz as em_ok
       from public.auditor_assinatura_eventos where gateway_event_id = 'hook_f1_late'`);
  assert.deepEqual(rows, [{ status_aplicado: "paga", em_ok: true }]); // o evento fica gravado
});

test("F-01 (2) cancelada e depois paid com created_at MAIS NOVO: continua cancelada (final)", async () => {
  await registrar("sub_f2", "pendente");
  await aplicar("hook_f2_paid", "invoice.paid", "sub_f2", "paga", "2020-01-01T10:00:00Z");
  await aplicar("hook_f2_canc", "subscription.canceled", "sub_f2", "cancelada", "2020-01-05T10:00:00Z");
  const r = await aplicar("hook_f2_new", "charge.paid", "sub_f2", "paga", "2020-01-09T10:00:00Z");
  assert.deepEqual(r, { applied: false, duplicado: false, ignorado: "cancelada_final" });
  const r2 = await aplicar("hook_f2_semdata", "invoice.paid", "sub_f2", "paga", null); // sem created_at: now()
  assert.equal(r2.ignorado, "cancelada_final");
  assert.equal(await statusDe("sub_f2"), "cancelada");
  assert.equal(await naLista("sub_f2"), false);
});

test("F-01 (3) invoice.paid e depois payment_failed com created_at mais antigo: continua paga e na lista", async () => {
  await registrar("sub_f3", "pendente");
  await aplicar("hook_f3_paid", "invoice.paid", "sub_f3", "paga", "2020-01-10T10:00:00Z");
  const r = await aplicar("hook_f3_fail", "invoice.payment_failed", "sub_f3", "recusada", "2020-01-09T10:00:00Z");
  assert.deepEqual(r, { applied: false, duplicado: false, ignorado: "fora_de_ordem" });
  assert.equal(await statusDe("sub_f3"), "paga");
  assert.equal(await naLista("sub_f3"), true);
  const { rows } = await db.query(
    `select ultimo_evento_tipo, ultimo_evento_gateway_em = '2020-01-10T10:00:00Z'::timestamptz as em_ok
       from public.auditor_assinaturas where pagarme_subscription_id = 'sub_f3'`);
  assert.deepEqual(rows, [{ ultimo_evento_tipo: "invoice.paid", em_ok: true }]);
});

test("F-01 (4) reenvio do mesmo id: duplicado true, 1 linha, nada muda", async () => {
  const sel = `select status, updated_at, ultimo_evento_tipo, ultimo_evento_gateway_em
                 from public.auditor_assinaturas where pagarme_subscription_id = 'sub_f3'`;
  const antes = await db.query(sel);
  for (const id of ["hook_f3_paid", "hook_f3_fail"]) {
    const r = await aplicar(id, "charge.payment_failed", "sub_f3", "recusada", "2020-01-20T10:00:00Z");
    assert.deepEqual(r, { applied: false, duplicado: true });
    const { rows } = await db.query(
      "select count(*)::int as n from public.auditor_assinatura_eventos where gateway_event_id = $1", [id]);
    assert.equal(rows[0].n, 1);
  }
  assert.deepEqual((await db.query(sel)).rows, antes.rows);
});

test("F-01: aviso mais novo continua valendo (recusa depois do pagamento muda para recusada)", async () => {
  const r = await aplicar("hook_f3_fail_novo", "charge.payment_failed", "sub_f3", "recusada", "2020-01-11T10:00:00Z");
  assert.equal(r.applied, true);
  assert.equal(await statusDe("sub_f3"), "recusada");
});

test("F-01: cancelamento atrasado (created_at mais antigo que o ultimo aplicado) ainda cancela", async () => {
  await registrar("sub_f5", "pendente");
  await aplicar("hook_f5_paid", "invoice.paid", "sub_f5", "paga", "2020-01-10T10:00:00Z");
  const r = await aplicar("hook_f5_canc", "subscription.canceled", "sub_f5", "cancelada", "2020-01-08T10:00:00Z");
  assert.equal(r.applied, true);
  assert.equal(await statusDe("sub_f5"), "cancelada");
  assert.equal(await naLista("sub_f5"), false);
});

test("evento sem created_at: grava evento_em nulo e usa a hora do recebimento (now())", async () => {
  await registrar("sub_f6", "pendente");
  await aplicar("hook_f6_paid", "invoice.paid", "sub_f6", "paga", "2020-01-10T10:00:00Z");
  const r = await aplicar("hook_f6_fail", "charge.payment_failed", "sub_f6", "recusada", null);
  assert.equal(r.applied, true);
  assert.equal(await statusDe("sub_f6"), "recusada");
  const { rows } = await db.query(
    "select evento_em from public.auditor_assinatura_eventos where gateway_event_id = 'hook_f6_fail'");
  assert.equal(rows[0].evento_em, null);
  const r2 = await aplicar("hook_f6_paid_velho", "invoice.paid", "sub_f6", "paga", "2020-01-11T10:00:00Z");
  assert.equal(r2.ignorado, "fora_de_ordem"); // created_at anterior ao recebimento do aviso sem data
  assert.equal(await statusDe("sub_f6"), "recusada");
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
