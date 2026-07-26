<#
.SYNOPSIS
  Stop and remove the Siphon Windows service.

.DESCRIPTION
  Stops the service and unregisters it via WinSW (falling back to sc.exe). The wrapper
  exe (dist-bin\siphon-service.exe) and the packaged app are left in place so you can
  reinstall quickly. Use -Purge to also delete the data directory (profiles, rclone
  config, logs) under C:\ProgramData\Siphon (or the configured dataDir).

.PARAMETER Purge
  Also delete the Siphon data directory. This removes saved connections and the rclone
  config - there is no undo.

.EXAMPLE
  ./windows-service/Uninstall-SiphonService.ps1

.EXAMPLE
  ./windows-service/Uninstall-SiphonService.ps1 -Purge
#>
[CmdletBinding()]
param(
  [switch]$Purge
)

$ServiceName = 'Siphon'

# --- Self-elevate: removing a Windows service requires administrator ---
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
  Write-Host 'Requesting administrator privileges (approve the UAC prompt)...' -ForegroundColor Yellow
  $argsList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Purge) { $argsList += '-Purge' }
  try {
    $proc = Start-Process powershell.exe -Verb RunAs -ArgumentList $argsList -PassThru -Wait -ErrorAction Stop
  } catch {
    Write-Host 'Elevation was cancelled - nothing was removed.' -ForegroundColor Red
    exit 1
  }
  exit $proc.ExitCode
}

$ErrorActionPreference = 'Stop'
$here  = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$root  = Split-Path -Parent $here
$winsw = Join-Path $root 'dist-bin\siphon-service.exe'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

$svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Step "Stopping '$ServiceName'"
  try { Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Process -Name 'siphon-win-x64' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
  }

  Step "Removing '$ServiceName'"
  $removed = $false
  if (Test-Path $winsw) {
    try { & $winsw uninstall 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $removed = $true } } catch {}
  }
  if (-not $removed) { & sc.exe delete $ServiceName 2>$null | Out-Null }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Service $ServiceName -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 300
  }
  Write-Host "[uninstall] Service '$ServiceName' removed." -ForegroundColor Green
} else {
  Write-Host "[uninstall] Service '$ServiceName' is not installed." -ForegroundColor DarkGray
}

if ($Purge) {
  $dataDir = 'C:\ProgramData\Siphon'
  $cfgFile = Join-Path $here 'service.config.json'
  if (Test-Path $cfgFile) {
    try { $c = Get-Content $cfgFile -Raw | ConvertFrom-Json; if ($c.dataDir) { $dataDir = $c.dataDir } } catch {}
  }
  Step "Purging data directory: $dataDir"
  if (Test-Path $dataDir) {
    Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "[uninstall] Deleted $dataDir." -ForegroundColor Green
  } else {
    Write-Host "[uninstall] $dataDir does not exist - nothing to purge." -ForegroundColor DarkGray
  }
}
