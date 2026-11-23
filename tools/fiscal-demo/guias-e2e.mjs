// Fluxo do módulo Guias de ponta a ponta na demonstração (critério 20 da task agente-fiscal-disparo-guias), com a
// demo no ar (`npm run fiscal:demo`; o `--sem-funcoes` basta) e o Supabase local:
//   cd tools/fiscal-demo && node --import tsx guias-e2e.mjs [--manter]
// Cria um escritório de teste com o módulo ligado e uma sessão no Auth local, e então faz o que o painel faz, pelas
// mesmas rotas (site :3000 → API :3001): importa 2 contatos, sobe 3 PDFs direto ao Storage dublê (:3007) pela URL
// assinada, lê, confere (corrige a amarela), dispara, espera o worker da demo (a cada minuto), confere que o dublê da
// Meta (:3004) recebeu o modelo com o PDF no cabeçalho e o da Resend (:3003) o e-mail com anexo, abre o link /g/,
// responde "paguei" como o cliente e confere que a guia virou "paga (informada)". No fim apaga o que criou.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const demo = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(demo, '..', '..');
const app = resolve(raiz, 'app');
const pg = createRequire(resolve(app, 'package.json'))('pg');
const { gerarGuiaPdf, cnpjDe } = await import(pathToFileURL(resolve(app, 'api/_tests/guias-pdf.ts')).href);

const BANCO = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const AUTH = 'http://127.0.0.1:54321/auth/v1';
const SITE = 'http://localhost:3000';
const META = 'http://localhost:3004';
const RESEND = 'http://localhost:3003';
const manter = process.argv.includes('--manter');
const passos = [];
const ok = (cond, texto) => {
  if (!cond) throw new Error(`falhou: ${texto}`);
  passos.push(texto);
  console.log(`  ✔ ${texto}`);
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function anon() {
  const r = spawnSync('supabase', ['status', '-o', 'json'], { cwd: raiz, encoding: 'utf8', shell: process.platform === 'win32' });
  const s = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
  return s.ANON_KEY || s.anon_key || s.PUBLISHABLE_KEY;
}

const fone = () => `+55119${Array.from(randomBytes(8), (b) => String(b % 10)).join('')}`;
const db = new pg.Client({ connectionString: BANCO });
await db.connect();

const ids = { user: randomUUID(), client: randomUUID(), tenant: null };
const email = `guias-e2e-${randomBytes(4).toString('hex')}@example.test`;
const senha = randomBytes(18).toString('base64url');
const CNPJ_ESC = cnpjDe(`9${Array.from(randomBytes(7), (b) => String(b % 10)).join('')}0001`);
const C1 = { doc: cnpjDe(`1${Array.from(randomBytes(7), (b) => String(b % 10)).join('')}0001`), nome: 'Padaria Demo Ltda', fone: fone(), email: `padaria-${randomBytes(3).toString('hex')}@cliente.test` };
const C2 = { doc: cnpjDe(`2${Array.from(randomBytes(7), (b) => String(b % 10)).join('')}0001`), nome: 'Mercado Demo ME', fone: fone(), email: `mercado-${randomBytes(3).toString('hex')}@cliente.test` };

async function criarEscritorio() {
  await db.query(
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                             created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
     values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, extensions.crypt($3, extensions.gen_salt('bf')), now(),
             '{"provider":"email","providers":["email"],"role":"CLIENT"}', '{}', now(), now(), '', '', '', '')`,
    [ids.user, email, senha],
  );
  await db.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1::text, $1::uuid, jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`,
    [ids.user, email],
  );
  await db.query('insert into public.clients (id, name, slug) values ($1, $2, $3)', [ids.client, 'Contabilidade Demo Guias', `guias-e2e-${ids.client}`]);
  await db.query(`insert into public.memberships (user_id, client_id, role) values ($1, $2, 'CLIENT')`, [ids.user, ids.client]);
  await db.query(`insert into nofiscal.fiscal_accounts (user_id, email, phone_e164, email_verified_at, client_id) values ($1, $2, $3, now(), $4)`, [ids.user, email, fone(), ids.client]);
  const { rows } = await db.query(
    `insert into nofiscal.fiscal_tenants (cnpj, razao_social, codigo_municipio_ibge, api_key_hash, plan, monthly_note_limit, client_id, codigo_servico_nacional, p_tot_trib_sn, onboarding_etapa)
     values ($1, 'Contabilidade Demo Guias Ltda', '3507605', $2, 'escritorio_5', 500, $3, '170201', 6, 'concluido') returning id`,
    [CNPJ_ESC, randomBytes(32).toString('hex'), ids.client],
  );
  ids.tenant = rows[0].id;
  const ligar = await db.query('select public.fiscal_definir_modulo_guias($1, true, 500) as r', [ids.tenant]);
  ok(ligar.rows[0].r.ok === true, 'módulo Guias ligado na conta-mãe pela função da nó (fiscal_definir_modulo_guias)');
}

