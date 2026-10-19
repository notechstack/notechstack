# Prepara a assinatura do Auditor em producao (TASK-mvf9r6bxe5w). Quem roda: Lucca.
# Funciona no Windows PowerShell 5.1 e no PowerShell 7. Nao grava nenhum valor em arquivo.
# O que faz, sem repetir o que ja existe:
#   1. le os nomes dos secrets que ja estao no Supabase do site;
#   2. gera DIAG_IP_SALT e o usuario/senha do webhook (so se ainda nao existirem);
#   3. pede a chave publica pk_ de producao (so se ainda nao existir);
#   4. cria os 3 planos no Pagar.me (so se nenhum existir; pede a sk_ de producao);
#   5. grava todos os secrets de uma vez; 6. publica as 2 funcoes da assinatura;
#   7. mostra o que cadastrar no webhook do Pagar.me.
# Uso: powershell -ExecutionPolicy Bypass -File "C:\Users\lucca\AppData\Local\NoAgentic\v0.1\work\auditor-assinatura-pagarme\repo\scripts\pagarme-assinatura\preparar-producao.ps1"
# -Ensaio: nao fala com Supabase nem Pagar.me (so mostra o que faria). -NovoWebhook: gera usuario/senha novos.
param([switch]$Ensaio, [switch]$NovoWebhook)
$ErrorActionPreference = 'Stop'
$Projeto = 'sdeowbqmwkwseyktyemn'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Repo

function Novo-Hex([int]$n) {
  $b = New-Object byte[] $n
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  -join ($b | ForEach-Object { $_.ToString('x2') })
}

# O parametro NAO pode se chamar $ensaio: PowerShell ignora maiusculas e ele esconderia o -Ensaio do script
# (foi assim que a pk_ENSAIO foi gravada no ar em 19/10).
function Ler-Chave([string]$pergunta, [string]$valorEnsaio) {
  if ($script:Ensaio) { return $valorEnsaio }
  $s = Read-Host -AsSecureString $pergunta
  $p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }
}

