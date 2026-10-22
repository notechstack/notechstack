// Provas de C2, C3, C6 e C8 (.checks/agente-fiscal-v2.md, lote A): o handler real de fiscal-cadastro
// com a BrasilAPI em dublê e o banco local pela public.fiscal_cadastro_criar (papel service_role).
import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../../supabase/functions/fiscal-cadastro/core.ts";
import { LISTA_MUNICIPIOS } from "../../supabase/functions/_shared/fiscal/municipios.ts";
import {
  abrirBancos,
  apagarCadastro,
  brasilApi,
  cnpjValido,
  criarUsuario,
  funcoesDoBanco,
  respostaBrasilApi,
  telefoneAleatorio,
} from "./banco.mjs";

const bancos = abrirBancos();
const banco = funcoesDoBanco(bancos.servico);
const limpar = [];
test.after(async () => {
  for (const c of limpar) await apagarCadastro(bancos.dono, c);
  await bancos.fechar();
});

// Lista injetada: só São Paulo emite pelo padrão nacional.
const LISTA = { fonte: "https://lista.simulada/municipios", codigos_ibge: ["3550308"] };
const FORA_DO_PADRAO = 4106902; // Curitiba, fora da lista injetada

function pedido(corpo, token = "sessao") {
  return new Request("https://funcoes.local/fiscal-cadastro", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://www.notechstack.com.br", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(corpo),
  });
}

async function chamar(corpo, { api, userId = null, env = {}, lista = LISTA, criar = banco.criar } = {}) {
  const chamadasCriar = [];
  const res = await handle(pedido(corpo, userId ? "sessao" : null), {
    env: (k) => ({ CNPJ_API_URL: "https://cnpj.simulado", ...env })[k],
    fetch: api.fetch,
    sessao: async () => userId,
    municipios: async () => lista,
    criar: async (a) => { chamadasCriar.push(a); return criar(a); },
    log: () => {},
  });
  return { status: res.status, body: await res.json(), chamadasCriar };
}

async function contar(cnpj, telefone, email) {
  const { rows } = await bancos.dono.query(
    `select (select count(*) from nofiscal.fiscal_tenants where cnpj = $1)::int as tenants,
            (select count(*) from nofiscal.fiscal_phones where phone_e164 = $2)::int as phones,
            (select count(*) from public.clients where email = $3)::int as clients`,
    [cnpj, telefone, email],
  );
  return rows[0];
}

test("consultar cnpj: válido devolve 200 com os 7 campos", async () => {
  const cnpj = cnpjValido();
  const api = brasilApi({ [cnpj]: respostaBrasilApi(cnpj) });
  const r = await chamar({ acao: "consultar_cnpj", cnpj: `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}` }, { api });
  assert.equal(r.status, 200);
  assert.equal(r.body.cnpj, cnpj);
  assert.equal(r.body.razao_social, `EMPRESA TESTE ${cnpj} LTDA`);
  assert.equal(r.body.municipio, "SAO PAULO");
  assert.equal(r.body.uf, "SP");
  assert.equal(r.body.codigo_municipio_ibge, "3550308");
  assert.equal(r.body.cnae, "6201501");
  assert.equal(r.body.padrao_nacional, true);
  assert.deepEqual(api.chamadas, [`https://cnpj.simulado/api/cnpj/v1/${cnpj}`]);
});

test("consultar cnpj: dígito errado responde 422 CNPJ_INVALIDO sem consultar", async () => {
  const cnpj = cnpjValido();
  const errado = cnpj.slice(0, 13) + String((Number(cnpj[13]) + 1) % 10);
  const api = brasilApi({});
  const r = await chamar({ acao: "consultar_cnpj", cnpj: errado }, { api });
  assert.equal(r.status, 422);
  assert.equal(r.body.error_code, "CNPJ_INVALIDO");
  assert.equal(api.chamadas.length, 0);
});

test("consultar cnpj: inexistente responde 404 CNPJ_NAO_ENCONTRADO", async () => {
  const r = await chamar({ acao: "consultar_cnpj", cnpj: cnpjValido() }, { api: brasilApi({}) });
  assert.equal(r.status, 404);
  assert.equal(r.body.error_code, "CNPJ_NAO_ENCONTRADO");
  assert.equal(r.body.ok, false);
});

test("consultar cnpj: fora do ar (rede ou 5xx) responde 503 CONSULTA_INDISPONIVEL", async () => {
  const a = cnpjValido();
  const b = cnpjValido();
  const api = brasilApi({ [a]: "fora", [b]: 502 });
  for (const cnpj of [a, b]) {
    const r = await chamar({ acao: "consultar_cnpj", cnpj }, { api });
    assert.equal(r.status, 503);
    assert.equal(r.body.error_code, "CONSULTA_INDISPONIVEL");
  }
});