async function limpar() {
  if (!ids.tenant) return;
  await db.query(`delete from nofiscal.fiscal_messages where phone_e164 = any($1)`, [[C1.fone, C2.fone]]).catch(() => undefined);
  await db.query(`delete from nofiscal.fiscal_agent_once where chave like any($1)`, [[`%${C1.fone}%`, `%${C2.fone}%`]]).catch(() => undefined);
  await db.query('delete from nofiscal.fiscal_tenants where id = $1', [ids.tenant]);
  await db.query('delete from nofiscal.fiscal_accounts where client_id = $1', [ids.client]);
  await db.query('delete from public.memberships where client_id = $1', [ids.client]);
  await db.query('delete from public.clients where id = $1', [ids.client]);
  await db.query('delete from auth.users where id = $1', [ids.user]);
}

async function principal() {
  console.log('[guias-e2e] escritório de teste, sessão e módulo');
  await criarEscritorio();
  const chave = anon();
  const login = await fetch(`${AUTH}/token?grant_type=password`, { method: 'POST', headers: { apikey: chave, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: senha }) });
  const sessao = await login.json();
  ok(login.ok && typeof sessao.access_token === 'string', 'sessão aberta no Auth local');
  const api = async (corpo) => {
    const r = await fetch(`${SITE}/agentes/fiscal/api/v1/fiscal/guias/`, { method: 'POST', headers: { authorization: `Bearer ${sessao.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${corpo.acao} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  };

  const est = await api({ acao: 'estado' });
  ok(est.ligado === true && est.upload === true, 'a API diz que o módulo está ligado (a aba aparece)');

  console.log('[guias-e2e] 1. importar 2 contatos');
  const csv = ['documento,nome,whatsapp,email', `${C1.doc},${C1.nome},${C1.fone},${C1.email}`, `${C2.doc},${C2.nome},${C2.fone},${C2.email}`].join('\n');
  const imp = await api({ acao: 'contatos_importar', csv, aceite_origem: 'Cláusula do contrato (demo)' });
  ok(imp.importados === 2 && imp.erros.length === 0, 'CSV importado: 2 contatos, nenhum erro');

  console.log('[guias-e2e] 2. subir 3 PDFs direto ao Storage');
  const pdfs = [
    { nome: 'das-padaria.pdf', g: await gerarGuiaPdf({ tipo: 'das', cnpj: C1.doc, razao: C1.nome, competencia: '2026-11', vencimento: '2026-12-20', valorCentavos: 123456 }) },
    { nome: 'honorarios-mercado.pdf', g: await gerarGuiaPdf({ tipo: 'boleto', cnpj: C2.doc, razao: C2.nome, beneficiario: CNPJ_ESC, competencia: '2026-11', vencimento: '2026-12-10', valorCentavos: 35000 }) },
    { nome: 'darf-padaria.pdf', g: await gerarGuiaPdf({ tipo: 'darf', cnpj: C1.doc, razao: C1.nome, competencia: '2026-11', vencimento: '2026-12-19', valorCentavos: 98700, valorNoTexto: 98000 }) },
  ];
  const { lote_id } = await api({ acao: 'lote_criar', total: pdfs.length });
  const { arquivos } = await api({ acao: 'lote_arquivos', lote_id, arquivos: pdfs.map((p) => ({ nome: p.nome, tamanho: p.g.pdf.length })) });
  ok(arquivos.every((a) => a.url.startsWith('http://localhost:3007/storage/v1/object/upload/sign/fiscal-guias/')), 'a API devolveu só URLs assinadas do Storage (o PDF não passa por ela)');
  for (const [i, a] of arquivos.entries()) {
    const put = await fetch(a.url, { method: 'PUT', headers: { 'content-type': 'application/pdf', 'x-upsert': 'false' }, body: pdfs[i].g.pdf });
    if (!put.ok) throw new Error(`PUT ${put.status}`);
  }
  ok(true, '3 PDFs no Storage dublê por PUT direto');
  await api({ acao: 'lote_confirmar', lote_id, guia_ids: arquivos.map((a) => a.guia_id), fim: true });
  let pend = 1;
  for (let i = 0; i < 10 && pend; i++) pend = (await api({ acao: 'ler', lote_id })).pendentes;
  ok(pend === 0, 'leitura dos 3 PDFs concluída');

  console.log('[guias-e2e] 3. conferir');
  let ver = await api({ acao: 'lote_ver', lote_id });
  ok(JSON.stringify(ver.guias.map((g) => g.cor)) === JSON.stringify(['verde', 'verde', 'amarelo']), `cores da conferência: ${ver.guias.map((g) => `${g.arquivo}=${g.cor}`).join(', ')}`);
  const amarela = ver.guias[2];
  ok(/código de barras/.test(amarela.motivo), `a amarela diz o motivo: "${amarela.motivo}"`);
  await api({ acao: 'guia_editar', guia_id: amarela.id, campos: { valor: '987,00' } });
  ver = await api({ acao: 'lote_ver', lote_id });
  ok(ver.guias.every((g) => g.cor === 'verde'), 'corrigido o valor na conferência, as 3 ficaram verdes');
  const antes = await (await fetch(`${META}/api/conversa?numero=${encodeURIComponent(C1.fone)}`)).json();
  ok(antes.length === 0, 'nada foi enviado antes do Disparar');

  console.log('[guias-e2e] 4. disparar e esperar o worker da demo (até 2 min)');
  const disp = await api({ acao: 'disparar', guia_ids: ver.guias.map((g) => g.id) });
  ok(disp.agendadas === 3, 'Disparar agendou as 3 para agora');
  let acomp;
  for (let i = 0; i < 26; i++) {
    acomp = await api({ acao: 'acompanhar' });
    if (acomp.guias.length === 3 && acomp.guias.every((g) => g.status === 'enviada')) break;
    await esperar(5000);
  }
  ok(acomp.guias.length === 3 && acomp.guias.every((g) => g.status === 'enviada'), 'o worker disparou as 3 guias (status enviada)');

  console.log('[guias-e2e] 5. o que os dublês receberam');
  const conversa1 = await (await fetch(`${META}/api/conversa?numero=${encodeURIComponent(C1.fone)}`)).json();
  const modelos = conversa1.filter((m) => m.tipo === 'template' && m.modelo && m.modelo.name === 'guia_nova');
  ok(modelos.length === 2, 'o WhatsApp da Padaria recebeu 2 modelos guia_nova');
  const cab = modelos[0].modelo.components.find((c) => c.type === 'header');
  const doc = cab && cab.parameters[0];
  ok(doc && doc.type === 'document' && typeof doc.document.id === 'string' && /\.pdf$/.test(doc.document.filename), `cabeçalho de documento por media id (${doc && doc.document.id}, ${doc && doc.document.filename})`);
  const midias = await (await fetch(`${META}/api/midias`)).json();
  ok(midias[doc.document.id] && midias[doc.document.id].pdf === true, 'a mídia subida na Meta é o PDF');
  const corpo = modelos[0].modelo.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
  ok(corpo[0] === 'Contabilidade Demo Guias Ltda', `a mensagem leva o nome do escritório ("${corpo[0]}")`);
  const botoes = modelos[0].modelo.components.filter((c) => c.type === 'button').map((c) => `${c.index}:${c.sub_type}`);
  ok(botoes.join(',') === '0:quick_reply,1:quick_reply,2:url', `botões na ordem do modelo cadastrado: Recebi, Falar com o escritório, Ver e copiar o código (${botoes.join(', ')})`);
  const conversa2 = await (await fetch(`${META}/api/conversa?numero=${encodeURIComponent(C2.fone)}`)).json();
  ok(conversa2.some((m) => m.modelo && m.modelo.name === 'honorario_aviso'), 'o Mercado recebeu honorario_aviso (boleto de honorários)');
  const emails = await (await fetch(`${RESEND}/api/emails?to=${encodeURIComponent(C1.email)}`)).json();
  ok(emails.length === 2 && emails.every((e) => e.anexos.length === 1 && /\.pdf$/.test(e.anexos[0])), 'a Padaria recebeu 2 e-mails com o PDF anexo');
  const link = /(http:\/\/localhost:3001\/g\/[A-Za-z0-9_-]{32})/.exec(emails[0].text || '');
  ok(!!link, `o e-mail traz o link rastreável (${link && link[1]})`);
  const pagina = await fetch(link[1], { headers: { 'user-agent': 'Mozilla/5.0 (demo)' } });
  const htmlPagina = await pagina.text();
  ok(pagina.status === 200 && /Copiar código/.test(htmlPagina), 'o link /g/<token> abre com a linha digitável e o botão de copiar');

  console.log('[guias-e2e] 6. o cliente responde "paguei"');
  const resp = await (await fetch(`${META}/api/enviar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ de: C2.fone, texto: 'paguei' }) })).json();
  ok(resp.webhook_status === 200, 'o webhook local aceitou a resposta assinada');
  acomp = await api({ acao: 'acompanhar' });
  const doMercado = acomp.guias.find((g) => g.contato && g.contato.nome === C2.nome);
  ok(doMercado.status === 'paga_informada', `a guia do Mercado mudou para "${doMercado.status}"`);
  const baixada = acomp.guias.find((g) => g.status === 'baixada');
  ok(!!baixada, 'a guia do link aberto ficou "baixada"');
  const conversaDepois = await (await fetch(`${META}/api/conversa?numero=${encodeURIComponent(C2.fone)}`)).json();
  ok(/Obrigado! Avisei/.test(conversaDepois.at(-1).texto), `o cliente recebeu a confirmação ("${conversaDepois.at(-1).texto}")`);
  console.log(`\n[guias-e2e] tudo certo: ${passos.length} verificações.`);
}

try {
  await principal();
} catch (e) {
  console.error(`\n[guias-e2e] ${e.message}`);
  process.exitCode = 1;
} finally {
  if (!manter) await limpar().catch((e) => console.error('[guias-e2e] limpeza falhou:', e.message));
  await db.end();
}
