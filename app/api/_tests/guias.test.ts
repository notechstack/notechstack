// Módulo Guias de ponta a ponta contra o banco local (critérios 4 a 8 e 12 a 18), com o código sob teste conectado
// como `nofiscal_service` (RLS e grants valem). Storage, WhatsApp e e-mail são dublês em memória: nada sai da máquina.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AnexoEmail, EnviaEmail, ExtrasDoModelo, MensagemEmail } from '../_lib/agente/canais.js'
import { processarMensagem, type ConversaDeps, type MensagemRecebida } from '../_lib/agente/conversa.js'
import { linksDoSite } from '../_lib/agente/links.js'
import { handleWhatsAppWebhook } from '../_lib/agente/webhook.js'
import { closeSharedDb, type Db } from '../_lib/db.js'
import { formatarLinha } from '../_lib/guias/codigos.js'
import { rodadaDeGuias, type CanalWhatsAppGuias, type GuiasWorkerDeps } from '../_lib/guias/envio.js'
import { handleLinkDaGuia } from '../_lib/guias/link.js'
import { MODELOS, RODAPE_SAIR, lerPayload, modeloParaMeta } from '../_lib/guias/modelos.js'
import { avisoDoUso, handlePainelGuias, type PainelGuiasDeps } from '../_lib/guias/painel.js'
import { tokenDaGuia } from '../_lib/guias/servico.js'
import type { ArmazemDeGuias } from '../_lib/guias/storage.js'
import { textoDoPdf } from '../_lib/guias/texto-pdf.js'
import {
  allowTestUserToAssume,
  createSelfServiceTenant,
  dropSelfServiceTenant,
  interpreteDouble,
  openRoleDb,
  randomPhone,
  type SelfServiceTenant,
} from './agente-fixtures.js'
import { openTestDb } from './fixtures.js'
import { cnpjDe, fmtCnpj, gerarGuiaPdf } from './guias-pdf.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const SEGREDO = randomBytes(24).toString('hex')
const tenants: SelfServiceTenant[] = []

// ------------------------------------------------------------------ Dublês

/** Storage em memória: a "URL de upload" só existe para o teste pôr o arquivo, como o PUT do navegador. */
function storageDouble() {
  const arquivos = new Map<string, Uint8Array>()
  const uploads: string[] = []
  const armazem: ArmazemDeGuias = {
    async urlDeUpload(caminho) {
      uploads.push(caminho)
      return `https://storage.teste/storage/v1/object/upload/sign/fiscal-guias/${caminho}?token=t`
    },
    async baixar(caminho) {
      const a = arquivos.get(caminho)
      if (!a) throw new Error('objeto não encontrado')
      return a
    },
    async urlDeDownload(caminho, segundos) {
      return `https://storage.teste/storage/v1/object/sign/fiscal-guias/${caminho}?token=d&expira=${segundos}`
    },
  }
  return { armazem, arquivos, uploads, subir: (url: string, pdf: Uint8Array) => arquivos.set(url.split('/fiscal-guias/')[1].split('?')[0], pdf) }
}

type Saida =
  | { tipo: 'modelo'; para: string; nome: string; parametros: string[]; extras?: ExtrasDoModelo }
  | { tipo: 'texto'; para: string; texto: string }
  | { tipo: 'documento'; para: string; anexo: AnexoEmail; legenda: string }

function whatsappDouble() {
  const saidas: Saida[] = []
  const midias: AnexoEmail[] = []
  const estado = { falhar: false }
  let n = 0
  const whatsapp: CanalWhatsAppGuias = {
    async subirMidia(anexo) {
      midias.push(anexo)
      return `midia-${++n}`
    },
    async enviarModelo(para, nome, parametros, extras) {
      if (estado.falhar) throw new Error('Cloud API fora')
      saidas.push({ tipo: 'modelo', para, nome, parametros, extras })
      return { wamid: `wamid.guia-${randomBytes(6).toString('hex')}` }
    },
    async enviarTexto(para, texto) {
      saidas.push({ tipo: 'texto', para, texto })
      return { wamid: `wamid.txt-${randomBytes(6).toString('hex')}` }
    },
    async enviarDocumento(para, anexo, legenda) {
      saidas.push({ tipo: 'documento', para, anexo, legenda })
      return { wamid: `wamid.doc-${randomBytes(6).toString('hex')}` }
    },
  }
  return { whatsapp, saidas, midias, estado }
}

function emailDouble() {
  const emails: MensagemEmail[] = []
  const email: EnviaEmail = {
    async enviar(m) {
      emails.push(m)
    },
  }
  return { email, emails }
}

const sessoes = { userIdFrom: async (r: Request) => r.headers.get('x-usuario') }

async function chamar(deps: PainelGuiasDeps, usuario: string, corpo: Record<string, unknown>) {
  const res = await handlePainelGuias(
    new Request('https://app.teste/api/v1/fiscal/guias', { method: 'POST', headers: { 'content-type': 'application/json', 'x-usuario': usuario }, body: JSON.stringify(corpo) }),
    deps,
  )
  return { status: res.status, corpo: (await res.json()) as Record<string, any> }
}

// ------------------------------------------------------------------ Contas

async function escritorio(nome: string, ligar: boolean, limite = 10): Promise<SelfServiceTenant> {
  const s = await createSelfServiceTenant(admin.db, { razaoSocial: nome })
  tenants.push(s)
  await admin.db.query(`update nofiscal.fiscal_tenants set plan = 'escritorio_5', monthly_note_limit = 500 where id = $1`, [s.tenant.id])
  if (ligar) await admin.db.query('select public.fiscal_definir_modulo_guias($1, true, $2)', [s.tenant.id, limite])
  return s
}

let A: SelfServiceTenant
let B: SelfServiceTenant
let C: SelfServiceTenant
const st = storageDouble()
const wa = whatsappDouble()
const em = emailDouble()
let deps: PainelGuiasDeps
const CLIENTE_1 = cnpjDe(`11${randomBytes(4).readUInt32BE() % 9000000 + 1000000}0001`)
const CLIENTE_2 = cnpjDe(`22${randomBytes(4).readUInt32BE() % 9000000 + 1000000}0001`)
const SEM_CONTATO = cnpjDe(`33${randomBytes(4).readUInt32BE() % 9000000 + 1000000}0001`)
const FONE_1 = randomPhone()
const FONE_2 = randomPhone()

