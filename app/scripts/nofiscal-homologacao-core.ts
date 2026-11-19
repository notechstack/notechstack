// Homologação do leiaute da NT 009 na PRODUÇÃO RESTRITA da Sefin Nacional, por regime (Lucca, 19/11/2026).
// Quem roda é o Lucca, na máquina dele, com o A1 de uma empresa de teste de cada regime (MEI, Simples, Presumido ou
// Real). Para cada regime, transmite pelo cliente real do motor:
//   (1) a DPS no leiaute NT 009 sem IBSCBS (o que vai para produção em 01/12/2026);
//   (2) a mesma com o grupo IBSCBS e NBS, se --nbs vier (o que liga com NOFISCAL_DPS_IBSCBS=1);
//   (3) Presumido/Real com tomador CNPJ: IRRF 1,5% e PIS/COFINS/CSLL 4,65% retidos (tribFed).
// Cada nota autorizada é consultada e cancelada em seguida (e101101), para não deixar nota viva no ambiente de teste.
// O relatório JSON não traz PFX, senha, XML assinado, CNPJ, CPF, nome, inscrição municipal, Id da DPS nem chave: só o
// resultado, o código e a mensagem da Sefin, e os campos do regime lidos de volta na NFS-e.
// Recusa qualquer ambiente diferente de `producao_restrita`, antes de pedir qualquer dado.
import { createSefinClient, SEFIN_BASE_URLS, type SefinTransport } from '../api/_lib/sefin-client.js'
import { pfxToPem } from '../api/_lib/pfx.js'
import type { Certificado, SefinInvoice, SefinTenant } from '../api/_lib/sefin.js'
import type { OpcoesDps } from '../api/_lib/dps-builder.js'
import type { SignatureProfile } from '../api/_lib/xml-signer.js'
import { cpfValido, makeMasker, parseFlags, SPIKE_AMBIENTE, SpikeRefused } from './nofiscal-spike-core.js'

export type HomologacaoDeps = {
  argv: string[]
  ask: (question: string, options?: { hidden?: boolean }) => Promise<string>
  readFile: (path: string) => Promise<Buffer>
  writeFile: (path: string, content: string) => Promise<void>
  transport: (options: { extraCa: string[] }) => SefinTransport
  now: () => Date
  print: (line: string) => void
}

export type Regime = 'mei' | 'simples' | 'presumido' | 'real'

export type HomologacaoParams = {
  regime: Regime
  municipio: string
  serie: string
  numeroInicial: number
  cTribNac: string
  nbs: string | null
  pTotTribSN: string | null
  pTotTrib: { fed: string; est: string; mun: string } | null
  valor: string
  saida: string
  perfil: SignatureProfile
  caPath: string | null
}

export const USAGE_HOMOLOGACAO = `Uso: node scripts/nofiscal-homologacao.mjs --regime=mei|simples|presumido|real --municipio=<IBGE> \\
  --ctribnac=<6 dígitos> --serie=<1-49999> --numero-inicial=<n> --saida=<pasta> \\
  [--p-tot-trib-sn=6.00 (Simples)] [--p-tot-trib=13.45,0,5.00 (Presumido/Real: federal,estadual,municipal)] \\
  [--nbs=1.1502.10.00 (liga a nota com IBSCBS)] [--valor=1000.00] [--perfil-assinatura=sha256|sha1] [--ca=<PEM>]
CNPJ e inscrição municipal do prestador, documento e nome do tomador de teste, caminho do PFX e senha são pedidos
no terminal. Tomador com CNPJ (14 dígitos) em Presumido/Real acrescenta a nota com retenções federais.
Só roda contra a produção restrita.`

const PCT = /^\d{1,3}(\.\d{1,2})?$/

