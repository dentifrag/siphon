param([Parameter(Mandatory = $true)][string]$WorkerPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $WorkerPath -Library

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-NetIPAddress {
    param([string]$IPAddress, $ErrorAction)
    if ($IPAddress -eq '192.0.2.10') { return @{ IPAddress = $IPAddress } }
    return $null
}

$config = @{ host = '0.0.0.0'; port = 8080; dataDir = 'X:\fake\data' }
$executable = 'X:\fake\siphon-win-x64.exe'
$wrapper = 'X:\fake\siphon-service.exe'
$directory = 'X:\fake\siphon-updater'

function Get-Preflight {
    return New-SiphonInstallationConfig -Config $config -ExecutablePath $executable -WrapperPath $wrapper -UpdaterDirectory $directory -ServiceName 'Siphon'
}

foreach ($entry in @(
    @{ bind = '0.0.0.0'; health = 'http://127.0.0.1:8080/api/health' },
    @{ bind = '::'; health = 'http://[::1]:8080/api/health' },
    @{ bind = '192.0.2.10'; health = 'http://192.0.2.10:8080/api/health' }
)) {
    $config.host = $entry.bind
    $result = Get-Preflight
    Assert-True ($result.healthUri -ceq $entry.health) 'Preflight recorded the wrong local health identity'
    Assert-True ($result.host -ceq $entry.bind) 'Preflight lost the configured bind'
    Assert-True ($result.executablePath -ceq $executable) 'Preflight changed the installed executable identity'
}

foreach ($entry in @(
    @{ host = 'unsupported.example'; port = 8080; dataDir = 'X:\fake\data' },
    @{ host = '192.0.2.11'; port = 8080; dataDir = 'X:\fake\data' },
    @{ host = '::'; port = 0; dataDir = 'X:\fake\data' },
    @{ host = '::'; port = 65536; dataDir = 'X:\fake\data' },
    @{ host = '::'; port = 8080.5; dataDir = 'X:\fake\data' },
    @{ host = '::'; port = 8080; dataDir = "X:\fake\$([char]0)data" }
)) {
    $config = $entry
    $mutatedService = $false
    $rejected = $false
    try {
        $null = Get-Preflight
        $mutatedService = $true
    } catch { $rejected = $true }
    Assert-True $rejected 'Invalid deterministic installer configuration was accepted'
    Assert-True (-not $mutatedService) 'Invalid configuration proceeded past preflight'
}

Write-Output 'PASS: safe installer preflight'
