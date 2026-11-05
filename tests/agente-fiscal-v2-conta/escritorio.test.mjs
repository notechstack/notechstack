// Conta Escritório em "Minha conta" (.design/agente-fiscal-escritorio.md: "Painel do escritório", "Adicionar e
// desativar empresa", "Dados fiscais por empresa", "Troca de faixa", "Relatório"). As ações passam pelo núcleo
// da edge function `fiscal-conta` e pelas funções `public.fiscal_*` da migração 20261105180000, no banco local,
// com o papel `service_role`. A Receita (BrasilAPI) e o Pagar.me são dublês.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  MSG_CNPJ_INVALIDO,
  MSG_FORA_DO_SIMPLES,
  MSG_NAO_ENCONTRADO,
  processarConta,
} from "../../supabase/functions/fiscal-conta/core.ts";
import { abrirBancos, apagarEmpresa, criarAssinatura, criarEmpresa, funcoesDoBanco } from "./banco.mjs";

const API = "https://pagarme.simulado/core/v5";
const RECEITA = "https://receita.simulada";
const ENV = {
  PAGARME_ASSINATURA_SECRET_KEY: "sk_test_x",
  PAGARME_ASSINATURA_API_URL: `${API}/`,
  PAGARME_ASSINATURA_AMBIENTE: "sandbox",
  CNPJ_API_URL: RECEITA,
};
const CODIGOS = new Set(["010701", "010702", "170201"]);

const bancos = abrirBancos();
const banco = funcoesDoBanco(bancos.servico);
const um = async (sql, args) => (await bancos.servico.query(sql, args)).rows[0].r;
const escritorioDoBanco = {
  escritorio: (u) => um("select public.fiscal_escritorio_estado($1) as r", [u]),
  empresaAdicionar: (u, a) =>
    um("select public.fiscal_empresa_adicionar($1, $2, $3, $4, $5, $6, $7, $8) as r", [
      u, a.cnpj, a.razao_social, a.codigo_municipio_ibge, a.cnae, a.regime, a.api_key_hash, a.ambiente,
    ]),
  empresaConfigurar: (u, t, d) => um("select public.fiscal_empresa_configurar($1, $2, $3::jsonb) as r", [u, t, JSON.stringify(d)]),
  empresaAtivar: (u, t, a) => um("select public.fiscal_empresa_ativar($1, $2, $3) as r", [u, t, a]),
  relatorio: (u, m, t) => um("select public.fiscal_relatorio($1, $2::date, $3) as r", [u, m, t]),
};

const contas = [];

