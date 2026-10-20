// Captura o protótipo lp-basica-v1 em desktop e celular para conferência visual.
// Uso: node app/onboarding/conexao-equestre/screenshot.mjs (a partir da raiz do repo)
import { chromium } from '@playwright/test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const page_path = path.resolve(here, '../../public/prototipos/conexao-equestre/lp-basica-v1/index.html')
const out = path.resolve(here, 'checks')
const browser = await chromium.launch()
for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport })
  await page.goto(pathToFileURL(page_path).href, { waitUntil: 'networkidle' })
  await page.screenshot({ path: path.join(out, `lp-${name}-full.png`), fullPage: true })
  await page.screenshot({ path: path.join(out, `lp-${name}-hero.png`) })
  await page.close()
}
await browser.close()
console.log('ok', out)
