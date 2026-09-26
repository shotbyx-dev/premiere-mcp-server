# install-windows.ps1 — premiere-mcp-server Windows installer
# Created by Shotbyx.
#
# Installs: Node.js 20+ (via winget if missing), npm dependencies, the Premiere
# CEP bridge panel (+ After Effects panel when present), PlayerDebugMode, the
# bridge temp dir, a bearer token (.env), and a logon scheduled task.
# With -TunnelToken, also installs cloudflared (via winget) as a Windows service.
#
# Usage:
#   .\install-windows.ps1
#   .\install-windows.ps1 -TunnelToken "<token>" -PublicHostname "mcp.example.com"

param(
  [string]$TunnelToken = "",
  [string]$PublicHostname = "",
  [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "  premiere-mcp-server installer" -ForegroundColor Cyan
Write-Host "  Created by Shotbyx" -ForegroundColor DarkGray
Write-Host ""

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CepTarget = Join-Path $env:APPDATA "Adobe\CEP\extensions\MCPBridgeCEP"
$BridgeTemp = Join-Path $env:TEMP "premiere-mcp-bridge"
$EnvFile = Join-Path $RepoRoot ".env"

function Require-Node {
  $found = $false
  try {
    $v = (& node --version 2>$null).ToString().Trim()
    $major = [int]($v.TrimStart('v').Split('.')[0])
    if ($major -ge 20) { $found = $true; Write-Host "  Node.js $v found." -ForegroundColor Green }
  } catch { }
  if (-not $found) {
    Write-Host "  Installing Node.js LTS via winget (may prompt)..." -ForegroundColor Cyan
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $v = (& node --version).ToString().Trim()
    Write-Host "  Node.js $v installed." -ForegroundColor Green
  }
}

function Install-ServerDeps {
  Write-Host "  Installing npm dependencies..." -ForegroundColor Cyan
  Push-Location $RepoRoot
  try {
    & npm install --no-audit --no-fund
    & npm run build
  } finally { Pop-Location }
  Write-Host "  Server built." -ForegroundColor Green
}

function Install-CepPanel {
  Write-Host "  Installing Premiere CEP bridge panel..." -ForegroundColor Cyan
  $src = Join-Path $RepoRoot "cep\premiere"
  if (-not (Test-Path $src)) { throw "CEP panel source missing: $src" }
  New-Item -ItemType Directory -Force -Path $CepTarget | Out-Null
  Copy-Item (Join-Path $src '*') -Destination $CepTarget -Recurse -Force
  Write-Host "  Panel installed." -ForegroundColor Green
  for ($n = 9; $n -le 15; $n++) {
    $key = "HKCU:\Software\Adobe\CSXS.$n"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name "PlayerDebugMode" -Value "1" -Type String -Force
  }
  Write-Host "  PlayerDebugMode enabled (CSXS 9-15)." -ForegroundColor Green
  $aeSrc = Join-Path $RepoRoot "cep\aftereffects\mcp-bridge-auto.jsx"
  if (Test-Path $aeSrc) {
    $aeBase = Get-ChildItem "C:\Program Files\Adobe" -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like "Adobe After Effects*" } |
      Sort-Object Name -Descending | Select-Object -First 1
    if ($aeBase) {
      $aePanels = Join-Path $aeBase.FullName "Support Files\Scripts\ScriptUI Panels"
      New-Item -ItemType Directory -Force -Path $aePanels | Out-Null
      Copy-Item $aeSrc -Destination (Join-Path $aePanels "mcp-bridge-auto.jsx") -Force
      Write-Host "  After Effects bridge panel installed." -ForegroundColor Green
    } else {
      Write-Host "  After Effects not found - copy cep\aftereffects\mcp-bridge-auto.jsx to <AE>\Support Files\Scripts\ScriptUI Panels manually." -ForegroundColor Yellow
    }
  }
}

function Ensure-BridgeTempDir {
  New-Item -ItemType Directory -Force -Path $BridgeTemp | Out-Null
  Write-Host "  Bridge temp dir ready." -ForegroundColor Green
}

function Ensure-Token {
  $token = ""
  if (Test-Path $EnvFile) {
    $line = Select-String -Path $EnvFile -Pattern '^PREMIERE_MCP_TOKEN=(.*)$' | Select-Object -First 1
    if ($line) { $token = $line.Matches.Groups[1].Value.Trim() }
  }
  if (-not $token) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = [Convert]::ToHexString($bytes).ToLower()
    "PREMIERE_MCP_TOKEN=$token" | Out-File -FilePath $EnvFile -Encoding ascii -Append
    Write-Host "  Generated bearer token." -ForegroundColor Green
  } else {
    Write-Host "  Existing bearer token kept." -ForegroundColor Green
  }
  if (-not (Select-String -Path $EnvFile -Pattern '^PORT=' -Quiet)) {
    "PORT=$Port" | Out-File -FilePath $EnvFile -Encoding ascii -Append
  }
}