/** CNPJ com dígitos verificadores certos (o núcleo recusa os inválidos antes da Receita). */
function cnpjValido() {
  const base = Array.from(randomBytes(12), (b) => b % 10);
  base[8] = 0; base[9] = 0; base[10] = 0; base[11] = 1;
  const dv = (nums, pesos) => {
    const r = nums.reduce((s, n, i) => s + n * pesos[i], 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...base, d1, d2].join("");
}

async function escritorio({ plano = "escritorio_5", status = "paga" } = {}) {
  const e = await criarEmpresa(bancos.dono, { plano, etapa: "certificado" });
  e.filhas = [];
  contas.push(e);
  if (status) await criarAssinatura(bancos.dono, e, { status });
  return e;
}

async function comum(opcoes = {}) {
  const e = await criarEmpresa(bancos.dono, opcoes);
  e.filhas = [];
  contas.push(e);
  return e;
}

test.after(async () => {
  for (const e of contas) {
    const { rows } = await bancos.dono.query("select id from nofiscal.fiscal_tenants where escritorio_tenant_id = $1", [e.tenantId]);
    for (const { id } of rows) {
      await bancos.dono.query("delete from nofiscal.fiscal_invoice_entregas where invoice_id in (select id from nofiscal.fiscal_invoices where tenant_id = $1)", [id]);
      await bancos.dono.query("delete from nofiscal.fiscal_invoices where tenant_id = $1", [id]);
      await bancos.dono.query("delete from nofiscal.fiscal_dps_series where tenant_id = $1", [id]);
      await bancos.dono.query("delete from nofiscal.fiscal_tenants where id = $1", [id]);
    }
    await bancos.dono.query("delete from nofiscal.fiscal_invoice_entregas where invoice_id in (select id from nofiscal.fiscal_invoices where tenant_id = $1)", [e.tenantId]);
    await apagarEmpresa(bancos.dono, e);
  }
  await bancos.fechar();
});

/** Dublê da BrasilAPI (por CNPJ) e do Pagar.me; registra as chamadas. */
function rede({ receita = {}, pagarme = () => ({}) } = {}) {
  const chamadas = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    chamadas.push({ url, method: init.method ?? "GET", body });
    const m = /\/api\/cnpj\/v1\/(\d{14})$/.exec(url);
    if (m) {
      const r = receita[m[1]] ?? {};
      if (r.http) return { ok: false, status: r.http, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          razao_social: `CLIENTE ${m[1]} LTDA`,
          codigo_municipio_ibge: 3550308,
          municipio: "SAO PAULO",
          uf: "SP",
          cnae_fiscal: 6920601,
          descricao_situacao_cadastral: "ATIVA",
          opcao_pelo_mei: false,
          opcao_pelo_simples: true,
          ...r,
        }),
      };
    }
    const r = pagarme(init.method, url, body) || {};
    const http = r.http ?? 200;
    return { ok: http < 300, status: http, json: async () => r.json ?? {} };
  };
  return { fetch, chamadas, receita: () => chamadas.filter((c) => c.url.startsWith(RECEITA)), pagarme: () => chamadas.filter((c) => c.url.startsWith(API)) };
}

async function conta(e, body, { gw = rede(), env = {}, deps = {} } = {}) {
  const r = await processarConta("POST", body, {
    env: { ...ENV, ...env },
    fetch: gw.fetch,
    sessao: async () => e.userId,
    estado: banco.estado,
    configurar: banco.configurar,
    trocarPlano: banco.trocarPlano,
    agendarCancelamento: banco.agendarCancelamento,
    apagarConta: banco.apagarConta,
    codigosServico: async () => CODIGOS,
    ...escritorioDoBanco,
    municipios: async () => null,
    log: () => {},
    ...deps,
  });
  return { ...r, gw };
}

async function tenant(id) {
  const { rows } = await bancos.dono.query(
    `select plan, monthly_note_limit, client_id, escritorio_tenant_id, regime, api_key_hash, ambiente, onboarding_etapa,
            codigo_servico_nacional, p_tot_trib_sn::text as pct, active, razao_social, cnae
       from nofiscal.fiscal_tenants where id = $1`,
    [id],
  );
  return rows[0];
}

async function adicionar(e, opcoes = {}) {
  const cnpj = opcoes.cnpj ?? cnpjValido();
  const r = await conta(e, { acao: "empresa_adicionar", cnpj }, opcoes);
  assert.equal(r.http, 200, JSON.stringify(r.body));
  return { cnpj, tenantId: r.body.adicionada.tenant_id, r };
}

// ---------------------------------------------------------------------------------------------

test("estado do escritório e da conta comum", async () => {
  const e = await escritorio();
  const r = await conta(e, { acao: "estado" });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.plano, "escritorio_5");
  const esc = r.body.escritorio;
  assert.ok(esc, "estado traz `escritorio`");
  assert.equal(esc.escritorio_tenant_id, e.tenantId);
  assert.equal(esc.max_empresas, 5);
  assert.equal(esc.empresas_ativas, 1);
  assert.equal(esc.notas_limite, 500);
  assert.equal(esc.notas_mes, 0);
  assert.equal(esc.empresas.length, 1);
  assert.equal(esc.empresas[0].principal, true);
  assert.equal(esc.empresas[0].situacao, "falta_certificado");

  // Conta Inicial/Pro: sem `escritorio`, e a função do escritório nem é chamada.
  const c = await comum({ plano: "pro" });
  let chamou = false;
  const rc = await conta(c, { acao: "estado" }, { deps: { escritorio: async () => { chamou = true; return null; } } });
  assert.equal(rc.http, 200);
  assert.equal(Object.hasOwn(rc.body, "escritorio"), false);
  assert.equal(chamou, false);
});