function workerDeps(extra: Partial<GuiasWorkerDeps> = {}): GuiasWorkerDeps {
  return {
    db: servico.db, storage: st.armazem, whatsapp: wa.whatsapp, email: em.email, leitor: { texto: textoDoPdf, ia: null },
    segredo: SEGREDO, linkBase: 'https://app.teste', teto: 200, ...extra,
  }
}

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
  A = await escritorio('Contabilidade Teste A', true)
  B = await escritorio('Contabilidade Teste B', true)
  C = await escritorio('Contabilidade Sem Módulo', false)
  deps = { db: servico.db, sessions: sessoes, storage: st.armazem, leitor: { texto: textoDoPdf, ia: null } }
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
  await closeSharedDb()
})

const guiasDe = async (conta: string) =>
  (await admin.db.query<Record<string, any>>(`select * from nofiscal.guias where escritorio_tenant_id = $1 order by created_at`, [conta])).rows
const enviosDe = async (guiaId: string) =>
  (await admin.db.query<Record<string, any>>(`select * from nofiscal.guia_envios where guia_id = $1 order by created_at`, [guiaId])).rows

// ------------------------------------------------------------------ Painel

describe('painel: módulo, contatos e posse', () => {
  it('sem o módulo, o estado diz ligado:false e todo o resto é recusado (a aba não aparece)', async () => {
    expect(await chamar(deps, C.ownerUserId, { acao: 'estado' })).toEqual({ status: 200, corpo: { ligado: false } })
    const r = await chamar(deps, C.ownerUserId, { acao: 'contatos_listar' })
    expect(r.status).toBe(403)
    expect(r.corpo.error.code).toBe('GUIAS_DESLIGADO')
    const sem = await handlePainelGuias(new Request('https://app.teste/x', { method: 'POST', body: '{}' }), deps)
    expect(sem.status).toBe(401)
  })

  it('com o módulo, o estado traz o nome do escritório, o uso do mês e as regras', async () => {
    const r = await chamar(deps, A.ownerUserId, { acao: 'estado' })
    expect(r.status).toBe(200)
    expect(r.corpo).toMatchObject({ ligado: true, escritorio: 'Contabilidade Teste A', uso: { enviadas: 0, limite: 10, aviso: null }, upload: true })
    expect(r.corpo.regras.assinatura).toBe('Contabilidade Teste A')
  })

  it('importa CSV com validação por linha e relatório de erros, registrando o aceite declarado', async () => {
    const csv = [
      'documento,nome,whatsapp,email',
      `${fmtCnpj(CLIENTE_1)},Padaria Um Ltda,${FONE_1},um@cliente.test`,
      `${CLIENTE_2},Mercado Dois,,dois@cliente.test`,
      '11111111111111,CNPJ Inválido,11987654321,',
      `${cnpjDe('445556660001')},Sem Canal,,`,
      `${cnpjDe('445556670001')},Fone Ruim,123,`,
      `${cnpjDe('445556680001')},"Nome, com vírgula",,not-an-email`,
    ].join('\n')
    const r = await chamar(deps, A.ownerUserId, { acao: 'contatos_importar', csv, aceite_origem: 'Termo assinado no contrato', aceite_em: '2026-11-18' })
    expect(r.status).toBe(200)
    expect(r.corpo.importados).toBe(2)
    expect(r.corpo.erros).toEqual([
      { linha: 4, motivo: 'CNPJ ou CPF inválido' },
      { linha: 5, motivo: 'informe um WhatsApp ou um e-mail' },
      { linha: 6, motivo: 'WhatsApp inválido: 123' },
      { linha: 7, motivo: 'e-mail inválido: not-an-email' },
    ])
    const lista = await chamar(deps, A.ownerUserId, { acao: 'contatos_listar' })
    expect(lista.corpo.contatos).toHaveLength(2)
    const um = lista.corpo.contatos.find((c: any) => c.documento === CLIENTE_1)
    expect(um).toMatchObject({ nome: 'Padaria Um Ltda', whatsapps: [FONE_1], emails: ['um@cliente.test'], aceite_origem: 'Termo assinado no contrato', ativo: true })
    expect(new Date(um.aceite_em).toISOString().slice(0, 10)).toBe('2026-11-18')
  })

  it('edita e desativa contato; o escritório B não vê nem mexe nos contatos de A', async () => {
    const lista = await chamar(deps, A.ownerUserId, { acao: 'contatos_listar' })
    const dois = lista.corpo.contatos.find((c: any) => c.documento === CLIENTE_2)
    const ed = await chamar(deps, A.ownerUserId, { acao: 'contato_salvar', contato: { id: dois.id, documento: CLIENTE_2, nome: 'Mercado Dois ME', whatsapps: [FONE_2], emails: ['dois@cliente.test'] } })
    expect(ed.status).toBe(200)
    expect((await chamar(deps, B.ownerUserId, { acao: 'contatos_listar' })).corpo.contatos).toEqual([])
    const intruso = await chamar(deps, B.ownerUserId, { acao: 'contato_ativar', id: dois.id, ativo: false })
    expect(intruso.status).toBe(422)
    const ainda = await admin.db.query('select ativo, nome from nofiscal.guia_contatos where id = $1', [dois.id])
    expect(ainda.rows[0]).toEqual({ ativo: true, nome: 'Mercado Dois ME' })
    const ruim = await chamar(deps, A.ownerUserId, { acao: 'contato_salvar', contato: { documento: '123', nome: 'x', emails: ['a@b.c'] } })
    expect(ruim.status).toBe(422)
  })
})

