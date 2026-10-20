// Roteiro do spike na PRODUÇÃO RESTRITA da Sefin Nacional (Landing do checklist, lote 2b -
// roteiro do spike). Quem roda é Lucca, na máquina dele, com o A1 da PRIMECARE:
//   (a) transmite N DPS (padrão 10) com o cliente real do motor;
//   (b) consulta cada uma por GET /dps/{id} e GET /nfse/{chave};
//   (c) cancela 1 (e101101) e consulta o evento;
//   (d) Unresolved 1: pula um número e, com uma rejeição provocada (CPF do tomador com dígito
//       verificador errado, E0206 esperado), reenvia o mesmo número com o CPF certo;
//   (e) grava um relatório JSON sem PFX, senha, XML assinado, CNPJ, CPF, nome, inscrição
//       municipal, Id da DPS ou chave de acesso; os números aparecem como "n0+k".
// Recusa qualquer ambiente diferente de `producao_restrita`. Tudo o que toca o mundo (terminal,
// arquivos, rede, relógio) entra por `SpikeDeps`, para o teste rodar sem rede.
import { createSefinClient, SEFIN_BASE_URLS, type HttpRequest, type SefinTransport } from '../api/_lib/sefin-client.js'
import { pfxToPem } from '../api/_lib/pfx.js'
import type { Certificado, EmitirResultado, SefinInvoice, SefinTenant } from '../api/_lib/sefin.js'
import type { SignatureProfile } from '../api/_lib/xml-signer.js'

export const SPIKE_AMBIENTE = 'producao_restrita'

export type SpikeDeps = {
  argv: string[]
  /** Pergunta no terminal; `hidden` = sem eco (senha). */
  ask: (question: string, options?: { hidden?: boolean }) => Promise<string>
  readFile: (path: string) => Promise<Buffer>
  writeFile: (path: string, content: string) => Promise<void>
  /** Transporte HTTPS real na máquina de Lucca; dublê no teste. */
  transport: (options: { extraCa: string[] }) => SefinTransport
  now: () => Date
  sleep: (ms: number) => Promise<void>
  print: (line: string) => void
}

export type SpikeParams = {
  ambiente: typeof SPIKE_AMBIENTE
  municipio: string
  serie: string
  numeroInicial: number
  cTribNac: string
  quantidade: number
  pTotTribSN: string
  valor: string
  descricao: string
  saida: string
  perfil: SignatureProfile
  caPath: string | null
}

export type SpikeSecrets = {
  cnpj: string
  im: string | null
  cpf: string
  nome: string
  pfxPath: string
  password: string
}

type Outcome = {
  resultado: string
  codigo?: string
  mensagem?: string
  chave_recebida?: boolean
  chave_formato_ok?: boolean
  ms: number
}

type RequestLog = { metodo: string; rota: string; status: number | null; ms: number; chaves_json: string[]; erro?: string }

export type SpikeReport = {
  gerado_em: string
  ambiente: string
  url_base: string
  perfil_assinatura: SignatureProfile
  quantidade: number
  certificado_valido_ate: string
  emissoes: ({ numero: string } & Outcome)[]
  consultas: ({ numero: string } & Outcome)[]
  cancelamento: ({ numero: string; consulta_evento: Outcome } & Outcome) | null
  unresolved_1: {
    lacuna: { numero: string; pulado: string } & Outcome & { aceita: boolean | null }
    reuso_apos_rejeicao: {
      numero: string
      rejeicao_provocada: { como: string; esperado: string } & Outcome
      reenvio: Outcome
      aceito: boolean | null
    }
  }
  unresolved_3: { alguma_dps_autorizada: boolean; codigos_vistos: string[] }
  requisicoes: RequestLog[]
  numeros_consumidos: string[]
}

export class SpikeRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpikeRefused'
  }
}

export function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`argumento inesperado: ${arg}`)
    const eq = arg.indexOf('=')
    if (eq > 0) out[arg.slice(2, eq)] = arg.slice(eq + 1)
    else {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[arg.slice(2)] = 'true'
      else {
        out[arg.slice(2)] = next
        i++
      }
    }
  }
  return out
}