test("adicionar empresa", async () => {
  const e = await escritorio();
  const { cnpj, tenantId, r } = await adicionar(e);
  assert.equal(r.body.adicionada.reativada, false);
  assert.equal(r.body.escritorio.empresas.length, 2);
  const nova = r.body.escritorio.empresas.find((x) => x.tenant_id === tenantId);
  assert.equal(nova.cnpj, cnpj);
  assert.equal(nova.principal, false);
  assert.equal(nova.situacao, "falta_certificado");
  assert.equal(r.gw.receita().length, 1, "consulta a Receita");
  assert.equal(r.gw.pagarme().length, 0);

  const t = await tenant(tenantId);
  assert.equal(t.escritorio_tenant_id, e.tenantId);
  assert.equal(t.client_id, null);
  assert.equal(t.razao_social, `CLIENTE ${cnpj} LTDA`);
  assert.equal(t.cnae, "6920601");
  assert.equal(t.regime, "simples");
  assert.match(t.api_key_hash, /^[0-9a-f]{64}$/);
  assert.equal(t.ambiente, "producao_restrita");
  assert.equal(t.plan, "escritorio_5");
  assert.equal(t.monthly_note_limit, 500);
  assert.equal(t.onboarding_etapa, "certificado");

  // FISCAL_AMBIENTE_PADRAO=producao, como no cadastro; MEI vem da Receita.
  const mei = cnpjValido();
  const p = await adicionar(e, { cnpj: mei, env: { FISCAL_AMBIENTE_PADRAO: "producao" }, gw: rede({ receita: { [mei]: { opcao_pelo_mei: true } } }) });
  const tm = await tenant(p.tenantId);
  assert.equal(tm.ambiente, "producao");
  assert.equal(tm.regime, "mei");

  // Fora do Simples/MEI: o mesmo texto do cadastro, e nada gravado.
  const fora = cnpjValido();
  const rf = await conta(e, { acao: "empresa_adicionar", cnpj: fora }, { gw: rede({ receita: { [fora]: { opcao_pelo_mei: null, opcao_pelo_simples: false } } }) });
  assert.equal(rf.http, 422);
  assert.equal(rf.body.error_code, "CNPJ_FORA_DO_SIMPLES");
  assert.equal(rf.body.mensagem, MSG_FORA_DO_SIMPLES);
  const cadastro = readFileSync(new URL("../../supabase/functions/fiscal-cadastro/core.ts", import.meta.url), "utf8");
  for (const msg of [MSG_FORA_DO_SIMPLES, MSG_NAO_ENCONTRADO, MSG_CNPJ_INVALIDO]) {
    assert.ok(cadastro.includes(msg), `mesmo texto de fiscal-cadastro: ${msg}`);
  }
  const n = (await bancos.dono.query("select count(*)::int n from nofiscal.fiscal_tenants where cnpj = $1", [fora])).rows[0].n;
  assert.equal(n, 0);

  // Não encontrado e Receita fora do ar.
  const sumido = cnpjValido();
  const rn = await conta(e, { acao: "empresa_adicionar", cnpj: sumido }, { gw: rede({ receita: { [sumido]: { http: 404 } } }) });
  assert.equal(rn.http, 404);
  assert.equal(rn.body.error_code, "CNPJ_NAO_ENCONTRADO");
  const caiu = cnpjValido();
  const ri = await conta(e, { acao: "empresa_adicionar", cnpj: caiu }, { gw: rede({ receita: { [caiu]: { http: 503 } } }) });
  assert.equal(ri.http, 503);
  assert.equal(ri.body.error_code, "CONSULTA_INDISPONIVEL");

  // CNPJ inválido: nem chega à Receita.
  const inval = await conta(e, { acao: "empresa_adicionar", cnpj: "11.111.111/1111-11" });
  assert.equal(inval.http, 422);
  assert.equal(inval.body.error_code, "CNPJ_INVALIDO");
  assert.equal(inval.gw.chamadas.length, 0);

  // Já na lista; CNPJ de outra conta.
  const rep = await conta(e, { acao: "empresa_adicionar", cnpj });
  assert.equal(rep.http, 409);
  assert.equal(rep.body.error_code, "CNPJ_JA_CADASTRADO");
  assert.equal(rep.gw.chamadas.length, 0);
  // (O CNPJ aleatório do fixture não tem DV: troca por um válido.)
  const outra = await comum({});
  const valido = cnpjValido();
  await bancos.dono.query("update nofiscal.fiscal_tenants set cnpj = $2 where id = $1", [outra.tenantId, valido]);
  const ro2 = await conta(e, { acao: "empresa_adicionar", cnpj: valido });
  assert.equal(ro2.http, 409, JSON.stringify(ro2.body));
  assert.equal(ro2.body.error_code, "CNPJ_JA_CADASTRADO");
  assert.equal(ro2.body.mensagem, "Este CNPJ já está cadastrado no nó.fiscal.");

  // Limite da faixa: 3 ativas + 2 = 5; a sexta é recusada antes da Receita.
  await adicionar(e);
  await adicionar(e);
  const cheio = await conta(e, { acao: "empresa_adicionar", cnpj: cnpjValido() });
  assert.equal(cheio.http, 409);
  assert.equal(cheio.body.error_code, "EMPRESAS_ACIMA_DO_LIMITE");
  assert.equal(cheio.body.mensagem, "Seu plano permite até 5 empresas.");
  assert.equal(cheio.body.limite, 5);
  assert.equal(cheio.gw.chamadas.length, 0);

  // A função do banco também barra (a edge function não é a única barreira).
  const direto = await escritorioDoBanco.empresaAdicionar(e.userId, {
    cnpj: cnpjValido(), razao_social: "X", codigo_municipio_ibge: "3550308", cnae: null, regime: "simples",
    api_key_hash: "a".repeat(64), ambiente: "producao_restrita",
  });
  assert.equal(direto.erro, "EMPRESAS_ACIMA_DO_LIMITE");

  // Conta Inicial/Pro não adiciona empresa.
  const pro = await comum({ plano: "pro" });
  const rp = await conta(pro, { acao: "empresa_adicionar", cnpj: cnpjValido() });
  assert.equal(rp.http, 403);
  assert.equal(rp.body.error_code, "PLANO_SEM_EMPRESAS");
  assert.equal(rp.gw.chamadas.length, 0);
});