describe('envio dos PDFs, leitura e conferência', () => {
  let loteId = ''
  let guias: any[] = []

  it('o upload é por URL assinada do Storage: a API devolve só URLs e nunca recebe o PDF', async () => {
    expect((await chamar(deps, A.ownerUserId, { acao: 'lote_criar', total: 501 })).status).toBe(422)
    const lote = await chamar(deps, A.ownerUserId, { acao: 'lote_criar', total: 3 })
    expect(lote.status).toBe(200)
    loteId = lote.corpo.lote_id
    expect((await chamar(deps, A.ownerUserId, { acao: 'lote_arquivos', lote_id: loteId, arquivos: [{ nome: 'x.png', tamanho: 10 }] })).status).toBe(422)
    expect((await chamar(deps, A.ownerUserId, { acao: 'lote_arquivos', lote_id: loteId, arquivos: [{ nome: 'x.pdf', tamanho: 11 * 1024 * 1024 }] })).status).toBe(422)
    expect((await chamar(deps, B.ownerUserId, { acao: 'lote_arquivos', lote_id: loteId, arquivos: [{ nome: 'a.pdf', tamanho: 10 }] })).status).toBe(422)

    const pdfs = [
      await gerarGuiaPdf({ tipo: 'das', cnpj: CLIENTE_1, competencia: '2026-11', vencimento: '2026-12-20', valorCentavos: 123456 }),
      await gerarGuiaPdf({ tipo: 'boleto', cnpj: CLIENTE_2, beneficiario: A.tenant.cnpj, competencia: '2026-11', vencimento: '2026-12-10', valorCentavos: 35000, valorNoTexto: 34000 }),
      await gerarGuiaPdf({ tipo: 'darf', cnpj: SEM_CONTATO, competencia: '2026-11', vencimento: '2026-12-19', valorCentavos: 98700 }),
    ]
    const r = await chamar(deps, A.ownerUserId, {
      acao: 'lote_arquivos', lote_id: loteId,
      arquivos: [{ nome: 'das.pdf', tamanho: pdfs[0].pdf.length }, { nome: 'honorarios.pdf', tamanho: pdfs[1].pdf.length }, { nome: 'darf.pdf', tamanho: pdfs[2].pdf.length }],
    })
    expect(r.status).toBe(200)
    expect(r.corpo.arquivos).toHaveLength(3)
    for (const [i, a] of r.corpo.arquivos.entries()) {
      expect(a.url).toMatch(/^https:\/\/storage\.teste\/storage\/v1\/object\/upload\/sign\/fiscal-guias\//)
      expect(a.url).toContain(A.tenant.id)
      st.subir(a.url, pdfs[i].pdf)
    }
    // Mais do que o lote declarou é recusado.
    expect((await chamar(deps, A.ownerUserId, { acao: 'lote_arquivos', lote_id: loteId, arquivos: [{ nome: 'd.pdf', tamanho: 10 }] })).status).toBe(422)
    const c = await chamar(deps, A.ownerUserId, { acao: 'lote_confirmar', lote_id: loteId, guia_ids: r.corpo.arquivos.map((a: any) => a.guia_id), fim: true })
    expect(c.corpo.confirmadas).toBe(3)
  })

  it('lê os PDFs e mostra verde (casou e leu tudo), amarela (valor divergente) e vermelha (CNPJ sem contato)', async () => {
    let pendentes = 1
    for (let i = 0; i < 5 && pendentes; i++) pendentes = (await chamar(deps, A.ownerUserId, { acao: 'ler', lote_id: loteId })).corpo.pendentes
    expect(pendentes).toBe(0)
    const v = await chamar(deps, A.ownerUserId, { acao: 'lote_ver', lote_id: loteId })
    expect(v.status).toBe(200)
    guias = v.corpo.guias
    expect(guias.map((g: any) => [g.arquivo, g.cor, g.tipo])).toEqual([
      ['das.pdf', 'verde', 'das'],
      ['honorarios.pdf', 'amarelo', 'honorario'],
      ['darf.pdf', 'vermelho', 'darf'],
    ])
    expect(guias[0]).toMatchObject({ documento: CLIENTE_1, competencia: '2026-11', valor_centavos: 123456, vencimento: '2026-12-20', contato: { nome: 'Padaria Um Ltda' } })
    expect(guias[1]).toMatchObject({ documento: CLIENTE_2, valor_centavos: 34000, valor_codigo_barras: 35000 })
    expect(guias[1].motivo).toMatch(/código de barras/)
    expect(guias[2]).toMatchObject({ documento: SEM_CONTATO, contato: null })
    expect(guias[2].motivo).toMatch(/sem contato/)
    expect(v.corpo.lote).toMatchObject({ status: 'conferir', lidos: 3, com_problema: 2 })
    // O escritório B não vê o lote de A.
    expect((await chamar(deps, B.ownerUserId, { acao: 'lote_ver', lote_id: loteId })).status).toBe(422)
  })

  it('edita o campo na conferência e cria o contato ali mesmo: as três ficam verdes', async () => {
    const linhaRuim = await chamar(deps, A.ownerUserId, { acao: 'guia_editar', guia_id: guias[1].id, campos: { linha_digitavel: '1'.repeat(47) } })
    expect(linhaRuim.status).toBe(422)
    const ed = await chamar(deps, A.ownerUserId, { acao: 'guia_editar', guia_id: guias[1].id, campos: { valor: '350,00' } })
    expect(ed.corpo.guia).toMatchObject({ cor: 'verde', valor_centavos: 35000 })
    const novo = await chamar(deps, A.ownerUserId, { acao: 'contato_salvar', contato: { documento: SEM_CONTATO, nome: 'Cliente Novo SA', emails: ['novo@cliente.test'] } })
    expect(novo.status).toBe(200)
    const v = await chamar(deps, A.ownerUserId, { acao: 'lote_ver', lote_id: loteId })
    expect(v.corpo.guias.map((g: any) => g.cor)).toEqual(['verde', 'verde', 'verde'])
    expect(v.corpo.lote.com_problema).toBe(0)
  })

  it('nada é enviado sem Disparar: o worker roda e não manda nada', async () => {
    const antes = wa.saidas.length
    const r = await rodadaDeGuias(workerDeps())
    expect(r.disparadas).toBe(0)
    expect(wa.saidas.length).toBe(antes)
    expect(em.emails.length).toBe(0)
    for (const g of guias) expect(await enviosDe(g.id)).toEqual([])
  })

  it('B não dispara guias de A; A agenda uma para depois e dispara as outras agora', async () => {
    expect((await chamar(deps, B.ownerUserId, { acao: 'disparar', guia_ids: guias.map((g: any) => g.id) })).corpo).toMatchObject({ agendadas: 0, recusadas: 3 })
    const depois = new Date(Date.now() + 3 * 3600_000).toISOString()
    expect((await chamar(deps, A.ownerUserId, { acao: 'disparar', guia_ids: [guias[2].id], quando: depois })).corpo).toMatchObject({ agendadas: 1 })
    expect((await chamar(deps, A.ownerUserId, { acao: 'disparar', guia_ids: [guias[0].id, guias[1].id] })).corpo).toMatchObject({ agendadas: 2, recusadas: 0 })
  })
})

describe('worker: disparo, idempotência, teto e lembretes', () => {
  it('dispara o agendado: modelo de utilidade com o PDF (media id) e botões, e e-mail com o PDF e o reply-to do escritório', async () => {
    const r = await rodadaDeGuias(workerDeps())
    expect(r).toMatchObject({ disparadas: 2, falharam: 0 })
    const [das, honorario, darf] = await guiasDe(A.tenant.id)
    expect(das.status).toBe('enviada')
    expect(honorario.status).toBe('enviada')
    expect(darf.status).toBe('agendada')

    const modelos = wa.saidas.filter((s): s is Extract<Saida, { tipo: 'modelo' }> => s.tipo === 'modelo')
    const doDas = modelos.find((m) => m.para === FONE_1)!
    expect(doDas.nome).toBe('guia_nova')
    expect(doDas.parametros.slice(0, 7)).toEqual(['Contabilidade Teste A', 'DAS do Simples Nacional', 'Padaria Um Ltda', '11/2026', '1.234,56', '20/12/2026', formatarLinha(das.linha_digitavel)])
    expect(doDas.extras?.documento).toEqual({ mediaId: expect.stringMatching(/^midia-/), nome: 'das.pdf' })
    const token = tokenDaGuia(SEGREDO, das.id)
    expect(doDas.extras?.botoes).toEqual([
      { tipo: 'resposta', indice: 0, payload: `guia:${das.id}:recebi` },
      { tipo: 'url', indice: 1, texto: token },
      { tipo: 'resposta', indice: 2, payload: `guia:${das.id}:escritorio` },
    ])
    expect(wa.midias.some((m) => m.nome === 'das.pdf' && m.tipo === 'application/pdf')).toBe(true)
    const doHonorario = modelos.find((m) => m.para === FONE_2)!
    expect(doHonorario.nome).toBe('honorario_aviso')
    expect(doHonorario.parametros[0]).toBe('Contabilidade Teste A')

    const emailUm = em.emails.find((e) => e.para === 'um@cliente.test')!
    expect(emailUm.anexos?.[0]).toMatchObject({ nome: 'das.pdf', tipo: 'application/pdf' })
    expect(emailUm.responderPara).toBe(A.ownerEmail)
    expect(emailUm.texto).toContain(`https://app.teste/g/${token}`)
    expect(emailUm.texto).toContain('Contabilidade Teste A')
    expect(emailUm.idempotencia).toBeTruthy()
    const envios = await enviosDe(das.id)
    expect(envios.map((e) => [e.canal, e.motivo, e.status, e.destino])).toEqual([
      ['whatsapp', 'envio', 'enviada', FONE_1],
      ['email', 'envio', 'enviada', 'um@cliente.test'],
    ])
    expect(envios[0].id_externo).toMatch(/^wamid\.guia-/)
  })

  it('retentativa não duplica: rodar de novo não manda nada, nem com um envio que ficou pela metade', async () => {
    const antes = { wa: wa.saidas.length, em: em.emails.length }
    await rodadaDeGuias(workerDeps())
    expect(wa.saidas.length).toBe(antes.wa)
    expect(em.emails.length).toBe(antes.em)
    // Simula uma rodada que caiu depois de reivindicar o envio e antes de marcar a guia: a guia volta a 'agendada'.
    const [das] = await guiasDe(A.tenant.id)
    await admin.db.query(`update nofiscal.guias set status = 'agendada' where id = $1`, [das.id])
    await admin.db.query(`update nofiscal.guia_envios set status = 'pendente', id_externo = null where guia_id = $1`, [das.id])
    await rodadaDeGuias(workerDeps())
    expect(wa.saidas.length).toBe(antes.wa)
    expect(em.emails.length).toBe(antes.em)
    expect((await guiasDe(A.tenant.id))[0].status).toBe('enviada')
  })

  it('o agendado para depois só sai na hora; o teto diário de contatos únicos adia sem perder', async () => {
    const [, , darf] = await guiasDe(A.tenant.id)
    expect((await rodadaDeGuias(workerDeps())).disparadas).toBe(0)
    const tarde = new Date(Date.now() + 4 * 3600_000)
    // Teto 2: os 2 números já usados hoje enchem o teto (o DARF só tem e-mail, então passa).
    const r = await rodadaDeGuias(workerDeps({ now: () => tarde, teto: 2 }))
    expect(r.disparadas).toBe(1)
    expect((await guiasDe(A.tenant.id))[2].status).toBe('enviada')
    expect(em.emails.some((e) => e.para === 'novo@cliente.test')).toBe(true)

    // Contato novo com WhatsApp, teto cheio: fica agendada (adiada), sem enviar.
    const fone3 = randomPhone()
    const doc3 = cnpjDe('667778880001')
    await chamar(deps, A.ownerUserId, { acao: 'contato_salvar', contato: { documento: doc3, nome: 'Terceiro', whatsapps: [fone3] } })
    const lote = (await chamar(deps, A.ownerUserId, { acao: 'lote_criar', total: 1 })).corpo.lote_id
    const pdf = await gerarGuiaPdf({ tipo: 'das_mei', cnpj: doc3, vencimento: '2026-12-20', valorCentavos: 7600 })
    const arq = (await chamar(deps, A.ownerUserId, { acao: 'lote_arquivos', lote_id: lote, arquivos: [{ nome: 'mei.pdf', tamanho: pdf.pdf.length }] })).corpo.arquivos[0]
    st.subir(arq.url, pdf.pdf)
    await chamar(deps, A.ownerUserId, { acao: 'lote_confirmar', lote_id: lote, guia_ids: [arq.guia_id], fim: true })
    await chamar(deps, A.ownerUserId, { acao: 'ler', lote_id: lote })
    await chamar(deps, A.ownerUserId, { acao: 'disparar', guia_ids: [arq.guia_id] })
    const adiada = await rodadaDeGuias(workerDeps({ teto: 2 }))
    expect(adiada).toMatchObject({ disparadas: 0, adiadas_pelo_teto: 1 })
    expect(wa.saidas.some((s) => s.para === fone3)).toBe(false)
    const solta = await rodadaDeGuias(workerDeps({ teto: 3 }))
    expect(solta.disparadas).toBe(1)
    expect(wa.saidas.some((s) => s.para === fone3)).toBe(true)
  })

  it('lembretes às 9 h de Brasília, véspera e dia, só sem "paguei", no máximo 2 por guia', async () => {
    const [das, honorario] = await guiasDe(A.tenant.id)
    const lembretes = () => wa.saidas.filter((s) => s.tipo === 'modelo' && s.nome === 'guia_lembrete') as Extract<Saida, { tipo: 'modelo' }>[]
    // O honorário vence 10/12; a véspera é 09/12. 08:59 em Brasília (11:59 UTC): nada.
    expect((await rodadaDeGuias(workerDeps({ now: () => new Date('2026-12-09T11:59:00Z') }))).lembretes).toBe(0)
    expect((await rodadaDeGuias(workerDeps({ now: () => new Date('2026-12-09T12:01:00Z') }))).lembretes).toBe(1)
    expect(lembretes().at(-1)).toMatchObject({ para: FONE_2, parametros: ['Contabilidade Teste A', 'de honorários', 'Mercado Dois ME', '350,00', 'amanhã'] })
    expect(lembretes().at(-1)?.extras?.botoes).toEqual([
      { tipo: 'resposta', indice: 0, payload: `guia:${honorario.id}:paguei` },
      { tipo: 'resposta', indice: 1, payload: `guia:${honorario.id}:segunda_via` },
    ])
    // Mesmo dia de novo: nada.
    expect((await rodadaDeGuias(workerDeps({ now: () => new Date('2026-12-09T18:00:00Z') }))).lembretes).toBe(0)
    expect((await rodadaDeGuias(workerDeps({ now: () => new Date('2026-12-10T12:30:00Z') }))).lembretes).toBe(1)
    expect(lembretes().at(-1)?.parametros.at(-1)).toBe('hoje')
    expect((await admin.db.query('select lembretes_enviados from nofiscal.guias where id = $1', [honorario.id])).rows[0].lembretes_enviados).toBe(2)
    // DAS (vence 20/12) com "paguei" informado: não recebe lembrete.
    await admin.db.query(`update nofiscal.guias set status = 'paga_informada' where id = $1`, [das.id])
    const antes = lembretes().length
    await rodadaDeGuias(workerDeps({ now: () => new Date('2026-12-19T12:30:00Z') }))
    expect(lembretes().filter((l) => l.para === FONE_1).length).toBe(lembretes().slice(0, antes).filter((l) => l.para === FONE_1).length)
    await admin.db.query(`update nofiscal.guias set status = 'enviada' where id = $1`, [das.id])
  })
})

// ------------------------------------------------------------------ Respostas (webhook)

describe('respostas pelo WhatsApp', () => {
  const resposta = whatsappDouble()
  const alerta = emailDouble()
  const conversa = (): ConversaDeps => ({
    db: servico.db,
    whatsapp: resposta.whatsapp,
    interprete: interpreteDouble({}).interprete,
    links: linksDoSite(),
    guias: { email: alerta.email, storage: st.armazem },
  })
  const msg = (de: string, extra: Partial<MensagemRecebida>): MensagemRecebida => ({ id: `wamid.r-${randomUUID()}`, de, tipo: 'text', texto: null, arquivo: null, ...extra })

  it('"paguei" de um contato de guias marca paga_informada e responde', async () => {
    await processarMensagem(conversa(), msg(FONE_1, { texto: 'Já paguei, obrigado!' }))
    const [das] = await guiasDe(A.tenant.id)
    expect(das).toMatchObject({ status: 'paga_informada', pago_origem: 'whatsapp' })
    expect(resposta.saidas.at(-1)).toMatchObject({ tipo: 'texto', para: FONE_1 })
    expect((resposta.saidas.at(-1) as any).texto).toContain('Contabilidade Teste A')
  })

  it('botão "Mandar de novo" (payload) reenvia o PDF dentro da janela', async () => {
    const [, honorario] = await guiasDe(A.tenant.id)
    await processarMensagem(conversa(), msg(FONE_2, { tipo: 'button', botao: { texto: 'Mandar de novo', payload: `guia:${honorario.id}:segunda_via` } }))
    const doc = resposta.saidas.at(-1) as Extract<Saida, { tipo: 'documento' }>
    expect(doc).toMatchObject({ tipo: 'documento', para: FONE_2, anexo: { nome: 'honorarios.pdf', tipo: 'application/pdf' } })
    expect(doc.legenda).toContain('2ª via')
    expect((await enviosDe(honorario.id)).some((e) => e.motivo === 'segunda_via' && e.status === 'enviada')).toBe(true)
    // "2ª via" por texto também.
    await processarMensagem(conversa(), msg(FONE_2, { texto: 'manda de novo a 2a via por favor' }))
    expect(resposta.saidas.at(-1)).toMatchObject({ tipo: 'documento', para: FONE_2 })
  })

  it('qualquer outra coisa: e-mail de alerta ao escritório e registro na guia', async () => {
    await processarMensagem(conversa(), msg(FONE_2, { texto: 'Esse valor está certo? Achei alto.' }))
    expect(alerta.emails.at(-1)).toMatchObject({ para: A.ownerEmail })
    expect(alerta.emails.at(-1)?.texto).toContain('Esse valor está certo? Achei alto.')
    const [, honorario] = await guiasDe(A.tenant.id)
    expect(honorario.ultima_resposta).toBe('Esse valor está certo? Achei alto.')
    expect(honorario.status).toBe('enviada')
  })

  it('comprovante (imagem) conta como "paguei"', async () => {
    await processarMensagem(conversa(), msg(FONE_2, { tipo: 'image', texto: null }))
    const [, honorario] = await guiasDe(A.tenant.id)
    expect(honorario).toMatchObject({ status: 'paga_informada', pago_origem: 'comprovante' })
  })

  it('"SAIR" faz opt-out só do WhatsApp daquele contato', async () => {
    await processarMensagem(conversa(), msg(FONE_2, { texto: 'SAIR' }))
    const { rows } = await admin.db.query('select sair_whatsapp_em, sair_email_em from nofiscal.guia_contatos where $1 = any(whatsapps)', [FONE_2])
    expect(rows[0].sair_whatsapp_em).not.toBeNull()
    expect(rows[0].sair_email_em).toBeNull()
  })

  it('número que não é contato de guias segue o caminho de sempre', async () => {
    const outro = randomPhone()
    const antes = resposta.saidas.length
    await processarMensagem(conversa(), msg(outro, { texto: 'paguei' }))
    const ultima = resposta.saidas.at(-1) as Extract<Saida, { tipo: 'texto' }>
    expect(resposta.saidas.length).toBe(antes + 1)
    expect(ultima.para).toBe(outro)
    expect(ultima.texto).not.toContain('Avisei')
  })

  it('statuses[] da Meta atualizam guia_envios e o andamento da guia (entregue → lida, nunca para trás)', async () => {
    const [, , , mei] = await guiasDe(A.tenant.id)
    const envio = (await enviosDe(mei.id)).find((e) => e.canal === 'whatsapp')!
    const segredo = randomBytes(8).toString('hex')
    const corpo = (status: string) =>
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [{ id: 'w', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '1' }, statuses: [{ id: envio.id_externo, status, recipient_id: envio.destino.replace('+', '') }] } }] }],
      })
    const enviar = (status: string) => {
      const b = corpo(status)
      return handleWhatsAppWebhook(
        new Request('https://app.teste/api/whatsapp/webhook', { method: 'POST', body: b, headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', segredo).update(b).digest('hex')}` } }),
        { verifyToken: 'v', appSecret: segredo, phoneNumberId: '1', conversa: conversa, central: () => servico.db },
      )
    }
    expect((await enviar('read')).status).toBe(200)
    expect((await enviar('delivered')).status).toBe(200)
    const e = (await enviosDe(mei.id)).find((x) => x.id === envio.id)!
    expect(e.status).toBe('lida')
    expect(e.lido_em).not.toBeNull()
    expect(e.entregue_em).not.toBeNull()
    expect((await guiasDe(A.tenant.id))[3].status).toBe('lida')
  })
})

