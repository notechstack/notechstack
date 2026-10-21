// POST /api/v1/onboarding/clientes: base de clientes no onboarding (critérios 19 a 23; forma no
// Landing de .checks/agente-fiscal-v2.md, lote D - rota `onboarding/clientes`). Três ações:
// - `buscar_adn`: notas do tenant no ADN, com o A1 dele, viram candidatos (um por tomador);
// - `ler_pdf`: um PDF de nota lido pela IA vira um candidato (até 30 PDFs por tenant);
// - `salvar`: os candidatos que a pessoa manteve viram modelos (`origem` de importação).
// Banco só pelo `nofiscal_service`; dono conferido dentro de `nofiscal`, como na rota de ativação.
// O PDF existe só em memória nesta requisição: nunca vai a disco, banco, storage ou log (22).
import { candidatosDoAdn } from './adn-candidatos.js'
import { nfseDoEmitente, type DistribuicaoAdn } from './adn.js'
import type { Db, Queryable } from './db.js'
import { json } from './http.js'
import { modeloParaGravar, type MotivoIgnorado } from './ia/candidato.js'
import { pareceCabecalhoPdf, type LeitorPdf } from './ia/leitor-pdf.js'
import { logEvent } from './log.js'
import type { Ambiente } from './sefin.js'
import type { SessionVerifier } from './session.js'

export type OnboardingClientesDeps = {
  /** Conexão como `nofiscal_service`. */
  db: Db
  sessions: SessionVerifier
  adn: DistribuicaoAdn
  /** `null` sem IA configurada (`ANTHROPIC_API_KEY`). */
  leitor: LeitorPdf | null
}

export const LIMITE_PDFS = 30
export const MAX_PDF_BYTES = 5 * 1024 * 1024
export const MAX_MODELOS_POR_SALVAR = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Codigo =
  | 'UNAUTHORIZED'
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
  | 'METHOD_NOT_ALLOWED'
  | 'ADN_INDISPONIVEL'
  | 'IA_INDISPONIVEL'
  | 'LIMITE_PDFS'
  | 'PDF_ILEGIVEL'
  | 'INTERNAL'

const ERROS: Record<Codigo, { status: number; message: string }> = {
  UNAUTHORIZED: { status: 401, message: 'faça login para continuar' },
  VALIDATION_FAILED: { status: 422, message: 'requisição inválida' },
  FORBIDDEN: { status: 403, message: 'você não é dono desta empresa' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'use POST' },
  ADN_INDISPONIVEL: { status: 503, message: 'não foi possível buscar suas notas no Ambiente de Dados Nacional; envie os PDFs das notas' },
  IA_INDISPONIVEL: { status: 503, message: 'a leitura de PDFs está indisponível agora; tente de novo em alguns minutos' },
  LIMITE_PDFS: { status: 429, message: `você já enviou ${LIMITE_PDFS} PDFs` },
  PDF_ILEGIVEL: { status: 422, message: 'este arquivo não é o PDF de uma nota fiscal de serviço (DANFSe)' },
  INTERNAL: { status: 500, message: 'erro interno' },
}

function erro(code: Codigo, message = ERROS[code].message): Response {
  return json(ERROS[code].status, { error: { code, message } })
}

type Pedido =
  | { acao: 'buscar_adn'; tenantId: string }
  | { acao: 'ler_pdf'; tenantId: string; pdf: Uint8Array }
  | { acao: 'salvar'; tenantId: string; modelos: unknown[] }

type Tenant = { id: string; cnpj: string; ambiente: Ambiente }