test("dados fiscais por empresa", async () => {
  const e = await escritorio();
  const { tenantId } = await adicionar(e);
  const r = await conta(e, { acao: "empresa_configurar", tenant_id: tenantId, codigo_servico_nacional: "170201", p_tot_trib_sn: "6,5" });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  const t = await tenant(tenantId);
  assert.equal(t.codigo_servico_nacional, "170201");
  assert.equal(t.pct, "6.50");
  assert.equal(t.onboarding_etapa, "concluido", "empresa do escritório não passa por clientes nem ativação");
  const linha = r.body.escritorio.empresas.find((x) => x.tenant_id === tenantId);
  assert.equal(linha.codigo_servico_nacional, "170201");
  assert.equal(linha.situacao, "falta_certificado");

  // A própria empresa do escritório (conta-mãe).
  const rm = await conta(e, { acao: "empresa_configurar", tenant_id: e.tenantId, codigo_servico_nacional: "010701", p_tot_trib_sn: 4 });
  assert.equal(rm.http, 200, JSON.stringify(rm.body));
  assert.equal((await tenant(e.tenantId)).codigo_servico_nacional, "010701");

  // MEI: sem percentual.
  const mei = cnpjValido();
  const m = await adicionar(e, { cnpj: mei, gw: rede({ receita: { [mei]: { opcao_pelo_mei: true } } }) });
  const rmei = await conta(e, { acao: "empresa_configurar", tenant_id: m.tenantId, codigo_servico_nacional: "010702" });
  assert.equal(rmei.http, 200, JSON.stringify(rmei.body));
  assert.equal((await tenant(m.tenantId)).pct, null);

  // Inválidos: código fora da lista, percentual fora da faixa; nada gravado.
  for (const [dados, campo] of [
    [{ codigo_servico_nacional: "999999", p_tot_trib_sn: 6 }, "codigo_servico_nacional"],
    [{ codigo_servico_nacional: "010701", p_tot_trib_sn: 101 }, "p_tot_trib_sn"],
  ]) {
    const ri = await conta(e, { acao: "empresa_configurar", tenant_id: tenantId, ...dados });
    assert.equal(ri.http, 422, JSON.stringify(ri.body));
    assert.equal(ri.body.campo, campo);
  }
  assert.equal((await tenant(tenantId)).codigo_servico_nacional, "170201");

  // Empresa de outra conta: 403, e o banco também recusa.
  const outra = await comum({});
  const ro = await conta(e, { acao: "empresa_configurar", tenant_id: outra.tenantId, codigo_servico_nacional: "010701", p_tot_trib_sn: 6 });
  assert.equal(ro.http, 403);
  assert.equal(ro.body.error_code, "FORBIDDEN");
  const direto = await escritorioDoBanco.empresaConfigurar(e.userId, outra.tenantId, { codigo_servico_nacional: "010701", p_tot_trib_sn: "6" });
  assert.equal(direto.erro, "FORBIDDEN");
  const sem = await conta(e, { acao: "empresa_configurar", codigo_servico_nacional: "010701" });
  assert.equal(sem.http, 400);
});

