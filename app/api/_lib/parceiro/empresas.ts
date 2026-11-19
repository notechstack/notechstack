// Empresas da conta pela API (parceiro com sistema próprio): cadastrar a empresa cliente, ler a situação dela (pronta,
// falta A1, procuração pendente…) e mudar dados fiscais e retenção, sem depender do painel. As regras são as do painel:
// os dados do CNPJ vêm da Receita (mesma consulta do cadastro), o limite de empresas e a procuração passam pelas
// mesmas funções do banco (migração 20261119090000) e a situação é o mesmo `emission_block` do motor.
// O A1 não entra pela API: certificado e senha só pelo painel (Minha conta → Minhas empresas). Com procuração, a
// empresa não precisa de A1: quem assina é o A1 do escritório. A nó nunca assina nota de cliente.
import type { Queryable } from '../db.js'
import { errorResponse, json } from '../http.js'
import { logEvent } from '../log.js'
import { motivoDoProblema } from '../agente/lote.js'
import { lerRetencaoDaEmpresa } from '../painel-emissao.js'
import { gerarChave } from './chave.js'
import { avaliarRegime, cnpjValido, consultarCnpj, lerRegimeNormal, type Consulta, type RegimeNormal } from './receita.js'

/** `regimeDeclarado`: Presumido ou Real, que a Receita não distingue (só vale se a base disser "fora do Simples"). */
export type ConsultaReceita = (cnpj: string, regimeDeclarado?: RegimeNormal | null) => Promise<Consulta>

/** Consulta real: BrasilAPI (`CNPJ_API_URL` opcional), CNPJ.ws de reserva e o regime confirmado à mão no banco. */
export function consultaReceitaFromEnv(db: Queryable, env: NodeJS.ProcessEnv = process.env): ConsultaReceita {
  return (cnpj, regimeDeclarado = null) =>
    consultarCnpj(cnpj, {
      apiUrl: env.CNPJ_API_URL,
      regimeDeclarado,
      regimeConfirmado: async (c) => {
        const { rows } = await db.query<{ r: string | null }>('select public.fiscal_regime_confirmado($1) as r', [c])
        const r = rows[0]?.r
        return r === 'mei' || r === 'simples' ? r : null
      },
    })
}

/** Situação para o sistema do parceiro, a partir do código do `emission_block` (null = emite). */
export function situacaoDoBloqueio(codigo: string | null): string {
  if (!codigo) return 'pronta'
  switch (codigo) {
    case 'CERT_MISSING':
      return 'falta_a1'
    case 'CERT_EXPIRED':
      return 'a1_vencido'
    case 'PROCURACAO_MISSING':
    case 'PROCURACAO_INVALIDA':
    case 'PROCURACAO_NAO_ENCONTRADA':
      return 'procuracao_pendente'
    case 'PROCURACAO_VENCIDA':
      return 'procuracao_vencida'
    case 'PROCURADOR_CERT_INVALIDO':
      return 'a1_do_escritorio_invalido'
    case 'FISCAL_CONFIG_MISSING':
      return 'falta_dados_fiscais'
    case 'TENANT_INACTIVE':
      return 'desativada'
    case 'NO_SUBSCRIPTION':
    case 'SUBSCRIPTION_CANCELLED':
    case 'PAYMENT_NOT_APPROVED':
      return 'assinatura_inativa'
    default:
      return 'bloqueada'
  }
}

type LinhaEmpresa = {
  id: string
  cnpj: string
  razao_social: string
  regime: string
  ambiente: string
  active: boolean
  principal: boolean
  modo_autenticacao: string
  codigo_servico_nacional: string | null
  p_tot_trib_sn: string | null
  p_tot_trib_fed: string | null
  p_tot_trib_est: string | null
  p_tot_trib_mun: string | null
  retem_iss: boolean
  aliquota_iss: string | null
  retem_inss: boolean
  inss_percentual: string | null
  cert_not_after: Date | null
  proc_status: string | null
  proc_valida_ate: string | null
  proc_conferida_em: Date | null
  proc_ultimo_erro: string | null
  bloqueio: string | null
  bloqueio_nfe: string | null
}

