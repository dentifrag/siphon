[CmdletBinding()]
param([switch]$Inspect, [switch]$Library)

$ErrorActionPreference = 'Stop'
if (-not $Library) { Set-StrictMode -Version Latest }
. (Join-Path $PSScriptRoot 'SiphonUpdater.Core.ps1')

function Get-SiphonPowerShell {
    return Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
}

function Get-SiphonTaskArguments([string]$Directory) {
    return '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $Directory 'Update-SiphonService.ps1') + '"'
}

function Assert-SiphonLocalVolume([string]$Directory) {
    $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Directory))
    if ($root -cnotmatch '^[A-Za-z]:\\$') { throw 'Updater installation requires a local fixed NTFS volume.' }
    $drive = New-Object IO.DriveInfo($root)
    if ($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS') {
        throw 'Updater installation requires a local fixed NTFS volume.'
    }
}

function Assert-SiphonNoReparse([string]$Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Reparse points are not supported in a service installation.'
            }
        }
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Test-SiphonTrustedSid([string]$Sid) {
    return $Sid -in @(
        'S-1-5-18', 'S-1-5-32-544',
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    )
}

function Assert-SiphonAcl([string]$Path, [switch]$Ancestor) {
    Assert-SiphonNoReparse $Path
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not (Test-SiphonTrustedSid $owner)) {
        throw "Installation ownership is not administrator-controlled: $Path"
    }
    $dangerous = [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    if (-not $Ancestor) {
        $dangerous = $dangerous -bor [Security.AccessControl.FileSystemRights]::Write
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if (
            $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            -not (Test-SiphonTrustedSid $rule.IdentityReference.Value) -and
            ($rule.FileSystemRights -band $dangerous) -ne 0 -and
            ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
        ) { throw "Installation path permits an untrusted writer: $Path" }
    }
}

function Assert-SiphonAncestors([string]$Directory) {
    $current = Split-Path -Parent ([IO.Path]::GetFullPath($Directory))
    while ($current) {
        Assert-SiphonAcl $current -Ancestor
        $parent = Split-Path -Parent $current
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Assert-SiphonServicePaths {
    param([string]$ExecutablePath, [string]$WrapperPath)
    $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ExecutablePath))
    Assert-SiphonLocalVolume $directory
    Assert-SiphonAncestors $directory
    foreach ($path in @($directory, $ExecutablePath, $WrapperPath, [IO.Path]::ChangeExtension($WrapperPath, '.xml'))) {
        Assert-SiphonAcl $path
    }
}

function Set-SiphonProtection([string]$Path, [switch]$Readable) {
    Assert-SiphonNoReparse $Path
    $item = Get-Item -LiteralPath $Path -Force
    $acl = if ($item.PSIsContainer) {
        New-Object Security.AccessControl.DirectorySecurity
    } else {
        New-Object Security.AccessControl.FileSecurity
    }
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = if ($item.PSIsContainer) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sid)),
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
    }
    if ($Readable) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),
            [Security.AccessControl.FileSystemRights]::ReadAndExecute,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Write-SiphonJson([string]$Path, $Value) {
    Assert-SiphonNoReparse $Path
    $pending = "$Path.$([Guid]::NewGuid().ToString('N')).pending"
    try {
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))
        $stream = [IO.File]::Open($pending, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Set-SiphonProtection $pending
        if (Test-Path -LiteralPath $Path) {
            [IO.File]::Replace($pending, $Path, $null)
        } else {
            [IO.File]::Move($pending, $Path)
        }
    } finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
    }
}

