# install-windows.ps1 — PremierePilot by Shotbyx (premiere-mcp-server) Windows installer
# Created by Shotbyx.
#
# One-click installer. Steps:
#   1. Preflight checks (Windows 10 1809+/11, winget, Premiere Pro present)
#   2. Node.js 20 LTS (via winget if missing)
#   3. ffmpeg (via winget if missing) — needed for detect_beats audio decode
#   4. npm install + build
#   5. Premiere CEP bridge panel (+ After Effects ScriptUI panel when AE present)
#   6. PlayerDebugMode, bridge temp dir, bearer token (.env)
#   7. Logon scheduled task "PremiereMCPServer"
#   8. Server home dir %APPDATA%\PremierePilot (via pair.ps1 -Quiet)
#   9. Weekly auto-update check task "PremierePilotUpdateCheck"
#  10. Optional: cloudflared tunnel service (with -TunnelToken)
#
# Every step is idempotent — re-running the installer is safe.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
#   .\install-windows.ps1 -TunnelToken "<token>" -PublicHostname "mcp.example.com"
#   .\install-windows.ps1 -SkipAdobeCheck   # install server even without Premiere present
#   .\install-windows.ps1 -Uninstall         # remove tasks + panels (asks about tunnel)
#
# NOTE: PowerShell 5.1 compatible. No secrets are written anywhere except the
# local .env bearer token (never printed, never committed).

param(
  [string]$TunnelToken = "",
  [string]$PublicHostname = "",
  [int]$Port = 8787,
  [switch]$SkipAdobeCheck,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "  PremierePilot by Shotbyx — installer" -ForegroundColor Cyan
Write-Host "  Created by Shotbyx" -ForegroundColor DarkGray
Write-Host ""

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CepTarget = Join-Path $env:APPDATA "Adobe\CEP\extensions\MCPBridgeCEP"
$BridgeTemp = Join-Path $env:TEMP "premiere-mcp-bridge"
$EnvFile = Join-Path $RepoRoot ".env"
$ServerTaskName = "PremiereMCPServer"
$CreativeCloudUrl = "https://www.adobe.com/creativecloud/desktop-app.html"

# ---------------------------------------------------------------- preflight ---

function Show-PreflightError([string]$title, [string]$whatToDo) {
  Write-Host ""
  Write-Host ("  [X] " + $title) -ForegroundColor White -BackgroundColor Red
  Write-Host ("  What to do: " + $whatToDo) -ForegroundColor Yellow
  Write-Host ""
}

function Get-AdobeDir([string]$pattern) {
  $base = "C:\Program Files\Adobe"
  if (-not (Test-Path $base)) { return $null }
  $hit = Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like $pattern } |
    Sort-Object Name -Descending |
    Select-Object -First 1
  return $hit
}

