# Liga o motor do no.fiscal em producao, de uma vez. Quem roda: Lucca. Molde: scripts\pagarme-assinatura\preparar-producao-fiscal.ps1.
# Funciona no Windows PowerShell 5.1 e no PowerShell 7. Nenhum valor e gravado em arquivo nem mostrado na tela.
#
# O que faz:
#   1. gera o que da para gerar: senhas dos papeis nofiscal_service e nofiscal_onboarding, CRON_SECRET,
#      WHATSAPP_VERIFY_TOKEN e um FISCAL_TRIAL_SALT novo (o mesmo vai para o Supabase e para o app);
#   2. pede so o que vem de fora (colar e Enter, sem aparecer): token e app secret do WhatsApp, id do numero,
#      chave da Anthropic e chave da Resend; confere cada um na API dona antes de gravar qualquer coisa;
#   3. banco: liga o login dos dois papeis e grava no Vault o endereco e o segredo do worker;
#   4. testa a conexao dos dois papeis pelo pooler e monta NOFISCAL_DATABASE_URL e NOFISCAL_ONBOARDING_DATABASE_URL;
#   5. Supabase: FISCAL_AMBIENTE_PADRAO=producao e o FISCAL_TRIAL_SALT novo;
#   6. Vercel (notechstack-app, Production): todas as variaveis numa chamada so, e um redeploy para valerem;
#   7. mostra o que cadastrar no webhook do WhatsApp (o verify token vai para a area de transferencia).
#
# Uso:   powershell -ExecutionPolicy Bypass -File scripts\nofiscal-motor\preparar-motor.ps1
#        -Ensaio                      nao fala com nada; mostra o que faria, com valores trocados por ***
#        -ContasExistentesEmProducao  passa para producao as contas ja criadas em producao_restrita
#        -NovoWebhookPagarme          no fim, roda preparar-producao-fiscal.ps1 -NovoWebhook (senha do webhook igual a sk_)
param([switch]$Ensaio, [switch]$ContasExistentesEmProducao, [switch]$NovoWebhookPagarme)
$ErrorActionPreference = 'Stop'
$Projeto = 'sdeowbqmwkwseyktyemn'
$VercelTime = 'team_78Up32KlXHEQKQxaegmjB33O'
$VercelProjeto = 'notechstack-app'
$AppUrl = 'https://app.notechstack.com.br'
$SiteFiscal = 'https://www.notechstack.com.br/agentes/fiscal/'
$NumeroAgente = '5511939289413'
$GraphVersao = 'v26.0'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Repo

function Novo-Hex([int]$n) {
  $b = New-Object byte[] $n
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  -join ($b | ForEach-Object { $_.ToString('x2') })
}

function Ler-Chave([string]$pergunta) {
  $s = Read-Host -AsSecureString $pergunta
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

# Supabase CLI: o global, ou o do npx quando nao houver.
$SupaCmd = @('supabase')
if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) { $SupaCmd = @('npx', '--yes', 'supabase') }