function Install-ScheduledTask {
  $taskName = "PremiereMCPServer"
  schtasks /query /tn $taskName 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { schtasks /delete /tn $taskName /f | Out-Null }
  $indexJs = Join-Path $RepoRoot "dist\index.js"
  $nodePath = (Get-Command node).Source
  $action = "`"$nodePath`" `"$indexJs`""
  schtasks /create /tn $taskName /tr $action /sc onlogon /rl limited /f | Out-Null
  $xml = (schtasks /query /tn $taskName /xml) -join "`n"
  if ($xml -notmatch '<WorkingDirectory>') {
    $xml = $xml -replace '(<Exec>)', ('$1<WorkingDirectory>' + $RepoRoot + '</WorkingDirectory>')
  }
  $tmpXml = Join-Path $env:TEMP "premiere-mcp-task.xml"
  $xml | Out-File -FilePath $tmpXml -Encoding utf8
  schtasks /create /tn $taskName /xml $tmpXml /f | Out-Null
  Remove-Item $tmpXml -Force
  Write-Host "  Scheduled task 'PremiereMCPServer' runs at logon." -ForegroundColor Green
}

function Install-Cloudflared([string]$token, [string]$hostname) {
  Write-Host "  Installing cloudflared via winget..." -ForegroundColor Cyan
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path', 'User')
  if ($token) {
    Write-Host "  Installing cloudflared tunnel service..." -ForegroundColor Cyan
    & cloudflared service install $token
    Write-Host "  Tunnel service installed." -ForegroundColor Green
    Write-Host ("  In the Cloudflare dashboard, route " + $hostname + " to localhost port " + $Port) -ForegroundColor Green
  } else {
    Write-Host "  cloudflared installed (no tunnel token given)." -ForegroundColor Yellow
  }
}

Require-Node
Install-ServerDeps
Install-CepPanel
Ensure-BridgeTempDir
Ensure-Token
Install-ScheduledTask
if ($TunnelToken -or $PublicHostname) { Install-Cloudflared $TunnelToken $PublicHostname }

Write-Host ""
Write-Host "  Done. Next steps:" -ForegroundColor Cyan
Write-Host "  1. In Premiere: Window > Extensions > MCP Bridge (CEP) - bridge starts automatically."
Write-Host "     In After Effects: the MCP Bridge Auto panel opens from Window menu; keep auto-run ON."
Write-Host "  2. Keep this PC awake and signed in to Adobe CC."
Write-Host ("  3. Health check on 127.0.0.1 port " + $Port + " path /health")
Write-Host "  4. Your bearer token is in the repo .env file - keep it secret."
if ($PublicHostname) { Write-Host ("  5. Public MCP path: /mcp on " + $PublicHostname) }
Write-Host ""
Write-Host "  Created by Shotbyx" -ForegroundColor DarkGray
