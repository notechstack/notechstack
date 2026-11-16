// Conferência da empresa para NF-e (migração 20261117100000): automática, gratuita e sempre com o A1 da própria
// empresa. Ordem (Lucca, 17/11/2026):
//   1. certificado: `abrirCertificado` confere a raiz do CNPJ (a Sefaz rejeita com 213 se não bater);
//   2. consulta de cadastro da Sefaz da UF (15 UFs têm): IE do CNPJ, habilitada e credenciada para NF-e. Só a
//      resposta com cadastro (111/112) decide; sem o serviço, sem resposta ou com outro código, segue para a nota de
//      teste, que é a prova definitiva;
//   3. nota de teste em homologação (vale para as 27 UFs), série 889 com numeração própria da conferência:
//      autorizada = pronta; 203 = falta credenciamento; 230/231 = problema na IE; 213 = certificado de outro CNPJ.
// O resultado fica em `fiscal_nfe_conferencias` com a IE, a UF e o certificado usados; `nfe_emission_block` pede
// conferência nova quando um deles muda.
import type { Db } from '../db.js'
import { logEvent } from '../log.js'
import type { Uf } from './autorizadores.js'
import { montarNfe, NfeInvalidaError, soDigitos, type NfeInput, type ResponsavelTecnico } from './nfe-builder.js'
import { abrirCertificado, CSTAT_TRANSITORIO, type ResultadoAutorizacao, type SefazClient } from './sefaz-client.js'
import { emitenteDaEmpresa, empresaNfe, type EmpresaNfe } from './servico.js'

/**
 * Série da nota de teste: a última da faixa do web service (0 a 889; 890+ dá rejeição 266). Só vai à homologação,
 * que é outro ambiente da Sefaz: não disputa número com a série de produção da empresa.
 */
export const SERIE_DE_TESTE = 889

export type ResultadoConferencia = {
  status: 'pendente' | 'aprovada' | 'reprovada' | 'erro'
  etapa: 'certificado' | 'cadastro' | 'nota_teste' | null
  codigo: string | null
  motivo: string
}

const NOME_DA_UF: Record<string, string> = {
  AC: 'Acre', AL: 'Alagoas', AM: 'Amazonas', AP: 'Amapá', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
  GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais', MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba',
  PE: 'Pernambuco', PI: 'Piauí', PR: 'Paraná', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia', RR: 'Roraima',
  RS: 'Rio Grande do Sul', SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo', TO: 'Tocantins',
}

/** Onde a empresa pede o credenciamento de emissor de NF-e. */
export function ondeCredenciar(uf: string): string {
  if (uf === 'SP') return 'peça o credenciamento no Posto Fiscal Eletrônico (PFE) da Sefaz-SP'
  return `peça o credenciamento como emissor de NF-e na Sefaz de ${NOME_DA_UF[uf] ?? uf}`
}

/** Texto que o painel mostra para cada código da conferência (o que houve e o que fazer). */
export function motivoDaConferencia(codigo: string, uf: string, detalhe = ''): string {
  const sefaz = `a Sefaz-${uf}`
  switch (codigo) {
    case 'CERT_DE_OUTRO_CNPJ':
      return 'o certificado A1 é de outro CNPJ: a NF-e só pode ser assinada pelo e-CNPJ A1 da própria empresa (ou da matriz). Envie o A1 dela'
    case 'CERT_SEM_CNPJ':
      return 'o certificado não é um e-CNPJ A1 (não traz CNPJ). Envie o e-CNPJ A1 da empresa'
    case 'CERT_INVALID':
      return 'não deu para abrir o certificado A1 gravado. Envie o A1 de novo'
    case 'NFE_CERT_MISSING':
      return 'falta o certificado A1 da própria empresa (a NF-e não aceita procuração). Envie o A1 dela'
    case 'NFE_IE_NAO_E_DO_CNPJ':
      return `${sefaz} não encontra a inscrição estadual informada neste CNPJ${detalhe ? ` (IEs do CNPJ: ${detalhe})` : ''}. Confira a IE`
    case 'NFE_IE_NAO_HABILITADA':
      return `${sefaz} informa que a inscrição estadual não está habilitada. Regularize a IE na Sefaz`
    case 'NFE_NAO_CREDENCIADA':
      return `${sefaz} informa que esta empresa não está credenciada para NF-e: ${ondeCredenciar(uf)}`
    case 'NFE_IE_INVALIDA':
      return `${sefaz} recusou a inscrição estadual (não cadastrada ou não vinculada a este CNPJ). Confira a IE${detalhe ? `: ${detalhe}` : ''}`
    case 'SEFAZ_INDISPONIVEL':
      return `${sefaz} não respondeu agora. Tente a conferência de novo em alguns minutos`
    default:
      return `${sefaz} recusou a nota de teste${detalhe ? `: ${detalhe}` : ''}`
  }
}

