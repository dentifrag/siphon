param(
    [Parameter(Mandatory = $true)][string]$WorkerPath,
    [ValidateSet('identity', 'http')][string]$Scenario
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $WorkerPath -Library

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function New-Endpoint([string]$Address, [int]$Port) {
    return New-Object Net.IPEndPoint([Net.IPAddress]::Parse($Address), $Port)
}

function Reset-Health([string]$Address = '127.0.0.1', [string]$ClientAddress = '127.0.0.1') {
    $hostPart = if ($Address.Contains(':')) { "[$Address]" } else { $Address }
    $script:config = @{
        executablePath = 'X:\fake\siphon-win-x64.exe'
        wrapperPath = 'X:\fake\siphon-service.exe'
        serviceName = 'Siphon'
        host = $Address
        port = 8080
        healthUri = "http://${hostPart}:8080/api/health"
    }
    $script:local = New-Endpoint $ClientAddress 49152
    $script:remote = New-Endpoint $Address 8080
    $script:service = [pscustomobject]@{
        Name = 'Siphon'; State = 'Running'; StartName = 'LocalSystem'
        PathName = '"X:\fake\siphon-service.exe"'; ProcessId = 100
    }
    $script:app = [pscustomobject]@{
        ProcessId = 200; ParentProcessId = 100; ExecutablePath = $config.executablePath
        CreationDate = [datetime]'2026-10-10T00:01:00Z'
    }
    $script:wrapper = [pscustomobject]@{
        ProcessId = 100; ParentProcessId = 50; ExecutablePath = $config.wrapperPath
        CreationDate = [datetime]'2026-10-10T00:00:00Z'
    }
    $script:extraProcesses = @{}
    $script:rows = @(
        [pscustomobject]@{
            LocalAddress = $Address; LocalPort = 8080; RemoteAddress = $ClientAddress
            RemotePort = 49152; State = 5; OwningProcess = 200
        },
        [pscustomobject]@{
            LocalAddress = $ClientAddress; LocalPort = 49152; RemoteAddress = $Address
            RemotePort = 8080; State = 5; OwningProcess = 999
        },
        [pscustomobject]@{
            LocalAddress = $Address; LocalPort = 8080; RemoteAddress = $ClientAddress
            RemotePort = 49153; State = 5; OwningProcess = 999
        }
    )
    $script:events = [System.Collections.Generic.List[string]]::new()
    $script:onRead = $null
    $script:failure = ''
    $script:position = 0
    $script:requestText = ''
    $script:response = [Text.Encoding]::UTF8.GetBytes((New-Response))
    $script:client = $null
    $script:timeouts = [System.Collections.Generic.List[int]]::new()
    $script:cimDelayMilliseconds = 0
    $script:cimReads = 0
}

function Get-CimInstance {
    param([string]$ClassName, [string]$Namespace, [string]$Filter, [double]$OperationTimeoutSec, $ErrorAction)
    Assert-True ($OperationTimeoutSec -gt 0 -and $OperationTimeoutSec -le 3) 'CIM identity lookup has no finite shared-deadline timeout'
    $script:cimReads++
    if ($script:cimDelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $script:cimDelayMilliseconds }
    if ($script:failure -eq 'cim-timeout') { throw 'Bounded identity query timed out' }
    if ($ClassName -eq 'MSFT_NetTCPConnection') {
        Assert-True ($Namespace -ieq 'ROOT/StandardCimv2') 'Connected ownership must use the underlying TCP CIM provider'
        Assert-True ($Filter -match '\bState\s*=\s*5\b') 'Ownership query must select Established, not a listener snapshot'
        $script:events.Add('tcp-identity')
        return $script:rows
    }
    if ($ClassName -eq 'Win32_Service') {
        Assert-True ($Filter -match "Name\s*=\s*'Siphon'") 'Service lookup lost the recorded identity'
        return $script:service
    }
    if ($ClassName -eq 'Win32_Process') {
        if ($Filter -match '\bProcessId\s*=\s*200\b') { return $script:app }
        if ($Filter -match '\bProcessId\s*=\s*100\b') { return $script:wrapper }
        if ($Filter -match '\bProcessId\s*=\s*(\d+)\b' -and $script:extraProcesses.ContainsKey([int]$Matches[1])) {
            return $script:extraProcesses[[int]$Matches[1]]
        }
        return $null
    }
    throw "Unexpected OS query: $ClassName"
}
function Get-NetTCPConnection { throw 'Listener/process snapshots cannot prove connected responder identity.' }
function Get-Service { throw 'SCM Running alone cannot prove connected responder identity.' }
function Invoke-WebRequest { throw 'A standalone HTTP response cannot prove connected responder identity.' }
function Start-Process { throw 'Process/service mutation is forbidden in this fixture.' }
function Stop-Service { throw 'Process/service mutation is forbidden in this fixture.' }
function Start-Service { throw 'Process/service mutation is forbidden in this fixture.' }

function Read-Identity {
    return Assert-SiphonHealthConnection -Config $config -LocalEndpoint $local -RemoteEndpoint $remote
}

function New-Response(
    [string]$Body = '{"app":"siphon","version":"1.10.0"}',
    [string]$ExtraHeaders = '',
    [string]$Status = 'HTTP/1.1 200 OK'
) {
    $length = [Text.Encoding]::UTF8.GetByteCount($Body)
    return "$Status`r`nContent-Length: $length`r`n${ExtraHeaders}`r`n$Body"
}

# Only TcpClient construction is replaced. Every other New-Object remains the real constructor.
function New-Object {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)][string]$TypeName,
        [Parameter(Position = 1)]$ArgumentList,
        [hashtable]$Property
    )
    if ($TypeName -match '(^|\.)TcpClient$') {
        $script:client = [pscustomobject]@{
            Connected = $false; Closed = $false; ReceiveTimeout = 0; SendTimeout = 0
            Client = [pscustomobject]@{ LocalEndPoint = $script:local; RemoteEndPoint = $script:remote; Connected = $false }
        }
        $script:client | Add-Member ScriptMethod ConnectAsync {
            param($Address, $Port)
            Assert-True ($Address -is [Net.IPAddress]) 'Health connect attempted DNS instead of numeric IPAddress'
            Assert-True ($Address.Equals($script:remote.Address) -and $Port -eq $script:remote.Port) 'Health connect did not use the configured numeric endpoint'
            $script:events.Add('connect')
            return New-FakeTask 'connect'
        }
        $script:client | Add-Member ScriptMethod GetStream {
            return New-FakeStream
        }
        $script:client | Add-Member ScriptMethod Close {
            $this.Closed = $true; $this.Connected = $false; $this.Client.Connected = $false
        }
        $script:client | Add-Member ScriptMethod Dispose { $this.Close() }
        return $script:client
    }
    if ($TypeName -match 'HttpClient|WebClient') { throw 'Opaque HTTP transports cannot bind response identity to the exact connection.' }
    $arguments = @{ TypeName = $TypeName }
    if ($PSBoundParameters.ContainsKey('ArgumentList')) { $arguments.ArgumentList = $ArgumentList }
    if ($PSBoundParameters.ContainsKey('Property')) { $arguments.Property = $Property }
    return Microsoft.PowerShell.Utility\New-Object @arguments
}

