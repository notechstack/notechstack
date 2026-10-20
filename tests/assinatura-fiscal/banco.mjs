// Banco local do Supabase para as provas do lote C (Landing, "Provas do lote C contra o banco local").
// Os fixtures são gravados como `postgres`; o código sob teste fala com o banco só pelas quatro
// funções `public.fiscal_*`, com o papel `service_role`, como as edge functions.
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const URL_PADRAO = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const URL_DO_BANCO = process.env.NOFISCAL_TEST_DATABASE_URL ?? URL_PADRAO;

function urlLocal(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("as provas da assinatura fiscal só rodam no banco local");
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
export const cpfAleatorio = () => digitos(11);
export const telefoneAleatorio = () => `+55119${digitos(8)}`;
export const emailAleatorio = () => `dono-${randomBytes(6).toString("hex")}@example.test`;

/**
 * Tenant do self-service pronto para assinar: usuário dono, `clients`, `memberships`, conta
 * ativa, configuração fiscal e certificado válido (a emissão só depende da assinatura).
 */
export async function criarEmpresa(dono, { cnpj = cnpjAleatorio(), email = emailAleatorio(), telefone = telefoneAleatorio() } = {}) {
  const userId = randomUUID();
  const clientId = randomUUID();
  await dono.query(
    `insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, 'authenticated', 'authenticated', $2, '{"role":"CLIENT"}', '{}', now(), now())`,
    [userId, email],
  );
  await dono.query("insert into public.clients (id, name, slug) values ($1, $2, $3)", [
    clientId, `Cliente ${clientId.slice(0, 8)}`, `assinatura-fiscal-${clientId}`,
  ]);
  await dono.query("insert into public.memberships (user_id, client_id, role) values ($1, $2, 'CLIENT')", [userId, clientId]);
  await dono.query(
    `insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, phone_verified_at, client_id)
     values ($1, $2, $3, now(), now(), $4)`,
    [userId, email, telefone, clientId],
  );
  const { rows } = await dono.query(
    `insert into nofiscal.fiscal_tenants
       (cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, active,
        p_tot_trib_sn, ambiente, client_id, codigo_servico_nacional)
     values ($1, $2, '3550308', $3, 'inicial', 20, true, '6.00', 'producao_restrita', $4, '010701')
     returning id`,
    [cnpj, `Empresa de teste ${cnpj}`, randomBytes(32).toString("hex"), clientId],
  );
  const tenantId = rows[0].id;
  await dono.query("select nofiscal.upsert_certificate($1, $2, $3, $4, $5)", [
    tenantId,
    `TESTPFX${randomBytes(48).toString("base64")}`,
    `senha-${randomBytes(6).toString("hex")}`,
    `CN=EMPRESA TESTE:${cnpj}`,
    new Date(Date.now() + 365 * 24 * 3600 * 1000),
  ]);
  return { userId, clientId, tenantId, cnpj, email, telefone };
}

export async function apagarEmpresa(dono, empresa) {
  const subs = await dono.query(
    "select pagarme_subscription_id from nofiscal.fiscal_subscriptions where tenant_id = $1", [empresa.tenantId]);
  const ids = subs.rows.map((r) => r.pagarme_subscription_id);
  await dono.query("delete from nofiscal.fiscal_subscription_events where pagarme_subscription_id = any($1)", [ids]);
  await dono.query("delete from nofiscal.fiscal_subscriptions where tenant_id = $1", [empresa.tenantId]);
  const cert = await dono.query(
    "delete from nofiscal.fiscal_certificates where tenant_id = $1 returning vault_secret_id", [empresa.tenantId]);
  for (const r of cert.rows) await dono.query("delete from vault.secrets where id = $1", [r.vault_secret_id]);
  await dono.query("delete from nofiscal.fiscal_tenants where id = $1", [empresa.tenantId]);
  await dono.query("delete from nofiscal.fiscal_accounts where user_id = $1", [empresa.userId]);
  await dono.query("delete from public.memberships where client_id = $1", [empresa.clientId]);
  await dono.query("delete from public.clients where id = $1", [empresa.clientId]);
  await dono.query("delete from auth.users where id = $1", [empresa.userId]);
}

export async function apagarReivindicacoes(dono, hashes) {
  for (const [kind, hash] of Object.entries(hashes)) {
    await dono.query("delete from nofiscal.fiscal_trial_claims where kind = $1 and hash = $2", [kind, hash]);
  }
}

export async function apagarEventos(dono, subscriptionIds) {
  await dono.query("delete from nofiscal.fiscal_subscription_events where pagarme_subscription_id = any($1)", [subscriptionIds]);
}

/** As quatro funções do lote A, chamadas com o papel das edge functions. */
export function funcoesDoBanco(servico) {
  return {
    async contexto(userId) {
      const { rows } = await servico.query("select public.fiscal_assinatura_contexto($1) as r", [userId]);
      return rows[0].r;
    },
    async reivindicarTeste(tenantId, hashes) {
      const { rows } = await servico.query("select public.fiscal_reivindicar_teste($1, $2::jsonb) as r", [
        tenantId, JSON.stringify(hashes),
      ]);
      return rows[0].r;
    },
    async registrar(l) {
      const { rows } = await servico.query(
        "select public.fiscal_registrar_assinatura($1, $2, $3, $4, $5, $6, $7, $8) as r",
        [l.tenant_id, l.plano, l.com_teste, l.trial_ends_at, l.customer_id, l.subscription_id, l.status, l.aceite_texto],
      );
      return rows[0].r;
    },
    async aplicarEvento(a) {
      const { rows } = await servico.query(
        "select public.fiscal_aplicar_evento_assinatura($1, $2, $3, $4, $5::jsonb, $6::timestamptz) as r",
        [a.p_gateway_event_id, a.p_tipo, a.p_subscription_id, a.p_status, JSON.stringify(a.p_payload), a.p_evento_em],
      );
      return rows[0].r;
    },
  };
}