test("desativar e reativar empresa", async () => {
  const e = await escritorio();
  const { tenantId } = await adicionar(e);
  const r = await conta(e, { acao: "empresa_ativar", tenant_id: tenantId, ativa: false });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.escritorio.empresas_ativas, 1);
  assert.equal(r.body.escritorio.empresas.find((x) => x.tenant_id === tenantId).situacao, "desativada");
  assert.equal((await tenant(tenantId)).active, false);

  // A empresa do escritório não se desativa.
  const rp = await conta(e, { acao: "empresa_ativar", tenant_id: e.tenantId, ativa: false });
  assert.equal(rp.http, 409);
  assert.equal(rp.body.error_code, "EMPRESA_PRINCIPAL");

  // Sem `ativa` booleano: 400.
  const rb = await conta(e, { acao: "empresa_ativar", tenant_id: tenantId, ativa: "sim" });
  assert.equal(rb.http, 400);

  // Com a faixa cheia, reativar é recusado; adicionar o mesmo CNPJ desativado também.
  for (let i = 0; i < 4; i += 1) await adicionar(e);
  const cheio = await conta(e, { acao: "empresa_ativar", tenant_id: tenantId, ativa: true });
  assert.equal(cheio.http, 409);
  assert.equal(cheio.body.mensagem, "Seu plano permite até 5 empresas.");

  // Desativa outra e reativa a primeira.
  const outra = (await escritorioDoBanco.escritorio(e.userId)).empresas.find((x) => !x.principal && x.ativa);
  assert.equal((await conta(e, { acao: "empresa_ativar", tenant_id: outra.tenant_id, ativa: false })).http, 200);
  const volta = await conta(e, { acao: "empresa_ativar", tenant_id: tenantId, ativa: true });
  assert.equal(volta.http, 200, JSON.stringify(volta.body));
  assert.equal((await tenant(tenantId)).active, true);

  // Conta comum: 403.
  const c = await comum({});
  const rc = await conta(c, { acao: "empresa_ativar", tenant_id: c.tenantId, ativa: false });
  assert.equal(rc.http, 403);
});

