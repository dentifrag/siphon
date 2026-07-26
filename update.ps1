<#
  update.ps1 - Pull the latest Siphon, rebuild the Windows exe, and restart the service.

  Usage:
    Right-click > "Run with PowerShell",  or from a terminal:  .\update.ps1  [-Force]
    -Force  rebuilds/restarts even if git reports no new commits.

  It self-elevates (one UAC prompt) because stopping/starting the service needs admin.
  Steps that aren't needed are skipped (e.g. npm ci only runs when dependencies changed).
#>
param([switch]$Force)

$ServiceName = 'Siphon'

# --- Self-elevate: stopping/starting a Windows service requires administrator ---
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Requesting administrator privileges (approve the UAC prompt)...' -ForegroundColor Yellow
  $relaunch = @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File', "`"$PSCommandPath`"")
  if ($Force) { $relaunch += '-Force' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $relaunch
  return
}

$ErrorActionPreference = 'Stop'
$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
Set-Location $root

# Ensure node/npm/git are visible in this elevated session (it may not inherit the user PATH)
$env:Path = "C:\Program Files\nodejs;" + [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

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
  Step 'Building server bundle (esbuild, deps bundled)'
  npx esbuild src/server/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist-server/index.cjs
  if ($LASTEXITCODE -ne 0) { throw 'server esbuild bundle failed.' }

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

  Step 'Verifying (the exe must actually serve, not just report Running)'
  $ok = $false
  for ($i = 1; $i -le 6 -and -not $ok; $i++) {
    Start-Sleep 3
    try {
      $r = Invoke-WebRequest 'http://localhost:8080' -UseBasicParsing -TimeoutSec 8
      if ($r.StatusCode -eq 200) { $ok = $true; Write-Host 'OK - HTTP 200 at http://localhost:8080' -ForegroundColor Green }
    } catch { }
  }
  if (-not $ok) {
    Write-Host 'WARN - service reports Running but http://localhost:8080 is not serving (likely a startup crash).' -ForegroundColor Red
    $errLog = 'C:\ProgramData\Siphon\logs\siphon-service.err.log'
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
  exit 1
}
