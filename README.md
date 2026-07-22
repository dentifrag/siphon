# Siphon

A self-hosted **web UI for [rclone](https://rclone.org)**: browse a remote and pull
files down onto your server's drives, controlled from any browser (laptop, phone,
tablet). rclone does the transfers (multi-threaded, resumable, widely audited); Siphon
is a small, safe front door around it: a **Fastify** server plus a **React** UI.

You run the server on the machine that should hold the files, point it at an SFTP
server, browse, and download. Because rclone is the engine, parallel/segmented
downloads come for free, and more backends can follow.

It ships in two forms that share one server:

- **Single-file app** (Windows / macOS / Linux): download one executable, run it, and
  control it from any browser. No install, no Node, no Docker. Runs the downloads on that
  machine with native, full-speed folder access. **Recommended for most people.**
- **Self-hosted web app** (Docker or native Node): the same server, containerized (or run
  directly) for an always-on box / NAS.

> How it stays safe: Siphon supervises a **private** `rclone rcd` instance bound to
> loopback with random credentials; browsers only ever talk to Siphon's own
> password-gated, path-confined API, never to rclone directly. See
> [Security notes](#security-notes).

## Download and run (single-file app)

1. Grab the binary for your OS from the
   [Releases page](https://github.com/dentifrag/siphon/releases):
   - Windows: `siphon-win-x64.exe`
   - macOS (Apple Silicon): `siphon-macos-arm64` &nbsp;/&nbsp; (Intel): `siphon-macos-x64`
   - Linux: `siphon-linux-x64`
2. Put it in a folder and run it once. It creates a `config.json` next to itself, then
   prints a first-run notice. Edit `config.json` to set a password and your download
   drives (see the table below).
3. Run it again and open `http://localhost:8080` (or `http://<this-pc-ip>:8080` from your
   phone or another computer on the network).

On first connect the app makes sure rclone is available: if it isn't next to the
executable or on `PATH`, it downloads the official build once into the data folder. To
use a specific rclone, set `RCLONE_PATH` to its full path.

```jsonc
// config.json (created next to the executable on first run)
{
  "port": 8080,
  "appPassword": "change-me",
  "downloadDirs": "Downloads=C:\\Users\\You\\Downloads,Data=D:\\",
  "dataDir": ""                    // optional; defaults to a "data" folder next to the exe
}
```

`downloadDirs` is what powers the folder picker: list each drive/folder you want to save
into as `Label=path`, comma-separated. Point one at a drive root (e.g. `D:\`) to browse
that whole drive.

> First-run notes: the binaries are unsigned, so Windows SmartScreen ("More info → Run
> anyway") or macOS Gatekeeper (right-click → Open, or
> `xattr -d com.apple.quarantine <file>`) may prompt once. On macOS/Linux, mark it
> executable: `chmod +x siphon-*`.

### Keep it running on boot (Windows, no login required)

Register the executable as a scheduled task that starts at boot as SYSTEM. In an
**Administrator PowerShell**, from the folder containing the exe:

```powershell
$exe = "$PWD\siphon-win-x64.exe"
schtasks /Create /TN "Siphon" /TR "$exe" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
schtasks /Run /TN "Siphon"      # start it now too
# Allow other devices on your LAN to reach it:
New-NetFirewallRule -DisplayName "Siphon" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

Remove it later with `schtasks /Delete /TN "Siphon" /F`. A Task Scheduler task
doesn't auto-restart on crash; if you want a self-healing Windows *service*, use the
`node-windows` scripts below (they need Node installed) or a tool like
[WinSW](https://github.com/winsw/winsw) wrapping the exe.

On **Linux**, a systemd unit does the same:

```ini
# /etc/systemd/system/siphon.service
[Unit]
Description=Siphon
After=network.target
[Service]
ExecStart=/opt/siphon/siphon-linux-x64
Restart=always
[Install]
WantedBy=multi-user.target
```
Then `sudo systemctl enable --now siphon`.

## Self-hosted web app (Docker)

Run the downloader on one always-on machine and control it from any browser. The image
bundles rclone, so nothing else is needed:

```bash
# from the repo root
APP_PASSWORD=change-me docker compose up -d --build
# then open http://<server-ip>:8080
```

Downloads land in `./downloads` (mounted to `/downloads`); saved profiles and the rclone
config (which holds your SFTP secrets) live in `./data` (mounted to `/data`).

Environment variables:

| Var | Default | Purpose |
| --- | --- | --- |
| `APP_PASSWORD` | _(unset)_ | Password gate for the UI. If unset, the UI is open (LAN only!). |
| `PORT` | `8080` | HTTP port. |
| `DOWNLOAD_DIRS` | _(unset)_ | Multiple download roots for the folder picker: `"Label=/path,Other=/path2"`. Overrides `DOWNLOAD_DIR`. |
| `DOWNLOAD_DIR` | `/downloads` | Single download root (used when `DOWNLOAD_DIRS` is unset). |
| `DATA_DIR` | `/data` | Where saved profiles + the rclone config are stored. |
| `RCLONE_PATH` | _(auto)_ | Full path to an rclone binary. The Docker image ships one on `PATH`; unset lets the app find or fetch it. |

> These environment variables map one-to-one to the `config.json` keys used by the
> single-file app (`PORT`→`port`, `APP_PASSWORD`→`appPassword`, `DOWNLOAD_DIRS`→
> `downloadDirs`, etc.). Environment variables always take precedence over `config.json`.

### Choosing where files are saved (multiple drives)

The web UI has a **folder picker**: pick any configured root, browse into subfolders,
or create a new one. Configure the roots with `DOWNLOAD_DIRS`, mounting each drive:

```yaml
# docker-compose.yml
environment:
  DOWNLOAD_DIRS: "Movies=/drives/movies,Backup=/drives/backup"
volumes:
  - /mnt/movies:/drives/movies
  - /mnt/backup:/drives/backup
```

### Browsing the whole filesystem

You can point a root at an entire disk. How well that works depends on where you run it:

- **Linux host + Docker (your always-on server):** bind-mount anything at native speed.
  Mount `- /:/host` and set `DOWNLOAD_DIRS: "Host=/host"` to browse everything, or mount
  specific drives. This is the recommended setup. Broad mounts widen the attack surface,
  so set `APP_PASSWORD` and keep it on a trusted network.
- **Docker Desktop (Windows/Mac):** the container runs in a Linux VM, so the host disk is
  exposed over a file-sharing bridge. Paths are **remapped** (e.g. `C:\Users\…` becomes
  `/host_mnt/c/Users/…`), you must add the folder to Docker Desktop's File Sharing, and
  I/O is **slower**. For full-speed access to your real Windows/Mac drives, run natively.

### Run natively (best for full-disk access at native speed)

If the machine saving the files is the one running the app, skip Docker and run the
server directly. It sees your real filesystem with native paths and full throughput. You
need rclone available (on `PATH`, next to the app, or via `RCLONE_PATH`); otherwise the
app fetches it once into `DATA_DIR`.

```bash
npm ci
npm run web:build:all           # build the web UI + bundle the server
# Linux/Mac:
DOWNLOAD_DIRS="Home=$HOME,Root=/" DATA_DIR=./data APP_PASSWORD=change-me npm run web:start
# Windows (PowerShell): point roots at your drives
#   $env:DOWNLOAD_DIRS="C=C:\,D=D:\"; $env:APP_PASSWORD="change-me"; npm run web:start
```

Then open `http://localhost:8080`.

Web dev (two terminals): `npm run web:server` (API on :8080) and `npm run web:dev`
(UI on :5174 with an API proxy).

### Build the single-file binaries yourself

Prebuilt binaries are attached to each [Release](https://github.com/dentifrag/siphon/releases)
(built by CI on native runners). To build them locally with
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg):

```bash
npm ci
npm run package:all      # builds win-x64, macos-arm64, macos-x64, linux-x64 into dist-bin/
# or one target: npm run package:win  |  package:macos-arm64  |  package:linux
```

Each binary embeds Node, the server, and the web UI (~50 MB). rclone is **not** embedded;
the app provisions it on first run (or use a bundled/`PATH` copy). Cross-compiling from one
OS to another works for the bundle; if a target misbehaves, build it on that OS (or let the
GitHub Actions release workflow do all four).

### Run as a Windows service (starts on boot, no login required)

The scheduled-task approach above works with the single-file exe and needs nothing
installed. If you already have Node and want a self-healing *service* (auto-restart on
crash), you can instead install the server as a real Windows service with
[`node-windows`](https://github.com/coreybutler/node-windows) (installed automatically
as an optional dependency).

1. Install [Node.js LTS](https://nodejs.org/) and get the code on the machine.
2. In the project folder, build the server:
   ```powershell
   npm ci
   npm run web:build:all
   ```
3. Create your config from the example and edit it (drives, password, port):
   ```powershell
   copy windows-service\service.config.example.json windows-service\service.config.json
   notepad windows-service\service.config.json
   ```
   Point `downloadDirs` at the drives/folders you want to save to, e.g.
   `"Movies=D:\\Movies,Backup=E:\\,Downloads=C:\\Users\\You\\Downloads"`. Set an
   `appPassword`.
4. Open **PowerShell as Administrator** in the project folder and install:
   ```powershell
   npm run service:install
   ```
   The service `Siphon` is now installed, started, and set to auto-start on boot.
   Open `http://localhost:8080` (or `http://<pc-ip>:8080` from another device).

Manage it like any service: `services.msc`, or `net stop Siphon` /
`net start Siphon`. To remove it: `npm run service:uninstall` (also as Administrator).

To reach it from other devices on your LAN, allow the port through Windows Firewall
(Administrator PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Siphon" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

Notes:
- The service runs as `LocalSystem`, which is why no login is needed. It can read/write
  any path the machine can, so keep `appPassword` set.
- `service.config.json` holds your password and is gitignored. After changing it, reinstall
  the service (`npm run service:uninstall` then `npm run service:install`) to apply.
- Rebuilding after a code update: `git pull && npm ci && npm run web:build:all`, then
  reinstall the service.

## Features (download-focused)

- Connect over SFTP with password or private key (+ passphrase).
- Browse remote directories (breadcrumbs, sortable columns, click / shift-click /
  cmd-click multi-select, right-click download).
- Segmented downloads with a configurable segment count (1-16) via rclone's multi-thread
  copier, and a rolling-average speed readout.
- Transfer queue with live progress (SSE), speed, active-stream count, and cancel.
- Saved connection profiles: pick a saved site and connect without retyping the password
  (rclone holds the secret; see below).
- A server-side folder picker that browses multiple download roots (drives), navigates
  subfolders, and creates new ones.

Uploads and remote file management (rename/delete/mkdir) are intentionally out of
scope for this version.

## How segmentation works

The transfer itself is an rclone `operations/copyfile` job run against the SFTP remote,
tuned so the requested segment count actually produces that many parallel streams:

1. `stat` the remote file to get its size.
2. rclone forms parallel streams from **chunks**, and the number of chunks is
   `ceil(size / chunkSize)`. If the chunk size is larger than the file, only one chunk
   (one stream) runs. So the app sizes the multi-thread chunk to about `size / segments`
   (bounded by a sensible minimum) to reproduce "N segments".
3. Small files (below a cutoff) skip multi-thread entirely and download single-stream.
4. Progress is polled from rclone's `core/stats` and the job status, then pushed to the
   browser over Server-Sent Events with a rolling-average speed.

The chunk-planning math lives in `src/server/rclone/chunk.ts` and is covered by
`test/chunk.test.ts`.

## Getting started (development)

```bash
npm install
npm run web:server   # API on :8080 (needs rclone on PATH or RCLONE_PATH)
npm run web:dev      # UI on :5174 with an API proxy, hot reload
```

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Vite dev server for the web UI (proxies the API). |
| `npm run build` | Build the web UI and bundle the server into `dist-web/` + `dist-server/`. |
| `npm run web:server` | Run the API server in watch mode (dev). |
| `npm run web:start` | Run the built server (`dist-server/index.cjs`). |
| `npm run typecheck` | Type-check the server and web code. |
| `npm test` | Run the unit tests. |
| `npm run package:all` | Build single-file executables for all platforms into `dist-bin/`. |

## Tests

- `test/chunk.test.ts` covers the multi-thread chunk-planning math (the part that turns a
  segment count into real parallel streams).
- `test/config.test.ts` covers config-file / env-var merging.
- `test/localFs.test.ts` covers download-root confinement and the folder picker.
- `test/speed.test.ts` covers the rolling-average speed calculation.

## Security notes

- **rclone is never exposed.** The app supervises a private `rclone rcd` bound to
  `127.0.0.1` on a random free port with a random username/password, using an isolated
  `rclone.conf` in `DATA_DIR`. Browsers only ever talk to the app's own HTTP API, which is
  password-gated and path-confined.
- Set `APP_PASSWORD` to gate the UI (session cookie auth). Without it the UI is open, so
  only run unauthenticated on a trusted LAN.
- **Credentials.** Saved sites are stored as rclone remotes; rclone obscures the
  password/passphrase in its config file. This app stores only non-secret metadata
  (host, user, port, segment count, download folder) in `remotes.json`. Selecting a saved
  site connects using rclone's stored secret, so the browser never resends the password.
  Uncheck "Remember password" to save a site without its secret.
- Downloads are confined to the configured download roots (`DOWNLOAD_DIRS` /
  `DOWNLOAD_DIR`); folder-picker browsing, folder creation, and download destinations are
  all validated against those roots (symlinks resolved) so requests can't escape them.
- **Host keys.** This version does not pin SFTP host keys. If you need strict host-key
  verification, run on a trusted network or in front of a known host.

## Project layout

```
src/
  server/          Fastify web server: REST + SSE, auth, download-root confinement
    rclone/        the engine: binary provisioning, rcd supervisor, rc client,
                   download manager, chunk math, remote (saved-site) store
  web/             web entry: HTTP/SSE window.api client + login gate (reuses the React UI)
  renderer/        React UI (connection panel, remote browser, transfer queue, folder picker)
  shared/          types + the window.api contract shared by the server and UI
```
