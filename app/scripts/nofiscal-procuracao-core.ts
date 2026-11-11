// Bateria de testes da emissão por procuração eletrônica (handoff de 11/11/2026, "Bateria de
// testes: emissão por procuração"). Quem roda é Lucca, na máquina dele. Dois comandos:
//
//   sonda   (testes 1 e 4) leitura só de consulta, como procurador, repetida a cada N segundos:
//           ADN `GET /contribuintes/DFe/0?lote=true` e, se houver uma chave de NFS-e do outorgante,
//           Sefin `GET /nfse/{chave}`. Registra quando cada uma passa a responder (ou deixa de).
//   emitir  (testes 3, 3b e 4) uma DPS com o outorgante como prestador. A conexão (mTLS) usa SEMPRE
//           o certificado do procurador; a assinatura usa o do procurador (teste 3) ou o do
//           outorgante (teste 3b, `--assinatura=outorgante`). Se for autorizada, cancela na hora.
//
// O guia v1.3 (item 11) não diz como o procurador escolhe o outorgante na API de Distribuição;
// `--adn-parametro=<nome>` acrescenta `&<nome>=<CNPJ do outorgante>` quando a Swagger confirmar o nome.
// Emissão em produção só com `--autorizado-por-lucca`, valor até R$ 1,00 e a frase de confirmação
// digitada no terminal. Relatório JSON sem PFX, senha, CNPJ, CPF, nome, inscrição ou chave de acesso.
// Tudo o que toca o mundo entra por `ProcuracaoDeps` (as mesmas dependências do spike).
import { ADN_CONTRIBUINTES_URLS } from '../api/_lib/adn.js'
import { pfxToPem, type PemCredentials } from '../api/_lib/pfx.js'
import {
  createSefinClient,
  gunzipBase64,
  SEFIN_BASE_URLS,
  type HttpRequest,
  type SefinTransport,
  type TlsCredentials,
} from '../api/_lib/sefin-client.js'
import type { Ambiente, Certificado, SefinTenant } from '../api/_lib/sefin.js'
import type { SignatureProfile } from '../api/_lib/xml-signer.js'
import { cpfValido, makeMasker, parseFlags, SpikeRefused, type SpikeDeps } from './nofiscal-spike-core.js'

/** `writeFile` aqui sobrescreve: a sonda regrava o relatório a cada rodada. */
export type ProcuracaoDeps = SpikeDeps

export const CONFIRMACAO_PRODUCAO = 'EMITIR EM PRODUCAO'
export const VALOR_MAXIMO_PRODUCAO = 1

const URLS_ESPERADAS: Readonly<Record<Ambiente, { sefin: string; adn: string }>> = {
  producao_restrita: {
    sefin: 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional',
    adn: 'https://adn.producaorestrita.nfse.gov.br/contribuintes',
  },
  producao: { sefin: 'https://sefin.nfse.gov.br/SefinNacional', adn: 'https://adn.nfse.gov.br/contribuintes' },
}

export const USAGE = `Bateria da procuração eletrônica (nó.fiscal). Dois comandos:

  node scripts/nofiscal-procuracao.mjs sonda --saida=<pasta> [--ambiente=producao_restrita|producao]
      [--intervalo=120] [--minutos=60] [--uma-vez] [--cadastrada-em=2026-11-11T14:05]
      [--parar-quando=liberado|negado] [--adn-parametro=<nome do parâmetro do CNPJ>] [--rodada=<rótulo>]
      Testes 1 e 4: só leitura. Pede CNPJ do outorgante, PFX e senha do procurador e, opcional,
      a chave de acesso de uma NFS-e do outorgante (para a sonda na Sefin).

  node scripts/nofiscal-procuracao.mjs emitir --serie=<1-49999> --numero=<n> --ctribnac=<6 dígitos>
      --saida=<pasta> [--assinatura=procurador|outorgante] [--regime=simples|mei] [--p-tot-trib-sn=<%>]
      [--valor=1.00] [--municipio=3550308] [--perfil-assinatura=sha256|sha1] [--rodada=<rótulo>]
      [--ambiente=producao_restrita|producao] [--autorizado-por-lucca] [--nao-cancelar] [--ca=<PEM>]
      Testes 3 (assinatura do procurador), 3b (--assinatura=outorgante) e 4 (--rodada=sem-procuracao).
      A conexão é sempre com o certificado do procurador. Nota autorizada é cancelada na hora.
      Produção: exige --autorizado-por-lucca, valor até 1.00 e a frase "${CONFIRMACAO_PRODUCAO}".

Dados sensíveis (CNPJ, CPF, nome, caminhos, senhas, chave) são pedidos no terminal e não vão ao relatório.`