// Lucca, 22/10/2026: só cria empresa com o CNPJ confirmado e ATIVO na Receita; fora do ar também bloqueia.
test("cnpj real e ativo: baixado, inapto, sem situação e consulta fora não criam nada", async () => {
  const casos = [
    ["BAIXADA", 422, "CNPJ_INATIVO"],
    ["INAPTA", 422, "CNPJ_INATIVO"],
    ["", 503, "CONSULTA_INDISPONIVEL"],
    ["fora", 503, "CONSULTA_INDISPONIVEL"],
    ["inexistente", 404, "CNPJ_NAO_ENCONTRADO"],
  ];
  for (const [situacao, status, codigo] of casos) {
    const cnpj = cnpjValido();
    const telefone = telefoneAleatorio();
    const u = await criarUsuario(bancos.dono);
    limpar.push({ userId: u.id, cnpj, telefone });
    const resposta = situacao === "fora" ? "fora" : situacao === "inexistente" ? undefined : respostaBrasilApi(cnpj, { situacao });
    const api = brasilApi(resposta === undefined ? {} : { [cnpj]: resposta });
    const consulta = await chamar({ acao: "consultar_cnpj", cnpj }, { api });
    assert.equal(consulta.status, status, situacao);
    assert.equal(consulta.body.error_code, codigo, situacao);
    if (codigo === "CNPJ_INATIVO") assert.match(consulta.body.mensagem, new RegExp(situacao.toLowerCase()));
    const r = await chamar({ acao: "criar", cnpj, razao_social: "Empresa", responsavel: "Maria Souza", telefone, plano: "pro" }, { api, userId: u.id });
    assert.equal(r.status, status, `criar ${situacao}`);
    assert.equal(r.body.error_code, codigo, `criar ${situacao}`);
    assert.equal(r.chamadasCriar.length, 0, `criar ${situacao}`);
    assert.deepEqual(await contar(cnpj, telefone, u.email), { tenants: 0, phones: 0, clients: 0 });
  }
});

test("consultar cnpj: sem CNPJ_API_URL usa a BrasilAPI oficial", async () => {
  const cnpj = cnpjValido();
  const api = brasilApi({ [cnpj]: respostaBrasilApi(cnpj) });
  await chamar({ acao: "consultar_cnpj", cnpj }, { api, env: { CNPJ_API_URL: undefined } });
  assert.deepEqual(api.chamadas, [`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`]);
});

test("município fora do padrão: consulta diz padrao_nacional false e criar responde 422 sem gravar nada", async () => {
  const cnpj = cnpjValido();
  const telefone = telefoneAleatorio();
  const u = await criarUsuario(bancos.dono);
  limpar.push({ userId: u.id, cnpj, telefone });
  const api = brasilApi({ [cnpj]: respostaBrasilApi(cnpj, { ibge: FORA_DO_PADRAO, municipio: "CURITIBA", uf: "PR" }) });

  const consulta = await chamar({ acao: "consultar_cnpj", cnpj }, { api });
  assert.equal(consulta.status, 200);
  assert.equal(consulta.body.padrao_nacional, false);

  // Mesmo que o corpo diga outro município, vale o da consulta.
  const r = await chamar(
    { acao: "criar", cnpj, razao_social: "Empresa", responsavel: "Maria Souza", telefone, plano: "pro", codigo_municipio_ibge: "3550308" },
    { api, userId: u.id },
  );
  assert.equal(r.status, 422);
  assert.equal(r.body.error_code, "MUNICIPIO_FORA_DO_PADRAO");
  assert.equal(r.chamadasCriar.length, 0);
  assert.deepEqual(await contar(cnpj, telefone, u.email), { tenants: 0, phones: 0, clients: 0 });
  const conta = await bancos.dono.query("select 1 from nofiscal.fiscal_accounts where user_id = $1", [u.id]);
  assert.equal(conta.rowCount, 0);
});

test("município fora do padrão: com a lista real do lote P, Salvador fica fora e São Paulo passa", async () => {
  // A mesma lista que o index.ts da função usa (municipios-padrao-nacional.json, embutido).
  assert.ok(LISTA_MUNICIPIOS.fonte.startsWith("https://www.gov.br/nfse/"));
  const salvador = cnpjValido();
  const saoPaulo = cnpjValido();
  const telefone = telefoneAleatorio();
  const u = await criarUsuario(bancos.dono);
  limpar.push({ userId: u.id, cnpj: salvador, telefone });
  const api = brasilApi({
    [salvador]: respostaBrasilApi(salvador, { ibge: 2927408, municipio: "SALVADOR", uf: "BA" }),
    [saoPaulo]: respostaBrasilApi(saoPaulo),
  });
  const fora = await chamar({ acao: "consultar_cnpj", cnpj: salvador }, { api, lista: LISTA_MUNICIPIOS });
  assert.equal(fora.body.padrao_nacional, false);
  const dentro = await chamar({ acao: "consultar_cnpj", cnpj: saoPaulo }, { api, lista: LISTA_MUNICIPIOS });
  assert.equal(dentro.body.padrao_nacional, true);

  const r = await chamar(
    { acao: "criar", cnpj: salvador, razao_social: "Empresa", responsavel: "Maria Souza", telefone, plano: "inicial" },
    { api, userId: u.id, lista: LISTA_MUNICIPIOS },
  );
  assert.equal(r.status, 422);
  assert.equal(r.body.error_code, "MUNICIPIO_FORA_DO_PADRAO");
  assert.equal(r.chamadasCriar.length, 0);
  assert.deepEqual(await contar(salvador, telefone, u.email), { tenants: 0, phones: 0, clients: 0 });
});