function Assert-Timeout([int]$Milliseconds) {
    Assert-True ($Milliseconds -gt 0 -and $Milliseconds -le 3000) 'Socket operation did not use a finite <=3s shared deadline'
    $script:timeouts.Add($Milliseconds)
}
function New-FakeTask([string]$Kind, $Result = $null) {
    $task = [pscustomobject]@{ Kind = $Kind; Result = $Result; IsCompleted = $false }
    $task | Add-Member ScriptMethod Wait {
        param([int]$Milliseconds)
        Assert-Timeout $Milliseconds
        if ($script:failure -eq "$($this.Kind)-timeout") { return $false }
        if ($this.Kind -eq 'connect') {
            $script:client.Connected = $true
            $script:client.Client.Connected = $true
        }
        $this.IsCompleted = $true
        return $true
    }
    $task | Add-Member ScriptMethod GetAwaiter { return $this }
    $task | Add-Member ScriptMethod GetResult {
        Assert-True $this.IsCompleted 'An asynchronous operation was consumed without a bounded wait'
        return $this.Result
    }
    return $task
}
function Read-FakeBytes($Buffer, [int]$Offset, [int]$Count) {
    $script:events.Add('read')
    if ($null -ne $script:onRead) {
        $change = $script:onRead
        $script:onRead = $null
        & $change
    }
    if ($script:failure -eq 'read-timeout') { throw [IO.IOException]::new('Read timed out') }
    $remaining = $script:response.Length - $script:position
    $read = [Math]::Min([Math]::Min($Count, 7), $remaining)
    if ($read -gt 0) {
        [Array]::Copy($script:response, $script:position, $Buffer, $Offset, $read)
        $script:position += $read
    }
    return $read
}
function New-FakeStream {
    $stream = [pscustomobject]@{ ReadTimeout = 0; WriteTimeout = 0; CanRead = $true; CanWrite = $true }
    $stream | Add-Member ScriptMethod Write {
        param($Buffer, [int]$Offset, [int]$Count)
        Assert-Timeout $this.WriteTimeout
        $script:events.Add('write')
        $script:requestText += [Text.Encoding]::ASCII.GetString($Buffer, $Offset, $Count)
        if ($script:failure -eq 'write-timeout') { throw [IO.IOException]::new('Write timed out') }
    }
    $stream | Add-Member ScriptMethod Read {
        param($Buffer, [int]$Offset, [int]$Count)
        Assert-Timeout $this.ReadTimeout
        return Read-FakeBytes $Buffer $Offset $Count
    }
    $stream | Add-Member ScriptMethod ReadByte {
        Assert-Timeout $this.ReadTimeout
        $buffer = [byte[]]@(0)
        if ((Read-FakeBytes $buffer 0 1) -eq 0) { return -1 }
        return [int]$buffer[0]
    }
    $stream | Add-Member ScriptMethod WriteAsync {
        param($Buffer, [int]$Offset, [int]$Count, $CancellationToken)
        $script:events.Add('write')
        $script:requestText += [Text.Encoding]::ASCII.GetString($Buffer, $Offset, $Count)
        return New-FakeTask 'write'
    }
    $stream | Add-Member ScriptMethod ReadAsync {
        param($Buffer, [int]$Offset, [int]$Count, $CancellationToken)
        return New-FakeTask 'read' (Read-FakeBytes $Buffer $Offset $Count)
    }
    $stream | Add-Member ScriptMethod Flush {}
    $stream | Add-Member ScriptMethod Dispose {}
    return $stream
}