const SELECT_EMPRESA = `
  select t.id, t.cnpj, t.razao_social, t.regime, t.ambiente, t.active, t.id = $1 as principal, t.modo_autenticacao,
         t.codigo_servico_nacional, t.p_tot_trib_sn::text as p_tot_trib_sn,
         t.p_tot_trib_fed::text as p_tot_trib_fed, t.p_tot_trib_est::text as p_tot_trib_est, t.p_tot_trib_mun::text as p_tot_trib_mun,
         coalesce(t.retem_iss, false) as retem_iss, t.aliquota_iss::text as aliquota_iss,
         coalesce(t.retem_inss, false) as retem_inss, t.inss_percentual::text as inss_percentual,
         c.not_after as cert_not_after,
         p.status as proc_status, p.valida_ate::text as proc_valida_ate, p.conferida_em as proc_conferida_em,
         p.ultimo_erro as proc_ultimo_erro,
         nofiscal.emission_block(t.id) as bloqueio,
         nofiscal.nfe_emission_block(t.id) as bloqueio_nfe
    from nofiscal.fiscal_tenants t
    left join nofiscal.fiscal_certificates c on c.tenant_id = t.id
    left join nofiscal.fiscal_procuracoes p on p.tenant_id = t.id
   where (t.id = $1 or t.escritorio_tenant_id = $1)`

export type VisaoEmpresa = ReturnType<typeof visaoDaEmpresa>

function visaoDaEmpresa(e: LinhaEmpresa, procurador: { cnpj: string; razao_social: string } | null) {
  return {
    cnpj: e.cnpj,
    razao_social: e.razao_social,
    regime: e.regime,
    ambiente: e.ambiente,
    ativa: e.active,
    principal: e.principal,
    situacao: situacaoDoBloqueio(e.bloqueio),
    bloqueio: e.bloqueio ? { codigo: e.bloqueio, motivo: motivoDoProblema(e.bloqueio, { empresa: e.razao_social }) } : null,
    autenticacao: e.modo_autenticacao,
    certificado: e.cert_not_after ? { vence_em: e.cert_not_after.toISOString() } : null,
    procuracao: e.proc_status
      ? {
          status: e.proc_status,
          valida_ate: e.proc_valida_ate,
          conferida_em: e.proc_conferida_em ? e.proc_conferida_em.toISOString() : null,
          ultimo_erro: e.proc_ultimo_erro,
        }
      : null,
    // A quem a empresa dá a procuração (Portal de Serviços da Receita, serviço NFS-e): sempre o escritório.
    procurador: e.principal ? null : procurador,
    dados_fiscais: {
      codigo_servico_nacional: e.codigo_servico_nacional,
      simples_percentual: e.p_tot_trib_sn,
      // Presumido e Real: percentuais da Lei 12.741/2012 (DPS totTrib/pTotTrib).
      tributos_aproximados:
        e.p_tot_trib_fed === null ? null : { federal: e.p_tot_trib_fed, estadual: e.p_tot_trib_est, municipal: e.p_tot_trib_mun },
    },
    retencao: { retem_iss: e.retem_iss, aliquota_iss: e.aliquota_iss, retem_inss: e.retem_inss, inss_percentual: e.inss_percentual },
    nfe: { bloqueio: e.bloqueio_nfe },
  }
}

async function procuradorDe(db: Queryable, donoId: string) {
  const { rows } = await db.query<{ cnpj: string; razao_social: string }>('select cnpj, razao_social from nofiscal.fiscal_tenants where id = $1', [donoId])
  return rows[0] ?? null
}

