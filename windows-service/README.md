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
npm run web:build
npx esbuild src/server/index.ts --bundle --platform=node --target=node20 --format=cjs --outfile=dist-server/index.cjs
npm run package:win
```

...or let the installer build it for you with `-Build` (needs Node.js 20+ on PATH).

> The esbuild step above deliberately bundles **all** dependencies (no `--packages=external`).
> Left external, `@fastify/cookie`'s dynamic `import('cookie')` survives into the packaged exe
> and crash-loops it at startup (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`). `update.ps1` and the
> installer's `-Build` both do it this way.

## Install

From an **Administrator** PowerShell (the scripts also self-elevate with a UAC prompt):

```powershell
npm run service:install
# equivalently:
powershell -NoProfile -ExecutionPolicy Bypass -File windows-service/Install-SiphonService.ps1

# first-time setup that also builds the exe:
powershell -NoProfile -ExecutionPolicy Bypass -File windows-service/Install-SiphonService.ps1 -Build
```

The installer stops any existing `Siphon` service, downloads + verifies WinSW into
`dist-bin/siphon-service.exe`, writes `dist-bin/siphon-service.xml` from your config, then
installs, starts, and checks that `http://localhost:<port>` actually serves.

## Configure

Copy the example and edit it (the real file is git-ignored):

```powershell
Copy-Item windows-service/service.config.example.json windows-service/service.config.json
```

| Key               | Env var             | Default                 | Notes                                                                 |
| ----------------- | ------------------- | ----------------------- | --------------------------------------------------------------------- |
| `port`            | `PORT`              | `8080`                  | Web UI port.                                                          |
| `host`            | `HOST`              | `0.0.0.0`               | Bind address.                                                         |
| `dataDir`         | `DATA_DIR`          | `C:\ProgramData\Siphon` | Saved profiles, rclone config, and logs live here.                    |
| `downloadDirs`    | `DOWNLOAD_DIRS`     | _(empty)_               | Empty = browse the whole PC. Limit with `Label=path,Label2=path2`.    |
| `appUsername`     | `APP_USERNAME`      | _(empty)_               | Login username (defaults to `admin` when a password is set).          |
| `appPassword`     | `APP_PASSWORD`      | _(empty)_               | Plaintext login password (recommended). Leave blank for open access.  |
| `appPasswordHash` | `APP_PASSWORD_HASH` | _(empty)_               | scrypt hash instead of plaintext (`./siphon --hash-password`).        |
| `rclonePath`      | `RCLONE_PATH`       | bundled `rclone.exe`    | Path to rclone. Defaults to `dist-bin/rclone.exe` if present.         |

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

Use [`update.ps1`](../update.ps1) in the repo root: it pulls the latest code, rebuilds the exe
(with the correct bundling), and restarts the service.

## Uninstall

```powershell
npm run service:uninstall
# also delete saved data (profiles, rclone config, logs) - no undo:
powershell -NoProfile -ExecutionPolicy Bypass -File windows-service/Uninstall-SiphonService.ps1 -Purge
```