// ------------------------------------------------------------------ Link, acompanhamento e modelos

describe('link /g/<token>, acompanhamento e modelos', () => {
  const abrir = (token: string, extra = '', ua = 'Mozilla/5.0 (iPhone)') =>
    handleLinkDaGuia(new Request(`https://app.teste/api/v1/fiscal/guia-link?token=${token}${extra}`, { headers: { 'user-agent': ua } }), { db: servico.db, storage: st.armazem })

  it('mostra a linha digitável com botão de copiar e o PDF; abrir marca "baixada"; a prévia do WhatsApp não marca', async () => {
    const [, , darf] = await guiasDe(A.tenant.id)
    const token = tokenDaGuia(SEGREDO, darf.id)
    const previa = await abrir(token, '', 'WhatsApp/2.23.20.0')
    expect(previa.status).toBe(200)
    expect((await guiasDe(A.tenant.id))[2].baixada_em).toBeNull()
    const r = await abrir(token)
    const html = await r.text()
    expect(r.status).toBe(200)
    expect(r.headers.get('x-robots-tag')).toContain('noindex')
    expect(html).toContain(formatarLinha(darf.linha_digitavel))
    expect(html).toContain('Copiar código')
    expect(html).toContain('Contabilidade Teste A')
    expect(html).toContain('href="?pdf=1"')
    const depois = (await guiasDe(A.tenant.id))[2]
    expect(depois.status).toBe('baixada')
    expect(depois.baixada_em).not.toBeNull()
    const pdf = await abrir(token, '&pdf=1')
    expect(pdf.status).toBe(302)
    expect(pdf.headers.get('location')).toMatch(/^https:\/\/storage\.teste\/storage\/v1\/object\/sign\/fiscal-guias\/.+expira=120/)
  })

  it('token imprevisível: errado ou expirado dá 404', async () => {
    expect((await abrir('x'.repeat(32))).status).toBe(404)
    expect((await abrir('curto')).status).toBe(404)
    const [, , darf] = await guiasDe(A.tenant.id)
    await admin.db.query(`update nofiscal.guias set link_expira_em = now() - interval '1 second' where id = $1`, [darf.id])
    expect((await abrir(tokenDaGuia(SEGREDO, darf.id))).status).toBe(404)
    expect(tokenDaGuia(SEGREDO, darf.id)).not.toBe(tokenDaGuia('outro-segredo', darf.id))
  })

  it('acompanhar: lista por guia com o andamento e o uso do mês; CSV exportável', async () => {
    const mes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7)
    const r = await chamar(deps, A.ownerUserId, { acao: 'acompanhar', mes })
    expect(r.status).toBe(200)
    const status = r.corpo.guias.map((g: any) => g.status).sort()
    expect(status).toEqual(['baixada', 'lida', 'paga_informada', 'paga_informada'].sort())
    expect(r.corpo.uso.enviadas).toBeGreaterThanOrEqual(3)
    const csv = await handlePainelGuias(new Request(`https://app.teste/x?exportar=csv&mes=${mes}`, { headers: { 'x-usuario': A.ownerUserId } }), deps)
    expect(csv.headers.get('content-type')).toContain('text/csv')
    const texto = await csv.text()
    expect(texto.split('\r\n')[0]).toContain('cliente;documento;tipo')
    expect(texto).toContain('Padaria Um Ltda')
    expect(texto).toContain('paga_informada')
    const deB = await handlePainelGuias(new Request(`https://app.teste/x?exportar=csv&mes=${mes}`, { headers: { 'x-usuario': B.ownerUserId } }), deps)
    expect(await deB.text()).not.toContain('Padaria Um Ltda')
  })

  it('aviso do limite do mês a 80% e a 100%, sem bloquear', () => {
    expect(avisoDoUso(7, 10).aviso).toBeNull()
    expect(avisoDoUso(8, 10).aviso).toBe('80')
    expect(avisoDoUso(10, 10).aviso).toBe('100')
    expect(avisoDoUso(12, 10)).toMatchObject({ aviso: '100', percentual: 120 })
  })

  it('modelos de utilidade com "Responda SAIR", o nome do escritório e PDF no cabeçalho', () => {
    for (const m of Object.values(MODELOS)) {
      const meta = modeloParaMeta(m) as { category: string; components: { type: string; text?: string }[] }
      expect(meta.category).toBe('UTILITY')
      expect(meta.components.find((c) => c.type === 'FOOTER')?.text).toBe(RODAPE_SAIR)
      expect(m.parametros[0]).toBe('escritorio')
      expect(m.corpo.trim()).not.toMatch(/^\{\{|\}\}$/)
    }
    expect(MODELOS.guia_nova.cabecalhoDocumento).toBe(true)
    expect(lerPayload('guia:00000000-0000-4000-8000-000000000000:paguei')).toEqual({ guiaId: '00000000-0000-4000-8000-000000000000', acao: 'paguei' })
    expect(lerPayload('guia:xx:paguei')).toBeNull()
  })
})

