#!/usr/bin/env node
// Cria (ou reutiliza) um usuário CLIENT no Supabase Auth pelo Admin API e vincula ao cliente.
// Não lê .env: as variáveis vêm do ambiente do processo. Nada é gravado em arquivo.
//
// Uso (PowerShell):
//   $env:SUPABASE_URL="https://<ref>.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="<service_role>";
//   $env:CLIENT_EMAIL="cliente@exemplo.com"; $env:CLIENT_PASSWORD="<senha>"; $env:CLIENT_SLUG="conexao-equestre"
//   node app/scripts/create-client-user.mjs
//
// O que faz: busca o usuário pelo e-mail; se não existir, cria com e-mail confirmado, senha informada e
// app_metadata.role=CLIENT. Se existir com outro papel (NO_ADMIN/AGENCY_ADMIN), aborta sem alterar.
// Em seguida insere memberships(user_id, client_id, role=CLIENT) para o cliente do slug, se ausente.
// Não altera projetos, roadmap, access_status nem senha de usuário existente.
import { createClient } from '@supabase/supabase-js'

const need = (name) => {
  const value = process.env[name]
  if (!value) { console.error(`Variável ausente: ${name}`); process.exit(2) }
  return value
}
const url = need('SUPABASE_URL').replace(/\/$/, '')
const serviceRole = need('SUPABASE_SERVICE_ROLE_KEY')
const email = need('CLIENT_EMAIL').trim().toLowerCase()
const password = need('CLIENT_PASSWORD')
const slug = need('CLIENT_SLUG')

const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } })

const { data: client, error: clientError } = await admin.from('clients').select('id,name').eq('slug', slug).maybeSingle()
if (clientError || !client) { console.error('Cliente não encontrado para o slug', slug, clientError?.message ?? ''); process.exit(1) }

let user = null
for (let page = 1; page <= 20 && !user; page += 1) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
  if (error) { console.error('Falha ao listar usuários:', error.message); process.exit(1) }
  user = data.users.find((u) => (u.email ?? '').toLowerCase() === email) ?? null
  if (data.users.length < 1000) break
}

let created = false
if (user) {
  const role = user.app_metadata?.role
  if (role && role !== 'CLIENT') { console.error(`Usuário já existe com papel ${role}; nada alterado.`); process.exit(1) }
  if (!role) {
    const { error } = await admin.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, role: 'CLIENT' } })
    if (error) { console.error('Falha ao definir papel CLIENT:', error.message); process.exit(1) }
  }
  console.log('Usuário reutilizado (senha preservada).')
} else {
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: { role: 'CLIENT' }, user_metadata: { client: slug },
  })
  if (error) { console.error('Falha ao criar usuário:', error.message); process.exit(1) }
  user = data.user; created = true
  console.log('Usuário criado com e-mail confirmado e papel CLIENT.')
}

const { data: membership } = await admin.from('memberships').select('user_id').eq('user_id', user.id).eq('client_id', client.id).maybeSingle()
if (!membership) {
  const { error } = await admin.from('memberships').insert({ user_id: user.id, client_id: client.id, role: 'CLIENT' })
  if (error) {
    if (created) await admin.auth.admin.deleteUser(user.id)
    console.error('Falha ao criar membership:', error.message); process.exit(1)
  }
  console.log('Membership CLIENT criada para', client.name)
} else {
  console.log('Membership já existia para', client.name)
}
console.log(JSON.stringify({ user_id: user.id, email, client_id: client.id, created }, null, 2))
