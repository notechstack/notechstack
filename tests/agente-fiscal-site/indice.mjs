// `node --test tests/agente-fiscal-site/` (a forma das provas no checklist): no Node 24 o runner não expande uma
// pasta e a resolve como módulo, pelo "main" do package.json. Este arquivo carrega todos os *.test.mjs daqui, então
// a pasta inteira roda num processo e --test-name-pattern escolhe o teste. Dentro da pasta, `node --test` sem
// argumento usa o glob padrão e não passa por aqui.
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const aqui = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(aqui).filter((x) => x.endsWith('.test.mjs')).sort()) {
  await import(pathToFileURL(`${aqui}/${f}`).href);
}
