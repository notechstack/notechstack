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

// O aceite e obrigatorio (sempre true, com data, texto e whatsapp).
async function assinatura(subId, status) {
  await db.query(
    `insert into public.auditor_assinaturas
       (plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite_em, relatorio_aceite_texto)
     values ('mensal', 'Teste', $1, '11987654321', $2, $3, now(), 'aceito')`,
    [`${subId}@exemplo.com`, subId, status],
  );
}

// Aviso pela funcao real do webhook, com created_at do Pagar.me.
async function aplicar(id, tipo, subId, status, eventoEm) {
  const { rows } = await db.query(
    "select public.aplicar_evento_assinatura_auditor($1, $2, $3, $4, '{}'::jsonb, $5::timestamptz) as r",
    [id, tipo, subId, status, eventoEm]);
  return rows[0].r;
}
const diasAtras = (d) => new Date(Date.now() - d * 86400000).toISOString();

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

test("paga entra na lista e a lista traz o whatsapp; linha sem aceite nem chega a existir", async () => {
  await assinatura("sub_paga", "paga");
  await evento("hook_paga_1", "sub_paga", "paga", 10);
  assert.equal(await naLista("sub_paga"), true);
  const { rows } = await db.query(
    "select whatsapp from public.auditor_lista_envio_relatorio where pagarme_subscription_id = 'sub_paga'");
  assert.deepEqual(rows, [{ whatsapp: "11987654321" }]);
  await assert.rejects(
    db.query(`insert into public.auditor_assinaturas
                (plano, nome, email, whatsapp, pagarme_subscription_id, status, relatorio_aceite, relatorio_aceite_em, relatorio_aceite_texto)
              values ('mensal', 'X', 'x@exemplo.com', '11987654321', 'sub_sem_aceite', 'paga', false, now(), 'x')`),
    /auditor_assinaturas_aceite_obrigatorio/,
  );
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

test("o prazo conta do created_at do aviso (evento_em), nao da hora em que chegou", async () => {
  await assinatura("sub_em", "recusada");
  await evento("hook_em_paga", "sub_em", "paga", 30);
  // recebido agora, mas o Pagar.me diz que a recusa foi ha 4 dias
  await db.query(
    `insert into public.auditor_assinatura_eventos (gateway_event_id, tipo, pagarme_subscription_id, status_aplicado, evento_em)
     values ('hook_em_rec', 'teste', 'sub_em', 'recusada', now() - interval '4 days')`);
  assert.equal(await naLista("sub_em"), false);
});

test("F-01 na lista real: cancelada + charge.paid atrasado fica fora; paga + falha atrasada fica dentro", async () => {
  await assinatura("sub_f01_c", "pendente");
  await aplicar("hook_f01_c1", "invoice.paid", "sub_f01_c", "paga", diasAtras(10));
  await aplicar("hook_f01_c2", "subscription.canceled", "sub_f01_c", "cancelada", diasAtras(2));
  const r = await aplicar("hook_f01_c3", "charge.paid", "sub_f01_c", "paga", diasAtras(5));
  assert.equal(r.ignorado, "cancelada_final");
  assert.equal(await naLista("sub_f01_c"), false);

  await assinatura("sub_f01_p", "pendente");
  await aplicar("hook_f01_p1", "invoice.paid", "sub_f01_p", "paga", diasAtras(1));
  const r2 = await aplicar("hook_f01_p2", "invoice.payment_failed", "sub_f01_p", "recusada", diasAtras(2));
  assert.equal(r2.ignorado, "fora_de_ordem");
  assert.equal(await naLista("sub_f01_p"), true);
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
  const { rows } = await db.query(
    "select whatsapp from public.auditor_lista_envio_relatorio where pagarme_subscription_id = 'sub_paga'");
  assert.deepEqual(rows, [{ whatsapp: "11987654321" }]); // rollback mantem a coluna da lista de envio
  await db.exec(await readFile(ACESSO, "utf8"));
  assert.equal(await naLista("sub_rec_1d"), true);
});