export async function listarEmpresas(db: Queryable, donoId: string) {
  const { rows } = await db.query<LinhaEmpresa>(`${SELECT_EMPRESA} order by t.id = $1 desc, t.razao_social`, [donoId])
  const procurador = await procuradorDe(db, donoId)
  return rows.map((r) => visaoDaEmpresa(r, procurador))
}

export async function empresaPorCnpj(db: Queryable, donoId: string, cnpj: string) {
  const { rows } = await db.query<LinhaEmpresa>(`${SELECT_EMPRESA} and t.cnpj = $2`, [donoId, cnpj])
  return rows[0] ? visaoDaEmpresa(rows[0], await procuradorDe(db, donoId)) : null
}

/** Id da empresa da conta pelo CNPJ (qualquer situação). */
export async function idDaEmpresa(db: Queryable, donoId: string, cnpj: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    'select id from nofiscal.fiscal_tenants where cnpj = $2 and (id = $1 or escritorio_tenant_id = $1)',
    [donoId, cnpj],
  )
  return rows[0]?.id ?? null
}

// ---------------------------------------------------------------------------------------
// Leitura do corpo (pura).

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const soDigitos = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '')
const PCT = /^\d{1,3}(\.\d{1,2})?$/

export type DadosDaEmpresa = {
  codigo_servico_nacional?: string
  simples_percentual?: string
  /** Presumido e Real (POST): o regime que a Receita não distingue. */
  regime?: RegimeNormal
  /** Presumido e Real: pTotTrib federal, estadual (padrão 0) e municipal. */
  tributos_aproximados?: { fed: string; est: string; mun: string }
  retencao?: Obj
  procuracao?: { valida_ate: string | null }
}

type Leitura<T> = { ok: true; valor: T } | { ok: false; codigo: 'VALIDATION_FAILED' | 'UNKNOWN_FIELD'; mensagem: string; campo?: string }

