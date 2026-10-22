// Provas de C5, C9 e C7s (.checks/agente-fiscal-v2.md, lote A).
// C5 e C9: handler real de fiscal-acesso, limite pela public.fiscal_acesso_preparar no banco local
// (service_role), GoTrue admin e Resend em dublê (o envio passa pelo enviarResend real).
// C7s: verificar pela função, com o GoTrue local de verdade (rotas abertas do Kong: /otp e /verify;
// código lido na caixa local) e a contagem em public.fiscal_acesso_conferir.
import test from "node:test";
import assert from "node:assert/strict";
import { handle, verificarGoTrue } from "../../supabase/functions/fiscal-acesso/core.ts";
import { enviarResend } from "../../supabase/functions/_shared/fiscal/email.ts";
import {
  abrirBancos,
  apagarUsuario,
  AUTH_LOCAL,
  criarUsuario,
  emailAleatorio,
  funcoesDoBanco,
  ipAleatorio,
  MAILPIT_LOCAL,
  sha256,
} from "./banco.mjs";

const SAL = "sal-do-acesso-de-teste";
const bancos = abrirBancos();
const banco = funcoesDoBanco(bancos.servico);
const usuarios = [];
const emails = [];
const ips = [];
test.after(async () => {
  for (const e of emails) {
    const chave = sha256(`${SAL}:email:${e}`);
    await bancos.dono.query("delete from public.fiscal_acesso_tentativas where chave_email = $1", [chave]);
    await bancos.dono.query("delete from public.fiscal_acesso_codigos where chave_email = $1", [chave]);
  }
  for (const ip of ips) await bancos.dono.query("delete from public.fiscal_acesso_tentativas where chave_ip = $1", [sha256(`${SAL}:ip:${ip}`)]);
  for (const id of usuarios) await apagarUsuario(bancos.dono, id);
  await bancos.fechar();
});

// Dublê da Resend: guarda o corpo enviado e devolve um id.
function resend() {
  const enviados = [];
  const fetch = async (url, init) => {
    enviados.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: `email_${enviados.length}` }), { status: 200 });
  };
  return { fetch, enviados };
}

function cenario({ env = {}, deps: extra = {} } = {}) {
  const r = resend();
  const criados = [];
  const codigos = [];
  const deps = {
    env: (k) => ({ FISCAL_ACESSO_SALT: SAL, ...env })[k],
    preparar: banco.preparar,
    criarUsuario: async (email, appMetadata) => { criados.push({ email, appMetadata }); return "novo"; },
    gerarCodigo: async () => {
      const c = String(100000 + Math.floor(Math.random() * 900000));
      codigos.push(c);
      return c;
    },
    enviar: (para, email) => enviarResend({
      apiUrl: (env.RESEND_API_URL || "https://api.resend.com").replace(/\/+$/, ""),
      apiKey: "re_teste", remetente: "nó.fiscal <notas@notechstack.com.br>", para, email, fetch: r.fetch,
    }),
    registrarCodigo: async (chave, hash) => {
      await bancos.servico.query("select public.fiscal_acesso_registrar_codigo($1, $2)", [chave, hash]);
    },
    conferir: async (chave, hash, validade) =>
      (await bancos.servico.query("select public.fiscal_acesso_conferir($1, $2, $3) as r", [chave, hash, validade])).rows[0].r,
    consumir: async (chave) => { await bancos.servico.query("select public.fiscal_acesso_consumir($1)", [chave]); },
    descartarCodigo: async () => {},
    verificarNoGoTrue: async () => { throw new Error("não usado"); },
    log: () => {},
    ...extra,
  };
  return { deps, enviados: r.enviados, criados, codigos };
}

async function pedir(deps, email, ip, corpo = {}) {
  emails.push(email.trim().toLowerCase());
  ips.push(ip);
  const res = await handle(new Request("https://funcoes.local/fiscal-acesso", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": ip, Origin: "https://www.notechstack.com.br" },
    body: JSON.stringify({ email, ...corpo }),
  }), deps);
  return { status: res.status, body: await res.json() };
}