test("trocar faixa do escritório", async () => {
  const e = await escritorio();
  const { tenantId } = await adicionar(e);
  const itens = (method, url) =>
    method === "GET" && url.endsWith("/items") ? { json: { data: [{ id: "si_ativo", status: "active" }] } } : { json: {} };

  const r = await conta(e, { acao: "trocar_plano", plano: "escritorio_20" }, { gw: rede({ pagarme: itens }) });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.equal(r.body.plano, "escritorio_20");
  assert.equal(r.body.escritorio.max_empresas, 20);
  const put = r.gw.pagarme().find((c) => c.method === "PUT");
  assert.ok(put.url.endsWith("/items/si_ativo"));
  assert.deepEqual(put.body.pricing_scheme, { scheme_type: "unit", price: 79700 });
  assert.equal(put.body.name, "Agente Fiscal Escritório 20");
  assert.equal(put.body.description, "Assinatura Agente Fiscal Escritório 20 · nó tech stack");
  // A faixa vale para a conta-mãe e para as empresas do escritório.
  assert.equal((await tenant(e.tenantId)).plan, "escritorio_20");
  assert.equal((await tenant(e.tenantId)).monthly_note_limit, 2000);
  assert.equal((await tenant(tenantId)).plan, "escritorio_20");

  // Mais empresas ativas que a faixa de destino: 409 antes do Pagar.me.
  for (let i = 0; i < 4; i += 1) await adicionar(e);
  const menor = await conta(e, { acao: "trocar_plano", plano: "escritorio_5" }, { gw: rede({ pagarme: itens }) });
  assert.equal(menor.http, 409, JSON.stringify(menor.body));
  assert.equal(menor.body.error_code, "EMPRESAS_ACIMA_DO_LIMITE");
  assert.equal(menor.body.mensagem, "Você tem 6 empresas ativas, e esta faixa permite até 5. Desative empresas antes de trocar.");
  assert.equal(menor.gw.chamadas.length, 0);
  // O banco repete a regra.
  const direto = await banco.trocarPlano(e.userId, "escritorio_5");
  assert.equal(direto.erro, "EMPRESAS_ACIMA_DO_LIMITE");
  assert.equal((await tenant(e.tenantId)).plan, "escritorio_20");

  // Entre famílias: recusado sem Pagar.me, nos dois sentidos.
  const fam = await conta(e, { acao: "trocar_plano", plano: "pro" }, { gw: rede({ pagarme: itens }) });
  assert.equal(fam.http, 409);
  assert.equal(fam.body.error_code, "PLANO_DE_OUTRA_FAMILIA");
  assert.equal(fam.gw.chamadas.length, 0);
  const pro = await comum({ plano: "pro" });
  await criarAssinatura(bancos.dono, pro, { status: "paga" });
  const fam2 = await conta(pro, { acao: "trocar_plano", plano: "escritorio_5" }, { gw: rede({ pagarme: itens }) });
  assert.equal(fam2.http, 409);
  assert.equal(fam2.body.error_code, "PLANO_DE_OUTRA_FAMILIA");
  assert.equal(fam2.gw.chamadas.length, 0);
  assert.equal((await banco.trocarPlano(pro.userId, "escritorio_5")).erro, "PLANO_DE_OUTRA_FAMILIA");

  // Faixa desconhecida.
  const x = await conta(e, { acao: "trocar_plano", plano: "escritorio_100" });
  assert.equal(x.http, 400);
  assert.equal(x.body.mensagem, "Escolha uma das faixas: até 5, 20 ou 50 empresas.");
});