// ------------------------------------------------------------------ Defeitos achados na revisão independente

describe('revisão independente: cada defeito com o seu teste', () => {
  /** Escritório novo, contato com WhatsApp e e-mail, uma guia lida e verde pronta para disparar. */
  async function cenario(nome: string, venc = '2026-12-20') {
    const esc = await escritorio(nome, true)
    const fone = randomPhone()
    const doc = cnpjDe(`5${randomBytes(4).readUInt32BE() % 9000000 + 1000000}0001`.slice(0, 12))
    await chamar(deps, esc.ownerUserId, { acao: 'contato_salvar', contato: { documento: doc, nome: `Cliente ${nome}`, whatsapps: [fone], emails: [`c-${randomBytes(3).toString('hex')}@cliente.test`] } })
    const lote = (await chamar(deps, esc.ownerUserId, { acao: 'lote_criar', total: 1 })).corpo.lote_id
    const pdf = await gerarGuiaPdf({ tipo: 'das', cnpj: doc, vencimento: venc, valorCentavos: 5000 })
    const arq = (await chamar(deps, esc.ownerUserId, { acao: 'lote_arquivos', lote_id: lote, arquivos: [{ nome: 'g.pdf', tamanho: pdf.pdf.length }] })).corpo.arquivos[0]
    st.subir(arq.url, pdf.pdf)
    await chamar(deps, esc.ownerUserId, { acao: 'lote_confirmar', lote_id: lote, guia_ids: [arq.guia_id], fim: true })
    await chamar(deps, esc.ownerUserId, { acao: 'ler', lote_id: lote })
    return { esc, fone, guiaId: arq.guia_id as string, caminho: (await guiasDe(esc.tenant.id))[0].pdf_path as string }
  }

  it('1. erro no módulo (ex.: migration não aplicada) não tira a resposta de sempre de um número desconhecido', async () => {
    const r = whatsappDouble()
    const quebrado = new Proxy(servico.db, {
      get(alvo, p) {
        if (p === 'query') return (sql: string, v?: unknown[]) => (/guia_contatos/.test(sql) ? Promise.reject(new Error('relation "nofiscal.guia_contatos" does not exist')) : alvo.query(sql, v))
        return Reflect.get(alvo, p)
      },
    }) as Db
    const outro = randomPhone()
    await processarMensagem({ db: quebrado, whatsapp: r.whatsapp, interprete: interpreteDouble({}).interprete, links: linksDoSite(), guias: { email: null, storage: st.armazem } }, { id: `wamid.x-${randomUUID()}`, de: outro, tipo: 'text', texto: 'oi', arquivo: null })
    expect(r.saidas).toHaveLength(1)
    expect(r.saidas[0]).toMatchObject({ tipo: 'texto', para: outro })
  })

  it('2. 2ª via com o Storage fora: avisa o cliente e não deixa envio "pendente" travando a próxima tentativa', async () => {
    const c = await cenario('Rev Dois')
    await chamar(deps, c.esc.ownerUserId, { acao: 'disparar', guia_ids: [c.guiaId] })
    await rodadaDeGuias(workerDeps())
    const r = whatsappDouble()
    const pdf = st.arquivos.get(c.caminho)!
    st.arquivos.delete(c.caminho)
    const conv = (): ConversaDeps => ({ db: servico.db, whatsapp: r.whatsapp, interprete: interpreteDouble({}).interprete, links: linksDoSite(), guias: { email: null, storage: st.armazem } })
    await processarMensagem(conv(), { id: `wamid.s-${randomUUID()}`, de: c.fone, tipo: 'text', texto: '2ª via', arquivo: null })
    expect((r.saidas.at(-1) as any).texto).toMatch(/Não consegui mandar o PDF/)
    expect((await enviosDe(c.guiaId)).filter((e) => e.motivo === 'segunda_via')).toEqual([])
    st.arquivos.set(c.caminho, pdf)
    await processarMensagem(conv(), { id: `wamid.s-${randomUUID()}`, de: c.fone, tipo: 'text', texto: '2ª via', arquivo: null })
    expect(r.saidas.at(-1)).toMatchObject({ tipo: 'documento', para: c.fone })
  })

  it('3. a guia disparada no dia não recebe lembrete no mesmo dia', async () => {
    const c = await cenario('Rev Tres', '2026-12-20')
    await chamar(deps, c.esc.ownerUserId, { acao: 'disparar', guia_ids: [c.guiaId] })
    const vespera = new Date('2026-12-19T13:00:00Z')
    await rodadaDeGuias(workerDeps({ now: () => vespera }))
    const envios = await enviosDe(c.guiaId)
    expect(envios.filter((e) => e.motivo === 'envio').length).toBe(2)
    expect(envios.filter((e) => e.motivo === 'lembrete')).toEqual([])
    // No dia seguinte (vencimento), o lembrete sai.
    await rodadaDeGuias(workerDeps({ now: () => new Date('2026-12-20T13:00:00Z') }))
    expect((await enviosDe(c.guiaId)).filter((e) => e.motivo === 'lembrete').length).toBe(1)
  })

  it('4. lembrete que falhou não gasta a cota de 2: a retentativa do mesmo dia é que conta', async () => {
    const c = await cenario('Rev Quatro', '2026-12-20')
    await chamar(deps, c.esc.ownerUserId, { acao: 'disparar', guia_ids: [c.guiaId] })
    await rodadaDeGuias(workerDeps())
    wa.estado.falhar = true
    try {
      await rodadaDeGuias(workerDeps({ now: () => new Date('2026-12-19T12:30:00Z') }))
    } finally {
      wa.estado.falhar = false
    }
    const lembretes = async () => (await admin.db.query('select lembretes_enviados from nofiscal.guias where id = $1', [c.guiaId])).rows[0].lembretes_enviados
    expect(await lembretes()).toBe(0)
    await rodadaDeGuias(workerDeps({ now: () => new Date('2026-12-19T12:31:00Z') }))
    expect(await lembretes()).toBe(1)
    expect((await enviosDe(c.guiaId)).find((e) => e.motivo === 'lembrete')?.status).toBe('enviada')
  })

  it('5. "SAIR" tem volta pelo painel (com aceite novo) e o pedido de sair do e-mail é registrável', async () => {
    const c = await cenario('Rev Cinco')
    const conv = (): ConversaDeps => ({ db: servico.db, whatsapp: whatsappDouble().whatsapp, interprete: interpreteDouble({}).interprete, links: linksDoSite(), guias: { email: null, storage: st.armazem } })
    await processarMensagem(conv(), { id: `wamid.q-${randomUUID()}`, de: c.fone, tipo: 'text', texto: 'sair', arquivo: null })
    const contato = async () => (await admin.db.query('select id, sair_whatsapp_em, sair_email_em, aceite_origem from nofiscal.guia_contatos where $1 = any(whatsapps)', [c.fone])).rows[0]
    const antes = await contato()
    expect(antes.sair_whatsapp_em).not.toBeNull()
    expect((await chamar(deps, c.esc.ownerUserId, { acao: 'contato_canal', id: antes.id, sair_whatsapp: false })).status).toBe(422)
    expect((await chamar(deps, c.esc.ownerUserId, { acao: 'contato_canal', id: antes.id, sair_whatsapp: false, aceite_origem: 'Pediu de volta por telefone' })).status).toBe(200)
    expect(await contato()).toMatchObject({ sair_whatsapp_em: null, aceite_origem: 'Pediu de volta por telefone' })
    await chamar(deps, c.esc.ownerUserId, { acao: 'contato_canal', id: antes.id, sair_email: true })
    expect((await contato()).sair_email_em).not.toBeNull()
    // Outro escritório não mexe.
    expect((await chamar(deps, B.ownerUserId, { acao: 'contato_canal', id: antes.id, sair_email: false })).status).toBe(422)
  })

  it('6. PDF sumido no disparo: a guia vira "falhou" e não trava a fila', async () => {
    const c = await cenario('Rev Seis')
    await chamar(deps, c.esc.ownerUserId, { acao: 'disparar', guia_ids: [c.guiaId] })
    const pdf = st.arquivos.get(c.caminho)!
    st.arquivos.delete(c.caminho)
    const r = await rodadaDeGuias(workerDeps())
    expect(r.falharam).toBeGreaterThanOrEqual(1)
    expect((await guiasDe(c.esc.tenant.id))[0].status).toBe('falhou')
    st.arquivos.set(c.caminho, pdf)
    // Disparar de novo funciona.
    expect((await chamar(deps, c.esc.ownerUserId, { acao: 'disparar', guia_ids: [c.guiaId] })).corpo.agendadas).toBe(1)
    await rodadaDeGuias(workerDeps())
    expect((await guiasDe(c.esc.tenant.id))[0].status).toBe('enviada')
  })

  it('link de guia ainda na fila (agendada) não a tira da fila; CSV com CNPJ sem o zero à esquerda é aceito', async () => {
    const c = await cenario('Rev Sete')
    await chamar(deps, c.esc.ownerUserId, { acao: 'disparar', guia_ids: [c.guiaId] })
    const token = tokenDaGuia(SEGREDO, c.guiaId)
    await admin.db.query(`update nofiscal.guias set link_token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex'), link_expira_em = now() + interval '1 day' where id = $1`, [c.guiaId, token])
    const res = await handleLinkDaGuia(new Request(`https://app.teste/x?token=${token}`, { headers: { 'user-agent': 'Mozilla/5.0' } }), { db: servico.db, storage: st.armazem })
    expect(res.status).toBe(200)
    expect((await guiasDe(c.esc.tenant.id))[0].status).toBe('agendada')
    const comZero = cnpjDe('012345670001')
    expect(comZero.startsWith('0')).toBe(true)
    const imp = await chamar(deps, c.esc.ownerUserId, { acao: 'contatos_importar', csv: `${comZero.slice(1)},Zero Ltda,,zero@cliente.test` })
    expect(imp.corpo).toMatchObject({ importados: 1, erros: [] })
  })
})

