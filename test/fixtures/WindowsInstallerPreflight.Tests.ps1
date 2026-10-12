param(
    [Parameter(Mandatory = $true)][string]$WorkerPath,
    [ValidateSet('bind', 'acl', 'task-acl')][string]$Scenario = 'bind'
)

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

if ($Scenario -eq 'task-acl') {
    $taskPath = Join-Path $env:SystemRoot 'System32\Tasks\SiphonUpdate'
    $normalized = 'O:BAG:BAD:(A;;FA;;;SY)(A;;FA;;;BA)'
    $protected = 'O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'

    function New-FakeTaskAcl([string]$Owner = 'S-1-5-32-544', [bool]$Protected = $true, [switch]$Writable) {
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($Owner)))
        $acl.SetAccessRuleProtection($Protected, $false)
        foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
                (New-Object Security.Principal.SecurityIdentifier($sid)),
                [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow
            )))
        }
        if ($Writable) {
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
                (New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),
                [Security.AccessControl.FileSystemRights]::Write,
                [Security.AccessControl.AccessControlType]::Allow
            )))
        }
        return $acl
    }
    function Test-Path {
        param([string]$LiteralPath)
        return $LiteralPath -ceq $taskPath
    }
    function Get-Item {
        param([string]$LiteralPath, [switch]$Force)
        if ($LiteralPath -cne $taskPath) { throw 'Unexpected task path.' }
        return @{ Attributes = [IO.FileAttributes]::Normal }
    }
    function Get-Acl {
        param([string]$LiteralPath)
        if ($LiteralPath -cne $taskPath) { throw 'Host ACL reads are forbidden in this fixture.' }
        return $script:taskAcl
    }
    function Set-Acl { throw 'Host ACL changes are forbidden in this fixture.' }

    $script:taskAcl = New-FakeTaskAcl
    foreach ($descriptor in @($normalized, $protected)) {
        Assert-SiphonTaskSecurity $descriptor
    }
    foreach ($entry in @(
        @{ descriptor = 'O:BUG:BAD:(A;;FA;;;SY)(A;;FA;;;BA)'; acl = (New-FakeTaskAcl) },
        @{ descriptor = 'G:BAD:(A;;FA;;;SY)(A;;FA;;;BA)'; acl = (New-FakeTaskAcl) },
        @{ descriptor = 'O:BAG:BA'; acl = (New-FakeTaskAcl) },
        @{ descriptor = 'O:BAG:BAD:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)'; acl = (New-FakeTaskAcl) },
        @{ descriptor = $normalized; acl = (New-FakeTaskAcl -Owner 'S-1-5-21-1-2-3-1001') },
        @{ descriptor = $normalized; acl = (New-FakeTaskAcl -Writable) },
        @{ descriptor = $protected; acl = (New-FakeTaskAcl -Protected $false) }
    )) {
        $script:taskAcl = $entry.acl
        $message = ''
        try { Assert-SiphonTaskSecurity $entry.descriptor } catch { $message = $_.Exception.Message }
        Assert-True ($message -match 'ownership|protected|restricted|untrusted writer') 'Task validation accepted unsafe effective permissions or storage.'
    }
    Write-Output 'PASS: safe normalized task security'
    return
}