test("relatório do mês", async () => {
  const e = await escritorio();
  const { tenantId, cnpj } = await adicionar(e);
  const nota = async (t, status, extra = {}) => {
    const { rows } = await bancos.dono.query(
      `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, status, xml_nfse, last_error, issued_at, created_at)
       values ($1, $2, $3::jsonb, $4, $5, $6, $7, coalesce($8, now())) returning id`,
      [
        t, `rel-${randomBytes(6).toString("hex")}`,
        JSON.stringify({ tomador: { nome: "Tomador Um", cnpj: "11444777000161", email: "fin@tomador.test" }, servico: { codigo_servico_nacional: "170201", descricao: "Honorários contábeis" }, valor: extra.valor ?? "250.00" }),
        status, extra.xml ?? null, extra.erro ?? null, status === "issued" ? new Date() : null, extra.criada ?? null,
      ],
    );
    return rows[0].id;
  };
  const emitida = await nota(tenantId, "issued", { xml: "<NFSe/>", valor: "1500.50" });
  await nota(tenantId, "rejected", { erro: "E0712 código de tributação inválido" });
  await nota(e.tenantId, "queued");
  await nota(e.tenantId, "issued", { xml: "<NFSe/>", criada: new Date(Date.now() - 70 * 24 * 3600 * 1000) });
  await bancos.dono.query(
    `insert into nofiscal.fiscal_invoice_entregas (invoice_id, canal, papel, destino, status)
     values ($1, 'email', 'tomador', 'fin@tomador.test', 'enviado'), ($1, 'whatsapp', 'escritorio', '+5511999990000', 'falhou')`,
    [emitida],
  );

  const r = await conta(e, { acao: "relatorio" }, { deps: { agora: () => new Date() } });
  assert.equal(r.http, 200, JSON.stringify(r.body));
  assert.match(r.body.mes, /^\d{4}-\d{2}$/);
  assert.equal(r.body.totais.emitidas, 1);
  assert.equal(Number(r.body.totais.valor_emitido), 1500.5);
  assert.equal(r.body.totais.recusadas, 1);
  assert.equal(r.body.totais.na_fila, 1);
  assert.equal(r.body.notas.length, 3, "a nota de 70 dias atrás fica de fora");
  const n = r.body.notas.find((x) => x.invoice_id === emitida);
  assert.equal(n.empresa.cnpj, cnpj);
  assert.equal(n.tomador.nome, "Tomador Um");
  assert.equal(n.descricao, "Honorários contábeis");
  assert.equal(n.codigo_tributacao, "170201");
  assert.equal(n.valor, "1500.50");
  assert.equal(n.tem_pdf, true);
  assert.deepEqual(n.entregas.map((x) => `${x.canal}:${x.destino}:${x.status}`), [
    "email:fin@tomador.test:enviado", "whatsapp:+5511999990000:falhou",
  ]);
  const recusada = r.body.notas.find((x) => x.situacao === "rejected");
  assert.equal(recusada.tem_pdf, false);
  assert.equal(recusada.motivo, "E0712 código de tributação inválido");

  // Só uma empresa.
  const so = await conta(e, { acao: "relatorio", mes: r.body.mes, tenant_id: e.tenantId });
  assert.equal(so.http, 200);
  assert.equal(so.body.notas.length, 1);
  assert.equal(so.body.tenant_id, e.tenantId);

  // Mês sem notas.
  const vazio = await conta(e, { acao: "relatorio", mes: "2020-01" });
  assert.equal(vazio.http, 200);
  assert.deepEqual(vazio.body.notas, []);
  assert.equal(vazio.body.totais.emitidas, 0);

  // Mês inválido; empresa de outra conta.
  assert.equal((await conta(e, { acao: "relatorio", mes: "2026-13" })).http, 400);
  const outra = await comum({});
  const ro = await conta(e, { acao: "relatorio", mes: r.body.mes, tenant_id: outra.tenantId });
  assert.equal(ro.http, 403);
  assert.equal(ro.body.error_code, "FORBIDDEN");
});
