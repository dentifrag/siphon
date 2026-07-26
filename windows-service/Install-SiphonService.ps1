<#
.SYNOPSIS
  Install Siphon as an auto-start Windows service using WinSW.

.DESCRIPTION
  Wraps the standalone dist-bin\siphon-win-x64.exe in WinSW (the Windows Service
  Wrapper) so it starts on boot, restarts on failure, and rolls its logs. No system
  Node.js install is required at runtime - the packaged exe is self-contained.

  WinSW itself is downloaded from its official GitHub release (pinned version, verified
  by SHA-256) into dist-bin\siphon-service.exe the first time you run this.

  Settings come from windows-service\service.config.json if present (copy the example
  and edit it); otherwise sensible defaults are used. Re-running the script is safe -
  it stops and reinstalls the service in place.

.PARAMETER Build
  Build dist-bin\siphon-win-x64.exe first (needs Node.js 20+ and npm on PATH). Use this
  for a first-time setup on a machine that hasn't produced the exe yet.

.EXAMPLE
  # From an Administrator PowerShell (or it will prompt to elevate):
  ./windows-service/Install-SiphonService.ps1

.EXAMPLE
  # First-time setup that also builds the exe:
  ./windows-service/Install-SiphonService.ps1 -Build
#>
[CmdletBinding()]
param(
  [switch]$Build,
  # Set automatically when the script relaunches itself elevated; not meant to be passed by hand.
  [switch]$Elevated
)

$ServiceName  = 'Siphon'
$WinswVersion = 'v2.12.0'
$WinswAsset   = 'WinSW-x64.exe'   # self-contained .NET build - no .NET Framework needed
$WinswUrl     = "https://github.com/winsw/winsw/releases/download/$WinswVersion/$WinswAsset"
$WinswSha256  = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'

# --- Self-elevate: installing/stopping a Windows service requires administrator ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Write-Host 'Requesting administrator privileges (approve the UAC prompt)...' -ForegroundColor Yellow
  $argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  if ($Build) { $argsList += '-Build' }
  try {
    $proc = Start-Process powershell.exe -Verb RunAs -ArgumentList $argsList -PassThru -Wait -ErrorAction Stop
  } catch {
    Write-Host 'Elevation was cancelled - nothing was installed.' -ForegroundColor Red
    exit 1
  }
  exit $proc.ExitCode
}

$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$root = Split-Path -Parent $here
Set-Location $root

$exe   = Join-Path $root 'dist-bin\siphon-win-x64.exe'
$winsw = Join-Path $root 'dist-bin\siphon-service.exe'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

# When we relaunched ourselves elevated, the new window would otherwise close the instant the
# script ends - too fast to read the result. Hold it open with a final banner that auto-closes
# after a timeout (or immediately on a key press). No-op when run from an existing admin shell.
function Wait-BeforeClose([string]$Message, [string]$Color, [int]$Seconds) {
  if (-not $Elevated) { return }
  Write-Host ''
  Write-Host $Message -ForegroundColor $Color
  # Prefer an interactive "press a key or wait" countdown, but fall back to a plain timed wait in
  # hosts that don't expose raw key input - keeping the real delay equal to $Seconds either way.
  $canReadKey = $false
  try { $null = $Host.UI.RawUI.KeyAvailable; $canReadKey = $true } catch { $canReadKey = $false }
  if ($canReadKey) {
    Write-Host "This window closes in $Seconds seconds - press any key to close now..." -ForegroundColor DarkGray
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
      try { if ($Host.UI.RawUI.KeyAvailable) { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown'); break } } catch { break }
      Start-Sleep -Milliseconds 150
    }
  } else {
    Write-Host "This window closes in $Seconds seconds..." -ForegroundColor DarkGray
    Start-Sleep -Seconds $Seconds
  }
}
function Fail($m) {
  Write-Host "`n[install] $m`n" -ForegroundColor Red
  Wait-BeforeClose 'Install FAILED - review the messages above before this window closes.' 'Red' 120
  exit 1
}
function Get-Sha256($path) { (Get-FileHash $path -Algorithm SHA256).Hash.ToUpperInvariant() }

function Xml-Escape([string]$s) {
  if ($null -eq $s) { return '' }
  $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

function Build-SiphonExe {
  Step 'Building the standalone exe (-Build)'
  # Elevated sessions don't always inherit the user PATH - make node/npm visible.
  $env:Path = "C:\Program Files\nodejs;" + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail 'npm not found on PATH. Install Node.js 20+ and retry, or build the exe manually (see README).'
  }
  if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Step 'Installing dependencies (npm ci)'; npm ci; if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }
  }
  Step 'Building web UI (vite)'; npm run web:build; if ($LASTEXITCODE -ne 0) { Fail 'web:build failed.' }
  # Bundle ALL server deps (deliberately NOT --packages=external, which the repo's own
  # server:build script uses). @fastify/cookie does a dynamic import('cookie'), and left
  # external that import survives into the pkg snapshot and crash-loops the packaged exe at
  # startup with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING (service shows "Running" but never
  # listens). Bundling compiles it into a static require. Same rationale as update.ps1.
  Step 'Bundling server (deps bundled)'
  npm run server:build:bundled
  if ($LASTEXITCODE -ne 0) { Fail 'server bundle failed.' }
  Step 'Packaging exe (npm run package:win)'; npm run package:win; if ($LASTEXITCODE -ne 0) { Fail 'package:win failed.' }
}

