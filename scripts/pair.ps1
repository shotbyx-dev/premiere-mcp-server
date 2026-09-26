# pair.ps1 — PremierePilot by Shotbyx: first-run pairing wizard
# Created by Shotbyx.
#
# Creates the server home dir %APPDATA%\PremierePilot (this will hold the OAuth
# token store in a future release; for now a README.txt + the update log live
# here), then prints everything needed to connect an AI to this PC:
#   - the public connect URL (from -PublicHostname, the .env PUBLIC_HOSTNAME,
#     or an interactive prompt; falls back to a localhost URL + tunnel guidance)
#   - a short pairing code identifying this PC (safe to read aloud)
#   - the bearer token, MASKED (first/last 4 chars only) + the file it lives in
#
# The raw bearer token is NEVER printed to the console.
#
# QR code decision: no QR is rendered by default. A correct QR encoder needs
# Reed-Solomon error correction — not feasible as a compact, dependency-free
# PowerShell 5.1 snippet — and sending your URL to a web QR API would leak it to
# a third party. If `qrencode` happens to be on PATH we use it to draw an ANSI
# QR; otherwise the URL is printed large below plus a short pairing code.
#
# Usage:
#   .\pair.ps1
#   .\pair.ps1 -PublicHostname "mcp.example.com"
#   .\pair.ps1 -Quiet   # only ensure the server home dir (used by the installer)

param(
  [string]$PublicHostname = "",
  [int]$Port = 0,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$HomeDir = Join-Path $env:APPDATA "PremierePilot"
$EnvFile = Join-Path $RepoRoot ".env"

function Ensure-ServerHome {
  New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
  $readme = Join-Path $HomeDir "README.txt"
  if (-not (Test-Path $readme)) {
    @(
      "PremierePilot by Shotbyx — server home directory",
      "=================================================",
      "",
      "Created by: scripts\pair.ps1 (first-run pairing wizard).",
      "",
      "This folder will hold the OAuth token store (coming in a future",
      "release). Today it holds the auto-update log (update.log).",
      "",
      "Do not delete this folder while PremierePilot is installed.",
      "",
      "Created by Shotbyx."
    ) | Out-File -FilePath $readme -Encoding utf8
  }
}

function Read-DotEnvValue([string]$name) {
  if (-not (Test-Path $EnvFile)) { return "" }
  $line = Select-String -Path $EnvFile -Pattern ('^' + $name + '=(.*)$') | Select-Object -First 1
  if ($line) { return $line.Matches.Groups[1].Value.Trim() }
  return ""
}

function Write-Box([string[]]$lines, [string]$color) {
  $w = 56
  $bar = '  +' + ('-' * ($w + 2)) + '+'
  Write-Host $bar -ForegroundColor $color
  foreach ($l in $lines) {
    $t = $l
    if ($t.Length -gt $w) { $t = $t.Substring(0, $w) }
    Write-Host ('  | ' + $t.PadRight($w) + ' |') -ForegroundColor $color
  }
  Write-Host $bar -ForegroundColor $color
}

Ensure-ServerHome
if ($Quiet) { exit 0 }

Write-Host ""
Write-Host "  PremierePilot by Shotbyx — pairing" -ForegroundColor Cyan
Write-Host "  Created by Shotbyx" -ForegroundColor DarkGray
Write-Host ""

# --- resolve port ---
if ($Port -eq 0) {
  $p = Read-DotEnvValue "PORT"
  if ($p -match '^\d+$') { $Port = [int]$p } else { $Port = 8787 }
}

# --- resolve public hostname ---
if (-not $PublicHostname) { $PublicHostname = Read-DotEnvValue "PUBLIC_HOSTNAME" }
if (-not $PublicHostname) {
  $PublicHostname = (Read-Host "  Public hostname for remote access (e.g. mcp.example.com) — Enter to skip").Trim()
}

# --- token (masked only) ---
$token = Read-DotEnvValue "PREMIERE_MCP_TOKEN"
if (-not $token) {
  Write-Host "  [X] No bearer token found in .env — run install-windows.ps1 first." -ForegroundColor White -BackgroundColor Red
  exit 1
}
if ($token.Length -ge 8) {
  $masked = $token.Substring(0, 4) + "..." + $token.Substring($token.Length - 4)
} else {
  $masked = "****"
}
# Short pairing code: first 3 bytes of SHA-256(token) as hex — identifies this PC
# without revealing the token. Safe to read aloud to your AI.
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($token))
$pairCode = -join ($hash[0..2] | ForEach-Object { $_.ToString('X2') })

# --- connect URL ---
if ($PublicHostname) {
  $connectUrl = "https://" + $PublicHostname + "/mcp"
  Write-Host "  Your AI connects with this URL:" -ForegroundColor Cyan
  Write-Box @($connectUrl, "", "Pairing code: " + $pairCode) "Green"
  $qr = Get-Command qrencode -ErrorAction SilentlyContinue
  if ($qr -and $connectUrl) {
    Write-Host ""
    Write-Host "  (qrencode found — terminal QR:)" -ForegroundColor DarkGray
    & qrencode -t ANSI $connectUrl
  }
} else {
  $connectUrl = "http://localhost:" + $Port + "/mcp"
  Write-Host "  No public hostname given — this PC only:" -ForegroundColor Yellow
  Write-Box @($connectUrl, "", "Pairing code: " + $pairCode) "Yellow"
  Write-Host ""
  Write-Host "  For access outside this PC, expose it first, then re-run pair.ps1:" -ForegroundColor Yellow
  Write-Host "   - Tailscale: run 'tailscale serve' for the local port, or"
  Write-Host "   - re-run install-windows.ps1 with -TunnelToken and -PublicHostname (cloudflared)."
}

Write-Host ""
Write-Host ("  Bearer token: " + $masked + "  (full token lives in " + $EnvFile + " — keep it secret)") -ForegroundColor DarkGray
Write-Host "  Health check: http://127.0.0.1:$Port/health" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Give the connect URL + pairing code + bearer token to your AI (Muse/ChatGPT)." -ForegroundColor Cyan
Write-Host "  The pairing code only identifies this PC — the token is the actual secret." -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Created by Shotbyx" -ForegroundColor DarkGray