/** Campos comuns de POST e PATCH. `exigirCodigo`: no POST, o código de serviço é obrigatório. */
export function lerDadosDaEmpresa(corpo: Obj, permitidos: string[]): Leitura<DadosDaEmpresa> {
  const extra = Object.keys(corpo).find((k) => !permitidos.includes(k))
  if (extra) return { ok: false, codigo: 'UNKNOWN_FIELD', mensagem: `campo não aceito: ${extra}` }
  const d: DadosDaEmpresa = {}
  if (corpo.codigo_servico_nacional !== undefined) {
    const codigo = soDigitos(corpo.codigo_servico_nacional)
    if (!/^\d{6}$/.test(codigo)) return { ok: false, codigo: 'VALIDATION_FAILED', mensagem: 'codigo_servico_nacional deve ter 6 dígitos (lista nacional)', campo: 'codigo_servico_nacional' }
    d.codigo_servico_nacional = codigo
  }
  if (corpo.simples_percentual !== undefined && corpo.simples_percentual !== null) {
    const pct = typeof corpo.simples_percentual === 'number' ? String(corpo.simples_percentual) : typeof corpo.simples_percentual === 'string' ? corpo.simples_percentual.trim().replace(',', '.') : ''
    if (!PCT.test(pct) || Number(pct) > 100) {
      return { ok: false, codigo: 'VALIDATION_FAILED', mensagem: 'simples_percentual deve ser de 0 a 100, com até 2 casas (ex.: "6.00")', campo: 'simples_percentual' }
    }
    d.simples_percentual = pct
  }
  if (corpo.regime !== undefined && corpo.regime !== null) {
    const regime = lerRegimeNormal(corpo.regime)
    if (!regime) return { ok: false, codigo: 'VALIDATION_FAILED', mensagem: 'regime deve ser "presumido" ou "real" (MEI e Simples vêm da Receita)', campo: 'regime' }
    d.regime = regime
  }
  if (corpo.tributos_aproximados !== undefined && corpo.tributos_aproximados !== null) {
    const t = corpo.tributos_aproximados
    if (!isObj(t)) return { ok: false, codigo: 'VALIDATION_FAILED', mensagem: 'tributos_aproximados deve ser um objeto', campo: 'tributos_aproximados' }
    const extraT = Object.keys(t).find((k) => !['federal', 'estadual', 'municipal'].includes(k))
    if (extraT) return { ok: false, codigo: 'UNKNOWN_FIELD', mensagem: `campo não aceito: tributos_aproximados.${extraT}` }
    const ler = (v: unknown) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().replace(',', '.') : '')
    const fed = ler(t.federal)
    const est = t.estadual === undefined || t.estadual === null || t.estadual === '' ? '0' : ler(t.estadual)
    const mun = ler(t.municipal)
    for (const [campo, v] of [['federal', fed], ['estadual', est], ['municipal', mun]] as const) {
      if (!PCT.test(v) || Number(v) > 100) {
        return { ok: false, codigo: 'VALIDATION_FAILED', mensagem: `tributos_aproximados.${campo} deve ser de 0 a 100, com até 2 casas`, campo: `tributos_aproximados.${campo}` }
      }
    }
    d.tributos_aproximados = { fed, est, mun }
  }
  if (corpo.retencao !== undefined) {
    if (!isObj(corpo.retencao)) return { ok: false, codigo: 'VALIDATION_FAILED', mensagem: 'retencao deve ser um objeto', campo: 'retencao' }
    const extraRet = Object.keys(corpo.retencao).find((k) => !['retem_iss', 'aliquota_iss', 'retem_inss', 'inss_percentual'].includes(k))
    if (extraRet) return { ok: false, codigo: 'UNKNOWN_FIELD', mensagem: `campo não aceito: retencao.${extraRet}` }
    d.retencao = corpo.retencao
  }
  if (corpo.procuracao !== undefined) {
    if (!isObj(corpo.procuracao)) return { ok: false, codigo: 'VALIDATION_FAILED', mensagem: 'procuracao deve ser um objeto', campo: 'procuracao' }
    const extraProc = Object.keys(corpo.procuracao).find((k) => k !== 'valida_ate')
    if (extraProc) return { ok: false, codigo: 'UNKNOWN_FIELD', mensagem: `campo não aceito: procuracao.${extraProc}` }
    const v = corpo.procuracao.valida_ate
    if (v !== undefined && v !== null && !(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)))) {
      return { ok: false, codigo: 'VALIDATION_FAILED', mensagem: 'procuracao.valida_ate deve ser uma data AAAA-MM-DD ou null', campo: 'procuracao.valida_ate' }
    }
    d.procuracao = { valida_ate: typeof v === 'string' ? v : null }
  }
  return { ok: true, valor: d }
}

// ---------------------------------------------------------------------------------------
// Rotas.

export type EmpresasCtx = { db: Queryable; donoId: string; agora: Date; receita: ConsultaReceita }

const PROCURACAO_MOTIVO: Record<string, string> = {
  RATE_LIMITED: 'muitas tentativas nesta empresa; tente de novo em uma hora',
  VALIDADE_PASSADA: 'procuracao.valida_ate já passou',
  ESCRITORIO_SEM_CERTIFICADO: 'o escritório precisa ter o próprio A1 cadastrado no painel para assinar por procuração',
  PROCURADOR_CERT_VENCIDO: 'o A1 do escritório venceu; envie o novo no painel',
  PROCURACAO_SO_NO_ESCRITORIO: 'procuração só vale para empresa cliente do escritório (não para a conta-mãe)',
  FORBIDDEN: 'empresa não é desta conta',
}

