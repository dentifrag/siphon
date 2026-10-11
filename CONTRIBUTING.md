# Contributing to Siphon

Thanks for your interest in improving Siphon. This document explains how to get a
development environment running, the conventions the project follows, and what to expect
when you open a pull request.

## Prerequisites

- **Node.js `^22.22.2`, `^24.15.0`, or `>=26.0.0`** (required by the jsdom and Vite dev tooling;
  the project builds and packages against Node 22).
- **rclone** is reused from your `PATH` or `RCLONE_PATH` binary override, or downloaded
  automatically into the dev sandbox. The first download requires internet access and uses
  PowerShell to extract on Windows or `unzip` on macOS/Linux.
- No Docker or separate SSH/SFTP server is required for local development.

## Getting started

```bash
git clone https://github.com/dentifrag/siphon.git
cd siphon
npm install
```

Start the isolated full stack from the checkout or worktree:

```bash
npm run dev
```

When ready, open **http://127.0.0.1:5174** and finish the normal app setup. The command starts
the UI with hot reload, the real API with watch reload on `127.0.0.1:8081`, and an rclone SFTP
server on `127.0.0.1:2022`. Use the local host, port, username, and generated password printed
in the terminal in the normal SFTP connection form. The SFTP password is separate from the
app login you choose.

Browse `Sample folder`, download it to exercise nested files, filenames with spaces, and
empty subfolders, then use the upload picker to send `Upload sample.txt` back to the remote.
You can also edit files directly under `.siphon-dev/remote` while developing.

Everything persists under `.siphon-dev` in this checkout, including app setup and saved
connections in `data/`, remote samples in `remote/`, local files in `downloads/`, generated
credentials in `credentials.json`, and configuration/cache files. Existing samples and
config files are not overwritten. Production environment overrides are removed except the
`RCLONE_PATH` binary override, and local data/download paths and loopback listeners are
enforced. Connecting to a real remote is optional and deliberate; local destinations and
upload sources stay confined to `.siphon-dev/downloads`.

Press **Ctrl+C** to stop the UI, API, and all owned rclone processes. For a fresh start,
stop the instance, delete **only `.siphon-dev`** in this checkout, and run `npm run dev` again.
Normal `data/` and `downloads/` directories are not part of this reset.

### Running concurrent worktrees

The defaults are UI `5174`, API `8081`, and SFTP `2022`. All three must be free and distinct;
invalid or occupied ports fail before the launcher writes files or starts services.
Override them in your shell when another worktree is running:

```bash
DEV_API_PORT=8082 DEV_UI_PORT=5175 DEV_SFTP_PORT=2023 npm run dev
```

In PowerShell:

```powershell
$env:DEV_API_PORT = '8082'
$env:DEV_UI_PORT = '5175'
$env:DEV_SFTP_PORT = '2023'
npm run dev
```

The ready message prints the selected UI URL and SFTP connection settings.

### Manual API/UI commands

You can still run `npm run web:server` and `npm run web:dev` in separate terminals.
The API defaults to `:8080`; open the UI at `http://127.0.0.1:5174`, which proxies API calls
to `127.0.0.1:8080`. These commands use normal environment settings and app paths rather
than the isolated sandbox. They do not start a local sample SFTP server; prefer `npm run dev`
for local development without touching your live service.

## Everyday commands

| Command                | What it does                               |
| ---------------------- | ------------------------------------------ |
| `npm run dev`          | Run isolated UI, API, and sample SFTP.     |
| `npm run web:server`   | Run the API with live reload (tsx watch).  |
| `npm run web:dev`      | Run the UI with Vite hot reload.           |
| `npm test`             | Run the test suite once (Vitest).          |
| `npm run test:watch`   | Run tests in watch mode.                   |
| `npm run typecheck`    | Type-check server, dev scripts, and web.   |
| `npm run lint`         | Lint with oxlint.                          |
| `npm run lint:fix`     | Apply oxlint autofixes.                    |
| `npm run format`       | Format the repo with Prettier.             |
| `npm run format:check` | Verify formatting without writing changes. |
| `npm run build`        | Build the web UI and bundle the server.    |

## Before you push

Please make sure the same checks CI runs pass locally:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

CI runs all of these on every pull request, so running them first saves a round trip.

## Code style

- Formatting is enforced by **Prettier** (no semicolons, single quotes, 100 column width).
  Run `npm run format` before committing rather than hand-formatting.
- Linting is handled by **oxlint**. If a rule genuinely does not apply to an intentional
  pattern, disable it inline with a short justification (see the existing
  `eslint-disable-next-line ... -- reason` comments) rather than turning it off globally.
- TypeScript is used throughout. Prefer explicit types at module boundaries and keep the
  strictness the existing code uses.
- Keep comments for things that genuinely need explaining. Well-named code does not need a
  narration.

## Commits and pull requests

- Write clear, imperative commit messages (for example, "Reject remote path traversal on
  upload").
- Keep pull requests focused. Smaller, single-purpose PRs are easier to review and land.
- Describe what changed and why in the PR body, and call out anything security-relevant.
- Add or update tests for behavior you change. The suite lives in `test/`.
- Update the README or other docs when you change user-facing behavior or configuration.

## Reporting bugs and requesting features

Use the issue templates. For anything security-sensitive, do **not** open a public issue.
Follow [SECURITY.md](SECURITY.md) instead.

## Project layout

See the "Project layout" section in the [README](README.md#project-layout) for a map of the
`src/` tree.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) that covers the project.
