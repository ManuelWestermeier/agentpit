@echo off
setlocal
cd /d "%~dp0"
title Agent Cockpit

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js fehlt. Installieren: winget install OpenJS.NodeJS.LTS  ^(oder https://nodejs.org^)
  pause
  exit /b 1
)

for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
  echo Node.js %NODEMAJOR% ist zu alt ^(mindestens 22.13^): winget upgrade OpenJS.NodeJS.LTS
  pause
  exit /b 1
)

if not exist "node_modules\@anthropic-ai\claude-agent-sdk\package.json" (
  echo Installiere Abhaengigkeiten ^(einmalig, ca. 150 MB inkl. Claude Code^) ...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo npm install ist fehlgeschlagen.
    pause
    exit /b 1
  )
)

if not exist "web\dist\index.html" (
  echo Baue die Weboberflaeche ...
  call npm run build:web
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

where ffmpeg >nul 2>nul
if errorlevel 1 echo Hinweis: ffmpeg fehlt - fuer Videos: winget install --id Gyan.FFmpeg -e
where gh >nul 2>nul
if errorlevel 1 echo Hinweis: GitHub CLI fehlt - fuer GitHub-Login: winget install GitHub.cli

node server\index.js
echo.
echo Cockpit beendet.
pause
