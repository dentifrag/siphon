# Siphon

[![CI](https://github.com/dentifrag/siphon/actions/workflows/ci.yml/badge.svg)](https://github.com/dentifrag/siphon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A self-hosted web UI for [rclone](https://rclone.org). Browse a remote server from any
browser (laptop or phone) and download files straight onto your home server's drives, with
fast parallel transfers. Siphon is a small, password-protected front end; rclone does the
heavy lifting.

## Quick start

### Docker

```bash
docker compose up -d --build
# then open http://<server-ip>:8080
```

Files download into `./downloads`; saved connections live in `./data`. rclone is bundled in
the image, so there's nothing else to install.

### Single-file app (Windows / macOS / Linux)

1. Download the binary for your OS from the [Releases page](https://github.com/dentifrag/siphon/releases)
   (`siphon-win-x64.exe`, `siphon-macos-arm64`, `siphon-macos-x64`, or `siphon-linux-x64`).
2. Run it once. It creates a `config.json` next to itself.
3. Open `http://localhost:8080` (or `http://<pc-ip>:8080` from another device) and finish first-run setup in the browser.

On macOS/Linux, make it executable first: `chmod +x siphon-*`. The binaries are unsigned, so
Windows SmartScreen or macOS Gatekeeper may warn once. rclone is fetched automatically on
first run if it isn't already installed.

## Configuration

Set these as environment variables (Docker) or as keys in `config.json` (single-file app).
Environment variables win if both are set.

| Setting                 | `config.json` key     | Default                      | What it does                                                                       |
| ----------------------- | --------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| `APP_USERNAME`          | `appUsername`         | `admin` when auth is enabled | Login username. Change this from `admin`.                                          |
| `APP_PASSWORD`          | `appPassword`         | none                         | Plaintext password for login.                                                      |
| `APP_PASSWORD_HASH`     | `appPasswordHash`     | none                         | Scrypt password hash from `--hash-password`. Takes precedence over `APP_PASSWORD`. |
| `LOGIN_MAX_ATTEMPTS`    | `loginMaxAttempts`    | `10`                         | Failed login attempts before lockout. Set `0` to disable lockout.                  |
| `LOGIN_LOCKOUT_MINUTES` | `loginLockoutMinutes` | `15`                         | Lockout duration after too many failed attempts.                                   |
| `SESSION_TTL_HOURS`     | `sessionTtlHours`     | `72`                         | Session lifetime before re-login is required.                                      |
| `TRUST_PROXY`           | `trustProxy`          | `false`                      | Trust reverse-proxy headers for client IP and protocol.                            |
| `SECURE_COOKIES`        | `secureCookies`       | `auto`                       | Cookie security mode: `auto`, `true`, `false`.                                     |
| `DOWNLOAD_DIRS`         | `downloadDirs`        | `/downloads`                 | Where files can be saved. `Label=path` pairs, comma-separated.                     |
| `PORT`                  | `port`                | `8080`                       | Web UI port.                                                                       |
| `DATA_DIR`              | `dataDir`             | `./data`                     | Where saved connections are stored.                                                |

`DOWNLOAD_DIRS` powers the in-app folder picker. List each drive or folder you want to save
into, for example `Movies=/mnt/movies,Backup=/mnt/backup`. In Docker, mount each of those
paths as a volume. The same folders scope which local files can be uploaded, since uploads read
from the server's local disk into the remote folder you are browsing.

SFTP uploads run single-stream per file (rclone can't multi-thread a single-file SFTP upload).
Overall upload throughput across multiple files comes from the Concurrent setting in the
transfer queue.

The Segments setting is saved with each download when it is queued. Changing Concurrent
does not replace queued or running transfers' segment requests; changing Segments applies
only to newly queued downloads. Configured streams can be fewer than requested because each
chunk is at least 5 MiB: a 20 MiB file requesting eight segments is configured for four.
Requested and configured segment counts, including the displayed active-segment count, are
not measurements of rclone's actual runtime streams.

## First-run setup

On first launch with no configured credentials (no `APP_PASSWORD` / `APP_PASSWORD_HASH` environment variables and no `appPassword` / `appPasswordHash` in `config.json`), Siphon starts in setup mode.
Only setup APIs are available until setup is completed.

Open the app in a browser and choose one of these:

- Create an admin username and password.
- Run without a password (open mode), only for trusted networks.

Setup mode should be completed before exposing Siphon beyond loopback or a trusted LAN.

If `APP_PASSWORD` / `APP_PASSWORD_HASH` or `appPassword` / `appPasswordHash` is configured, those credentials override stored auth state and setup is skipped.

## Features

- Connect over SFTP with a password or private key.
- Browse remote folders with current-folder filtering, sorting, multi-select, and right-click
  download.
- Adjust Name, Size, and Modified columns with pointer dragging, keyboard controls, or
  numeric inputs in Columns, and reveal full names with Wrap filenames.
- Fast parallel downloads (1 to 16 streams) with live progress and speed.
- Upload files and folders that already exist on the Siphon server's local disk into the
  remote folder you are browsing.
- Downloads keep running on the server even if you close the tab or your phone.
- Save connections so you don't retype credentials, and pick a save folder per download.

### Retry failed downloads

Retry appears only for eligible downloads that rclone has reported as finished with a
failure. It starts a new attempt with a new transfer ID and job, not a byte-level resume.
The old row keeps its failure diagnostics and shows Retried. Each failed row can create
only one successor; repeating the request returns that same successor. If the successor
also fails, it can become eligible for its own Retry.

Retries use the original connection snapshot, source path, local destination, and per-item
segment request. Switching or disconnecting the browsing connection, or changing or
deleting a saved profile, does not redirect the retry or adopt new credentials. A missing
source, private key, or connection configuration remains an error. Source size is checked
again; the content at the same source path may have changed.

Downloads to the same canonical final local file run one at a time, including retries.
A queued row shows "Waiting for another download to this file." Other destinations and
uploads still share the Concurrent capacity.

If a submission's outcome is unknown or cancellation has not been confirmed, that target
stays blocked for the lifetime of the running server's download manager. Existing queued
and newly requested downloads to it show an explicit reason. Not every error is retryable;
canceled transfers and uploads cannot Retry. Remove and Clear finished discard the removed
rows' diagnostics and retry options, but do not clear uncertain-target protection.

Clear all, reconnecting, closing the browser, waiting for a timer, or a stop request
returning does not prove the backend stopped or clear that protection. Before restarting
Siphon to unblock a target, confirm that its old supervised rclone backend has actually
terminated. A full server restart empties the in-memory queue and forgets target protection;
an app restart alone is not proof that old writers stopped. Orphaned or external writers
are outside this protection.

Retries are manual: there is no automatic retry, backoff, Retry all, persistent history,
or polling-based recovery. Retry does not guarantee overwrite behavior, atomic replacement,
partial-file handling, or byte-level resume.

### Browser columns

Name defaults to filling the remaining table width, with sensible default widths for Size
and Modified. Drag a column's trailing edge, focus its resize handle and use Left/Right
arrows (Shift for larger steps, Home/End for minimum/maximum), or open Columns to enter
numeric widths. Wrap filenames reveals full filenames instead of truncating them.

Setting a Name width pins it to a fixed pixel width; enlarged columns may intentionally
require horizontal scrolling. Auto-fill Name column returns Name to filling the remaining
space. Reset column widths restores auto-fill Name and default metadata widths without
changing your Wrap filenames setting.

Widths survive folder navigation and reconnects while the browser component remains
mounted. A page reload restores defaults; widths are not saved to persistent storage.
At viewport widths <=1024px, the existing stacked, wrapped layout remains and desktop
column controls are hidden. On wider screens with coarse-pointer input, filenames wrap
by default.

### Saved sites and shared connections

Editing a saved site's connection fields or deselecting it creates a manual connection.
Re-enter the password before connecting or saving it. An unchanged selected site still
uses its saved credentials.

The active connection is shared across tabs. If another tab changes it, a stale tab shows
a connection conflict instead of transferring to the wrong server. Select the desired
server and reconnect, then refresh the folder and select the intended files again before
starting the transfer. Queued transfers and transfers that already acquired their connection
keep running against their original server. Reloading the page reattaches the current shared
connection; confirm the server before transferring.

## Keep it running on boot

- **Docker:** already handled (`restart: unless-stopped` in `docker-compose.yml`).
- **Windows:** run `npm run service:install` from an Administrator PowerShell (or right-click
  `windows-service/Install-SiphonService.ps1` > "Run with PowerShell"). It wraps the packaged
  `dist-bin/siphon-win-x64.exe` in [WinSW](https://github.com/winsw/winsw) as an auto-start
  service that restarts on failure and rolls its logs - no system Node.js needed at runtime.
  For a first-time build of the exe, add `-Build`. See [`windows-service/`](windows-service/)
  for details.
- **Linux:** point a systemd unit at the binary with `Restart=always`.

## Authentication and security

- Username + password login is supported. The default username is `admin` when auth is enabled, change it with `APP_USERNAME` or `appUsername`.
- You can configure the password as plaintext (`APP_PASSWORD` or `appPassword`) or as a scrypt hash (`APP_PASSWORD_HASH` or `appPasswordHash`). Generate hashes with:

```bash
./siphon --hash-password
```

Hashed passwords take precedence over plaintext values.

- Login lockout is enabled by default, `loginMaxAttempts=10` and `loginLockoutMinutes=15`. Set `loginMaxAttempts=0` to disable lockout.
- Sessions expire automatically, `sessionTtlHours=72` by default.
- For HTTPS behind VPN or reverse proxy, set `trustProxy=true` and `secureCookies=true`.
- Password changes are available in-app for store-managed credentials. Env-managed credentials are read-only and skip the setup wizard.
- Forgot your password, if a hash is configured (`APP_PASSWORD_HASH` or `appPasswordHash`), replace or remove that hash first (or regenerate it with `--hash-password`) because hash settings take precedence over plaintext. Then set a new password or hash and restart Siphon.
- Siphon runs rclone privately on localhost with random credentials, browsers only talk to Siphon's API, never to rclone directly.
- Saved passwords are stored by rclone (obscured in its config), not by Siphon. Downloads are restricted to folders you configure.
- This version does not verify SFTP host keys, run it on a network you trust.

### Breaking change: passwordless upgrades now enter setup mode

Existing installs that previously ran with no password and no env credentials now start in setup mode and block operational APIs until setup is completed. This is intentional and fail-closed.

Offline recovery:

1. Stop Siphon.
2. Delete `auth.json` from `dataDir`.
   - macOS default: `~/Library/Application Support/Siphon/auth.json`
   - Linux default: `~/.local/share/siphon/auth.json`
   - Windows default: `%APPDATA%\Siphon\auth.json`
3. Start Siphon again and complete setup.

Deleting `auth.json` is also how you leave open mode.

## Development

```bash
npm install
npm run web:server   # API on :8080 (needs rclone on PATH or set RCLONE_PATH)
npm run web:dev      # UI on :5174 with hot reload
npm test             # run the tests
npm run typecheck    # type-check server + web
npm run lint         # lint with oxlint
npm run format       # format with Prettier
```

To build the single-file binaries yourself: `npm run package:all` (outputs to `dist-bin/`).

## Project layout

```
src/
  server/        Fastify API: auth, config, sessions, request handling
    routes/      HTTP route handlers (auth, browse, downloads, uploads, ...)
    rclone/      rclone process supervisor, client, and download manager
  ui/            React UI built with Primer (components + hooks in lib/)
  web/           Vite entry point that mounts the UI
  shared/        Types and the API contract shared between server and UI
test/            Vitest unit tests
windows-service/ WinSW-based Windows service install/uninstall (PowerShell)
Dockerfile       Container image (bundles rclone)
docker-compose.yml
```

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, coding
style, and the checks CI runs. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

- Found a security issue? Follow the [security policy](SECURITY.md) and report it privately.
- Curious what changed between releases? See the [changelog](CHANGELOG.md).

## License

Siphon is released under the [MIT License](LICENSE).