test("município fora do padrão: lista sem fonte (lote P sem resposta) deixa todos passarem", async () => {
  const cnpj = cnpjValido();
  const api = brasilApi({ [cnpj]: respostaBrasilApi(cnpj, { ibge: FORA_DO_PADRAO }) });
  for (const lista of [null, { fonte: null, codigos_ibge: [] }]) {
    const r = await chamar({ acao: "consultar_cnpj", cnpj }, { api, lista });
    assert.equal(r.body.padrao_nacional, true);
  }
});

test("criar empresa: sessão válida responde 201 e grava cliente, vínculo, conta, tenant e telefone do dono", async () => {
  const cnpj = cnpjValido();
  const telefone = telefoneAleatorio();
  const u = await criarUsuario(bancos.dono);
  limpar.push({ userId: u.id, cnpj, telefone });
  const api = brasilApi({ [cnpj]: respostaBrasilApi(cnpj) });

  const r = await chamar(
    { acao: "criar", cnpj, razao_social: "Nome digitado", responsavel: "Maria Souza", telefone: `(11) ${telefone.slice(5, 10)}-${telefone.slice(10)}`, plano: "pro" },
    { api, userId: u.id },
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.etapa, "pagamento");
  assert.match(r.body.tenant_id, /^[0-9a-f-]{36}$/);

  const t = (await bancos.dono.query(
    `select id, client_id, cnpj, razao_social, codigo_municipio_ibge, cnae, plan, monthly_note_limit, ambiente,
            api_key_hash, onboarding_etapa, pago_em
       from nofiscal.fiscal_tenants where id = $1`, [r.body.tenant_id])).rows[0];
  assert.equal(t.cnpj, cnpj);
  assert.equal(t.razao_social, `EMPRESA TESTE ${cnpj} LTDA`);
  assert.equal(t.codigo_municipio_ibge, "3550308");
  assert.equal(t.cnae, "6201501");
  assert.ok(t.client_id);
  assert.equal(t.plan, "pro");
  assert.equal(t.monthly_note_limit, 100);
  assert.equal(t.ambiente, "producao_restrita");
  assert.match(t.api_key_hash, /^[0-9a-f]{64}$/);
  assert.equal(t.onboarding_etapa, "pagamento");
  assert.equal(t.pago_em, null);

  const cliente = (await bancos.dono.query("select origem, name from public.clients where id = $1", [t.client_id])).rows[0];
  assert.equal(cliente.origem, "fiscal");
  const vinculo = await bancos.dono.query("select role from public.memberships where user_id = $1 and client_id = $2", [u.id, t.client_id]);
  assert.deepEqual(vinculo.rows, [{ role: "CLIENT" }]);

  const conta = (await bancos.dono.query(
    "select email, phone_e164, email_verified_at, phone_verified_at, client_id from nofiscal.fiscal_accounts where user_id = $1", [u.id])).rows[0];
  assert.equal(conta.email, u.email);
  assert.equal(conta.phone_e164, telefone);
  assert.ok(conta.email_verified_at instanceof Date);
  assert.equal(conta.phone_verified_at, null);
  assert.equal(conta.client_id, t.client_id);

  const fones = await bancos.dono.query("select phone_e164, role, verified_at from nofiscal.fiscal_phones where tenant_id = $1", [t.id]);
  assert.deepEqual(fones.rows, [{ phone_e164: telefone, role: "owner", verified_at: null }]);

  const serie = await bancos.dono.query("select serie, next_number::int as n from nofiscal.fiscal_dps_series where tenant_id = $1", [t.id]);
  assert.deepEqual(serie.rows, [{ serie: "1", n: 1 }]);

  const meta = await bancos.dono.query("select raw_user_meta_data ->> 'responsavel' as r from auth.users where id = $1", [u.id]);
  assert.equal(meta.rows[0].r, "Maria Souza");
});

