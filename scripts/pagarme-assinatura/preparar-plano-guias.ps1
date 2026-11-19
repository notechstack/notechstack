# Cria o plano "no.fiscal Guias" no Pagar.me de producao e grava PAGARME_PLANO_FISCAL_GUIAS_ID no Supabase.
# Quem roda: Lucca. Molde: preparar-producao-fiscal.ps1. Funciona no Windows PowerShell 5.1 e no PowerShell 7.
# Nao grava nenhum valor em arquivo. O plano: mensal, R$ 197,00, sem teste, fatura do cartao NOFISCALGUIAS
# (corpoDoPlanoGuias em supabase/functions/assinatura-fiscal-guias/core.ts).
# Se o secret ja existe, nao cria outro plano (para nao duplicar).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\pagarme-assinatura\preparar-plano-guias.ps1
# -Ensaio: nao fala com Supabase nem Pagar.me (so mostra o que faria).
param([switch]$Ensaio)
$ErrorActionPreference = 'Stop'
$Projeto = 'sdeowbqmwkwseyktyemn'
$Variavel = 'PAGARME_PLANO_FISCAL_GUIAS_ID'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Repo

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

Write-Host "== Plano no.fiscal Guias em producao (projeto $Projeto) ==" -ForegroundColor Cyan

$json = Supa @('secrets', 'list', '--project-ref', $Projeto, '--output', 'json')
try { $lista = $json | ConvertFrom-Json } catch { throw "Nao consegui ler a lista de secrets do Supabase: $json" }
$existentes = @($lista | ForEach-Object { $_.name } | Where-Object { $_ })
foreach ($n in @('PAGARME_SECRET_KEY', 'PAGARME_ASSINATURA_AMBIENTE')) {
  if (-not $Ensaio -and -not ($existentes -contains $n)) { throw "Falta o secret $n no Supabase. Nada foi criado." }
}
if ($existentes -contains $Variavel) {
  Write-Host "$Variavel ja esta gravado: nenhum plano novo criado." -ForegroundColor Yellow
  return
}

$id = $null
if ($Ensaio) { $id = 'plan_ENSAIO' } else {
  $sk = Ler-Chave 'Cole a chave SECRETA de producao do Pagar.me (comeca com sk_, nao sk_test_) e tecle Enter'
  if (-not $sk.StartsWith('sk_') -or $sk.StartsWith('sk_test_')) { throw 'Essa nao e uma chave secreta de producao (precisa comecar com sk_ e nao com sk_test_). Nada foi criado.' }
  $env:PAGARME_SECRET_KEY = $sk
  $ErrorActionPreference = 'Continue'
  try { $saida = & node (Join-Path $Repo 'scripts\pagarme-assinatura\criar-plano-guias.mjs') 2>&1 }
  finally {
    $ErrorActionPreference = 'Stop'
    Remove-Item Env:PAGARME_SECRET_KEY -ErrorAction SilentlyContinue
    $sk = $null
  }
  foreach ($linha in @($saida)) { if ("$linha" -match "^$Variavel=(plan_\w+)$") { $id = $Matches[1] } }
  if (-not $id) { throw ("O plano nao foi criado: " + ($saida -join ' ')) }
}

Supa @('secrets', 'set', '--project-ref', $Projeto, "$Variavel=$id") | Out-Null
Write-Host "Plano criado e gravado no Supabase: $Variavel=$id" -ForegroundColor Green
Write-Host 'Confira no Pagar.me: Planos > no.fiscal Guias (mensal, R$ 197,00, sem teste, fatura NOFISCALGUIAS).'
Write-Host 'Depois: publicar as edge functions assinatura-fiscal-guias, assinatura-fiscal-webhook e assinatura-fiscal-ciclo.'
