# Prepara a assinatura do no.fiscal em producao. Quem roda: Lucca. Molde: preparar-producao.ps1 (auditor).
# Funciona no Windows PowerShell 5.1 e no PowerShell 7. Nao grava nenhum valor em arquivo.
# O que faz, sem repetir o que ja existe:
#   1. le os nomes dos secrets que ja estao no Supabase do site;
#   2. gera o usuario/senha do webhook fiscal (so se ainda nao existirem);
#   3. cria os planos no Pagar.me por grupo (4 mensais, 4 anuais), so o grupo que nao existir; pede a sk_ de producao;
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

# 3. planos, por grupo: os 4 mensais (22/10/2026) e os 4 anuais (03/11/2026, 20% off, cobranca anual)
$grupos = @(
  @{ Nome = 'mensais'; Codigos = @('inicial', 'pro', 'inicial_sem_teste', 'pro_sem_teste');
     Envs = @('PAGARME_PLANO_FISCAL_INICIAL_ID', 'PAGARME_PLANO_FISCAL_PRO_ID', 'PAGARME_PLANO_FISCAL_INICIAL_SEM_TESTE_ID', 'PAGARME_PLANO_FISCAL_PRO_SEM_TESTE_ID') },
  @{ Nome = 'anuais'; Codigos = @('inicial_anual', 'pro_anual', 'inicial_anual_sem_teste', 'pro_anual_sem_teste');
     Envs = @('PAGARME_PLANO_FISCAL_INICIAL_ANUAL_ID', 'PAGARME_PLANO_FISCAL_PRO_ANUAL_ID', 'PAGARME_PLANO_FISCAL_INICIAL_ANUAL_SEM_TESTE_ID', 'PAGARME_PLANO_FISCAL_PRO_ANUAL_SEM_TESTE_ID') }
)
# Checa todos os grupos antes de criar qualquer plano: grupo pela metade para tudo, sem nada criado.
foreach ($g in $grupos) {
  $faltando = @($g.Envs | Where-Object { -not (Tem $_) })
  if ($faltando.Count -ne 0 -and $faltando.Count -ne 4) { throw ("Faltam so alguns planos $($g.Nome) (" + ($faltando -join ', ') + "). Para nao duplicar, nada foi criado.") }
}
$sk = $null
try {
  foreach ($g in $grupos) {
    $faltando = @($g.Envs | Where-Object { -not (Tem $_) })
    if ($faltando.Count -eq 0) { Write-Host "Os 4 planos $($g.Nome) ja estao gravados: nenhum plano novo criado."; continue }
    if ($Ensaio) { foreach ($n in $g.Envs) { $novos[$n] = 'plan_ENSAIO' }; continue }
    if (-not $sk) {
      $sk = Ler-Chave 'Cole a chave SECRETA de producao do Pagar.me (comeca com sk_, nao sk_test_) e tecle Enter'
      if (-not $sk.StartsWith('sk_') -or $sk.StartsWith('sk_test_')) { throw 'Essa nao e uma chave secreta de producao (precisa comecar com sk_ e nao com sk_test_). Nada foi gravado.' }
    }
    $env:PAGARME_SECRET_KEY = $sk
    $ErrorActionPreference = 'Continue'
    try { $saida = & node (Join-Path $Repo 'scripts\pagarme-assinatura\criar-planos-fiscal.mjs') @($g.Codigos) 2>&1 }
    finally {
      $ErrorActionPreference = 'Stop'
      Remove-Item Env:PAGARME_SECRET_KEY -ErrorAction SilentlyContinue }
    foreach ($linha in @($saida)) { if ("$linha" -match '^(PAGARME_PLANO_FISCAL_[A-Z_]+_ID)=(plan_\w+)$') { $novos[$Matches[1]] = $Matches[2] } }
    $criados = @($g.Envs | Where-Object { $novos.Contains($_) })
    if ($criados.Count -ne 4) {
      # Grava o que ja foi criado (grupos anteriores inteiros e este pela metade) para nao duplicar ao rodar de novo.
      $feitos = @($novos.Keys | Where-Object { $_ -like 'PAGARME_PLANO_FISCAL_*' } | ForEach-Object { "$_=$($novos[$_])" })
      if ($feitos.Count -gt 0) { Supa (@('secrets', 'set', '--project-ref', $Projeto) + $feitos) | Out-Null }
      $parciais = @($novos.Keys | Where-Object { $_ -like 'PAGARME_PLANO_FISCAL_*' } | ForEach-Object { "$_=$($novos[$_])" })
      throw ("Os planos $($g.Nome) nao foram todos criados: " + (($saida | Where-Object { "$_" -notmatch '^PAGARME_PLANO' }) -join ' ') +
        ". Os ja criados foram gravados nos secrets: " + ($parciais -join ', ') + ". Confira no Pagar.me antes de rodar de novo.")
    }
    Write-Host "Planos $($g.Nome) criados no Pagar.me: Inicial e Pro, com e sem teste."
  }
} finally { $sk = $null }

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
