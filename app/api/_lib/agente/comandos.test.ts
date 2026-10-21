// Comandos do dono no WhatsApp. Checks C44 e C46 de .checks/agente-fiscal-v2.md. O código sob
// teste conecta como `nofiscal_service`. `nofiscal.agendar_cancelamento` é do lote B: se ainda
// não existir no banco local, o teste cria um stub na forma do contrato (Landing, lote C - stub
// do contrato B → C) e o apaga no fim.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  allowTestUserToAssume,
  assinarTenant,
  canaisDouble,
  createSelfServiceTenant,
  dropSelfServiceTenant,
  interpreteDouble,
  LINKS_DE_TESTE,
  mensagemDeTexto,
  openRoleDb,
  randomPhone,
  type SelfServiceTenant,
} from '../../_tests/agente-fixtures.js'
import { openTestDb } from '../../_tests/fixtures.js'
import { processarMensagem } from './conversa.js'
import { dataBr } from './tempo.js'

const admin = openTestDb()
const servico = openRoleDb('nofiscal_service')
const tenants: SelfServiceTenant[] = []
let criouStub = false

const STUB = `
create function nofiscal.agendar_cancelamento(p_tenant_id uuid, p_origem text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_criada timestamptz;
  v_teste boolean;
  v_fim timestamptz;
begin
  select s.id, s.created_at, coalesce(s.status = 'pendente' and t.trial_ends_at > now(), false)
    into v_id, v_criada, v_teste
    from nofiscal.fiscal_subscriptions s join nofiscal.fiscal_tenants t on t.id = s.tenant_id
   where s.tenant_id = p_tenant_id and s.status <> 'cancelada'
   order by s.created_at desc limit 1;
  if v_id is null then
    return jsonb_build_object('status', 'sem_assinatura');
  end if;
  if v_teste then
    v_fim := now();
  else
    v_fim := v_criada;
    while v_fim <= now() loop
      v_fim := v_fim + interval '1 month';
    end loop;
  end if;
  update nofiscal.fiscal_subscriptions
     set cancelamento_agendado_para = v_fim, cancelamento_pedido_em = now(), cancelamento_origem = p_origem
   where id = v_id;
  return jsonb_build_object('status', 'agendado', 'cancelamento_agendado_para', v_fim);
end;
$$;
revoke all on function nofiscal.agendar_cancelamento(uuid, text) from public, anon, authenticated, service_role;
grant execute on function nofiscal.agendar_cancelamento(uuid, text) to nofiscal_service;
`

beforeAll(async () => {
  await allowTestUserToAssume(admin.db, 'nofiscal_service')
  const { rows } = await admin.db.query<{ existe: boolean }>(
    `select to_regprocedure('nofiscal.agendar_cancelamento(uuid, text)') is not null as existe`,
  )
  if (!rows[0].existe) {
    await admin.db.query(STUB)
    criouStub = true
  }
})

afterAll(async () => {
  for (const s of tenants) await dropSelfServiceTenant(admin.db, s)
  if (criouStub) await admin.db.query('drop function if exists nofiscal.agendar_cancelamento(uuid, text)')
  await servico.pool.end()
  await admin.pool.end()
})

async function novoTenant(plan: 'inicial' | 'pro' = 'pro') {
  const s = await createSelfServiceTenant(admin.db, { plan })
  tenants.push(s)
  return s
}

function conversa() {
  const canais = canaisDouble()
  const ia = interpreteDouble({})
  const deps = { db: servico.db, whatsapp: canais.whatsapp, interprete: ia.interprete, links: LINKS_DE_TESTE }
  const enviar = async (de: string, texto: string) => {
    await processarMensagem(deps, mensagemDeTexto(de, texto))
    return canais.whatsapps.filter((m) => m.para === de).at(-1)?.texto ?? ''
  }
  return { enviar, ia }
}

async function assinatura(tenantId: string) {
  const { rows } = await admin.db.query<{ para: Date | null; origem: string | null; status: string }>(
    `select cancelamento_agendado_para as para, cancelamento_origem as origem, status
       from nofiscal.fiscal_subscriptions where tenant_id = $1`,
    [tenantId],
  )
  return rows[0]
}

async function configuracao(tenantId: string) {
  const { rows } = await admin.db.query<{ contador_email: string | null; resumo_frequencia: string | null; resumo_dia: number | null }>(
    'select contador_email, resumo_frequencia, resumo_dia from nofiscal.fiscal_tenants where id = $1',
    [tenantId],
  )
  return rows[0]
}