function ambienteDe(flags: Record<string, string>): Ambiente {
  const ambiente = flags.ambiente ?? 'producao_restrita'
  if (ambiente !== 'producao_restrita' && ambiente !== 'producao') {
    throw new SpikeRefused(`ambiente desconhecido: ${ambiente} (use producao_restrita ou producao)`)
  }
  if (SEFIN_BASE_URLS[ambiente] !== URLS_ESPERADAS[ambiente].sefin || ADN_CONTRIBUINTES_URLS[ambiente] !== URLS_ESPERADAS[ambiente].adn) {
    throw new SpikeRefused('as URLs da Sefin/ADN do motor não conferem com as esperadas; nada foi enviado')
  }
  return ambiente
}

const need = (flags: Record<string, string>, name: string) => {
  const value = flags[name]
  if (!value || value === 'true') throw new Error(`falta --${name}`)
  return value.trim()
}

const rotuloDe = (flags: Record<string, string>) => {
  const rodada = flags.rodada ?? 'com-procuracao'
  if (!/^[a-z0-9-]{1,40}$/.test(rodada)) throw new Error('--rodada aceita só letras minúsculas, números e hífen')
  return rodada
}

type CertAberto = { certificado: Certificado; pem: PemCredentials; tls: TlsCredentials; caminho: string; senha: string }

async function abrirCertificado(deps: ProcuracaoDeps, papel: 'procurador' | 'outorgante'): Promise<CertAberto> {
  const caminho = (await deps.ask(`Caminho do PFX do ${papel}: `)).trim()
  if (!caminho) throw new Error(`falta o caminho do PFX do ${papel}`)
  const senha = await deps.ask(`Senha do PFX do ${papel}: `, { hidden: true })
  const pfx = await deps.readFile(caminho)
  const certificado: Certificado = { pfxBase64: pfx.toString('base64'), password: senha }
  const pem = pfxToPem(certificado)
  if (pem.notAfter.getTime() <= deps.now().getTime()) throw new Error(`o certificado do ${papel} está vencido`)
  return { certificado, pem, tls: { key: pem.keyPem, cert: [pem.certPem, ...pem.chainPem].join('\n') }, caminho, senha }
}

async function perguntarCnpjOutorgante(deps: ProcuracaoDeps): Promise<string> {
  const cnpj = (await deps.ask('CNPJ do outorgante (o "cliente", 14 dígitos): ')).replace(/\D/g, '')
  if (!/^\d{14}$/.test(cnpj)) throw new Error('CNPJ deve ter 14 dígitos')
  return cnpj
}

/** Códigos de erro da Sefin/ADN no corpo (`codigo`/`Codigo`, em qualquer nível). */
export function codigosDe(body: string): string[] {
  const vistos = new Set<string>()
  for (const m of body.matchAll(/"codigo"\s*:\s*"([^"]{1,20})"/gi)) vistos.add(m[1])
  return [...vistos]
}

type RequestLog = { metodo: string; rota: string; status: number | null; ms: number; codigos: string[]; erro?: string }