/** Retenção padrão e procuração depois do cadastro ou no PATCH. Devolve um erro (Response) ou null. */
async function aplicarExtras(ctx: EmpresasCtx, tenantId: string, regime: string, d: DadosDaEmpresa): Promise<Response | null> {
  if (d.retencao) {
    const lido = lerRetencaoDaEmpresa(d.retencao, regime)
    if (!lido.ok) return errorResponse('VALIDATION_FAILED', lido.mensagem, { campo: `retencao.${lido.campo === 'retencao' ? 'retem_iss' : lido.campo}` })
    const v = lido.valores
    await ctx.db.query(
      `update nofiscal.fiscal_tenants set retem_iss = $2, aliquota_iss = $3, retem_inss = $4, inss_percentual = $5, updated_at = $6 where id = $1`,
      [tenantId, v.retem_iss, v.aliquota_iss, v.retem_inss, v.inss_percentual, ctx.agora],
    )
  }
  if (d.procuracao) {
    const { rows } = await ctx.db.query<{ r: string }>('select nofiscal.api_empresa_procuracao($1, $2, $3::date) as r', [
      ctx.donoId,
      tenantId,
      d.procuracao.valida_ate,
    ])
    const r = rows[0]?.r ?? 'FORBIDDEN'
    if (r !== 'OK') {
      return errorResponse('PROCURACAO_RECUSADA', PROCURACAO_MOTIVO[r] ?? `procuração recusada (${r})`, { motivo: r })
    }
  }
  return null
}

/** Confere a retenção antes de gravar qualquer coisa (o regime vem da Receita no POST). */
function retencaoValida(d: DadosDaEmpresa, regime: string): Response | null {
  if (!d.retencao) return null
  const lido = lerRetencaoDaEmpresa(d.retencao, regime)
  return lido.ok ? null : errorResponse('VALIDATION_FAILED', lido.mensagem, { campo: `retencao.${lido.campo === 'retencao' ? 'retem_iss' : lido.campo}` })
}

const CAMPOS_POST = ['cnpj', 'regime', 'codigo_servico_nacional', 'simples_percentual', 'tributos_aproximados', 'retencao', 'procuracao']
const CAMPOS_PATCH = ['codigo_servico_nacional', 'simples_percentual', 'tributos_aproximados', 'retencao', 'procuracao']

const naoOptante = (regime: string) => regime === 'presumido' || regime === 'real'

/** O jsonb de `fiscal_empresa_configurar` para o regime: pTotTribSN do Simples ou pTotTrib do Presumido/Real. */
function configuracaoDoRegime(regime: string, codigo: string, pct: string | null, tot: { fed: string; est: string; mun: string } | null) {
  return naoOptante(regime) ? { codigo_servico_nacional: codigo, p_tot_trib: tot } : { codigo_servico_nacional: codigo, p_tot_trib_sn: pct }
}