describe('comandos no WhatsApp', () => {
  it('cancelar assinatura pelo whatsapp', async () => {
    const s = await novoTenant()
    await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
    const c = conversa()

    // Primeiro a data e o pedido de "confirmar"; nada é gravado ainda.
    const pergunta = await c.enviar(s.ownerPhone, 'cancelar assinatura')
    const data = /Você emite até (\d{2}\/\d{2}\/\d{4})\./.exec(pergunta)?.[1]
    expect(data).toBeDefined()
    expect(pergunta).toContain('"confirmar"')
    expect(await assinatura(s.tenant.id)).toMatchObject({ para: null, origem: null, status: 'paga' })

    // "confirmar" chama agendar_cancelamento e responde a mesma data.
    const feito = await c.enviar(s.ownerPhone, 'confirmar')
    const gravada = await assinatura(s.tenant.id)
    expect(gravada.para).not.toBeNull()
    expect(gravada.origem).toBe('whatsapp')
    expect(gravada.status).toBe('paga')
    expect(dataBr(gravada.para as Date)).toBe(data)
    expect(feito).toBe(`Cancelamento agendado. Você emite até ${data}.`)
    expect(c.ia.chamadas).toEqual([])
  })

  it('cancelar assinatura só com o confirmar seguinte, do dono', async () => {
    const s = await novoTenant()
    await assinarTenant(admin.db, s.tenant.id, { status: 'paga' })
    const c = conversa()

    // Outra mensagem entre o pedido e o "confirmar" desfaz o pedido.
    await c.enviar(s.ownerPhone, 'cancelar assinatura')
    await c.enviar(s.ownerPhone, 'contador contador@example.test')
    expect(await c.enviar(s.ownerPhone, 'confirmar')).not.toContain('Cancelamento agendado')
    expect((await assinatura(s.tenant.id)).para).toBeNull()

    // "não" mantém.
    await c.enviar(s.ownerPhone, 'cancelar assinatura')
    expect(await c.enviar(s.ownerPhone, 'não')).toBe('Ok, a assinatura continua.')
    expect((await assinatura(s.tenant.id)).para).toBeNull()

    // Número autorizado que não é o do dono não cancela.
    const autorizado = randomPhone()
    await admin.db.query(`insert into nofiscal.fiscal_phones (tenant_id, phone_e164, role, verified_at) values ($1, $2, 'authorized', now())`, [
      s.tenant.id,
      autorizado,
    ])
    expect(await c.enviar(autorizado, 'cancelar assinatura')).toBe('Só o WhatsApp do dono da conta pode fazer isso.')

    // No teste: cancela agora, nada é cobrado.
    const emTeste = await novoTenant()
    await assinarTenant(admin.db, emTeste.tenant.id, { status: 'pendente', trialEndsAt: new Date(Date.now() + 5 * 24 * 3600_000) })
    expect(await c.enviar(emTeste.ownerPhone, 'cancelar assinatura')).toContain('Você está no teste')
    expect(await c.enviar(emTeste.ownerPhone, 'confirmar')).toBe('Assinatura cancelada. Nada será cobrado.')
    expect((await assinatura(emTeste.tenant.id)).para).not.toBeNull()

    // Sem assinatura.
    const semAssinatura = await novoTenant()
    expect(await c.enviar(semAssinatura.ownerPhone, 'cancelar assinatura')).toBe('Não encontrei assinatura ativa para cancelar.')
  })

  it('comandos de configuração', async () => {
    const c = conversa()
    const pro = await novoTenant('pro')
    expect(await c.enviar(pro.ownerPhone, 'contador Maria.Contadora@Example.test')).toBe(
      'Pronto: maria.contadora@example.test vai receber cópia das notas.',
    )
    expect((await configuracao(pro.tenant.id)).contador_email).toBe('maria.contadora@example.test')

    expect(await c.enviar(pro.ownerPhone, 'resumo mensal 5')).toBe('Pronto: resumo mensal todo dia 5, às 9h.')
    expect(await configuracao(pro.tenant.id)).toMatchObject({ resumo_frequencia: 'mensal', resumo_dia: 5 })

    expect(await c.enviar(pro.ownerPhone, 'Resumo semanal segunda')).toBe('Pronto: resumo semanal toda segunda, às 9h.')
    expect(await configuracao(pro.tenant.id)).toMatchObject({ resumo_frequencia: 'semanal', resumo_dia: 1 })
    expect(await c.enviar(pro.ownerPhone, 'resumo semanal 5')).toBe('Pronto: resumo semanal toda sexta, às 9h.')
    expect(await configuracao(pro.tenant.id)).toMatchObject({ resumo_frequencia: 'semanal', resumo_dia: 5 })

    // Dia fora da faixa não grava.
    expect(await c.enviar(pro.ownerPhone, 'resumo mensal 31')).toContain('1 a 28')
    expect(await configuracao(pro.tenant.id)).toMatchObject({ resumo_frequencia: 'semanal', resumo_dia: 5 })

    // No Inicial: "Disponível no plano Pro", e nada muda.
    const inicial = await novoTenant('inicial')
    expect(await c.enviar(inicial.ownerPhone, 'contador maria@example.test')).toBe('Disponível no plano Pro')
    expect(await c.enviar(inicial.ownerPhone, 'resumo mensal 5')).toBe('Disponível no plano Pro')
    expect(await c.enviar(inicial.ownerPhone, 'resumo semanal 1')).toBe('Disponível no plano Pro')
    expect(await configuracao(inicial.tenant.id)).toEqual({ contador_email: null, resumo_frequencia: null, resumo_dia: null })
    expect(c.ia.chamadas).toEqual([])
  })
})