/** Transporte que guarda só metadados e conecta SEMPRE com o certificado do procurador. */
function transporteDoProcurador(
  inner: SefinTransport,
  tlsProcurador: TlsCredentials,
  requests: RequestLog[],
  mask: (text: string) => string,
  now: () => Date,
): SefinTransport {
  return async (request: HttpRequest) => {
    const started = now().getTime()
    const rota = mask(new URL(request.url).pathname.replace(/^\/(SefinNacional|contribuintes)/, ''))
    try {
      const response = await inner(request, tlsProcurador)
      requests.push({ metodo: request.method, rota, status: response.status, ms: now().getTime() - started, codigos: codigosDe(response.body) })
      return response
    } catch (error) {
      requests.push({
        metodo: request.method,
        rota,
        status: null,
        ms: now().getTime() - started,
        codigos: [],
        erro: mask(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      })
      throw error
    }
  }
}

function deepMask<T>(value: T, mask: (text: string) => string): T {
  if (typeof value === 'string') return mask(value) as T
  if (Array.isArray(value)) return value.map((item) => deepMask(item, mask)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepMask(item, mask)])) as T
  }
  return value
}

const carimbo = (d: Date) => d.toISOString().replace(/[:.]/g, '-')
const pasta = (saida: string) => saida.replace(/[\\/]+$/, '')

// ------------------------------------------------------------------ sonda (testes 1 e 4)

export type EstadoSonda = 'liberado' | 'negado' | 'sem_resposta' | 'nao_visivel'

export type Rodada = {
  em: string
  minutos_desde_cadastro: number | null
  adn: { status: number | null; documentos: number; outorgante_visivel: boolean; codigos: string[]; erro?: string }
  sefin: { status: number | null; codigos: string[]; erro?: string } | null
  estado: EstadoSonda
}

export type SondaReport = {
  teste: 'sonda'
  rodada: string
  gerado_em: string
  ambiente: Ambiente
  adn_parametro: string | null
  sonda_sefin: boolean
  intervalo_s: number
  cadastrada_em: string | null
  certificado_procurador_valido_ate: string
  rodadas: Rodada[]
  transicoes: { em: string; minutos_desde_cadastro: number | null; de: EstadoSonda | null; para: EstadoSonda }[]
  encerrada_por: 'uma_vez' | 'tempo' | 'parar_quando'
  leitura: string
}

/** A sonda não tem tomador: a máscara do spike (que exige CPF) não serve. */
function mascaraDaSonda(segredos: string[]): (text: string) => string {
  const valores = segredos.filter(Boolean)
  return (text: string) => {
    let out = text.replace(/\d{50}/g, '[chave]')
    for (const v of valores) out = out.split(v).join('[segredo]')
    return out
  }
}