/** A nota de teste: R$ 1,00 de um item, para um consumidor final fictício no endereço da própria empresa. */
export function notaDeTeste(empresa: EmpresaNfe, numero: number, agora: Date, responsavelTecnico: ResponsavelTecnico | null): NfeInput {
  const emitente = emitenteDaEmpresa(empresa)
  return {
    ambiente: 'homologacao',
    emitente,
    destinatario: {
      documento: '52998224725',
      nome: 'Conferencia de configuracao',
      indicadorIE: '9',
      endereco: emitente.endereco,
    },
    itens: [
      { codigo: 'TESTE', descricao: 'Item de teste da conferencia de NF-e', ncm: '21069090', cfop: '5102', unidade: 'UN', quantidade: 1, valorUnitario: 1, csosn: '102' },
    ],
    serie: SERIE_DE_TESTE,
    numero,
    emissao: agora,
    naturezaOperacao: 'Venda de mercadoria',
    presenca: '9',
    pagamentos: [{ forma: '01', valor: 1 }],
    informacoesComplementares: 'Nota de teste em homologacao para conferir o cadastro do emissor. Sem valor fiscal.',
    responsavelTecnico,
  }
}

export type ConferirDeps = {
  db: Db
  sefaz: SefazClient
  now: () => Date
  responsavelTecnico?: ResponsavelTecnico | null
  /** Espera entre consultas de recibo quando a Sefaz processa o lote em segundo plano (padrão 1,5 s). */
  esperarMs?: number
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const semZeros = (s: string) => soDigitos(s).replace(/^0+/, '')

async function gravar(db: Db, tenantId: string, r: ResultadoConferencia, extra: Record<string, unknown>): Promise<ResultadoConferencia> {
  await db.query(
    `insert into nofiscal.fiscal_nfe_conferencias
       (tenant_id, status, etapa, codigo, motivo, cadastro_cred_nfe, cadastro_habilitada, teste_chave, teste_protocolo, ie, uf,
        cert_uploaded_at, conferida_em, updated_at)
     -- O instante do certificado conferido vai como texto lido do banco: o Date do JS perderia os microssegundos.
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $13::timestamptz, $12, $12)
     on conflict (tenant_id) do update set
       status = excluded.status, etapa = excluded.etapa, codigo = excluded.codigo, motivo = excluded.motivo,
       cadastro_cred_nfe = excluded.cadastro_cred_nfe, cadastro_habilitada = excluded.cadastro_habilitada,
       teste_chave = coalesce(excluded.teste_chave, fiscal_nfe_conferencias.teste_chave),
       teste_protocolo = coalesce(excluded.teste_protocolo, fiscal_nfe_conferencias.teste_protocolo),
       ie = excluded.ie, uf = excluded.uf, cert_uploaded_at = excluded.cert_uploaded_at,
       conferida_em = excluded.conferida_em, updated_at = excluded.updated_at`,
    [
      tenantId, r.status, r.etapa, r.codigo, r.motivo.slice(0, 500),
      extra.credNfe ?? null, extra.habilitada ?? null, extra.chave ?? null, extra.protocolo ?? null,
      extra.ie ?? null, extra.uf ?? null, extra.agora, extra.certUploadedAt ?? null,
    ],
  )
  logEvent('nofiscal.nfe_conferencia', { tenant_id: tenantId, status: r.status, etapa: r.etapa, codigo: r.codigo })
  return r
}

/** Reserva o próximo número da série de teste (fica gravado mesmo que a Sefaz não responda: nunca se repete). */
async function numeroDeTeste(db: Db, tenantId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `insert into nofiscal.fiscal_nfe_conferencias (tenant_id, teste_proximo_numero) values ($1, 2)
     on conflict (tenant_id) do update set teste_proximo_numero = fiscal_nfe_conferencias.teste_proximo_numero + 1
     returning teste_proximo_numero - 1 as n`,
    [tenantId],
  )
  return Number(rows[0].n)
}