/** CPF com dígitos verificadores válidos. */
export function cpfValido(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false
  const dv = (base: string) => {
    const sum = base.split('').reduce((acc, d, i) => acc + Number(d) * (base.length + 1 - i), 0)
    const rest = (sum * 10) % 11
    return rest === 10 ? 0 : rest
  }
  return dv(cpf.slice(0, 9)) === Number(cpf[9]) && dv(cpf.slice(0, 10)) === Number(cpf[10])
}

/** O mesmo CPF com o último dígito verificador trocado: provoca E0206 (DV inválido). */
export function cpfComDvErrado(cpf: string): string {
  return `${cpf.slice(0, 10)}${(Number(cpf[10]) + 1) % 10}`
}

export const USAGE = `Uso: node scripts/nofiscal-spike.mjs --serie=<1-49999> --numero-inicial=<n> --ctribnac=<6 dígitos> \\
  --p-tot-trib-sn=<percentual> --saida=<pasta do relatório> [--quantidade=10] [--municipio=3550308] \\
  [--valor=1.00] [--descricao="..."] [--perfil-assinatura=sha256|sha1] [--ca=<PEM extra da cadeia do servidor>] \\
  [--ambiente=producao_restrita]
CNPJ, inscrição municipal, CPF e nome do tomador de teste, caminho do PFX e senha são pedidos no terminal.
Só roda contra a produção restrita.`

export function parseSpikeParams(flags: Record<string, string>): SpikeParams {
  const ambiente = flags.ambiente ?? SPIKE_AMBIENTE
  if (ambiente !== SPIKE_AMBIENTE) {
    throw new SpikeRefused(`o spike só roda na produção restrita (recebido: ${ambiente})`)
  }
  const need = (name: string) => {
    const value = flags[name]
    if (!value || value === 'true') throw new Error(`falta --${name}`)
    return value.trim()
  }
  const serie = need('serie')
  if (!/^\d{1,5}$/.test(serie) || Number(serie) < 1 || Number(serie) > 49999) throw new Error('--serie deve estar entre 1 e 49999')
  const numeroInicial = Number(need('numero-inicial'))
  if (!Number.isSafeInteger(numeroInicial) || numeroInicial < 1) throw new Error('--numero-inicial deve ser inteiro positivo')
  const cTribNac = need('ctribnac')
  if (!/^\d{6}$/.test(cTribNac)) throw new Error('--ctribnac deve ter 6 dígitos')
  const quantidade = Number(flags.quantidade ?? '10')
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 50) throw new Error('--quantidade deve estar entre 1 e 50')
  const pTotTribSN = need('p-tot-trib-sn')
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(pTotTribSN) || Number(pTotTribSN) > 100) throw new Error('--p-tot-trib-sn deve ser percentual de 0 a 100')
  const municipio = flags.municipio ?? '3550308'
  if (!/^\d{7}$/.test(municipio)) throw new Error('--municipio deve ter 7 dígitos')
  const valor = flags.valor ?? '1.00'
  if (!/^\d{1,13}\.\d{2}$/.test(valor) || Number(valor) <= 0) throw new Error('--valor deve ter 2 casas decimais, por exemplo 1.00')
  const perfilFlag = flags['perfil-assinatura'] ?? 'sha256'
  if (perfilFlag !== 'sha256' && perfilFlag !== 'sha1') throw new Error('--perfil-assinatura deve ser sha256 ou sha1')
  return {
    ambiente: SPIKE_AMBIENTE,
    municipio,
    serie,
    numeroInicial,
    cTribNac,
    quantidade,
    pTotTribSN,
    valor,
    descricao: flags.descricao ?? 'Teste de integracao do emissor - producao restrita',
    saida: need('saida'),
    perfil: perfilFlag === 'sha1' ? 'sha1-c14n' : 'sha256-exc-c14n',
    caPath: flags.ca ?? null,
  }
}