function Remove-ExistingService {
  $svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
  if (-not $svc) { return }
  Step "Removing the existing '$ServiceName' service (so its exe can be replaced)"
  try { Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Process -Name 'siphon-win-x64' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
  }
  $removed = $false
  if (Test-Path $winsw) {
    try { & $winsw uninstall 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $removed = $true } } catch {}
  }
  if (-not $removed) { & sc.exe delete $ServiceName 2>$null | Out-Null }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Service $ServiceName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
  }
}

# --- Load config (defaults, overridden by service.config.json) ---
$cfg = [ordered]@{
  port            = 8080
  host            = '0.0.0.0'
  dataDir         = 'C:\ProgramData\Siphon'
  downloadDirs    = ''
  appUsername     = ''
  appPassword     = ''
  appPasswordHash = ''
  rclonePath      = ''
}
$cfgFile = Join-Path $here 'service.config.json'
if (Test-Path $cfgFile) {
  Step "Reading config: $cfgFile"
  try { $userCfg = Get-Content $cfgFile -Raw | ConvertFrom-Json } catch { Fail "Could not parse service.config.json: $($_.Exception.Message)" }
  foreach ($k in @($cfg.Keys)) {
    if ($null -ne $userCfg.$k -and "$($userCfg.$k)" -ne '') { $cfg[$k] = $userCfg.$k }
  }
} else {
  Write-Host "[install] No service.config.json - using defaults (port $($cfg.port), data $($cfg.dataDir))." -ForegroundColor DarkGray
  Write-Host "[install] To customize, copy windows-service\service.config.example.json to windows-service\service.config.json and edit it." -ForegroundColor DarkGray
}

# --- Ensure the standalone exe exists ---
if (-not (Test-Path $exe)) {
  if ($Build) {
    Build-SiphonExe
  } else {
    $msg = @'
Standalone exe not found at dist-bin\siphon-win-x64.exe.
Build it first (from a normal shell with Node.js 20+):
  npm ci
  npm run package:build
  npm run package:win
...or re-run this installer with  -Build  to do it automatically.
'@
    Fail $msg
  }
}

# --- Default rclone to the bundled copy if present ---
if (-not $cfg.rclonePath) {
  $bundledRclone = Join-Path $root 'dist-bin\rclone.exe'
  if (Test-Path $bundledRclone) { $cfg.rclonePath = $bundledRclone }
}
if ($cfg.rclonePath -and -not (Test-Path $cfg.rclonePath)) {
  Write-Host "[install] WARN: rclonePath '$($cfg.rclonePath)' does not exist. Siphon needs rclone at runtime (on PATH or via RCLONE_PATH)." -ForegroundColor Yellow
}

# --- Stop/remove any existing service first (releases the wrapper exe file lock) ---
Remove-ExistingService