describe('cobrança da assinatura Guias (20261119190000)', () => {
  it('estado mostra valor e próxima cobrança; cobrança recusada bloqueia o disparo (409) e o worker, e a paga desbloqueia', async () => {
    const esc = await escritorio('Cobranca Guias', true)
    await admin.db.query(
      `update nofiscal.fiscal_addons set pagarme_subscription_id = $2, pagarme_status = 'pendente', proxima_cobranca = '2026-12-16T18:42:00Z',
              desconto_valor = 5000, desconto_ciclos = 12 where tenant_id = $1`,
      [esc.tenant.id, `sub_guias_${randomBytes(4).toString('hex')}`],
    )
    const est = await chamar(deps, esc.ownerUserId, { acao: 'estado' })
    expect(est.corpo.cobranca).toMatchObject({ valor_centavos: 19700, valor_atual_centavos: 14700, desconto_ciclos_restantes: 12, status: 'pendente' })
    expect(new Date(est.corpo.cobranca.proxima_cobranca).toISOString()).toBe('2026-12-16T18:42:00.000Z')
    expect(est.corpo.bloqueio).toBeNull()

    const fone = randomPhone()
    const doc = cnpjDe('818283840001')
    await chamar(deps, esc.ownerUserId, { acao: 'contato_salvar', contato: { documento: doc, nome: 'Bloq', whatsapps: [fone] } })
    const lote = (await chamar(deps, esc.ownerUserId, { acao: 'lote_criar', total: 1 })).corpo.lote_id
    const pdf = await gerarGuiaPdf({ tipo: 'das', cnpj: doc, vencimento: '2026-12-20', valorCentavos: 1000 })
    const arq = (await chamar(deps, esc.ownerUserId, { acao: 'lote_arquivos', lote_id: lote, arquivos: [{ nome: 'b.pdf', tamanho: pdf.pdf.length }] })).corpo.arquivos[0]
    st.subir(arq.url, pdf.pdf)
    await chamar(deps, esc.ownerUserId, { acao: 'lote_confirmar', lote_id: lote, guia_ids: [arq.guia_id], fim: true })
    await chamar(deps, esc.ownerUserId, { acao: 'ler', lote_id: lote })
    await chamar(deps, esc.ownerUserId, { acao: 'disparar', guia_ids: [arq.guia_id] })

    await admin.db.query(`update nofiscal.fiscal_addons set pagarme_status = 'recusada' where tenant_id = $1`, [esc.tenant.id])
    expect((await chamar(deps, esc.ownerUserId, { acao: 'estado' })).corpo.bloqueio).toBe('PAGAMENTO_RECUSADO')
    const bloqueado = await chamar(deps, esc.ownerUserId, { acao: 'disparar', guia_ids: [arq.guia_id] })
    expect(bloqueado.status).toBe(409)
    expect(bloqueado.corpo.error.code).toBe('GUIAS_BLOQUEADO')
    await rodadaDeGuias(workerDeps())
    expect(wa.saidas.some((x) => x.para === fone)).toBe(false)
    expect((await guiasDe(esc.tenant.id))[0].status).toBe('agendada')

    await admin.db.query(`update nofiscal.fiscal_addons set pagarme_status = 'paga' where tenant_id = $1`, [esc.tenant.id])
    await rodadaDeGuias(workerDeps())
    expect(wa.saidas.some((x) => x.para === fone)).toBe(true)
  })
})

// Garante que o Db de serviço é o usado (tipo).
export type _Uso = Db
