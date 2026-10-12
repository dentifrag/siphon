param([Parameter(Mandatory = $true)][string]$CorePath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. $CorePath

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

$request = @{
    id = 'job-1'
    fromVersion = '1.0.2'
    toVersion = '1.10.0'
    protocolVersion = 1
    releaseTag = '1.10.0'
    assetName = 'siphon-win-x64.exe'
    assetUrl = 'https://github.com/dentifrag/siphon/releases/download/1.10.0/siphon-win-x64.exe'
    sizeBytes = 100
    sha256 = ('a' * 64)
}
$config = @{
    executablePath = 'X:\fake\siphon-win-x64.exe'
    backupPath = 'X:\fake\siphon-win-x64.exe.backup'
    stagePath = 'X:\fake\staged.exe'
    healthUri = 'http://127.0.0.1:8080/api/health'
}

# All paths are inert identifiers; every network, service, file, and journal operation is injected.
function New-Fixture([string]$Mode = 'healthy') {
    $script:state = @{
        mode = $Mode
        calls = [System.Collections.Generic.List[string]]::new()
        journals = [System.Collections.Generic.List[object]]::new()
        journal = $null
        hash = $request.sha256
        size = $request.sizeBytes
        liveVersion = $request.fromVersion
        backupVersion = $null
        running = $true
        lockAvailable = $true
    }
    return @{
        AcquireLock = { $script:state.calls.Add('lock'); return $script:state.lockAvailable }
        ReleaseLock = { $script:state.calls.Add('unlock') }
        ReadJournal = { return $script:state.journal }
        WriteJournal = {
            param($Journal)
            $copy = $Journal | ConvertTo-Json -Depth 10 | ConvertFrom-Json
            $script:state.journals.Add($copy)
            $script:state.calls.Add("journal:$($copy.phase)")
            $script:state.journal = $copy
        }
        Download = {
            param($Request, $Config)
            $script:state.calls.Add('download')
        }
        GetSha256 = { param($Path) return $script:state.hash }
        GetSize = { param($Path) return $script:state.size }
        StopService = {
            param($Config)
            $script:state.calls.Add('stop')
            $script:state.running = $false
        }
        Backup = {
            param($Config)
            $script:state.calls.Add('backup')
            $script:state.backupVersion = $script:state.liveVersion
        }
        Replace = {
            param($Config)
            $script:state.calls.Add('replace')
            $script:state.liveVersion = $request.toVersion
        }
        StartService = {
            param($Config)
            $script:state.calls.Add('start')
            if ($script:state.mode -eq 'startup-failed' -and $script:state.liveVersion -eq $request.toVersion) {
                throw 'new service startup failed'
            }
            $script:state.running = $true
        }
        CheckHealth = {
            param($ExpectedVersion, $Config, [long]$Deadline)
            $remaining = ($Deadline - [Diagnostics.Stopwatch]::GetTimestamp()) / [Diagnostics.Stopwatch]::Frequency
            Assert-True ($remaining -gt 0 -and $remaining -le 300) 'Health retries must pass a shared five-minute deadline'
            $script:state.calls.Add("health:$ExpectedVersion")
            if ($script:state.mode -eq 'untrusted-responder') { throw 'Connected responder is not the recorded service child.' }
            $version = $script:state.liveVersion
            if ($script:state.mode -eq 'wrong-version' -and $ExpectedVersion -eq $request.toVersion) {
                $version = '0.9.0'
            }
            return @{ app = 'siphon'; version = $version; serviceRunning = $script:state.running }
        }
        Restore = {
            param($Config)
            $script:state.calls.Add('restore')
            if ($script:state.mode -eq 'rollback-failed') { throw 'restore failed' }
            $script:state.liveVersion = $script:state.backupVersion
        }
        BackupExists = { param($Config) return $null -ne $script:state.backupVersion }
        RemoveBackup = {
            param($Config)
            $script:state.calls.Add('remove-backup')
            $script:state.backupVersion = $null
        }
        Wait = { param($Milliseconds) $script:state.calls.Add('wait') }
    }
}

function Run-Core($Operations) {
    return Invoke-SiphonUpdate -Request $request -Config $config -Operations $Operations
}

$operations = New-Fixture
$script:state.hash = ('b' * 64)
$result = Run-Core $operations
Assert-Equal $result.phase 'failed' 'Checksum mismatch must fail before service mutation'
foreach ($forbidden in @('stop', 'backup', 'replace', 'start', 'restore')) {
    Assert-True (-not $script:state.calls.Contains($forbidden)) "Checksum rejection called $forbidden"
}
Assert-Equal $script:state.liveVersion $request.fromVersion 'Checksum rejection replaced the executable'
Assert-True $script:state.running 'Checksum rejection stopped the old service'
Assert-True $script:state.calls.Contains('unlock') 'Checksum rejection leaked the worker lock'

$operations = New-Fixture
$result = Run-Core $operations
Assert-Equal $result.phase 'succeeded' 'Healthy update did not succeed'
Assert-Equal $result.serviceHealth 'healthy' 'Success lacks authoritative service health'
Assert-Equal $script:state.liveVersion $request.toVersion 'Healthy update did not install the pinned version'
Assert-True ($script:state.calls.IndexOf('backup') -lt $script:state.calls.IndexOf('replace')) 'Replacement ran before backup'
Assert-True ($script:state.calls.IndexOf('journal:replacing') -ge 0) 'Replacement intent was not journaled'
Assert-True ($script:state.calls.IndexOf('journal:replacing') -lt $script:state.calls.IndexOf('replace')) 'Replacement intent was journaled too late'
$replacementJournal = $script:state.journals | Where-Object { $_.phase -eq 'replacing' } | Select-Object -First 1
Assert-True $replacementJournal.replacementIntentReached 'Replacement journal did not persist destructive-step provenance'
Assert-True ($script:state.calls.IndexOf('health:1.10.0') -lt $script:state.calls.IndexOf('remove-backup')) 'Backup removed before version health'
Assert-True $script:state.calls.Contains('unlock') 'Healthy update leaked the worker lock'

foreach ($mode in @('wrong-version', 'startup-failed')) {
    $operations = New-Fixture $mode
    $result = Run-Core $operations
    Assert-Equal $result.phase 'rolled-back' "$mode did not roll back"
    Assert-Equal $result.serviceHealth 'healthy' "$mode claimed rollback without old-version health"
    Assert-Equal $script:state.liveVersion $request.fromVersion "$mode did not restore the old executable"
    Assert-True $script:state.calls.Contains('health:1.0.2') "$mode did not verify the restored version"
    Assert-True ($script:state.calls.IndexOf('journal:rolling-back') -ge 0) "$mode omitted rollback intent"
    Assert-True ($script:state.calls.IndexOf('journal:rolling-back') -lt $script:state.calls.IndexOf('restore')) "$mode journaled rollback too late"
}

$operations = New-Fixture 'rollback-failed'
$operations.CheckHealth = { param($ExpectedVersion, $Config) return @{ app = 'siphon'; version = '0.9.0'; serviceRunning = $false } }
$result = Run-Core $operations
Assert-Equal $result.phase 'rollback-failed' 'Failed rollback was not reported'
Assert-Equal $script:state.journals[$script:state.journals.Count - 1].phase 'rollback-failed' 'Failed rollback was not persisted'
Assert-True ($null -ne $script:state.backupVersion) 'Failed rollback destroyed the backup'
Assert-True (-not $script:state.calls.Contains('remove-backup')) 'Failed rollback removed the backup'

$operations = New-Fixture
$script:state.backupVersion = $request.fromVersion
$script:state.liveVersion = $null
$script:state.running = $false
$script:state.journal = @{
    id = $request.id
    fromVersion = $request.fromVersion
    toVersion = $request.toVersion
    phase = 'replacing'
    serviceHealth = 'unknown'
    startedAt = '2026-10-10T00:00:00Z'
    updatedAt = '2026-10-10T00:00:00Z'
}
$result = Run-Core $operations
Assert-Equal $result.phase 'rolled-back' 'Interrupted replacement did not recover'
Assert-Equal $script:state.liveVersion $request.fromVersion 'Recovery did not restore the backup'
Assert-True $script:state.calls.Contains('health:1.0.2') 'Recovery skipped old-version health'
Assert-True (-not $script:state.calls.Contains('download')) 'Recovery started a fresh update'
Assert-True (-not $script:state.calls.Contains('replace')) 'Recovery retried replacement instead of restoring'

$operations = New-Fixture
$script:state.lockAvailable = $false
$rejected = $false
try { $null = Run-Core $operations } catch { $rejected = $true }
Assert-True $rejected 'Duplicate lock was accepted'
Assert-Equal ($script:state.calls -join ',') 'lock' 'Duplicate worker performed operations or released another worker lock'
Assert-Equal $script:state.journals.Count 0 'Duplicate worker overwrote the active journal'

$operations = New-Fixture
$operations.Remove('StopService')
$rejected = $false
try { $null = Run-Core $operations } catch { $rejected = $true }
Assert-True $rejected 'Missing injected operations did not fail closed'
Assert-Equal $script:state.calls.Count 0 'Missing injected operations fell back to real operations or started work'

$operations = New-Fixture
$normalStop = $operations.StopService
$operations.StopService = {
    param($Config)
    $script:state.calls.Add('stop')
    $script:state.running = $false
    throw 'stop obstruction'
}
$result = Run-Core $operations
Assert-Equal $result.phase 'rollback-failed' 'Pre-backup stop obstruction did not persist failed recovery'
Assert-Equal $script:state.journal.replacementIntentReached $false 'Pre-backup recovery lost untouched-executable provenance'
Assert-True (-not $script:state.calls.Contains('backup')) 'Stop obstruction reached backup'
Assert-True (-not $script:state.calls.Contains('replace')) 'Stop obstruction reached replacement'
$script:state.calls.Clear()
$operations.StopService = $normalStop
$result = Run-Core $operations
Assert-Equal $result.phase 'rolled-back' 'Retry after pre-backup obstruction did not recover'
Assert-Equal $result.serviceHealth 'healthy' 'Retry skipped old-version health'
Assert-True $script:state.running 'Retry did not restart the untouched executable'
Assert-True $script:state.calls.Contains('start') 'Retry refused to restart without a backup'
foreach ($forbidden in @('download', 'backup', 'replace', 'restore')) {
    Assert-True (-not $script:state.calls.Contains($forbidden)) "Pre-backup recovery called $forbidden"
}

foreach ($phase in @('stopping', 'backing-up')) {
    $operations = New-Fixture
    $normalStop = $operations.StopService
    $script:state.running = $false
    $script:state.journal = @{
        id = $request.id
        fromVersion = $request.fromVersion
        toVersion = $request.toVersion
        phase = $phase
        serviceHealth = 'unknown'
        startedAt = '2026-10-10T00:00:00Z'
        updatedAt = '2026-10-10T00:00:00Z'
    }
    $operations.StopService = {
        param($Config)
        $script:state.calls.Add('stop')
        throw 'interrupted recovery stop obstruction'
    }
    $result = Run-Core $operations
    Assert-Equal $result.phase 'rollback-failed' "$phase recovery obstruction was not persisted"
    Assert-Equal $script:state.journal.replacementIntentReached $false "$phase recovery did not reconstruct pre-replacement provenance"
    $script:state.calls.Clear()
    $operations.StopService = $normalStop
    $result = Run-Core $operations
    Assert-Equal $result.phase 'rolled-back' "$phase recovery retry incorrectly required a backup"
    Assert-Equal $result.serviceHealth 'healthy' "$phase recovery did not verify old-version health"
    Assert-True $script:state.running "$phase retry left the old executable stopped"
    foreach ($forbidden in @('download', 'backup', 'replace', 'restore')) {
        Assert-True (-not $script:state.calls.Contains($forbidden)) "$phase recovery called $forbidden"
    }
}

$operations = New-Fixture
$script:state.running = $false
$script:state.journal = @{
    id = $request.id
    fromVersion = $request.fromVersion
    toVersion = $request.toVersion
    phase = 'rolling-back'
    replacementIntentReached = $false
    serviceHealth = 'unknown'
    startedAt = '2026-10-10T00:00:00Z'
    updatedAt = '2026-10-10T00:00:00Z'
} | ConvertTo-Json | ConvertFrom-Json
$result = Run-Core $operations
Assert-Equal $result.phase 'rolled-back' 'Interrupted pre-backup rollback incorrectly required a backup'
Assert-Equal $result.serviceHealth 'healthy' 'Interrupted pre-backup rollback skipped exact health'
Assert-True $script:state.calls.Contains('start') 'Interrupted pre-backup rollback did not restart'
Assert-True (-not $script:state.calls.Contains('restore')) 'Interrupted pre-backup rollback attempted a nonexistent backup'

$operations = New-Fixture
$script:state.liveVersion = $request.toVersion
$script:state.running = $false
$script:state.journal = @{
    id = $request.id
    fromVersion = $request.fromVersion
    toVersion = $request.toVersion
    phase = 'rollback-failed'
    replacementIntentReached = $true
    serviceHealth = 'unhealthy'
    startedAt = '2026-10-10T00:00:00Z'
    updatedAt = '2026-10-10T00:00:00Z'
}
$result = Run-Core $operations
Assert-Equal $result.phase 'rollback-failed' 'Post-replacement retry accepted a missing backup'
Assert-True (-not $script:state.calls.Contains('start')) 'Post-replacement retry started an un-restored executable'
Assert-True (-not $script:state.calls.Contains('remove-backup')) 'Post-replacement retry discarded recovery state'
Assert-Equal $script:state.journal.replacementIntentReached $true 'Post-replacement provenance was cleared'

$script:state.journal.PSObject.Properties.Remove('replacementIntentReached')
$script:state.calls.Clear()
$result = Run-Core $operations
Assert-Equal $result.phase 'rollback-failed' 'Legacy ambiguous rollback retry accepted a missing backup'
Assert-True (-not $script:state.calls.Contains('start')) 'Legacy ambiguous rollback retry started an un-restored executable'

$operations = New-Fixture 'untrusted-responder'
$result = Run-Core $operations
Assert-Equal $result.phase 'rollback-failed' 'Responder rejection did not reject new-version and rollback health'
Assert-Equal $result.serviceHealth 'unhealthy' 'Unrelated responder established authoritative health'
Assert-Equal $script:state.liveVersion $request.fromVersion 'Responder rejection did not attempt rollback'
Assert-Equal $script:state.backupVersion $request.fromVersion 'Responder rejection discarded the recovery backup'
Assert-True $script:state.calls.Contains('health:1.10.0') 'New-version responder identity was not checked'
Assert-True $script:state.calls.Contains('health:1.0.2') 'Rollback responder identity was not checked'
Assert-True (-not $script:state.calls.Contains('remove-backup')) 'Responder rejection allowed backup cleanup'
Assert-True (@($script:state.journals | Where-Object { $_.phase -in @('succeeded', 'rolled-back') -and $_.serviceHealth -eq 'healthy' }).Count -eq 0) 'Responder rejection was persisted as successful terminal health'

foreach ($phase in @('succeeded', 'rolled-back')) {
    $operations = New-Fixture 'untrusted-responder'
    $script:state.liveVersion = if ($phase -eq 'succeeded') { $request.toVersion } else { $request.fromVersion }
    $script:state.backupVersion = $request.fromVersion
    $script:state.journal = @{
        id = $request.id
        fromVersion = $request.fromVersion
        toVersion = $request.toVersion
        phase = $phase
        replacementIntentReached = $true
        serviceHealth = 'healthy'
        startedAt = '2026-10-10T00:00:00Z'
        updatedAt = '2026-10-10T00:00:00Z'
    }
    $result = Run-Core $operations
    Assert-Equal $result.phase 'rollback-failed' "$phase accepted health from an unrelated responder"
    Assert-Equal $result.serviceHealth 'unhealthy' "$phase retained a false authoritative health claim"
    Assert-Equal $script:state.backupVersion $request.fromVersion "$phase discarded its backup after responder rejection"
    Assert-True (-not $script:state.calls.Contains('remove-backup')) "$phase cleaned up without connected responder identity"
}

Write-Output 'PASS: 17 safe updater scenarios'