function Invoke-Preflight {
  Write-Host "  Preflight checks..." -ForegroundColor Cyan
  $ok = $true

  # Windows 10 1809 (build 17763) or newer / Windows 11
  try {
    $build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
  } catch { $build = 0 }
  if ($build -lt 17763) {
    Show-PreflightError "Windows 10 version 1809 (build 17763) or newer is required." `
      "Update Windows via Settings > Windows Update, reboot, then re-run this installer."
    $ok = $false
  } else {
    Write-Host ("  Windows build " + $build + " OK.") -ForegroundColor Green
  }

  # winget
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Show-PreflightError "winget was not found on this PC." `
      "Install 'App Installer' from the Microsoft Store, then re-run this installer."
    $ok = $false
  } else {
    Write-Host "  winget found." -ForegroundColor Green
  }

  # Premiere Pro (required unless skipped)
  $pp = Get-AdobeDir "Adobe Premiere Pro*"
  if (-not $pp -and -not $SkipAdobeCheck) {
    Show-PreflightError "Adobe Premiere Pro was not found under C:\Program Files\Adobe." `
      ("Install it from " + $CreativeCloudUrl + ", then re-run — or re-run with -SkipAdobeCheck.")
    $ok = $false
  } elseif ($pp) {
    Write-Host ("  Premiere Pro found: " + $pp.Name) -ForegroundColor Green
  } else {
    Write-Host "  Premiere check skipped (-SkipAdobeCheck)." -ForegroundColor Yellow
  }

  # After Effects (optional — warn only)
  $ae = Get-AdobeDir "Adobe After Effects*"
  if (-not $ae) {
    Write-Host "  After Effects not found — Premiere-only mode. Install AE later and re-run to add its panel." -ForegroundColor Yellow
  } else {
    Write-Host ("  After Effects found: " + $ae.Name) -ForegroundColor Green
  }

  # Soft admin warning (not fatal: logon tasks work as standard user; winget may prompt for elevation)
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Write-Host "  Note: not running as Administrator — winget may show a UAC prompt." -ForegroundColor Yellow
  }

  if (-not $ok) { throw "Preflight checks failed. Fix the items above and re-run the installer." }
  Write-Host "  Preflight passed." -ForegroundColor Green
}

# ---------------------------------------------------------------- uninstall ---

function Invoke-Uninstall {
  Write-Host "  Uninstalling PremierePilot..." -ForegroundColor Cyan

  foreach ($t in @($ServerTaskName, "PremierePilotUpdateCheck")) {
    schtasks /query /tn $t 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      schtasks /delete /tn $t /f 2>$null | Out-Null
      Write-Host ("  Scheduled task '" + $t + "' removed.") -ForegroundColor Green
    } else {
      Write-Host ("  Scheduled task '" + $t + "' was not present.") -ForegroundColor DarkGray
    }
  }

  if (Test-Path $CepTarget) {
    Remove-Item -Recurse -Force $CepTarget -ErrorAction SilentlyContinue
    Write-Host "  Premiere CEP bridge panel removed." -ForegroundColor Green
  } else {
    Write-Host "  Premiere CEP bridge panel was not installed." -ForegroundColor DarkGray
  }

  $aeRemoved = $false
  $aeBase = Get-AdobeDir "Adobe After Effects*"
  if ($aeBase) {
    $aePanel = Join-Path $aeBase.FullName "Support Files\Scripts\ScriptUI Panels\mcp-bridge-auto.jsx"
    if (Test-Path $aePanel) {
      Remove-Item -Force $aePanel -ErrorAction SilentlyContinue
      $aeRemoved = $true
    }
  }
  if ($aeRemoved) { Write-Host "  After Effects bridge panel removed." -ForegroundColor Green }

  # Tunnel service: ask, don't assume
  if (Get-Command cloudflared -ErrorAction SilentlyContinue) {
    $svc = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
    if ($svc) {
      $ans = Read-Host "  cloudflared tunnel service is installed. Remove it too? [y/N]"
      if ($ans -match "^[Yy]") {
        & cloudflared service uninstall
        Write-Host "  cloudflared tunnel service removed (binary kept)." -ForegroundColor Green
      } else {
        Write-Host "  cloudflared tunnel service kept." -ForegroundColor Yellow
      }
    }
  }

  Write-Host ""
  Write-Host "  Uninstall complete." -ForegroundColor Cyan
  Write-Host "  Left in place (delete manually if you want a fully clean slate):" -ForegroundColor DarkGray
  Write-Host ("   - repo files and .env bearer token: " + $RepoRoot) -ForegroundColor DarkGray
  Write-Host ("   - server home dir: " + (Join-Path $env:APPDATA "PremierePilot")) -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  Created by Shotbyx" -ForegroundColor DarkGray
}

# ------------------------------------------------------------------ install ---

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

function Ensure-Ffmpeg {
  $found = $false
  try {
    & ffmpeg -version 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $found = $true; Write-Host "  ffmpeg found." -ForegroundColor Green }
  } catch { }
  if (-not $found) {
    Write-Host "  Installing ffmpeg via winget (may prompt)..." -ForegroundColor Cyan
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
    Write-Host "  ffmpeg installed." -ForegroundColor Green
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
    $aeBase = Get-AdobeDir "Adobe After Effects*"
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
    # NOTE: [Convert]::ToHexString() does not exist on .NET Framework (PS 5.1) — build hex manually.
    $token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    "PREMIERE_MCP_TOKEN=$token" | Out-File -FilePath $EnvFile -Encoding ascii -Append
    Write-Host "  Generated bearer token." -ForegroundColor Green
  } else {
    Write-Host "  Existing bearer token kept." -ForegroundColor Green
  }
  if (-not (Select-String -Path $EnvFile -Pattern '^PORT=' -Quiet)) {
    "PORT=$Port" | Out-File -FilePath $EnvFile -Encoding ascii -Append
  }
  # Owner passphrase gates the OAuth consent page (PREMIERE_MCP_OWNER_SECRET).
  if (-not (Select-String -Path $EnvFile -Pattern '^PREMIERE_MCP_OWNER_SECRET=' -Quiet)) {
    $sbytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($sbytes)
    $secret = -join ($sbytes | ForEach-Object { $_.ToString('x2') })
    "PREMIERE_MCP_OWNER_SECRET=$secret" | Out-File -FilePath $EnvFile -Encoding ascii -Append
    Write-Host "  Generated owner passphrase (consent page)." -ForegroundColor Green
  } else {
    Write-Host "  Existing owner passphrase kept." -ForegroundColor Green
  }
  # Public URL: the OAuth issuer + Host allow-list. REQUIRED for remote access —
  # without it, tunneled requests are rejected (403) by the DNS-rebinding guard.
  if ($PublicHostname) {
    $pubUrl = "https://$PublicHostname"
    if (Select-String -Path $EnvFile -Pattern '^PREMIERE_MCP_PUBLIC_URL=' -Quiet) {
      (Get-Content $EnvFile) -replace '^PREMIERE_MCP_PUBLIC_URL=.*$', "PREMIERE_MCP_PUBLIC_URL=$pubUrl" |
        Out-File -FilePath $EnvFile -Encoding ascii
    } else {
      "PREMIERE_MCP_PUBLIC_URL=$pubUrl" | Out-File -FilePath $EnvFile -Encoding ascii -Append
    }
    if (-not (Select-String -Path $EnvFile -Pattern '^PUBLIC_HOSTNAME=' -Quiet)) {
      "PUBLIC_HOSTNAME=$PublicHostname" | Out-File -FilePath $EnvFile -Encoding ascii -Append
    }
    Write-Host "  Public URL set: $pubUrl" -ForegroundColor Green
  } elseif (-not (Select-String -Path $EnvFile -Pattern '^PREMIERE_MCP_PUBLIC_URL=' -Quiet)) {
    Write-Host "  WARNING: no -PublicHostname given, so PREMIERE_MCP_PUBLIC_URL is unset." -ForegroundColor Yellow
    Write-Host "  Remote (tunnel) access will be rejected until you set it in .env" -ForegroundColor Yellow
    Write-Host "  and restart the server. Run .\scripts\pair.ps1 to configure it." -ForegroundColor Yellow
  }
}

function Install-ScheduledTask {
  schtasks /query /tn $ServerTaskName 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { schtasks /delete /tn $ServerTaskName /f | Out-Null }
  $indexJs = Join-Path $RepoRoot "dist\index.js"
  $nodePath = (Get-Command node).Source
  $action = "`"$nodePath`" `"$indexJs`""
  schtasks /create /tn $ServerTaskName /tr $action /sc onlogon /rl limited /f | Out-Null
  $xml = (schtasks /query /tn $ServerTaskName /xml) -join "`n"
  if ($xml -notmatch '<WorkingDirectory>') {
    $xml = $xml -replace '(<Exec>)', ('$1<WorkingDirectory>' + $RepoRoot + '</WorkingDirectory>')
  }
  $tmpXml = Join-Path $env:TEMP "premiere-mcp-task.xml"
  $xml | Out-File -FilePath $tmpXml -Encoding utf8
  schtasks /create /tn $ServerTaskName /xml $tmpXml /f | Out-Null
  Remove-Item $tmpXml -Force
  Write-Host ("  Scheduled task '" + $ServerTaskName + "' runs at logon.") -ForegroundColor Green
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

function Show-Summary {
  Write-Host ""
  Write-Host "  ==================================================" -ForegroundColor Cyan
  Write-Host "   PremierePilot by Shotbyx — install complete" -ForegroundColor Cyan
  Write-Host "  ==================================================" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "  Next steps:" -ForegroundColor Cyan
  Write-Host "   1. Open Premiere Pro: Window > Extensions > MCP Bridge (the bridge starts automatically)."
  Write-Host "      After Effects (if installed): Window > mcp-bridge-auto — keep auto-run ON."
  Write-Host "   2. Keep this PC awake and signed in to Adobe Creative Cloud."
  Write-Host "   3. Run scripts\pair.ps1 — it prints your connect URL and pairing code."
  Write-Host "   4. Give the connect URL to your AI (Muse/ChatGPT) together with the bearer token"
  Write-Host ("      stored in " + $EnvFile + " — never share the token publicly.")
  Write-Host ("   5. Health check: http://127.0.0.1:" + $Port + "/health")
  Write-Host "   6. A weekly auto-update check is scheduled ('PremierePilotUpdateCheck', Sundays 03:00)."
  if ($PublicHostname) { Write-Host ("   7. Public MCP path: https://" + $PublicHostname + "/mcp") }
  Write-Host ""
  Write-Host "  Created by Shotbyx" -ForegroundColor DarkGray
  Write-Host ""
}

# --------------------------------------------------------------------- main ---

if ($Uninstall) { Invoke-Uninstall; exit 0 }

Invoke-Preflight
Require-Node
Ensure-Ffmpeg
Install-ServerDeps
Install-CepPanel
Ensure-BridgeTempDir
Ensure-Token
Install-ScheduledTask
& (Join-Path $PSScriptRoot "pair.ps1") -Quiet
& (Join-Path $PSScriptRoot "check-update.ps1") -RegisterTask
if ($TunnelToken -or $PublicHostname) { Install-Cloudflared $TunnelToken $PublicHostname }
Show-Summary
