function Get-SiphonValue($Object, [string]$Name) {
    if ($Object -is [System.Collections.IDictionary]) { return $Object[$Name] }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Test-SiphonVersion([string]$Version) {
    return $Version -cmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
}

function Assert-SiphonRequest($Request) {
    $id = Get-SiphonValue $Request 'id'
    $from = Get-SiphonValue $Request 'fromVersion'
    $to = Get-SiphonValue $Request 'toVersion'
    $tag = Get-SiphonValue $Request 'releaseTag'
    $size = Get-SiphonValue $Request 'sizeBytes'
    $hash = Get-SiphonValue $Request 'sha256'
    if (
        $id -isnot [string] -or $id -cnotmatch '^[A-Za-z0-9_-]{1,128}$' -or
        -not (Test-SiphonVersion $from) -or -not (Test-SiphonVersion $to) -or
        ([version]$to -le [version]$from) -or
        $tag -isnot [string] -or ($tag -cne $to -and $tag -cne "v$to") -or
        (Get-SiphonValue $Request 'protocolVersion') -ne 1 -or
        (Get-SiphonValue $Request 'assetName') -cne 'siphon-win-x64.exe' -or
        (Get-SiphonValue $Request 'assetUrl') -cne "https://github.com/dentifrag/siphon/releases/download/$tag/siphon-win-x64.exe" -or
        $null -eq $size -or [decimal]$size -le 0 -or [decimal]$size -gt 536870912 -or [decimal]$size -ne [math]::Floor([decimal]$size) -or
        $hash -isnot [string] -or $hash -cnotmatch '^[a-f0-9]{64}$'
    ) { throw 'Invalid pinned update request.' }
}

function Invoke-SiphonUpdate {
    param(
        [Parameter(Mandatory = $true)]$Request,
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Operations
    )
    $required = @(
        'AcquireLock', 'ReleaseLock', 'ReadJournal', 'WriteJournal', 'Download',
        'GetSha256', 'GetSize', 'StopService', 'Backup', 'Replace', 'StartService',
        'CheckHealth', 'Restore', 'BackupExists', 'RemoveBackup', 'Wait'
    )
    foreach ($name in $required) {
        if (-not $Operations.Contains($name) -or $Operations[$name] -isnot [scriptblock]) {
            throw "Missing injected updater operation: $name"
        }
    }
    Assert-SiphonRequest $Request
    if (-not (& $Operations.AcquireLock)) { throw 'Another updater or installer holds the worker lock.' }
    try {
        $now = [DateTime]::UtcNow.ToString('o')
        $job = @{
            id = Get-SiphonValue $Request 'id'
            fromVersion = Get-SiphonValue $Request 'fromVersion'
            toVersion = Get-SiphonValue $Request 'toVersion'
            phase = 'accepted'
            replacementIntentReached = $false
            serviceHealth = 'unknown'
            startedAt = $now
            updatedAt = $now
        }
        $previous = & $Operations.ReadJournal
        if ($null -ne $previous -and (Get-SiphonValue $previous 'id') -eq $job.id) {
            if (
                (Get-SiphonValue $previous 'fromVersion') -cne $job.fromVersion -or
                (Get-SiphonValue $previous 'toVersion') -cne $job.toVersion
            ) { throw 'Worker journal identity mismatch.' }
            foreach ($name in @('phase', 'serviceHealth', 'startedAt', 'updatedAt', 'error')) {
                $value = Get-SiphonValue $previous $name
                if ($null -ne $value) { $job[$name] = $value }
            }
            $replacementIntent = Get-SiphonValue $previous 'replacementIntentReached'
            if ($null -ne $replacementIntent) {
                if ($replacementIntent -isnot [bool]) { throw 'Invalid replacement recovery provenance.' }
                $job.replacementIntentReached = $replacementIntent
            } else {
                $job.replacementIntentReached = $job.phase -notin @('accepted', 'downloading', 'verifying-download', 'stopping', 'backing-up', 'failed')
            }
        } elseif ($null -ne $previous) {
            $previousPhase = Get-SiphonValue $previous 'phase'
            $previousHealth = Get-SiphonValue $previous 'serviceHealth'
            if ($previousPhase -notin @('succeeded', 'rolled-back', 'failed') -or $previousHealth -ne 'healthy') {
                throw 'A different unfinished update journal requires administrator recovery.'
            }
        }

        $write = {
            param([string]$Phase, [string]$Health = 'unknown')
            $job.phase = $Phase
            $job.serviceHealth = $Health
            $job.updatedAt = [DateTime]::UtcNow.ToString('o')
            $null = & $Operations.WriteJournal $job
        }
        $healthy = {
            param([string]$Expected)
            for ($attempt = 0; $attempt -lt 60; $attempt++) {
                try {
                    $health = & $Operations.CheckHealth $Expected $Config
                    if (
                        (Get-SiphonValue $health 'app') -ceq 'siphon' -and
                        (Get-SiphonValue $health 'version') -ceq $Expected -and
                        (Get-SiphonValue $health 'serviceRunning') -eq $true
                    ) { return $true }
                    if (
                        (Get-SiphonValue $health 'app') -ceq 'siphon' -and
                        (Get-SiphonValue $health 'version') -and
                        (Get-SiphonValue $health 'version') -cne $Expected
                    ) { return $false }
                } catch {}
                $null = & $Operations.Wait 2000
            }
            return $false
        }
        $recover = {
            $null = & $write 'rolling-back'
            $null = & $Operations.StopService $Config
            if (& $Operations.BackupExists $Config) {
                $null = & $Operations.Restore $Config
            } elseif ($job.replacementIntentReached) {
                throw 'The recovery backup is missing; replacement cannot be safely reversed.'
            }
            $null = & $Operations.StartService $Config
            $null = & $write 'verifying-old'
            if (-not (& $healthy $job.fromVersion)) { throw 'Restored service failed exact old-version health verification.' }
            $null = & $write 'rolled-back' 'healthy'
            try { $null = & $Operations.RemoveBackup $Config } catch {
                $job.error = "$($job.error) Recovery succeeded, but backup cleanup failed: $($_.Exception.Message)"
                $null = & $write 'rolled-back' 'healthy'
            }
        }

        if ($job.phase -in @('succeeded', 'rolled-back', 'failed')) {
            $expected = if ($job.phase -eq 'succeeded') { $job.toVersion } else { $job.fromVersion }
            if (& $healthy $expected) {
                $null = & $write $job.phase 'healthy'
                try { $null = & $Operations.RemoveBackup $Config } catch {
                    $job.error = "Service is healthy, but backup cleanup failed: $($_.Exception.Message)"
                    $null = & $write $job.phase 'healthy'
                }
                return $job
            }
            $job.error = 'Previously completed update no longer has the expected service health.'
            $null = & $write 'rollback-failed' 'unhealthy'
            return $job
        }
        if ($job.phase -in @('stopping', 'backing-up', 'replacing', 'starting', 'verifying-new', 'rolling-back', 'verifying-old', 'rollback-failed')) {
            $job.error = 'Interrupted update: recovering the previous version.'
            try {
                $null = & $recover
            } catch {
                $job.error = "Interrupted update recovery failed: $($_.Exception.Message)"
                $null = & $write 'rollback-failed' 'unhealthy'
            }
            return $job
        }
        if ($job.phase -notin @('accepted', 'downloading', 'verifying-download')) {
            throw 'Unknown update journal phase; refusing service mutation.'
        }

        $serviceMayBeStopped = $false
        try {
            if ($null -ne $previous -and (Get-SiphonValue $previous 'id') -ne $job.id -and (& $Operations.BackupExists $Config)) {
                if (-not (& $healthy $job.fromVersion)) { throw 'Previous backup cannot be retired without exact installed-version health.' }
                $null = & $Operations.RemoveBackup $Config
            }
            $null = & $write 'downloading'
            $null = & $Operations.Download $Request $Config
            $null = & $write 'verifying-download'
            $stage = Get-SiphonValue $Config 'stagePath'
            if (
                (& $Operations.GetSize $stage) -ne (Get-SiphonValue $Request 'sizeBytes') -or
                ((& $Operations.GetSha256 $stage).ToLowerInvariant()) -cne (Get-SiphonValue $Request 'sha256')
            ) { throw 'Downloaded executable failed SHA-256 or size verification.' }
            $null = & $write 'stopping'
            $serviceMayBeStopped = $true
            $null = & $Operations.StopService $Config
            $null = & $write 'backing-up'
            $null = & $Operations.Backup $Config
            $job.replacementIntentReached = $true
            $null = & $write 'replacing'
            $null = & $Operations.Replace $Config
            $null = & $write 'starting'
            $null = & $Operations.StartService $Config
            $null = & $write 'verifying-new'
            if (-not (& $healthy $job.toVersion)) { throw 'New version failed exact service health verification.' }
            $null = & $write 'succeeded' 'healthy'
            try { $null = & $Operations.RemoveBackup $Config } catch {
                $job.error = "Update succeeded, but backup cleanup failed: $($_.Exception.Message)"
                $null = & $write 'succeeded' 'healthy'
            }
        } catch {
            $job.error = $_.Exception.Message
            if ($serviceMayBeStopped) {
                try {
                    $null = & $recover
                } catch {
                    $job.error = "$($job.error) Recovery failed: $($_.Exception.Message)"
                    $null = & $write 'rollback-failed' 'unhealthy'
                }
            } else {
                $health = if (& $healthy $job.fromVersion) { 'healthy' } else { 'unhealthy' }
                $null = & $write 'failed' $health
            }
        }
        return $job
    } finally {
        $null = & $Operations.ReleaseLock
    }
}