if ($Scenario -eq 'acl') {
    $serviceDirectory = 'X:\fake'
    $xml = [IO.Path]::ChangeExtension($wrapper, '.xml')
    $paths = @($serviceDirectory, $executable, $wrapper, $xml)
    $script:fakeAcls = @{}
    $script:aclReads = [System.Collections.Generic.List[string]]::new()

    function New-FakeAcl([string]$Owner = 'S-1-5-32-544', [switch]$Writable) {
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($Owner)))
        foreach ($entry in @(
            @{ sid = 'S-1-5-18'; rights = [Security.AccessControl.FileSystemRights]::FullControl },
            @{ sid = 'S-1-5-32-545'; rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
        )) {
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
                (New-Object Security.Principal.SecurityIdentifier($entry.sid)),
                $entry.rights,
                [Security.AccessControl.AccessControlType]::Allow
            )))
        }
        if ($Writable) {
            $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
                (New-Object Security.Principal.SecurityIdentifier('S-1-1-0')),
                [Security.AccessControl.FileSystemRights]::Write,
                [Security.AccessControl.AccessControlType]::Allow
            )))
        }
        return $acl
    }

    function Test-Path {
        param([string]$LiteralPath, [string]$Path)
        $target = if ($LiteralPath) { $LiteralPath } else { $Path }
        return $script:fakeAcls.ContainsKey($target)
    }
    function Get-Item {
        param([string]$LiteralPath, [switch]$Force)
        return @{
            Attributes = if ($LiteralPath -eq $serviceDirectory) { [IO.FileAttributes]::Directory } else { [IO.FileAttributes]::Normal }
            FullName = $LiteralPath
            PSIsContainer = $LiteralPath -eq $serviceDirectory
        }
    }
    function Get-Acl {
        param([string]$LiteralPath)
        $script:aclReads.Add($LiteralPath)
        return $script:fakeAcls[$LiteralPath]
    }
    function Assert-SiphonLocalVolume { param([string]$Directory) }
    function Set-SiphonProtection { throw 'Preflight must reject unsafe ACLs, not sanitize them.' }
    function Set-Acl { throw 'Host ACL changes are forbidden in this fixture.' }
    function Stop-Service { throw 'Service mutation is forbidden in this fixture.' }
    function Start-Service { throw 'Service mutation is forbidden in this fixture.' }
    function Start-Process { throw 'Elevated process invocation is forbidden in this fixture.' }
    function Get-FileHash { throw 'Service-path trust must be checked before reading executable hashes.' }

    function Reset-FakeAcls {
        $script:fakeAcls.Clear()
        $script:aclReads.Clear()
        foreach ($path in $paths) { $script:fakeAcls[$path] = New-FakeAcl }
    }
    function Assert-ServicePaths {
        Assert-SiphonServicePaths -ExecutablePath $executable -WrapperPath $wrapper
    }

    # Get-Acl returns in-memory DACLs; the production Assert-SiphonAcl is not replaced.
    Reset-FakeAcls
    Assert-ServicePaths
    foreach ($path in $paths) {
        Assert-True $script:aclReads.Contains($path) "Full ownership/DACL preflight omitted $path"
    }
    foreach ($path in $paths) {
        foreach ($unsafe in @('owner', 'writer')) {
            Reset-FakeAcls
            $script:fakeAcls[$path] = if ($unsafe -eq 'owner') {
                New-FakeAcl -Owner 'S-1-5-21-1-2-3-1001'
            } else { New-FakeAcl -Writable }
            $message = ''
            try { Assert-ServicePaths } catch { $message = $_.Exception.Message }
            Assert-True ($message -match 'ownership|untrusted writer') "Preflight accepted an unsafe $unsafe on $path"
        }
    }
    Reset-FakeAcls
    $script:fakeAcls.Remove($wrapper)
    $script:fakeAcls.Remove($xml)
    Assert-ServicePaths
    Assert-True $script:aclReads.Contains($executable) 'First-install preflight omitted the existing app executable'
    Write-Output 'PASS: safe service-path ACL preflight'
    return
}

function Get-Preflight {
    return New-SiphonInstallationConfig -Config $config -ExecutablePath $executable -WrapperPath $wrapper -UpdaterDirectory $directory -ServiceName 'Siphon'
}

foreach ($entry in @(
    @{ bind = '0.0.0.0'; health = 'http://127.0.0.1:8080/api/health' },
    @{ bind = '127.0.0.1'; health = 'http://127.0.0.1:8080/api/health' },
    @{ bind = '::'; health = 'http://[::1]:8080/api/health' },
    @{ bind = '::1'; health = 'http://[::1]:8080/api/health' },
    @{ bind = '192.0.2.10'; health = 'http://192.0.2.10:8080/api/health' }
)) {
    $config.host = $entry.bind
    $result = Get-Preflight
    Assert-True ($result.healthUri -ceq $entry.health) 'Preflight recorded the wrong local health identity'
    Assert-True ($result.host -ceq $entry.bind) 'Preflight lost the configured bind'
    Assert-True ($result.executablePath -ceq $executable) 'Preflight changed the installed executable identity'
}

$config.host = 'localhost'
$message = ''
try { $null = Get-Preflight } catch { $message = $_.Exception.Message }
Assert-True ($message -match 'local IP bind') 'Hostname localhost must fail deterministic preflight with a local IP bind explanation'

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
