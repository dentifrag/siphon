# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.5] - 2026-10-13

### Added

- Download collision previews for files, folders, multi-selection downloads, and retries.
  Existing files require an explicit overwrite or batch-skip decision before downloads queue.
- Downloads transfer into private staging before publication. Changed destinations fail
  visibly instead of being overwritten, and displaced files retain a recovery path.

### Changed

- Legacy direct download and retry API endpoints reject existing destinations with
  `409 DESTINATION_COLLISION`. API clients can use the preview and commit endpoints for
  explicit collision decisions.

### Fixed

- Windows PowerShell executable replacement now passes a true null backup path.
- Windows updater recovery controls require a current, supported idle-task inspection.
- Windows updater HTTP operations and health checks use bounded native waits and retry
  deadlines, including response-body reads that ignore cancellation.

## [1.0.4] - 2026-10-11

### Fixed

- Completed downloads, directory-child transfers, and uploads now display a full green
  progress bar at 100%, even when reported bytes or file sizes are zero, unknown, or incomplete.
- Windows updater verification now accepts correctly protected stored task files even when
  Task Scheduler omits the DACL protection flag.
- Explicit update checks now have a bounded 60-second browser timeout, and update request
  timeouts are reported distinctly from caller cancellation.

## [1.0.3] - 2026-10-11

### Added

- Manual retries for eligible failed downloads, with a new attempt that retains the original
  connection, destination, and segment request. Downloads to the same destination run one
  at a time, and uncertain transfer outcomes keep that destination blocked.
- Adjustable desktop browser columns with pointer, keyboard, and numeric controls, plus
  filename wrapping and an auto-fill Name column.
- A password-authenticated Updates dialog for installed Windows services, with explicit
  release checks, confirmed installation, bounded browser reconnect, and persisted progress.
- One-time administrator setup of a protected independent SYSTEM update task. It verifies
  the pinned release size/digest, restarts and health-checks the exact version, and restores
  the previous executable on failure without changing data, settings, or rclone.
- Protocol-v1 Windows release manifests and safe injected Windows updater core checks in CI.
- An isolated localhost development stack with hot reload, a sample SFTP server, and
  checkout-local data and downloads.

### Changed

- Refreshed runtime dependencies and the development toolchain.

### Fixed

- Packaged apps can install rclone on first run without an unsupported dynamic-import error.
- Folder downloads now create the validated destination folder structure before queuing
  individual files. Concurrent still limits active file transfers, and Segments controls
  parallel streams within each file.
- The transfer queue displays the stream limit instead of an inferred active-stream count.
- The download folder now defaults to the last path selected in the UI instead of resetting to
  the configured default on every load.
- Queued downloads retain their own segment settings when Concurrent changes.
- Editing saved-site connection fields requires re-entering the password instead of silently
  reusing saved credentials.
- Stale tabs detect shared-connection changes instead of sending new transfers to the wrong
  server, and stale navigation and queue responses no longer replace newer UI state.
- Destination paths are preserved without corrupting valid path characters.

## [1.0.2] - 2026-08-25

### Changed

- Raised the development Node.js requirement to `^22.22.2 || ^24.15.0 || >=26.0.0`, following the
  jsdom 30 upgrade. This affects the dev toolchain only. The server bundle is still compiled for
  Node 20, and the Docker image and packaged binaries still ship Node 22, so running Siphon is
  unaffected.

### Fixed

- The right-click menu in the file browser now opens at the pointer instead of the row's
  overflow button on the far right, so it no longer scrolls the list away from the cursor.
- Downloading a folder now transfers its contents. Files previously failed with an "object not
  found" error, while folder paths with redundant separators completed without downloading.

## [1.0.1] - 2026-07-28

### Added

- A quick filter for the current folder in the remote browser.

### Changed

- The macOS x64 release binary is now built on an arm64 runner, since Intel runners are scarce.

## [1.0.0] - 2026-07-26

The first public release.

### Added

- Connect to remote servers over SFTP with a password or private key.
- Browse remote folders with sorting, multi-select, and right-click download.
- Fast parallel downloads (1 to 16 streams) with live progress and speed.
- Upload files and folders from the Siphon server's local disk into the browsed remote folder.
- Server-side transfers that keep running after the browser tab is closed.
- Saved connection profiles and a per-download destination folder picker.
- Password authentication with login lockout, session expiry, and a first-run setup wizard.
- Optional open (unauthenticated) mode for trusted networks.
- Docker image with rclone bundled, plus single-file binaries for Windows, macOS, and Linux.
- Windows service installer for running Siphon at boot.

[Unreleased]: https://github.com/dentifrag/siphon/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/dentifrag/siphon/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/dentifrag/siphon/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/dentifrag/siphon/compare/1.0.2...v1.0.3
[1.0.2]: https://github.com/dentifrag/siphon/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/dentifrag/siphon/compare/v1.0.0...1.0.1
[1.0.0]: https://github.com/dentifrag/siphon/releases/tag/v1.0.0
