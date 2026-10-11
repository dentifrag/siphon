# Running Siphon as a Windows service

These scripts install Siphon as an auto-start Windows service using
[WinSW](https://github.com/winsw/winsw) (the Windows Service Wrapper). WinSW wraps the
self-contained `dist-bin/siphon-win-x64.exe`, so the service:

- starts automatically on boot (no login required),
- restarts on failure,
- rolls its logs by size, and
- needs **no system Node.js** at runtime (the packaged exe is standalone).

WinSW is downloaded from its official GitHub release on first install, pinned to a specific
version and verified by SHA-256. Nothing third-party is committed to this repo.

## Prerequisites

You need the packaged exe at `dist-bin/siphon-win-x64.exe`. Either build it yourself:

```powershell
npm ci
npm run package:build
npm run package:win
```

...or let the installer build it for you with `-Build` (needs Node.js 20+ on PATH).

> `package:build` runs the **bundled** server build (`server:build:bundled`, no
> `--packages=external`). Left external, `@fastify/cookie`'s dynamic `import('cookie')` survives
> into the packaged exe and crash-loops it at startup (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`).
> `update.ps1` and the installer's `-Build` build it the same way.

## Install

From an **Administrator** PowerShell (the scripts also self-elevate with a UAC prompt):

```powershell
npm run service:install
# equivalently:
powershell -NoProfile -ExecutionPolicy Bypass -File windows-service/Install-SiphonService.ps1

# first-time setup that also builds the exe:
powershell -NoProfile -ExecutionPolicy Bypass -File windows-service/Install-SiphonService.ps1 -Build
```

The installer validates configuration and the local health address before stopping an
existing `Siphon` service. It downloads + verifies WinSW into `dist-bin/siphon-service.exe`,
writes `dist-bin/siphon-service.xml` from your config, then installs, starts, and checks
`/api/health` on the recorded bind address. Hostname binds, including `localhost`, are
rejected before service changes; use `0.0.0.0`, `::`, an explicit IPv4/IPv6 loopback IP
(`127.0.0.1` or `::1`), or a local interface IP address.

## Configure

Copy the example and edit it (the real file is git-ignored):

```powershell
Copy-Item windows-service/service.config.example.json windows-service/service.config.json
```

| Key               | Env var             | Default                 | Notes                                                                |
| ----------------- | ------------------- | ----------------------- | -------------------------------------------------------------------- |
| `port`            | `PORT`              | `8080`                  | Web UI port.                                                         |
| `host`            | `HOST`              | `0.0.0.0`               | Bind address.                                                        |
| `dataDir`         | `DATA_DIR`          | `C:\ProgramData\Siphon` | Saved profiles, rclone config, and logs live here.                   |
| `downloadDirs`    | `DOWNLOAD_DIRS`     | _(empty)_               | Empty = browse the whole PC. Limit with `Label=path,Label2=path2`.   |
| `appUsername`     | `APP_USERNAME`      | _(empty)_               | Login username (defaults to `admin` when a password is set).         |
| `appPassword`     | `APP_PASSWORD`      | _(empty)_               | Plaintext login password (recommended). Leave blank for open access. |
| `appPasswordHash` | `APP_PASSWORD_HASH` | _(empty)_               | scrypt hash instead of plaintext (`./siphon --hash-password`).       |
| `rclonePath`      | `RCLONE_PATH`       | bundled `rclone.exe`    | Path to rclone. Defaults to `dist-bin/rclone.exe` if present.        |

Only non-empty values are written into the service. Re-run `npm run service:install` after
editing to apply changes.

## Manage

```powershell
net stop Siphon        # or: Stop-Service Siphon
net start Siphon       # or: Start-Service Siphon
Get-Service Siphon     # status
```

Logs (WinSW rolls them by size) are under `<dataDir>\logs`:
`siphon-service.out.log`, `siphon-service.err.log`, `siphon-service.wrapper.log`.

## Update

### One-time administrator setup

Existing installs need this app version and the protected helper installed once. The
installer's `-Build` switch builds **only when the exe is absent**; it does not refresh an
existing exe. From the updated checkout, explicitly run:

```powershell
Get-Service Siphon -ErrorAction SilentlyContinue | Stop-Service -Force
npm run package:build
npm run package:win
powershell -NoProfile -ExecutionPolicy Bypass -File windows-service\Install-SiphonService.ps1
```

Alternatively, run [`update.ps1`](../update.ps1) once to pull, rebuild, and restart, then
rerun the service installer. The existing git-based `update.ps1` workflow remains available
for manual administration; it is not the in-app update mechanism.

Use an administrator-controlled installation location, not a user-owned home directory,
network share, removable drive, or junction/symlink. The executable and updater require a
local fixed NTFS volume. For example, keep the checkout under an
administrator-owned `C:\Program Files\Siphon` directory. The installer protects `dist-bin`
and creates `dist-bin\siphon-updater` on the executable's volume. Untrusted ownership or
ancestor permissions that allow replacement are refused. The app excludes its installation
directory from ordinary filesystem, upload, and download APIs.

Installation ancestors must be owned by the Administrators group, SYSTEM, or Windows
TrustedInstaller, with no untrusted delete/ownership permissions. An administrator's
individual user SID is not treated as a substitute for group ownership. Prepare the
installation folder's ownership and ACLs before setup; do not weaken the helper's checks
to use a user-profile checkout.
Both installer and uninstaller check the full owner/DACL of the existing `dist-bin`
directory and every existing app executable, WinSW executable, and WinSW XML file before
modifying permissions, stopping/removing the service, or invoking WinSW. Untrusted owners
or writers are rejected, not repaired by changing the parent directory's ACL. Missing
wrapper/XML files are allowed on first install; an existing app executable must pass.

The existing WinSW service must run as LocalSystem and retain the recorded executable,
wrapper, bind address, and port. Health checks support wildcard binds, explicit IPv4/IPv6
loopback IPs, and local interface IP addresses, without proxies or redirects. `localhost`
is not a supported bind identity. The installer records these settings,
copies the protocol-v1 core and worker, and installs the fixed `\SiphonUpdate` SYSTEM
Scheduled Task. Its protected action takes no caller-controlled shell arguments, ignores
concurrent instances, permits battery operation, and has a 45-minute execution budget.
The startup trigger recovers only an already accepted request; it never selects a new release.
It waits 30 seconds after boot, then uses bounded old-version readiness checks.

### Use the Updates dialog

Sign in with a password and select **Updates** in the header. Open mode cannot check or
install releases. Opening the dialog reads local status only. Select **Check for updates**,
then **Install update**, review the confirmation, and select **Install and restart**.
Queued/running transfers and in-flight enqueue requests prevent installation; maintenance
blocks new transfers through verification and rollback.

The task runs independently of WinSW, so stopping Siphon cannot terminate its updater.
It revalidates the exact confirmed release and asset IDs, downloads from official GitHub
release storage, checks the pinned size and SHA-256 before stopping the service, and
replaces only `siphon-win-x64.exe`. It preserves data/configuration, rclone, executable
location, and service settings. Success requires both a running service and the exact
installed version from the public, uncached `GET /api/health`.
Installer and updater health checks use one bounded numeric-IP TCP connection. They verify
the response socket's exact connected address/port tuple belongs to the recorded Siphon
process, directly parented by the running SYSTEM WinSW service. The same tuple, process
IDs, creation times, executable paths, and service identity must still match after reading
the bounded HTTP response. An unrelated responder or changed/closed connection cannot
authorize success or recovery-backup cleanup, even if it returns the expected JSON.

The browser stores non-sensitive reconnect intent before submitting. A lost POST response
is reconciled through status, not resubmitted. A restart can invalidate your session; sign
in again to see the result. Closing the dialog does not cancel the task. A bounded reconnect
deadline leaves the outcome unknown; **Retry status** resumes reconciliation.
Only a definitive server rejection before acceptance clears reconnect intent and enables
another explicit install attempt. An uncertain scheduler or network response retains it,
even if a status response has not yet identified the job.

### Compatibility and recovery

Only the latest published stable `dentifrag/siphon` release is offered. Numeric or
`v`-prefixed tags must match the bundled package version. Future release workflows publish
`siphon-win-x64.update.json` with protocol, version, asset name, byte size, and SHA-256.
The already-published `1.0.2` release lacks this manifest: it can report current, but a newer
release without a compatible manifest is explicitly unavailable. Protocol changes require
manual helper setup, never automatic script replacement.

The protected updater directory contains immutable accepted `request.json`, release
identity `proof.json`, atomic worker-owned `job.json`, and separate `scheduling.json`
uncertainty. Scheduler acceptance is not worker completion. An interrupted replacement
recovers the old executable instead of retrying replacement. The verified backup remains
at `siphon-updater\previous.exe` until exact health verification completes. Failed rollback
preserves it and keeps maintenance active.
Recovery records whether replacement intent was reached. An interrupted stop or backup
that never reached replacement can restart and verify the untouched old executable without
a backup. A missing backup after replacement intent remains a failed recovery.

If task acceptance is uncertain, **Retry accepted task** may run the same protected request
only after task-idle inspection. It does not fetch or substitute a newer release. Never
delete a pending request/journal to bypass maintenance. For failed recovery, an administrator
must inspect the protected journal and backup, stop the recorded service, restore the backup
to the recorded executable path, restart, and verify `/api/health` against the old version.
Use the recorded local interface or explicit loopback IP for recovery health checks;
do not substitute a `localhost` bind or bypass existing service-path ownership/DACL checks.
The accepted task can then reconcile recovery. Do not run `update.ps1` over an unfinished
in-app update. Installer/uninstaller operations refuse live or nonterminal jobs and hold the
same worker lock.
Reinstalling after a healthy terminal job retires its accepted request and backup while
retaining the completed journal for display. It cannot retire an unfinished or unknown job.

## Uninstall

```powershell
npm run service:uninstall
# also delete saved data (profiles, rclone config, logs) - no undo:
powershell -NoProfile -ExecutionPolicy Bypass -File windows-service/Uninstall-SiphonService.ps1 -Purge
```