if ($Scenario -eq 'identity') {
    foreach ($addresses in @(
        @('127.0.0.1', '127.0.0.1'),
        @('::1', '::1'),
        @('192.0.2.10', '192.0.2.10'),
        @('fe80::1%7', 'fe80::2%7')
    )) {
        Reset-Health $addresses[0] $addresses[1]
        $token = Read-Identity
        Assert-True ($null -ne $token) 'Connected identity did not produce a stable token'
        $again = Read-Identity
        Assert-True (($token | ConvertTo-Json -Depth 8 -Compress) -ceq ($again | ConvertTo-Json -Depth 8 -Compress)) 'Same connected identity produced unstable tokens'
        $script:app.CreationDate = $script:app.CreationDate.AddSeconds(1)
        $changed = Read-Identity
        Assert-True (($token | ConvertTo-Json -Depth 8 -Compress) -cne ($changed | ConvertTo-Json -Depth 8 -Compress)) 'Identity token omitted app creation time'
        $script:wrapper.CreationDate = $script:wrapper.CreationDate.AddSeconds(1)
        $changedAgain = Read-Identity
        Assert-True (($changed | ConvertTo-Json -Depth 8 -Compress) -cne ($changedAgain | ConvertTo-Json -Depth 8 -Compress)) 'Identity token omitted wrapper creation time'
    }
    Reset-Health
    $script:rows[0].LocalAddress = '::ffff:127.0.0.1'
    $script:rows[0].RemoteAddress = '::ffff:127.0.0.1'
    $null = Read-Identity
    Reset-Health
    $script:service.StartName = 'NT AUTHORITY\SYSTEM'
    $script:service.PathName = $config.wrapperPath
    $null = Read-Identity

    foreach ($entry in @(
        @{ name = 'unrelated correct-version responder'; change = { $script:rows[0].OwningProcess = 999 } },
        @{ name = 'wrong app image'; change = { $script:app.ExecutablePath = 'X:\other\app.exe' } },
        @{ name = 'wrong parent'; change = { $script:app.ParentProcessId = 999 } },
        @{ name = 'wrong app PID'; change = { $script:app.ProcessId = 999 } },
        @{ name = 'wrong wrapper PID'; change = { $script:wrapper.ProcessId = 999 } },
        @{ name = 'missing service'; change = { $script:service = $null } },
        @{ name = 'missing wrapper'; change = { $script:wrapper = $null } },
        @{ name = 'missing app'; change = { $script:app = $null } },
        @{ name = 'wrong wrapper image'; change = { $script:wrapper.ExecutablePath = 'X:\other\wrapper.exe' } },
        @{ name = 'wrong service wrapper'; change = { $script:service.PathName = 'X:\other\wrapper.exe' } },
        @{ name = 'wrong service account'; change = { $script:service.StartName = 'ordinary-user' } },
        @{ name = 'stopped service'; change = { $script:service.State = 'Stopped' } },
        @{ name = 'wrong SCM PID'; change = { $script:service.ProcessId = 999 } },
        @{ name = 'missing tuple'; change = { $script:rows = @() } },
        @{ name = 'ambiguous tuple'; change = { $script:rows += $script:rows[0] } },
        @{ name = 'missing child creation'; change = { $script:app.CreationDate = $null } },
        @{ name = 'missing wrapper creation'; change = { $script:wrapper.CreationDate = $null } },
        @{ name = 'parent PID reuse'; change = { $script:wrapper.CreationDate = $script:app.CreationDate.AddSeconds(1) } },
        @{ name = 'wrong TCP direction'; change = { $script:rows = @($script:rows[1]) } },
        @{ name = 'IPv6 scope mismatch'; change = {
            Reset-Health 'fe80::1%7' 'fe80::2%7'
            $script:rows[0].LocalAddress = 'fe80::1%8'
        } }
    )) {
        Reset-Health
        & $entry.change
        $rejected = $false
        try { $null = Read-Identity } catch { $rejected = $true }
        Assert-True $rejected "Connected ownership accepted $($entry.name)"
    }
    Write-Output 'PASS: safe connected health identity'
    return
}

