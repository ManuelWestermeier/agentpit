# Agent Cockpit starten (PowerShell).
# Falls Skripte gesperrt sind:  powershell -ExecutionPolicy Bypass -File .\start.ps1
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js fehlt. Installieren mit:  winget install OpenJS.NodeJS.LTS' -ForegroundColor Yellow
  exit 1
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) {
  Write-Host "Node.js $major ist zu alt (mindestens 22.13, empfohlen 24 LTS):  winget upgrade OpenJS.NodeJS.LTS" -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path 'node_modules/@anthropic-ai/claude-agent-sdk/package.json')) {
  Write-Host 'Installiere Abhängigkeiten (einmalig, ca. 150 MB inkl. Claude Code) ...'
  npm install --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { throw 'npm install fehlgeschlagen' }
}

if (-not (Test-Path 'web/dist/index.html')) {
  Write-Host 'Baue die Weboberfläche ...'
  npm run build:web
  if ($LASTEXITCODE -ne 0) { throw 'Build fehlgeschlagen' }
}

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  $answer = Read-Host 'ffmpeg fehlt (für Videos). Jetzt mit winget installieren? [j/N]'
  if ($answer -match '^(j|y)') {
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
  }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  Write-Host 'Hinweis: GitHub CLI fehlt (für „Mit GitHub anmelden“):  winget install GitHub.cli' -ForegroundColor DarkGray
}

node server/index.js
