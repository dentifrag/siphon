# Siphon

A self-hosted web UI for [rclone](https://rclone.org). Browse a remote server from any
browser (laptop or phone) and download files straight onto your home server's drives, with
fast parallel transfers. Siphon is a small, password-protected front end; rclone does the
heavy lifting.

<img width="2556" height="1319" alt="image" src="https://github.com/user-attachments/assets/25a10e23-e4a9-4912-9e1e-f120bfcaa1a2" />
<img width="521" height="985" alt="image" src="https://github.com/user-attachments/assets/c9fa1b7a-88a4-42f0-aa26-e15c913bd416" />


## Quick start

### Docker (recommended for an always-on server)

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

| Setting | `config.json` key | Default | What it does |
| --- | --- | --- | --- |
| `APP_USERNAME` | `appUsername` | `admin` when auth is enabled | Login username. Change this from `admin`. |
| `APP_PASSWORD` | `appPassword` | none | Plaintext password for login. |
| `APP_PASSWORD_HASH` | `appPasswordHash` | none | Scrypt password hash from `--hash-password`. Takes precedence over `APP_PASSWORD`. |
| `LOGIN_MAX_ATTEMPTS` | `loginMaxAttempts` | `10` | Failed login attempts before lockout. Set `0` to disable lockout. |
| `LOGIN_LOCKOUT_MINUTES` | `loginLockoutMinutes` | `15` | Lockout duration after too many failed attempts. |
| `SESSION_TTL_HOURS` | `sessionTtlHours` | `72` | Session lifetime before re-login is required. |
| `TRUST_PROXY` | `trustProxy` | `false` | Trust reverse-proxy headers for client IP and protocol. |
| `SECURE_COOKIES` | `secureCookies` | `auto` | Cookie security mode: `auto`, `true`, `false`. |
| `DOWNLOAD_DIRS` | `downloadDirs` | `/downloads` | Where files can be saved. `Label=path` pairs, comma-separated. |
| `PORT` | `port` | `8080` | Web UI port. |
| `DATA_DIR` | `dataDir` | `./data` | Where saved connections are stored. |

`DOWNLOAD_DIRS` powers the in-app folder picker. List each drive or folder you want to save
into, for example `Movies=/mnt/movies,Backup=/mnt/backup`. In Docker, mount each of those
paths as a volume.

## First-run setup

On first launch without `APP_PASSWORD` or `APP_PASSWORD_HASH`, Siphon starts in setup mode.
Only setup APIs are available until setup is completed.

Open the app in a browser and choose one of these:

- Create an admin username and password.
- Run without a password (open mode), only for trusted networks.

Setup mode should be completed before exposing Siphon beyond loopback or a trusted LAN.

If `APP_PASSWORD` or `APP_PASSWORD_HASH` is set, those credentials override stored auth state
and setup is skipped.

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
```

To build the single-file binaries yourself: `npm run package:all` (outputs to `dist-bin/`).