function seisDigitos(s) {
  return s.match(/\d{6}/g) ?? [];
}

test("código por e-mail: 202 para e-mail novo e existente, um código de 6 dígitos e nenhum link", async () => {
  const c = cenario();
  const novo = emailAleatorio();
  const existente = await criarUsuario(bancos.dono);
  usuarios.push(existente.id);

  const r1 = await pedir(c.deps, novo, ipAleatorio());
  const r2 = await pedir(c.deps, existente.email.toUpperCase(), ipAleatorio());
  assert.deepEqual([r1.status, r1.body], [202, { ok: true }]);
  assert.deepEqual([r2.status, r2.body], [202, { ok: true }]);

  // Só o e-mail novo vira usuário, com o papel do fiscal.
  assert.deepEqual(c.criados, [{ email: novo, appMetadata: { role: "FISCAL_CLIENT" } }]);

  assert.equal(c.enviados.length, 2);
  for (const [i, { url, body }] of c.enviados.entries()) {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(body.subject, "Seu código nó.fiscal");
    assert.deepEqual(body.to, [[novo, existente.email][i]]);
    for (const parte of [body.text, body.html]) {
      assert.deepEqual(seisDigitos(parte), [c.codigos[i]], "exatamente um código de 6 dígitos");
      assert.doesNotMatch(parte, /https?:|www\.|href=|<a[\s>]/i, "nenhum link");
    }
  }
});

test("código por e-mail: conta do sistema recebe 202 sem envio; e-mail inválido 400", async () => {
  const c = cenario();
  const admin = await criarUsuario(bancos.dono, emailAleatorio(), "NO_ADMIN");
  usuarios.push(admin.id);
  const r = await pedir(c.deps, admin.email, ipAleatorio());
  assert.equal(r.status, 202);
  assert.equal(c.enviados.length, 0);
  const ruim = await pedir(c.deps, "sem-arroba", ipAleatorio());
  assert.equal(ruim.status, 400);
  assert.equal(ruim.body.motivo, "email_invalido");
});

test("código por e-mail: RESEND_API_URL troca só a base da Resend", async () => {
  const c = cenario({ env: { RESEND_API_URL: "http://localhost:3003/" } });
  const r = await pedir(c.deps, emailAleatorio(), ipAleatorio());
  assert.equal(r.status, 202);
  assert.equal(c.enviados[0].url, "http://localhost:3003/emails");
});

test("limite do código: o 4º pedido do mesmo e-mail na hora responde 429 sem envio", async () => {
  const c = cenario();
  const email = emailAleatorio();
  for (let i = 0; i < 3; i++) assert.equal((await pedir(c.deps, email, ipAleatorio())).status, 202);
  const quarto = await pedir(c.deps, email, ipAleatorio());
  assert.equal(quarto.status, 429);
  assert.equal(quarto.body.ok, false);
  assert.equal(quarto.body.motivo, "limite");
  assert.equal(c.enviados.length, 3);
});

test("limite do código: o 21º pedido do mesmo IP na hora responde 429 sem envio", async () => {
  const c = cenario();
  const ip = ipAleatorio();
  for (let i = 0; i < 20; i++) assert.equal((await pedir(c.deps, emailAleatorio(), ip)).status, 202, `pedido ${i + 1}`);
  const r = await pedir(c.deps, emailAleatorio(), ip);
  assert.equal(r.status, 429);
  assert.deepEqual([r.body.ok, r.body.motivo], [false, "limite"]);
  assert.equal(c.enviados.length, 20);
  // Sem sal, falha fechada: nada é contado nem enviado.
  const semSal = cenario({ env: { FISCAL_ACESSO_SALT: "" } });
  assert.equal((await pedir(semSal.deps, emailAleatorio(), ipAleatorio())).status, 503);
  assert.equal(semSal.enviados.length, 0);
});

// ---------------------------------------------------------------- C7s: verificar pela função

