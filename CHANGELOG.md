# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/dentifrag/siphon/compare/1.0.2...HEAD
[1.0.2]: https://github.com/dentifrag/siphon/compare/1.0.1...1.0.2
[1.0.1]: https://github.com/dentifrag/siphon/compare/v1.0.0...1.0.1
[1.0.0]: https://github.com/dentifrag/siphon/releases/tag/v1.0.0