const centavos = (v: string) => BigInt(v.replace('.', ''))
const reais = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`
/** IRRF 1,5% e PIS/COFINS/CSLL 4,65% (0,65 + 3 + 1) do valor: as alíquotas usuais de serviço entre PJ, só para o teste. */
export function gerarRetencoesFederaisDeTeste(valor: string) {
  const v = centavos(valor)
  return { irrf: { valor: reais((v * 150n + 5000n) / 10000n) }, csrf: { valor: reais((v * 465n + 5000n) / 10000n) } }
}

export function parseHomologacaoParams(flags: Record<string, string>): HomologacaoParams {
  const ambiente = flags.ambiente ?? SPIKE_AMBIENTE
  if (ambiente !== SPIKE_AMBIENTE) throw new SpikeRefused(`a homologação só roda na produção restrita (recebido: ${ambiente})`)
  const need = (name: string) => {
    const v = flags[name]
    if (!v || v === 'true') throw new Error(`falta --${name}`)
    return v.trim()
  }
  const regime = need('regime') as Regime
  if (!['mei', 'simples', 'presumido', 'real'].includes(regime)) throw new Error('--regime deve ser mei, simples, presumido ou real')
  const municipio = need('municipio')
  if (!/^\d{7}$/.test(municipio)) throw new Error('--municipio deve ter 7 dígitos (IBGE)')
  const serie = need('serie')
  if (!/^\d{1,5}$/.test(serie) || Number(serie) < 1 || Number(serie) > 49999) throw new Error('--serie deve estar entre 1 e 49999')
  const numeroInicial = Number(need('numero-inicial'))
  if (!Number.isSafeInteger(numeroInicial) || numeroInicial < 1) throw new Error('--numero-inicial deve ser inteiro positivo')
  const cTribNac = need('ctribnac')
  if (!/^\d{6}$/.test(cTribNac)) throw new Error('--ctribnac deve ter 6 dígitos')
  const nbs = flags.nbs ? flags.nbs.replace(/[.\s]/g, '') : null
  if (nbs !== null && !/^\d{9}$/.test(nbs)) throw new Error('--nbs deve ter 9 dígitos (1.1502.10.00)')
  let pTotTribSN: string | null = null
  let pTotTrib: HomologacaoParams['pTotTrib'] = null
  if (regime === 'simples') {
    pTotTribSN = need('p-tot-trib-sn')
    if (!PCT.test(pTotTribSN) || Number(pTotTribSN) > 100) throw new Error('--p-tot-trib-sn deve ser percentual de 0 a 100')
  }
  if (regime === 'presumido' || regime === 'real') {
    const partes = need('p-tot-trib').split(',').map((p) => p.trim())
    if (partes.length !== 3 || partes.some((p) => !PCT.test(p) || Number(p) > 100)) {
      throw new Error('--p-tot-trib deve ser federal,estadual,municipal (ex.: 13.45,0,5.00)')
    }
    pTotTrib = { fed: partes[0], est: partes[1], mun: partes[2] }
  }
  const valor = flags.valor ?? '1000.00'
  if (!/^\d{1,13}\.\d{2}$/.test(valor) || Number(valor) <= 0) throw new Error('--valor deve ter 2 casas decimais, por exemplo 1000.00')
  const perfil = flags['perfil-assinatura'] ?? 'sha256'
  if (perfil !== 'sha256' && perfil !== 'sha1') throw new Error('--perfil-assinatura deve ser sha256 ou sha1')
  return {
    regime,
    municipio,
    serie,
    numeroInicial,
    cTribNac,
    nbs,
    pTotTribSN,
    pTotTrib,
    valor,
    saida: need('saida'),
    perfil: perfil === 'sha1' ? 'sha1-c14n' : 'sha256-exc-c14n',
    caPath: flags.ca ?? null,
  }
}

type Segredos = { cnpj: string; im: string | null; tomador: string; nome: string; pfxPath: string; password: string }

async function pedirSegredos(ask: HomologacaoDeps['ask']): Promise<Segredos> {
  const cnpj = (await ask('CNPJ do prestador (14 dígitos): ')).replace(/\D/g, '')
  if (!/^\d{14}$/.test(cnpj)) throw new Error('CNPJ deve ter 14 dígitos')
  const im = (await ask('Inscrição municipal (Enter se não houver registro no CNC): ')).trim() || null
  const tomador = (await ask('CPF ou CNPJ do tomador de teste: ')).replace(/\D/g, '')
  if (!(tomador.length === 14 || (tomador.length === 11 && cpfValido(tomador)))) throw new Error('documento do tomador inválido')
  const nome = (await ask('Nome do tomador de teste: ')).trim()
  if (!nome || nome.length > 150) throw new Error('nome do tomador deve ter de 1 a 150 caracteres')
  const pfxPath = (await ask('Caminho do arquivo PFX do A1: ')).trim()
  if (!pfxPath) throw new Error('falta o caminho do PFX')
  const password = await ask('Senha do PFX: ', { hidden: true })
  return { cnpj, im, tomador, nome, pfxPath, password }
}

type Caso = { rotulo: string; opcoes: OpcoesDps; servico: Record<string, unknown>; retencao: Record<string, unknown> | null }

export type ResultadoNota = {
  caso: string
  numero: string
  resultado: string
  codigo?: string
  mensagem?: string
  ms: number
  /** Lido de volta na NFS-e autorizada: o que a Sefin gravou para o regime. */
  conferido?: Record<string, string | boolean | null>
  consulta?: string
  cancelamento?: string
}

export type RelatorioHomologacao = {
  gerado_em: string
  ambiente: string
  url_base: string
  regime: Regime
  municipio: string
  leiaute: 'nt009'
  certificado_valido_ate: string
  notas: ResultadoNota[]
  codigos_vistos: string[]
}

const tag = (xml: string, nome: string) => new RegExp(`<(?:\\w+:)?${nome}>([^<]*)</(?:\\w+:)?${nome}>`).exec(xml)?.[1] ?? null

export async function runHomologacao(deps: HomologacaoDeps): Promise<{ relatorio: RelatorioHomologacao | null; path: string | null }> {
  const flags = parseFlags(deps.argv)
  if (flags.help) {
    deps.print(USAGE_HOMOLOGACAO)
    return { relatorio: null, path: null }
  }
  const p = parseHomologacaoParams(flags)
  const baseUrl = SEFIN_BASE_URLS[SPIKE_AMBIENTE]
  if (baseUrl !== 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional') {
    throw new SpikeRefused('a URL da produção restrita não confere; nada foi enviado')
  }
  const s = await pedirSegredos(deps.ask)
  const pfx = await deps.readFile(s.pfxPath)
  const certificado: Certificado = { pfxBase64: pfx.toString('base64'), password: s.password }
  const pem = pfxToPem(certificado)
  if (pem.notAfter.getTime() <= deps.now().getTime()) throw new Error('o certificado do PFX está vencido')
  const extraCa = p.caPath ? [(await deps.readFile(p.caPath)).toString('utf8')] : []
  const mask = makeMasker({ cnpj: s.cnpj, im: s.im, cpf: s.tomador, nome: s.nome }, [s.password, s.pfxPath])

  const tenant: SefinTenant = {
    id: 'homologacao',
    cnpj: s.cnpj,
    razao_social: 'homologacao',
    inscricao_municipal: s.im,
    codigo_municipio_ibge: p.municipio,
    regime: p.regime,
    ambiente: SPIKE_AMBIENTE,
    p_tot_trib_sn: p.pTotTribSN,
    p_tot_trib: p.pTotTrib,
  }
  const naoOptante = p.regime === 'presumido' || p.regime === 'real'
  const casos: Caso[] = [{ rotulo: 'nt009', opcoes: { leiaute: 'nt009', ibscbs: false }, servico: {}, retencao: null }]
  if (p.nbs) casos.push({ rotulo: 'nt009+ibscbs', opcoes: { leiaute: 'nt009', ibscbs: true }, servico: { nbs: p.nbs }, retencao: null })
  if (naoOptante && s.tomador.length === 14) {
    casos.push({ rotulo: 'nt009+retencao-federal', opcoes: { leiaute: 'nt009', ibscbs: false }, servico: {}, retencao: gerarRetencoesFederaisDeTeste(p.valor) })
  }

  const inner = deps.transport({ extraCa })
  const codigos = new Set<string>()
  const notas: ResultadoNota[] = []
  let atual: OpcoesDps = casos[0].opcoes
  const client = createSefinClient({ transport: inner, perfilAssinatura: p.perfil, now: deps.now, opcoesDps: () => atual })

  for (const [i, caso] of casos.entries()) {
    const numero = p.numeroInicial + i
    atual = caso.opcoes
    const invoice: SefinInvoice = {
      id: `homologacao-${numero}`,
      external_id: `homologacao-${numero}`,
      payload: {
        tomador: { [s.tomador.length === 14 ? 'cnpj' : 'cpf']: s.tomador, nome: s.nome },
        servico: { codigo_servico_nacional: p.cTribNac, descricao: `Teste de homologacao NT 009 - ${p.regime}`, ...caso.servico },
        valor: p.valor,
        ...(caso.retencao ? { retencao: caso.retencao } : {}),
      },
      dps_serie: p.serie,
      dps_numero: numero,
      id_dps: client.idDps({ tenant, serie: p.serie, numero }),
    }
    const inicio = deps.now().getTime()
    const r = await client.emitir({ tenant, invoice, certificado })
    const ms = deps.now().getTime() - inicio
    const nota: ResultadoNota = { caso: caso.rotulo, numero: `n0+${i}`, resultado: r.kind, ms }
    deps.print(`${caso.rotulo}: ${r.kind}${r.kind === 'rejected' ? ` ${r.code}` : ''}`)
    if (r.kind === 'rejected') {
      codigos.add(r.code)
      nota.codigo = r.code
      nota.mensagem = mask(r.message)
    } else if (r.kind === 'unavailable') {
      for (const c of r.reason.match(/E\d{3,4}/g) ?? []) codigos.add(c)
      nota.mensagem = mask(r.reason)
    } else {
      nota.conferido = {
        opSimpNac: tag(r.xmlNfse, 'opSimpNac'),
        regApTribSN: tag(r.xmlNfse, 'regApTribSN'),
        pTotTribSN: tag(r.xmlNfse, 'pTotTribSN'),
        pTotTribFed: tag(r.xmlNfse, 'pTotTribFed'),
        finNFSe: tag(r.xmlNfse, 'finNFSe'),
        cNBS: tag(r.xmlNfse, 'cNBS') !== null,
        grupo_IBSCBS: /<(?:\w+:)?IBSCBS>/.test(r.xmlNfse),
        vRetIRRF: tag(r.xmlNfse, 'vRetIRRF'),
        vRetCSLL: tag(r.xmlNfse, 'vRetCSLL'),
        vTotalRet: tag(r.xmlNfse, 'vTotalRet'),
        vLiq: tag(r.xmlNfse, 'vLiq'),
      }
      const consulta = await client.consultarPorIdDps({ tenant, idDps: invoice.id_dps, certificado })
      nota.consulta = consulta.kind
      const cancel = await client.cancelar({ tenant, chaveAcesso: r.chaveAcesso, certificado })
      nota.cancelamento = cancel.kind === 'refused' ? `refused ${cancel.code}` : cancel.kind
    }
    notas.push(nota)
  }

  const relatorio: RelatorioHomologacao = {
    gerado_em: deps.now().toISOString(),
    ambiente: SPIKE_AMBIENTE,
    url_base: baseUrl,
    regime: p.regime,
    municipio: p.municipio,
    leiaute: 'nt009',
    certificado_valido_ate: pem.notAfter.toISOString(),
    notas,
    codigos_vistos: [...codigos].sort(),
  }
  const texto = mask(JSON.stringify(relatorio, null, 2))
  const path = `${p.saida.replace(/[\\/]+$/, '')}/homologacao-nt009-${p.regime}-${relatorio.gerado_em.replace(/[:.]/g, '-')}.json`
  await deps.writeFile(path, texto)
  deps.print(`Relatório: ${path}`)
  return { relatorio: JSON.parse(texto) as RelatorioHomologacao, path }
}
