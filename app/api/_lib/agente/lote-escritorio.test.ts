// Lote por planilha da conta Escritório, de ponta a ponta no banco local: a planilha chega no WhatsApp da conta-mãe,
// o resumo sai, "confirmar" cria as notas (parcial e uma vez só), o worker emite, cada tomador recebe o e-mail sem
// WhatsApp por nota, o registro de entregas é gravado e o lote fecha com o retorno (CSV e .zip) numa mensagem.
// O código sob teste conecta como `nofiscal_service`; WhatsApp, e-mail, mídia, IA e Sefin são dublês.
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createEscritorio,
  createSelfServiceTenant,
  criarModelo,
  dropEscritorio,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDePlanilha,
  mensagemDeTexto,
  midiaDouble,
  openRoleDb,
  randomPhone,
  rodarWorker,
  type Escritorio,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { sharedTestCertificate } from '../../_tests/certs.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { fakeSefin } from '../../_tests/sefin-fake.js'
import { createSefinClient } from '../sefin-client.js'
import { processarMensagem, TEXTOS } from './conversa.js'
import { confirmarItensDoLote, MODELO_DA_PLANILHA, TEXTOS_DO_LOTE } from './lote.js'
import { fecharLotes } from './lote-retorno.js'
import { LINHA_DA_PLANILHA } from './planos.js'
import { diaLocal } from './tempo.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const escritorios: Escritorio[] = []
const avulsos: SelfServiceTenant[] = []

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
})

afterAll(async () => {
  for (const e of escritorios) await dropEscritorio(admin.db, e)
  for (const s of avulsos) await dropSelfServiceTenant(admin.db, s)
  await servico.pool.end()
  await admin.pool.end()
})

const CPF = '52998224725'
const CNPJ_TOMADOR = '11444777000161'
const PEDIDO = 'nota pra Prontia, 10 reais'

function agente(agora: () => Date) {
  const canais = canaisDouble()
  const midia = midiaDouble()
  const ia = interpreteDouble({ [PEDIDO]: { modelo: 'Prontia', valor: '10.00', intencao: 'emitir' } })
  const deps = { db: servico.db, whatsapp: canais.whatsapp, email: canais.email, interprete: ia.interprete, links: LINKS_DE_TESTE, midia: midia.midia, now: agora }
  let n = 0
  return {
    canais,
    midia,
    deps,
    /** Manda a planilha (bytes novos a cada envio, mesmo conteúdo = mesmo hash) e devolve a resposta. */
    async planilha(de: string, conteudo: string | Uint8Array, nome = 'novembro.csv', mime: string | null = 'text/csv') {
      const id = `midia-${++n}`
      midia.guardar(id, conteudo)
      const antes = canais.whatsapps.length
      await processarMensagem(deps, mensagemDePlanilha(de, nome, mime, id))
      return canais.whatsapps.slice(antes).map((m) => m.texto).join('\n')
    },
    async texto(de: string, texto: string) {
      const antes = canais.whatsapps.length
      await processarMensagem(deps, mensagemDeTexto(de, texto))
      return canais.whatsapps.slice(antes).map((m) => m.texto).join('\n')
    },
  }
}

async function lotesDo(tenantId: string) {
  const { rows } = await admin.db.query<{ id: string; status: string; arquivo_sha256: string; arquivo_nome: string; expires_at: Date; created_at: Date; concluido_em: Date | null }>(
    'select * from nofiscal.fiscal_lotes where escritorio_tenant_id = $1 order by created_at',
    [tenantId],
  )
  return rows
}

async function itensDo(loteId: string) {
  const { rows } = await admin.db.query<{ id: string; linha: number; tenant_id: string | null; problema: string | null; invoice_id: string | null }>(
    'select id, linha, tenant_id, problema, invoice_id from nofiscal.fiscal_lote_itens where lote_id = $1 order by linha',
    [loteId],
  )
  return rows
}