function Supa([string[]]$a) {
  if ($Ensaio) {
    $vis = $a | ForEach-Object { if ($_ -match '^[A-Z_]+=') { ($_ -split '=', 2)[0] + '=***' } else { $_ } }
    Write-Host ('[ensaio] supabase ' + ($vis -join ' '))
    return '[]'
  }
  $ErrorActionPreference = 'Continue'
  $saida = & supabase @a 2>&1
  $codigo = $LASTEXITCODE
  # Token velho numa variavel de ambiente vence o 'supabase login': tira so desta janela e tenta de novo.
  if ($codigo -ne 0 -and ($saida -join ' ') -match '401|Invalid access token' -and $env:SUPABASE_ACCESS_TOKEN) {
    Remove-Item Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue
    $saida = & supabase @a 2>&1
    $codigo = $LASTEXITCODE
  }
  # Login vencido: o proprio roteiro abre o login do Supabase e tenta de novo, uma vez.
  if ($codigo -ne 0 -and ($saida -join ' ') -match '401|Invalid access token|access token' -and -not $script:JaLogou) {
    $script:JaLogou = $true
    Write-Host 'O login do Supabase deste PC venceu. Vou abrir o login: no navegador, clique em Authorize e volte aqui.' -ForegroundColor Yellow
    & supabase login 2>&1 | Out-Host
    $saida = & supabase @a 2>&1
    $codigo = $LASTEXITCODE
  }
  # CLI antiga nao conhece --use-api: publica sem ele.
  if ($codigo -ne 0 -and $a -contains '--use-api' -and ($saida -join ' ') -match 'unknown flag') {
    $semApi = @($a | Where-Object { $_ -ne '--use-api' })
    $saida = & supabase @semApi 2>&1
    $codigo = $LASTEXITCODE
  }
  $ErrorActionPreference = 'Stop'
  if ($codigo -ne 0) {
    if (($saida -join ' ') -match '401|Invalid access token|access token') {
      throw "O Supabase recusou o login. Em supabase.com/dashboard/account/tokens clique em Generate new token, copie e rode:  supabase login --token COLE_AQUI   e depois rode este script de novo."
    }
    throw "O comando 'supabase $($a[0]) $($a[1])' falhou: $($saida -join ' ')"
  }
  return (@($saida | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n")
}

Write-Host "== Auditor em producao (projeto $Projeto) ==" -ForegroundColor Cyan

# 1. nomes que ja existem
$json = Supa @('secrets', 'list', '--project-ref', $Projeto, '--output', 'json')
try { $lista = $json | ConvertFrom-Json } catch { throw "Nao consegui ler a lista de secrets do Supabase. Mande esta mensagem ao Dwight: $json" }
$existentes = @($lista | ForEach-Object { $_.name } | Where-Object { $_ })
Write-Host ("Secrets ja gravados: " + $existentes.Count)
function Tem([string]$n) { return $existentes -contains $n }

$novos = [ordered]@{}

# 2. sal do diagnostico e webhook
if (-not (Tem 'DIAG_IP_SALT')) { $novos['DIAG_IP_SALT'] = Novo-Hex 32 } else { Write-Host 'DIAG_IP_SALT ja existe: mantido (nao trocar).' }
$webUser = $null; $webPass = $null
if ($NovoWebhook -or -not (Tem 'PAGARME_ASSINATURA_WEBHOOK_USER') -or -not (Tem 'PAGARME_ASSINATURA_WEBHOOK_PASS')) {
  $webUser = 'no-auditor-' + (Novo-Hex 4)
  $webPass = Novo-Hex 24
  $novos['PAGARME_ASSINATURA_WEBHOOK_USER'] = $webUser
  $novos['PAGARME_ASSINATURA_WEBHOOK_PASS'] = $webPass
} else { Write-Host 'Usuario e senha do webhook ja existem: mantidos. Para gerar novos, rode com -NovoWebhook.' }

# 3. chave publica
if (-not (Tem 'PAGARME_ASSINATURA_PUBLIC_KEY')) {
  $pk = Ler-Chave 'Cole a chave PUBLICA de producao do Pagar.me (comeca com pk_) e tecle Enter' 'pk_ENSAIO'
  if (-not $pk.StartsWith('pk_') -or $pk.StartsWith('pk_test_')) { throw 'Essa nao e uma chave publica de producao (precisa comecar com pk_ e nao com pk_test_). Nada foi gravado.' }
  $novos['PAGARME_ASSINATURA_PUBLIC_KEY'] = $pk
}
$novos['PAGARME_ASSINATURA_AMBIENTE'] = 'producao'
$novos['AUDITOR_VENDA_ABERTA'] = 'sim'

# 4. planos
$nomesPlano = @('PAGARME_PLANO_MENSAL_ID', 'PAGARME_PLANO_SEMANAL_ID', 'PAGARME_PLANO_AGENCIA_ID')
$faltando = @($nomesPlano | Where-Object { -not (Tem $_) })
if ($faltando.Count -eq 3) {
  if ($Ensaio) {
    foreach ($n in $nomesPlano) { $novos[$n] = 'plan_ENSAIO' }
  } else {
    $sk = Ler-Chave 'Cole a chave SECRETA de producao do Pagar.me (comeca com sk_, a mesma da PAGARME_SECRET_KEY) e tecle Enter' ''
    if (-not $sk.StartsWith('sk_') -or $sk.StartsWith('sk_test_')) { throw 'Essa nao e uma chave secreta de producao (precisa comecar com sk_ e nao com sk_test_). Nada foi gravado.' }
    $env:PAGARME_ASSINATURA_AMBIENTE = 'producao'
    $env:PAGARME_SECRET_KEY = $sk
    $ErrorActionPreference = 'Continue'
    try { $saida = & node (Join-Path $Repo 'scripts\pagarme-assinatura\criar-planos-sandbox.mjs') 2>&1 }
    finally {
      $ErrorActionPreference = 'Stop'
      Remove-Item Env:PAGARME_SECRET_KEY -ErrorAction SilentlyContinue; Remove-Item Env:PAGARME_ASSINATURA_AMBIENTE -ErrorAction SilentlyContinue; $sk = $null }
    foreach ($linha in @($saida)) { if ("$linha" -match '^(PAGARME_PLANO_[A-Z]+_ID)=(plan_\w+)$') { $novos[$Matches[1]] = $Matches[2] } }
    $criados = @($nomesPlano | Where-Object { $novos.Contains($_) })
    if ($criados.Count -ne 3) { throw ("Os planos nao foram criados: " + ($saida -join ' ') + ". Nada foi gravado. Mande essa mensagem ao Dwight.") }
    Write-Host 'Planos criados no Pagar.me: Mensal, Semanal e Agencia.'
  }
} elseif ($faltando.Count -gt 0) {
  throw ("Faltam so alguns planos (" + ($faltando -join ', ') + "). Para nao duplicar, nada foi criado. Chame o Dwight.")
} else { Write-Host 'Os 3 planos ja estao gravados: nenhum plano novo criado.' }

# 5. grava tudo de uma vez
$pares = @($novos.Keys | ForEach-Object { "$_=$($novos[$_])" })
Supa (@('secrets', 'set', '--project-ref', $Projeto) + $pares) | Out-Null
Write-Host ('Secrets gravados: ' + (($novos.Keys) -join ', ')) -ForegroundColor Green

# 6. funcoes da assinatura (precisam das 2 migrations ja rodadas)
foreach ($f in @('assinatura-auditor', 'assinatura-auditor-webhook')) {
  Supa @('functions', 'deploy', $f, '--project-ref', $Projeto, '--use-api') | Out-Null
  Write-Host "Funcao publicada: $f" -ForegroundColor Green
}

# 7. webhook no Pagar.me
Write-Host ''
Write-Host '== Agora no Pagar.me: Configuracoes > Webhooks > Criar webhook ==' -ForegroundColor Cyan
Write-Host "URL:     https://$Projeto.supabase.co/functions/v1/assinatura-auditor-webhook"
if ($webUser) {
  Write-Host "Usuario: $webUser"
  Write-Host "Senha:   $webPass"
  if (-not $Ensaio) { Set-Clipboard -Value $webPass; Write-Host '(a senha ja esta copiada: e so colar)' }
} else { Write-Host 'Usuario e senha: os que voce ja cadastrou antes (nao mudaram).' }
Write-Host 'Eventos: invoice.paid, charge.paid, invoice.payment_failed, charge.payment_failed, subscription.payment_failed, subscription.canceled'
Write-Host 'Pronto. Avise o Dwight para conferir.' -ForegroundColor Green