foreach ($addresses in @(
    @('127.0.0.1', '127.0.0.1'), @('::1', '::1'), @('192.0.2.10', '192.0.2.10'),
    @('fe80::1%12', 'fe80::2%12')
)) {
    Reset-Health $addresses[0] $addresses[1]
    $health = Get-SiphonVersionHealth $config
    Assert-True ($health.app -ceq 'siphon' -and $health.version -ceq '1.10.0' -and $health.serviceRunning) 'Owned exact responder was rejected'
    Assert-True ($script:requestText -match '^GET /api/health HTTP/1\.1\r\n') 'Health request lost the exact endpoint'
    Assert-True (@($script:events | Where-Object { $_ -eq 'connect' }).Count -eq 1) 'Health identity and response used different TCP connections'
    Assert-True ($script:events.IndexOf('tcp-identity') -lt $script:events.IndexOf('read')) 'Identity was not checked before response read'
    Assert-True ($script:events.LastIndexOf('tcp-identity') -gt $script:events.LastIndexOf('read')) 'Identity was not checked after response read'
    Assert-True $script:client.Closed 'Health socket was not closed'
    Assert-True ($script:timeouts.Count -gt 0) 'Transport deadline was not applied'
}

Reset-Health
$script:cimDelayMilliseconds = 300
$watch = [Diagnostics.Stopwatch]::StartNew()
$health = Get-SiphonVersionHealth $config
Assert-True ($health.version -ceq '1.10.0' -and $health.serviceRunning) 'Cumulative bounded CIM latency rejected the verified responder.'
Assert-True ($script:cimReads -eq 10) 'Slower health verification skipped a before/after identity query.'
Assert-True ($watch.ElapsedMilliseconds -ge 3000 -and $watch.ElapsedMilliseconds -lt 10000) 'Health verification did not cover cumulative latency within its bounded deadline.'
Assert-True $script:client.Closed 'Slower health verification leaked its socket.'

Reset-Health
$rejected = $false
try { $null = Get-SiphonVersionHealth -Config $config -Deadline ([Diagnostics.Stopwatch]::GetTimestamp() - 1) } catch {
    Assert-True ($_.Exception.Message.Contains('Local health deadline exceeded')) 'Health retries ignored their shared deadline'
    $rejected = $true
}
Assert-True $rejected 'An expired recovery deadline started another health attempt'
Assert-True ($script:cimReads -eq 0 -and $script:client.Closed) 'Expired recovery deadline queried identity or leaked its socket'