function Supa([string[]]$a, [switch]$Silencioso) {
  if ($Ensaio) {
    $vis = $a | ForEach-Object { if ($_ -match '^[A-Z_]+=') { ($_ -split '=', 2)[0] + '=***' } elseif ($_ -match 'password|create_secret|update_secret|postgresql://') { '<sql com segredo>' } else { $_ } }
    Write-Host ('[ensaio] supabase ' + ($vis -join ' '))
    return '[]'
  }
  $ErrorActionPreference = 'Continue'
  $exe = $SupaCmd[0]; $pre = @($SupaCmd | Select-Object -Skip 1)
  $saida = & $exe @($pre + $a) 2>&1
  $codigo = $LASTEXITCODE
  if ($codigo -ne 0 -and ($saida -join ' ') -match '401|Invalid access token' -and $env:SUPABASE_ACCESS_TOKEN) {
    Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
    $saida = & $exe @($pre + $a) 2>&1
    $codigo = $LASTEXITCODE
  }
  $ErrorActionPreference = 'Stop'
  if ($codigo -ne 0) {
    if ($Silencioso) { return $null }
    if (($saida -join ' ') -match '401|Invalid access token|access token') {
      throw "O Supabase recusou o login. Rode 'supabase login', autorize no navegador e rode este script de novo."
    }
    # Nunca repete o comando (pode ter senha); so o erro.
    throw ("O Supabase recusou '" + $a[0] + ' ' + $a[1] + "': " + (($saida | Where-Object { "$_" -notmatch 'postgresql://' }) -join ' '))
  }
  return (@($saida | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n")
}

function Sql([string]$consulta, [switch]$Silencioso) {
  return Supa @('db', 'query', '--linked', '--project-ref', $Projeto, $consulta) -Silencioso:$Silencioso
}

Write-Host "== Motor do no.fiscal em producao ==" -ForegroundColor Cyan
if ($Ensaio) { Write-Host '(ensaio: nada sera gravado)' -ForegroundColor Yellow }

# ---------- 1. gerados aqui ----------
$senhaService = Novo-Hex 24
$senhaOnboarding = Novo-Hex 24
$cronSecret = Novo-Hex 32
$verifyToken = Novo-Hex 24
$salTeste = Novo-Hex 32

# ---------- 2. o que vem de fora, conferido na API dona ----------
if ($Ensaio) {
  $waToken = 'ENSAIO'; $waAppSecret = 'ENSAIO'; $waPhoneId = '000000000000000'; $anthropic = 'ENSAIO'; $resend = 'ENSAIO'
} else {
  Write-Host ''
  Write-Host 'WhatsApp (Meta for Developers > seu app > WhatsApp > Configuracao da API; token permanente do usuario do sistema na BM):'
  $waPhoneId = (Read-Host 'Identificacao do numero de telefone (Phone number ID, so digitos)').Trim()
  if ($waPhoneId -notmatch '^\d{10,20}$') { throw 'O Phone number ID tem so digitos. Nada foi gravado.' }
  $waToken = Ler-Chave 'Cole o token de acesso PERMANENTE do WhatsApp e tecle Enter'
  try {
    $num = Invoke-RestMethod -Uri "https://graph.facebook.com/$GraphVersao/${waPhoneId}?fields=display_phone_number,verified_name,quality_rating" -Headers @{ Authorization = "Bearer $waToken" }
  } catch { throw 'A Meta recusou o token ou o Phone number ID (confira se o token e do usuario do sistema com whatsapp_business_messaging). Nada foi gravado.' }
  $digitos = ($num.display_phone_number -replace '\D', '')
  if (-not $digitos.EndsWith('11939289413')) { throw "Esse Phone number ID e do numero $($num.display_phone_number), nao do +55 11 93928-9413. Nada foi gravado." }
  Write-Host ("  ok: " + $num.display_phone_number + ' (' + $num.verified_name + ', qualidade ' + $num.quality_rating + ')') -ForegroundColor Green
  $waAppSecret = Ler-Chave 'Cole o App Secret do app da Meta que recebe o webhook (Configuracoes do app > Basico > Chave secreta do app)'
  if ($waAppSecret -notmatch '^[0-9a-f]{32}$') { throw 'O App Secret da Meta tem 32 caracteres hexadecimais. Nada foi gravado.' }

  $anthropic = Ler-Chave 'Cole a chave da Anthropic (comeca com sk-ant-)'
  try { Invoke-RestMethod -Uri 'https://api.anthropic.com/v1/models?limit=1' -Headers @{ 'x-api-key' = $anthropic; 'anthropic-version' = '2023-06-01' } | Out-Null }
  catch { throw 'A Anthropic recusou a chave. Nada foi gravado.' }
  Write-Host '  ok: chave da Anthropic aceita' -ForegroundColor Green

  $resend = Ler-Chave 'Cole a chave da Resend (comeca com re_)'
  try { $dom = Invoke-RestMethod -Uri 'https://api.resend.com/domains' -Headers @{ Authorization = "Bearer $resend" } }
  catch { throw 'A Resend recusou a chave. Nada foi gravado.' }
  $nos = @($dom.data | Where-Object { $_.name -eq 'notechstack.com.br' })
  if ($nos.Count -eq 0 -or $nos[0].status -ne 'verified') {
    Write-Host '  atencao: o dominio notechstack.com.br nao aparece verificado nessa conta da Resend; os e-mails saem de notas@notechstack.com.br' -ForegroundColor Yellow
  } else { Write-Host '  ok: chave da Resend aceita, dominio notechstack.com.br verificado' -ForegroundColor Green }
}

# Vercel: o token do 'vercel login' desta maquina.
$vercelToken = $null
if (-not $Ensaio) {
  $auth = Join-Path $env:APPDATA 'com.vercel.cli\Data\auth.json'
  if (Test-Path $auth) { try { $vercelToken = (Get-Content $auth -Raw | ConvertFrom-Json).token } catch { $vercelToken = $null } }
  if (-not $vercelToken) { $vercelToken = Ler-Chave 'Cole um token da Vercel (vercel.com/account/tokens)' }
  $VH = @{ Authorization = "Bearer $vercelToken" }
  try { $proj = Invoke-RestMethod -Uri "https://api.vercel.com/v9/projects/${VercelProjeto}?teamId=$VercelTime" -Headers $VH }
  catch { throw "A Vercel recusou o token ou nao achou o projeto $VercelProjeto. Rode 'npx vercel login' e tente de novo. Nada foi gravado." }
  Write-Host ('  ok: Vercel, projeto ' + $proj.name) -ForegroundColor Green
}

# ---------- 3. banco: login dos papeis e Vault do worker ----------
Write-Host ''
Write-Host 'Banco: ligando o login dos papeis e gravando o worker no Vault...'
function Vault-Sql([string]$nome, [string]$valor) {
  return "do `$`$ declare v uuid; begin select id into v from vault.secrets where name = '$nome'; " +
    "if v is null then perform vault.create_secret('$valor', '$nome'); else perform vault.update_secret(v, '$valor'); end if; end `$`$;"
}
Sql ("alter role nofiscal_service with login password '$senhaService'; " +
     "alter role nofiscal_onboarding with login password '$senhaOnboarding'; " +
     (Vault-Sql 'nofiscal_worker_url' $AppUrl) + ' ' + (Vault-Sql 'NOFISCAL_CRON_SECRET' $cronSecret)) | Out-Null
Write-Host '  ok: papeis com login e worker no Vault' -ForegroundColor Green

# ---------- 4. pooler: acha o host que aceita os papeis ----------
$urlService = $null; $urlOnboarding = $null
if ($Ensaio) {
  $urlService = 'postgresql://ENSAIO'; $urlOnboarding = 'postgresql://ENSAIO'
} else {
  foreach ($hostPooler in @('aws-0-us-east-2.pooler.supabase.com', 'aws-1-us-east-2.pooler.supabase.com')) {
    $candS = "postgresql://nofiscal_service.${Projeto}:$senhaService@${hostPooler}:6543/postgres"
    if (Supa @('db', 'query', '--db-url', $candS, 'select current_user') -Silencioso) {
      $urlService = $candS
      $urlOnboarding = "postgresql://nofiscal_onboarding.${Projeto}:$senhaOnboarding@${hostPooler}:6543/postgres"
      if (-not (Supa @('db', 'query', '--db-url', $urlOnboarding, 'select current_user') -Silencioso)) { throw "O papel nofiscal_onboarding nao conectou pelo pooler $hostPooler. O banco ja tem o login ligado; rode o script de novo." }
      Write-Host "  ok: os dois papeis conectam pelo pooler $hostPooler (modo transacao, 6543)" -ForegroundColor Green
      break
    }
  }
  if (-not $urlService) { throw 'Nenhum pooler aceitou o papel nofiscal_service. Copie o host em Supabase > Connect > Transaction pooler e avise o Claude.' }
}

# ---------- 5. Supabase ----------
Supa @('secrets', 'set', '--project-ref', $Projeto, 'FISCAL_AMBIENTE_PADRAO=producao', "FISCAL_TRIAL_SALT=$salTeste") | Out-Null
Write-Host '  ok: Supabase com FISCAL_AMBIENTE_PADRAO=producao e o FISCAL_TRIAL_SALT novo' -ForegroundColor Green
if ($ContasExistentesEmProducao) {
  Sql "update nofiscal.fiscal_tenants set ambiente = 'producao' where ambiente = 'producao_restrita'" | Out-Null
  Write-Host '  ok: contas existentes passadas para producao' -ForegroundColor Green
}

# ---------- 6. Vercel: tudo numa chamada e redeploy ----------
$segredo = 'sensitive'; $aberto = 'encrypted'
$vars = @(
  @{ key = 'NOFISCAL_DATABASE_URL'; value = $urlService; type = $segredo },
  @{ key = 'NOFISCAL_ONBOARDING_DATABASE_URL'; value = $urlOnboarding; type = $segredo },
  @{ key = 'CRON_SECRET'; value = $cronSecret; type = $segredo },
  @{ key = 'FISCAL_TRIAL_SALT'; value = $salTeste; type = $segredo },
  @{ key = 'WHATSAPP_ACCESS_TOKEN'; value = $waToken; type = $segredo },
  @{ key = 'WHATSAPP_APP_SECRET'; value = $waAppSecret; type = $segredo },
  @{ key = 'WHATSAPP_VERIFY_TOKEN'; value = $verifyToken; type = $segredo },
  @{ key = 'ANTHROPIC_API_KEY'; value = $anthropic; type = $segredo },
  @{ key = 'RESEND_API_KEY'; value = $resend; type = $segredo },
  @{ key = 'WHATSAPP_PHONE_NUMBER_ID'; value = $waPhoneId; type = $aberto },
  @{ key = 'WHATSAPP_NUMERO_AGENTE'; value = $NumeroAgente; type = $aberto },
  @{ key = 'SUPABASE_URL'; value = "https://$Projeto.supabase.co"; type = $aberto },
  @{ key = 'AGENTE_FISCAL_SITE_URL'; value = $SiteFiscal; type = $aberto }
)
# A chave anon (publica) e a mesma do site: config.js do no.fiscal.
$cfg = Get-Content (Join-Path $Repo 'agentes\fiscal\config.js') -Raw
if ($cfg -match "anonKey:\s*'([^']+)'") { $vars += @{ key = 'SUPABASE_ANON_KEY'; value = $Matches[1]; type = $aberto } }
else { throw 'Nao achei a anonKey em agentes\fiscal\config.js. Nada foi gravado na Vercel.' }

$corpo = @($vars | ForEach-Object { @{ key = $_.key; value = $_.value; type = $_.type; target = @('production') } })
if ($Ensaio) {
  Write-Host ('[ensaio] Vercel ' + $VercelProjeto + ' (Production): ' + (($vars | ForEach-Object { $_.key + '=***' }) -join ', '))
} else {
  $json = ConvertTo-Json -InputObject $corpo -Depth 4 -Compress
  try {
    Invoke-RestMethod -Method Post -Uri "https://api.vercel.com/v10/projects/${VercelProjeto}/env?upsert=true&teamId=$VercelTime" -Headers $VH -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
  } catch { throw ('A Vercel recusou as variaveis: ' + $_.Exception.Message + '. O banco e o Supabase ja foram gravados; rode o script de novo (ele refaz tudo).') }
  Write-Host ("  ok: " + $vars.Count + ' variaveis na Vercel (Production)') -ForegroundColor Green

  $dep = Invoke-RestMethod -Uri "https://api.vercel.com/v6/deployments?projectId=$($proj.id)&teamId=$VercelTime&target=production&state=READY&limit=1" -Headers $VH
  $ultimo = @($dep.deployments)[0]
  if (-not $ultimo) { throw 'Nao achei o deploy de producao do app para refazer. Faca um Redeploy no painel da Vercel.' }
  $novo = Invoke-RestMethod -Method Post -Uri "https://api.vercel.com/v13/deployments?teamId=$VercelTime&forceNew=1" -Headers $VH -ContentType 'application/json' -Body (ConvertTo-Json @{ name = $VercelProjeto; deploymentId = $ultimo.uid; target = 'production' } -Compress)
  Write-Host ('  ok: redeploy de producao iniciado (' + $novo.url + ')') -ForegroundColor Green
}
$senhaService = $null; $senhaOnboarding = $null; $cronSecret = $null; $salTeste = $null
$waToken = $null; $waAppSecret = $null; $anthropic = $null; $resend = $null; $urlService = $null; $urlOnboarding = $null; $vercelToken = $null

# ---------- 7. webhook do WhatsApp ----------
Write-Host ''
Write-Host '== Agora na Meta: seu app > WhatsApp > Configuracao > Webhook > Editar ==' -ForegroundColor Cyan
Write-Host "URL de callback: $AppUrl/api/whatsapp/webhook"
if (-not $Ensaio) { Set-Clipboard -Value $verifyToken; Write-Host 'Verificar token: ja esta copiado (Ctrl+V). Nao aparece aqui de proposito.' }
$verifyToken = $null
Write-Host 'Depois de verificar e salvar: em Campos do webhook, assine "messages".'
Write-Host 'Espere o redeploy terminar (1 a 2 minutos) antes de clicar em Verificar e salvar.'

if ($NovoWebhookPagarme) {
  Write-Host ''
  Read-Host 'Quando terminar na Meta, tecle Enter para trocar a senha do webhook do Pagar.me'
  $arg = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Repo 'scripts\pagarme-assinatura\preparar-producao-fiscal.ps1'), '-NovoWebhook')
  if ($Ensaio) { $arg += '-Ensaio' }
  & powershell @arg
}
Write-Host ''
Write-Host 'Pronto. Avise o Claude para conferir.' -ForegroundColor Green