async function askSecrets(ask: SpikeDeps['ask']): Promise<SpikeSecrets> {
  const cnpj = (await ask('CNPJ do prestador (14 dígitos): ')).replace(/\D/g, '')
  if (!/^\d{14}$/.test(cnpj)) throw new Error('CNPJ deve ter 14 dígitos')
  const im = (await ask('Inscrição municipal (Enter se não houver registro no CNC): ')).trim() || null
  const cpf = (await ask('CPF do tomador de teste (11 dígitos): ')).replace(/\D/g, '')
  if (!cpfValido(cpf)) throw new Error('CPF do tomador de teste inválido (dígito verificador)')
  const nome = (await ask('Nome do tomador de teste: ')).trim()
  if (!nome || nome.length > 150) throw new Error('nome do tomador deve ter de 1 a 150 caracteres')
  const pfxPath = (await ask('Caminho do arquivo PFX do A1: ')).trim()
  if (!pfxPath) throw new Error('falta o caminho do PFX')
  const password = await ask('Senha do PFX: ', { hidden: true })
  return { cnpj, im, cpf, nome, pfxPath, password }
}

/** Tira do texto tudo o que identifica o contribuinte, o tomador ou a numeração real. */
export function makeMasker(secrets: Pick<SpikeSecrets, 'cnpj' | 'im' | 'cpf' | 'nome'>, extra: string[] = []) {
  const pairs: [string, string][] = [
    [secrets.cnpj, '[cnpj]'],
    [secrets.cpf, '[cpf]'],
    [cpfComDvErrado(secrets.cpf), '[cpf-dv-errado]'],
    [secrets.nome, '[nome]'],
    ...(secrets.im ? [[secrets.im, '[im]'] as [string, string]] : []),
    ...extra.map((value): [string, string] => [value, '[segredo]']),
  ]
  return (text: string): string => {
    let out = text
      .replace(/PRE\d{56}/g, 'PRE[id-evento]')
      .replace(/NFS\d{50}/g, 'NFS[chave]')
      .replace(/DPS\d{42}/g, 'DPS[id-dps]')
      .replace(/\d{50}/g, '[chave]')
    for (const [value, label] of pairs) if (value) out = out.split(value).join(label)
    return out
  }
}

function jsonKeys(body: string): string[] {
  try {
    const value: unknown = JSON.parse(body)
    const keys = new Set<string>()
    const walk = (node: unknown, prefix: string, depth: number) => {
      if (depth > 2 || node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        if (node.length) walk(node[0], `${prefix}[]`, depth + 1)
        return
      }
      for (const [key, child] of Object.entries(node)) {
        keys.add(`${prefix}${key}`)
        walk(child, `${prefix}${key}.`, depth + 1)
      }
    }
    walk(value, '', 0)
    return [...keys]
  } catch {
    return []
  }
}

