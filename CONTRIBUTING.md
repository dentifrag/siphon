# Contributing to Siphon

Thanks for your interest in improving Siphon. This document explains how to get a
development environment running, the conventions the project follows, and what to expect
when you open a pull request.

## Prerequisites

- **Node.js 20 or newer** (the project builds and packages against Node 22).
- **rclone** on your `PATH`, or point Siphon at a binary with the `RCLONE_PATH` environment
  variable. rclone does the actual transfer work; Siphon is the front end.
- An SFTP server to test against (any box you can reach over SSH works).

## Getting started

```bash
git clone https://github.com/dentifrag/siphon.git
cd siphon
npm install
```

Run the API and the UI in two terminals:

```bash
npm run web:server   # API on http://localhost:8080 (needs rclone on PATH or RCLONE_PATH)
npm run web:dev      # UI on http://localhost:5174 with hot reload
```

The dev UI proxies API calls to the server, so open the UI URL in your browser.

## Everyday commands

| Command                | What it does                               |
| ---------------------- | ------------------------------------------ |
| `npm run web:server`   | Run the API with live reload (tsx watch).  |
| `npm run web:dev`      | Run the UI with Vite hot reload.           |
| `npm test`             | Run the test suite once (Vitest).          |
| `npm run test:watch`   | Run tests in watch mode.                   |
| `npm run typecheck`    | Type-check the server and web projects.    |
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