# --- Acquire and verify WinSW ---
$needDownload = $true
if (Test-Path $winsw) {
  if ((Get-Sha256 $winsw) -eq $WinswSha256) {
    $needDownload = $false
    Write-Host "[install] WinSW already present and verified." -ForegroundColor DarkGray
  } else {
    Write-Host "[install] Replacing dist-bin\siphon-service.exe (hash differs from pinned WinSW $WinswVersion)." -ForegroundColor DarkGray
  }
}
if ($needDownload) {
  Step "Downloading WinSW $WinswVersion ($WinswAsset)"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $winsw) | Out-Null
  $tmp = "$winsw.download"
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
  try { Invoke-WebRequest $WinswUrl -OutFile $tmp -UseBasicParsing } catch { Fail "Download failed: $($_.Exception.Message)" }
  $got = Get-Sha256 $tmp
  if ($got -ne $WinswSha256) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Fail "WinSW SHA-256 mismatch.`n  expected $WinswSha256`n  got      $got"
  }
  Move-Item $tmp $winsw -Force
  Write-Host "[install] WinSW verified ($WinswSha256)." -ForegroundColor Green
}

# --- Create data + log directories ---
$logPath = Join-Path $cfg.dataDir 'logs'
New-Item -ItemType Directory -Force -Path $cfg.dataDir | Out-Null
New-Item -ItemType Directory -Force -Path $logPath | Out-Null

# --- Generate the WinSW config (must share the wrapper's base name: siphon-service.xml) ---
Step 'Writing WinSW config (siphon-service.xml)'
$envPairs = [ordered]@{
  NODE_ENV          = 'production'
  PORT              = "$($cfg.port)"
  HOST              = "$($cfg.host)"
  DATA_DIR          = "$($cfg.dataDir)"
  DOWNLOAD_DIRS     = "$($cfg.downloadDirs)"
  APP_USERNAME      = "$($cfg.appUsername)"
  APP_PASSWORD      = "$($cfg.appPassword)"
  APP_PASSWORD_HASH = "$($cfg.appPasswordHash)"
  RCLONE_PATH       = "$($cfg.rclonePath)"
}
$envLines = foreach ($k in $envPairs.Keys) {
  $v = $envPairs[$k]
  if ($null -ne $v -and "$v" -ne '') { '  <env name="{0}" value="{1}"/>' -f $k, (Xml-Escape "$v") }
}

$xml = @"
<service>
  <id>$ServiceName</id>
  <name>$ServiceName</name>
  <description>Siphon: a self-hosted web UI for rclone.</description>
  <executable>$(Xml-Escape $exe)</executable>
  <workingdirectory>$(Xml-Escape (Split-Path -Parent $exe))</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <resetfailure>1 hour</resetfailure>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <logpath>$(Xml-Escape $logPath)</logpath>
$($envLines -join "`n")
</service>
"@

$xmlPath = [IO.Path]::ChangeExtension($winsw, '.xml')
[IO.File]::WriteAllText($xmlPath, $xml, (New-Object System.Text.UTF8Encoding($false)))

# --- Install + start ---
Step "Installing service '$ServiceName'"
& $winsw install
if ($LASTEXITCODE -ne 0) { Fail "WinSW install failed (exit $LASTEXITCODE)." }

Step "Starting service '$ServiceName'"
& $winsw start
if ($LASTEXITCODE -ne 0) { Start-Service $ServiceName -ErrorAction SilentlyContinue }

# --- Verify it actually serves (not just "Running") ---
Step 'Verifying (the service must serve HTTP, not just report Running)'
$port = [int]$cfg.port
$ok = $false
for ($i = 1; $i -le 8 -and -not $ok; $i++) {
  Start-Sleep 2
  try {
    $r = Invoke-WebRequest "http://localhost:$port" -UseBasicParsing -TimeoutSec 6
    if ($r.StatusCode -eq 200) { $ok = $true }
  } catch {}
}

if ($ok) {
  Write-Host "`n[install] OK - Siphon is serving at http://localhost:$port (and http://<this-pc-ip>:$port)." -ForegroundColor Green
  Write-Host "[install] It starts automatically on boot. Manage it in services.msc, or: net stop $ServiceName / net start $ServiceName" -ForegroundColor Green
  Wait-BeforeClose 'Siphon installed and serving.' 'Green' 20
} else {
  Write-Host "`n[install] WARN - service installed but http://localhost:$port is not responding (possible startup crash)." -ForegroundColor Red
  $errLog = Join-Path $logPath 'siphon-service.err.log'
  if (Test-Path $errLog) {
    Write-Host "--- last errors ($errLog) ---" -ForegroundColor Yellow
    Get-Content $errLog -Tail 15
  }
  Wait-BeforeClose 'Install finished with a warning - the service is not serving yet.' 'Red' 120
  exit 1
}