export async function conferirEmpresaNfe(deps: ConferirDeps, tenantId: string): Promise<ResultadoConferencia> {
  const db = deps.db
  const agora = deps.now()
  const empresa = await empresaNfe(db, tenantId)
  if (!empresa) return { status: 'pendente', etapa: null, codigo: 'TENANT_NOT_FOUND', motivo: 'empresa não encontrada' }
  if (!empresa.inscricao_estadual || !empresa.endereco) {
    return { status: 'pendente', etapa: null, codigo: 'NFE_SEM_DADOS', motivo: 'preencha a inscrição estadual e o endereço antes da conferência' }
  }
  const uf = empresa.endereco.uf as Uf
  // O instante do A1 é lido junto com ele: se outro A1 chegar durante a conferência, o resultado fica preso ao antigo e
  // `nfe_emission_block` pede outra conferência.
  const { rows: certs } = await db.query<{ pfx_base64: string | null; password: string | null; uploaded_at: string }>(
    `select r.pfx_base64, r.password, c.uploaded_at::text as uploaded_at from nofiscal.fiscal_certificates c, nofiscal.read_certificate(c.tenant_id) r
      where c.tenant_id = $1`,
    [tenantId],
  )
  const base = { ie: empresa.inscricao_estadual, uf, agora, certUploadedAt: certs[0]?.uploaded_at ?? null }
  const reprovar = (etapa: ResultadoConferencia['etapa'], codigo: string, detalhe = '', extra: Record<string, unknown> = {}) =>
    gravar(db, tenantId, { status: 'reprovada', etapa, codigo, motivo: motivoDaConferencia(codigo, uf, detalhe) }, { ...base, ...extra })
  const falhar = (etapa: ResultadoConferencia['etapa'], motivo: string, extra: Record<string, unknown> = {}) =>
    (logEvent('nofiscal.nfe_conferencia_indisponivel', { tenant_id: tenantId, etapa, motivo: motivo.slice(0, 200) }),
    gravar(db, tenantId, { status: 'erro', etapa, codigo: 'SEFAZ_INDISPONIVEL', motivo: motivoDaConferencia('SEFAZ_INDISPONIVEL', uf) }, { ...base, ...extra }))

  // 1. Certificado da própria empresa.
  const cert = certs[0]
  if (!cert?.pfx_base64) return reprovar('certificado', 'NFE_CERT_MISSING')
  const cred = abrirCertificado({ pfxBase64: cert.pfx_base64, password: cert.password ?? '' }, empresa.cnpj)
  if ('erro' in cred) return reprovar('certificado', cred.erro.split(':')[0])

  // 2. Cadastro da Sefaz da UF, onde existir.
  const extra: Record<string, unknown> = {}
  const cad = await deps.sefaz.consultarCadastro(uf, empresa.cnpj, cred)
  if (cad.kind === 'encontrado') {
    const minha = cad.inscricoes.find((i) => semZeros(i.ie) === semZeros(empresa.inscricao_estadual!))
    if (!minha) return reprovar('cadastro', 'NFE_IE_NAO_E_DO_CNPJ', cad.inscricoes.map((i) => i.ie).filter(Boolean).join(', '))
    extra.credNfe = minha.credenciamentoNfe || null
    extra.habilitada = minha.habilitada
    if (!minha.habilitada) return reprovar('cadastro', 'NFE_IE_NAO_HABILITADA', '', extra)
    if (minha.credenciamentoNfe === '0') return reprovar('cadastro', 'NFE_NAO_CREDENCIADA', '', extra)
  } else if (cad.kind !== 'sem_servico') {
    logEvent('nofiscal.nfe_conferencia_cadastro', { tenant_id: tenantId, resultado: cad.kind, cstat: 'cStat' in cad ? cad.cStat : null })
  }

  // 3. Nota de teste em homologação.
  let r: ResultadoAutorizacao | null = null
  let chave = ''
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const numero = await numeroDeTeste(db, tenantId)
    let xml: string
    try {
      const montada = montarNfe(notaDeTeste(empresa, numero, agora, deps.responsavelTecnico ?? null))
      xml = deps.sefaz.assinarNfe(montada.xml, cred)
      chave = montada.chave
    } catch (error) {
      if (error instanceof NfeInvalidaError) return reprovar('nota_teste', 'NFE_DADOS_INVALIDOS', error.problemas.join('; '), extra)
      throw error
    }
    r = await deps.sefaz.autorizar(uf, 'homologacao', xml, cred)
    for (let i = 0; i < 3 && r.kind === 'em_processamento'; i++) {
      await esperar(deps.esperarMs ?? 1500)
      r = await deps.sefaz.consultarRecibo(uf, 'homologacao', r.recibo, xml, cred)
    }
    // Número de teste já usado (uma conferência anterior que não voltou): vai o próximo.
    if (r.kind === 'rejeitada' && (r.cStat === '539' || r.cStat === '204')) continue
    break
  }
  const comChave = { ...extra, chave }
  if (!r || r.kind === 'indisponivel' || r.kind === 'em_processamento') {
    return falhar('nota_teste', r && r.kind === 'indisponivel' ? r.motivo : 'sem resposta final', comChave)
  }
  if (r.kind === 'autorizada') {
    return gravar(db, tenantId, { status: 'aprovada', etapa: 'nota_teste', codigo: null, motivo: 'nota de teste autorizada em homologação' }, { ...base, ...comChave, protocolo: r.protocolo })
  }
  if (r.kind === 'denegada') return reprovar('nota_teste', `SEFAZ_${r.cStat}`, r.motivo, comChave)
  if (CSTAT_TRANSITORIO.has(r.cStat)) return falhar('nota_teste', `${r.cStat} ${r.motivo}`, comChave)
  if (r.cStat === '203') return reprovar('nota_teste', 'NFE_NAO_CREDENCIADA', '', comChave)
  if (r.cStat === '230' || r.cStat === '231') return reprovar('nota_teste', 'NFE_IE_INVALIDA', r.motivo, comChave)
  if (r.cStat === '213') return reprovar('nota_teste', 'CERT_DE_OUTRO_CNPJ', '', comChave)
  return reprovar('nota_teste', `SEFAZ_${r.cStat}`, `${r.cStat} ${r.motivo}`, comChave)
}

/** O que o painel mostra da conferência da empresa (`null` = nunca conferida). */
export async function conferenciaDaEmpresa(db: Db, tenantId: string) {
  const { rows } = await db.query<{ status: string; etapa: string | null; codigo: string | null; motivo: string | null; conferida_em: Date | null; cadastro_cred_nfe: string | null }>(
    'select status, etapa, codigo, motivo, conferida_em, cadastro_cred_nfe from nofiscal.fiscal_nfe_conferencias where tenant_id = $1',
    [tenantId],
  )
  return rows[0] ?? null
}
