# Prepara a assinatura do no.fiscal em producao. Quem roda: Lucca. Molde: preparar-producao.ps1 (auditor).
# Funciona no Windows PowerShell 5.1 e no PowerShell 7. Nao grava nenhum valor em arquivo.
# O que faz, sem repetir o que ja existe:
#   1. le os nomes dos secrets que ja estao no Supabase do site;
#   2. gera o usuario/senha do webhook fiscal (so se ainda nao existirem);
#   3. cria os 4 planos no Pagar.me (so se nenhum existir; pede a sk_ de producao);
#   4. grava os secrets de uma vez; 5. mostra o que cadastrar no webhook do Pagar.me.
# NAO grava FISCAL_VENDA_ABERTA nem publica funcao: isso vem depois do teste.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\pagarme-assinatura\preparar-producao-fiscal.ps1
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

function Ler-Chave([string]$pergunta) {
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
  $ErrorActionPreference = 'Stop'
  if ($codigo -ne 0) {
    if (($saida -join ' ') -match '401|Invalid access token|access token') {
      throw "O Supabase recusou o login. Rode 'supabase login', autorize no navegador e rode este script de novo."
    }
    throw "O comando 'supabase $($a[0]) $($a[1])' falhou: $($saida -join ' ')"
  }
  return (@($saida | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n")
}

Write-Host "== no.fiscal em producao (projeto $Projeto) ==" -ForegroundColor Cyan

# 1. nomes que ja existem
$json = Supa @('secrets', 'list', '--project-ref', $Projeto, '--output', 'json')
try { $lista = $json | ConvertFrom-Json } catch { throw "Nao consegui ler a lista de secrets do Supabase: $json" }
$existentes = @($lista | ForEach-Object { $_.name } | Where-Object { $_ })
Write-Host ("Secrets ja gravados: " + $existentes.Count)
function Tem([string]$n) { return $existentes -contains $n }

foreach ($n in @('PAGARME_SECRET_KEY', 'PAGARME_ASSINATURA_PUBLIC_KEY', 'PAGARME_ASSINATURA_AMBIENTE', 'FISCAL_TRIAL_SALT')) {
  if (-not $Ensaio -and -not (Tem $n)) { throw "Falta o secret $n no Supabase. Nada foi gravado." }
}

$novos = [ordered]@{}

# 2. webhook
$webUser = $null; $webPass = $null
if ($NovoWebhook -or -not (Tem 'PAGARME_FISCAL_WEBHOOK_USER') -or -not (Tem 'PAGARME_FISCAL_WEBHOOK_PASS')) {
  $webUser = 'no-fiscal-' + (Novo-Hex 4)
  $webPass = Novo-Hex 24
  $novos['PAGARME_FISCAL_WEBHOOK_USER'] = $webUser
  $novos['PAGARME_FISCAL_WEBHOOK_PASS'] = $webPass
} else { Write-Host 'Usuario e senha do webhook fiscal ja existem: mantidos. Para gerar novos, rode com -NovoWebhook.' }

# 3. planos
$nomesPlano = @('PAGARME_PLANO_FISCAL_INICIAL_ID', 'PAGARME_PLANO_FISCAL_PRO_ID', 'PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID', 'PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID')
$faltando = @($nomesPlano | Where-Object { -not (Tem $_) })
if ($faltando.Count -eq 4) {
  if ($Ensaio) {
    foreach ($n in $nomesPlano) { $novos[$n] = 'plan_ENSAIO' }
  } else {
    $sk = Ler-Chave 'Cole a chave SECRETA de producao do Pagar.me (comeca com sk_, nao sk_test_) e tecle Enter'
    if (-not $sk.StartsWith('sk_') -or $sk.StartsWith('sk_test_')) { throw 'Essa nao e uma chave secreta de producao (precisa comecar com sk_ e nao com sk_test_). Nada foi gravado.' }
    $env:PAGARME_SECRET_KEY = $sk
    $ErrorActionPreference = 'Continue'
    try { $saida = & node (Join-Path $Repo 'scripts\pagarme-assinatura\criar-planos-fiscal.mjs') 2>&1 }
    finally {
      $ErrorActionPreference = 'Stop'
      Remove-Item Env:PAGARME_SECRET_KEY -ErrorAction SilentlyContinue; $sk = $null }
    foreach ($linha in @($saida)) { if ("$linha" -match '^(PAGARME_PLANO_FISCAL_[A-Z_]+_ID)=(plan_\w+)$') { $novos[$Matches[1]] = $Matches[2] } }
    $criados = @($nomesPlano | Where-Object { $novos.Contains($_) })
    if ($criados.Count -ne 4) {
      $parciais = @($novos.Keys | Where-Object { $_ -like 'PAGARME_PLANO_FISCAL_*' } | ForEach-Object { "$_=$($novos[$_])" })
      throw ("Os planos nao foram todos criados: " + (($saida | Where-Object { "$_" -notmatch '^PAGARME_PLANO' }) -join ' ') +
        ". Nada foi gravado. Criados no Pagar.me (apague ou aproveite): " + ($parciais -join ', '))
    }
    Write-Host 'Planos criados no Pagar.me: Inicial e Pro, com e sem teste.'
  }
} elseif ($faltando.Count -gt 0) {
  throw ("Faltam so alguns planos (" + ($faltando -join ', ') + "). Para nao duplicar, nada foi criado.")
} else { Write-Host 'Os 4 planos ja estao gravados: nenhum plano novo criado.' }

# 4. grava tudo de uma vez
if ($novos.Count -gt 0) {
  $pares = @($novos.Keys | ForEach-Object { "$_=$($novos[$_])" })
  Supa (@('secrets', 'set', '--project-ref', $Projeto) + $pares) | Out-Null
  Write-Host ('Secrets gravados: ' + (($novos.Keys) -join ', ')) -ForegroundColor Green
} else { Write-Host 'Nada novo para gravar.' }

# 5. webhook no Pagar.me
Write-Host ''
Write-Host '== Agora no Pagar.me: Configuracoes > Webhooks > Criar webhook ==' -ForegroundColor Cyan
Write-Host "URL:     https://$Projeto.supabase.co/functions/v1/assinatura-fiscal-webhook"
if ($webUser) {
  Write-Host "Usuario: $webUser"
  if (-not $Ensaio) { Set-Clipboard -Value $webPass; Write-Host 'Senha:   ja esta copiada (Ctrl+V no campo de senha). Nao aparece aqui de proposito.' }
  $webPass = $null
} else { Write-Host 'Usuario e senha: os que voce ja cadastrou antes (nao mudaram).' }
Write-Host 'Eventos: invoice.paid, charge.paid, invoice.payment_failed, charge.payment_failed, subscription.canceled'
Write-Host 'Pronto. Avise o Claude para conferir.' -ForegroundColor Green