export async function handleOnboardingClientes(request: Request, deps: OnboardingClientesDeps): Promise<Response> {
  try {
    if (request.method !== 'POST') return erro('METHOD_NOT_ALLOWED')
    const userId = await deps.sessions.userIdFrom(request)
    if (!userId) return erro('UNAUTHORIZED')

    const pedido = await lerPedido(request)
    if (typeof pedido === 'string') return erro('VALIDATION_FAILED', pedido)

    const tenant = await tenantDoDono(deps.db, userId, pedido.tenantId)
    if (!tenant) {
      logEvent('nofiscal.onboarding_clientes', { acao: pedido.acao, tenant_id: pedido.tenantId, result: 'FORBIDDEN' })
      return erro('FORBIDDEN')
    }
    if (pedido.acao === 'buscar_adn') return await buscarAdn(deps, tenant)
    if (pedido.acao === 'ler_pdf') return await lerPdf(deps, tenant, pedido.pdf)
    return await salvar(deps.db, tenant, pedido.modelos)
  } catch (error) {
    // Só o nome do erro: a mensagem de um driver ou do SDK pode ecoar parâmetros.
    logEvent('nofiscal.onboarding_clientes_error', { error_name: error instanceof Error ? error.name : 'unknown' })
    return erro('INTERNAL')
  }
}

async function lerPedido(request: Request): Promise<Pedido | string> {
  const tipo = request.headers.get('content-type') ?? ''
  if (/^multipart\/form-data/i.test(tipo)) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return 'envie multipart/form-data com tenant_id, acao e arquivo'
    }
    const acao = form.get('acao')
    const tenantId = form.get('tenant_id')
    if (acao !== 'ler_pdf') return 'em multipart, só a ação ler_pdf'
    if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return 'tenant_id inválido'
    const arquivo = form.get('arquivo')
    if (!(arquivo instanceof Blob) || arquivo.size === 0) return 'arquivo ausente'
    if (arquivo.size > MAX_PDF_BYTES) return 'arquivo maior que 5 MB'
    return { acao, tenantId, pdf: new Uint8Array(await arquivo.arrayBuffer()) }
  }

  let corpo: unknown
  try {
    corpo = await request.json()
  } catch {
    return 'envie JSON com tenant_id e acao'
  }
  const obj = typeof corpo === 'object' && corpo !== null && !Array.isArray(corpo) ? (corpo as Record<string, unknown>) : {}
  const tenantId = obj.tenant_id
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) return 'tenant_id inválido'
  if (obj.acao === 'buscar_adn') return { acao: 'buscar_adn', tenantId }
  if (obj.acao === 'salvar') {
    const modelos = obj.modelos
    if (!Array.isArray(modelos) || modelos.length === 0 || modelos.length > MAX_MODELOS_POR_SALVAR) {
      return `modelos deve ser uma lista de 1 a ${MAX_MODELOS_POR_SALVAR} candidatos`
    }
    return { acao: 'salvar', tenantId, modelos }
  }
  if (obj.acao === 'ler_pdf') return 'ler_pdf vai em multipart/form-data com o campo arquivo'
  return 'acao deve ser buscar_adn, ler_pdf ou salvar'
}

async function tenantDoDono(db: Queryable, userId: string, tenantId: string): Promise<Tenant | null> {
  const { rows } = await db.query<Tenant>(
    `select t.id, t.cnpj, t.ambiente
       from nofiscal.fiscal_tenants t
       join nofiscal.fiscal_accounts a on a.client_id = t.client_id
      where t.id = $1 and a.user_id = $2 and a.email_verified_at is not null`,
    [tenantId, userId],
  )
  return rows[0] ?? null
}

async function buscarAdn(deps: OnboardingClientesDeps, tenant: Tenant): Promise<Response> {
  const { rows } = await deps.db.query<{ pfx_base64: string; password: string }>(
    'select pfx_base64, password from nofiscal.read_certificate($1)',
    [tenant.id],
  )
  const cert = rows[0]
  if (!cert) {
    logEvent('nofiscal.onboarding_clientes', { acao: 'buscar_adn', tenant_id: tenant.id, result: 'SEM_CERTIFICADO' })
    return erro('ADN_INDISPONIVEL')
  }
  const baixa = await deps.adn.baixarNfse({
    cnpj: tenant.cnpj,
    ambiente: tenant.ambiente,
    certificado: { pfxBase64: cert.pfx_base64, password: cert.password },
  })
  if (baixa.kind === 'indisponivel') {
    logEvent('nofiscal.onboarding_clientes', { acao: 'buscar_adn', tenant_id: tenant.id, result: 'ADN_INDISPONIVEL', motivo: baixa.motivo })
    return erro('ADN_INDISPONIVEL')
  }
  const candidatos = candidatosDoAdn(nfseDoEmitente(baixa.xmls, tenant.cnpj))
  logEvent('nofiscal.onboarding_clientes', { acao: 'buscar_adn', tenant_id: tenant.id, result: 'OK', notas: baixa.xmls.length, candidatos: candidatos.length })
  return json(200, { candidatos })
}