function Read-SiphonJson([string]$Path) {
    Assert-SiphonNoReparse $Path
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    Assert-SiphonAcl $Path
    if ((Get-Item -LiteralPath $Path).Length -gt 65536) { throw 'Protected updater metadata exceeds the allowed size.' }
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Open-SiphonWorkerLock([string]$Directory) {
    $path = Join-Path $Directory 'worker.lock'
    Assert-SiphonNoReparse $path
    if (-not (Test-Path -LiteralPath $path)) {
        [IO.File]::WriteAllText($path, '')
        Set-SiphonProtection $path
    }
    Assert-SiphonAcl $path
    return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
}

function Assert-SiphonLifecycleIdle([string]$Directory) {
    $task = Get-ScheduledTask -TaskPath '\' -TaskName 'SiphonUpdate' -ErrorAction SilentlyContinue
    if ($task -and $task.State -notin @('Ready', 'Disabled')) { throw 'The update task is active or unknown; installation changes are refused.' }
    $request = Read-SiphonJson (Join-Path $Directory 'request.json')
    if ($null -eq $request) {
        if (Test-Path -LiteralPath (Join-Path $Directory 'previous.exe')) {
            throw 'A recovery backup without an accepted request requires administrator recovery.'
        }
        return
    }
    $journal = Read-SiphonJson (Join-Path $Directory 'job.json')
    if (
        $null -eq $journal -or (Get-SiphonValue $journal 'id') -ne (Get-SiphonValue $request 'id') -or
        (Get-SiphonValue $journal 'fromVersion') -cne (Get-SiphonValue $request 'fromVersion') -or
        (Get-SiphonValue $journal 'toVersion') -cne (Get-SiphonValue $request 'toVersion') -or
        (Get-SiphonValue $journal 'phase') -notin @('succeeded', 'rolled-back', 'failed') -or
        (Get-SiphonValue $journal 'serviceHealth') -ne 'healthy'
    ) { throw 'An accepted update is unfinished or recovery is uncertain; installation changes are refused.' }
}

function Retire-SiphonCompletedRequest([string]$Directory) {
    Assert-SiphonLifecycleIdle $Directory
    if (-not (Test-Path -LiteralPath (Join-Path $Directory 'request.json'))) { return }
    foreach ($name in @('request.json', 'scheduling.json', 'previous.exe', 'previous.exe.copying', 'staged.exe')) {
        $path = Join-Path $Directory $name
        Assert-SiphonNoReparse $path
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
}

function Get-SiphonHealthUri([string]$Bind, [int]$Port) {
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid installed service port.' }
    $address = if ($Bind -in @('0.0.0.0', '127.0.0.1')) {
        '127.0.0.1'
    } elseif ($Bind -in @('::', '::1')) {
        '[::1]'
    } else {
        $ip = $null
        if (-not [Net.IPAddress]::TryParse($Bind, [ref]$ip)) { throw 'Updater health requires a local IP bind address.' }
        if (-not (Get-NetIPAddress -IPAddress $Bind -ErrorAction SilentlyContinue)) {
            throw 'The installed bind address is not a local interface.'
        }
        if ($ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { "[$Bind]" } else { $Bind }
    }
    return "http://${address}:$Port/api/health"
}

function New-SiphonInstallationConfig {
    param($Config, [string]$ExecutablePath, [string]$WrapperPath, [string]$UpdaterDirectory, [string]$ServiceName)
    $exeDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ExecutablePath))
    if (
        $ServiceName -cne 'Siphon' -or
        $ExecutablePath -cne [IO.Path]::Combine($exeDirectory, 'siphon-win-x64.exe') -or
        $WrapperPath -cne [IO.Path]::Combine($exeDirectory, 'siphon-service.exe') -or
        $UpdaterDirectory -cne [IO.Path]::Combine($exeDirectory, 'siphon-updater') -or
        $UpdaterDirectory.Contains('"')
    ) { throw 'Unsupported service installation identity.' }
    $values = if ($Config -is [System.Collections.IDictionary]) { $Config.Values } else {
        $Config.PSObject.Properties | ForEach-Object { $_.Value }
    }
    foreach ($value in $values) {
        $null = [Xml.XmlConvert]::VerifyXmlChars([string]$value)
    }
    $port = [string](Get-SiphonValue $Config 'port')
    if ($port -cnotmatch '^[1-9][0-9]{0,4}$') { throw 'Invalid installed service port.' }
    $bind = [string](Get-SiphonValue $Config 'host')
    $data = [string](Get-SiphonValue $Config 'dataDir')
    if ([string]::IsNullOrWhiteSpace($data)) { throw 'Installed service data directory is required.' }
    $null = [IO.Path]::GetFullPath($data)
    $health = Get-SiphonHealthUri $bind ([int]$port)
    return [ordered]@{
        protocolVersion = 1
        executablePath = $ExecutablePath
        wrapperPath = $WrapperPath
        serviceName = $ServiceName
        taskName = 'SiphonUpdate'
        host = $bind
        port = [int]$port
        healthUri = $health
        stagePath = [IO.Path]::Combine($UpdaterDirectory, 'staged.exe')
        backupPath = [IO.Path]::Combine($UpdaterDirectory, 'previous.exe')
    }
}

function Assert-SiphonTaskSecurity([string]$SecurityDescriptor) {
    $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor($SecurityDescriptor)
    if (
        $null -eq $descriptor.Owner -or
        -not (Test-SiphonTrustedSid $descriptor.Owner.Value) -or
        $null -eq $descriptor.DiscretionaryAcl
    ) { throw 'Scheduled Task ownership or protected access is not trusted.' }
    foreach ($ace in $descriptor.DiscretionaryAcl) {
        if ($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed -and -not (Test-SiphonTrustedSid $ace.SecurityIdentifier.Value)) {
            throw 'Scheduled Task access is not restricted to administrators and SYSTEM.'
        }
    }
    # Task Scheduler omits the protection flag; verify it on the persisted task file.
    $taskPath = Join-Path $env:SystemRoot 'System32\Tasks\SiphonUpdate'
    Assert-SiphonAcl $taskPath
    if (-not (Get-Acl -LiteralPath $taskPath).AreAccessRulesProtected) {
        throw 'Scheduled Task file access is not protected.'
    }
}

function Get-SiphonInstallation([string]$Directory) {
    $Directory = [IO.Path]::GetFullPath($Directory)
    Assert-SiphonLocalVolume $Directory
    $exeDirectory = Split-Path -Parent $Directory
    if ((Split-Path -Leaf $Directory) -cne 'siphon-updater' -or $Directory.Contains('"')) {
        throw 'Unsupported updater directory identity.'
    }
    Assert-SiphonAncestors $exeDirectory
    Assert-SiphonAcl $exeDirectory
    Assert-SiphonAcl $Directory
    foreach ($path in Get-ChildItem -LiteralPath $Directory -Force) {
        Assert-SiphonAcl $path.FullName
    }
    $config = Read-SiphonJson (Join-Path $Directory 'installation.json')
    if (
        $null -eq $config -or $config.protocolVersion -ne 1 -or
        $config.serviceName -cne 'Siphon' -or $config.taskName -cne 'SiphonUpdate' -or
        $config.executablePath -cne (Join-Path $exeDirectory 'siphon-win-x64.exe') -or
        $config.wrapperPath -cne (Join-Path $exeDirectory 'siphon-service.exe') -or
        $config.stagePath -cne (Join-Path $Directory 'staged.exe') -or
        $config.backupPath -cne (Join-Path $Directory 'previous.exe') -or
        $config.healthUri -cne (Get-SiphonHealthUri $config.host $config.port)
    ) { throw 'Protected service installation identity or helper protocol mismatch.' }
    Assert-SiphonAcl $config.executablePath
    Assert-SiphonAcl $config.wrapperPath
    $xmlPath = [IO.Path]::ChangeExtension($config.wrapperPath, '.xml')
    Assert-SiphonAcl $xmlPath
    if ((Get-FileHash -LiteralPath $config.wrapperPath -Algorithm SHA256).Hash -cne '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA') {
        throw 'Installed WinSW identity differs from the pinned wrapper.'
    }
    [xml]$xml = Get-Content -LiteralPath $xmlPath -Raw
    $envValues = @{}
    foreach ($entry in $xml.service.env) { $envValues[$entry.name] = $entry.value }
    if (
        $xml.service.id -cne $config.serviceName -or $xml.service.executable -cne $config.executablePath -or
        $envValues['HOST'] -cne $config.host -or $envValues['PORT'] -cne "$($config.port)" -or
        $envValues['SIPHON_UPDATER_DIR'] -cne $Directory
    ) { throw 'WinSW configuration does not match the protected installation record.' }
    $service = Get-CimInstance Win32_Service -Filter "Name='Siphon'"
    if (
        $null -eq $service -or $service.StartName -notin @('LocalSystem', 'NT AUTHORITY\SYSTEM') -or
        $service.PathName -notin @($config.wrapperPath, "`"$($config.wrapperPath)`"")
    ) { throw 'The existing service is not the recorded SYSTEM WinSW service.' }
    $task = Get-ScheduledTask -TaskPath '\' -TaskName 'SiphonUpdate'
    $actions = @($task.Actions)
    if (
        $actions.Count -ne 1 -or $actions[0].Execute -cne (Get-SiphonPowerShell) -or
        $actions[0].Arguments -cne (Get-SiphonTaskArguments $Directory) -or
        $actions[0].WorkingDirectory -cne $Directory -or
        $task.Principal.UserId -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18') -or
        $task.Principal.LogonType -ne 'ServiceAccount' -or
        $task.Principal.RunLevel -ne 'Highest' -or
        $task.Settings.MultipleInstances -ne 'IgnoreNew' -or
        $task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries -or
        $task.Settings.ExecutionTimeLimit -ne 'PT45M' -or $task.State -notin @('Ready', 'Running', 'Queued') -or
        -not $task.Settings.AllowDemandStart -or -not $task.Settings.StartWhenAvailable -or
        @($task.Triggers).Count -ne 1 -or
        $task.Triggers[0].Delay -ne 'PT30S' -or
        @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count -ne 1
    ) { throw 'The protected Scheduled Task identity or recovery settings do not match.' }
    $scheduler = New-Object -ComObject 'Schedule.Service'
    $scheduler.Connect()
    $registered = $scheduler.GetFolder('\').GetTask('SiphonUpdate')
    Assert-SiphonTaskSecurity $registered.GetSecurityDescriptor(7)
    return @{
        config = $config
        taskIdle = $task.State -eq 'Ready'
        serviceRunning = $service.State -eq 'Running'
        servicePid = $service.ProcessId
    }
}

function Invoke-SiphonFetch([string]$Uri, [long]$Limit, [string]$Destination = '') {
    Add-Type -AssemblyName System.Net.Http
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $handler = New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $client = New-Object Net.Http.HttpClient($handler)
    $budgetSeconds = if ($Destination) { 600 } else { 20 }
    $client.Timeout = [TimeSpan]::FromSeconds([math]::Min(30, $budgetSeconds))
    $client.DefaultRequestHeaders.UserAgent.ParseAdd('Siphon-updater/1')
    $client.DefaultRequestHeaders.Accept.ParseAdd('application/json')
    $response = $null
    $output = $null
    $inputStream = $null
    $budget = [Diagnostics.Stopwatch]::StartNew()
    try {
        for ($redirect = 0; $redirect -le 3; $redirect++) {
            $address = [Uri]$Uri
            $isApi = $address.Host -ceq 'api.github.com' -and $address.AbsolutePath -cmatch '^/repos/dentifrag/siphon/releases/tags/v?[0-9]+\.[0-9]+\.[0-9]+$'
            $isDownload = $address.Host -ceq 'github.com' -and $address.AbsolutePath -cmatch '^/dentifrag/siphon/releases/download/v?[0-9]+\.[0-9]+\.[0-9]+/siphon-win-x64\.(exe|update\.json)$'
            $isStorage = $redirect -gt 0 -and $address.Host -ceq 'release-assets.githubusercontent.com' -and $address.AbsolutePath.StartsWith('/github-production-release-asset/')
            if (
                $address.Scheme -cne 'https' -or -not $address.IsDefaultPort -or $address.UserInfo -or
                $address.Fragment -or -not ($isApi -or $isDownload -or $isStorage)
            ) { throw 'Network request is outside the official Siphon release channel.' }
            $response = $client.GetAsync($address, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            if ([int]$response.StatusCode -in @(301, 302, 303, 307, 308)) {
                $next = $response.Headers.Location
                if ($null -eq $next) { throw 'Official asset redirect has no location.' }
                $next = New-Object Uri($address, $next)
                if ($next.Host -cne 'release-assets.githubusercontent.com') { throw 'Asset redirect is not official GitHub release storage.' }
                $Uri = $next.AbsoluteUri
                $response.Dispose()
                $response = $null
                continue
            }
            if (-not $response.IsSuccessStatusCode) { throw "Official release request failed ($([int]$response.StatusCode))." }
            if ($response.Content.Headers.ContentLength -gt $Limit) { throw 'Official release asset exceeds the pinned size limit.' }
            $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $output = if ($Destination) {
                Assert-SiphonNoReparse $Destination
                [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
            } else { New-Object IO.MemoryStream }
            $buffer = New-Object byte[] 65536
            $total = 0L
            for (;;) {
                $cancel = New-Object Threading.CancellationTokenSource
                try {
                    $remaining = [math]::Max(1, ($budgetSeconds - $budget.Elapsed.TotalSeconds) * 1000)
                    $cancel.CancelAfter([int][math]::Min(30000, $remaining))
                    $count = $inputStream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).GetAwaiter().GetResult()
                } finally { $cancel.Dispose() }
                if ($count -eq 0) { break }
                $total += $count
                if ($total -gt $Limit -or $budget.Elapsed.TotalSeconds -gt $budgetSeconds) {
                    throw 'Official release download exceeded the size or time limit.'
                }
                $output.Write($buffer, 0, $count)
            }
            if ($Destination) {
                $output.Flush($true)
                return
            }
            return ,$output.ToArray()
        }
        throw 'Too many official asset redirects.'
    } finally {
        if ($null -ne $inputStream) { $inputStream.Dispose() }
        if ($null -ne $output) { $output.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
        $handler.Dispose()
    }
}

function Assert-SiphonPublishedRequest($Request, [string]$Directory) {
    Assert-SiphonRequest $Request
    $proof = Read-SiphonJson (Join-Path $Directory 'proof.json')
    if ($null -eq $proof -or $proof.id -cne $Request.id) { throw 'Pinned release proof does not match the accepted request.' }
    $bytes = Invoke-SiphonFetch "https://api.github.com/repos/dentifrag/siphon/releases/tags/$($Request.releaseTag)" 2097152
    $release = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    if (
        $release.id -ne $proof.releaseId -or $release.tag_name -cne $Request.releaseTag -or
        $release.draft -ne $false -or $release.prerelease -ne $false -or
        $release.html_url -cne "https://github.com/dentifrag/siphon/releases/tag/$($Request.releaseTag)"
    ) { throw 'The accepted release is no longer the exact official published release.' }
    $exe = @($release.assets | Where-Object { $_.name -ceq 'siphon-win-x64.exe' })
    $manifest = @($release.assets | Where-Object { $_.name -ceq 'siphon-win-x64.update.json' })
    if (
        $exe.Count -ne 1 -or $manifest.Count -ne 1 -or
        $exe[0].id -ne $proof.assetId -or $manifest[0].id -ne $proof.manifestId -or
        $exe[0].size -ne $Request.sizeBytes -or $exe[0].browser_download_url -cne $Request.assetUrl -or
        $manifest[0].browser_download_url -cne "https://github.com/dentifrag/siphon/releases/download/$($Request.releaseTag)/siphon-win-x64.update.json"
    ) { throw 'Pinned Windows release assets changed identity or size.' }
    $digest = Get-SiphonValue $exe[0] 'digest'
    if ($digest -and $digest -cne "sha256:$($Request.sha256)") { throw 'Published executable digest differs from the accepted digest.' }
    $bytes = Invoke-SiphonFetch $manifest[0].browser_download_url 16384
    $metadata = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    if (
        $metadata.protocolVersion -ne 1 -or $metadata.version -cne $Request.toVersion -or
        $metadata.assetName -cne $Request.assetName -or $metadata.sizeBytes -ne $Request.sizeBytes -or
        $metadata.sha256 -cne $Request.sha256
    ) { throw 'Published Windows manifest differs from the accepted request.' }
}

function Stop-SiphonInstalledService($Config) {
    $service = Get-Service -Name $Config.serviceName
    if ($service.Status -ne 'Stopped') {
        $service.Stop()
        $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(45))
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            if (-not (Test-Path -LiteralPath $Config.executablePath)) { return }
            $file = [IO.File]::Open($Config.executablePath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $file.Dispose()
            return
        } catch { Start-Sleep -Milliseconds 300 }
    }
    throw 'Installed executable remained locked after the bounded service stop.'
}

function Start-SiphonInstalledService($Config) {
    $service = Get-Service -Name $Config.serviceName
    if ($service.Status -ne 'Running') { $service.Start() }
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(45))
}

function Get-SiphonHealthMilliseconds([long]$Deadline) {
    $remaining = [math]::Floor(($Deadline - [Diagnostics.Stopwatch]::GetTimestamp()) * 1000 / [Diagnostics.Stopwatch]::Frequency)
    if ($remaining -le 0) { throw 'Local health deadline exceeded.' }
    return [int][math]::Min(3000, $remaining)
}

function Get-SiphonHealthCim {
    param([string]$ClassName, [string]$Filter, [long]$Deadline, [string]$Namespace = 'ROOT/cimv2')
    $seconds = [int][math]::Floor((Get-SiphonHealthMilliseconds $Deadline) / 1000)
    if ($seconds -lt 1) { throw 'Insufficient time remains for bounded health identity verification.' }
    $result = Get-CimInstance -ClassName $ClassName -Namespace $Namespace -Filter $Filter -OperationTimeoutSec $seconds -ErrorAction Stop
    $null = Get-SiphonHealthMilliseconds $Deadline
    return $result
}

function Get-SiphonHealthAddress([Net.IPAddress]$Address) {
    if ($Address.IsIPv4MappedToIPv6) { return $Address.MapToIPv4() }
    return $Address
}

function Get-SiphonHealthConnectionOwner {
    param([Net.IPEndPoint]$LocalEndpoint, [Net.IPEndPoint]$RemoteEndpoint, [long]$Deadline)
    $clientAddress = Get-SiphonHealthAddress $LocalEndpoint.Address
    $serverAddress = Get-SiphonHealthAddress $RemoteEndpoint.Address
    $rows = @(Get-SiphonHealthCim -ClassName 'MSFT_NetTCPConnection' -Namespace 'ROOT/StandardCimv2' -Filter "State = 5 AND LocalPort = $($RemoteEndpoint.Port) AND RemotePort = $($LocalEndpoint.Port)" -Deadline $Deadline)
    $matches = @($rows | Where-Object {
        $_.State -eq 5 -and $_.LocalPort -eq $RemoteEndpoint.Port -and $_.RemotePort -eq $LocalEndpoint.Port -and
        (Get-SiphonHealthAddress ([Net.IPAddress]::Parse($_.LocalAddress))).Equals($serverAddress) -and
        (Get-SiphonHealthAddress ([Net.IPAddress]::Parse($_.RemoteAddress))).Equals($clientAddress)
    })
    if ($matches.Count -ne 1 -or [long]$matches[0].OwningProcess -le 0) {
        throw 'Health response connection has no unique established server owner.'
    }
    return [long]$matches[0].OwningProcess
}

function Assert-SiphonHealthConnection {
    param(
        $Config,
        [Net.IPEndPoint]$LocalEndpoint,
        [Net.IPEndPoint]$RemoteEndpoint,
        [long]$Deadline = ([Diagnostics.Stopwatch]::GetTimestamp() + 3 * [Diagnostics.Stopwatch]::Frequency)
    )
    if ($null -eq $LocalEndpoint -or $null -eq $RemoteEndpoint -or $Config.serviceName -cne 'Siphon') {
        throw 'Invalid recorded health connection identity.'
    }
    $ownerId = Get-SiphonHealthConnectionOwner -LocalEndpoint $LocalEndpoint -RemoteEndpoint $RemoteEndpoint -Deadline $Deadline
    $services = @(Get-SiphonHealthCim -ClassName 'Win32_Service' -Filter "Name = 'Siphon'" -Deadline $Deadline)
    if ($services.Count -ne 1 -or $null -eq $services[0]) { throw 'Recorded health service is missing or ambiguous.' }
    $service = $services[0]
    $serviceId = [long]$service.ProcessId
    $serviceName = [string]$service.Name
    $serviceState = [string]$service.State
    $serviceAccount = [string]$service.StartName
    $servicePath = [string]$service.PathName
    if (
        $serviceName -cne $Config.serviceName -or $serviceState -cne 'Running' -or $serviceId -le 0 -or
        $serviceAccount -notin @('LocalSystem', 'NT AUTHORITY\SYSTEM') -or
        $servicePath -cnotin @($Config.wrapperPath, "`"$($Config.wrapperPath)`"")
    ) { throw 'Health responder does not belong to the recorded running SYSTEM service.' }
    $apps = @(Get-SiphonHealthCim -ClassName 'Win32_Process' -Filter "ProcessId = $ownerId" -Deadline $Deadline)
    if ($apps.Count -ne 1 -or $null -eq $apps[0]) { throw 'Connected Siphon responder is missing or ambiguous.' }
    $app = $apps[0]
    $appId = [long]$app.ProcessId
    $parentId = [long]$app.ParentProcessId
    $appPath = [string]$app.ExecutablePath
    $appBirth = $app.CreationDate
    if (
        $appId -ne $ownerId -or $parentId -ne $serviceId -or $appPath -cne $Config.executablePath -or
        $appBirth -isnot [datetime]
    ) { throw 'Connected health responder is not the recorded direct Siphon service child.' }
    $wrappers = @(Get-SiphonHealthCim -ClassName 'Win32_Process' -Filter "ProcessId = $serviceId" -Deadline $Deadline)
    if ($wrappers.Count -ne 1 -or $null -eq $wrappers[0]) { throw 'Recorded WinSW process is missing or ambiguous.' }
    $wrapper = $wrappers[0]
    $wrapperId = [long]$wrapper.ProcessId
    $wrapperPath = [string]$wrapper.ExecutablePath
    $wrapperBirth = $wrapper.CreationDate
    if (
        $wrapperId -ne $serviceId -or $wrapperPath -cne $Config.wrapperPath -or
        $wrapperBirth -isnot [datetime] -or $wrapperBirth.ToUniversalTime() -gt $appBirth.ToUniversalTime()
    ) { throw 'Recorded WinSW parent identity or process creation order is invalid.' }
    $confirmedOwner = Get-SiphonHealthConnectionOwner -LocalEndpoint $LocalEndpoint -RemoteEndpoint $RemoteEndpoint -Deadline $Deadline
    if ($confirmedOwner -ne $ownerId) { throw 'Health connection ownership changed during identity verification.' }
    return ([ordered]@{
        localAddress = (Get-SiphonHealthAddress $LocalEndpoint.Address).ToString()
        localPort = $LocalEndpoint.Port
        remoteAddress = (Get-SiphonHealthAddress $RemoteEndpoint.Address).ToString()
        remotePort = $RemoteEndpoint.Port
        appPid = $appId
        appBirth = $appBirth.ToUniversalTime().Ticks
        appPath = $appPath
        parentPid = $parentId
        wrapperPid = $wrapperId
        wrapperBirth = $wrapperBirth.ToUniversalTime().Ticks
        wrapperPath = $wrapperPath
        serviceName = $serviceName
        serviceState = $serviceState
        serviceAccount = $serviceAccount
        servicePath = $servicePath
    } | ConvertTo-Json -Compress)
}

function Get-SiphonVersionHealth($Config) {
    $deadline = [Diagnostics.Stopwatch]::GetTimestamp() + 3 * [Diagnostics.Stopwatch]::Frequency
    $uri = [uri]$Config.healthUri
    $address = $null
    if (
        -not $uri.IsAbsoluteUri -or $uri.Scheme -cne 'http' -or $uri.AbsolutePath -cne '/api/health' -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.Port -lt 1 -or $uri.Port -gt 65535 -or
        -not [Net.IPAddress]::TryParse($uri.DnsSafeHost.Trim([char[]]'[]'), [ref]$address)
    ) { throw 'Health transport requires the recorded numeric IP endpoint.' }
    $client = New-Object Net.Sockets.TcpClient -ArgumentList $address.AddressFamily
    $stream = $null
    try {
        $connecting = $client.ConnectAsync($address, $uri.Port)
        if (-not $connecting.Wait((Get-SiphonHealthMilliseconds $deadline))) { throw 'Local health connection timed out.' }
        $null = $connecting.GetAwaiter().GetResult()
        if (-not $client.Connected -or -not $client.Client.Connected) { throw 'Local health connection is closed.' }
        $before = Assert-SiphonHealthConnection -Config $Config -LocalEndpoint $client.Client.LocalEndPoint -RemoteEndpoint $client.Client.RemoteEndPoint -Deadline $deadline
        $stream = $client.GetStream()
        $hostPart = if ($address.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6) { "[$address]" } else { "$address" }
        $request = [Text.Encoding]::ASCII.GetBytes("GET /api/health HTTP/1.1`r`nHost: ${hostPart}:$($uri.Port)`r`nAccept: application/json`r`nAccept-Encoding: identity`r`nConnection: keep-alive`r`n`r`n")
        $stream.WriteTimeout = Get-SiphonHealthMilliseconds $deadline
        $stream.Write($request, 0, $request.Length)
        $headers = New-Object 'System.Collections.Generic.List[byte]'
        for (;;) {
            if ($headers.Count -ge 4096) { throw 'Local health headers exceed the allowed size.' }
            $stream.ReadTimeout = Get-SiphonHealthMilliseconds $deadline
            $value = $stream.ReadByte()
            if ($value -lt 0) { throw 'Truncated local health response headers.' }
            if ($value -gt 126 -or ($value -lt 32 -and $value -notin @(9, 10, 13))) { throw 'Malformed local health response headers.' }
            $headers.Add([byte]$value)
            $size = $headers.Count
            if ($size -ge 4 -and $headers[$size - 4] -eq 13 -and $headers[$size - 3] -eq 10 -and $headers[$size - 2] -eq 13 -and $headers[$size - 1] -eq 10) { break }
        }
        $headerText = [Text.Encoding]::ASCII.GetString($headers.ToArray())
        $lines = $headerText.Substring(0, $headerText.Length - 4) -split "`r`n"
        if ($lines[0] -cnotmatch '^HTTP/1\.1 200 [\x20-\x7e]*$') { throw 'Local health requires a successful HTTP/1.1 response.' }
        $length = $null
        for ($index = 1; $index -lt $lines.Count; $index++) {
            $field = [regex]::Match($lines[$index], '^(?<name>[!#$%&''*+.^_`|~0-9A-Za-z-]+):(?<value>[\t\x20-\x7e]*)$')
            if (-not $field.Success) { throw 'Malformed local health response header.' }
            $name = $field.Groups['name'].Value.ToLowerInvariant()
            $value = $field.Groups['value'].Value.Trim()
            if ($name -eq 'content-length') {
                if ($null -ne $length -or $value -cnotmatch '^[0-9]{1,4}$' -or [int]$value -gt 4096) {
                    throw 'Local health requires one bounded Content-Length.'
                }
                $length = [int]$value
            } elseif ($name -eq 'transfer-encoding' -or ($name -eq 'content-encoding' -and $value -ine 'identity')) {
                throw 'Encoded or transfer-encoded local health responses are unsupported.'
            }
        }
        if ($null -eq $length) { throw 'Local health response lacks Content-Length.' }
        $body = New-Object byte[] $length
        $offset = 0
        while ($offset -lt $length) {
            $stream.ReadTimeout = Get-SiphonHealthMilliseconds $deadline
            $count = $stream.Read($body, $offset, $length - $offset)
            if ($count -le 0) { throw 'Truncated local health response body.' }
            $offset += $count
        }
        if (-not $client.Connected -or -not $client.Client.Connected) { throw 'Health connection closed before response verification.' }
        $after = Assert-SiphonHealthConnection -Config $Config -LocalEndpoint $client.Client.LocalEndPoint -RemoteEndpoint $client.Client.RemoteEndPoint -Deadline $deadline
        if ($before -cne $after -or -not $client.Connected -or -not $client.Client.Connected) {
            throw 'Health responder identity changed or its connection closed while reading.'
        }
        $encoding = New-Object Text.UTF8Encoding -ArgumentList $false, $true
        $health = $encoding.GetString($body) | ConvertFrom-Json -ErrorAction Stop
        if ($null -eq $health -or $health -is [array] -or $health.app -isnot [string] -or $health.version -isnot [string]) {
            throw 'Malformed local version health JSON.'
        }
        $null = Get-SiphonHealthMilliseconds $deadline
        return @{ app = $health.app; version = $health.version; serviceRunning = $true }
    } finally {
        try {
            if ($null -ne $stream) { $stream.Dispose() }
        } finally { $client.Dispose() }
    }
}

if ($Library) { return }
$directory = [IO.Path]::GetFullPath($PSScriptRoot)
$installation = Get-SiphonInstallation $directory
$config = $installation.config
if ($Inspect) {
    $inspector = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -OperationTimeoutSec 5
    $app = Get-CimInstance Win32_Process -Filter "ProcessId=$($inspector.ParentProcessId)" -OperationTimeoutSec 5
    if (
        $null -eq $app -or $app.ExecutablePath -cne $config.executablePath -or
        $app.ParentProcessId -ne $installation.servicePid
    ) { throw 'The inspector parent is not the recorded WinSW service executable.' }
    $lockIdle = $false
    if ($installation.taskIdle) {
        try {
            $probe = Open-SiphonWorkerLock $directory
            $probe.Dispose()
            $lockIdle = $true
        } catch {}
    }
    @{
        protocolVersion = $config.protocolVersion
        executablePath = $config.executablePath
        host = $config.host
        port = $config.port
        serviceName = $config.serviceName
        taskName = $config.taskName
        taskIdle = $installation.taskIdle -and $lockIdle
        serviceRunning = $installation.serviceRunning
    } | ConvertTo-Json -Compress
    return
}
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') {
    throw 'The update worker may run only as the preinstalled SYSTEM Scheduled Task.'
}
$request = Read-SiphonJson (Join-Path $directory 'request.json')
if ($null -eq $request) { return }
if (@($request.PSObject.Properties).Count -ne 9) { throw 'Accepted update request contains unexpected fields.' }
$script:workerLock = $null
$operations = @{
    AcquireLock = {
        try { $script:workerLock = Open-SiphonWorkerLock $directory; return $true } catch { return $false }
    }
    ReleaseLock = { if ($null -ne $script:workerLock) { $script:workerLock.Dispose(); $script:workerLock = $null } }
    ReadJournal = { Read-SiphonJson (Join-Path $directory 'job.json') }
    WriteJournal = { param($Journal) Write-SiphonJson (Join-Path $directory 'job.json') $Journal }
    Download = {
        param($Request, $Config)
        $null = Get-SiphonInstallation $directory
        $oldHealthy = $false
        for ($attempt = 0; $attempt -lt 30 -and -not $oldHealthy; $attempt++) {
            try {
                $health = Get-SiphonVersionHealth $Config
                $oldHealthy = $health.app -ceq 'siphon' -and $health.version -ceq $Request.fromVersion -and $health.serviceRunning
            } catch {}
            if (-not $oldHealthy) { Start-Sleep -Seconds 1 }
        }
        if (-not $oldHealthy) { throw 'Installed service does not match the pinned old version.' }
        Assert-SiphonPublishedRequest $Request $directory
        Invoke-SiphonFetch $Request.assetUrl $Request.sizeBytes $Config.stagePath
        Set-SiphonProtection $Config.stagePath
        Assert-SiphonPublishedRequest $Request $directory
    }
    GetSha256 = { param($Path) Assert-SiphonAcl $Path; return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
    GetSize = { param($Path) Assert-SiphonAcl $Path; return (Get-Item -LiteralPath $Path).Length }
    StopService = {
        param($Config)
        $null = Get-SiphonInstallation $directory
        Stop-SiphonInstalledService $Config
    }
    Backup = {
        param($Config)
        Assert-SiphonNoReparse $Config.backupPath
        if (Test-Path -LiteralPath $Config.backupPath) { throw 'An existing recovery backup must not be overwritten.' }
        $pending = "$($Config.backupPath).copying"
        Assert-SiphonNoReparse $pending
        try {
            $expected = (Get-FileHash -LiteralPath $Config.executablePath -Algorithm SHA256).Hash
            [IO.File]::Copy($Config.executablePath, $pending, $true)
            $stream = [IO.File]::Open($pending, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $stream.Flush($true) } finally { $stream.Dispose() }
            Set-SiphonProtection $pending
            if ($expected -cne (Get-FileHash -LiteralPath $pending -Algorithm SHA256).Hash) {
                throw 'Old executable backup verification failed.'
            }
            [IO.File]::Move($pending, $Config.backupPath)
        } finally {
            if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
        }
    }
    Replace = {
        param($Config)
        Assert-SiphonAcl $Config.stagePath
        Assert-SiphonAcl $Config.executablePath
        [IO.File]::Replace($Config.stagePath, $Config.executablePath, $null)
        Set-SiphonProtection $Config.executablePath -Readable
    }
    StartService = { param($Config) Start-SiphonInstalledService $Config }
    CheckHealth = { param($ExpectedVersion, $Config) Get-SiphonVersionHealth $Config }
    Restore = {
        param($Config)
        Assert-SiphonAcl $Config.backupPath
        Assert-SiphonNoReparse $Config.executablePath
        [IO.File]::Copy($Config.backupPath, $Config.executablePath, $true)
        $stream = [IO.File]::Open($Config.executablePath, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Flush($true) } finally { $stream.Dispose() }
        Set-SiphonProtection $Config.executablePath -Readable
    }
    BackupExists = { param($Config) Assert-SiphonNoReparse $Config.backupPath; return Test-Path -LiteralPath $Config.backupPath }
    RemoveBackup = {
        param($Config)
        foreach ($path in @($Config.backupPath, $Config.stagePath)) {
            Assert-SiphonNoReparse $path
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
        }
    }
    Wait = { param($Milliseconds) Start-Sleep -Milliseconds $Milliseconds }
}
$result = Invoke-SiphonUpdate -Request $request -Config $config -Operations $operations
if ($result.phase -eq 'rollback-failed') { exit 1 }
