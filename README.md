# Siphon

A self-hosted web UI for [rclone](https://rclone.org). Browse a remote server from any
browser (laptop or phone) and download files straight onto your home server's drives, with
fast parallel transfers. Siphon is a small, password-protected front end; rclone does the
heavy lifting.

## Quick start

### Docker (recommended for an always-on server)

```bash
APP_PASSWORD=change-me docker compose up -d --build
# then open http://<server-ip>:8080
```

Files download into `./downloads`; saved connections live in `./data`. rclone is bundled in
the image, so there's nothing else to install.

### Single-file app (Windows / macOS / Linux)

1. Download the binary for your OS from the [Releases page](https://github.com/dentifrag/siphon/releases)
   (`siphon-win-x64.exe`, `siphon-macos-arm64`, `siphon-macos-x64`, or `siphon-linux-x64`).
2. Run it once. It creates a `config.json` next to itself. Open that file and set a password
   and your download folders.
3. Run it again and open `http://localhost:8080` (or `http://<pc-ip>:8080` from another device).

On macOS/Linux, make it executable first: `chmod +x siphon-*`. The binaries are unsigned, so
Windows SmartScreen or macOS Gatekeeper may warn once. rclone is fetched automatically on
first run if it isn't already installed.

## Configuration

Set these as environment variables (Docker) or as keys in `config.json` (single-file app).
Environment variables win if both are set.

| Setting | `config.json` key | Default | What it does |
| --- | --- | --- | --- |
| `APP_PASSWORD` | `appPassword` | none | Password to open the UI. Without it, anyone on the network can use it. |
| `DOWNLOAD_DIRS` | `downloadDirs` | `/downloads` | Where files can be saved. `Label=path` pairs, comma-separated. |
| `PORT` | `port` | `8080` | Web UI port. |
| `DATA_DIR` | `dataDir` | `./data` | Where saved connections are stored. |

`DOWNLOAD_DIRS` powers the in-app folder picker. List each drive or folder you want to save
into, for example `Movies=/mnt/movies,Backup=/mnt/backup`. In Docker, mount each of those
paths as a volume.

## Features

- Connect over SFTP with a password or private key.
- Browse remote folders with sorting, multi-select, and right-click download.
- Fast parallel downloads (1 to 16 streams) with live progress and speed.
- Downloads keep running on the server even if you close the tab or your phone.
- Save connections so you don't retype credentials, and pick a save folder per download.

Uploads and remote file management are out of scope for now.

## Keep it running on boot

- **Docker:** already handled (`restart: unless-stopped` in `docker-compose.yml`).
- **Windows:** run `npm run service:install` from an Administrator PowerShell to install it as a
  service that starts at boot. See [`windows-service/`](windows-service/) for details.
- **Linux:** point a systemd unit at the binary with `Restart=always`.

## Security

- Always set a password (`APP_PASSWORD`). Without one, the UI is open to your whole network.
- Siphon runs rclone privately on localhost with random credentials; browsers only talk to
  Siphon's own password-protected API, never to rclone directly.
- Saved passwords are stored by rclone (obscured in its config), not by Siphon. Downloads are
  restricted to the folders you configure.
- This version does not verify SFTP host keys, so run it on a network you trust.

## Development

```bash
npm install
npm run web:server   # API on :8080 (needs rclone on PATH or set RCLONE_PATH)
npm run web:dev      # UI on :5174 with hot reload
npm test             # run the tests
```

To build the single-file binaries yourself: `npm run package:all` (outputs to `dist-bin/`).