export async function criarEmpresa(ctx: EmpresasCtx, corpo: unknown): Promise<Response> {
  if (!isObj(corpo)) return errorResponse('VALIDATION_FAILED', 'o corpo deve ser um objeto JSON')
  const cnpj = soDigitos(corpo.cnpj)
  if (!cnpjValido(cnpj)) return errorResponse('VALIDATION_FAILED', 'cnpj inválido (14 dígitos com dígito verificador)', { campo: 'cnpj' })
  const lido = lerDadosDaEmpresa(corpo, CAMPOS_POST)
  if (!lido.ok) return errorResponse(lido.codigo, lido.mensagem, lido.campo ? { campo: lido.campo } : {})
  const d = lido.valor
  if (!d.codigo_servico_nacional) return errorResponse('VALIDATION_FAILED', 'codigo_servico_nacional é obrigatório', { campo: 'codigo_servico_nacional' })

  // Já é desta conta: devolve como está (o POST pode ser repetido sem efeito). Para mudar, PATCH.
  const existente = await empresaPorCnpj(ctx.db, ctx.donoId, cnpj)
  if (existente && existente.ativa) return json(200, { criada: false, empresa: existente })

  const consulta = await ctx.receita(cnpj, d.regime ?? null)
  // Fora do Simples (19/11/2026): Presumido/Real só em cidade de emissor nacional pleno; lá, pede o `regime`.
  const avaliacao = avaliarRegime(consulta)
  if (avaliacao?.codigo === 'REGIME_A_DECLARAR') {
    return errorResponse('REGIME_A_DECLARAR', 'CNPJ fora do Simples em cidade que emite Presumido e Real pelo Emissor Nacional: informe regime "presumido" ou "real"', { campo: 'regime' })
  }
  if (avaliacao) return errorResponse('FORA_DO_SIMPLES', avaliacao.mensagem, { campo: 'cnpj', lista_espera: 'lista_espera' in avaliacao })
  if (!consulta.ok) {
    if (consulta.motivo === 'indisponivel') return errorResponse('RECEITA_INDISPONIVEL', 'não conseguimos confirmar o CNPJ na Receita agora; tente de novo em alguns minutos')
    if (consulta.motivo === 'nao_encontrado') return errorResponse('CNPJ_NAO_ENCONTRADO', 'CNPJ não encontrado na Receita Federal', { campo: 'cnpj' })
    if (consulta.motivo === 'inativo') return errorResponse('CNPJ_INATIVO', `o CNPJ está ${consulta.situacao.toLowerCase()} na Receita; só empresa ativa emite`, { campo: 'cnpj' })
    return errorResponse('FORA_DO_SIMPLES', 'o nó.fiscal atende MEI e Simples Nacional; na Receita, este CNPJ não está no Simples', { campo: 'cnpj' })
  }
  const dados = consulta.dados
  if (naoOptante(dados.regime)) {
    if (!d.tributos_aproximados) {
      return errorResponse('VALIDATION_FAILED', 'tributos_aproximados (federal e municipal, Lei 12.741) é obrigatório para Lucro Presumido ou Real', { campo: 'tributos_aproximados' })
    }
  } else if (dados.regime !== 'mei' && d.simples_percentual === undefined) {
    return errorResponse('VALIDATION_FAILED', 'simples_percentual é obrigatório para empresa do Simples (ME/EPP)', { campo: 'simples_percentual' })
  }
  const retencaoRuim = retencaoValida(d, dados.regime)
  if (retencaoRuim) return retencaoRuim

  const { rows } = await ctx.db.query<{ r: { ok: boolean; erro?: string; limite?: number; tenant_id?: string; reativada?: boolean; configuracao?: { ok: boolean; erro?: string; campo?: string } } }>(
    'select nofiscal.api_empresa_adicionar($1, $2, $3, $4, $5, $6, $7, $8::jsonb) as r',
    [
      ctx.donoId,
      cnpj,
      dados.razao_social,
      dados.codigo_municipio_ibge,
      dados.cnae,
      dados.regime,
      gerarChave().hash,
      JSON.stringify(configuracaoDoRegime(dados.regime, d.codigo_servico_nacional, d.simples_percentual ?? null, d.tributos_aproximados ?? null)),
    ],
  )
  const r = rows[0]?.r
  if (!r?.ok) {
    if (r?.erro === 'EMPRESAS_ACIMA_DO_LIMITE') return errorResponse('EMPRESAS_ACIMA_DO_LIMITE', `o plano da conta permite até ${r.limite} empresas ativas`, { limite: r.limite })
    if (r?.erro === 'CNPJ_JA_CADASTRADO') return errorResponse('CNPJ_JA_CADASTRADO', 'este CNPJ já está cadastrado no nó.fiscal por outra conta')
    if (r?.erro === 'PLANO_SEM_EMPRESAS') return errorResponse('SO_ESCRITORIO', 'cadastrar empresas é do plano Escritório')
    return errorResponse('INTERNAL', 'erro interno')
  }
  const tenantId = r.tenant_id as string
  if (r.configuracao && !r.configuracao.ok) {
    logEvent('nofiscal.api_empresa_config_recusada', { tenant_id: tenantId, campo: r.configuracao.campo ?? null })
  }
  const extras = await aplicarExtras(ctx, tenantId, dados.regime, d)
  logEvent('nofiscal.api_empresa_criada', { dono_tenant_id: ctx.donoId, tenant_id: tenantId, reativada: Boolean(r.reativada) })
  const empresa = await empresaPorCnpj(ctx.db, ctx.donoId, cnpj)
  if (extras) {
    // A empresa foi criada; só a parte extra falhou. O corpo diz as duas coisas.
    const erro = (await extras.json()) as Record<string, unknown>
    return json(201, { criada: true, empresa, aviso: erro.error })
  }
  return json(r.reativada ? 200 : 201, { criada: !r.reativada, reativada: Boolean(r.reativada), empresa })
}