async function lerPdf(deps: OnboardingClientesDeps, tenant: Tenant, pdf: Uint8Array): Promise<Response> {
  const registrar = (result: string, extra: Record<string, number> = {}) =>
    logEvent('nofiscal.onboarding_clientes', { acao: 'ler_pdf', tenant_id: tenant.id, result, ...extra })
  if (!deps.leitor) {
    registrar('IA_NAO_CONFIGURADA')
    return erro('IA_INDISPONIVEL')
  }
  // A vaga é reservada antes de qualquer leitura: o 31º PDF não chega à IA (critério 23).
  const reserva = await deps.db.query<{ enviados: number }>(
    `insert into nofiscal.fiscal_importacao_pdfs as p (tenant_id, enviados) values ($1, 1)
     on conflict (tenant_id) do update set enviados = p.enviados + 1, atualizado_em = now()
      where p.enviados < $2
     returning p.enviados`,
    [tenant.id, LIMITE_PDFS],
  )
  if (reserva.rowCount === 0) {
    registrar('LIMITE_PDFS')
    return erro('LIMITE_PDFS')
  }
  if (!pareceCabecalhoPdf(pdf)) {
    registrar('PDF_ILEGIVEL')
    return erro('PDF_ILEGIVEL')
  }
  let leitura
  try {
    leitura = await deps.leitor.ler(pdf)
  } catch (error) {
    // Falha da IA não é culpa da pessoa: a vaga volta.
    await deps.db.query(
      `update nofiscal.fiscal_importacao_pdfs set enviados = enviados - 1, atualizado_em = now()
        where tenant_id = $1 and enviados > 0`,
      [tenant.id],
    )
    logEvent('nofiscal.onboarding_clientes', {
      acao: 'ler_pdf',
      tenant_id: tenant.id,
      result: 'IA_INDISPONIVEL',
      error_name: error instanceof Error ? error.name : 'unknown',
    })
    return erro('IA_INDISPONIVEL')
  }
  const tokens = { tokens_entrada: leitura.tokens.entrada, tokens_saida: leitura.tokens.saida }
  if (!leitura.danfse) {
    registrar('PDF_ILEGIVEL', tokens)
    return erro('PDF_ILEGIVEL')
  }
  registrar('OK', tokens)
  return json(200, { candidato: leitura.candidato })
}

async function salvar(db: Db, tenant: Tenant, modelos: unknown[]): Promise<Response> {
  const ignorados: { nome: string | null; motivo: MotivoIgnorado }[] = []
  let salvos = 0
  await db.transaction(async (tx) => {
    for (const bruto of modelos) {
      const conferido = modeloParaGravar(bruto)
      if (!conferido.ok) {
        ignorados.push({ nome: conferido.nome, motivo: conferido.motivo })
        continue
      }
      const m = conferido.modelo
      // O índice único (tenant_id, lower(nome)) decide o nome repetido, no tenant e no próprio lote.
      const { rowCount } = await tx.query(
        `insert into nofiscal.fiscal_models
           (tenant_id, nome, tomador_documento, tomador_nome, tomador_email, tomador_endereco,
            codigo_servico_nacional, descricao, valor_padrao, origem, created_from_invoice_id)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, null)
         on conflict do nothing`,
        [
          tenant.id,
          m.nome,
          m.tomador_documento,
          m.tomador_nome,
          m.tomador_email,
          m.tomador_endereco ? JSON.stringify(m.tomador_endereco) : null,
          m.codigo_servico_nacional,
          m.descricao,
          m.valor_padrao,
          m.origem,
        ],
      )
      if (rowCount === 0) ignorados.push({ nome: m.nome, motivo: 'nome_repetido' })
      else salvos++
    }
  })
  logEvent('nofiscal.onboarding_clientes', { acao: 'salvar', tenant_id: tenant.id, result: 'OK', salvos, ignorados: ignorados.length })
  return json(201, { salvos, ignorados })
}
