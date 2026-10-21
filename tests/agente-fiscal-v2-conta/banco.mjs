// Banco local do Supabase para as provas do lote B (.checks/agente-fiscal-v2.md). Os fixtures são
// gravados como `postgres`; o código sob teste fala com o banco só pelas funções `public.fiscal_*`,
// com o papel `service_role`, como as edge functions. Molde: tests/assinatura-fiscal/banco.mjs.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const URL_PADRAO = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const URL_DO_BANCO = process.env.NOFISCAL_TEST_DATABASE_URL ?? URL_PADRAO;

function urlLocal(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("as provas da conta fiscal só rodam no banco local");
  }
  return url;
}

function urlComPapel(url, papel) {
  const u = new URL(url);
  u.searchParams.set("options", `-c role=${papel}`);
  return u.toString();
}

export function abrirBancos() {
  const dono = new pg.Pool({ connectionString: urlLocal(URL_DO_BANCO), max: 2 });
  const servico = new pg.Pool({ connectionString: urlComPapel(urlLocal(URL_DO_BANCO), "service_role"), max: 2 });
  return { dono, servico, fechar: async () => { await dono.end(); await servico.end(); } };
}

const digitos = (n) => Array.from(randomBytes(n), (b) => String(b % 10)).join("");
export const cnpjAleatorio = () => digitos(14);
export const telefoneAleatorio = () => `+55119${digitos(8)}`;
export const emailAleatorio = () => `conta-${randomBytes(6).toString("hex")}@example.test`;
export const subIdAleatorio = () => `sub_${randomBytes(8).toString("hex")}`;

/**
 * Emitente do self-service no meio ou no fim do onboarding: usuário dono, `clients`, `memberships`,
 * conta com e-mail confirmado, tenant e telefone do dono. Opcional: dados fiscais e certificado.
 */
export async function criarEmpresa(dono, {
  plano = "inicial",
  etapa = "dados_fiscais",
  configurado = false,
  certificado = false,
  trialEndsAt = null,
} = {}) {
  const userId = randomUUID();
  const clientId = randomUUID();
  const cnpj = cnpjAleatorio();
  const email = emailAleatorio();
  const telefone = telefoneAleatorio();
  await dono.query(
    `insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, '{"role":"FISCAL_CLIENT"}', $3, now(), now())`,
    [userId, email, JSON.stringify({ responsavel: "Maria Responsável" })],
  );
  await dono.query("insert into public.clients (id, name, slug) values ($1, $2, $3)", [
    clientId, `Cliente ${clientId.slice(0, 8)}`, `fiscal-conta-teste-${clientId}`,
  ]);
  await dono.query("insert into public.memberships (user_id, client_id, role) values ($1, $2, 'CLIENT')", [userId, clientId]);
  await dono.query(
    `insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id)
     values ($1, $2, $3, now(), $4)`,
    [userId, email, telefone, clientId],
  );
  const { rows } = await dono.query(
    `insert into nofiscal.fiscal_tenants
       (cnpj, razao_social, codigo_municipio_ibge, cnae, api_key_hash, plan, monthly_note_limit, active,
        ambiente, client_id, onboarding_etapa, trial_ends_at, p_tot_trib_sn, codigo_servico_nacional)
     values ($1, $2, '3550308', '6201501', $3, $4, $5, true, 'producao_restrita', $6, $7, $8, $9, $10)
     returning id`,
    [
      cnpj, `Empresa de teste ${cnpj}`, randomBytes(32).toString("hex"), plano, plano === "pro" ? 100 : 20, clientId,
      etapa, trialEndsAt, configurado ? "6.00" : null, configurado ? "010701" : null,
    ],
  );
  const tenantId = rows[0].id;
  const fone = await dono.query(
    "insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role) values ($1, $2, 'owner') returning id",
    [tenantId, telefone],
  );
  const e = { userId, clientId, tenantId, cnpj, email, telefone, phoneId: fone.rows[0].id, subs: [] };
  if (certificado) {
    await dono.query("select nofiscal.upsert_certificate($1, $2, $3, $4, $5)", [
      tenantId,
      `TESTPFX${randomBytes(48).toString("base64")}`,
      `senha-${randomBytes(6).toString("hex")}`,
      `CN=EMPRESA TESTE:${cnpj}`,
      new Date(Date.now() + 365 * 24 * 3600 * 1000),
    ]);
  }
  return e;
}