export async function alterarEmpresa(ctx: EmpresasCtx, cnpj: string, corpo: unknown): Promise<Response> {
  if (!isObj(corpo)) return errorResponse('VALIDATION_FAILED', 'o corpo deve ser um objeto JSON')
  const atual = await empresaPorCnpj(ctx.db, ctx.donoId, cnpj)
  const tenantId = atual ? await idDaEmpresa(ctx.db, ctx.donoId, cnpj) : null
  if (!atual || !tenantId) return errorResponse('EMPRESA_NAO_ENCONTRADA', 'empresa não encontrada nesta conta')
  const lido = lerDadosDaEmpresa(corpo, CAMPOS_PATCH)
  if (!lido.ok) return errorResponse(lido.codigo, lido.mensagem, lido.campo ? { campo: lido.campo } : {})
  const d = lido.valor
  const retencaoRuim = retencaoValida(d, atual.regime)
  if (retencaoRuim) return retencaoRuim

  if (d.codigo_servico_nacional !== undefined || d.simples_percentual !== undefined || d.tributos_aproximados !== undefined) {
    const codigo = d.codigo_servico_nacional ?? atual.dados_fiscais.codigo_servico_nacional
    const pct = d.simples_percentual ?? atual.dados_fiscais.simples_percentual
    const ta = atual.dados_fiscais.tributos_aproximados
    const tot = d.tributos_aproximados ?? (ta ? { fed: ta.federal as string, est: (ta.estadual ?? '0') as string, mun: ta.municipal as string } : null)
    if (!codigo) return errorResponse('VALIDATION_FAILED', 'codigo_servico_nacional é obrigatório', { campo: 'codigo_servico_nacional' })
    if (naoOptante(atual.regime)) {
      if (!tot) return errorResponse('VALIDATION_FAILED', 'tributos_aproximados é obrigatório para Lucro Presumido ou Real', { campo: 'tributos_aproximados' })
    } else if (atual.regime !== 'mei' && !pct) {
      return errorResponse('VALIDATION_FAILED', 'simples_percentual é obrigatório para empresa do Simples', { campo: 'simples_percentual' })
    }
    const { rows } = await ctx.db.query<{ r: { ok: boolean; erro?: string; campo?: string } }>(
      'select nofiscal.api_empresa_configurar($1, $2, $3::jsonb) as r',
      [ctx.donoId, tenantId, JSON.stringify(configuracaoDoRegime(atual.regime, codigo, pct, tot))],
    )
    const r = rows[0]?.r
    if (!r?.ok) {
      const campo =
        r?.campo === 'p_tot_trib_sn' ? 'simples_percentual' : r?.campo === 'p_tot_trib' ? 'tributos_aproximados' : (r?.campo ?? 'codigo_servico_nacional')
      return errorResponse('VALIDATION_FAILED', `${campo} recusado`, { campo })
    }
  }
  const extras = await aplicarExtras(ctx, tenantId, atual.regime, d)
  if (extras) return extras
  logEvent('nofiscal.api_empresa_alterada', { dono_tenant_id: ctx.donoId, tenant_id: tenantId })
  return json(200, { empresa: await empresaPorCnpj(ctx.db, ctx.donoId, cnpj) })
}
