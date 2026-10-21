// Provas de C5, C9 e C7s (.checks/agente-fiscal-v2.md, lote A).
// C5 e C9: handler real de fiscal-acesso, limite pela public.fiscal_acesso_preparar no banco local
// (service_role), GoTrue admin e Resend em dublê (o envio passa pelo enviarResend real).
// C7s: o GoTrue local de verdade (rotas abertas do Kong: /otp e /verify; código lido na caixa local).
import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../../supabase/functions/fiscal-acesso/core.ts";
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
  for (const e of emails) await bancos.dono.query("delete from public.fiscal_acesso_tentativas where chave_email = $1", [sha256(`${SAL}:email:${e}`)]);
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

function cenario({ env = {} } = {}) {
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
    log: () => {},
  };
  return { deps, enviados: r.enviados, criados, codigos };
}

async function pedir(deps, email, ip) {
  emails.push(email.trim().toLowerCase());
  ips.push(ip);
  const res = await handle(new Request("https://funcoes.local/fiscal-acesso", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-real-ip": ip, Origin: "https://www.notechstack.com.br" },
    body: JSON.stringify({ email }),
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

// ---------------------------------------------------------------- C7s: GoTrue local

const post = async (caminho, corpo) => {
  const r = await fetch(`${AUTH_LOCAL}${caminho}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// Pede um código ao GoTrue local e o lê na caixa de entrada local.
async function codigoDoGoTrue(email) {
  const r = await post("/otp", { email, create_user: false });
  assert.equal(r.status, 200, "GoTrue local enviou o código");
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

const verificar = (email, token) => post("/verify", { type: "email", email, token });
const outro = (codigo) => String((Number(codigo) + 1) % 1000000).padStart(6, "0");

test("código errado não abre sessão: código errado e código vencido não abrem sessão no GoTrue local", async () => {
  const u = await criarUsuario(bancos.dono);
  usuarios.push(u.id);
  const codigo = await codigoDoGoTrue(u.email);

  const errado = await verificar(u.email, outro(codigo));
  assert.notEqual(errado.status, 200);
  assert.equal(errado.body.access_token, undefined);

  // Vence o código (envio há 2 h; o GoTrue local aceita por 1 h).
  await bancos.dono.query(
    "update auth.users set recovery_sent_at = now() - interval '2 hours', confirmation_sent_at = now() - interval '2 hours' where id = $1",
    [u.id],
  );
  await bancos.dono.query("update auth.one_time_tokens set created_at = now() - interval '2 hours' where user_id = $1", [u.id]);
  const vencido = await verificar(u.email, codigo);
  assert.notEqual(vencido.status, 200);
  assert.equal(vencido.body.access_token, undefined);
});

test("código errado não abre sessão: a 5ª tentativa errada invalida o código", async () => {
  const u = await criarUsuario(bancos.dono);
  usuarios.push(u.id);
  const codigo = await codigoDoGoTrue(u.email);
  for (let i = 0; i < 5; i++) assert.notEqual((await verificar(u.email, outro(codigo))).status, 200);
  const depois = await verificar(u.email, codigo);
  // Sem imprimir a sessão na falha: só se ela existe.
  assert.equal("access_token" in depois.body, false, `o código certo, depois de 5 erros, abriu sessão (HTTP ${depois.status})`);
});
