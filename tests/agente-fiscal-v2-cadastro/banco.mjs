// Banco e GoTrue locais para as provas do lote A (.checks/agente-fiscal-v2.md). Molde:
// tests/assinatura-fiscal/banco.mjs. Fixtures gravados como `postgres`; o código sob teste fala com o
// banco só pelas funções `public.fiscal_*`, com o papel `service_role`, como as edge functions.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const URL_PADRAO = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const URL_DO_BANCO = process.env.NOFISCAL_TEST_DATABASE_URL ?? URL_PADRAO;
// Rotas abertas do Kong local (sem apikey) e a caixa de entrada local do GoTrue.
export const AUTH_LOCAL = "http://127.0.0.1:54321/auth/v1";
export const MAILPIT_LOCAL = "http://127.0.0.1:54324";

function urlLocal(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") throw new Error("as provas do lote A só rodam no banco local");
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
export const sha256 = (texto) => createHash("sha256").update(texto, "utf8").digest("hex");
export const emailAleatorio = () => `v2a-${randomBytes(6).toString("hex")}@example.test`;
export const telefoneAleatorio = () => `+55119${digitos(8)}`;
export const ipAleatorio = () => `10.${randomBytes(3).join(".")}`;

// CNPJ com dígitos verificadores válidos (calculados aqui, à parte do código sob teste).
export function cnpjValido() {
  const base = digitos(12);
  const dv = (s, pesos) => {
    const r = pesos.reduce((t, p, i) => t + Number(s[i]) * p, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${d1}${d2}`;
}

export function cpfValido() {
  const base = digitos(9);
  const dv = (s) => {
    const n = s.length + 1;
    const r = (s.split("").reduce((t, c, i) => t + Number(c) * (n - i), 0) * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  return `${base}${d1}${dv(base + d1)}`;
}

/** Usuário do GoTrue com e-mail confirmado (como o fiscal-acesso deixa). */
export async function criarUsuario(dono, email = emailAleatorio(), papel = "FISCAL_CLIENT") {
  const id = randomUUID();
  await dono.query(
    `insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data,
       raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, now(), $3, '{}',
       now(), now(), '', '', '', '')`,
    [id, email, JSON.stringify({ provider: "email", providers: ["email"], role: papel })],
  );
  return { id, email };
}

export async function apagarUsuario(dono, userId) {
  await dono.query("delete from auth.users where id = $1", [userId]);
}

/** Apaga tudo o que fiscal_cadastro_criar (e o checkout) gravaram para o usuário e o CNPJ. */
export async function apagarCadastro(dono, { userId, cnpj, telefone }) {
  const t = await dono.query("select id, client_id from nofiscal.fiscal_tenants where cnpj = $1", [cnpj]);
  for (const { id, client_id } of t.rows) {
    const subs = await dono.query("select pagarme_subscription_id from nofiscal.fiscal_subscriptions where tenant_id = $1", [id]);
    await dono.query("delete from nofiscal.fiscal_subscription_events where pagarme_subscription_id = any($1)", [
      subs.rows.map((r) => r.pagarme_subscription_id),
    ]);
    await dono.query("delete from nofiscal.fiscal_subscriptions where tenant_id = $1", [id]);
    await dono.query("delete from nofiscal.fiscal_phones where tenant_id = $1", [id]);
    await dono.query("delete from nofiscal.fiscal_dps_series where tenant_id = $1", [id]);
    await dono.query("delete from nofiscal.fiscal_tenants where id = $1", [id]);
    await dono.query("delete from nofiscal.fiscal_accounts where client_id = $1", [client_id]);
    await dono.query("delete from public.memberships where client_id = $1", [client_id]);
    await dono.query("delete from public.clients where id = $1", [client_id]);
  }
  if (telefone) await dono.query("delete from nofiscal.fiscal_phones where phone_e164 = $1", [telefone]);
  if (userId) {
    await dono.query("delete from nofiscal.fiscal_accounts where user_id = $1", [userId]);
    await apagarUsuario(dono, userId);
  }
}

export async function apagarReivindicacoes(dono, hashes) {
  for (const [kind, hash] of Object.entries(hashes)) {
    await dono.query("delete from nofiscal.fiscal_trial_claims where kind = $1 and hash = $2", [kind, hash]);
  }
}

/** As funções que as edge functions chamam, com o papel service_role. */
export function funcoesDoBanco(servico) {
  const um = async (sql, args) => (await servico.query(sql, args)).rows[0].r;
  return {
    preparar: async (email, chaveEmail, chaveIp) =>
      (await servico.query("select * from public.fiscal_acesso_preparar($1, $2, $3)", [email, chaveEmail, chaveIp])).rows[0],
    criar: (a) =>
      um("select public.fiscal_cadastro_criar($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as r", [
        a.user_id, a.cnpj, a.razao_social, a.codigo_municipio_ibge, a.cnae, a.telefone, a.plano, a.responsavel,
        a.api_key_hash, a.ambiente,
      ]),
    contexto: (userId) => um("select public.fiscal_assinatura_contexto($1) as r", [userId]),
    reivindicarTeste: (tenantId, hashes) =>
      um("select public.fiscal_reivindicar_teste($1, $2::jsonb) as r", [tenantId, JSON.stringify(hashes)]),
    registrar: (l) =>
      um("select public.fiscal_registrar_assinatura($1, $2, $3, $4, $5, $6, $7, $8) as r", [
        l.tenant_id, l.plano, l.com_teste, l.trial_ends_at, l.customer_id, l.subscription_id, l.status, l.aceite_texto,
      ]),
    marcarPago: async (tenantId) => { await um("select public.fiscal_marcar_pago($1) as r", [tenantId]); },
    validarCupom: (tenantId, codigo, plano) =>
      um("select public.fiscal_validar_cupom($1, $2, $3) as r", [tenantId, codigo, plano]),
    registrarCortesia: (tenantId, plano, codigo, aceite) =>
      um("select public.fiscal_registrar_cortesia($1, $2, $3, $4) as r", [tenantId, plano, codigo, aceite]),
    usarCupom: (tenantId, codigo, plano, subscriptionId) =>
      um("select public.fiscal_usar_cupom($1, $2, $3, $4) as r", [tenantId, codigo, plano, subscriptionId]),
  };
}

/** Dublê da BrasilAPI: cnpj → resposta; "fora" simula a consulta fora do ar. */
export function brasilApi(mapa) {
  const chamadas = [];
  const fetch = async (url) => {
    chamadas.push(url);
    const cnpj = String(url).split("/").pop();
    const r = mapa[cnpj];
    if (r === "fora") throw new TypeError("fetch failed");
    if (r === undefined) return new Response(JSON.stringify({ message: "CNPJ não encontrado" }), { status: 404 });
    if (typeof r === "number") return new Response("{}", { status: r });
    return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, chamadas };
}

export function respostaBrasilApi(cnpj, { ibge = 3550308, municipio = "SAO PAULO", uf = "SP", cnae = 6201501, situacao = "ATIVA" } = {}) {
  return {
    cnpj,
    razao_social: `EMPRESA TESTE ${cnpj} LTDA`,
    nome_fantasia: "",
    municipio,
    uf,
    codigo_municipio: 7107,
    codigo_municipio_ibge: ibge,
    cnae_fiscal: cnae,
    cnae_fiscal_descricao: "Desenvolvimento de programas de computador sob encomenda",
    descricao_situacao_cadastral: situacao,
  };
}
