# check-update.ps1 — PremierePilot by Shotbyx: auto-update checker
# Created by Shotbyx.
#
# Reads the local version from package.json, queries the latest GitHub release,
# and compares semver. If a newer release exists:
#   - interactive: prompts, then updates
#   - -Silent: notify-only (writes to the update log, does not install)
#
# Update path: `git pull --rebase` when this is a git checkout; otherwise the
# release zipball is downloaded and extracted over the install dir. Afterwards
# `npm install && npm run build` run again and the "PremiereMCPServer" scheduled
# task is restarted (best effort).
#
# -RegisterTask registers the WEEKLY scheduled task "PremierePilotUpdateCheck"
# (Sundays 03:00) that runs this script with -Silent, then exits.
#
# Usage:
#   .\check-update.ps1
#   .\check-update.ps1 -Silent
#   .\check-update.ps1 -RegisterTask
#
# NOTE: PowerShell 5.1 compatible. No secrets involved.

param(
  [switch]$Silent,
  [switch]$RegisterTask,
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$LogFile = ""
)

$ErrorActionPreference = 'Stop'

if (-not $LogFile) { $LogFile = Join-Path $env:APPDATA "PremierePilot\update.log" }
$UpdateTaskName = "PremierePilotUpdateCheck"
$ServerTaskName = "PremiereMCPServer"
$ReleasesUrl = "https://api.github.com/repos/shotbyx-dev/premiere-mcp-server/releases/latest"
$UserAgent = "PremierePilot-UpdateCheck"

function Write-UpdateLog([string]$msg) {
  $dir = Split-Path -Parent $LogFile
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  ('[{0:yyyy-MM-dd HH:mm:ss}] {1}' -f (Get-Date), $msg) | Out-File -FilePath $LogFile -Encoding utf8 -Append
}

function Compare-Semver([string]$a, [string]$b) {
  # Returns 1 if $a newer, -1 if older, 0 if equal. Ignores leading 'v' and -prerelease suffixes.
  $pa = (($a.TrimStart('v') -split '-', 2)[0] -split '\.')
  $pb = (($b.TrimStart('v') -split '-', 2)[0] -split '\.')
  $n = [Math]::Max($pa.Count, $pb.Count)
  for ($i = 0; $i -lt $n; $i++) {
    $x = 0; $y = 0
    if ($i -lt $pa.Count) { [int]::TryParse($pa[$i], [ref]$x) | Out-Null }
    if ($i -lt $pb.Count) { [int]::TryParse($pb[$i], [ref]$y) | Out-Null }
    if ($x -ne $y) {
      if ($x -gt $y) { return 1 } else { return -1 }
    }
  }
  return 0
}

function Register-UpdateTask {
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $script = Join-Path $RepoRoot "scripts\check-update.ps1"
  $action = "`"$psExe`" -ExecutionPolicy Bypass -NoProfile -File `"$script`" -Silent"
  schtasks /delete /tn $UpdateTaskName /f 2>$null | Out-Null
  schtasks /create /tn $UpdateTaskName /tr $action /sc weekly /d SUN /st 03:00 /rl limited /f | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to register scheduled task '$UpdateTaskName'." }
  Write-Host ("  Weekly update check registered ('" + $UpdateTaskName + "', Sundays 03:00).") -ForegroundColor Green
}

function Invoke-Update([object]$release) {
  Write-UpdateLog "Installing update..."
  Push-Location $RepoRoot
  try {
    $isGit = (Test-Path (Join-Path $RepoRoot ".git")) -and (Get-Command git -ErrorAction SilentlyContinue)
    if ($isGit) {
      Write-Host "  Updating via git pull --rebase..." -ForegroundColor Cyan
      & git pull --rebase
    } else {
      Write-Host "  No git checkout — downloading release zip..." -ForegroundColor Cyan
      $stamp = [Guid]::NewGuid().ToString("N")
      $zip = Join-Path $env:TEMP ("premiere-mcp-update-" + $stamp + ".zip")
      $out = Join-Path $env:TEMP ("premiere-mcp-update-" + $stamp)
      try {
        Invoke-WebRequest -Uri $release.zipball_url -OutFile $zip `
          -Headers @{ "User-Agent" = $UserAgent } -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $out -Force
        $inner = Get-ChildItem $out -Directory | Select-Object -First 1
        if (-not $inner) { throw "Release zip had no top-level directory." }
        # .env is gitignored so it is never inside the zip — the token survives.
        Get-ChildItem $inner.FullName | Copy-Item -Destination $RepoRoot -Recurse -Force
      } finally {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    Write-Host "  Rebuilding (npm install + build)..." -ForegroundColor Cyan
    & npm install --no-audit --no-fund
    & npm run build
  } finally { Pop-Location }

  # Restart the server task so the new build takes effect (best effort).
  try {
    schtasks /query /tn $ServerTaskName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      schtasks /end /tn $ServerTaskName 2>$null | Out-Null
      Start-Sleep -Seconds 2
      schtasks /run /tn $ServerTaskName 2>$null | Out-Null
      Write-UpdateLog "Server scheduled task restarted."
      Write-Host ("  Scheduled task '" + $ServerTaskName + "' restarted.") -ForegroundColor Green
    }
  } catch {
    Write-UpdateLog "Could not restart server task (non-fatal)."
  }
  Write-UpdateLog "Update installed."
  Write-Host "  Update installed." -ForegroundColor Green
}

# --- main ---

if ($RegisterTask) { Register-UpdateTask; exit 0 }

Write-UpdateLog "Update check started."

$local = ""
try {
  $pkg = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
  $local = [string]$pkg.version
} catch {
  Write-UpdateLog "Could not read local version from package.json."
  Write-Host "  [X] Could not read local version from package.json." -ForegroundColor White -BackgroundColor Red
  exit 1
}

$release = $null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $release = Invoke-RestMethod -Uri $ReleasesUrl -Headers @{ "User-Agent" = $UserAgent } -UseBasicParsing
} catch {
  Write-UpdateLog "Could not reach GitHub releases API — will retry next check."
  Write-Host "  Could not reach GitHub releases API (offline?). Skipping." -ForegroundColor Yellow
  exit 0
}

$remote = [string]$release.tag_name
$cmp = Compare-Semver $remote $local

if ($cmp -le 0) {
  Write-UpdateLog ("Up to date (local v" + $local + ", latest " + $remote + ").")
  Write-Host ("  Up to date (v" + $local + ").") -ForegroundColor Green
  exit 0
}

Write-UpdateLog ("Update available: local v" + $local + " -> " + $remote + ".")
$doUpdate = $false
if ($Silent) {
  Write-Host ("  Update available: v" + $local + " -> " + $remote +
    " (silent mode: not installing; details in " + $LogFile + ").") -ForegroundColor Yellow
} else {
  $ans = Read-Host ("  Update available: v" + $local + " -> " + $remote + ". Install now? [Y/n]")
  if ($ans -eq "" -or $ans -match "^[Yy]") { $doUpdate = $true } else { Write-UpdateLog "Update declined by user." }
}

if ($doUpdate) { Invoke-Update $release }
Write-UpdateLog "Update check finished."