describe('lote por planilha (conta Escritório)', () => {
  it('resumo, planilha repetida, confirmação parcial uma vez só, entrega sem WhatsApp por nota e retorno no fim', async () => {
    const certificado = sharedTestCertificate().certificado
    const e = await createEscritorio(admin.db, {
      certificado,
      empresas: [
        { certificado, razaoSocial: 'Padaria Cliente Ltda' },
        { notAfter: null, razaoSocial: 'Oficina Sem Certificado' },
      ],
    })
    escritorios.push(e)
    const [cliente, semCertificado] = e.empresas
    let agora = new Date()
    const a = agente(() => agora)
    const csv = [
      'CNPJ Prestador;CPF/CNPJ Tomador;Nome Tomador;E-mail Tomador;Valor;Descrição',
      `${e.mae.tenant.cnpj};529.982.247-25;Maria Tomadora;maria@tomador.test;150,00;Honorários de novembro`,
      `${cliente.cnpj};11.444.777/0001-61;Padaria Freguesa;fin@freguesa.test;1.000,00;`,
      `${semCertificado.cnpj};${CPF};Maria Tomadora;;50;`,
      `${e.mae.tenant.cnpj};123;Zé;;10;`,
      `${e.mae.tenant.cnpj};${CPF};Maria Tomadora;;150;`,
    ].join('\r\n')

    // Resumo: 2 prontas, 3 com problema (bloqueio da empresa, documento, linha repetida).
    const resumo = await a.planilha(e.mae.ownerPhone, `\uFEFF${csv}\r\n`)
    expect(resumo).toContain('Li a planilha novembro.csv: 5 linhas.')
    expect(resumo).toContain('Prontas para emitir: 2, total R$ 1.150,00.')
    expect(resumo).toContain('- Linha 4: Oficina Sem Certificado ainda não tem certificado A1')
    expect(resumo).toContain('- Linha 5: CPF ou CNPJ do tomador inválido')
    expect(resumo).toContain('- Linha 6: igual à linha 2 (mesmo prestador, tomador e valor)')
    expect(resumo).toContain('Responda *confirmar* para emitir as 2 notas prontas')

    const [lote] = await lotesDo(e.mae.tenant.id)
    expect(lote.status).toBe('aguardando_confirmacao')
    expect(lote.arquivo_nome).toBe('novembro.csv')
    expect(lote.arquivo_sha256).toBe(createHash('sha256').update(`\uFEFF${csv}\r\n`).digest('hex'))
    expect(Math.abs(lote.expires_at.getTime() - (agora.getTime() + 24 * 3600_000))).toBeLessThan(1000)
    expect((await itensDo(lote.id)).map((i) => [i.linha, i.problema])).toEqual([
      [2, null],
      [3, null],
      [4, 'CERT_MISSING'],
      [5, 'DOCUMENTO_INVALIDO'],
      [6, 'LINHA_REPETIDA'],
    ])

    // Mesma planilha (mesmo hash) com o lote vivo: recusa, nada novo gravado.
    const repetida = await a.planilha(e.mae.ownerPhone, `\uFEFF${csv}\r\n`, 'novembro (1).csv')
    expect(repetida).toMatch(/^Essa planilha já foi enviada em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2} e está esperando o \*confirmar\*\./)
    expect(await lotesDo(e.mae.tenant.id)).toHaveLength(1)

    // "confirmar": só as linhas prontas viram nota, com external_id = 'lote:' + id da linha.
    agora = new Date(agora.getTime() + 60_000)
    expect(await a.texto(e.mae.ownerPhone, 'confirmar')).toContain('Confirmado. Emitindo 2 notas na Sefin.')
    const itens = await itensDo(lote.id)
    const { rows: notas } = await admin.db.query<{ id: string; tenant_id: string; external_id: string; status: string }>(
      `select id, tenant_id, external_id, status from nofiscal.fiscal_invoices where external_id like 'lote:%' and tenant_id = any($1::uuid[]) order by external_id`,
      [[e.mae.tenant.id, cliente.id, semCertificado.id]],
    )
    expect(notas.map((n) => n.external_id).sort()).toEqual([`lote:${itens[0].id}`, `lote:${itens[1].id}`].sort())
    expect(itens.filter((i) => i.invoice_id).map((i) => i.linha)).toEqual([2, 3])
    expect(notas.find((n) => n.external_id === `lote:${itens[1].id}`)?.tenant_id).toBe(cliente.id)
    expect((await lotesDo(e.mae.tenant.id))[0].status).toBe('emitindo')

    // Só a primeira confirmação muda o estado: o segundo "confirmar" não cria nada.
    expect(await a.texto(e.mae.ownerPhone, 'confirmar')).toContain('Essa planilha já foi confirmada')
    expect(await confirmarItensDoLote(servico.db, lote.id, agora)).toBeNull()
    const { rows: contagem } = await admin.db.query<{ n: string }>(
      `select count(*) as n from nofiscal.fiscal_invoices where tenant_id = any($1::uuid[])`,
      [[e.mae.tenant.id, cliente.id, semCertificado.id]],
    )
    expect(Number(contagem[0].n)).toBe(2)

    // Worker: a empresa do escritório e depois a conta-mãe (é na rodada dela que o lote fecha).
    const antesDoWorker = a.canais.whatsapps.length
    const sefin = createSefinClient({ transport: fakeSefin().transport })
    await rodarWorker(servico.db, { sefin, tenantId: cliente.id, canais: a.canais, now: () => agora })
    expect((await lotesDo(e.mae.tenant.id))[0].status).toBe('emitindo')
    await rodarWorker(servico.db, { sefin, tenantId: e.mae.tenant.id, canais: a.canais, now: () => agora })

    // Nenhum WhatsApp por nota nem oferta de modelo; o e-mail vai ao tomador e à conta do escritório.
    const depois = a.canais.whatsapps.slice(antesDoWorker)
    expect(depois.some((m) => /autorizada|Quer que eu guarde/.test(m.texto))).toBe(false)
    expect(a.canais.emails.map((m) => m.para).sort()).toEqual(
      ['fin@freguesa.test', 'maria@tomador.test', e.mae.ownerEmail, e.mae.ownerEmail].sort(),
    )
    const { rows: entregas } = await admin.db.query<{ invoice_id: string; canal: string; papel: string; destino: string; status: string }>(
      `select invoice_id, canal, papel, destino, status from nofiscal.fiscal_invoice_entregas where invoice_id = any($1::uuid[]) order by destino`,
      [notas.map((n) => n.id)],
    )
    const daNota = (tenantId: string) =>
      entregas
        .filter((x) => x.invoice_id === notas.find((n) => n.tenant_id === tenantId)?.id)
        .map((x) => [x.canal, x.papel, x.destino, x.status])
        .sort()
    expect(daNota(e.mae.tenant.id)).toEqual([
      ['email', 'dono', e.mae.ownerEmail, 'enviado'],
      ['email', 'tomador', 'maria@tomador.test', 'enviado'],
    ].sort())
    expect(daNota(cliente.id)).toEqual([
      ['email', 'escritorio', e.mae.ownerEmail, 'enviado'],
      ['email', 'tomador', 'fin@freguesa.test', 'enviado'],
    ].sort())

    // Fechamento: lote concluído e uma entrega ao escritório, com o CSV de retorno e o .zip.
    const [fechado] = await lotesDo(e.mae.tenant.id)
    expect(fechado.status).toBe('concluido')
    expect(fechado.concluido_em).not.toBeNull()
    const dia = diaLocal(fechado.created_at)
    expect(depois.map((m) => m.anexo?.nome)).toEqual([`retorno-${dia}.csv`, `notas-${dia}.zip`])
    expect(depois.every((m) => m.para === e.mae.ownerPhone)).toBe(true)
    expect(depois[0].texto).toContain('concluída: 2 notas emitidas e 3 linhas não emitidas.')
    expect(depois[0].texto).toContain('Valor emitido: R$ 1.150,00.')
    const retorno = Buffer.from(depois[0].anexo?.conteudo ?? []).toString('utf8')
    expect(retorno.startsWith('\uFEFFlinha;prestador;tomador;valor;situação;número;chave;motivo\r\n')).toBe(true)
    expect(retorno).toContain(';Padaria Freguesa (11.444.777/0001-61);1.000,00;emitida;')
    expect(retorno).toContain('4;Oficina Sem Certificado')
    const zip = unzipSync(depois[1].anexo?.conteudo ?? new Uint8Array())
    const nomes = Object.keys(zip).sort()
    expect(nomes).toHaveLength(4)
    expect(nomes.filter((n) => n.endsWith('.pdf')).map((n) => Buffer.from(zip[n].subarray(0, 5)).toString('latin1'))).toEqual(['%PDF-', '%PDF-'])
    expect(nomes.some((n) => n.startsWith(`${cliente.cnpj}/`))).toBe(true)

    // Outra rodada não manda o retorno de novo.
    const total = a.canais.whatsapps.length
    await rodarWorker(servico.db, { sefin, tenantId: e.mae.tenant.id, canais: a.canais, now: () => agora })
    expect(a.canais.whatsapps.length).toBe(total)
    expect((await lotesDo(e.mae.tenant.id))[0]).toMatchObject({ status: 'concluido' })

    // A mesma planilha depois do lote concluído passa (o hash só barra lote aguardando); as linhas que já viraram
    // nota ficam de fora por JA_EMITIDA_NO_MES.
    const deNovo = await a.planilha(e.mae.ownerPhone, `\uFEFF${csv}\r\n`)
    expect(deNovo).toContain('- Linha 2: já há nota igual neste mês')
    expect(deNovo).toContain('- Linha 3: já há nota igual neste mês')
    expect(deNovo).toContain('Nenhuma linha está pronta para emitir.')
    expect((await lotesDo(e.mae.tenant.id)).map((l) => l.status)).toEqual(['concluido', 'descartado'])
  })

  it('plano Inicial/Pro: a planilha recebe a resposta curta do plano, sem download', async () => {
    const pro = await createSelfServiceTenant(admin.db, { plan: 'pro' })
    avulsos.push(pro)
    const a = agente(() => new Date())
    expect(await a.planilha(pro.ownerPhone, 'cpf_cnpj_tomador;nome_tomador;valor\n', 'notas.xlsx', null)).toBe(TEXTOS_DO_LOTE.soEscritorio)
    expect(a.midia.baixadas).toEqual([])
    // Outro documento qualquer continua com a resposta de "só texto"; o certificado continua recusado antes de tudo.
    expect(await a.planilha(pro.ownerPhone, 'x', 'contrato.pdf', 'application/pdf')).toBe(TEXTOS.soTexto)
  })

  it('colunas desconhecidas: explica as colunas e manda o modelo, sem gravar nada', async () => {
    const e = await createEscritorio(admin.db, { empresas: [{ razaoSocial: 'Cliente A' }] })
    escritorios.push(e)
    const a = agente(() => new Date())
    const resposta = await a.planilha(e.mae.ownerPhone, 'cliente;cpf;valor\nMaria;52998224725;10\n')
    expect(resposta).toContain('Não reconheci as colunas da planilha, e nada foi gravado.')
    expect(resposta).toContain('Colunas que eu não conheço: cliente, cpf.')
    expect(resposta).toContain('Faltam as colunas: cpf_cnpj_tomador, nome_tomador, cnpj_prestador.')
    expect(resposta).toContain(MODELO_DA_PLANILHA)
    expect(await lotesDo(e.mae.tenant.id)).toEqual([])
  })

  it('nota igual no mês bloqueia a linha; "cancelar" descarta; lote vencido pede a planilha de novo', async () => {
    const e = await createEscritorio(admin.db)
    escritorios.push(e)
    await admin.db.query(
      `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload, status, issued_at)
       values ($1, 'ja-emitida', $2::jsonb, 'issued', now())`,
      [e.mae.tenant.id, JSON.stringify({ tomador: { cpf: CPF, nome: 'Maria' }, servico: { codigo_servico_nacional: '010701', descricao: 'x' }, valor: '77.00' })],
    )
    let agora = new Date()
    const a = agente(() => agora)
    // Uma empresa só: cnpj_prestador pode faltar.
    const csv = `cpf_cnpj_tomador,nome_tomador,valor\n${CPF},Maria,"77,00"\n${CNPJ_TOMADOR},Padaria,"20,00"\n`
    const resumo = await a.planilha(e.mae.ownerPhone, csv)
    expect(resumo).toContain('- Linha 2: já há nota igual neste mês (mesmo prestador, tomador e valor)')
    expect(resumo).toContain('Responda *confirmar* para emitir a nota pronta')

    expect(await a.texto(e.mae.ownerPhone, 'cancelar')).toBe(TEXTOS_DO_LOTE.descartado)
    expect((await lotesDo(e.mae.tenant.id)).map((l) => l.status)).toEqual(['descartado'])

    // Descartado não segura o hash: a mesma planilha volta, e passadas 24 h sem confirmar ela expira.
    expect(await a.planilha(e.mae.ownerPhone, csv)).toContain('Prontas para emitir: 1')
    agora = new Date(agora.getTime() + 24 * 3600_000 + 60_000)
    expect(await a.texto(e.mae.ownerPhone, 'confirmar')).toBe(TEXTOS_DO_LOTE.expirou)
    expect((await lotesDo(e.mae.tenant.id)).map((l) => l.status)).toEqual(['descartado', 'expirado'])
    const { rows } = await admin.db.query<{ n: string }>(`select count(*) as n from nofiscal.fiscal_invoices where tenant_id = $1`, [e.mae.tenant.id])
    expect(Number(rows[0].n)).toBe(1)
  })

  it('"confirmar" vai para o mais recente: o pedido avulso aguardando mais novo que o lote', async () => {
    const e = await createEscritorio(admin.db)
    escritorios.push(e)
    await criarModelo(admin.db, e.mae.tenant.id, { nome: 'Prontia', documento: CNPJ_TOMADOR, nomeTomador: 'Prontia Saúde', descricao: 'Consultoria' })
    const a = agente(() => new Date())
    await a.planilha(e.mae.ownerPhone, `cpf_cnpj_tomador;nome_tomador;valor\n${CPF};Maria;30\n`)
    expect(await a.texto(e.mae.ownerPhone, PEDIDO)).toContain('Resumo da nota:')
    expect(await a.texto(e.mae.ownerPhone, 'confirmar')).toBe(TEXTOS.emitindo)
    expect((await lotesDo(e.mae.tenant.id))[0].status).toBe('aguardando_confirmacao')
    // Agora o mais recente aguardando é o lote.
    expect(await a.texto(e.mae.ownerPhone, 'sim')).toBe('Para emitir a nota pronta da planilha, responda *confirmar*.')
    expect(await a.texto(e.mae.ownerPhone, 'confirmar')).toContain('Confirmado. Emitindo 1 nota na Sefin.')
    expect((await lotesDo(e.mae.tenant.id))[0].status).toBe('emitindo')
  })
})