test("criar empresa: sem sessão responde 401 e plano desconhecido vale inicial", async () => {
  const cnpj = cnpjValido();
  const telefone = telefoneAleatorio();
  const api = brasilApi({ [cnpj]: respostaBrasilApi(cnpj) });
  const sem = await chamar({ acao: "criar", cnpj, razao_social: "X", responsavel: "Maria Souza", telefone, plano: "pro" }, { api });
  assert.equal(sem.status, 401);
  assert.equal(sem.body.error_code, "SEM_SESSAO");

  const u = await criarUsuario(bancos.dono);
  limpar.push({ userId: u.id, cnpj, telefone });
  const r = await chamar({ acao: "criar", cnpj, razao_social: "X", responsavel: "Maria Souza", telefone, plano: "ouro" }, { api, userId: u.id, env: { FISCAL_AMBIENTE_PADRAO: "producao" } });
  assert.equal(r.status, 201);
  const t = (await bancos.dono.query("select plan, monthly_note_limit, ambiente from nofiscal.fiscal_tenants where id = $1", [r.body.tenant_id])).rows[0];
  assert.deepEqual(t, { plan: "inicial", monthly_note_limit: 20, ambiente: "producao" });

  // A página repete o mesmo pedido (retentativa): mesmo tenant, nada duplicado.
  const de_novo = await chamar({ acao: "criar", cnpj, razao_social: "X", responsavel: "Maria Souza", telefone, plano: "inicial" }, { api, userId: u.id });
  assert.equal(de_novo.status, 201);
  assert.equal(de_novo.body.tenant_id, r.body.tenant_id);
});

test("conflitos no cadastro: CNPJ repetido e WhatsApp de outra empresa respondem 409 sem criar nada", async () => {
  const cnpjA = cnpjValido();
  const telA = telefoneAleatorio();
  const dono = await criarUsuario(bancos.dono);
  limpar.push({ userId: dono.id, cnpj: cnpjA, telefone: telA });
  const cnpjB = cnpjValido();
  const telB = telefoneAleatorio();
  const api = brasilApi({ [cnpjA]: respostaBrasilApi(cnpjA), [cnpjB]: respostaBrasilApi(cnpjB) });
  const primeiro = await chamar({ acao: "criar", cnpj: cnpjA, razao_social: "A", responsavel: "Dono A", telefone: telA, plano: "inicial" }, { api, userId: dono.id });
  assert.equal(primeiro.status, 201);

  // Outra pessoa com o mesmo CNPJ.
  const outro = await criarUsuario(bancos.dono);
  limpar.push({ userId: outro.id, cnpj: cnpjB, telefone: telB });
  const cnpjRepetido = await chamar({ acao: "criar", cnpj: cnpjA, razao_social: "A", responsavel: "Outra Pessoa", telefone: telB, plano: "pro" }, { api, userId: outro.id });
  assert.equal(cnpjRepetido.status, 409);
  assert.equal(cnpjRepetido.body.error_code, "CNPJ_JA_CADASTRADO");
  assert.equal(cnpjRepetido.body.mensagem, "Este CNPJ já tem conta. Entre pela sua conta");

  // Outra empresa com o WhatsApp do primeiro dono.
  const telRepetido = await chamar({ acao: "criar", cnpj: cnpjB, razao_social: "B", responsavel: "Outra Pessoa", telefone: telA, plano: "pro" }, { api, userId: outro.id });
  assert.equal(telRepetido.status, 409);
  assert.equal(telRepetido.body.error_code, "TELEFONE_DE_OUTRA_EMPRESA");
  assert.equal(telRepetido.body.mensagem, "Este WhatsApp já está ligado a outra empresa");

  assert.deepEqual(await contar(cnpjB, telB, outro.email), { tenants: 0, phones: 0, clients: 0 });
  const tenantsA = await bancos.dono.query("select count(*)::int as n from nofiscal.fiscal_tenants where cnpj = $1", [cnpjA]);
  assert.equal(tenantsA.rows[0].n, 1);
  const contaOutro = await bancos.dono.query("select 1 from nofiscal.fiscal_accounts where user_id = $1", [outro.id]);
  assert.equal(contaOutro.rowCount, 0);
  const vinculos = await bancos.dono.query("select 1 from public.memberships where user_id = $1", [outro.id]);
  assert.equal(vinculos.rowCount, 0);
});

test("consultar cnpj: a consulta vai com user-agent próprio (a BrasilAPI dá 403 ao 'node')", async () => {
  const { consultarCnpj, USER_AGENT } = await import("../../supabase/functions/_shared/fiscal/cnpj.ts");
  const cnpj = cnpjValido();
  let headers;
  await consultarCnpj(cnpj, { fetch: async (_url, init) => { headers = init.headers; return new Response(JSON.stringify(respostaBrasilApi(cnpj)), { status: 200 }); } });
  assert.equal(headers["User-Agent"], USER_AGENT);
  assert.match(USER_AGENT, /^no-fiscal\//);
});