foreach ($entry in @(
    @{ name = 'unrelated responder with correct JSON'; change = { $script:rows[0].OwningProcess = 999 } },
    @{ name = 'app PID reuse while reading'; change = { $script:onRead = { $script:app.CreationDate = $script:app.CreationDate.AddSeconds(1) } } },
    @{ name = 'wrapper PID reuse while reading'; change = { $script:onRead = { $script:wrapper.CreationDate = $script:wrapper.CreationDate.AddSeconds(1) } } },
    @{ name = 'valid child PID changed with same creation time'; change = { $script:onRead = {
        $script:app.ProcessId = 201; $script:rows[0].OwningProcess = 201
        $script:extraProcesses[201] = $script:app
    } } },
    @{ name = 'valid wrapper PID changed with same creation time'; change = { $script:onRead = {
        $script:wrapper.ProcessId = 101; $script:service.ProcessId = 101; $script:app.ParentProcessId = 101
        $script:extraProcesses[101] = $script:wrapper
    } } },
    @{ name = 'service PID changed while reading'; change = { $script:onRead = { $script:service.ProcessId = 999 } } },
    @{ name = 'service stopped while reading'; change = { $script:onRead = { $script:service.State = 'Stopped' } } },
    @{ name = 'app image changed while reading'; change = { $script:onRead = { $script:app.ExecutablePath = 'X:\other\app.exe' } } },
    @{ name = 'wrapper image changed while reading'; change = { $script:onRead = { $script:wrapper.ExecutablePath = 'X:\other\wrapper.exe' } } },
    @{ name = 'ownership changed while reading'; change = { $script:onRead = { $script:rows[0].OwningProcess = 999 } } },
    @{ name = 'connection closed while reading'; change = { $script:onRead = {
        $script:rows = @(); $script:client.Connected = $false; $script:client.Client.Connected = $false
    } } },
    @{ name = 'connection closed with stale ownership row'; change = { $script:onRead = {
        $script:client.Connected = $false; $script:client.Client.Connected = $false
    } } },
    @{ name = 'oversized headers'; response = (New-Response -ExtraHeaders ("X-Pad: " + ('a' * 4096) + "`r`n")) },
    @{ name = 'oversized body'; response = (New-Response -Body ('a' * 4097)) },
    @{ name = 'missing length'; response = "HTTP/1.1 200 OK`r`n`r`n{`"app`":`"siphon`",`"version`":`"1.10.0`"}" },
    @{ name = 'conflicting length'; response = (New-Response -ExtraHeaders "Content-Length: 1`r`n") },
    @{ name = 'transfer encoding'; response = (New-Response -ExtraHeaders "Transfer-Encoding: chunked`r`n") },
    @{ name = 'transfer encoding without length'; response = "HTTP/1.1 200 OK`r`nTransfer-Encoding: chunked`r`n`r`n0`r`n`r`n" },
    @{ name = 'content encoding'; response = (New-Response -ExtraHeaders "Content-Encoding: gzip`r`n") },
    @{ name = 'redirect'; response = (New-Response -Status 'HTTP/1.1 302 Found') },
    @{ name = 'truncated headers'; response = "HTTP/1.1 200 OK`r`nContent-Length: 1`r`n" },
    @{ name = 'truncated body'; response = "HTTP/1.1 200 OK`r`nContent-Length: 4096`r`n`r`n{}" },
    @{ name = 'invalid length'; response = "HTTP/1.1 200 OK`r`nContent-Length: -1`r`n`r`n{}" },
    @{ name = 'invalid JSON'; response = (New-Response -Body 'not-json') },
    @{ name = 'malformed status'; response = (New-Response -Status 'NOTHTTP 200 OK') },
    @{ name = 'connect timeout'; failure = 'connect-timeout' },
    @{ name = 'write timeout'; failure = 'write-timeout' },
    @{ name = 'read timeout'; failure = 'read-timeout' },
    @{ name = 'identity query timeout'; failure = 'cim-timeout' }
)) {
    Reset-Health
    if ($entry.ContainsKey('change')) { & $entry.change }
    if ($entry.ContainsKey('response')) { $script:response = [Text.Encoding]::UTF8.GetBytes($entry.response) }
    if ($entry.ContainsKey('failure')) { $script:failure = $entry.failure }
    $rejected = $false
    try { $null = Get-SiphonVersionHealth $config } catch { $rejected = $true }
    Assert-True $rejected "Version health accepted $($entry.name)"
    Assert-True ($null -ne $script:client -and $script:client.Closed) "Version health leaked its socket after $($entry.name)"
}

Write-Output 'PASS: safe connected health http'