/** Assinatura gravada direto (o checkout é da v1/lote A). */
export async function criarAssinatura(dono, e, {
  status = "paga",
  comTeste = false,
  plano = null,
  criadaEm = new Date(),
  agendadoPara = null,
} = {}) {
  const subId = subIdAleatorio();
  const { rows } = await dono.query(
    `insert into nofiscal.fiscal_subscriptions
       (tenant_id, plano, com_teste, pagarme_customer_id, pagarme_subscription_id, status, aceite_em, aceite_texto,
        created_at, cancelamento_agendado_para, cancelamento_pedido_em, cancelamento_origem)
     values ($1, coalesce($2, (select plan from nofiscal.fiscal_tenants where id = $1)), $3, 'cus_teste', $4, $5, now(),
             'aceite de teste', $6, $7, $7, case when $7::timestamptz is null then null else 'site' end)
     returning id`,
    [e.tenantId, plano, comTeste, subId, status, criadaEm, agendadoPara],
  );
  e.subs.push(subId);
  return { id: rows[0].id, subId };
}

export async function apagarEmpresa(dono, e) {
  await dono.query("delete from nofiscal.fiscal_subscription_events where pagarme_subscription_id = any($1)", [e.subs]);
  await dono.query("delete from nofiscal.fiscal_subscriptions where tenant_id = $1", [e.tenantId]);
  const cert = await dono.query(
    "delete from nofiscal.fiscal_certificates where tenant_id = $1 returning vault_secret_id", [e.tenantId]);
  for (const r of cert.rows) await dono.query("delete from vault.secrets where id = $1", [r.vault_secret_id]);
  await dono.query("delete from nofiscal.fiscal_requests where tenant_id = $1", [e.tenantId]);
  await dono.query("delete from nofiscal.fiscal_models where tenant_id = $1", [e.tenantId]);
  await dono.query("delete from nofiscal.fiscal_invoice_events where invoice_id in (select id from nofiscal.fiscal_invoices where tenant_id = $1)", [e.tenantId]);
  await dono.query("delete from nofiscal.fiscal_invoices where tenant_id = $1", [e.tenantId]);
  await dono.query("delete from nofiscal.fiscal_dps_series where tenant_id = $1", [e.tenantId]);
  await dono.query("delete from nofiscal.fiscal_phones where tenant_id = $1", [e.tenantId]);
  await dono.query("delete from nofiscal.fiscal_certificate_attempts where tenant_id = $1", [e.tenantId]);
  await dono.query("delete from nofiscal.fiscal_tenants where id = $1", [e.tenantId]);
  await dono.query("delete from nofiscal.fiscal_accounts where user_id = $1", [e.userId]);
  await dono.query("delete from public.memberships where client_id = $1", [e.clientId]);
  await dono.query("delete from public.clients where id = $1", [e.clientId]);
  await dono.query("delete from auth.users where id = $1", [e.userId]);
}

export const sha256 = (texto) => createHash("sha256").update(texto, "utf8").digest("hex");

/** As funções public.fiscal_* do lote B (e o webhook da v1), chamadas com o papel das edge functions. */
export function funcoesDoBanco(servico) {
  const um = async (sql, args) => (await servico.query(sql, args)).rows[0].r;
  return {
    estado: (userId) => um("select public.fiscal_conta_estado($1) as r", [userId]),
    configurar: (userId, dados) => um("select public.fiscal_configurar($1, $2::jsonb) as r", [userId, JSON.stringify(dados)]),
    trocarPlano: (userId, plano) => um("select public.fiscal_trocar_plano($1, $2) as r", [userId, plano]),
    agendarCancelamento: (userId, fim) =>
      um("select public.fiscal_agendar_cancelamento($1, $2::timestamptz) as r", [userId, fim]),
    apagarConta: (userId) => um("select public.fiscal_apagar_conta($1) as r", [userId]),
    segredoOk: (segredo) => um("select public.fiscal_ciclo_segredo_ok($1) as r", [segredo]),
    vencidas: (limite) => um("select public.fiscal_cancelamentos_vencidos($1) as r", [limite]),
    contextoCheckout: (userId) => um("select public.fiscal_assinatura_contexto($1) as r", [userId]),
    aplicarEvento: (a) =>
      um("select public.fiscal_aplicar_evento_assinatura($1, $2, $3, $4, $5::jsonb, $6::timestamptz) as r", [
        a.p_gateway_event_id, a.p_tipo, a.p_subscription_id, a.p_status, JSON.stringify(a.p_payload), a.p_evento_em,
      ]),
  };
}