const postAuth = async (caminho, corpo) => {
  const r = await fetch(`${AUTH_LOCAL}${caminho}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// Código emitido pelo GoTrue local (POST /otp, lido na caixa de entrada local), no lugar do
// generateLink de produção, que exige a chave de serviço.
async function codigoDoGoTrue(email) {
  const r = await postAuth("/otp", { email, create_user: false });
  assert.equal(r.status, 200, "GoTrue local emitiu o código");
  for (let i = 0; i < 30; i++) {
    const busca = await (await fetch(`${MAILPIT_LOCAL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
    if (busca.messages?.length) {
      const msg = await (await fetch(`${MAILPIT_LOCAL}/api/v1/message/${busca.messages[0].ID}`)).json();
      const codigo = msg.Text.match(/code:\s*(\d{6})/)?.[1];
      assert.ok(codigo, "código no e-mail local");
      return codigo;
    }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  throw new Error("código não chegou à caixa local");
}

// O handler real com o GoTrue local: emite, confere no banco e abre a sessão no /verify de verdade.
// O descarte troca os tokens guardados pelo GoTrue, como o generateLink de produção faz.
function cenarioGoTrue() {
  const descartes = [];
  const c = cenario({
    deps: {
      gerarCodigo: codigoDoGoTrue,
      descartarCodigo: async (email) => {
        descartes.push(email);
        await bancos.dono.query(
          "update auth.users set recovery_token = '', confirmation_token = '' where lower(email) = $1", [email]);
        await bancos.dono.query(
          "delete from auth.one_time_tokens where user_id = (select id from auth.users where lower(email) = $1)", [email]);
      },
      verificarNoGoTrue: (email, codigo) => verificarGoTrue({ authUrl: AUTH_LOCAL, email, codigo }),
    },
  });
  return { ...c, descartes };
}

async function usuarioComCodigo(c) {
  const u = await criarUsuario(bancos.dono);
  usuarios.push(u.id);
  assert.equal((await pedir(c.deps, u.email, ipAleatorio())).status, 202);
  const codigo = c.enviados.at(-1).body.text.match(/\d{6}/)[0];
  return { ...u, codigo };
}

const verificar = (c, email, codigo) => pedir(c.deps, email, ipAleatorio(), { acao: "verificar", codigo });
const outro = (codigo) => String((Number(codigo) + 1) % 1000000).padStart(6, "0");

test("código errado não abre sessão: código errado responde 422 CODIGO_INCORRETO com tentativas_restantes, e o certo abre a sessão do GoTrue", async () => {
  const c = cenarioGoTrue();
  const u = await usuarioComCodigo(c);

  const errado = await verificar(c, u.email, outro(u.codigo));
  assert.equal(errado.status, 422);
  assert.equal(errado.body.error_code, "CODIGO_INCORRETO");
  assert.equal(errado.body.mensagem, "Código incorreto");
  assert.equal(errado.body.tentativas_restantes, 4);
  assert.equal("access_token" in errado.body, false);

  const certo = await verificar(c, u.email, u.codigo);
  assert.equal(certo.status, 200);
  assert.equal(typeof certo.body.access_token, "string");
  assert.equal(typeof certo.body.refresh_token, "string");
  assert.ok(certo.body.expires_at > Date.now() / 1000);

  // Código já usado não abre outra sessão.
  const repetido = await verificar(c, u.email, u.codigo);
  assert.equal(repetido.status, 422);
  assert.equal(repetido.body.error_code, "CODIGO_VENCIDO");
});

test("código errado não abre sessão: código vencido responde 422 CODIGO_VENCIDO", async () => {
  const c = cenarioGoTrue();
  const u = await usuarioComCodigo(c);
  // Enviado há 2 h; a validade padrão é 1 h (a do OTP do GoTrue).
  await bancos.dono.query("update public.fiscal_acesso_codigos set enviado_em = now() - interval '2 hours' where chave_email = $1", [
    sha256(`${SAL}:email:${u.email}`),
  ]);
  const r = await verificar(c, u.email, u.codigo);
  assert.equal(r.status, 422);
  assert.equal(r.body.error_code, "CODIGO_VENCIDO");
  assert.equal(r.body.mensagem, "Peça um código novo");
  assert.equal("access_token" in r.body, false);
});

test("código errado não abre sessão: a 5ª tentativa errada responde 422 CODIGO_ESGOTADO e descarta o código", async () => {
  const c = cenarioGoTrue();
  const u = await usuarioComCodigo(c);
  for (let restantes = 4; restantes >= 1; restantes--) {
    const r = await verificar(c, u.email, outro(u.codigo));
    assert.deepEqual([r.status, r.body.error_code, r.body.tentativas_restantes], [422, "CODIGO_INCORRETO", restantes]);
  }
  const quinta = await verificar(c, u.email, outro(u.codigo));
  assert.equal(quinta.status, 422);
  assert.equal(quinta.body.error_code, "CODIGO_ESGOTADO");
  assert.equal(quinta.body.mensagem, "Peça um código novo");
  assert.deepEqual(c.descartes, [u.email]);
  assert.equal(c.enviados.length, 1, "nenhum e-mail novo enviado sozinho");

  // Depois de esgotado, nem o código certo abre sessão: nem pela função, nem direto no GoTrue.
  const certo = await verificar(c, u.email, u.codigo);
  assert.deepEqual([certo.status, certo.body.error_code], [422, "CODIGO_ESGOTADO"]);
  assert.equal("access_token" in certo.body, false);
  const direto = await postAuth("/verify", { type: "email", email: u.email, token: u.codigo });
  assert.notEqual(direto.status, 200);
  assert.equal("access_token" in direto.body, false);
});

test("código errado não abre sessão: GoTrue fora responde 503 e o código continua valendo", async () => {
  let fora = true;
  const c = cenario({
    deps: {
      verificarNoGoTrue: async () => {
        if (fora) throw new Error("gotrue_transitorio");
        return { ok: true, sessao: { access_token: "a", refresh_token: "r", expires_at: 1 } };
      },
    },
  });
  const email = emailAleatorio();
  assert.equal((await pedir(c.deps, email, ipAleatorio())).status, 202);
  const r = await verificar(c, email, c.codigos[0]);
  assert.deepEqual([r.status, r.body.motivo], [503, "indisponivel"]);
  fora = false;
  const de_novo = await verificar(c, email, c.codigos[0]);
  assert.deepEqual([de_novo.status, de_novo.body], [200, { ok: true, access_token: "a", refresh_token: "r", expires_at: 1 }]);
});

// Código fixo da demonstração (pedido de Lucca, 22/10/2026): só com o site em localhost.
test("código fixo da demo: abre sessão em localhost e não vale com o site de produção", async () => {
  const sessao = { access_token: "at", refresh_token: "rt", expires_at: 123 };
  const conferidos = [];
  const extra = {
    verificarNoGoTrue: async (email, codigo) => { conferidos.push(codigo); return { ok: true, sessao }; },
  };
  const local = cenario({ env: { FISCAL_CODIGO_FIXO_DEMO: "123456", FISCAL_SITE_URL: "http://localhost:3000" }, deps: extra });
  const email = emailAleatorio();
  const r = await pedir(local.deps, email, ipAleatorio(), { acao: "verificar", codigo: "123456" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, ...sessao });
  assert.deepEqual(conferidos, [local.codigos[0]], "a sessão sai de um código novo do GoTrue, não do fixo");

  for (const site of ["https://www.notechstack.com.br", "", "http://localhost.evil.com"]) {
    const prod = cenario({ env: { FISCAL_CODIGO_FIXO_DEMO: "123456", FISCAL_SITE_URL: site }, deps: extra });
    const p = await pedir(prod.deps, emailAleatorio(), ipAleatorio(), { acao: "verificar", codigo: "123456" });
    assert.notEqual(p.status, 200, `site ${site || "(vazio)"}`);
    assert.equal(prod.codigos.length, 0, `site ${site || "(vazio)"}: nenhum código gerado`);
  }
});
