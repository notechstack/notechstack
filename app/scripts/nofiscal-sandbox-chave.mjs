// Gera (ou troca, ou revoga) a chave SANDBOX da API do nó.fiscal para uma conta-mãe (19/11/2026).
// A chave `nfk_test_…` emite NFS-e simuladas: nada vai à Sefin, nada usa certificado, nada entra no painel nem na
// franquia (app/api/_lib/sandbox/). Documentação para o parceiro: agentes/fiscal/dados/api/README.md, seção Sandbox.
//
// Quem roda: a nó (Lucca), da raiz do repo notechstack com o projeto Supabase linkado. Uso:
//   node app/scripts/nofiscal-sandbox-chave.mjs --cnpj=12345678000190            # mostra a chave e o comando
//   node app/scripts/nofiscal-sandbox-chave.mjs --cnpj=12345678000190 --aplicar  # já grava pelo supabase CLI
//   node app/scripts/nofiscal-sandbox-chave.mjs --conta=<uuid do tenant> --revogar --aplicar
//   --local: grava no banco local (supabase db query --local) em vez do linkado.
//
// A chave sai só aqui, uma vez, no terminal: o banco guarda o sha256 e o prefixo. O SQL gravado em arquivo temporário
// leva só o hash. Trocar a chave invalida a anterior na hora; as notas sandbox continuam lá.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Iguais a app/api/_lib/auth.ts e app/api/_lib/parceiro/chave.ts (gerarChaveSandbox); o teste do sandbox confere.
export const PREFIXO_SANDBOX = 'nfk_test_';

export function gerarChaveSandbox(bytes = () => randomBytes(32)) {
  const chave = `${PREFIXO_SANDBOX}${bytes().toString('base64url')}`;
  const hash = createHash('sha256').update(chave, 'utf8').digest('hex');
  return { chave, hash, prefixo: chave.slice(0, PREFIXO_SANDBOX.length + 6) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SQL que grava (ou revoga) a chave da conta. Só aceita uuid, CNPJ de 14 dígitos, hash hex e prefixo do formato. */
export function sqlDaChave({ conta, cnpj, hash, prefixo }) {
  let alvo;
  if (conta) {
    if (!UUID.test(conta)) throw new Error('--conta deve ser o uuid do tenant da conta-mãe');
    alvo = `'${conta}'::uuid`;
  } else {
    if (!/^\d{14}$/.test(cnpj ?? '')) throw new Error('--cnpj deve ter 14 dígitos, só números');
    alvo = `(select id from nofiscal.fiscal_tenants where cnpj = '${cnpj}' and escritorio_tenant_id is null)`;
  }
  if (hash !== null && (!/^[0-9a-f]{64}$/.test(hash) || !/^nfk_test_[A-Za-z0-9_-]{6}$/.test(prefixo))) throw new Error('hash ou prefixo fora do formato');
  const h = hash === null ? 'null' : `'${hash}'`;
  const p = prefixo === null ? 'null' : `'${prefixo}'`;
  return `select public.fiscal_definir_chave_sandbox(${alvo}, ${h}, ${p}) as resultado;\n`;
}

function lerArgs(argv) {
  const args = {};
  for (const a of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`argumento não reconhecido: ${a}`);
    args[m[1]] = m[2] ?? true;
  }
  return args;
}

function main() {
  const args = lerArgs(process.argv.slice(2));
  if (!args.conta && !args.cnpj) throw new Error('informe --cnpj=<CNPJ da conta-mãe> ou --conta=<uuid>');
  const revogar = Boolean(args.revogar);
  const gerada = revogar ? null : gerarChaveSandbox();
  const sql = sqlDaChave({
    conta: typeof args.conta === 'string' ? args.conta : null,
    cnpj: typeof args.cnpj === 'string' ? args.cnpj : null,
    hash: gerada?.hash ?? null,
    prefixo: gerada?.prefixo ?? null,
  });
  const pasta = mkdtempSync(join(tmpdir(), 'nofiscal-sandbox-'));
  const arquivo = join(pasta, 'chave-sandbox.sql');
  writeFileSync(arquivo, sql, 'utf8');
  const alvo = args.local ? '--local' : '--linked';
  if (args.aplicar) {
    try {
      const saida = execFileSync('supabase', ['db', 'query', alvo, '-f', arquivo], { encoding: 'utf8' });
      if (!/"ok"\s*:\s*true/.test(saida)) {
        console.error('O banco não confirmou (conta não encontrada?). Saída:\n' + saida);
        process.exitCode = 1;
        return;
      }
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  }
  if (revogar) {
    console.log(args.aplicar ? 'Chave sandbox revogada.' : `Para revogar: supabase db query ${alvo} -f ${arquivo}`);
    return;
  }
  console.log('Chave sandbox (aparece só agora; guarde e mande ao parceiro por canal seguro):');
  console.log(`  ${gerada.chave}`);
  console.log(`Prefixo (para reconhecer depois): ${gerada.prefixo}`);
  if (!args.aplicar) console.log(`Ainda NÃO gravada. Para gravar: supabase db query ${alvo} -f ${arquivo}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