async function telefoneAutorizado(tenantId: string): Promise<string> {
  const telefone = randomPhone()
  await admin.db.query(
    `insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role, verified_at) values ($1, $2, 'authorized', now())`,
    [tenantId, telefone],
  )
  return telefone
}

async function notaDoItem(loteId: string, linha: number) {
  const { rows } = await admin.db.query<{ invoice_id: string | null; problema: string | null }>(
    'select invoice_id, problema from nofiscal.fiscal_lote_itens where lote_id = $1 and linha = $2',
    [loteId, linha],
  )
  return rows[0]
}

describe('lote por planilha: correções da revisão', () => {
  it('"confirmar" e "cancelar" só alcançam a planilha do próprio telefone', async () => {
    const e = await createEscritorio(admin.db)
    escritorios.push(e)
    const outro = await telefoneAutorizado(e.mae.tenant.id)
    const a = agente(() => new Date())
    expect(await a.planilha(e.mae.ownerPhone, `cpf_cnpj_tomador;nome_tomador;valor\n${CPF};Maria;30\n`)).toContain('Prontas para emitir: 1')

    // O outro telefone da conta não confirma nem descarta a planilha do dono.
    expect(await a.texto(outro, 'confirmar')).toBe(TEXTOS.semPedido)
    expect(await a.texto(outro, 'cancelar')).not.toBe(TEXTOS_DO_LOTE.descartado)
    expect((await lotesDo(e.mae.tenant.id)).map((l) => l.status)).toEqual(['aguardando_confirmacao'])

    // Com a própria planilha, cada um confirma a sua.
    expect(await a.planilha(outro, `cpf_cnpj_tomador;nome_tomador;valor\n${CNPJ_TOMADOR};Padaria;45\n`)).toContain('Prontas para emitir: 1')
    expect(await a.texto(e.mae.ownerPhone, 'confirmar')).toContain('Confirmado. Emitindo 1 nota')
    const [doDono, doOutro] = await lotesDo(e.mae.tenant.id)
    expect([doDono.status, doOutro.status]).toEqual(['emitindo', 'aguardando_confirmacao'])
    expect(await a.texto(outro, 'cancelar')).toBe(TEXTOS_DO_LOTE.descartado)
    expect((await lotesDo(e.mae.tenant.id)).map((l) => l.status)).toEqual(['emitindo', 'descartado'])
  })

  it('no "confirmar", a nota igual que saiu depois do resumo barra a linha (JA_EMITIDA_NO_MES)', async () => {
    const e = await createEscritorio(admin.db)
    escritorios.push(e)
    const a = agente(() => new Date())
    await a.planilha(e.mae.ownerPhone, `cpf_cnpj_tomador;nome_tomador;valor\n${CPF};Maria;77\n${CNPJ_TOMADOR};Padaria;20\n`)
    // Entre o resumo e o "confirmar", sai uma nota igual à linha 2 (pedido avulso, por exemplo), ainda na fila.
    await admin.db.query(
      `insert into nofiscal.fiscal_invoices (tenant_id, external_id, payload) values ($1, 'avulsa-igual', $2::jsonb)`,
      [e.mae.tenant.id, JSON.stringify({ tomador: { cpf: CPF, nome: 'Maria' }, servico: { codigo_servico_nacional: '010701', descricao: 'x' }, valor: '77.00' })],
    )
    const resposta = await a.texto(e.mae.ownerPhone, 'confirmar')
    expect(resposta).toContain('Confirmado. Emitindo 1 nota na Sefin.')
    expect(resposta).toContain('1 linha ficou de fora: já há nota igual neste mês (mesmo prestador, tomador e valor).')
    const [lote] = await lotesDo(e.mae.tenant.id)
    expect(await notaDoItem(lote.id, 2)).toEqual({ invoice_id: null, problema: 'JA_EMITIDA_NO_MES' })
    expect((await notaDoItem(lote.id, 3)).invoice_id).not.toBeNull()
  })

  it('retorno: só fica marcado quando um canal confirma; tenta de novo, fora da janela vai por e-mail, e sai uma vez só', async () => {
    const e = await createEscritorio(admin.db)
    escritorios.push(e)
    const inicio = new Date()
    const a = agente(() => inicio)
    await a.planilha(e.mae.ownerPhone, `cpf_cnpj_tomador;nome_tomador;valor\n${CPF};Maria;30\n`, 'dezembro.csv')
    await a.texto(e.mae.ownerPhone, 'confirmar')
    const [lote] = await lotesDo(e.mae.tenant.id)
    await admin.db.query(
      `update nofiscal.fiscal_invoices set status = 'rejected', last_error_code = 'E0310', last_error = 'CPF não encontrado'
        where id = (select invoice_id from nofiscal.fiscal_lote_itens where lote_id = $1 and linha = 2)`,
      [lote.id],
    )
    const falha = new Error('fora do ar')
    const quebrados = {
      whatsapp: { enviarTexto: async () => Promise.reject(falha), enviarDocumento: async () => Promise.reject(falha), enviarModelo: async () => Promise.reject(falha) },
      email: { enviar: async () => Promise.reject(falha) },
    }
    // 12 h depois: o lote fecha, mas os dois canais falham; nada fica marcado.
    const meioDia = new Date(inicio.getTime() + 12 * 3600_000)
    expect(await fecharLotes({ db: servico.db, ...quebrados, links: LINKS_DE_TESTE, now: () => meioDia }, { tenantIds: [e.mae.tenant.id] })).toBe(0)
    let [atual] = await admin.db.query<{ status: string; retorno_enviado_em: Date | null }>(
      'select status, retorno_enviado_em from nofiscal.fiscal_lotes where id = $1',
      [lote.id],
    ).then((r) => r.rows)
    expect(atual).toEqual({ status: 'concluido', retorno_enviado_em: null })

    // 25 h depois do "confirmar" (fora da janela de 24 h do WhatsApp, 13 h depois de concluído): duas rodadas ao
    // mesmo tempo, um e-mail só, com o CSV.
    const depois = new Date(inicio.getTime() + 25 * 3600_000)
    const canais = canaisDouble()
    const deps = { db: servico.db, whatsapp: canais.whatsapp, email: canais.email, links: LINKS_DE_TESTE, now: () => depois }
    const enviados = await Promise.all([fecharLotes(deps, { tenantIds: [e.mae.tenant.id] }), fecharLotes(deps, { tenantIds: [e.mae.tenant.id] })])
    expect(enviados.sort()).toEqual([0, 1])
    expect(canais.whatsapps).toEqual([])
    expect(canais.emails).toHaveLength(1)
    expect(canais.emails[0].para).toBe(e.mae.ownerEmail)
    expect(canais.emails[0].anexos?.map((x) => x.nome)).toEqual([`retorno-${diaLocal(lote.created_at)}.csv`])
    expect(canais.emails[0].texto).toContain('concluída: 0 notas emitidas e 1 recusada pela Sefin.')
    ;[atual] = await admin.db.query<{ status: string; retorno_enviado_em: Date | null }>(
      'select status, retorno_enviado_em from nofiscal.fiscal_lotes where id = $1',
      [lote.id],
    ).then((r) => r.rows)
    expect(atual.retorno_enviado_em).not.toBeNull()
    expect(await fecharLotes(deps, { tenantIds: [e.mae.tenant.id] })).toBe(0)
    expect(canais.emails).toHaveLength(1)
  })

  it('nota parada na fila: aviso parcial em 6 h; em 24 h o lote fecha com ela "na fila" no retorno', async () => {
    const e = await createEscritorio(admin.db)
    escritorios.push(e)
    const a = agente(() => new Date())
    await a.planilha(e.mae.ownerPhone, `cpf_cnpj_tomador;nome_tomador;valor\n${CPF};Maria;30\n`)
    await a.texto(e.mae.ownerPhone, 'confirmar')
    const [lote] = await lotesDo(e.mae.tenant.id)
    const canais = canaisDouble()
    const deps = { db: servico.db, whatsapp: canais.whatsapp, email: canais.email, links: LINKS_DE_TESTE, now: () => new Date() }

    await admin.db.query(`update nofiscal.fiscal_lotes set confirmed_at = now() - interval '7 hours' where id = $1`, [lote.id])
    expect(await fecharLotes(deps, { tenantIds: [e.mae.tenant.id] })).toBe(0)
    expect(canais.whatsapps.map((m) => m.texto)).toEqual([
      expect.stringContaining('0 notas já saíram, 0 foram recusadas e 1 continua na fila'),
    ])

    await admin.db.query(`update nofiscal.fiscal_lotes set confirmed_at = now() - interval '25 hours' where id = $1`, [lote.id])
    expect(await fecharLotes(deps, { tenantIds: [e.mae.tenant.id] })).toBe(1)
    const retorno = canais.whatsapps.at(-1)
    expect(retorno?.anexo?.nome).toMatch(/^retorno-.*\.csv$/)
    expect(retorno?.texto).toContain('concluída: 0 notas emitidas e 1 ainda na fila.')
    expect(Buffer.from(retorno?.anexo?.conteudo ?? []).toString('utf8')).toContain(';na fila;')
    expect((await lotesDo(e.mae.tenant.id))[0].status).toBe('concluido')
  })
})

