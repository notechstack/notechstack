#!/usr/bin/env node

/**
 * Nó Fiscal — cadastro local de tenant e troca do certificado A1 (critérios 28, 30 e 31).
 *
 * Roda só na máquina de Lucca, conectado ao banco da Nó como dono (`postgres`): é o único
 * papel com EXECUTE em `nofiscal.upsert_certificate` e `nofiscal.set_webhook_secret`.
 * Nenhuma rota HTTP recebe o PFX ou a senha.
 *
 * Uso (dados não secretos por flag; string de conexão, caminho do PFX e senha são pedidos
 * no terminal, sem eco, e nunca são gravados nem exibidos):
 *
 *   node scripts/nofiscal-register.mjs --cnpj=56210013000140 \
 *     --razao-social="PRIMECARE SERVICOS MEDICOS LTDA" --ibge=3550308 --im=<inscrição> \
 *     --webhook-url=https://<projeto>.supabase.co/functions/v1/nfse-callback \
 *     --plano=pro --limite=5000 --serie=<série> --proximo-numero=<n> [--ambiente=producao_restrita]
 *
 * Na criação, imprime uma única vez a chave de API (secret NOFISCAL_API_KEY da Prontia) e o
 * segredo do callback (secret NOFISCAL_WEBHOOK_SECRET); o banco guarda só o sha256 da chave
 * e o segredo no Supabase Vault. Rodar de novo para um CNPJ existente só troca o A1: não gera
 * chave nem segredo e não mexe na série nem nos dados do tenant (Landing do checklist).
 */
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import { readFile as nodeReadFile } from 'node:fs/promises'
import readline from 'node:readline'
import { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import forge from 'node-forge'
import pg from 'pg'

export const API_KEY_PREFIX = 'nfk_'
const PLANS = ['inicial', 'pro', 'custom']
const AMBIENTES = ['producao_restrita', 'producao']

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function generateApiKey(randomBytes = nodeRandomBytes) {
  return `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function generateWebhookSecret(randomBytes = nodeRandomBytes) {
  return randomBytes(32).toString('hex')
}

export function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`argumento inesperado: ${arg}`)
    const eq = arg.indexOf('=')
    if (eq > 0) {
      options[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) throw new Error(`falta valor para ${arg}`)
      options[arg.slice(2)] = next
      i++
    }
  }
  return options
}

/** Abre o PFX e lê do próprio certificado o subject e o `not_after` (critério 30). */
export function readPfx(pfxBuffer, password) {
  let p12
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfxBuffer.toString('binary')), false, password)
  } catch {
    throw new Error('não foi possível abrir o PFX com essa senha')
  }
  const bagsOf = (type) => p12.getBags({ bagType: type })[type] ?? []
  const key = [...bagsOf(forge.pki.oids.pkcs8ShroudedKeyBag), ...bagsOf(forge.pki.oids.keyBag)].find((bag) => bag.key)?.key
  const certs = bagsOf(forge.pki.oids.certBag).map((bag) => bag.cert).filter(Boolean)
  if (!key || certs.length === 0) throw new Error('o PFX não traz chave privada e certificado')
  const cert = certs.find((candidate) => candidate.publicKey?.n && key.n && candidate.publicKey.n.equals(key.n))
  if (!cert) throw new Error('nenhum certificado do PFX corresponde à chave privada')

  const subject = cert.subject.attributes
    .map((attr) => `${attr.shortName ?? attr.name ?? attr.type}=${attr.value}`)
    .join(', ')
  const commonName = cert.subject.getField('CN')?.value ?? ''
  const cnpjInSubject = /:(\d{14})$/.exec(commonName)?.[1] ?? null
  return { pfxBase64: pfxBuffer.toString('base64'), subject, notAfter: cert.validity.notAfter, cnpjInSubject }
}

function requireMatch(options, name, pattern, description) {
  const value = options[name]
  if (value === undefined) throw new Error(`--${name} é obrigatório para criar o tenant`)
  if (!pattern.test(value)) throw new Error(`--${name} inválido: ${description}`)
  return value
}

function creationFields(options) {
  const plan = requireMatch(options, 'plano', /^(inicial|pro|custom)$/, PLANS.join(' | '))
  const ambiente = options.ambiente ?? 'producao_restrita'
  if (!AMBIENTES.includes(ambiente)) throw new Error(`--ambiente inválido: ${AMBIENTES.join(' | ')}`)
  const razaoSocial = requireMatch(options, 'razao-social', /^.{1,150}$/, 'de 1 a 150 caracteres').trim()
  return {
    razaoSocial,
    ibge: requireMatch(options, 'ibge', /^\d{7}$/, 'código IBGE de 7 dígitos'),
    inscricaoMunicipal: options.im ?? null,
    webhookUrl: requireMatch(options, 'webhook-url', /^https:\/\/\S+$/, 'URL https'),
    plan,
    limit: Number(requireMatch(options, 'limite', /^[1-9]\d*$/, 'inteiro positivo')),
    serie: requireMatch(options, 'serie', /^\S{1,20}$/, 'texto sem espaços'),
    nextNumber: requireMatch(options, 'proximo-numero', /^[1-9]\d*$/, 'inteiro positivo'),
    ambiente,
  }
}

/**
 * Cadastro com dependências injetadas (os testes nunca tocam banco real):
 * argv, ask(pergunta, {hidden}), readFile(caminho), connect(stringDeConexão) → {query, end},
 * randomBytes, now(), print(linha).
 */
export async function register(deps) {
  const options = parseArgs(deps.argv)
  const cnpj = options.cnpj
  if (!cnpj || !/^\d{14}$/.test(cnpj)) throw new Error('--cnpj é obrigatório, com 14 dígitos')

  const connectionString = await deps.ask('String de conexão do banco da Nó (dono, não é exibida): ', { hidden: true })
  const pfxPath = await deps.ask('Caminho do arquivo PFX (não é exibido): ', { hidden: true })
  const password = await deps.ask('Senha do PFX (não é exibida): ', { hidden: true })
  if (!connectionString || !pfxPath) throw new Error('string de conexão e caminho do PFX são obrigatórios')
  try {
    return await registerWith(deps, options, cnpj, { connectionString, pfxPath, password })
  } catch (error) {
    // Nenhuma mensagem de erro (do pg, do forge, do sistema) sai com a conexão, o caminho ou a senha.
    let message = error instanceof Error ? error.message : 'falha desconhecida'
    for (const secret of [connectionString, pfxPath, password]) {
      if (secret) message = message.split(secret).join('[oculto]')
    }
    // eslint-disable-next-line preserve-caught-error -- a causa original carrega os segredos que esta mensagem esconde
    throw new Error(message)
  }
}

async function registerWith(deps, options, cnpj, { connectionString, pfxPath, password }) {
  let pfxBuffer
  try {
    pfxBuffer = await deps.readFile(pfxPath)
  } catch {
    throw new Error('não foi possível ler o arquivo PFX informado')
  }
  const cert = readPfx(pfxBuffer, password)
  if (cert.cnpjInSubject && cert.cnpjInSubject !== cnpj) throw new Error('o certificado é de outro CNPJ')
  if (cert.notAfter.getTime() <= deps.now().getTime()) throw new Error('o certificado já venceu')

  const client = await deps.connect(connectionString)
  let created = null
  let tenantId
  try {
    await client.query('begin')
    const existing = await client.query('select id from nofiscal.fiscal_tenants where cnpj = $1 for update', [cnpj])
    if (existing.rows.length > 0) {
      tenantId = existing.rows[0].id
    } else {
      const fields = creationFields(options)
      const apiKey = generateApiKey(deps.randomBytes)
      const webhookSecret = generateWebhookSecret(deps.randomBytes)
      const inserted = await client.query(
        `insert into nofiscal.fiscal_tenants
           (cnpj, razao_social, inscricao_municipal, codigo_municipio_ibge, ambiente, webhook_url,
            api_key_hash, plan, monthly_note_limit)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id`,
        [
          cnpj,
          fields.razaoSocial,
          fields.inscricaoMunicipal,
          fields.ibge,
          fields.ambiente,
          fields.webhookUrl,
          sha256Hex(apiKey),
          fields.plan,
          fields.limit,
        ],
      )
      tenantId = inserted.rows[0].id
      await client.query('insert into nofiscal.fiscal_dps_series (tenant_id, serie, next_number) values ($1, $2, $3)', [
        tenantId,
        fields.serie,
        fields.nextNumber,
      ])
      await client.query('select nofiscal.set_webhook_secret($1, $2)', [tenantId, webhookSecret])
      created = { apiKey, webhookSecret, ambiente: fields.ambiente }
    }
    await client.query('select nofiscal.upsert_certificate($1, $2, $3, $4, $5)', [
      tenantId,
      cert.pfxBase64,
      password,
      cert.subject,
      cert.notAfter,
    ])
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    await client.end()
  }

  deps.print(`Tenant ${tenantId} (CNPJ ${cnpj}) ${created ? 'criado' : 'já existia: certificado trocado'}.`)
  deps.print(`Certificado: ${cert.subject}, válido até ${cert.notAfter.toISOString()}.`)
  if (created) {
    deps.print(`Ambiente: ${created.ambiente}.`)
    deps.print('')
    deps.print('Os dois valores abaixo aparecem só agora. Cadastre-os como secrets na Prontia:')
    deps.print(`  NOFISCAL_API_KEY=${created.apiKey}`)
    deps.print(`  NOFISCAL_WEBHOOK_SECRET=${created.webhookSecret}`)
  }
  return { tenantId, created: Boolean(created) }
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    let muted = false
    const output = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) process.stdout.write(chunk, encoding)
        callback()
      },
    })
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true })
    rl.question(question, (answer) => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
    muted = hidden
  })
}

async function main() {
  try {
    await register({
      argv: process.argv.slice(2),
      ask,
      readFile: (path) => nodeReadFile(path),
      connect: async (connectionString) => {
        const client = new pg.Client({ connectionString })
        await client.connect()
        return client
      },
      randomBytes: nodeRandomBytes,
      now: () => new Date(),
      print: (line) => process.stdout.write(`${line}\n`),
    })
  } catch (error) {
    process.stderr.write(`Erro: ${error instanceof Error ? error.message : 'falha desconhecida'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
