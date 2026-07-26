<#
  update.ps1 - Pull the latest Siphon, rebuild the Windows exe, and restart the service.

  Usage:
    Right-click > "Run with PowerShell",  or from a terminal:  .\update.ps1  [-Force]
    -Force  rebuilds/restarts even if git reports no new commits.

  It self-elevates (one UAC prompt) because stopping/starting the service needs admin.
  Steps that aren't needed are skipped (e.g. npm ci only runs when dependencies changed).
#>
# -Elevated is set automatically when the script relaunches itself for admin rights;
# it is not meant to be passed by hand.
param([switch]$Force, [switch]$Elevated)

$ServiceName = 'Siphon'

# --- Self-elevate: stopping/starting a Windows service requires administrator ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Requesting administrator privileges (approve the UAC prompt)...' -ForegroundColor Yellow
  $relaunch = @('-NoProfile','-ExecutionPolicy','Bypass','-File', "`"$PSCommandPath`"", '-Elevated')
  if ($Force) { $relaunch += '-Force' }
  try {
    $proc = Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch -PassThru -Wait -ErrorAction Stop
  } catch {
    Write-Host 'Elevation was cancelled - nothing was updated.' -ForegroundColor Red
    exit 1
  }
  exit $proc.ExitCode
}

$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Set-Location $root

# Ensure node/npm/git are visible in this elevated session (it may not inherit the user PATH)
$env:Path = "C:\Program Files\nodejs;" + [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

# When we relaunched ourselves elevated, the new window would otherwise close the instant the
# script ends - too fast to read the result. Hold it open with a final banner that auto-closes
# after a timeout (or immediately on a key press). No-op when run from an existing admin shell.
function Wait-BeforeClose([string]$Message, [string]$Color, [int]$Seconds) {
  if (-not $Elevated) { return }
  Write-Host ''
  Write-Host $Message -ForegroundColor $Color
  Write-Host "This window closes in $Seconds seconds - press any key to close now..." -ForegroundColor DarkGray
  $deadline = (Get-Date).AddSeconds($Seconds)
  try {
    while ((Get-Date) -lt $deadline) {
      if ($Host.UI.RawUI.KeyAvailable) { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown'); break }
      Start-Sleep -Milliseconds 150
    }
  } catch {
    Start-Sleep -Seconds ([Math]::Min($Seconds, 10))
  }
}

$exitCode = 0
try {
  if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
    throw "Service '$ServiceName' is not installed. Install it first (windows-service setup)."
  }

  Step 'Pulling latest from git'
  $before = (git rev-parse HEAD).Trim()
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull failed (local changes or non-fast-forward). Resolve manually, then re-run.' }
  $after = (git rev-parse HEAD).Trim()

  if ($before -eq $after -and -not $Force) {
    Write-Host "`nAlready up to date ($after). Nothing to rebuild. Use -Force to rebuild anyway." -ForegroundColor Green
    return
  }

  $changed = if ($before -ne $after) { git diff --name-only $before $after } else { @() }
  $needCi = $Force -or (-not (Test-Path (Join-Path $root 'node_modules'))) -or ($changed -contains 'package-lock.json') -or ($changed -contains 'package.json')

  if ($needCi) {
    Step 'Installing dependencies (npm ci)'
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  } else {
    Write-Host 'Dependencies unchanged - skipping npm ci.' -ForegroundColor DarkGray
  }

  Step 'Building web UI (Vite)'
  npm run web:build
  if ($LASTEXITCODE -ne 0) { throw 'web:build failed.' }

  # Server bundle: bundle ALL deps into one CJS file (deliberately NOT using --packages=external,
  # which is what the repo's own `server:build` script uses).
  # Why: @fastify/cookie does a dynamic import('cookie') and `cookie` is an ESM-only package. Left
  # external, that dynamic import survives into the pkg snapshot, and the packaged .exe crash-loops
  # at startup with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING (the service shows "Running" but never
  # listens). Bundling compiles the dynamic import into a static require so the exe boots.
  # Docker / plain `node dist-server/index.cjs` is unaffected either way.
  Step 'Building server bundle (deps bundled)'
  npm run server:build:bundled
  if ($LASTEXITCODE -ne 0) { throw 'server bundle failed.' }

  Step "Stopping service '$ServiceName' (releases the locked exe)"
  Stop-Service $ServiceName
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Process -Name 'siphon-win-x64' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
  }

  Step 'Packaging Windows exe (npm run package:win)'
  $packaged = $false
  for ($i = 1; $i -le 3 -and -not $packaged; $i++) {
    npm run package:win
    if ($LASTEXITCODE -eq 0) { $packaged = $true }
    else { Write-Host "  package attempt $i failed (exe may still be locked); retrying..." -ForegroundColor Yellow; Start-Sleep 2 }
  }
  if (-not $packaged) { throw "package:win failed. The service is stopped - re-run this script, or 'sc start $ServiceName' to restore the old build." }

  Step "Starting service '$ServiceName'"
  Start-Service $ServiceName

  # Derive the actual port + log dir from the installed WinSW config (fall back to defaults),
  # so verification is correct even when service.config.json sets a non-default port/dataDir.
  $port = 8080
  $logDir = 'C:\ProgramData\Siphon\logs'
  $svcXmlPath = Join-Path $root 'dist-bin\siphon-service.xml'
  if (Test-Path $svcXmlPath) {
    try {
      [xml]$svcXml = Get-Content $svcXmlPath -Raw
      $portEnv = @($svcXml.service.env) | Where-Object { $_.name -eq 'PORT' } | Select-Object -First 1
      if ($portEnv -and $portEnv.value) { $port = [int]$portEnv.value }
      if ($svcXml.service.logpath) { $logDir = [string]$svcXml.service.logpath }
    } catch { }
  }

  Step 'Verifying (the exe must actually serve, not just report Running)'
  $ok = $false
  for ($i = 1; $i -le 6 -and -not $ok; $i++) {
    Start-Sleep 3
    try {
      $r = Invoke-WebRequest "http://localhost:$port" -UseBasicParsing -TimeoutSec 8
      if ($r.StatusCode -eq 200) { $ok = $true; Write-Host "OK - HTTP 200 at http://localhost:$port" -ForegroundColor Green }
    } catch { }
  }
  if (-not $ok) {
    Write-Host "WARN - service reports Running but http://localhost:$port is not serving (likely a startup crash)." -ForegroundColor Red
    $errLog = Join-Path $logDir 'siphon-service.err.log'
    if (Test-Path $errLog) {
      Write-Host "--- last errors ($errLog) ---" -ForegroundColor Yellow
      Get-Content $errLog -Tail 15
    }
  }

  Write-Host "`nUpdate complete: $before -> $after" -ForegroundColor Green
}
catch {
  Write-Host "`nUPDATE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "If the service was left stopped, start it with:  sc start $ServiceName" -ForegroundColor Yellow
  $exitCode = 1
}
finally {
  if ($exitCode -eq 0) {
    Wait-BeforeClose 'Update finished successfully.' 'Green' 20
  } else {
    Wait-BeforeClose 'Update FAILED - review the messages above before this window closes.' 'Red' 120
  }
}
exit $exitCode
