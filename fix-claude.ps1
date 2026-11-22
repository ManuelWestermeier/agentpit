# Claude Code unter Windows diagnostizieren und reparieren.
# Ausfuehren:  powershell -ExecutionPolicy Bypass -File .\fix-claude.ps1
# Erst Diagnose, Reparatur nur nach Rueckfrage. Kaputte Dateien werden umbenannt (*.defekt), nicht geloescht.
$ErrorActionPreference = 'Continue'  # npm schreibt Warnungen auf stderr; Fehler werden unten explizit geworfen

function Get-ExeInfo([string]$Path) {
  $fs = [IO.File]::OpenRead($Path)
  try {
    $len = $fs.Length
    if ($len -lt 64) { return [pscustomobject]@{ Ok = $false; Typ = "leer/abgebrochen ($len Bytes)" } }
    $br = New-Object IO.BinaryReader($fs)
    $head = $br.ReadBytes(4)
    if ($head[0] -eq 0x7F -and $head[1] -eq 0x45 -and $head[2] -eq 0x4C -and $head[3] -eq 0x46) { return [pscustomobject]@{ Ok = $false; Typ = 'Linux-Binary (ELF) – falsche Plattform' } }
    if ($head[0] -eq 0xCF -and $head[1] -eq 0xFA) { return [pscustomobject]@{ Ok = $false; Typ = 'macOS-Binary (Mach-O) – falsche Plattform' } }
    if ($head[0] -ne 0x4D -or $head[1] -ne 0x5A) { return [pscustomobject]@{ Ok = $false; Typ = 'keine EXE (kein MZ-Header) – Download kaputt' } }
    $fs.Position = 0x3C; $pe = $br.ReadInt32()
    if ($pe -le 0 -or $pe -gt $len - 6) { return [pscustomobject]@{ Ok = $false; Typ = 'EXE abgeschnitten' } }
    $fs.Position = $pe
    if ($br.ReadUInt32() -ne 0x00004550) { return [pscustomobject]@{ Ok = $false; Typ = 'EXE beschaedigt (kein PE-Header)' } }
    $machine = $br.ReadUInt16()
    $arch = switch ($machine) { 0x8664 { 'x64' } 0xAA64 { 'ARM64' } 0x014C { 'x86' } default { ('0x{0:X4}' -f $machine) } }
    $cpu = $env:PROCESSOR_ARCHITECTURE
    $runs = ($cpu -eq 'AMD64' -and $arch -eq 'x64') -or ($cpu -eq 'ARM64' -and ($arch -eq 'ARM64' -or $arch -eq 'x64')) -or $arch -eq 'x86'
    $typ = if ($runs) { "Windows-EXE $arch" } else { "Windows-EXE $arch – passt nicht zur CPU ($cpu)" }
    return [pscustomobject]@{ Ok = $runs; Typ = $typ }
  } finally { $fs.Dispose() }
}

Write-Host "`n== System" -ForegroundColor Yellow
Write-Host ("CPU: {0}   PowerShell 64-Bit: {1}   Windows: {2}" -f $env:PROCESSOR_ARCHITECTURE, [Environment]::Is64BitProcess, [Environment]::OSVersion.Version)
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) { Write-Host "Node: $(node -v)   npm: $(npm -v 2>$null)   global: $(npm prefix -g 2>$null)" } else { Write-Host 'Node: fehlt (winget install OpenJS.NodeJS.LTS)' -ForegroundColor Red }

Write-Host "`n== Gefundene claude-Befehle (erster gewinnt)" -ForegroundColor Yellow
$found = @(Get-Command claude -All -ErrorAction SilentlyContinue)
$broken = @()
foreach ($c in $found) {
  $p = $c.Source
  if ($p -like '*.exe') {
    $i = Get-ExeInfo $p
    $size = '{0:N1} MB' -f ((Get-Item $p).Length / 1MB)
    $color = if ($i.Ok) { 'Green' } else { 'Red' }
    Write-Host ("{0}  [{1}, {2}]" -f $p, $i.Typ, $size) -ForegroundColor $color
    if (-not $i.Ok) { $broken += $p }
  } else {
    Write-Host ("{0}  [{1}]" -f $p, $c.CommandType)
  }
}
if (-not $found) { Write-Host 'Kein claude im PATH.' }

$devdir = (npm config get devdir 2>$null)
if ($env:npm_config_devdir -or $env:NPM_CONFIG_DEVDIR -or ($devdir -and $devdir -ne 'undefined' -and $devdir -ne 'null')) {
  Write-Host "`nHinweis: npm-Einstellung 'devdir' gesetzt (Ursache der Warnung 'Unknown env config devdir')." -ForegroundColor DarkYellow
}

if (-not $broken -and $found) {
  Write-Host "`nKein defektes claude.exe gefunden. Test:" -ForegroundColor Green
  & claude --version
  exit 0
}

$answer = Read-Host "`nReparieren (defekte Dateien umbenennen, Claude Code per npm neu installieren)? [j/N]"
if ($answer -notmatch '^(j|y)') { exit 0 }

foreach ($p in $broken) {
  $target = "$p.defekt"
  if (Test-Path $target) { Remove-Item $target -Force }
  Rename-Item -LiteralPath $p -NewName (Split-Path $target -Leaf)
  Write-Host "umbenannt: $p -> $target"
}

# npm-Warnung beseitigen
npm config delete devdir 2>$null | Out-Null
npm config delete devdir --global 2>$null | Out-Null
foreach ($scope in 'User', 'Machine') {
  foreach ($n in 'npm_config_devdir', 'NPM_CONFIG_DEVDIR') {
    if ([Environment]::GetEnvironmentVariable($n, $scope)) {
      if ($scope -eq 'Machine') { Write-Host "Umgebungsvariable $n (System) bitte als Admin entfernen." -ForegroundColor DarkYellow }
      else { [Environment]::SetEnvironmentVariable($n, $null, 'User'); Write-Host "Umgebungsvariable $n (Benutzer) entfernt." }
    }
  }
}
Remove-Item Env:npm_config_devdir -ErrorAction SilentlyContinue

if (-not $node) { throw 'Node.js fehlt – erst: winget install OpenJS.NodeJS.LTS, Terminal neu oeffnen, Skript erneut starten.' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 22) { throw "Node $major ist zu alt (Claude Code braucht 22+): winget upgrade OpenJS.NodeJS.LTS" }

Write-Host "`n== Neuinstallation (npm, mit plattformspezifischem Binary)" -ForegroundColor Yellow
npm uninstall -g @anthropic-ai/claude-code 2>$null | Out-Null
npm install -g @anthropic-ai/claude-code@latest --include=optional --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { throw 'npm install fehlgeschlagen – Alternative: winget install Anthropic.ClaudeCode' }

$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
Write-Host "`n== Pruefung" -ForegroundColor Yellow
Get-Command claude -All | ForEach-Object { Write-Host $_.Source }
& claude --version
& claude doctor
Write-Host "`nFalls oben noch ein anderer Pfad VOR dem npm-Pfad steht: diesen Eintrag aus dem PATH entfernen oder die Datei umbenennen." -ForegroundColor DarkYellow