/** `2026-11-11T14:05` sem fuso é horário de Brasília. */
export function parseCadastradaEm(value: string | undefined): Date | null {
  if (!value) return null
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00-03:00` : value
  const t = Date.parse(iso)
  if (Number.isNaN(t)) throw new Error('--cadastrada-em deve ser data e hora, por exemplo 2026-11-11T14:05')
  return new Date(t)
}

/**
 * Estado da rodada. A Sefin decide quando há chave (200 = o procurador lê a nota do outorgante;
 * 4xx = negado). Só com o ADN: documento do outorgante visível = liberado; sem ele, "não visível"
 * (pode ser procuração ainda não propagada, parâmetro errado ou outorgante sem documentos).
 */
export function estadoDaRodada(r: Pick<Rodada, 'adn' | 'sefin'>): EstadoSonda {
  if (r.sefin) {
    if (r.sefin.status === 200) return 'liberado'
    if (r.sefin.status !== null && r.sefin.status >= 400 && r.sefin.status < 500) return 'negado'
    return 'sem_resposta'
  }
  if (r.adn.outorgante_visivel) return 'liberado'
  if (r.adn.status === null || r.adn.status >= 500) return 'sem_resposta'
  if (r.adn.status === 401 || r.adn.status === 403) return 'negado'
  return 'nao_visivel'
}

function documentosDoAdn(body: string): string[] | null {
  let corpo: unknown
  try {
    corpo = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof corpo !== 'object' || corpo === null) return null
  const chave = Object.keys(corpo).find((k) => k.toLowerCase() === 'lotedfe')
  const lote = chave ? (corpo as Record<string, unknown>)[chave] : undefined
  if (!Array.isArray(lote)) return []
  const xmls: string[] = []
  for (const doc of lote) {
    if (typeof doc !== 'object' || doc === null) continue
    const k = Object.keys(doc).find((name) => name.toLowerCase() === 'arquivoxml')
    const arquivo = k ? (doc as Record<string, unknown>)[k] : undefined
    if (typeof arquivo !== 'string') continue
    try {
      xmls.push(gunzipBase64(arquivo))
    } catch {
      // documento ilegível: conta como não visível
    }
  }
  return xmls
}

export async function runSonda(deps: ProcuracaoDeps, flags: Record<string, string>): Promise<{ report: SondaReport; path: string }> {
  const ambiente = ambienteDe(flags)
  const saida = need(flags, 'saida')
  const intervalo = Number(flags.intervalo ?? '120')
  if (!Number.isInteger(intervalo) || intervalo < 30 || intervalo > 3600) throw new Error('--intervalo deve ser de 30 a 3600 segundos')
  const minutos = Number(flags.minutos ?? '60')
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > 240) throw new Error('--minutos deve ser de 1 a 240')
  const umaVez = flags['uma-vez'] === 'true'
  const pararQuando = flags['parar-quando'] ?? null
  if (pararQuando !== null && pararQuando !== 'liberado' && pararQuando !== 'negado') throw new Error('--parar-quando deve ser liberado ou negado')
  const adnParametro = flags['adn-parametro'] ?? null
  if (adnParametro !== null && !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(adnParametro)) throw new Error('--adn-parametro deve ser um nome de parâmetro simples')
  const cadastradaEm = parseCadastradaEm(flags['cadastrada-em'])
  const rodada = rotuloDe(flags)

  const cnpj = await perguntarCnpjOutorgante(deps)
  const procurador = await abrirCertificado(deps, 'procurador')
  const chave = (await deps.ask('Chave de acesso de uma NFS-e do outorgante (Enter para pular a sonda na Sefin): ')).replace(/\D/g, '')
  if (chave && !/^\d{50}$/.test(chave)) throw new Error('a chave de acesso deve ter 50 dígitos')
  const mask = mascaraDaSonda([cnpj, procurador.senha, procurador.caminho, chave])

  const requests: RequestLog[] = []
  const extraCa = flags.ca ? [(await deps.readFile(flags.ca)).toString('utf8')] : []
  const transport = transporteDoProcurador(deps.transport({ extraCa }), procurador.tls, requests, mask, deps.now)
  const adnUrl = `${ADN_CONTRIBUINTES_URLS[ambiente]}/DFe/0?lote=true${adnParametro ? `&${adnParametro}=${cnpj}` : ''}`
  const sefinUrl = chave ? `${SEFIN_BASE_URLS[ambiente]}/nfse/${chave}` : null
  const headers = { accept: 'application/json' }
  const minutosDesde = (d: Date) => (cadastradaEm ? Math.round((d.getTime() - cadastradaEm.getTime()) / 6000) / 10 : null)

  const path = `${pasta(saida)}/nofiscal-procuracao-sonda-${rodada}-${carimbo(deps.now())}.json`
  const total = umaVez ? 1 : Math.floor((minutos * 60) / intervalo) + 1
  const rodadas: Rodada[] = []
  const transicoes: SondaReport['transicoes'] = []
  let encerradaPor: SondaReport['encerrada_por'] = umaVez ? 'uma_vez' : 'tempo'
  const montar = (): SondaReport => {
    const ultima = rodadas.at(-1)?.estado ?? null
    const primeiraLiberada = transicoes.find((t) => t.para === 'liberado')
    const leitura =
      ultima === null
        ? 'nenhuma rodada concluída'
        : primeiraLiberada
          ? `liberado a partir de ${primeiraLiberada.em}${primeiraLiberada.minutos_desde_cadastro !== null ? ` (${primeiraLiberada.minutos_desde_cadastro} min depois do cadastro)` : ''}; último estado: ${ultima}`
          : `nunca liberou nesta janela; último estado: ${ultima}${chave ? '' : ' (sem chave da Sefin, o ADN sozinho só mostra "liberado" se aparecer documento do outorgante)'}`
    return deepMask(
      {
        teste: 'sonda',
        rodada,
        gerado_em: deps.now().toISOString(),
        ambiente,
        adn_parametro: adnParametro,
        sonda_sefin: Boolean(chave),
        intervalo_s: intervalo,
        cadastrada_em: cadastradaEm?.toISOString() ?? null,
        certificado_procurador_valido_ate: procurador.pem.notAfter.toISOString().slice(0, 10),
        rodadas,
        transicoes,
        encerrada_por: encerradaPor,
        leitura,
        // As requisições ficam de fora da sonda: são uma ou duas por rodada, já descritas acima.
      } satisfies SondaReport,
      mask,
    )
  }

  deps.print(`Sonda como procurador em ${ambiente}: ${total} rodada(s), a cada ${intervalo} s. Relatório: ${path}`)
  for (let i = 0; i < total; i++) {
    if (i > 0) await deps.sleep(intervalo * 1000)
    const em = deps.now()
    const adn: Rodada['adn'] = { status: null, documentos: 0, outorgante_visivel: false, codigos: [] }
    try {
      const r = await transport({ method: 'GET', url: adnUrl, headers }, procurador.tls)
      adn.status = r.status
      adn.codigos = codigosDe(r.body)
      if (r.status === 200) {
        const xmls = documentosDoAdn(r.body) ?? []
        adn.documentos = xmls.length
        adn.outorgante_visivel = xmls.some((xml) => xml.includes(cnpj))
      }
    } catch (error) {
      adn.erro = error instanceof Error ? error.name : 'erro'
    }
    let sefin: Rodada['sefin'] = null
    if (sefinUrl) {
      sefin = { status: null, codigos: [] }
      try {
        const r = await transport({ method: 'GET', url: sefinUrl, headers }, procurador.tls)
        sefin.status = r.status
        sefin.codigos = codigosDe(r.body)
      } catch (error) {
        sefin.erro = error instanceof Error ? error.name : 'erro'
      }
    }
    const estado = estadoDaRodada({ adn, sefin })
    const anterior = rodadas.at(-1)?.estado ?? null
    rodadas.push({ em: em.toISOString(), minutos_desde_cadastro: minutosDesde(em), adn, sefin, estado })
    if (estado !== anterior) transicoes.push({ em: em.toISOString(), minutos_desde_cadastro: minutosDesde(em), de: anterior, para: estado })
    deps.print(
      `  ${em.toISOString()}: ${estado} (ADN ${adn.status ?? adn.erro}${adn.documentos ? `, ${adn.documentos} doc.` : ''}${sefin ? `; Sefin ${sefin.status ?? sefin.erro}` : ''})`,
    )
    if (pararQuando && estado === pararQuando) encerradaPor = 'parar_quando'
    // Regrava a cada rodada: interromper com Ctrl+C não perde o que já foi medido.
    await deps.writeFile(path, `${JSON.stringify(montar(), null, 2)}\n`)
    if (encerradaPor === 'parar_quando') break
  }
  const report = montar()
  await deps.writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  deps.print(report.leitura)
  return { report, path }
}

// ------------------------------------------------------------------ emitir (testes 3, 3b e 4)

type Resultado = { resultado: string; codigo?: string; mensagem?: string; chave_formato_ok?: boolean; ms: number }

export type EmissaoReport = {
  teste: '3' | '3b'
  rodada: string
  gerado_em: string
  ambiente: Ambiente
  assinatura: 'procurador' | 'outorgante'
  conexao: 'procurador'
  perfil_assinatura: SignatureProfile
  dps: { serie: string; numero: number; valor: string; regime: 'simples' | 'mei' }
  certificados_valido_ate: { procurador: string; outorgante: string | null }
  emissao: Resultado
  cancelamento: (Resultado & { consulta_evento: Resultado }) | null
  nota_pendente_de_cancelamento: boolean
  leitura: string
  requisicoes: RequestLog[]
}

export function leituraDaEmissao(input: {
  teste: '3' | '3b'
  rodada: string
  emissao: string
  codigo?: string
}): string {
  const codigo = input.codigo ? ` (${input.codigo})` : ''
  if (input.rodada === 'sem-procuracao') {
    if (input.emissao === 'authorized') return 'ALERTA: autorizada sem procuração. A revogação ainda não valeu ou a Sefin não confere a procuração; repetir mais tarde.'
    if (input.emissao === 'rejected') return `Rejeitada sem procuração${codigo}: este código vira a mensagem do agente para "procuração não encontrada".`
    return 'Sem resposta conclusiva da Sefin; repetir.'
  }
  if (input.teste === '3') {
    if (input.emissao === 'authorized') return 'DPS assinada e transmitida pelo procurador foi aceita: o cadastro por procuração dispensa o A1 do cliente (confirmar com o teste 4).'
    if (input.emissao === 'rejected') return `Rejeitada com o certificado do procurador${codigo}: rodar o teste 3b (--assinatura=outorgante) para separar assinatura de conexão.`
    return 'Sem resposta conclusiva da Sefin; repetir o teste 3.'
  }
  if (input.emissao === 'authorized') return 'Aceita com a assinatura do outorgante e a conexão do procurador: se o teste 3 foi rejeitado, a procuração não elimina o A1 (rever a proposta antes de vender).'
  if (input.emissao === 'rejected') return `Rejeitada também com a assinatura do outorgante${codigo}: conferir na sonda se a procuração já propagou e se o serviço cadastrado é o da NFS-e.`
  return 'Sem resposta conclusiva da Sefin; repetir o teste 3b.'
}

export async function runEmitir(deps: ProcuracaoDeps, flags: Record<string, string>): Promise<{ report: EmissaoReport; path: string }> {
  const ambiente = ambienteDe(flags)
  const assinatura = flags.assinatura ?? 'procurador'
  if (assinatura !== 'procurador' && assinatura !== 'outorgante') throw new Error('--assinatura deve ser procurador ou outorgante')
  const serie = need(flags, 'serie')
  if (!/^\d{1,5}$/.test(serie) || Number(serie) < 1 || Number(serie) > 49999) throw new Error('--serie deve estar entre 1 e 49999')
  const numero = Number(need(flags, 'numero'))
  if (!Number.isSafeInteger(numero) || numero < 1) throw new Error('--numero deve ser inteiro positivo')
  const cTribNac = need(flags, 'ctribnac')
  if (!/^\d{6}$/.test(cTribNac)) throw new Error('--ctribnac deve ter 6 dígitos')
  const regime = flags.regime ?? 'simples'
  if (regime !== 'simples' && regime !== 'mei') throw new Error('--regime deve ser simples ou mei')
  const pTotTribSN = regime === 'mei' ? null : need(flags, 'p-tot-trib-sn')
  if (pTotTribSN !== null && (!/^\d{1,3}(\.\d{1,2})?$/.test(pTotTribSN) || Number(pTotTribSN) > 100)) {
    throw new Error('--p-tot-trib-sn deve ser percentual de 0 a 100')
  }
  const valor = flags.valor ?? '1.00'
  if (!/^\d{1,13}\.\d{2}$/.test(valor) || Number(valor) <= 0) throw new Error('--valor deve ter 2 casas decimais, por exemplo 1.00')
  const municipio = flags.municipio ?? '3550308'
  if (!/^\d{7}$/.test(municipio)) throw new Error('--municipio deve ter 7 dígitos')
  const perfilFlag = flags['perfil-assinatura'] ?? 'sha256'
  if (perfilFlag !== 'sha256' && perfilFlag !== 'sha1') throw new Error('--perfil-assinatura deve ser sha256 ou sha1')
  const perfil: SignatureProfile = perfilFlag === 'sha1' ? 'sha1-c14n' : 'sha256-exc-c14n'
  const naoCancelar = flags['nao-cancelar'] === 'true'
  const saida = need(flags, 'saida')
  const rodada = rotuloDe(flags)

  if (ambiente === 'producao') {
    // Regra do handoff: emissão em produção só com aprovação prévia do Lucca, valor mínimo e cancelada na hora.
    if (flags['autorizado-por-lucca'] !== 'true') throw new SpikeRefused('emissão em produção exige --autorizado-por-lucca; nada foi enviado')
    if (Number(valor) > VALOR_MAXIMO_PRODUCAO) throw new SpikeRefused(`em produção o valor máximo é ${VALOR_MAXIMO_PRODUCAO.toFixed(2)}; nada foi enviado`)
    if (naoCancelar) throw new SpikeRefused('em produção a nota é sempre cancelada; tire --nao-cancelar')
    const frase = await deps.ask(`Vai emitir UMA NFS-e REAL de R$ ${valor} em produção e cancelar em seguida. Digite "${CONFIRMACAO_PRODUCAO}": `)
    if (frase.trim() !== CONFIRMACAO_PRODUCAO) throw new SpikeRefused('confirmação não digitada; nada foi enviado')
  }

  const cnpj = await perguntarCnpjOutorgante(deps)
  const im = (await deps.ask('Inscrição municipal do outorgante (Enter se não houver registro no CNC): ')).trim() || null
  const cpf = (await deps.ask('CPF do tomador de teste (11 dígitos): ')).replace(/\D/g, '')
  if (!cpfValido(cpf)) throw new Error('CPF do tomador de teste inválido (dígito verificador)')
  const nome = (await deps.ask('Nome do tomador de teste: ')).trim()
  if (!nome || nome.length > 150) throw new Error('nome do tomador deve ter de 1 a 150 caracteres')
  const procurador = await abrirCertificado(deps, 'procurador')
  const outorgante = assinatura === 'outorgante' ? await abrirCertificado(deps, 'outorgante') : null
  const assinante = outorgante ?? procurador
  const mask = makeMasker({ cnpj, im, cpf, nome }, [
    procurador.senha,
    procurador.caminho,
    procurador.certificado.pfxBase64.slice(0, 64),
    ...(outorgante ? [outorgante.senha, outorgante.caminho, outorgante.certificado.pfxBase64.slice(0, 64)] : []),
  ])

  const requests: RequestLog[] = []
  const extraCa = flags.ca ? [(await deps.readFile(flags.ca)).toString('utf8')] : []
  // O cliente assina com `assinante` (o certificado passado em cada chamada); o transporte troca a
  // credencial do mTLS pela do procurador. É o que separa assinatura de conexão no 3b.
  const transport = transporteDoProcurador(deps.transport({ extraCa }), procurador.tls, requests, mask, deps.now)
  const client = createSefinClient({ transport, perfilAssinatura: perfil, now: deps.now })
  const tenant: SefinTenant = {
    id: 'procuracao',
    cnpj,
    razao_social: 'procuracao',
    inscricao_municipal: im,
    codigo_municipio_ibge: municipio,
    regime,
    ambiente,
    p_tot_trib_sn: pTotTribSN,
  }
  const teste = assinatura === 'procurador' ? '3' : '3b'
  const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
    const started = deps.now().getTime()
    const value = await work()
    return [value, deps.now().getTime() - started]
  }

  deps.print(`Teste ${teste} (${rodada}) em ${ambiente}: prestador = outorgante, assinatura = ${assinatura}, conexão = procurador.`)
  const [emitido, msEmissao] = await timed(() =>
    client.emitir({
      tenant,
      invoice: {
        id: `procuracao-${numero}`,
        external_id: `procuracao-${numero}`,
        payload: {
          tomador: { cpf, nome },
          servico: { codigo_servico_nacional: cTribNac, descricao: 'Teste de emissao por procuracao eletronica' },
          valor,
        },
        dps_serie: serie,
        dps_numero: numero,
        id_dps: client.idDps({ tenant, serie, numero }),
      },
      certificado: assinante.certificado,
    }),
  )
  const emissao: Resultado =
    emitido.kind === 'authorized'
      ? { resultado: 'authorized', chave_formato_ok: /^\d{50}$/.test(emitido.chaveAcesso), ms: msEmissao }
      : emitido.kind === 'rejected'
        ? { resultado: 'rejected', codigo: emitido.code, mensagem: emitido.message, ms: msEmissao }
        : { resultado: 'unavailable', mensagem: emitido.reason, ms: msEmissao }
  deps.print(`  emissão: ${emissao.resultado}${emissao.codigo ? ` ${emissao.codigo}` : ''}`)

  let cancelamento: EmissaoReport['cancelamento'] = null
  let pendente = false
  if (emitido.kind === 'authorized') {
    if (naoCancelar) {
      pendente = true
    } else {
      const [cancel, ms] = await timed(() => client.cancelar({ tenant, chaveAcesso: emitido.chaveAcesso, certificado: assinante.certificado }))
      const [consulta, msConsulta] = await timed(() =>
        client.consultarCancelamento({ tenant, chaveAcesso: emitido.chaveAcesso, certificado: assinante.certificado }),
      )
      cancelamento = {
        resultado: cancel.kind,
        ...(cancel.kind === 'refused' ? { codigo: cancel.code, mensagem: cancel.message } : {}),
        ...(cancel.kind === 'unavailable' ? { mensagem: cancel.reason } : {}),
        ms,
        consulta_evento: {
          resultado: consulta.kind,
          ...(consulta.kind === 'unavailable' ? { mensagem: consulta.reason } : {}),
          ms: msConsulta,
        },
      }
      pendente = cancel.kind !== 'accepted' && consulta.kind !== 'found'
      deps.print(`  cancelamento: ${cancel.kind}${cancel.kind === 'refused' ? ` ${cancel.code}` : ''}; consulta do evento: ${consulta.kind}`)
    }
    if (pendente) {
      // A chave só aparece aqui no terminal (é preciso para cancelar à mão); o relatório não a guarda.
      deps.print('  ATENÇÃO: a nota está AUTORIZADA e NÃO foi cancelada.')
      deps.print(`  Chave de acesso: ${emitido.chaveAcesso}`)
      deps.print('  Cancele no Emissor Nacional (perfil do outorgante) ou rode de novo com o certificado do outorgante.')
    }
  }

  const leitura = leituraDaEmissao({ teste, rodada, emissao: emissao.resultado, codigo: emissao.codigo })
  const report = deepMask<EmissaoReport>(
    {
      teste,
      rodada,
      gerado_em: deps.now().toISOString(),
      ambiente,
      assinatura,
      conexao: 'procurador',
      perfil_assinatura: perfil,
      dps: { serie, numero, valor, regime },
      certificados_valido_ate: {
        procurador: procurador.pem.notAfter.toISOString().slice(0, 10),
        outorgante: outorgante ? outorgante.pem.notAfter.toISOString().slice(0, 10) : null,
      },
      emissao,
      cancelamento,
      nota_pendente_de_cancelamento: pendente,
      leitura,
      requisicoes: requests,
    },
    mask,
  )
  const path = `${pasta(saida)}/nofiscal-procuracao-teste${teste}-${rodada}-${carimbo(deps.now())}.json`
  await deps.writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  deps.print(leitura)
  deps.print(`Relatório gravado em ${path}. Número ${numero} da série ${serie} consumido em ${ambiente}.`)
  return { report, path }
}

// ------------------------------------------------------------------ entrada

export async function runProcuracao(deps: ProcuracaoDeps): Promise<{ path: string | null }> {
  const [comando, ...resto] = deps.argv
  if (!comando || comando === '--help' || comando === 'ajuda') {
    deps.print(USAGE)
    return { path: null }
  }
  const flags = parseFlags(resto)
  if (flags.help) {
    deps.print(USAGE)
    return { path: null }
  }
  if (comando === 'sonda') return runSonda(deps, flags)
  if (comando === 'emitir') return runEmitir(deps, flags)
  throw new Error(`comando desconhecido: ${comando} (use sonda ou emitir)`)
}