export async function runSpike(deps: SpikeDeps): Promise<{ report: SpikeReport | null; path: string | null }> {
  const flags = parseFlags(deps.argv)
  if (flags.help) {
    deps.print(USAGE)
    return { report: null, path: null }
  }
  const params = parseSpikeParams(flags)
  const baseUrl = SEFIN_BASE_URLS[params.ambiente]
  if (baseUrl !== 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional') {
    throw new SpikeRefused('a URL da produção restrita não confere; nada foi enviado')
  }
  const secrets = await askSecrets(deps.ask)
  const pfx = await deps.readFile(secrets.pfxPath)
  const certificado: Certificado = { pfxBase64: pfx.toString('base64'), password: secrets.password }
  const pem = pfxToPem(certificado)
  if (pem.notAfter.getTime() <= deps.now().getTime()) throw new Error('o certificado do PFX está vencido')
  const extraCa = params.caPath ? [(await deps.readFile(params.caPath)).toString('utf8')] : []
  const mask = makeMasker(secrets, [secrets.password, certificado.pfxBase64.slice(0, 64), secrets.pfxPath])

  const requests: RequestLog[] = []
  const inner = deps.transport({ extraCa })
  // Só metadados de cada chamada: método, rota mascarada, status, tempo e nomes de campos.
  const transport: SefinTransport = async (request: HttpRequest, tls) => {
    const started = deps.now().getTime()
    const rota = mask(new URL(request.url).pathname.replace(/^\/SefinNacional/, ''))
    try {
      const response = await inner(request, tls)
      requests.push({ metodo: request.method, rota, status: response.status, ms: deps.now().getTime() - started, chaves_json: jsonKeys(response.body) })
      return response
    } catch (error) {
      requests.push({
        metodo: request.method,
        rota,
        status: null,
        ms: deps.now().getTime() - started,
        chaves_json: [],
        erro: mask(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      })
      throw error
    }
  }
  const client = createSefinClient({ transport, perfilAssinatura: params.perfil, now: deps.now })
  const tenant: SefinTenant = {
    id: 'spike',
    cnpj: secrets.cnpj,
    razao_social: 'spike',
    inscricao_municipal: secrets.im,
    codigo_municipio_ibge: params.municipio,
    regime: 'simples',
    ambiente: params.ambiente,
    p_tot_trib_sn: params.pTotTribSN,
  }
  const label = (numero: number) => `n0+${numero - params.numeroInicial}`
  const invoiceFor = (numero: number, cpf: string): SefinInvoice => ({
    id: `spike-${numero}`,
    external_id: `spike-${numero}`,
    payload: {
      tomador: { cpf, nome: secrets.nome },
      servico: { codigo_servico_nacional: params.cTribNac, descricao: params.descricao },
      valor: params.valor,
    },
    dps_serie: params.serie,
    dps_numero: numero,
    id_dps: client.idDps({ tenant, serie: params.serie, numero }),
  })
  const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
    const started = deps.now().getTime()
    const value = await work()
    return [value, deps.now().getTime() - started]
  }
  const codes = new Set<string>()
  const describeEmitir = (result: EmitirResultado, ms: number): Outcome => {
    if (result.kind === 'authorized') return { resultado: 'authorized', chave_recebida: true, chave_formato_ok: /^\d{50}$/.test(result.chaveAcesso), ms }
    if (result.kind === 'rejected') {
      codes.add(result.code)
      return { resultado: 'rejected', codigo: result.code, mensagem: mask(result.message), ms }
    }
    for (const code of result.reason.match(/E\d{3,4}/g) ?? []) codes.add(code)
    return { resultado: 'unavailable', mensagem: mask(result.reason), ms }
  }
  const emit = async (numero: number, cpf: string) => {
    const [result, ms] = await timed(() => client.emitir({ tenant, invoice: invoiceFor(numero, cpf), certificado }))
    return { result, outcome: describeEmitir(result, ms) }
  }
  const consumed: string[] = []

  deps.print(`Produção restrita: ${baseUrl}`)
  deps.print(`(a) Transmitindo ${params.quantidade} DPS...`)
  const emissoes: SpikeReport['emissoes'] = []
  const autorizadas: { numero: number; chave: string }[] = []
  for (let k = 0; k < params.quantidade; k++) {
    const numero = params.numeroInicial + k
    const { result, outcome } = await emit(numero, secrets.cpf)
    consumed.push(label(numero))
    emissoes.push({ numero: label(numero), ...outcome })
    if (result.kind === 'authorized') autorizadas.push({ numero, chave: result.chaveAcesso })
    deps.print(`  ${label(numero)}: ${outcome.resultado}${outcome.codigo ? ` ${outcome.codigo}` : ''}`)
    await deps.sleep(500)
  }

  deps.print('(b) Consultando cada DPS...')
  const consultas: SpikeReport['consultas'] = []
  for (let k = 0; k < params.quantidade; k++) {
    const numero = params.numeroInicial + k
    const idDps = client.idDps({ tenant, serie: params.serie, numero })
    const [result, ms] = await timed(() => client.consultarPorIdDps({ tenant, idDps, certificado }))
    const esperada = autorizadas.find((a) => a.numero === numero)?.chave
    consultas.push({
      numero: label(numero),
      resultado: result.kind,
      ms,
      ...(result.kind === 'found' ? { chave_recebida: true, chave_formato_ok: result.chaveAcesso === esperada || esperada === undefined } : {}),
      ...(result.kind === 'unavailable' ? { mensagem: mask(result.reason) } : {}),
    })
  }

  deps.print('(c) Cancelando a primeira nota autorizada...')
  let cancelamento: SpikeReport['cancelamento'] = null
  if (autorizadas[0]) {
    const alvo = autorizadas[0]
    const [result, ms] = await timed(() => client.cancelar({ tenant, chaveAcesso: alvo.chave, certificado }))
    const [consulta, msConsulta] = await timed(() => client.consultarCancelamento({ tenant, chaveAcesso: alvo.chave, certificado }))
    if (result.kind === 'refused') codes.add(result.code)
    cancelamento = {
      numero: label(alvo.numero),
      resultado: result.kind,
      ...(result.kind === 'refused' ? { codigo: result.code, mensagem: mask(result.message) } : {}),
      ...(result.kind === 'unavailable' ? { mensagem: mask(result.reason) } : {}),
      ms,
      consulta_evento: {
        resultado: consulta.kind,
        ...(consulta.kind === 'unavailable' ? { mensagem: mask(consulta.reason) } : {}),
        ms: msConsulta,
      },
    }
    deps.print(`  ${label(alvo.numero)}: ${result.kind}; consulta do evento: ${consulta.kind}`)
  } else {
    deps.print('  nenhuma nota autorizada: cancelamento não testado')
  }

  deps.print('(d) Unresolved 1: lacuna na numeração...')
  const pulado = params.numeroInicial + params.quantidade
  const lacunaNumero = pulado + 1
  const lacuna = await emit(lacunaNumero, secrets.cpf)
  consumed.push(label(lacunaNumero))
  deps.print(`  ${label(lacunaNumero)} (pulando ${label(pulado)}): ${lacuna.outcome.resultado}`)

  deps.print('(d) Unresolved 1: rejeição provocada e reenvio do mesmo número...')
  const reusoNumero = lacunaNumero + 1
  const rejeicao = await emit(reusoNumero, cpfComDvErrado(secrets.cpf))
  await deps.sleep(500)
  const reenvio = await emit(reusoNumero, secrets.cpf)
  consumed.push(label(reusoNumero))
  deps.print(`  ${label(reusoNumero)}: rejeição ${rejeicao.outcome.codigo ?? rejeicao.outcome.resultado}; reenvio ${reenvio.outcome.resultado}`)

  const report: SpikeReport = {
    gerado_em: deps.now().toISOString(),
    ambiente: params.ambiente,
    url_base: baseUrl,
    perfil_assinatura: params.perfil,
    quantidade: params.quantidade,
    certificado_valido_ate: pem.notAfter.toISOString().slice(0, 10),
    emissoes,
    consultas,
    cancelamento,
    unresolved_1: {
      lacuna: {
        numero: label(lacunaNumero),
        pulado: label(pulado),
        ...lacuna.outcome,
        aceita: lacuna.result.kind === 'authorized' ? true : lacuna.result.kind === 'rejected' ? false : null,
      },
      reuso_apos_rejeicao: {
        numero: label(reusoNumero),
        rejeicao_provocada: {
          como: 'CPF do tomador com o último dígito verificador trocado',
          esperado: 'rejected com E0206 (CPF com DV inválido)',
          ...rejeicao.outcome,
        },
        reenvio: reenvio.outcome,
        aceito:
          rejeicao.result.kind !== 'rejected'
            ? null
            : reenvio.result.kind === 'authorized'
              ? true
              : reenvio.result.kind === 'rejected'
                ? false
                : null,
      },
    },
    unresolved_3: { alguma_dps_autorizada: autorizadas.length > 0 || lacuna.result.kind === 'authorized', codigos_vistos: [...codes].sort() },
    requisicoes: requests,
    numeros_consumidos: consumed,
  }

  // Última barreira: toda string do relatório passa pela máscara antes de ir para o disco.
  const masked = deepMask(report, mask)
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-')
  const path = `${params.saida.replace(/[\\/]+$/, '')}/nofiscal-spike-${stamp}.json`
  await deps.writeFile(path, `${JSON.stringify(masked, null, 2)}\n`)
  deps.print(`Relatório gravado em ${path}`)
  deps.print(`Próximo número livre nesta série da produção restrita: n0+${reusoNumero + 1 - params.numeroInicial}.`)
  return { report: masked, path }
}

function deepMask<T>(value: T, mask: (text: string) => string): T {
  if (typeof value === 'string') return mask(value) as T
  if (Array.isArray(value)) return value.map((item) => deepMask(item, mask)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepMask(item, mask)])) as T
  }
  return value
}