describe('boas-vindas do Escritório', () => {
  it('o "Pronto!" ganha a linha da planilha', async () => {
    const e = await createEscritorio(admin.db, { onboardingEtapa: 'boas_vindas_conferir' })
    escritorios.push(e)
    const a = agente(() => new Date())
    const resposta = await a.texto(e.mae.ownerPhone, 'sim')
    expect(resposta).toMatch(/^Pronto! /)
    expect(resposta.split('\n').at(-1)).toBe(LINHA_DA_PLANILHA)
    expect(LINHA_DA_PLANILHA).toBe(
      'Pra emitir as notas do mês de uma vez, mande a planilha aqui (modelo: https://www.notechstack.com.br/agentes/fiscal/dados/modelo-lote.csv).',
    )
  })
})

describe('registro de entregas da nota avulsa', () => {
  it('cada tentativa de WhatsApp e e-mail fica gravada, com o que falhou', async () => {
    const s = await createSelfServiceTenant(admin.db, { plan: 'pro', certificado: sharedTestCertificate().certificado })
    avulsos.push(s)
    await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
    await criarModelo(admin.db, s.tenant.id, { nome: 'Prontia', documento: CNPJ_TOMADOR, nomeTomador: 'Prontia Saúde', email: 'fin@prontia.test' })
    const agora = () => new Date()
    const a = agente(agora)
    await a.texto(s.ownerPhone, PEDIDO)
    await a.texto(s.ownerPhone, 'confirmar')
    // O e-mail do tomador falha nas 3 tentativas; o resto sai.
    const email = {
      async enviar(m: { para: string }) {
        if (m.para === 'fin@prontia.test') throw new Error('caixa cheia')
      },
    }
    await rodarWorker(servico.db, {
      sefin: createSefinClient({ transport: fakeSefin().transport }),
      tenantId: s.tenant.id,
      canais: { whatsapp: a.canais.whatsapp, email },
      now: agora,
    })
    const { rows } = await admin.db.query<{ canal: string; papel: string; destino: string; status: string }>(
      `select e.canal, e.papel, e.destino, e.status from nofiscal.fiscal_invoice_entregas e
         join nofiscal.fiscal_invoices i on i.id = e.invoice_id where i.tenant_id = $1 order by e.canal, e.destino`,
      [s.tenant.id],
    )
    expect(rows.map((r) => [r.canal, r.papel, r.destino, r.status])).toEqual([
      ['email', 'dono', s.ownerEmail, 'enviado'],
      ['email', 'tomador', 'fin@prontia.test', 'falhou'],
      ['whatsapp', 'dono', s.ownerPhone, 'enviado'],
    ])
  })
})
